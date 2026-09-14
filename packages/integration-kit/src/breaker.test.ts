/**
 * SD §INT Circuit breaker row: "Opens at 50% failure over 20 calls in 60 s; half-open probe every
 * 30 s". Expected numbers (20, 10, 9, 19, 60000, 30000) are typed from the spec, never read from
 * `BREAKER`.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  BREAKER,
  createCircuitBreaker,
  createUpstreamCaller,
  PERMIT_REFUSED,
  UpstreamCallFailedError,
  type BreakerState,
  type CircuitBreaker,
} from './index.ts';
import { createManualClock, track } from './testing.ts';

/** Settle `n` attempts, `failures` of them failed (failures first), all at the current time. */
function record(breaker: CircuitBreaker, n: number, failures: number): void {
  for (let i = 0; i < n; i++) {
    const permit = breaker.acquire();
    assert.ok(permit !== undefined, `attempt ${String(i + 1)} of ${String(n)} was refused`);
    breaker.settle(permit, i < failures);
  }
}

test('the breaker opens at 50% failure over 20 calls: 10 failed of 20 opens it and the next call is refused', () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  record(breaker, 19, 10);
  assert.equal(breaker.state, 'closed', 'closed after 19 calls, below the volume of 20');
  record(breaker, 1, 0);
  assert.equal(breaker.state, 'open', 'open at the 20th call with 10 of 20 failed');
  assert.equal(breaker.acquire(), undefined, 'the next call is refused');
});

test('below the threshold it stays closed: 9 failed of 20', () => {
  const breaker = createCircuitBreaker({ clock: createManualClock() });
  record(breaker, 20, 9);
  assert.equal(breaker.state, 'closed');
  assert.ok(breaker.acquire() !== undefined);
});

test('below the volume it stays closed: 19 calls, every one failed', () => {
  const breaker = createCircuitBreaker({ clock: createManualClock() });
  record(breaker, 19, 19);
  assert.equal(breaker.state, 'closed');
});

test('outcomes older than 60 s do not count: 10 failures at 0 ms and 10 successes at 60000 ms leave it closed, at 59999 ms they open it', async () => {
  const aged = createManualClock();
  const agedBreaker = createCircuitBreaker({ clock: aged });
  record(agedBreaker, 10, 10);
  await aged.advance(60_000);
  record(agedBreaker, 10, 0);
  assert.equal(agedBreaker.state, 'closed', 'the ten failures aged out of the window');

  const inside = createManualClock();
  const insideBreaker = createCircuitBreaker({ clock: inside });
  record(insideBreaker, 10, 10);
  await inside.advance(59_999);
  record(insideBreaker, 10, 0);
  assert.equal(insideBreaker.state, 'open', 'CONTROL: the same outcomes 1 ms earlier are inside the window');
});

test('while open every call is refused; at 30000 ms exactly one probe is admitted and a second call is still refused', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  record(breaker, 20, 20);
  await clock.advance(29_999);
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.acquire(), undefined, 'refused at 29999 ms');
  await clock.advance(1);
  assert.equal(breaker.state, 'half_open');
  const probe = breaker.acquire();
  assert.deepEqual(probe, { probe: true }, 'one probe at 30000 ms');
  assert.equal(breaker.acquire(), undefined, 'a second call while the probe is in flight is refused');
});

test('a successful probe closes the breaker with an empty window; a failed probe re-opens it for another 30 s', async () => {
  const clock = createManualClock();
  const changes: BreakerState[] = [];
  const breaker = createCircuitBreaker({ clock, onStateChange: (s) => changes.push(s) });
  record(breaker, 20, 20);
  await clock.advance(30_000);

  const failedProbe = breaker.acquire();
  assert.ok(failedProbe?.probe === true);
  breaker.settle(failedProbe, true);
  assert.equal(breaker.state, 'open', 'a failed probe re-opens');
  await clock.advance(29_999);
  assert.equal(breaker.acquire(), undefined, 'for another 30 s from the failed probe');
  await clock.advance(1);

  const goodProbe = breaker.acquire();
  assert.ok(goodProbe?.probe === true);
  breaker.settle(goodProbe, false);
  assert.equal(breaker.state, 'closed');
  record(breaker, 19, 19);
  assert.equal(breaker.state, 'closed', 'the window restarted empty: 19 failures are below the volume');
  assert.deepEqual(changes, ['open', 'half_open', 'open', 'half_open', 'closed']);
});

test('an attempt admitted before the breaker opened is not counted when it settles afterwards', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const early = breaker.acquire();
  assert.ok(early !== undefined);
  record(breaker, 20, 20);
  breaker.settle(early, false);
  assert.equal(breaker.state, 'open', 'a late success does not close an open breaker');
  await clock.advance(30_000);
  assert.equal(breaker.state, 'half_open');
});

test('a permit settles exactly once, and only on the breaker that issued it', () => {
  const breaker = createCircuitBreaker({ clock: createManualClock() });
  const other = createCircuitBreaker({ clock: createManualClock() });
  const permit = breaker.acquire();
  assert.ok(permit !== undefined);
  assert.throws(() => other.settle(permit, true), { name: 'TypeError', message: PERMIT_REFUSED });
  breaker.settle(permit, true);
  assert.throws(() => breaker.settle(permit, true), { name: 'TypeError', message: PERMIT_REFUSED });
  assert.throws(() => breaker.settle({ probe: true }, false), { name: 'TypeError', message: PERMIT_REFUSED });
});

test('BREAKER pins SD INT: opens at 50% failure over 20 calls in 60000 ms, probe after 30000 ms', () => {
  assert.deepEqual({ ...BREAKER }, { failureRatio: 0.5, minimumCalls: 20, windowMs: 60000, probeAfterMs: 30000 });
});

test('through the caller: an open breaker refuses the next call without reaching the transport, as upstream_unavailable with reason circuit_open', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  record(breaker, 20, 10);
  assert.equal(breaker.state, 'open');
  const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
  let reached = 0;
  const call = track(
    caller.call(async () => {
      reached++;
      return { status: 200 };
    }),
  );
  await clock.advance(0);
  assert.equal(reached, 0, 'the transport was not called');
  assert.ok(call.error instanceof UpstreamCallFailedError);
  assert.equal(call.error.reason, 'circuit_open');
  assert.equal(call.error.attempts, 0);
  assert.equal(call.error.retryable, true);
});

test('through the caller: every attempt is one breaker call, so the 20th failed attempt opens it partway through a request', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
  let reached = 0;
  const send = async (): Promise<{ status: number }> => {
    reached++;
    return { status: 500 };
  };
  for (let i = 0; i < 3; i++) {
    const call = track(caller.call(send));
    await clock.advance(1000);
    assert.equal((call.error as UpstreamCallFailedError).reason, 'server_error');
  }
  assert.equal(breaker.state, 'closed', '18 failed attempts: below the volume');
  const fourth = track(caller.call(send));
  await clock.advance(1000);
  assert.equal(reached, 20, 'the 20th attempt opened it; the 21st was refused');
  assert.equal((fourth.error as UpstreamCallFailedError).reason, 'circuit_open');
  assert.equal((fourth.error as UpstreamCallFailedError).attempts, 2);
});

test('a 4xx is a success for the breaker: 20 consecutive 404s leave it closed', async () => {
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
  for (let i = 0; i < 20; i++) {
    const call = track(caller.call(async () => ({ status: 404 })));
    await clock.advance(0);
    assert.deepEqual(call.value, { status: 404 });
  }
  assert.equal(breaker.state, 'closed');
});
