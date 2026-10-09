/**
 * The `worker.selftest` handler as a NestJS provider (T-242) — and THE PATTERN A QUEUE'S TICKET
 * FOLLOWS to add its own (T-148 § contract 4 row 3, restated for Nest in T-242's contract):
 *
 *   1. a provider class whose dependencies arrive through its constructor, registered in its
 *      module as a factory with an explicit `inject` list (src/runtime.module.ts says why);
 *   2. in `onApplicationBootstrap` (which Nest runs after every `onModuleInit`, so pg-boss is
 *      started): `createQueue`, then `updateQueue` with the queue's options (the latter converges
 *      an existing queue), then `BossHost.work(...)` — never `boss.work` directly, so the drain
 *      counts the handler in flight;
 *   3. the module imports `WorkerRuntimeModule` and is imported by `WorkerModule`
 *      (src/worker.module.ts). Never `partition: true` (T-146 § contract §3).
 *
 * What the handler does per payload `op` is unchanged from T-148: src/selftest.ts.
 *
 * T-245: THE FIRST HANDLER TO USE A SHARED MODULE'S PROVIDER. It injects `@kinvara/core-modules`'
 * `Database` (bound by src/database.module.ts) and, after the payload's work and before it
 * completes, reads its principal through `Database.withAppRw`: `current_user` inside the
 * transaction, and `role`'s `reset_val` — the value the session resets to, i.e. what the
 * connection's own startup options set, before `SET LOCAL ROLE`. Both go into the job's output as
 * `db`. A `hold` job does that read AFTER its hold, so a job in flight across SIGTERM needs the
 * package's pool after the signal: drain-check A fails if `Database` were torn down before the
 * drain.
 */
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { JobWithMetadata } from 'pg-boss';
import { Database } from '@kinvara/core-modules/runtime';
import { sql } from 'drizzle-orm';
import { BossHost } from './boss-host.ts';
import { WorkerDatabaseModule } from './database.module.ts';
import type { WorkerLog } from './log.ts';
import { WORKER_LOG, WorkerRuntimeModule } from './runtime.module.ts';
import { SelftestReporter, SelftestReporterModule } from './selftest-reporter.module.ts';
import {
  parseSelftest,
  SELFTEST_FAILURE,
  SELFTEST_QUEUE,
  SELFTEST_QUEUE_OPTIONS,
  type SelftestOutput,
} from './selftest.ts';

export class SelftestHandler implements OnApplicationBootstrap {
  readonly #host: BossHost;
  readonly #reporter: SelftestReporter;
  readonly #db: Database;
  readonly #log: WorkerLog;

  constructor(host: BossHost, reporter: SelftestReporter, db: Database, log: WorkerLog) {
    this.#host = host;
    this.#reporter = reporter;
    this.#db = db;
    this.#log = log;
  }

  async onApplicationBootstrap(): Promise<void> {
    const boss = this.#host.boss;
    await boss.createQueue(SELFTEST_QUEUE, { ...SELFTEST_QUEUE_OPTIONS });
    // createQueue is a no-op on an existing queue (pgboss.create_queue); this converges its options.
    await boss.updateQueue(SELFTEST_QUEUE, { ...SELFTEST_QUEUE_OPTIONS });
    const workOptions = { includeMetadata: true, batchSize: 1, pollingIntervalSeconds: 1 } as const;
    await this.#host.work<unknown, SelftestOutput, typeof workOptions>(
      SELFTEST_QUEUE,
      workOptions,
      async (jobs: JobWithMetadata<unknown>[]) => this.#handle(jobs),
    );
  }

  async #handle(jobs: JobWithMetadata<unknown>[]): Promise<SelftestOutput> {
    const job = jobs[0];
    if (job === undefined) throw new Error('worker.selftest: called with no job');
    const attempt = job.retryCount + 1;
    const who = { id: job.id, attempt, host: hostname(), pid: process.pid };
    const data = parseSelftest(job.data);
    if (typeof data === 'string') {
      await this.#reporter.notify({ ...who, phase: 'refused' });
      throw new Error(`worker.selftest: refused payload: ${data}`);
    }
    await this.#reporter.notify({ ...who, tag: data.tag, op: data.op, phase: 'start' });
    this.#log(`selftest job ${job.id} op=${data.op} attempt=${String(attempt)} started`);
    if (data.op === 'throw') throw new Error(SELFTEST_FAILURE);
    if (data.op === 'hold') await sleep(data.holdMs ?? 0);
    const db = await this.#principal();
    await this.#reporter.notify({ ...who, tag: data.tag, op: data.op, phase: 'done' });
    this.#log(`selftest job ${job.id} op=${data.op} attempt=${String(attempt)} completed`);
    return { op: data.op, tag: data.tag, attempt, host: who.host, pid: who.pid, db };
  }

  /** Read through the package's `Database`, in one `withAppRw` transaction. */
  async #principal(): Promise<SelftestOutput['db']> {
    return this.#db.withAppRw(async (tx) => {
      const result = await tx.execute<{ current_user: string; role_at_connect: string }>(
        sql`SELECT current_user::text AS current_user,
                   (SELECT reset_val FROM pg_settings WHERE name = 'role') AS role_at_connect`,
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('worker.selftest: the principal read returned no row');
      return { currentUser: row.current_user, roleAtConnect: row.role_at_connect };
    });
  }
}

export class SelftestModule {}
Module({
  imports: [WorkerRuntimeModule, SelftestReporterModule, WorkerDatabaseModule],
  providers: [
    {
      provide: SelftestHandler,
      useFactory: (host: BossHost, reporter: SelftestReporter, db: Database, log: WorkerLog) =>
        new SelftestHandler(host, reporter, db, log),
      inject: [BossHost, SelftestReporter, Database, WORKER_LOG],
    },
  ],
})(SelftestModule);
