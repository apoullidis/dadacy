/**
 * gate:pr — the local PR aggregate (PROTOCOL.md §5.1, SD §QD-4 PR row).
 *
 * There is no CI service and there never will be. This command IS the PR gate.
 * It runs every sub-gate, reports each one separately so a single failure does
 * not mask the rest, and exits non-zero if any of them failed.
 *
 * T-001 owns the seven that need no application code. T-005 extends this list
 * with the gates that depend on other agents' work (locale completeness,
 * prohibited claims, safety-review currency, plural completeness, the SMS
 * segment assertion, the PII leak canary, policy branch coverage, Zod<->OpenAPI
 * drift, migration lint, Drizzle parity). Adding a name here is how a gate
 * becomes blocking; there is no other switch.
 */
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './lib/run.ts';

interface Gate {
  readonly name: string;
  readonly why: string;
}

const GATES: readonly Gate[] = [
  { name: 'gate:toolbox', why: 'toolchain pins, determinism, ownership (QA-F3)' },
  { name: 'gate:typecheck', why: 'TypeScript strict across the workspace (SD §DH-2)' },
  { name: 'gate:lint', why: 'ESLint flat config + Prettier (SD §DH-2)' },
  { name: 'gate:deps', why: 'dependency-cruiser module boundaries (SA §SA-2)' },
  { name: 'gate:secrets', why: 'gitleaks (SD §QD-4)' },
  { name: 'gate:trivy', why: 'dependency vulnerabilities (SD §QD-4)' },
  { name: 'gate:size-limit', why: 'per-route JS budgets (SD §PERF)' },
  {
    name: 'gate:egress-boundary',
    why: 'no compose service on kinvara-build; svc run has no egress (DOCKER.md §7)',
  },
];

const results: { name: string; code: number }[] = [];

for (const g of GATES) {
  console.log(`\n${'='.repeat(78)}\n== ${g.name} — ${g.why}\n${'='.repeat(78)}`);
  const r = spawnSync('pnpm', ['run', '--silent', g.name], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  const code = r.error !== undefined ? 127 : (r.status ?? 1);
  results.push({ name: g.name, code });
}

console.log(`\n${'='.repeat(78)}\n== gate:pr summary\n${'='.repeat(78)}`);
let failed = 0;
for (const r of results) {
  const status = r.code === 0 ? 'PASS' : `FAIL (exit ${String(r.code)})`;
  if (r.code !== 0) failed += 1;
  console.log(`  ${status.padEnd(16)} ${r.name}`);
}
console.log(`\n  ${String(results.length - failed)}/${String(results.length)} gates passed.`);

if (failed > 0) {
  console.error(`\nGATE FAIL  gate:pr — ${String(failed)} gate(s) failed`);
  process.exit(1);
}
console.log('\nGATE PASS  gate:pr');
process.exit(0);
