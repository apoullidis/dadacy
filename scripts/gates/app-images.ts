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
/**
 * The Dockerfile the pin/derivation checks in §1 read. It is NOT the set §6
 * runs over — that set is `dockerfilesInUse`, derived in §2a from every
 * OVERLAY service declaring a `build.dockerfile`.
 *
 * Two rounds of QA on this one line of design, and both are worth keeping:
 *   round 1 — §6 was pinned to this constant. Repointing `web` at a second
 *             Dockerfile with USER root, a shell-form ENTRYPOINT and no
 *             HEALTHCHECK left the gate GREEN — and T-018's own contract §6
 *             invites exactly that split for the Next.js apps.
 *   round 2 — §6 was then pinned to the `built-by: T-018` label set, which is
 *             the same defect in a different hat. An UNLABELLED overlay
 *             service with a build.dockerfile was checked by nothing, and the
 *             gate still printed `dockerfiles checked 1` as though it had
 *             enumerated.
 * A check that disarms itself when a documented next step is taken is worse
 * than no check, because its green is read as coverage.
 */
const PRIMARY_DOCKERFILE = 'docker/app.Dockerfile';
const CHAOS_FILE = 'docker/compose.chaos.yml';
/**
 * Every overlay. §6's set of Dockerfiles is derived from ALL of these — see
 * `dockerfilesInUse` for why it is not derived from the `built-by` label.
 */
