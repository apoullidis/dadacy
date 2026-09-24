/**
 * gate:heavy — the local heavy aggregate (PROTOCOL §5.1, SD §QD-4 "PR (heavy)").
 *
 * There is no CI service and there never will be. This command IS the heavy
 * stage. `.github/workflows/heavy.yml` mirrors it and has never run.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROGRAM IS FOR, STATED BEFORE WHAT IT DOES.
 *
 * SD names four heavy gates. THREE OF THEM HAVE NOTHING TO RUN AGAINST: the
 * Lighthouse run has no page, axe-core has no flow, Playwright has no journey,
 * because `apps/web` is a declared placeholder owned by `frontend-developer`
 * and the tickets that fill it (T-050, T-051, T-120) are blocked. The failure
 * mode this file exists to prevent is the obvious one: point Lighthouse at the
 * placeholder, get a number, print a green heavy gate. That gate would have
 * scanned nothing and would say it had.
 *
 * So the aggregate's own anti-vacuity question — PROTOCOL §5.1's "if it
 * checked nothing, would it say so?" — is asked of itself, in four places:
 *
 *   1. THE ROSTER. scripts/gates/lib/heavy-roster.ts holds SD's heavy row as
 *      data and is checked against it both ways, so a sub-gate cannot go
 *      missing; it can only change class, and every class that is not green
 *      must name an owner and the exact condition that makes it green.
 *   2. EXECUTION. Every rostered entry is EXECUTED on every run, including the
 *      three nobody expects to pass. "Not yet supplied" is a RESULT here,
 *      produced by running the command. A PENDING hook that starts exiting 0
 *      fails this gate and demands its promotion.
 *   3. THE EVIDENCE ANCHOR. A BLOCKING sub-gate's zero exit is not enough: its
 *      own output must carry the lines that prove it ran over something. A
 *      sub-gate replaced by `true`, or one that skipped every file, exits 0
 *      and prints no anchor, and this aggregate calls that CRASHED — not
 *      passed. A harness must never infer a verdict from a signal a no-op also
 *      produces (PROTOCOL §5.1).
 *   4. COVERAGE. A run that executed a subset REFUSES TO REPORT A PASS for the
 *      rest. See "two entry points" below — this is the part that costs
 *      something, and it is the part that makes the other three mean anything.
 *
 * ---------------------------------------------------------------------------
 * TWO ENTRY POINTS, AND WHY THERE CANNOT BE ONE.
 *
 * The two sub-gates that run for real today need mutually exclusive toolboxes:
 *
 *   gate:constraint-suite   needs the DOCKER SOCKET and no compose service.
 *                           `scripts/dev --docker` (T-115 § contract §11
 *                           names this invocation for T-006 by name).
 *   gate:drizzle-parity     needs a compose SERVICE (`postgres:5432` on the
 *                           ticket's kinvara-int) and no socket.
 *                           `scripts/svc run <ticket> --`.
 *
 * `scripts/svc run` REFUSES the socket by name (T-034 § contract §2, OD-16 /
 * OD-18: a socket restores a route off the host without touching a network),
 * and `scripts/dev` attaches no service. DOCKER.md §7 rule (b) forbids one
 * invocation having both. So a full heavy run is TWO commands, and this
 * program is honest about which one it is in:
 *
 *   ./scripts/dev --docker pnpm -w gate:heavy      # the socket segment
 *   ./scripts/svc run <ticket> -- pnpm -w gate:heavy   # the service segment
 *
 * Each run executes the entries its segment can run, writes a RECEIPT of what
 * it observed, and reads the other segment's receipt. It exits 0 only when
 * every entry is accounted for — executed here, or carried by a receipt taken
 * at THIS SAME TREE STATE. A missing or stale receipt is a FAIL that prints
 * the exact command to run. Deleting the receipt directory makes this gate red,
 * which is the property that matters: the segment you did not run is never
 * silently assumed green.
 *
 * THE AGGREGATE RE-DERIVES EACH VERDICT FROM THE STORED OUTPUT LINES, not from
 * a stored verdict: a receipt carries the sub-gate's exit status, its banner
 * line and the lines its anchors matched, and the judgement is re-run here.
 *
 * WHAT A RECEIPT IS NOT. It is a cache of a run in this working tree, not a
 * security boundary. `.cache/gate-heavy/` is gitignored and a person with a
 * text editor can write one by hand; nothing here would know. It defends
 * against FORGETTING a segment, not against FAKING one. PROTOCOL §5.2 is what
 * defends against faking one, and it is not a mechanism.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, capture } from './lib/run.ts';
import { HEAVY_ROSTER, PR_ROW, SPEC_HEAVY_ROW, heavyRosterProblems } from './lib/heavy-roster.ts';
import type { AnchorSpec, HeavyEntry, Segment } from './lib/heavy-roster.ts';

const RULE = '='.repeat(78);
const NOT_SUPPLIED = 'GATE NOT YET SUPPLIED';
const RECEIPT_DIR = path.join(REPO_ROOT, '.cache', 'gate-heavy');

/**
 * The floor on BLOCKING sub-gates — a RATCHET, not a guess, and the same
 * instrument as `MIN_BLOCKING` in scripts/gates/pr.ts. It is the number this
 * aggregate had when the floor was last raised; demoting or deleting one fails
 * the aggregate even though the roster/spec checks would still pass, because a
 * demotion to PENDING is a legal roster edit and is exactly how a heavy gate
 * would quietly stop running.
 *
 * 2 on 2026-09-22 (T-006, this aggregate's first delivery): gate:constraint-suite
 * and gate:drizzle-parity. Measured in BOTH directions in
 * tasks/state/EP-1/T-006.md § Evidence 5 — at floor 2 a demotion is GATE FAIL;
 * at floor 1 the identical mutated tree is GATE PASS and the refusal is
 * silently lost. Raise it in the same change set that supplies a hook.
 *
 * 3 on 2026-09-24 (T-190, OD-220): gate:db-introspect-suite promoted BLOCKED -> BLOCKING once
 * T-165 turned its suite green. Measured in both directions in tasks/state/EP-1/T-190.md.
 */
