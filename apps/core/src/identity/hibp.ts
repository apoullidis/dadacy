/**
 * The HIBP Pwned Passwords k-anonymity range check. Sources: SA §SEC-5 (line 2203), SD §INT-F
 * (line 3763), decisions.md OE-22 G2, and `T-139` § Rework 1 LIVE §2/§6 for what carries a verdict.
 *
 * WHAT LEAVES THIS PROCESS: one `GET <HIBP_API_BASE>/range/<first 5 hex of the SHA-1>`. The request
 * carries neither the password nor the full hash.
 *
 * THE VERDICT. A RESOLVED `200` is the only answer that carries one:
 *   - the body is split into lines; a line whose text before `:` equals characters 6–40 of the
 *     upper-case SHA-1 means `breached`;
 *   - no such line, an empty body included, means `clean`.
 *
 * EVERYTHING ELSE IS `unavailable`, and the caller fails OPEN:
 *   - a resolved non-200. The kit resolves every 4xx except 429 after one attempt (T-142 LIVE §2,
 *     orchestrator correction). T-139 lists `400`/`405`/`408`/`431`/`501`. The body is not read;
 *   - `UpstreamCallFailedError`, caught here: timeout, 5xx, transport error, invalid status, an
 *     open breaker, or a `429` after the kit's retries.
 *
 * Any other throw propagates, and the filter answers 500. That covers the kit's programmer errors
 * (`RANDOM_REFUSED`, a throwing clock) and a missing `HIBP_API_BASE`: a misconfiguration is not
 * "HIBP unavailable".
 *
 * THE BODY IS READ INSIDE THE ATTEMPT, under the kit's per-attempt signal. A 200 whose body stalls
 * is aborted at the attempt timeout and retried as a transport error. It cannot hold the request
 * open after `call()` has resolved.
 *
 * THE BREAKER is `HIBP_BREAKER`: one per provider, module-scoped, shared by every call (T-142 LIVE
 * §8). The caller keeps the kit's request-path default of 2 s per attempt, so a hanging upstream
 * costs the kit's full 18195 ms before this returns `unavailable`. That is measured in
 * `test/identity.inprocess.test.ts`.
 */
import { createHash } from 'node:crypto';
import {
  createCircuitBreaker,
  UpstreamCallFailedError,
  type CircuitBreaker,
  type UpstreamCaller,
  type UpstreamFailureReason,
} from '@kinvara/integration-kit';

/** Literals and an HTTP status integer only. Nothing from the password or the upstream's body. */
export type HibpUnavailableReason = `kit_${UpstreamFailureReason}` | `status_${number}`;

export type HibpVerdict =
  | { readonly kind: 'breached' }
  | { readonly kind: 'clean' }
  | { readonly kind: 'unavailable'; readonly reason: HibpUnavailableReason };

/** ONE breaker for HIBP in this process. */
export const HIBP_BREAKER: CircuitBreaker = createCircuitBreaker();

export const HIBP_BASE_REFUSED =
  'identity: HIBP_API_BASE is not an http(s) origin, so no password can be checked';

export interface HibpCheckerOptions {
  /** `HIBP_API_BASE`: an origin with no trailing slash (T-139 § contract §1). */
  readonly base: string | undefined;
  readonly caller: UpstreamCaller;
  /** Injected by tests. Defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

interface RangeAnswer {
  readonly status: number;
  readonly body: string;
}

const ORIGIN = /^https?:\/\/[^/\s]+$/;

export class HibpChecker {
  readonly #base: string | undefined;
  readonly #caller: UpstreamCaller;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HibpCheckerOptions) {
    this.#base = options.base;
    this.#caller = options.caller;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async check(password: string): Promise<HibpVerdict> {
    const base = this.#base;
    if (base === undefined || !ORIGIN.test(base)) throw new TypeError(HIBP_BASE_REFUSED);

    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const url = `${base}/range/${sha1.slice(0, 5)}`;
    const suffix = sha1.slice(5);

    let answer: RangeAnswer;
    try {
      answer = await this.#caller.call(async (signal): Promise<RangeAnswer> => {
        const response = await this.#fetch(url, { method: 'GET', signal });
        if (response.status !== 200) {
          // Never read: a non-200 body is not a verdict (T-139 §2).
          await response.body?.cancel().catch(() => undefined);
          return { status: response.status, body: '' };
        }
        return { status: 200, body: await response.text() };
      });
    } catch (thrown) {
      if (thrown instanceof UpstreamCallFailedError) {
        return { kind: 'unavailable', reason: `kit_${thrown.reason}` };
      }
      throw thrown;
    }

    if (answer.status !== 200) {
      const status: number = answer.status;
      return { kind: 'unavailable', reason: `status_${status}` };
    }
    for (const line of answer.body.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon !== -1 && line.slice(0, colon).toUpperCase() === suffix)
        return { kind: 'breached' };
    }
    return { kind: 'clean' };
  }
}
