/**
 * THE SPAN CANARY — T-008's own no-PII mechanism, end to end.
 *
 * ================================================================
 * WHY THIS EXISTS AND WHAT IT IS NOT
 * ================================================================
 *
 * `T-008`'s acceptance criterion reads: "A sample request emits the full
 * contract and is visible end to end in Jaeger, with no PII — asserted by the
 * leak canary, not by inspection." THE LEAK CANARY IS `T-119`, AND `T-119` IS
 * `blocked_by T-116, T-008`. It is blocked on this ticket, so it cannot be
 * used here and must not be waited for; and the criterion rules out asserting
 * "no PII" by inspection. What is owed instead is a committed mechanism that
 * FAILS WHEN PII REACHES A SPAN, published at exactly the width it covers.
 * This is that mechanism.
 *
 * IT IS VALUE-BASED, NOT PATTERN-BASED, AND THAT IS THE DIVISION OF LABOUR.
 * It plants unique sentinel values through the paths a request can carry them
 * on, and asserts those exact byte strings appear nowhere in what Jaeger
 * actually stored. It needs no format knowledge — which is SD §SEC-I5's own
 * argument for the certificate-reference canary: "A value-based canary needs
 * no format knowledge." `T-119` adds the half this cannot do: the Cyprus
 * format patterns (identity card, ARC, TIN, IBAN, passport, vehicle, E.164)
 * and the cross-script name set, which catch PII NOBODY PLANTED.
 *
 * ================================================================
 * WHAT IT WOULD MISS — read this before trusting a green run
 * ================================================================
 *
 *   - A value it did not plant. It has no detector.
 *   - A value that is TRANSFORMED before reaching a span — hashed, truncated,
 *     case-folded, URL-encoded, transliterated to or from Greeklish. A
 *     byte-comparison sees none of those. This is precisely T-119's
 *     cross-script half (SD §SEC-I5 property 2).
 *   - A path it does not exercise. It exercises: the URL path, the query
 *     string, a JSON request body, two request headers and `traceparent`.
 *   - Anything that is not an OTel span in Jaeger. Not the application log,
 *     not a Sentry payload, not an ALB access log, not `provider_event.raw` —
 *     three of which do not exist in this build at all.
 *
 * ================================================================
 * IF IT CHECKED NOTHING, WOULD IT SAY SO? (PROTOCOL §5.1)
 * ================================================================
 *
 * An absence check over an empty capture passes. So NO ABSENCE IS JUDGED until
 * five positive controls have passed, and each is an assertion, not a log line:
 *
 *   P1  Jaeger returned at least MIN_TRACES traces.
 *   P2  the span for a REGISTERED route is present, carrying all seven
 *       contract fields, with the data_class the registry declares.
 *   P3  the span for the UNMATCHED 404 requests is present — so the requests
 *       that carried the path and body sentinels were definitely traced. An
 *       absence check that passes because the request was never traced is the
 *       failure this control exists to make impossible.
 *   P4  THE LEAK CONTROL. This process posts a span straight at the collector
 *       carrying an attribute key the allowlist does not pass, holding its own
 *       sentinel. The span must ARRIVE in Jaeger (so the capture demonstrably
 *       sees spans of this shape)...
 *   P5  ...and the redaction processor's own summary on that arrived span must
 *       NAME the key it removed. That is what separates "the attribute was
 *       redacted" from "the span never arrived" — two outcomes a bare absence
 *       check reads as one.
 *
 * P4+P5 together are the answer to the question: they prove the capture can
 * see a leak of exactly this kind, so the absence of the other sentinels is
 * evidence rather than silence. Remove `redaction` from the collector's traces
 * pipeline and this program goes RED at the sentinel check, not green.
 *
 * ================================================================
 * RUNNING IT
 * ================================================================
 *
 *   ./scripts/svc up  T-008 db api otel --verify --build
 *   ./scripts/svc run T-008 -- node packages/observability/tools/canary.ts
 *   ./scripts/svc down T-008
 *
 * It needs the `otel` profile, so it CANNOT be a member of `pnpm gate:pr`,
 * which declares `svc: none` (DOCKER.md §7). That is the same structural bound
 * `gate:drizzle-parity` and `apps/core`'s `test:integration` have (OD-57), and
 * it is stated rather than worked around. `pnpm gate:otel-contract` is the
 * static half that does run in `gate:pr`.
 *
 * THREE OUTCOMES, NOT TWO. `CANARY PASS` (0), `CANARY FAIL` (1) and
 * `HARNESS ERROR` (2) are distinct, so a run that could not reach `core` or
 * Jaeger can never be read as a clean one.
 */