const MIN_HEAVY_BLOCKING = 3;

// ---------------------------------------------------------------------- flags
const argv = process.argv.slice(2);
const rosterOnly = argv.includes('--roster-only');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg?.slice('--only='.length);

// ------------------------------------------------------------- the tree state
/**
 * A fingerprint of the working tree, so a receipt cannot outlive the code it
 * describes. HEAD alone is not enough — every gate in this build is runnable
 * on a dirty tree — so the diff and the untracked set go in too.
 */
function treeFingerprint(): { fp: string; head: string; dirty: boolean } {
  const head = capture('git', ['rev-parse', 'HEAD']);
  const diff = capture('git', ['diff', 'HEAD']);
  const untracked = capture('git', ['ls-files', '--others', '--exclude-standard']);
  if (head.code !== 0) {
    return { fp: 'NO-GIT', head: 'NO-GIT', dirty: false };
  }
  const h = crypto.createHash('sha256');
  h.update(head.stdout);
  h.update('\0');
  h.update(diff.stdout);
  h.update('\0');
  h.update(untracked.stdout);
  return {
    fp: h.digest('hex').slice(0, 16),
    head: head.stdout.trim().slice(0, 7),
    dirty: diff.stdout !== '' || untracked.stdout !== '',
  };
}

// --------------------------------------------------------- segment detection
/**
 * Which segment this invocation IS, read from the markers the two entry points
 * set (T-034 § contract §1 for the socket; scripts/svc for the project).
 * Nothing here probes a daemon or a database: an invocation is its entry
 * point, and a probe that "found a socket" in a toolbox that should not have
 * one is a finding, not a capability.
 */
function currentSegments(): Segment[] {
  const segs: Segment[] = ['any'];
  if (process.env['KINVARA_DOCKER_SOCKET'] === '1') segs.push('socket');
  if (
    process.env['KINVARA_PROJECT'] !== undefined &&
    process.env['KINVARA_PROJECT'] !== '' &&
    process.env['PGHOST'] !== undefined &&
    process.env['PGHOST'] !== ''
  ) {
    segs.push('service');
  }
  return segs;
}

const SEGMENT_COMMAND: Readonly<Record<Segment, string>> = {
  any: 'pnpm -w gate:heavy',
  socket: './scripts/dev --docker pnpm -w gate:heavy',
  service: './scripts/svc run <ticket> -- pnpm -w gate:heavy',
};

