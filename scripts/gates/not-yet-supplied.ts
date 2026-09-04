/**
 * A script name that T-001 PUBLISHES but does not yet IMPLEMENT.
 *
 * It exits non-zero and names the ticket that owes it. That is deliberate:
 * platform-infrastructure.md's first failure mode is "gates wired but not
 * blocking", and a stub that quietly exits 0 is exactly that. A downstream
 * agent that runs one of these gets a loud, attributable failure rather than a
 * green result from a gate that checks nothing.
 *
 * These names are NOT in `gate:pr` yet — T-005 adds them as it implements them.
 */
const OWED: ReadonlyMap<string, string> = new Map([
  [
    'db:introspect:check',
    'tech-lead — Drizzle introspection parity against db/schema.ts (SD §DH-1, §QD-4). Blocked on T-020/T-021.',
  ],
  [
    'gate:heavy',
    'platform-infrastructure T-006 — Lighthouse CI, axe-core, Playwright, Testcontainers (SD §QD-4 "PR (heavy)"). Blocked on T-005, T-115, T-018.',
  ],
]);

const name = process.argv[2] ?? '(unnamed)';
const owner = OWED.get(name);

console.error(`GATE NOT YET SUPPLIED  ${name}`);
console.error(`  Owed by: ${owner ?? 'unknown — this name is not in the T-001 contract'}`);
console.error(
  '  The name is published (state/EP-1/T-001.md § Published contract) so downstream',
);
console.error(
  '  tickets can cite it; the implementation is not. This exits non-zero on purpose:',
);
console.error('  a stub that exits 0 is a gate that is wired but does not block.');
process.exit(1);
