/**
 * `WorkerDatabaseModule` — the worker's binding of `@kinvara/core-modules`' `Database` (T-245,
 * OD-292a): the package's shared runtime, bound to `WorkerRuntimeModule`'s `CONNECTION_SETTINGS`,
 * so every connection `Database` opens carries the same libpq `-c role=app_rw` and
 * `application_name = 'kinvara-worker'` as the worker's own pool and pg-boss's (src/config.ts).
 * `withAppRw` still runs `SET LOCAL ROLE app_rw` in each transaction, as it does in `core`.
 *
 * THE ONE PLACE THE WORKER CALLS `DatabaseModule.forRoot`. A queue's module that needs `Database`
 * (a module of `packages/core-modules/src/<module>/`, or a handler) imports THIS module; a second
 * `forRoot` would open a second pool. `max: 2` matches the worker's own pool (src/config.ts).
 *
 * `Database.onApplicationShutdown` ends its pool in Nest's teardown, which src/main.ts runs only
 * after `BossHost.drain()` has returned (T-242 RW1-C §2 row 2), so an in-flight handler keeps it.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@kinvara/core-modules/runtime';
import type { ConnectionSettings } from './config.ts';
import type { WorkerLog } from './log.ts';
import { CONNECTION_SETTINGS, WORKER_LOG, WorkerRuntimeModule } from './runtime.module.ts';

const WORKER_DATABASE = DatabaseModule.forRoot({
  imports: [WorkerRuntimeModule],
  inject: [CONNECTION_SETTINGS, WORKER_LOG],
  useFactory: (settings: ConnectionSettings, log: WorkerLog) => ({
    source: { ...settings, max: 2 },
    log,
  }),
});

export class WorkerDatabaseModule {}
Module({
  imports: [WORKER_DATABASE],
  exports: [WORKER_DATABASE],
})(WorkerDatabaseModule);
