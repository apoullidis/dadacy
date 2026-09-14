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
 *   30 s. A probe still unsettled 30 s after it was issued is superseded: one new probe is
 *   admitted, and the superseded probe's settle, whenever it comes, is ignored. That is the
 *   orchestrator's reading of "half-open probe every 30 s" (T-142 rework 1, ruling 2c; OD-113).
 *
 * A "call" here is one ATTEMPT against the upstream: the caller settles a permit per attempt, so
 * a retried request contributes one outcome per attempt. Every non-probe permit is stamped with
 * the closed period that issued it, and a permit issued before the breaker last left CLOSED is
 * never counted, in any later state, including after a probe has re-closed it (OD-112).
 *
 * `onStateChange` runs after each transition is complete, and an exception it throws is
 * discarded, so a throwing hook cannot change the state machine or strand a probe (OD-113).
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
  /**
   * Called after each transition: `open`, `half_open` when a probe is issued with none in flight
   * (not when a superseding probe is issued), and `closed`. What it throws is discarded.
   */
  readonly onStateChange?: (state: BreakerState) => void;
}

export const PERMIT_REFUSED =
  'CircuitBreaker: this permit was already settled or was not issued by this breaker';

export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const clock = options.clock ?? systemClock;
  const hook = options.onStateChange;
  const issued = new WeakSet<Permit>();
  /** The closed period each non-probe permit was issued in. */
  const periodOf = new WeakMap<Permit, number>();

  let state: 'closed' | 'open' = 'closed';
  /** Advanced every time the breaker leaves CLOSED. */
  let closedPeriod = 0;
  let openedAt = 0;
  let probe: Permit | undefined;
  let probeIssuedAt = 0;
  let window: { readonly at: number; readonly failed: boolean }[] = [];

  const notify = (next: BreakerState): void => {
    try {
      hook?.(next);
    } catch {
      // Discarded (OD-113): every transition is complete before the hook runs.
    }
  };

  const current = (now: number): BreakerState =>
    state === 'open' && now - openedAt >= BREAKER.probeAfterMs ? 'half_open' : state;

  const open = (now: number): void => {
    state = 'open';
    openedAt = now;
    closedPeriod++;
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
        periodOf.set(permit, closedPeriod);
        return permit;
      }
      if (
        s === 'half_open' &&
        (probe === undefined || now - probeIssuedAt >= BREAKER.probeAfterMs)
      ) {
        const superseding = probe !== undefined;
        probe = Object.freeze({ probe: true });
        probeIssuedAt = now;
        issued.add(probe);
        if (!superseding) notify('half_open');
        return probe;
      }
      return undefined;
    },

    settle(permit: Permit, failed: boolean): void {
      if (!issued.delete(permit)) throw new TypeError(PERMIT_REFUSED);
      const now = clock.now();

      if (permit.probe) {
        // A probe superseded by a re-admitted one (see acquire): its late settle is ignored.
        if (permit !== probe) return;
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
      // Issued before the breaker last left CLOSED: never counted, whatever the state now (OD-112).
      if (periodOf.get(permit) !== closedPeriod) return;

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
