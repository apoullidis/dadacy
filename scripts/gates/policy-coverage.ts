/**
 * gate:policy-coverage — SD §QD-4's PR row item "policy tests at 100% branch".
 *
 * SD §QD-1: "100% branch — a CI gate, not a target. This is the authorisation
 * layer; partial coverage is not acceptable (SA TS-11)."
 *
 * WHAT IS MINE AND WHAT IS NOT. The role matrix, the cases and the coverage
 * instrument belong to T-024 (`packages/policy`). What T-005 owns is that the
 * number is READ where it blocks, and that it cannot be satisfied by covering
 * nothing. So this gate does not compute coverage; it runs the package's own
 * test script and refuses three things the printed number alone cannot:
 *
 *   P1  branches covered != branches total, or the percentage is not 100.
 *   P2  branches total == 0, or source files == 0 — 100% of nothing is the
 *       vacuous pass (the Trivy zero-package shape, OD-3).
 *   P3  THE EXTERNAL ANCHOR: the number of source files the coverage line
 *       reports must equal the number of non-test `.ts` files `git ls-files`
 *       tracks under packages/policy/src/. Coverage tools report 100% over the
 *       files they were pointed at; git says which files exist. If a source
 *       file silently stops being instrumented, 100% stays 100% and this check
 *       is the only thing that moves (PROTOCOL §5.1: a check must not be
 *       derived from the same reading as the thing it checks).
 *
 * And, because "did nothing" must not look like "passed": no coverage line at
 * all is a FAIL naming the missing line, never a skip.
 */
import { capture, finish } from './lib/run.ts';
import { workspacePackages } from './lib/workspace.ts';

const PKG = 'packages/policy';
const failures: string[] = [];

const pkg = workspacePackages().find((p) => p.dir === PKG);
if (pkg === undefined) {
  finish('gate:policy-coverage', [`${PKG} is not a workspace package`]);
}
if (!('test' in pkg.scripts)) {
  finish('gate:policy-coverage', [
    `${PKG} declares no \`test\` script, so the 100%-branch gate has nothing to read. ` +
      'SD §QD-4 makes this row blocking.',
  ]);
}

console.log(`$ pnpm --filter ${pkg.name} run test`);
const r = capture('pnpm', ['--filter', pkg.name, 'run', '--silent', 'test']);
const out = `${r.stdout}${r.stderr}`;
process.stdout.write(out.endsWith('\n') || out === '' ? out : `${out}\n`);

if (r.spawnFailed) {
  finish('gate:policy-coverage', [`could not execute the test script: ${r.stderr.trim()}`]);
}
if (r.code !== 0) failures.push(`${pkg.name}: \`test\` exited ${String(r.code)}`);

/** `run-tests: coverage branches 75/75 (100%), functions 17/17, statements 100/100, lines 78/78, over 5 source file(s)` */
const COVERAGE =
  /^run-tests: coverage branches ([0-9]+)\/([0-9]+) \(([0-9]+(?:\.[0-9]+)?)%\).*?over ([0-9]+) source file\(s\)/m;
const m = COVERAGE.exec(out);

if (m === null) {
  failures.push(
    `${pkg.name} printed NO coverage line. The gate reads ` +
      '`run-tests: coverage branches A/B (P%), ... over N source file(s)`. ' +
      'Without it this gate has measured nothing, and it says so rather than passing.',
  );
  finish('gate:policy-coverage', failures);
}

const covered = Number(m[1]);
const total = Number(m[2]);
const pct = Number(m[3]);
const files = Number(m[4]);
const tracked = pkg.sourceFiles.length;

console.log(
  `\n  branches ${String(covered)}/${String(total)} (${String(pct)}%), over ${String(files)} source file(s)`,
);
console.log(`  git tracks ${String(tracked)} non-test .ts file(s) under ${PKG}/src/`);

if (total === 0 || files === 0) {
  failures.push(
    `VACUOUS: ${String(total)} branch(es) over ${String(files)} source file(s). ` +
      '100% of nothing is not 100% (OD-3).',
  );
}
if (covered !== total || pct !== 100) {
  failures.push(
    `branch coverage is ${String(covered)}/${String(total)} (${String(pct)}%), not 100% ` +
      '(SD §QD-1: "a CI gate, not a target").',
  );
}
if (files !== tracked) {
  failures.push(
    `FILE-SET-DRIFT: coverage reports ${String(files)} source file(s); git tracks ${String(tracked)} ` +
      `under ${PKG}/src/ (${pkg.sourceFiles.join(', ')}). A file that stops being instrumented ` +
      'leaves the percentage at 100 and moves nothing else.',
  );
}

finish('gate:policy-coverage', failures);
