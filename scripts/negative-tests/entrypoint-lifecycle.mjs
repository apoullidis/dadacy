/**
 * scripts/negative-tests/entrypoint-lifecycle.mjs — T-180.
 *
 * WHAT THIS JUDGES. docker/app-runtime/entrypoint.mjs is PID 1 in every
 * application image. After it forwards a signal and its direct child exits,
 * it waits for the child's process group to empty, up to a deadline. These
 * cases pin WHERE THAT DEADLINE COUNTS FROM, and what happens when no signal
 * was forwarded at all:
 *
 *   L01  control — the group empties on its own condition, long before any
 *        deadline, and the application's status is reported.
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
fs.writeFileSync(
  path.join(fixture, 'app.js'),
  `const { spawn } = require('node:child_process');
const e = process.env;
let helper = null;
if (e.LC_HELPER === 'stubborn') helper = spawn(process.execPath, [__dirname + '/helper.js'], { stdio: 'inherit' });
console.error('app: pid=' + process.pid + ' helper=' + (helper ? helper.pid : 'none'));
if (e.LC_MODE === 'self-exit') {
  setTimeout(() => { console.error('app: exiting on its own with ' + e.LC_CODE); process.exit(Number(e.LC_CODE)); }, Number(e.LC_LIFE_MS));
} else {
  let n = 0;
  process.on('SIGTERM', () => {
    n += 1;
    if (n > 1) return void console.error('app: SIGTERM #' + n + ' ignored');
    console.error('app: SIGTERM #1, draining ' + e.LC_DRAIN_MS + ' ms');
    setTimeout(() => { console.error('app: drained, exit 0'); process.exit(0); }, Number(e.LC_DRAIN_MS));
  });
}
setInterval(() => {}, 1000);
`,
);

/**
 * Run one case. `signals` are ms offsets after boot at which SIGTERM is sent to
 * the entrypoint. Returns what was observed; judging is the caller's.
 */
function runCase(env, signals) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ep = spawn(process.execPath, [IMPL], {
      env: { ...process.env, KINVARA_APP: 'lc', KINVARA_APP_DIR: fixture, ...env },
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
        for (const off of signals) {
          timers.push(
            setTimeout(() => {
              if (firstSignalAt === null) firstSignalAt = Date.now();
              try {
                ep.kill('SIGTERM');
              } catch {
                /* already gone: judged below */
              }
            }, off),
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
        resolve({ code, sig, log, t0, bootAt, firstSignalAt, exitAt });
      }, 300);
    });
  });
}

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
];

const results = await Promise.all(cases.map((c) => runCase(c.env, c.signals)));
let bad = 0;
cases.forEach((c, i) => {
  const r = results[i];
  const problems = [];
  let verdict = 'OK';
  if (
    r.bootAt === null ||
    !/mode=real {2}running start \(node app\.js\) as a direct child/.test(r.log)
  ) {
    verdict = 'CRASH';
    problems.push('the app never booted in REAL mode on the argv path');
  } else if (r.sig === 'SIGKILL') {
    verdict = 'HUNG';
    problems.push(`no exit within ${String(2 * D + 20_000)} ms; the harness killed it`);
  } else {
    for (const re of c.landed)
      if (!re.test(r.log)) problems.push(`set-up did not land: ${String(re)} not in the log`);
    for (const re of c.absent ?? [])
      if (re.test(r.log)) problems.push(`${String(re)} appeared, and nothing should have sent it`);
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
fs.rmSync(fixture, { recursive: true, force: true });
console.log('');
if (bad === 0) console.log(`ALL ${String(cases.length)} CASES BEHAVED AS EXPECTED`);
else console.log(`!! ${String(bad)} of ${String(cases.length)} CASE(S) MISBEHAVED`);
process.exit(bad === 0 ? 0 : 1);
