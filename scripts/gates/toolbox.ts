/**
 * gate:toolbox — QA-F3, the obligation T-000 carried to T-001.
 *
 * T-000 proved three properties of the toolbox ONCE, in an evidence file:
 * every tool matches its pin, the same command run twice is byte-identical,
 * and a file the toolbox writes is owned by the invoking user. One-time
 * evidence decays. CHECKPOINT_DISABLE=1 and the whole pin contract were, until
 * this gate existed, enforced by memory alone.
 *
 * PROTOCOL.md §5.1, in full, because it is the reason this file is shaped the
 * way it is: "Any determinism or comparison check asserts the exit status too,
 * not just the bytes... two separate agents independently wrote a bash-shaped
 * loop that sent one argv, exited 127 twice, and compared two identical error
 * messages as if that were a pass. Assert exit 0 AND identical bytes, or the
 * check is decorative."
 *
 * Every determinism assertion below therefore requires: run 1 exit 0, run 2
 * exit 0, and stdout+stderr byte-identical. Any one of the three missing is a
 * failure.
 *
 * This gate runs INSIDE the toolbox (`scripts/dev pnpm gate:toolbox`), which is
 * the only place the properties can be observed at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, capture, finish, toolVersions } from './lib/run.ts';

const failures: string[] = [];
const pins = toolVersions();

function pin(key: string): string | undefined {
  return pins.get(key);
}

// ---------------------------------------------------------------------------
// 1. Versions match .tool-versions exactly.
// ---------------------------------------------------------------------------
console.log('1. PINS — every tool reports exactly what .tool-versions says\n');

interface Probe {
  readonly tool: string;
  readonly pinKey: string;
  readonly argv: readonly string[];
  /** Pull the bare version out of the command's stdout. */
  readonly extract: (out: string) => string;
  /**
   * Set when the tool is deliberately absent from one toolbox variant. The
   * probe is then reported as skipped-by-design there instead of failing.
   */
  readonly absentFrom?: { readonly variant: Variant; readonly why: string };
}

const first = (s: string): string => s.split('\n')[0] ?? '';

// ---------------------------------------------------------------------------
// Which toolbox variant are we in?
//
// Detected from the filesystem rather than an env var, deliberately: the image
// tag is a fingerprint of .tool-versions ONLY (T-016 / OD-1), so editing the
// Dockerfile does not invalidate a cached image. An env var added there could
// be missing from an image built before the edit; /ms-playwright comes from
// the mcr.microsoft.com/playwright base image itself and cannot be stale.
// ---------------------------------------------------------------------------
type Variant = 'toolbox' | 'toolbox-playwright';
const VARIANT: Variant = fs.existsSync('/ms-playwright') ? 'toolbox-playwright' : 'toolbox';

const PROBES: readonly Probe[] = [
  {
    tool: 'node',
    pinKey: 'nodejs',
    argv: ['node', '--version'],
    extract: (o) => first(o).trim().replace(/^v/, ''),
  },
  { tool: 'pnpm', pinKey: 'pnpm', argv: ['pnpm', '--version'], extract: (o) => first(o).trim() },
  {
    tool: 'terraform',
    pinKey: 'terraform',
    argv: ['terraform', 'version'],
    extract: (o) =>
      first(o)
        .trim()
        .replace(/^Terraform v/, ''),
  },
  {
    tool: 'gitleaks',
    pinKey: 'gitleaks',
    argv: ['gitleaks', 'version'],
    extract: (o) => first(o).trim(),
  },
  {
    tool: 'trivy',
    pinKey: 'trivy',
    argv: ['trivy', '--version'],
    extract: (o) =>
      first(o)
        .replace(/^Version:\s*/, '')
        .trim(),
  },
  {
    // T-016. `psql (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2)` -> `18`; the pin
    // is a major version, which is what PGDG's package name takes.
    tool: 'psql',
    pinKey: 'postgresql',
    argv: ['psql', '--version'],
    extract: (o) => /\b(\d+)\.\d+/.exec(first(o))?.[1] ?? first(o).trim(),
    absentFrom: {
      variant: 'toolbox-playwright',
      why: 'the Playwright variant is built on Ubuntu noble and carries no libpq; it exercises the app, not the database (T-016)',
    },
  },
];

