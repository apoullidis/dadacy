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
 * P3 — the cluster-level parameter — is in `preflight-p3.test.ts`. It needs a
 * cluster started with a different server command, and a suite FILE holds at
 * most one cluster: the runner's `--no-file-parallelism` serialises files, not
 * the clusters inside one, and this file used to hold two at once — measured by T-115 as a
 * 1 GB peak against the `db` profile's 512 MB budget. `gate:constraint-suite`
 * now refuses a second acquire call site in one file.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { acquireCluster, applyBaseline, type Cluster } from '../src/index.ts';

const SUITE = 'preflight';
let db: Cluster;

beforeAll(async () => {
  // NOT acquireMigratedCluster: this suite watches 0001 fail, so it must own a
  // cluster in which 0001 has never run. Nothing here creates the five roles,
  // which is why three probe databases can share one cluster — every one of
  // them is refused before Section 2.
  db = await acquireCluster(SUITE);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

const PSQL_SCRIPT_ERROR = 3;

describe('0001 §Section 0 — the preflight refuses a database it cannot be repaired into', () => {
  test('P1 — a libc database, the mistake that cannot be repaired later', async () => {
    await db.sql({
      database: 'postgres',
      commands: [
        // `LOCALE_PROVIDER libc` is EXPLICIT here and T-020's own statement did
        // not have it. T-020 ran against the pre-T-017 image, whose `template0`
        // was itself libc, so `LOCALE 'C.UTF-8'` alone produced a libc database.
        // On the pinned image (OD-5 fixed at initdb time) `template0` is ICU
        // `und`, the provider is INHERITED FROM THE TEMPLATE, and the same
        // statement produces an ICU database with locale `C.UTF-8` — which the
        // preflight refuses down its *P2* branch, not its P1 one. The port was
        // green on the exit status and wrong about which assertion it had
        // exercised; asserting the MESSAGE is what caught it.
        `CREATE DATABASE probe_libc TEMPLATE template0 ENCODING UTF8
           LOCALE_PROVIDER libc LOCALE 'C.UTF-8'`,
      ],
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
