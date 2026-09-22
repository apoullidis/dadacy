/**
 * The client half of `scripts/verify/sigterm-drain.sh`: "<service> shuts down
 * cleanly on SIGTERM with no dropped in-flight request".
 *
 * Runs under `scripts/svc run`, i.e. ON the ticket's kinvara-int network, so it
 * reaches the service by compose service name on its default port. It cannot
 * send the signal itself — `svc run` has no Docker socket, by T-018's OD-16
 * ruling — so it hands off through marker files in the bind mount and the host
 * sends SIGTERM.
 *
 * Two assertions, because "exited cleanly" alone would pass for a process that
 * dropped the request and then exited 0:
 *   A. the in-flight request COMPLETES, with the expected status and a body,
 *      and completes AFTER the signal was sent;
 *   B. a NEW connection made after SIGTERM is REFUSED — the process stopped
 *      accepting rather than merely finishing.
 * The exit CODE and the elapsed time are asserted by the host, which is the
 * side that can see them.
 *
 * A third — "/readyz reports 503 while draining" — was written, measured, and
 * DELETED: with server.close() + closeIdleConnections() that branch cannot be
 * reached (fresh connection -> ECONNREFUSED; a request queued on the busy
 * keep-alive socket -> ECONNRESET at ms=4708). It was also, as first written, a
 * disjunction that B made true on its own, which is why it "passed" before
 * anyone looked. See docker/app-runtime/entrypoint.mjs.
 *
 * ============================================================================
 * THE IN-FLIGHT REQUEST IS A PARAMETER (T-151, decisions.md OD-101)
 * ============================================================================
 * It used to be hard-coded as `GET /__placeholder/slow?ms=6000`, a route only
 * `entrypoint.mjs`'s PLACEHOLDER serves. Against real `core` that returned
 * `status=404 ms=2` (T-135 § E10) and again `status=404 ms=6` here
 * (state/EP-1/T-151.md § Evidence 1), so assertion A failed whatever the app's
 * drain did, and the only way a real app could have passed was to ship a
 * `/__placeholder/slow` route — an invented endpoint.
 *
 * So the request now comes from `<dir>/request.json`, written by the shell from
 * its command line, in one of two SHAPES:
 *
 *   server-slow  the server is slow, and the client just waits. What the
 *                placeholder's `/__placeholder/slow?ms=` route is for.
 *   slow-body    THE CLIENT is slow: the request line, the headers and a
 *                Content-Length go out at once, then one byte of body, and the
 *                REST OF THE BODY IS WITHHELD UNTIL AFTER THE HOST HAS SENT
 *                SIGTERM. The server is mid-request-parse across the signal, so
 *                the window exists without the application owning a slow route.
 *                This is how a real app is judged.
 *
 * `slow-body` needs no cooperation from the application beyond a route that
 * reads a body, and the response it asserts is the application's real answer to
 * that request — for `core`, `POST /v1/auth/login` with `{}` is a 400
 * problem+json produced before anything touches a database.
 *
 * REFUSING RATHER THAN REPORTING A FALSE FAIL. If the shell was given no
 * request and `/healthz` says the service is in REAL mode, the placeholder
 * default cannot judge it — so this exits 2 and writes a `refused` marker, and
 * the shell reports REFUSED and never sends a signal. "Refused", "failed" and
 * "crashed" are three distinguishable outcomes (PROTOCOL §5.1).
 */
import fs from 'node:fs';
import net from 'node:net';

const DIR = process.env.KINVARA_DRAIN_DIR ?? '.sigterm-drain';

/** Written by sigterm-drain.sh before it starts this process. */
const spec = JSON.parse(fs.readFileSync(`${DIR}/request.json`, 'utf8'));
const HOST = spec.host;
const PORT = spec.port;

const refuse = (why) => {
  fs.writeFileSync(`${DIR}/refused`, why);
  console.log(`\nSIGTERM DRAIN REFUSED — ${why}`);
  process.exit(2);
};

const get = (path, timeout = 30000) =>
  new Promise((resolve) => {
    const started = Date.now();
    import('node:http').then(({ default: http }) => {
      const req = http.request({ host: HOST, port: PORT, path, timeout }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b, ms: Date.now() - started }));
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ error: 'TIMEOUT', ms: Date.now() - started });
      });
      req.on('error', (e) => resolve({ error: e.code ?? e.message, ms: Date.now() - started }));
      req.end();
    });
  });

const rawConnect = () =>
  new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT });
    s.setTimeout(4000);
    s.on('connect', () => {
      s.destroy();
      resolve('CONNECTED');
    });
    s.on('timeout', () => {
      s.destroy();
      resolve('TIMEOUT');
    });
    s.on('error', (e) => resolve(e.code ?? 'ERR'));
  });

/**
 * The `slow-body` shape, on a raw socket because no HTTP client will hold a
 * body open on demand. Returns a handle: `started` resolves once the headers
 * and the first body byte are on the wire, `finish()` releases the rest, and
 * `done` resolves with the parsed response.
 */
