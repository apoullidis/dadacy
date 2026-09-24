/**
 * scripts/negative-tests/entrypoint-lifecycle.mjs — T-180, extended by T-181.
 *
 * WHAT THIS JUDGES. docker/app-runtime/entrypoint.mjs is PID 1 in every
 * application image. After it forwards a signal and its direct child exits,
 * it waits for the child's process group to empty, up to a deadline. L01-L06 pin
 * WHERE THAT DEADLINE COUNTS FROM, and what happens when no signal was forwarded
 * at all; L07-L15 (T-181) pin WHAT IT REPORTS when the application dies by a
 * SIGNAL, WHAT IT SAYS while doing so, and the one cost of the deadline rule:
 *
 *   L01  control — the group empties on its own condition, long before any
 *        deadline, and the application's exit code is reported. (L01-L06 end the
 *        app by an EXIT CODE; the signal deaths are L07-L13.)
 *   L02  THE RED-BEFORE CASE (tech-lead TL-A1 on T-179): the app drains 8 s and
 *        exits, leaving a helper in its group. The deadline is the first
 *        forwarded signal + GROUP_DRAIN_MS, not the app's exit + GROUP_DRAIN_MS.
 *        Before T-180 this exited 8 s late — SIGKILLed at a 30 s grace in a
 *        container (137), with gate:app-images green.
 *   L03  the FIRST signal fixes the deadline: a second SIGTERM 6 s later does
 *        not move it.
 *   L04  the deadline does not cut the direct child short: an app still
 *        draining past it is waited for, and the wait then ends at once.
 *   L05  NO SIGNAL WAS FORWARDED and the app crashed (status 3) leaving a
 *        helper: PID 1 exits AT ONCE with 3 and does not wait. This is T-180's
 *        decision for that path, and it is the case that fails if the no-signal
 *        path ever reaches the wait — including through a null or NaN deadline,
 *        which would hang (reported HUNG, never OK).
 *   L06  the same for a normal completion (status 0).
 *   L07  SIGKILL -> 137, L08 SIGSEGV -> 139, L09 SIGQUIT -> 131,
 *   L10  SIGABRT -> 134: 128 + signo, one case per signal, on the path where no
 *        signal was forwarded. Each reported 130 before T-181 — one expression
 *        mapped every signal but SIGTERM to SIGINT's number — so each is RED
 *        against main 7411061 through KINVARA_ENTRYPOINT_IMPL below.
 *   L11  SIGTERM -> 143 and L12 SIGINT -> 130 are the CONTROLS: the two numbers
 *        the old expression already had right, which T-181 must not move.
 *   L17  SIGBUS -> 135 and L18 SIGHUP -> 129 (T-181 rework 1, QA-2): two signals
 *        OUTSIDE the six above. L07-L12 pin six numbers, not the rule — a
 *        literal six-entry table passed all of them, and so did one that
 *        defaulted every unlisted signal to 2 (the original defect). These two
 *        red against both (measured, T-181 § Rework 1). Their expected numbers
 *        are LITERALS from Linux's x86/ARM numbering (signal(7): SIGBUS 7,
 *        SIGHUP 1), deliberately not read from os.constants — that is the table
 *        the code under test reads, and a check must not share its source.
 *   L13  the OTHER path to the mapping, and the one that PRINTS: a forwarded
 *        SIGTERM, then a death by SIGKILL mid-drain with a helper still in the
 *        group -> 137, and PID 1 says the number IS the application's own. On
 *        the ARGV path that is true, and until T-181 it said the opposite.
 *   L14  the SHELL path, compound: `node app.js ; true`, so /bin/sh is the
 *        direct child (asserted: the app's parent is NOT the entrypoint). 143,
 *        and PID 1 says it does not know whose signal death that is.
 *   L16  the SHELL path where the shell is REPLACED by the application
 *        (T-181 rework 1, QA-1 / OD-209): `NODE_ENV=production exec node app.js`
 *        goes to /bin/sh -c (its first word contains `=`), and the shell execs,
 *        so the direct child IS the application (asserted: the app's parent IS
 *        the entrypoint). It dies by SIGKILL mid-drain -> 137, the app's own.
 *        Until rework 1 PID 1 said that 137 was "for the SHELL" — false here.
 *        WHY `exec` IS SPELLED OUT: busybox ash (the image's /bin/sh) execs
 *        `VAR=value cmd` by itself, but this suite runs in the toolbox, whose
 *        /bin/sh is dash 0.5.12, which does not (measured, T-181 § Rework 1).
 *        PID 1 sees only its direct child's pid and death, so the explicit
 *        `exec` gives it the identical view on any /bin/sh. The literal
 *        `VAR=value cmd` shape under ash is measured in the image, not here.
 *   L15  THE BOUND, pinned rather than described (tech-lead TL-1 on T-180): a
 *        signal the application SURVIVES fixes the deadline for a LATER stop, so
 *        a stop more than GROUP_DRAIN_MS after it gets NO group wait and a
 *        helper still draining is cut, at exit 0. T-181 measured the obvious fix
 *        (re-anchor on a signal arriving after the deadline) in the real image:
 *        it repairs this case and turns an app draining past the deadline under
 *        ONE stop into ExitCode=137 at the grace, which is what T-179/T-180
 *        exist to remove. This case is therefore the GUARD ON THE DECISION — it
 *        is red against a re-anchoring entrypoint (measured, T-181 § E8: 51605 ms
 *        and `helper: drained` printed) while every other case is green against
 *        that same variant, so nothing else here would catch the change.
 *
 * THE LINE PID 1 PRINTS, and which cases hold it. L13 (argv) asserts the
 * "which IS its own signal death" sentence and the shell-path sentence ABSENT;
 * L14 and L16 (shell path, one per topology) assert the reverse. The shell-path
 * sentence claims neither whose death it was nor that it was the shell's,
 * because PID 1 does not check whether the shell exec'd: L14 and L16 are the
 * two answers to that question and the SAME sentence must be true of both.
 *
 * WHAT IT DOES NOT JUDGE. It runs entrypoint.mjs as an ordinary process in
 * whatever container runs this suite, NOT as PID 1, so it does not reproduce a
 * zombie: an orphan here is reaped by someone else. The helpers are therefore
 * made to OUTLIVE the deadline (they ignore SIGTERM/SIGINT), so that "the group
 * is still non-empty at the deadline" holds whether or not anything reaps.
 * The zombie itself, and the container's exit code, are measured in the real
 * image in tasks/state/EP-1/T-180.md, not here.
 *
 * HARNESS-NO-OP CLASS (PROTOCOL §5.1). Every case asserts that what it set up
 * actually happened — the app booted in REAL mode, the signal (or signals)
 * reached it, the helper was started — before judging timing. A run that did
 * not boot is CRASH; a run that did not exit is HUNG; neither is ever OK.
 *
 * THE DIFFERENTIAL (the T-036 convention): KINVARA_ENTRYPOINT_IMPL=<path>
 * judges another copy of the entrypoint, e.g. the one at main 36a41d1:
 *   git show 36a41d1:docker/app-runtime/entrypoint.mjs > /tmp/ep-old.mjs
 *   ./scripts/dev env KINVARA_ENTRYPOINT_IMPL=/tmp/ep-old.mjs bash scripts/negative-tests/entrypoint-lifecycle.sh
 * (`env` inside scripts/dev, because scripts/dev does not forward the host's
 * environment — OD-62.) Nothing in this repository sets it; gate:pr does not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const IMPL = process.env.KINVARA_ENTRYPOINT_IMPL || 'docker/app-runtime/entrypoint.mjs';
const implText = fs.readFileSync(IMPL, 'utf8');
const drainHits = [
  ...implText.matchAll(/^[ \t]*const[ \t]+GROUP_DRAIN_MS[ \t]*=[ \t]*(\d[\d_]*);/gm),
];
if (drainHits.length !== 1) {
  console.log(
    `HARNESS ERROR: ${IMPL} has ${String(drainHits.length)} readable GROUP_DRAIN_MS lines`,
  );
  console.log('!! 1 of 0 CASE(S) MISBEHAVED; 1 HARNESS ERROR(S)');
  process.exit(2);
}
/** The wait's length, read from the file under test: these cases judge WHERE the
 *  deadline counts from, not its value — gate:app-images §7 holds the value. */
