/**
 * `Database` with no service (T-245). What it does WITHOUT a database: no connection at
 * construction, a fixed refusal on first use when there is no URL, and a pool built from the
 * app's source and nothing else. `withAppRw` against a real Postgres is apps/core's
 * `test:integration` (*withAppRw runs as app_rw …*) and the containerised worker's job output.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Database, DATABASE_URL_REFUSED } from './index.ts';
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