function slowBodyRequest({ method, path, body, headers }) {
  const payload = Buffer.from(body, 'utf8');
  const socket = net.connect({ host: HOST, port: PORT });
  const startedAt = Date.now();
  let raw = Buffer.alloc(0);
  let resolveStarted;
  let resolveDone;
  const started = new Promise((r) => (resolveStarted = r));
  const done = new Promise((r) => (resolveDone = r));

  const settle = (value) => resolveDone({ ...value, ms: Date.now() - startedAt });

  socket.on('data', (d) => (raw = Buffer.concat([raw, d])));
  socket.on('error', (e) => {
    resolveStarted();
    settle({ error: e.code ?? e.message });
  });
  socket.on('close', () => {
    const text = raw.toString('utf8');
    const split = text.indexOf('\r\n\r\n');
    if (split === -1) return void settle({ error: raw.length === 0 ? 'NO_RESPONSE' : 'TRUNCATED' });
    const head = text.slice(0, split);
    settle({
      status: Number(head.split(' ')[1]),
      headers: head,
      body: text.slice(split + 4),
    });
  });

  socket.on('connect', () => {
    const lines = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${HOST}:${String(PORT)}`,
      `Content-Length: ${String(payload.length)}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ];
    socket.write(lines.join('\r\n'));
    // One byte, so the server is parsing a body it has not finished receiving.
    socket.write(payload.subarray(0, 1));
    resolveStarted();
  });

  return {
    started,
    done,
    finish: () => socket.write(payload.subarray(1)),
  };
}

const out = { request: spec };
out.before_healthz = await get('/healthz');
console.log('baseline /healthz  ', JSON.stringify(out.before_healthz));

let mode;
try {
  mode = JSON.parse(out.before_healthz.body ?? '{}').mode;
} catch {
  mode = undefined;
}
out.mode = mode;

if (spec.defaulted && mode !== 'placeholder') {
  refuse(
    `${HOST} reports mode=${String(mode)}, and the default in-flight request ` +
      `(GET /__placeholder/slow) is served only by the placeholder runtime. ` +
      `Pass --path (and --body, for an app with no slow route) so the verifier judges THIS app. ` +
      `See scripts/verify/sigterm-drain.sh --help.`,
  );
}

console.log(
  `in-flight request     ${spec.shape}  ${spec.method} ${spec.path}` +
    (spec.body === null ? '' : `  body=${String(spec.body.length)}B`),
);

let inflight;
let release = null;
if (spec.shape === 'slow-body') {
  const handle = slowBodyRequest({
    method: spec.method,
    path: spec.path,
    body: spec.body,
    headers: spec.headers,
  });
  await handle.started;
  inflight = handle.done;
  release = handle.finish;
} else {
  inflight = get(spec.path);
  await new Promise((r) => setTimeout(r, 400)); // let it actually be in flight
}

fs.writeFileSync(`${DIR}/inflight`, String(Date.now()));
console.log('in-flight request started; waiting for the host to send SIGTERM');

// The host writes this the moment after `docker kill -s TERM`.
const deadline = Date.now() + 30000;
while (!fs.existsSync(`${DIR}/sigterm-sent`) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
out.sigterm_observed_at = Date.now();

await new Promise((r) => setTimeout(r, 1200));
out.new_connection_after_sigterm = await rawConnect();
console.log('new TCP connection    ', out.new_connection_after_sigterm);

// Only now is the rest of the body released: the server has been holding this
// request across the signal, which is the whole point of the shape.
if (release !== null) {
  release();
  console.log('rest of the body released after SIGTERM');
}

out.inflight = await inflight;
out.inflight_completed_at = Date.now();
console.log('in-flight result      ', JSON.stringify(out.inflight));

fs.writeFileSync(`${DIR}/result.json`, JSON.stringify(out, null, 2));

const bodyLength = typeof out.inflight.body === 'string' ? out.inflight.body.length : 0;
const okStatus = out.inflight.status === spec.expectStatus;
const okBody =
  bodyLength > 0 &&
  (spec.expectBodyContains === null || out.inflight.body.includes(spec.expectBodyContains));
const okAfter = out.inflight_completed_at > out.sigterm_observed_at;
const okHeld = spec.shape === 'slow-body' ? true : out.inflight.ms >= spec.holdMs;
const okA = okStatus && okBody && okAfter && okHeld;
const okB = out.new_connection_after_sigterm === 'ECONNREFUSED';

console.log(
  `\nA the in-flight request completed after SIGTERM, ${String(spec.expectStatus)} with a body   ` +
    `${okA ? 'PASS' : 'FAIL'}  (status=${String(out.inflight.status)} body=${String(bodyLength)}B ` +
    `ms=${String(out.inflight.ms)} after_signal=${String(okAfter)}` +
    (spec.expectBodyContains === null ? '' : ` contains=${String(okBody)}`) +
    (spec.shape === 'slow-body' ? '' : ` held>=${String(spec.holdMs)}ms=${String(okHeld)}`) +
    (out.inflight.error === undefined ? '' : ` error=${out.inflight.error}`) +
    ')',
);
if (bodyLength > 0) console.log(`  body: ${out.inflight.body}`);
console.log(
  `B a NEW connection after SIGTERM is refused                  ${okB ? 'PASS' : 'FAIL'}  (${out.new_connection_after_sigterm})`,
);
process.exit(okA && okB ? 0 : 1);
