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
 * cannot leave. Measured, in T-017's evidence: ENETUNREACH to a raw IP from
 * under `svc run` and from an app container, against a positive control on
 * `scripts/dev` that connects.
 *
 * WHAT THIS GATE ADDS, AND WHY IT IS STATIC
 * -----------------------------------------
 * The measurement above is a snapshot of one afternoon. The way this property
 * dies is not a kernel change — it is somebody adding two words to a compose
 * file eight months from now because a service "needs to fetch something".
 * So this gate reads the files, not the network, and it runs with no Docker
 * and no services: `scripts/dev pnpm gate:egress-boundary`, and inside
 * `gate:pr`, where every change passes.
 *
 * ANTI-VACUOUS BY CONSTRUCTION
 * ----------------------------
 * A checker that silently parses zero services passes every time — that is
 * the shape of OD-1, of the Trivy zero-package defect, and of OD-7. So the
 * service scan CROSS-CHECKS itself: every compose file must yield exactly as
 * many services as it has `image:` keys, and every service found must declare
 * `networks:`. Reformat the file in a way this parser cannot follow and the
 * gate goes RED, not green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, finish } from './lib/run.ts';

const BUILD_NETWORK = 'kinvara-build';
const INT_NETWORK = 'kinvara-int';
/** The one non-internal network, and the one file allowed to name it. */
const PUB_NETWORK = 'kinvara-pub';
const PUB_FILE = 'docker/compose.dev.yml';

const failures: string[] = [];

