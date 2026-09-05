/**
 * gate:constraint-suite — T-115.
 *
 * Three things, in the order a failure is cheapest to diagnose:
 *
 *   1. THE IMAGE TAG IS IDENTICAL TO COMPOSE'S. `DOCKER.md` §1: "Pin the same
 *      Postgres image tag in all of them." Two readings of two different files —
 *      a TypeScript constant and the compose YAML — so the check cannot agree
 *      with the thing it checks by sharing a mistake with it. Plus one anchor
 *      that comes from neither: OD-10 says the tag must not be the stock
 *      `postgis/postgis:` image, so `compose.yml` and the harness drifting
 *      TOGETHER is still caught.
 *
 *   2. NO SUITE MOCKS THE DATABASE. `qa-verification.md`: "A DB test that mocks
 *      the database" is an automatic FAIL, and `PROTOCOL.md` §5.2 says the
 *      invariant row runs on Testcontainers, "never a mock, and never the
 *      shared dev database". A rule beats a reviewer remembering.
 *
 *   3. THE SUITES RUN. Skipped with `--static`, which is what `gate:pr` uses:
 *      the run needs the Docker daemon and the toolbox cannot reach it (OD-16).
 *
 * Every check is anti-vacuous: zero files, zero services or zero suites is a
 * FAILURE, not a pass. `0 of N entries resolved` passing is the defect shape
 * this build has already shipped twice (T-001 QA-F3, T-016/T-017 QA-F2).
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT, finish, stream } from './lib/run.ts';
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
    `base-image drift: postgres.Dockerfile builds FROM '${fromLine[1]}', ` +
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
 * The rule, stated as a property rather than a blocklist of library names:
 * a constraint suite must acquire a REAL cluster through this harness, and must
 * not name a test-double facility. The second half is a list because the
 * ecosystem is; the first half is what actually bites, because a suite that
 * never acquires a cluster cannot be testing a database whatever it imports.
 */
const FORBIDDEN: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /\bmock\w*\s*\(/i, what: 'a mock() call' },
  { re: /\bmock\.\w+\s*\(/i, what: "a call on node:test's mock namespace" },
  { re: /\bimport\s*\{[^}]*\bmock\b[^}]*\}/, what: "an import of node:test's mock" },
  { re: /\b(sinon|jest|vitest|proxyquire|testdouble)\b/i, what: 'a mocking library' },
  { re: /\bpg-mem\b|\bbetter-sqlite3\b|\bsqlite\b|:memory:/i, what: 'an in-memory database' },
  { re: /\bstub\w*\s*\(/i, what: 'a stub() call' },
];

const ACQUIRE = /\bacquire(Migrated)?Cluster\s*\(/;

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
  if (!ACQUIRE.test(text)) {
    fail(
      `${file} never calls acquireCluster()/acquireMigratedCluster(). A constraint suite that ` +
        `does not acquire a real cluster is not testing a database (PROTOCOL §5.2, DOCKER.md §1).`,
    );
  }
  if (!/\.stop\s*\(\s*\)/.test(text)) {
    fail(
      `${file} never calls cluster.stop() — a suite that leaks its cluster starves the next one`,
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
  pass('every suite acquires a real cluster, tears it down, and names no test double');
}

// ---------------------------------------------------------------------------
// 4. Run them
// ---------------------------------------------------------------------------
if (staticOnly) {
  console.log('\n== 4. running the suites — SKIPPED (--static)');
  console.log(
    '     The run needs the Docker daemon, which scripts/dev and scripts/svc run do not\n' +
      '     expose to the toolbox (OD-16). gate:pr uses --static; the full gate belongs in\n' +
      '     gate:heavy (T-006) once the socket is mounted.',
  );
  finish(GATE, failures);
}

console.log('\n== 4. the constraint suites, against real disposable clusters');
const code = stream('pnpm', ['--filter', '@kinvara/db-testkit', 'run', 'test:integration']);
if (code !== 0) failures.push(`the constraint suites exited ${String(code)}`);

finish(GATE, failures);
