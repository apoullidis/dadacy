/**
 * docker/app-runtime/assert-no-dev-deps.mjs — a BUILD-TIME assertion, run
 * TWICE in docker/app.Dockerfile: in `prod-deps`, where it fails early and
 * points straight at the cause, and again in `runtime` AFTER THE LAST COPY,
 * where it proves the property of the image that actually ships.
 *
 *   node assert-no-dev-deps.mjs <root> <APP> [--bundle-out <file>]
 *   node assert-no-dev-deps.mjs <root> <APP> --bundle <file>
 *
 *   <root>   the tree whose node_modules is inspected.
 *   <APP>    the app the image is built for (apps/<APP>/package.json).
 *   WHOLE-WORKSPACE MODE (<root> has pnpm-lock.yaml; the `prod-deps` run):
 *            every package.json under <root> is read, and every `importers:`
 *            entry of the lockfile must be among them. --bundle-out writes
 *            those manifests' exact bytes and the importer list to <file>.
 *   BUNDLE MODE (<root> has no pnpm-lock.yaml; the `runtime` run): the
 *            manifests and importers are read from the bundle the `prod-deps`
 *            run wrote, and every package.json under <root> must be in the
 *            bundle with identical bytes. Without a lockfile and without
 *            --bundle, the run is refused.
 *
 * Both runs are needed and the second is the load-bearing one. A guard that
 * runs only in `prod-deps` proves a property OF `prod-deps`: QA built the
 * counter-example, and a single `COPY --from=deps` in the runtime stage put
 * 23.6 MB of typescript into kinvara/core:dev with the guard green.
 *
 * IT DOES SHIP, and an earlier version of this comment said "it never ships".
 * That was false: `COPY docker/app-runtime/ ./app-runtime/` copies this whole
 * directory into the image, and QA found the file there. It is inert — nothing
 * invokes it at runtime — but writing an unverified "never" into the very file
 * created to stop unverified claims is the defect in miniature, so: it ships,
 * it is a few KB, and it does nothing once the image is running. The bundle
 * ships too (app-runtime/workspace-manifests.json): JSON, not executable.
 *
 * WHY IT EXISTS. T-018's first version claimed in its evidence — as measured
 * fact — that "typescript, eslint, turbo, size-limit, dependency-cruiser do
 * not reach" the runtime image. All five were in it, plus prettier: 112.2 MB
 * of a 270 MB image, the entire top ten by size. The mechanism was that
 * `prod-deps` was `FROM deps` and `pnpm --filter … --prod install` re-links
 * the filtered projects without purging the inherited workspace-root virtual
 * store, so `node_modules/.pnpm` kept the whole dev install.
 *
 * IT IS A CHECK AND NOT A CLAIM, AND IT RUNS WHERE THE PROPERTY LIVES.
 * `gate:app-images` cannot see inside an image, so the assertion runs in the
 * build, and a regression turns `svc up --verify --build` red.
 *
 * =============================================================================
 * WHY A BUNDLE (T-154 rework 1, decisions.md OD-122)
 * =============================================================================
 * The runtime stage copies only apps/<APP>, so the image holds 15 of the
 * workspace's 19 manifests. A guard that read its names from the image could
 * not know a name another app declares as a devDependency: QA planted
 * `esbuild` (dev only in apps/worker) into core's runtime stage and both runs
 * passed. So the runtime run judges the manifests the prod-deps run judged,
 * carried as bytes, not as a name list derived from them: both runs execute
 * the same code over the same bytes and print the same manifest-set sha256.
 * The bundle is written in the same build and never committed, and the checks
 * above tie it to the image: every manifest in the image must be in it,
 * byte-identical, and every lockfile importer's manifest must be in it.
 *
 * =============================================================================
 * THE RULE (T-154, amending T-018/T-034's "any devDependency named anywhere")
 * =============================================================================
 * Every workspace package.json is read. Nothing here enumerates a package.
 *
 *   CLOSURE  = apps/<APP>/package.json, plus every workspace manifest reached
 *              from it through a `workspace:` spec in `dependencies` or
 *              `optionalDependencies`, transitively. (The manifests pnpm's
 *              `--filter @kinvara/<APP>... --prod` install reads.)
 *   RUNTIME  = every name under `dependencies`/`optionalDependencies` of a
 *              manifest IN the closure.
 *
 * A name some manifest declares under `devDependencies` is CHECKED — it must be
 * absent from <root>/node_modules, top level and virtual store — UNLESS BOTH
 * hold:
 *   (a) no manifest IN the closure declares it as a devDependency; and
 *   (b) some manifest IN the closure declares it as a runtime dependency.
 * Such a name is EXEMPT, and is printed as exempt on every run.
 *
 * Why the old rule was one step too wide (decisions.md OD-117): the workspace
 * root declares `pg` and `drizzle-orm` as devDependencies because its own
 * scripts (db:migrate, db:introspect) use them in the toolbox. The root is
 * never installed into an image. Reading that declaration as "dev tooling for
 * every image" refused `apps/core` declaring the same packages as runtime
 * dependencies.
 *
 * Why (a) and not only (b): the closure's own manifests must agree. Moving
 * `typescript` or `vitest` from an app's devDependencies to its dependencies
 * (what a `pnpm add` without -D does) is still refused while any manifest in
 * the closure calls it dev — `packages/contracts` does, for both.
 *
 * WHAT IT DOES NOT CATCH, stated narrowly:
 *   - a devtool declared as a runtime dependency by the closure when every
 *     manifest that calls it dev is OUTSIDE the closure (for example a
 *     root-only devDependency such as `drizzle-kit` added to an app's
 *     `dependencies`). The declaration is what exempts it.
 *   - a package that is only a TRANSITIVE dependency of a devDependency and is
 *     named in no package.json.
 *   - a workspace package reached by a spec that is not `workspace:`; its
 *     manifest is not in the closure.
 *   - anything put into the image AFTER the run (a COPY, or a RUN that copies).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE_KIND = 'kinvara-workspace-manifests/v1';
const refuse = (msg) => {
  console.error(`assert-no-dev-deps: ${msg} — refusing to pass`);
  process.exit(1);
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// --- arguments ---------------------------------------------------------------
const positional = [];
let bundleIn = null;
let bundleOut = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--bundle' || a === '--bundle-out') {
    const v = argv[i + 1];
    if (v === undefined || v === '') refuse(`${a} needs a file path`);
    if (a === '--bundle') bundleIn = path.resolve(v);
    else bundleOut = path.resolve(v);
    i += 1;
  } else if (a.startsWith('--')) {
    refuse(`unknown option ${a}`);
  } else {
    positional.push(a);
  }
}
if (positional.length > 2) refuse(`unexpected argument(s): ${positional.slice(2).join(' ')}`);
const root = path.resolve(positional[0] ?? '/srv/kinvara');
const app = positional[1] ?? '';
const modules = path.join(root, 'node_modules');

if (app === '') {
  refuse(
    "no APP argument. The exemption is judged against ONE app's runtime closure, " +
      'so without an app there is nothing to judge against',
  );
}

/** Every package.json under `dir`, root included, ignoring node_modules. */
const manifestsUnder = (top) => {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'package.json') found.push(path.relative(top, full));
    }
  };
  walk(top, 0);
  return found.sort();
};

