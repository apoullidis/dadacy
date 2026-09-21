/**
 * SD §INT's `provider_health` gauge and the three clauses of
 * `T-142` § Published contract (rework 1) §8.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  providerHealth,
  providerHealthPayload,
  registerProviderHealth,
  resetProviderHealth,
  snapshotProviderHealth,
} from './provider-health.ts';
import type { BreakerState } from './contract.ts';

class FakeBreaker {
  value: BreakerState;
  constructor(value: BreakerState) {
    this.value = value;
  }
  get state(): BreakerState {
    return this.value;
  }
}

beforeEach(() => {
  resetProviderHealth();
});

describe('the gauge reads breaker.state at snapshot time, not the last hook call', () => {
  test('a breaker that moved to half_open WITHOUT notifying is reported half_open', () => {
    const breaker = new FakeBreaker('open');
    const hook = registerProviderHealth('hibp', breaker);
    hook('open');
    // T-142 § contract §2: an OPEN breaker whose 30 s have passed READS
    // half_open, and no hook fires until a probe is admitted. A gauge built
    // from hook calls alone would still say `open` here.
    breaker.value = 'half_open';
    const reading = snapshotProviderHealth()[0];
    expect(reading?.state).toBe('half_open');
    expect(reading?.lastNotified).toBe('open');
  });

  test('a breaker whose state getter throws reports unknown and counts the failure', () => {
    const throwing = {
      get state(): BreakerState {
        throw new Error('breaker exploded');
      },
    };
    registerProviderHealth('stripe', throwing);
    expect(snapshotProviderHealth()[0]?.state).toBe('unknown');
    expect(providerHealth.hookFailures).toBe(1);
  });

  test('a breaker whose state is not a breaker state reports unknown, not the value', () => {
    registerProviderHealth('stripe', { state: 'parent@example.cy' } as unknown as FakeBreaker);
    const reading = snapshotProviderHealth()[0];
    expect(reading?.state).toBe('unknown');
    expect(JSON.stringify(reading)).not.toContain('parent@example.cy');
  });
});

describe('the hook cannot report by throwing, because the breaker discards throws', () => {
  test('a notification carrying a non-state is counted, not recorded', () => {
    const hook = registerProviderHealth('telephony', new FakeBreaker('closed'));
    hook('tripped' as BreakerState);
    expect(providerHealth.badNotifications).toBe(1);
    expect(snapshotProviderHealth()[0]?.lastNotified).toBe('unknown');
    expect(snapshotProviderHealth()[0]?.transitions).toBe(0);
  });

  test('transitions counts hook calls — NOT probes; half_open fires once per half-open EPISODE, not per superseding probe (T-142 § contract §8)', () => {
    const hook = registerProviderHealth('hibp', new FakeBreaker('closed'));
    hook('open');
    hook('half_open');
    hook('closed');
    expect(snapshotProviderHealth()[0]?.transitions).toBe(3);
  });

  test('registering a second breaker for one provider replaces the first', () => {
    registerProviderHealth('hibp', new FakeBreaker('closed'));
    registerProviderHealth('hibp', new FakeBreaker('open'));
    const readings = snapshotProviderHealth();
    expect(readings).toHaveLength(1);
    expect(readings[0]?.state).toBe('open');
  });

  test('an undeclared provider is refused at registration', () => {
    expect(() => registerProviderHealth('datadog' as never, new FakeBreaker('closed'))).toThrow(
      /not a declared provider/,
    );
  });
});

describe('the gauge payload carries only enumerations', () => {
  test('one data point per provider per state, value 1 for the current state', () => {
    registerProviderHealth('hibp', new FakeBreaker('half_open'));
    const payload = providerHealthPayload('kinvara-core', 1_700_000_000_000) as {
      resourceMetrics: {
        scopeMetrics: { metrics: { name: string; gauge: { dataPoints: unknown[] } }[] }[];
      }[];
    };
    const metric = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
    expect(metric?.name).toBe('provider_health');
    const points = metric?.gauge.dataPoints as {
      asInt: string;
      attributes: { key: string; value: { stringValue: string } }[];
    }[];
    expect(points).toHaveLength(4);
    const on = points.filter((p) => p.asInt === '1');
    expect(on).toHaveLength(1);
    expect(on[0]?.attributes.map((a) => a.value.stringValue)).toEqual(['hibp', 'half_open']);
    for (const point of points) {
      for (const attribute of point.attributes) {
        expect(['provider', 'state']).toContain(attribute.key);
      }
    }
  });
});
