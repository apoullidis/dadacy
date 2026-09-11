/**
 * `pnpm --filter @kinvara/i18n test` — Vitest 5.0.0, plus a refusal of any run
 * that did not execute every test this package declares (T-132, OE-13).
 *
 * Why this is not bare `vitest run`: Vitest exits 0 when a test is skipped or
 * marked todo, and its JSON report records an expected-fail (`test.fails`) as
 * `passed` with no field that marks it (T-115 § Published contract §4, RW-TFJ).
 * A runner migration, or any later edit, that stops a test from running would
 * therefore be green on exit status alone — the harness-no-op class of
 * PROTOCOL §5.1. So this reads two reports of ONE run and requires all of:
 *
 *   1. Vitest exited 0 and wrote its JSON report. The report path is created
 *      fresh for each run, so a stale report cannot stand in for this one.
 *   2. The report: total > 0, passed === total, failed = skipped = todo = 0,
 *      no failed suite, `success`; and its per-test statuses re-count to those
 *      totals.
 *   3. The report's file set equals `src/*.test.ts` ∪ `tools/*.test.ts` as read
 *      from the directory, not from Vitest: a file Vitest never ran, or one it
 *      found somewhere else, is refused.
 *   4. Every file registered at run time at least as many tests as it has
 *      `test(` / `it(` call sites at the start of a line in its source — a test
 *      lost inside a file.
 *   5. The text reporter's summary line reads exactly `Tests  N passed (N)`,
 *      N === total. This second reading is the one that sees an expected-fail.
 *
 * It takes no arguments: a filtered run is a different run, and 3–5 would
 * refuse it anyway. For an ad-hoc run, use
 * `pnpm --filter @kinvara/i18n exec vitest run <filter>`.
 *
 * There is no Vitest/Vite config file in this package (T-115 § contract §3):
 * the runner's options are the command line below.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIRS = ['src', 'tools'];
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
  assertionResults: { status: string }[];
}
type Report = Record<(typeof COUNTS)[number], number> & {
  success: boolean;
  testResults: FileResult[];
};

if (process.argv.length > 2) {
  console.error(
    `run-tests: takes no arguments (got ${JSON.stringify(process.argv.slice(2))}). ` +
      'For an ad-hoc run: pnpm --filter @kinvara/i18n exec vitest run <filter>',
  );
  process.exit(2);
}

/** The declared set — the directory's reading, independent of Vitest's. */
const declared = new Map<string, number>();
for (const dir of TEST_DIRS) {
  for (const file of readdirSync(join(PKG, dir)).sort()) {
    if (!file.endsWith('.test.ts')) continue;
    const rel = `${dir}/${file}`;
    const source = readFileSync(join(PKG, rel), 'utf8');
    declared.set(rel, (source.match(/^\s*(?:test|it)\(/gm) ?? []).length);
  }
}

const problems: string[] = [];
let summary = '';
const tmp = mkdtempSync(join(tmpdir(), 'i18n-vitest-'));
try {
  const reportPath = join(tmp, 'report.json');
  const run = spawnSync(
    join(PKG, 'node_modules', '.bin', 'vitest'),
    ['run', '--reporter=verbose', '--reporter=json', `--outputFile.json=${reportPath}`],
    {
      cwd: PKG,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);

  // 1. exit status, and a report that this run wrote
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
      // Fail closed: a Vitest that renamed a field must not read as a pass.
      problems.push(`the JSON report carries no ${missing.join(', ')}`);
    } else {
      const r = raw as Report;
      const total = r.numTotalTests;

      // 2. the report's own counts, and a re-count from its per-test statuses
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

      // 3. the file set Vitest ran equals the file set the directory declares
      const ran = new Map(r.testResults.map((f) => [relative(PKG, f.name), f]));
      for (const rel of ran.keys()) {
        if (!declared.has(rel))
          problems.push(`vitest ran ${rel}, which is not a declared test file`);
      }
      for (const rel of declared.keys()) {
        if (!ran.has(rel))
          problems.push(`${rel} is a declared test file and vitest did not run it`);
      }

      // 4. per file: passed, and no fewer tests at run time than call sites in source
      for (const [rel, sites] of declared) {
        const f = ran.get(rel);
        if (f === undefined) continue;
        if (f.status !== 'passed') problems.push(`${rel}: file status is ${f.status}`);
        if (f.assertionResults.length < sites) {
          problems.push(
            `${rel}: ${String(f.assertionResults.length)} tests registered at run time, ` +
              `${String(sites)} test( call sites in source`,
          );
        }
      }

      // 5. the text reporter's summary — a second reading, from a different reporter
      const lines = [...run.stdout.matchAll(/^\s*Tests\s+(.*?)\s*$/gm)].map((m) => m[1]);
      const want = `${String(total)} passed (${String(total)})`;
      if (lines.length !== 1 || lines[0] !== want) {
        problems.push(`the summary line reads ${JSON.stringify(lines)}, not ["${want}"]`);
      }

      summary =
        `${String(r.numPassedTests)} of ${String(total)} tests passed in ` +
        `${String(ran.size)} of ${String(declared.size)} declared files; ` +
        `failed ${String(r.numFailedTests)}, skipped ${String(r.numPendingTests)}, ` +
        `todo ${String(r.numTodoTests)}; summary line ${JSON.stringify(lines)}`;
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (summary !== '') console.log(`\nrun-tests: ${summary}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nTEST FAIL  @kinvara/i18n — ${String(problems.length)} problem(s)`);
  process.exit(1);
}
console.log('\nTEST PASS  @kinvara/i18n');
