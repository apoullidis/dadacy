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

/**
 * Published names that are NOT members of the PR roster. There is one: the
 * heavy aggregate, which is its own stage (SD §QD-4 "PR (heavy)").
 */
const OFF_ROSTER: readonly RosterEntry[] = [
  {
    name: 'gate:heavy',
    spec: 'PROGRAMME',
    cls: 'PENDING',
    why: 'Lighthouse CI, axe-core, Playwright in three locales, the Testcontainers constraint suite, and the two PR-row gates that need a service (SD §QD-4 "PR (heavy)")',
    owner:
      'platform-infrastructure T-006 — blocked on T-115 and T-034 (T-018 was retired under PROTOCOL §4 and re-cut into T-034 + T-035)',
    unblocks:
      'T-006 implements the aggregate. It inherits from T-005: `gate:drizzle-parity` and `scripts/negative-tests/db-introspect.sh`, both of which need the `db` profile and so cannot run in a PR stage that declares `svc: none`.',
  },
];

const name = process.argv[2] ?? '(unnamed)';
const entry = [...ROSTER, ...OFF_ROSTER].find((e) => e.name === name);

console.error(`GATE NOT YET SUPPLIED  ${name}`);
if (entry === undefined) {
  console.error('  Owed by: UNKNOWN — this name is in no roster entry.');
  console.error('  It is not a published gate. Either it is a typo, or a gate was removed from');
  console.error('  scripts/gates/lib/roster.ts without removing its package.json script.');
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
console.error('  wired but does not block. `pnpm gate:pr` runs this hook on every run and FAILS');
console.error('  if it ever exits 0 without being promoted to BLOCKING in the roster.');
process.exit(1);
