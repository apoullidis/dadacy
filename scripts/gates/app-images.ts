/**
 * gate:app-images — the static checks over the application Dockerfiles and the
 * compose overlays (T-018, carried by T-034; stage semantics T-035; SCOPE T-036).
 *
 * `docker/app.Dockerfile` + `docker/compose.verify.yml` are what make every
 * later ticket's evidence real: DOCKER.md §5 says a service-dependent ticket
 * is only done when the app ran AS ITS IMAGE, because signal handling, DNS,
 * paths, env resolution and non-root permissions are invisible outside it.
 *
 * WHAT THIS HEADER USED TO SAY, AND WHY IT DOES NOT SAY IT ANY MORE (TL-F4).
 * It said "five properties, each stated so that the check IS the claim". That
 * sentence was false for five of the checks below at once, and the falsehood
 * was always the same shape: THE CHECK'S SCOPE WAS ONE STEP NARROWER THAN THE
 * SENTENCE DESCRIBING IT (decisions.md OD-21…OD-32, escalation OE-8). The
 * literal-pin anchor read the Node pin and not the pnpm pin; `ports:` was read
 * in one overlay of two; the `:?` clause was a whole-file `includes()` over
 * five services; a budget raise was read in `verify` and not in `chaos`; §1's
 * pin checks read two constant paths while §6 read a derived set; a `build:`
 * with no `target:` was never resolved at all. Every one of them was green.
 *
 * SO THE ORGANISING RULE OF THIS FILE IS NOW A SCOPE RULE, and it is the thing
 * to preserve when you edit it:
 *
 *     EVERY CHECK READS A DERIVED SET, NOT A CONSTANT PATH, AND ITERATES
 *     WHAT IT CLAIMS TO COVER — PER FILE, PER SERVICE, PER PIN, PER STAGE.
 *
 *   * the files: the composed set is read out of `scripts/svc`'s own
 *     `compose_files_for()` (T-037, OD-37) — not a constant, and not a
 *     `docker/compose*.yml` glob, which is the same enumeration in another
 *     spelling. `dockerfilesInUse` is every Dockerfile an application build
 *     actually points at. `PRIMARY_DOCKERFILE` no longer exists.
 *   * the services the image contract is asserted OVER: `apps/*` UNION the
 *     `io.kinvara.built-by` label set, and a NON-application build declared
 *     for one of them is itself a failure (T-037, OD-36). That is an
 *     inversion, not a fourth enumerated route: three reviewers each found a
 *     different route to a root, healthcheck-less `safety-gw` image, and each
 *     fix closed the route it was given (OE-10).
 *   * the membership of that label set is asserted against `apps/*`, OUTSIDE
 *     the file the labels live in (T-037, OD-38). Its only previous check
 *     fired when the set was EMPTY, so losing one member was silent — and the
 *     member could be removed by the same edit that exploited its absence.
 *   * the pins: both of them, looped, never one spelled out.
 *   * the services: `Object.entries(...)` of each parsed file, never a
 *     whole-file `text.includes(...)` standing in for "every service does X".
 *   * the stages: the target COMPOSE names (T-035), and a `build:` with no
 *     `target:` is a FAILURE rather than a silent skip (OD-30/OD-32) — so the
 *     stage that ships can never be decided by which stage happens to be last.
 *
 * A SECOND RULE, from the other half of the family (OD-26/OD-28): a check that
 * REQUIRES a line to be present reads the file with comments stripped. Over
 * raw text, `# ` in front of the line satisfies the check, which is the exact
 * edit the check exists to catch.
 *
 * What this gate does NOT do: build anything, or run a container. It has no
 * Docker socket by design (OD-16), and a gate that needed a daemon could not
 * be part of `gate:pr`. That the images BUILD and pass their healthchecks is
 * `svc up --verify --build`, evidenced per ticket. What each check covers is
 * published in state/EP-1/T-036.md § Published contract, and every row there
 * names the negative case in `scripts/negative-tests/app-images.sh` that would
 * fail if it were false.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, finish, toolVersions } from './lib/run.ts';
import { composedFiles } from './lib/composed-files.ts';

/**
 * EVERY compose file a ticket-scoped project is composed from — DERIVED FROM
 * `scripts/svc`'s own `-f` assembly, never written down here (T-037, OD-37).
 *
 * WHAT THIS REPLACES, AND WHY THE PREVIOUS FIX WAS NOT ENOUGH. The four
 * constants that used to sit here were a hand-written enumeration under a
 * heading reading "EVERY compose file that can declare a `build:`". `T-036`
 * corrected their CONTENTS (OD-33: `docker/compose.yml` was missing from the
 * build set, and a root, healthcheck-less `safety-gw` came out of the gap) and
 * left them enumerations. `tech-lead` then measured the level above: a FIFTH
 * compose file, wired into `scripts/svc`, carrying a target-less two-stage
 * application build, literal pins, `ports:` and `mem_limit: 8g`, is read by
 * NOTHING in either gate and is exit 0 on both — because `does not exist —
 * this gate's file list is stale` fires on a LISTED file MISSING, never on one
 * APPEARING. Reproduced on this branch before the fix (§ Evidence 1).
 *
 * A glob (`docker/compose*.yml`) was considered and REJECTED, on `tech-lead`'s
 * recommendation adopted in `T-037`'s brief: it is a second enumeration of the
 * same kind, and `docker/chaos-extra.yml` would not match it. `scripts/svc`'s
 * `compose_files_for()` is what actually decides which files reach a project,
 * so it IS the set. See `lib/composed-files.ts` for the derivation, its
 * fail-closed behaviour, and the straggler scan that catches a compose file
 * `svc` composes from nothing.
 */
const composed = composedFiles();
/** Passed unconditionally: the file the addition/override difference is against. */
const BASE_FILE = composed.files.find((f) => f.role === 'base')?.rel ?? 'docker/compose.yml';
/** The file `--verify` adds, derived from the flag rather than from its name (row L). */
const VERIFY_FILE = composed.files.find((f) => f.guard === 'USE_VERIFY')?.rel ?? '';
const BUILD_DECLARING_FILES: readonly string[] = composed.files.map((f) => f.rel);
/**
 * The files the no-host-port rule (§3) covers: everything composed EXCEPT the
 * dev-only file.
 *
 * OD-22. The rule is a property of a TICKET-SCOPED PROJECT —
 * `docker compose -p kinvara-<t> -f compose.yml [-f overlay]` — so a `ports:`
 * key anywhere in that set is the same defect. Measured before that fix:
 * `ports: ['53999:3000']` on `core` in compose.yml passed this gate AND
 * gate:egress-boundary at exit 0, and the identical key on a chaos addition
 * passed both. Worse than a plain gap, because OD-4 makes the wrong edit
 * SILENT: Docker drops publishing on an `internal: true` network with no
 * error, so it reads as working until a service gains a second network.
 *
 * The exclusion is now DERIVED TOO: the excluded file is the one `scripts/svc`
 * adds only for the literal `dev` project (`IS_DEV`), which is exactly the
 * documented exception — the shared stack is the one project that publishes
 * (`T-016` § contract 6). It is not excluded by name.
 */
const PORT_FREE_FILES: readonly string[] = composed.files
  .filter((f) => f.role !== 'dev')
  .map((f) => f.rel);
