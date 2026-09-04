/**
 * `test` / `test:integration` — the Turborepo fan-out.
 *
 * Every package's own test script is run through turbo so caching and the task
 * graph in turbo.json apply. At T-001 no package implements these tasks yet
 * (the topology is placeholders, SD §DH-1). That is reported explicitly on
 * stdout rather than passing silently: a test command that quietly finds
 * nothing to run looks exactly like a test command that passed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bin } from './lib/run.ts';

const task = process.argv[2];
if (task === undefined || task === '') {
  console.error('usage: node scripts/gates/turbo-task.ts <task>');
  process.exit(2);
}

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
  console.log(`turbo run ${task}: NO PACKAGE IMPLEMENTS THIS TASK YET.`);
  console.log(
    '  The workspace is T-001 scaffolding — apps/* and packages/* are placeholder',
  );
  console.log(
    `  package.json files with no scripts. This is reported, not silently skipped:`,
  );
  console.log(
    `  0 suites run is a fact about the repository, not a passing test suite.`,
  );
  process.exit(0);
}

console.log(`turbo run ${task}  (${String(who.length)} package(s): ${who.join(', ')})`);
const r = spawnSync(bin('turbo'), ['run', task], { cwd: REPO_ROOT, stdio: 'inherit' });
process.exit(r.error !== undefined ? 127 : (r.status ?? 1));
