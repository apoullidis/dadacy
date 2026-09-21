/**
 * The exporter, and the clause of `T-142` § contract (rework 1) §8 that says
 * the exporter must surface its own failures.
 */
import { describe, expect, test, vi } from 'vitest';
import {
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
