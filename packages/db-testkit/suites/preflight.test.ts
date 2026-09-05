/**
 * T-020 Evidence §6, ported — `0001` refuses a wrongly-provisioned database.
 *
 * The §Section 0 preflight is an ASSERTION, not a fix, because
 * `datlocprovider`, `datlocale` and `encoding` cannot be altered after
 * `CREATE DATABASE`; the only remedy is dump-and-restore. An assertion nobody
 * has watched refuse is decoration, so all three failure modes are exercised
 * here, and **the exit status is asserted, not just the message**: under
 * `ON_ERROR_STOP=1` psql exits 3 on a script error, and two runs that both
 * fail identically are byte-identical (PROTOCOL §5.1).
 *
 * P3 needs its own cluster. `shared_preload_libraries` is a CLUSTER-level
 * parameter, which is the third reason this harness gives every suite a cluster
 * rather than a database (see `src/cluster.ts`).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireCluster, applyBaseline, type Cluster } from '../src/index.ts';

const SUITE = 'preflight';
let db: Cluster;

before(
  async () => {
    // NOT acquireMigratedCluster: this suite watches 0001 fail, so it must own a
    // cluster in which 0001 has never run. Nothing here creates the five roles,
    // which is why three probe databases can share one cluster — every one of
    // them is refused before Section 2.
    db = await acquireCluster(SUITE);
  },
  { timeout: 300_000 },
);

after(async () => {
  if (db !== undefined) await db.stop();
});

const PSQL_SCRIPT_ERROR = 3;

describe('0001 §Section 0 — the preflight refuses a database it cannot be repaired into', () => {
  test('P1 — a libc database, the mistake that cannot be repaired later', async () => {
    await db.sql({
      database: 'postgres',
      commands: [`CREATE DATABASE probe_libc TEMPLATE template0 ENCODING UTF8 LOCALE 'C.UTF-8'`],
    });
    const r = await applyBaseline(db, 'probe_libc');
    assert.equal(
      r.code,
      PSQL_SCRIPT_ERROR,
      `P1: expected psql exit 3 under ON_ERROR_STOP=1, got ${String(r.code)}.\n${r.output}`,
    );
    assert.ok(
      r.output.includes('uses locale provider c') && r.output.includes('expected the ICU provider'),
      `P1: the refusal must name the provider it found and the one it wanted.\n${r.output}`,
    );

    // And the refusal is CLEAN — the whole file is one transaction, so nothing
    // is half-applied. Without this, a preflight that raised after creating
    // three extensions would still "pass" the test above.
    assert.equal(
      await db.value(`SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'`, {
        database: 'probe_libc',
      }),
      '0',
    );
  });

  test('P2 — a NON-ROOT ICU locale: the plausible wrong answer, not an obvious one', async () => {
    // "The market is Greek, so use the Greek collation" gives a database that
    // sorts Cyrillic and Latin by Greek rules. SD §DB-16 requires the ROOT
    // locale because the corpus is Greek, Cyrillic, Latin and Greeklish in one
    // set of columns.
    await db.sql({
      database: 'postgres',
      commands: [
        `CREATE DATABASE probe_el TEMPLATE template0 ENCODING UTF8
           LOCALE_PROVIDER icu ICU_LOCALE 'el' LOCALE 'C.UTF-8'`,
      ],
    });
    const r = await applyBaseline(db, 'probe_el');
    assert.equal(r.code, PSQL_SCRIPT_ERROR, `P2: expected psql exit 3.\n${r.output}`);
    assert.ok(
      r.output.includes('has ICU locale el') && r.output.includes("expected the root locale 'und'"),
      `P2: the refusal must name the locale it found.\n${r.output}`,
    );
  });

  test('CONTROL — the same file applies to a correctly provisioned database', async () => {
    // The control that makes P1 and P2 mean something: a preflight that
    // refused everything would pass both of them.
    const r = await applyBaseline(db);
    assert.equal(r.code, 0, `the baseline must apply to a correct database.\n${r.output}`);
    assert.equal(
      await db.value(`SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'`),
      '7',
      'SD §DH-1 first-ticket #3 names seven extensions',
    );
  });
});

describe('0001 §Section 0 — P3, the cluster-level parameter', () => {
  let bare: Cluster;

  before(
    async () => {
      // A cluster started with the parameter genuinely empty. T-020 produced this
      // by resetting the parameter and restarting the container by hand; here it
      // is one line, which is the whole difference between a one-off run and a
      // suite.
      bare = await acquireCluster('preflight-no-preload', {
        command: ['postgres', '-c', 'shared_preload_libraries='],
      });
    },
    { timeout: 300_000 },
  );

  after(async () => {
    if (bare !== undefined) await bare.stop();
  });

  test('P3 — shared_preload_libraries without pg_stat_statements (OD-7)', async () => {
    assert.equal(
      await bare.value(`SHOW shared_preload_libraries`),
      '',
      'the probe cluster must really have the parameter empty, or P3 tests nothing',
    );
    const r = await applyBaseline(bare);
    assert.equal(r.code, PSQL_SCRIPT_ERROR, `P3: expected psql exit 3.\n${r.output}`);
    assert.ok(
      r.output.includes('shared_preload_libraries does not contain pg_stat_statements'),
      `P3: the refusal must name the parameter.\n${r.output}`,
    );
    // Why it matters, restated as an assertion: CREATE EXTENSION would have
    // SUCCEEDED here, and every read of the view would then raise — SD §DB-12's
    // weekly review of statements over 50 ms silently dead, nothing red.
    assert.equal(
      await bare.value(`SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'`),
      '0',
    );
  });
});
