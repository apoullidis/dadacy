/**
 * gate:deps — dependency-cruiser. SD §DH-1: "Module boundaries are enforced at
 * build time (SA SA-2): dependency-cruiser rules fail CI on a cross-module
 * import that does not go through a published module interface, and on any
 * import from apps/admin/components into apps/web."
 *
 * T-001 wires the tool and proves it blocks. The module-boundary RULE SET is
 * T-002's — see .dependency-cruiser.cjs.
 *
 * T-244 (OD-292a) adds three things here, and the two import rules beside them in
 * .dependency-cruiser.cjs (`no-cross-app-import`, `no-package-to-app-import`):
 *
 *   1. ONE depcruise run, read as JSON, so this gate can count what it read. Every
 *      violation is printed as `<severity> <rule-name>: <from> → <to>`, the shape
 *      depcruise's own `err` reporter prints, so a refusal names its rule.
 *   2. `no-app-package-dependency` — a MANIFEST rule, which depcruise cannot express:
 *      no apps/<a>/package.json names another app's package, and no
 *      packages/<x>/package.json names any app's package, in any dependency section
 *      (key, or a `workspace:`/`npm:` alias in the value), and no `link:`/`file:`/
 *      `portal:` value points into such an app's directory. The app set is DERIVED
 *      from apps/<dir>/package.json `name`, never listed here.
 *   3. COVERAGE, anchored outside depcruise: every tracked file under apps/ and
 *      packages/ with an extension depcruise reads must be among the modules it
 *      cruised, and each app's src/ must contribute at least one module. A file the
 *      cruiser never read is a file no rule judged (PROTOCOL §5.1: if the check did
 *      nothing, it must say so). The per-app counts are printed on every run.
 *
 * WHAT IT DOES NOT SEE (bounds; T-244 § Published contract): an import whose
 * specifier is not a literal (`import(x)`, `createRequire(...)(computed)`); code
 * loaded by a runtime flag (`node --import …` in a `start` script); a `paths` alias
 * in a per-package tsconfig.json (depcruise reads the ROOT tsconfig.json only; such
 * an alias resolves nowhere and is refused by `not-to-unresolvable`, not by a T-244
 * rule — measured, T-244 R9); the root package.json and pnpm-workspace.yaml
 * `overrides` (not read by rule 2 of this file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bin, capture, finish } from './lib/run.ts';

const failures: string[] = [];

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string; readonly severity: string };
}
interface CruiseResult {
  readonly modules: readonly { readonly source: string }[];
  readonly summary: {
    readonly violations: readonly Violation[];
    readonly error: number;
    readonly warn: number;
    readonly info: number;
    readonly totalCruised: number;
    readonly totalDependenciesCruised: number;
  };
}

// ---------------------------------------------------------------------------
// 1. dependency-cruiser, one run, JSON.
const roots = ['apps', 'packages', 'scripts'].filter((d) => fs.existsSync(path.join(REPO_ROOT, d)));
console.log(`$ depcruise --config .dependency-cruiser.cjs --output-type json ${roots.join(' ')}`);
const run = capture(bin('depcruise'), [
  '--config',
  '.dependency-cruiser.cjs',
  '--output-type',
  'json',
  ...roots,
]);
let cruise: CruiseResult | undefined;
try {
  cruise = JSON.parse(run.stdout) as CruiseResult;
  if (!Array.isArray(cruise.modules) || !Array.isArray(cruise.summary.violations)) {
    cruise = undefined;
  }
} catch {
  cruise = undefined;
}
if (cruise === undefined) {
  // A crash and a refusal are different outcomes (PROTOCOL §5.1).
  finish('gate:deps', [
    `dependency-cruiser produced no JSON verdict (exit ${String(run.code)}). Not a pass and not a ` +
      `refusal: a crash. Last lines:\n${`${run.stdout}${run.stderr}`.trimEnd().split('\n').slice(-8).join('\n')}`,
  ]);
}

console.log('');
for (const v of cruise.summary.violations) {
  console.log(`  ${v.rule.severity} ${v.rule.name}: ${v.from} → ${v.to}`);
}
const { error, warn, info, totalCruised, totalDependenciesCruised } = cruise.summary;
console.log(
  `\n${String(cruise.summary.violations.length)} dependency violation(s) (${String(error)} error(s), ` +
    `${String(warn)} warning(s), ${String(info)} info). ${String(totalCruised)} modules, ` +
    `${String(totalDependenciesCruised)} dependencies cruised.`,
);
// With `--output-type json` depcruise exits 0 even when it reports an error-severity
// violation (measured, T-244; only its `err` reporters set the exit code). So the
// verdict is `summary.error`, and a non-zero exit is something else and is reported.
if (error > 0)
  failures.push(`dependency-cruiser reported ${String(error)} error-severity violation(s)`);
if (run.code !== 0) failures.push(`dependency-cruiser exited ${String(run.code)}`);

// ---------------------------------------------------------------------------
// 2. no-app-package-dependency — the manifest rule.
const readJson = (rel: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
const dirsOf = (parent: string): string[] =>
  fs.existsSync(path.join(REPO_ROOT, parent))
    ? fs
        .readdirSync(path.join(REPO_ROOT, parent), { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() && fs.existsSync(path.join(REPO_ROOT, parent, d.name, 'package.json')),
        )
        .map((d) => d.name)
        .sort()
    : [];

/** app package name -> app directory (apps/<dir>), derived from the manifests. */
const apps = new Map<string, string>();
for (const d of dirsOf('apps')) {
  const name = readJson(`apps/${d}/package.json`)?.['name'];
  if (typeof name !== 'string' || name === '') {
    failures.push(
      `no-app-package-dependency: apps/${d}/package.json has no readable "name", so the app set ` +
        `cannot be derived — refused rather than judged against a partial set`,
    );
    continue;
  }
  apps.set(name, `apps/${d}`);
}

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const KEY_ONLY_SECTIONS = ['peerDependenciesMeta', 'dependenciesMeta'];
const LIST_SECTIONS = ['bundleDependencies', 'bundledDependencies'];
const manifestHits: string[] = [];
const manifests = [
  ...dirsOf('apps').map((d) => `apps/${d}`),
  ...dirsOf('packages').map((d) => `packages/${d}`),
];
for (const dir of manifests) {
  const rel = `${dir}/package.json`;
  const m = readJson(rel);
  if (m === undefined) {
    failures.push(
      `no-app-package-dependency: ${rel} is not a readable JSON object — refused, not skipped`,
    );
    continue;
  }
  // An app may name itself; it may name no other app. A package may name no app.
  const forbidden = [...apps].filter(([, appDir]) => appDir !== dir);
  const hit = (where: string, what: string, appDir: string): void => {
    manifestHits.push(`  error no-app-package-dependency: ${rel} ${where} ${what} → ${appDir}`);
  };
  const judge = (where: string, key: string, value: unknown): void => {
    for (const [name, appDir] of forbidden) {
      if (key === name) hit(where, `"${key}"`, appDir);
      else if (typeof value === 'string' && value.includes(name))
        hit(where, `"${key}": "${value}"`, appDir);
    }
    if (typeof value === 'string') {
      const lm = /^(?:link|file|portal):(.+)$/.exec(value);
      if (lm !== null) {
        const target = path.relative(REPO_ROOT, path.resolve(REPO_ROOT, dir, lm[1] ?? ''));
        for (const [, appDir] of forbidden) {
          if (target === appDir || target.startsWith(`${appDir}/`))
            hit(where, `"${key}": "${value}"`, appDir);
        }
      }
    }
  };
  for (const s of SECTIONS) {
    const sec = m[s];
    if (sec === undefined) continue;
    if (typeof sec !== 'object' || sec === null || Array.isArray(sec)) {
      failures.push(
        `no-app-package-dependency: ${rel} "${s}" is not an object — refused, not skipped`,
      );
      continue;
    }
    for (const [k, v] of Object.entries(sec)) judge(s, k, v);
  }
  for (const s of KEY_ONLY_SECTIONS) {
    const sec = m[s];
    if (typeof sec === 'object' && sec !== null && !Array.isArray(sec)) {
      for (const k of Object.keys(sec)) judge(s, k, undefined);
    }
  }
  for (const s of LIST_SECTIONS) {
    const sec = m[s];
    if (Array.isArray(sec)) for (const k of sec) if (typeof k === 'string') judge(s, k, undefined);
  }
}
console.log(
  `\nno-app-package-dependency: ${String(manifests.length)} manifest(s) read against ${String(apps.size)} app ` +
    `package(s) (${[...apps.keys()].join(', ')})`,
);
for (const h of manifestHits) console.log(h);
if (manifestHits.length > 0) {
  failures.push(
    `no-app-package-dependency: ${String(manifestHits.length)} manifest entr(y/ies) name an app package. ` +
      `Shared code goes in a packages/* workspace package (OD-292a, EV-30)`,
  );
}
if (manifests.length === 0 || apps.size === 0) {
  failures.push(
    `no-app-package-dependency read ${String(manifests.length)} manifest(s) and ${String(apps.size)} app(s): vacuous`,
  );
}

