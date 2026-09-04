/**
 * gate:trivy — Trivy filesystem scan. SD §QD-4 PR row: "`pnpm audit` + Trivy".
 *
 * Scans pnpm-lock.yaml for known vulnerabilities in the dependency tree.
 * Trivy needs its vulnerability database, so this gate runs under
 * `scripts/dev` (egress) and NOT under `scripts/svc run` (no egress,
 * DOCKER.md §7). The database is cached in .cache/trivy, which is gitignored.
 *
 * TWO THINGS THIS GATE DOES THAT A BARE `trivy fs` DOES NOT, both because
 * platform-infrastructure.md's first failure mode is "gates wired but not
 * blocking":
 *
 *   1. `--include-dev-deps`. Trivy suppresses development and testing
 *      dependencies by default. Measured on this repository at T-001: with
 *      the default, Trivy reported "Supported files for scanner(s) not found"
 *      and exited 0, having examined ZERO packages — because at this point
 *      every dependency in the workspace is a devDependency. A green gate
 *      that looked at nothing is worse than no gate. Build tooling is also
 *      exactly where a supply-chain compromise lands, so including it is
 *      right on the merits and not only for the evidence.
 *
 *   2. An explicit "did this actually scan anything?" assertion. The gate
 *      counts the packages Trivy reports and FAILS if the count is zero, so
 *      the vacuous-pass condition above can never come back silently — a
 *      moved lockfile or a changed flag turns the gate red, not green.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, capture, finish, toolVersions } from './lib/run.ts';

interface TrivyVuln {
  readonly VulnerabilityID?: string;
  readonly PkgName?: string;
  readonly InstalledVersion?: string;
  readonly Severity?: string;
  readonly FixedVersion?: string;
}
interface TrivyResult {
  readonly Target?: string;
  readonly Packages?: readonly unknown[];
  readonly Vulnerabilities?: readonly TrivyVuln[];
}
interface TrivyReport {
  readonly Results?: readonly TrivyResult[];
}

const failures: string[] = [];
const pinned = toolVersions().get('trivy');

const v = capture('trivy', ['--version']);
if (v.spawnFailed || v.code !== 0) {
  finish('gate:trivy', [
    'trivy is not on PATH. It lives in the toolbox image — run `scripts/dev --build`.',
  ]);
}
const found = (v.stdout.split('\n')[0] ?? '').replace(/^Version:\s*/, '').trim();
console.log(`trivy ${found} (pinned ${String(pinned)})`);
if (pinned !== undefined && found !== pinned) {
  finish('gate:trivy', [
    `trivy ${found} != .tool-versions pin ${pinned}; rebuild the toolbox (\`scripts/dev --build\`)`,
  ]);
}

const cache = path.join(REPO_ROOT, '.cache', 'trivy');
const out = path.join(os.tmpdir(), `kinvara-trivy-${String(process.pid)}.json`);

const ARGS: readonly string[] = [
  'fs',
  '--scanners',
  'vuln',
  '--include-dev-deps',
  '--list-all-pkgs',
  '--severity',
  'HIGH,CRITICAL',
  '--no-progress',
  '--ignorefile',
  '.trivyignore',
  '--skip-dirs',
  '.cache',
  '--skip-dirs',
  'node_modules',
  '--format',
  'json',
  '--output',
  out,
  '.',
];

console.log(`\n$ trivy ${ARGS.slice(0, -3).join(' ')} .`);
const r = capture('trivy', ARGS, { TRIVY_CACHE_DIR: cache });
process.stderr.write(r.stderr);

if (r.code !== 0) {
  finish('gate:trivy', [`trivy itself exited ${String(r.code)} — the scan did not complete`]);
}

let report: TrivyReport;
try {
  report = JSON.parse(fs.readFileSync(out, 'utf8')) as TrivyReport;
} finally {
  fs.rmSync(out, { force: true });
}

const results = report.Results ?? [];
let packages = 0;
const vulns: TrivyVuln[] = [];
for (const res of results) {
  packages += (res.Packages ?? []).length;
  for (const vuln of res.Vulnerabilities ?? []) vulns.push(vuln);
}

console.log(
  `\nScanned ${String(results.length)} target(s), ${String(packages)} package(s), severity HIGH,CRITICAL.`,
);
for (const res of results) {
  console.log(
    `  target: ${res.Target ?? '(unnamed)'}  packages: ${String((res.Packages ?? []).length)}`,
  );
}

// The anti-vacuous-pass assertion. See the header comment.
if (packages === 0) {
  failures.push(
    'Trivy examined ZERO packages. A vulnerability gate that scans nothing exits 0 and means ' +
      'nothing. Check that pnpm-lock.yaml exists at the repository root and that --include-dev-deps ' +
      'is still passed.',
  );
}

if (vulns.length > 0) {
  console.log('');
  for (const vuln of vulns) {
    console.log(
      `  ${String(vuln.Severity)}  ${String(vuln.VulnerabilityID)}  ` +
        `${String(vuln.PkgName)}@${String(vuln.InstalledVersion)}  ` +
        `fixed in ${vuln.FixedVersion === undefined || vuln.FixedVersion === '' ? '(no fix available)' : vuln.FixedVersion}`,
    );
  }
  failures.push(
    `${String(vulns.length)} HIGH/CRITICAL vulnerability(ies) in the dependency tree. ` +
      'Upgrade, or record an accepted risk in .trivyignore with an owner, a reason and an expiry.',
  );
}

finish('gate:trivy', failures);