// ------------------------------------------------------------------- anchors
interface AnchorResult {
  readonly label: string;
  readonly ok: boolean;
  readonly line: string;
  readonly reason: string;
}

function checkAnchor(spec: AnchorSpec, text: string): AnchorResult {
  const m = spec.pattern.exec(text);
  if (m === null) {
    return {
      label: spec.label,
      ok: false,
      line: '',
      reason: `no line matching ${String(spec.pattern)}`,
    };
  }
  for (const [group, floor] of spec.atLeast ?? []) {
    const raw = m[group];
    const n = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(n) || n < floor) {
      return {
        label: spec.label,
        ok: false,
        line: m[0],
        reason: `capture ${String(group)} is ${String(raw)}, and the floor is ${String(floor)} — a pass over an empty set`,
      };
    }
  }
  for (const [a, b] of spec.equal ?? []) {
    if (m[a] !== m[b]) {
      return {
        label: spec.label,
        ok: false,
        line: m[0],
        reason: `capture ${String(a)} (${String(m[a])}) != capture ${String(b)} (${String(m[b])})`,
      };
    }
  }
  return { label: spec.label, ok: true, line: m[0], reason: '' };
}

/** One entry's observation, in the form a receipt stores and the judge reads. */
interface Observation {
  readonly name: string;
  readonly code: number;
  /** The GATE PASS/FAIL/CRASH/NOT-YET-SUPPLIED banner lines, verbatim. */
  readonly banners: readonly string[];
  /** The lines each anchor matched, verbatim — empty when it matched nothing. */
  readonly anchorLines: readonly string[];
  readonly seconds: number;
}

interface Receipt {
  readonly segment: Segment;
  readonly fingerprint: string;
  readonly head: string;
  readonly project: string;
  readonly takenAt: string;
  readonly observations: readonly Observation[];
}

function bannersIn(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => /^GATE (PASS|FAIL|CRASH|NOT YET SUPPLIED|NEEDS A SERVICE) /.test(l.trim()))
    .map((l) => l.trim());
}

function observe(entry: HeavyEntry): Observation {
  const started = Date.now();
  const r = capture('pnpm', ['run', '--silent', entry.name]);
  const text = `${r.stdout}${r.stderr}`;
  process.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`);
  const anchorLines: string[] = [];
  for (const a of entry.anchors ?? []) {
    const res = checkAnchor(a, text);
    anchorLines.push(res.line);
  }
  return {
    name: entry.name,
    code: r.spawnFailed ? 127 : r.code,
    banners: bannersIn(text),
    anchorLines,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

/**
 * Judge one observation against its declared class. The same function judges a
 * run that just happened and a run carried by a receipt — there is one set of
 * rules, and a receipt cannot buy a verdict the live run would not have got.
 */
function judge(entry: HeavyEntry, o: Observation): string[] {
  const problems: string[] = [];
  const passBanner = `GATE PASS  ${entry.name}`;
  switch (entry.cls) {
    case 'BLOCKING': {
      if (o.code !== 0) {
        problems.push(`${entry.name} FAILED (exit ${String(o.code)})`);
        break;
      }
      if (!o.banners.includes(passBanner)) {
        problems.push(
          `${entry.name} exited 0 but printed no \`${passBanner}\` banner (banners: ` +
            `${o.banners.length === 0 ? 'NONE' : o.banners.join(' | ')}). A crash that happens to ` +
            'exit 0, and a pass, must not look the same (PROTOCOL §5.1).',
        );
        break;
      }
      (entry.anchors ?? []).forEach((a, i) => {
        const line = o.anchorLines[i] ?? '';
        const res = checkAnchor(a, line);
        if (!res.ok) {
          problems.push(
            `${entry.name} printed \`${passBanner}\` but its evidence anchor "${a.label}" is not ` +
              `satisfied: ${res.reason}. A green banner over a run that did nothing is the one ` +
              'outcome this aggregate exists to refuse.',
          );
        }
      });
      break;
    }
    case 'PENDING':
    case 'SERVICE': {
      if (o.code === 0) {
        problems.push(
          `${entry.name} is rostered ${entry.cls} but EXITED 0 — ${entry.owner ?? 'its owner'} has ` +
            'supplied it and nobody promoted it to BLOCKING. Move it in ' +
            'scripts/gates/lib/heavy-roster.ts.',
        );
      } else if (!o.banners.some((b) => b.startsWith(NOT_SUPPLIED))) {
        problems.push(
          `${entry.name} is rostered ${entry.cls} and exited ${String(o.code)} WITHOUT the ` +
            `"${NOT_SUPPLIED}" banner — a crash and a not-yet-supplied hook must not look the ` +
            'same (PROTOCOL §5.1).',
        );
      }
      break;
    }
    case 'BLOCKED': {
      if (o.code === 0) {
        problems.push(
          `${entry.name} is rostered BLOCKED against a pinned failure and is GREEN — an allowance ` +
            'that outlives its reason. Promote it.',
        );
      } else if (
        entry.pinnedFailure !== undefined &&
        !o.banners.some((b) => b.includes(entry.pinnedFailure ?? '\u0000')) &&
        !o.anchorLines.some((l) => l.includes(entry.pinnedFailure ?? '\u0000'))
      ) {
        problems.push(
          `${entry.name} is RED IN A WAY THAT IS NOT THE PINNED ONE — the pin is ` +
            `${JSON.stringify(entry.pinnedFailure)} and nothing in its output carries it.`,
        );
      }
      break;
    }
  }
  return problems;
}

