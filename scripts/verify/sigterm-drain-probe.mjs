/**
 * T-018 — "core shuts down cleanly on SIGTERM with no dropped in-flight request".
 *
 * Runs under `scripts/svc run`, i.e. ON the ticket's kinvara-int network, so
 * it reaches core by compose service name on its default port. It cannot send
 * the signal itself — `svc run` has no Docker socket, by this ticket's own
 * OD-16 ruling — so it hands off through marker files in the bind mount and
 * the host sends SIGTERM.
 *
 * Two assertions, because "exited cleanly" alone would pass for a process
 * that dropped the request and then exited 0:
 *   A. the in-flight request COMPLETES with 200 and the full sleep;
 *   B. a NEW connection made after SIGTERM is REFUSED — the process stopped
 *      accepting rather than merely finishing.
 *
 * A third — "/readyz reports 503 while draining" — was written, measured, and
 * DELETED: with server.close() + closeIdleConnections() that branch cannot be
 * reached (fresh connection -> ECONNREFUSED; a request queued on the busy
 * keep-alive socket -> ECONNRESET at ms=4708). It was also, as first written,
 * a disjunction that B made true on its own, which is why it "passed" before
 * anyone looked. See docker/app-runtime/entrypoint.mjs.
 *
 * The exit CODE and the elapsed time are asserted by the host, which is the
 * side that can see them.
 */
import fs from 'node:fs';
import net from 'node:net';

const DIR = process.env.KINVARA_DRAIN_DIR ?? '.sigterm-drain';
const HOST = 'core';
const PORT = 3000;
const SLEEP_MS = 6000;

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

const out = {};
out.before_healthz = await get('/healthz');
console.log('baseline /healthz  ', JSON.stringify(out.before_healthz));

// Fire the long request and DO NOT await it yet.
const inflight = get(`/__placeholder/slow?ms=${String(SLEEP_MS)}`);
await new Promise((r) => setTimeout(r, 400)); // let it actually be in flight
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

out.inflight = await inflight;
console.log('in-flight result      ', JSON.stringify(out.inflight));

fs.writeFileSync(`${DIR}/result.json`, JSON.stringify(out, null, 2));

const okA = out.inflight.status === 200 && out.inflight.ms >= SLEEP_MS;
const okB = out.new_connection_after_sigterm === 'ECONNREFUSED';
console.log(
  `\nA in-flight request completed 200 after the full ${String(SLEEP_MS)}ms sleep   ${okA ? 'PASS' : 'FAIL'}  (status=${String(out.inflight.status)} ms=${String(out.inflight.ms)})`,
);
console.log(
  `B a NEW connection after SIGTERM is refused                  ${okB ? 'PASS' : 'FAIL'}  (${out.new_connection_after_sigterm})`,
);
process.exit(okA && okB ? 0 : 1);
