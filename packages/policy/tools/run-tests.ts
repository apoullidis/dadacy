/**
 * `pnpm --filter policy test -- --coverage` — Vitest 5.0.0 with v8 coverage,
 * plus a refusal of any run that did not execute every test this package
 * declares, and a refusal of any run below 100% branch coverage.
 *
 * PROVENANCE: the run-accounting half (checks 1-6 below) is a copy of
 * packages/i18n/tools/run-tests.ts at `e7fe917` (T-132), changed only in the
 * package name, the temp-dir prefix and TEST_DIRS. Its checks and its GAPS are
 * therefore T-132's, stated at true width in state/EP-0/T-132.md § Published
 * contract (rework 2) §3-§4, which applies here unchanged, open routes
 * included. T-023 made the same copy for the same reason.
 *
 * Why not bare `vitest run`: Vitest exits 0 when a test is skipped or marked
 * todo, and its JSON report records an expected-fail (`test.fails`) as
 * `passed` with no field that marks it (T-115 § Published contract §4). So a
 * regression that stops a test running would be green on exit status alone --
 * the harness-no-op class of PROTOCOL §5.1. This reads two reports of ONE run
 * and requires all of:
 *
 *   1. Vitest exited 0 and wrote its JSON report, to a path created fresh for
 *      this run, so a stale report cannot stand in for it.
 *   2. The report: total > 0, passed === total, failed = skipped = todo = 0,
 *      no failed suite, `success`; and its per-test statuses re-count to those
 *      totals.
 *   3. The report's file set equals `src/*.test.ts` as read from the
 *      directory, not from Vitest.
 *   4. BY NAME: every `test(` / `it(` call whose title is a string literal
 *      appears with that exact title in Vitest's report FOR THAT FILE, with
 *      status `passed`, once per source occurrence. Expected titles are read
 *      from the source text, never from the report.
 *   5. Every file registered at run time at least as many tests as it has
 *      `test(` / `it(` call sites at the start of a line in its source.
 *   6. The text reporter's summary line reads exactly `Tests  N passed (N)`.
 *
 * AND, this package's own reason for existing (SD §QD-1's Policy row --
 * "100% branch, a CI gate, not a target"):
 *
 *   7. COVERAGE. Coverage is not optional and is not caller-supplied: this
 *      runner always passes the coverage flags, so `--coverage` on the command
 *      line is accepted and redundant rather than load-bearing. A run that
 *      omitted the flag could not be greener than one that passed it, which is
 *      the point -- the published gate command cannot be weakened by dropping
 *      an argument. Two independent refusals:
 *        (a) Vitest's own `--coverage.thresholds.*=100`, which fails the run;
 *        (b) this runner reading `coverage-summary.json` and requiring
 *            branches/functions/lines/statements pct === 100 for the TOTAL and
 *            for EVERY file under src/ that is not a test.
 *      (b) exists because a threshold Vitest did not apply -- a renamed flag,
 *      a provider that silently produced no report -- is indistinguishable
 *      from a threshold it met. If the summary is missing or carries no total,
 *      that is a failure and never a pass.
 *
 * It takes no arguments other than an optional `--coverage`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIRS = ['src'];
const COUNTS = [
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
  'numFailedTestSuites',
] as const;

interface FileResult {
  name: string;
  status: string;
  assertionResults: { title: string; status: string }[];
}
type Report = Record<(typeof COUNTS)[number], number> & {
  success: boolean;
  testResults: FileResult[];
};
interface DeclaredTitle {
  title: string;
  line: number;
}
interface DeclaredFile {
  sites: number;
  titles: DeclaredTitle[];
}
interface CoverageMetric {
  pct: number;
  total: number;
  covered: number;
}
interface CoverageEntry {
  branches: CoverageMetric;
  functions: CoverageMetric;
  lines: CoverageMetric;
  statements: CoverageMetric;
}

const extra = process.argv.slice(2);
// pnpm forwards the published gate command `pnpm --filter policy test -- --coverage`
// as argv `['--', '--coverage']`, so the separator itself arrives here. It is not
// an argument anybody typed and it does not narrow the run.
const unknown = extra.filter((a) => a !== '--coverage' && a !== '--');
if (unknown.length > 0) {
  console.error(
    `run-tests: the only accepted argument is --coverage (got ${JSON.stringify(extra)}). ` +
      'Coverage is always on; the flag is accepted so the published gate command reads ' +
      'the same as it does for every other package. For an ad-hoc run: ' +
      'pnpm --filter policy exec vitest run <filter>',
  );
  process.exit(2);
}

const problems: string[] = [];

const TITLED_CALL =
  /(?<![\w$.])(?:test|it)\s*\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*,/g;
const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
};

function decode(body: string): string | undefined {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = SIMPLE_ESCAPES[body[++i] ?? ''];
    if (e === undefined) return undefined;
    out += e;
  }
  return out;
}

const declared = new Map<string, DeclaredFile>();
for (const dir of TEST_DIRS) {
  for (const file of readdirSync(join(PKG, dir)).sort()) {
    if (!file.endsWith('.test.ts')) continue;
    const rel = `${dir}/${file}`;
    const source = readFileSync(join(PKG, rel), 'utf8');
    const titles: DeclaredTitle[] = [];
    for (const m of source.matchAll(TITLED_CALL)) {
      const line = source.slice(0, m.index).split('\n').length;
      const title = decode(m[1] ?? m[2] ?? m[3] ?? '');
      if (title === undefined) {
        problems.push(
          `${rel}:${String(line)}: a test title uses an escape this reader does not decode; ` +
            'write the title without it',
        );
        continue;
      }
      titles.push({ title, line });
    }
    declared.set(rel, { sites: (source.match(/^\s*(?:test|it)\(/gm) ?? []).length, titles });
  }
}
const declaredTitles = [...declared.values()].reduce((n, f) => n + f.titles.length, 0);
if (declaredTitles === 0) {
  problems.push('the source reading found no literal test title in any declared file');
}

let summary = '';
let coverageSummary = '';
const tmp = mkdtempSync(join(tmpdir(), 'policy-vitest-'));
try {
  const reportPath = join(tmp, 'report.json');
  const covDir = join(tmp, 'coverage');
  const run = spawnSync(
    join(PKG, 'node_modules', '.bin', 'vitest'),
    [
      'run',
      '--reporter=verbose',
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
      '--coverage.enabled=true',
      '--coverage.provider=v8',
      '--coverage.all=true',
      '--coverage.include=src/**/*.ts',
      '--coverage.exclude=src/**/*.test.ts',
      '--coverage.reporter=text',
      '--coverage.reporter=json-summary',
      `--coverage.reportsDirectory=${covDir}`,
      '--coverage.thresholds.branches=100',
      '--coverage.thresholds.functions=100',
      '--coverage.thresholds.lines=100',
      '--coverage.thresholds.statements=100',
    ],
    {
      cwd: PKG,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);

  if (run.error !== undefined) problems.push(`vitest did not start: ${run.error.message}`);
  if (run.status !== 0) {
    problems.push(`vitest exited ${String(run.status)} (signal ${String(run.signal)})`);
  }
  if (!existsSync(reportPath)) {
    problems.push('vitest wrote no JSON report: the run did not complete');
  } else {
    const raw: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
    const missing = [...COUNTS, 'success', 'testResults'].filter(
      (k) => typeof raw !== 'object' || raw === null || !(k in raw),
    );
    if (missing.length > 0) {
      problems.push(`the JSON report carries no ${missing.join(', ')}`);
    } else {
      const r = raw as Report;
      const total = r.numTotalTests;

      if (total <= 0) problems.push(`the report counts ${String(total)} tests`);
      if (r.numPassedTests !== total) {
        problems.push(`${String(r.numPassedTests)} of ${String(total)} tests passed`);
      }
      for (const k of ['numFailedTests', 'numPendingTests', 'numTodoTests'] as const) {
        if (r[k] !== 0) problems.push(`${k} is ${String(r[k])}, not 0`);
      }
      if (r.numFailedTestSuites !== 0) {
        problems.push(`numFailedTestSuites is ${String(r.numFailedTestSuites)}, not 0`);
      }
      if (!r.success) problems.push('the report says success: false');
      const statuses = r.testResults.flatMap((f) => f.assertionResults.map((a) => a.status));
      const recountPassed = statuses.filter((s) => s === 'passed').length;
      if (statuses.length !== total || recountPassed !== r.numPassedTests) {
        problems.push(
          `per-test statuses re-count to ${String(recountPassed)} passed of ${String(statuses.length)}, ` +
            `the totals say ${String(r.numPassedTests)} of ${String(total)}`,
        );
      }

      const ran = new Map(r.testResults.map((f) => [relative(PKG, f.name), f]));
      for (const rel of ran.keys()) {
        if (!declared.has(rel))
          problems.push(`vitest ran ${rel}, which is not a declared test file`);
      }
      for (const rel of declared.keys()) {
        if (!ran.has(rel))
          problems.push(`${rel} is a declared test file and vitest did not run it`);
      }

      let matched = 0;
      for (const [rel, d] of declared) {
        const f = ran.get(rel);
        if (f === undefined) continue;
        if (f.status !== 'passed') problems.push(`${rel}: file status is ${f.status}`);

        const byTitle = new Map<string, string[]>();
        for (const a of f.assertionResults) {
          byTitle.set(a.title, [...(byTitle.get(a.title) ?? []), a.status]);
        }
        for (const { title, line } of d.titles) {
          const status = byTitle.get(title)?.shift();
          const at = `${rel}:${String(line)}: declared test ${JSON.stringify(title)}`;
          if (status === undefined) {
            problems.push(`${at} did not run — its title is not in Vitest's report for this file`);
          } else if (status !== 'passed') {
            problems.push(`${at} ran with status ${status}, not passed`);
          } else matched++;
        }

        if (f.assertionResults.length < d.sites) {
          problems.push(
            `${rel}: ${String(f.assertionResults.length)} tests registered at run time, ` +
              `${String(d.sites)} test( call sites in source`,
          );
        }
      }

      const lines = [...run.stdout.matchAll(/^\s*Tests\s+(.*?)\s*$/gm)].map((m) => m[1]);
      const want = `${String(total)} passed (${String(total)})`;
      if (lines.length !== 1 || lines[0] !== want) {
        problems.push(`the summary line reads ${JSON.stringify(lines)}, not ["${want}"]`);
      }

      summary =
        `${String(r.numPassedTests)} of ${String(total)} tests passed in ` +
        `${String(ran.size)} of ${String(declared.size)} declared files; ` +
        `failed ${String(r.numFailedTests)}, skipped ${String(r.numPendingTests)}, ` +
        `todo ${String(r.numTodoTests)}; ${String(matched)} of ${String(declaredTitles)} ` +
        `literal titles in source passed by name; summary line ${JSON.stringify(lines)}`;
    }
  }

  // 7(b). The coverage summary, read independently of Vitest's own threshold.
  const summaryPath = join(covDir, 'coverage-summary.json');
  if (!existsSync(summaryPath)) {
    problems.push(
      'no coverage-summary.json was written, so the 100% branch requirement was not ' +
        'measured. A coverage run that produced no report is the "did nothing" outcome, ' +
        'never a pass (SD §QD-1, PROTOCOL §5.1).',
    );
  } else {
    const cov = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, CoverageEntry>;
    const totalEntry = cov['total'];
    if (totalEntry === undefined) {
      problems.push('coverage-summary.json carries no `total` entry');
    } else {
      const files = Object.keys(cov).filter((k) => k !== 'total');
      if (files.length === 0) {
        problems.push(
          'coverage-summary.json measured 0 files. The gate is vacuous: 100% of nothing ' +
            'is not 100% branch coverage of the authorisation layer.',
        );
      }
      for (const [name, entry] of Object.entries(cov)) {
        for (const metric of ['branches', 'functions', 'lines', 'statements'] as const) {
          const pct = entry[metric].pct;
          if (pct !== 100) {
            problems.push(
              `${name === 'total' ? 'TOTAL' : relative(PKG, name)}: ${metric} coverage is ` +
                `${String(pct)}%, not 100%. SD §QD-1 makes this a gate, not a target: ` +
                'an unexercised branch in packages/policy is a permission nobody has checked.',
            );
          }
        }
      }
      // ANTI-VACUITY — the same defect class this ticket closes for
      // gate:semgrep, applied to this gate so it does not ship with the hole
      // it was sent to fix elsewhere.
      //
      // istanbul reports 0 covered of 0 as pct 100. So every check above is
      // satisfied by a package with NO branches in it at all: 100% of zero.
      // This is not hypothetical here — src/index.ts is exactly such a file, a
      // pure re-export barrel with 0 statements and 0 branches, which is why
      // the TEXT reporter prints 0 for it while the JSON summary reports 100.
      // Harmless for one barrel; fatal as a whole-package property, because it
      // is what "100% branch" would mean if the sources ever stopped being
      // instrumented or the include glob stopped matching. So the TOTALS must
      // be non-zero, and the counts are printed rather than the percentages.
      for (const metric of ['branches', 'functions', 'statements'] as const) {
        if (totalEntry[metric].total === 0) {
          problems.push(
            `coverage reports 0 ${metric} in TOTAL across packages/policy. 100% of zero is ` +
              'not coverage: either the sources were not instrumented, or the include glob ' +
              'matched nothing. That is a failure and never a pass (SD §QD-1, PROTOCOL §5.1).',
          );
        }
      }
      coverageSummary =
        `branches ${String(totalEntry.branches.covered)}/${String(totalEntry.branches.total)} ` +
        `(${String(totalEntry.branches.pct)}%), functions ` +
        `${String(totalEntry.functions.covered)}/${String(totalEntry.functions.total)}, ` +
        `statements ${String(totalEntry.statements.covered)}/${String(totalEntry.statements.total)}, ` +
        `lines ${String(totalEntry.lines.covered)}/${String(totalEntry.lines.total)}, ` +
        `over ${String(files.length)} source file(s)`;
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (summary !== '') console.log(`\nrun-tests: ${summary}`);
if (coverageSummary !== '') console.log(`run-tests: coverage ${coverageSummary}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nTEST FAIL  @kinvara/policy — ${String(problems.length)} problem(s)`);
  process.exit(1);
}
console.log('\nTEST PASS  @kinvara/policy');