const OVERLAY_FILES = [VERIFY_FILE, CHAOS_FILE];
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
const dockerfile = read(PRIMARY_DOCKERFILE);
if (dockerfile === null) failures.push(`${PRIMARY_DOCKERFILE} does not exist`);

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
        `${PRIMARY_DOCKERFILE}: 'ARG ${argName}' has a DEFAULT. A default makes a build that ` +
          `forgets to pass the pin succeed against some other version, silently. It must ` +
          `have none, so the build fails at the FROM line instead.`,
      );
    } else if (!decl.test(dockerfile)) {
      failures.push(`${PRIMARY_DOCKERFILE}: no bare 'ARG ${argName}' declaration`);
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
  for (const rel of [PRIMARY_DOCKERFILE, VERIFY_FILE]) {
    const text = read(rel);
    if (
      text !== null &&
      text.split('\n').some((l) => !l.trimStart().startsWith('#') && l.includes(nodePin))
    ) {
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

/**
 * dockerfile path -> `<file>:<service>[:<target>]` for every OVERLAY service
 * that declares a `build.dockerfile`, whatever its labels say.
 *
 * DERIVED FROM THE OVERLAYS, NOT FROM `declaredByLabel`, and that is QA's
 * finding one level up from the previous one. The first version of §6 pinned
 * its checks to a constant path; the second pinned them to the label set,
 * which is the same defect wearing a different hat. QA added an overlay
 * service with a `build.dockerfile`, `USER root`, a shell-form ENTRYPOINT, no
 * HEALTHCHECK and no guard, and left it unlabelled: GATE PASS, with the gate
 * printing `dockerfiles checked 1` as though it had enumerated something.
 *
 * `compose.chaos.yml` is in the set for a concrete reason: T-018's own
 * published contract hands that file to T-126, and a built sidecar — a proxy
 * that throttles the network, say — is exactly what lands there.
 *
 * compose.yml's own builds (postgres, fake-telephony) are NOT in the set. That
 * is not an omission: they are T-017's images, they are not built from the
 * pnpm workspace, and the application-image contract below — a non-root uid of
 * this shape, a Node healthcheck, the devDependency guard — does not describe
 * them. The boundary is "an image an OVERLAY builds", which is the boundary
 * this ticket and T-126 own.
 */
const dockerfilesInUse = new Map<string, string[]>();
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
      failures.push(
        `${VERIFY_FILE}: '${name}' passes no APP build arg — app.Dockerfile requires it`,
      );
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
// 2a. The Dockerfiles §6 checks: EVERY overlay service that declares one.
// ---------------------------------------------------------------------------
for (const rel of OVERLAY_FILES) {
  const svcs = servicesOf(rel);
  if (svcs === null) continue; // already reported
  for (const [name, svc] of Object.entries(svcs)) {
    const build = svc['build'];
    if (!isRecord(build)) continue;
    const df = String(build['dockerfile'] ?? '');
    if (df === '') {
      failures.push(
        `${rel}: '${name}' declares build: with no dockerfile:. This gate cannot then ` +
          `check the image contract of something this repository builds, and a build with ` +
          `no dockerfile: silently means './Dockerfile' relative to the context.`,
      );
      continue;
    }
    if (!fs.existsSync(path.join(REPO_ROOT, df))) {
      failures.push(`${rel}: '${name}' names dockerfile '${df}', which does not exist`);
      continue;
    }
    const target = typeof build['target'] === 'string' ? build['target'] : '';
    const label = `${rel.replace('docker/', '')}:${name}${target === '' ? '' : `→${target}`}`;
    dockerfilesInUse.set(df, [...(dockerfilesInUse.get(df) ?? []), label]);
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
    case 'g':
      return n * 1024;
    case 'm':
      return n;
    case 'k':
      return n / 1024;
    default:
      return n / (1024 * 1024);
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
      if (
        overlay === null ||
        original === null ||
        Number.isNaN(overlay) ||
        Number.isNaN(original)
      ) {
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
    failures.push(
      `apps/${name}/package.json does not exist, but ${BASE_FILE} builds an image from it`,
    );
    continue;
  }
  appsChecked += 1;
  const srcDir = path.join(appDir, 'src');
  const hasSource = fs.existsSync(srcDir) && fs.readdirSync(srcDir).length > 0;
  if (!hasSource) continue;
  withSource += 1;
  let scripts: unknown;
  try {
    scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8') as string) as Record<string, unknown>)[
      'scripts'
    ];
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

/**
 * The instruction lines of one stage of a Dockerfile.
 *
 * WHY THE CHECK BELOW HAS TO KNOW ABOUT STAGES. The previous version looked
 * for a line matching /^RUN.*assert-no-dev-deps/ anywhere in the file. QA
 * showed two ways past that, and only the first is adversarial:
 *   - `RUN echo skipping assert-no-dev-deps.mjs` — a mention, not a run;
 *   - moving the real RUN into a stage the target does not depend on. That is
 *     an ORDINARY REFACTOR, not sabotage, and it left the gate green while the
 *     guard never executed. Present-but-unreachable is the exact failure mode
 *     the guard exists to prevent.
 *
 * So the check is: the guard must run IN THE TARGET STAGE — the one compose
 * names in `build.target`, or the last stage if it names none — and no COPY or
 * ADD may follow it there. Anything copied in after it is outside what it saw,
 * and `COPY --from=deps ./node_modules` is precisely how QA put 23.6 MB of
 * typescript back into the image with an earlier version of the guard green.
 */
interface Stage {
  readonly name: string;
  readonly lines: readonly string[];
}

/** Strip a Dockerfile comment line and any trailing shell comment. */
const dfCode = (line: string): string => (line.split('#')[0] ?? '').trim();

/**
 * Does this instruction EXECUTE the devDependency guard?
 *
 * "Contains the filename" is not the question, and asking it that way was
 * wrong twice. `text.includes(...)` was satisfied by the COPY line;
 * `/^RUN.*assert-no-dev-deps\.mjs/` is satisfied by
 * `RUN echo skipping assert-no-dev-deps.mjs`, which QA wrote and which
 * passed. So: split the RUN's body on shell operators and require some
 * command whose FIRST TOKEN is `node` and which names the script. `echo …`
 * and `echo node …` both fail that; `true && node …assert-no-dev-deps.mjs`
 * passes it, correctly, because it runs.
 *
 * WHAT THIS CANNOT DO. Deciding whether an arbitrary shell line executes a
 * program is not a thing a regex settles, and this does not claim to: a
 * `RUN node -e '0' …assert-no-dev-deps.mjs` would satisfy it. It catches the
 * ways the guard ordinarily stops running — deleted, replaced by a mention,
 * moved into a stage the target does not build, or outrun by a later COPY —
 * and the thing that actually observes the guard running is the build, which
 * prints `assert-no-dev-deps: OK — none of them is present` once per image.
 */
const runsGuard = (line: string): boolean => {
  if (!/^RUN\b/i.test(line)) return false;
  const body = line.replace(/^RUN\s+/i, '').replace(/^--mount=\S+\s+/, '');
  return body
    .split(/&&|\|\||;|\|/)
    .map((seg) => seg.trim())
    .some((seg) => /^node\b/.test(seg) && /(^|[\s/])assert-no-dev-deps\.mjs(\s|$)/.test(seg));
};

/** Split a Dockerfile into stages, joining continuation lines. */
function stagesOf(text: string): Stage[] {
  const joined: string[] = [];
  let acc = '';
  for (const raw of text.split('\n')) {
    const code = dfCode(raw);
    if (code === '') continue;
    if (code.endsWith('\\')) {
      acc += `${code.slice(0, -1)} `;
      continue;
    }
    joined.push((acc + code).trim());
    acc = '';
  }
  if (acc.trim() !== '') joined.push(acc.trim());

  const stages: Stage[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of joined) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from !== null) {
      if (current !== null) stages.push(current);
      current = { name: from[2] ?? `#${String(stages.length)}`, lines: [] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (current !== null) stages.push(current);
  return stages;
}

// ---------------------------------------------------------------------------
// 6. The image contract itself — over EVERY Dockerfile a service is actually
//    built from, derived in §2 from `build.dockerfile`, never from a constant.
//    See PRIMARY_DOCKERFILE for what this cost when it was a constant.
// ---------------------------------------------------------------------------
if (dockerfilesInUse.size === 0) {
  failures.push(
    `no service in ${VERIFY_FILE} names a build.dockerfile this gate could read — the ` +
      `image-contract checks below would then assert nothing.`,
  );
}

for (const [rel, users] of [...dockerfilesInUse].sort(([a], [b]) => a.localeCompare(b))) {
  const text = read(rel);
  if (text === null) continue; // already reported by §2
  const who = `${rel} (built as: ${users.join(', ')})`;

  if (!/^ENTRYPOINT \[/m.test(text)) {
    failures.push(
      `${who}: ENTRYPOINT is not in exec form. Shell form puts /bin/sh at PID 1, ` +
        `and sh does not forward SIGTERM to its child: 'docker stop' would wait out the ` +
        `whole stop_grace_period and then SIGKILL the app mid-request.`,
    );
  }
  if (!/^HEALTHCHECK /m.test(text)) {
    failures.push(
      `${who}: no HEALTHCHECK. It belongs in the image, not only in compose, so it ` +
        `travels with what ships (T-003's ECS task definitions read it from here).`,
    );
  }
  const user = /^USER (\S+)/m.exec(text);
  if (user === null) {
    failures.push(`${who}: no USER instruction — the image would run as root`);
  } else {
    const uid = user[1] ?? '';
    if (/^(0|root)(:|$)/.test(uid)) failures.push(`${who}: USER is root (${uid})`);
    if (/^(1000|node)(:|$)/.test(uid)) {
      failures.push(
        `${who}: USER is ${uid}. uid 1000 is the toolbox's uid and this host's repo ` +
          `owner, so "runs as a non-root user" and "happens to match the bind mount" become ` +
          `indistinguishable and a permission defect surfaces first in ECS.`,
      );
    }
  }
  // The devDependency guard is a BUILD-TIME assertion, because that is the only
  // place the property is visible: this gate cannot see inside an image, and the
  // leak is invisible from outside until someone measures a layer — which is
  // exactly how 112.2 MB of devDependencies shipped in T-018's first version.
  // Every Dockerfile in use must run it, so a NEW one cannot omit it quietly.
  // --- the devDependency guard, stage-aware --------------------------------
  //
  // Only for a Dockerfile that installs from the pnpm workspace. That
  // condition is read from the file itself, not from a list of which images
  // are "app" images: a chaos sidecar built from some other base has no
  // node_modules and no devDependencies, and demanding the guard of it would
  // be a rule nobody could satisfy honestly.
  const buildsFromWorkspace = /pnpm-lock\.yaml|pnpm\s+(install|--filter)/.test(text);
  if (buildsFromWorkspace) {
    const stages = stagesOf(text);
    // The target stage: what compose names, else the last stage in the file.
    const targets = new Set(
      users.map((u) => (u.includes('→') ? (u.split('→')[1] ?? '') : '')).filter((t) => t !== ''),
    );
    if (targets.size === 0 && stages.length > 0) targets.add(stages[stages.length - 1]?.name ?? '');

    for (const target of targets) {
      const stage = stages.find((st) => st.name === target);
      if (stage === undefined) {
        failures.push(
          `${who}: compose builds target '${target}', which is not a stage in this file`,
        );
        continue;
      }
      const guardAt = stage.lines.findIndex(runsGuard);
      if (guardAt === -1) {
        failures.push(
          `${who}: stage '${target}' — the stage that SHIPS — does not run ` +
            `docker/app-runtime/assert-no-dev-deps.mjs. Running it in an earlier stage ` +
            `proves a property of THAT stage: one 'COPY --from=deps' here puts 23.6 MB of ` +
            `typescript into the image with the guard green (measured by QA). It must run ` +
            `in the stage compose actually builds.`,
        );
        continue;
      }
      const after = stage.lines.slice(guardAt + 1).filter((l) => /^(COPY|ADD)\b/i.test(l));
      if (after.length > 0) {
        failures.push(
          `${who}: stage '${target}' copies into the image AFTER the devDependency guard ` +
            `runs, so what it copied was never checked: ${after.join(' | ')}. Move the ` +
            `guard below the last COPY.`,
        );
      }
    }
  }
}

console.log(
  `  node pin (from .tool-versions)  ${nodePin ?? '(unset)'}  — derived, not written down`,
);
console.log(
  `  services labelled built-by ${BUILT_BY}  ${String(declaredByLabel.length)}: ${declaredByLabel.join(' ')}`,
);
console.log(`  dockerfiles checked             ${String(dockerfilesInUse.size)}`);
for (const [df, users] of [...dockerfilesInUse].sort(([a], [b]) => a.localeCompare(b))) {
  // Print WHO, not just how many. `dockerfiles checked 1` was printed by the
  // version that had enumerated the wrong set entirely, and it read as
  // coverage (QA, round 2).
  console.log(`    ${df}  <-  ${users.join(', ')}`);
}
console.log(`  apps checked                    ${String(appsChecked)}`);
console.log(
  `  apps with src/                  ${String(withSource)}` +
    (withSource === 0
      ? '  (all five still T-001 placeholders — the images run the reference entrypoint)'
      : ''),
);

finish('gate:app-images', failures);
