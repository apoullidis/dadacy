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
 *   4. On the first SIGTERM/SIGINT: stop beating, then `app.close()`, whose
 *      `onApplicationShutdown` hook on `BossHost` IS the drain — stop fetching, let in-flight jobs
 *      finish (up to STOP_TIMEOUT_MS), close the pools; then exit 0. A second signal exits 1 at
 *      once. A signal that arrives while the context is still booting is held until it is up,
 *      and then drains the same way (nothing else stops pg-boss under a booting module).
 *      Nest's own `enableShutdownHooks` is NOT used: it re-raises the signal after the hooks
 *      (`process.kill(process.pid, signal)`, @nestjs/core nest-application-context.js), which
 *      would end the process as 143, not 0, and it ignores a second signal.
 *
 * NO CHILD PROCESS. Nothing here, nothing in pg-boss 12.26.4's `dist/`, and nothing NestJS's
 * application context starts spawns one, so the process group PID 1 waits on holds this process
 * alone and empties when it exits (OD-196; re-measured in the image, state/EP-2/T-242.md).
 *
 * EXIT CODES: 0 drained; 1 boot failure or second signal; 2 refused to start (REFUSED_EXIT).
 * `abortOnError: false` is what makes a failed boot an exception here rather than Nest's default
 * `process.abort()` (SIGABRT, 134) with no banner.
 */
import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { BossHost } from './boss-host.ts';
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
  try {
    await context.close();
  } catch (thrown) {
    log(`drain: stop failed (${describe(thrown)}), exiting 1`);
    process.exit(1);
  }
  // The elapsed time is printed, not inferred: pg-boss's stop() can return with jobs still
  // running BEFORE the timeout (T-148 QA-A1: a non-graceful stop returned at 0.20 s), so "the
  // deadline was reached" is not something this line may assume. Whatever the cause, pg-boss
  // fails a job still active at stop back to its queue's retry policy (failWip).
  const report = host.stopReport;
  if (report === undefined) {
    // close() returned but BossHost's onApplicationShutdown never ran: pg-boss was not stopped,
    // so nothing may be said about what happened to the jobs in flight.
    log(
      `drain: the context closed but BossHost's onApplicationShutdown did not run; pg-boss was ` +
        `not stopped and ${String(host.inFlight)} job(s) were in flight; exiting 1`,
    );
    process.exit(1);
  }
  const stillRunning = report.stillRunning;
  const elapsedMs = Math.round(performance.now() - signalledAt);
  log(
    stillRunning === 0
      ? 'drained: 0 in flight, exiting 0'
      : `stopped with ${String(stillRunning)} job(s) still running when pg-boss's stop returned, ` +
          `${String(elapsedMs)}ms after ${signal} (graceful timeout ${String(STOP_TIMEOUT_MS)}ms); ` +
          `pg-boss failed them back to their queue's retry policy (failWip); exiting 0`,
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
