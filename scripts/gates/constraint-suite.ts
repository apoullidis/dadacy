/**
 * gate:constraint-suite — T-115.
 *
 * Five things, in the order a failure is cheapest to diagnose:
 *
 *   1. THE IMAGE TAG IS IDENTICAL TO COMPOSE'S. `DOCKER.md` §1: "Pin the same
 *      Postgres image tag in all of them." Two readings of two different files —
 *      a TypeScript constant and the compose YAML — so the check cannot agree
 *      with the thing it checks by sharing a mistake with it. Plus one anchor
 *      that comes from neither: OD-10 says the tag must not be the stock
 *      `postgis/postgis:` image, so `compose.yml` and the harness drifting
 *      TOGETHER is still caught. (The harness repeats the identity check at
 *      acquisition time, `assertPinnedImage`, so a suite run directly — not
 *      through this gate — refuses a drifted tag too.)
 *
 *   2. THE RUNNER, AND THE BUDGET. Vitest is the runner (SD §QD-1, OE-13). It is
 *      pinned to an exact version, and three readings must agree on it: the
 *      manifest, `pnpm-lock.yaml`, and the package actually INSTALLED — the last
 *      one is not derived from the other two. `--no-file-parallelism` runs one
 *      suite FILE at a time; §3 adds that a file has at most one acquire call
 *      site, because a second one inside a file is a second concurrent cluster
 *      (measured in `preflight.test.ts`, T-115). The runner is configured on the
 *      `test:integration` command line and nowhere else: a Vitest or Vite config
 *      file in the package directory is refused, because a config can alias the
 *      harness module to a double or add a setup file, and §3 never reads it.
 *      (Only the package directory: measured on Vitest 5.0.0, a config at the
 *      repository root is NOT loaded by `vitest run` in the package.)
 *
 *   3. NO SUITE MOCKS THE DATABASE. `qa-verification.md`: "A DB test that mocks
 *      the database" is an automatic FAIL, and `PROTOCOL.md` §5.2 says the
 *      invariant row runs on Testcontainers, "never a mock, and never the
 *      shared dev database". The rules that REQUIRE something (acquire a
 *      cluster, stop it, declare a test) are read from the TypeScript SYNTAX
 *      TREE, not the raw text: a call in a comment or a string is not a call.
 *      The rules that FORBID something (a mocking utility — Vitest's `vi.*`
 *      included) read the raw text, which errs towards a false FAIL, never a
 *      false PASS.
 *
 *   4. THE SUITES RUN. Skipped with `--static`, which is what `gate:pr` uses:
 *      the run needs the Docker socket, which only `scripts/dev --docker`
 *      supplies (T-034), and `gate:toolbox` §6 fails `gate:pr` on purpose when
 *      the socket is present.
 *
 *   5. THE RUN DID SOMETHING, AND ALL OF IT PASSED. The exit status alone
 *      cannot tell a pass from a no-op: `test.skip`, `test.todo` and a run
 *      filtered down to fewer files all exit 0. So Vitest writes its JSON report
 *      to a file this gate deleted first, and every count in it is asserted — a
 *      run that writes no report is a FAILURE, not a pass (PROTOCOL §5.1: "if
 *      your check did nothing at all, would it say so?"). The report's FILE SET
 *      must equal the suite files §3 listed from the directory — a different
 *      reading from the runner's own include glob — and each file must register
 *      at least as many tests at run time as it has test() call sites.
 *
 * Every check is anti-vacuous: zero files, zero services, zero suites or zero
 * tests is a FAILURE, not a pass. `0 of N entries resolved` passing is the
 * defect shape this build has already shipped twice (T-001 QA-F3, T-016/T-017
 * QA-F2).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import { REPO_ROOT, capture, finish } from './lib/run.ts';
import {
  CLUSTER_MEMORY_BYTES,
  FORBIDDEN_IMAGE_PREFIX,
  POSTGRES_BASE_IMAGE,
  POSTGRES_IMAGE,
} from '../../packages/db-testkit/src/image.ts';

const GATE = 'gate:constraint-suite';
const PKG_DIR = path.join(REPO_ROOT, 'packages', 'db-testkit');
const SUITE_DIR = path.join(PKG_DIR, 'suites');
const SRC_DIR = path.join(PKG_DIR, 'src');
const COMPOSE = path.join(REPO_ROOT, 'docker', 'compose.yml');
const PG_DOCKERFILE = path.join(REPO_ROOT, 'docker', 'postgres.Dockerfile');
const PKG_JSON = path.join(PKG_DIR, 'package.json');
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml');
const LOCK_IMPORTER = 'packages/db-testkit';

const failures: string[] = [];
const staticOnly = process.argv.includes('--static');

function fail(message: string): void {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
}
function pass(message: string): void {
  console.log(`  ok    ${message}`);
}
function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// 1. The pinned image
// ---------------------------------------------------------------------------
console.log("\n== 1. the Testcontainers image tag is compose's image tag");

const serviceMap = rec(rec(YAML.parse(fs.readFileSync(COMPOSE, 'utf8')))?.['services']);

if (serviceMap === undefined || Object.keys(serviceMap).length === 0) {
  fail(`${COMPOSE} parsed to zero services — this gate cannot account for what it read`);
} else {
  const postgres = rec(serviceMap['postgres']);
  if (postgres === undefined) {
    fail(
      "docker/compose.yml declares no 'postgres' service — the db profile has moved or been renamed",
    );
  } else {
    const composeImage = postgres['image'];
    if (typeof composeImage !== 'string' || composeImage === '') {
      fail("docker/compose.yml's postgres service declares no image:");
    } else if (composeImage !== POSTGRES_IMAGE) {
      fail(
        `image drift: compose.yml says '${composeImage}', ` +
          `packages/db-testkit/src/image.ts says '${POSTGRES_IMAGE}'. ` +
          `DOCKER.md §1 requires the same tag in compose and Testcontainers, and the ` +
          `difference is invisible until a suite runs against a database the schema ` +
          `cannot install into.`,
      );
    } else {
      pass(`compose.yml postgres.image === POSTGRES_IMAGE (${POSTGRES_IMAGE})`);
    }
  }
}

// The anchor that is derived from OD-10 rather than from either artefact.
if (POSTGRES_IMAGE.startsWith(FORBIDDEN_IMAGE_PREFIX)) {
  fail(
    `the harness is pinned to the STOCK image (${POSTGRES_IMAGE}). OD-10: the stock image ` +
      `provisions a libc database with an empty shared_preload_libraries and four undeclared ` +
      `extensions, which 0001's preflight correctly refuses. Use kinvara/postgres:18-3.6-kinvara1.`,
  );
} else {
  pass(`not the stock image (OD-10) — ${POSTGRES_IMAGE}`);
}

// And the derived image's provenance, against the Dockerfile's own FROM.
const dockerfile = fs.readFileSync(PG_DOCKERFILE, 'utf8');
const fromLine = /^FROM\s+(\S+)/m.exec(dockerfile);
if (fromLine === null) {
  fail(`${PG_DOCKERFILE} has no FROM line this gate can read`);
} else if (fromLine[1] !== POSTGRES_BASE_IMAGE) {
  fail(
    `base-image drift: postgres.Dockerfile builds FROM '${String(fromLine[1])}', ` +
      `image.ts records '${POSTGRES_BASE_IMAGE}'`,
  );
} else {
  pass('postgres.Dockerfile FROM === POSTGRES_BASE_IMAGE (digest included)');
}

// ---------------------------------------------------------------------------
// 2. The runner is pinned and configured where this gate can read it, and the
//    suite fits the budget it claims
// ---------------------------------------------------------------------------
console.log('\n== 2. the runner is pinned, and the suite fits the budget it claims');

const pkg = rec(JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'))) ?? {};
const devDeps = rec(pkg['devDependencies']) ?? {};
const scripts = rec(pkg['scripts']) ?? {};

// Vitest and its peer Vite. An exact version in the manifest is necessary and
// not sufficient: the lockfile can disagree with it until someone re-installs,
// and node_modules can disagree with both. The INSTALLED version is the one
// that actually runs, and it is read from the package itself.
const EXACT = /^\d+\.\d+\.\d+$/;
const RUNNER_PINS = ['vitest', 'vite'] as const;
const lockImporter = rec(
  rec(rec(YAML.parse(fs.readFileSync(LOCKFILE, 'utf8')))?.['importers'])?.[LOCK_IMPORTER],
);
for (const name of RUNNER_PINS) {
  const want = devDeps[name];
  if (typeof want !== 'string') {
    fail(`packages/db-testkit declares no devDependency '${name}' — Vitest is the runner (OE-13)`);
    continue;
  }
  if (!EXACT.test(want)) {
    fail(
      `packages/db-testkit pins ${name} as '${want}', which is not an exact version. SD §QD-1 ` +
        `says "pin at install"; a range makes the runner whatever the registry served that day.`,
    );
    continue;
  }
  const locked = rec(rec(lockImporter?.['devDependencies'])?.[name]);
  const lockSpec = locked?.['specifier'];
  const lockVersion = locked?.['version'];
  const lockResolved = typeof lockVersion === 'string' ? lockVersion.split('(')[0] : undefined;
  let installed: unknown;
  try {
    installed = rec(
      JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'node_modules', name, 'package.json'), 'utf8')),
    )?.['version'];
  } catch {
    installed = undefined;
  }
  if (lockSpec !== want || lockResolved !== want) {
    fail(
      `pnpm-lock.yaml's importer ${LOCK_IMPORTER} records ${name} as specifier ` +
        `'${String(lockSpec)}' resolved '${String(lockResolved)}'; the manifest pins '${want}'. ` +
        `Run scripts/dev pnpm install and commit the lockfile.`,
    );
  } else if (installed !== want) {
    fail(
      `the INSTALLED ${name} is '${String(installed ?? 'absent')}', but the manifest and the ` +
        `lockfile pin '${want}'. The suites would run on a runner nobody pinned.`,
    );
  } else {
    pass(`${name} ${want} — exact in the manifest, in pnpm-lock.yaml, and as installed`);
  }
}

const runner = typeof scripts['test:integration'] === 'string' ? scripts['test:integration'] : '';
const argv = runner.trim().split(/\s+/);
if (argv[0] !== 'vitest' || argv[1] !== 'run') {
  fail(
    `packages/db-testkit test:integration must start 'vitest run' — Vitest is the runner ` +
      `(SD §QD-1, OE-13). It is: '${runner}'`,
  );
}
if (!argv.includes('--no-file-parallelism')) {
  fail(
    'packages/db-testkit test:integration must pass --no-file-parallelism. One cluster per ' +
      'suite FILE is 512 MB each; Vitest runs files in parallel by default, so without this ' +
      "the peak is (files x 512 MB) and DOCKER.md §9's arithmetic is wrong.",
  );
} else {
  pass('test:integration runs one suite file at a time (vitest run --no-file-parallelism)');
}
// Flags that change WHAT runs, or point the runner at a file this gate does not
// read. A positional filter is not listed: it narrows the file set, and §5
// compares the file set the run reports with the directory listing.
const RUNNER_FLAGS_FORBIDDEN = new Set([
  '--config',
  '-c',
  '--root',
  '-r',
  '--dir',
  '--project',
  '--setupFiles',
  '--globalSetup',
  '--passWithNoTests',
  '--allowOnly',
  '--changed',
  '--related',
  '--shard',
]);
const badFlags = argv.filter((a) => RUNNER_FLAGS_FORBIDDEN.has(a.split('=')[0] ?? ''));
if (badFlags.length > 0) {
  fail(
    `packages/db-testkit test:integration passes ${badFlags.join(', ')}: each changes what runs ` +
      `or what it runs against, and this gate does not read what it points at`,
  );
}
// `vitest run` in the package loads a config file from the package directory.
// Only that directory is checked: a config at the repository root was measured
// (Vitest 5.0.0, T-115) NOT to be loaded by this run, so refusing one would be a
// false FAIL with a false reason.
const CONFIG_FILE = /^(vitest|vite)\.(config|workspace)\.[cm]?[jt]s$/;
const configFiles = fs
  .readdirSync(PKG_DIR)
  .filter((f) => CONFIG_FILE.test(f))
  .map((f) => path.relative(REPO_ROOT, path.join(PKG_DIR, f)));
if (configFiles.length > 0) {
  fail(
    `${configFiles.join(', ')}: a Vitest/Vite config file the constraint suites would load. ` +
      `Their runner is configured on the test:integration command line, which this gate reads; ` +
      `a config file can alias the harness module to a double or add a setup file, and nothing ` +
      `here reads it.`,
  );
} else {
  pass('no Vitest/Vite config file in packages/db-testkit');
}

if (serviceMap !== undefined) {
  const limit = rec(serviceMap['postgres'])?.['mem_limit'];
  const expected = `${String(CLUSTER_MEMORY_BYTES / (1024 * 1024))}m`;
  if (limit !== expected) {
    fail(
      `the harness caps a cluster at ${expected} but compose.yml's postgres mem_limit is ` +
        `${String(limit)}. DOCKER.md §3 budgets the db profile once; two numbers is two budgets.`,
    );
  } else {
    pass(`cluster mem_limit === compose's db profile budget (${expected})`);
  }
}

// ---------------------------------------------------------------------------
// 3. No suite mocks the database
// ---------------------------------------------------------------------------
console.log('\n== 3. no constraint suite mocks the database');

/**
 * The FORBID half: a blocklist, because the ecosystem of test doubles is a
 * list. Read over the raw text on purpose — a match in a comment is a false
 * FAIL, which costs a reword; the opposite error would cost a false PASS.
 * Vitest ships its own double machinery on `vi` — `vi.mock` of the harness
 * module is the most natural way to fake a cluster under this runner, and it
 * leaves every REQUIRE rule below satisfied — so any use of `vi` is refused.
 */
