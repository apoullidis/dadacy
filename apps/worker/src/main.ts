/**
 * `pnpm --filter @kinvara/worker start` — what the image runs. `start` is `node src/main.ts`: its
 * first word is an executable file on the spawn's PATH, so docker/app-runtime/entrypoint.mjs takes
 * the ARGV path (T-185 § contract 1, 5) and this process is PID 1's direct child; the boot line
 * reads `mode=real  running start (node src/main.ts) as a direct child`.
 *
 * THE LIFECYCLE
 *   1. connect as `app_rw` and preflight (src/preflight.ts, SELECTs only) — refuse to start,
 *      exit 2, on any finding, before pg-boss issues a statement;
 *   2. start pg-boss 12.26.4 with `migrate: false` (src/config.ts); its own `contractor.check()`
 *      then compares the schema version a second time;
 *   3. register the handlers (src/selftest.ts) — the scheduler runs in this process too
 *      (`schedule: true`, pg-boss's timekeeper);
 *   4. beat the heartbeat the image's HEALTHCHECK reads (src/heartbeat.ts, OD-198);
 *   5. on the first SIGTERM/SIGINT: stop beating, stop fetching, let in-flight jobs finish (up to
 *      STOP_TIMEOUT_MS), close the pools, exit 0. A second signal exits 1 at once.
 *
 * NO CHILD PROCESS. Nothing here, and nothing in pg-boss 12.26.4's `dist/`, spawns one (no
 * child_process, worker_threads or cluster), so the process group PID 1 waits on holds this
 * process alone and empties when it exits (OD-196; measured in the image, state/EP-2/T-148.md).
 *
 * EXIT CODES: 0 drained; 1 boot failure or second signal; 2 refused to start (REFUSED_EXIT).
 * Nothing here logs DATABASE_URL. Driver and server errors are logged with their code and message
 * as given; the ones this ticket saw name a role, a database or a schema, never a password.
 */
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { PgBoss } from 'pg-boss';
import {
  bossConfig,
  connectionSettings,
  HEARTBEAT_PATH,
  pgBossVersion,
  poolConfig,
  requiredSchemaVersion,
  RUNTIME_ROLE,
  STOP_TIMEOUT_MS,
} from './config.ts';
import { startHeartbeat, type Heartbeat } from './heartbeat.ts';
import { preflight } from './preflight.ts';
import { REFUSED_EXIT, WorkerRefusal } from './refusal.ts';
import { registerSelftest, SELFTEST_QUEUE, type InFlight } from './selftest.ts';

const log = (line: string): void => {
  process.stderr.write(`[worker] ${line}\n`);
};

/**
 * `code=<sqlstate|none> <message>[ queue=<name>]`. pg-boss emits a worker's fetch error as a PLAIN
 * OBJECT spread from the Error (`{ ...error, message, stack, queue, worker }`, dist/manager.js),
 * so `instanceof Error` alone would print `[object Object]` — measured in the image before this
 * read the `message` property (state/EP-2/T-148.md). The stack is never logged.
 */
function describe(thrown: unknown): string {
  const field = (key: string): unknown =>
    typeof thrown === 'object' && thrown !== null && key in thrown
      ? (thrown as Record<string, unknown>)[key]
      : undefined;
  const code = field('code');
  const message = field('message');
  const queue = field('queue');
  return (
    `code=${typeof code === 'string' ? code : 'none'} ` +
    `${typeof message === 'string' ? message : String(thrown)}` +
    (typeof queue === 'string' ? ` queue=${queue}` : '')
  );
}

const inFlight: InFlight = { count: 0 };
let pool: Pool | undefined;
let boss: PgBoss | undefined;
let heartbeat: Heartbeat | undefined;
let draining = false;

async function drain(signal: string): Promise<void> {
  if (draining) {
    log(`second signal (${signal}) — abandoning the drain, exiting 1`);
    process.exit(1);
  }
  draining = true;
  heartbeat?.stop();
  if (boss === undefined) {
    log(`${signal} before pg-boss started — nothing in flight, exiting 0`);
    process.exit(0);
  }
  log(
    `${signal}: fetching no new jobs; waiting up to ${String(STOP_TIMEOUT_MS)}ms for ` +
      `${String(inFlight.count)} in-flight job(s)`,
  );
  try {
    await boss.stop({ graceful: true, close: true, timeout: STOP_TIMEOUT_MS });
    await pool?.end();
  } catch (thrown) {
    log(`drain: stop failed (${describe(thrown)}), exiting 1`);
    process.exit(1);
  }
  log(`drained: ${String(inFlight.count)} in flight, exiting 0`);
  process.exit(0);
}

process.on('SIGTERM', () => void drain('SIGTERM'));
process.on('SIGINT', () => void drain('SIGINT'));

async function boot(): Promise<void> {
  const settings = connectionSettings();
  const requiredVersion = requiredSchemaVersion();
  pool = new pg.Pool(poolConfig(settings));
  pool.on('error', (thrown) => log(`an idle database connection failed (${describe(thrown)})`));

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (thrown) {
    throw new WorkerRefusal(
      'database',
      `could not open a session as ${RUNTIME_ROLE} (${describe(thrown)})`,
    );
  }
  const found = await (async () => {
    try {
      return await preflight(client, requiredVersion);
    } finally {
      client.release();
    }
  })();
  log(
    `mode=real  pg-boss ${pgBossVersion()} against schema pgboss v${String(found.schemaVersion)}; ` +
      `login ${found.sessionUser} (superuser=${String(found.sessionIsSuperuser)}), running as ` +
      `${found.currentUser} (startup option -c role=${RUNTIME_ROLE}); migrate=false`,
  );

  const instance = new PgBoss(bossConfig(settings));
  instance.on('error', (thrown) => log(`pg-boss error (${describe(thrown)})`));
  instance.on('warning', (warning) => log(`pg-boss warning: ${warning.message}`));
  try {
    await instance.start();
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : '';
    if (
      message === 'pg-boss database requires migrations' ||
      message === 'pg-boss is not installed'
    ) {
      throw new WorkerRefusal('schema-version', `pg-boss refused the schema: ${message}`);
    }
    throw thrown;
  }
  boss = instance;
  if (draining) return;

  await registerSelftest(instance, pool, inFlight, log);
  if (draining) return;
  heartbeat = await startHeartbeat(pool, HEARTBEAT_PATH, log);
  log(`ready: consuming ${SELFTEST_QUEUE}; scheduler on; heartbeat -> ${HEARTBEAT_PATH}`);
}

try {
  await boot();
} catch (thrown) {
  // A stop signal during boot: drain() owns the exit, and a boot step failing because pg-boss was
  // stopped under it is not a boot failure.
  if (draining) {
    log(`boot interrupted by a stop signal (${describe(thrown)}); the drain decides the exit`);
  } else if (thrown instanceof WorkerRefusal) {
    log(`WORKER REFUSED (${thrown.reason}): ${thrown.message}; exiting ${String(REFUSED_EXIT)}`);
    process.exit(REFUSED_EXIT);
  } else {
    log(`WORKER BOOT FAILED (${describe(thrown)}), exiting 1`);
    process.exit(1);
  }
}
