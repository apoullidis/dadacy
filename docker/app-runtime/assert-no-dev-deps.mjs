/**
 * docker/app-runtime/assert-no-dev-deps.mjs — a BUILD-TIME assertion, run
 * TWICE in docker/app.Dockerfile: in `prod-deps`, where it fails early and
 * points straight at the cause, and again in `runtime` AFTER THE LAST COPY,
 * where it proves the property of the image that actually ships.
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
 * it is about 4 KB, and it does nothing once the image is running.
 *
 * WHY IT EXISTS. T-018's first version claimed in its evidence — as measured
 * fact — that "typescript, eslint, turbo, size-limit, dependency-cruiser do
 * not reach" the runtime image. All five were in it, plus prettier: 112.2 MB
 * of a 270 MB image, the entire top ten by size. The mechanism was that
 * `prod-deps` was `FROM deps` and `pnpm --filter … --prod install` re-links
 * the filtered projects without purging the inherited workspace-root virtual
 * store, so `node_modules/.pnpm` kept the whole dev install.
 *
 * The structural fix is that `prod-deps` now starts `FROM base` and has
 * nothing to inherit. This is the check that makes the fix hold: reinstating
 * `FROM deps` puts turbo and typescript back, and this fails the build.
 *
 * IT IS A CHECK AND NOT A CLAIM, AND IT RUNS WHERE THE PROPERTY LIVES.
 * `gate:app-images` cannot see inside an image; the leak is invisible from
 * outside until someone measures a layer, which is precisely why it shipped.
 * So the assertion runs in the build, and a regression turns
 * `svc up --verify --build` red rather than producing a working image that
 * nobody opens.
 *
 * DERIVED, NOT LISTED: every package.json in the tree is read and every name
 * in its `devDependencies` must be absent. Nothing here enumerates a package.
 *
 * WHAT IT DOES NOT CATCH: a package that is only a TRANSITIVE dependency of a
 * devDependency and is named in no package.json. Excluding the direct ones is
 * what makes their trees absent, so in practice the two travel together — but
 * that is the reasoning, not the assertion, and the assertion is the narrow
 * one.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? '/srv/kinvara';
const modules = path.join(root, 'node_modules');

/** Every package.json in the workspace, root included, ignoring node_modules. */
const manifests = [];
const walk = (dir, depth) => {
  if (depth > 3) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else if (entry.name === 'package.json') manifests.push(full);
  }
};
walk(root, 0);

if (manifests.length === 0) {
  console.error(`assert-no-dev-deps: found no package.json under ${root} — refusing to pass`);
  process.exit(1);
}

/** name -> the manifests that declare it as a devDependency. */
const dev = new Map();
for (const m of manifests) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(m, 'utf8'));
  } catch (e) {
    console.error(`assert-no-dev-deps: ${m} is not parseable JSON: ${e.message}`);
    process.exit(1);
  }
  for (const name of Object.keys(pkg.devDependencies ?? {})) {
    if (!dev.has(name)) dev.set(name, []);
    dev.get(name).push(path.relative(root, m));
  }
}

if (dev.size === 0) {
  console.error(
    'assert-no-dev-deps: no package.json in this workspace declares any devDependencies, so ' +
      'this check asserts nothing. That is not the state this repository is in ' +
      '(the root manifest declares a dozen), so something is wrong with the copy into ' +
      'this stage. Refusing to pass.',
  );
  process.exit(1);
}

const storeDir = path.join(modules, '.pnpm');
const store = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
// pnpm's virtual store mangles a scoped name: @turbo/linux-64 -> @turbo+linux-64
const mangled = (name) => name.replace(/\//g, '+');

const found = [];
for (const [name, declaredIn] of dev) {
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

console.log(
  `assert-no-dev-deps: ${String(dev.size)} devDependency name(s) across ` +
    `${String(manifests.length)} manifest(s); virtual store holds ${String(store.length)} package(s)`,
);

if (found.length > 0) {
  console.error('\nassert-no-dev-deps: DEVDEPENDENCIES ARE IN THE RUNTIME DEPENDENCY TREE.\n');
  console.error(found.join('\n'));
  console.error(
    '\nThe `prod-deps` stage must start FROM base, not FROM deps. `pnpm --prod install`\n' +
      'over an existing dev install re-links the filtered projects but does NOT purge the\n' +
      'workspace-root virtual store, so node_modules/.pnpm keeps everything. That shipped\n' +
      'once: 112.2 MB of a 270 MB image, the whole top ten by size.\n',
  );
  process.exit(1);
}
console.log('assert-no-dev-deps: OK — none of them is present');
