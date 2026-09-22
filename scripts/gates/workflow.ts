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
 *       `strategy.matrix.gate` ARRAY of the blocking job must equal the
 *       roster's BLOCKING + BLOCKED names exactly, and the advisory job's the
 *       PENDING + SERVICE names exactly. A gate added locally and not here, or
 *       here and not locally, is a FAIL.
 *
 *       IT COMPARES THAT ARRAY, NOT THE EFFECTIVE MATRIX (QR2-A4, narrowed
 *       2026-09-20). GitHub builds a matrix from `gate:` AND from `include:` /
 *       `exclude:`. This gate reads `strategy.matrix.gate` only, so a leg added
 *       through `include:` is invisible to W4 and to W7 alike — measured by
 *       qa-verification: `include: [{ gate: gate:does-not-exist }]` beside the
 *       existing list leaves this gate GATE PASS at `29 concrete`, while on a
 *       runner it would create a 23rd leg running an undeclared script. Reading
 *       `include`/`exclude` into both checks is a few lines and it is NOT done
 *       here: it is a live route, and a route is closed by a ticket with its own
 *       red-before/green-after cases, not by a comment (PROTOCOL §6.5's
 *       distinction, applied by the implementer rather than to it). Carried as
 *       decisions.md OD-173 with T-005 § Integration naming it.
 *   W5  the CLASS mirror: the advisory job carries `continue-on-error: true`
 *       and the blocking job does not. Without this, W4 could pass while the
 *       file made a pending hook blocking or a blocking gate advisory.
 *   W6  `fetch-depth: 0` on every `actions/checkout`. gate:migration-lint's
 *       R-TRAILER reads `merge-base..HEAD` (T-031 § contract; CONTRACTS.md
 *       addresses this to T-005 by name) and a shallow checkout breaks it.
 *   W8  DIVERGENCE, both ways, against scripts/gates/lib/heavy-roster.ts, for
 *       .github/workflows/heavy.yml — SD §QD-4's SECOND PR-stage row, which
 *       `pnpm gate:heavy` runs (T-006). Same three readings as W4/W5: the
 *       blocking job's `strategy.matrix.gate` array equals the heavy roster's
 *       BLOCKING + BLOCKED names, the advisory job's its PENDING + SERVICE
 *       names, and the class mirror holds. IT INHERITS W4's BOUND EXACTLY: it
 *       compares those arrays and not the effective matrix, so an `include:`
 *       leg is invisible to it (OD-173).
 *   W7  every `run:` step that invokes pnpm names a script that EXISTS in
 *       package.json — INCLUDING through a `${{ matrix.<key> }}` expression,
 *       which is expanded against that job's own `strategy.matrix.<key>` values
 *       (the values W4 has already held against the roster) and checked once
 *       per value. A pnpm `run:` step carrying an expression this gate cannot
 *       resolve is REFUSED, not skipped.
 *
 *       THE EXPANSION IS NOT A REFINEMENT, IT IS THE WHOLE OF W7 ON THIS FILE.
 *       Both real `run:` steps in pr.yml are `pnpm run ${{ matrix.gate }}`, and
 *       until rework 1 the rule's pattern excluded `$`, `{` and `}`, so both
 *       were silently skipped: QA changed them to `${{ matrix.nosuch }}` —
 *       which would fail all 29 jobs on a runner — and this gate stayed green.
 *       Cases F7 and F8 are the two halves of the corrected rule.
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
 *   * NOT anything about a `run:` step that does NOT start with `pnpm`. W7
 *     reads pnpm invocations only; any other shell command is structurally
 *     checked by W2 and otherwise unexamined — including `npx pnpm run <x>`,
 *     measured GATE PASS. Nor does it read a pnpm line that is not a bare
 *     `pnpm [run] <script>`. THE THREE SHAPES THAT ARE SILENTLY SKIPPED, named
 *     individually because "chained or flag-bearing" is not what a reader reads
 *     that as (QR2-A5, widened 2026-09-20 from qa-verification's measurements):
 *       - a CHAINED line, `pnpm run a && pnpm run b`;
 *       - a FLAG-BEARING line, `pnpm run ${{ matrix.gate }} --filter nosuch`,
 *         which also drops W7's count to `0 concrete` while the gate passes;
 *       - a MULTI-LINE `run: |` BLOCK whose first word is `pnpm`, which is the
 *         most ordinary shape a real CI step takes.
 *     Each was measured GATE PASS with an undeclared script inside it. That
 *     bound is unchanged by the expansion above.
 *   * NOT that W7 checked ANYTHING. It prints the number of concrete
 *     invocations it resolved and nothing in this gate asserts that number is
 *     greater than zero (QR2-A3). It is caught one level up — case F0 in
 *     pr-gates.sh AND case W0 in heavy-gates.sh each require the exact
 *     `W7: <n> concrete` line this gate prints, so a committed workflow of the
 *     flag-bearing shape goes red in gate:pr-gate-suite or in
 *     gate:negative-suites — but the gate a reader runs ALONE passes at zero
 *     coverage. THE LITERAL IS DELIBERATELY NOT SPELLED HERE (OD-190): it was
 *     29 when T-005 wrote this line, 30 after T-008 added a gate and 36 after
 *     T-006 added a second workflow file, and this sentence moved with none of
 *     them. The pins are in the two suites, where a wrong one goes red; a prose
 *     copy of a number is a copy that goes stale silently (PROTOCOL §5.3 R1:
 *     prefer a number the machine prints). The one-line floor belongs in this
 *     file and is T-174's, which already owns it by name.
 *   * NOT anything about `merge`, `production` or `migrations` stages of
 *     SD §QD-4. This gate covers SD's two PR-stage rows — pr.yml against
 *     scripts/gates/lib/roster.ts (W4/W5) and heavy.yml against
 *     scripts/gates/lib/heavy-roster.ts (W8). A THIRD workflow file added
 *     later is parsed and structurally checked (W1, W2, W6, W7) and is held
 *     against no roster; that bound is unchanged by T-006, only narrowed from
 *     "a second workflow file" to "a third", because the second one now has a
 *     roster of its own.
 *   * NOT that the heavy stage's `services:` block or its Docker daemon would
 *     work on a runner. W2 does not read `services:` at all. heavy.yml's own
 *     header says what a runner would need; nothing here checks it, and
 *     nothing could without running it.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT, finish } from './lib/run.ts';