const D = Number((drainHits[0]?.[1] ?? '').replaceAll('_', ''));
const SLACK_MS = 2_500;
console.log(
  `entrypoint under test: ${IMPL} (sha256 ${crypto.createHash('sha256').update(implText).digest('hex').slice(0, 16)}), ` +
    `GROUP_DRAIN_MS ${String(D)} ms, timing slack +${String(SLACK_MS)} ms`,
);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvara-t180-'));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({ name: 'lc', private: true, scripts: { start: 'node app.js' } }),
);
fs.writeFileSync(
  path.join(fixture, 'helper.js'),
  `process.on('SIGTERM', () => console.error('helper: SIGTERM ignored'));
process.on('SIGINT', () => {});
console.error('helper: up');
setTimeout(() => process.exit(0), 120000);
`,
);
/**
 * A helper that DOES drain (T-181, L15). L02-L04's helper ignores every signal
 * so that the group is still non-empty at the deadline; L15 needs the opposite —
 * a helper whose drain can be seen to be CUT — so it is a second file rather
 * than a flag on the first, because changing the first would move L02's window.
 */
fs.writeFileSync(
  path.join(fixture, 'helper-draining.js'),
  `process.on('SIGINT', () => console.error('helper: SIGINT ignored'));
process.on('SIGTERM', () => {
  console.error('helper: SIGTERM, draining 4000 ms');
  setTimeout(() => { console.error('helper: drained'); process.exit(0); }, 4000);
});
console.error('helper: up');
setTimeout(() => process.exit(0), 120000);
`,
);
fs.writeFileSync(
  path.join(fixture, 'app.js'),
  `const { spawn } = require('node:child_process');
const e = process.env;
let helper = null;
if (e.LC_HELPER === 'stubborn') helper = spawn(process.execPath, [__dirname + '/helper.js'], { stdio: 'inherit' });
if (e.LC_HELPER === 'draining') helper = spawn(process.execPath, [__dirname + '/helper-draining.js'], { stdio: 'inherit' });
// ppid (T-181 rework 1): whether the app is the entrypoint's DIRECT child —
// i.e. whether a shell sits between them — is set-up for L13/L14/L16, and a
// case must see its set-up land before its verdict means anything.
console.error('app: pid=' + process.pid + ' helper=' + (helper ? helper.pid : 'none') + ' ppid=' + process.ppid);
// T-181: an app that SURVIVES a signal is the whole point of L15, so SIGINT is
// ignored on request rather than taking node's default death.
if (e.LC_IGNORE_INT === '1') process.on('SIGINT', () => console.error('app: SIGINT ignored'));
if (e.LC_MODE === 'self-exit') {
  setTimeout(() => { console.error('app: exiting on its own with ' + e.LC_CODE); process.exit(Number(e.LC_CODE)); }, Number(e.LC_LIFE_MS));
} else if (e.LC_MODE === 'self-signal') {
  // T-181: die by a SIGNAL, with NO signal forwarded to this process group —
  // the path that reports the app's own status. process.kill to self takes the
  // default action, because nothing here handles LC_SIG.
  setTimeout(() => { console.error('app: killing itself with ' + e.LC_SIG); process.kill(process.pid, e.LC_SIG); }, Number(e.LC_LIFE_MS));
} else if (e.LC_MODE === 'ignore') {
  process.on('SIGTERM', () => console.error('app: SIGTERM ignored, still working'));
} else {
  let n = 0;
  process.on('SIGTERM', () => {
    n += 1;
    if (n > 1) return void console.error('app: SIGTERM #' + n + ' ignored');
    console.error('app: SIGTERM #1, draining ' + e.LC_DRAIN_MS + ' ms');
    // T-181: LC_DIE_SIG turns the drain into a DEATH BY SIGNAL mid-drain, the
    // path that also prints the stderr line.
    setTimeout(() => {
      if (e.LC_DIE_SIG) { console.error('app: dying mid-drain by ' + e.LC_DIE_SIG); return void process.kill(process.pid, e.LC_DIE_SIG); }
      console.error('app: drained, exit 0');
      process.exit(0);
    }, Number(e.LC_DRAIN_MS));
  });
}
setInterval(() => {}, 1000);
`,
);
/**
 * THE SHELL PATH, as two more fixtures (T-181; the second is rework 1's).
 * `entrypoint.mjs` sends any start script that is not a simple command to
 * `/bin/sh -c`. What the direct child then IS depends on the shell:
 *   compound — `node app.js ; true`: the shell stays, the app is behind it (L14).
 *   varexec  — `NODE_ENV=production exec node app.js`: shell path (first word
 *              contains `=`), and the shell is replaced by the app, so the
 *              direct child IS the app (L16). See L16 in the header for why
 *              `exec` is spelled out rather than left to the shell.
 * PID 1 does not check which of the two it has, so its shell-path line must be
 * true of both — that is what L14 and L16 hold together.
 */
