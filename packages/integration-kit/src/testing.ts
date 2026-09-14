/**
 * `@kinvara/integration-kit/testing` — a manual clock and a settlement tracker, for this package's
 * tests and for an adapter's unit tests. Not for production code.
 */
import type { Clock } from './clock.ts';

export interface ManualClock extends Clock {
  /**
   * Move time forward by `ms`, firing each due timer in order at its own due time, and letting
   * every promise chain it starts run before the next timer fires.
   */
  advance(ms: number): Promise<void>;
  /** Timers armed and not yet fired or cleared. */
  pending(): number;
}

interface Timer {
  readonly id: number;
  readonly due: number;
  readonly callback: () => void;
}

/** One macrotask turn: every queued microtask, and any it queues, runs first. */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let seq = 0;
  let timers: Timer[] = [];

  return {
    now: () => now,
    setTimeout(callback: () => void, ms: number): unknown {
      const timer = { id: ++seq, due: now + Math.max(0, ms), callback };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(handle: unknown): void {
      timers = timers.filter((t) => t.id !== handle);
    },
    pending: () => timers.length,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      await drain();
      for (;;) {
        const next = timers
          .filter((t) => t.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (next === undefined) break;
        timers = timers.filter((t) => t !== next);
        now = next.due;
        next.callback();
        await drain();
      }
      now = target;
      await drain();
    },
  };
}

export interface Settlement<T> {
  readonly settled: boolean;
  readonly value: T | undefined;
  readonly error: unknown;
}

/**
 * Attach handlers at once, so a rejection is never unhandled while a test is still advancing the
 * clock, and read the outcome synchronously afterwards.
 */
export function track<T>(promise: Promise<T>): Settlement<T> {
  const s: { settled: boolean; value: T | undefined; error: unknown } = {
    settled: false,
    value: undefined,
    error: undefined,
  };
  promise.then(
    (value) => {
      s.settled = true;
      s.value = value;
    },
    (error: unknown) => {
      s.settled = true;
      s.error = error;
    },
  );
  return s;
}
