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
 * pipeline and this program goes RED, not green.
 *
 *   P0  EVERY SPAN THIS RUN JUDGES IS ONE THIS RUN PRODUCED. Jaeger's storage
 *       outlives a run, and the first version of this program keyed its
 *       readiness on "are there at least N traces for this service?" — which a
 *       PREVIOUS run's traces already satisfy. It then judged a byte-identical
 *       stale capture and reported the previous run's contract values. That is
 *       the harness-no-op class (PROTOCOL §5.1) in this program's own body, and
 *       it was found by mutating the collector and watching the verdict come
 *       back for the wrong reason. The fix is not a longer wait: every probe
 *       request carries a `traceparent` WITH A TRACE ID THIS RUN GENERATED, and
 *       every positive control is computed from spans fetched BY THOSE IDS. A
 *       run whose spans never arrived now fails at P0 and says which ids are
 *       missing. The one probe that cannot be identified this way — the one
 *       whose whole point is a MALFORMED `traceparent` — is covered by a count
 *       delta taken before and after, which is a run-local measurement too.
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

/** One fresh trace id per identified probe. THIS is what makes a run run-local. */
const newTraceId = (): string => randomBytes(16).toString('hex');
const traceparentFor = (traceId: string): string =>
  `00-${traceId}-${randomBytes(8).toString('hex')}-01`;

const ID = {
  registered: newTraceId(),
  unmatchedPath: newTraceId(),
  unmatchedBody: newTraceId(),
  headers: newTraceId(),
  healthz: newTraceId(),
  leak: newTraceId(),
} as const;

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
      notes.push(`${label} did not become true within ${String(seconds)}s`);
      return false;
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------- jaeger reads
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
interface Capture {
  readonly raw: string;
  readonly traces: JaegerTrace[];
}

const EMPTY: Capture = { raw: '', traces: [] };

const tagsOf = (span: JaegerSpan): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(span.tags)) {
    for (const tag of span.tags as JaegerTag[]) {
      if (typeof tag.key === 'string') out[tag.key] = String(tag.value ?? '');
    }
  }
  return out;
};

