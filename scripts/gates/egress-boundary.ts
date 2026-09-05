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
    // evidence that something other than a service is being read as one.
    if (rel === BASE_FILE && !('image' in svc) && !('build' in svc)) {
      failures.push(
        `${BASE_FILE}: '${name}' has neither image: nor build:. Either it is not a ` +
          `service and this gate is misreading the file, or it is a service compose ` +
          `cannot start. Both are failures.`,
      );
    }

    const nets = networksOf(svc);

    if (nets === undefined) {
      // The OD-12 case, and the one the written rule used to miss.
      if (rel === BASE_FILE) {
        failures.push(
          `${BASE_FILE}: service '${name}' declares no networks:. Compose puts it on ` +
            `the project's DEFAULT bridge, which is NOT internal and HAS EGRESS — ` +
            `measured on kinvara-t-017: such a container completed a TCP connection to ` +
            `1.1.1.1:443 while 'svc up' reported it healthy (OD-12). ` +
            `Every service must name ${INT_NETWORK} explicitly.`,
        );
      }
      continue; // an overlay may legitimately leave networks alone
    }

    if (nets.length === 0 && rel === BASE_FILE) {
      failures.push(
        `${BASE_FILE}: service '${name}' has an EMPTY networks:. Same outcome as ` +
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

    if (rel === BASE_FILE && !nets.includes(INT_NETWORK)) {
      failures.push(`${BASE_FILE}: service '${name}' is not on ${INT_NETWORK}.`);
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
  if (!/refusing to attach/.test(svcScript)) {
    failures.push(
      `scripts/svc no longer contains its refusal assertion for ${BUILD_NETWORK}. ` +
        `That assertion is the runtime half of this gate; do not delete it.`,
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

console.log(`  compose files parsed       ${String(filesParsed)}/${String(COMPOSE_FILES.length)}`);
console.log(`  services checked           ${String(servicesChecked)}`);
console.log(`  parser                     yaml (a real one — see QA-F2)`);
console.log(`  entry points checked       scripts/dev, scripts/svc`);

finish('gate:egress-boundary', failures);
