/**
 * `worker.selftest` — the worker's one built-in queue: a diagnostic, not a business queue.
 *
 * WHY IT EXISTS. T-148's acceptance needs a job the containerised worker is seen completing, a
 * job held in flight across SIGTERM, and a handler that throws — and every SD §BE-11 queue's
 * handler belongs to that queue's own ticket ("Out" in T-148's brief). So the worker carries one
 * queue whose handler does nothing but report itself. It writes no application table, and reads
 * one only for op `contact` (`account`, by primary key, through identity's provider — T-246); what
 * it can do is bounded by the payload checks below.
 *
 * WHAT THE HANDLER DOES, per payload `op`:
 *   echo   completes, returning who handled it;
 *   hold   waits `holdMs` (0..15000) and then completes — the in-flight job of the drain case;
 *   throw  throws — the failing handler of refusal (iii);
 *   contact  resolves `accountId`'s contact through `@kinvara/core-modules/identity`'s
 *          `AccountContacts` (T-246) and completes with the SHA-256 of the email and of the phone
 *          (hex, or null) — never the values, so the job row carries no contact detail. An id no
 *          account holds fails the job with `AccountNotFoundError` (the named refusal).
 * Every attempt first sends `pg_notify('kinvara_worker_selftest', …)` with phase `start`, and a
 * successful one sends phase `done`. The notification is the handler's side effect outside
 * pg-boss's own tables, so a test can tell "the handler ran, here, this many times" apart from
 * "pg-boss marked the row" (T-148 acceptance (a), refusal (iii)). Only `contact` reads an
 * application table (`account`, through identity's provider, as `app_rw`); no op writes one.
 *
 * WHERE IT RUNS (T-242): this file is the queue's pure half — its name, options, payload reader
 * and failure text, imported by the tests and the drain probe without loading NestJS. The handler
 * itself is a Nest provider, src/selftest.handler.ts; its notifications are sent through
 * `SelftestReporter` (src/selftest-reporter.module.ts) and carry `via: 'SelftestReporter'`.
 *
 * RETRY POLICY, CONFIGURED HERE: `retryLimit: 1`, so a throwing job is attempted exactly TWICE and
 * then `failed`. pg-boss's own default is 2 (three attempts; `types.d.ts` QueueOptions), so a
 * deleted or ignored option is visible as a third attempt. NEVER `partition: true` (T-146 § contract
 * §3: it needs CREATE on schema pgboss, which no role holds).
 */
export const SELFTEST_QUEUE = 'worker.selftest';
export const SELFTEST_CHANNEL = 'kinvara_worker_selftest';
export const SELFTEST_MAX_HOLD_MS = 15_000;

export const SELFTEST_QUEUE_OPTIONS = {
  retryLimit: 1,
  retryDelay: 1,
  retryBackoff: false,
  expireInSeconds: 60,
} as const;

export type SelftestOp = 'echo' | 'hold' | 'throw' | 'contact';

export interface SelftestData {
  readonly op: SelftestOp;
  readonly tag: string;
  readonly holdMs?: number;
  /** `contact` only: a canonical ULID (Crockford base32, 26 characters). */
  readonly accountId?: string;
}

export interface SelftestOutput {
  readonly op: SelftestOp;
  readonly tag: string;
  readonly attempt: number;
  readonly host: string;
  readonly pid: number;
  /** T-245: read through `@kinvara/core-modules`' `Database.withAppRw` (src/selftest.handler.ts). */
  readonly db: { readonly currentUser: string; readonly roleAtConnect: string };
  /** T-246, `contact` only: SHA-256 (hex) of the resolved email and phone, or null where NULL. */
  readonly contact?: { readonly emailSha256: string | null; readonly phoneSha256: string | null };
}

export const SELFTEST_FAILURE = 'worker.selftest: deliberate failure (op=throw)';

const TAG = /^[A-Za-z0-9._:-]{1,100}$/;
/** A canonical ULID's shape; `@kinvara/domain-types`' `accountId()` is the check that brands it. */
const ULID_SHAPE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** The payload, or a reason it is refused. The reason never echoes the payload. */
export function parseSelftest(data: unknown): SelftestData | string {
  if (typeof data !== 'object' || data === null) return 'payload is not an object';
  const op = 'op' in data ? data.op : undefined;
  const tag = 'tag' in data ? data.tag : undefined;
  const holdMs = 'holdMs' in data ? data.holdMs : undefined;
  const accountId = 'accountId' in data ? data.accountId : undefined;
  if (op !== 'echo' && op !== 'hold' && op !== 'throw' && op !== 'contact') {
    return 'op is not echo, hold, throw or contact';
  }
  if (typeof tag !== 'string' || !TAG.test(tag)) return 'tag is not 1-100 of [A-Za-z0-9._:-]';
  if (op === 'contact') {
    if (holdMs !== undefined) return 'holdMs is only for op=hold';
    if (typeof accountId !== 'string' || !ULID_SHAPE.test(accountId)) {
      return 'accountId is not a canonical ULID';
    }
    return { op, tag, accountId };
  }
  if (accountId !== undefined) return 'accountId is only for op=contact';
  if (op !== 'hold') return holdMs === undefined ? { op, tag } : 'holdMs is only for op=hold';
  if (
    typeof holdMs !== 'number' ||
    !Number.isInteger(holdMs) ||
    holdMs < 0 ||
    holdMs > SELFTEST_MAX_HOLD_MS
  ) {
    return `holdMs is not an integer 0..${String(SELFTEST_MAX_HOLD_MS)}`;
  }
  return { op, tag, holdMs };
}
