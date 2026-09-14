import { BREAKER } from './policy.ts';
import { systemClock, type Clock } from './clock.ts';

/**
 * SD §INT circuit breaker: "Opens at 50% failure over 20 calls in 60 s; half-open probe every 30 s".
 *
 * - CLOSED: every call is admitted. Each settled outcome is kept for 60 s. When at least 20
 *   outcomes are inside the window and at least half of them failed, the breaker OPENS and the
 *   window is cleared.
 * - OPEN: every call is refused (`acquire()` returns `undefined`) until 30 s have passed since it
 *   opened.
 * - HALF_OPEN: exactly one probe is admitted; every other call is still refused. The probe
 *   succeeding CLOSES the breaker with an empty window; the probe failing re-OPENS it for another
 *   30 s.
 *
 * A "call" here is one ATTEMPT against the upstream: the caller settles a permit per attempt, so
 * a retried request contributes one outcome per attempt. An outcome settled while the breaker is
 * not CLOSED, from a permit issued before it opened, is not counted.
 *
 * One breaker per provider. The `provider_health` gauge SD names is not built here (it needs the
 * `otel` profile); `state` and `onStateChange` are what it will read.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface Permit {
  readonly probe: boolean;
}

export interface CircuitBreaker {
  /** The state as of `clock.now()`; an OPEN breaker whose 30 s have passed reads `half_open`. */
  readonly state: BreakerState;
  /** A permit for one attempt, or `undefined` if the breaker refuses it. */
  acquire(): Permit | undefined;
  /** Record the attempt's outcome. Each permit settles exactly once. */
  settle(permit: Permit, failed: boolean): void;
}

export interface CircuitBreakerOptions {
  readonly clock?: Clock;
  readonly onStateChange?: (state: BreakerState) => void;
}

export const PERMIT_REFUSED =
  'CircuitBreaker: this permit was already settled or was not issued by this breaker';

export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const clock = options.clock ?? systemClock;
  const notify = options.onStateChange ?? ((): void => undefined);
  const issued = new WeakSet<Permit>();

  let state: 'closed' | 'open' = 'closed';
  let openedAt = 0;
  let probe: Permit | undefined;
  let window: { readonly at: number; readonly failed: boolean }[] = [];

  const current = (now: number): BreakerState =>
    state === 'open' && now - openedAt >= BREAKER.probeAfterMs ? 'half_open' : state;

  const open = (now: number): void => {
    state = 'open';
    openedAt = now;
    window = [];
    notify('open');
  };

  return {
    get state(): BreakerState {
      return current(clock.now());
    },

    acquire(): Permit | undefined {
      const now = clock.now();
      const s = current(now);
      if (s === 'closed') {
        const permit: Permit = Object.freeze({ probe: false });
        issued.add(permit);
        return permit;
      }
      if (s === 'half_open' && probe === undefined) {
        probe = Object.freeze({ probe: true });
        issued.add(probe);
        notify('half_open');
        return probe;
      }
      return undefined;
    },

    settle(permit: Permit, failed: boolean): void {
      if (!issued.delete(permit)) throw new TypeError(PERMIT_REFUSED);
      const now = clock.now();

      if (permit === probe) {
        probe = undefined;
        if (failed) {
          open(now);
        } else {
          state = 'closed';
          window = [];
          notify('closed');
        }
        return;
      }
      // A permit issued before the breaker opened, settling afterwards: not counted.
      if (state !== 'closed') return;

      window.push({ at: now, failed });
      const from = now - BREAKER.windowMs;
      window = window.filter((o) => o.at > from);
      const failures = window.filter((o) => o.failed).length;
      if (
        window.length >= BREAKER.minimumCalls &&
        failures / window.length >= BREAKER.failureRatio
      ) {
        open(now);
      }
    },
  };
}
