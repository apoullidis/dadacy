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
  type Clock,
  type Permit,
  type UpstreamResponse,
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

/** Acquire `n` permits and hold them unsettled. */
function hold(breaker: CircuitBreaker, n: number): Permit[] {
  const permits: Permit[] = [];
  for (let i = 0; i < n; i++) {
    const permit = breaker.acquire();
    assert.ok(permit !== undefined, `held permit ${String(i + 1)} of ${String(n)} was refused`);
    permits.push(permit);
  }
  return permits;
}

const describeOutcome = (error: unknown): string =>
  error instanceof UpstreamCallFailedError
    ? `${error.reason}/${String(error.attempts)}`
    : String(error);

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
  assert.equal(
    insideBreaker.state,
    'open',
    'CONTROL: the same outcomes 1 ms earlier are inside the window',
  );
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
  assert.equal(
    breaker.acquire(),
    undefined,
    'a second call while the probe is in flight is refused',
  );
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
  assert.equal(
    breaker.state,
    'closed',
    'the window restarted empty: 19 failures are below the volume',
  );
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

test('a permit issued before the breaker last left closed is not counted after a probe re-closes it: 20 pre-open failures settled then leave it closed', async () => {
  // QA's QM1 / B12 scenario (OD-112, ruling 1).
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const early = hold(breaker, 20);
  record(breaker, 20, 20);
  assert.equal(breaker.state, 'open', 'CONTROL: 20 other failures opened it');
  await clock.advance(30_000);
  const probe = breaker.acquire();
  assert.ok(probe?.probe === true, 'CONTROL: a probe at 30000 ms');
  breaker.settle(probe, false);
  assert.equal(breaker.state, 'closed', 'CONTROL: the probe re-closed it');
  for (const permit of early) breaker.settle(permit, true);
  assert.equal(
    breaker.state,
    'closed',
    '20 pre-open failures settled after the re-close are not counted: the breaker stays closed',
  );
  record(breaker, 19, 19);
  assert.equal(
    breaker.state,
    'closed',
    'the pre-open failures left nothing in the window: 19 new failures are below the volume',
  );
});

test('pre-open failures settled while the breaker is open are not counted: they neither re-open it nor move the probe time', async () => {
  // QA's LE-guard reading: observable, and pinned by no case at 52a665e.
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const early = hold(breaker, 20);
  record(breaker, 20, 20);
  await clock.advance(10_000);
  for (const permit of early) breaker.settle(permit, true);
  await clock.advance(20_000);
  assert.equal(
    breaker.state,
    'half_open',
    '20 pre-open failures settled at 10000 ms while open did not re-open it: the probe is still due at 30000 ms',
  );
});

test('through the caller: 20 attempts in flight when the breaker opened, timing out at 45000 ms after a probe re-closed it, leave it closed', async () => {
  // QA's B12b scenario: a per-attempt timeout longer than the 30 s probe delay.
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  const slow = createUpstreamCaller({ breaker, clock, random: () => 0, timeoutMs: 45_000 });
  let started = 0;
  const hang = (): Promise<UpstreamResponse> => {
    started++;
    return new Promise<UpstreamResponse>(() => undefined);
  };
  for (let i = 0; i < 20; i++) track(slow.call(hang));
  await clock.advance(0);
  assert.equal(started, 20, 'CONTROL: 20 attempts in flight');
  record(breaker, 20, 20);
  assert.equal(breaker.state, 'open', 'CONTROL: 20 other failures opened it');
  await clock.advance(30_000);
  const probe = breaker.acquire();
  assert.ok(probe?.probe === true, 'CONTROL: a probe at 30000 ms');
  breaker.settle(probe, false);
  assert.equal(breaker.state, 'closed', 'CONTROL: the probe re-closed it');
  await clock.advance(15_000);
  assert.equal(
    breaker.state,
    'closed',
    'the 20 timeouts of attempts admitted before the breaker opened are not counted: it stays closed',
  );
  assert.equal(
    started,
    40,
    'CONTROL: the 20 timed-out attempts were retried into a closed breaker',
  );
});