import { ROSTER } from './lib/roster.ts';
import { HEAVY_ROSTER } from './lib/heavy-roster.ts';

const DIR = '.github/workflows';
const PR_FILE = 'pr.yml';
const HEAVY_FILE = 'heavy.yml';
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

/** How many concrete `pnpm <script>` commands W7 resolved and checked. */
let runChecked = 0;

/**
 * Expand every `${{ … }}` in a `run:` command against the job's matrix.
 *
 * A `${{ matrix.<key> }}` whose key is a non-empty array of scalars in this
 * job's `strategy.matrix` expands to one command per value — that is how
 * `pnpm run ${{ matrix.gate }}` becomes 22 concrete commands. Anything else is
 * returned as UNRESOLVED and the caller fails on it; nothing is dropped.
 */
function expandExpressions(
  cmd: string,
  matrix: Readonly<Record<string, unknown>> | undefined,
): { commands: string[]; unresolved: string[] } {
  const unresolved: string[] = [];
  let commands = [cmd];
  for (const found of cmd.match(/\$\{\{[^}]*\}\}/g) ?? []) {
    const inner = found.slice(3, -2).trim();
    const key = /^matrix\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(inner)?.[1];
    const values: unknown = key === undefined ? undefined : matrix?.[key];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((v) => typeof v !== 'string' && typeof v !== 'number')
    ) {
      unresolved.push(found);
      continue;
    }
    commands = commands.flatMap((c) =>
      (values as readonly (string | number)[]).map((v) => c.split(found).join(String(v))),
    );
  }
  return { commands, unresolved };
}

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
        if (/^pnpm\b/.test(cmd)) {
          const { commands, unresolved } = expandExpressions(cmd, matrix);
          for (const expr of unresolved) {
            failures.push(
              `W7 ${at} step ${String(i)}: runs \`${cmd}\`, which carries the expression ` +
                `\`${expr}\`, and this gate cannot resolve it. It resolves ` +
                '`${{ matrix.<key> }}` against the strategy.matrix of the job the step is in, ' +
                'and nothing else. An unresolvable expression is an UNCHECKED command, so it ' +
                'is refused here rather than skipped — skipping is how both of the real run: ' +
                'steps in this workflow went unchecked until rework 1.',
            );
          }
          if (unresolved.length === 0) {
            for (const resolvedCmd of commands) {
              const m = /^pnpm\s+(?:run\s+)?(?!install\b|--)([^\s${}]+)\s*$/.exec(resolvedCmd);
              if (m?.[1] === undefined) continue;
              runChecked += 1;
              if (!scripts.has(m[1])) {
                const via = resolvedCmd === cmd ? '' : ` (from \`${cmd}\`)`;
                failures.push(
                  `W7 ${at} step ${String(i)}: runs \`${resolvedCmd}\`${via}, and package.json ` +
                    `declares no script \`${m[1]}\`.`,
                );
              }
            }
          }
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

function matrixGates(jobs: Record<string, Job>, jobId: string): string[] | undefined {
  const job = jobs[jobId];
  const v = job?.strategy?.matrix?.['gate'];
  return Array.isArray(v) ? v.map((x) => String(x)) : undefined;
}

const wantBlocking = ROSTER.filter((e) => e.cls === 'BLOCKING' || e.cls === 'BLOCKED').map(
  (e) => e.name,
);
const wantAdvisory = ROSTER.filter((e) => e.cls === 'PENDING' || e.cls === 'SERVICE').map(
  (e) => e.name,
);

function compare(
  file: string,
  jobs: Record<string, Job>,
  label: string,
  jobId: string,
  want: readonly string[],
): void {
  const W = file === PR_FILE ? 'W4' : 'W8';
  const got = matrixGates(jobs, jobId);
  if (got === undefined) {
    failures.push(`${W} ${DIR}/${file}: job \`${jobId}\` has no strategy.matrix.gate array`);
    return;
  }
  const missing = want.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !want.includes(n));
  const dupes = got.filter((n, i) => got.indexOf(n) !== i);
  if (missing.length > 0) {
    failures.push(
      `${W} ${label}: in the roster but NOT in ${DIR}/${file} job \`${jobId}\`: ${missing.join(', ')}. ` +
        'The workflow and the local aggregate have diverged — that is the divergence check T-005 ' +
        'is accepted on.',
    );
  }
  if (extra.length > 0) {
    failures.push(
      `${W} ${label}: in ${DIR}/${file} job \`${jobId}\` but NOT in the roster: ${extra.join(', ')}.`,
    );
  }
  if (dupes.length > 0)
    failures.push(`${W} ${label}: duplicated in the matrix: ${[...new Set(dupes)].join(', ')}`);
  if (missing.length === 0 && extra.length === 0 && dupes.length === 0) {
    console.log(`  ok  ${file}: ${label}: ${String(got.length)} gate(s), identical to the roster`);
  }
}