const read = (rel: string): string | null => {
  const p = path.join(REPO_ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

/** A YAML line with its comment stripped. Crude on purpose — see below. */
const codeOf = (line: string): string => {
  // Compose values here are unquoted scalars and flow sequences; none of them
  // contains a '#'. Anything that did would be over-reported, which is the
  // safe direction for this gate.
  const i = line.indexOf('#');
  return (i === -1 ? line : line.slice(0, i)).replace(/\s+$/, '');
};

interface Service {
  readonly name: string;
  readonly line: number;
  readonly networks: string[] | null;
}

/**
 * Parse `services:` -> `<name>:` -> `networks:` out of a compose file.
 *
 * A deliberately small subset of YAML: two indent levels, flow or block
 * sequences. It is sound because it refuses to guess — anything it cannot
 * account for makes the caller's cross-check fail.
 */
function parseServices(text: string): Service[] {
  const lines = text.split('\n');
  const services: Service[] = [];
  let inServices = false;
  let current: { name: string; line: number; networks: string[] | null } | null = null;
  let collectingBlockList = false;

  const flush = (): void => {
    if (current !== null) services.push({ ...current });
    current = null;
    collectingBlockList = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const code = codeOf(raw);
    if (code.trim() === '') continue;

    // A top-level key ends the services block.
    if (/^[A-Za-z0-9_.-]+:/.test(code)) {
      flush();
      inServices = code.startsWith('services:');
      continue;
    }
    if (!inServices) continue;

    // A service name: exactly two spaces of indent, a bare key, nothing after.
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(code);
    if (svc !== null) {
      flush();
      current = { name: svc[1] ?? '', line: i + 1, networks: null };
      continue;
    }
    if (current === null) continue;

    if (collectingBlockList) {
      const item = /^ {6}- +(.+)$/.exec(code);
      if (item !== null) {
        (current.networks ??= []).push((item[1] ?? '').trim());
        continue;
      }
      collectingBlockList = false;
    }

    const nets = /^ {4}networks:\s*(.*)$/.exec(code);
    if (nets !== null) {
      const inline = (nets[1] ?? '').trim();
      if (inline.startsWith('[')) {
        current.networks = inline
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
      } else if (inline === '') {
        current.networks = [];
        collectingBlockList = true;
      } else {
        current.networks = [inline];
      }
    }
  }
  flush();
  return services;
}

// ---------------------------------------------------------------------------
// 1. `kinvara-build` appears in no compose file, anywhere but a comment.
//
//    The blunt check, and the one that cannot be defeated by YAML structure:
//    a service, an anchor, an `extends`, a `x-` template — if the string is
//    live in the file, this fires.
// ---------------------------------------------------------------------------
const COMPOSE_FILES = [
  'docker/compose.yml',
  'docker/compose.dev.yml',
  'docker/compose.verify.yml',
  'docker/compose.chaos.yml',
];

let composeFilesSeen = 0;
let parsedServiceCount = 0;
for (const rel of COMPOSE_FILES) {
  const text = read(rel);
  if (text === null) {
    failures.push(`${rel} does not exist — this gate's file list is stale`);
    continue;
  }
  composeFilesSeen += 1;
  text.split('\n').forEach((line, idx) => {
    if (codeOf(line).includes(BUILD_NETWORK)) {
      failures.push(
        `${rel}:${String(idx + 1)} names ${BUILD_NETWORK} outside a comment. ` +
          `No service may EVER be attached to the egress network (DOCKER.md §7a). ` +
          `line: ${line.trim()}`,
      );
    }
  });
}
if (composeFilesSeen === 0) failures.push('no compose file was read at all — refusing to pass');

// ---------------------------------------------------------------------------
// 2. Every service declares its networks, and the set is what §7 allows.
// ---------------------------------------------------------------------------
for (const rel of COMPOSE_FILES) {
  const text = read(rel);
  if (text === null) continue;

  const services = parseServices(text);
  parsedServiceCount += services.length;
  // The cross-check. Every service in every one of these files carries an
  // `image:`; if the parser found a different number, it did not understand
  // the file and must not report a pass on it.
  const imageKeys = text
    .split('\n')
    .map(codeOf)
    .filter((l) => /^ {4}image:/.test(l)).length;

  if (rel === 'docker/compose.yml') {
    if (imageKeys === 0) {
      failures.push(`${rel} has no services — this gate would then assert nothing`);
    }
    if (services.length !== imageKeys) {
      failures.push(
        `${rel}: parsed ${String(services.length)} services but the file has ` +
          `${String(imageKeys)} image: keys. The parser did not understand this file; ` +
          `fix the gate rather than trusting it.`,
      );
    }
  }

  for (const s of services) {
    if (s.networks === null) {
      if (rel === 'docker/compose.yml') {
        failures.push(
          `${rel}:${String(s.line)} service '${s.name}' declares no networks:. ` +
            `Compose would attach it to the project's DEFAULT bridge, which is NOT ` +
            `internal and therefore has egress. Every service must name ${INT_NETWORK}.`,
        );
      }
      continue; // an overlay may legitimately leave networks alone
    }
    for (const n of s.networks) {
      if (n === INT_NETWORK) continue;
      if (n === PUB_NETWORK && rel === PUB_FILE) continue; // the documented dev-stack exception
      failures.push(
        `${rel}:${String(s.line)} service '${s.name}' is attached to '${n}'. ` +
          `Only ${INT_NETWORK} is permitted (and ${PUB_NETWORK}, in ${PUB_FILE} alone, ` +
          `which is why no evidence may come from the shared dev stack).`,
      );
    }
    if (!s.networks.includes(INT_NETWORK) && rel === 'docker/compose.yml') {
      failures.push(`${rel}:${String(s.line)} service '${s.name}' is not on ${INT_NETWORK}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The two entry points keep their halves of the rule.
// ---------------------------------------------------------------------------
const svc = read('scripts/svc');
if (svc === null) {
  failures.push('scripts/svc is missing');
} else {
  const live = svc.split('\n').map(codeOf);
  const attaches = live.filter((l) =>
    /--network\s+["']?\$?\{?(BUILD_NETWORK|kinvara-build)/.test(l),
  );
  if (attaches.length > 0) {
    failures.push(
      `scripts/svc attaches ${BUILD_NETWORK}: ${attaches.join(' | ')}. ` +
        `svc run gets services and NO egress (DOCKER.md §7b).`,
    );
  }
  if (!/refusing to attach/.test(svc)) {
    failures.push(
      `scripts/svc no longer contains its refusal assertion for ${BUILD_NETWORK}. ` +
        `That assertion is the runtime half of this gate; do not delete it.`,
    );
  }
}

const dev = read('scripts/dev');
if (dev === null) {
  failures.push('scripts/dev is missing');
} else {
  const live = dev.split('\n').map(codeOf);
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

console.log(
  `  compose files checked      ${String(composeFilesSeen)}/${String(COMPOSE_FILES.length)}`,
);
console.log(`  services parsed            ${String(parsedServiceCount)}`);
console.log(`  entry points checked       scripts/dev, scripts/svc`);

finish('gate:egress-boundary', failures);
