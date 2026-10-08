/**
 * The test side of the containerised-worker suite: a superuser pool for reading `pgboss` state
 * (the `svc run` login, `postgres:5432`), a LISTEN on the selftest channel, and a pg-boss CLIENT
 * that can send and schedule but runs NO worker, NO maintenance and NO timekeeper
 * (`schedule: false`, `supervise: false`). So a job that reaches `completed`, and a cron job that
 * is CREATED, can only have been handled / fired by another process — the `worker` container.
 */
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { PgBoss } from 'pg-boss';
import type { ConstructorOptions } from 'pg-boss';
import { setTimeout as sleep } from 'node:timers/promises';
import { SELFTEST_CHANNEL } from '../../src/selftest.ts';

export function databaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (value === undefined || value === '') {
    throw new TypeError(
      'DATABASE_URL is not set: run under `scripts/svc run <ticket> --` on a project where ' +
        '`svc up <ticket> db worker --verify --build` is running',
    );
  }
  return value;
}

export function superuserPool(): Pool {
  return new pg.Pool({ connectionString: databaseUrl(), application_name: 'kinvara-worker-test' });
}

export interface Note {
  readonly id: string;
  readonly phase: string;
  readonly attempt: number;
  readonly host: string;
  readonly pid: number;
  readonly tag?: string;
  /** the service that sent it (T-242: `SelftestReporter`, injected into the handler provider) */
  readonly via?: string;
}

function isNote(value: unknown): value is Note {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'phase' in value &&
    typeof value.phase === 'string' &&
    'attempt' in value &&
    typeof value.attempt === 'number' &&
    'host' in value &&
    typeof value.host === 'string' &&
    'pid' in value &&
    typeof value.pid === 'number'
  );
}

export interface Listener {
  readonly notes: Note[];
  close(): Promise<void>;
}

/** LISTEN on the selftest channel; every notification the handler sends is kept, in order. */
export async function listen(pool: Pool): Promise<Listener> {
  const client: PoolClient = await pool.connect();
  const notes: Note[] = [];
  client.on('notification', (message) => {
    if (message.channel !== SELFTEST_CHANNEL || message.payload === undefined) return;
    const parsed: unknown = JSON.parse(message.payload);
    if (isNote(parsed)) notes.push(parsed);
  });
  await client.query(`LISTEN ${SELFTEST_CHANNEL}`);
  return {
    notes,
    close: async () => {
      await client.query(`UNLISTEN ${SELFTEST_CHANNEL}`);
      client.release();
    },
  };
}

/** A pg-boss that can send and schedule, as `app_rw`, and does nothing on its own. */
export async function clientBoss(): Promise<PgBoss> {
  const config: ConstructorOptions & { readonly options: string } = {
    connectionString: databaseUrl(),
    application_name: 'kinvara-worker-test',
    options: '-c role=app_rw',
    schema: 'pgboss',
    migrate: false,
    schedule: false,
    supervise: false,
  };
  const boss = new PgBoss(config);
  boss.on('error', () => undefined);
  await boss.start();
  return boss;
}

export interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly retry_count: number;
  readonly retry_limit: number;
  readonly output: unknown;
  readonly created_on: Date;
  readonly completed_on: Date | null;
}

export async function job(pool: Pool, id: string): Promise<JobRow | undefined> {
  return (
    await pool.query<JobRow>(
      `SELECT id::text, state::text, retry_count, retry_limit, output, created_on, completed_on
         FROM pgboss.job WHERE name = 'worker.selftest' AND id = $1`,
      [id],
    )
  ).rows[0];
}

/** Poll until `probe` returns a value, or fail with `what` after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)}ms: ${what}`);
    await sleep(250);
  }
}
