/**
 * The availability module's two queues in the worker (T-089; SD §BE-1 line 926: `worker` runs
 * "jobs (slot materialisation)"; SD §BE-11 line 1352; C10 (a)). It follows the queue pattern
 * src/selftest.handler.ts states (T-242): a provider built by a factory with an explicit `inject`
 * list; in `onApplicationBootstrap`, `createQueue` then `updateQueue` with the queue's options,
 * then `BossHost.work(...)`; never `partition: true`.
 *
 *   `search.slot_materialise {sitterId}` — one `Database.withAppRw` transaction calling
 *       `materialiseSitter` (`@kinvara/core-modules/availability`): E.3 U-11's lock, the reads,
 *       `DELETE` then one `INSERT` (T-163 § Published contract — LIVE §2). A throw rolls the
 *       transaction back and fails the job; pg-boss retries it (three attempts, SD 1352).
 *   `search.slot_materialise_nightly {}` — scheduled `SLOT_MATERIALISE_NIGHTLY_CRON` in
 *       `Europe/Nicosia` (C10 (a): the roll SD's job table omits, EV-n). One transaction reads
 *       every `sitter_profile` id and enqueues `search.slot_materialise {sitterId}` for each, on
 *       that same `Tx`, through `JobEnqueuer` with `BossHost`'s pg-boss (T-149 § contract §4, §7:
 *       never a second `PgBoss`). So a sitter who edits nothing keeps a full 56-day horizon.
 *       `boss.schedule` is an upsert on (queue, key), so every boot converges the one schedule.
 *
 * The handler reads its input from the job alone; the payload is parsed with the queue's own
 * schema and a refused payload fails the job without touching a table.
 */
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import {
  materialiseSitter,
  SLOT_MATERIALISE_JOB,
  SLOT_MATERIALISE_NIGHTLY_CRON,
  SLOT_MATERIALISE_NIGHTLY_JOB,
  SLOT_MATERIALISE_NIGHTLY_QUEUE,
  SLOT_MATERIALISE_NIGHTLY_QUEUE_OPTIONS,
  SLOT_MATERIALISE_NIGHTLY_TZ,
  SLOT_MATERIALISE_QUEUE,
  SLOT_MATERIALISE_QUEUE_OPTIONS,
} from '@kinvara/core-modules/availability';
import { JobEnqueuer } from '@kinvara/core-modules/jobs';
import { Database } from '@kinvara/core-modules/runtime';
import { ulid } from '@kinvara/domain-types';
import { BossHost } from './boss-host.ts';
import { WorkerDatabaseModule } from './database.module.ts';
import type { WorkerLog } from './log.ts';
import { WORKER_LOG, WorkerRuntimeModule } from './runtime.module.ts';

/** What a `search.slot_materialise` job returns (stored by pg-boss as the job's `output`). */
export interface SlotMaterialiseOutput {
  readonly sitterFound: boolean;
  readonly bookable: boolean;
  readonly today: string;
  readonly deleted: number;
  readonly written: number;
  readonly clusterIds: readonly number[];
}

/** What a `search.slot_materialise_nightly` job returns. */
export interface SlotMaterialiseNightlyOutput {
  readonly enqueued: number;
}

export class AvailabilityHandler implements OnApplicationBootstrap {
  readonly #host: BossHost;
  readonly #db: Database;
  readonly #log: WorkerLog;

  constructor(host: BossHost, db: Database, log: WorkerLog) {
    this.#host = host;
    this.#db = db;
    this.#log = log;
  }

