/**
 * gate:trivy — Trivy filesystem scan. SD §QD-4 PR row: "`pnpm audit` + Trivy".
 *
 * Scans the pnpm lockfile for known vulnerabilities in the dependency tree.
 * Trivy needs its vulnerability database, so this gate has to run under
 * `scripts/dev` (egress) and NOT under `scripts/svc run` (no egress,
 * DOCKER.md §7). The database is cached in .cache/trivy, which is gitignored,
 * so repeat runs do not re-download it.
 */
import path from 'node:path';
import { REPO_ROOT, capture, stream, finish, toolVersions } from './lib/run.ts';

const failures: string[] = [];
const pinned = toolVersions().get('trivy');

const v = capture('trivy', ['--version']);
if (v.spawnFailed || v.code !== 0) {
  failures.push(
    'trivy is not on PATH. It lives in the toolbox image — run `scripts/dev --build`.',
  );
} else {
  const firstLine = v.stdout.split('\n')[0] ?? '';
  const found = firstLine.replace(/^Version:\s*/, '').trim();
  console.log(`trivy ${found} (pinned ${String(pinned)})`);
  if (pinned !== undefined && found !== pinned) {
    failures.push(`trivy ${found} != .tool-versions pin ${pinned}; rebuild the toolbox`);
  }
}

if (failures.length === 0) {
  const cache = path.join(REPO_ROOT, '.cache', 'trivy');
  process.env['TRIVY_CACHE_DIR'] = cache;
  process.env['TRIVY_NO_PROGRESS'] = 'true';
  console.log(
    '\n$ trivy fs --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --ignorefile .trivyignore .',
  );
  const code = stream('trivy', [
    'fs',
    '--scanners',
    'vuln',
    '--severity',
    'HIGH,CRITICAL',
    '--exit-code',
    '1',
    '--no-progress',
    '--ignorefile',
    '.trivyignore',
    '--skip-dirs',
    '.cache',
    '--skip-dirs',
    'node_modules',
    '.',
  ]);
  if (code !== 0) {
    failures.push(`trivy exited ${String(code)} — HIGH/CRITICAL vulnerabilities found`);
  }
}

finish('gate:trivy', failures);