async function readTraces(url: string): Promise<Capture> {
  const r = await tryFetch(url);
  if (r === undefined || !r.ok) return EMPTY;
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

const byId = (traceId: string): Promise<Capture> => readTraces(`${JAEGER}/api/traces/${traceId}`);
const byService = (service: string): Promise<Capture> =>
  readTraces(`${JAEGER}/api/traces?service=${encodeURIComponent(service)}&limit=500&lookback=1h`);

const spansOf = (capture: Capture): JaegerSpan[] =>
  capture.traces.flatMap((t) => (Array.isArray(t.spans) ? (t.spans as JaegerSpan[]) : []));

// ---------------------------------------------------------------- preconditions
const coreUp = await waitFor(
  `${CORE}/healthz answering with mode:real`,
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

if (harness === undefined) {
  const ok = await waitFor(
    `${JAEGER}/api/services answering`,
    async () => {
      const r = await tryFetch(`${JAEGER}/api/services`);
      return r !== undefined && r.ok;
    },
    60,
  );
  if (!ok) harness = `jaeger's query API is not answering at ${JAEGER}`;
}

/** The count BEFORE this run, so the one unidentifiable probe has a run-local control. */
const tracesBefore = harness === undefined ? (await byService(CORE_SERVICE)).traces.length : 0;

// ---------------------------------------------------------------- plant, through the app
let requestsMade = 0;
if (harness === undefined) {
  const probes: [string, RequestInit][] = [
    [`${CORE}/v1/meta/platform-fee`, { headers: { traceparent: traceparentFor(ID.registered) } }],
    [`${CORE}/v1/${SENTINEL.path}`, { headers: { traceparent: traceparentFor(ID.unmatchedPath) } }],
    [
      `${CORE}/v1/meta/platform-fee?probe=${encodeURIComponent(SENTINEL.query)}`,
      { headers: { traceparent: traceparentFor(ID.healthz) } },
    ],
    [
      `${CORE}/v1/${SENTINEL.path}/submit`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: traceparentFor(ID.unmatchedBody),
        },
        body: JSON.stringify({ email: SENTINEL.body, iban: SENTINEL.header }),
      },
    ],
    [
      `${CORE}/v1/meta/platform-fee`,
      {
        headers: {
          traceparent: traceparentFor(ID.headers),
          'x-kinvara-probe': SENTINEL.header,
          cookie: `kinvara_session=${SENTINEL.cookie}`,
        },
      },
    ],
    // THE ONE PROBE WITH NO KNOWN ID, deliberately: its whole point is a
    // MALFORMED traceparent, so the app must generate a fresh id and this
    // program cannot know it. Its control is the count delta, below.
    [
      `${CORE}/v1/meta/platform-fee`,
      { headers: { traceparent: `00-${SENTINEL.traceparent}-1111111111111111-01` } },
    ],
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
                traceId: ID.leak,
                spanId: randomBytes(8).toString('hex'),
                name: 'GET /healthz',
                kind: 2,
                startTimeUnixNano: `${String(now)}000000`,
                endTimeUnixNano: `${String(now + 1)}000000`,
                attributes: [
                  { key: 'trace_id', value: { stringValue: ID.leak } },
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

// ---------------------------------------------------------------- capture, BY THIS RUN'S IDS
const captures = new Map<string, Capture>();
let serviceCapture: Capture = EMPTY;
let canaryServiceCapture: Capture = EMPTY;
let tracesAfter = 0;

if (harness === undefined) {
  await waitFor(
    "every one of this run's trace ids to be retrievable from jaeger",
    async () => {
      for (const [label, traceId] of Object.entries(ID)) {
        const capture = await byId(traceId);
        captures.set(label, capture);
      }
      serviceCapture = await byService(CORE_SERVICE);
      canaryServiceCapture = await byService(CANARY_SERVICE);
      tracesAfter = serviceCapture.traces.length;
      return (
        [...captures.values()].every((c) => spansOf(c).length > 0) &&
        tracesAfter >= tracesBefore + 6
      );
    },
    45,
  );
}

// ---------------------------------------------------------------- P0..P5
let spansScanned = 0;
let bytesScanned = 0;
/**
 * P0 alone gates the absence check, NOT the whole of P2-P5.
 *
 * P0 is the control that makes an absence mean anything — it says the capture
 * is THIS RUN's. P2-P5 are shape and leak-visibility controls, and failing one
 * of them is no reason to stop looking for a planted value; a mutation that
 * breaks the span's shape is exactly the kind that also leaks. An earlier
 * version gated the absence check behind every control and a real, measured
 * leak was reported only as a shape failure.
 */
let p0Ok = true;

if (harness === undefined) {
  const perId = [...captures.values()];
  spansScanned = perId.reduce((n, c) => n + spansOf(c).length, 0);
  bytesScanned =
    perId.reduce((n, c) => n + c.raw.length, 0) +
    serviceCapture.raw.length +
    canaryServiceCapture.raw.length;

  // P0 — every span judged below is one THIS RUN produced.
  const missing = [...captures.entries()]
    .filter(([, c]) => spansOf(c).length === 0)
    .map(([label]) => label);
  if (missing.length > 0) {
    problems.push(
      `P0 jaeger holds no span for this run's trace id(s): ${missing.join(', ')}. THE ABSENCE CHECK IS NOT RUN, because an absence check over someone else's capture — or over a previous run's — proves nothing about this one.`,
    );
    p0Ok = false;
  }
  if (tracesAfter < tracesBefore + 6) {
    problems.push(
      `P0 ${CORE_SERVICE} had ${String(tracesBefore)} trace(s) before this run and ${String(tracesAfter)} after; six new ones are required. The malformed-traceparent probe has no known id and this delta is its only control.`,
    );
    p0Ok = false;
  }

  // P2 — the sample request emits the FULL contract.
  const CONTRACT = [
    'trace_id',
    'route',
    'module',
    'actor_role',
    'status',
    'duration_ms',
    'data_class',
  ];
  const registeredSpan = spansOf(captures.get('registered') ?? EMPTY)[0];
  if (registeredSpan === undefined) {
    problems.push(
      `P2 this run's registered-route trace ${ID.registered} holds no span, so the instrumentation is not demonstrably emitting anything.`,
    );
  } else {
    const tags = tagsOf(registeredSpan);
    const absent = CONTRACT.filter((field) => !(field in tags));
    if (absent.length > 0) {
      problems.push(
        `P2 the sample request's span is missing contract field(s): ${absent.join(', ')}. SD §QD-5 requires all seven.`,
      );
    }
    if (tags['route'] !== 'GET /v1/meta/platform-fee') {
      problems.push(
        `P2 the sample request's span carries route=${JSON.stringify(tags['route'])}; the registry key is \`GET /v1/meta/platform-fee\`.`,
      );
    }
    if (tags['data_class'] !== 'C4') {
      problems.push(
        `P2 the sample request's span carries data_class=${JSON.stringify(tags['data_class'])}; the route registry declares C4.`,
      );
    }
    if (tags['trace_id'] !== ID.registered) {
      problems.push(
        `P2 the sample request's span carries trace_id=${JSON.stringify(tags['trace_id'])}, not this run's ${ID.registered}.`,
      );
    }
    notes.push(
      `P2 contract on THIS RUN's sample request: ${CONTRACT.map((f) => `${f}=${tags[f] ?? '(absent)'}`).join(' ')}`,
    );
  }

  // P3 — the requests that carried the path and body sentinels WERE traced.
  for (const label of ['unmatchedPath', 'unmatchedBody'] as const) {
    const span = spansOf(captures.get(label) ?? EMPTY)[0];
    if (span === undefined) continue; // already reported by P0
    const tags = tagsOf(span);
    if (tags['route'] !== '(unmatched)') {
      problems.push(
        `P3 the ${label} probe's span carries route=${JSON.stringify(tags['route'])}; an unmatched request must be stamped \`(unmatched)\` with its path discarded.`,
      );
    }
  }

  // P4 + P5 — the leak control.
  const leakSpan = spansOf(captures.get('leak') ?? EMPTY)[0];
  if (leakSpan === undefined) {
    problems.push(
      `P4 the leak-control span (trace ${ID.leak}) did not arrive in jaeger, so this run cannot demonstrate that the capture is able to see a leak at all. Check the collector's traces pipeline.`,
    );
  } else {
    const tags = tagsOf(leakSpan);
    if (LEAK_KEY in tags) {
      problems.push(
        `P4/LEAK the unallowlisted attribute \`${LEAK_KEY}\` REACHED JAEGER carrying ${JSON.stringify(tags[LEAK_KEY])}. The collector's redaction allowlist did not remove it.`,
      );
    }
    const redactedKeys = tags['redaction.redacted.keys'] ?? '';
    const named = redactedKeys
      .split(',')
      .map((k) => k.trim())
      .includes(LEAK_KEY);
    if (!named) {
      problems.push(
        `P5 the arrived leak-control span does not name \`${LEAK_KEY}\` in redaction.redacted.keys (it names ${JSON.stringify(redactedKeys)}). Without that, "the attribute was redacted" and "the attribute never arrived" are the same observation, and this run is one outcome short of a verdict.`,
      );
    } else {
      notes.push(`P5 the collector reports it removed: ${redactedKeys}`);
    }
  }
}

// ---------------------------------------------------------------- the absence check
if (harness === undefined && p0Ok) {
  const haystack = [
    ...[...captures.values()].map((c) => c.raw),
    serviceCapture.raw,
    canaryServiceCapture.raw,
  ].join('\n');
  for (const [name, value] of SENTINELS) {
    if (haystack.includes(value)) {
      problems.push(
        `LEAK the ${name} sentinel ${JSON.stringify(value)} IS PRESENT in what jaeger stored.`,
      );
    }
    // A URL-encoded copy is the same value by another spelling, and the
    // encoding happens in THIS program rather than downstream, so catching it
    // is in scope. No other transformation is (see the header).
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
  `  this run's trace ids: ${Object.entries(ID)
    .map(([k, v]) => `${k}=${v.slice(0, 8)}…`)
    .join(' ')}`,
);
console.log(
  `  ${CORE_SERVICE} traces before/after: ${String(tracesBefore)} -> ${String(tracesAfter)}`,
);
console.log(
  `  judged: ${String(spansScanned)} span(s) fetched BY THIS RUN'S TRACE IDS; ${String(bytesScanned)} byte(s) of jaeger JSON scanned for sentinels`,
);
for (const note of notes) console.log(`  note: ${note}`);
console.log(
  '  NOT COVERED: any value this run did not plant; any value transformed (hashed, folded, transliterated) before reaching a span; any path not exercised above; anything that is not an OTel span in jaeger. T-119 (gate:pii-canary) is the ticket that widens the first two.',
);
console.log(
  '  AND TWO BOUNDS ON THE SENTINEL SET ITSELF (T-008 rework 1, QA-F6): only TWO of the seven sentinels have any emitter-side channel to a span in this build — path (via route) and traceparent (via traceIdFrom); query, body, header and cookie cannot reach a span at all today and are guards against a future auto-instrumentation SDK, and leak tests the COLLECTOR, not the emitter. And the P0 delta control reads limit=500&lookback=1h, so a jaeger holding 500 or more kinvara-core traces in that window saturates the delta and makes this canary permanently RED — it fails safe, and T-119 must not reuse that control unchanged.',
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