const FORBIDDEN: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /\bmock\w*\s*\(/i, what: 'a mock() call' },
  { re: /\bmock\.\w+\s*\(/i, what: "a call on node:test's mock namespace" },
  { re: /\bimport\s*\{[^}]*\bmock\b[^}]*\}/, what: "an import of node:test's mock" },
  { re: /\bvi\s*\.\s*\w+/, what: "a use of Vitest's vi (vi.mock / vi.fn / vi.spyOn / vi.stub…)" },
  { re: /\bimport\s*\{[^}]*\bvi\b[^}]*\}/, what: "an import of Vitest's vi" },
  { re: /\b(sinon|jest|proxyquire|testdouble)\b/i, what: 'a mocking library' },
  { re: /\bpg-mem\b|\bbetter-sqlite3\b|\bsqlite\b|:memory:/i, what: 'an in-memory database' },
  { re: /\bstub\w*\s*\(/i, what: 'a stub() call' },
];

/**
 * The REQUIRE half, which is the half that bites: a suite that never acquires a
 * cluster cannot be testing a database, whatever it imports. Read from the
 * syntax tree, because a require-check over raw text is satisfied by a comment
 * — the defect family measured in `gate:egress-boundary` (OD-26, T-034
 * TL-F1/TL-F2). An acquirer counts only when it is bound by an IMPORT from the
 * harness (an alias counts; a same-named local function does not). A test
 * counts only when it is `test`/`it` imported from `vitest`: a suite still on
 * node:test declares nothing this runner will run.
 */