test('a half-open probe whose transport resolves null or undefined is settled as failed: the call ends in upstream_unavailable, the breaker re-opens, and 30 s later a healthy call closes it', async () => {
  // QA's B8 scenario (OD-113, ruling 2a).
  for (const bad of [null, undefined]) {
    const clock = createManualClock();
    const breaker = createCircuitBreaker({ clock });
    record(breaker, 20, 20);
    await clock.advance(30_000);
    const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
    const probeCall = track(caller.call(async () => bad as unknown as UpstreamResponse));
    await clock.advance(0);
    assert.ok(
      probeCall.error instanceof UpstreamCallFailedError,
      `a ${String(bad)} probe response ends in UpstreamCallFailedError, not ${String(probeCall.error)}`,
    );
    assert.equal(
      probeCall.error.reason,
      'circuit_open',
      'its retry is refused by the re-opened breaker',
    );
    assert.equal(probeCall.error.attempts, 1);
    assert.equal(
      breaker.state,
      'open',
      `a ${String(bad)} probe response was settled as failed: the breaker re-opened`,
    );
    await clock.advance(30_000);
    const healthy = track(caller.call(async () => ({ status: 200 })));
    await clock.advance(0);
    assert.deepEqual(
      healthy.value,
      { status: 200 },
      'a healthy call 30 s later is admitted as the next probe',
    );
    assert.equal(breaker.state, 'closed');
  }
});

test('every exit from an attempt settles its permit: a clock that throws while arming the probe attempt rejects that call and the probe is settled as failed', async () => {
  // Ruling 2a, the exit that is not a response: an exception between acquire() and settle().
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  record(breaker, 20, 20);
  await clock.advance(30_000);
  const broken = new Error('clock unavailable');
  const throwing: Clock = {
    now: () => clock.now(),
    setTimeout: (): unknown => {
      throw broken;
    },
    clearTimeout: (handle) => {
      clock.clearTimeout(handle);
    },
  };
  const brokenCaller = createUpstreamCaller({ breaker, clock: throwing, random: () => 0 });
  const call = track(brokenCaller.call(async () => ({ status: 200 })));
  await clock.advance(0);
  assert.equal(call.error, broken, 'CONTROL: the clock error is the rejection');
  assert.equal(
    breaker.state,
    'open',
    'the probe was settled as failed on the way out: the breaker re-opened instead of holding the probe',
  );
  await clock.advance(30_000);
  const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
  const healthy = track(caller.call(async () => ({ status: 200 })));
  await clock.advance(0);
  assert.deepEqual(healthy.value, { status: 200 });
  assert.equal(breaker.state, 'closed');
});

test('a throwing onStateChange changes nothing: throwing on open, on half_open, on closed or on all three, every request sees the kit outcome and the breaker still opens, probes and closes', async () => {
  // QA's B9 scenario (OD-113, ruling 2b).
  for (const on of ['open', 'half_open', 'closed', 'all'] as const) {
    const clock = createManualClock();
    const seen: BreakerState[] = [];
    const breaker = createCircuitBreaker({
      clock,
      onStateChange: (s) => {
        seen.push(s);
        if (on === 'all' || s === on) throw new Error('gauge exporter not initialised');
      },
    });
    const caller = createUpstreamCaller({ breaker, clock, random: () => 0 });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const call = track(caller.call(async () => ({ status: 503 })));
      await clock.advance(1000);
      outcomes.push(describeOutcome(call.error));
    }
    assert.deepEqual(
      outcomes,
      ['server_error/6', 'server_error/6', 'server_error/6', 'circuit_open/2'],
      `hook throwing on ${on}: the request that trips the breaker is refused as circuit_open, not with the hook error`,
    );
    assert.equal(
      breaker.state,
      'open',
      `hook throwing on ${on}: open after the 20th failed attempt`,
    );
    await clock.advance(30_000);
    const healthy = track(caller.call(async () => ({ status: 200 })));
    await clock.advance(0);
    assert.deepEqual(
      healthy.value,
      { status: 200 },
      `hook throwing on ${on}: the probe is admitted and its 200 returned, not the hook error (${String(healthy.error)})`,
    );
    assert.equal(breaker.state, 'closed', `hook throwing on ${on}: the probe closed the breaker`);
    assert.deepEqual(seen, ['open', 'half_open', 'closed'], `hook throwing on ${on}: transitions`);
  }
});

