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
 *     status reported is the application's EXIT CODE (it is the direct
 *     child) — but a death by a signal is mapped, not passed through: since
 *     T-181 it is 128 + signo, so an app SIGKILLed mid-drain reports 137 and
 *     one that SIGSEGVs reports 139, where before T-181 both reported 130 and
 *     read as SIGINT (qa-verification on T-180, both paths; see WHAT THIS
 *     PROCESS CAN AND CANNOT REPORT below).
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
 * application, so its EXIT CODE is the application's and a clean drain shows
 * up as `exit 0`. A death by a SIGNAL is mapped, not passed through, and SINCE
 * T-181 the mapping is 128 + signo, read from `os.constants.signals` rather
 * than written here: 137 for SIGKILL, 139 for SIGSEGV, 134 for SIGABRT, and
 * 143/130 for SIGTERM/SIGINT as before. Until T-181 one expression gave 143 for
 * SIGTERM and 130 for EVERY other signal, so an OOM SIGKILL and a SIGSEGV both
 * reported 130 and read as SIGINT (qa-verification on T-180, QA-F2; the
 * expression was T-018's, d434296). ON PATH 1 THAT NUMBER IS THE
 * APPLICATION'S OWN, and the stderr line says so; on path 2, if the shell is
 * the one that dies on the forwarded signal, this process cannot observe the
 * application's own status, and the line says THAT instead. One sentence for
 * both paths was T-151's, and it was false on path 1 — the CONDITION tech-lead
 * attached to T-180's second approval (TL-5), closed with the mapping in one
 * commit because a correct number carrying "this is not the app's own" is worse
 * than the wrong number was.
 *
 * WHAT A SIGNAL DEATH STILL DOES NOT TELL YOU, so nobody reads more into the
 * number than it holds: 137 does not mean the OOM killer. `docker inspect` is
 * where that lives — a real memory-cgroup OOM kill reports OOMKilled=true
 * beside the 137, and V8's own heap OOM is not a cgroup event at all (it
 * aborts, so 134, with `FATAL ERROR … JavaScript heap out of memory` in the
 * log and OOMKilled=false). Measured both ways in the image, T-181 § Evidence.
 */
