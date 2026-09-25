/**
 * THE EXPORTER — OTLP over HTTP with the JSON encoding, with NO npm
 * dependency. Its default transport is `node:http`/`node:https` with an
 * off-lane name lookup (`offlane.ts`, T-205); a `fetch` can be passed in for
 * tests.
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
 *
 * TELEMETRY MAY NOT STARVE THE REQUEST PATH (T-204, OD-227; T-205, OD-230).
 * Measured in state/EP-1/T-204.md § Finding: the exporter used to start one
 * `fetch` per flush with no bound on how many were in flight. With the
 * collector absent, each `fetch`'s `getaddrinfo` blocks ~5 s on compose's
 * resolver, and libuv runs at most ceil(n/2) of its n pool threads as slow I/O
 * (2 of the default 4; OD-229). So collector lookups filled that DNS lane, and
 * every other lookup in the process queued behind them: `hibp-fake` (the
 * breached-password check, which then FAILED OPEN with `hibp-fake` up) and
 * `postgres`. Queue waits of 590 s were measured. Four bounds now apply, each
 * with cases in `otlp.test.ts` under `describe('T-204: the exporter's four
 * bounds')`:
 *
 *   1. AT MOST ONE EXPORT IN FLIGHT. A flush while one is in flight does not
 *      start a second request.
 *   2. A DEADLINE PER EXPORT (`exportTimeoutMs`, default 5000). The request's
 *      signal is aborted, and the export is reported as `export_network`. This
 *      bounds a collector that resolves but never answers.
 *   3. A COOL-DOWN AFTER EVERY FAILED EXPORT (`backoffMs`, default 5000,
 *      doubling to `maxBackoffMs`, default 60000). No export starts during it,
 *      however many spans are buffered, and after a success the next failure
 *      cools down `backoffMs` again. Cases: the four `bound 3` cases, which all
 *      fail with `export_network`; `bound 3 for export_status` (QA's QA-c,
 *      committed in T-205) and `bound 3 for export_serialise` (T-205) for the
 *      other two classes. `flush()` is the one path that ignores the cool-down
 *      (see `Exporter.flush`).
 *   4. A BOUNDED BUFFER (`maxQueue`, default 2048). A span recorded when the
 *      buffer is full is dropped and counted in `exporterCounters.dropped`. It
 *      is not queued. Memory cannot grow with the length of an outage.
 *
 * THE BOUNDS WERE NOT ENOUGH ON THEIR OWN (T-205, OD-230). Node cannot cancel a
 * `getaddrinfo`, so each abandoned export left its lookup holding a lane until
 * the resolver gave up. On compose's resolver (~5 s) the leftovers did not
 * overlap. With a resolver that stalls a failing lookup 30 s or 60 s they did,
 * and a breached password was accepted (state/EP-1/T-205.md E2, E3). So the
 * default transport now resolves the collector with c-ares, off the thread
 * pool, and cancels that query at the deadline: see `offlane.ts` for the
 * mechanism and its costs. The runs that show it are in state/EP-1/T-205.md;
 * the cases are under `describe('T-205: the collector is resolved off the DNS
 * lane')`. A `fetchImpl` passed in (tests only) still resolves through
 * `getaddrinfo`.
 *
 * The cost: during a collector outage spans are DROPPED, and counted. That is
 * the intended trade. A missing trace is an observability defect; a
 * breached-password check switched off is a safety defect.
 */
import { offLaneTransport, resolveOffLane, type ResolveHost, type Transport } from './offlane.ts';
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
  /**
   * TESTS ONLY. When given, this `fetch` is the transport, and it resolves the
   * collector's name however it does: the real `fetch` uses `getaddrinfo`, on
   * libuv's DNS lane, which is what T-205 moved the exporter off. Production
   * passes none (`apps/core/src/observability/install.ts`), and so gets the
   * off-lane transport of `offlane.ts`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * T-205: how the default transport resolves the collector's host name.
   * Default `resolveOffLane` (c-ares, not the thread pool). Ignored when
   * `fetchImpl` is given.
   */
  readonly resolveHost?: ResolveHost;
  readonly onFailure?: (failure: ExportFailure, detail: string) => void;
  /** Flush when this many spans are buffered. */
  readonly maxBatch?: number;
  /** Flush this many milliseconds after the first buffered span. */
  readonly flushAfterMs?: number;
  /** T-204 bound 2: abort an export after this many milliseconds. Default 5000. */
  readonly exportTimeoutMs?: number;
  /** T-204 bound 3: the first cool-down after a failed export. Default 5000. Doubles per consecutive failure. */
  readonly backoffMs?: number;
  /** T-204 bound 3: the cool-down never exceeds this. Default 60000. */
  readonly maxBackoffMs?: number;
  /** T-204 bound 4: spans buffered beyond this are dropped and counted. Default 2048. */
  readonly maxQueue?: number;
}