// ---------------------------------------------------------------------------
// 3. Coverage, anchored on git rather than on depcruise's own reading.
const CRUISED_EXT = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const EXCLUDED = /(^|\/)(node_modules|dist|build|out|\.next|\.turbo|coverage|\.cache)(\/|$)/;
const tracked = capture('git', ['ls-files', '-z', '--', 'apps', 'packages']);
if (tracked.spawnFailed || tracked.code !== 0) {
  failures.push('coverage: `git ls-files` failed; the coverage anchor cannot be computed');
} else {
  const cruised = new Set(cruise.modules.map((m) => m.source));
  const expected = tracked.stdout
    .split('\0')
    .filter((f) => f !== '' && CRUISED_EXT.test(f) && !EXCLUDED.test(f))
    .filter((f) => {
      try {
        return fs.lstatSync(path.join(REPO_ROOT, f)).isFile();
      } catch {
        return false; // deleted in the working tree: nothing to cruise
      }
    });
  const missed = expected.filter((f) => !cruised.has(f));
  console.log(
    `\ncoverage: ${String(expected.length)} tracked source file(s) under apps/ and packages/, ` +
      `${String(expected.length - missed.length)} of them cruised`,
  );
  if (missed.length > 0) {
    failures.push(
      `coverage: ${String(missed.length)} tracked source file(s) were NOT cruised, so no rule judged them: ` +
        missed.slice(0, 12).join(', '),
    );
  }
  for (const d of dirsOf('apps')) {
    const prefix = `apps/${d}/src/`;
    const n = [...cruised].filter((s) => s.startsWith(prefix)).length;
    const t = expected.filter((s) => s.startsWith(prefix)).length;
    console.log(`  modules cruised under ${prefix}: ${String(n)} (tracked: ${String(t)})`);
    if (t > 0 && n === 0)
      failures.push(`coverage: ${prefix} has ${String(t)} tracked file(s) and 0 cruised`);
  }
}

finish('gate:deps', failures);
