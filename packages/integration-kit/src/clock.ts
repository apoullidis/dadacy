/**
 * The time source every behaviour in this package reads. Injected so the tests can drive
 * timeouts, backoff and the breaker window without waiting on the wall clock.
 */
export interface Clock {
  /** Milliseconds; only differences are read. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
});

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}
