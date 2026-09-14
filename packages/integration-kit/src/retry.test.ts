/**
 * SD §INT Retry row: "Exponential with full jitter: 200 ms → 400 → 800 → 1600 → 3200, max 5,
 * only on 5xx/timeout/429; never on 4xx". Expected numbers are typed from the spec.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { toProblem } from '@kinvara/domain-types';
import {
  createCircuitBreaker,
  createUpstreamCaller,
  isRetryableStatus,
  RANDOM_REFUSED,
  RETRY,
  UpstreamCallFailedError,
  type UpstreamResponse,
} from './index.ts';
import { createManualClock, track } from './testing.ts';

/** A transport answering each attempt from a script, recording the clock time of each attempt. */
function scripted(
  clock: { now(): number },
  statuses: readonly number[],
): { readonly at: number[]; readonly send: () => Promise<UpstreamResponse> } {
  const at: number[] = [];
  return {
    at,
    send: async () => {
      at.push(clock.now());
      const status = statuses[Math.min(at.length - 1, statuses.length - 1)];
      return { status: status ?? 0 };
    },
  };
}

/** Enough time for six attempts and five maximal waits; nothing below is near it. */
const DRAIN_MS = 100_000;

test('no retry on a 4xx: 400, 401, 403, 404, 405, 409, 410, 412, 413 and 422 each come back after exactly one attempt', async () => {
  for (const status of [400, 401, 403, 404, 405, 409, 410, 412, 413, 422]) {
    const clock = createManualClock();
    const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
    const t = scripted(clock, [status, 200]);
    const call = track(caller.call(t.send));
    await clock.advance(DRAIN_MS);
    assert.equal(t.at.length, 1, `status ${String(status)} was attempted ${String(t.at.length)} times`);
    assert.equal(call.error, undefined, `status ${String(status)} is returned, not thrown`);
    assert.deepEqual(call.value, { status }, `status ${String(status)} is the response the caller gets`);
  }
});

test('a 5xx is retried: 500, 501, 502, 503, 504 and 599 each reach a second attempt and return its 200', async () => {
  for (const status of [500, 501, 502, 503, 504, 599]) {
    const clock = createManualClock();
    const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
    const t = scripted(clock, [status, 200]);
    const call = track(caller.call(t.send));
    await clock.advance(DRAIN_MS);
    assert.equal(t.at.length, 2, `status ${String(status)} was attempted ${String(t.at.length)} times`);
    assert.deepEqual(call.value, { status: 200 });
  }
});

test('a 429 is retried', async () => {
  const clock = createManualClock();
  const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
  const t = scripted(clock, [429, 200]);
  const call = track(caller.call(t.send));
  await clock.advance(DRAIN_MS);
  assert.equal(t.at.length, 2);
  assert.deepEqual(call.value, { status: 200 });
});

test('a transport that throws or rejects is retried', async () => {
  for (const fail of ['throw', 'reject'] as const) {
    const clock = createManualClock();
    const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
    let n = 0;
    const call = track(
      caller.call((): Promise<UpstreamResponse> => {
        n++;
        if (n === 1 && fail === 'throw') throw new Error('ECONNRESET');
        if (n === 1) return Promise.reject(new Error('ECONNRESET'));
        return Promise.resolve({ status: 204 });
      }),
    );
    await clock.advance(DRAIN_MS);
    assert.equal(n, 2, `${fail}: attempts`);
    assert.deepEqual(call.value, { status: 204 });
  }
});

test('retries stop at five: a persistent 503 is attempted six times and then thrown as upstream_unavailable', async () => {
  const clock = createManualClock();
  const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
  const t = scripted(clock, [503]);
  const call = track(caller.call(t.send));
  await clock.advance(DRAIN_MS);
  assert.equal(t.at.length, 6);
  assert.ok(call.error instanceof UpstreamCallFailedError);
  assert.equal(call.error.reason, 'server_error');
  assert.equal(call.error.attempts, 6);
});

