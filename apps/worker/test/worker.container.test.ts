/**
 * Against the CONTAINERISED worker — `scripts/svc up <ticket> db worker --verify --build` on a
 * database `db:migrate up` has brought to `0006` or later, then
 * `scripts/svc run <ticket> -- pnpm --filter @kinvara/worker test:integration`.
 *
 * This process never runs a pg-boss worker or timekeeper (test/fixtures/db.ts `clientBoss`:
 * `schedule: false`, `supervise: false`, no `work()`), so:
 *   - a `worker.selftest` job that reaches `completed`/`failed` was handled by another process;
 *   - a job created from a cron schedule was created by another process's timekeeper;
 *   - the handler's `pg_notify` side effect carries that process's hostname, which is asserted to
 *     differ from this one's, and the sessions of `application_name = 'kinvara-worker'` come from
 *     a client address that is not this one's.
 * The only other process on the project's network is the `worker` container (`svc ps`, pasted
 * with the evidence).
 *
 * Expectations are anchored outside the worker's code where one exists: the retry count from
 * pg-boss's row (`retry_count`, `state`) and the attempt count from the handler's own
 * notifications, which must agree; the queue's options are read back from `pgboss.queue`.
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { SELFTEST_FAILURE, SELFTEST_QUEUE, SELFTEST_QUEUE_OPTIONS } from '../src/selftest.ts';
import { clientBoss, job, listen, superuserPool, waitFor, type Listener } from './fixtures/db.ts';

const RUN = `t${Date.now().toString(36)}`;
let pool: Pool;
let listener: Listener;
let boss: PgBoss;

beforeAll(async () => {
  pool = superuserPool();
  listener = await listen(pool);
  boss = await clientBoss();
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await listener.close();
  await pool.end();
});

async function send(data: Record<string, unknown>): Promise<string> {
  const id = await boss.send(SELFTEST_QUEUE, data);
  assert.ok(typeof id === 'string', 'send returned a job id');
  return id;
}

test('(c) the worker container is running real code: its own sessions, as login app, from another address', async () => {
  const rows = (
    await pool.query<{ usename: string; other_host: boolean }>(
      `SELECT usename::text, client_addr IS DISTINCT FROM inet_client_addr() AS other_host
         FROM pg_stat_activity WHERE application_name = 'kinvara-worker'`,
    )
  ).rows;
  assert.ok(rows.length >= 1, 'at least one kinvara-worker session (the placeholder opens none)');
  // G9 / OD-116: the compose login is the bootstrap superuser; the ROLE is app_rw (boot line).
  assert.deepEqual([...new Set(rows.map((r) => r.usename))], ['app']);
  assert.ok(
    rows.every((r) => r.other_host),
    'every kinvara-worker session is from another host',
  );
});

test('(c) the worker created worker.selftest with the configured policy, and not partitioned', async () => {
  const row = (
    await pool.query<{
      policy: string;
      partition: boolean;
      table_name: string;
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
      expire_seconds: number;
    }>(
      `SELECT policy, partition, table_name, retry_limit, retry_delay, retry_backoff, expire_seconds
         FROM pgboss.queue WHERE name = $1`,
      [SELFTEST_QUEUE],
    )
  ).rows[0];
  assert.deepEqual(row, {
    policy: 'standard',
    partition: false,
    table_name: 'job_common',
    retry_limit: SELFTEST_QUEUE_OPTIONS.retryLimit,
    retry_delay: SELFTEST_QUEUE_OPTIONS.retryDelay,
    retry_backoff: SELFTEST_QUEUE_OPTIONS.retryBackoff,
    expire_seconds: SELFTEST_QUEUE_OPTIONS.expireInSeconds,
  });
});

test(
  "(T-245 a) the handler's injected @kinvara/core-modules Database runs withAppRw as app_rw, on a connection that set the role at connect, and the job is completed",
  { timeout: 30_000 },
  async () => {
    const tag = `${RUN}.db`;
    const id = await send({ op: 'echo', tag });
    const done = await waitFor('the db job to complete', 20_000, async () => {
      const row = await job(pool, id);
      return row?.state === 'completed' ? row : undefined;
    });
    // Expected values are literals (T-020 § contract §3: the worker runs as app_rw; T-148 § contract
    // 1 row 1: by the libpq option), not read from src/.
    const output = done.output as { tag?: unknown; db?: unknown };
    assert.equal(output.tag, tag);
    assert.deepEqual(output.db, { currentUser: 'app_rw', roleAtConnect: 'app_rw' });
    // Control: this process's own superuser session neither is app_rw nor set a role at connect.
    const plain = await pool.query<{ u: string; r: string }>(
      "SELECT current_user::text AS u, (SELECT reset_val FROM pg_settings WHERE name = 'role') AS r",
    );
    assert.notEqual(plain.rows[0]?.u, 'app_rw');
    assert.notEqual(plain.rows[0]?.r, 'app_rw');
  },
);

test(
  '(a) a job sent to worker.selftest is completed by the containerised worker: pgboss state AND the handler side effect, sent by an injected service',
  { timeout: 30_000 },
  async () => {
    const tag = `${RUN}.echo`;
    const id = await send({ op: 'echo', tag });
    const done = await waitFor('the echo job to complete', 20_000, async () => {
      const row = await job(pool, id);
      return row?.state === 'completed' ? row : undefined;
    });
    const output = done.output as {
      host?: unknown;
      pid?: unknown;
      tag?: unknown;
      attempt?: unknown;
    };
    assert.equal(output.tag, tag);
    assert.equal(output.attempt, 1);
    assert.ok(typeof output.host === 'string' && output.host !== hostname(), 'handled elsewhere');
    const notes = listener.notes.filter((n) => n.id === id);
    // T-242: the handler is a Nest provider and sends its notifications through a service it
    // INJECTED from another module (SelftestReporterModule, the stand-in for a core module). The
    // name is a literal here, not read from src/, so the assertion is not derived from the code.
    assert.deepEqual(
      notes.map((n) => [n.phase, n.attempt, n.host, n.via]),
      [
        ['start', 1, output.host, 'SelftestReporter'],
        ['done', 1, output.host, 'SelftestReporter'],
      ],
    );
  },
);

test(
  '(iii) a handler that throws: the job ends failed after exactly the configured attempts (retryLimit 1 = 2 attempts)',
  { timeout: 60_000 },
  async () => {
    // Discriminating only if the configured limit is not pg-boss's own default (2, types.d.ts
    // QueueOptions.retryLimit): a worker that ignored the option would then show a third attempt.
    assert.notEqual(SELFTEST_QUEUE_OPTIONS.retryLimit, 2);
    const id = await send({ op: 'throw', tag: `${RUN}.throw` });
    const failed = await waitFor('the throwing job to fail', 30_000, async () => {
      const row = await job(pool, id);
      return row?.state === 'failed' ? row : undefined;
    });
    // Nothing may come after `failed`: give a third attempt time to appear (retryDelay is 1 s).
    await sleep(4_000);
    const after = await job(pool, id);
    assert.equal(after?.state, 'failed');
    assert.equal(failed.retry_limit, SELFTEST_QUEUE_OPTIONS.retryLimit);
    assert.equal(failed.retry_count, SELFTEST_QUEUE_OPTIONS.retryLimit);
    const output = failed.output as { message?: unknown };
    assert.equal(output.message, SELFTEST_FAILURE);
    const notes = listener.notes.filter((n) => n.id === id);
    assert.deepEqual(
      notes.map((n) => [n.phase, n.attempt]),
      [
        ['start', 1],
        ['start', 2],
      ],
    );
  },
);

test(
  '(b) a cron schedule fires in the container, and G6: the smallest cadence it delivers',
  { timeout: 200_000 },
  async () => {
    const schedules = [
      { key: `${RUN}-every-1s`, cron: '* * * * * *' },
      { key: `${RUN}-every-30s`, cron: '*/30 * * * * *' },
      { key: `${RUN}-every-60s`, cron: '* * * * *' },
    ];
    for (const s of schedules) {
      await boss.schedule(
        SELFTEST_QUEUE,
        s.cron,
        { op: 'echo', tag: `cron.${s.key}` },
        { key: s.key },
      );
    }
    const clock = async (): Promise<Date> =>
      (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now ??
      new Date(0);
    const startedAt = await clock();
    try {
      await sleep(150_000);
    } finally {
      for (const s of schedules) await boss.unschedule(SELFTEST_QUEUE, s.key);
    }
    // A due schedule is inserted into pg-boss's internal send-it queue and forwarded by a worker
    // polling every cronWorkerIntervalSeconds (5 s): let the last one land before reading.
    await sleep(7_000);
    const endedAt = await clock();
    const rows = (
      await pool.query<{ tag: string; state: string; created_on: Date; host: string | null }>(
        `SELECT data->>'tag' AS tag, state::text, created_on, output->>'host' AS host
         FROM pgboss.job
        WHERE name = $1 AND data->>'tag' LIKE $2 AND created_on BETWEEN $3 AND $4
        ORDER BY created_on`,
        [SELFTEST_QUEUE, `cron.${RUN}-%`, startedAt, endedAt],
      )
    ).rows;
    // The UTC minutes the window touches, from the DATABASE clock — not from the jobs.
    const minutesSpanned =
      Math.floor(endedAt.getTime() / 60_000) - Math.floor(startedAt.getTime() / 60_000) + 1;
    console.log(
      `G6 window ${startedAt.toISOString()} .. ${endedAt.toISOString()} (database clock_timestamp()), ` +
        `UTC minutes touched: ${String(minutesSpanned)}`,
    );
    for (const s of schedules) {
      const mine = rows.filter((r) => r.tag === `cron.${s.key}`);
      const at = mine.map((r) => r.created_on.toISOString());
      const gaps = mine
        .slice(1)
        .map((r, i) => (r.created_on.getTime() - (mine[i]?.created_on.getTime() ?? 0)) / 1000);
      console.log(
        `G6 ${s.cron.padEnd(16)} fired ${String(mine.length)} time(s); created_on ${JSON.stringify(at)}; gaps_s ${JSON.stringify(gaps)}; states ${JSON.stringify(mine.map((r) => r.state))}`,
      );
    }
    // (b): fired in the container, and every cron-created job was completed there.
    assert.ok(rows.length >= 1, '(b) at least one cron-created job');
    assert.ok(
      rows.every((r) => r.state === 'completed' && r.host !== null && r.host !== hostname()),
      '(b) every cron-created job was completed by another process',
    );
    // G6, as measured (state/EP-2/T-148.md § G6): pg-boss 12.26.4 delivers AT MOST ONE job per
    // schedule per UTC minute — its timekeeper inserts each due schedule with `singletonSeconds: 60`
    // (dist/timekeeper.js `cron()`). So an every-second and an every-30-second expression are
    // ACCEPTED and fire no more often than an every-minute one. The bound is the number of UTC
    // minutes the window touched (3 or 4 for ~157 s), read from the database clock; a 30 s cadence
    // would deliver at least 5 and turn this red. Each schedule fires at least twice.
    for (const s of schedules) {
      const count = rows.filter((r) => r.tag === `cron.${s.key}`).length;
      assert.ok(count >= 2, `${s.cron} fired at least twice`);
      assert.ok(
        count <= minutesSpanned,
        `${s.cron} fired ${String(count)} times in a window touching ${String(minutesSpanned)} UTC minutes`,
      );
    }
  },
);
