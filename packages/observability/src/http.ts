/**
 * The request observer. Framework-agnostic on purpose: this package has no
 * dependencies and knows nothing about Fastify or Nest. `apps/core` adapts it
 * in ~30 lines (`apps/core/src/observability/`).
 *
 * THE ONE THING TO GET RIGHT, AND IT IS THE WHOLE PII ARGUMENT:
 *
 *   `route` COMES FROM THE ROUTER'S REGISTERED TEMPLATE, NEVER FROM THE URL.
 *
 * Fastify's `request.routeOptions.url` is the string the route was registered
 * with (`/v1/auth/login`), not the string the client sent
 * (`/v1/auth/login?email=a@b.c`). When no route matched it is absent, and this
 * observer substitutes the reserved `(unmatched)` template and DISCARDS the
 * path. An unmatched path is the single most likely place for an e-mail
 * address, an id or a token to arrive, and there is no code path here that puts
 * one on a span.
 *
 * `traceparent` is honoured only when it parses as W3C trace-context with a
 * 32-lowercase-hex trace id; anything else gets a fresh id. A header is client
 * input, and client input reaches telemetry only through a total function onto
 * a closed set.
 */
import { UNCLASSIFIED, type ActorRole } from './contract.ts';
import { RESERVED_ROUTES, lookupRoute, routeKey } from './routes.ts';
import {
  requestSpanOrRefusal,
  newTraceId,
  timingFrom,
  type OtlpSpan,
  type Timing,
} from './span.ts';
import type { Exporter } from './otlp.ts';

/** Exactly what the observer needs from a request/response pair. */
export interface ObservedRequest {
  readonly method: string;
  /** The ROUTER'S TEMPLATE, e.g. `/v1/auth/login`. Absent when nothing matched. */
  readonly routeTemplate: string | undefined;
  readonly statusCode: number;
  readonly startMillis: number;
  readonly durationMs: number;
  /** `traceparent`, verbatim, or absent. */
  readonly traceparent?: string | undefined;
  /**
   * The authenticated principal's role. `apps/core` has no request-scoped
   * principal yet (T-135 § contract §6: `@UsePolicy` is not built), so it
   * passes nothing and this is `anonymous`. The ticket that adds the policy
   * decorator supplies it.
   */
  readonly actorRole?: ActorRole | undefined;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** W3C trace-context, or a fresh id. Never the header's raw bytes. */
export function traceIdFrom(traceparent: string | undefined): string {
  if (typeof traceparent === 'string') {
    const match = TRACEPARENT.exec(traceparent);
    if (match?.[1] !== undefined && match[1] !== '0'.repeat(32)) return match[1];
  }
  return newTraceId();
}

/**
 * Resolve the route attribute. Returns a REGISTERED template or a reserved one
 * — never anything derived from the URL the client sent.
 */
export function resolveRoute(method: string, routeTemplate: string | undefined): string {
  if (routeTemplate === undefined || routeTemplate === '' || routeTemplate === '*') {
    return RESERVED_ROUTES.unmatched;
  }
  const key = routeKey(method, routeTemplate);
  return lookupRoute(key) === undefined ? RESERVED_ROUTES.unregistered : key;
}

export interface RequestObserver {
  observe(request: ObservedRequest): OtlpSpan;
}

export function createRequestObserver(exporter: Exporter): RequestObserver {
  return {
    observe(request: ObservedRequest): OtlpSpan {
      const route = resolveRoute(request.method, request.routeTemplate);
      const entry = lookupRoute(route);
      const timing: Timing = timingFrom(request.startMillis, request.durationMs);
      const span = requestSpanOrRefusal(
        {
          trace_id: traceIdFrom(request.traceparent),
          route,
          module: entry?.module ?? 'meta',
          actor_role: request.actorRole ?? 'anonymous',
          status: request.statusCode,
          duration_ms: request.durationMs,
          data_class: entry?.data_class ?? UNCLASSIFIED,
        },
        timing,
      );
      exporter.record(span);
      return span;
    },
  };
}
