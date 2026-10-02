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
 *      SINCE T-006, `SERVICE` IS JUDGED ON ITS OWN BANNER, `GATE NEEDS A
 *      SERVICE`, and not on PENDING's. The two classes were always different
 *      facts — content owed, versus supplied but unrunnable in a stage that
 *      declares `svc: none` — and until `pnpm gate:heavy` existed to run one,
 *      nothing turned on the difference. Now something does: a SERVICE gate
 *      that still prints "NOT YET SUPPLIED" is a gate whose implementation has
 *      landed and whose hook nobody removed.
 *   4. IT CANNOT PASS VACUOUSLY. Zero gates executed, or a BLOCKING population
 *      of zero, is a FAIL — not a green run over an empty list. That is the
 *      Trivy zero-package defect and OD-3, and it is asserted here as well as
 *      inside the gates that can suffer it.
 */
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, capture, exitFlushed } from './lib/run.ts';
import { ROSTER, SPEC_PR_ROW, PROGRAMME, rosterProblems } from './lib/roster.ts';
import type { RosterEntry } from './lib/roster.ts';

const RULE = '='.repeat(78);

/**
 * The floor on BLOCKING gates — a RATCHET, not a guess. It is the number this
 * aggregate had when the floor was last raised; demoting or deleting one fails
 * the aggregate. Adding a gate does not, so the correct move when you add one
 * is to raise this number in the same change set. Anti-vacuity: header note 4.
 *
 * 22 -> 23 on 2026-09-20 (T-042), when gate:locale-completeness was supplied
 * and promoted PENDING -> BLOCKING. Case A6 in scripts/negative-tests/
 * pr-gates.sh reads this number, and so does the `W7: 29 concrete` pin in
 * case F0 (23 blocking + 6 advisory matrix values); both moved with it.
 *
 * 23 -> 24 on 2026-09-20 (T-044), when gate:safety-review-currency was
 * supplied and promoted PENDING -> BLOCKING. Case A6's expected reason moved
 * with it; F0's `W7: 29 concrete` pin did NOT, because a promotion moves a
 * gate between the two matrices and leaves the total alone (24 blocking + 5
 * advisory). Measured in both directions in tasks/state/EP-0/T-044.md
 * § Evidence 6: at floor 23, A6's own mutation is a GATE PASS and the refusal
 * is silently lost.
 *
 * 24 -> 25 on 2026-09-21 (T-046), when gate:sms-segments was supplied and
 * promoted PENDING -> BLOCKING. Case A6's expected reason moved with it; F0's
 * `W7: 29 concrete` pin did NOT, for the same reason as last time — a
 * promotion moves a gate between the two matrices and leaves the total alone
 * (25 blocking + 4 advisory). Measured in both directions in
 * tasks/state/EP-0/T-046.md § Evidence 5: at floor 24, A6's own mutation is a
 * GATE PASS and the refusal is silently lost.
 *
 * 25 -> 26 on 2026-09-21 (T-008), when gate:otel-contract was ADDED as a new
 * PROGRAMME gate. This one is an ADDITION, not a promotion, so unlike the three
 * above it moves the TOTAL as well: F0's pin in scripts/negative-tests/
 * pr-gates.sh goes 29 -> 30 (26 blocking + 4 advisory) because the gate joins
 * the blocking matrix without leaving the advisory one. Case A6's expected
 * reason moved with the floor. Measured in both directions in
 * tasks/state/EP-1/T-008.md § Evidence 5: at floor 25, A6's own mutation is a
 * GATE PASS and the refusal is silently lost.
 */
const MIN_BLOCKING = 26;

