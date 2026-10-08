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
 * It is not `core`'s code: the worker image carries `apps/worker` only (docker/app.Dockerfile
 * copies `apps/${APP}`), so importing a real `apps/core` module from here would compile in the
 * toolbox and fail in the image. That is the next queue ticket's question, stated in T-242's
 * contract.
 */
import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL, WorkerRuntimeModule } from './runtime.module.ts';
import { SELFTEST_CHANNEL } from './selftest.ts';

export class SelftestReporter {
  static readonly NAME = 'SelftestReporter';
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** `pg_notify` on the selftest channel, stamped with this service's name. */
  async notify(fields: Record<string, unknown>): Promise<void> {
    await this.#pool.query('SELECT pg_notify($1, $2)', [
      SELFTEST_CHANNEL,
      JSON.stringify({ ...fields, via: SelftestReporter.NAME }),
    ]);
  }
}

export class SelftestReporterModule {}
Module({
  imports: [WorkerRuntimeModule],
  providers: [
    {
      provide: SelftestReporter,
      useFactory: (pool: Pool) => new SelftestReporter(pool),
      inject: [PG_POOL],
    },
  ],
  exports: [SelftestReporter],
})(SelftestReporterModule);
