/**
 * THE EXPORTER — OTLP over HTTP with the JSON encoding, written against
 * `fetch`, with NO npm dependency.
 *
 * WHY NOT `@opentelemetry/sdk-node` AND THE AUTO-INSTRUMENTATIONS. Two reasons,
 * and the first is the load-bearing one:
 *
 *   1. AUTO-INSTRUMENTATION IS INCOMPATIBLE WITH THIS CONTRACT. It puts full
 *      request URLs (`http.url`, `url.full`, `url.query`), database statements
 *      and header values on spans by default. SD §QD-5's contract is SEVEN
 *      FIELDS and SA §TS-10 rule 1 is an allowlist; a firehose that must then
 *      be filtered is the denylist shape that rule exists to refuse. What is
 *      emitted here is what the contract names, and nothing has to be removed
 *      afterwards.
 *   2. Supply chain. `@opentelemetry/auto-instrumentations-node` is ~40
 *      transitive packages into every runtime image. `pnpm-workspace.yaml` is
 *      under `gate:supply-chain` and OD-51; this package adds zero runtime
 *      dependencies and changes neither that file nor any pin.
 *
 * WHAT THAT COSTS, stated rather than hidden: no context propagation across an
 * outbound call, no automatic parent/child linking, no DB or HTTP client spans.
 * Every span in this system is emitted by an explicit call. See
 * state/EP-1/T-008.md § Published contract § What is not claimed.
 *
 * THE EXPORTER SURFACES ITS OWN FAILURES. `T-142` § contract (rework 1) §8
 * places that obligation on "whoever wires `otel`" because a throw from an
 * `onStateChange` hook is discarded silently, so a provider-health gauge that
 * failed quietly would be indistinguishable from a healthy provider. Every
 * failure here increments `exportFailures` and calls `onFailure` with a CLASS,
 * never a message: `errorClass`-style vocabulary only, because an exception
 * message is free text and free text is what this package does not put in
 * telemetry.
 */
import type { OtlpSpan } from './span.ts';

export const SCOPE_NAME = '@kinvara/observability';
export const SCOPE_VERSION = '0.0.0';

/** The failure vocabulary. Closed, like everything else that reaches an operator. */
export const EXPORT_FAILURE = Object.freeze({
  network: 'export_network',
  status: 'export_status',
  serialise: 'export_serialise',
  disabled: 'export_disabled',
});

export type ExportFailure = (typeof EXPORT_FAILURE)[keyof typeof EXPORT_FAILURE];

export interface ExporterOptions {
  /** `OTEL_EXPORTER_OTLP_ENDPOINT`, e.g. `http://otel-collector:4318`. */
  readonly endpoint: string;
  /** `OTEL_SERVICE_NAME`, e.g. `kinvara-core`. */
  readonly serviceName: string;
  readonly fetchImpl?: typeof fetch;
  readonly onFailure?: (failure: ExportFailure, detail: string) => void;
  /** Flush when this many spans are buffered. */
  readonly maxBatch?: number;
  /** Flush this many milliseconds after the first buffered span. */
  readonly flushAfterMs?: number;
}

export interface ExportResult {
  readonly ok: boolean;
  readonly spans: number;
  readonly failure?: ExportFailure;
}

export const exporterCounters = {
  exported: 0,
  exportAttempts: 0,
  exportFailures: 0,
  dropped: 0,
};

export const resetExporterCounters = (): void => {
  exporterCounters.exported = 0;
  exporterCounters.exportAttempts = 0;
  exporterCounters.exportFailures = 0;
  exporterCounters.dropped = 0;
};

/** The OTLP/JSON envelope. One resource, one scope, N spans. */
export function tracePayload(spans: readonly OtlpSpan[], serviceName: string): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans,
          },
        ],
      },
    ],
  };
}

export interface Exporter {
  /** Buffer a span. Never throws, never returns a promise the caller must await. */
  record(span: OtlpSpan): void;
  /** Send everything buffered. Resolves with the result of the one request it made. */
  flush(): Promise<ExportResult>;
  shutdown(): Promise<ExportResult>;
  pending(): number;
}

const defaultOnFailure = (failure: ExportFailure, detail: string): void => {
  // A fixed marker and a fixed vocabulary. `detail` is produced by this file and
  // is never derived from a response body or an exception message.
  process.stderr.write(`[otel] ${failure} ${detail}\n`);
};

export function createExporter(options: ExporterOptions): Exporter {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const onFailure = options.onFailure ?? defaultOnFailure;
  const maxBatch = options.maxBatch ?? 64;
  const flushAfterMs = options.flushAfterMs ?? 200;
  const url = `${options.endpoint.replace(/\/+$/, '')}/v1/traces`;

  let buffer: OtlpSpan[] = [];
  let timer: NodeJS.Timeout | undefined;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const send = async (spans: readonly OtlpSpan[]): Promise<ExportResult> => {
    if (spans.length === 0) return { ok: true, spans: 0 };
    exporterCounters.exportAttempts += 1;
    let body: string;
    try {
      body = JSON.stringify(tracePayload(spans, options.serviceName));
    } catch {
      exporterCounters.exportFailures += 1;
      exporterCounters.dropped += spans.length;
      onFailure(EXPORT_FAILURE.serialise, `${String(spans.length)} span(s)`);
      return { ok: false, spans: spans.length, failure: EXPORT_FAILURE.serialise };
    }
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!response.ok) {
        exporterCounters.exportFailures += 1;
        exporterCounters.dropped += spans.length;
        onFailure(EXPORT_FAILURE.status, `http ${String(response.status)}`);
        return { ok: false, spans: spans.length, failure: EXPORT_FAILURE.status };
      }
      exporterCounters.exported += spans.length;
      return { ok: true, spans: spans.length };
    } catch {
      exporterCounters.exportFailures += 1;
      exporterCounters.dropped += spans.length;
      onFailure(EXPORT_FAILURE.network, `${String(spans.length)} span(s)`);
      return { ok: false, spans: spans.length, failure: EXPORT_FAILURE.network };
    }
  };

  const flush = async (): Promise<ExportResult> => {
    clear();
    const batch = buffer;
    buffer = [];
    return send(batch);
  };

  return {
    record(span: OtlpSpan): void {
      buffer.push(span);
      if (buffer.length >= maxBatch) {
        void flush();
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          void flush();
        }, flushAfterMs);
        timer.unref?.();
      }
    },
    flush,
    shutdown: flush,
    pending: () => buffer.length,
  };
}