/**
 * The `-f` overlays — every file `svc` adds behind a FLAG. §4's budget rule
 * reads this set. `compose.dev.yml` is not one: it is applied by project name.
 */
const OVERLAY_FILES: readonly string[] = composed.files
  .filter((f) => f.role === 'overlay')
  .map((f) => f.rel);
const BUILT_BY = 'T-018';
/**
 * The toolchain pins that reach an image build, LOOPED — never one of them
 * spelled out.
 *
 * OD-21: the literal-pin anchor below used to read `nodePin` alone, so
 * `RUN corepack prepare pnpm@11.25.0 --activate` — the ordinary idiom, and the
 * spelling people actually write — passed in both files it read. One fact in
 * two places is OD-1's shape and the copy goes stale in silence.
 */
const PIN_ARGS = [
  { arg: 'NODE_VERSION', env: 'KINVARA_NODE_VERSION', pinKey: 'nodejs' },
  { arg: 'PNPM_VERSION', env: 'KINVARA_PNPM_VERSION', pinKey: 'pnpm' },
] as const;

const failures: string[] = [];
// Every diagnostic from the derivation is a failure of THIS gate: a gate that
// cannot establish what it is supposed to read must go red, never green over a
// set it guessed.
failures.push(...composed.problems);
if (VERIFY_FILE === '') {
  failures.push(
    `scripts/svc's compose_files_for() adds no compose file behind USE_VERIFY, so this ` +
      `gate cannot tell which file '--verify' builds the application images from. Row L ` +
      `below (every labelled service has a build: there) is what 'svc up --verify --build' ` +
      `depends on, and it cannot be checked against a file that is not composed.`,
  );
}
const read = (rel: string): string | null => {
  const p = path.join(REPO_ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strip a Dockerfile comment line and any trailing shell comment. */
const dfCode = (line: string): string => (line.split('#')[0] ?? '').trim();
/** The live (comment-stripped) lines of a shell script or a Dockerfile. */
const liveLines = (text: string): string[] => text.split('\n').map(dfCode);

/**
 * Does this Dockerfile install from the pnpm workspace, and therefore have a
 * node_modules that could hold devDependencies (and a Node/pnpm pin that must
 * be derived)? Read from the file, never from a list of which images are "app"
 * images: a chaos sidecar built from some other base has neither, and
 * demanding either of it would be a rule nobody could satisfy honestly.
 *
 * Deliberately WIDE, and it over-approximates on purpose. The previous version
 * matched three literals (`pnpm-lock.yaml`, `pnpm install`, `pnpm --filter`)
 * and QA found the obvious hole: `pnpm i` is the same command, is the SHORTER
 * and commoner spelling, and skipped the guard. Over-approximating fails SAFE
 * — a false positive asks you to add a guard or an ARG to an image that may
 * not need one, which is visible and arguable; a false negative is an
 * unguarded image, which is silent, and silence shipped 112.2 MB of
 * devDependencies.
 */
const buildsFromWorkspace = (text: string): boolean =>
  liveLines(text).some((l) => /\bpnpm\b|node_modules/.test(l));

/**
 * Is this build an APPLICATION image — one §6's contract actually describes (a
 * non-root uid of a particular shape, a Node healthcheck, an exec entrypoint,
 * the devDependency guard)?
 *
 * DERIVED PER BUILD, FROM THE ARTEFACT AND FROM COMPOSE — never from which
 * file the service is declared in. The first attempt at OD-33's fix used a
 * file list (`APP_IMAGE_FILES = [verify, chaos, dev]`) and negative case 56
 * caught it within the hour: a new app service declared in `docker/compose.yml`
 * with `RUN pnpm i`, literal `ARG` pins, `USER root` and a shell ENTRYPOINT was
 * GATE PASS, because the file it was declared in said it was not an app image.
 * That is OD-33's own defect reproduced inside OD-33's own fix, which is why
 * the file list is gone rather than corrected.
 *
 * Two signals, either is sufficient, both anchored outside this file:
 *
 *  - the Dockerfile installs from the pnpm workspace (`buildsFromWorkspace`) —
 *    this is `T-034` § contract 5's own words for why `postgres` and
 *    `fake-telephony` are out of scope: *"they are T-017's images, they are not
 *    built from the pnpm workspace"*. Both have zero live mentions of pnpm or
 *    node_modules, so both stay exempt without being named anywhere;
 *  - the service passes an `APP` build arg, i.e. compose says this build IS one
 *    of this workspace's applications. That covers the Next.js split `T-034`
 *    § contract 6 invites — a `docker/next.Dockerfile` need not mention pnpm at
 *    all, and negative case 18 is exactly that shape.
 */
const isApplicationBuild = (
  dockerfileText: string | null,
  build: Record<string, unknown>,
): boolean => {
  if (dockerfileText !== null && buildsFromWorkspace(dockerfileText)) return true;
  const args = build['args'];
  return isRecord(args) && typeof args['APP'] === 'string' && args['APP'].trim() !== '';
};

/** Parsed `services:` of a compose file. Memoised: each file is reported once. */
const servicesCache = new Map<string, Record<string, Record<string, unknown>> | null>();
const servicesOf = (rel: string): Record<string, Record<string, unknown>> | null => {
  const cached = servicesCache.get(rel);
  if (cached !== undefined) return cached;
  const compute = (): Record<string, Record<string, unknown>> | null => {
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
  const result = compute();
  servicesCache.set(rel, result);
  return result;
};

const base = servicesOf(BASE_FILE);
const verify = VERIFY_FILE === '' ? null : servicesOf(VERIFY_FILE);

// ---------------------------------------------------------------------------
// THE APPLICATION-SERVICE SET, AND WHERE ITS MEMBERSHIP IS ANCHORED (T-037,
// OD-38).
//
// `declaredByLabel` — the services `docker/compose.yml` labels
// `io.kinvara.built-by` — is what row L, §5's app set and §2b's universal all
// key on. It was read out of THE SAME FILE AN ATTACKER EDITS, and its only
// self-check fired when the set was EMPTY. `tech-lead` measured the
// consequence on `93969b3`: delete `safety-gw`'s two label lines from
// `compose.yml` and nothing else, and the gate prints
// `services labelled built-by T-018  4: core worker web admin` at exit 0,
// GATE PASS; then delete `safety-gw`'s entire `build:` stanza from
// `compose.verify.yml` and it is STILL exit 0 — where negative case 07, the
// same deletion for `core` with its label intact, is exit 1. Row L's own
// trigger was defeated by first removing the label, and every rule keyed on
// this set went silent for that service together. Reproduced on this branch
// before the fix (§ Evidence 1).
//
// PROTOCOL.md §5.1: "a check must not be derived from the same reading as the
// thing it checks... anchor one of them outside". So MEMBERSHIP is asserted,
// not non-emptiness, and it is asserted against `apps/*/package.json` — a
// different tree, owned by different agents, and the same set DOCKER.md §3's
// profile table names. An application whose service loses its label now reds
// the gate at the moment the label goes, rather than at the moment somebody
// notices.
//
// DELIBERATELY OVER-APPROXIMATING, in the same direction and for the same
// reason as `buildsFromWorkspace`: if `apps/` gains a directory that is not a
// compose service, this gate reds and asks for a label. That is visible and
// arguable. The other direction — a service quietly leaving the set — is
// silent, and silence is what shipped OD-38.
const APPS_DIR = 'apps';
const appServices: string[] = (() => {
  const abs = path.join(REPO_ROOT, APPS_DIR);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(abs, e.name, 'package.json')))
    .map((e) => e.name)
    .sort();
})();
if (appServices.length === 0) {
  failures.push(
    `${APPS_DIR}/ contains no application package.json. That set is what anchors the ` +
      `io.kinvara.built-by membership check below, and an empty anchor would make it ` +
      `assert nothing (OD-38).`,
  );
}

const declaredByLabel: string[] = [];
if (base !== null) {
  for (const [name, svc] of Object.entries(base)) {
    const labels = svc['labels'];
    if (isRecord(labels) && labels['io.kinvara.built-by'] === BUILT_BY) declaredByLabel.push(name);
  }
}
declaredByLabel.sort();
if (base !== null && appServices.length > 0) {
  // The direction OD-38 measured: a service `compose.yml` DECLARES, for an
  // application this workspace HAS, must carry the label. The requirement
  // comes from `apps/`, so deleting the label from `compose.yml` cannot
  // satisfy it — which is the whole point.
  //
  // Scoped to services the base file declares, deliberately: an application
  // that `compose.yml` does not declare at all is not a labelling defect, and
  // widening this to "every apps/* directory" would make negative case 52 —
  // an app declared only by an overlay build — red on two problems instead of
  // the one it is cited for, which is the isolation QA-F2 fixed. The residue
  // (deleting the label AND the whole service) is probed by case 71 and is
  // caught by the overlay ADDITION rules in both gates.
  for (const name of appServices) {
    if (base[name] !== undefined && !declaredByLabel.includes(name)) {
      failures.push(
        `${BASE_FILE} declares service '${name}' and ${APPS_DIR}/${name} is an application ` +
          `in this workspace, but the service is not labelled ` +
          `'io.kinvara.built-by: ${BUILT_BY}'. That label is what puts a service inside the ` +
          `image contract — row L, the placeholder rule, and the rule that no composed file ` +
          `may declare a NON-application build for it. Deleting the label used to remove the ` +
          `service from all three AT ONCE, in silence, because the only check on this set was ` +
          `that it is not EMPTY (OD-38). Membership is asserted now, against ${APPS_DIR}/.`,
      );
    }
  }
  for (const name of declaredByLabel) {
    if (!appServices.includes(name)) {
      failures.push(
        `${BASE_FILE} labels '${name}' as built by ${BUILT_BY}, but there is no ` +
          `${APPS_DIR}/${name}/package.json. Either the label names a service this ` +
          `workspace does not build, or the app was removed and the label was not.`,
      );
    }
  }
}
/**
 * The services the image contract is asserted OVER, whichever composed file
 * declares their build (T-037, OD-36). The union, not the label set alone:
 * `appServices` is the anchor that survives an edit to `docker/compose.yml`,
 * and `declaredByLabel` catches a labelled service that is not (yet) an
 * `apps/*` directory.
 */
const protectedServices = new Set<string>([...appServices, ...declaredByLabel]);

const pins = toolVersions();
/** arg name -> the pinned value it must carry. Both, always both. */
const pinValues = new Map<string, string>();
for (const { arg, pinKey } of PIN_ARGS) {
  const v = pins.get(pinKey);
  if (v === undefined) failures.push(`.tool-versions does not pin '${pinKey}'`);
  else pinValues.set(arg, v);
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
 * names in `build.target`, which is now always named because a `build:` with
 * no `target:` is refused in §2a (OD-30/OD-32) — and no COPY or
 * ADD may follow it there. Anything copied in after it is outside what it saw,
 * and `COPY --from=deps ./node_modules` is precisely how QA put 23.6 MB of
 * typescript back into the image with an earlier version of the guard green.
 */
interface Stage {
  readonly name: string;
  /**
   * The `FROM` argument, verbatim: another stage's name, or an external image
   * reference. It is what makes the ancestry walk below possible, and it is
   * the difference between modelling Docker and pattern-matching a file.
   */
  readonly parent: string;
  readonly lines: readonly string[];
}

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
  let current: { name: string; parent: string; lines: string[] } | null = null;
  for (const line of joined) {
    // The flag group is not decoration: `FROM --platform=$BUILDPLATFORM node:x
    // AS y` is ordinary, and the previous pattern did not match it — so that
    // FROM was read as an INSTRUCTION OF THE PREVIOUS STAGE and the whole new
    // stage's lines were attributed to its predecessor. A mis-parse in the
    // silent direction, in the function the checks below now depend on.
    const from = /^FROM\s+((?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from !== null) {
      if (current !== null) stages.push(current);
      current = {
        name: from[3] ?? `#${String(stages.length)}`,
        parent: from[2] ?? '',
        lines: [],
      };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (current !== null) stages.push(current);
  return stages;
}

/**
 * The stages a target stage inherits its image config from, ANCESTOR FIRST,
 * ending with the target itself. `null` if the target is not a stage here.
 *
 * A `FROM` whose argument names another stage in this file continues the walk;
 * one naming an external image ends it. That end is not a hole: nothing in an
 * external base gives an image a non-root `USER` or the healthcheck this
 * contract requires — `node:*-alpine` has no `USER` and no `HEALTHCHECK` at
 * all — so a chain that reaches an external base having set neither is exactly
 * the image this gate must refuse.
 */
function ancestryOf(stages: readonly Stage[], target: string): Stage[] | null {
  const byName = new Map(stages.map((s) => [s.name.toLowerCase(), s]));
  let cur = byName.get(target.toLowerCase());
  if (cur === undefined) return null;
  const chain: Stage[] = [];
  const seen = new Set<string>();
  while (cur !== undefined && !seen.has(cur.name.toLowerCase())) {
    seen.add(cur.name.toLowerCase());
    chain.unshift(cur);
    cur = byName.get(cur.parent.toLowerCase());
  }
  return chain;
}

interface Setting {
  /** Everything after the instruction keyword, trimmed. */
  readonly value: string;
  /** The stage that set it — named in the failure so the fix is findable. */
  readonly stage: string;
}

/**
 * LAST-WINS ALONG THE ANCESTRY. Docker resolves `USER`, `ENTRYPOINT` and
 * `HEALTHCHECK` as IMAGE CONFIG, not as file contents: a child stage starts
 * from its parent's config and every later instruction overwrites the earlier
 * one. So the resolved value is the last occurrence in ancestor-first order —
 * which is neither "anywhere in the file" (OE-7: three appended lines, or
 * `USER root` alone, make the shipping stage root with the gate green) nor
 * "somewhere in this stage" (which would refuse a legitimate
 * `FROM runtime AS next-runtime` that inherits all three correctly).
 */
function resolveSetting(chain: readonly Stage[], instruction: string): Setting | null {
  const re = new RegExp(`^${instruction}\\b\\s*(.*)$`, 'i');
  let last: Setting | null = null;
  for (const stage of chain) {
    for (const line of stage.lines) {
      const m = re.exec(line);
      if (m !== null) last = { value: (m[1] ?? '').trim(), stage: stage.name };
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// 2a. THE DERIVED SET — every overlay service that builds, and every
//     Dockerfile they build from. Everything below reads this; nothing below
//     reads a constant path.
//
//     It runs FIRST now (it used to sit between §2 and §3), because §1's pin
//     checks were the half of OD-25 that still read two constants while §6
//     read this set — so a SECOND Dockerfile, which T-034 § contract 6 tells
//     the Next.js tickets to add, passed §1 with literal pins in both ARGs
//     while the gate printed `dockerfiles checked 2`.
// ---------------------------------------------------------------------------
interface BuildUse {
  /** The overlay file the service is declared in. */
  readonly file: string;
  readonly service: string;
  readonly dockerfile: string;
  /** The stage compose names. Never '' — a missing target is a failure below. */
  readonly target: string;
  /** `build.args`, verbatim from the YAML: compose does no substitution here. */
  readonly args: Record<string, unknown>;
}
const buildUses: BuildUse[] = [];
/**
 * dockerfile path -> `<file>:<service>→<target>` for every OVERLAY service
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
 * `compose.chaos.yml` is in the set for a concrete reason: T-034's own
 * published contract hands that file to T-126, and a built sidecar — a proxy
 * that throttles the network, say — is exactly what lands there.
 *
 * compose.yml's own builds (postgres, fake-telephony) are NOT in THIS map, and
 * `isApplicationBuild` is what keeps them out — not a file list. They are
 * T-017's images, they are not built from the pnpm workspace and they pass no
 * APP arg, so the application-image contract below — a non-root uid of this
 * shape, a Node healthcheck, the devDependency guard — does not describe them.
 *
 * They ARE held to the target rule, because that rule is not about application
 * images: it is about which stage ships being decided by file order. Both are
 * single-stage, so both resolve unambiguously and stay green (OD-33).
 */
const dockerfilesInUse = new Map<string, string[]>();
/** `<file>:<service>` -> the repo-root-relative Dockerfile, for EVERY build. */
const allBuilds: { readonly where: string; readonly dockerfile: string }[] = [];
/**
 * `<dockerfile> <target>  <-  ancestry` for every stage the image-contract
 * checks below actually resolved. Printed, because `dockerfiles checked 1`
 * was printed by a version that had enumerated the wrong set entirely and it
 * read as coverage (QA, round 2). A reader can now see WHICH STAGE was
 * checked and what it inherits from, which is the thing OE-7 and OD-29 were
 * both invisible in.
 */
const stagesChecked: string[] = [];

/**
 * Resolve a `build.dockerfile` the way Docker does: relative to `context:`,
 * which is itself relative to the COMPOSE FILE's own directory. Returns a
 * repo-root-relative path, or null if it escapes the repository.
 *
 * The previous version did `path.join(REPO_ROOT, df)`, which is right only
 * because every overlay build happens to use `context: ..` with a
 * root-relative `dockerfile:`. `compose.yml`'s two builds do NOT — `postgres`
 * is `context: .` + `dockerfile: postgres.Dockerfile`, and `fake-telephony` is
 * `context: ./fakes/telephony` + `dockerfile: Dockerfile` (T-034 § contract 5
 * records this difference). Reading them the old way reports "does not exist"
 * for two files that do, which is the wrong failure and would have made
 * OD-33's fix look impossible.
 */
function resolveDockerfile(composeFile: string, context: string, df: string): string | null {
  const joined = path.normalize(path.join(path.dirname(composeFile), context, df));
  return joined.startsWith('..') || path.isAbsolute(joined) ? null : joined;
}

for (const rel of BUILD_DECLARING_FILES) {
  const svcs = servicesOf(rel);
  if (svcs === null) continue; // already reported
  for (const [name, svc] of Object.entries(svcs)) {
    if (!('build' in svc)) continue;
    const build = svc['build'];
    if (!isRecord(build)) {
      // Compose's SHORT FORM — `build: ..` — is a string, and the previous
      // line here was `if (!isRecord(build)) continue`, so a service written
      // that way was skipped ENTIRELY: no Dockerfile derived, no image
      // contract, no pin check, gate green. Found by attacking this fix rather
      // than by running it; it is the same family shape one level down, and it
      // is a spelling compose accepts, not a construction.
      failures.push(
        `${rel}: '${name}' declares build: in the short form (${JSON.stringify(build)}). ` +
          `This gate reads build.dockerfile and build.target, so the short form would ` +
          `leave the image it builds checked by nothing. Use the long form with an ` +
          `explicit dockerfile: and target:.`,
      );
      continue;
    }
    const rawDf = String(build['dockerfile'] ?? '');
    if (rawDf === '') {
      failures.push(
        `${rel}: '${name}' declares build: with no dockerfile:. This gate cannot then ` +
          `check the image contract of something this repository builds, and a build with ` +
          `no dockerfile: silently means './Dockerfile' relative to the context.`,
      );
      continue;
    }
    const ctx = typeof build['context'] === 'string' ? build['context'] : '.';
    const df = resolveDockerfile(rel, ctx, rawDf);
    if (df === null) {
      failures.push(
        `${rel}: '${name}' resolves dockerfile '${rawDf}' (context '${ctx}') outside this ` +
          `repository. This gate can only read what is in the repo.`,
      );
      continue;
    }
    if (!fs.existsSync(path.join(REPO_ROOT, df))) {
      failures.push(
        `${rel}: '${name}' names dockerfile '${rawDf}' (context '${ctx}' -> ${df}), ` +
          `which does not exist`,
      );
      continue;
    }
    allBuilds.push({ where: `${rel.replace('docker/', '')}:${name}`, dockerfile: df });
    const dfText = read(df);
    const stages = dfText === null ? [] : stagesOf(dfText);
    const isApp = isApplicationBuild(dfText, build);

    // --- 2b. THE UNIVERSAL (T-037, OD-36) ------------------------------------
    //
    //   NO COMPOSED FILE MAY DECLARE A NON-APPLICATION BUILD FOR A SERVICE IN
    //   THE APPLICATION SET.
    //
    // This is the INVERSION the OE-10 ruling asked for, and it is the reason
    // this ticket exists. Every previous fix here enumerated a bad route —
    // a `build:` with no `target:` (OD-32), a `build:` in a file the list
    // omitted (OD-33) — and each closed the route it was given. Then
    // `tech-lead` found a third: give `docker/compose.yml`'s `safety-gw` a
    // `build:` pointing at a SINGLE-STAGE, NON-APPLICATION Dockerfile and it is
    // DEMOTED OUT of the application set. Three checks then decline it in
    // sequence, each correctly by its own rule — the target rule exempts a
    // single-stage file, `isApplicationBuild` is false so §1b/§1c/§6 skip it,
    // and row L is satisfied by the untouched overlay. Built: `User=[root]`,
    // a shell at PID 1, `Healthcheck=null`, `gate:pr` 9/9 exit 0 (OD-36).
    //
    // Enumerating a fourth route would have been the same mistake a fourth
    // time. So the question is turned round: instead of asking "is this build
    // one of the shapes we refuse", ask "is this service one whose image must
    // satisfy the contract" — and if it is, a build that cannot be checked
    // against that contract is itself the failure. `postgres` and
    // `fake-telephony` stay green because neither is in the set, and nothing
    // names them anywhere.
    //
    // Membership is anchored on `apps/*` as well as on the label, so the
    // demotion cannot be performed by first deleting the label (OD-38).
    if (!isApp && protectedServices.has(name)) {
      failures.push(
        `${rel}: '${name}' is an APPLICATION SERVICE (apps/${name} exists, and/or ` +
          `${BASE_FILE} labels it 'io.kinvara.built-by: ${BUILT_BY}'), but the build it ` +
          `declares here is not an application build: ${df} neither installs from the pnpm ` +
          `workspace nor takes an APP build arg. Its image would then be exempt from the ` +
          `non-root uid, the healthcheck, the exec-form entrypoint, the derived pins and ` +
          `the devDependency guard — every one of them, silently, because being outside ` +
          `the application set is how a build escapes all of them at once (OD-36). ` +
          `An application service is built from the application Dockerfile.`,
      );
    }

    // --- the target rule, over EVERY build in EVERY file (OD-30/OD-32/OD-33) -
    const declared = typeof build['target'] === 'string' ? build['target'].trim() : '';
    let target = declared;
    if (declared === '') {
      const stageCount = stages.length;
      if (stageCount === 1) {
        // Unambiguous: "the last stage" and "the only stage" are the same
        // stage, so the build still resolves and the checks below still run
        // over it. This is a resolution, not a skip — the previous version
        // `continue`d here, and negative case 56 walked straight through the
        // gap.
        target = stages[0]?.name ?? '';
      } else {
        // THE RULE, AND WHY THE EXEMPTION IS SHAPED LIKE THIS.
        //
        // The risk is not "an app image is unchecked" — it is "WHICH STAGE
        // SHIPS IS DECIDED BY FILE ORDER AND BY NOTHING ELSE". Append a stage
        // and the image this service builds changes, silently, with every
        // check still pointed at the old one. That is what OD-32 measured on
        // `safety-gw` and what OD-33 measured again one compose file over.
        //
        // A file with EXACTLY ONE stage has no ordering to disturb: "the last
        // stage" and "the only stage" are the same stage, and there is nothing
        // a target: could disambiguate. The two legitimate target-less builds
        // on this tree — postgres.Dockerfile and fakes/telephony/Dockerfile,
        // both T-017's — are single-stage, and both stay green.
        //
        // The exemption is DERIVED FROM THE ARTEFACT AND SELF-CLOSING: append
        // a second stage to either file and the risk appears and the gate reds
        // in the same instant. That is why it is a stage count and not
        // `buildsFromWorkspace`, which QA offered: that predicate answers "does
        // this image have devDependencies to hide", a different question. It
        // would exempt a multi-stage chaos sidecar — precisely the thing T-126
        // is expected to add — and would demand a target of a single-stage
        // workspace build for no reason. Borrowing a predicate for a question
        // it does not answer is how this family started.
        failures.push(
          `${rel}: '${name}' declares build: with no target:, and ${df} has ` +
            `${String(stageCount)} stages. Docker then builds the LAST one, which is ` +
            `decided by file order and by nothing else — append a stage and the image ` +
            `this service ships changes, silently (OD-30/OD-32/OD-33). Name the stage. ` +
            `(A single-stage Dockerfile is exempt: there is nothing for a target: to ` +
            `disambiguate, and adding a second stage turns this red by itself.)`,
        );
        continue;
      }
    }

    // --- the application-image set (§1b, §1c, §6) ---------------------------
    // Derived per build, not from which file it was declared in — see
    // `isApplicationBuild` for what case 56 cost the file-list version.
    if (!isApp) continue;
    const label = `${rel.replace('docker/', '')}:${name}→${target}`;
    dockerfilesInUse.set(df, [...(dockerfilesInUse.get(df) ?? []), label]);
    buildUses.push({
      file: rel,
      service: name,
      dockerfile: df,
      target,
      args: isRecord(build['args']) ? build['args'] : {},
    });
  }
}

if (dockerfilesInUse.size === 0) {
  failures.push(
    `no build in ${BUILD_DECLARING_FILES.join(' or ')} resolves to an APPLICATION image ` +
      `this gate could read — §1b, §1c and §6 would then assert nothing.`,
  );
}

// ---------------------------------------------------------------------------
// 1. THE NODE AND PNPM VERSIONS ARE DERIVED FROM .tool-versions — over every
//    Dockerfile in use, every overlay file, both pins, and PER SERVICE.
//
//    Four measured defects lived in this block and every one of them was the
//    same shape, a scope one step narrower than the sentence describing it:
//      OD-21  the literal anchor looped the Node pin only;
//      OD-23  the `:?` clause was a whole-file `includes()` across FIVE
//             services, so one of them could drop it and stay green;
//      OD-25  the checks read two constant paths while §6 read the derived
//             set, so a second Dockerfile passed with literal pins in both;
//      OD-28  the `scripts/svc` clause read the RAW file, so commenting the
//             derivation out satisfied it (see §1d).
// ---------------------------------------------------------------------------

// --- 1a. FORBID: the literal pin value, in any file that feeds a build. -----
// The anchor of the whole section. Everything else here is spelling; this is
// the property — a second copy of the version is one fact in two places and it
// goes stale silently (OD-1).
// The app Dockerfiles, plus EVERY compose file that can declare a build —
// compose.yml included, which is the file OD-33's narrow control isolated: a
// live literal '24.20.0' in compose.dev.yml was exit 1 and the identical
// string in compose.yml was exit 0.
//
// T-017's own Dockerfiles are deliberately NOT here; see § Published contract
// § What is NOT claimed, and decisions.md OD-34.
const pinnedFiles = [
  ...new Set<string>([...dockerfilesInUse.keys(), ...BUILD_DECLARING_FILES]),
].sort();
for (const [arg, value] of pinValues) {
  for (const rel of pinnedFiles) {
    const text = read(rel);
    if (text === null) continue; // reported elsewhere
    if (liveLines(text).some((l) => l !== '' && l.includes(value))) {
      failures.push(
        `${rel} contains the literal ${arg} pin '${value}' in live (non-comment) text. ` +
          `The version must come from .tool-versions through scripts/svc — a second copy ` +
          `is one fact in two places and it goes stale silently (OD-1, OD-21).`,
      );
    }
  }
}

// --- 1a2. RECONCILE: PIN_ARGS is a SECOND ENUMERATION of .tool-versions ------
//
// Found by this ticket's own scope audit, not by a report. PIN_ARGS lists two
// pins under the sentence "the toolchain pins that reach an image build". That
// is true on the delivered tree — app.Dockerfile's only pin-shaped ARGs are
// NODE_VERSION and PNPM_VERSION — but it is a constant list checked against
// nothing, which is OD-1's shape and QA-F6's shape and the shape of every
// defect in this file's history. If .tool-versions grew a pin an application
// Dockerfile consumed, every rule in §1 would silently skip it.
//
// So: fold every pin key the way scripts/lib/toolbox.sh folds it (upper-cased,
// non-alphanumerics to '_', the single alias nodejs -> NODE, T-016 § contract
// 8) and fail if an application Dockerfile declares an ARG for one PIN_ARGS
// does not cover. gate:toolbox §1a does exactly this for its probe table; this
// is the same instrument pointed at this file's table.
const foldPinKey = (key: string): string =>
  (key === 'nodejs' ? 'node' : key).toUpperCase().replace(/[^A-Z0-9]/g, '_');
const coveredArgs = new Set<string>(PIN_ARGS.map((p) => p.arg));
for (const rel of [...dockerfilesInUse.keys()].sort()) {
  const text = read(rel);
  if (text === null) continue;
  const live = liveLines(text);
  for (const [key] of pins) {
    const arg = `${foldPinKey(key)}_VERSION`;
    if (coveredArgs.has(arg)) continue;
    if (live.some((l) => new RegExp(`^ARG\\s+${arg}\\b`).test(l))) {
      failures.push(
        `${rel} declares 'ARG ${arg}', which is a .tool-versions pin ('${key}') that ` +
          `PIN_ARGS in this gate does not cover — so none of §1's rules apply to it: not ` +
          `the literal-pin forbid, not the no-default rule, not the per-service ':?' ` +
          `requirement. Add it to PIN_ARGS.`,
      );
    }
  }
}

// --- 1b. REQUIRE, per Dockerfile: a bare ARG, never one with a default. -----
for (const rel of [...dockerfilesInUse.keys()].sort()) {
  const text = read(rel);
  if (text === null) continue;
  const live = liveLines(text);
  const workspace = buildsFromWorkspace(text);
  for (const { arg } of PIN_ARGS) {
    const withDefault = live.some((l) => new RegExp(`^ARG\\s+${arg}=`).test(l));
    const bare = live.some((l) => new RegExp(`^ARG\\s+${arg}\\s*$`).test(l));
    if (withDefault) {
      failures.push(
        `${rel}: 'ARG ${arg}' has a DEFAULT. A default makes a build that forgets to pass ` +
          `the pin succeed against some other version, silently. It must have none, so the ` +
          `build fails at the FROM line instead.`,
      );
    } else if (!bare && workspace) {
      failures.push(
        `${rel}: no bare 'ARG ${arg}' declaration, and this file installs from the pnpm ` +
          `workspace (it names pnpm or node_modules). The version it builds against would ` +
          `then come from the base image tag or from nowhere, not from .tool-versions.`,
      );
    }
  }
}

// --- 1c. REQUIRE, PER SERVICE: the `:?` form of every ARG its Dockerfile ----
//     declares. OD-23: this was `verifyText.includes('NODE_VERSION: ${KINVARA_
//     NODE_VERSION:?')` over the whole file, so removing the form from ONE of
//     five services left the gate at exit 0 and only replacing all five turned
//     it red. The clause asserted "the file mentions the form somewhere", not
//     "every build gets it" — and a service quietly building against an unset
//     variable is precisely what the `:?` exists to prevent.
//
//     Which ARGs are required is DERIVED FROM THE DOCKERFILE, not listed here:
//     a service must pass exactly the pin ARGs the file it builds declares. A
//     sidecar whose Dockerfile takes neither is asked for neither.
for (const use of buildUses) {
  const text = read(use.dockerfile);
  if (text === null) continue;
  const live = liveLines(text);
  for (const { arg, env } of PIN_ARGS) {
    if (!live.some((l) => new RegExp(`^ARG\\s+${arg}\\b`).test(l))) continue;
    const passed = use.args[arg];
    const wanted = `\${${env}:?`;
    if (typeof passed !== 'string' || !passed.startsWith(wanted)) {
      failures.push(
        `${use.file}: '${use.service}' builds ${use.dockerfile}, which declares ` +
          `'ARG ${arg}', but the service passes ${arg} as ` +
          `${passed === undefined ? '(nothing)' : JSON.stringify(passed)} rather than ` +
          `'${wanted}...}'. The ':?' form is what makes a bare 'docker compose -f ...' run ` +
          `fail loudly instead of building against an unset variable — and it is required ` +
          `of EVERY service, not of the file somewhere (OD-23).`,
      );
    }
  }
}

// --- 1d. REQUIRE: scripts/svc still derives both, read LIVE. ---------------
// OD-26/OD-28's shape, found in this file by the enumeration this ticket owns:
// the clause tested the RAW text, so `# KINVARA_NODE_VERSION="$(toolbox_require
// _pin nodejs)"` satisfied it while the export was gone.
const svcScript = read('scripts/svc');
if (svcScript === null) {
  failures.push('scripts/svc is missing');
} else {
  const live = liveLines(svcScript).join('\n');
  for (const { env, pinKey } of PIN_ARGS) {
    if (!new RegExp(`${env}="\\$\\(toolbox_require_pin ${pinKey}\\)"`).test(live)) {
      failures.push(
        `scripts/svc no longer derives ${env} from .tool-versions with ` +
          `toolbox_require_pin in live (non-comment) code. Without it the ':?' in the ` +
          `overlays makes every --verify build fail, and the obvious repair is to ` +
          `hard-code a version.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Every service compose.yml says T-018 builds is built by the overlay.
// ---------------------------------------------------------------------------
// `declaredByLabel` and its MEMBERSHIP check are computed near the top of this
// file, against the `apps/*` anchor (OD-38). Row L follows.
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
// 3 + 4. No host ports anywhere in a ticket-scoped project, and no budget
//        raised (DOCKER.md §3, §9.2, OD-4, OD-22, OD-24).
//
//        Both used to read `compose.verify.yml` alone. They now read
//        PORT_FREE_FILES / OVERLAY_FILES, which is what the sentences
//        describing them always said.
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

/**
 * The largest single budget compose.yml declares — the ceiling an overlay
 * ADDITION may not exceed.
 *
 * DERIVED from the base file rather than written down, and that is the point:
 * DOCKER.md §3's table IS compose.yml's mem_limits (T-016 reconciled them
 * service by service), so the ceiling moves only when the budget table does.
 * An addition has no base definition to be compared against — which is how a
 * chaos-only sidecar with `mem_limit: 4g` passed both gates — so the rule for
 * one is: declare mem_limit and cpus (DOCKER.md §9.2, "EVERY service"), and do
 * not exceed the largest service the machine is already budgeted for.
 */
let additionCeilingMb: number | null = null;
if (base !== null) {
  for (const svc of Object.values(base)) {
    const mb = memToMb(svc['mem_limit']);
    if (mb !== null && (additionCeilingMb === null || mb > additionCeilingMb)) {
      additionCeilingMb = mb;
    }
  }
}

// --- 3. no host ports, over PORT_FREE_FILES ---------------------------------
let portFreeChecked = 0;
for (const rel of PORT_FREE_FILES) {
  const svcs = servicesOf(rel);
  if (svcs === null) continue; // already reported
  for (const [name, svc] of Object.entries(svcs)) {
    portFreeChecked += 1;
    if ('ports' in svc) {
      failures.push(
        `${rel}: '${name}' declares ports:. A ticket-scoped project publishes no host port ` +
          `and cannot — Docker drops publishing on an internal: true network SILENTLY ` +
          `(OD-4). The line would do nothing while reading as though it worked, and it ` +
          `would start working the day the service gains a second, non-internal network. ` +
          `Use expose:. (The shared kinvara-dev stack is the documented exception and ` +
          `lives in compose.dev.yml, which this rule deliberately does not cover.)`,
      );
    }
  }
}

// --- 4. budgets, over OVERLAY_FILES -----------------------------------------
//
// A SEPARATE LOOP OVER A SEPARATE, NAMED SET. It used to ride on §3's loop and
// skip the base file with `if (rel === BASE_FILE) continue`, so its scope was
// "PORT_FREE_FILES minus one" — a set derived by exclusion, which is readable
// only by tracing control flow and is the shape this whole ticket is about.
// The two rules genuinely cover different sets (compose.dev.yml is exempt from
// §3 and simply unmeasured for §4 — see § Published contract § What is NOT
// claimed), so they get one loop each and each names its own set.
let budgetsChecked = 0;
for (const rel of OVERLAY_FILES) {
  const svcs = servicesOf(rel);
  if (svcs === null || base === null) continue;
  for (const [name, svc] of Object.entries(svcs)) {
    budgetsChecked += 1;
    const baseSvc = base[name];

    if (baseSvc === undefined) {
      // An ADDITION (OD-24). gate:egress-boundary owns its networks; its
      // resource budget is nobody else's.
      for (const key of ['mem_limit', 'cpus'] as const) {
        if (!(key in svc)) {
          failures.push(
            `${rel}: '${name}' is an ADDITION — the name is not in ${BASE_FILE} — and it ` +
              `declares no ${key}. DOCKER.md §9.2: EVERY service declares mem_limit and ` +
              `cpus, because an unbounded container on a 4-core box takes the machine down ` +
              `and every agent in the wave loses its work in progress.`,
          );
        }
      }
      const mb = memToMb(svc['mem_limit']);
      if ('mem_limit' in svc && mb === null) {
        failures.push(`${rel}: '${name}' mem_limit is not a size this gate can compare`);
      } else if (mb !== null && additionCeilingMb !== null && mb > additionCeilingMb) {
        failures.push(
          `${rel}: '${name}' is an ADDITION with mem_limit ${String(mb)} MB, above the ` +
            `largest service ${BASE_FILE} budgets (${String(additionCeilingMb)} MB). ` +
            `DOCKER.md §3's table is what the orchestrator sums before dispatching a wave; ` +
            `a new service bigger than anything in it needs that table amended, not an ` +
            `overlay edit — and a chaos run is when the box is under the MOST pressure.`,
        );
      }
      continue;
    }

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
        failures.push(`${rel}: '${name}' ${key} is not comparable with ${BASE_FILE}'s`);
      } else if (overlay > original) {
        failures.push(
          `${rel}: '${name}' raises ${key} from ${String(original)} to ` +
            `${String(overlay)}. DOCKER.md §3's budget table is what the orchestrator sums ` +
            `before dispatching a wave; an overlay may not escape it — and that is as true ` +
            `of compose.chaos.yml as of compose.verify.yml (OD-24).`,
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
/**
 * The apps this rule covers: every service compose.yml LABELS as built here,
 * UNION every APP an APPLICATION build actually passes.
 *
 * The label set alone is the same narrow scope the §6 checks were found to
 * have (T-034 QA round 2): an overlay service that builds an image and is
 * simply not labelled contributes an app nothing reads. Deriving from both
 * means a new app reaches this rule the moment ANY of the three files builds
 * it, whichever way it was declared.
 */
const appsToCheck = [
  ...new Set<string>([
    ...declaredByLabel,
    ...buildUses.map((u) => (typeof u.args['APP'] === 'string' ? u.args['APP'] : '')),
  ]),
]
  .filter((a) => a !== '')
  .sort();
for (const name of appsToCheck) {
  const appDir = path.join(REPO_ROOT, 'apps', name);
  const pkgPath = path.join(appDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    failures.push(
      `apps/${name}/package.json does not exist, but a compose service builds an image ` +
        `from it (APP=${name})`,
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

// ---------------------------------------------------------------------------
// 6. The image contract itself — over EVERY Dockerfile a service is actually
//    built from, derived in §2 from `build.dockerfile`, never from a constant.
//    See PRIMARY_DOCKERFILE for what this cost when it was a constant.
// ---------------------------------------------------------------------------
for (const [rel, users] of [...dockerfilesInUse].sort(([a], [b]) => a.localeCompare(b))) {
  const text = read(rel);
  if (text === null) continue; // already reported by §2
  const who = `${rel} (built as: ${users.join(', ')})`;

  // --- the stages this file actually ships -----------------------------------
  //
  // THE TARGET IS TAKEN FROM COMPOSE, NOT FROM THE DOCKERFILE, and that is
  // half of the fix rather than a detail (OD-29). `docker/compose.verify.yml`
  // chooses each service's stage; a perfect ancestry walk anchored on the last
  // stage of the file would close OE-7's documented route and leave the one
  // that edits no Dockerfile at all — `safety-gw` moved from `target: runtime`
  // to `target: prod-deps` — wide open. Measured before this fix: exit 0,
  // while the gate PRINTED `compose.verify.yml:safety-gw→prod-deps` in its own
  // summary. `users` carries that `→target`, so the checks below run over the
  // stage compose names and a changed `target:` moves them with it.
  const stages = stagesOf(text);
  // Every label in `users` carries a `→target`, because §2a refuses a `build:`
  // with no `target:` (OD-30/OD-32). There is therefore no last-stage fallback
  // here and no empty string to filter out — the previous version had both,
  // and the fallback was DEAD the moment any sibling service named a target,
  // which is how the last stage of this file came to be checked by nothing.
  const targets = new Set(users.map((u) => u.split('→')[1] ?? '').filter((t) => t !== ''));
  if (targets.size === 0) {
    failures.push(
      `${who}: no build.target resolved for this file — this gate would then check the ` +
        `image contract of nothing while reporting on the file.`,
    );
    continue;
  }
  if (stages.length === 0) {
    failures.push(
      `${who}: no FROM instruction — this gate would then check the image contract of ` +
        `nothing while reporting on the file.`,
    );
    continue;
  }

  const resolved: { readonly target: string; readonly chain: readonly Stage[] }[] = [];
  for (const target of targets) {
    const chain = ancestryOf(stages, target);
    if (chain === null) {
      failures.push(`${who}: compose builds target '${target}', which is not a stage in this file`);
      continue;
    }
    resolved.push({ target, chain });
    stagesChecked.push(`${rel} ${target}  <-  ${chain.map((st) => st.name).join(' -> ')}`);
  }

  // --- the image contract, resolved the way Docker resolves it ---------------
  for (const { target, chain } of resolved) {
    const via = chain.map((s) => s.name).join(' -> ');
    // Name only the services that build THIS target. `who` lists all five, and
    // a failure that reads the same whichever service caused it makes the
    // OD-29 route — one word changed on `safety-gw` alone — look like a
    // whole-file problem.
    // OD-32(3): this used to read `u.includes('→') ? u.split('→')[1] : target`,
    // so a TARGET-LESS service matched EVERY resolved target and the failure
    // text asserted `compose.verify.yml:safety-gw` was built as `runtime` when
    // it was not. A missing target is now refused outright in §2a, and this
    // filter no longer has a branch that treats one as a wildcard.
    const mine = users.filter((u) => u.split('→')[1] === target);
    const where = `${rel} stage '${target}' (ancestry ${via}; built as ${mine.join(', ')})`;

    const entrypoint = resolveSetting(chain, 'ENTRYPOINT');
    if (entrypoint === null) {
      failures.push(
        `${where}: no ENTRYPOINT resolves for this stage. Its ancestry sets none, so the ` +
          `base image's own entrypoint ships — for node:*-alpine that is ` +
          `docker-entrypoint.sh, a shell, at PID 1.`,
      );
    } else {
      // EXEC FORM IS JSON, AND ONLY JSON (OD-31). `startsWith('[')` said yes to
      // ENTRYPOINT ['node', '/srv/…/entrypoint.mjs'] — single quotes, which is
      // not JSON — and Docker reads that as SHELL form: measured on a built
      // image, `Entrypoint=["/bin/sh","-c","['/bin/sleep', '1']"]`, i.e. the
      // exact /bin/sh at PID 1 this check exists to refuse. BuildKit does warn
      // (JSONArgsRecommended), so this one is not silent — but a warning in a
      // build log is not a gate.
      let parsed: unknown;
      try {
        parsed = JSON.parse(entrypoint.value);
      } catch {
        parsed = undefined;
      }
      if (!Array.isArray(parsed)) {
        failures.push(
          `${where}: the ENTRYPOINT that wins is shell form, set in stage ` +
            `'${entrypoint.stage}': ${entrypoint.value}. Exec form is a JSON array and ` +
            `Docker parses it as JSON: single quotes, a trailing comma or an unquoted ` +
            `token all fall back to shell form, which puts /bin/sh at PID 1, and sh does ` +
            `not forward SIGTERM to its child: 'docker stop' would wait out the whole ` +
            `stop_grace_period and then SIGKILL the app mid-request.`,
        );
      } else if (parsed.length === 0) {
        failures.push(
          `${where}: ENTRYPOINT [] in stage '${entrypoint.stage}' RESETS the entrypoint. ` +
            `Docker treats an empty array as clearing it, so the image has none.`,
        );
      }
    }

    const healthcheck = resolveSetting(chain, 'HEALTHCHECK');
    if (healthcheck === null) {
      failures.push(
        `${where}: no HEALTHCHECK resolves for this stage. It belongs in the image, not ` +
          `only in compose, so it travels with what ships (T-003's ECS task definitions ` +
          `read it from here).`,
      );
    } else if (/^NONE\b/i.test(healthcheck.value)) {
      failures.push(
        `${where}: the HEALTHCHECK that wins is 'HEALTHCHECK NONE', set in stage ` +
          `'${healthcheck.stage}'. That is not a healthcheck: Docker records ` +
          `Healthcheck.Test = ["NONE"] and the container is never probed at all. A check ` +
          `that only asked whether the file contains the word HEALTHCHECK would pass this.`,
      );
    }

    const user = resolveSetting(chain, 'USER');
    if (user === null) {
      failures.push(
        `${where}: no USER resolves for this stage — the image would run as root. A USER ` +
          `in a stage this one does not inherit from does not reach it.`,
      );
    } else {
      const uid = user.value.split(/\s+/)[0] ?? '';
      if (/^(0|root)(:|$)/.test(uid)) {
        failures.push(
          `${where}: the USER that wins is root (${uid}), set in stage '${user.stage}'. ` +
            `A later USER overrides an earlier one, so switching to root for an apk add ` +
            `or a chown and not switching back ships a root image — and BuildKit says ` +
            `nothing about it (OD-20: the warning count does not move).`,
        );
      }
      if (/^(1000|node)(:|$)/.test(uid)) {
        failures.push(
          `${where}: the USER that wins is ${uid}, set in stage '${user.stage}'. uid 1000 ` +
            `is the toolbox's uid and this host's repo owner, so "runs as a non-root user" ` +
            `and "happens to match the bind mount" become indistinguishable and a ` +
            `permission defect surfaces first in ECS.`,
        );
      }
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
  //
  // Whether this file needs the guard at all is `buildsFromWorkspace`, hoisted
  // to the top of this file because §1b asks the same question of the same
  // files. See its docblock for why the condition is deliberately wide.
  if (buildsFromWorkspace(text)) {
    // The same target set the image-contract checks above resolved. This guard
    // check is deliberately STAGE-LOCAL and not an ancestry walk: it asks
    // whether the tree that ships was assertedly clean AFTER THE LAST COPY, and
    // a child stage that copies anything in has copied it in after its parent's
    // guard ran. The two questions are different, and answering the second one
    // with the first is the mistake that shipped 112.2 MB of devDependencies.
    for (const { target, chain } of resolved) {
      const stage = chain[chain.length - 1];
      if (stage === undefined) continue; // ancestryOf never returns an empty chain
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
  `  pins (from .tool-versions)      ` +
    [...pinValues].map(([arg, v]) => `${arg}=${v}`).join('  ') +
    `  — both, in every file below (OD-21)`,
);
console.log(
  `  application services (anchor)   ${String(appServices.length)}: ${appServices.join(' ')}` +
    `  (from ${APPS_DIR}/*/package.json — outside docker/, OD-38)`,
);
console.log(
  `  services labelled built-by ${BUILT_BY}  ${String(declaredByLabel.length)}: ${declaredByLabel.join(' ')}` +
    `  (membership asserted against the anchor above, not merely non-empty)`,
);
console.log(
  `  image contract asserted over    ${String(protectedServices.size)}: ` +
    `${[...protectedServices].sort().join(' ')}` +
    `  (no composed file may declare a NON-application build for one — OD-36)`,
);
console.log(
  `  files read for build: (§2a)     ${String(BUILD_DECLARING_FILES.length)}: ${BUILD_DECLARING_FILES.join(' ')}`,
);
console.log(
  `  composed set derived from       scripts/svc compose_files_for()  ` +
    composed.files.map((f) => `${f.rel}[${f.role}]`).join(' ') +
    `  (OD-37 — not a list, not a glob)`,
);
console.log(
  `  application builds (§1b/1c/§6)  ${String(buildUses.length)}` +
    `  (derived per build: pnpm workspace, or an APP build arg)`,
);
console.log(`  builds read (target rule)       ${String(allBuilds.length)}`);
for (const b of [...allBuilds].sort((x, y) => x.where.localeCompare(y.where))) {
  console.log(`    ${b.where.padEnd(34)} ${b.dockerfile}`);
}
console.log(
  `  files held to the no-ports rule ${String(PORT_FREE_FILES.length)}: ${PORT_FREE_FILES.join(' ')}` +
    `  (compose.dev.yml is the documented exception — T-016 § contract 6)`,
);
console.log(`  services read for ports         ${String(portFreeChecked)}`);
console.log(
  `  services read for budgets       ${String(budgetsChecked)}: ${OVERLAY_FILES.join(' ')}`,
);
console.log(
  `  addition mem_limit ceiling      ` +
    `${additionCeilingMb === null ? '(none — compose.yml declared none)' : `${String(additionCeilingMb)} MB, derived from ${BASE_FILE}`}`,
);
console.log(`  dockerfiles read (the §2a set)  ${String(dockerfilesInUse.size)}`);
for (const [df, users] of [...dockerfilesInUse].sort(([a], [b]) => a.localeCompare(b))) {
  // Print WHO, not just how many. `dockerfiles checked 1` was printed by the
  // version that had enumerated the wrong set entirely, and it read as
  // coverage (QA, round 2).
  console.log(`    ${df}  <-  ${users.join(', ')}`);
}
console.log(`  overlay builds read (§1c, §2a)  ${String(buildUses.length)}`);
console.log(`  stages resolved (§6, last-wins) ${String(stagesChecked.length)}`);
for (const line of [...stagesChecked].sort()) console.log(`    ${line}`);
console.log(`  apps read                       ${String(appsChecked)}`);
console.log(
  `  apps with src/                  ${String(withSource)}` +
    (withSource === 0
      ? '  (all five still T-001 placeholders — the images run the reference entrypoint)'
      : ''),
);

finish('gate:app-images', failures);
