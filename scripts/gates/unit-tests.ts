/**
 * gate:unit-tests — T-005, closing OD-57 and OD-3.
 *
 * OD-57: no gate ran any package's unit tests. Every refusal published by
 * packages/i18n, packages/domain-types, packages/contracts, packages/policy and
 * packages/integration-kit applied only when a human ran the script by hand. A
 * regression that deleted or skipped a test passed `gate:pr`.
 *
 * OD-3 is the same defect one level up and it is the one this file is shaped
 * around: `pnpm -w test` exits 0 when NO package implements the task, so the
 * moment one package implements it, a package that FORGOT is silently skipped.
 * That is the Trivy zero-package defect wearing different clothes, and
 * "a gate that passes because it ran nothing" is the thing T-005 exists to
 * prevent. So this gate cannot pass vacuously, and the proof is not an
 * assertion — it is four refusals, each with a case in
 * scripts/negative-tests/pr-gates.sh:
 *
 *   V1  a package with tracked `*.test.ts` files and NO `test` /
 *       `test:integration` script                       -> UNRUN-TESTS
 *   V2  a package that declares `test` but has ZERO tracked test files
 *       (its runner cannot have run anything)            -> VACUOUS-PACKAGE
 *   V3  a package with tracked `src/**` and neither script
 *                                                        -> UNTESTED-PACKAGE
 *   V4  ZERO packages declaring `test` across the workspace
 *                                                        -> NO-TEST-PACKAGES
 *
 * plus the per-package cross-check that is the real anti-vacuity anchor:
 *
 *   V5  the runner reports how many files it DECLARED; `git ls-files` says how
 *       many exist. If they differ, a test file is not being run — or is not
 *       tracked — and the gate reds. Neither number is derived from the other
 *       (PROTOCOL §5.1).
 *
 * WHAT THIS GATE DOES NOT COVER. `test:integration` is not run here: apps/core
 * and packages/db-testkit need the `db` profile and `gate:pr` declares
 * `svc: none` (DOCKER.md §7). V1/V3 still bind on those packages — a package
 * cannot escape by declaring neither — but their cases run in `gate:heavy`
 * (T-006). Said, not assumed.
 */
import { capture, finish } from './lib/run.ts';
import { workspacePackages } from './lib/workspace.ts';
import type { WorkspacePackage } from './lib/workspace.ts';

/**
 * `--dry-run` performs V1-V4 — the DECLARATION checks, which are the whole of
 * OD-3 and OD-57 — and runs no test. It exists so those four refusals can be
 * attacked in milliseconds instead of once per 30-second full run, and it
 * PRINTS that it ran nothing so a pasted `GATE PASS` from it cannot be read as
 * a test run. `pnpm gate:unit-tests` does not pass it.
 */
const DRY_RUN = process.argv.includes('--dry-run');
const GATE = DRY_RUN ? 'gate:unit-tests [--dry-run: DECLARATION CHECKS ONLY, NO TEST RAN]' : 'gate:unit-tests';

const failures: string[] = [];

let pkgs: WorkspacePackage[];
try {
  pkgs = workspacePackages();
} catch (e) {
  finish(GATE, [
    `could not enumerate the workspace: ${e instanceof Error ? e.message : String(e)}`,
  ]);
}

const declaresTest = (p: WorkspacePackage): boolean => 'test' in p.scripts;
const declaresIntegration = (p: WorkspacePackage): boolean => 'test:integration' in p.scripts;

console.log(`workspace packages found: ${String(pkgs.length)}`);

// ----------------------------------------------------------- V1, V2, V3
for (const p of pkgs) {
  const t = declaresTest(p);
  const i = declaresIntegration(p);
  if (p.testFiles.length > 0 && !t && !i) {
    failures.push(
      `UNRUN-TESTS ${p.dir}: ${String(p.testFiles.length)} tracked test file(s) and no \`test\` ` +
        `or \`test:integration\` script. Nothing runs them. (OD-3)`,
    );
  }
  if (t && p.testFiles.length === 0) {
    failures.push(
      `VACUOUS-PACKAGE ${p.dir}: declares \`test\` but git tracks zero \`*.test.ts\` files in it. ` +
        `Its test script cannot have run anything, and a green run over nothing is the defect.`,
    );
  }
  if (p.sourceFiles.length > 0 && !t && !i) {
    failures.push(
      `UNTESTED-PACKAGE ${p.dir}: ${String(p.sourceFiles.length)} tracked source file(s) under ` +
        `src/ and no \`test\` or \`test:integration\` script (SD §QD-4 PR row: "unit tests").`,
    );
  }
}

