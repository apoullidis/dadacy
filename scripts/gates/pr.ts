/**
 * gate:pr — the local PR aggregate (PROTOCOL.md §5.1, SD §QD-4 PR row).
 *
 * There is no CI service and there never will be. This command IS the PR gate.
 *
 * The gate list is no longer written here. It is `scripts/gates/lib/roster.ts`,
 * which also holds SD §QD-4's PR row as quoted text, and this program refuses
 * to pass if the two diverge. Adding a name to the roster is how a gate becomes
 * blocking; there is still no other switch, but now REMOVING one is refused too.
 *
 * What this program asserts, beyond "did each gate exit 0":
 *
 *   1. THE ROSTER COVERS THE SPEC. Every semicolon-separated item of SD §QD-4's
 *      PR row has at least one roster entry. A gate cannot go missing; it can
 *      only change class, and every non-BLOCKING class must name an owner and
 *      the exact condition that makes it green (roster.ts `rosterProblems`).
 *   2. EVERY ROSTERED GATE IS EXECUTED. Including the ones nobody expects to
 *      pass. "Not yet supplied" is a RESULT here, produced by running the
 *      command, not a row in a table that stopped being true.
 *   3. THE OUTCOME MATCHES THE DECLARED CLASS. A PENDING hook that starts
 *      exiting 0 fails this gate: its owner supplied it and nobody promoted it.
 *      A PENDING hook that fails without the `GATE NOT YET SUPPLIED` banner
 *      fails this gate too — refused, crashed and not-yet-supplied must stay
 *      three distinguishable outcomes (PROTOCOL §5.1).
 *   4. IT CANNOT PASS VACUOUSLY. Zero gates executed, or a BLOCKING population
 *      of zero, is a FAIL — not a green run over an empty list. That is the
 *      Trivy zero-package defect and OD-3, and it is asserted here as well as
 *      inside the gates that can suffer it.
 */
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, capture } from './lib/run.ts';
import { ROSTER, SPEC_PR_ROW, PROGRAMME, rosterProblems } from './lib/roster.ts';
import type { RosterEntry } from './lib/roster.ts';

const RULE = '='.repeat(78);

/**
 * The floor on BLOCKING gates — a RATCHET, not a guess. It is the number this
 * aggregate had when the floor was last raised; demoting or deleting one fails
 * the aggregate. Adding a gate does not, so the correct move when you add one
 * is to raise this number in the same change set. Anti-vacuity: header note 4.
 */
const MIN_BLOCKING = 21;

/**
 * Two flags, and they exist so this program can be ATTACKED cheaply rather than
 * only observed passing. A full run is over six minutes (the negative suites
 * are 75% of it), which is long enough that nobody would write forty cases
 * against it — and a gate nobody attacks is a gate whose coverage is unknown
 * (PROTOCOL §5.1: "I had run the check; I had not tried to get past it").
 *
 *   --roster-only   the roster/spec/vacuity checks alone. Runs no gate.
 *   --only=<name>   execute exactly one rostered gate and judge it against its
 *                   declared class. The roster checks still run.
 *
 * Neither weakens the default: `pnpm gate:pr` passes neither, and both PRINT
 * what they did, so a pasted run cannot be mistaken for a full one.
 */
const argv = process.argv.slice(2);
const rosterOnly = argv.includes('--roster-only');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg?.slice('--only='.length);

interface Outcome {
  readonly entry: RosterEntry;
  readonly code: number;
  /** '' when the gate's output went straight to the terminal. */
  readonly text: string;
}

const outcomes: Outcome[] = [];

