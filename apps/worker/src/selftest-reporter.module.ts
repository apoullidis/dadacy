/**
 * `SelftestReporterModule` — a trivial module that STANDS IN FOR A `core` MODULE (T-242): it
 * provides and exports one service, `SelftestReporter`, which the `worker.selftest` handler
 * (src/selftest.handler.ts, in another module) injects. The point is the shape a later queue ticket
 * needs — a handler provider injecting a service some other module exports — exercised in the
 * container: every notification the handler sends is sent BY THIS SERVICE and carries
 * `via: 'SelftestReporter'`, which test (a) asserts. If the injection broke, the handler would
 * hold `undefined` and every job would fail; if the module were not imported, Nest would refuse
 * to boot.
 *
 * IT OWNS A RESOURCE AND RELEASES IT IN A NEST TEARDOWN HOOK, on purpose (T-242 rework 1, QA-F1 /
 * OD-293): its own `pg.Pool`, `end()`ed in `onModuleDestroy` — the shape apps/core's `Database`
 * has (`onApplicationShutdown`, apps/core/src/identity/database.ts), in the earliest of Nest's
 * teardown passes. So every stop of the real worker exercises the order src/main.ts promises:
 * pg-boss drains first, this pool closes after. If the order regressed, the in-flight job's last
 * notification would hit an ended pool and the job would fail; apps/worker/tools/drain-check.sh
 * judges that (A), the worker's verdict line (S), and the order of the two log lines (O).
 *
 * It is not `core`'s code: the worker image carries `apps/worker` only (docker/app.Dockerfile
 * copies `apps/${APP}`), so importing a real `apps/core` module from here would compile in the
 * toolbox and fail in the image. That is the next queue ticket's question, stated in T-242's
 * contract.
 */
import type { OnModuleDestroy } from '@nestjs/common';
import { Module } from '@nestjs/common';
import pg from 'pg';
import type { Pool } from 'pg';
import { poolConfig, type ConnectionSettings } from './config.ts';
import { describe, type WorkerLog } from './log.ts';
import { CONNECTION_SETTINGS, WORKER_LOG, WorkerRuntimeModule } from './runtime.module.ts';
import { SELFTEST_CHANNEL } from './selftest.ts';

/** The line `onModuleDestroy` prints before it ends the pool; drain-check.sh's check O reads it. */
export const REPORTER_TEARDOWN_LINE = 'SelftestReporter: onModuleDestroy, ending its own pool';

export class SelftestReporter implements OnModuleDestroy {
  static readonly NAME = 'SelftestReporter';
  readonly #pool: Pool;
  readonly #log: WorkerLog;

  constructor(settings: ConnectionSettings, log: WorkerLog) {
    // Its own pool, as a `core` module would own its own: one connection, the worker's role option.
    this.#pool = new pg.Pool({ ...poolConfig(settings), max: 1 });
    this.#pool.on('error', (thrown) =>
      log(`SelftestReporter: an idle database connection failed (${describe(thrown)})`),
    );
    this.#log = log;
  }

  /** `pg_notify` on the selftest channel, stamped with this service's name. */
  async notify(fields: Record<string, unknown>): Promise<void> {
    await this.#pool.query('SELECT pg_notify($1, $2)', [
      SELFTEST_CHANNEL,
      JSON.stringify({ ...fields, via: SelftestReporter.NAME }),
    ]);
  }

  async onModuleDestroy(): Promise<void> {
    this.#log(REPORTER_TEARDOWN_LINE);
    await this.#pool.end();
  }
}

export class SelftestReporterModule {}
Module({
  imports: [WorkerRuntimeModule],
  providers: [
    {
      provide: SelftestReporter,
      useFactory: (settings: ConnectionSettings, log: WorkerLog) =>
        new SelftestReporter(settings, log),
      inject: [CONNECTION_SETTINGS, WORKER_LOG],
    },
  ],
  exports: [SelftestReporter],
})(SelftestReporterModule);