// ---------------------------------------------------------------------------
// Pins that are asserted structurally rather than by running something.
//
// A pin listed here still counts as covered by section 1a below; a pin that is
// neither probed nor listed here is a FAILURE. That rule is the point: the
// probe table is a SECOND enumeration of .tool-versions, and a second
// enumeration that nothing reconciles is exactly the defect OD-1 was
// (scripts/dev's four-tool pin loop) and QA-F6 was (a pin with no Dockerfile
// ARG, silently dropped). One list is the source of truth and everything else
// is checked against it.
// ---------------------------------------------------------------------------
const STRUCTURALLY_ASSERTED: ReadonlyMap<string, string> = new Map([
  [
    'playwright',
    'consumed as the base image tag mcr.microsoft.com/playwright:v<pin>-noble. ' +
      'A wrong value cannot produce a working image at all — the pull fails and the ' +
      'build stops — which is a stronger assertion than any version probe run afterwards.',
  ],
]);

for (const p of PROBES) {
  const want = pin(p.pinKey);
  const [cmd, ...args] = p.argv;
  if (cmd === undefined) continue;
  if (want === undefined) {
    failures.push(`.tool-versions has no pin for '${p.pinKey}'`);
    continue;
  }
  if (p.absentFrom !== undefined && p.absentFrom.variant === VARIANT) {
    // Say so on stdout rather than passing silently (T-001 contract, rule 2).
    console.log(`  -- ${p.tool.padEnd(10)} absent from the ${VARIANT} variant by design`);
    console.log(`     ${p.absentFrom.why}`);
    continue;
  }
  const r = capture(cmd, args);
  if (r.spawnFailed || r.code !== 0) {
    failures.push(
      `${p.tool}: '${p.argv.join(' ')}' exited ${String(r.code)} (${r.stderr.trim().slice(0, 120)}). ` +
        'If it is missing from the image, run `scripts/dev --build`.',
    );
    console.log(`  X  ${p.tool.padEnd(10)} could not run`);
    continue;
  }
  const got = p.extract(r.stdout);
  if (got === want) {
    console.log(`  ok ${p.tool.padEnd(10)} ${got}`);
  } else {
    failures.push(`${p.tool}: reports '${got}', .tool-versions pins '${want}'`);
    console.log(`  X  ${p.tool.padEnd(10)} ${got} != pinned ${want}`);
  }
}

// ---------------------------------------------------------------------------
// 1a. COVERAGE — every pin in .tool-versions is accounted for (QA-F6).
//
// Without this, .tool-versions can grow a line that nothing anywhere asserts,
// and the pin becomes decoration. It is the same shape as OD-1 and QA-F6, one
// level up: a list enumerated in two places with nothing reconciling them.
// ---------------------------------------------------------------------------
console.log(`\n1a. COVERAGE — every .tool-versions pin is probed or structurally asserted`);
console.log(`    (running in the ${VARIANT} variant)\n`);

const probedKeys = new Set(PROBES.map((p) => p.pinKey));
for (const [key] of pins) {
  if (probedKeys.has(key)) {
    console.log(`  ok ${key.padEnd(12)} probed`);
  } else if (STRUCTURALLY_ASSERTED.has(key)) {
    console.log(`  ok ${key.padEnd(12)} structurally asserted`);
    console.log(`     ${STRUCTURALLY_ASSERTED.get(key) ?? ''}`);
  } else {
    failures.push(
      `.tool-versions pins '${key}' but nothing asserts it: no probe in scripts/gates/toolbox.ts ` +
        'and no entry in STRUCTURALLY_ASSERTED. A pin nothing checks is decoration — add a probe, ' +
        'or record why one is not the right check.',
    );
    console.log(`  X  ${key.padEnd(12)} NOTHING ASSERTS THIS PIN`);
  }
}

// ---------------------------------------------------------------------------
// 2. Determinism — exit 0 twice AND byte-identical output. Both, or neither.
// ---------------------------------------------------------------------------
console.log('\n2. DETERMINISM — same command twice: exit 0 both times AND identical bytes\n');

