/**
 * The exporter, and the clause of `T-142` § contract (rework 1) §8 that says
 * the exporter must surface its own failures.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  EXPORTER_BOUNDS,
  EXPORT_FAILURE,
  createExporter,
  exporterCounters,
  resetExporterCounters,
  tracePayload,
} from './otlp.ts';
import { buildRequestSpan, timingFrom, type OtlpSpan } from './span.ts';

const TIMING = timingFrom(1_700_000_000_000, 7);
const span = (): OtlpSpan =>
  buildRequestSpan(
    {
      trace_id: 'a'.repeat(32),
      route: 'GET /v1/meta/platform-fee',
      module: 'meta',
      actor_role: 'anonymous',
      status: 200,
      duration_ms: 7,
      data_class: 'C4',
    },
    TIMING,
  );

const ok = (): Response => new Response('{}', { status: 200 });

describe('the OTLP/JSON envelope', () => {
  test('carries one resource with service.name and one scope', () => {
    const payload = tracePayload([span()], 'kinvara-core') as {
      resourceSpans: { resource: { attributes: { key: string }[] }; scopeSpans: unknown[] }[];
    };
    expect(payload.resourceSpans).toHaveLength(1);
    expect(payload.resourceSpans[0]?.resource.attributes[0]?.key).toBe('service.name');
    expect(payload.resourceSpans[0]?.scopeSpans).toHaveLength(1);
  });

  test('posts to <endpoint>/v1/traces with a JSON content type', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const exporter = createExporter({
      endpoint: 'http://otel-collector:4318/',
      serviceName: 'kinvara-core',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    exporter.record(span());
    await exporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://otel-collector:4318/v1/traces');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('the exporter surfaces its own failures (T-142 § contract (rework 1) §8)', () => {
  test('a network failure is counted and reported with a CLASS, never a message', async () => {
    resetExporterCounters();
    const failures: string[] = [];
    const exporter = createExporter({
      endpoint: 'http://otel-collector:4318',
      serviceName: 'kinvara-core',
      fetchImpl: (() => {
        throw new Error('getaddrinfo EAI_AGAIN otel-collector parent@example.cy');
      }) as unknown as typeof fetch,
      onFailure: (failure, detail) => failures.push(`${failure} ${detail}`),
    });
    exporter.record(span());
    const result = await exporter.flush();
    expect(result.ok).toBe(false);
    expect(result.failure).toBe(EXPORT_FAILURE.network);
    expect(exporterCounters.exportFailures).toBe(1);
    expect(exporterCounters.dropped).toBe(1);
    expect(failures).toEqual(['export_network 1 span(s)']);
    // The thrown error's message never reaches the report.
    expect(failures.join()).not.toContain('EAI_AGAIN');
    expect(failures.join()).not.toContain('parent@example.cy');
  });

  test('a non-2xx response is a DIFFERENT failure class from a network failure', async () => {
    resetExporterCounters();
    const failures: string[] = [];
    const exporter = createExporter({
      endpoint: 'http://otel-collector:4318',
      serviceName: 'kinvara-core',
      fetchImpl: (async () =>
        new Response('collector says no: parent@example.cy', {
          status: 503,
        })) as unknown as typeof fetch,
      onFailure: (failure, detail) => failures.push(`${failure} ${detail}`),
    });
    exporter.record(span());
    const result = await exporter.flush();
    expect(result.failure).toBe(EXPORT_FAILURE.status);
    expect(failures).toEqual(['export_status http 503']);
    expect(failures.join()).not.toContain('parent@example.cy');
  });

  test('flushing an empty buffer is a success that reports zero spans, not a silent no-op', async () => {
    resetExporterCounters();
    const fetchImpl = vi.fn(async () => ok());
    const exporter = createExporter({
      endpoint: 'http://x',
      serviceName: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await exporter.flush();
    expect(result).toEqual({ ok: true, spans: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exporterCounters.exportAttempts).toBe(0);
  });

  test('a success counts the spans it exported, so a run that exported nothing cannot look like one that did', async () => {
    resetExporterCounters();
    const exporter = createExporter({
      endpoint: 'http://x',
      serviceName: 's',
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
    });
    exporter.record(span());
    exporter.record(span());
    await exporter.flush();
    expect(exporterCounters.exported).toBe(2);
    expect(exporterCounters.exportFailures).toBe(0);
  });
});

/**
 * T-204 (OD-227): telemetry may not starve the request path. Each bound in
 * `otlp.ts`'s header has a case here. The expected values are typed from
 * T-204's decision, never read back from `EXPORTER_BOUNDS`, except in the pin case.
 */