// ============================================================ 1. the roster
const failures: string[] = [];
for (const p of heavyRosterProblems()) failures.push(`roster: ${p}`);

const tree = treeFingerprint();
const segments = currentSegments();
const segLabel = segments.filter((s) => s !== 'any').join('+') || 'none';

console.log(
  `${RULE}\n== gate:heavy — the roster, held against SD §QD-4's "PR (heavy)" row\n${RULE}`,
);
console.log(
  `  tree: HEAD ${tree.head}${tree.dirty ? ' + LOCAL CHANGES' : ''}  fingerprint ${tree.fp}`,
);
console.log(`  this invocation provides segment(s): ${segLabel}`);
console.log(`  SD §QD-4 "PR (heavy)" row items: ${String(SPEC_HEAVY_ROW.length)}`);
for (const item of SPEC_HEAVY_ROW) {
  const answering = HEAVY_ROSTER.filter((e) => e.spec === item).map((e) => e.name);
  console.log(`    ${item}`);
  console.log(
    `      -> ${answering.length === 0 ? 'NOTHING — this is a FAIL' : answering.join(', ')}`,
  );
}
const carried = HEAVY_ROSTER.filter((e) => e.spec === PR_ROW);
console.log(
  `  SD §QD-4 PR-row items the PR stage cannot run, executed here: ` +
    `${carried.map((e) => `${e.name} (${String(e.prSpec)})`).join(', ') || 'none'}`,
);

// ================================================= 2. execute what we can
if (rosterOnly) console.log('\n--roster-only: NO SUB-GATE WAS EXECUTED. Roster checks only.');
if (only !== undefined) {
  console.log(`\n--only=${only}: ONE sub-gate executed. This is not a full gate:heavy run.`);
  if (!HEAVY_ROSTER.some((e) => e.name === only)) {
    failures.push(`--only=${only} names no heavy roster entry`);
  }
}

const selected = HEAVY_ROSTER.filter((e) => only === undefined || e.name === only);
const runnableHere = rosterOnly ? [] : selected.filter((e) => segments.includes(e.segment));
const observations = new Map<string, Observation>();

for (const entry of runnableHere) {
  console.log(
    `\n${RULE}\n== ${entry.name}  [${entry.cls}] (${entry.segment}) — ${entry.why}\n${RULE}`,
  );
  if (entry.owner !== undefined) console.log(`   owed by: ${entry.owner}`);
  if (entry.unblocks !== undefined) console.log(`   goes green when: ${entry.unblocks}\n`);
  observations.set(entry.name, observe(entry));
}

// ================================================= 3. the receipt for this run
/**
 * Only entries tied to a real segment go in a receipt. The `any` entries — the
 * not-yet-supplied hooks — are cheap and run in every invocation, so carrying
 * them across would let a stale one speak for a live one.
 */
