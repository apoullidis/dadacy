import { UpstreamUnavailableError } from '@kinvara/domain-types';
import type { CircuitBreaker } from './breaker.ts';
import { sleep, systemClock, type Clock } from './clock.ts';
import { RETRY, TIMEOUT_MS } from './policy.ts';

/** Anything an adapter's transport resolves with; the kit reads `status` and nothing else. */
export interface UpstreamResponse {
  readonly status: number;
}

/**
 * One attempt. The kit passes a fresh `AbortSignal` per attempt and aborts it when the attempt
 * times out; the transport should honour it to release the socket. The kit stops waiting either
 * way. A throw or rejection is a transport error.
 */
export type Send<R extends UpstreamResponse> = (signal: AbortSignal) => Promise<R>;

export type UpstreamFailureReason =
  | 'timeout'
  | 'server_error'
  | 'rate_limited'
  | 'transport_error'
  | 'invalid_status'
  | 'circuit_open';

/**
 * Every upstream failure the kit reports. It IS an `UpstreamUnavailableError` (T-023: 503,
 * `upstream_unavailable`, `retryable: true`), so `apps/core`'s filter answers it as that — which
 * is how an upstream 502 or 504 reaches a client as a retryable 503 rather than a 500 (QR-A4).
 *
 * `reason` and `attempts` are for server-side logs and metrics. Both are literals or counts the
 * kit computed; neither carries anything from the upstream response. `toProblem` does not
 * serialise them (it emits the standard members plus `problemExtensions()`, which this class
 * does not override).
 */
export class UpstreamCallFailedError extends UpstreamUnavailableError {
  readonly reason: UpstreamFailureReason;
  /** Attempts that reached the transport. 0 when the breaker refused the first. */
  readonly attempts: number;

  constructor(reason: UpstreamFailureReason, attempts: number) {
    super();
    this.reason = reason;
    this.attempts = attempts;
  }
}

export interface UpstreamCallerOptions {
  /** One breaker per provider; share it across every caller for that provider. */
  readonly breaker: CircuitBreaker;
  /** Must be the breaker's clock too. Defaults to the system clock. */
  readonly clock?: Clock;
  /** In [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number;
  /**
   * Per attempt, an integer from 1 to 2147483647. Defaults to SD §INT's request-path 2 s; pass
   * `TIMEOUT_MS.worker` in `worker`.
   */
  readonly timeoutMs?: number;
}

export interface UpstreamCaller {
  /**
   * Resolves with the first response that is not a failure: any status from 100 to 599 other than
   * 429 and 5xx, 4xx included and never retried. A response that is not an object whose `status`
   * reads as an integer from 100 to 599 is a failure (`invalid_status`) and is retried.
   *
   * Rejects with `UpstreamCallFailedError` when the breaker refuses an attempt, or when the sixth
   * attempt fails. Two programmer errors reject otherwise: `TypeError(RANDOM_REFUSED)` from a bad
   * `random`, and whatever an injected `clock` throws. On every exit, each attempt's permit has
   * been settled exactly once.
   */
  call<R extends UpstreamResponse>(send: Send<R>): Promise<R>;
}

export const RANDOM_REFUSED = 'integration-kit: random() must return a finite number in [0, 1)';

/** Node's timer ceiling: a longer `setTimeout` delay is clamped to 1 ms and fires at once (QR-A3). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** SD §INT Retry row: "only on 5xx/timeout/429; never on 4xx". */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

type Outcome<R> =
  | { readonly kind: 'response'; readonly response: R }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'transport_error' };

/**
 * The response's `status` if the response is a non-null object whose `status` reads as a number;
 * otherwise `undefined`, which is `invalid_status`. It never throws: a `null`, `undefined` or
 * primitive response, and a `status` getter that throws, are upstream failures (OD-113).
 */
function statusOf(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  let status: unknown;
  try {
    status = (response as { readonly status?: unknown }).status;
  } catch {
    return undefined;
  }
  return typeof status === 'number' ? status : undefined;
}

function failureOf<R extends UpstreamResponse>(
  outcome: Outcome<R>,
): UpstreamFailureReason | undefined {
  if (outcome.kind !== 'response') return outcome.kind;
  const status = statusOf(outcome.response);
  if (status === undefined || !Number.isInteger(status) || status < 100 || status > 599) {
    return 'invalid_status';
  }
  if (!isRetryableStatus(status)) return undefined;
  return status === 429 ? 'rate_limited' : 'server_error';
}

async function attempt<R extends UpstreamResponse>(
  send: Send<R>,
  clock: Clock,
  timeoutMs: number,
): Promise<Outcome<R>> {
  const controller = new AbortController();
  let timer: unknown;
  const timedOut = new Promise<Outcome<R>>((resolve) => {
    timer = clock.setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });
  const sent = Promise.resolve()
    .then(() => send(controller.signal))
    .then(
      (response): Outcome<R> => ({ kind: 'response', response }),
      (): Outcome<R> => ({ kind: 'transport_error' }),
    );
  try {
    return await Promise.race([sent, timedOut]);
  } finally {
    clock.clearTimeout(timer);
  }
}

function backoffMs(retry: number, random: () => number): number {
  const cap = RETRY.capsMs[retry] ?? RETRY.capsMs[RETRY.capsMs.length - 1] ?? 0;
  const r = random();
  if (!Number.isFinite(r) || r < 0 || r >= 1) throw new TypeError(RANDOM_REFUSED);
  return Math.floor(r * cap);
}

export function createUpstreamCaller(options: UpstreamCallerOptions): UpstreamCaller {
  const { breaker } = options;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS.requestPath;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('integration-kit: timeoutMs must be a positive integer');
  }

  return {
    async call<R extends UpstreamResponse>(send: Send<R>): Promise<R> {
      for (let made = 0; ; made++) {
        const permit = breaker.acquire();
        if (permit === undefined) throw new UpstreamCallFailedError('circuit_open', made);

        // Every exit from here settles the permit exactly once. An exception between acquire()
        // and settle() would otherwise strand it, and a stranded probe refuses the provider (OD-113).
        let failed = true;
        let outcome: Outcome<R>;
        let reason: UpstreamFailureReason | undefined;
        try {
          outcome = await attempt(send, clock, timeoutMs);
          reason = failureOf(outcome);
          failed = reason !== undefined;
        } finally {
          breaker.settle(permit, failed);
        }

        if (reason === undefined && outcome.kind === 'response') return outcome.response;
        if (made >= RETRY.maxRetries) {
          throw new UpstreamCallFailedError(reason ?? 'invalid_status', made + 1);
        }
        await sleep(clock, backoffMs(made, random));
      }
    },
  };
}