/**
 * Two flags, and they exist so this program can be ATTACKED cheaply rather than
 * only observed passing. A full run is slow:
 *
 *   9:59.38 total, at 8c35307, measured with
 *   `{ time ./scripts/dev pnpm run --silent gate:pr ; }` — zsh's builtin
 *   `time`, the `total` column, on this host; the run is pasted in
 *   tasks/state/EP-1/T-005.md.
 *
 * The two negative-suite gates are most of it, and BOTH FIGURES ARE PRINTED BY
 * THE GATES THEMSELVES on every run rather than restated here:
 * `gate:negative-suites` 290.4s (the six per-suite lines it prints, summed)
 * plus `gate:pr-gate-suite` 212.6s, at that same commit. That is long
 * enough that nobody would write seventy-one cases against a full run — and a
 * gate nobody attacks is a gate whose coverage is unknown (PROTOCOL §5.1: "I
 * had run the check; I had not tried to get past it").
 *
 * A second measurement is a SECOND ATTRIBUTED LINE, never a merged range
 * (PROTOCOL §5.3 R1).
 *
 *   --roster-only   the roster/spec/vacuity checks alone. Runs no gate.
 *   --only=<name>   execute exactly one rostered gate and judge it against its
 *                   declared class. The roster checks still run.
 *
 * Neither weakens the default: `pnpm gate:pr` passes neither, and both PRINT
 * what they did IN THE BANNER ITSELF — the `GATE PASS  gate:pr` line, which is
 * the line every ticket in this programme pastes as its Definition of Done.
 * That placement is rework 1's, and it is the point: until then the disclosure
 * sat five lines up in the summary block and both flags ended in a banner
 * byte-identical to a full run's. Cases A10 and A11 assert the marker is in the
 * banner line, not merely somewhere in the output.
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
const NEEDS_SERVICE = 'GATE NEEDS A SERVICE';

for (const o of outcomes) {
  const { entry, code, text } = o;
  switch (entry.cls) {
    case 'BLOCKING':
      if (code !== 0) failures.push(`${entry.name} FAILED (exit ${String(code)})`);
      break;
    case 'PENDING':
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
    case 'SERVICE':
      // T-006. SERVICE and PENDING were judged by one banner until the heavy
      // stage existed to run a SERVICE gate. They are now two RESULTS, because
      // they are two different facts about the world: PENDING means the gate's
      // CONTENT is owed by a named ticket; SERVICE means the gate is SUPPLIED
      // AND RUNS, in `pnpm gate:heavy`, and that THIS stage structurally cannot
      // start the service it needs (gate:pr declares `svc: none`; DOCKER.md §7).
      // A SERVICE gate printing "NOT YET SUPPLIED" was the register defect
      // PROTOCOL §5.1 names: a true sentence that became false when T-006
      // landed, in the output every ticket in the programme pastes.
      if (code === 0) {
        failures.push(
          `${entry.name} is rostered SERVICE but EXITED 0 in a stage that declares \`svc: none\` — either a service is attached to gate:pr, which DOCKER.md §7 forbids, or the gate is not reading for one. Move it in scripts/gates/lib/roster.ts or fix the gate.`,
        );
      } else if (!text.includes(NEEDS_SERVICE)) {
        failures.push(
          `${entry.name} is rostered SERVICE and exited ${String(code)} WITHOUT the "${NEEDS_SERVICE}" banner — a gate that needs a service, a hook whose content is not yet supplied, and a crash must be three distinguishable outcomes (PROTOCOL §5.1). If it printed "${NOT_SUPPLIED}", its content IS supplied and the hook was left behind; \`pnpm gate:heavy\` (T-006) is what executes it.`,
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
    status =
      o.code === 0
        ? `UNEXPECTED PASS (promote it)`
        : o.entry.cls === 'SERVICE'
          ? 'NEEDS A SERVICE'
          : 'NOT YET SUPPLIED';
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

/**
 * The marker that rides IN the banner. Empty for a full run, so `gate:pr`'s own
 * banner is unchanged and a full run is still the plain line every ticket
 * pastes — and non-empty, with the count, for either cheap entry point.
 */
const banner = rosterOnly
  ? '  [--roster-only: NO GATE EXECUTED — NOT a full gate:pr run]'
  : only !== undefined
    ? `  [--only=${only}: ${String(outcomes.length)} of ${String(ROSTER.length)} rostered gate(s) executed — NOT a full gate:pr run]`
    : '';

if (failures.length > 0) {
  console.error(`\nGATE FAIL  gate:pr${banner} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  exitFlushed(1);
}
console.log(`\nGATE PASS  gate:pr${banner}`);
exitFlushed(0);