/** The project paths under `importers:` in a pnpm-lock.yaml. */
const importersOf = (text) => {
  const out = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^importers:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break;
    const m = /^ {2}(?:'([^']*)'|"([^"]*)"|([^\s'"][^:]*)):(?:\s*\{\})?\s*$/.exec(line);
    if (m) out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
};

// --- where the manifests come from -------------------------------------------
const lockPath = path.join(root, 'pnpm-lock.yaml');
const wholeWorkspace = fs.existsSync(lockPath);
if (wholeWorkspace && bundleIn !== null) {
  refuse(
    `${root} has a pnpm-lock.yaml and --bundle was also given. Judge a whole workspace ` +
      'from its own files, or an image tree from a bundle, not both',
  );
}
if (bundleOut !== null && !wholeWorkspace) {
  refuse('--bundle-out needs a whole workspace: a pnpm-lock.yaml under the root');
}
if (!wholeWorkspace && bundleIn === null) {
  refuse(
    `${root} has no pnpm-lock.yaml and no --bundle was given, so this run cannot know ` +
      "every workspace manifest's devDependencies (the runtime stage holds only " +
      "apps/<APP>'s). In app.Dockerfile the runtime run is given the bundle the prod-deps run wrote",
  );
}

const bytes = new Map(); // rel path -> exact bytes of that package.json
let importers;
let source;
if (wholeWorkspace) {
  for (const rel of manifestsUnder(root)) bytes.set(rel, fs.readFileSync(path.join(root, rel)));
  importers = importersOf(fs.readFileSync(lockPath, 'utf8'));
  if (importers.length === 0) {
    refuse(`${lockPath} lists no importers, so the workspace's projects cannot be checked`);
  }
  source = `the workspace tree ${root} (pnpm-lock.yaml present)`;
} else {
  let bundle = null;
  try {
    bundle = JSON.parse(fs.readFileSync(bundleIn, 'utf8'));
  } catch (e) {
    refuse(`cannot read the bundle ${bundleIn}: ${e.message}`);
  }
  if (
    bundle === null ||
    bundle.kind !== BUNDLE_KIND ||
    !Array.isArray(bundle.importers) ||
    typeof bundle.manifests !== 'object' ||
    bundle.manifests === null
  ) {
    refuse(`${bundleIn} is not a ${BUNDLE_KIND} bundle`);
  }
  importers = bundle.importers.map(String);
  for (const [rel, b64] of Object.entries(bundle.manifests)) {
    bytes.set(rel, Buffer.from(String(b64), 'base64'));
  }
  if (importers.length === 0) refuse(`${bundleIn} lists no importers`);
  source = `the bundle ${bundleIn}`;
}
if (bytes.size === 0) refuse(`found no package.json in ${source}`);

