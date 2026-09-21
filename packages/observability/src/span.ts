/**
 * Building a span from the contract, and the ONE place a refusal is turned into
 * a span rather than into a thrown error.
 *
 * THE ATTRIBUTE SET IS DERIVED FROM `REQUEST_FIELDS`, NOT TYPED OUT AGAIN.
 * A span therefore cannot carry an attribute the contract does not name, and
 * `gate:otel-contract` R3 re-derives the same set from `contract.ts` and holds
 * it against the collector's allowlist, so the two boundaries cannot drift.
 *
 * THE SPAN NAME IS THE ROUTE TEMPLATE AND NOTHING ELSE. Jaeger's UI shows the
 * operation name most prominently, so a concrete URL there would be the most
 * visible leak available; there is no code path that puts one there.
 *
 * THE SPAN STATUS MESSAGE IS NEVER AN ERROR MESSAGE. OTLP's `status.message`
 * is free text and is the obvious place an exception string would arrive. This
 * package sets it from a fixed vocabulary of three values or leaves it empty.
 */
import { randomBytes } from 'node:crypto';
import {
  REQUEST_FIELDS,
  JOB_FIELDS,
  PROVIDER_FIELDS,
  UNCLASSIFIED,
  assertActorRole,
  assertAttempt,
  assertBreakerState,
  assertDataClass,
  assertDuration,
  assertExactKeys,
  assertJobId,
  assertModule,
  assertOperation,
  assertOutcome,
  assertProvider,
  assertQueue,
  assertStatus,
  assertTraceId,
  REFUSAL,
  InstrumentationRefused,
  type JobFields,
  type ProviderFields,
  type RequestFields,
} from './contract.ts';
import { RESERVED_ROUTES, lookupRoute } from './routes.ts';

/** OTLP/JSON `AnyValue`, restricted to the two shapes this package emits. */
export type OtlpValue = { readonly stringValue: string } | { readonly intValue: string };
export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpValue;
}

/** OTLP `Status.StatusCode`. 0 unset, 1 ok, 2 error. */
export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;

/** The only three values this package ever puts in OTLP's free-text `status.message`. */
export const STATUS_MESSAGES = Object.freeze({
  serverError: 'server_error',
  clientError: 'client_error',
  contractRefused: 'contract_refused',
});

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpAttribute[];
  readonly status: { readonly code: number; readonly message?: string };
}

/** SPAN_KIND_SERVER / SPAN_KIND_CLIENT / SPAN_KIND_CONSUMER. */
export const KIND_SERVER = 2;
export const KIND_CLIENT = 3;
export const KIND_CONSUMER = 5;

export const newTraceId = (): string => randomBytes(16).toString('hex');
export const newSpanId = (): string => randomBytes(8).toString('hex');

const attr = (key: string, value: string | number): OtlpAttribute =>
  typeof value === 'number' && Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: String(value) } };

/**
 * Project a validated record onto exactly `fields`, in `fields` order. The
 * ALLOWLIST IS THE FIELD LIST — this function cannot emit a key that is not in
 * it, whatever the record contains.
 */
const project = (
  record: Readonly<Record<string, string | number>>,
  fields: readonly string[],
): OtlpAttribute[] => fields.map((field) => attr(field, record[field] ?? ''));

/** Counters the exporter and the gate both read. Monotonic, process-local. */
export const counters = {
  requestSpans: 0,
  jobSpans: 0,
  providerSpans: 0,
  /** Spans emitted with `data_class: UNCLASSIFIED` because the route had no registry entry. */
  refusedSpans: 0,
  /** `emit*` calls that threw `InstrumentationRefused` and produced no span at all. */
  rejectedCalls: 0,
};

export const resetCounters = (): void => {
  counters.requestSpans = 0;
  counters.jobSpans = 0;
  counters.providerSpans = 0;
  counters.refusedSpans = 0;
  counters.rejectedCalls = 0;
};

export interface Timing {
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
}

/** `Date.now()` milliseconds to an OTLP nanosecond string, without float error. */
export const nanosFromEpochMillis = (ms: number): string => `${Math.trunc(ms)}000000`;

export const timingFrom = (startMillis: number, durationMs: number): Timing => ({
  startTimeUnixNano: nanosFromEpochMillis(startMillis),
  endTimeUnixNano: nanosFromEpochMillis(startMillis + durationMs),
});

const httpStatusToSpanStatus = (status: number): { code: number; message?: string } => {
  if (status >= 500) return { code: STATUS_ERROR, message: STATUS_MESSAGES.serverError };
  if (status >= 400) return { code: STATUS_ERROR, message: STATUS_MESSAGES.clientError };
  return { code: STATUS_OK };
};

/**
 * Validate SD §QD-5's request tuple and build its span.
 *
 * THROWS `InstrumentationRefused` on any violation. The caller
 * (`requestSpanOrRefusal`) is what turns a throw into a refusal span; a module
 * calling this directly gets the throw, which is what a unit test wants.
 */
