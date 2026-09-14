/**
 * The problem+json filter's refusals, the process-level handlers, and the SIGTERM
 * drain, against a REAL process: `node test/fixtures/fault-server.ts` runs
 * `src/server.ts` — the same `createApp`, filter, handlers and drain `main.ts`
 * runs — plus test-only throwing routes, on 127.0.0.1. Its ENTIRE stdout and
 * stderr are captured from process start, so "absent from the log" is a
 * statement about everything the process wrote.
 *
 * Why not against the container: producing (ii) and (iii) on demand needs a
 * route that throws a constructed value, and shipping one in the image would
 * invent an endpoint. `test/container.test.ts` exercises (i) and QA-F1's three
 * undecodable paths in the container.
 *
 * The tests in this file run in order and share one server; the output test
 * stops it, so it comes after every request. The last two tests boot their own.
 *
 * Expected bodies are LITERALS, written from OE-15 and T-023 § contract §6's
 * table (status, code, retryable) and each class's title; the process markers
 * are literals written from this ticket's § Published contract. Neither is read
 * from `src/`.
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPE_BASE } from '@kinvara/contracts';
import { toProblem } from '@kinvara/domain-types';
import { LOG_MARKERS } from '../src/problem-json/problem-json.filter.ts';
import { ExtensionsThrowProbe, SLOW_MS, d4aProxy } from './fixtures/faults.ts';
import { rawGet, type RawResponse } from './fixtures/raw-http.ts';

const SENTINEL = 'KINVARA-T135-SENTINEL-f1lter-9d4a';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fault-server.ts');

const problemBody = (code: string, title: string, status: number, retryable = false) => ({
  type: `https://errors.kinvara.cy/${code}`,
  title,
  status,
  code,
  retryable,
});
const FIXED_500 = problemBody('internal_error', 'Internal error', 500);
const INVALID_INPUT = problemBody('invalid_input', 'Invalid input', 400);

const UNHANDLED_MARKER =
  '[core] process: an unhandled promise rejection; the process continues class=Error';
const UNCAUGHT_MARKER = '[core] process: an uncaught exception; exiting 1 class=Error';

interface Server {
  readonly child: ChildProcess;
  readonly base: string;
  readonly output: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function boot(): Promise<Server> {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, KINVARA_T135_SENTINEL: SENTINEL, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const port = /listening on 127\.0\.0\.1:(\d+)/.exec(out)?.[1];
    if (port !== undefined) {
      return { child, base: `http://127.0.0.1:${port}`, output: () => out, exited };
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new TypeError(`fault-server did not start (exit ${String(child.exitCode)}):\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function problem(res: Response): Promise<{ text: string; body: unknown }> {
  assert.match(res.headers.get('content-type') ?? '', /^application\/problem\+json\b/);
  const text = await res.text();
  return { text, body: JSON.parse(text) };
}

/** The whole shape at once, so a red case shows what came back rather than the first mismatch. */
function assertRawProblem(res: RawResponse, status: number, expected: object): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = `<not JSON: ${res.body.slice(0, 200)}>`;
  }
  assert.deepEqual(
    {
      status: res.status,
      contentType: res.headers['content-type'] ?? null,
      sentinelInBody: res.body.includes(SENTINEL),
      body: parsed,
    },
    {
      status,
      contentType: 'application/problem+json; charset=utf-8',
      sentinelInBody: false,
      body: expected,
    },
  );
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

let server: Server;
beforeAll(async () => {
  server = await boot();
}, 40_000);
afterAll(() => {
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
});

test('premise: the D4a Proxy and a throwing problemExtensions each make toProblem itself throw, carrying the sentinel', () => {
  for (const construction of [d4aProxy(SENTINEL), new ExtensionsThrowProbe(SENTINEL)]) {
    assert.throws(
      () => toProblem(construction, TYPE_BASE),
      (e: unknown) => e instanceof Error && e.message.includes(SENTINEL),
    );
  }
});

test('(i) a thrown DomainError answers problem+json with exactly the standard members: no detail, no instance, no value, no echo', async () => {
  const { text, body } = await problem(await fetch(`${server.base}/fault/domain`));
  assert.equal(text.includes(SENTINEL), false);
  assert.deepEqual(body, {
    nested: {},
    type: 'https://errors.kinvara.cy/slot_taken',
    title: 'Slot taken',
    status: 409,
    code: 'slot_taken',
    retryable: false,
  });
});

test('(ii) toProblem forced to throw by the D4a Proxy answers the fixed 500 body', async () => {
  const res = await fetch(`${server.base}/fault/proxy`);
  assert.equal(res.status, 500);
  const { text, body } = await problem(res);
  assert.equal(text.includes(SENTINEL), false);
  assert.deepEqual(body, FIXED_500);
});