for (const p of PROBES) {
  const [cmd, ...args] = p.argv;
  if (cmd === undefined) continue;
  if (p.absentFrom !== undefined && p.absentFrom.variant === VARIANT) continue;
  const a = capture(cmd, args);
  const b = capture(cmd, args);
  const label = p.argv.join(' ');

  if (a.code !== 0 || b.code !== 0) {
    failures.push(
      `determinism '${label}': exit codes ${String(a.code)}/${String(b.code)}, expected 0/0. ` +
        'Two identical FAILURES are byte-identical too — that is why this asserts the status (PROTOCOL §5.1).',
    );
    console.log(
      `  X  ${label.padEnd(22)} exit ${String(a.code)}/${String(b.code)} — not a pass, whatever the bytes say`,
    );
    continue;
  }
  const same = a.stdout === b.stdout && a.stderr === b.stderr;
  if (!same) {
    failures.push(`determinism '${label}': exit 0 both runs but the output differs between runs`);
    console.log(`  X  ${label.padEnd(22)} exit 0/0, bytes DIFFER`);
    continue;
  }
  console.log(
    `  ok ${label.padEnd(22)} exit 0/0, ${String(Buffer.byteLength(a.stdout))} identical bytes`,
  );
}

// ---------------------------------------------------------------------------
// 3. The environment the determinism depends on.
// ---------------------------------------------------------------------------
console.log('\n3. ENVIRONMENT — the settings the properties above rest on\n');

const REQUIRED_ENV: ReadonlyMap<string, string> = new Map([
  ['CHECKPOINT_DISABLE', '1'],
  ['CI', '1'],
  ['TZ', 'UTC'],
  ['LANG', 'C.UTF-8'],
]);

