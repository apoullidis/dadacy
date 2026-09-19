/**
 * gate:workflow — the authored-but-never-executed CI YAML. T-005.
 *
 * PROTOCOL §5.1: "Authored, validated, not executed — that is the workflow
 * YAML's status, exactly as Terraform's is. T-005's evidence is that the YAML
 * is schema-valid, that every gate in SD §QD-4 appears in it, and that the same
 * gate runs and blocks locally."
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS VALIDATED WITHOUT BEING RUN, AND WHAT THAT DOES NOT PROVE.
 * Stated here rather than left for a reader to assume, because the difference
 * is the whole point of the file's status.
 *
 * WHAT IS CHECKED:
 *   W1  it PARSES as YAML, by the same `yaml` parser the compose gates use.
 *       A file that does not parse is not a workflow.
 *   W2  the STRUCTURE GitHub requires: a top-level mapping with `on` and a
 *       non-empty `jobs` mapping; every job an object with `runs-on` and a
 *       non-empty `steps` array; every step having exactly one of `uses` or
 *       `run`; every `strategy.matrix` value a non-empty array. A job id that
 *       is not a valid GitHub job id (`[A-Za-z_][A-Za-z0-9_-]*`) is refused.
 *   W3  `on` is not swallowed by YAML 1.1's boolean rule. `on:` is the one key
 *       in this schema that a 1.1 loader reads as `true:` — this gate asserts
 *       the parsed key set contains `on` as a STRING, so a parser change that
 *       silently renames the trigger key is caught rather than inherited.
 *   W4  DIVERGENCE, both ways, against scripts/gates/lib/roster.ts: the
 *       blocking matrix must equal the roster's BLOCKING + BLOCKED names
 *       exactly, and the advisory matrix the PENDING + SERVICE names exactly.
 *       A gate added locally and not here, or here and not locally, is a FAIL.
 *   W5  the CLASS mirror: the advisory job carries `continue-on-error: true`
 *       and the blocking job does not. Without this, W4 could pass while the
 *       file made a pending hook blocking or a blocking gate advisory.
 *   W6  `fetch-depth: 0` on every `actions/checkout`. gate:migration-lint's
 *       R-TRAILER reads `merge-base..HEAD` (T-031 § contract; CONTRACTS.md
 *       addresses this to T-005 by name) and a shallow checkout breaks it.
 *   W7  every `run:` step invokes a pnpm script that EXISTS in package.json.
 *       A job that runs a script nobody defined would fail on a runner nobody
 *       has; it fails here instead.
 *
 * WHAT IT DOES NOT PROVE, and cannot:
 *   * NOT that GitHub would accept the file. This is a structural check against
 *     the subset of the Actions schema this workflow uses, not the published
 *     JSON Schema. Validating against that schema needs either a network fetch
 *     at gate time (gate:semgrep's contract is that a gate makes no network
 *     call, and Trivy's DB already costs this stage its egress requirement) or
 *     a vendored copy plus a validator dependency — which is a supply-chain
 *     decision, not a formatting one (see gate:supply-chain, OD-51). Named as a
 *     bound rather than filled with an assumption.
 *   * NOT that any referenced action (`actions/checkout@v4`,
 *     `pnpm/action-setup@v4`) exists, is at that version, or behaves as
 *     assumed. Nothing here resolves a reference.
 *   * NOT that the jobs would PASS. That is what `pnpm gate:pr` is for, and it
 *     is the only evidence this build accepts (PROTOCOL §5.1: "A gate whose
 *     only proof is a green YAML file is not wired to anything").
 *   * NOT anything about `merge`, `production` or `migrations` stages of
 *     SD §QD-4. This gate covers the PR row and the files in .github/workflows;
 *     a second workflow file added later is parsed and structurally checked
 *     (W1, W2, W6, W7) but only pr.yml is held against the roster.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT, finish } from './lib/run.ts';
import { ROSTER } from './lib/roster.ts';

const DIR = '.github/workflows';
const PR_FILE = 'pr.yml';
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const failures: string[] = [];

const absDir = path.join(REPO_ROOT, DIR);
if (!fs.existsSync(absDir)) finish('gate:workflow', [`${DIR} does not exist`]);
const files = fs
  .readdirSync(absDir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();
if (files.length === 0) {
  finish('gate:workflow', [
    `${DIR} contains no workflow file. SD §QD-4's stages are mirrored here; an empty directory ` +
      'is the "gate silently absent" case.',
  ]);
}
console.log(`workflow files: ${files.join(', ')}`);

const pkg: unknown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const scripts = new Set(Object.keys((pkg as { scripts?: Record<string, string> }).scripts ?? {}));

interface Step {
  readonly uses?: unknown;
  readonly run?: unknown;
  readonly with?: Readonly<Record<string, unknown>>;
}
interface Job {
  readonly 'runs-on'?: unknown;
  readonly steps?: unknown;
  readonly strategy?: { readonly matrix?: Readonly<Record<string, unknown>> };
  readonly 'continue-on-error'?: unknown;
}

const parsedDocs = new Map<string, Record<string, unknown>>();

for (const f of files) {
  const text = fs.readFileSync(path.join(absDir, f), 'utf8');
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    failures.push(
      `W1 ${DIR}/${f}: does not parse as YAML — ${e instanceof Error ? e.message : String(e)}`,
    );
    continue;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    failures.push(`W1 ${DIR}/${f}: top level is not a mapping`);
    continue;
  }
  const root = doc as Record<string, unknown>;
  parsedDocs.set(f, root);

  // W3 — `on` must survive as the string key `on`.
  if (!Object.prototype.hasOwnProperty.call(root, 'on')) {
    const keys = Object.keys(root);
    failures.push(
      `W3 ${DIR}/${f}: no \`on\` key (keys: ${keys.join(', ')}). YAML 1.1 reads a bare \`on:\` as ` +
        'the boolean `true`; if that is what happened here the trigger has been silently renamed.',
    );
  }

  const jobs = root['jobs'];
  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)) {
    failures.push(`W2 ${DIR}/${f}: \`jobs\` is missing or is not a mapping`);
    continue;
  }
  const jobEntries = Object.entries(jobs as Record<string, unknown>);
  if (jobEntries.length === 0) failures.push(`W2 ${DIR}/${f}: \`jobs\` is empty`);

  for (const [id, rawJob] of jobEntries) {
    const at = `${DIR}/${f} job ${id}`;
    if (!JOB_ID.test(id)) failures.push(`W2 ${at}: not a valid job id`);
    if (typeof rawJob !== 'object' || rawJob === null || Array.isArray(rawJob)) {
      failures.push(`W2 ${at}: not a mapping`);
      continue;
    }
    const job = rawJob as Job;
    if (typeof job['runs-on'] !== 'string') failures.push(`W2 ${at}: no \`runs-on\``);
    const steps = job.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      failures.push(`W2 ${at}: \`steps\` is missing or empty`);
      continue;
    }
    const matrix = job.strategy?.matrix;
    if (matrix !== undefined) {
      for (const [k, v] of Object.entries(matrix)) {
        if (!Array.isArray(v) || v.length === 0) {
          failures.push(`W2 ${at}: strategy.matrix.${k} is not a non-empty array`);
        }
      }
    }
    for (const [i, rawStep] of steps.entries()) {
      if (typeof rawStep !== 'object' || rawStep === null || Array.isArray(rawStep)) {
        failures.push(`W2 ${at} step ${String(i)}: not a mapping`);
        continue;
      }
      const step = rawStep as Step;
      const hasUses = typeof step.uses === 'string';
      const hasRun = typeof step.run === 'string';
      if (hasUses === hasRun) {
        failures.push(`W2 ${at} step ${String(i)}: needs exactly one of \`uses\` or \`run\``);
        continue;
      }
      // W6
      if (hasUses && String(step.uses).startsWith('actions/checkout')) {
        const depth = step.with?.['fetch-depth'];
        if (depth !== 0 && depth !== '0') {
          failures.push(
            `W6 ${at} step ${String(i)}: actions/checkout without \`fetch-depth: 0\`. ` +
              "gate:migration-lint's R-TRAILER reads merge-base..HEAD (T-031 § contract; " +
              'CONTRACTS.md addresses this to T-005 by name) and a shallow checkout breaks it.',
          );
        }
      }
      // W7
      if (hasRun) {
        const cmd = String(step.run).trim();
        const m = /^pnpm\s+(?:run\s+)?(?!install\b|--)([^\s${}]+)\s*$/.exec(cmd);
        if (m?.[1] !== undefined && !scripts.has(m[1])) {
          failures.push(
            `W7 ${at} step ${String(i)}: runs \`${cmd}\`, and package.json declares no script ` +
              `\`${m[1]}\`.`,
          );
        }
      }
    }
  }
}

// -------------------------------------------------------------- W4 / W5 / W7
const prDoc = parsedDocs.get(PR_FILE);
if (prDoc === undefined) {
  finish('gate:workflow', [
    ...failures,
    `W4 ${DIR}/${PR_FILE} is missing or unparseable — there is nothing to hold the roster against`,
  ]);
}
const prJobs = (prDoc['jobs'] ?? {}) as Record<string, Job>;

function matrixGates(jobId: string): string[] | undefined {
  const job = prJobs[jobId];
  const v = job?.strategy?.matrix?.['gate'];
  return Array.isArray(v) ? v.map((x) => String(x)) : undefined;
}

const wantBlocking = ROSTER.filter((e) => e.cls === 'BLOCKING' || e.cls === 'BLOCKED').map(
  (e) => e.name,
);
const wantAdvisory = ROSTER.filter((e) => e.cls === 'PENDING' || e.cls === 'SERVICE').map(
  (e) => e.name,
);

function compare(label: string, jobId: string, want: readonly string[]): void {
  const got = matrixGates(jobId);
  if (got === undefined) {
    failures.push(`W4 ${DIR}/${PR_FILE}: job \`${jobId}\` has no strategy.matrix.gate array`);
    return;
  }
  const missing = want.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !want.includes(n));
  const dupes = got.filter((n, i) => got.indexOf(n) !== i);
  if (missing.length > 0) {
    failures.push(
      `W4 ${label}: in the roster but NOT in ${DIR}/${PR_FILE} job \`${jobId}\`: ${missing.join(', ')}. ` +
        'The workflow and the local aggregate have diverged — that is the divergence check T-005 ' +
        'is accepted on.',
    );
  }
  if (extra.length > 0) {
    failures.push(
      `W4 ${label}: in ${DIR}/${PR_FILE} job \`${jobId}\` but NOT in the roster: ${extra.join(', ')}.`,
    );
  }
  if (dupes.length > 0)
    failures.push(`W4 ${label}: duplicated in the matrix: ${[...new Set(dupes)].join(', ')}`);
  if (missing.length === 0 && extra.length === 0 && dupes.length === 0) {
    console.log(`  ok  ${label}: ${String(got.length)} gate(s), identical to the roster`);
  }
}

compare('blocking gates', 'blocking', wantBlocking);
compare('not-yet-supplied gates', 'advisory', wantAdvisory);

// W5 — the class mirror.
const blockingCoE = prJobs['blocking']?.['continue-on-error'];
const advisoryCoE = prJobs['advisory']?.['continue-on-error'];
if (blockingCoE === true || blockingCoE === 'true') {
  failures.push(
    `W5 ${DIR}/${PR_FILE}: job \`blocking\` carries continue-on-error. Every gate in it would then ` +
      'produce a green check having failed — the exact failure platform-infrastructure.md names first.',
  );
}
if (advisoryCoE !== true && advisoryCoE !== 'true') {
  failures.push(
    `W5 ${DIR}/${PR_FILE}: job \`advisory\` does not carry \`continue-on-error: true\`, so the ` +
      'workflow makes not-yet-supplied hooks blocking where the local aggregate does not. The two ' +
      'stages must mean the same thing.',
  );
}
if (blockingCoE === undefined && advisoryCoE === true) {
  console.log('  ok  the class mirror: blocking blocks, advisory is continue-on-error');
}

console.log(
  `\n  This file is AUTHORED AND VALIDATED, NEVER EXECUTED. There is no remote (PROTOCOL §3), ` +
    `so nothing here has ever run. The evidence that these gates block is \`pnpm gate:pr\`.`,
);

finish('gate:workflow', failures);