const HARNESS_MODULES = new Set(['../src/index.ts', '../src/cluster.ts', '@kinvara/db-testkit']);
const ACQUIRERS = new Set(['acquireCluster', 'acquireMigratedCluster']);
const RUNNER_MODULE = 'vitest';

interface SuiteShape {
  /** Call SITES of an imported acquirer, not calls at run time: a site in a loop counts once. */
  readonly acquireSites: number;
  readonly stops: boolean;
  /** Call SITES of test()/it(). `test.skip(…)` is not a call of `test` and is not counted. */
  readonly tests: number;
}

function suiteShape(file: string, text: string): SuiteShape {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const acquirers = new Set<string>();
  const testFns = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const from = stmt.moduleSpecifier.text;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (HARNESS_MODULES.has(from) && ACQUIRERS.has(imported)) acquirers.add(el.name.text);
      if (from === RUNNER_MODULE && (imported === 'test' || imported === 'it')) {
        testFns.add(el.name.text);
      }
    }
  }
  let acquireSites = 0;
  let stops = false;
  let tests = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (acquirers.has(callee.text)) acquireSites += 1;
        if (testFns.has(callee.text)) tests += 1;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'stop' &&
        node.arguments.length === 0
      ) {
        stops = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { acquireSites, stops, tests };
}

