/**
 * A gate name that is PUBLISHED but whose CONTENT is not yet implemented.
 *
 * It exits non-zero and names the ticket that owes it. That is deliberate:
 * platform-infrastructure.md's first failure mode is "gates wired but not
 * blocking", and a stub that quietly exits 0 is exactly that. A downstream
 * agent that runs one of these gets a loud, attributable failure rather than a
 * green result from a gate that checks nothing.
 *
 * T-005: the owner list is no longer written here. It is read from
 * `scripts/gates/lib/roster.ts`, the same table `gate:pr` runs, so the owner
 * printed by the hook and the owner printed by the aggregate cannot drift. A
 * name that is not in the roster at all is refused with a different message —
 * an unrostered gate name is a typo or a gate somebody deleted, and neither
 * should print an owner it made up.
 */
import { ROSTER } from './lib/roster.ts';
import type { RosterEntry } from './lib/roster.ts';
import { HEAVY_ROSTER } from './lib/heavy-roster.ts';

/**
 * Published names that are NOT members of EITHER roster. There are none.
 *
 * There used to be one — `gate:heavy` itself, which this file stood in for
 * while T-006 was owed. T-006 has landed: `pnpm gate:heavy` is
 * scripts/gates/heavy.ts, and the three hooks the heavy stage is still owed
 * (`gate:lighthouse`, `gate:axe`, `gate:playwright-journeys`) are rostered in
 * scripts/gates/lib/heavy-roster.ts, which this file now reads beside the PR
 * roster. The owner a hook prints and the owner its aggregate prints still
 * cannot drift, in either stage.
 */
const OFF_ROSTER: readonly RosterEntry[] = [];

const name = process.argv[2] ?? '(unnamed)';
const entry = [...ROSTER, ...HEAVY_ROSTER, ...OFF_ROSTER].find((e) => e.name === name);

console.error(`GATE NOT YET SUPPLIED  ${name}`);
if (entry === undefined) {
  console.error('  Owed by: UNKNOWN — this name is in no roster entry.');
  console.error('  It is not a published gate. Either it is a typo, or a gate was removed from');
  console.error('  scripts/gates/lib/roster.ts (or lib/heavy-roster.ts) without removing its');
  console.error('  package.json script.');
  process.exit(1);
}
console.error(`  Class:   ${entry.cls}`);
console.error(`  Owed by: ${entry.owner ?? 'UNKNOWN — the roster entry carries no owner'}`);
console.error(
  `  Goes green when: ${entry.unblocks ?? 'UNRECORDED — that is an open-ended allowance'}`,
);
console.error(`  What it will check: ${entry.why}`);
console.error('');
console.error('  The NAME is published so downstream tickets can cite it; the implementation is');
console.error('  not. This exits non-zero on purpose: a stub that exits 0 is a gate that is');
console.error('  wired but does not block. The aggregate that rosters it — `pnpm gate:pr` or');
console.error('  `pnpm gate:heavy` — runs this hook on every run and FAILS if it ever exits 0');
console.error('  without being promoted to BLOCKING in that roster.');
process.exit(1);
