/**
 * THE TRANSACTIONAL ENQUEUE (T-149; SD §BE-11 line 1313, §BE-14 lines 1504–1511; SA §SA-5).
 *
 * SD 1313: "a job that must fire because of a state change is enqueued in the same transaction as
 * that state change. No job is enqueued from an HTTP response handler after commit." So
 * `JobEnqueuer.enqueue` takes the caller's `Tx` — the open `withAppRw` transaction the state change
 * is written in — and nothing else will do:
 *
 *   - AT COMPILE TIME, `tx` is a required parameter of the BRANDED `Tx` type, which only
 *     `Database.withAppRw` mints. Omitting it, passing `undefined`, or passing a pool-bound
 *     `drizzle(pool)` handle does not compile (`type-tests/enqueue-refusals.ts`, `pnpm -w typecheck`).
 *   - AT RUN TIME, `assertOpenTx(tx)` refuses a `Tx` whose transaction has ended (kept past
 *     `withAppRw`'s return) with `TransactionClosedError`, before anything is sent: its connection is
 *     back in the pool, and a statement on it would run in autocommit — a job after commit.
 *
 * VALIDATION IS INSIDE THE TRANSACTION (SD 1507–1509: "a Zod failure INSIDE the enqueuing
 * transaction, so the state change rolls back with it"). The payload is parsed against the job's
 * own schema BEFORE anything is sent; a failure throws `JobPayloadRefusedError`, which propagates
 * out of the caller's `work` and rolls the transaction back — UNLESS the caller catches it inside
 * `work`, which this module cannot prevent. What is stored is the schema's OUTPUT, not the input.
 * Notify-bearing payloads extend `NotifyJobBase` with `.extend()` (T-147 § contract §1, §7).
 *
 * THE SEND RUNS ON THE CALLER'S CONNECTION. pg-boss 12.26.4's `send(name, data, { db })` executes
 * its insert on the supplied `db` (`manager.js` `createJob`), and `fromDrizzle(tx, sql)` (pg-boss's
 * own adapter) routes each statement through `tx.execute`, i.e. on the transaction's one pooled
 * connection. The queue's metadata is still read by the SENDER on its own pool (`getQueueCache`),
 * so the sender must be a STARTED `PgBoss` and the queue must already exist (committed).
 * pg-boss 12.26.4 has no SQL-callable `pgboss.send(...)` (G11, measured in T-149's evidence).
 *
 * THE REFUSAL NEVER ECHOES THE PAYLOAD (PROTOCOL §9.2): it carries the queue name (code-defined)
 * and each issue's path and Zod code only.
 */
import { sql } from 'drizzle-orm';
import { fromDrizzle, type SendOptions } from 'pg-boss';
import type { z } from 'zod';
import { assertOpenTx, type Tx } from '../runtime/database.ts';

/** A queue and the schema every payload sent to it must pass. */
export interface JobDefinition<S extends z.ZodType<object>> {
  readonly queue: string;
  readonly payload: S;
}

/** Fixed text: the queue name must be a non-empty string. */
export const JOB_QUEUE_REFUSED = 'jobs: a job definition needs a non-empty queue name';

/** Declare a job: its queue name and its payload schema. */
export function defineJob<S extends z.ZodType<object>>(
  queue: string,
  payload: S,
): JobDefinition<S> {
  if (typeof queue !== 'string' || queue === '') throw new TypeError(JOB_QUEUE_REFUSED);
  return Object.freeze({ queue, payload });
}

/**
 * What the enqueue needs from pg-boss: a STARTED `PgBoss`'s `send(name, data, options)` overload.
 * A `PgBoss` is assignable to it (CONTROL in `type-tests/enqueue-refusals.ts`); a worker handler
 * passes `BossHost`'s instance.
 */
export interface JobSender {
  send(name: string, data: object, options: SendOptions): Promise<string | null>;
}

/** pg-boss's send options, without `db`: the connection is always the caller's `Tx`. */
export type EnqueueOptions = Omit<SendOptions, 'db'>;

/** One refused field: its path in the payload and Zod's issue code. Never the value. */
export interface PayloadIssue {
  readonly path: string;
  readonly code: string;
}

/**
 * A payload that failed its job's schema. Thrown inside the caller's transaction, before anything
 * is sent. Carries the queue and each issue's path and code — never the payload or a value from it.
 */
export class JobPayloadRefusedError extends Error {
  override readonly name = 'JobPayloadRefusedError';
  readonly queue: string;
  readonly issues: readonly PayloadIssue[];
  constructor(queue: string, issues: readonly PayloadIssue[]) {
    super(
      `jobs: the payload for queue "${queue}" failed its schema at ` +
        `${issues.map((i) => `${i.path === '' ? '(root)' : i.path} (${i.code})`).join(', ')}; ` +
        'nothing was enqueued',
    );
    this.queue = queue;
    this.issues = Object.freeze(issues.map((i) => Object.freeze({ ...i })));
  }
}

export class JobEnqueuer {
  readonly #sender: JobSender;

  constructor(sender: JobSender) {
    this.#sender = sender;
  }

  /**
   * Validate `input` against `job.payload` and send the parsed payload to `job.queue` ON `tx`, the
   * caller's open transaction. Resolves the job id, or `null` when pg-boss suppressed the job (a
   * singleton or throttling option, or a policy, matched an existing one). Rejects
   * `TransactionClosedError` or `JobPayloadRefusedError` without sending anything.
   */
  async enqueue<S extends z.ZodType<object>>(
    tx: Tx,
    job: JobDefinition<S>,
    input: z.input<S>,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    assertOpenTx(tx);
    const parsed = job.payload.safeParse(input);
    if (!parsed.success) {
      throw new JobPayloadRefusedError(
        job.queue,
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
        })),
      );
    }
    return await this.#sender.send(job.queue, parsed.data, {
      ...options,
      db: fromDrizzle(tx, sql),
    });
  }
}
