/**
 * gate:egress-boundary — the static half of DOCKER.md §7.
 *
 * Ticket: T-017 (platform-infrastructure). `T-016` built the runtime halves;
 * this is the check that stops them being quietly undone.
 *
 * THE PROPERTY
 * ------------
 *   scripts/dev      -> kinvara-build (egress)     and NO services
 *   scripts/svc run  -> the ticket's kinvara-int   and NO egress
 *
 * `kinvara-int` is `internal: true`, so no application container and no fake
 * has a route off this host. That is what makes "no live vendor credentials"
 * STRUCTURAL rather than a rule somebody has to remember (PROTOCOL.md §9.9),
 * and it is what keeps a gate command's result honest: a test cannot start
 * passing because it silently reached a real endpoint, because the packet
 * cannot leave.
 *
 * STATE THE RULE AS THE POSITIVE PROPERTY:
 *
 *     Every service in compose.yml is on kinvara-int and on nothing else.
 *
 * "No service is attached to kinvara-build" is a CONSEQUENCE, and on its own
 * it is not enough: a service that declares no `networks:` key at all is put
 * by compose on <project>_default, an ordinary bridge with full egress, with
 * no error and a healthy container (measured — OD-12).
 *
 * WHY A REAL YAML PARSER, AND NOT A REGEX (QA-F2)
 * ----------------------------------------------
 * The first version of this gate hand-rolled a small YAML subset: two indent
 * levels, `^  <name>:` for a service, `^    image:` for the cross-check. It
 * passed every test put to it and it was WRONG, because compose accepts flow
 * mappings:
 *
 *     qa-flow-probe: { image: alpine:3.20, profiles: ['mail'] }
 *
 * That is a real service — `docker compose config --services` lists it, it
 * starts, and with no `networks:` key it lands on <project>_default and
 * reaches the internet. Both regexes missed that single line TOGETHER, so the
 * `services.length === imageKeys` cross-check still balanced and the gate
 * reported PASS. An anti-vacuity check that shares a blind spot with the thing
 * it is checking is not an anti-vacuity check.
 *
 * The lesson is not "that regex had a bug". It is: DO NOT DEFEND A SECURITY
 * PROPERTY WITH A PARSER YOU WROTE BY ACCIDENT. The `yaml` package is a
 * devDependency and this file is now the only place in the repo that reads
 * compose YAML structurally.
 *
 * OVERLAY-ONLY SERVICES — AN ADDITION IS NOT AN OVERRIDE (QA-F5)
 * ---------------------------------------------------------------
 * The first version exempted every service in an overlay from the
 * `networks:` requirement, on the reasoning that an override may legitimately
 * leave networks alone. That reasoning is right for an OVERRIDE and much too
 * wide for an ADDITION. QA measured the hole on `T-017`: a service defined
 * ONLY in `compose.verify.yml`, with no `networks:` key, passed this gate,
 * came up healthy, and completed a TCP connection to 1.1.1.1:443. It could
 * not fire only because both overlays were `services: {}` — and `T-018` is
 * the ticket that populates one.
 *
 * The rule is a NAME-SET DIFFERENCE, derived rather than listed:
 *
 *     a service name present in an overlay or compose.dev.yml but ABSENT
 *     from compose.yml is an ADDITION, and an addition carries every
 *     obligation a base service carries: it must declare `networks:`, that
 *     list must be non-empty, it must include kinvara-int, and it must name
 *     nothing else (bar kinvara-pub in compose.dev.yml alone).
 *
 * A name that IS in compose.yml is an override and keeps the exemption,
 * because compose merges the base definition's networks into it. There is no
 * list of exempt services to extend and none to forget.
 *
 * WHAT THIS GATE STILL CANNOT FOLLOW — each one is a FAILURE, never a pass
 * ----------------------------------------------------------------------
 * A parser removes the syntax blind spots, not the compose-semantics ones.
 * `extends:` pulls a service definition out of another file and could carry a
 * `networks:` key this gate never sees. It is not used in this repo, so rather
 * than half-implement it, encountering it is a hard failure with an
 * instruction to extend the gate first. If you add a compose feature this
 * gate does not model, the gate goes RED and you fix the gate — which is the
 * only direction that is safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, finish } from './lib/run.ts';

const BUILD_NETWORK = 'kinvara-build';
const INT_NETWORK = 'kinvara-int';
/** The one non-internal network, and the one file allowed to name it. */
const PUB_NETWORK = 'kinvara-pub';
const PUB_FILE = 'docker/compose.dev.yml';
const BASE_FILE = 'docker/compose.yml';