for (const [key, want] of REQUIRED_ENV) {
  const got = process.env[key];
  if (got === want) {
    console.log(`  ok ${key.padEnd(20)} = ${want}`);
  } else {
    const why =
      key === 'CHECKPOINT_DISABLE'
        ? ' Without it `terraform version` phones home and appends an upgrade notice, and the determinism check above stops meaning anything.'
        : '';
    failures.push(
      `${key} is ${got === undefined ? 'UNSET' : `'${got}'`}, expected '${want}'.${why}`,
    );
    console.log(
      `  X  ${key.padEnd(20)} = ${got === undefined ? '(unset)' : got}  — expected ${want}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. File ownership — the toolbox writes as the invoking host user, not root.
// ---------------------------------------------------------------------------
console.log('\n4. OWNERSHIP — a file the toolbox writes belongs to the invoking user\n');

const reference = path.join(REPO_ROOT, '.tool-versions');
const refStat = fs.statSync(reference);
const probe = path.join(os.tmpdir(), `kinvara-gate-toolbox-${String(process.pid)}.probe`);
const inRepoProbe = path.join(REPO_ROOT, `.gate-toolbox-ownership-probe-${String(process.pid)}`);

try {
  fs.writeFileSync(probe, 'ownership probe\n');
  fs.writeFileSync(inRepoProbe, 'ownership probe\n');
  const s = fs.statSync(inRepoProbe);
  console.log(
    `  .tool-versions (written on the host) uid:gid = ${String(refStat.uid)}:${String(refStat.gid)}`,
  );
  console.log(`  probe file (written in the toolbox) uid:gid = ${String(s.uid)}:${String(s.gid)}`);
  if (s.uid === 0) {
    failures.push(
      'the toolbox wrote a root-owned file into the bind mount (--user is not being passed)',
    );
  } else if (s.uid !== refStat.uid || s.gid !== refStat.gid) {
    failures.push(
      `toolbox-written file is ${String(s.uid)}:${String(s.gid)} but host files are ` +
        `${String(refStat.uid)}:${String(refStat.gid)} — scripts/dev is not running as the invoking uid/gid`,
    );
  } else {
    console.log('  ok same uid:gid — nothing lands root-owned');
  }
} finally {
  fs.rmSync(probe, { force: true });
  fs.rmSync(inRepoProbe, { force: true });
}

// ---------------------------------------------------------------------------
// 5. The three obligations T-000's published contract puts on package authors.
// ---------------------------------------------------------------------------
console.log('\n5. CONTRACT — the obligations T-000 carried to this repository\n');

const pnpmPin = pin('pnpm');
const rootPkgPath = path.join(REPO_ROOT, 'package.json');
const rootPkg: unknown = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
const pkgManager =
  typeof rootPkg === 'object' && rootPkg !== null && 'packageManager' in rootPkg
    ? (rootPkg as { packageManager: unknown }).packageManager
    : undefined;
const wantPkgManager = `pnpm@${String(pnpmPin)}`;
if (pkgManager === wantPkgManager) {
  console.log(`  ok package.json packageManager = ${wantPkgManager}`);
} else {
  failures.push(
    `root package.json "packageManager" is ${JSON.stringify(pkgManager)}, must be exactly "${wantPkgManager}". ` +
      'Corepack is pinned and has no egress under `svc run`, so a mismatch fails there rather than here.',
  );
}

if (fs.existsSync(path.join(REPO_ROOT, '.npmrc'))) {
  failures.push(
    '.npmrc exists. pnpm 11 silently ignores pnpm settings there (measured, T-000 §9): ' +
      'settings belong in pnpm-workspace.yaml.',
  );
} else {
  console.log('  ok no .npmrc — pnpm settings live in pnpm-workspace.yaml');
}

const storePath = capture('pnpm', ['store', 'path']);
if (storePath.code !== 0) {
  failures.push(`'pnpm store path' exited ${String(storePath.code)}`);
} else {
  const store = storePath.stdout.trim();
  if (store.startsWith(REPO_ROOT)) {
    failures.push(
      `the pnpm store is INSIDE the repository (${store}). pnpm_config_store_dir is not taking ` +
        'effect and the store is polluting the bind mount instead of the named volume.',
    );
  } else {
    console.log(`  ok pnpm store outside the repo: ${store}`);
  }
}

const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
if (!/^\.pnpm-store\/?$/m.test(gitignore)) {
  failures.push('.gitignore does not list `.pnpm-store/` — T-000 asked for it as cheap insurance');
} else {
  console.log('  ok .gitignore covers .pnpm-store/');
}

// ---------------------------------------------------------------------------
// 6. ISOLATION — a gate run cannot reach the Docker daemon (T-018 / OD-16).
//
// This is the BEHAVIOURAL half of the OD-16 ruling, and it is deliberately
// UNCONDITIONAL. gate:egress-boundary asserts the same property by READING
// scripts/dev and scripts/svc; a check derived from the same text as the thing
// it checks confirms its own misreading (PROTOCOL §5.1, and the reason QA-F2
// happened). This one observes the container it is actually running in, so it
// is red the moment the socket becomes available by ANY route — a changed
// default, a new flag, an edit to the shared mount helper, or an agent
// exporting DOCKER_HOST.
//
// There is no bypass and there must not be one: an env var saying "the caller
// asked for it" would be set by the same code path that mounts the socket, and
// the check would agree with the defect. So `pnpm gate:toolbox` (and therefore
// `gate:pr`) is run WITHOUT `--docker`. That is also the correct posture on its
// own terms: a gate result should be a fact about the toolchain, not about
// something that could create arbitrary containers while producing it.
// ---------------------------------------------------------------------------
console.log('\n6. ISOLATION — a gate run has no route to the Docker daemon\n');

const SOCKET = '/var/run/docker.sock';
let socketVisible: boolean;
try {
  socketVisible = fs.statSync(SOCKET).isSocket();
} catch {
  socketVisible = false;
}
const dockerHost = process.env['DOCKER_HOST'];

if (socketVisible) {
  failures.push(
    `${SOCKET} is visible to this gate run. The Docker socket belongs to ` +
      `'scripts/dev --docker' and to nothing else (OD-16): it is host-root for whatever ` +
      `the toolbox runs, and a process holding it can create a container on a network ` +
      `with egress, which defeats the property 'svc run' exists to provide. If you are ` +
      `running gates, drop --docker; if the socket arrived without it, that is the defect.`,
  );
} else {
  console.log(`  ok no ${SOCKET}`);
}
if (dockerHost !== undefined && dockerHost !== '') {
  failures.push(
    `DOCKER_HOST is set to '${dockerHost}' during a gate run. Same property as above, by ` +
      `a different route: a TCP daemon endpoint needs no socket mount at all.`,
  );
} else {
  console.log('  ok DOCKER_HOST unset');
}

finish('gate:toolbox', failures);
