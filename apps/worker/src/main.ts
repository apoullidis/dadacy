/**
 * `pnpm --filter @kinvara/worker start` — what the image runs. `start` is `node src/main.ts`: its
 * first word is an executable file on the spawn's PATH, so docker/app-runtime/entrypoint.mjs takes
 * the ARGV path (T-185 § contract 1, 5) and this process is PID 1's direct child; the boot line
 * reads `mode=real  running start (node src/main.ts) as a direct child`.
 *
 * A NESTJS 11 APPLICATION CONTEXT, NO HTTP ADAPTER (T-242, OE-79). `createApplicationContext`
 * builds the module graph and runs its lifecycle hooks; unlike `NestFactory.create` it creates no
 * HTTP adapter and opens no listening socket (`T-034`: a worker has no port). The no-socket
 * property is asserted in the running container by `apps/worker/tools/no-listen.sh`.
 *
 * THE LIFECYCLE
 *   1. Nest builds `WorkerModule` (src/worker.module.ts). `BossHost.onModuleInit`
 *      (src/boss-host.ts) connects as `app_rw`, preflights (src/preflight.ts, SELECTs only) and
 *      refuses to start on any finding before pg-boss issues a statement; then starts pg-boss
 *      12.26.4 with `migrate: false` (src/config.ts), whose own `contractor.check()` compares the
 *      schema version a second time. The scheduler runs in this process (`schedule: true`).
 *   2. Every handler provider registers in its `onApplicationBootstrap` (src/selftest.handler.ts).
 *   3. Here, once the context is up: beat the heartbeat the image's HEALTHCHECK reads
 *      (src/heartbeat.ts, OD-198) — so the first beat follows pg-boss's start and every handler.
 *   4. On the first SIGTERM/SIGINT: stop beating; `BossHost.drain()` — stop fetching, let
 *      in-flight jobs finish (up to STOP_TIMEOUT_MS), stop pg-boss; and only THEN `app.close()`,
 *      which runs every module's teardown hooks (a handler's injected services release their
 *      resources there) and closes the worker's pool; then exit 0. The drain is not a Nest hook
 *      because Nest runs this app's teardown root-first and pg-boss's module is the deepest, so a
 *      hook-borne drain ran after the services its handlers use were torn down (T-242 rework 1,
 *      QA-F1 / OD-293; src/boss-host.ts). A second signal exits 1 at once. A signal that arrives
 *      while the context is still booting is held until it is up, and then drains the same way
 *      (nothing else stops pg-boss under a booting module).
 *      Nest's own `enableShutdownHooks` is NOT used: it re-raises the signal after the hooks
 *      (`process.kill(process.pid, signal)`, @nestjs/core nest-application-context.js), which
 *      would end the process as 143, not 0, and it ignores a second signal.
 *
 * NO CHILD PROCESS. Nothing here, nothing in pg-boss 12.26.4's `dist/`, and nothing NestJS's
 * application context starts spawns one, so the process group PID 1 waits on holds this process
 * alone and empties when it exits (OD-196; re-measured in the image, state/EP-2/T-242.md).
 *
 * EXIT CODES: 0 drained; 1 boot failure, second signal, a failed stop or a failed teardown;
 * 2 refused to start (REFUSED_EXIT). Exit 0 does NOT say every job in flight completed, and
 * neither does the verdict line: it begins `drained:` only when nothing was still running at the
 * stop, no handler rejected and pg-boss emitted no `error` event after the signal, and pg-boss was
 * stopped before `close()`; otherwise `drain finished with` and the three counts. A job pg-boss
 * fails inside its own race while the handler does not reject — past its queue's
 * `expireInSeconds` (measured: QA mutant `expire6`, T-242 QA2-F1), or a `perJobResults` 'failed'
 * disposition (read, not run) — is in none of the counts, so `drained:` can be printed over it.
 * Whether a job completed is its state in `pgboss.job` (tools/drain-check.sh, check A).
 * `abortOnError: false` is what makes a failed boot an exception here rather than Nest's default
 * `process.abort()` (SIGABRT, 134) with no banner.
 */
import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { BossHost, type StopReport } from './boss-host.ts';
import { HEARTBEAT_PATH, STOP_TIMEOUT_MS } from './config.ts';
import { startHeartbeat, type Heartbeat } from './heartbeat.ts';
import { describe, log, WorkerNestLogger } from './log.ts';
import { REFUSED_EXIT, WorkerRefusal } from './refusal.ts';
import { PG_POOL } from './runtime.module.ts';
import { WorkerModule } from './worker.module.ts';

