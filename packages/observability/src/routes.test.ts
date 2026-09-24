/**
 * The registry, the refusal path, and the observer's route resolution.
 *
 * These are the cases behind "how `data_class` is set, and what happens when it
 * is absent or wrong" (state/EP-1/T-008.md § Published contract §3).
 */
import { describe, expect, test } from 'vitest';
import {
  RESERVED_ROUTES,
  ROUTE_REGISTRY,
  RegistryMalformed,
  assertRegistry,
  lookupRoute,
  type RouteEntry,
} from './routes.ts';
import { DATA_CLASSES, MODULES, UNCLASSIFIED } from './contract.ts';
import {
  counters,
  refuseRequestSpan,
  requestSpanOrRefusal,
  resetCounters,
  timingFrom,
} from './span.ts';
import { createRequestObserver, resolveRoute, traceIdFrom } from './http.ts';
import { createExporter, type OtlpSpan } from './index.ts';

const TIMING = timingFrom(1_700_000_000_000, 3);
const attrs = (span: OtlpSpan): Record<string, string> =>
  Object.fromEntries(
    span.attributes.map((a) => [
      a.key,
      'stringValue' in a.value ? a.value.stringValue : a.value.intValue,
    ]),
  );

describe('the registry is well formed, and assertRegistry says so when it is not', () => {
  test('every entry names a SA SA-2 module, a SA SEC-3 class and a reason', () => {
    for (const [key, entry] of Object.entries(ROUTE_REGISTRY)) {
      expect((MODULES as readonly string[]).includes(entry.module), key).toBe(true);
      expect((DATA_CLASSES as readonly string[]).includes(entry.data_class), key).toBe(true);
      expect(entry.because.trim().length, key).toBeGreaterThan(0);
    }
  });

  test('a fifth data class is refused at load, not at request time', () => {
    const bad = { 'GET /x': { module: 'meta', data_class: 'C5', because: 'no' } };
    expect(() => {
      assertRegistry(bad as unknown as Readonly<Record<string, RouteEntry>>);
    }).toThrow(RegistryMalformed);
  });

  test('a module outside SA SA-2 is refused at load', () => {
    const bad = { 'GET /x': { module: 'billing', data_class: 'C4', because: 'no' } };
    expect(() => {
      assertRegistry(bad as unknown as Readonly<Record<string, RouteEntry>>);
    }).toThrow(/not in SA §SA-2/);
  });

  test('a concrete URL as a key is refused at load', () => {
    const bad = {
      'GET /v1/accounts?email=a@b.cy': { module: 'meta', data_class: 'C4', because: 'no' },
    };
    expect(() => {
      assertRegistry(bad as unknown as Readonly<Record<string, RouteEntry>>);
    }).toThrow(/is not "<METHOD> \/template"/);
  });

  test('an entry with no reason is refused at load', () => {
    const bad = { 'GET /x': { module: 'meta', data_class: 'C4', because: '  ' } };
    expect(() => {
      assertRegistry(bad as unknown as Readonly<Record<string, RouteEntry>>);
    }).toThrow(/gives no reason/);
  });

  test('an empty registry is refused — a registry that classifies nothing is the vacuous pass', () => {
    expect(() => {
      assertRegistry({});
    }).toThrow(/it is empty/);
  });
});

describe('an unregistered route cannot produce a classified span', () => {
  test('the refusal span carries (unregistered), UNCLASSIFIED, and NOTHING from the rejected route', () => {
    resetCounters();
    const span = requestSpanOrRefusal(
      {
        trace_id: 'b'.repeat(32),
        route: 'GET /v1/accounts/parent@example.cy',
        module: 'identity',
        actor_role: 'parent',
        status: 404,
        duration_ms: 4,
        data_class: 'C2',
      },
      TIMING,
    );
    const a = attrs(span);
    expect(a['route']).toBe(RESERVED_ROUTES.unregistered);
    expect(a['data_class']).toBe(UNCLASSIFIED);
    expect(span.name).toBe(RESERVED_ROUTES.unregistered);
    expect(JSON.stringify(span)).not.toContain('parent@example.cy');
    expect(counters.refusedSpans).toBe(1);
    expect(counters.requestSpans).toBe(0);
  });

  test('a refusal cannot be a leak route: a bad actor_role/status/duration falls back, it does not pass through', () => {
    const span = refuseRequestSpan(
      'c'.repeat(32),
      {
        actor_role: 'parent+35799123456@example.cy',
        status: 'CY17002001280000001200527600',
        duration_ms: 'Χριστοδούλου',
      },
      TIMING,
    );
    const a = attrs(span);
    expect(a['actor_role']).toBe('system');
    expect(a['status']).toBe('500');
    expect(a['duration_ms']).toBe('0');
    expect(JSON.stringify(span)).not.toContain('35799123456');
    expect(JSON.stringify(span)).not.toContain('Χριστοδούλου');
    expect(JSON.stringify(span)).not.toContain('CY17002001280000001200527600');
  });

  test('a malformed trace id on a refusal becomes 32 zeroes, not the malformed bytes', () => {
    const span = refuseRequestSpan('parent@example.cy', {}, TIMING);
    expect(span.traceId).toBe('0'.repeat(32));
    expect(JSON.stringify(span)).not.toContain('parent@example.cy');
  });

  test('the status message is a fixed vocabulary, never an error message', () => {
    const span = refuseRequestSpan('d'.repeat(32), {}, TIMING);
    expect(span.status.message).toBe('contract_refused');
  });
});