function runStreamed(entry: RosterEntry): Outcome {
  const r = spawnSync('pnpm', ['run', '--silent', entry.name], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  const code = r.error !== undefined ? 127 : (r.status ?? 1);
  return { entry, code, text: '' };
}

function runCaptured(entry: RosterEntry): Outcome {
  const r = capture('pnpm', ['run', '--silent', entry.name]);
  const text = `${r.stdout}${r.stderr}`;
  process.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`);
  return { entry, code: r.spawnFailed ? 127 : r.code, text };
}

// --------------------------------------------------------------- 1. the roster
const failures: string[] = [];
for (const p of rosterProblems()) failures.push(`roster: ${p}`);

console.log(`${RULE}\n== gate:pr — the roster, held against SD §QD-4's PR row\n${RULE}`);
console.log(`  SD §QD-4 PR row items: ${String(SPEC_PR_ROW.length)}`);
for (const item of SPEC_PR_ROW) {
  const answering = ROSTER.filter((e) => e.spec === item).map((e) => e.name);
  console.log(`    ${item}`);
  console.log(
    `      -> ${answering.length === 0 ? 'NOTHING — this is a FAIL' : answering.join(', ')}`,
  );
}
const programme = ROSTER.filter((e) => e.spec === PROGRAMME).map((e) => e.name);
console.log(`  gates this build added that SD §QD-4 does not name: ${programme.join(', ')}`);

// ------------------------------------------------------------- 2. run them all
if (rosterOnly) console.log('\n--roster-only: NO GATE WAS EXECUTED. Roster checks only.');
if (only !== undefined) {
  console.log(`\n--only=${only}: ONE gate executed. This is not a full gate:pr run.`);
  if (!ROSTER.some((e) => e.name === only)) {
    failures.push(`--only=${only} names no roster entry`);
  }
}
const toRun = rosterOnly ? [] : ROSTER.filter((e) => only === undefined || e.name === only);

for (const entry of toRun) {
  console.log(`\n${RULE}\n== ${entry.name}  [${entry.cls}] — ${entry.why}\n${RULE}`);
  if (entry.owner !== undefined) console.log(`   owed by: ${entry.owner}`);
  if (entry.unblocks !== undefined) console.log(`   goes green when: ${entry.unblocks}\n`);
  outcomes.push(entry.cls === 'BLOCKING' ? runStreamed(entry) : runCaptured(entry));
}

// ---------------------------------------------------- 3. judge against the class
const NOT_SUPPLIED = 'GATE NOT YET SUPPLIED';

for (const o of outcomes) {
  const { entry, code, text } = o;
  switch (entry.cls) {
    case 'BLOCKING':
      if (code !== 0) failures.push(`${entry.name} FAILED (exit ${String(code)})`);
      break;
    case 'PENDING':
    case 'SERVICE':
      if (code === 0) {
        failures.push(
          `${entry.name} is rostered ${entry.cls} but EXITED 0 — ${entry.owner ?? 'its owner'} has supplied it and nobody promoted it to BLOCKING. Move it in scripts/gates/lib/roster.ts.`,
        );
      } else if (!text.includes(NOT_SUPPLIED)) {
        failures.push(
          `${entry.name} is rostered ${entry.cls} and exited ${String(code)} WITHOUT the "${NOT_SUPPLIED}" banner — a crash and a not-yet-supplied hook must not look the same (PROTOCOL §5.1).`,
        );
      }
      break;
    case 'BLOCKED':
      if (code !== 0) failures.push(`${entry.name} FAILED (exit ${String(code)})`);
      break;
  }
}

// -------------------------------------------------------------- 4. anti-vacuity
const blocking = ROSTER.filter((e) => e.cls === 'BLOCKING').length;
if (outcomes.length === 0 && !rosterOnly) {
  failures.push('gate:pr executed ZERO gates — a pass over an empty list');
}
if (!rosterOnly && only === undefined && outcomes.length !== ROSTER.length) {
  failures.push(
    `gate:pr executed ${String(outcomes.length)} of ${String(ROSTER.length)} rostered gate(s)`,
  );
}
if (blocking < MIN_BLOCKING) {
  failures.push(
    `gate:pr has ${String(blocking)} BLOCKING gate(s); the floor is ${String(MIN_BLOCKING)}. A gate was demoted or deleted — a green run over a shrinking list is the defect this aggregate exists to prevent.`,
  );
}

// -------------------------------------------------------------------- summary
console.log(`\n${RULE}\n== gate:pr summary\n${RULE}`);
const counts: Record<string, number> = { BLOCKING: 0, PENDING: 0, BLOCKED: 0, SERVICE: 0 };
let blockingPassed = 0;
for (const o of outcomes) {
  counts[o.entry.cls] = (counts[o.entry.cls] ?? 0) + 1;
  let status: string;
  if (o.entry.cls === 'BLOCKING' || o.entry.cls === 'BLOCKED') {
    status = o.code === 0 ? 'PASS' : `FAIL (exit ${String(o.code)})`;
    if (o.code === 0) blockingPassed += 1;
  } else {
    status = o.code === 0 ? `UNEXPECTED PASS (promote it)` : 'NOT YET SUPPLIED';
  }
  const tail = o.entry.cls === 'BLOCKING' ? '' : `  <- ${o.entry.owner ?? '(no owner)'}`;
  console.log(`  ${status.padEnd(22)} ${o.entry.name.padEnd(32)} [${o.entry.cls}]${tail}`);
}
console.log(
  `\n  executed ${String(outcomes.length)} rostered gate(s): ` +
    `${String(counts['BLOCKING'] ?? 0)} BLOCKING, ${String(counts['BLOCKED'] ?? 0)} BLOCKED, ` +
    `${String(counts['SERVICE'] ?? 0)} SERVICE, ${String(counts['PENDING'] ?? 0)} PENDING.`,
);
console.log(
  `  ${String(blockingPassed)}/${String((counts['BLOCKING'] ?? 0) + (counts['BLOCKED'] ?? 0))} gates that must pass, passed.`,
);
console.log(
  `  ${String((counts['PENDING'] ?? 0) + (counts['SERVICE'] ?? 0))} rostered gate(s) are NOT green and are named above with their owner.`,
);

if (failures.length > 0) {
  console.error(`\nGATE FAIL  gate:pr — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nGATE PASS  gate:pr');
process.exit(0);