let app: INestApplicationContext | undefined;
let heartbeat: Heartbeat | undefined;
let pendingSignal: string | undefined;
let signalledAt = 0;
let draining = false;

async function drain(context: INestApplicationContext, signal: string): Promise<void> {
  const host = context.get(BossHost);
  log(
    `${signal}: fetching no new jobs; waiting up to ${String(STOP_TIMEOUT_MS)}ms for ` +
      `${String(host.inFlight)} in-flight job(s)`,
  );
  let report: StopReport;
  try {
    // FIRST, and awaited: pg-boss stops before close() runs any module's teardown hook.
    report = await host.drain();
  } catch (thrown) {
    log(`drain: stop failed (${describe(thrown)}), exiting 1`);
    process.exit(1);
  }
  // The elapsed time is printed, not inferred: pg-boss's stop() can return with jobs still
  // running BEFORE the timeout (T-148 QA-A1: a non-graceful stop returned at 0.20 s).
  const elapsedMs = Math.round(performance.now() - signalledAt);
  log(
    `pg-boss stopped ${String(elapsedMs)}ms after ${signal} (graceful timeout ` +
      `${String(STOP_TIMEOUT_MS)}ms): ${String(report.stillRunning)} ` +
      `still running, ${String(report.handlerFailures)} handler failure(s), ` +
      `${String(report.bossErrors)} pg-boss error(s) since the signal; closing the application ` +
      `context (module teardown hooks run now)`,
  );
  try {
    await context.close();
  } catch (thrown) {
    log(`drain: pg-boss stopped, then a module's teardown failed (${describe(thrown)}), exiting 1`);
    process.exit(1);
  }
  const clean =
    report.beforeClose &&
    report.stillRunning === 0 &&
    report.handlerFailures === 0 &&
    report.bossErrors === 0;
  log(
    clean
      ? 'drained: 0 in flight, 0 handler failures, 0 pg-boss errors since the signal; exiting 0'
      : `drain finished with ${String(report.stillRunning)} job(s) still running when pg-boss's ` +
          `stop returned (pg-boss fails those through their queue's retry policy, failWip), ` +
          `${String(report.handlerFailures)} handler failure(s) and ` +
          `${String(report.bossErrors)} pg-boss error(s) since the signal` +
          (report.beforeClose ? '' : ', and pg-boss was stopped only after module teardown') +
          `; exiting 0`,
  );
  process.exit(0);
}

function onSignal(signal: string): void {
  if (draining || pendingSignal !== undefined) {
    log(`second signal (${signal}) — abandoning the drain, exiting 1`);
    process.exit(1);
  }
  signalledAt = performance.now();
  heartbeat?.stop();
  if (app === undefined) {
    pendingSignal = signal;
    log(`${signal} while the application context is booting; it drains as soon as it is up`);
    return;
  }
  draining = true;
  void drain(app, signal);
}

process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

try {
  app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new WorkerNestLogger(log),
    abortOnError: false,
  });
} catch (thrown) {
  const pending = pendingSignal === undefined ? '' : ` (${pendingSignal} was pending)`;
  if (thrown instanceof WorkerRefusal) {
    log(
      `WORKER REFUSED (${thrown.reason}): ${thrown.message}; exiting ${String(REFUSED_EXIT)}${pending}`,
    );
    process.exit(REFUSED_EXIT);
  }
  log(`WORKER BOOT FAILED (${describe(thrown)})${pending}, exiting 1`);
  process.exit(1);
}

if (pendingSignal !== undefined) {
  draining = true;
  await drain(app, pendingSignal);
} else {
  const started = await startHeartbeat(app.get<symbol, Pool>(PG_POOL), HEARTBEAT_PATH, log);
  heartbeat = started;
  // A signal during the first beat found `heartbeat` unset and could not stop it.
  if (draining) started.stop();
  // READ, not restated: an INestApplication (NestFactory.create) carries an HTTP adapter and
  // answers getHttpAdapter; an application context does not have the method at all.
  const adapter = 'getHttpAdapter' in app ? 'WITH an HTTP adapter' : 'no HTTP adapter';
  log(
    `ready: NestJS application context (${adapter}); consuming ` +
      `${app.get(BossHost).queues.join(', ')}; scheduler on; heartbeat -> ${HEARTBEAT_PATH}`,
  );
}
