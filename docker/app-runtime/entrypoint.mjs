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
 *     `docker stop` sends SIGTERM and waits `stop_grace_period` before
 *     SIGKILL. docker/compose.yml declares `stop_grace_period: 30s` for all
 *     five application services (`web` and `admin` since T-179; before that
 *     they declared none and took compose's 10 s default — tech-lead TL-1 on
 *     T-151). That is not a coincidence to preserve by hand:
 *     gate:app-images §7 refuses any APPLICATION service — derived, not
 *     listed — whose grace, in any composed file, is below GROUP_DRAIN_MS
 *     (read from THIS file) plus a 5 s exit margin. Since T-180 that relation
 *     IS the property: the group wait's deadline is fixed at the FIRST
 *     FORWARDED SIGNAL (runReal), so if the application has exited by
 *     first-signal + GROUP_DRAIN_MS the wait ends there, however long the
 *     application took to drain (scripts/negative-tests/entrypoint-lifecycle.sh
 *     L02; an app still draining at the deadline is waited for, L04). Until T-180 it
 *     counted from the direct child's exit, and tech-lead measured an 8 s
 *     drain SIGKILLed (137) at a 30 s grace with the gate green (TL-A1 on
 *     T-179; red-before and green-after in state/EP-1/T-180.md). What the
 *     deadline does NOT bound is the application itself: an app still
 *     draining at the grace is SIGKILLed by docker, which is then true. A
 *     process that ignores SIGTERM drops every in-flight request at deploy
 *     time.
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
 *     actually needed for — a pipe, a `&&`, a redirect, a quote, and A
 *     LEADING VARIABLE ASSIGNMENT (`NODE_ENV=production next start`) — goes
 *     to `/bin/sh -c` instead. SIMPLE_COMMAND below is the exact line between
 *     the two, and it explains why the first word's character class is not
 *     the arguments' (T-151 rework 1, QA-F1).
 *  2. THE CHILD LEADS ITS OWN PROCESS GROUP, AND THE SIGNAL GOES TO THE
 *     GROUP. `spawn(..., { detached: true })` makes the child a process-group
 *     leader; `process.kill(-pgid, sig)` then reaches every process in it,
 *     including a shell's grandchild. And after the direct child exits, this
 *     process WAITS FOR THE GROUP TO EMPTY before exiting, because PID 1
 *     exiting kills whatever is left — but only if a signal was forwarded,
 *     and never past first-signal + GROUP_DRAIN_MS (T-180). If the
 *     application ends ON ITS OWN, with no signal forwarded, this process
 *     exits at once with `status` and does not wait (see child.on('exit')
 *     in runReal for why, and for what `status` is on a signal death).
 *
 *     That wait is not belt-and-braces. Measured in node:24.20.0-alpine: for
 *     a compound script, busybox ash does not exec its child, TAKES the
 *     forwarded SIGTERM itself and exits `sig=SIGTERM` while the application
 *     is still draining — 4 polls later the group was still alive and the app
 *     then exited 0. Without the wait, PID 1 would have exited first and
 *     killed it. For a simple command ash DOES exec, which is the second
 *     reason path 1 exists: it does not depend on that optimisation.
 *
 *     AND ON THAT SHELL PATH THE WAIT CANNOT END ON ITS OWN CONDITION. This
 *     is a standing bound, not a remote edge case (T-151 rework 1, QA-A1;
 *     re-measured in node:24.20.0-alpine, state/EP-1/T-151.md § Rework 1
 *     R1.5). Once ash dies on the forwarded signal the application is
 *     reparented to PID 1, and this process does not reap a child it never
 *     spawned — so the moment it finishes draining it becomes a ZOMBIE,
 *     `kill(-pgid, 0)` still SUCCEEDS on a zombie, and waitForGroup below
 *     therefore polls until the deadline — first forwarded signal +
 *     GROUP_DRAIN_MS — and exits 128+signum. So a CLEAN drain behind a true
 *     compound script keeps the container up until that deadline and reports
 *     143 every time. The deadline is inside the stop_grace_period all five
 *     application services declare, because gate:app-images §7 holds every
 *     grace at >= GROUP_DRAIN_MS + 5 s, reading the constant from this file
 *     and holding the one statement that uses it (T-179, T-180). The 143 is
 *     still a false crash signal. The application does drain.
 *
 *     THE ZOMBIE IS NOT ONLY A SHELL-PATH EFFECT (tech-lead TL-A1 on T-179):
 *     an application that spawns a helper into its group and exits without
 *     waiting for it leaves that helper to be reparented here and zombify, so
 *     the full wait runs ON THE ARGV PATH too, with no shell anywhere. Since
 *     T-180 that wait also ends at first-signal + GROUP_DRAIN_MS, so it is
 *     inside the grace however long the app drained, and on this path the
 *     status reported is the application's own (it is the direct child).
 *     Before T-180 the wait started when the APP exited, and an 8 s drain
 *     was SIGKILLed (137) at the 30 s grace after every process had logged a
 *     clean exit. Both readings, red at main 36a41d1 and green after, in the
 *     real image: state/EP-1/T-180.md § Evidence E1/E4. WHAT IS STILL LEFT,
 *     AND IS NOT T-180's: a zombie is still counted as alive, so a clean
 *     drain that leaves one keeps the container up until the deadline rather
 *     than exiting when the drain ends — and on the shell path reports 143.
 *     Reading /proc/<pid>/stat and treating state Z as gone would end both;
 *     it is a second mechanism change (OD-196's trigger). What IS bounded:
 *     `VAR=value cmd args` is not a compound script — ash execs it, so the
 *     direct child IS the application (measured, T-151 § Rework 1 R1.5) — and
 *     no app in this repository declares a compound start script.
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
 * arguments, nothing a shell would have to interpret.
 *
 * THE FIRST WORD'S CLASS OMITS `=`; THE ARGUMENTS' KEEPS IT, and that
 * asymmetry is the whole of the rule (T-151 rework 1, QA-F1). `--port=3000`
 * is a plain argument and a command word never legitimately contains `=`, but
 * `NODE_ENV=production next start` is a SHELL VARIABLE ASSIGNMENT — something
 * only a shell can perform. Until this rework `=` was in both classes, so
 * that script was classified simple and spawned as a file literally named
 * `NODE_ENV=production`: ENOENT, "could not start … exiting 1", and the
 * container never booted. That is the ordinary Next.js production start line,
 * which is to say `web`/`admin`'s likeliest one. Red-before / green-after in
 * the real image: state/EP-1/T-151.md § Rework 1 R1.2 and R1.3.
 *
 * WHAT IS AND IS NOT CLAIMED. Every character a shell would act on — `$`, a
 * backtick, `~`, `*`, `?`, `[`, `]`, `{`, `}`, `'`, `"`, `\`, `|`, `&`, `;`,
 * `<`, `>`, `(`, `)`, `#`, a tab, a double space — is outside BOTH classes,
 * and `=` is outside the first, so a script containing one takes the
 * `/bin/sh -c` path. Within these two classes there is nothing left for a
 * shell to interpret, so a misjudgement can only fall back to the more
 * general path, never the other way. THE CLAIM IS ABOUT THESE TWO CHARACTER
 * CLASSES, not about shells in general. What falsifies it is a classification
 * table over plausible start scripts, run against the regex copied out of
 * this file: § Rework 1 R1.1.
 */
const SIMPLE_COMMAND = /^[A-Za-z0-9_@.:/+,-]+(?: [A-Za-z0-9_@.:/+=,-]+)*$/;

/** How long after the FIRST FORWARDED SIGNAL this process may wait for the
 *  child's process group to empty (T-180). The deadline is fixed when that
 *  signal arrives, in the one statement in runReal that reads this constant;
 *  a later signal does not move it, and if no signal is ever forwarded there
 *  is no deadline and no wait. Until T-180 it counted from the direct child's
 *  exit instead (tech-lead TL-A1 on T-179).
 *
 *  EVERY APPLICATION SERVICE'S GRACE IS HELD ABOVE THIS NUMBER, BY A GATE THAT
 *  READS IT FROM HERE (T-179). gate:app-images §7 parses the one
 *  `const GROUP_DRAIN_MS = <literal>;` line below and refuses any application
 *  service — derived from apps/*, the built-by label, every application build
 *  and every service running one of their images, never a hand list — whose
 *  stop_grace_period in any composed file is below this + 5000 ms. At T-179:
 *
 *      core 30s    worker 30s    safety-gw 30s    web 30s    admin 30s
 *
 *  (at main 39f01f2 `web` and `admin` declared none and took compose's 10 s
 *  default — tech-lead TL-1 on T-151). So: RAISE THIS LITERAL AND THE GATE GOES
 *  RED until the graces move with it (negative case 148); write it as anything
 *  but one numeric literal and the gate refuses to guess (case 151). AND THE
 *  GATE HOLDS WHERE IT IS USED (T-180): it may be declared nowhere else — a
 *  same-named let/var/const in an inner scope would shadow it (cases 166-168,
 *  T-180 rework 1) — and the identifier may be used in code (counted in the syntax tree, so comments
 *  and strings do not count) exactly once, as `deadline = signalledAt +
 *  GROUP_DRAIN_MS;` in runReal — so a multiplier or an environment override
 *  there, a second use, or the deadline counted from Date.now() reds the gate
 *  (cases 156-159; QA-7's g02/g03 on T-179). §7 also finds THIS FILE from the
 *  ENTRYPOINT the image stage resolves (§6), not from a fixed path, so
 *  pointing app.Dockerfile at a copy reads the copy (case 161; g12), and an
 *  image ENTRYPOINT it cannot map is refused (cases 163-165). IT READS THE
 *  IMAGE's ENTRYPOINT, NOT THE CONTAINER's PID 1: a compose `entrypoint:` on a
 *  service replaces PID 1 and §7 does not read it, so a 60 s copy of this file
 *  run that way is green (qa-verification on T-180, QA-F3; the refusal is a
 *  separate ticket). Nor does it read a RUN that rewrites this file after the
 *  COPY, or a node flag's separate value taken for the script
 *  (`node --import <this> <copy>`). WHAT THE GATE GIVES, now
 *  that the deadline counts from the first forwarded signal: if the
 *  application has exited by the deadline, this process is gone within about
 *  one poll of first-signal + GROUP_DRAIN_MS, inside every application
 *  service's grace (scripts/negative-tests/entrypoint-lifecycle.sh L02). WHAT
 *  IT DOES NOT: that the application itself exits inside the grace. An app
 *  still draining at the deadline is waited for and this process exits with
 *  it (L04); if that is past the grace, docker's SIGKILL is the truthful
 *  outcome.
 *  scripts/verify/sigterm-drain.sh reads each container's real StopTimeout,
 *  and assertion D judges against that number. */
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

  // THE DEADLINE IS FIXED BY THE FIRST FORWARDED SIGNAL AND BY NOTHING ELSE
  // (T-180, from tech-lead's TL-A1 on T-179). Both stay null until a signal
  // arrives; the first one sets them; a second signal is forwarded but moves
  // neither. `deadline === null` is therefore also the one record of "was a
  // signal forwarded at all", so there is no second flag that could disagree
  // with it — and no path on which the wait runs against a null or NaN
  // deadline, because the only caller of waitForGroup is behind that check.
  let signalledAt = null;
  let deadline = null;
  // Forward, do not swallow. The child owns its own drain. The signal goes to
  // the GROUP so that a shell's grandchild gets it too; `child.kill` is the
  // fallback for the one case a group kill can fail (the group is already
  // gone), and it would be wrong to treat that as fatal.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (deadline === null) {
        signalledAt = Date.now();
        // THE ONE READ OF GROUP_DRAIN_MS. gate:app-images §7 holds this
        // statement's exact text (T-180), so scaling or overriding the wait
        // here reds the gate rather than changing it past the graces.
        deadline = signalledAt + GROUP_DRAIN_MS;
      }
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    });
  }

  child.on('exit', (code, sig) => {
    const status = sig !== null ? 128 + (sig === 'SIGTERM' ? 15 : 2) : (code ?? 1);
    // NO SIGNAL WAS FORWARDED: the application ended on its own — a crash or
    // a normal completion. Exit NOW, with `status` above, and do NOT wait for
    // its process group (T-180's decision; this is also what the code did
    // before T-180). `status` is the application's EXIT CODE when it exited;
    // when it died by a SIGNAL, the mapping above reports 143 for SIGTERM and
    // 130 for EVERY other signal — so an OOM SIGKILL or a SIGSEGV reads as
    // SIGINT (measured by qa-verification on T-180, QA-F2; the mapping is
    // T-018's, unchanged here, and its fix is a separate ticket). Nobody asked for a drain, so there is no deadline to count from
    // and no grace period running; waiting would only delay a restart by up
    // to GROUP_DRAIN_MS and hide the crash behind a quiet container. Anything
    // the application left in its group dies with this process, which is the
    // application's own choice: it exited without waiting for it. Falsified
    // by scripts/negative-tests/entrypoint-lifecycle.sh cases L05/L06.
    if (deadline === null) return void process.exit(status);
    if (sig !== null) {
      // The direct child was killed by the signal we forwarded. On the shell
      // path that is the shell, not the app, so this process must not claim
      // the app exited cleanly — and must not exit yet either.
      log(
        `the start command itself was ended by ${sig}; waiting for its process ` +
          `group, and reporting ${String(status)} because this process cannot see the application's own exit status`,
      );
    }
    waitForGroup(child.pid, status, signalledAt, deadline);
  });
}

/**
 * PID 1 exiting kills everything left in the container, so a drain that
 * outlives the direct child must outlive this process too. `kill(-pgid, 0)`
 * sends no signal; it throws ESRCH exactly when the group is empty.
 *
 * `deadline` was fixed when the FIRST signal was forwarded (runReal above), so
 * however long the direct child took to exit, this never waits past it — and
 * if the child exits after it, the first poll ends the wait. It does NOT cut
 * the direct child short: the wait only begins once the child has exited, and
 * an application still draining at the grace is docker's to SIGKILL, truthfully.
 */
function waitForGroup(pgid, status, signalledAt, deadline) {
  const poll = () => {
    try {
      process.kill(-pgid, 0);
    } catch {
      return void process.exit(status);
    }
    if (Date.now() >= deadline) {
      log(
        `process group ${String(pgid)} still alive ${String(Date.now() - signalledAt)}ms after ` +
          `the first forwarded signal (the deadline), exiting anyway`,
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
