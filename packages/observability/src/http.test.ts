/**
 * THE OBSERVER PATH — the only path `apps/core` uses.
 *
 * Every other suite in this package exercises the builder directly, which is
 * what a unit test naturally wants and which is exactly how T-008 shipped a
 * false sentence: `createRequestObserver` calls `resolveRoute` FIRST, so by the
 * time the builder sees the route it is already the reserved `(unregistered)`
 * marker — and the marker is itself a `ROUTE_REGISTRY` key. `lookupRoute` found
 * it, `?? UNCLASSIFIED` never fired, and a served route with no registry entry
 * was stamped `C4` with `counters.refusedSpans` at 0, while five sentences in
 * the contract and the source said it was stamped `UNCLASSIFIED` and counted
 * (T-008 rework 1, QA-F1).
 *
 * So these cases are written AT THE ADAPTER'S CALL SHAPE, never at the
 * builder's, and the two controls below exist so that they cannot go green by
 * the mechanism disappearing: the marker's registry entry is asserted to still
 * say `C4`, and `(unmatched)` is asserted to still be a classified, uncounted,
 * un-refused span.
 */
import { describe, expect, test } from 'vitest';
import { createRequestObserver, resolveRoute } from './http.ts';
import { RESERVED_ROUTES, ROUTE_REGISTRY, lookupRoute } from './routes.ts';
import { REFUSAL, UNCLASSIFIED, InstrumentationRefused } from './contract.ts';
import { buildRequestSpan, counters, resetCounters, timingFrom, type OtlpSpan } from './span.ts';

const TIMING = timingFrom(1_700_000_000_000, 3);

const attrs = (span: OtlpSpan): Record<string, string> =>
  Object.fromEntries(
    span.attributes.map((a) => [
      a.key,
      'stringValue' in a.value ? a.value.stringValue : a.value.intValue,
    ]),
  );

const observed = (routeTemplate: string | undefined, method = 'GET'): OtlpSpan => {
  const recorded: OtlpSpan[] = [];
  const observer = createRequestObserver({
    record: (s) => recorded.push(s),
    flush: () => Promise.resolve({ ok: true, spans: 0 }),
    shutdown: () => Promise.resolve({ ok: true, spans: 0 }),
    pending: () => 0,
  });
  observer.observe({
    method,
    routeTemplate,
    statusCode: 200,
    startMillis: 1_700_000_000_000,
    durationMs: 2,
  });
  return recorded[0] as OtlpSpan;
};

describe('an unregistered route is stamped through the OBSERVER, not only through the builder', () => {
  test('a matched-but-unregistered route is stamped UNCLASSIFIED THROUGH the observer, and refusedSpans increments', () => {
    resetCounters();
    const span = observed('/v1/not/in/the/registry');
    const a = attrs(span);
    expect(a['route']).toBe(RESERVED_ROUTES.unregistered);
    expect(a['data_class']).toBe(UNCLASSIFIED);
    expect(a['module']).toBe('meta');
    expect(span.name).toBe(RESERVED_ROUTES.unregistered);
    expect(counters.refusedSpans).toBe(1);
    expect(counters.requestSpans).toBe(0);
  });

  test('CONTROL — the marker still HAS a registry entry, and it still says C4', () => {
    // Anchored outside the observer on purpose (PROTOCOL §5.1: a check must not
    // be derived from the same reading as the thing it checks). If the fix above
    // were ever "achieved" by deleting the marker's entry, this control goes red
    // and the case above would no longer be measuring what it names.
    expect(lookupRoute(RESERVED_ROUTES.unregistered)?.data_class).toBe('C4');
    expect(Object.hasOwn(ROUTE_REGISTRY, RESERVED_ROUTES.unregistered)).toBe(true);
    expect(resolveRoute('GET', '/v1/not/in/the/registry')).toBe(RESERVED_ROUTES.unregistered);
  });

  test('CONTROL — (unmatched) is NOT refused: it is a classified C4 meta span and refusedSpans stays 0', () => {
    resetCounters();
    const a = attrs(observed(undefined));
    expect(a['route']).toBe(RESERVED_ROUTES.unmatched);
    expect(a['data_class']).toBe('C4');
    expect(counters.refusedSpans).toBe(0);
    expect(counters.requestSpans).toBe(1);
  });

  test('CONTROL — a registered route is still stamped from its own registry entry', () => {
    resetCounters();
    const a = attrs(observed('/v1/auth/login', 'post'));
    expect(a['route']).toBe('POST /v1/auth/login');
    expect(a['data_class']).toBe('C2');
    expect(a['module']).toBe('identity');
    expect(counters.refusedSpans).toBe(0);
    expect(counters.requestSpans).toBe(1);
  });

  test('the observer refusal carries NOTHING from the rejected route', () => {
    resetCounters();
    const span = observed('/v1/accounts/parent@example.cy');
    expect(JSON.stringify(span)).not.toContain('parent@example.cy');
    expect(attrs(span)['route']).toBe(RESERVED_ROUTES.unregistered);
  });

  test('the marker is refused as an INPUT route by the builder, as UNCLASSIFIED is refused as an input class', () => {
    expect(() =>
      buildRequestSpan(
        {
          trace_id: 'a'.repeat(32),
          route: RESERVED_ROUTES.unregistered,
          module: 'meta',
          actor_role: 'anonymous',
          status: 200,
          duration_ms: 1,
          data_class: 'C4',
        },
        TIMING,
      ),
    ).toThrow(InstrumentationRefused);
    try {
      buildRequestSpan(
        {
          trace_id: 'a'.repeat(32),
          route: RESERVED_ROUTES.unregistered,
          module: 'meta',
          actor_role: 'anonymous',
          status: 200,
          duration_ms: 1,
          data_class: 'C4',
        },
        TIMING,
      );
    } catch (thrown) {
      expect((thrown as Error).message).toContain(REFUSAL.unregisteredRoute);
    }
  });
});
