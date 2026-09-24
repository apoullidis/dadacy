/**
 * THE REFUSALS. Every sentence in state/EP-1/T-008.md § Published contract §§2–4
 * that says the contract refuses something has a case here that plants the
 * thing and asserts the refusal.
 *
 * Each case asserts the refusal's SHAPE — the class, the reason string and the
 * field — not merely that something threw. A crash, a refusal for the wrong
 * reason and a refusal are three distinguishable outcomes (PROTOCOL §5.1).
 */
import { describe, expect, test } from 'vitest';
import {
  ACTOR_ROLES,
  DATA_CLASSES,
  InstrumentationRefused,
  JOB_FIELDS,
  MODULES,
  PROVIDER_FIELDS,
  REFUSAL,
  REQUEST_FIELDS,
  UNCLASSIFIED,
} from './contract.ts';
import { buildJobSpan, buildProviderSpan, buildRequestSpan, timingFrom } from './span.ts';

const TIMING = timingFrom(1_700_000_000_000, 12);
const TRACE = 'a'.repeat(32);

const validRequest = (): Record<string, unknown> => ({
  trace_id: TRACE,
  route: 'POST /v1/auth/login',
  module: 'identity',
  actor_role: 'anonymous',
  status: 200,
  duration_ms: 12,
  data_class: 'C2',
});

/** Assert the refusal's class, reason and field — never just "it threw". */
const refusedWith = (fn: () => unknown, reason: string, field: string): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'nothing was thrown; the contract accepted the planted value').toBeInstanceOf(
    InstrumentationRefused,
  );
  const refusal = thrown as InstrumentationRefused;
  expect(refusal.field).toBe(field);
  expect(refusal.message).toContain(reason);
};

describe('the tuple is SD §QD-5 verbatim', () => {
  test('REQUEST_FIELDS is SD QD-5 request tuple, in order', () => {
    expect([...REQUEST_FIELDS]).toEqual([
      'trace_id',
      'route',
      'module',
      'actor_role',
      'status',
      'duration_ms',
      'data_class',
    ]);
  });

  test('JOB_FIELDS and PROVIDER_FIELDS are SD QD-5 job and provider tuples, in order', () => {
    expect([...JOB_FIELDS]).toEqual(['queue', 'job_id', 'attempt', 'duration_ms', 'outcome']);
    expect([...PROVIDER_FIELDS]).toEqual([
      'provider',
      'operation',
      'status',
      'duration_ms',
      'breaker_state',
    ]);
  });

  test('DATA_CLASSES is SA SEC-3 four classes and UNCLASSIFIED is not one of them', () => {
    expect([...DATA_CLASSES]).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect((DATA_CLASSES as readonly string[]).includes(UNCLASSIFIED)).toBe(false);
  });
});

describe('the key set is an allowlist, and an extra key is refused rather than dropped', () => {
  test('an extra key is refused, naming the key', () => {
    refusedWith(
      () => buildRequestSpan({ ...validRequest(), email: 'a@b.cy' }, TIMING),
      REFUSAL.unknownField,
      'email',
    );
  });

  test('a missing key is refused, naming the key', () => {
    const fields = validRequest();
    delete fields['data_class'];
    refusedWith(() => buildRequestSpan(fields, TIMING), REFUSAL.missingField, 'data_class');
  });

  test('a non-object is refused', () => {
    refusedWith(() => buildRequestSpan('trace', TIMING), REFUSAL.notAnObject, '(root)');
    refusedWith(() => buildRequestSpan(null, TIMING), REFUSAL.notAnObject, '(root)');
    refusedWith(() => buildRequestSpan([], TIMING), REFUSAL.notAnObject, '(root)');
  });
});

