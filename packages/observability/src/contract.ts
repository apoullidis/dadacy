/**
 * THE INSTRUMENTATION CONTRACT — SD §QD-5, verbatim:
 *
 *   every request  emits {trace_id, route, module, actor_role, status, duration_ms, data_class}
 *   every job      emits {queue, job_id, attempt, duration_ms, outcome}
 *   every provider emits {provider, operation, status, duration_ms, breaker_state}
 *   No PII (SEC-I5).
 *
 * THE DESIGN DECISION THAT MAKES "No PII" CHECKABLE RATHER THAN ASPIRATIONAL,
 * and it is the whole point of this file:
 *
 *   EVERY FIELD OF ALL THREE CONTRACTS IS DRAWN FROM A CLOSED SET OR A BOUNDED
 *   NUMERIC RANGE. There is no free-text field anywhere in them, so there is
 *   nothing for PII to ride on.
 *
 * `route` is a ROUTE TEMPLATE and is checked against the registry in
 * `routes.ts` — never a concrete URL, because a concrete URL is exactly where a
 * path parameter, a query string or an e-mail address would arrive. `module`,
 * `actor_role`, `data_class`, `outcome`, `provider` and `breaker_state` are
 * enumerations. `status` is an integer 100-599. `duration_ms` is a finite
 * non-negative number. `trace_id` and `span_id` are fixed-length lowercase hex.
 * `queue` is an enumeration; `job_id` is a ULID; `attempt` is a small integer.
 * `operation` is a per-provider enumeration.
 *
 * SA §TS-10 rule 1 is "allowlist, never denylist — denylists fail on the field
 * nobody thought of". `validateRequestFields` is that allowlist applied to the
 * KEY SET (an unexpected key is refused, not dropped silently) and the value
 * rules above are the same allowlist applied to the VALUES.
 *
 * WHAT THIS FILE IS NOT. It is not a PII detector and it does not look at
 * request bodies, log lines or error messages. The Cyprus format patterns and
 * the cross-script name canary of SD §SEC-I5 are `T-119`'s (`gate:pii-canary`),
 * which is `blocked_by T-008` and so could not be used here. See
 * state/EP-1/T-008.md § Published contract §5 for what this ticket's own
 * mechanism covers and what it does not.
 */

/** SD §QD-5's request tuple, in SD's order. Nothing may be added to it here. */
export const REQUEST_FIELDS = [
  'trace_id',
  'route',
  'module',
  'actor_role',
  'status',
  'duration_ms',
  'data_class',
] as const;

/** SD §QD-5's job tuple, in SD's order. */
export const JOB_FIELDS = ['queue', 'job_id', 'attempt', 'duration_ms', 'outcome'] as const;

/** SD §QD-5's provider-call tuple, in SD's order. */
export const PROVIDER_FIELDS = [
  'provider',
  'operation',
  'status',
  'duration_ms',
  'breaker_state',
] as const;

/**
 * SA §SEC-3's four PII classes, and nothing else. SD §DB line 2841 constrains
 * `audit_log.data_class` to exactly this set, so a span attribute using a fifth
 * value would not be joinable to an audit row.
 *
 *   C1  special category / criminal offence  — never in logs, traces or errors
 *   C2  sensitive personal
 *   C3  personal
 *   C4  non-personal
 *
 * The class is a property of the ROUTE, not of the payload: it is the highest
 * class of data the route handles. It says what an operator reading this span
 * must NOT go looking for in the request that produced it.
 */
export const DATA_CLASSES = ['C1', 'C2', 'C3', 'C4'] as const;

/**
 * NOT a data class. It is the refusal marker this package substitutes when a
 * route has no registry entry, so that an unclassified span is visibly
 * unclassified instead of quietly looking like C4. `assertDataClass` refuses it
 * as an input; only `refuseRequestSpan` may produce it.
 */
export const UNCLASSIFIED = 'UNCLASSIFIED' as const;

/**
 * SA §SA-2's module table, plus `meta`.
 *
 * `meta` IS NOT IN SA §SA-2 and is named here rather than smuggled in: it is
 * the API-surface namespace `T-135` created for `/v1/meta/*`, which belongs to
 * no domain module. If SA §SA-2 is ever revised, this list is the copy to
 * re-check.
 */
