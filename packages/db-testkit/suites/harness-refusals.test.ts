/**
 * The harness's OWN refusals, each watched refusing on a real cluster.
 *
 * `acquireCluster` refuses four things before a suite touches anything: an
 * image that is not compose's (or is the stock one), a database that is not
 * ICU `und`, a server this suite did not just start, and a cluster that already
 * carries the five `0001` roles. Until this file none of them had ever been
 * observed refusing — they had only ever run in the direction that passes, and
 * an assertion nobody has seen refuse is decoration (PROTOCOL §5.1). Each
 * refusal below has a control, so "refused" and "refuses everything" are
 * distinguishable.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireCluster,
  applyBaseline,
  assertDisposable,
  assertPinnedImage,
  composePostgresImage,
  FIVE_ROLES,
  POSTGRES_IMAGE,
  type Cluster,
} from '../src/index.ts';

const SUITE = 'harness-refusals';
let db: Cluster;
let startedAt = 0;

beforeAll(async () => {
  startedAt = Date.now();
  db = await acquireCluster(SUITE);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

describe('the pinned image — refused at acquisition, not only by the gate', () => {
  test("CONTROL — the harness tag is compose's tag, read from compose.yml now", () => {
    assert.equal(composePostgresImage(), POSTGRES_IMAGE);
    assert.doesNotThrow(() => {
      assertPinnedImage(POSTGRES_IMAGE);
    });
  });

  test('the stock image is refused (OD-10), even though it is on the daemon and would resolve', () => {
    assert.throws(() => {
      assertPinnedImage('postgis/postgis:18-3.6');
    }, /refusing the STOCK image postgis\/postgis:18-3\.6/);
  });

  test('compose moved to a new tag and the harness did not — the realistic bump', () => {
    assert.throws(() => {
      assertPinnedImage(POSTGRES_IMAGE, 'kinvara/postgres:18-3.6-kinvara2');
    }, /image drift/);
  });

  test('the harness moved and compose did not', () => {
    assert.throws(() => {
      assertPinnedImage('kinvara/postgres:18-3.6-kinvara9');
    }, /image drift/);
  });
});

describe('the cluster is disposable — each refusal watched', () => {
  test('CONTROL — the cluster this suite just started passes all three checks', async () => {
    await assertDisposable(db, { startedAt });
  });

  test('a database that is not ICU und is refused', async () => {
    await db.sql({
      database: 'postgres',
      commands: [
        `CREATE DATABASE probe_libc TEMPLATE template0 ENCODING UTF8
           LOCALE_PROVIDER libc LOCALE 'C.UTF-8'`,
      ],
    });
    assert.equal(
      await db.value(`SELECT datlocprovider::text FROM pg_database WHERE datname = 'probe_libc'`),
      'c',
      'the probe database must really be libc, or this refusal tests nothing',
    );
    await assert.rejects(
      assertDisposable(db, { startedAt, database: 'probe_libc' }),
      /probe_libc has datlocprovider:datlocale = c:/,
    );
  });

  test('a server that was already running when the suite started is refused', async () => {
    // The scenario the check exists for: a suite begins NOW and is handed a
    // server that was up before it. The server and its age are real; what is
    // shrunk is the tolerance (30 s -> 0), so the test does not wait 30 s. The
    // default tolerance itself is not exercised in the refusing direction.
    const age = Number(
      await db.value(`SELECT extract(epoch from (now() - pg_postmaster_start_time()))`),
    );
    assert.ok(age > 0.1, `the server must be measurably older than "now" (age ${String(age)}s)`);
    await assert.rejects(
      assertDisposable(db, { startedAt: Date.now(), slackSeconds: 0 }),
      /not a disposable cluster/,
    );
  });

  test('a cluster that already carries the five 0001 roles is refused', async () => {
    const r = await applyBaseline(db);
    assert.equal(r.code, 0, `0001 must apply for this probe to mean anything.\n${r.output}`);
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_roles WHERE rolname IN (${FIVE_ROLES.map((x) => `'${x}'`).join(',')})`,
      ),
      '5',
    );
    await assert.rejects(
      assertDisposable(db, { startedAt }),
      /5 of the five 0001 roles already exist/,
    );
  });
});
