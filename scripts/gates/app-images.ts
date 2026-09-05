/**
 * gate:app-images — the application images stay honest (T-018).
 *
 * `docker/app.Dockerfile` + `docker/compose.verify.yml` are what make every
 * later ticket's evidence real: DOCKER.md §5 says a service-dependent ticket
 * is only done when the app ran AS ITS IMAGE, because signal handling, DNS,
 * paths, env resolution and non-root permissions are invisible outside it.
 *
 * Five properties, each stated so that the check IS the claim.
 *
 * 1. THE NODE VERSION IS DERIVED, NOT WRITTEN DOWN. `ARG NODE_VERSION` has no
 *    default, compose.verify.yml passes `${KINVARA_NODE_VERSION:?...}`, and
 *    `scripts/svc` sets that from `.tool-versions`. The anchor that makes this
 *    more than a spelling check is the LAST clause: the literal pin value must
 *    not appear in either file. A second copy of "24.20.0" is OD-1's shape —
 *    one fact in two places, and the copy goes stale silently.
 *
 * 2. EVERY SERVICE compose.yml SAYS T-018 BUILDS IS ACTUALLY BUILT HERE. The
 *    set comes from the `io.kinvara.built-by` label in compose.yml, not from a
 *    list in this file, so adding a sixth app to compose.yml with that label
 *    turns this gate red until the overlay builds it. `scripts/svc`'s
 *    missing-image message reads the same label (QA-F8) — one source.
 *
 * 3. NO `ports:` IN THE OVERLAY. A ticket-scoped project publishes none and
 *    cannot: Docker drops publishing on an `internal: true` network silently
 *    (OD-4). A `ports:` line there does nothing while reading as though it
 *    works, and starts working the day someone adds a second network.
 *
 * 4. THE OVERLAY CANNOT RAISE A BUDGET. DOCKER.md §3's table is what the
 *    orchestrator sums before dispatching a wave; an overlay that quietly
 *    doubles a mem_limit breaks arithmetic that keeps a 4-core box alive.
 *
 * 5. A PLACEHOLDER CANNOT OUTLIVE REAL SOURCE. The image entrypoint runs the
 *    app's own `start` script if it declares one and a reference placeholder
 *    otherwise. That conditional is derived from package.json, which is right,
 *    but on its own "still on the placeholder" is the kind of thing that stays
 *    true for six months. So: an app with a `src/` directory MUST declare
 *    `start`. The trigger is the filesystem — something outside both the
 *    Dockerfile and the entrypoint that reads it — which is the point.
 *
 * What this gate does NOT do: build anything, or run a container. It has no
 * Docker socket by design (OD-16), and a gate that needed a daemon could not
 * be part of `gate:pr`. That the images BUILD and pass their healthchecks is
 * `svc up --verify --build`, evidenced per ticket.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, finish, toolVersions } from './lib/run.ts';

const BASE_FILE = 'docker/compose.yml';
const VERIFY_FILE = 'docker/compose.verify.yml';
const DOCKERFILE = 'docker/app.Dockerfile';
const BUILT_BY = 'T-018';

const failures: string[] = [];
const read = (rel: string): string | null => {
  const p = path.join(REPO_ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const servicesOf = (rel: string): Record<string, Record<string, unknown>> | null => {
  const text = read(rel);
  if (text === null) {
    failures.push(`${rel} does not exist`);
    return null;
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    failures.push(`${rel} is not parseable YAML: ${String(err)}`);
    return null;
  }
  if (!isRecord(doc) || !isRecord(doc['services'])) {
    failures.push(`${rel}: no services: mapping — refusing to report a pass on it`);
    return null;
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(doc['services'])) if (isRecord(v)) out[k] = v;
  return out;
};

const base = servicesOf(BASE_FILE);
const verify = servicesOf(VERIFY_FILE);
const dockerfile = read(DOCKERFILE);
if (dockerfile === null) failures.push(`${DOCKERFILE} does not exist`);

const pins = toolVersions();
const nodePin = pins.get('nodejs');
const pnpmPin = pins.get('pnpm');
if (nodePin === undefined || pnpmPin === undefined) {
  failures.push('.tool-versions does not pin both nodejs and pnpm');
}

// ---------------------------------------------------------------------------
// 1. The Node/pnpm versions are derived from .tool-versions.
// ---------------------------------------------------------------------------
if (dockerfile !== null) {
  for (const argName of ['NODE_VERSION', 'PNPM_VERSION']) {
    const decl = new RegExp(`^ARG ${argName}\\s*$`, 'm');
    const withDefault = new RegExp(`^ARG ${argName}=`, 'm');
    if (withDefault.test(dockerfile)) {
      failures.push(
        `${DOCKERFILE}: 'ARG ${argName}' has a DEFAULT. A default makes a build that ` +
          `forgets to pass the pin succeed against some other version, silently. It must ` +
          `have none, so the build fails at the FROM line instead.`,
      );
    } else if (!decl.test(dockerfile)) {
      failures.push(`${DOCKERFILE}: no bare 'ARG ${argName}' declaration`);
    }
  }
}

const verifyText = read(VERIFY_FILE);
if (verifyText !== null) {
  for (const [argName, envName] of [
    ['NODE_VERSION', 'KINVARA_NODE_VERSION'],
    ['PNPM_VERSION', 'KINVARA_PNPM_VERSION'],
  ] as const) {
    if (!verifyText.includes(`${argName}: \${${envName}:?`)) {
      failures.push(
        `${VERIFY_FILE}: ${argName} is not passed as \${${envName}:?...}. The ':?' form is ` +
          `what makes a bare 'docker compose -f ...' run fail loudly instead of building ` +
          `against an unset variable.`,
      );
    }
  }
}

// The anchor. Everything above is spelling; this is the property.
if (nodePin !== undefined) {
  for (const rel of [DOCKERFILE, VERIFY_FILE]) {
    const text = read(rel);
    if (text !== null && text.split('\n').some((l) => !l.trimStart().startsWith('#') && l.includes(nodePin))) {
      failures.push(
        `${rel} contains the literal Node pin '${nodePin}' in live (non-comment) text. ` +
          `The version must come from .tool-versions through scripts/svc — a second copy ` +
          `is one fact in two places and it goes stale silently (OD-1).`,
      );
    }
  }
}

const svcScript = read('scripts/svc');
if (svcScript === null) {
  failures.push('scripts/svc is missing');
} else if (
  !/KINVARA_NODE_VERSION="\$\(toolbox_require_pin nodejs\)"/.test(svcScript) ||
  !/KINVARA_PNPM_VERSION="\$\(toolbox_require_pin pnpm\)"/.test(svcScript)
) {
  failures.push(
    `scripts/svc no longer derives KINVARA_NODE_VERSION / KINVARA_PNPM_VERSION from ` +
      `.tool-versions with toolbox_require_pin. Without it the ':?' in ${VERIFY_FILE} ` +
      `makes every --verify build fail, and the obvious repair is to hard-code a version.`,
  );
}

// ---------------------------------------------------------------------------
// 2. Every service compose.yml says T-018 builds is built by the overlay.
// ---------------------------------------------------------------------------
const declaredByLabel: string[] = [];
if (base !== null) {
  for (const [name, svc] of Object.entries(base)) {
    const labels = svc['labels'];
    if (isRecord(labels) && labels['io.kinvara.built-by'] === BUILT_BY) declaredByLabel.push(name);
  }
}
if (declaredByLabel.length === 0) {
  failures.push(
    `${BASE_FILE} labels no service 'io.kinvara.built-by: ${BUILT_BY}' — this gate would ` +
      `then assert nothing about the images it exists to check.`,
  );
}
if (verify !== null) {
  for (const name of declaredByLabel) {
    const svc = verify[name];
    if (svc === undefined || !isRecord(svc['build'])) {
      failures.push(
        `${BASE_FILE} says ${BUILT_BY} builds '${name}', but ${VERIFY_FILE} declares no ` +
          `build: for it. 'svc up <t> --verify' would then try to pull kinvara/${name}, ` +
          `which does not exist in any registry and never will.`,
      );
      continue;
    }
    const build = svc['build'];
    const df = String(build['dockerfile'] ?? '');
    if (df === '' || !fs.existsSync(path.join(REPO_ROOT, df))) {
      failures.push(`${VERIFY_FILE}: '${name}' names dockerfile '${df}', which does not exist`);
    }
    const args = build['args'];
    if (!isRecord(args) || typeof args['APP'] !== 'string' || args['APP'] === '') {
      failures.push(`${VERIFY_FILE}: '${name}' passes no APP build arg — app.Dockerfile requires it`);
    }
    if (svc['pull_policy'] !== 'build') {
      failures.push(
        `${VERIFY_FILE}: '${name}' does not set 'pull_policy: build'. Without it compose ` +
          `may try the registry first for an image only this repository can produce.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3 + 4. No host ports, and no budget raised (DOCKER.md §3, OD-4).
// ---------------------------------------------------------------------------
const memToMb = (v: unknown): number | null => {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?$/i.exec(String(v).trim());
  if (m === null) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? 'b').toLowerCase()) {
    case 'g': return n * 1024;
    case 'm': return n;
    case 'k': return n / 1024;
    default: return n / (1024 * 1024);
  }
};

if (verify !== null && base !== null) {
  for (const [name, svc] of Object.entries(verify)) {
    if ('ports' in svc) {
      failures.push(
        `${VERIFY_FILE}: '${name}' declares ports:. A ticket-scoped project publishes no ` +
          `host port and cannot — Docker drops publishing on an internal: true network ` +
          `SILENTLY (OD-4). The line would do nothing while reading as though it worked.`,
      );
    }
    const baseSvc = base[name];
    if (baseSvc === undefined) continue; // an addition; gate:egress-boundary owns that case
    for (const key of ['mem_limit', 'cpus'] as const) {
      if (!(key in svc)) continue;
      const overlay = key === 'mem_limit' ? memToMb(svc[key]) : Number(svc[key]);
      const original = key === 'mem_limit' ? memToMb(baseSvc[key]) : Number(baseSvc[key]);
      if (overlay === null || original === null || Number.isNaN(overlay) || Number.isNaN(original)) {
        failures.push(`${VERIFY_FILE}: '${name}' ${key} is not comparable with ${BASE_FILE}'s`);
      } else if (overlay > original) {
        failures.push(
          `${VERIFY_FILE}: '${name}' raises ${key} from ${String(original)} to ` +
            `${String(overlay)}. DOCKER.md §3's budget table is what the orchestrator sums ` +
            `before dispatching a wave; an overlay may not escape it.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. A placeholder cannot outlive real source.
// ---------------------------------------------------------------------------
let appsChecked = 0;
let withSource = 0;
for (const name of declaredByLabel) {
  const appDir = path.join(REPO_ROOT, 'apps', name);
  const pkgPath = path.join(appDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    failures.push(`apps/${name}/package.json does not exist, but ${BASE_FILE} builds an image from it`);
    continue;
  }
  appsChecked += 1;
  const srcDir = path.join(appDir, 'src');
  const hasSource = fs.existsSync(srcDir) && fs.readdirSync(srcDir).length > 0;
  if (!hasSource) continue;
  withSource += 1;
  let scripts: unknown;
  try {
    scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8') as string) as Record<string, unknown>)['scripts'];
  } catch (err) {
    failures.push(`apps/${name}/package.json is not parseable JSON: ${String(err)}`);
    continue;
  }
  const start = isRecord(scripts) ? scripts['start'] : undefined;
  if (typeof start !== 'string' || start.trim() === '') {
    failures.push(
      `apps/${name} has source under src/ but declares no 'start' script. The image ` +
        `entrypoint picks REAL mode from that script and falls back to the placeholder ` +
        `otherwise — so without it this app has code and ships a placeholder, and every ` +
        `piece of evidence produced against its container is about the placeholder.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. The image contract itself.
// ---------------------------------------------------------------------------
if (dockerfile !== null) {
  if (!/^ENTRYPOINT \[/m.test(dockerfile)) {
    failures.push(
      `${DOCKERFILE}: ENTRYPOINT is not in exec form. Shell form puts /bin/sh at PID 1, ` +
        `and sh does not forward SIGTERM to its child: 'docker stop' would wait out the ` +
        `whole stop_grace_period and then SIGKILL the app mid-request.`,
    );
  }
  if (!/^HEALTHCHECK /m.test(dockerfile)) {
    failures.push(
      `${DOCKERFILE}: no HEALTHCHECK. It belongs in the image, not only in compose, so it ` +
        `travels with what ships (T-003's ECS task definitions read it from here).`,
    );
  }
  const user = /^USER (\S+)/m.exec(dockerfile);
  if (user === null) {
    failures.push(`${DOCKERFILE}: no USER instruction — the image would run as root`);
  } else {
    const uid = user[1] ?? '';
    if (/^(0|root)(:|$)/.test(uid)) failures.push(`${DOCKERFILE}: USER is root (${uid})`);
    if (/^(1000|node)(:|$)/.test(uid)) {
      failures.push(
        `${DOCKERFILE}: USER is ${uid}. uid 1000 is the toolbox's uid and this host's repo ` +
          `owner, so "runs as a non-root user" and "happens to match the bind mount" become ` +
          `indistinguishable and a permission defect surfaces first in ECS.`,
      );
    }
  }
}

console.log(`  node pin (from .tool-versions)  ${nodePin ?? '(unset)'}  — derived, not written down`);
console.log(`  services labelled built-by ${BUILT_BY}  ${String(declaredByLabel.length)}: ${declaredByLabel.join(' ')}`);
console.log(`  apps checked                    ${String(appsChecked)}`);
console.log(
  `  apps with src/                  ${String(withSource)}` +
    (withSource === 0 ? '  (all five still T-001 placeholders — the images run the reference entrypoint)' : ''),
);

finish('gate:app-images', failures);