const segmentsRunHere = segments.filter((s) => s !== 'any');
if (!rosterOnly && only === undefined) {
  for (const seg of segmentsRunHere) {
    const obs = HEAVY_ROSTER.filter((e) => e.segment === seg)
      .map((e) => observations.get(e.name))
      .filter((o): o is Observation => o !== undefined);
    const receipt: Receipt = {
      segment: seg,
      fingerprint: tree.fp,
      head: tree.head,
      project: process.env['KINVARA_PROJECT'] ?? '(none)',
      takenAt: new Date().toISOString(),
      observations: obs,
    };
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RECEIPT_DIR, `${seg}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8',
    );
  }
}

// ============================== 4. the segments this run did NOT provide
interface Carried {
  readonly entry: HeavyEntry;
  readonly observation: Observation;
  readonly receipt: Receipt;
}
const carriedByReceipt: Carried[] = [];

function readReceipt(seg: Segment): Receipt | string {
  const p = path.join(RECEIPT_DIR, `${seg}.json`);
  if (!fs.existsSync(p)) return `there is no receipt at ${path.relative(REPO_ROOT, p)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return `the receipt at ${path.relative(REPO_ROOT, p)} does not parse: ${e instanceof Error ? e.message : String(e)}`;
  }
  const r = parsed as Partial<Receipt>;
  if (r.fingerprint !== tree.fp) {
    return (
      `the receipt at ${path.relative(REPO_ROOT, p)} was taken at tree ${String(r.fingerprint)} ` +
      `and this tree is ${tree.fp} — it is STALE and says nothing about the code in front of you`
    );
  }
  if (!Array.isArray(r.observations))
    return `the receipt at ${path.relative(REPO_ROOT, p)} carries no observations`;
  return r as Receipt;
}

if (!rosterOnly) {
  const missingSegments = new Set(
    selected.filter((e) => !segments.includes(e.segment)).map((e) => e.segment),
  );
  for (const seg of missingSegments) {
    const owed = selected.filter((e) => e.segment === seg);
    const r = readReceipt(seg);
    if (typeof r === 'string') {
      failures.push(
        `the ${seg} segment did not run here and ${r}. NOT RUN is not PASSED: ` +
          `${owed.map((e) => e.name).join(', ')} ${owed.length === 1 ? 'is' : 'are'} unaccounted ` +
          `for. Run \`${SEGMENT_COMMAND[seg]}\` at this same tree state.`,
      );
      continue;
    }
    for (const entry of owed) {
      const o = r.observations.find((x) => x.name === entry.name);
      if (o === undefined) {
        failures.push(
          `the ${seg} receipt is for this tree but carries no observation for ${entry.name} — ` +
            `re-run \`${SEGMENT_COMMAND[seg]}\``,
        );
        continue;
      }
      carriedByReceipt.push({ entry, observation: o, receipt: r });
    }
  }
}

// ==================================================== 5. judge every entry
for (const entry of runnableHere) {
  const o = observations.get(entry.name);
  if (o === undefined) continue;
  for (const p of judge(entry, o)) failures.push(p);
}
for (const c of carriedByReceipt) {
  for (const p of judge(c.entry, c.observation)) {
    failures.push(`${p} [carried by the ${c.receipt.segment} receipt of ${c.receipt.takenAt}]`);
  }
}

// ======================================================== 6. anti-vacuity
const blocking = HEAVY_ROSTER.filter((e) => e.cls === 'BLOCKING').length;
const accounted = runnableHere.length + carriedByReceipt.length;
if (!rosterOnly && accounted === 0) {
  failures.push('gate:heavy accounted for ZERO sub-gates — a pass over an empty list');
}
if (!rosterOnly && only === undefined && accounted !== HEAVY_ROSTER.length) {
  failures.push(
    `gate:heavy accounted for ${String(accounted)} of ${String(HEAVY_ROSTER.length)} rostered ` +
      'sub-gate(s)',
  );
}
if (blocking < MIN_HEAVY_BLOCKING) {
  failures.push(
    `gate:heavy has ${String(blocking)} BLOCKING sub-gate(s); the floor is ` +
      `${String(MIN_HEAVY_BLOCKING)}. A sub-gate was demoted or deleted — a green run over a ` +
      'shrinking list is the defect this aggregate exists to prevent.',
  );
}

// ============================================================== 7. summary
console.log(`\n${RULE}\n== gate:heavy summary\n${RULE}`);
const counts: Record<string, number> = { BLOCKING: 0, PENDING: 0, BLOCKED: 0, SERVICE: 0 };
let mustPass = 0;
let mustPassed = 0;
for (const entry of HEAVY_ROSTER) {
  if (only !== undefined && entry.name !== only) continue;
  counts[entry.cls] = (counts[entry.cls] ?? 0) + 1;
  const live = observations.get(entry.name);
  const viaReceipt = carriedByReceipt.find((c) => c.entry.name === entry.name);
  const o = live ?? viaReceipt?.observation;
  const how = live !== undefined ? 'ran here' : viaReceipt !== undefined ? `receipt` : 'NOT RUN';
  let status: string;
  if (o === undefined) {
    status = rosterOnly ? 'not executed' : 'NOT RUN — UNACCOUNTED';
  } else if (entry.cls === 'BLOCKING' || entry.cls === 'BLOCKED') {
    mustPass += 1;
    const bad = judge(entry, o).length > 0;
    if (!bad) mustPassed += 1;
    if (bad) {
      status = `FAIL (exit ${String(o.code)})`;
    } else if (entry.cls === 'BLOCKED') {
      // A BLOCKED entry that is red exactly as pinned is BEHAVING, and calling
      // that "PASS" in the summary would be the register defect one line up:
      // the suite is red, it is owned, and the aggregate is content.
      status = `RED AS PINNED (${String(o.seconds)}s)`;
    } else {
      status = `PASS (${String(o.seconds)}s)`;
    }
  } else {
    status = o.code === 0 ? 'UNEXPECTED PASS (promote it)' : 'NOT YET SUPPLIED';
  }
  const tail = entry.cls === 'BLOCKING' ? '' : `  <- ${entry.owner ?? '(no owner)'}`;
  console.log(
    `  ${status.padEnd(24)} ${entry.name.padEnd(26)} [${entry.cls}] ${how.padEnd(8)}${tail}`,
  );
}
console.log(
  `\n  accounted for ${String(accounted)} rostered sub-gate(s): ` +
    `${String(counts['BLOCKING'] ?? 0)} BLOCKING, ${String(counts['BLOCKED'] ?? 0)} BLOCKED, ` +
    `${String(counts['SERVICE'] ?? 0)} SERVICE, ${String(counts['PENDING'] ?? 0)} PENDING.`,
);
console.log(
  `  ${String(mustPassed)}/${String(mustPass)} sub-gate(s) whose outcome must match their class, ` +
    'matched (BLOCKING green; BLOCKED red exactly as pinned).',
);
console.log(
  `  ${String((counts['PENDING'] ?? 0) + (counts['SERVICE'] ?? 0) + (counts['BLOCKED'] ?? 0))} ` +
    'rostered sub-gate(s) are NOT GREEN — every PENDING, SERVICE and BLOCKED entry — and each is ' +
    'named above with its owner. A BLOCKED entry behaving as pinned is still a RED check.',
);
if (carriedByReceipt.length > 0) {
  const segs = [...new Set(carriedByReceipt.map((c) => c.receipt.segment))];
  for (const s of segs) {
    const r = carriedByReceipt.find((c) => c.receipt.segment === s)?.receipt;
    console.log(
      `  the ${s} segment was carried by a receipt taken at ${String(r?.takenAt)} on tree ` +
        `${String(r?.fingerprint)} (project ${String(r?.project)}) — the same tree as this run.`,
    );
  }
}

const banner = rosterOnly
  ? '  [--roster-only: NO SUB-GATE EXECUTED — NOT a full gate:heavy run]'
  : only !== undefined
    ? `  [--only=${only}: ${String(runnableHere.length)} of ${String(HEAVY_ROSTER.length)} rostered sub-gate(s) executed — NOT a full gate:heavy run]`
    : '';

if (failures.length > 0) {
  console.error(`\nGATE FAIL  gate:heavy${banner} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nGATE PASS  gate:heavy${banner}`);
process.exit(0);