/** T-204's defaults, pinned by `otlp.test.ts`. */
export const EXPORTER_BOUNDS = Object.freeze({
  exportTimeoutMs: 5000,
  backoffMs: 5000,
  maxBackoffMs: 60000,
  maxQueue: 2048,
});

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
  /**
   * Wait for any export in flight, then send everything buffered. It does NOT
   * wait for a cool-down (bound 3): case `flush() during a cool-down starts an
   * export anyway` (QA's QA-d). So never call it on a timer: that would start
   * an export every period whatever the collector's state. Call it at shutdown.
   * Resolves with the result of the one request it made. Still never more than
   * one request in flight (T-204 bound 1).
   */
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
  const fetchImpl = options.fetchImpl;
  const onFailure = options.onFailure ?? defaultOnFailure;
  const maxBatch = options.maxBatch ?? 64;
  const flushAfterMs = options.flushAfterMs ?? 200;
  const exportTimeoutMs = options.exportTimeoutMs ?? EXPORTER_BOUNDS.exportTimeoutMs;
  const backoffMs = options.backoffMs ?? EXPORTER_BOUNDS.backoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? EXPORTER_BOUNDS.maxBackoffMs;
  const maxQueue = options.maxQueue ?? EXPORTER_BOUNDS.maxQueue;
  const url = `${options.endpoint.replace(/\/+$/, '')}/v1/traces`;
  /** T-205: the default transport resolves the collector off libuv's DNS lane. */
  const post: Transport =
    fetchImpl === undefined
      ? offLaneTransport(options.resolveHost ?? resolveOffLane, exportTimeoutMs)
      : async (target, body, signal) => {
          const response = await fetchImpl(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal,
          });
          return response.status;
        };

  let buffer: OtlpSpan[] = [];
  let timer: NodeJS.Timeout | undefined;
  /** Bound 1: the one export in flight, if any. */
  let inFlight: Promise<ExportResult> | undefined;
  /** Bound 3: no export starts before this (Date.now() milliseconds). */
  let coolDownUntil = 0;
  let consecutiveFailures = 0;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const failed = (spans: number, failure: ExportFailure, detail: string): ExportResult => {
    exporterCounters.exportFailures += 1;
    exporterCounters.dropped += spans;
    consecutiveFailures += 1;
    const wait = Math.min(maxBackoffMs, backoffMs * 2 ** Math.min(consecutiveFailures - 1, 30));
    coolDownUntil = Date.now() + wait;
    onFailure(failure, detail);
    return { ok: false, spans, failure };
  };

  const send = async (spans: readonly OtlpSpan[]): Promise<ExportResult> => {
    if (spans.length === 0) return { ok: true, spans: 0 };
    exporterCounters.exportAttempts += 1;
    let body: string;
    try {
      body = JSON.stringify(tracePayload(spans, options.serviceName));
    } catch {
      return failed(spans.length, EXPORT_FAILURE.serialise, `${String(spans.length)} span(s)`);
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, exportTimeoutMs);
    deadline.unref?.();
    try {
      const status = await post(url, body, controller.signal);
      if (status < 200 || status > 299) {
        return failed(spans.length, EXPORT_FAILURE.status, `http ${String(status)}`);
      }
      exporterCounters.exported += spans.length;
      consecutiveFailures = 0;
      coolDownUntil = 0;
      return { ok: true, spans: spans.length };
    } catch {
      return failed(spans.length, EXPORT_FAILURE.network, `${String(spans.length)} span(s)`);
    } finally {
      clearTimeout(deadline);
    }
  };

  /** Start one export of the whole buffer. Only ever called with nothing in flight. */
  const start = (): Promise<ExportResult> => {
    clear();
    const batch = buffer;
    buffer = [];
    const running = send(batch).finally(() => {
      inFlight = undefined;
      schedule();
    });
    inFlight = running;
    return running;
  };

  /** Decide when the next export may start; never starts a second one in flight. */
  function schedule(): void {
    if (inFlight !== undefined || buffer.length === 0 || timer !== undefined) return;
    const coolDown = coolDownUntil - Date.now();
    const delay = coolDown > 0 ? coolDown : buffer.length >= maxBatch ? 0 : flushAfterMs;
    if (delay === 0) {
      void start();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (inFlight !== undefined || buffer.length === 0) return;
      if (coolDownUntil > Date.now()) {
        schedule();
        return;
      }
      void start();
    }, delay);
    timer.unref?.();
  }

  const flush = async (): Promise<ExportResult> => {
    while (inFlight !== undefined) await inFlight.catch(() => undefined);
    return start();
  };

  return {
    record(span: OtlpSpan): void {
      if (buffer.length >= maxQueue) {
        exporterCounters.dropped += 1;
        return;
      }
      buffer.push(span);
      if (buffer.length >= maxBatch && timer !== undefined && coolDownUntil <= Date.now()) clear();
      schedule();
    },
    flush,
    shutdown: flush,
    pending: () => buffer.length,
  };
}