describe('resolveRoute never returns anything derived from the URL the client sent', () => {
  test('an unmatched request becomes (unmatched) and the path is discarded', () => {
    expect(resolveRoute('GET', undefined)).toBe(RESERVED_ROUTES.unmatched);
    expect(resolveRoute('GET', '')).toBe(RESERVED_ROUTES.unmatched);
    expect(resolveRoute('GET', '*')).toBe(RESERVED_ROUTES.unmatched);
  });

  test('a matched-but-unregistered template becomes (unregistered)', () => {
    expect(resolveRoute('GET', '/v1/not/in/the/registry')).toBe(RESERVED_ROUTES.unregistered);
  });

  test('a registered template becomes its key, method upper-cased', () => {
    expect(resolveRoute('post', '/v1/auth/login')).toBe('POST /v1/auth/login');
    expect(lookupRoute('POST /v1/auth/login')?.data_class).toBe('C2');
  });
});

describe('traceparent is client input and reaches telemetry only through a total function', () => {
  test('a valid W3C traceparent is honoured', () => {
    const id = 'f'.repeat(32);
    expect(traceIdFrom(`00-${id}-${'1'.repeat(16)}-01`)).toBe(id);
  });

  test('anything else yields a fresh 32-hex id and never the header bytes', () => {
    for (const header of [
      'not-a-traceparent',
      '00-parent@example.cy-1111111111111111-01',
      `00-${'0'.repeat(32)}-1111111111111111-01`,
      '',
      undefined,
    ]) {
      const id = traceIdFrom(header);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe('0'.repeat(32));
      if (typeof header === 'string' && header.length > 0) expect(id).not.toContain(header);
    }
  });
});

describe('the observer, end to end in process', () => {
  test('a registered route produces a span whose attribute keys are exactly the contract', () => {
    resetCounters();
    const recorded: OtlpSpan[] = [];
    const exporter = createExporter({ endpoint: 'http://x', serviceName: 'test' });
    const observer = createRequestObserver({
      record: (s) => recorded.push(s),
      flush: exporter.flush,
      shutdown: exporter.shutdown,
      pending: () => 0,
    });
    observer.observe({
      method: 'GET',
      routeTemplate: '/v1/meta/platform-fee',
      statusCode: 200,
      startMillis: 1_700_000_000_000,
      durationMs: 2,
    });
    expect(recorded).toHaveLength(1);
    const span = recorded[0] as OtlpSpan;
    expect(span.attributes.map((a) => a.key)).toEqual([
      'trace_id',
      'route',
      'module',
      'actor_role',
      'status',
      'duration_ms',
      'data_class',
    ]);
    expect(attrs(span)['data_class']).toBe('C4');
    expect(counters.requestSpans).toBe(1);
    expect(counters.refusedSpans).toBe(0);
  });

  test('a 404 discards the path and is stamped C4 (unmatched), not left unclassified', () => {
    resetCounters();
    const recorded: OtlpSpan[] = [];
    const observer = createRequestObserver({
      record: (s) => recorded.push(s),
      flush: () => Promise.resolve({ ok: true, spans: 0 }),
      shutdown: () => Promise.resolve({ ok: true, spans: 0 }),
      pending: () => 0,
    });
    observer.observe({
      method: 'GET',
      routeTemplate: undefined,
      statusCode: 404,
      startMillis: 1_700_000_000_000,
      durationMs: 1,
    });
    const span = recorded[0] as OtlpSpan;
    expect(attrs(span)['route']).toBe(RESERVED_ROUTES.unmatched);
    expect(attrs(span)['data_class']).toBe('C4');
    expect(counters.refusedSpans).toBe(0);
  });
});
