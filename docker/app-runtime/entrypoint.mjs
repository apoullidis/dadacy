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
 *                -> run that command in the app directory, as this process's
 *                   own direct child, and forward signals to it (see
 *                   "DELIVERING THE SIGNAL" below).
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
 *
 * DELIVERING THE SIGNAL — WHY THERE IS NO `node --run` HERE (T-151, OD-100)
 * ------------------------------------------------------------------------
 * REAL mode used to run `node --run start`. `node --run` DOES NOT FORWARD
 * SIGTERM: it exits 143 and orphans its child un-signalled, so the
 * application was never asked to drain and, PID 1 having exited, the orphan
 * was killed with it. Measured on the real image at main 637640e
 * (state/EP-1/T-151.md § Evidence 1): the container exited 143 in 0.18 s and
 * `core`'s two drain lines never appeared in its log. NO `start` SCRIPT CAN
 * FIX THAT, because the signal dies above anything the app controls — which
 * is why the fix is here.
 *
 * Two mechanisms, and both are measured, not assumed:
 *
 *  1. THE APPLICATION IS THIS PROCESS'S DIRECT CHILD, BY CONSTRUCTION. A
 *     start script that is a simple command (`node src/main.ts`, `next
 *     start`) is spawned as argv with no shell and no `--run` in between, so
 *     `child.kill()` reaches the application itself. Anything a shell is
 *     actually needed for (a pipe, a `&&`, a redirect, a quote) goes to
 *     `/bin/sh -c` instead — see 2.
 *  2. THE CHILD LEADS ITS OWN PROCESS GROUP, AND THE SIGNAL GOES TO THE
 *     GROUP. `spawn(..., { detached: true })` makes the child a process-group
 *     leader; `process.kill(-pgid, sig)` then reaches every process in it,
 *     including a shell's grandchild. And after the direct child exits, this
 *     process WAITS FOR THE GROUP TO EMPTY before exiting, because PID 1
 *     exiting kills whatever is left.
 *
 *     That wait is not belt-and-braces. Measured in node:24.20.0-alpine: for
 *     a compound script, busybox ash does not exec its child, TAKES the
 *     forwarded SIGTERM itself and exits `sig=SIGTERM` while the application
 *     is still draining — 4 polls later the group was still alive and the app
 *     then exited 0. Without the wait, PID 1 would have exited first and
 *     killed it. For a simple command ash DOES exec, which is the second
 *     reason path 1 exists: it does not depend on that optimisation.
 *
 * WHAT THIS PROCESS CAN AND CANNOT REPORT. On path 1 the direct child is the
 * application, so its exit status IS the application's and a clean drain
 * shows up as `exit 0`. On path 2, if the shell is the one that dies on the
 * forwarded signal, this process cannot observe the application's own status;
 * it says so on stderr and exits 128+signum rather than inventing a 0.
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

/**
 * A start script this file may run WITHOUT a shell: a command word and plain
 * arguments, nothing a shell would have to interpret. Deliberately strict —
 * anything outside this character set goes to `/bin/sh -c`, so a misjudgement
 * can only ever fall back to the more general path, never the other way.
 */
const SIMPLE_COMMAND = /^[A-Za-z0-9_@.:/+=,-]+(?: [A-Za-z0-9_@.:/+=,-]+)*$/;

/** How long to wait for the child's process group to empty after forwarding a
 *  signal. Inside the 30 s `stop_grace_period` the app services declare in
 *  docker/compose.yml, so docker's SIGKILL is never what ends the wait. */
const GROUP_DRAIN_MS = 25_000;

// --- MODE SELECTION ---------------------------------------------------------
const pkgPath = path.join(APP_DIR, 'package.json');
let startScript;
try {
  startScript = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts?.start;
} catch {
  startScript = undefined;
}

if (typeof startScript === 'string' && startScript.trim() !== '') {
  runReal(startScript.trim());
} else {
  runPlaceholder();
}

// --- REAL MODE --------------------------------------------------------------
function runReal(script) {
  // What `node --run` supplied and a bare spawn does not: the workspace's and
  // the app's own bin directories, so a start script may name a binary
  // (`next start`) and not only an interpreter.
  const env = {
    ...process.env,
    PATH: [
      path.join(APP_DIR, 'node_modules', '.bin'),
      '/srv/kinvara/node_modules/.bin',
      process.env.PATH ?? '',
    ]
      .filter(Boolean)
      .join(':'),
  };

  const simple = SIMPLE_COMMAND.test(script);
  const [file, ...args] = simple ? script.split(' ') : ['/bin/sh', '-c', script];
  log(
    simple
      ? `mode=real  running start (${script}) as a direct child in ${APP_DIR}`
      : `mode=real  running start via /bin/sh -c (${script}) in ${APP_DIR}`,
  );

  const child = spawn(file, args, { cwd: APP_DIR, stdio: 'inherit', detached: true, env });

  child.on('error', (err) => {
    log(`could not start '${script}': ${err.code ?? err.message}, exiting 1`);
    process.exit(1);
  });

  let forwarded = null;
  // Forward, do not swallow. The child owns its own drain. The signal goes to
  // the GROUP so that a shell's grandchild gets it too; `child.kill` is the
  // fallback for the one case a group kill can fail (the group is already
  // gone), and it would be wrong to treat that as fatal.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      forwarded = sig;
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    });
  }

  child.on('exit', (code, sig) => {
    const status = sig !== null ? 128 + (sig === 'SIGTERM' ? 15 : 2) : (code ?? 1);
    if (forwarded === null) return void process.exit(status);
    if (sig !== null) {
      // The direct child was killed by the signal we forwarded. On the shell
      // path that is the shell, not the app, so this process must not claim
      // the app exited cleanly — and must not exit yet either.
      log(
        `the start command itself was ended by ${sig}; waiting for its process ` +
          `group, and reporting ${String(status)} because this process cannot see the application's own exit status`,
      );
    }
    waitForGroup(child.pid, status);
  });
}

/**
 * PID 1 exiting kills everything left in the container, so a drain that
 * outlives the direct child must outlive this process too. `kill(-pgid, 0)`
 * sends no signal; it throws ESRCH exactly when the group is empty.
 */
function waitForGroup(pgid, status) {
  const deadline = Date.now() + GROUP_DRAIN_MS;
  const poll = () => {
    try {
      process.kill(-pgid, 0);
    } catch {
      return void process.exit(status);
    }
    if (Date.now() >= deadline) {
      log(
        `process group ${String(pgid)} still alive after ${String(GROUP_DRAIN_MS)}ms, exiting anyway`,
      );
      return void process.exit(status);
    }
    setTimeout(poll, 100);
  };
  poll();
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
        done(200, {
          status: 'ok',
          app: APP,
          mode: 'placeholder',
          slept_ms: Date.now() - startedAt,
        });
      };
      wait();
      return;
    }

    return done(404, { status: 'not_found', app: APP, mode: 'placeholder' });
  });

  server.keepAliveTimeout = 5_000;
  server.listen(PORT, '0.0.0.0', () =>
    log(`mode=placeholder  listening on 0.0.0.0:${String(PORT)}`),
  );

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
    server.close(() => {
      if (!hardStop) finish();
    });
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
    fs.writeFileSync(
      HEARTBEAT,
      JSON.stringify({ app: APP, at: Date.now(), pid: process.pid, mode: 'placeholder' }),
    );
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
    setTimeout(() => {
      log('drained, exiting 0');
      process.exit(0);
    }, wait);
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
}