import { randomBytes } from 'node:crypto';

const CORE = process.env['CORE_BASE_URL'] ?? 'http://core:3000';
const OTLP = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://otel-collector:4318';
const JAEGER = process.env['JAEGER_QUERY_BASE'] ?? 'http://jaeger:16686';
const CORE_SERVICE = 'kinvara-core';
const CANARY_SERVICE = 'kinvara-canary';
const LEAK_KEY = 'kinvara.canary.leak';
const MIN_TRACES = 4;

const problems: string[] = [];
const notes: string[] = [];
let harness: string | undefined;

/** A sentinel: PII-SHAPED so a reader sees what is being tested, with a unique
 *  nonce so a hit can only be this program's own planted value. */
const nonce = (): string => randomBytes(6).toString('hex').toUpperCase();
const SENTINEL = {
  path: `CY-PATH-${nonce()}`,
  query: `CY-QUERY-${nonce()}`,
  body: `parent.${nonce().toLowerCase()}@example.cy`,
  header: `CY17002001280000${nonce()}`,
  cookie: `session-${nonce()}`,
  traceparent: `TRACEPARENT-${nonce()}`,
  leak: `Χριστοδούλου-+357-${nonce()}`,
} as const;
const SENTINELS: readonly [string, string][] = Object.entries(SENTINEL);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function tryFetch(url: string, init?: RequestInit): Promise<Response | undefined> {
  try {
    return await fetch(url, init);
  } catch {
    return undefined;
  }
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  seconds: number,
): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) {
      notes.push(`${label} did not become ready within ${String(seconds)}s`);
      return false;
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------- preconditions
const coreUp = await waitFor(
  `${CORE}/healthz`,
  async () => {
    const r = await tryFetch(`${CORE}/healthz`);
    if (r === undefined || !r.ok) return false;
    const body: unknown = await r.json().catch(() => undefined);
    return (
      typeof body === 'object' && body !== null && (body as { mode?: unknown }).mode === 'real'
    );
  },
  60,
);
if (!coreUp) harness = `core is not answering /healthz with mode:real at ${CORE}`;

const jaegerUp =
  harness === undefined &&
  (await waitFor(
    `${JAEGER}/api/services`,
    async () => {
      const r = await tryFetch(`${JAEGER}/api/services`);
      return r !== undefined && r.ok;
    },
    60,
  ));
if (harness === undefined && !jaegerUp)
  harness = `jaeger's query API is not answering at ${JAEGER}`;

// ---------------------------------------------------------------- plant, through the app
let requestsMade = 0;
if (harness === undefined) {
  const probes: [string, RequestInit][] = [
    [`${CORE}/v1/meta/platform-fee`, {}],
    [`${CORE}/v1/${SENTINEL.path}`, {}],
    [`${CORE}/v1/meta/platform-fee?probe=${encodeURIComponent(SENTINEL.query)}`, {}],
    [
      `${CORE}/v1/${SENTINEL.path}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: SENTINEL.body, iban: SENTINEL.header }),
      },
    ],
    [
      `${CORE}/v1/meta/platform-fee`,
      {
        headers: {
          'x-kinvara-probe': SENTINEL.header,
          cookie: `kinvara_session=${SENTINEL.cookie}`,
          traceparent: `00-${SENTINEL.traceparent}-1111111111111111-01`,
        },
      },
    ],
    [`${CORE}/healthz`, {}],
  ];
  for (const [url, init] of probes) {
    const r = await tryFetch(url, init);
    if (r === undefined) {
      harness = `a probe request to ${url.replace(/\?.*$/, '?…')} did not complete`;
      break;
    }
    requestsMade += 1;
  }
}

// ---------------------------------------------------------------- plant, at the collector
// THE LEAK CONTROL. One span with an allowlisted attribute set PLUS one key the
// allowlist does not pass, carrying its own sentinel.
const leakTraceId = randomBytes(16).toString('hex');
if (harness === undefined) {
  const now = Date.now();
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: CANARY_SERVICE } }],
        },
        scopeSpans: [
          {
            scope: { name: '@kinvara/observability/canary', version: '0.0.0' },
            spans: [
              {
                traceId: leakTraceId,
                spanId: randomBytes(8).toString('hex'),
                name: 'GET /healthz',
                kind: 2,
                startTimeUnixNano: `${now}000000`,
                endTimeUnixNano: `${now + 1}000000`,
                attributes: [
                  { key: 'trace_id', value: { stringValue: leakTraceId } },
                  { key: 'route', value: { stringValue: 'GET /healthz' } },
                  { key: 'module', value: { stringValue: 'meta' } },
                  { key: 'actor_role', value: { stringValue: 'system' } },
                  { key: 'status', value: { intValue: '200' } },
                  { key: 'duration_ms', value: { intValue: '1' } },
                  { key: 'data_class', value: { stringValue: 'C4' } },
                  { key: LEAK_KEY, value: { stringValue: SENTINEL.leak } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  const r = await tryFetch(`${OTLP}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r === undefined || !r.ok) {
    harness = `the leak-control span was not accepted by the collector at ${OTLP}/v1/traces (${
      r === undefined ? 'no response' : `http ${String(r.status)}`
    })`;
  }
}

// ---------------------------------------------------------------- capture
interface JaegerTag {
  key?: unknown;
  value?: unknown;
}
interface JaegerSpan {
  operationName?: unknown;
  tags?: unknown;
}
interface JaegerTrace {
  spans?: unknown;
}

const tagsOf = (span: JaegerSpan): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(span.tags)) {
    for (const tag of span.tags as JaegerTag[]) {
      if (typeof tag.key === 'string') out[tag.key] = String(tag.value ?? '');
    }
  }
  return out;
};

