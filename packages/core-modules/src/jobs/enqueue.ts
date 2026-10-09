/**
 * THE TRANSACTIONAL ENQUEUE (T-149; SD §BE-11 line 1313, §BE-14 lines 1504–1511; SA §SA-5).
 *
 * SD 1313: "a job that must fire because of a state change is enqueued in the same transaction as
 * that state change. No job is enqueued from an HTTP response handler after commit." So
 * `JobEnqueuer.enqueue` takes a `Tx` — an open `withAppRw` transaction — and nothing else will do.
 * THE GUARANTEE IS "IN THE TRANSACTION OF THE `Tx` PASSED IN". Nothing here can know which
 * transaction holds the caller's state change: a `Tx` from a nested `withAppRw` is just as open,
 * and a job sent on it commits with the INNER transaction even if the outer one rolls back
 * (T-149 QA probe P5). Pass the `Tx` your state change was written on.
 *
 *   - AT COMPILE TIME, `tx` is a required parameter of the BRANDED `Tx` type, which only
 *     `Database.withAppRw` mints. Omitting it, passing `undefined`, or passing a pool-bound
 *     `drizzle(pool)` handle does not compile (`type-tests/enqueue-refusals.ts`, `pnpm -w typecheck`).
 *   - WHEN `enqueue` IS CALLED, `joinTx` refuses (rejects `TransactionClosedError`, nothing sent) a
 *     `Tx` whose `work` has already returned or thrown, or one `withAppRw` never minted.
 *   - ONCE JOINED, the enqueue holds the transaction open: `withAppRw` does not COMMIT or ROLLBACK
 *     until the enqueue has settled, so its INSERT runs inside the transaction EVEN IF THE CALLER
 *     NEVER AWAITED IT — a forgotten `await` followed by a rollback leaves no job, and followed by a
 *     commit puts the job in the same transaction as the state change (OD-303; T-149 rework 1).
 *     A joined enqueue that rejects rolls the transaction back, and `withAppRw` rejects with it.
 *   - WHEN EACH STATEMENT IS ISSUED, `assertLiveTx` refuses it if the transaction is past its
 *     COMMIT/ROLLBACK point — a sender that issues a statement after its own send has settled
 *     gets `TransactionClosedError` instead of autocommit on a released connection.
 *
 * VALIDATION IS INSIDE THE TRANSACTION (SD 1507–1509: "a Zod failure INSIDE the enqueuing
 * transaction, so the state change rolls back with it"). The payload is parsed against the job's
 * own schema BEFORE anything is sent; a failure rejects `JobPayloadRefusedError`, and because the
 * enqueue is joined to the transaction, the transaction rolls back EVEN IF the caller catches the
 * error inside `work` (withAppRw then rejects with it). What is stored is the schema's OUTPUT, not
 * the input. Notify-bearing payloads extend `NotifyJobBase` with `.extend()` (T-147 § contract §1, §7).
 *
 * THE SEND RUNS ON THE CALLER'S CONNECTION. pg-boss 12.26.4's `send(name, data, { db })` executes
 * its insert on the supplied `db` (`manager.js` `createJob`), and `fromDrizzle(tx, sql)` (pg-boss's
 * own adapter) routes each statement through `tx.execute`, i.e. on the transaction's one pooled
 * connection. The queue's metadata is still read by the SENDER on its own pool (`getQueueCache`),
 * so the sender must be a STARTED `PgBoss` and the queue must already exist (committed).
 * pg-boss 12.26.4 has no SQL-callable `pgboss.send(...)` (G11, measured in T-149's evidence).
 *
 * THE REFUSAL ECHOES NOTHING FROM THE PAYLOAD (PROTOCOL §9.2): no value, and no KEY the payload
 * supplied. It carries the queue name (code-defined) and, per issue, Zod's code and a path in which
 * only the segments the SCHEMA names survive — an object key declared in a shape, an array or tuple
 * index. Every other segment (a `z.record` or `z.map` key, a catchall key) is rendered `*`
 * (`schemaPath`; T-149 QA-F3: a phone number used as a record key was echoed before).
 */
import { sql } from 'drizzle-orm';
import { fromDrizzle, type SendOptions } from 'pg-boss';
import type { z } from 'zod';
import { assertLiveTx, joinTx, type Tx } from '../runtime/database.ts';

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

/**
 * One refused field: Zod's issue code and its path, in which a segment the schema does not name (a
 * `z.record`/`z.map`/catchall key, i.e. a key the payload supplied) is `*`. Never a value or key
 * from the payload.
 */
export interface PayloadIssue {
  readonly path: string;
  readonly code: string;
}