const START = {
  argv: 'node app.js',
  compound: 'node app.js ; true',
  varexec: 'NODE_ENV=production exec node app.js',
};
const fixtures = { argv: fixture };
for (const kind of ['compound', 'varexec']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kinvara-t181-${kind}-`));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `lc-${kind}`, private: true, scripts: { start: START[kind] } }),
  );
  for (const f of ['app.js', 'helper.js', 'helper-draining.js'])
    fs.copyFileSync(path.join(fixture, f), path.join(dir, f));
  fixtures[kind] = dir;
}
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Run one case. `signals` are ms offsets after boot at which SIGTERM is sent to
 * the entrypoint. Returns what was observed; judging is the caller's.
 */
function runCase(env, signals, kind = 'argv') {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ep = spawn(process.execPath, [IMPL], {
      env: {
        ...process.env,
        KINVARA_APP: 'lc',
        KINVARA_APP_DIR: fixtures[kind],
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let bootAt = null;
    let firstSignalAt = null;
    const timers = [];
    const onData = (b) => {
      log += String(b);
      if (bootAt === null && /app: pid=\d+/.test(log)) {
        bootAt = Date.now();
        for (const entry of signals) {
          // A bare number is a SIGTERM at that offset (T-180's five cases);
          // `{ at, sig }` names the signal, which T-181's L15 needs because the
          // regression it pins begins with a SIGINT the application survives.
          const { at, sig } = typeof entry === 'number' ? { at: entry, sig: 'SIGTERM' } : entry;
          timers.push(
            setTimeout(() => {
              if (firstSignalAt === null) firstSignalAt = Date.now();
              try {
                ep.kill(sig);
              } catch {
                /* already gone: judged below */
              }
            }, at),
          );
        }
      }
    };
    ep.stdout.on('data', onData);
    ep.stderr.on('data', onData);
    const hang = setTimeout(() => ep.kill('SIGKILL'), 2 * D + 20_000);
    ep.on('exit', (code, sig) => {
      const exitAt = Date.now();
      clearTimeout(hang);
      for (const t of timers) clearTimeout(t);
      // Whatever the entrypoint left behind is this harness's to remove: the
      // helper outlives the deadline by design, and ignores SIGTERM.
      const m = /app: pid=(\d+) helper=(\d+|none)/.exec(log);
      setTimeout(() => {
        for (const p of [m?.[1], m?.[2]]) {
          if (p === undefined || p === 'none') continue;
          for (const target of [-Number(p), Number(p)]) {
            try {
              process.kill(target, 'SIGKILL');
            } catch {
              /* gone */
            }
          }
        }
        const pp = /app: pid=\d+ helper=(?:\d+|none) ppid=(\d+)/.exec(log);
        const appPpid = pp ? Number(pp[1]) : null;
        resolve({ code, sig, log, t0, bootAt, firstSignalAt, exitAt, epPid: ep.pid, appPpid });
      }, 300);
    });
  });
}

/**
 * A NO-SIGNAL-FORWARDED signal death: the app kills itself with `sig` 1 s after
 * boot, and PID 1 must exit with `code`. Used by L07-L12 and L17-L18.
 *
 * ONE WINDOW FOR EVERY SIGNAL, 1000 + 2 * SLACK_MS (T-181 rework 1, QA-4). The
 * window's only job on this path is to exclude a hang or a group wait — no
 * helper is started, and the wait it would catch is GROUP_DRAIN_MS (25 000 ms)
 * long. The exit status is what is judged. Rework 0 gave the wide window to
 * SIGQUIT/SIGABRT only, on the ground that node's abort path is slower; QA then
 * measured SIGSEGV (L08, narrow window, ceiling 3500 ms) at 2113 ms on a head
 * run, and T-181 § E8's own pastes had it at 1195, 1218 and 1900 ms. Which
 * signals take node's slow path is not something this file can enumerate, so
 * every signal gets the window that still excludes the thing being guarded.
 * Readings are in tasks/state/EP-1/T-181.md § E8 and § Rework 1, per run.
 */
const selfSignalCase = ([id, sig, code, note = '']) => ({
  id,
  label: `NO signal forwarded, app dies by ${sig} -> ${String(code)}${note}`,
  env: {
    LC_MODE: 'self-signal',
    LC_SIG: sig,
    LC_LIFE_MS: '1000',
    LC_HELPER: 'none',
    LC_DRAIN_MS: '0',
  },
  signals: [],
  expect: { code, from: 'boot', min: 900, max: 1000 + 2 * SLACK_MS, deadlineLine: false },
  landed: [new RegExp(`app: killing itself with ${sig}`)],
});

/** The shell-path sentence, and the argv one, as each case must see them. */
const shellLine = (script, sig, n, signo) =>
  new RegExp(
    reEscape(
      `the direct child was ended by ${sig}; reporting ${String(n)} = 128 + ${String(signo)}, ` +
        `and waiting for its process group. It was started as /bin/sh -c (${script}), so it is ` +
        `either that shell or, if the shell exec'd, the start command itself; this process does ` +
        `not check which, so it does not say whose signal death ${String(n)} is`,
    ),
  );