export function buildRequestSpan(fields: unknown, timing: Timing, spanId?: string): OtlpSpan {
  const record = assertExactKeys(fields, REQUEST_FIELDS);
  const trace_id = assertTraceId(record['trace_id']);
  const route = typeof record['route'] === 'string' ? record['route'] : '';
  const entry = lookupRoute(route);
  if (entry === undefined) {
    throw new InstrumentationRefused(REFUSAL.unregisteredRoute, 'route');
  }
  const module = assertModule(record['module']);
  if (module !== entry.module) {
    throw new InstrumentationRefused(REFUSAL.routeModuleMismatch, 'module');
  }
  const actor_role = assertActorRole(record['actor_role']);
  const status = assertStatus(record['status'], 'status');
  const duration_ms = assertDuration(record['duration_ms'], 'duration_ms');
  const data_class = assertDataClass(record['data_class']);
  if (data_class !== entry.data_class) {
    throw new InstrumentationRefused(REFUSAL.routeDataClassMismatch, 'data_class');
  }
  const validated: RequestFields = {
    trace_id,
    route,
    module,
    actor_role,
    status,
    duration_ms,
    data_class,
  };
  counters.requestSpans += 1;
  return {
    traceId: trace_id,
    spanId: spanId ?? newSpanId(),
    name: route,
    kind: KIND_SERVER,
    ...timing,
    attributes: project(validated as unknown as Record<string, string | number>, REQUEST_FIELDS),
    status: httpStatusToSpanStatus(status),
  };
}

/**
 * THE REFUSAL PATH. A span that cannot satisfy the contract is still emitted —
 * because a silently absent span is indistinguishable from a healthy quiet
 * period — but it is emitted STAMPED, with the offending route replaced by the
 * reserved `(unregistered)` template and `data_class` set to the non-class
 * `UNCLASSIFIED`.
 *
 * Nothing from the rejected input reaches the span except `actor_role`,
 * `status` and `duration_ms` when those three themselves validate; otherwise
 * they fall back to `system` / 500 / 0. That is the property that matters:
 * A REFUSAL CANNOT BE A LEAK ROUTE.
 */
export function refuseRequestSpan(
  traceId: string,
  fields: Readonly<Record<string, unknown>>,
  timing: Timing,
  spanId?: string,
): OtlpSpan {
  counters.refusedSpans += 1;
  let actor_role = 'system';
  let status = 500;
  let duration_ms = 0;
  try {
    actor_role = assertActorRole(fields['actor_role']);
  } catch {
    /* keep the fallback */
  }
  try {
    status = assertStatus(fields['status'], 'status');
  } catch {
    /* keep the fallback */
  }
  try {
    duration_ms = assertDuration(fields['duration_ms'], 'duration_ms');
  } catch {
    /* keep the fallback */
  }
  const record: Record<string, string | number> = {
    trace_id: /^[0-9a-f]{32}$/.test(traceId) ? traceId : '0'.repeat(32),
    route: RESERVED_ROUTES.unregistered,
    module: 'meta',
    actor_role,
    status,
    duration_ms,
    data_class: UNCLASSIFIED,
  };
  return {
    traceId: String(record['trace_id']),
    spanId: spanId ?? newSpanId(),
    name: RESERVED_ROUTES.unregistered,
    kind: KIND_SERVER,
    ...timing,
    attributes: project(record, REQUEST_FIELDS),
    status: { code: STATUS_ERROR, message: STATUS_MESSAGES.contractRefused },
  };
}

/**
 * What `apps/core`'s hook calls. Never throws: observability may not be able to
 * fail a request. Every failure becomes a stamped refusal span instead.
 */
export function requestSpanOrRefusal(
  fields: Readonly<Record<string, unknown>>,
  timing: Timing,
  spanId?: string,
): OtlpSpan {
  try {
    return buildRequestSpan(fields, timing, spanId);
  } catch (thrown) {
    if (!(thrown instanceof InstrumentationRefused)) counters.rejectedCalls += 1;
    const traceId = typeof fields['trace_id'] === 'string' ? fields['trace_id'] : '';
    return refuseRequestSpan(traceId, fields, timing, spanId);
  }
}

export function buildJobSpan(fields: unknown, traceId: string, timing: Timing): OtlpSpan {
  const record = assertExactKeys(fields, JOB_FIELDS);
  const validated: JobFields = {
    queue: assertQueue(record['queue']),
    job_id: assertJobId(record['job_id']),
    attempt: assertAttempt(record['attempt']),
    duration_ms: assertDuration(record['duration_ms'], 'duration_ms'),
    outcome: assertOutcome(record['outcome']),
  };
  counters.jobSpans += 1;
  return {
    traceId: assertTraceId(traceId),
    spanId: newSpanId(),
    name: `${validated.queue}.job`,
    kind: KIND_CONSUMER,
    ...timing,
    attributes: project(validated as unknown as Record<string, string | number>, JOB_FIELDS),
    status: {
      code: validated.outcome === 'completed' ? STATUS_OK : STATUS_ERROR,
      ...(validated.outcome === 'completed' ? {} : { message: STATUS_MESSAGES.serverError }),
    },
  };
}

export function buildProviderSpan(fields: unknown, traceId: string, timing: Timing): OtlpSpan {
  const record = assertExactKeys(fields, PROVIDER_FIELDS);
  const provider = assertProvider(record['provider']);
  const validated: ProviderFields = {
    provider,
    operation: assertOperation(provider, record['operation']),
    status: assertStatus(record['status'], 'status'),
    duration_ms: assertDuration(record['duration_ms'], 'duration_ms'),
    breaker_state: assertBreakerState(record['breaker_state']),
  };
  counters.providerSpans += 1;
  return {
    traceId: assertTraceId(traceId),
    spanId: newSpanId(),
    name: `${validated.provider}.${validated.operation}`,
    kind: KIND_CLIENT,
    ...timing,
    attributes: project(validated as unknown as Record<string, string | number>, PROVIDER_FIELDS),
    status: httpStatusToSpanStatus(validated.status),
  };
}
