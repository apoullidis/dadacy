/**
 * `provider_health` — SD §INT's gauge, and the obligation `T-142` § Published
 * contract (rework 1) §8 places on "whoever wires `otel`", which is this
 * ticket:
 *
 *   > Expose `breaker.state` and `onStateChange` on the `provider_health`
 *   > gauge (SD §INT). A THROW FROM THE HOOK IS DISCARDED SILENTLY
 *   > (Deviation 9), so the exporter must surface its own failures.
 *   > `half_open` fires once per half-open episode, not per superseding probe.
 *
 * All three clauses are carried, and the bound in the third is carried WITH the
 * claim everywhere it is restated (PROTOCOL §5.3 R2), including in the gauge's
 * own doc comment below and in state/EP-1/T-008.md § Published contract §7.
 *
 * HOW THE FIRST TWO ARE ANSWERED:
 *
 *   `breaker.state` is a GETTER evaluated against the breaker's own clock, so
 *   `snapshot()` READS IT AT SNAPSHOT TIME rather than trusting the last
 *   transition it was told about. That matters because of the third clause: a
 *   breaker that has been open for 30 s reads `half_open` WITHOUT any hook
 *   having fired. A gauge built only from hook calls would show `open` for as
 *   long as no probe was issued, which is false. So the hook is the EVENT
 *   record and the getter is the VALUE — two readings, and the gauge reports
 *   both, which is also what stops it being derived from a single source
 *   (PROTOCOL §5.1).
 *
 *   The hook's throws are discarded by the breaker, so this hook must not
 *   depend on throwing to report a problem: it is wrapped, and a throw inside
 *   it increments `providerHealth.hookFailures` and is visible in the gauge's
 *   own snapshot. Separately, an export failure increments
 *   `exporterCounters.exportFailures` and calls the exporter's `onFailure` —
 *   the exporter surfacing its own failure, which is the clause's point.
 */
import { BREAKER_STATES, type BreakerState, type Provider, assertProvider } from './contract.ts';

/** The minimum of `@kinvara/integration-kit`'s `CircuitBreaker` this gauge reads. */
export interface BreakerStateSource {
  readonly state: BreakerState;
}

export interface ProviderHealthReading {
  readonly provider: Provider;
  /** Read from `breaker.state` AT SNAPSHOT TIME, not from the last hook call. */
  readonly state: BreakerState;
  /** The last state `onStateChange` reported, or `unknown` if it has never fired. */
  readonly lastNotified: BreakerState;
  /** How many times `onStateChange` has fired for this provider. */
  readonly transitions: number;
}

interface Registration {
  readonly source: BreakerStateSource;
  lastNotified: BreakerState;
  transitions: number;
}

const registry = new Map<Provider, Registration>();

export const providerHealth = {
  /** Throws from inside the wrapped hook. The breaker discards them; this does not. */
  hookFailures: 0,
  /** `onStateChange` calls carrying a value that is not a breaker state. */
  badNotifications: 0,
};

export const resetProviderHealth = (): void => {
  registry.clear();
  providerHealth.hookFailures = 0;
  providerHealth.badNotifications = 0;
};

/**
 * Register a provider's breaker and get back the `onStateChange` hook to pass
 * to `createCircuitBreaker({ onStateChange })`.
 *
 * ONE breaker per provider (`T-142` § contract §8). Registering a second one
 * for the same provider replaces the first, because a second breaker for one
 * provider is already a defect on that contract and a gauge that reported both
 * would hide it.
 */
export function registerProviderHealth(
  provider: Provider,
  source: BreakerStateSource,
): (state: BreakerState) => void {
  const key = assertProvider(provider);
  const registration: Registration = { source, lastNotified: 'unknown', transitions: 0 };
  registry.set(key, registration);
  return (state: BreakerState): void => {
    try {
      if (!(BREAKER_STATES as readonly string[]).includes(state)) {
        providerHealth.badNotifications += 1;
        return;
      }
      registration.lastNotified = state;
      registration.transitions += 1;
    } catch {
      providerHealth.hookFailures += 1;
    }
  };
}

/**
 * The gauge's current value.
 *
 * `transitions` COUNTS HOOK CALLS, and `T-142` § contract §8's bound travels
 * with it: `half_open` FIRES ONCE PER HALF-OPEN EPISODE, NOT PER SUPERSEDING
 * PROBE. So `transitions` is a count of transitions the breaker NOTIFIED, not a
 * count of probes issued, and it must not be read as one.
 */
export function snapshotProviderHealth(): readonly ProviderHealthReading[] {
  const out: ProviderHealthReading[] = [];
  for (const [provider, registration] of registry) {
    let state: BreakerState = 'unknown';
    try {
      const read: unknown = registration.source.state;
      state = (BREAKER_STATES as readonly string[]).includes(read as string)
        ? (read as BreakerState)
        : 'unknown';
    } catch {
      providerHealth.hookFailures += 1;
    }
    out.push({
      provider,
      state,
      lastNotified: registration.lastNotified,
      transitions: registration.transitions,
    });
  }
  return out;
}

/**
 * OTLP/JSON metrics envelope for `provider_health`, one gauge data point per
 * registered provider per state, value 1 or 0.
 *
 * The attribute set is `{provider, state}` and both are enumerations, so this
 * metric has the same property the span contract has: NOTHING IN IT CAN CARRY
 * FREE TEXT.
 */
export function providerHealthPayload(
  serviceName: string,
  nowMillis: number,
  readings: readonly ProviderHealthReading[] = snapshotProviderHealth(),
): unknown {
  const timeUnixNano = `${Math.trunc(nowMillis)}000000`;
  const dataPoints = readings.flatMap((reading) =>
    BREAKER_STATES.map((state) => ({
      timeUnixNano,
      asInt: String(reading.state === state ? 1 : 0),
      attributes: [
        { key: 'provider', value: { stringValue: reading.provider } },
        { key: 'state', value: { stringValue: state } },
      ],
    })),
  );
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
        scopeMetrics: [
          {
            scope: { name: '@kinvara/observability', version: '0.0.0' },
            metrics: [
              {
                name: 'provider_health',
                description:
                  'The circuit-breaker state of each upstream provider (SD §INT). 1 for the state the breaker is in, 0 for the others.',
                gauge: { dataPoints },
              },
            ],
          },
        ],
      },
    ],
  };
}
