/**
 * `Database` with no service (T-245). What it does WITHOUT a database: no connection at
 * construction, a fixed refusal on first use when there is no URL, and a pool built from the
 * app's source and nothing else; and no use after shutdown (rework 1, QA-F1). `withAppRw` against a
 * real Postgres is apps/core's `test:integration` (*withAppRw runs as app_rw …*) and the
 * containerised worker's job output.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  Database,
  DATABASE_SHUT_DOWN,
  DATABASE_URL_REFUSED,
  DatabaseShutDownError,
} from './index.ts';
import { poolConfigFor } from './database.ts';

const SENTINEL = 'postgres://SENTINEL-T245-user:SENTINEL-T245-pw@nowhere.invalid:5432/x';

test('with no connection string, withAppRw refuses with the fixed text and nothing is logged', async () => {
  for (const connectionString of [undefined, '']) {
    const lines: string[] = [];
    const db = new Database({ connectionString, application_name: 'kinvara-test' }, (l) =>
      lines.push(l),
    );
    await assert.rejects(
      db.withAppRw(async () => 'unreached'),
      (e: unknown) => e instanceof TypeError && e.message === DATABASE_URL_REFUSED,
    );
    assert.deepEqual(lines, []);
    await db.onApplicationShutdown();
  }
  assert.ok(!DATABASE_URL_REFUSED.includes('SENTINEL'));
});

test('construction and shutdown open nothing: an unreachable source is never contacted', async () => {
  const db = new Database({ connectionString: SENTINEL, application_name: 'kinvara-test' }, () => {
    throw new Error('nothing may be logged');
  });
  await db.onApplicationShutdown();
  await db.onApplicationShutdown();
});

test("core's source shape gives the pool exactly its URL and application_name", () => {
  assert.deepEqual(
    poolConfigFor({ connectionString: SENTINEL, application_name: 'kinvara-core' }, SENTINEL),
    { connectionString: SENTINEL, application_name: 'kinvara-core' },
  );
});

test("the worker's source shape reaches the pool whole: the role option, the timeout, max", () => {
  const source = {
    connectionString: SENTINEL,
    application_name: 'kinvara-worker',
    options: '-c role=app_rw',
    connectionTimeoutMillis: 10_000,
    max: 2,
  };
  assert.deepEqual(poolConfigFor(source, SENTINEL), {
    connectionString: SENTINEL,
    application_name: 'kinvara-worker',
    options: '-c role=app_rw',
    connectionTimeoutMillis: 10_000,
    max: 2,
  });
});

/** Loopback port 1: nothing listens, so a pool that tries to connect is refused at once. */
const CLOSED_PORT = 'postgres://t245:none@127.0.0.1:1/none';

function isShutDownRefusal(e: unknown): boolean {
  return (
    e instanceof DatabaseShutDownError &&
    e.name === 'DatabaseShutDownError' &&
    e.message === DATABASE_SHUT_DOWN
  );
}

test('use after shutdown is refused: a Database whose pool existed opens no new pool after onApplicationShutdown', async () => {
  const lines: string[] = [];
  const db = new Database(
    {
      connectionString: CLOSED_PORT,
      application_name: 'kinvara-test',
      connectionTimeoutMillis: 2000,
    },
    (l) => lines.push(l),
  );
  // The pool exists and has tried the source: a connect error, not a refusal.
  await assert.rejects(
    db.withAppRw(async () => 'unreached'),
    (e: unknown) => {
      assert.ok(!isShutDownRefusal(e), 'before shutdown the pool is used, not refused');
      assert.equal((e as { code?: unknown }).code, 'ECONNREFUSED');
      return true;
    },
  );
  await db.onApplicationShutdown();
  // After shutdown: the named refusal. A Database that built a NEW pool here would reject with
  // ECONNREFUSED again, which is what this assertion tells apart (QA-13 `dbfirst`).
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      db.withAppRw(async () => 'unreached'),
      (e: unknown) => {
        assert.ok(isShutDownRefusal(e), `expected DatabaseShutDownError, got ${String(e)}`);
        return true;
      },
    );
  }
  await db.onApplicationShutdown(); // still idempotent
  assert.deepEqual(lines, []);
  assert.ok(!DATABASE_SHUT_DOWN.includes('t245') && !DATABASE_SHUT_DOWN.includes('127.0.0.1'));
});

test('use after shutdown is refused before anything else: no pool, no URL check, nothing contacted', async () => {
  for (const connectionString of [undefined, SENTINEL]) {
    const db = new Database({ connectionString, application_name: 'kinvara-test' }, () => {
      throw new Error('nothing may be logged');
    });
    await db.onApplicationShutdown();
    await assert.rejects(
      db.withAppRw(async () => 'unreached'),
      (e: unknown) => {
        assert.ok(isShutDownRefusal(e), `expected DatabaseShutDownError, got ${String(e)}`);
        return true;
      },
    );
  }
});