/**
 * A payload that failed its job's schema. Raised inside the caller's transaction, before anything
 * is sent; it rolls that transaction back. Carries the queue and each issue's schema path and code
 * — never the payload, a value from it, or a key it supplied (`PayloadIssue`).
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
   * caller's open transaction, joined to it (`joinTx`): the transaction does not end until this
   * settles. Resolves the job id, or `null` when pg-boss suppressed the job (a singleton or
   * throttling option, or a policy, matched an existing one). Rejects `TransactionClosedError` (the
   * `Tx`'s `work` has already ended; nothing joined, nothing sent) or `JobPayloadRefusedError`
   * (nothing sent; the transaction rolls back and `withAppRw` rejects with it).
   */
  enqueue<S extends z.ZodType<object>>(
    tx: Tx,
    job: JobDefinition<S>,
    input: z.input<S>,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    return joinTx(tx, async () => {
      const parsed = job.payload.safeParse(input);
      if (!parsed.success) {
        throw new JobPayloadRefusedError(
          job.queue,
          parsed.error.issues.map((issue) => ({
            path: schemaPath(job.payload, issue.path),
            code: issue.code,
          })),
        );
      }
      const onTx = fromDrizzle(tx, sql);
      return await this.#sender.send(job.queue, parsed.data, {
        ...options,
        db: {
          async executeSql(text: string, values?: unknown[]) {
            assertLiveTx(tx);
            return await onTx.executeSql(text, values);
          },
        },
      });
    });
  }
}

/** A Zod schema's definition, read structurally (no runtime `zod` import; Zod 4.5.4's `_zod.def`). */
type Def = { readonly type?: unknown } & Readonly<Record<string, unknown>>;
function defOf(schema: unknown): Def | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const internals: unknown = (schema as { _zod?: unknown })._zod;
  if (typeof internals !== 'object' || internals === null) return undefined;
  const def: unknown = (internals as { def?: unknown }).def;
  return typeof def === 'object' && def !== null ? (def as Def) : undefined;
}

/** The structural schemas `schema` may be at one path position: wrappers and unions unwrapped. */
function structural(schema: unknown, out: Def[], seen: Set<unknown>): void {
  const def = defOf(schema);
  if (def === undefined || seen.has(schema)) return;
  seen.add(schema);
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'catch':
    case 'readonly':
    case 'success':
    case 'promise':
      structural(def['innerType'], out, seen);
      return;
    case 'pipe':
      structural(def['in'], out, seen);
      structural(def['out'], out, seen);
      return;
    case 'lazy': {
      const getter = def['getter'];
      if (typeof getter === 'function') structural((getter as () => unknown)(), out, seen);
      return;
    }
    case 'union':
      if (Array.isArray(def['options'])) for (const o of def['options']) structural(o, out, seen);
      return;
    case 'intersection':
      structural(def['left'], out, seen);
      structural(def['right'], out, seen);
      return;
    default:
      out.push(def);
  }
}

/**
 * Render an issue path keeping only the segments `schema` names: an object key declared in a shape,
 * an array or tuple index. Any other segment — a key the PAYLOAD supplied (`z.record`, `z.map`, a
 * catchall) — becomes `*`, so the refusal never echoes one (PROTOCOL §9.2; T-149 QA-F3).
 */
function schemaPath(schema: unknown, path: readonly PropertyKey[]): string {
  let here: unknown[] = [schema];
  const rendered: string[] = [];
  for (const segment of path) {
    const defs: Def[] = [];
    const seen = new Set<unknown>();
    for (const s of here) structural(s, defs, seen);
    const next: unknown[] = [];
    let named = false;
    for (const def of defs) {
      if (def.type === 'object') {
        const shape = def['shape'];
        if (
          typeof segment === 'string' &&
          typeof shape === 'object' &&
          shape !== null &&
          Object.hasOwn(shape, segment)
        ) {
          named = true;
          next.push((shape as Record<string, unknown>)[segment]);
        } else if (def['catchall'] !== undefined) {
          next.push(def['catchall']);
        }
      } else if (def.type === 'record' || def.type === 'map') {
        next.push(def['valueType']);
      } else if (def.type === 'array' && typeof segment === 'number') {
        named = true;
        next.push(def['element']);
      } else if (def.type === 'tuple' && typeof segment === 'number') {
        named = true;
        const items = def['items'];
        next.push(Array.isArray(items) && segment < items.length ? items[segment] : def['rest']);
      }
    }
    rendered.push(named ? String(segment) : '*');
    here = next;
  }
  return rendered.join('.');
}