export const MODULES = [
  'identity',
  'credential',
  'profile',
  'availability',
  'discovery',
  'booking',
  'payment',
  'session',
  'messaging',
  'review',
  'trust',
  'notify',
  'audit',
  'governance',
  'schedule',
  'locale',
  'lexicon',
  'meta',
] as const;

/**
 * `packages/contracts`' ACCOUNT_ROLES (SD §DB-2's `account_role.role` CHECK
 * set), plus the two non-account principals a request can have.
 *
 * It is DUPLICATED rather than imported on purpose: `@kinvara/contracts`'
 * package root reaches `@kinvara/i18n` (T-147 § contract §3), and an
 * observability package that drags the message catalogue into every app that
 * emits a span is a module-boundary defect. `gate:otel-contract` check R6 holds
 * this list against `packages/contracts/src/endpoints.ts`'s ACCOUNT_ROLES by
 * reading that file, so the copy cannot drift silently.
 */
export const ACTOR_ROLES = [
  'parent',
  'sitter',
  'support',
  'ts_operator',
  'ts_senior',
  'dsl',
  'deputy_dsl',
  'finance',
  'compliance',
  'engineer',
  'anonymous',
  'system',
] as const;

/** SD §BE-14's queues, as used by the job contract. */
export const QUEUES = [
  'safety',
  'notify',
  'payment',
  'credential',
  'retention',
  'analytics',
] as const;

/** A job's terminal outcome. */
export const JOB_OUTCOMES = ['completed', 'failed', 'dead_lettered', 'cancelled'] as const;

/** The vendors this product calls. DOCKER.md §7's fake set, by the name the fake stands in for. */
export const PROVIDERS = ['stripe', 'telephony', 'email', 'hibp', 'aws_kms', 'aws_s3'] as const;

/**
 * `@kinvara/integration-kit`'s circuit-breaker states (T-142 § contract §2),
 * plus `unknown` for a call made without a breaker.
 */
export const BREAKER_STATES = ['closed', 'open', 'half_open', 'unknown'] as const;

export type DataClass = (typeof DATA_CLASSES)[number];
export type KinvaraModule = (typeof MODULES)[number];
export type ActorRole = (typeof ACTOR_ROLES)[number];
export type Queue = (typeof QUEUES)[number];
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export type Provider = (typeof PROVIDERS)[number];
export type BreakerState = (typeof BREAKER_STATES)[number];

export interface RequestFields {
  readonly trace_id: string;
  readonly route: string;
  readonly module: KinvaraModule;
  readonly actor_role: ActorRole;
  readonly status: number;
  readonly duration_ms: number;
  readonly data_class: DataClass;
}

export interface JobFields {
  readonly queue: Queue;
  readonly job_id: string;
  readonly attempt: number;
  readonly duration_ms: number;
  readonly outcome: JobOutcome;
}

export interface ProviderFields {
  readonly provider: Provider;
  readonly operation: string;
  readonly status: number;
  readonly duration_ms: number;
  readonly breaker_state: BreakerState;
}

/** Every refusal this package can produce, as a closed vocabulary. */
export const REFUSAL = Object.freeze({
  notAnObject: 'observability: fields must be a plain object',
  unknownField: 'observability: unknown field',
  missingField: 'observability: missing field',
  traceId: 'observability: trace_id must be 32 lowercase hex characters',
  spanId: 'observability: span_id must be 16 lowercase hex characters',
  unregisteredRoute: 'observability: route is not a registered route template',
  module: 'observability: module is not in SA §SA-2 module set',
  actorRole: 'observability: actor_role is not an account role',
  status: 'observability: status must be an integer 100-599',
  duration: 'observability: duration_ms must be a finite number >= 0',
  dataClass: 'observability: data_class must be one of C1, C2, C3, C4',
  queue: 'observability: queue is not a declared queue',
  jobId: 'observability: job_id must be a 26-character Crockford ULID',
  attempt: 'observability: attempt must be an integer 1-1000',
  outcome: 'observability: outcome is not a declared job outcome',
  provider: 'observability: provider is not a declared provider',
  operation: 'observability: operation is not declared for this provider',
  breakerState: 'observability: breaker_state is not a breaker state',
  routeModuleMismatch: 'observability: module does not match the route registry entry',
  routeDataClassMismatch: 'observability: data_class does not match the route registry entry',
});

