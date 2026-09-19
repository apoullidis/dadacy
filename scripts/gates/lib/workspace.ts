/**
 * Workspace discovery for the test gates (T-005).
 *
 * The package list is derived from `pnpm-workspace.yaml`'s globs and the test
 * file list from `git ls-files` — deliberately NOT from the thing being
 * checked. PROTOCOL §5.1: "a check must not be derived from the same reading as
 * the thing it checks." A package's own test runner reports how many files it
 * declared; git reports how many exist. The gates compare the two, and that is
 * the only reason either number means anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, capture } from './run.ts';

export interface WorkspacePackage {
  /** Path relative to the repo root, e.g. `packages/policy`. */
  readonly dir: string;
  /** The `name` field, e.g. `@kinvara/policy`. */
  readonly name: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** Tracked `*.test.ts` / `*.test.tsx` paths under this package. */
  readonly testFiles: readonly string[];
  /** Tracked `.ts`/`.tsx` under `<dir>/src/`, excluding test files. */
  readonly sourceFiles: readonly string[];
}

/** The workspace globs, read from pnpm-workspace.yaml rather than hard-coded. */
export function workspaceGlobs(): string[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s+-\s*'?"?([^'"\s]+)'?"?\s*$/.exec(line);
      if (m?.[1] !== undefined) {
        globs.push(m[1]);
        continue;
      }
      if (line.trim() !== '' && !line.startsWith(' ')) inPackages = false;
    }
  }
  return globs;
}

/** Every tracked file, once. Throws if git cannot be run — never guesses. */
function trackedFiles(): string[] {
  const r = capture('git', ['ls-files']);
  if (r.spawnFailed || r.code !== 0) {
    throw new Error(`git ls-files failed (exit ${String(r.code)}): ${r.stderr.trim()}`);
  }
  return r.stdout.split('\n').filter((l) => l !== '');
}

const TEST_FILE = /\.test\.tsx?$/;
const TS_FILE = /\.tsx?$/;

export function workspacePackages(): WorkspacePackage[] {
  const globs = workspaceGlobs();
  const roots = new Set<string>();
  for (const g of globs) {
    // Only the `<dir>/*` shape occurs in this repo; anything else is refused
    // rather than silently matched, because a glob this code cannot read is a
    // package set this code cannot claim to cover.
    const m = /^([^*]+)\/\*$/.exec(g);
    if (m?.[1] === undefined) {
      throw new Error(
        `pnpm-workspace.yaml glob ${JSON.stringify(g)} is not of the form '<dir>/*'. ` +
          'scripts/gates/lib/workspace.ts cannot enumerate it, and a gate that quietly ' +
          'skips a package set is the defect T-005 exists to prevent.',
      );
    }
    roots.add(m[1]);
  }

  const tracked = trackedFiles();
  const out: WorkspacePackage[] = [];
  for (const root of [...roots].sort()) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs).sort()) {
      const dir = `${root}/${entry}`;
      const pkgFile = path.join(REPO_ROOT, dir, 'package.json');
      if (!fs.existsSync(pkgFile)) continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const obj =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const name = typeof obj['name'] === 'string' ? obj['name'] : dir;
      const rawScripts = obj['scripts'];
      const scripts: Record<string, string> = {};
      if (typeof rawScripts === 'object' && rawScripts !== null) {
        for (const [k, v] of Object.entries(rawScripts)) if (typeof v === 'string') scripts[k] = v;
      }
      const mine = tracked.filter((f) => f.startsWith(`${dir}/`));
      out.push({
        dir,
        name,
        scripts,
        testFiles: mine.filter((f) => TEST_FILE.test(f)),
        sourceFiles: mine.filter(
          (f) => f.startsWith(`${dir}/src/`) && TS_FILE.test(f) && !TEST_FILE.test(f),
        ),
      });
    }
  }
  return out;
}
