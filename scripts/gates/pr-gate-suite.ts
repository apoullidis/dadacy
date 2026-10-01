/**
 * gate:pr-gate-suite — T-005's own negative suite, made blocking.
 *
 * `scripts/negative-tests/pr-gates.sh` is the evidence that the gates this
 * ticket added REFUSE things (PROTOCOL §5 item 4). OD-152's lesson is that a
 * committed negative suite nobody runs goes red on the trunk and stays there,
 * so this one is wired the same way the others are — blocking, on every PR,
 * with its case count pinned so a suite gutted to nothing cannot pass.
 *
 * WHY IT IS NOT A MEMBER OF `gate:negative-suites`, which would be the obvious
 * home. It ATTACKS that gate — including its exclusive lock (case B13) and its
 * dirty-tree refusal (case B14). Running it inside that gate means the lock is
 * already held and the tree is already being mutated when its cases run, so
 * every B case would be answered by the outer run rather than by the property
 * under test. Nesting a suite inside the thing it attacks makes both
 * untestable. It is therefore its own roster entry, executed after
 * `gate:negative-suites` has exited and released the lock.
 *
 * The judging is the same as `gate:negative-suites`': exit status, the footer,
 * and the case count against a pin — three readings, so that "did nothing",
 * "refused" and "crashed" stay distinguishable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, finish } from './lib/run.ts';

const SUITE = 'scripts/negative-tests/pr-gates.sh';
/** Raise this in the same change set that adds a case. */
const CASES = 74;

const failures: string[] = [];
const abs = path.join(REPO_ROOT, SUITE);
if (!fs.existsSync(abs)) finish('gate:pr-gate-suite', [`${SUITE} does not exist`]);

console.log(`$ bash ${SUITE}   (pinned at ${String(CASES)} cases)`);
const started = Date.now();
const r = spawnSync('bash', [abs], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
});
const secs = ((Date.now() - started) / 1000).toFixed(1);
if (r.error !== undefined)
  finish('gate:pr-gate-suite', [`could not execute ${SUITE}: ${r.error.message}`]);
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const code = r.status ?? 1;
process.stdout.write(out.endsWith('\n') || out === '' ? out : `${out}\n`);

const green = /^ALL ([0-9]+) CASES BEHAVED AS EXPECTED$/m.exec(out);
const red = /^!! ([0-9]+) of ([0-9]+) CASE\(S\) MISBEHAVED/m.exec(out);

if (green === null && red === null) {
  failures.push(
    `NO FOOTER after ${secs}s, exit ${String(code)}. Neither footer was printed, so this is a ` +
      'CRASH or a no-op, not a verdict (PROTOCOL §5.1).',
  );
} else if (red !== null) {
  failures.push(`RED: ${red[0]} (exit ${String(code)})`);
  if (Number(red[2]) !== CASES) {
    failures.push(`and the case count is ${String(red[2])}, not the pinned ${String(CASES)}`);
  }
} else if (green !== null) {
  const n = Number(green[1]);
  if (n !== CASES) {
    failures.push(
      `the footer reports ${String(n)} case(s); the pin is ${String(CASES)}. A case was added or ` +
        'deleted — re-verify the suite and update CASES in scripts/gates/pr-gate-suite.ts.',
    );
  }
  if (code !== 0) failures.push(`green footer but exit ${String(code)} — the two disagree`);
  if (failures.length === 0)
    console.log(`\n  ok  ALL ${String(n)} CASES BEHAVED AS EXPECTED, exit 0, ${secs}s`);
}

finish('gate:pr-gate-suite', failures);
