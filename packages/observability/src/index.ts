/**
 * `@kinvara/observability` — SD §QD-5's instrumentation contract, the OTLP/JSON
 * exporter, the route -> data_class registry, the Sentry `beforeSend` scrubber
 * and SD §INT's `provider_health` gauge. T-008.
 *
 * NO RUNTIME DEPENDENCIES. See `src/otlp.ts` for why the OpenTelemetry SDK and
 * its auto-instrumentations are deliberately not used, and what that costs.
 *
 * Read state/EP-1/T-008.md § Published contract before coding against this —
 * in particular §5, which states exactly what this ticket's no-PII mechanism
 * covers and what it does not, and names `T-119` as the ticket that widens it.
 */
export {
  ACTOR_ROLES,
  BREAKER_STATES,
  DATA_CLASSES,
  JOB_FIELDS,
  JOB_OUTCOMES,
  MODULES,
  PROVIDERS,
  PROVIDER_FIELDS,
  PROVIDER_OPERATIONS,
  QUEUES,
  REFUSAL,
  REQUEST_FIELDS,
  UNCLASSIFIED,
  InstrumentationRefused,
  type ActorRole,
  type BreakerState,
  type DataClass,
  type JobFields,
  type JobOutcome,
  type KinvaraModule,
  type Provider,
  type ProviderFields,
  type Queue,
  type RequestFields,
} from './contract.ts';

export {
  RESERVED_ROUTES,
  ROUTE_REGISTRY,
  RegistryMalformed,
  assertRegistry,
  lookupRoute,
  routeKey,
  type RouteEntry,
} from './routes.ts';

export {
  KIND_CLIENT,
  KIND_CONSUMER,
  KIND_SERVER,
  STATUS_ERROR,
  STATUS_MESSAGES,
  STATUS_OK,
  STATUS_UNSET,
  buildJobSpan,
  buildProviderSpan,
  buildRequestSpan,
  counters,
  nanosFromEpochMillis,
  newSpanId,
  newTraceId,
  refuseRequestSpan,
  requestSpanOrRefusal,
  resetCounters,
  timingFrom,
  type OtlpAttribute,
  type OtlpSpan,
  type Timing,
} from './span.ts';

export {
  EXPORT_FAILURE,
  SCOPE_NAME,
  SCOPE_VERSION,
  createExporter,
  EXPORTER_BOUNDS,
  exporterCounters,
  resetExporterCounters,
  tracePayload,
  type ExportFailure,
  type ExportResult,
  type Exporter,
  type ExporterOptions,
} from './otlp.ts';

export { resolveOffLane, type ResolveHost, type ResolvedAddress } from './offlane.ts';

export {
  createRequestObserver,
  resolveRoute,
  traceIdFrom,
  type ObservedRequest,
  type RequestObserver,
} from './http.ts';

export {
  BODY_EXCLUDED_ROUTE_PREFIXES,
  SENTRY_ALLOWED_KEYS,
  SENTRY_ALLOWED_TAGS,
  SentryNotAvailable,
  initSentry,
  scrubEvent,
  sentryConfig,
  type SentryConfig,
  type SentryEventLike,
} from './sentry.ts';

export {
  providerHealth,
  providerHealthPayload,
  registerProviderHealth,
  resetProviderHealth,
  snapshotProviderHealth,
  type BreakerStateSource,
  type ProviderHealthReading,
} from './provider-health.ts';