// --------------------------------------------------------------------- V4
const runnable = pkgs.filter(declaresTest);
if (runnable.length === 0) {
  failures.push(
    'NO-TEST-PACKAGES: not one workspace package declares a `test` script. This gate exits ' +
      'NON-ZERO on that, where `pnpm -w test` exits 0 — see OD-3. A test stage with nothing ' +
      'in it is not a passing test stage.',
  );
  finish(GATE, failures);
}

console.log(
  `packages declaring \`test\`: ${String(runnable.length)} — ${runnable.map((p) => p.name).join(', ')}`,
);
const integrationOnly = pkgs.filter((p) => !declaresTest(p) && declaresIntegration(p));
console.log(
  `packages declaring only \`test:integration\` (run by gate:heavy, T-006 — they need \`db\`): ` +
    `${integrationOnly.length === 0 ? 'none' : integrationOnly.map((p) => p.name).join(', ')}`,
);

if (DRY_RUN) {
  console.log(
    '\n--dry-run: V1-V4 only. NO PACKAGE TEST SCRIPT WAS EXECUTED, so nothing here is evidence ' +
      'that any test passed.',
  );
  finish(GATE, failures);
}

// ----------------------------------------------------------------- run them
/** `run-tests: 56 of 56 tests passed in 7 of 7 declared files; ...` */
const SUMMARY =
  /^run-tests: ([0-9]+) of ([0-9]+) tests passed in ([0-9]+) of ([0-9]+) declared files/m;

const unresolved: string[] = [];
let totalTests = 0;
let ran = 0;

for (const p of runnable) {
  console.log(`\n${'-'.repeat(78)}\n$ pnpm --filter ${p.name} run test`);
  const r = capture('pnpm', ['--filter', p.name, 'run', '--silent', 'test']);
  const out = `${r.stdout}${r.stderr}`;
  process.stdout.write(out.endsWith('\n') || out === '' ? out : `${out}\n`);
  ran += 1;

  if (r.spawnFailed) {
    failures.push(`${p.name}: could not execute the test script: ${r.stderr.trim()}`);
    continue;
  }
  if (r.code !== 0) {
    failures.push(`${p.name}: \`test\` exited ${String(r.code)}`);
    continue;
  }

  const m = SUMMARY.exec(out);
  if (m === null) {
    // Reported, not swallowed. An instrument whose unresolved list says "none"
    // while dropping cases is worse than one that admits what it skipped.
    unresolved.push(p.name);
    console.log(
      `  UNRESOLVED COUNT: ${p.name}'s runner printed no \`run-tests: N of M tests passed in F of G ` +
        `declared files\` line, so only the git-anchored checks (V1-V3) and its exit status cover it.`,
    );
    continue;
  }
  const passed = Number(m[1]);
  const total = Number(m[2]);
  const filesRun = Number(m[3]);
  const filesDeclared = Number(m[4]);
  totalTests += passed;

  if (passed < 1 || total < 1) {
    failures.push(`${p.name}: exited 0 having run ${String(passed)} test(s). A vacuous pass.`);
    continue;
  }
  if (passed !== total) {
    failures.push(`${p.name}: ${String(passed)} of ${String(total)} tests passed`);
    continue;
  }
  if (filesRun !== filesDeclared) {
    failures.push(`${p.name}: ran ${String(filesRun)} of ${String(filesDeclared)} declared files`);
    continue;
  }
  // V5 — the external anchor.
  if (filesDeclared !== p.testFiles.length) {
    failures.push(
      `FILE-SET-DRIFT ${p.name}: its runner declared ${String(filesDeclared)} test file(s); ` +
        `\`git ls-files\` tracks ${String(p.testFiles.length)} \`*.test.ts\` file(s) under ${p.dir}. ` +
        `Either a test file is not being run, or one is untracked. The two numbers come from ` +
        `different instruments on purpose (PROTOCOL §5.1).`,
    );
    continue;
  }
  console.log(
    `  ok  ${p.name}: ${String(passed)}/${String(total)} tests in ${String(filesDeclared)} file(s), ` +
      `matching ${String(p.testFiles.length)} tracked on disk`,
  );
}

if (ran !== runnable.length) {
  failures.push(`${String(ran)} of ${String(runnable.length)} packages actually ran`);
}
if (unresolved.length === runnable.length) {
  failures.push(
    `NO-COUNTABLE-RUN: not one of the ${String(runnable.length)} package(s) printed a countable ` +
      'summary line, so the per-test anti-vacuity check (V5) covered nothing. Exit statuses alone ' +
      'cannot tell a passing suite from an empty one.',
  );
}

console.log(`\n${'-'.repeat(78)}`);
console.log(`  ${String(ran)} package(s) run; ${String(totalTests)} test(s) counted.`);
console.log(
  `  unresolved counts: ${unresolved.length === 0 ? 'none' : unresolved.join(', ')} ` +
    `(${String(unresolved.length)} of ${String(runnable.length)})`,
);

finish(GATE, failures);