describe('every field is a closed set or a bounded number — there is no free text', () => {
  test('a free-text value planted in each field of the request tuple is refused, one case per field', () => {
    const leak = 'Χριστοδούλου +35799123456 CY17002001280000001200527600';
    const expected: Readonly<Record<string, string>> = {
      trace_id: REFUSAL.traceId,
      route: REFUSAL.unregisteredRoute,
      module: REFUSAL.module,
      actor_role: REFUSAL.actorRole,
      status: REFUSAL.status,
      duration_ms: REFUSAL.duration,
      data_class: REFUSAL.dataClass,
    };
    // The field list drives the loop, so a field ADDED to the contract without a
    // rule here fails this test rather than slipping through unchecked.
    expect(Object.keys(expected).sort()).toEqual([...REQUEST_FIELDS].sort());
    for (const field of REQUEST_FIELDS) {
      refusedWith(
        () => buildRequestSpan({ ...validRequest(), [field]: leak }, TIMING),
        expected[field] as string,
        field,
      );
    }
  });

  test('a concrete URL is not a route template and is refused', () => {
    refusedWith(
      () =>
        buildRequestSpan(
          { ...validRequest(), route: 'POST /v1/auth/login?email=parent@example.cy' },
          TIMING,
        ),
      REFUSAL.unregisteredRoute,
      'route',
    );
    refusedWith(
      () =>
        buildRequestSpan(
          { ...validRequest(), route: 'GET /v1/accounts/01J0000000000000000000000A' },
          TIMING,
        ),
      REFUSAL.unregisteredRoute,
      'route',
    );
  });

  test('status outside 100-599, and a non-integer, are refused', () => {
    for (const status of [99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY, '200']) {
      refusedWith(
        () => buildRequestSpan({ ...validRequest(), status }, TIMING),
        REFUSAL.status,
        'status',
      );
    }
  });

  test('a negative or non-finite duration is refused', () => {
    for (const duration_ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, '12']) {
      refusedWith(
        () => buildRequestSpan({ ...validRequest(), duration_ms }, TIMING),
        REFUSAL.duration,
        'duration_ms',
      );
    }
  });

  test('a trace id that is not 32 lowercase hex is refused', () => {
    for (const trace_id of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '', 'zz']) {
      refusedWith(
        () => buildRequestSpan({ ...validRequest(), trace_id }, TIMING),
        REFUSAL.traceId,
        'trace_id',
      );
    }
  });

  test('every ACTOR_ROLE and every MODULE in the sets is a string with no whitespace', () => {
    for (const role of ACTOR_ROLES) expect(role).toMatch(/^[a-z_]+$/);
    for (const mod of MODULES) expect(mod).toMatch(/^[a-z_]+$/);
  });
});

describe('a caller cannot re-class a route from the request path', () => {
  test('a data_class disagreeing with the registry is refused', () => {
    refusedWith(
      () => buildRequestSpan({ ...validRequest(), data_class: 'C4' }, TIMING),
      REFUSAL.routeDataClassMismatch,
      'data_class',
    );
  });

  test('a module disagreeing with the registry is refused', () => {
    refusedWith(
      () => buildRequestSpan({ ...validRequest(), module: 'payment' }, TIMING),
      REFUSAL.routeModuleMismatch,
      'module',
    );
  });
});

describe('the job and provider tuples', () => {
  const job = (): Record<string, unknown> => ({
    queue: 'safety',
    job_id: '01J0000000000000000000000A',
    attempt: 1,
    duration_ms: 5,
    outcome: 'completed',
  });

  test('a valid job span carries exactly JOB_FIELDS', () => {
    const span = buildJobSpan(job(), TRACE, TIMING);
    expect(span.attributes.map((a) => a.key)).toEqual([...JOB_FIELDS]);
  });

  test('a job_id that is not a ULID is refused', () => {
    refusedWith(
      () => buildJobSpan({ ...job(), job_id: 'parent@example.cy' }, TRACE, TIMING),
      REFUSAL.jobId,
      'job_id',
    );
  });

  test('an undeclared queue and an undeclared outcome are refused', () => {
    refusedWith(
      () => buildJobSpan({ ...job(), queue: 'anything' }, TRACE, TIMING),
      REFUSAL.queue,
      'queue',
    );
    refusedWith(
      () => buildJobSpan({ ...job(), outcome: 'worked' }, TRACE, TIMING),
      REFUSAL.outcome,
      'outcome',
    );
  });

  test('operation is enumerated PER PROVIDER, so a real operation on the wrong provider is refused', () => {
    const base = {
      provider: 'hibp',
      operation: 'range.lookup',
      status: 200,
      duration_ms: 9,
      breaker_state: 'closed',
    };
    expect(buildProviderSpan(base, TRACE, TIMING).attributes.map((a) => a.key)).toEqual([
      ...PROVIDER_FIELDS,
    ]);
    refusedWith(
      () => buildProviderSpan({ ...base, provider: 'stripe' }, TRACE, TIMING),
      REFUSAL.operation,
      'operation',
    );
    refusedWith(
      () =>
        buildProviderSpan(
          { ...base, operation: 'GET https://api.pwnedpasswords.com/range/ABCDE' },
          TRACE,
          TIMING,
        ),
      REFUSAL.operation,
      'operation',
    );
  });

  test('an undeclared breaker state is refused', () => {
    refusedWith(
      () =>
        buildProviderSpan(
          {
            provider: 'hibp',
            operation: 'range.lookup',
            status: 200,
            duration_ms: 9,
            breaker_state: 'tripped',
          },
          TRACE,
          TIMING,
        ),
      REFUSAL.breakerState,
      'breaker_state',
    );
  });
});