test('(ii) toProblem forced to throw by a throwing problemExtensions answers the fixed 500 body', async () => {
  const res = await fetch(`${server.base}/fault/extensions`);
  assert.equal(res.status, 500);
  const { text, body } = await problem(res);
  assert.equal(text.includes(SENTINEL), false);
  assert.deepEqual(body, FIXED_500);
});

test('(iii) a non-domain Error answers a 500 carrying nothing from it', async () => {
  const res = await fetch(`${server.base}/fault/plain`);
  assert.equal(res.status, 500);
  const { text, body } = await problem(res);
  assert.equal(text.includes(SENTINEL), false);
  assert.deepEqual(body, FIXED_500);
});

test('(iii) a thrown non-Error value answers the same 500 carrying nothing from it', async () => {
  const res = await fetch(`${server.base}/fault/non-error`);
  assert.equal(res.status, 500);
  const { text, body } = await problem(res);
  assert.equal(text.includes(SENTINEL), false);
  assert.deepEqual(body, FIXED_500);
});

test('a Fastify-level client error (a malformed JSON body quoting the sentinel) answers 400 invalid_input carrying nothing', async () => {
  const res = await fetch(`${server.base}/fault/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"x":"${SENTINEL}`,
  });
  assert.equal(res.status, 400);
  const { text, body } = await problem(res);
  assert.equal(text.includes(SENTINEL), false);
  assert.deepEqual(body, INVALID_INPUT);
});

test('an unmatched route whose path is the sentinel answers the 404 not_found body', async () => {
  const res = await fetch(`${server.base}/v1/${SENTINEL}`);
  assert.equal(res.status, 404);
  const { text } = await problem(res);
  assert.equal(text.includes(SENTINEL), false);
});

test('QA-F1: an undecodable path, invalid UTF-8 in a percent-encoding, answers 400 invalid_input problem+json echoing nothing', async () => {
  assertRawProblem(await rawGet(server.base, `/v1/%E0%A4%A${SENTINEL}`), 400, INVALID_INPUT);
});

test('QA-F1: an undecodable path, %ZZ after the real route, answers 400 invalid_input problem+json echoing nothing', async () => {
  assertRawProblem(
    await rawGet(server.base, `/v1/meta/platform-fee%ZZ${SENTINEL}`),
    400,
    INVALID_INPUT,
  );
});

test('QA-F1: an undecodable path, a lone percent at the end, answers 400 invalid_input problem+json echoing nothing', async () => {
  assertRawProblem(await rawGet(server.base, `/${SENTINEL}%`), 400, INVALID_INPUT);
});

test('QA-F2: a non-domain Error thrown in a Nest middleware answers the fixed 500 body, not a hung request', async () => {
  assertRawProblem(await rawGet(server.base, '/fault/mw-throw'), 500, FIXED_500);
}, 15_000);

test('QA-F2 control: a Nest middleware passing the Error to next answers the fixed 500 body', async () => {
  assertRawProblem(await rawGet(server.base, '/fault/mw-next'), 500, FIXED_500);
}, 15_000);

test('QA-A2: a framework 401 UnauthorizedException answers 401 unauthenticated, echoing nothing', async () => {
  assertRawProblem(
    await rawGet(server.base, '/fault/http401'),
    401,
    problemBody('unauthenticated', 'Unauthenticated', 401),
  );
});

test('QA-A2: a guard answering false (Nest throws ForbiddenException) answers 403 policy_denied, not 400', async () => {
  assertRawProblem(
    await rawGet(server.base, '/fault/guarded'),
    403,
    problemBody('policy_denied', 'Forbidden', 403),
  );
});

test('QA-A2: a framework 412 PreconditionFailedException answers 412 precondition_failed, echoing nothing', async () => {
  assertRawProblem(
    await rawGet(server.base, '/fault/http412'),
    412,
    problemBody('precondition_failed', 'Precondition failed', 412),
  );
});

test('QA-A2: a framework 429 answers 429 rate_limited with retryable true, echoing nothing', async () => {
  assertRawProblem(
    await rawGet(server.base, '/fault/http429'),
    429,
    problemBody('rate_limited', 'Too many requests', 429, true),
  );
});

test('QA-A2: a framework 503 ServiceUnavailableException answers 503 upstream_unavailable with retryable true, echoing nothing', async () => {
  assertRawProblem(
    await rawGet(server.base, '/fault/http503'),
    503,
    problemBody('upstream_unavailable', 'Upstream unavailable', 503, true),
  );
});

test('QA-A2 report, no code invented: a framework 409 answers 400 invalid_input and a framework 502 the fixed 500', async () => {
  assertRawProblem(await rawGet(server.base, '/fault/http409'), 400, INVALID_INPUT);
  assertRawProblem(await rawGet(server.base, '/fault/http502'), 500, FIXED_500);
});