compare(PR_FILE, prJobs, 'blocking gates', 'blocking', wantBlocking);
compare(PR_FILE, prJobs, 'not-yet-supplied gates', 'advisory', wantAdvisory);

// -------------------------------------------------------------------- W8
// SD §QD-4's SECOND PR-stage row. Held against its own roster, both ways, with
// its own class mirror — because a heavy gate that exists locally and not here
// (or here and not locally) is the same divergence W4 refuses, one row over.
const heavyDoc = parsedDocs.get(HEAVY_FILE);
if (heavyDoc === undefined) {
  failures.push(
    `W8 ${DIR}/${HEAVY_FILE} is missing or unparseable — SD §QD-4's "PR (heavy)" row is ` +
      'mirrored there and there is nothing to hold the heavy roster against',
  );
} else {
  const heavyJobs = (heavyDoc['jobs'] ?? {}) as Record<string, Job>;
  compare(
    HEAVY_FILE,
    heavyJobs,
    'heavy blocking gates',
    'blocking',
    HEAVY_ROSTER.filter((e) => e.cls === 'BLOCKING' || e.cls === 'BLOCKED').map((e) => e.name),
  );
  compare(
    HEAVY_FILE,
    heavyJobs,
    'heavy not-yet-supplied gates',
    'advisory',
    HEAVY_ROSTER.filter((e) => e.cls === 'PENDING' || e.cls === 'SERVICE').map((e) => e.name),
  );
  classMirror(HEAVY_FILE, heavyJobs);
}

// W5 — the class mirror. Applied to pr.yml here and to heavy.yml under W8.
function classMirror(file: string, jobs: Record<string, Job>): void {
  const W = file === PR_FILE ? 'W5' : 'W8';
  const blockingCoE = jobs['blocking']?.['continue-on-error'];
  const advisoryCoE = jobs['advisory']?.['continue-on-error'];
  if (blockingCoE === true || blockingCoE === 'true') {
    failures.push(
      `${W} ${DIR}/${file}: job \`blocking\` carries continue-on-error. Every gate in it would then ` +
        'produce a green check having failed — the exact failure platform-infrastructure.md names first.',
    );
  }
  if (advisoryCoE !== true && advisoryCoE !== 'true') {
    failures.push(
      `${W} ${DIR}/${file}: job \`advisory\` does not carry \`continue-on-error: true\`, so the ` +
        'workflow makes not-yet-supplied hooks blocking where the local aggregate does not. The two ' +
        'stages must mean the same thing.',
    );
  }
  if (blockingCoE === undefined && advisoryCoE === true) {
    console.log(`  ok  ${file}: the class mirror — blocking blocks, advisory is continue-on-error`);
  }
}
classMirror(PR_FILE, prJobs);

console.log(
  `  ok  W7: ${String(runChecked)} concrete \`pnpm <script>\` invocation(s) checked against ` +
    `package.json, after expanding every \`\${{ matrix.<key> }}\` in a pnpm \`run:\` step`,
);

console.log(
  `\n  This file is AUTHORED AND VALIDATED, NEVER EXECUTED. There is no remote (PROTOCOL §3), ` +
    `so nothing here has ever run. The evidence that these gates block is \`pnpm gate:pr\`.`,
);

finish('gate:workflow', failures);
