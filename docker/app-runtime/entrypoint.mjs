/**
 * docker/app-runtime/entrypoint.mjs — PID 1 in every kinvara/* application
 * image (T-018).
 *
 * WHY THIS FILE EXISTS AT ALL
 * --------------------------
 * `apps/*` are T-001 topology placeholders: no `src/`, no dependencies, no
 * scripts. They belong to tech-lead (core, worker), T-012 (safety-gw) and
 * frontend-developer (web, admin), and platform-infrastructure does not write
 * application code (platform-infrastructure.md "You do not touch").
 *
 * But DOCKER.md §5 says a ticket's evidence is only honest when the app runs
 * AS ITS IMAGE, because the failures that matter — signal handling on
 * shutdown, DNS between services, file paths, env resolution, non-root
 * permissions — are invisible outside it. Those are properties of the IMAGE
 * and the ENTRYPOINT, not of the business logic, and they can be built and
 * proven now.
 *
 * So this file is the image's contract with the app, in two modes:
 *
 *   REAL         the app's package.json declares a `start` script
 *                -> exec `node --run start` in the app directory.
 *   PLACEHOLDER  it does not
 *                -> run the reference server/worker below, which implements
 *                   the same lifecycle contract.
 *
 * THE MODE IS DERIVED FROM package.json, NEVER CONFIGURED. An app moves from
 * placeholder to real by declaring `start`; there is no flag to forget to
 * flip. And `gate:app-images` fails if an app has a `src/` directory but no
 * `start` script — so an app cannot grow real source and keep running the
 * placeholder without the gate going red. (Left to a runtime conditional
 * alone, "still on the placeholder" is exactly the kind of thing that stays
 * true for six months.)
 *
 * PLACEHOLDER MODE IS SELF-DECLARING. /healthz answers with
 * `"mode": "placeholder"`, and the banner below goes to stderr on every boot.
 * Evidence produced against a placeholder says so in its own output; nobody
 * has to remember.
 *
 * THE LIFECYCLE CONTRACT — what a real `start` script must also honour
 * -------------------------------------------------------------------
 *   * SIGTERM: stop accepting new work, let in-flight work finish, exit 0.
 *     `docker stop` sends SIGTERM and waits `stop_grace_period` (30s for the
 *     app services) before SIGKILL. A process that ignores SIGTERM drops
 *     every in-flight request at deploy time.
 *   * The process must be PID 1's own child or PID 1 itself: a shell-form CMD
 *     puts /bin/sh at PID 1, and sh does not forward signals to its child.
 *     This file is exec'd directly for that reason.
 *   * A second SIGTERM means "stop waiting" and exits non-zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP = process.env.KINVARA_APP ?? 'unknown';
const KIND = process.env.KINVARA_APP_KIND ?? 'http';
const PORT = Number(process.env.PORT ?? '3000');
const APP_DIR = process.env.KINVARA_APP_DIR ?? `/srv/kinvara/apps/${APP}`;
const HEARTBEAT = process.env.KINVARA_HEARTBEAT ?? '/tmp/kinvara-heartbeat';

const log = (...a) => process.stderr.write(`[${APP}] ${a.join(' ')}\n`);

// --- REAL MODE --------------------------------------------------------------
const pkgPath = path.join(APP_DIR, 'package.json');
let startScript;
try {
  startScript = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts?.start;
} catch {
  startScript = undefined;
}

if (typeof startScript === 'string' && startScript.trim() !== '') {
  log(`mode=real  running 'node --run start' in ${APP_DIR}`);
  const child = spawn(process.execPath, ['--run', 'start'], {
    cwd: APP_DIR,
    stdio: 'inherit',
  });
  // Forward, do not swallow. The child owns its own drain.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('exit', (code, sig) => {
    process.exit(sig !== null ? 128 + (sig === 'SIGTERM' ? 15 : 2) : (code ?? 1));
  });
} else {
  runPlaceholder();
}

// --- PLACEHOLDER MODE -------------------------------------------------------
function runPlaceholder() {
  log('=======================================================================');
  log(`PLACEHOLDER RUNTIME. apps/${APP} declares no 'start' script, so this`);
  log('image is running the reference entrypoint, not application code.');
  log('It proves the IMAGE contract — non-root, healthcheck, SIGTERM drain —');
  log('and nothing about business behaviour. /healthz says so too.');
  log('=======================================================================');

  let shuttingDown = false;
  let hardStop = false;

  if (KIND === 'worker') return runWorkerPlaceholder();

  // In-flight accounting is the whole point: the drain must be observable.
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    inFlight += 1;
    const url = new URL(req.url ?? '/', `http://localhost:${String(PORT)}`);
    const done = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      inFlight -= 1;
      if (shuttingDown && inFlight === 0) finish();
    };

    if (url.pathname === '/healthz' || url.pathname === '/readyz') {
      // NO "503 while draining" BRANCH HERE, AND THE REASON IS MEASURED.
      // The obvious design is for /readyz to answer 503 once SIGTERM has
      // arrived, so a load balancer can deregister before the socket goes.
      // With this drain — server.close() plus closeIdleConnections() — THAT
      // BRANCH IS UNREACHABLE, and I wrote it before measuring:
      //   * a FRESH connection after SIGTERM gets ECONNREFUSED, so /readyz
      //     cannot be asked at all;
      //   * a request QUEUED on the one keep-alive socket already busy with
      //     the in-flight request gets ECONNRESET when that request finishes
      //     and the server closes (measured: ms=4708, ECONNRESET).
      // A branch nothing can reach is decoration, and asserting it would have
      // been a claim one step wider than the mechanism (PROTOCOL §5.1).
      // Draining IS reported — in the `draining` field below — for a request
      // that was already in flight when the signal arrived.
      //
      // The real question this raises is graceful DEREGISTRATION, which is a
      // load-balancer property: keep serving until the target group drops
      // you, then drain. That belongs to T-011 (blue/green via CodeDeploy),
      // not to a local compose image, and compose cannot prove it — it is a
      // T-019 parity-checklist item.
      return done(200, {
        status: 'ok',
        app: APP,
        mode: 'placeholder',
        kind: KIND,
        pid: process.pid,
        uid: process.getuid?.() ?? null,
        node: process.version,
        draining: shuttingDown,
      });
    }

    // The only reason this route exists: an in-flight request has to be
    // in flight WHILE SIGTERM arrives, or "no dropped request" is untestable.
    if (url.pathname === '/__placeholder/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? '1000'), 60_000);
      const startedAt = Date.now();
      // Re-arm until the deadline has genuinely passed. A single
      // setTimeout(ms) can fire up to a millisecond EARLY, so `slept_ms` came
      // back as 299 for a 300 ms request — and it did so on the toolbox run
      // and not on the container run, which is how scripts/verify/agree.sh
      // found it: a route that promises "at least ms" must not depend on the
      // timer being late.
      const wait = () => {
        const remaining = ms - (Date.now() - startedAt);
        if (remaining > 0) return void setTimeout(wait, remaining);
        done(200, { status: 'ok', app: APP, mode: 'placeholder', slept_ms: Date.now() - startedAt });
      };
      wait();
      return;
    }

    return done(404, { status: 'not_found', app: APP, mode: 'placeholder' });
  });

  server.keepAliveTimeout = 5_000;
  server.listen(PORT, '0.0.0.0', () => log(`mode=placeholder  listening on 0.0.0.0:${String(PORT)}`));

  const finish = () => {
    log(`drained: 0 in flight, exiting 0`);
    process.exit(0);
  };

  const drain = () => {
    if (shuttingDown) {
      hardStop = true;
      log('second signal — abandoning the drain, exiting 1');
      process.exit(1);
    }
    shuttingDown = true;
    log(`SIGTERM: refusing new connections, ${String(inFlight)} request(s) in flight`);
    // Stop accepting NEW connections; sockets already mid-request are kept.
    server.close(() => { if (!hardStop) finish(); });
    server.closeIdleConnections();
    if (inFlight === 0) finish();
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
}

function runWorkerPlaceholder() {
  // A worker has no port, so its liveness is a heartbeat file and its
  // healthcheck asserts freshness. That is the shape a real job runner has.
  let busyUntil = 0;
  let stopping = false;
  const tick = () => {
    fs.writeFileSync(HEARTBEAT, JSON.stringify({ app: APP, at: Date.now(), pid: process.pid, mode: 'placeholder' }));
  };
  tick();
  const timer = setInterval(tick, 2_000);
  log(`mode=placeholder  heartbeat -> ${HEARTBEAT}`);

  const drain = () => {
    if (stopping) process.exit(1);
    stopping = true;
    clearInterval(timer);
    const wait = Math.max(0, busyUntil - Date.now());
    log(`SIGTERM: finishing current unit (${String(wait)}ms), then exiting 0`);
    setTimeout(() => { log('drained, exiting 0'); process.exit(0); }, wait);
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
}
