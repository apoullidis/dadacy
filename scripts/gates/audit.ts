/**
 * gate:audit — `pnpm audit`, the half of SD §QD-4's "`pnpm audit` + Trivy" that
 * T-001 deliberately left out. T-005 confirms or reverses that call; the
 * reasoning is in state/EP-1/T-005.md § The `pnpm audit` decision. In short:
 * Trivy and pnpm read the SAME lockfile but NOT the same advisory data — Trivy
 * scans its own vulnerability database, `pnpm audit` queries the GitHub
 * Advisory Database through the registry — so this is a second source, not a
 * second reading of one source, and SD names both.
 *
 * THRESHOLD. HIGH and CRITICAL block, which is exactly `gate:trivy`'s
 * `--severity HIGH,CRITICAL`. One threshold across both halves of the row, so a
 * finding cannot block in one and pass in the other. MODERATE, LOW and INFO are
 * PRINTED IN FULL, with their package and path, and do not block — they are
 * reported so they can be routed to the package owner, because the packages
 * they land in are not this ticket's to bump.
 *
 * HOW IT CANNOT PASS VACUOUSLY. This is the Trivy zero-package defect's twin
 * and it is guarded the same way:
 *
 *   A1  `pnpm audit --json` must produce parseable JSON with a `metadata`
 *       object. A registry that cannot be reached, an auth failure or a changed
 *       output shape is a FAIL, never "no vulnerabilities".
 *   A2  `metadata.totalDependencies` must be > 0. An audit over an empty
 *       dependency graph reports zero advisories and would otherwise be
 *       indistinguishable from a clean one.
 *   A3  the severity buckets reported must be the five pnpm documents. A new
 *       bucket this gate does not read is a FAIL, not a silently ignored class.
 *
 * NETWORK. `pnpm audit` reaches the registry, so this gate runs under
 * `scripts/dev` (egress) and NOT under `scripts/svc run` (DOCKER.md §7).
 * `gate:trivy` already has that requirement, so `gate:pr` gains no new one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, capture, finish } from './lib/run.ts';

const BLOCKING: readonly string[] = ['critical', 'high'];
const REPORTED: readonly string[] = ['moderate', 'low', 'info'];
const KNOWN = [...BLOCKING, ...REPORTED];

const failures: string[] = [];

if (!fs.existsSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'))) {
  finish('gate:audit', ['pnpm-lock.yaml does not exist — there is nothing to audit']);
}

console.log('$ pnpm audit --json');
const r = capture('pnpm', ['audit', '--json']);
// pnpm exits non-zero when it FINDS something; that is not an error here. A
// spawn failure, or output that is not a report, is.
if (r.spawnFailed) {
  finish('gate:audit', [`could not execute pnpm audit: ${r.stderr.trim()}`]);
}

interface Finding {
  readonly paths?: readonly string[];
  readonly dev?: boolean;
}
interface Advisory {
  readonly title?: string;
  readonly module_name?: string;
  readonly severity?: string;
  readonly vulnerable_versions?: string;
  readonly patched_versions?: string;
  readonly url?: string;
  readonly findings?: readonly Finding[];
}
interface Report {
  readonly advisories?: Readonly<Record<string, Advisory>>;
  readonly metadata?: {
    readonly vulnerabilities?: Readonly<Record<string, number>>;
    readonly totalDependencies?: number;
  };
}

let report: Report;
try {
  const parsed: unknown = JSON.parse(r.stdout);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  report = parsed as Report;
} catch (e) {
  finish('gate:audit', [
    `A1 pnpm audit did not produce a parseable report (exit ${String(r.code)}): ` +
      `${e instanceof Error ? e.message : String(e)}. This is a FAIL, not "no vulnerabilities" — ` +
      'an unreachable registry must never look like a clean audit. First 400 bytes of stdout: ' +
      JSON.stringify(r.stdout.slice(0, 400)) +
      ' stderr: ' +
      JSON.stringify(r.stderr.slice(0, 400)),
  ]);
}

const meta = report.metadata;
const buckets = meta?.vulnerabilities;
if (meta === undefined || buckets === undefined) {
  finish('gate:audit', ['A1 the report has no `metadata.vulnerabilities` — output shape changed']);
}
const totalDeps = meta.totalDependencies ?? 0;
if (totalDeps <= 0) {
  failures.push(
    `A2 pnpm audit examined ${String(totalDeps)} dependencies. An audit over nothing reports ` +
      'zero advisories and looks exactly like a clean one (the Trivy zero-package defect, OD-3).',
  );
}
for (const k of Object.keys(buckets)) {
  if (!KNOWN.includes(k)) {
    failures.push(
      `A3 pnpm reported a severity bucket this gate does not read: ${JSON.stringify(k)}. ` +
        'Add it to BLOCKING or REPORTED in scripts/gates/audit.ts — a class nobody reads is a ' +
        'class nobody blocks on.',
    );
  }
}

console.log(`  dependencies audited: ${String(totalDeps)}`);
console.log(`  advisories: ${KNOWN.map((k) => `${k} ${String(buckets[k] ?? 0)}`).join(', ')}`);

const advisories = Object.values(report.advisories ?? {});
const bySeverity = (sev: string): Advisory[] =>
  advisories.filter((a) => (a.severity ?? '').toLowerCase() === sev);

for (const sev of BLOCKING) {
  for (const a of bySeverity(sev)) {
    failures.push(
      `${sev.toUpperCase()} ${a.module_name ?? '?'} ${a.vulnerable_versions ?? ''} — ` +
        `${a.title ?? ''} (fixed in ${a.patched_versions ?? '?'}) ${a.url ?? ''} via ` +
        `${(a.findings ?? [])
          .flatMap((f) => f.paths ?? [])
          .slice(0, 3)
          .join(', ')}`,
    );
  }
}

let reportedCount = 0;
for (const sev of REPORTED) {
  for (const a of bySeverity(sev)) {
    reportedCount += 1;
    console.log(
      `  ${sev.toUpperCase().padEnd(8)} ${(a.module_name ?? '?').padEnd(20)} ` +
        `${a.vulnerable_versions ?? ''} -> ${a.patched_versions ?? '?'}  ${a.title ?? ''}`,
    );
    for (const p of (a.findings ?? []).flatMap((f) => f.paths ?? []).slice(0, 4)) {
      console.log(`             via ${p}`);
    }
    console.log(`             ${a.url ?? ''}`);
  }
}
console.log(
  `\n  ${String(reportedCount)} advisory(ies) below the blocking threshold are printed above and ` +
    'are NOT this gate’s to fix: they land in packages owned by other agents. Route them.',
);
console.log(
  '  Blocking threshold: HIGH + CRITICAL, the same as gate:trivy’s --severity HIGH,CRITICAL.',
);

finish('gate:audit', failures);
