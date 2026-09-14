/**
 * SD §INT Timeout row: "2 s on the request path; 5 s in `worker`; 10 s for provider-hosted
 * redirect creation". Every expected number below is typed from the spec, never read from
 * `TIMEOUT_MS`, so a changed constant turns these red instead of moving with them.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createCircuitBreaker,
  createUpstreamCaller,
  TIMEOUT_MS,
  UpstreamCallFailedError,
  type UpstreamResponse,
} from './index.ts';
import { createManualClock, track } from './testing.ts';

/** A transport that never answers, recording each attempt's signal. */
function hangingTransport(): {
  readonly signals: AbortSignal[];
  readonly send: (signal: AbortSignal) => Promise<UpstreamResponse>;
} {
  const signals: AbortSignal[] = [];
  return {
    signals,
    send: (signal) => {
      signals.push(signal);
      return new Promise<UpstreamResponse>(() => undefined);
    },
  };
}

test('the request-path timeout is 2 s: an attempt still pending at 1999 ms is not aborted, and at 2000 ms it is', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
  const t = hangingTransport();
  const call = track(caller.call(t.send));

  await clock.advance(1999);
  assert.equal(t.signals.length, 1, 'one attempt at 1999 ms');
  assert.equal(t.signals[0]?.aborted, false, 'not timed out at 1999 ms');

  await clock.advance(1);
  assert.equal(t.signals[0]?.aborted, true, 'timed out at 2000 ms');
  assert.equal(
    t.signals.length,
    2,
    'the timeout is retryable: with a zero wait the second attempt starts at 2000 ms',
  );
  assert.equal(call.settled, false);
});

test('a call whose every attempt times out settles as upstream_unavailable after six attempts, at 12000 ms and not before', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
  const t = hangingTransport();
  const call = track(caller.call(t.send));

  await clock.advance(11_999);
  assert.equal(call.settled, false, 'still in its sixth attempt at 11999 ms');
  await clock.advance(1);
  assert.equal(call.settled, true, 'settled at 12000 ms: six attempts of 2000 ms with zero waits');

  assert.ok(call.error instanceof UpstreamCallFailedError, 'rejected with the kit error');
  assert.equal(call.error.reason, 'timeout');
  assert.equal(call.error.attempts, 6);
  assert.equal(call.error.code, 'upstream_unavailable');
  assert.equal(t.signals.length, 6);
  assert.ok(
    t.signals.every((s) => s.aborted),
    'every attempt was aborted',
  );
  assert.equal(clock.pending(), 0, 'no timer left armed');
});

test('the request-path worst case: six timed-out attempts and five near-maximal waits settle at 18195 ms and not before', async () => {
  // 6 x 2000 ms of attempts + (199 + 399 + 799 + 1599 + 3199) ms of waits = 18195 ms. This is the
  // latency an adapter on the request path inherits when its upstream never answers.
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const caller = createUpstreamCaller({ breaker, clock, random: () => 0.999_999 });
  const t = hangingTransport();
  const call = track(caller.call(t.send));

  await clock.advance(18_194);
  assert.equal(call.settled, false, 'still in its sixth attempt at 18194 ms');
  await clock.advance(1);
  assert.equal(call.settled, true, 'settled at 18195 ms');
  assert.ok(call.error instanceof UpstreamCallFailedError);
  assert.equal(call.error.attempts, 6);
});

test('a response before the timeout is returned, and its timer is cleared', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const caller = createUpstreamCaller({ breaker, clock });
  let signal: AbortSignal | undefined;
  const call = track(
    caller.call(async (s) => {
      signal = s;
      return { status: 200, body: 'ok' };
    }),
  );
  await clock.advance(0);
  assert.equal(call.settled, true);
  assert.deepEqual(call.value, { status: 200, body: 'ok' });
  assert.equal(signal?.aborted, false);
  assert.equal(clock.pending(), 0, 'the timeout timer was cleared, not left to fire');
});

test('a worker caller passing the 5 s timeout is not aborted at 4999 ms and is at 5000 ms', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const caller = createUpstreamCaller({
    breaker,
    clock,
    random: () => 0,
    timeoutMs: TIMEOUT_MS.worker,
  });
  const t = hangingTransport();
  track(caller.call(t.send));
  await clock.advance(4999);
  assert.equal(t.signals[0]?.aborted, false);
  await clock.advance(1);
  assert.equal(t.signals[0]?.aborted, true);
});

test('TIMEOUT_MS pins SD INT: 2000 ms request path, 5000 ms worker, 10000 ms provider-hosted redirect creation', () => {
  assert.deepEqual({ ...TIMEOUT_MS }, { requestPath: 2000, worker: 5000, providerRedirect: 10000 });
  assert.ok(Object.isFrozen(TIMEOUT_MS));
});

test('a timeout that is not a positive integer is refused when the caller is built', () => {
  const breaker = createCircuitBreaker();
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createUpstreamCaller({ breaker, timeoutMs }), {
      name: 'TypeError',
      message: 'integration-kit: timeoutMs must be a positive integer',
    });
  }
});

test('a timeout above 2147483647 ms is refused when the caller is built, and 2147483647 is accepted', () => {
  // QR-A3: Node clamps a larger timer delay to 1 ms, so such a timeout would fire at once.
  const breaker = createCircuitBreaker();
  assert.doesNotThrow(() => createUpstreamCaller({ breaker, timeoutMs: 2_147_483_647 }));
  for (const timeoutMs of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => createUpstreamCaller({ breaker, timeoutMs }),
      { name: 'TypeError', message: 'integration-kit: timeoutMs must be a positive integer' },
      `timeoutMs ${String(timeoutMs)} is refused`,
    );
  }
});
