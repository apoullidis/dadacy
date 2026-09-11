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
 *   2. THE BUDGET — one cluster at a time, at the `db` profile's own mem_limit.
 *      `--test-concurrency=1` serialises suite FILES; §3 adds that a file has at
 *      most one acquire call site, because a second one inside a file is a
 *      second concurrent cluster (measured in `preflight.test.ts`, T-115).
 *
 *   3. NO SUITE MOCKS THE DATABASE. `qa-verification.md`: "A DB test that mocks
 *      the database" is an automatic FAIL, and `PROTOCOL.md` §5.2 says the
 *      invariant row runs on Testcontainers, "never a mock, and never the
 *      shared dev database". The rules that REQUIRE something (acquire a
 *      cluster, stop it, declare a test) are read from the TypeScript SYNTAX
 *      TREE, not the raw text: a call in a comment or a string is not a call.
 *      The rules that FORBID something (a mocking library) read the raw text,
 *      which errs towards a false FAIL, never a false PASS.
 *
 *   4. THE SUITES RUN. Skipped with `--static`, which is what `gate:pr` uses:
 *      the run needs the Docker socket, which only `scripts/dev --docker`
 *      supplies (T-034), and `gate:toolbox` §6 fails `gate:pr` on purpose when
 *      the socket is present.
 *
 *   5. THE RUN DID SOMETHING, AND ALL OF IT PASSED. The exit status alone
 *      cannot tell a pass from a no-op: `test.skip` and `todo` exit 0. So the
 *      node:test summary is read and every count asserted — and a run that
 *      prints no summary at all is a FAILURE, not a pass (PROTOCOL §5.1: "if
 *      your check did nothing at all, would it say so?").
 *
 * Every check is anti-vacuous: zero files, zero services, zero suites or zero
 * tests is a FAILURE, not a pass. `0 of N entries resolved` passing is the
 * defect shape this build has already shipped twice (T-001 QA-F3, T-016/T-017
 * QA-F2).
 */
import fs from 'node:fs';
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
const SUITE_DIR = path.join(REPO_ROOT, 'packages', 'db-testkit', 'suites');
const SRC_DIR = path.join(REPO_ROOT, 'packages', 'db-testkit', 'src');
const COMPOSE = path.join(REPO_ROOT, 'docker', 'compose.yml');
const PG_DOCKERFILE = path.join(REPO_ROOT, 'docker', 'postgres.Dockerfile');
const PKG_JSON = path.join(REPO_ROOT, 'packages', 'db-testkit', 'package.json');

const failures: string[] = [];
const staticOnly = process.argv.includes('--static');

function fail(message: string): void {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
}
function pass(message: string): void {
  console.log(`  ok    ${message}`);
}

// ---------------------------------------------------------------------------
// 1. The pinned image
// ---------------------------------------------------------------------------
console.log("\n== 1. the Testcontainers image tag is compose's image tag");

const composeDoc: unknown = YAML.parse(fs.readFileSync(COMPOSE, 'utf8'));
const services =
  typeof composeDoc === 'object' && composeDoc !== null
    ? (composeDoc as Record<string, unknown>)['services']
    : undefined;
const serviceMap =
  typeof services === 'object' && services !== null
    ? (services as Record<string, unknown>)
    : undefined;

if (serviceMap === undefined || Object.keys(serviceMap).length === 0) {
  fail(`${COMPOSE} parsed to zero services — this gate cannot account for what it read`);
} else {
  const postgres = serviceMap['postgres'];
  if (typeof postgres !== 'object' || postgres === null) {
    fail(
      "docker/compose.yml declares no 'postgres' service — the db profile has moved or been renamed",
    );
  } else {
    const composeImage = (postgres as Record<string, unknown>)['image'];
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
// 2. The budget — one cluster at a time, at the db profile's own mem_limit
// ---------------------------------------------------------------------------
console.log('\n== 2. the suite fits the budget it claims');

const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')) as {
  scripts?: Record<string, string>;
};
const runner = pkg.scripts?.['test:integration'] ?? '';
if (!runner.includes('--test-concurrency=1')) {
  fail(
    'packages/db-testkit test:integration must pass --test-concurrency=1. One cluster per ' +
      'suite FILE is 512 MB each; node --test runs files in parallel by default, so without ' +
      "this the peak is (files x 512 MB) and DOCKER.md §9's arithmetic is wrong.",
  );
} else {
  pass('test:integration runs one suite file at a time');
}

if (serviceMap !== undefined) {
  const pg = serviceMap['postgres'];
  const limit =
    typeof pg === 'object' && pg !== null
      ? (pg as Record<string, unknown>)['mem_limit']
      : undefined;
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
 */
const FORBIDDEN: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /\bmock\w*\s*\(/i, what: 'a mock() call' },
  { re: /\bmock\.\w+\s*\(/i, what: "a call on node:test's mock namespace" },
  { re: /\bimport\s*\{[^}]*\bmock\b[^}]*\}/, what: "an import of node:test's mock" },
  { re: /\b(sinon|jest|vitest|proxyquire|testdouble)\b/i, what: 'a mocking library' },
  { re: /\bpg-mem\b|\bbetter-sqlite3\b|\bsqlite\b|:memory:/i, what: 'an in-memory database' },
  { re: /\bstub\w*\s*\(/i, what: 'a stub() call' },
];

/**
 * The REQUIRE half, which is the half that bites: a suite that never acquires a
 * cluster cannot be testing a database, whatever it imports. Read from the
 * syntax tree, because a require-check over raw text is satisfied by a comment
 * — the defect family measured in `gate:egress-boundary` (OD-26, T-034
 * TL-F1/TL-F2). An acquirer counts only when it is bound by an IMPORT from the
 * harness (an alias counts; a same-named local function does not).
 */
const HARNESS_MODULES = new Set(['../src/index.ts', '../src/cluster.ts', '@kinvara/db-testkit']);
const ACQUIRERS = new Set(['acquireCluster', 'acquireMigratedCluster']);

interface SuiteShape {
  /** Call SITES of an imported acquirer, not calls at run time: a site in a loop counts once. */
  readonly acquireSites: number;
  readonly stops: boolean;
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
      if (from === 'node:test' && (imported === 'test' || imported === 'it')) {
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

for (const file of suiteFiles) {
  const text = fs.readFileSync(path.join(SUITE_DIR, file), 'utf8');
  const shape = suiteShape(file, text);
  if (shape.acquireSites > 1) {
    fail(
      `${file} acquires a cluster at ${String(shape.acquireSites)} call sites. A suite FILE holds at ` +
        `most one cluster: --test-concurrency=1 serialises FILES, not the clusters inside one, so a ` +
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
    fail(`${file} declares no test() — it adds nothing to the run and nothing to the count`);
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
const run = capture('pnpm', ['--filter', '@kinvara/db-testkit', 'run', 'test:integration']);
// stderr first: it carries pnpm's `$ node --test …` banner, which belongs above
// the spec output rather than after it.
process.stderr.write(run.stderr);
process.stdout.write(run.stdout);
if (run.code !== 0) fail(`the constraint suites exited ${String(run.code)}`);

// ---------------------------------------------------------------------------
// 5. The run did something, and all of it passed
// ---------------------------------------------------------------------------
console.log('\n== 5. the run did something, and all of it passed');

const COUNTS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;
const counts = new Map<string, number>();
for (const m of run.stdout.matchAll(/^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) {
  const key = m[1];
  const value = m[2];
  if (key !== undefined && value !== undefined) counts.set(key, Number(value));
}
const missing = COUNTS.filter((k) => !counts.has(k));
if (missing.length > 0) {
  fail(
    `the run printed no node:test summary (missing: ${missing.join(', ')}). Without it this ` +
      `gate cannot tell a pass from a run that did nothing.`,
  );
} else {
  const n = (k: (typeof COUNTS)[number]): number => counts.get(k) ?? -1;
  const summary = COUNTS.map((k) => `${k} ${String(n(k))}`).join(' / ');
  if (n('tests') === 0) fail(`zero tests ran (${summary})`);
  else if (n('pass') !== n('tests')) fail(`not every test passed (${summary})`);
  else if (n('fail') + n('cancelled') + n('skipped') + n('todo') !== 0) {
    fail(`a test failed, was cancelled, skipped or left todo (${summary})`);
  } else {
    pass(summary);
  }
}

finish(GATE, failures);