const unread = importers.filter((imp) => !bytes.has(path.join(imp, 'package.json')));
if (unread.length > 0) {
  refuse(
    `pnpm-lock.yaml lists ${String(unread.length)} project(s) whose package.json is not in ` +
      `${source}: ${unread.join(', ')}. Their devDependencies would go unread`,
  );
}

const rels = [...bytes.keys()].sort();
const manifestSet = sha256(rels.map((rel) => `${rel}\t${sha256(bytes.get(rel))}\n`).join(''));

let wrote = '';
if (bundleOut !== null) {
  const text = `${JSON.stringify({
    kind: BUNDLE_KIND,
    note: 'Written by the prod-deps run of assert-no-dev-deps.mjs for the runtime run. Data, not code.',
    importers,
    manifests: Object.fromEntries(rels.map((rel) => [rel, bytes.get(rel).toString('base64')])),
  })}\n`;
  fs.writeFileSync(bundleOut, text, { mode: 0o644 });
  wrote = `${bundleOut} (${String(rels.length)} manifest(s), ${String(Buffer.byteLength(text))} B)`;
}

// --- in bundle mode, the image's manifests must be the bundle's ---------------
let imageNote = 'the workspace tree itself';
if (!wholeWorkspace) {
  const inImage = manifestsUnder(root);
  for (const rel of inImage) {
    const judged = bytes.get(rel);
    if (judged === undefined) {
      refuse(
        `${path.join(root, rel)} is in the image but not in the bundle, ` +
          'so the closure judged here is not the one that ships',
      );
    }
    if (!judged.equals(fs.readFileSync(path.join(root, rel)))) {
      refuse(
        `${path.join(root, rel)} differs from the bundle's copy, ` +
          'so the closure judged here is not the one that ships',
      );
    }
  }
  imageNote = `${String(inImage.length)} manifest(s) under ${root}, each byte-identical to the bundle's`;
}

/** rel path -> parsed manifest */
const pkgs = new Map();
for (const rel of rels) {
  try {
    pkgs.set(rel, JSON.parse(bytes.get(rel).toString('utf8')));
  } catch (e) {
    refuse(`${rel} (from ${source}) is not parseable JSON: ${e.message}`);
  }
}

/** workspace package name -> rel path of its manifest */
const byName = new Map();
for (const [rel, pkg] of pkgs) {
  if (typeof pkg.name === 'string') byName.set(pkg.name, rel);
}

const appRel = path.join('apps', app, 'package.json');
if (!pkgs.has(appRel)) refuse(`APP '${app}' has no ${appRel} in ${source}`);