const ARGV_CLAIM = /which IS its own signal death/;
const SHELL_CLAIM = /does not say whose signal death/;
/** Every spelling rework 0 printed on the shell path. Each asserted a fact PID 1
 *  does not have — "for the SHELL", "cannot see the application's own exit
 *  status" — and was false when the shell had exec'd (OD-209). */
const OLD_SHELL_CLAIMS = [/for the SHELL/, /cannot see the application's own exit status/];

const cases = [
  {
    id: 'L01',
    label: 'control: the group empties on its own (1 s drain, no helper)',
    env: { LC_MODE: 'drain', LC_DRAIN_MS: '1000', LC_HELPER: 'none' },
    signals: [500],
    expect: { code: 0, from: 'signal', min: 900, max: 1000 + SLACK_MS, deadlineLine: false },
    landed: [/app: SIGTERM #1/, /app: drained, exit 0/],
  },
  {
    id: 'L02',
    label: 'TL-A1: 8 s drain, helper left behind -> exit at signal + D',
    env: { LC_MODE: 'drain', LC_DRAIN_MS: '8000', LC_HELPER: 'stubborn' },
    signals: [500],
    expect: { code: 0, from: 'signal', min: D - 100, max: D + SLACK_MS, deadlineLine: true },
    landed: [/helper: up/, /app: SIGTERM #1/, /app: drained, exit 0/],
  },
  {
    id: 'L03',
    label: 'a second SIGTERM 6 s later does not move the deadline',
    env: { LC_MODE: 'drain', LC_DRAIN_MS: '8000', LC_HELPER: 'stubborn' },
    signals: [500, 6500],
    expect: { code: 0, from: 'signal', min: D - 100, max: D + SLACK_MS, deadlineLine: true },
    landed: [/helper: up/, /app: SIGTERM #1/, /app: SIGTERM #2 ignored/, /app: drained, exit 0/],
  },
  {
    id: 'L04',
    label: 'the app drains PAST the deadline: waited for, then no further wait',
    env: { LC_MODE: 'drain', LC_DRAIN_MS: String(D + 1500), LC_HELPER: 'stubborn' },
    signals: [500],
    expect: {
      code: 0,
      from: 'signal',
      min: D + 1400,
      max: D + 1500 + SLACK_MS,
      deadlineLine: true,
    },
    landed: [/helper: up/, /app: SIGTERM #1/, /app: drained, exit 0/],
  },
  {
    id: 'L05',
    label: 'NO signal, app crashes (3), helper left -> exit 3 at once',
    env: { LC_MODE: 'self-exit', LC_LIFE_MS: '1000', LC_CODE: '3', LC_HELPER: 'stubborn' },
    signals: [],
    expect: { code: 3, from: 'boot', min: 900, max: 1000 + SLACK_MS, deadlineLine: false },
    landed: [/helper: up/, /app: exiting on its own with 3/],
    absent: [/SIGTERM/],
  },
  {
    id: 'L06',
    label: 'NO signal, app completes (0), helper left -> exit 0 at once',
    env: { LC_MODE: 'self-exit', LC_LIFE_MS: '1000', LC_CODE: '0', LC_HELPER: 'stubborn' },
    signals: [],
    expect: { code: 0, from: 'boot', min: 900, max: 1000 + SLACK_MS, deadlineLine: false },
    landed: [/helper: up/, /app: exiting on its own with 0/],
    absent: [/SIGTERM/],
  },
  // ---------------------------------------------------------------- T-181
  // L07-L12: WHAT PID 1 REPORTS FOR A SIGNAL DEATH — 128 + signo, one case per
  // signal. Every one of L07-L10 reported 130 before T-181 (one expression,
  // `128 + (sig === 'SIGTERM' ? 15 : 2)`), so each is red against the entrypoint
  // at main 7411061 through KINVARA_ENTRYPOINT_IMPL. L11 and L12 are the
  // CONTROLS: SIGTERM and SIGINT are the two numbers the old expression already
  // had right, and they must not move — if a "fix" shifted them, T-151's and
  // T-180's published 143 and every grace argument built on it would be wrong.
  // These take the NO-SIGNAL-FORWARDED path, so they also confirm the mapping is
  // applied there and not only where the stderr line prints (L13).
  ...[
    ['L07', 'SIGKILL', 137],
    ['L08', 'SIGSEGV', 139],
    ['L09', 'SIGQUIT', 131],
    ['L10', 'SIGABRT', 134],
    ['L11', 'SIGTERM', 143, ' (control: unchanged)'],
    ['L12', 'SIGINT', 130, ' (control: unchanged)'],
  ].map(selfSignalCase),
  {
    // L13: THE OTHER PATH TO THE MAPPING, and the one that PRINTS. A forwarded
    // SIGTERM, then the app dies mid-drain by SIGKILL with a helper still in its
    // group: PID 1 waits to the deadline and reports 137. Before T-181: 130,
    // with the line claiming the number was not the application's own — on the
    // ARGV path, where the direct child IS the application. The line is asserted
    // here, not just the number, because the number alone would leave the
    // CONDITION (T-180 TL-5) untested.
    id: 'L13',
    label: 'forwarded SIGTERM, app dies mid-drain by SIGKILL, helper left -> 137',
    env: {
      LC_MODE: 'drain',
      LC_DRAIN_MS: '1000',
      LC_DIE_SIG: 'SIGKILL',
      LC_HELPER: 'stubborn',
    },
    signals: [500],
    expect: { code: 137, from: 'signal', min: D - 100, max: D + SLACK_MS, deadlineLine: true },
    directChild: true,
    landed: [/helper: up/, /app: dying mid-drain by SIGKILL/],
    asserts: [
      /the application itself \(the start command, node app\.js\) was ended by SIGKILL; reporting 137 = 128 \+ 9, which IS its own signal death/,
    ],
    absent: [SHELL_CLAIM, ...OLD_SHELL_CLAIMS],
  },
  {
    // L14: THE SHELL PATH, compound — the topology where the shell STAYS.
    // `node app.js ; true`, so the direct child is /bin/sh (asserted below: the
    // app's parent is not the entrypoint); SIGTERM kills the shell while the app
    // ignores it and holds the group open. 143, and PID 1 says it does not know
    // whose signal death that is — here it happens to be the shell's, and in L16
    // the same sentence is printed over the app's own. Rework 0 printed "for the
    // SHELL", true here and false in L16 (OD-209), so this case is red against
    // 69a276d as well as 7411061.
    //
    // THE PAIR IS SYMMETRIC ON PURPOSE. L13 asserts the argv sentence present
    // and the shell one absent; this case (and L16) asserts the reverse. Without
    // both absences, an entrypoint that printed BOTH lines would pass one of the
    // two, and "the line is per path" would be a claim one step wider than what
    // is held (PROTOCOL §5.1).
    id: 'L14',
    label: 'SHELL path, compound: SIGTERM kills /bin/sh -> 143, whose not said',
    env: { LC_MODE: 'ignore', LC_DRAIN_MS: '0', LC_HELPER: 'none' },
    signals: [500],
    fixture: 'compound',
    directChild: false,
    expect: { code: 143, from: 'signal', min: D - 100, max: D + SLACK_MS, deadlineLine: true },
    landed: [/app: SIGTERM ignored, still working/],
    asserts: [shellLine(START.compound, 'SIGTERM', 143, 15)],
    absent: [ARGV_CLAIM, ...OLD_SHELL_CLAIMS],
  },
  {
    // L15: THE BOUND, PINNED RATHER THAN DESCRIBED (T-181; tech-lead TL-1 on
    // T-180 measured it and routed it here). A SIGINT the app and helper both
    // SURVIVE fixes the deadline for a LATER stop: the stop arrives after
    // first-signal + GROUP_DRAIN_MS, so the group gets NO wait and the helper is
    // cut mid-drain, at exit 0, with nothing in the number saying so.
    //
    // THIS CASE EXISTS BECAUSE THE BEHAVIOUR IS DELIBERATE AND UNGUARDED.
    // T-181 measured the obvious fix — re-anchor on a signal that arrives after
    // the deadline — in the real image (§ E6, § E7 of tasks/state/EP-1/T-181.md):
    // it DOES repair this case (25.187 s, the helper drains) and it turns an app
    // draining past the deadline under ONE stop into ExitCode=137 at the grace
    // (30.162 s, against 27.110 s and exit 0 without it), the outcome T-179 and
    // T-180 exist to remove. So the behaviour is kept and pinned here instead: this
    // case goes RED against any entrypoint that re-anchors, which is exactly the
    // change a later ticket would make without knowing what it costs.
    id: 'L15',
    label: 'a SURVIVED SIGINT anchors a LATER stop: no group wait (the bound)',
    env: {
      LC_MODE: 'drain',
      LC_DRAIN_MS: '1000',
      LC_HELPER: 'draining',
      LC_IGNORE_INT: '1',
    },
    signals: [
      { at: 500, sig: 'SIGINT' },
      { at: D + 2000, sig: 'SIGTERM' },
    ],
    expect: {
      code: 0,
      from: 'signal',
      min: D + 2400,
      max: D + 2500 + SLACK_MS,
      deadlineLine: true,
    },
    landed: [/helper: up/, /app: SIGINT ignored/, /app: SIGTERM #1/, /app: drained, exit 0/],
    // The helper drains for 4 s from the SIGTERM and never gets to finish. Its
    // absence is the defect, and asserting the absence is what makes this a case
    // rather than a note.
    absent: [/helper: drained/],
  },
  {
    // L16: THE SHELL PATH WHERE THE SHELL IS GONE (T-181 rework 1, QA-1 /
    // OD-209). The start script's first word contains `=`, so it goes to
    // /bin/sh -c; the shell execs, so the direct child IS the application
    // (asserted: the app's parent is the entrypoint). A forwarded SIGTERM, then
    // death by SIGKILL mid-drain with a helper in the group -> 137, which is the
    // APPLICATION's own signal death. At 69a276d PID 1 said "/bin/sh -c (…) was
    // ended by SIGKILL … 137 … for the SHELL, because this process cannot see
    // the application's own exit status" — false on every clause, and the same
    // defect TL-5's CONDITION removed from the argv path. RED at 69a276d.
    // `exec` is spelled out because the toolbox's dash does not exec on its own
    // (header, L16); under the image's busybox ash `NODE_ENV=production node
    // app.js` gives PID 1 this same view, measured in the image.
    id: 'L16',
    label: "SHELL path, shell exec'd: app dies by SIGKILL -> 137, whose not said",
    env: {
      LC_MODE: 'drain',
      LC_DRAIN_MS: '1000',
      LC_DIE_SIG: 'SIGKILL',
      LC_HELPER: 'stubborn',
    },
    signals: [500],
    fixture: 'varexec',
    directChild: true,
    expect: { code: 137, from: 'signal', min: D - 100, max: D + SLACK_MS, deadlineLine: true },
    landed: [/helper: up/, /app: dying mid-drain by SIGKILL/],
    asserts: [shellLine(START.varexec, 'SIGKILL', 137, 9)],
    absent: [ARGV_CLAIM, ...OLD_SHELL_CLAIMS],
  },
  // L17-L18 (T-181 rework 1, QA-2): the rule, not a table. Numbers are Linux
  // x86/ARM literals (signal(7)); see the header for why they are not read from
  // os.constants.
  ...[
    ['L17', 'SIGBUS', 135, ' (outside the six)'],
    ['L18', 'SIGHUP', 129, ' (outside the six)'],
  ].map(selfSignalCase),
];

const results = await Promise.all(cases.map((c) => runCase(c.env, c.signals, c.fixture ?? 'argv')));
let bad = 0;
cases.forEach((c, i) => {
  const r = results[i];
  const problems = [];
  let verdict = 'OK';
  const kind = c.fixture ?? 'argv';
  const bootLine =
    kind === 'argv'
      ? /mode=real {2}running start \(node app\.js\) as a direct child/
      : new RegExp(`mode=real {2}running start via /bin/sh -c \\(${reEscape(START[kind])}\\)`);
  if (r.bootAt === null || !bootLine.test(r.log)) {
    verdict = 'CRASH';
    problems.push(`the app never booted in REAL mode on the ${kind} path`);
  } else if (r.sig === 'SIGKILL') {
    verdict = 'HUNG';
    problems.push(`no exit within ${String(2 * D + 20_000)} ms; the harness killed it`);
  } else {
    for (const re of c.landed)
      if (!re.test(r.log)) problems.push(`set-up did not land: ${String(re)} not in the log`);
    // T-181 rework 1: the process topology is set-up too. L16 means nothing if
    // a shell was still in between, and L14 means nothing if there was not.
    if (c.directChild !== undefined && (r.appPpid === r.epPid) !== c.directChild)
      problems.push(
        `set-up did not land: the app's parent is ${String(r.appPpid)}, the entrypoint is ${String(r.epPid)}; ` +
          `expected the app ${c.directChild ? 'to BE' : 'NOT to be'} the direct child`,
      );
    for (const re of c.absent ?? [])
      if (re.test(r.log)) problems.push(`${String(re)} appeared, and it should not have`);
    // T-181: what PID 1 ITSELF printed, kept apart from `landed` (the set-up) so
    // a failure says which of the two is wrong.
    for (const re of c.asserts ?? [])
      if (!re.test(r.log)) problems.push(`PID 1 did not print what this case holds: ${String(re)}`);
    const origin = c.expect.from === 'signal' ? r.firstSignalAt : r.bootAt;
    const elapsed = origin === null ? NaN : r.exitAt - origin;
    if (!(elapsed >= c.expect.min && elapsed <= c.expect.max)) {
      problems.push(
        `exited ${String(elapsed)} ms after the ${c.expect.from}, expected ${String(c.expect.min)}..${String(c.expect.max)}`,
      );
    }
    if (r.code !== c.expect.code)
      problems.push(`exit status ${String(r.code)}, expected ${String(c.expect.code)}`);
    const hasDeadline =
      /still alive \d+ms after the first forwarded signal|still alive after \d+ms/.test(r.log);
    if (hasDeadline !== c.expect.deadlineLine) {
      problems.push(
        `deadline line ${hasDeadline ? 'present' : 'absent'}, expected ${c.expect.deadlineLine ? 'present' : 'absent'}`,
      );
    }
    if (problems.length > 0) verdict = 'MISBEHAVED';
    r.elapsed = elapsed;
  }
  const mark = verdict === 'OK' ? '  ' : '!!';
  if (verdict !== 'OK') bad += 1;
  const origin = c.expect.from === 'signal' ? 'after 1st signal' : 'after boot';
  console.log(
    `${mark} ${c.id} ${c.label.padEnd(68)} exit=${String(r.code)} ${String(r.elapsed ?? '-')}ms ${origin}  ${verdict}`,
  );
  for (const p of problems) console.log(`       - ${p}`);
});
for (const dir of Object.values(fixtures)) fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (bad === 0) console.log(`ALL ${String(cases.length)} CASES BEHAVED AS EXPECTED`);
else console.log(`!! ${String(bad)} of ${String(cases.length)} CASE(S) MISBEHAVED`);
process.exit(bad === 0 ? 0 : 1);