async function traces(service: string): Promise<{ raw: string; traces: JaegerTrace[] }> {
  const url = `${JAEGER}/api/traces?service=${encodeURIComponent(service)}&limit=200&lookback=1h`;
  const r = await tryFetch(url);
  if (r === undefined || !r.ok) return { raw: '', traces: [] };
  const raw = await r.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { raw, traces: [] };
  }
  const data =
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: JaegerTrace[] }).data
      : [];
  return { raw, traces: data };
}

let coreCapture = { raw: '', traces: [] as JaegerTrace[] };
let canaryCapture = { raw: '', traces: [] as JaegerTrace[] };
if (harness === undefined) {
  // The app exporter flushes after 200 ms and the collector batches for 200 ms.
  const gotThem = await waitFor(
    'jaeger to hold the planted spans',
    async () => {
      coreCapture = await traces(CORE_SERVICE);
      canaryCapture = await traces(CANARY_SERVICE);
      return coreCapture.traces.length >= MIN_TRACES && canaryCapture.traces.length >= 1;
    },
    45,
  );
  if (!gotThem) {
    notes.push(
      `capture after the wait: ${String(coreCapture.traces.length)} ${CORE_SERVICE} trace(s), ${String(canaryCapture.traces.length)} ${CANARY_SERVICE} trace(s)`,
    );
  }
}

// ---------------------------------------------------------------- the five positive controls
const allSpans = (capture: { traces: JaegerTrace[] }): JaegerSpan[] =>
  capture.traces.flatMap((t) => (Array.isArray(t.spans) ? (t.spans as JaegerSpan[]) : []));

let spansScanned = 0;
let bytesScanned = 0;

