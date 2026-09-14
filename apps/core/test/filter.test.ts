/**
 * The problem+json filter's refusals, and the SIGTERM drain, against a REAL
 * process: `node test/fixtures/fault-server.ts` runs `src/server.ts` — the same
 * `createApp`, filter and drain `main.ts` runs — plus test-only throwing routes,
 * on 127.0.0.1. Its ENTIRE stdout and stderr are captured from process start, so
 * "absent from the log" is a statement about everything the process wrote.
 *
 * Why not against the container: producing (ii) and (iii) on demand needs a
 * route that throws a constructed value, and shipping one in the image would
 * invent an endpoint. `test/container.test.ts` exercises (i) in the container.
 *
 * The tests in this file run in order and share one server; the output test
 * stops it, so it comes after every request.
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

const SENTINEL = 'KINVARA-T135-SENTINEL-f1lter-9d4a';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fault-server.ts');

/** Written from OE-15 and toProblem's documented fallback, not read from the filter. */
const FIXED_500 = {
  type: 'https://errors.kinvara.cy/internal_error',
  title: 'Internal error',
  status: 500,
  code: 'internal_error',
  retryable: false,
};

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
  assert.deepEqual(body, {
    type: 'https://errors.kinvara.cy/invalid_input',
    title: 'Invalid input',
    status: 400,
    code: 'invalid_input',
    retryable: false,
  });
});

test('an unmatched route whose path is the sentinel answers the 404 not_found body', async () => {
  const res = await fetch(`${server.base}/v1/${SENTINEL}`);
  assert.equal(res.status, 404);
  const { text } = await problem(res);
  assert.equal(text.includes(SENTINEL), false);
});

test('the captured process output: the sentinel is ABSENT, no stack frame is logged, and each fixed marker IS present', async () => {
  server.child.kill('SIGTERM');
  const { code } = await server.exited;
  assert.equal(code, 0, 'the fault server drained and exited 0');
  const out = server.output();

  // Every observation at once, so a failure shows its whole shape rather than the first
  // assertion to trip. The marker counts are the anti-vacuity half: the capture is live
  // from process start and saw each path through the filter.
  assert.deepEqual(
    {
      captureLive: /listening on 127\.0\.0\.1:\d+/.test(out),
      toProblemThrewTypeError: count(out, `${LOG_MARKERS.toProblemThrew} class=TypeError`),
      toProblemThrewError: count(out, `${LOG_MARKERS.toProblemThrew} class=Error`),
      internalErrorError: count(out, `${LOG_MARKERS.internalError} class=Error`),
      internalErrorObject: count(out, `${LOG_MARKERS.internalError} class=object`),
      sentinelInLog: out.includes(SENTINEL),
      stackFrameInLog: /^\s+at\s/m.test(out),
      notFoundMessageInLog: /Cannot (GET|POST)/.test(out),
    },
    {
      captureLive: true,
      toProblemThrewTypeError: 1,
      toProblemThrewError: 1,
      internalErrorError: 1,
      internalErrorObject: 1,
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