import fs from 'node:fs';
import os from 'node:os';
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
 *  WHAT "A LATER SIGNAL DOES NOT MOVE IT" COSTS, stated because T-180's text
 *  said it was true and not what it buys or spends (tech-lead TL-1 on T-180,
 *  measured, routed to T-181): A FORWARDED SIGNAL THE APPLICATION SURVIVES
 *  FIXES THE DEADLINE FOR ANY LATER STOP. A stop more than GROUP_DRAIN_MS after
 *  such a signal therefore gets NO group wait — this process exits within one
 *  poll of the application's own exit, and anything still draining in the group
 *  dies with it, at the application's exit code with nothing in the number
 *  saying work was cut. Measured in the container: a SIGINT both app and helper
 *  ignored, then `docker stop` 27 s later, exited in 1.11 s with `helper:
 *  drained` never printed, against 25.18 s for the identical pair without the
 *  earlier SIGINT (tech-lead on T-180; re-measured on T-181 as case L15, which
 *  PINS this behaviour so it cannot change in silence). IT IS NOT A DEFECT THIS
 *  FILE CAN FIX, and T-181 measured the candidate fix rather than arguing it:
 *  re-anchoring on a signal that arrives after the deadline has passed does
 *  repair this case, and it turns an app draining past the deadline under ONE
 *  stop into a container SIGKILLed at the grace — 137, the exact outcome T-179
 *  and T-180 exist to remove. PID 1 cannot tell the two apart, because it
 *  cannot know which signal the stopper is timing (T-181 § Published contract 3
 *  and § Evidence E7; tech-lead TL-1(c)). The three things this needs together:
 *  a non-SIGTERM stop signal reaching the container, an application that
 *  survives it while draining on SIGTERM, and a second live process in the
 *  group. T-012, T-148 and web/admin's first `start` are the tickets that
 *  supply the third (OD-196's widened trigger).
 *
 *  EVERY APPLICATION SERVICE'S GRACE IS HELD ABOVE THIS NUMBER, BY A GATE THAT
 *  READS IT FROM HERE (T-179). gate:app-images §7 reads the ONE TOP-LEVEL
 *  `const GROUP_DRAIN_MS` DECLARATION below — the declaration this code uses,
 *  in the syntax tree, not a line a text match finds (T-182's D13: a line
 *  match could read a COMMENTED copy and hold the graces against a number
 *  nothing runs, measured with the gate green) — and refuses any application
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
 *  image ENTRYPOINT it cannot map is refused (cases 163-165). AND SINCE T-182
 *  IT READS WHAT PID 1 ACTUALLY RUNS FOR EACH APPLICATION SERVICE, not only
 *  the image's ENTRYPOINT: a compose `entrypoint:`/`command:` (list or string),
 *  `init: true`, `working_dir:`, a mount over this path (`volumes:`,
 *  `configs:`, `secrets:`, `tmpfs:`), a NODE_OPTIONS preload from compose or
 *  from this image's own ENV, a node flag that loads code or takes a separate
 *  value, `env_file:`, a RUN that rewrites this file after its COPY, an ADDed
 *  archive, and a `stop_signal:` this process installs no handler for are each
 *  REFUSED, with a case apiece (cases 169-192; for the refusal/control split run the
 *  run_case instrument named below over that range instead — OD-207). Every one of
 *  those was GREEN before T-182 EXCEPT a flag taking a separate value, which
 *  was already refused for a different reason (it could not be mapped to a
 *  repository file) and is now refused as the flag it is. And the first was not
 *  theoretical: one compose line made a 60 s copy of this file `core`'s real
 *  PID 1 (qa-verification on T-180, QA-F3).
 *  AND SINCE T-182's REWORK 1 IT ALSO HOLDS THE OTHER QUESTION — not "which
 *  file does node run" but "IS THIS PROCESS PID 1 AT ALL, and what is loaded
 *  into it". qa-verification reached the same hazard as `init: true` through
 *  `pid: host` (MEASURED: /proc/1/comm = `systemd`, so this file is not PID 1,
 *  and SIGQUIT then ended the container at ExitCode=131 in 2.19 s with NO
 *  drain, against still running at 36.36 s without it) and through
 *  `LD_PRELOAD` (MEASURED: five mappings of the named object inside PID 1's own
 *  address space), both at gate exit 0. Those are two spaces and they got two
 *  DIFFERENT shapes, which rework 2 had to say out loud because rework 1's text
 *  called them both allow-lists:
 *    * the compose KEY space is an ALLOW-LIST (§7c). An application service may
 *      declare only the keys §7c classifies, so a key NOBODY HAS NAMED reds the
 *      gate — case 196 plants one, and the orchestrator independently planted
 *      `userns_mode:` and got exit=1, GATE FAIL, 11 of 14. `pid:`, `user:` and
 *      `pull_policy: always` are refused as members of the class rather than as
 *      entries on a list (cases 193-206. THE REFUSAL/CONTROL SPLIT IS NOT
 *      WRITTEN HERE, and that is OD-207: a hand-written count beside a live
 *      literal is a defect on sight, whether or not it is currently correct —
 *      this one said "TEN refusals and FOUR controls" until 2026-09-23 and was
 *      wrong. The instrument is the suite's own run_case verdicts:
 *      `grep -oE 'run_case "(19[3-9]|20[0-6]) [^"]*" (PASS|FAIL)'
 *      scripts/negative-tests/app-images.sh | awk '{print $NF}' | sort |
 *      uniq -c`. Eight of them, all inside 193-202, were GREEN at T-182's
 *      first head `e1e5bfa` — a PAST state at a NAMED commit, measured by the
 *      KINVARA_GATE_IMPL differential in state/EP-1/T-182.md § Rework 1 D,
 *      which is the R1 register and not a sibling of a literal);
 *    * the ENVIRONMENT space is a DENY-LIST (§7d), and a variable name outside
 *      it is ADMITTED WITHOUT BEING READ. Rework 1 listed four namespaces
 *      (`LD_*`/`DYLD_*`/`NODE_*`, plus `PATH`) and called the class closed; the
 *      orchestrator then defeated that with `OPENSSL_CONF` inside `core`'s own
 *      `environment:` block, at gate exit 0 with `14 of 14` printed as resolved
 *      (OE-44). Rework 2 WIDENED the deny-list by measuring which names load
 *      code into THIS process in the shipping images — node links OpenSSL 3.5.7
 *      statically, and an `OPENSSL_CONF` naming a `providers` module under the
 *      `nodejs_conf` app section dlopens it: with a real .so, PID 1 dies in
 *      node::InitializeOncePerProcessInternal (SIGABRT, container ExitCode=139)
 *      instead of starting the app. So `OPENSSL_*` joins the namespaces and
 *      `SSL_CERT_FILE`/`SSL_CERT_DIR`/`CTLOG_FILE` join the exact names
 *      (cases 207-211). **`T-183` is the successor that replaces this
 *      deny-list with an allow-list anchored to a checked per-app manifest, and
 *      until it lands a green run means "no variable in a MEASURED loader
 *      namespace", never "no variable that can load code".**
 *  WHAT THE GATE GIVES, now
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
  //
  // THESE TWO SIGNALS AND NO OTHERS, AND THAT IS NOW AN ASSERTED PROPERTY
  // (T-182). This process is a namespace init, so a signal it installs no
  // handler for is IGNORED: with `stop_signal: SIGQUIT` nothing is forwarded,
  // the application never drains, and docker SIGKILLs at the grace —
  // ExitCode=137 at 30.13 s, measured in a container (qa-verification on
  // T-180, X1). gate:app-images §7 therefore REFUSES a `stop_signal:` on an
  // application service that is not SIGTERM or SIGINT (case 181; its control,
  // 182, is SIGTERM). Teaching this process to forward any stoppable signal
  // instead is a change to PID 1 in kinvara/safety-gw:dev — two approvals and
  // container evidence — and is routed rather than taken here (T-182
  // § Published contract § Routed).
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
    // A SIGNAL DEATH IS REPORTED AS 128 + signo, THE NUMBER EVERY SHELL, DOCKER
    // AND ORCHESTRATOR ALREADY READS (T-181). Until T-181 this was one
    // expression — `128 + (sig === 'SIGTERM' ? 15 : 2)` — so SIGTERM gave 143
    // and EVERY OTHER SIGNAL gave 130, which reads as SIGINT: an OOM SIGKILL
    // and a SIGSEGV both arrived as "someone pressed Ctrl-C" (qa-verification
    // on T-180, QA-F2; the expression was T-018's, d434296).
    //
    // THE NUMBER IS NOT WRITTEN DOWN HERE. `os.constants.signals` is node's own
    // table for THIS platform, so SIGKILL is 9 because node says so and not
    // because a literal in this file says so — the alternative, a hand-kept
    // name->number map beside the handlers, is the OD-207 shape (a value a
    // reader must re-derive by hand, next to the thing that has it already).
    //
    // WHY 128 + signo IS THE RIGHT CHOICE HERE, decided on measurement and not
    // on convention (T-181 § Published contract 1): docker reports PID 1's own
    // signal death as 128 + signo itself (its SIGKILL at the grace is 137, with
    // nothing in this file involved), so any OTHER number for the SAME death of
    // the direct child would make the two disagree inside one container. And
    // nothing in this repository decides on the value: no consumer reads it.
    // SIGTERM (143) and SIGINT (130) are unchanged by this mapping, which is
    // why T-151's and T-180's published 143s still hold.
    //
    // THE UNMAPPABLE CASE IS SAID OUT LOUD, not defaulted. `sig` comes from
    // node's own signal table, so a name that table cannot number is not
    // reachable from a real signal — but 128 + undefined is NaN, and
    // `process.exit(NaN)` exits 0, which is the one outcome that must never
    // come out of a signal death. So it is 128 with a log line, and "did
    // nothing" is distinguishable from "refused" (PROTOCOL §5.1).
    const signo = sig === null ? null : (os.constants.signals[sig] ?? null);
    if (sig !== null && signo === null) {
      log(`the start command was ended by ${sig}, which this node cannot number; reporting 128`);
    }
    const status = sig !== null ? 128 + (signo ?? 0) : (code ?? 1);
    // NO SIGNAL WAS FORWARDED: the application ended on its own — a crash or
    // a normal completion. Exit NOW, with `status` above, and do NOT wait for
    // its process group (T-180's decision; this is also what the code did
    // before T-180). `status` is the application's EXIT CODE when it exited;
    // when it died by a SIGNAL it is 128 + signo (T-181), so a SIGKILL is 137
    // and a SIGSEGV is 139 — each distinguishable, where until T-181 every
    // signal but SIGTERM was flattened to 130 and read as SIGINT (measured by
    // qa-verification on T-180, QA-F2). Nobody asked for a drain, so there is no deadline to count from
    // and no grace period running; waiting would only delay a restart by up
    // to GROUP_DRAIN_MS and hide the crash behind a quiet container. Anything
    // the application left in its group dies with this process, which is the
    // application's own choice: it exited without waiting for it. Falsified
    // by scripts/negative-tests/entrypoint-lifecycle.sh cases L05/L06.
    if (deadline === null) return void process.exit(status);
    if (sig !== null) {
      // THE LINE IS PER PATH, BECAUSE THE TRUTH IS PER PATH (T-181, the
      // CONDITION tech-lead attached to T-180's second approval, TL-5). Until
      // T-181 there was one sentence — "reporting N because this process cannot
      // see the application's own exit status" — and on the ARGV path it is
      // false: the direct child IS the application (`simple` is what chose that
      // path, thirty lines up), so its signal death IS the application's own
      // status and 137 IS the number to act on. Saying otherwise told an
      // operator to discard the one true number this process has. On the SHELL
      // path the sentence is right and stays, because the child that died is
      // /bin/sh and the application's own status is behind it.
      log(
        simple
          ? `the application itself (the start command, ${script}) was ended by ${sig}; ` +
              `reporting ${String(status)} = 128 + ${String(signo ?? 0)}, which IS its own ` +
              `signal death, and waiting for its process group`
          : `the start command itself — /bin/sh -c (${script}) — was ended by ${sig}; waiting ` +
              `for its process group, and reporting ${String(status)} = 128 + ${String(signo ?? 0)} ` +
              `for the SHELL, because this process cannot see the application's own exit status`,
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
