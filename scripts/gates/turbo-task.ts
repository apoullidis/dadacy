/**
 * `test` / `test:integration` — the Turborepo fan-out.
 *
 * Every package's own test script is run through turbo so caching and the task
 * graph in turbo.json apply. At T-001 no package implements these tasks yet
 * (the topology is placeholders, SD §DH-1). That is reported explicitly on
 * stdout rather than passing silently: a test command that quietly finds
 * nothing to run looks exactly like a test command that passed.
 *
 * T-005, decisions.md OD-3. Reporting it was not enough, and the reason is
 * worth keeping: the zero-implementer branch EXITED 0. So the moment the first
 * package implemented the task, the message stopped printing and a package that
 * FORGOT became indistinguishable from one that passed — the same shape as the
 * Trivy zero-package defect. The branch now exits NON-ZERO. Five packages
 * implement `test` and two implement `test:integration` as of main c27c354, so
 * this branch is not reachable today; it is the floor under the day someone
 * deletes the last one.
 *
 * WHAT THIS DOES NOT FIX, and what does: this program can only see packages
 * that DECLARE the script. A package that ships tests and declares nothing is
 * invisible here by construction. That half is `gate:unit-tests`, which asks
 * `git ls-files` instead (V1/V3), and is the blocking gate — this is the
 * workspace runner, not the gate.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bin } from './lib/run.ts';

const argvTask = process.argv[2];
if (argvTask === undefined || argvTask === '') {
  console.error('usage: node scripts/gates/turbo-task.ts <task>');
  process.exit(2);
}
const task: string = argvTask;

/** Which workspace packages actually declare this script? */
function implementers(): string[] {
  const found: string[] = [];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(REPO_ROOT, group);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const pkgFile = path.join(dir, entry, 'package.json');
      if (!fs.existsSync(pkgFile)) continue;
      const pkg: unknown = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const scripts =
        typeof pkg === 'object' && pkg !== null && 'scripts' in pkg
          ? (pkg as { scripts: unknown }).scripts
          : undefined;
      if (typeof scripts === 'object' && scripts !== null && task in scripts) {
        found.push(`${group}/${entry}`);
      }
    }
  }
  return found;
}

const who = implementers();
if (who.length === 0) {
  console.error(`TASK VACUOUS  ${task}: NO PACKAGE IMPLEMENTS THIS TASK.`);
  console.error('  0 suites run is a fact about the repository, not a passing test suite, so this');
  console.error('  exits NON-ZERO (T-005, decisions.md OD-3). It exited 0 until 2026-09-19, which');
  console.error('  meant that once one package implemented the task a package that forgot was');
  console.error('  silently skipped — the Trivy zero-package defect in another costume.');
  console.error(
    `  Declare a \`${task}\` script in at least one workspace package, or run the gate`,
  );
  console.error('  that judges the declaration set directly: `pnpm gate:unit-tests`.');
  process.exit(1);
}

console.log(`turbo run ${task}  (${String(who.length)} package(s): ${who.join(', ')})`);
const r = spawnSync(bin('turbo'), ['run', task], { cwd: REPO_ROOT, stdio: 'inherit' });
process.exit(r.error !== undefined ? 127 : (r.status ?? 1));