  async onApplicationBootstrap(): Promise<void> {
    const boss = this.#host.boss;
    await boss.createQueue(SLOT_MATERIALISE_QUEUE, { ...SLOT_MATERIALISE_QUEUE_OPTIONS });
    await boss.updateQueue(SLOT_MATERIALISE_QUEUE, { ...SLOT_MATERIALISE_QUEUE_OPTIONS });
    await boss.createQueue(SLOT_MATERIALISE_NIGHTLY_QUEUE, {
      ...SLOT_MATERIALISE_NIGHTLY_QUEUE_OPTIONS,
    });
    await boss.updateQueue(SLOT_MATERIALISE_NIGHTLY_QUEUE, {
      ...SLOT_MATERIALISE_NIGHTLY_QUEUE_OPTIONS,
    });
    await boss.schedule(
      SLOT_MATERIALISE_NIGHTLY_QUEUE,
      SLOT_MATERIALISE_NIGHTLY_CRON,
      {},
      {
        tz: SLOT_MATERIALISE_NIGHTLY_TZ,
      },
    );
    const workOptions = { batchSize: 1, pollingIntervalSeconds: 1 } as const;
    await this.#host.work<unknown, SlotMaterialiseOutput, typeof workOptions>(
      SLOT_MATERIALISE_QUEUE,
      workOptions,
      async (jobs: Job<unknown>[]) => this.#materialise(jobs),
    );
    await this.#host.work<unknown, SlotMaterialiseNightlyOutput, typeof workOptions>(
      SLOT_MATERIALISE_NIGHTLY_QUEUE,
      workOptions,
      async (jobs: Job<unknown>[]) => this.#nightly(jobs),
    );
  }

  async #materialise(jobs: Job<unknown>[]): Promise<SlotMaterialiseOutput> {
    const job = jobs[0];
    if (job === undefined) throw new Error(`${SLOT_MATERIALISE_QUEUE}: called with no job`);
    const parsed = SLOT_MATERIALISE_JOB.payload.safeParse(job.data);
    if (!parsed.success) throw new Error(`${SLOT_MATERIALISE_QUEUE}: refused payload`);
    const result = await this.#db.withAppRw((tx) => materialiseSitter(tx, parsed.data.sitterId));
    this.#log(
      `${SLOT_MATERIALISE_QUEUE} job ${job.id}: deleted ${String(result.deleted)}, ` +
        `wrote ${String(result.spans.length)} slot(s)`,
    );
    return {
      sitterFound: result.sitterFound,
      bookable: result.bookable,
      today: result.today,
      deleted: result.deleted,
      written: result.spans.length,
      clusterIds: result.clusterIds,
    };
  }

  async #nightly(jobs: Job<unknown>[]): Promise<SlotMaterialiseNightlyOutput> {
    const job = jobs[0];
    if (job === undefined) throw new Error(`${SLOT_MATERIALISE_NIGHTLY_QUEUE}: called with no job`);
    const parsed = SLOT_MATERIALISE_NIGHTLY_JOB.payload.safeParse(job.data ?? {});
    if (!parsed.success) throw new Error(`${SLOT_MATERIALISE_NIGHTLY_QUEUE}: refused payload`);
    const enqueuer = new JobEnqueuer(this.#host.boss);
    const enqueued = await this.#db.withAppRw(async (tx) => {
      const ids = (
        await tx.execute<{ id: string }>(
          sql`SELECT id::text AS id FROM public.sitter_profile ORDER BY id`,
        )
      ).rows.map((r) => ulid(r.id, 'sitterId'));
      for (const sitterId of ids) {
        await enqueuer.enqueue(tx, SLOT_MATERIALISE_JOB, { sitterId });
      }
      return ids.length;
    });
    this.#log(`${SLOT_MATERIALISE_NIGHTLY_QUEUE} job ${job.id}: enqueued ${String(enqueued)}`);
    return { enqueued };
  }
}

export class AvailabilityModule {}
Module({
  imports: [WorkerRuntimeModule, WorkerDatabaseModule],
  providers: [
    {
      provide: AvailabilityHandler,
      useFactory: (host: BossHost, db: Database, log: WorkerLog) =>
        new AvailabilityHandler(host, db, log),
      inject: [BossHost, Database, WORKER_LOG],
    },
  ],
})(AvailabilityModule);