const COMPOSE_FILES = [
  BASE_FILE,
  PUB_FILE,
  'docker/compose.verify.yml',
  'docker/compose.chaos.yml',
];

const failures: string[] = [];

const read = (rel: string): string | null => {
  const p = path.join(REPO_ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A service's networks, normalised. Compose accepts three spellings:
 *   networks: [a, b]            (sequence)
 *   networks: {a: {...}, b: {}} (mapping, for aliases/ipv4_address)
 *   networks: a                 (scalar — not legal compose, but parse it
 *                                anyway so a typo is reported, not ignored)
 * `undefined` means the key is absent, which is the OD-12 case and is NOT the
 * same as an empty list.
 */
function networksOf(svc: Record<string, unknown>): string[] | undefined {
  if (!('networks' in svc)) return undefined;
  const n = svc['networks'];
  if (n === null || n === undefined) return [];
  if (Array.isArray(n)) return n.map((x) => String(x));
  if (isRecord(n)) return Object.keys(n);
  return [String(n)];
}

let filesParsed = 0;
let servicesChecked = 0;
/** Service names declared in compose.yml. Anything else in an overlay is an ADDITION. */
let baseNames: Set<string> | null = null;
let additionsChecked = 0;

// compose.yml is read first ON PURPOSE — the overlay rule below is a set
// difference against it. If it is ever not first, or fails to parse, every
// overlay service becomes an "addition" and the gate goes red rather than
// silently exempting them. That direction is the safe one.
if (COMPOSE_FILES[0] !== BASE_FILE) {
  failures.push(
    `this gate's file list must start with ${BASE_FILE}: the overlay rule is a set ` +
      `difference against its service names and cannot be computed before it is read`,
  );
}

for (const rel of COMPOSE_FILES) {
  const text = read(rel);
  if (text === null) {
    failures.push(`${rel} does not exist — this gate's file list is stale`);
    continue;
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    failures.push(`${rel} is not parseable YAML: ${String(err)}`);
    continue;
  }
  if (!isRecord(doc)) {
    failures.push(`${rel} did not parse to a mapping — refusing to report a pass on it`);
    continue;
  }
  filesParsed += 1;

  // -------------------------------------------------------------------------
  // 1. `kinvara-build` appears NOWHERE live in the file.
  //
  //    Over the PARSED document, not the raw text, so comments are excluded
  //    exactly rather than by stripping everything after a '#'. It covers what
  //    the structural walk below does not visit at all: the top-level
  //    `networks:` block, `x-` extension fields, anchors, and any key this
  //    gate has never heard of.
  // -------------------------------------------------------------------------
  if (JSON.stringify(doc).includes(BUILD_NETWORK)) {
    failures.push(
      `${rel} names '${BUILD_NETWORK}' in its live YAML (not in a comment). ` +
        `No service may EVER be attached to the egress network, and this file must ` +
        `not even declare it (DOCKER.md §7a).`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Every service is on kinvara-int and on nothing else.
  // -------------------------------------------------------------------------
  const services = doc['services'];
  if (services === undefined) {
    if (rel === BASE_FILE) {
      failures.push(`${BASE_FILE} has no services: — this gate would then assert nothing`);
    }
    continue;
  }
  if (!isRecord(services)) {
    failures.push(`${rel}: services: is not a mapping — refusing to report a pass on it`);
    continue;
  }

  const names = Object.keys(services);
  if (rel === BASE_FILE) baseNames = new Set(names);
  if (rel === BASE_FILE && names.length === 0) {
    failures.push(`${BASE_FILE} declares zero services — this gate would then assert nothing`);
  }

  for (const name of names) {
    const svc = services[name];
    if (!isRecord(svc)) {
      failures.push(`${rel}: service '${name}' is not a mapping — cannot be checked`);
      continue;
    }
    servicesChecked += 1;

    // An ADDITION carries every obligation a base service carries (QA-F5).
    // Fail closed: if compose.yml did not parse we do not know what is an
    // override, so nothing is exempt.
    const isAddition = rel !== BASE_FILE && (baseNames === null || !baseNames.has(name));
    if (isAddition) additionsChecked += 1;
    const mustDeclareNetworks = rel === BASE_FILE || isAddition;

    // A compose feature this gate does not model must FAIL, never pass.
    if ('extends' in svc) {
      failures.push(
        `${rel}: service '${name}' uses 'extends', which this gate cannot follow — ` +
          `the inherited definition may carry a networks: key this gate never sees. ` +
          `Teach the gate to resolve 'extends' before using it here.`,
      );
    }

    // Anti-vacuity that does NOT share a blind spot with the parse: compose
    // requires image or build on every service, so a "service" with neither is
    // evidence that something other than a service is being read as one. It
    // applies to an ADDITION for the same reason it applies to a base service
    // — an override is exempt because the base definition supplies them.
    if (mustDeclareNetworks && !('image' in svc) && !('build' in svc)) {
      failures.push(
        `${rel}: '${name}' has neither image: nor build:. Either it is not a ` +
          `service and this gate is misreading the file, or it is a service compose ` +
          `cannot start. Both are failures.`,
      );
    }

    const nets = networksOf(svc);

    if (nets === undefined) {
      // The OD-12 case, and the one the written rule used to miss.
      if (mustDeclareNetworks) {
        failures.push(
          `${rel}: service '${name}' declares no networks:` +
            (isAddition
              ? ` — and it is an ADDITION, not an override: the name does not appear in ` +
                `${BASE_FILE}, so there is no base definition to inherit networks from. `
              : ' ') +
            `Compose puts it on the project's DEFAULT bridge, which is NOT internal and ` +
            `HAS EGRESS — measured on kinvara-t-017: such a container completed a TCP ` +
            `connection to 1.1.1.1:443 while 'svc up' reported it healthy (OD-12, QA-F5). ` +
            `Every service must name ${INT_NETWORK} explicitly.`,
        );
      }
      continue; // an OVERRIDE may legitimately leave networks alone
    }

    if (nets.length === 0 && mustDeclareNetworks) {
      failures.push(
        `${rel}: service '${name}' has an EMPTY networks:. Same outcome as ` +
          `omitting it — compose falls back to the default bridge (OD-12).`,
      );
    }

    for (const n of nets) {
      if (n === INT_NETWORK) continue;
      if (n === PUB_NETWORK && rel === PUB_FILE) continue; // the documented dev-stack exception
      failures.push(
        `${rel}: service '${name}' is attached to '${n}'. Only ${INT_NETWORK} is ` +
          `permitted (and ${PUB_NETWORK}, in ${PUB_FILE} alone, which is exactly why no ` +
          `evidence may ever come from the shared dev stack).`,
      );
    }

    if (mustDeclareNetworks && !nets.includes(INT_NETWORK)) {
      failures.push(`${rel}: service '${name}' is not on ${INT_NETWORK}.`);
    }
  }
}

if (filesParsed === 0) failures.push('no compose file parsed at all — refusing to pass');
if (servicesChecked === 0) failures.push('no service was checked at all — refusing to pass');

// ---------------------------------------------------------------------------
// 3. The two entry points keep their halves of the rule.
//
//     These are shell, not YAML, so they are read as text — and the checks are
//     deliberately about the ARGUMENT to --network, which is the one line in
//     each script that decides the property.
// ---------------------------------------------------------------------------
const codeOf = (line: string): string => {
  const i = line.indexOf('#');
  return (i === -1 ? line : line.slice(0, i)).replace(/\s+$/, '');
};

const svcScript = read('scripts/svc');
if (svcScript === null) {
  failures.push('scripts/svc is missing');
} else {
  const live = svcScript.split('\n').map(codeOf);
  const attaches = live.filter((l) =>
    /--network\s+["']?\$?\{?(BUILD_NETWORK|kinvara-build)/.test(l),
  );
  if (attaches.length > 0) {
    failures.push(
      `scripts/svc attaches ${BUILD_NETWORK}: ${attaches.join(' | ')}. ` +
        `svc run gets services and NO egress (DOCKER.md §7b).`,
    );
  }
  if (!live.some((l) => /refusing to attach/.test(l))) {
    failures.push(
      `scripts/svc no longer NAMES its refusal assertion for ${BUILD_NETWORK} in live ` +
        `(non-comment) code. That assertion is the runtime half of this gate; do not ` +
        `delete it and do not comment it out.`,
    );
  }
}

const devScript = read('scripts/dev');
if (devScript === null) {
  failures.push('scripts/dev is missing');
} else {
  const live = devScript.split('\n').map(codeOf);
  if (!live.some((l) => /--network\s+["']?\$?\{?BUILD_NETWORK/.test(l))) {
    failures.push(
      `scripts/dev no longer attaches ${BUILD_NETWORK}. It is the ONLY container ` +
        `permitted egress; if this changed, pnpm install stopped working and the ` +
        `reason will not be obvious.`,
    );
  }
  if (live.some((l) => /--network/.test(l) && l.includes(INT_NETWORK))) {
    failures.push(
      `scripts/dev attaches ${INT_NETWORK}. It gets egress and NO services; the two ` +
        `must never overlap in one invocation (DOCKER.md §7b).`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. The Docker socket lives in `scripts/dev --docker` and NOWHERE ELSE
//    (OD-16, ruled in T-018).
//
//    This is part of the egress boundary, not a separate concern, and it is
//    here because the boundary is what it defeats. `svc run` has no route off
//    the host BY CONSTRUCTION — kinvara-int is `internal: true`. A Docker
//    socket restores one: POST /containers/create with `NetworkMode: bridge`
//    gives a sibling with full egress, and `Binds: ["/:/host"]` gives the
//    host filesystem as root. Without this check the socket could be moved
//    into `svc run` and every check above would stay green, because none of
//    them models a socket.
//
//    The mount is built by `toolbox_docker_socket_args`, which lives in the
//    SHARED library both entry points source — so checking `scripts/svc` for
//    the literal path is not enough. Three things are asserted:
//      (a) scripts/svc names neither the socket, the helper, nor its output;
//      (b) `toolbox_mount_args` — the mount helper `svc run` DOES call — does
//          not name the socket, so the mount cannot be smuggled in through
//          the shared path;
//      (c) neither entry point can be edited into running the toolbox as
//          root, which is OD-16's cheapest wrong repair.
//
//    (c) is deliberately a SECOND check on a property `gate:toolbox` §4
//    already covers behaviourally, by stat-ing a file the toolbox actually
//    wrote. Two checks, two different derivations: this one reads the script,
//    that one observes the container.
//
//    EVERY CHECK IN THIS FILE — forbid AND require — READS THE COMMENT-STRIPPED
//    TEXT (OD-26 / OD-28, and T-036's enumeration). It did not used to: every
//    *forbid* read `live` and exactly three *require*-checks read the RAW file
//    (`refusing to attach`, `--docker) die`, `toolbox_refuse_root`), so putting
//    a `# ` in front of the line satisfied all three at exit 0 while the
//    behaviour was gone. `gate:pr` was 9/9 through it. The asymmetry is worth
//    naming rather than just fixing: a *forbid* over raw text is merely
//    over-strict (a comment mentioning the forbidden thing reds the gate, which
//    is visible and arguable), while a *require* over raw text is a hole, and
//    it is the hole that is silent. If you add a check here, that is the rule.
//
//    The one deliberate exception is the `toolbox_mount_args` body scan below:
//    it locates the function over the raw text and FAILS CLOSED when it cannot
//    (a commented-out definition is not found, so the gate goes red), and it
//    then forbids the socket over that raw body — over-strict in the safe
//    direction, on purpose.
// ---------------------------------------------------------------------------
const SOCKET_PATH = 'docker.sock';
const SOCKET_HELPER = 'toolbox_docker_socket_args';
const SOCKET_ARGS = 'KINVARA_DOCKER_ARGS';

if (svcScript !== null) {
  const live = svcScript.split('\n').map(codeOf).join('\n');
  for (const token of [SOCKET_PATH, SOCKET_HELPER, SOCKET_ARGS]) {
    if (live.includes(token)) {
      failures.push(
        `scripts/svc names '${token}' in live code. The Docker socket belongs to ` +
          `'scripts/dev --docker' and to nothing else: a process under 'svc run' has no ` +
          `egress by construction, and a socket lets it create a sibling container on a ` +
          `network that HAS egress — so the internal: true guarantee would stop being ` +
          `structural and every other check in this gate would stay green (OD-16).`,
      );
    }
  }
  if (!/--docker\)\s*die/.test(live)) {
    failures.push(
      `scripts/svc no longer NAMES a '--docker) die' arm in live (non-comment) code. ` +
        `Commenting it out is enough: the flag then falls through to "unknown option", ` +
        `which loses the reason, and the reason is the whole ruling (OD-16/OD-28).`,
    );
  }
}

// The gid must be DERIVED. OD-16 measured 987 on this host; a literal there
// is correct exactly once and then silently wrong on the next machine — and
// "silently" because the symptom is EACCES inside a test process, which reads
// as a broken harness and whose cheapest wrong repair is --user 0:0.
{
  const lib = read('scripts/lib/toolbox.sh');
  if (lib !== null) {
    const live = lib.split('\n').map(codeOf).join('\n');
    const literal = /--group-add[^\n]*["']?\d+/.exec(live);
    if (literal !== null) {
      failures.push(
        `scripts/lib/toolbox.sh passes a NUMERIC LITERAL to --group-add: ${literal[0].trim()}. ` +
          `The Docker socket's group id is host-specific (987 here, measured in OD-16) and must ` +
          `be derived with stat. A literal is right once and then gives EACCES on the next ` +
          `machine, which reads as a broken harness and whose cheapest wrong repair is root.`,
      );
    }
    if (!/--group-add "\$\{gid\}"/.test(live) || !/stat -c '%g'/.test(live)) {
      failures.push(
        `scripts/lib/toolbox.sh no longer derives the socket's group id with stat and passes ` +
          `it to --group-add. See OD-16: mount-only gives EACCES, mount + derived --group-add ` +
          `gives OK 200.`,
      );
    }
  }
}

const libShell = read('scripts/lib/toolbox.sh');
if (libShell === null) {
  failures.push('scripts/lib/toolbox.sh is missing');
} else {
  // Fail closed: if the function cannot be located, this check asserts nothing
  // and must say so rather than pass.
  const start = libShell.indexOf('\ntoolbox_mount_args() {');
  if (start === -1) {
    failures.push(
      `scripts/lib/toolbox.sh: cannot locate 'toolbox_mount_args()' — this gate then ` +
        `cannot check that the mount helper both entry points call does not carry the ` +
        `Docker socket. Restore the function or teach the gate its new shape.`,
    );
  } else {
    const end = libShell.indexOf('\n}', start);
    const body = end === -1 ? libShell.slice(start) : libShell.slice(start, end);
    if (body.includes(SOCKET_PATH)) {
      failures.push(
        `scripts/lib/toolbox.sh: 'toolbox_mount_args' names '${SOCKET_PATH}'. That helper ` +
          `is called by BOTH entry points, so the socket would reach 'svc run' through the ` +
          `shared path without scripts/svc mentioning it (OD-16).`,
      );
    }
  }
}

for (const [rel, text] of [
  ['scripts/dev', devScript],
  ['scripts/svc', svcScript],
] as const) {
  if (text === null) continue;
  const live = text.split('\n').map(codeOf);
  if (!live.some((l) => /--user\s+"\$\(id -u\):\$\(id -g\)"/.test(l))) {
    failures.push(
      `${rel} no longer passes --user "$(id -u):$(id -g)". The toolbox runs as the ` +
        `INVOKING user; without it every file it writes into the bind mount is ` +
        `root-owned and T-000's measured ownership property is gone. This is the ` +
        `cheapest wrong repair for OD-16's EACCES and it must not be reachable.`,
    );
  }
  const rootish = live.filter((l) => /--user\s+["']?0[:\s]/.test(l) || /--privileged/.test(l));
  if (rootish.length > 0) {
    failures.push(`${rel} runs the toolbox as root or privileged: ${rootish.join(' | ')}`);
  }
  if (!live.some((l) => /toolbox_refuse_root/.test(l))) {
    failures.push(
      `${rel} no longer NAMES toolbox_refuse_root in live (non-comment) code. That is ` +
        `the runtime half of the same property (OD-16). Note what this does and does ` +
        `not say: a static check can see that the name is there, not that the call ` +
        `runs — the behavioural anchor is gate:toolbox §4, which stats a file the ` +
        `toolbox actually wrote.`,
    );
  }
}

console.log(`  compose files parsed       ${String(filesParsed)}/${String(COMPOSE_FILES.length)}`);
console.log(`  services checked           ${String(servicesChecked)}`);
console.log(
  `  overlay-only additions     ${String(additionsChecked)}` +
    (additionsChecked === 0
      ? '  (none today — every overlay service overrides a compose.yml service)'
      : '  (each held to the full base-service rule)'),
);
console.log(`  parser                     yaml (a real one — see QA-F2)`);
console.log(`  entry points checked       scripts/dev, scripts/svc`);
console.log(`  docker socket              scripts/dev --docker only (OD-16)`);
console.log(
  `  script checks read         live (comment-stripped) text — forbid AND require (OD-28)`,
);

finish('gate:egress-boundary', failures);