export class InstrumentationRefused extends Error {
  readonly field: string;
  constructor(reason: string, field: string) {
    super(`${reason} (field: ${field})`);
    this.name = 'InstrumentationRefused';
    this.field = field;
  }
}

const refuse = (reason: string, field: string): never => {
  throw new InstrumentationRefused(reason, field);
};

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
/** Crockford base32 without I, L, O, U — SD's `char(26)` ULID. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The KEY-SET allowlist. Extra keys are REFUSED rather than dropped, because a
 * dropped key is a silent partial success and this package's whole argument is
 * that a refusal is visible. Missing keys are refused for the same reason — a
 * span missing `data_class` is the exact case the contract exists to make
 * impossible.
 */
export function assertExactKeys(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) return refuse(REFUSAL.notAnObject, '(root)');
  const allowed = new Set<string>(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(REFUSAL.unknownField, key);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) refuse(REFUSAL.missingField, field);
  }
  return value;
}

export function assertTraceId(value: unknown): string {
  if (typeof value !== 'string' || !TRACE_ID.test(value)) refuse(REFUSAL.traceId, 'trace_id');
  return value as string;
}

export function assertSpanId(value: unknown): string {
  if (typeof value !== 'string' || !SPAN_ID.test(value)) refuse(REFUSAL.spanId, 'span_id');
  return value as string;
}

export function assertStatus(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    refuse(REFUSAL.status, field);
  }
  return value as number;
}

export function assertDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    refuse(REFUSAL.duration, field);
  }
  return value as number;
}

const member = <T extends string>(
  set: readonly T[],
  value: unknown,
  reason: string,
  field: string,
): T => {
  if (typeof value !== 'string' || !(set as readonly string[]).includes(value)) {
    refuse(reason, field);
  }
  return value as T;
};

export const assertModule = (value: unknown): KinvaraModule =>
  member(MODULES, value, REFUSAL.module, 'module');
export const assertActorRole = (value: unknown): ActorRole =>
  member(ACTOR_ROLES, value, REFUSAL.actorRole, 'actor_role');
export const assertDataClass = (value: unknown): DataClass =>
  member(DATA_CLASSES, value, REFUSAL.dataClass, 'data_class');
export const assertQueue = (value: unknown): Queue => member(QUEUES, value, REFUSAL.queue, 'queue');
export const assertOutcome = (value: unknown): JobOutcome =>
  member(JOB_OUTCOMES, value, REFUSAL.outcome, 'outcome');
export const assertProvider = (value: unknown): Provider =>
  member(PROVIDERS, value, REFUSAL.provider, 'provider');
export const assertBreakerState = (value: unknown): BreakerState =>
  member(BREAKER_STATES, value, REFUSAL.breakerState, 'breaker_state');

export function assertJobId(value: unknown): string {
  if (typeof value !== 'string' || !ULID.test(value)) refuse(REFUSAL.jobId, 'job_id');
  return value as string;
}

export function assertAttempt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) {
    refuse(REFUSAL.attempt, 'attempt');
  }
  return value as number;
}

/**
 * The per-provider operation allowlist. `operation` is the one field of the
 * three contracts that would naturally be free text, and free text is what this
 * design does not have — so it is enumerated per provider. A provider whose
 * operation set is not yet known declares an empty array, and every call
 * through it is refused until the set is written down.
 */
export const PROVIDER_OPERATIONS: Readonly<Record<Provider, readonly string[]>> = Object.freeze({
  stripe: ['payment_intent.create', 'payment_intent.capture', 'refund.create', 'transfer.create'],
  telephony: ['message.send', 'call.create'],
  email: ['message.send'],
  hibp: ['range.lookup'],
  aws_kms: ['generate_data_key', 'decrypt'],
  aws_s3: ['put_object', 'get_object', 'delete_object'],
});

export function assertOperation(provider: Provider, value: unknown): string {
  const allowed = PROVIDER_OPERATIONS[provider];
  if (typeof value !== 'string' || !allowed.includes(value)) refuse(REFUSAL.operation, 'operation');
  return value as string;
}
