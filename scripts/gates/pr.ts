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
    why: 'every compose service on kinvara-int and nothing else; svc run has no egress; an overlay ADDITION is not an override (DOCKER.md §7, OD-12, OD-16, QA-F5)',
  },
  {
    name: 'gate:app-images',
    why: 'static checks over EVERY Dockerfile an overlay service builds and over compose.yml + every overlay (DOCKER.md §5, §3). The scope of each check is published in state/EP-1/T-036.md § Published contract, with the negative case that falsifies it; this gate is static and still cannot look inside an image — anchor image properties on docker image inspect and on the build',
  },
  {
    // T-115. The STATIC half only: the tag-identity and no-mock rules need no
    // Docker and no services, so they block on a PR. The half that RUNS the
    // suites needs the Docker socket, which only `scripts/dev --docker` supplies
    // (T-034) — and gate:toolbox §6 fails gate:pr on purpose when the socket is
    // present, so the two cannot share one invocation. The full gate belongs in
    // gate:heavy — T-006, which is blocked_by T-115 for this reason.
    name: 'gate:constraint-suite:static',
    why: "the Testcontainers image tag is compose's, and no constraint suite mocks the database (T-115)",
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