test('an unsettled probe is bounded: 30000 ms after it was issued one new probe is admitted, and the stale probe late settle is ignored', async () => {
  // QA's B7 scenario (OD-113, ruling 2c).
  const clock = createManualClock();
  const breaker = createCircuitBreaker({ clock });
  record(breaker, 20, 20);
  await clock.advance(30_000);
  const stale = breaker.acquire();
  assert.ok(stale?.probe === true, 'CONTROL: the first probe at 30000 ms');
  await clock.advance(29_999);
  assert.equal(
    breaker.acquire(),
    undefined,
    'refused at 59999 ms: the unsettled probe was issued 29999 ms ago',
  );
  await clock.advance(1);
  const readmitted = breaker.acquire();
  assert.ok(
    readmitted?.probe === true,
    'a new probe is admitted 30000 ms after the unsettled probe was issued',
  );
  assert.equal(breaker.acquire(), undefined, 'exactly one new probe is admitted');
  breaker.settle(stale, true);
  assert.equal(
    breaker.state,
    'half_open',
    'the stale probe late failure is ignored: the breaker did not re-open',
  );
  assert.equal(
    breaker.acquire(),
    undefined,
    'the stale probe late settle did not free the probe slot',
  );
  breaker.settle(readmitted, false);
  assert.equal(breaker.state, 'closed', 'the re-admitted probe decides');
  assert.throws(
    () => breaker.settle(stale, false),
    { name: 'TypeError', message: PERMIT_REFUSED },
    'the stale probe still settles only once',
  );
  record(breaker, 19, 19);
  assert.equal(breaker.state, 'closed', 'nothing from the stale probe entered the window');

  // Through the caller, as QA measured it: a probe acquired and never settled, then a healthy call.
  const clock2 = createManualClock();
  const breaker2 = createCircuitBreaker({ clock: clock2 });
  record(breaker2, 20, 20);
  await clock2.advance(30_000);
  assert.ok(breaker2.acquire()?.probe === true, 'CONTROL: a probe acquired and never settled');
  await clock2.advance(30_000);
  const caller = createUpstreamCaller({ breaker: breaker2, clock: clock2, random: () => 0 });
  let reached = 0;
  const healthy = track(
    caller.call(async () => {
      reached++;
      return { status: 200 };
    }),
  );
  await clock2.advance(0);
  assert.deepEqual(
    healthy.value,
    { status: 200 },
    'through the caller: a healthy call 30 s after the unsettled probe is admitted and returned',
  );
  assert.equal(reached, 1);
  assert.equal(breaker2.state, 'closed');
});

test('a permit settles exactly once, and only on the breaker that issued it', () => {
  const breaker = createCircuitBreaker({ clock: createManualClock() });
  const other = createCircuitBreaker({ clock: createManualClock() });
  const permit = breaker.acquire();
  assert.ok(permit !== undefined);
  assert.throws(() => other.settle(permit, true), { name: 'TypeError', message: PERMIT_REFUSED });
  breaker.settle(permit, true);
  assert.throws(() => breaker.settle(permit, true), { name: 'TypeError', message: PERMIT_REFUSED });
  assert.throws(() => breaker.settle({ probe: true }, false), {
    name: 'TypeError',
    message: PERMIT_REFUSED,
  });
});

test('BREAKER pins SD INT: opens at 50% failure over 20 calls in 60000 ms, probe after 30000 ms', () => {
  assert.deepEqual(
    { ...BREAKER },
    { failureRatio: 0.5, minimumCalls: 20, windowMs: 60000, probeAfterMs: 30000 },
  );
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