describe('T-204: the exporter cannot starve the request path', () => {
  const never = (): { fetchImpl: typeof fetch; calls: { signal: AbortSignal | undefined }[] } => {
    const calls: { signal: AbortSignal | undefined }[] = [];
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      calls.push({ signal });
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  test('EXPORTER_BOUNDS pins T-204: 5000 ms deadline, 5000 ms first cool-down, 60000 ms cap, 2048 spans', () => {
    expect(EXPORTER_BOUNDS).toEqual({
      exportTimeoutMs: 5000,
      backoffMs: 5000,
      maxBackoffMs: 60000,
      maxQueue: 2048,
    });
    expect(Object.isFrozen(EXPORTER_BOUNDS)).toBe(true);
  });

  test('bound 1: at most ONE export in flight, however many spans and batch-size flushes arrive', async () => {
    vi.useFakeTimers();
    try {
      resetExporterCounters();
      const { fetchImpl, calls } = never();
      const exporter = createExporter({
        endpoint: 'http://otel-collector:4318',
        serviceName: 'kinvara-core',
        fetchImpl,
        onFailure: () => undefined,
        maxBatch: 2,
        exportTimeoutMs: 600_000,
      });
      for (let i = 0; i < 500; i += 1) {
        exporter.record(span());
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(calls).toHaveLength(1);
      expect(exporterCounters.exportAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('bound 2: a collector that never answers is abandoned at 5000 ms, not at 4999, as export_network', async () => {
    vi.useFakeTimers();
    try {
      resetExporterCounters();
      const failures: string[] = [];
      const { fetchImpl, calls } = never();
      const exporter = createExporter({
        endpoint: 'http://otel-collector:4318',
        serviceName: 'kinvara-core',
        fetchImpl,
        onFailure: (failure) => failures.push(failure),
      });
      exporter.record(span());
      await vi.advanceTimersByTimeAsync(200); // flushAfterMs: the export starts
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls[0]?.signal?.aborted).toBe(false);
      expect(failures).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls[0]?.signal?.aborted).toBe(true);
      expect(failures).toEqual(['export_network']);
      expect(exporterCounters.dropped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('bound 3: after a failure no export starts for 5000 ms, then 10000, then 20000; a success resets it', async () => {
    vi.useFakeTimers();
    try {
      resetExporterCounters();
      let fail = true;
      const starts: number[] = [];
      const fetchImpl = (async () => {
        starts.push(Date.now());
        if (fail) throw new Error('getaddrinfo EAI_AGAIN otel-collector');
        return ok();
      }) as unknown as typeof fetch;
      const exporter = createExporter({
        endpoint: 'http://otel-collector:4318',
        serviceName: 'kinvara-core',
        fetchImpl,
        onFailure: () => undefined,
      });
      const t0 = Date.now();
      // A span every 100 ms for 40 s: pre-T-204 this was one export per 200 ms flush.
      for (let i = 0; i < 400; i += 1) {
        exporter.record(span());
        await vi.advanceTimersByTimeAsync(100);
      }
      const gaps = starts.map((t, i) => (i === 0 ? t - t0 : t - (starts[i - 1] ?? 0)));
      // First export at flushAfterMs; then the cool-downs 5000, 10000, 20000 (each gap >= its cool-down).
      expect(starts.length).toBe(4);
      expect(gaps[1]).toBeGreaterThanOrEqual(5000);
      expect(gaps[2]).toBeGreaterThanOrEqual(10000);
      expect(gaps[3]).toBeGreaterThanOrEqual(20000);
      expect(gaps[1]).toBeLessThan(5400);
      expect(gaps[2]).toBeLessThan(10400);
      // A success resets the cool-down: exports resume at the flush cadence.
      fail = false;
      await vi.advanceTimersByTimeAsync(60_000);
      const before = starts.length;
      for (let i = 0; i < 20; i += 1) {
        exporter.record(span());
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(starts.length - before).toBeGreaterThanOrEqual(15);
    } finally {
      vi.useRealTimers();
    }
  });

  test('bound 3: the cool-down never exceeds 60000 ms', async () => {
    vi.useFakeTimers();
    try {
      resetExporterCounters();
      const starts: number[] = [];
      const fetchImpl = (async () => {
        starts.push(Date.now());
        throw new Error('down');
      }) as unknown as typeof fetch;
      const exporter = createExporter({
        endpoint: 'http://x',
        serviceName: 's',
        fetchImpl,
        onFailure: () => undefined,
      });
      for (let i = 0; i < 6000; i += 1) {
        exporter.record(span());
        await vi.advanceTimersByTimeAsync(100);
      }
      const last = (starts.at(-1) ?? 0) - (starts.at(-2) ?? 0);
      expect(starts.length).toBeGreaterThan(6);
      expect(last).toBeGreaterThanOrEqual(60000);
      expect(last).toBeLessThan(60400);
    } finally {
      vi.useRealTimers();
    }
  });

  test('bound 4: the buffer holds at most 2048 spans; the rest are dropped and counted, not queued', async () => {
    vi.useFakeTimers();
    try {
      resetExporterCounters();
      const { fetchImpl } = never();
      const exporter = createExporter({
        endpoint: 'http://x',
        serviceName: 's',
        fetchImpl,
        onFailure: () => undefined,
        maxBatch: 1_000_000,
        exportTimeoutMs: 600_000,
      });
      exporter.record(span());
      await vi.advanceTimersByTimeAsync(200); // one export in flight, holding 1 span
      for (let i = 0; i < 3000; i += 1) exporter.record(span());
      expect(exporter.pending()).toBe(2048);
      expect(exporterCounters.dropped).toBe(3000 - 2048);
    } finally {
      vi.useRealTimers();
    }
  });

  test('flush() while an export is in flight waits for it and never runs two at once', async () => {
    resetExporterCounters();
    let open = 0;
    let maxOpen = 0;
    const fetchImpl = (async () => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 20));
      open -= 1;
      return ok();
    }) as unknown as typeof fetch;
    const exporter = createExporter({ endpoint: 'http://x', serviceName: 's', fetchImpl, maxBatch: 1 });
    exporter.record(span()); // maxBatch 1: starts at once
    exporter.record(span());
    const results = await Promise.all([exporter.flush(), exporter.flush(), exporter.flush()]);
    expect(maxOpen).toBe(1);
    expect(exporterCounters.exported).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