test('a persistent 429 is thrown as upstream_unavailable with reason rate_limited, not as our own 429', async () => {
  const clock = createManualClock();
  const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
  const call = track(caller.call(scripted(clock, [429]).send));
  await clock.advance(DRAIN_MS);
  assert.ok(call.error instanceof UpstreamCallFailedError);
  assert.equal(call.error.reason, 'rate_limited');
  assert.equal(call.error.status, 503);
});

test('full jitter: with random() = 0.5 the five waits are 100, 200, 400, 800 and 1600 ms', async () => {
  const clock = createManualClock();
  const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0.5 });
  const t = scripted(clock, [500]);
  track(caller.call(t.send));
  await clock.advance(DRAIN_MS);
  assert.deepEqual(t.at, [0, 100, 300, 700, 1500, 3100]);
});

test('full jitter: with random() just under 1 each wait stays below its cap of 200, 400, 800, 1600 and 3200 ms', async () => {
  const clock = createManualClock();
  const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0.999_999 });
  const t = scripted(clock, [500]);
  track(caller.call(t.send));
  await clock.advance(DRAIN_MS);
  const waits = t.at.slice(1).map((at, i) => at - (t.at[i] ?? 0));
  assert.deepEqual(waits, [199, 399, 799, 1599, 3199]);
});

test('RETRY pins SD INT: caps of 200, 400, 800, 1600 and 3200 ms, at most 5 retries', () => {
  assert.deepEqual([...RETRY.capsMs], [200, 400, 800, 1600, 3200]);
  assert.equal(RETRY.maxRetries, 5);
});

test('a random() outside [0, 1) is refused rather than producing a negative or oversized wait', async () => {
  for (const r of [-0.1, 1, 1.5, Number.NaN]) {
    const clock = createManualClock();
    const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => r });
    const call = track(caller.call(scripted(clock, [500]).send));
    await clock.advance(DRAIN_MS);
    assert.ok(call.error instanceof TypeError, `random() = ${String(r)}`);
    assert.equal(call.error.message, RANDOM_REFUSED);
  }
});

test('a status that is not an integer from 100 to 599 is a failure and retried, never returned', async () => {
  for (const status of [0, 99, 600, 200.5, Number.NaN]) {
    const clock = createManualClock();
    const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
    const t = scripted(clock, [status]);
    const call = track(caller.call(t.send));
    await clock.advance(DRAIN_MS);
    assert.equal(t.at.length, 6, `status ${String(status)}`);
    assert.ok(call.error instanceof UpstreamCallFailedError);
    assert.equal(call.error.reason, 'invalid_status');
  }
});

test('isRetryableStatus is true for 429 and 500 to 599 and false for every other status from 100 to 499', () => {
  for (let s = 100; s <= 599; s++) {
    assert.equal(isRetryableStatus(s), s === 429 || s >= 500, `status ${String(s)}`);
  }
});

test('QR-A4: an upstream 502 or 504 exhausted through the kit reaches a client as a 503 upstream_unavailable with retryable true, and nothing else', async () => {
  for (const status of [502, 504]) {
    const clock = createManualClock();
    const caller = createUpstreamCaller({ breaker: createCircuitBreaker({ clock }), clock, random: () => 0 });
    const call = track(caller.call(async () => ({ status, body: 'QA-T142-CANARY-5020' })));
    await clock.advance(DRAIN_MS);
    assert.ok(call.error instanceof UpstreamCallFailedError, `status ${String(status)}`);
    const problem = toProblem(call.error, 'https://errors.kinvara.cy/');
    assert.equal(problem.status, 503);
    assert.deepEqual(problem.body, {
      type: 'https://errors.kinvara.cy/upstream_unavailable',
      title: 'Upstream unavailable',
      status: 503,
      code: 'upstream_unavailable',
      retryable: true,
    });
    const logged = `${call.error.message} ${String(call.error.stack)} ${JSON.stringify(call.error)}`;
    assert.ok(!logged.includes('QA-T142-CANARY-5020'), 'nothing from the upstream body is on the error');
  }
});