const failuresBefore = failures.length;

let suiteFiles: string[] = [];
try {
  suiteFiles = fs
    .readdirSync(SUITE_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
} catch {
  fail(`${SUITE_DIR} does not exist — there are no constraint suites to check`);
}

if (suiteFiles.length === 0) {
  fail(
    'zero constraint suites found. This gate passing over an empty directory is the ' +
      '"0 of N entries resolved" defect (T-001 QA-F3); it fails instead.',
  );
} else {
  pass(`${String(suiteFiles.length)} constraint suite(s): ${suiteFiles.join(', ')}`);
}

/** test()/it() call sites per suite file, for §5's run-time comparison. */
const staticTests = new Map<string, number>();

for (const file of suiteFiles) {
  const text = fs.readFileSync(path.join(SUITE_DIR, file), 'utf8');
  const shape = suiteShape(file, text);
  staticTests.set(file, shape.tests);
  if (shape.acquireSites > 1) {
    fail(
      `${file} acquires a cluster at ${String(shape.acquireSites)} call sites. A suite FILE holds at ` +
        `most one cluster: --no-file-parallelism serialises FILES, not the clusters inside one, so a ` +
        `second acquire doubles the peak past the db profile's 512 MB (DOCKER.md §3, §9). Measured: ` +
        `preflight.test.ts did exactly this until T-115 moved P3 into its own file.`,
    );
  }
  if (shape.acquireSites === 0) {
    fail(
      `${file} never calls acquireCluster()/acquireMigratedCluster() imported from the harness. ` +
        `A constraint suite that does not acquire a real cluster is not testing a database ` +
        `(PROTOCOL §5.2, DOCKER.md §1). Read from the syntax tree: a call in a comment or a ` +
        `string does not count.`,
    );
  }
  if (!shape.stops) {
    fail(
      `${file} never calls cluster.stop() — a suite that leaks its cluster starves the next one`,
    );
  }
  if (shape.tests === 0) {
    fail(
      `${file} declares no test()/it() imported from '${RUNNER_MODULE}' — it adds nothing ` +
        `to the run and nothing to the count`,
    );
  }
  for (const f of FORBIDDEN) {
    if (f.re.test(text)) {
      fail(`${file} contains ${f.what}. A DB test that mocks the database is an automatic FAIL.`);
    }
  }
}

// The harness source is checked too: a double imported from src/ and re-exported
// would satisfy every per-suite rule above.
let srcFiles: string[] = [];
try {
  srcFiles = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
} catch {
  fail(`${SRC_DIR} does not exist`);
}
if (srcFiles.length === 0) fail('the harness has no source files');
for (const file of srcFiles) {
  const text = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  for (const f of FORBIDDEN) {
    if (f.re.test(text)) fail(`packages/db-testkit/src/${file} contains ${f.what}`);
  }
}
if (failures.length === failuresBefore) {
  pass('every suite acquires a real cluster, tears it down, declares tests, and names no double');
}

// ---------------------------------------------------------------------------
// 4. Run them
// ---------------------------------------------------------------------------
if (staticOnly) {
  console.log('\n== 4. running the suites — SKIPPED (--static)');
  console.log(
    '     The run needs the Docker socket, which only `scripts/dev --docker` supplies\n' +
      '     (T-034); gate:pr cannot carry it, because gate:toolbox §6 fails on purpose\n' +
      '     when the socket is present. The full gate:\n' +
      '         scripts/dev --docker pnpm -w gate:constraint-suite\n' +
      '     Wiring it into gate:heavy is T-006.',
  );
  finish(GATE, failures);
}

console.log('\n== 4. the constraint suites, against real disposable clusters');
// A fresh path, deleted before the run: a report left behind by an earlier run
// must not be able to stand in for this one.
const REPORT = path.join(os.tmpdir(), `kinvara-constraint-suite-${String(process.pid)}.json`);
fs.rmSync(REPORT, { force: true });
// NO_COLOR: this output is pasted into evidence files, where ANSI escapes are
// noise. It changes rendering only; every verdict below is read from the report.
const run = capture(
  'pnpm',
  [
    '--filter',
    '@kinvara/db-testkit',
    'run',
    'test:integration',
    '--reporter=json',
    `--outputFile.json=${REPORT}`,
  ],
  { NO_COLOR: '1' },
);
// stderr first: it carries pnpm's banner, which belongs above the run's output.
process.stderr.write(run.stderr);
process.stdout.write(run.stdout);
if (run.code !== 0) fail(`the constraint suites exited ${String(run.code)}`);

// ---------------------------------------------------------------------------
// 5. The run did something, and all of it passed
// ---------------------------------------------------------------------------
console.log('\n== 5. the run did something, and all of it passed');

let report: Record<string, unknown> | undefined;
try {
  report = rec(JSON.parse(fs.readFileSync(REPORT, 'utf8')));
} catch {
  report = undefined;
}
fs.rmSync(REPORT, { force: true });

if (report === undefined) {
  fail(
    `Vitest wrote no JSON report to ${REPORT}. Without it this gate cannot tell a pass from a ` +
      `run that did nothing (the path was deleted before the run, so no stale report can stand in).`,
  );
} else {
  const COUNTS = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numFailedTestSuites',
  ] as const;
  const got = new Map<string, number>();
  for (const k of COUNTS) {
    const v = report[k];
    if (typeof v === 'number') got.set(k, v);
  }
  const missing = COUNTS.filter((k) => !got.has(k));
  const results = Array.isArray(report['testResults']) ? (report['testResults'] as unknown[]) : [];

  // Per file, from the report — keyed by path relative to suites/.
  const ran = new Map<string, { status: string; tests: number; passed: number }>();
  let recountTests = 0;
  let recountPassed = 0;
  for (const r of results) {
    const f = rec(r);
    const name = f?.['name'];
    if (f === undefined || typeof name !== 'string') continue;
    const assertions = Array.isArray(f['assertionResults'])
      ? (f['assertionResults'] as unknown[])
      : [];
    const passed = assertions.filter((a) => rec(a)?.['status'] === 'passed').length;
    recountTests += assertions.length;
    recountPassed += passed;
    ran.set(path.relative(SUITE_DIR, name), {
      status: String(f['status']),
      tests: assertions.length,
      passed,
    });
  }

  if (missing.length > 0) {
    fail(`the Vitest report carries no ${missing.join(', ')} — this gate cannot read its counts`);
  } else {
    const n = (k: (typeof COUNTS)[number]): number => got.get(k) ?? -1;
    // Failed FILES are counted from each file's own status. Vitest's
    // numFailedTestSuites is printed under its own name: it counts describe
    // blocks as well as files (measured, T-115), so it is not a file count.
    const failedFiles = [...ran.values()].filter((r) => r.status !== 'passed').length;
    const summary =
      `tests ${String(n('numTotalTests'))} / passed ${String(n('numPassedTests'))} / ` +
      `failed ${String(n('numFailedTests'))} / skipped ${String(n('numPendingTests'))} / ` +
      `todo ${String(n('numTodoTests'))} / files ${String(ran.size)} of ${String(suiteFiles.length)}` +
      `, ${String(failedFiles)} failed (numFailedTestSuites ${String(n('numFailedTestSuites'))})`;
    const before = failures.length;
    if (n('numTotalTests') === 0) fail(`zero tests ran (${summary})`);
    else if (n('numPassedTests') !== n('numTotalTests')) {
      fail(`not every test passed (${summary})`);
    }
    if (n('numFailedTests') + n('numPendingTests') + n('numTodoTests') !== 0) {
      fail(`a test failed, was skipped or left todo (${summary})`);
    }
    if (failedFiles !== 0 || n('numFailedTestSuites') !== 0 || report['success'] !== true) {
      fail(`a suite file failed — to collect, in a hook, or at all (${summary})`);
    }
    if (recountTests !== n('numTotalTests') || recountPassed !== n('numPassedTests')) {
      fail(
        `the report disagrees with itself: its per-test results hold ${String(recountTests)} ` +
          `test(s), ${String(recountPassed)} passed; its totals say ${summary}`,
      );
    }
    // The file set, against the directory listing §3 took — not against the
    // runner's include glob, which is the thing being checked.
    const notRun = suiteFiles.filter((f) => !ran.has(f));
    const unexpected = [...ran.keys()].filter((f) => !staticTests.has(f));
    if (notRun.length > 0) {
      fail(
        `Vitest ran ${String(ran.size)} of the ${String(suiteFiles.length)} suite files; ` +
          `never run: ${notRun.join(', ')}`,
      );
    }
    if (unexpected.length > 0) {
      fail(
        `Vitest ran test files that are not constraint suites under suites/: ` +
          `${unexpected.join(', ')} — this gate's static rules never read them`,
      );
    }
    for (const [file, r] of ran) {
      const declared = staticTests.get(file);
      if (r.status !== 'passed') fail(`${file}: the file's status is '${r.status}'`);
      if (declared !== undefined && r.tests < declared) {
        fail(
          `${file} registered ${String(r.tests)} test(s) at run time but has ` +
            `${String(declared)} test()/it() call site(s) — a test that never registered ` +
            `cannot fail`,
        );
      }
    }
    if (failures.length === before) pass(summary);
  }
}

finish(GATE, failures);
