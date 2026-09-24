/**
 * gate:semgrep-rules — T-005, closing decisions.md OD-61.
 *
 * THE DEFECT. SD §QD-4's PR row makes "Semgrep project rules" a BLOCKING gate
 * and enumerates none of them. SD §QD-1 names thirteen. T-133 installed exactly
 * one (`no-any`) and — correctly — invented nothing. So a blocking row stood on
 * a rule set that was written down nowhere the gate could see, and twelve of
 * the thirteen had no ticket that would ever install them. A blocking gate over
 * a rule set nobody has installed is a gate that cannot fail.
 *
 * WHAT THIS GATE IS, AND WHAT IT IS NOT. It is NOT a set of Semgrep rules —
 * inventing rule content is explicitly not T-005's (role file: "the content of
 * any gate's rule set ... belongs to their owning agents"). It is the
 * ENUMERATION, placed where it blocks, and held in both directions:
 *
 *   E1  a rule id in .semgrep.yml that the catalogue does not record
 *                                        -> UNCATALOGUED (a rule arrived with
 *                                           no entry saying which of SD §QD-1's
 *                                           thirteen it is)
 *   E2  a catalogue entry marked installed whose rule id is NOT in .semgrep.yml
 *                                        -> REMOVED (a shipped rule was deleted
 *                                           and the blocking row would not have
 *                                           moved)
 *   E3  a catalogue entry that is not installed and names no owner
 *                                        -> UNOWNED
 *   E4  the catalogue does not have exactly the thirteen SD §QD-1 lists
 *                                        -> COUNT (a rule quietly dropped from
 *                                           the institutional memory)
 *
 * It PRINTS all thirteen on every run with their status and owner, because
 * OD-61's actual complaint is that the set is not enumerated where it blocks.
 * This is where it blocks.
 *
 * THE RESIDUE, STATED: twelve of the thirteen are not installed, so twelve of
 * SD §QD-1's rules catch nothing today. This gate does not close that and does
 * not pretend to — it makes the gap a printed, owned, countable list instead of
 * an absence. Cutting the twelve tickets is the orchestrator's call, and the
 * `owner` column is written so that call can be made from this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, finish } from './lib/run.ts';

const CATALOGUE = 'scripts/gates/semgrep-rules.json';
const RULES_FILE = '.semgrep.yml';
/** SD §QD-1 lists thirteen. Pinned so one cannot be dropped silently. */
const SPEC_RULE_COUNT = 13;

interface Entry {
  readonly subject?: string;
  readonly ruleId?: string | null;
  readonly owner?: string;
  readonly installingTicket?: string | null;
}

const failures: string[] = [];

const raw: unknown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CATALOGUE), 'utf8'));
const entries: readonly Entry[] = Array.isArray((raw as { rules?: unknown }).rules)
  ? (raw as { rules: readonly Entry[] }).rules
  : [];

if (entries.length !== SPEC_RULE_COUNT) {
  failures.push(
    `E4 ${CATALOGUE} has ${String(entries.length)} entries; SD §QD-1 lists ${String(SPEC_RULE_COUNT)}. ` +
      'A rule dropped from this file is a rule dropped from the institutional memory of the design.',
  );
}

// The rule ids actually shipped, read from the YAML by the one shape it uses:
// `  - id: <name>` under `rules:`. Read textually on purpose — this gate must
// not need a YAML parser to tell whether a rule exists.
const yml = fs.readFileSync(path.join(REPO_ROOT, RULES_FILE), 'utf8');
const shipped = new Set<string>();
for (const line of yml.split('\n')) {
  const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line.replace(/\r$/, ''));
  if (m?.[1] !== undefined) shipped.add(m[1]);
}
if (shipped.size === 0) {
  failures.push(
    `E1 ${RULES_FILE} declares no rule ids at all. "Semgrep project rules" is a BLOCKING row in ` +
      'SD §QD-4 and an empty rule set cannot fail. (gate:semgrep has its own self-test ' +
      'requirement per rule — this is the complementary check that there IS a rule.)',
  );
}

const catalogued = new Map<string, Entry>();
console.log(`SD §QD-1 — the thirteen project-specific Semgrep rules, where they block:\n`);
let installed = 0;
let unowned = 0;
for (const [i, e] of entries.entries()) {
  const id = e.ruleId ?? null;
  const status = id !== null ? `INSTALLED as \`${id}\`` : 'NOT INSTALLED';
  const ticket = e.installingTicket ?? null;
  console.log(`  ${String(i + 1).padStart(2)}. ${e.subject ?? '(no subject)'}`);
  console.log(`      ${status}${ticket !== null ? ` by ${ticket}` : ' — no installing ticket'}`);
  console.log(`      subject owner: ${e.owner ?? '(NONE)'}`);
  if (id !== null) {
    installed += 1;
    catalogued.set(id, e);
    if (!shipped.has(id)) {
      failures.push(
        `E2 ${CATALOGUE} records \`${id}\` as installed, but ${RULES_FILE} does not declare it. ` +
          'A shipped rule was deleted and the blocking row would not have moved.',
      );
    }
  } else if (e.owner === undefined || e.owner.trim() === '') {
    unowned += 1;
    failures.push(
      `E3 rule ${String(i + 1)} (${e.subject ?? '?'}) is not installed and names no owner. ` +
        'An unowned gap is indistinguishable from a forgotten one.',
    );
  }
}

for (const id of shipped) {
  if (!catalogued.has(id)) {
    failures.push(
      `E1 ${RULES_FILE} ships rule \`${id}\`, which ${CATALOGUE} does not record. Every rule that ` +
        'blocks a PR must say which of SD §QD-1’s thirteen it is, or that it is a new one ' +
        'somebody decided to add.',
    );
  }
}

const noTicket = entries.filter((e) => (e.installingTicket ?? null) === null);
console.log(
  `\n  ${String(installed)} of ${String(entries.length)} installed; ` +
    `${String(noTicket.length)} have NO installing ticket; ${String(unowned)} have no owner at all.`,
);
console.log(
  '  The rules with no installing ticket catch nothing today. That is OD-61 at true width, ' +
    'printed here rather than implied by a green check. Cutting those tickets is the ' +
    "orchestrator's call; the `owner` column is written so it can be made from this file.",
);

finish('gate:semgrep-rules', failures);