// --- the runtime closure ------------------------------------------------------
const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies'];
const closure = [appRel];
const runtime = new Map(); // name -> manifests (in the closure) declaring it
for (let i = 0; i < closure.length; i += 1) {
  const rel = closure[i];
  const pkg = pkgs.get(rel);
  for (const field of RUNTIME_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!runtime.has(name)) runtime.set(name, []);
      runtime.get(name).push(rel);
      if (String(spec).startsWith('workspace:')) {
        const dep = byName.get(name);
        if (dep === undefined) {
          refuse(
            `${rel} depends on ${name}@${String(spec)}, and no workspace manifest is named ${name}`,
          );
        }
        if (!closure.includes(dep)) closure.push(dep);
      }
    }
  }
}
const inClosure = new Set(closure);

// --- devDependency names, and which of them are checked -----------------------
const dev = new Map(); // name -> manifests declaring it as a devDependency
for (const [rel, pkg] of pkgs) {
  for (const name of Object.keys(pkg.devDependencies ?? {})) {
    if (!dev.has(name)) dev.set(name, []);
    dev.get(name).push(rel);
  }
}

if (dev.size === 0) {
  refuse(
    'no package.json in this workspace declares any devDependencies, so this check ' +
      'asserts nothing. That is not the state this repository is in (the root manifest ' +
      'declares a dozen), so something is wrong with the copy into this stage',
  );
}

const checked = new Map();
const exempt = [];
for (const [name, declaredIn] of dev) {
  const devInClosure = declaredIn.some((rel) => inClosure.has(rel));
  if (!devInClosure && runtime.has(name)) {
    exempt.push(
      `${name} (devDependency of ${declaredIn.join(', ')}; runtime dependency of ${runtime.get(name).join(', ')})`,
    );
  } else {
    checked.set(name, declaredIn);
  }
}

if (checked.size === 0) {
  refuse('every devDependency name is exempt, so this check asserts nothing');
}

const storeDir = path.join(modules, '.pnpm');
const store = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
// pnpm's virtual store mangles a scoped name: @turbo/linux-64 -> @turbo+linux-64
const mangled = (name) => name.replace(/\//g, '+');

const found = [];
for (const [name, declaredIn] of checked) {
  if (fs.existsSync(path.join(modules, name))) {
    found.push(`  ${name}  (top-level node_modules/${name}; declared in ${declaredIn.join(', ')})`);
  }
  const prefix = `${mangled(name)}@`;
  const hits = store.filter((d) => d.startsWith(prefix));
  if (hits.length > 0) {
    found.push(
      `  ${name}  (virtual store: ${hits.join(', ')}; declared in ${declaredIn.join(', ')})`,
    );
  }
}

console.log(`assert-no-dev-deps: APP=${app}; manifests from ${source}`);
console.log(
  `assert-no-dev-deps: ${String(rels.length)} workspace manifest(s), covering all ` +
    `${String(importers.length)} pnpm-lock.yaml importer(s); manifest set sha256:${manifestSet}`,
);
console.log(`assert-no-dev-deps: image tree: ${imageNote}`);
if (wrote !== '') console.log(`assert-no-dev-deps: wrote the bundle for the runtime run: ${wrote}`);
console.log(`assert-no-dev-deps: runtime closure: ${closure.join(', ')}`);
console.log(
  `assert-no-dev-deps: ${String(dev.size)} devDependency name(s) across ` +
    `${String(rels.length)} manifest(s): ${String(checked.size)} checked, ` +
    `${String(exempt.length)} exempt; virtual store holds ${String(store.length)} package(s)`,
);
console.log(
  `assert-no-dev-deps: exempt (a devDependency only outside the closure AND a runtime ` +
    `dependency inside it): ${exempt.length > 0 ? exempt.join('; ') : 'none'}`,
);

if (found.length > 0) {
  console.error('\nassert-no-dev-deps: DEVDEPENDENCIES ARE IN THE RUNTIME DEPENDENCY TREE.\n');
  console.error(found.join('\n'));
  console.error(
    '\nEach name above is a devDependency this image may not carry. The usual causes:\n' +
      '  - the stage inherits or copies a dev install (`FROM deps`, `COPY --from=deps`).\n' +
      '    `pnpm --prod install` over an existing dev install does NOT purge the virtual\n' +
      '    store; that shipped once, 112.2 MB of a 270 MB image;\n' +
      '  - a runtime package pulls it in as a dependency or a resolved peer;\n' +
      `  - a manifest in the closure of @kinvara/${app} declares it as a devDependency\n` +
      '    while another declares it as a runtime dependency. The closure must agree.\n',
  );
  process.exit(1);
}
console.log('assert-no-dev-deps: OK — none of the checked names is present');
