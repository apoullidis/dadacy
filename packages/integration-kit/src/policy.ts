/**
 * The numbers of SD §INT "Universal adapter behaviours" (software-design.md lines 3600–3607),
 * transcribed once. Nothing else in this package spells them.
 *
 * The behavioural tests do NOT read these constants for their fixtures: they use the spec's
 * literals (1999/2000 ms, 9/10 of 20 calls, …), so a changed constant turns them red rather
 * than moving the fixture with it (PROTOCOL §5.1, "a check must not be derived from the same
 * reading as the thing it checks").
 */

/** Timeout row: "2 s on the request path; 5 s in `worker`; 10 s for provider-hosted redirect creation". */
export const TIMEOUT_MS = Object.freeze({
  requestPath: 2_000,
  worker: 5_000,
  providerRedirect: 10_000,
} as const);

/**
 * Retry row: "Exponential with full jitter: 200 ms → 400 → 800 → 1600 → 3200, max 5, only on
 * 5xx/timeout/429; never on 4xx". Read as five RETRIES (six attempts): the row lists five waits,
 * and a fifth wait exists only before a sixth attempt. Each wait is `floor(random() * cap)`.
 */
export const RETRY = Object.freeze({
  capsMs: Object.freeze([200, 400, 800, 1_600, 3_200] as const),
  maxRetries: 5,
} as const);

/** Circuit breaker row: "Opens at 50% failure over 20 calls in 60 s; half-open probe every 30 s". */
export const BREAKER = Object.freeze({
  failureRatio: 0.5,
  minimumCalls: 20,
  windowMs: 60_000,
  probeAfterMs: 30_000,
} as const);