if (harness === undefined) {
  const coreSpans = allSpans(coreCapture);
  const canarySpans = allSpans(canaryCapture);
  spansScanned = coreSpans.length + canarySpans.length;
  bytesScanned = coreCapture.raw.length + canaryCapture.raw.length;

  // P1
  if (coreCapture.traces.length < MIN_TRACES) {
    problems.push(
      `P1 jaeger returned ${String(coreCapture.traces.length)} ${CORE_SERVICE} trace(s); at least ${String(MIN_TRACES)} are required. AN ABSENCE CHECK OVER AN EMPTY CAPTURE PASSES, so nothing below is judged.`,
    );
  }

  // P2
  const CONTRACT = [
    'trace_id',
    'route',
    'module',
    'actor_role',
    'status',
    'duration_ms',
    'data_class',
  ];
  const registered = coreSpans.find((s) => tagsOf(s)['route'] === 'GET /v1/meta/platform-fee');
  if (registered === undefined) {
    problems.push(
      `P2 no span for the registered route \`GET /v1/meta/platform-fee\` is in the capture, so the instrumentation is not demonstrably emitting anything.`,
    );
  } else {
    const tags = tagsOf(registered);
    const missing = CONTRACT.filter((field) => !(field in tags));
    if (missing.length > 0) {
      problems.push(
        `P2 the span for \`GET /v1/meta/platform-fee\` is missing contract field(s): ${missing.join(', ')}. SD §QD-5 requires all seven.`,
      );
    }
    if (tags['data_class'] !== 'C4') {
      problems.push(
        `P2 the span for \`GET /v1/meta/platform-fee\` carries data_class=${JSON.stringify(tags['data_class'])}; the route registry declares C4.`,
      );
    }
    notes.push(
      `P2 contract on the sample request: ${CONTRACT.map((f) => `${f}=${tags[f] ?? '(absent)'}`).join(' ')}`,
    );
  }

  // P3
  const unmatched = coreSpans.filter((s) => tagsOf(s)['route'] === '(unmatched)');
  if (unmatched.length < 2) {
    problems.push(
      `P3 found ${String(unmatched.length)} \`(unmatched)\` span(s); at least 2 are required (the path probe and the body probe). If those requests were never traced, their sentinels could not appear whatever the instrumentation did, and their absence would prove nothing.`,
    );
  }

  // P4 + P5
  const leakSpan = canarySpans.find((s) => tagsOf(s)['trace_id'] === leakTraceId);
  if (leakSpan === undefined) {
    problems.push(
      `P4 the leak-control span did not arrive in jaeger, so this run cannot demonstrate that the capture is able to see a leak at all.`,
    );
  } else {
    const tags = tagsOf(leakSpan);
    if (LEAK_KEY in tags) {
      problems.push(
        `P4/LEAK the unallowlisted attribute \`${LEAK_KEY}\` REACHED JAEGER. The collector's redaction allowlist did not remove it.`,
      );
    }
    const redactedKeys = tags['redaction.redacted.keys'] ?? '';
    if (
      !redactedKeys
        .split(',')
        .map((k) => k.trim())
        .includes(LEAK_KEY)
    ) {
      problems.push(
        `P5 the arrived leak-control span does not name \`${LEAK_KEY}\` in redaction.redacted.keys (it names ${JSON.stringify(redactedKeys)}). Without that, "the attribute was redacted" and "the attribute never arrived" are the same observation, and this whole run is one outcome short of a verdict.`,
      );
    } else {
      notes.push(`P5 the collector reports it removed: ${redactedKeys}`);
    }
  }
}

// ---------------------------------------------------------------- the absence check
if (harness === undefined && problems.length === 0) {
  const haystack = `${coreCapture.raw}\n${canaryCapture.raw}`;
  for (const [name, value] of SENTINELS) {
    if (haystack.includes(value)) {
      problems.push(
        `LEAK the ${name} sentinel ${JSON.stringify(value)} IS PRESENT in what jaeger stored.`,
      );
    }
    // A URL-encoded copy is the same value by another spelling; catching it is
    // in scope, because the encoding happens in THIS program, not downstream.
    const encoded = encodeURIComponent(value);
    if (encoded !== value && haystack.includes(encoded)) {
      problems.push(
        `LEAK the ${name} sentinel is present URL-ENCODED as ${JSON.stringify(encoded)}.`,
      );
    }
  }
}

// ---------------------------------------------------------------- verdict
console.log('span canary — T-008');
console.log(`  core        ${CORE}`);
console.log(`  collector   ${OTLP}`);
console.log(`  jaeger      ${JAEGER}`);
console.log(
  `  sentinels planted: ${String(SENTINELS.length)} (${SENTINELS.map(([k]) => k).join(', ')})`,
);
console.log(`  requests made:     ${String(requestsMade)}`);
console.log(
  `  captured:          ${String(coreCapture.traces.length)} ${CORE_SERVICE} trace(s), ${String(canaryCapture.traces.length)} ${CANARY_SERVICE} trace(s), ${String(spansScanned)} span(s), ${String(bytesScanned)} byte(s) of jaeger JSON`,
);
for (const note of notes) console.log(`  note: ${note}`);
console.log(
  '  NOT COVERED: any value this run did not plant; any value transformed (hashed, folded, transliterated) before reaching a span; any path not exercised above; anything that is not an OTel span in jaeger. T-119 (gate:pii-canary) is the ticket that widens the first two.',
);

if (harness !== undefined) {
  console.error(`\nHARNESS ERROR  span canary — ${harness}`);
  for (const note of notes) console.error(`  - ${note}`);
  process.exit(2);
}
if (problems.length > 0) {
  console.error(`\nCANARY FAIL  span canary — ${String(problems.length)} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nCANARY PASS  span canary');
process.exit(0);
