/**
 * `WorkerRuntimeModule` — what every queue's module imports: the worker's log sink, its `app_rw`
 * pool, and pg-boss (`BossHost`). Nest modules are singletons, so every importer gets the same
 * pool and the same pg-boss.
 *
 * PROVIDERS ARE FACTORIES WITH AN EXPLICIT `inject` LIST, as in apps/core (T-135 § contract
 * (rework 1); apps/core/src/identity/identity.module.ts). Node runs this as TypeScript source under
 * type stripping, so there is no `emitDecoratorMetadata` and Nest cannot infer a constructor's
 * dependencies: a dependency not named in `inject` arrives as `undefined`, and Nest does not refuse
 * that by itself. A token named in `inject` that no imported module provides IS refused, at boot
 * (`Nest can't resolve dependencies of …`), which the worker reports as `WORKER BOOT FAILED`.
 *
 * Decorators are applied as function calls, `Module({...})(Class)`, for the reason
 * apps/core/src/nest-decorate.ts gives: `@` syntax does not run under Node's type stripping.
 */
import { Module } from '@nestjs/common';
import pg from 'pg';
import type { Pool } from 'pg';
import { BossHost } from './boss-host.ts';
import { connectionSettings, poolConfig, type ConnectionSettings } from './config.ts';
import { describe, log, type WorkerLog } from './log.ts';

/** Injection tokens. A queue's handler injects `PG_POOL` for its own SQL and `WORKER_LOG` to log. */
export const WORKER_LOG = Symbol('kinvara.worker.log');
export const CONNECTION_SETTINGS = Symbol('kinvara.worker.connection-settings');
export const PG_POOL = Symbol('kinvara.worker.pg-pool');

export class WorkerRuntimeModule {}
Module({
  providers: [
    { provide: WORKER_LOG, useValue: log },
    // Throws WorkerRefusal('config') when DATABASE_URL is unset; Nest rethrows it unchanged.
    { provide: CONNECTION_SETTINGS, useFactory: () => connectionSettings() },
    {
      provide: PG_POOL,
      useFactory: (settings: ConnectionSettings, sink: WorkerLog): Pool => {
        const pool = new pg.Pool(poolConfig(settings));
        pool.on('error', (thrown) =>
          sink(`an idle database connection failed (${describe(thrown)})`),
        );
        return pool;
      },
      inject: [CONNECTION_SETTINGS, WORKER_LOG],
    },
    {
      provide: BossHost,
      useFactory: (settings: ConnectionSettings, pool: Pool, sink: WorkerLog) =>
        new BossHost(settings, pool, sink),
      inject: [CONNECTION_SETTINGS, PG_POOL, WORKER_LOG],
    },
  ],
  exports: [WORKER_LOG, PG_POOL, BossHost],
})(WorkerRuntimeModule);