test('QA-A1: an unhandled promise rejection logs a fixed marker and the class only, and the process keeps serving', async () => {
  const res = await fetch(`${server.base}/fault/unhandled`);
  assert.equal(res.status, 200);
  const deadline = Date.now() + 5000;
  while (
    !server.output().includes(UNHANDLED_MARKER) &&
    server.child.exitCode === null &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const health = await fetch(`${server.base}/healthz`).then(
    (r) => r.status,
    () => 'REFUSED',
  );
  const out = server.output();
  assert.deepEqual(
    {
      marker: count(out, UNHANDLED_MARKER),
      sentinelInLog: out.includes(SENTINEL),
      stackFrameInLog: /^\s+at\s/m.test(out),
      exitCode: server.child.exitCode,
      healthAfter: health,
    },
    { marker: 1, sentinelInLog: false, stackFrameInLog: false, exitCode: null, healthAfter: 200 },
  );
});

test('the captured process output: the sentinel is ABSENT, no stack frame is logged, and each fixed marker IS present', async () => {
  server.child.kill('SIGTERM');
  const { code } = await server.exited;
  assert.equal(code, 0, 'the fault server drained and exited 0');
  const out = server.output();

  // Every observation at once, so a failure shows its whole shape rather than the first
  // assertion to trip. The marker counts are the anti-vacuity half: the capture is live
  // from process start and saw each path through the filter. internalError class=Error is
  // (iii) plain + the throwing middleware + the next(err) middleware; class=HttpException is
  // the framework 502. The 4xx and 503 mappings and the undecodable paths log nothing.
  assert.deepEqual(
    {
      captureLive: /listening on 127\.0\.0\.1:\d+/.test(out),
      toProblemThrewTypeError: count(out, `${LOG_MARKERS.toProblemThrew} class=TypeError`),
      toProblemThrewError: count(out, `${LOG_MARKERS.toProblemThrew} class=Error`),
      internalErrorError: count(out, `${LOG_MARKERS.internalError} class=Error`),
      internalErrorObject: count(out, `${LOG_MARKERS.internalError} class=object`),
      internalErrorHttpException: count(out, `${LOG_MARKERS.internalError} class=HttpException`),
      writeFailed: count(out, LOG_MARKERS.writeFailed),
      unhandledRejection: count(out, UNHANDLED_MARKER),
      sentinelInLog: out.includes(SENTINEL),
      stackFrameInLog: /^\s+at\s/m.test(out),
      notFoundMessageInLog: /Cannot (GET|POST)/.test(out),
    },
    {
      captureLive: true,
      toProblemThrewTypeError: 1,
      toProblemThrewError: 1,
      internalErrorError: 3,
      internalErrorObject: 1,
      internalErrorHttpException: 1,
      writeFailed: 0,
      unhandledRejection: 1,
      sentinelInLog: false,
      stackFrameInLog: false,
      notFoundMessageInLog: false,
    },
  );
});

test('SIGTERM with a request in flight: the request completes, a new connection is refused, and the process exits 0', async () => {
  const drain = await boot();
  try {
    const started = Date.now();
    const inflight = fetch(`${drain.base}/fault/slow`).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as unknown,
      ms: Date.now() - started,
    }));
    await new Promise((r) => setTimeout(r, 400));
    drain.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));

    const port = Number(new URL(drain.base).port);
    const connect = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.on('connect', () => {
        socket.destroy();
        resolve('CONNECTED');
      });
      socket.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERROR'));
    });
    assert.equal(connect, 'ECONNREFUSED');

    const result = await inflight;
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { slept: SLOW_MS });
    assert.ok(result.ms >= SLOW_MS, `in flight for ${String(result.ms)} ms`);

    const { code } = await drain.exited;
    assert.equal(code, 0);
    assert.match(drain.output(), /SIGTERM: refusing new connections, draining in-flight requests/);
    assert.match(drain.output(), /drained, exiting 0/);
  } finally {
    if (drain.child.exitCode === null) drain.child.kill('SIGKILL');
  }
}, 30_000);

test('QA-A1: an uncaught exception outside any request logs a fixed marker and the class only, then the process exits 1', async () => {
  const crash = await boot();
  try {
    const res = await fetch(`${crash.base}/fault/uncaught`);
    assert.equal(res.status, 200);
    const { code } = await crash.exited;
    const out = crash.output();
    assert.deepEqual(
      {
        exitCode: code,
        marker: count(out, UNCAUGHT_MARKER),
        sentinelInLog: out.includes(SENTINEL),
        stackFrameInLog: /^\s+at\s/m.test(out),
      },
      { exitCode: 1, marker: 1, sentinelInLog: false, stackFrameInLog: false },
    );
  } finally {
    if (crash.child.exitCode === null) crash.child.kill('SIGKILL');
  }
}, 30_000);
