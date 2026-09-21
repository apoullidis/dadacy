/**
 * The `apps/core` adapter for `@kinvara/observability` — T-008.
 *
 * DELIBERATELY THIN. Everything that decides what reaches a span lives in
 * `packages/observability`; this file knows only how to ask Fastify for the
 * ROUTER'S REGISTERED TEMPLATE and how to time a response.
 *
 * `request.routeOptions.url` IS THE TEMPLATE, NOT THE URL. Fastify sets it to
 * the string the route was registered with (`/v1/auth/login`), and leaves it
 * undefined when nothing matched. `request.url` — the string the client sent,
 * query string and all — is never read here, by anything, at all.
 *
 * WHAT THAT SINGLE FACT BUYS, AT ITS TRUE WIDTH: it makes "THE CLIENT'S URL
 * NEVER BECOMES THE ROUTE ATTRIBUTE" a property of the code rather than a hope
 * about callers. It is NOT the same sentence as "no PII on a span", and an
 * earlier revision of this comment said that wider one. `gate:otel-contract`
 * R5 is what holds this file to the narrow claim (it fails on `request.url`,
 * `req.url` or `request.originalUrl` in comment-stripped source), and
 * state/EP-1/T-008.md § Evidence 5 measured how far the narrow claim carries:
 * FOUR independent edits, across three files and two packages, are needed
 * before a planted value reaches Jaeger — and the first of the four is caught
 * here, by the route registry, with the path discarded.
 *
 * The no-PII claim itself, at the width this build can evidence, is
 * state/EP-1/T-008.md § Published contract §5. `T-119` widens it.
 *
 * NEVER FAILS A REQUEST. The hook is wrapped: any throw increments a counter
 * and is swallowed. Telemetry that can 500 a request is worse than no
 * telemetry, and `core` serves a safety product.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createExporter, createRequestObserver, type Exporter } from '@kinvara/observability';

export const observabilityCounters = { hookFailures: 0 };

/** Set when the `otel` profile is not running; every exporter call is a no-op. */
const disabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  (env['OTEL_SDK_DISABLED'] ?? '').toLowerCase() === 'true';

const NOOP_EXPORTER: Exporter = {
  record: () => undefined,
  flush: () => Promise.resolve({ ok: true, spans: 0 }),
  shutdown: () => Promise.resolve({ ok: true, spans: 0 }),
  pending: () => 0,
};

export function buildExporter(env: Readonly<Record<string, string | undefined>>): Exporter {
  if (disabled(env)) return NOOP_EXPORTER;
  return createExporter({
    endpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://otel-collector:4318',
    serviceName: env['OTEL_SERVICE_NAME'] ?? 'kinvara-core',
  });
}

interface TimedRequest {
  kinvaraStartMillis?: number;
}

/**
 * Must be called BEFORE `listen`: it adds two Fastify hooks. `installDrain`
 * has the same requirement for the same reason.
 */
export function installObservability(
  app: NestFastifyApplication,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Exporter {
  const exporter = buildExporter(env);
  const observer = createRequestObserver(exporter);
  const instance = app.getHttpAdapter().getInstance();

  instance.addHook('onRequest', async (request) => {
    (request as unknown as TimedRequest).kinvaraStartMillis = Date.now();
  });

  instance.addHook('onResponse', async (request, reply) => {
    try {
      const started = (request as unknown as TimedRequest).kinvaraStartMillis ?? Date.now();
      const routeOptions: unknown = (request as unknown as { routeOptions?: unknown }).routeOptions;
      const template =
        typeof routeOptions === 'object' &&
        routeOptions !== null &&
        'url' in routeOptions &&
        typeof (routeOptions as { url?: unknown }).url === 'string'
          ? (routeOptions as { url: string }).url
          : undefined;
      const traceparent: unknown = request.headers['traceparent'];
      observer.observe({
        method: request.method,
        routeTemplate: template,
        statusCode: reply.statusCode,
        startMillis: started,
        durationMs: Math.max(0, Date.now() - started),
        ...(typeof traceparent === 'string' ? { traceparent } : {}),
      });
    } catch {
      observabilityCounters.hookFailures += 1;
    }
  });

  return exporter;
}
