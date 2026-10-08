/**
 * Everything the worker is configured with, in one place, and nothing read from the environment
 * except `DATABASE_URL` and the heartbeat path the image already sets (T-034's `KINVARA_HEARTBEAT`).
 *
 * THE PRINCIPAL (T-020 § contract §3: `apps/worker` connects as `app_rw`). Every connection the
 * worker opens — its own pool and pg-boss's — carries libpq's startup option `-c role=app_rw`, so
 * the session's `current_user` is `app_rw` before the first statement runs. On this compose file
 * the LOGIN is still the bootstrap superuser `app` (OD-90 cut F8/G9, OD-116; the `app_rw` login is
 * `T-155`'s), and a superuser can `RESET ROLE`: so this confines the worker's own SQL and
 * pg-boss's to `app_rw`'s grants; it is not a boundary around the process. A login that is not a
 * member of `app_rw` cannot connect at all (the role cannot be set). `src/preflight.ts` reads
 * `current_user` back and refuses to start unless it is `app_rw`.
 *
 * NO RUN-TIME DDL (T-146 § contract §3). `migrate: false` — pg-boss's default is `true`
 * (`attorney.js` `getConfig`), so forgetting it is the failure mode; `persistQueueStats: false`;
 * no queue is ever created with `partition: true` (src/selftest.ts). `0006` is the only thing that
 * creates or changes schema `pgboss`; a pg-boss version bump is a new migration.
 */
import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import type { ConstructorOptions } from 'pg-boss';
import { WorkerRefusal } from './refusal.ts';

export const PGBOSS_SCHEMA = 'pgboss';
export const RUNTIME_ROLE = 'app_rw';
export const APPLICATION_NAME = 'kinvara-worker';

/** How long a graceful stop waits for in-flight jobs. Under PID 1's GROUP_DRAIN_MS (25 s,
 *  docker/app-runtime/entrypoint.mjs) and the 30 s `stop_grace_period` compose declares; a job
 *  still running at this point is failed by pg-boss (`failWip`: "pg-boss shut down while active")
 *  and retried by its queue's policy. */
export const STOP_TIMEOUT_MS = 20_000;

/** The heartbeat the image's HEALTHCHECK reads (docker/app-runtime/healthcheck.mjs: `{ "at" }`
 *  fresher than KINVARA_HEARTBEAT_MAX_AGE_MS, default 15000). OD-198. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_PATH = process.env['KINVARA_HEARTBEAT'] ?? '/tmp/kinvara-heartbeat';

/** The libpq startup option that makes every session `app_rw` before its first statement. */
const ROLE_OPTION = `-c role=${RUNTIME_ROLE}`;

export interface ConnectionSettings {
  readonly connectionString: string;
  readonly application_name: string;
  readonly options: string;
  readonly connectionTimeoutMillis: number;
}

export function connectionSettings(env: NodeJS.ProcessEnv = process.env): ConnectionSettings {
  const connectionString = env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new WorkerRefusal('config', 'DATABASE_URL is not set, so there is no database');
  }
  return {
    connectionString,
    application_name: APPLICATION_NAME,
    options: ROLE_OPTION,
    connectionTimeoutMillis: 10_000,
  };
}

export function poolConfig(settings: ConnectionSettings): PoolConfig {
  return { ...settings, max: 2 };
}

/**
 * pg-boss's constructor options. `options` (the role) is not in pg-boss's `ConstructorOptions`
 * type, but pg-boss hands its whole config to `new pg.Pool(config)` (`dist/db.js`), so it reaches
 * every connection of pg-boss's pool. That it does is held by the refusal evidence, not by this
 * type: with it, `migrate: true` is refused `42501` under the superuser login. pg-boss opens a
 * LISTEN client only under `useListenNotify` (`dist/index.js`), which is off below, so there is
 * none; whether the option would reach one is not measured.
 */
export function bossConfig(settings: ConnectionSettings): ConstructorOptions {
  const config: ConstructorOptions & { readonly options: string } = {
    ...settings,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    persistQueueStats: false,
    persistWarnings: false,
    supervise: true,
    schedule: true,
    useListenNotify: false,
    max: 4,
  };
  return config;
}

/**
 * The pgboss schema version THIS pg-boss requires, read from pg-boss's own package.json
 * (`"pgboss": { "schema": 37 }` at 12.26.4) — the same number its `contractor.check()` compares.
 */
export function requiredSchemaVersion(): number {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(import.meta.resolve('pg-boss/package.json')), 'utf8'),
  );
  const pgboss =
    typeof raw === 'object' && raw !== null && 'pgboss' in raw ? raw.pgboss : undefined;
  const schema =
    typeof pgboss === 'object' && pgboss !== null && 'schema' in pgboss ? pgboss.schema : undefined;
  if (typeof schema !== 'number' || !Number.isInteger(schema)) {
    throw new WorkerRefusal('config', "pg-boss's package.json carries no integer pgboss.schema");
  }
  return schema;
}

export function pgBossVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(import.meta.resolve('pg-boss/package.json')), 'utf8'),
  );
  const version =
    typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  return typeof version === 'string' ? version : 'unknown';
}
