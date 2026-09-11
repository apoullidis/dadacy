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
 *   4. BY NAME (T-132 rework 1, QR-F1): every `test(` / `it(` call in a file's
 *      source whose title is a string literal ('…', "…", or a template with no
 *      `${`) must appear with that exact title in Vitest's report FOR THAT FILE,
 *      with status `passed`, once per occurrence in the source. The expected
 *      titles are read from the source text, never from the report, so a lost
 *      literal-titled test cannot be paid for by a surplus of tests with OTHER
 *      titles elsewhere in the file (QR-F1: a loop over `test()` registering
 *      more tests than it has call sites).
 *      Identity is the LEAF title only; `describe` ancestry is not read. So a
 *      surplus registered under the SAME leaf title in the same file (a
 *      literal `test('X')` inside a loop, or inside a looped `describe`) does
 *      pay for a lost `test('X')` (QR2-F2). A renamed or deleted test changes
 *      the source and the report together, so neither is seen (QR2-F3).
 *   5. Every file registered at run time at least as many tests as it has
 *      `test(` / `it(` call sites at the start of a line in its source. After
 *      4, this only adds cover for a test whose title is NOT a literal and
 *      whose call starts a line, and a surplus in the same file masks it.
 *      A test whose title is not a literal AND whose call does not start a
 *      line (a one-line `if (x) test(<template with ${…}>, …)`) is read by
 *      neither 4 nor 5. It can be lost with every check green and no surplus
 *      in the file (QR2-F1).
 *   Each gap above is a committed `limitation` case in run-tests-negatives.ts.
 *   6. The text reporter's summary line reads exactly `Tests  N passed (N)`,
 *      N === total. This second reading is the one that sees an expected-fail.
 *
 * It takes no arguments: a filtered run is a different run, and 3–6 would
 * refuse it anyway. For an ad-hoc run, use
 * `pnpm --filter @kinvara/i18n exec vitest run <filter>`.
 *
 * There is no Vitest/Vite config file in this package (T-115 § contract §3):
 * the runner's options are the command line below.
 *
 * Its negative cases are committed: `tools/run-tests-negatives.ts`.
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
  /** `test(` / `it(` call sites at the start of a line (check 5) */
  sites: number;
  /** literal titles, in source order (check 4) */
  titles: DeclaredTitle[];
}

if (process.argv.length > 2) {
  console.error(
    `run-tests: takes no arguments (got ${JSON.stringify(process.argv.slice(2))}). ` +
      'For an ad-hoc run: pnpm --filter @kinvara/i18n exec vitest run <filter>',
  );
  process.exit(2);
}

const problems: string[] = [];

/**
 * A `test(` or `it(` call (not `x.test(`, not `submit(`), then its first
 * argument if that is a string literal, then a comma. A template literal
 * containing `${` does not match, so a generated title is not read as a literal.
 */
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

/** The literal's value, or undefined for an escape this reader does not model. */
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

/** The declared set — the directory's and the source's reading, independent of Vitest's. */
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
  // A reader that found nothing must not read as "nothing is missing".
  problems.push('the source reading found no literal test title in any declared file');
}

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

      let matched = 0;
      for (const [rel, d] of declared) {
        const f = ran.get(rel);
        if (f === undefined) continue;
        if (f.status !== 'passed') problems.push(`${rel}: file status is ${f.status}`);

        // 4. by name: each literal title in the source, once per occurrence
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

        // 5. no fewer tests at run time than call sites in source
        if (f.assertionResults.length < d.sites) {
          problems.push(
            `${rel}: ${String(f.assertionResults.length)} tests registered at run time, ` +
              `${String(d.sites)} test( call sites in source`,
          );
        }
      }

      // 6. the text reporter's summary — a second reading, from a different reporter
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
