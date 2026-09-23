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
import { REPO_ROOT, finish, toolVersions } from './lib/run.ts';
import { composedFiles } from './lib/composed-files.ts';
import { parseCompose } from './lib/compose-parse.ts';
import ts from 'typescript';

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

/**
 * Files whose two readings — one lexer (`yaml`'s, which targets YAML 1.2 syntax;
 * a lone CR, where it departs from it, is refused, A11), the 1.2 and the 1.1
 * SCHEMA — A3 found equal (OD-39): value by value and by kind, so a 1.1 `Date`
 * never equals a 1.2 string (OD-46, case 128); key order is not compared
 * (OD-48). It says nothing about a 1.1/1.2 SYNTAX difference, which both
 * readings tokenise identically (A10, A13).
 */
const schemasAgreedFiles: string[] = [];
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
    // OD-39. This used to be `parseYaml(text)` — yaml@2.8.1's defaults, which
    // do not resolve `<<` merge keys. Compose does resolve them (measured,
    // `T-037` § Evidence R2 — and compose is NEITHER YAML version), so a build:
    // merged in from an x- fragment was invisible to every rule below while
    // compose built it: exit 0, gate:pr 9/9, and this file's own summary still
    // printing the clean-tree `builds read 7`. `lib/compose-parse.ts` is now
    // the ONE place any gate reads compose; it resolves `<<`, refuses a file
    // whose 1.1- and 1.2-SCHEMA readings its A3 comparison finds different
    // (value by value and by kind, so a 1.1 `Date` counts, OD-46; key order is
    // not compared, OD-48; one lexer — it cannot see a SYNTAX difference,
    // T-130 rework 1), refuses a second document (OD-41), the three YAML 1.1
    // line breaks (OD-43), a lone CR and text that is not UTF-8 (OD-45), the
    // `\/` escape (OD-44) and two SCALAR keys naming one property (OD-48; an
    // alias or collection key is not modelled, T-131 QA-F1), and lists
    // every member MEASURED in its header — not an exhaustive list.
    const { doc, problems, schemasAgreed } = parseCompose(rel, text);
    failures.push(...problems);
    if (schemasAgreed) schemasAgreedFiles.push(rel);
    if (doc === null) return null;
    if (!isRecord(doc['services'])) {
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
  // (deleting the label AND the whole service) is probed by case 66 and is
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
  /**
   * The build context, repo-root-relative, resolved against the compose file's
   * directory as Docker does. §7 needs it to map the ENTRYPOINT's in-image
   * script back to the repository file a COPY put there (T-180).
   */
  readonly context: string;
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
 * Every EXEC-FORM ENTRYPOINT §6 resolved for an application stage, with the
 * stage chain it was resolved over. §7 derives the file it reads GROUP_DRAIN_MS
 * from THESE, not from a fixed path (T-180, closing QA-7's `g12` on T-179: an
 * ENTRYPOINT repointed at a copy of the entrypoint escaped a constant path).
 */
const entrypointsResolved: {
  readonly dockerfile: string;
  readonly target: string;
  readonly argv: readonly unknown[];
  readonly chain: readonly Stage[];
}[] = [];

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
      context: path.normalize(path.join(path.dirname(rel), ctx)),
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
      } else {
        entrypointsResolved.push({ dockerfile: rel, target, argv: parsed, chain });
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

// ---------------------------------------------------------------------------
// 7. EVERY APPLICATION SERVICE'S stop_grace_period COVERS PID 1'S GROUP WAIT
//    (T-179, from tech-lead's TL-1 on T-151).
//
//    THE PROPERTY IS A RELATIONSHIP BETWEEN TWO FILES, NOT A NUMBER IN ONE.
//    The file each application stage's ENTRYPOINT runs —
//    `docker/app-runtime/entrypoint.mjs` in every image `docker/app.Dockerfile`
//    builds today — is PID 1, and after it forwards SIGTERM and its direct
//    child exits it waits for the application's process group to empty, until
//    a DEADLINE FIXED AT THE FIRST FORWARDED SIGNAL: first signal +
//    GROUP_DRAIN_MS (T-180). Docker SIGKILLs the container
//    `stop_grace_period` after the SIGTERM. If the grace is not longer than
//    that deadline, a drain still inside the wait is killed and the container
//    reports 137 — a FALSE CRASH SIGNAL to compose, T-003's ECS health and
//    T-009's paging (OD-196). At main 39f01f2 `web` and `admin` declared no
//    grace at all, so they took compose's 10 s default against a 25 s wait:
//    15 s short, with this gate green.
//
//    UNTIL T-180 THE DEADLINE COUNTED FROM THE DIRECT CHILD'S EXIT
//    (`waitForGroup` computed it from child.on('exit')), so this relation held
//    between two numbers without bounding the real wait: tech-lead measured an
//    app that drained 8 s and left a helper in its group SIGKILLed at a 30 s
//    grace (137) with this gate green (TL-A1 on T-179). Counting from the
//    first signal makes the relation the property; the relation itself is
//    unchanged. Red-before in the real image: state/EP-1/T-180.md § Evidence.
//
//    So the floor is READ, not restated, and T-180 widened what is read:
//      * the FILE is derived from WHAT PID 1 ACTUALLY RUNS, FOR EACH
//        APPLICATION SERVICE, IN EACH COMPOSED FILE (T-182) — resolved from
//        the image ENTRYPOINT/CMD §6 resolved for the stage compose builds,
//        compose's own `entrypoint:`/`command:`, `init:`, `working_dir:`, the
//        NODE_OPTIONS in effect, anything mounted over the resolved path, and
//        the COPY/ADD that puts the script there plus anything later in the
//        chain that rewrites it — and either mapped back to a repository file
//        or REFUSED. §7b's docblock below lists those nine inputs, each with
//        the case that falsifies it — and, since T-182's rework 1, the two
//        rules that answer the question the nine do not: which compose keys an
//        application service may declare at all (§7c, an ALLOW-LIST) and which
//        environment variable NAMES may reach PID 1 (§7d, a DENY-LIST over the
//        loader namespaces MEASURED to be in that process). `pid: host` and
//        `LD_PRELOAD` were green through the nine and are refused by those
//        (qa-verification QA-1, cases 193-206); `OPENSSL_CONF` was green
//        through those four namespaces and is refused since rework 2, which
//        widened §7d by measurement and named `T-183` as the ticket that
//        replaces the deny-list with an allow-list (OE-44, cases 207-211).
//        T-180 derived it from the image ENTRYPOINT of
//        each application STAGE, which a compose `entrypoint:` replaces
//        silently: measured GATE PASS with a 60 s copy of the entrypoint
//        really running as `core`'s PID 1 (qa-verification on T-180, QA-F3);
//      * the CONSTANT is one numeric literal, READ FROM THE DECLARATION THE
//        CODE USES rather than from a line a text match found (T-182's D13:
//        until then the value came from a line-anchored regex, so the matched
//        line could be a COMMENT while the real declaration said 60 000 —
//        measured, gate green, case 189). Raising it past a declared grace
//        reds this gate (case 148);
//      * and its ONE USE is held: GROUP_DRAIN_MS is DECLARED exactly once in
//        the file's syntax tree (a same-named let/var/const in an inner scope
//        would shadow it — cases 166-168, T-180 rework 1) and USED at exactly
//        one place, the statement `deadline = signalledAt + GROUP_DRAIN_MS;`,
//        counted as identifiers in the syntax tree so comments and strings are
//        not uses. A multiplier or an environment override there, a second read,
//        or the deadline counted from Date.now() reds this gate (cases
//        156-159; QA-7's `g02`/`g03`), and a mention in a comment or a string
//        does not (case 160).
//    A literal `30s` checked against a literal `30s` would stay green the day
//    someone raised GROUP_DRAIN_MS. The two numbers live in two files owned for
//    two different reasons, which is PROTOCOL §5.1's "anchor one of them
//    outside".
//
//    WHAT THE USE-SITE CHECK DOES NOT HOLD (T-180, stated rather than chased):
//    WHERE that statement sits — the same text moved into child.on('exit')
//    would count from the child's exit again with this gate green — nor what
//    waitForGroup then does with `deadline` or `signalledAt`. It holds the one
//    statement that fixes the deadline. The origin itself is held by
//    scripts/negative-tests/entrypoint-lifecycle.sh, which RUNS the file
//    (case L02 is tech-lead's probe shape; it is red at 36a41d1).
//
//    EXIT_MARGIN_MS IS A CHOSEN FLOOR, NOT A MEASUREMENT. It covers what comes
//    after the deadline: one poll (100 ms), the process exit and docker
//    noticing — tech-lead measured about 0.25 s for those (one run, this host,
//    TL-A1 on T-179). 5 s is the headroom T-151 § contract §2 published. Since
//    T-180 it no longer has to absorb the app's own drain time, because the
//    deadline no longer starts after it. It does not bound the APPLICATION: an
//    app still draining at the grace is docker's to SIGKILL, and 137 is then
//    true. Lowering the margin is a decision to make in this file, in review —
//    not a thing an edit elsewhere does.
//
//    WHICH SERVICES ARE "APPLICATION SERVICES" IS DERIVED, NEVER LISTED — a
//    hand list of five names is T-005's Deviation 6, and a sixth service would
//    silently take 10 s. A service is held to this rule when ANY of these holds,
//    in ANY composed file (the OD-37 set, from scripts/svc):
//      (a) it is in the image-contract set above (`protectedServices`: an
//          apps/* directory, anchored outside docker/ per OD-38, or the
//          io.kinvara.built-by label);
//      (b) some composed file declares an APPLICATION BUILD for it (the same
//          `isApplicationBuild` §2 uses — pnpm workspace or an APP arg), i.e.
//          it is built from the application Dockerfile and so runs this
//          entrypoint;
//      (c) its `image:` is one that a service in (a) or (b) declares — a
//          second container running `kinvara/worker:dev` runs the same PID 1
//          and has the same wait, whether or not anybody labelled it (case 145).
//          COMPARED AS LITERAL TEXT (QA-7): the same image spelled differently —
//          `docker.io/kinvara/worker:dev`, or `${VAR:-kinvara/worker:dev}` —
//          is not recognised. A copied image line is caught; a re-spelled one
//          is not.
//    Services outside all three are NOT held to it, deliberately: postgres
//    (10s), valkey, fake-telephony and hibp-fake (5s) declare short graces on
//    purpose and run no entrypoint.mjs. Nothing names them here.
//
//    OVER-APPROXIMATION, stated: a service that runs an application image for
//    some other purpose (a one-shot migrator, say) is held to the floor too.
//    That is visible and arguable; the other direction is silent.
//
//    HOW THE EFFECTIVE GRACE IS JUDGED ACROSS FILES. Compose merges the base
//    file with whichever overlays a project gets, and an overlay can be applied
//    without any other. So: (i) every declaration of `stop_grace_period` for an
//    application service, in EVERY composed file, must meet the floor — an
//    overlay may raise it, never lower it; and (ii) a service the base file
//    declares must declare it THERE (the base is always applied), while a
//    service the base does not declare must declare it in EVERY file that adds
//    it, because each of those can be the only one applied.
//
//    WHAT IS NOT CLAIMED. That docker enforces what compose resolves: this gate
//    reads source and starts nothing. Compose's own resolution was measured
//    against this parser in state/EP-1/T-179.md (`docker compose config`, no
//    container). Docker's StopTimeout is whole seconds, so the declared value is
//    FLOORED to a whole second before comparing — the conservative direction
//    whether compose truncates or rounds. A GROUP_DRAIN_MS that is not ONE
//    TOP-LEVEL `const` whose initializer is one numeric literal is REFUSED, not
//    guessed at — an expression (case 151), a `let` (case 191), a second
//    declaration anywhere in the syntax tree (cases 166-168). A second,
//    differently named constant doing the same job is a construction this gate
//    does not model.
//
//    THAT FAMILY OF BOUNDS IS CLOSED (T-182), AND THESE ARE THE FOUR THINGS
//    LEFT — the residue, at its measured width, each a construction rather
//    than a Tuesday (PROTOCOL §5.1):
//      * a RUN that rewrites the script WITHOUT NAMING IT: `runWritesPath`
//        reads the in-image path, the basename as a token, and a glob in the
//        script's own directory that matches it, and nothing else. `cd
//        /srv/kinvara/app-runtime && sed -i s/25/60/ $(ls)` is not caught;
//      * a PID 1 decided inside the BASE image rather than in this repository.
//        §6 refuses a stage whose ancestry sets no ENTRYPOINT, and §7 refuses
//        anything but `node <script>`, so what is left is a base image whose
//        own `node` on PATH is not node. Nothing here reads the base image;
//      * ECS. A task definition's `entryPoint`, `command`, `environment` or
//        `stopTimeout` is not read here at all — T-003's obligation, and the
//        reason T-182 was sequenced before it;
//      * a flag typed at a shell (`docker run --entrypoint …`). This gate
//        reads composed files, and evidence comes from a composed project
//        (DOCKER.md §5), so a one-off invocation is outside it.
// ---------------------------------------------------------------------------
const EXIT_MARGIN_MS = 5_000;
/**
 * THE ONE STATEMENT THAT MAY READ GROUP_DRAIN_MS (T-180). The entrypoint fixes
 * its group-wait deadline when the FIRST signal is forwarded, and this is the
 * only place the constant may be used. Holding its exact shape is what closes
 * QA-7's `g02` (a multiplier at the use site) and `g03` (an environment
 * override there) on T-179: before T-180 this gate read the declaration and
 * nothing else, so either one changed the real wait with the gate green.
 */
const DEADLINE_STATEMENT = 'deadline = signalledAt + GROUP_DRAIN_MS;';

/** Shell-ish tokens, quotes kept together; `unquote` then strips one layer. */
const tokenise = (s: string): string[] => s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
const unquote = (s: string): string =>
  /^".*"$/s.test(s) ? s.slice(1, -1) : /^'.*'$/s.test(s) ? s.slice(1, -1) : s;
const escapeRe = (s: string): string => s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `*` and `?` as a shell glob does, within one path segment. */
const globMatches = (pattern: string, name: string): boolean =>
  new RegExp(
    `^${pattern
      .split('')
      .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : escapeRe(c)))
      .join('')}$`,
  ).test(name);
/**
 * `docker build` EXTRACTS a local archive an ADD names, over whatever is
 * already at the destination, and it fetches a URL. Neither content is in this
 * repository in a form this gate can read, so a covering ADD of either is a
 * REFUSAL rather than a mapping (T-182; T-180 § contract 4's fourth family
 * member, which was declared and never planted).
 */
const ADD_ARCHIVE = /\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst)$/i;
const ADD_URL = /^(?:https?|git|ssh):\/\//i;

/**
 * Does this RUN write the file at `imagePath`? It is read, not guessed at: the
 * line NAMES the path, names its basename as a token, or names a glob in the
 * script's own directory that matches it. A RUN that rewrites the file without
 * naming it in any of those three ways is a construction this does not model,
 * and § Published contract says so (T-182, closing T-180 § contract 4's third
 * family member at that width).
 */
function runWritesPath(line: string, imagePath: string): boolean {
  const body = line.replace(/^RUN\s+/i, '').replace(/^--mount=\S+\s+/, '');
  const base = path.posix.basename(imagePath);
  const dir = path.posix.dirname(imagePath);
  if (body.includes(imagePath)) return true;
  if (new RegExp(`(^|[\\s'"/=])${escapeRe(base)}([\\s'"]|$)`).test(body)) return true;
  for (const tok of tokenise(body).map(unquote)) {
    if (!/[*?]/.test(tok)) continue;
    const full = tok.startsWith('/') ? tok : path.posix.join(dir, tok);
    if (path.posix.dirname(full) === dir && globMatches(path.posix.basename(full), base)) {
      return true;
    }
  }
  return false;
}

/**
 * The WORKDIR in effect at the end of `chain`, and where a COPY/ADD put
 * `imagePath` — plus, since T-182, a refusal when a LATER instruction in the
 * chain writes that path again: an ADD of an archive or a URL (whose content
 * this gate cannot read) and a RUN that names the file (whose effect it cannot
 * read either). `startWorkdir` lets the caller resolve a relative ENTRYPOINT
 * against the same WORKDIR walk this function does.
 */
function copySourceOf(
  chain: readonly Stage[],
  context: string,
  imagePath: string,
): { readonly file: string } | { readonly why: string } {
  let workdir = '/';
  let last: { readonly file: string } | { readonly why: string } | null = null;
  /** Index into `flat` of the instruction `last` came from. */
  let lastAt = -1;
  const flat: { readonly stage: Stage; readonly line: string }[] = [];
  for (const stage of chain) for (const line of stage.lines) flat.push({ stage, line });
  const abs = (p: string): string => path.posix.resolve(workdir, p);
  for (const [at, entry] of flat.entries()) {
    {
      const stage = entry.stage;
      const line = entry.line;
      const wd = /^WORKDIR\s+(.+)$/i.exec(line);
      if (wd !== null) {
        workdir = abs((wd[1] ?? '').trim());
        continue;
      }
      const cp = /^(?:COPY|ADD)\s+(.*)$/i.exec(line);
      if (cp === null) continue;
      const isAdd = /^ADD\b/i.test(line);
      let rest = (cp[1] ?? '').trim();
      const flags: string[] = [];
      for (let m = /^(--\S+)\s+(.*)$/.exec(rest); m !== null; m = /^(--\S+)\s+(.*)$/.exec(rest)) {
        flags.push(m[1] ?? '');
        rest = m[2] ?? '';
      }
      let parts: string[];
      if (rest.startsWith('[')) {
        let j: unknown;
        try {
          j = JSON.parse(rest);
        } catch {
          j = null;
        }
        parts = Array.isArray(j) ? j.map((x) => String(x)) : [];
      } else {
        parts = rest.split(/\s+/).filter((x) => x !== '');
      }
      if (parts.length < 2) continue;
      const dest = parts[parts.length - 1] ?? '';
      const srcs = parts.slice(0, -1);
      const destAbs = abs(dest);
      const destIsDir = dest.endsWith('/') || srcs.length > 1;
      const fromStage = flags.some((f) => /^--from=/i.test(f));
      for (const src of srcs) {
        const underDest = imagePath.startsWith(`${destAbs}/`);
        const asFile = destIsDir ? `${destAbs}/${path.posix.basename(src)}` : destAbs;
        const covers = underDest || imagePath === asFile || imagePath === destAbs;
        if (!covers) continue;
        if (fromStage) {
          last = { why: `'${line}' in stage '${stage.name}' puts it there FROM ANOTHER STAGE` };
          lastAt = at;
          continue;
        }
        if (isAdd && (ADD_ARCHIVE.test(src) || ADD_URL.test(src))) {
          last = {
            why:
              `'${line}' in stage '${stage.name}' ADDs ${ADD_URL.test(src) ? 'a URL' : 'an ARCHIVE'}` +
              ` over it, and docker ${ADD_URL.test(src) ? 'fetches' : 'extracts'} that content` +
              ` into the image: this gate cannot read what PID 1 would then be`,
          };
          lastAt = at;
          continue;
        }
        if (/[$*?[\]]/.test(src + dest)) {
          last = {
            why: `'${line}' in stage '${stage.name}' puts it there through a variable or a glob`,
          };
          lastAt = at;
          continue;
        }
        const srcRepo = path.normalize(path.join(context, src));
        if (srcRepo.startsWith('..') || path.isAbsolute(srcRepo)) {
          last = { why: `'${line}' copies from outside the repository` };
          lastAt = at;
          continue;
        }
        const srcAbs = path.join(REPO_ROOT, srcRepo);
        const srcIsDir = fs.existsSync(srcAbs) && fs.statSync(srcAbs).isDirectory();
        if (srcIsDir && underDest) {
          last = { file: path.join(srcRepo, imagePath.slice(destAbs.length + 1)) };
          lastAt = at;
        } else if (!srcIsDir && imagePath === asFile) {
          last = { file: srcRepo };
          lastAt = at;
        }
      }
    }
  }
  if (last !== null && 'file' in last) {
    for (const { line } of flat.slice(lastAt + 1)) {
      if (/^RUN\b/i.test(line) && runWritesPath(line, imagePath)) {
        return {
          why:
            `'${line}' runs AFTER the COPY that puts it there and names it, so what PID 1 ` +
            `runs is whatever that RUN left behind — which is not in this repository`,
        };
      }
    }
  }
  return last ?? { why: 'no COPY or ADD in the stage chain puts it there' };
}

// --- 7a. WHICH SERVICES ARE APPLICATION SERVICES (derived, T-179) ----------
//     Moved above the PID-1 resolution by T-182, because that resolution is
//     now per SERVICE rather than per Dockerfile stage: the question "what
//     does PID 1 run" has no answer until you know whose PID 1.

/** file -> its parsed services, for every composed file that parsed. */
const composedServices: {
  readonly rel: string;
  readonly svcs: Record<string, Record<string, unknown>>;
}[] = [];
for (const f of composed.files) {
  const svcs = servicesOf(f.rel);
  if (svcs !== null) composedServices.push({ rel: f.rel, svcs });
}
const imageOf = (svcs: Record<string, Record<string, unknown>>, name: string): string | null => {
  const own = svcs[name]?.['image'];
  if (typeof own === 'string' && own.trim() !== '') return own.trim();
  const fromBase = base?.[name]?.['image'];
  return typeof fromBase === 'string' && fromBase.trim() !== '' ? fromBase.trim() : null;
};
/** service -> why it is an application service (the derivation, printed). */
const graceWhy = new Map<string, Set<string>>();
const markApp = (name: string, why: string): void => {
  graceWhy.set(name, (graceWhy.get(name) ?? new Set<string>()).add(why));
};
const appImages = new Set<string>();
for (const { svcs } of composedServices) {
  for (const name of Object.keys(svcs)) {
    if (protectedServices.has(name)) {
      markApp(name, 'contract-set');
      const img = imageOf(svcs, name);
      if (img !== null) appImages.add(img);
    }
  }
}
for (const u of buildUses) {
  markApp(u.service, 'app-build');
  const svcs = composedServices.find((c) => c.rel === u.file)?.svcs;
  const img = svcs === undefined ? null : imageOf(svcs, u.service);
  if (img !== null) appImages.add(img);
}
for (const { svcs } of composedServices) {
  for (const name of Object.keys(svcs)) {
    const img = imageOf(svcs, name);
    if (img !== null && appImages.has(img)) markApp(name, `runs ${img}`);
  }
}

// ---------------------------------------------------------------------------
// 7b. WHAT PID 1 ACTUALLY RUNS, FOR EACH APPLICATION SERVICE (T-182)
//
//     ONE READING, NOT A RULE PER ROUTE. Until T-182 this rule read the IMAGE
//     ENTRYPOINT of each application STAGE and called the result "PID 1". A
//     container's PID 1 is not decided there alone, and qa-verification
//     measured SEVEN ways to decide it that the stage's ENTRYPOINT does not
//     mention — a compose `entrypoint:`, a `volumes:` mount over the script, a
//     `NODE_OPTIONS` preload (measured RUNNING INSIDE PID 1), a node flag
//     whose value is a separate argument, a RUN that rewrites the script after
//     its COPY, an ADDed archive, and `stop_signal:`, which decides whether
//     PID 1 is signalled at all. Seven checks for seven routes would have left
//     the eighth open, so what this does instead is RESOLVE the process:
//
//       for each application service, in each composed file that declares it,
//       take every input that can change what PID 1 executes, resolve them the
//       way docker and compose resolve them, and either arrive at ONE
//       REPOSITORY FILE this gate then reads GROUP_DRAIN_MS out of — or REFUSE.
//
//     THE INPUTS IT READS, and this list is the claim (§ Published contract
//     names the case that falsifies each):
//       (1) the image's resolved ENTRYPOINT and CMD — §6, last-wins along the
//           stage ancestry, for the stage COMPOSE builds for this service (or,
//           for a service that only runs an application `image:`, the stage
//           whose build produces that image);
//       (2) compose `entrypoint:` and `command:`, which override (1). A STRING
//           there is shell form, so /bin/sh becomes PID 1: refused;
//       (3) `init: true`, which makes docker-init PID 1 and this whole
//           resolution false: refused;
//       (4) the node argv — flags are read, not skipped: a flag that makes node
//           LOAD CODE (--import/--require/-r/--loader/--env-file/-e …) is
//           refused, a flag that takes a SEPARATE VALUE cannot be mistaken for
//           the script because any flag not on the inert list is refused;
//       (5) `NODE_OPTIONS`, from the image's own ENV and from compose
//           `environment:` — a preload there runs code in PID 1 (measured);
//           `env_file:` is refused because this gate does not read env files;
//       (6) `working_dir:`, which moves the WORKDIR a relative script resolves
//           against;
//       (7) anything MOUNTED over the resolved path — `volumes:`, `tmpfs:`,
//           `configs:`, `secrets:` — because the file in the image is then not
//           the file this gate read;
//       (8) `stop_signal:`, because PID 1 forwards SIGTERM and SIGINT and
//           nothing else, so any other stop signal means no forwarding, no
//           drain and a SIGKILL at the grace (measured by qa-verification on
//           T-180: `stop_signal: SIGQUIT` -> ExitCode=137 at 30.13 s);
//       (9) the last COPY/ADD that puts the script there, and any later
//           instruction in the stage chain that writes it again (an ADDed
//           archive or URL, or a RUN that names it).
//
//     THE NINE ABOVE ANSWER ONE QUESTION — "WHICH FILE DOES NODE RUN". They
//     are a resolution and every step either resolves or refuses, so a new
//     spelling of "something else is at that path" lands in (7) and a new
//     spelling of "node is started differently" lands in (2)/(4): the EIGHTH
//     route this ticket planted — a compose `configs:` entry whose `target:`
//     is the script, a key nobody in T-180's family named — is refused by (7)
//     without a rule of its own, which is the property that shape is for.
//
//     WHAT THEY DO NOT ANSWER IS A SECOND QUESTION: "WHAT IS PID 1, AND WHAT
//     CODE IS LOADED INTO IT." `init:` was always in that class (3);
//     qa-verification then reached the identical condition through `pid:` and
//     `LD_PRELOAD`, both invisible in all nine and both GREEN (QA-1). The two
//     halves of that class are NOT the same shape, and rework 2 was cut because
//     rework 1's text said they were:
//
//       (10) §7c — AN ALLOW-LIST, and it holds. An application service may
//            declare only compose keys this gate has classified as MODELLED or
//            as NEUTRAL (with the argument written beside each). Anything else
//            is REFUSED, so a tenth KEY is impossible rather than uncaught.
//            Independently attacked by the orchestrator with `userns_mode:`,
//            a key nobody in this family had named: exit=1, GATE FAIL, 11 of 14
//            (T-182 § Rework 2).
//       (11) §7d — A DENY-LIST, and it is not the allow-list's twin. A variable
//            in a MEASURED loader namespace (`LD_*`/`DYLD_*` per ld.so(8),
//            `NODE_*` per node(1), `OPENSSL_*` for the OpenSSL 3.5.7 node links
//            statically), or one of [`PATH` `SSL_CERT_FILE` `SSL_CERT_DIR`
//            `CTLOG_FILE`], is REFUSED, from compose `environment:` and from
//            the image's own ENV. NODE_OPTIONS (read, token by token) and
//            NODE_ENV (loads nothing) are admitted. A NAME OUTSIDE THAT LIST IS
//            ADMITTED WITHOUT BEING READ: rework 1 enumerated four namespaces
//            and called the class closed, and the orchestrator then defeated it
//            with `OPENSSL_CONF` inside `core`'s own `environment:` block —
//            exit=0, GATE PASS, `14 of 14` printed as resolved (OE-44). Rework 2
//            WIDENED the list by measuring which names actually load code into
//            PID 1 in these images (§7d's docblock has every measurement) and
//            states the shape honestly rather than claiming the class is shut.
//            **`T-183` is the successor that ends it: the environment
//            allow-list, anchored to a checked per-app manifest.**
//
//     So the fail-closed claim, at the width it actually holds: an input that
//     changes what PID 1 RUNS is refused by the resolution; a compose KEY that
//     changes what PID 1 IS is refused unless it has been classified here; and
//     an ENVIRONMENT VARIABLE that changes what PID 1 is, or loads code into
//     it, is refused if its name is in a measured loader namespace — and is
//     NOT read at all if it is not. § Published contract §3's residue lists
//     what else is out of reach: a RUN that rewrites the file without naming
//     it, anything decided inside the application image's own base image, ECS,
//     a flag typed at a shell, a hazard in the VALUE of an allow-listed key,
//     and — since rework 2 — every environment variable name outside §7d's
//     measured list.
// ---------------------------------------------------------------------------

/** The image's resolved ENTRYPOINT argv and stage chain, per (dockerfile, target). */
const stageOfBuild = new Map<
  string,
  { readonly argv: readonly string[]; readonly chain: readonly Stage[] }
>();
const stageKey = (df: string, target: string): string => `${df}\u0000${target}`;
for (const ep of entrypointsResolved) {
  stageOfBuild.set(stageKey(ep.dockerfile, ep.target), {
    argv: ep.argv.map((a) => String(a)),
    chain: ep.chain,
  });
}
/** service -> a build declared for it, and image text -> a build that produces it. */
const buildOfService = new Map<string, BuildUse>();
const buildOfImage = new Map<string, BuildUse>();
for (const u of buildUses) {
  if (!buildOfService.has(u.service)) buildOfService.set(u.service, u);
  const svcs = composedServices.find((c) => c.rel === u.file)?.svcs;
  const img = svcs === undefined ? null : imageOf(svcs, u.service);
  if (img !== null && !buildOfImage.has(img)) buildOfImage.set(img, u);
}

/**
 * Node flags this gate reads past: they take no separate value and they load
 * no code. ANYTHING ELSE IS REFUSED — that is what makes "a flag whose value
 * is a separate argument" (T-180 § contract 4's second family member, QA's E3)
 * impossible to mistake for the script, without this gate having to know
 * node's whole flag surface. Adding a flag here is a decision made in this
 * file, in review.
 */
const INERT_NODE_FLAGS: readonly RegExp[] = [
  /^--enable-source-maps$/,
  /^--no-warnings$/,
  /^--trace-warnings$/,
  /^--trace-uncaught$/,
  /^--use-strict$/,
  /^--disable-proto=\S+$/,
  /^--max-old-space-size=\d+$/,
  /^--max-semi-space-size=\d+$/,
  /^--stack-trace-limit=\d+$/,
  /^--unhandled-rejections=\S+$/,
  /^--dns-result-order=\S+$/,
  /^--title=\S+$/,
];
/**
 * Flags that make node execute code from somewhere else, or read more options
 * from somewhere else. `--import` was MEASURED running inside PID 1 of
 * kinvara/core:dev by qa-verification (T-180 rework 1, F6), and
 * docker/app.Dockerfile already sets NODE_OPTIONS image-wide, so the hook
 * point exists in the delivered image.
 */
const LOADS_CODE =
  /^--?(?:import|require|r|loader|experimental-loader|experimental-require-module|env-file|env-file-if-exists|eval|e|print|p|experimental-policy|experimental-vm-modules|conditions|C|experimental-network-imports)(?:=|$)/;

const flagVerdict = (arg: string): 'inert' | 'loads-code' | 'unmodelled' =>
  LOADS_CODE.test(arg)
    ? 'loads-code'
    : INERT_NODE_FLAGS.some((re) => re.test(arg))
      ? 'inert'
      : 'unmodelled';

/** The script `node` would run, or why this gate will not guess. */
function nodeScriptOf(
  argv: readonly string[],
): { readonly script: string } | { readonly why: string } {
  const bin = argv[0] ?? '';
  if (!/(^|\/)node$/.test(bin)) {
    return {
      why:
        `${JSON.stringify(argv)} is not \`node <script>\`, so the stop-grace rule (§7) cannot ` +
        `tell which file is PID 1 and read GROUP_DRAIN_MS from it. Refusing rather than ` +
        `reading a file this gate chose`,
    };
  }
  for (const arg of argv.slice(1)) {
    if (!arg.startsWith('-')) return { script: arg };
    const v = flagVerdict(arg);
    if (v === 'loads-code') {
      return {
        why:
          `the node flag '${arg}' in ${JSON.stringify(argv)} makes node run code from another ` +
          `file (or read more options from one) BEFORE the script, so the code PID 1 runs is ` +
          `not only the script this gate reads`,
      };
    }
    if (v === 'unmodelled') {
      return {
        why:
          `the node flag '${arg}' in ${JSON.stringify(argv)} is not one this rule models — it ` +
          `may take the next argument as its VALUE, in which case the script this gate read ` +
          `would be the flag's value and not PID 1's code (T-180 § contract 4, QA's E3). Add ` +
          `it to INERT_NODE_FLAGS in scripts/gates/app-images.ts, in review, if it is inert`,
      };
    }
  }
  return {
    why:
      `${JSON.stringify(argv)} names no script after node, so the stop-grace rule (§7) has no ` +
      `file to read GROUP_DRAIN_MS from`,
  };
}

/** Every ENV assignment the stage chain leaves in effect for `key` (last wins). */
function dockerfileEnv(chain: readonly Stage[], key: string): string | null {
  let value: string | null = null;
  for (const stage of chain) {
    for (const line of stage.lines) {
      const m = /^ENV\s+(.*)$/i.exec(line);
      if (m === null) continue;
      const toks = tokenise((m[1] ?? '').trim());
      const first = toks[0] ?? '';
      if (first !== '' && !first.includes('=')) {
        // The legacy `ENV KEY value with spaces` form.
        if (first === key) value = unquote(toks.slice(1).join(' '));
        continue;
      }
      for (const tok of toks) {
        const i = tok.indexOf('=');
        if (i <= 0) continue;
        if (tok.slice(0, i) === key) value = unquote(tok.slice(i + 1));
      }
    }
  }
  return value;
}

/** A compose `environment:`/`env_file:` reading of one variable. */
function composeEnv(
  svc: Record<string, unknown>,
  key: string,
): { readonly value: string | null } | { readonly why: string } {
  if (svc['env_file'] !== undefined) {
    return {
      why:
        `declares env_file:, which can set ${key} — and this gate does not read env files (they ` +
        `are not necessarily in the repository). Refusing rather than resolving PID 1's ` +
        `environment from half of its sources`,
    };
  }
  const env = svc['environment'];
  if (env === undefined) return { value: null };
  let value: string | null = null;
  if (isRecord(env)) {
    for (const [k, v] of Object.entries(env)) {
      if (k !== key) continue;
      if (typeof v !== 'string' && typeof v !== 'number') {
        return { why: `declares ${key} as ${JSON.stringify(v)}, which this gate cannot read` };
      }
      value = String(v);
    }
  } else if (Array.isArray(env)) {
    for (const entry of env) {
      if (typeof entry !== 'string') {
        return {
          why: `declares an environment: entry ${JSON.stringify(entry)} this gate cannot read`,
        };
      }
      const i = entry.indexOf('=');
      const k = i < 0 ? entry : entry.slice(0, i);
      if (k !== key) continue;
      value = i < 0 ? '' : entry.slice(i + 1);
    }
  } else {
    return { why: `declares environment: as ${JSON.stringify(env)}, which this gate cannot read` };
  }
  if (value !== null && value.includes('${')) {
    return {
      why:
        `declares ${key} as '${value}', which compose INTERPOLATES from the environment of ` +
        `whoever runs it — so what PID 1 loads is not decided in this repository`,
    };
  }
  return { value };
}

/** Every in-container path this service mounts something over, or why it cannot be read. */
function mountTargets(
  svc: Record<string, unknown>,
): { readonly targets: string[] } | { readonly why: string } {
  const targets: string[] = [];
  const push = (t: unknown, what: string): string | null => {
    if (typeof t !== 'string' || t === '')
      return `declares ${what} with a target this gate cannot read`;
    if (t.includes('${')) return `declares ${what} with an INTERPOLATED target '${t}'`;
    targets.push(path.posix.normalize(t));
    return null;
  };
  const vols = svc['volumes'];
  if (vols !== undefined) {
    if (!Array.isArray(vols)) return { why: `declares volumes: as ${JSON.stringify(vols)}` };
    for (const v of vols) {
      if (typeof v === 'string') {
        const parts = v.split(':');
        const why = push(parts.length === 1 ? parts[0] : parts[1], `a volumes: entry '${v}'`);
        if (why !== null) return { why };
      } else if (isRecord(v)) {
        const why = push(v['target'], `a volumes: entry ${JSON.stringify(v['target'] ?? v)}`);
        if (why !== null) return { why };
      } else {
        return { why: `declares a volumes: entry ${JSON.stringify(v)} this gate cannot read` };
      }
    }
  }
  const tmpfs = svc['tmpfs'];
  if (tmpfs !== undefined) {
    for (const t of Array.isArray(tmpfs) ? tmpfs : [tmpfs]) {
      const why = push(
        typeof t === 'string' ? t.split(':')[0] : t,
        `a tmpfs: entry ${JSON.stringify(t)}`,
      );
      if (why !== null) return { why };
    }
  }
  // configs: and secrets: mount a file too, and neither is a `volumes:` key.
  // The short form's target is derived the way compose derives it.
  for (const [key, root] of [
    ['configs', '/'],
    ['secrets', '/run/secrets/'],
  ] as const) {
    const list = svc[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { why: `declares ${key}: as ${JSON.stringify(list)}` };
    for (const c of list) {
      if (typeof c === 'string') {
        targets.push(path.posix.normalize(`${root}${c}`));
      } else if (isRecord(c)) {
        const t = c['target'];
        if (t === undefined) {
          const src = c['source'];
          if (typeof src !== 'string')
            return { why: `declares a ${key}: entry ${JSON.stringify(c)}` };
          targets.push(path.posix.normalize(`${root}${src}`));
        } else {
          const why = push(t, `a ${key}: entry ${JSON.stringify(t)}`);
          if (why !== null) return { why };
        }
      } else {
        return { why: `declares a ${key}: entry ${JSON.stringify(c)} this gate cannot read` };
      }
    }
  }
  return { targets };
}

// --- 7c. THE KEY SPACE, AS AN ALLOW-LIST (T-182 rework 1, QA-1) ------------
//
//     TWO QUESTIONS, NOT ONE LIST. Every one of the nine inputs above answers
//     "WHICH FILE does node run". qa-verification found a second question they
//     do not answer — "WHAT IS PID 1, and what code is loaded into it" — and
//     two compose keys that decide it while being invisible in all nine:
//
//       * `pid:`. MEASURED (T-182 § Rework 1 M1, reproducing QA-1): `pid: host`
//         on `core` puts the HOST's /sbin/init at PID 1 (`/proc/1/comm` =
//         `systemd`), so entrypoint.mjs is not PID 1 at all; `docker kill -s
//         QUIT` then ends the container at ExitCode=131 in 2.19 s with no
//         drain, against STILL RUNNING at 36.36 s without the flag. That is
//         the same signature as `init: true`, which (3) refuses — reached
//         through a key nothing here read.
//       * `LD_PRELOAD`, through `environment:`. MEASURED: five mappings of the
//         named object inside PID 1's OWN address space (`grep -c libz
//         /proc/1/maps`), zero without it. That is (5)'s `--require` hazard by
//         way of the dynamic loader instead of node, and it is the shape a
//         native APM agent, a profiler or jemalloc actually uses.
//
//     TWO MORE DENY ENTRIES WOULD HAVE BEEN THE WRONG ANSWER, for the reason
//     this ticket was cut in the first place: seven patches for seven members
//     is a failed ticket even if every case is green. The second question's
//     space is not a list of hazards — it is THE KEY SPACE ITSELF, which is far
//     wider than the fifteen keys §7 reads and grows with compose. (No count of
//     the compose spec's keys is stated here, because none was taken —
//     PROTOCOL §5.3 R1, and the argument does not need one.) So this is an
//     ALLOW-LIST:
//
//       an application service may declare ONLY keys this gate has classified,
//       as MODELLED (§7 resolves or refuses on the value) or as NEUTRAL (it
//       cannot change what PID 1 is, what it executes, or what is loaded into
//       it — the argument is beside each). ANYTHING ELSE IS REFUSED and the
//       pair is UNRESOLVED.
//
//     A tenth KEY is then IMPOSSIBLE rather than merely uncaught: a key nobody
//     has thought of fails closed, and admitting one is a decision made in this
//     file, in review, with its argument written down. The allow-list earned its
//     keep immediately — it refused three keys nobody in this family had named
//     (`pull_policy:`, `user:`, `userns_mode:`), and `pull_policy:` turned out
//     to be MODELLED rather than neutral (below). It has also been attacked from
//     outside: the orchestrator planted its own novel key `userns_mode: host`
//     and got exit=1, GATE FAIL, 11 of 14 (OE-44, 2026-09-22T21:30:48Z). THAT
//     SENTENCE IS ABOUT KEYS AND ONLY KEYS — the same orchestrator pass beat the
//     ENVIRONMENT half in the same hour, which is why §7d below now says out
//     loud that it is a deny-list.
//
//     WHAT IT DOES NOT CLOSE, stated rather than implied: a value inside an
//     allow-listed key (`environment:` is allow-listed, and LD_PRELOAD lives
//     in it) — which is why §7d below is a second, name-derived rule. The two
//     together are the claim rather than either alone, AND THE SECOND ONE IS
//     WEAKER THAN THIS ONE: §7d enumerates the loader namespaces measured to be
//     in PID 1's process, so a variable name outside them is admitted without
//     being read. `T-183` is the allow-list that ends that half.

/**
 * Keys §7 reads. Each either resolves (and its case is in § Published contract
 * §1) or refuses. `image`/`build`/`pull_policy` decide WHICH IMAGE, and
 * therefore which stage's ENTRYPOINT §6 resolved; the rest are inputs (2)-(9).
 */
const PID1_MODELLED_KEYS: readonly string[] = [
  'image',
  'build',
  'pull_policy',
  'entrypoint',
  'command',
  'init',
  'working_dir',
  'environment',
  'env_file',
  'volumes',
  'tmpfs',
  'configs',
  'secrets',
  'stop_signal',
  'stop_grace_period',
];

/**
 * Keys that cannot change what PID 1 is, what it executes, or what code is
 * loaded into it. The argument for each is here because that is the thing a
 * reviewer has to check when a key is added:
 *
 *   profiles      selects WHETHER the service starts, never what it runs.
 *   labels        metadata; read by scripts/svc, never by exec.
 *   networks      the namespace the process joins after exec (and the egress
 *                 boundary's own subject — gate:egress-boundary).
 *   expose        documentation of a port; publishes nothing.
 *   ports         host publishing; §3's no-ports rule owns it. Not in the exec
 *                 path.
 *   depends_on    start ordering.
 *   healthcheck   a SEPARATE process docker runs in the container; it cannot
 *                 replace PID 1 (and §5 owns its presence).
 *   restart       what docker does AFTER PID 1 exits.
 *   mem_limit     cgroup limits. A container killed for memory is an OOM kill,
 *   cpus          not a different PID 1; §4 owns the budgets.
 *
 * NOT here and deliberately: `user:` (it changes the uid PID 1 runs as, and §5
 * reads USER in the Dockerfile only, so a compose `user:` would be an unread
 * route), `pid:`, `init:` handled above, `privileged:`, `cap_add:`,
 * `security_opt:`, `userns_mode:`, `ipc:`, `uts:`, `sysctls:`, `ulimits:`,
 * `runtime:`, `platform:`, `extends:` (refused earlier, by its own
 * pre-existing rule). Each of those either changes PID 1 or changes the
 * process's privileges around it, and none is modelled.
 */
const PID1_NEUTRAL_KEYS: readonly string[] = [
  'profiles',
  'labels',
  'networks',
  'expose',
  'ports',
  'depends_on',
  'healthcheck',
  'restart',
  'mem_limit',
  'cpus',
];

/**
 * A measured note for a refused key, so the message says what was measured
 * rather than only that the key is unclassified. Message quality only: the
 * MECHANISM is the allow-list above, and a key with no note here is refused
 * exactly as loudly (case 197 plants one).
 */
const PID1_KEY_NOTES: Readonly<Record<string, string>> = {
  pid:
    ` MEASURED (T-182 § Rework 1 M1, reproducing qa-verification's QA-1): with \`pid: host\` the ` +
    `HOST's /sbin/init is PID 1 inside the container (/proc/1/comm = systemd), so ` +
    `docker/app-runtime/entrypoint.mjs is not PID 1 and forwards nothing; SIGQUIT then ended the ` +
    `container at ExitCode=131 in 2.19 s with NO drain, against still running at 36.36 s without ` +
    `it — the same signature as \`init: true\`, which this rule already refuses. ` +
    `\`pid: service:<name>\` and \`pid: container:<id>\` are the same key.`,
  user:
    ` §5 reads USER in the Dockerfile; a compose \`user:\` is not read there, so the uid PID 1 ` +
    `runs as would be decided somewhere no rule looks.`,
};

/**
 * §7d — ENVIRONMENT VARIABLE NAMES THAT DECIDE WHAT IS LOADED INTO PID 1.
 *
 * `environment:` is allow-listed by §7c because §7 reads NODE_OPTIONS out of
 * it — so the key-space rule cannot reach LD_PRELOAD, which lives INSIDE it.
 * This rule is therefore over NAMES, and it is derived from the two loaders'
 * own documented namespaces rather than from a list of spellings:
 *
 *   * the dynamic loader reads `LD_*` (ld.so(8): LD_PRELOAD, LD_AUDIT,
 *     LD_LIBRARY_PATH, …) and `DYLD_*` on Darwin;
 *   * node reads `NODE_*` (node(1) ENVIRONMENT: NODE_OPTIONS, NODE_REPL_*,
 *     NODE_EXTRA_CA_CERTS, …).
 *
 * So a new spelling INSIDE a listed namespace is refused without this gate
 * knowing it exists. Two names are read rather than refused: NODE_OPTIONS
 * (input (5), resolved token by token) and NODE_ENV (it selects behaviour in
 * the application, loads nothing, and every application service declares it).
 *
 * ================= THIS RULE IS A DENY-LIST, NOT AN ALLOW-LIST =============
 * READ THIS BEFORE TRUSTING A GREEN RUN. §7c (the KEY space) is an allow-list:
 * a key nobody classified fails closed. §7d is NOT its twin. It enumerates the
 * namespaces of the loaders MEASURED to be in PID 1's process, and a variable
 * name OUTSIDE them is ADMITTED WITHOUT BEING READ. T-182 rework 1 stated four
 * namespaces and treated the class as closed; the orchestrator then defeated it
 * with `OPENSSL_CONF` placed inside `core`'s own `environment:` block —
 * exit=0, GATE PASS, `14 of 14` pairs printed as resolved (T-182 § Rework 2,
 * the OE-44 route, stakeholder ruling B: widen by measurement, merge, cut a
 * successor). THE SUCCESSOR IS `T-183`: the environment ALLOW-LIST, anchored to
 * a checked per-app manifest. Until it lands, the honest statement of what a
 * green §7d run means is: "no variable in a MEASURED loader namespace", never
 * "no variable that can load code".
 *
 * WHAT REWORK 2 MEASURED, on the five shipping application images (all five run
 * the SAME node: sha256 3840e7a7…, v24.20.0, OpenSSL 3.5.7, Alpine 3.24.1, musl
 * — kinvara/{core,safety-gw,web,admin,worker}:dev, T-182 § Rework 2 M4/M5):
 *   * the objects mapped into a real node process are exactly four — the node
 *     binary, libstdc++, libgcc_s and /lib/ld-musl-x86_64.so.1. So the loaders
 *     in PID 1 are musl's ld.so, node/V8/libuv, and the OpenSSL 3.5.7 that node
 *     links STATICALLY (there is no libcrypto.so in ldd output);
 *   * instrument, over every env-name-shaped string in those four objects: set
 *     the name to the path of a FIFO with no writer. If the process OPENs the
 *     value, open(2) blocks and the run is killed (status >= 124); if the name
 *     is never used as a path, the workload completes at 0. Measured OPENED:
 *     LD_PRELOAD (the rework-1 hazard, positive control), NODE_EXTRA_CA_CERTS
 *     (already in NODE_*), and **OPENSSL_CONF** — at startup, before any
 *     application code. Measured not-opened: OPENSSL_MODULES, OPENSSL_ENGINES,
 *     OPENSSL_CONF_INCLUDE, SSL_CERT_FILE, SSL_CERT_DIR, CTLOG_FILE,
 *     ARES_RAND_FILE, ICU_TIMEZONE_FILES_DIR, MUSL_LOCPATH, NLSPATH, DATEMSK,
 *     TZ, TMPDIR, GLIBCXX_TUNABLES, UV_THREADPOOL_SIZE, LD_LIBRARY_PATH, and
 *     the negative control KINVARA_NOT_A_LOADER;
 *   * OPENSSL_CONF LOADS CODE, and that is the point: with the app section
 *     spelled `nodejs_conf` (node's own config appname — `openssl_conf` is
 *     IGNORED, which is why a naive probe shows nothing), a `providers` section
 *     whose `module` is a FIFO blocks the process at startup — the dlopen was
 *     attempted — and a `module` naming a REAL shared object (/usr/lib/libz.so.1)
 *     ends PID 1 inside node::InitializeOncePerProcessInternal with
 *     `Assertion failed: ncrypto::CSPRNG(nullptr, 0)`, SIGABRT, container
 *     ExitCode=139 against a control that boots the app. An `engines` section's
 *     `dynamic_path` does the same, and OPENSSL_MODULES / OPENSSL_ENGINES /
 *     OPENSSL_CONF_INCLUDE each decide WHERE that code is loaded from once a
 *     config names one (each measured OPENED in that arrangement). So the whole
 *     OPENSSL_ prefix is treated as a loader namespace, exactly as LD_ is;
 *   * SSL_CERT_FILE, SSL_CERT_DIR and CTLOG_FILE are OpenSSL's other file
 *     inputs in the same statically linked library. They are REFUSED on the
 *     argument — not on a measurement: the sweep above did NOT reach them
 *     (node uses its bundled CA store unless the application asks for the
 *     OpenSSL one), and refusing them is the fail-closed direction.
 *
 * PATH is in the family for a measured reason: the image's resolved ENTRYPOINT
 * is ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"] — `node` with NO
 * directory — so PATH decides WHICH BINARY is PID 1. Measured on
 * kinvara/core:dev 7cb5b84358b6: `-e PATH=/nonexistent` and the container
 * cannot start at all (`exec: "node": executable file not found in $PATH`,
 * docker run exit 127). The loud direction is docker's; the silent one needs a
 * second key to put a `node` on the new PATH, and it is refused here either
 * way rather than argued about.
 */
/**
 * The loader namespaces MEASURED to be in PID 1's process (see the docblock
 * above for each measurement). OPENSSL_ was added by T-182 rework 2 after the
 * OE-44 route: node links OpenSSL 3.5.7 statically, and OPENSSL_CONF loads a
 * shared object into PID 1 at startup. `DYLD_` is not reachable on these Linux
 * images and is kept because the same compose file describes the estate T-003
 * owns; it costs nothing and it is the ld.so namespace on Darwin.
 */
const ENV_LOADER_NAMESPACE = /^(?:LD_|DYLD_|NODE_|OPENSSL_)/;
/**
 * Exact names outside every prefix above. PATH is measured (it decides which
 * binary is PID 1); the three OpenSSL file inputs are refused on the argument
 * that the library reading them is in this process, with the measurement that
 * did NOT reach them stated rather than hidden (T-182 § Rework 2).
 */
const ENV_LOADER_EXACT = new Set(['SSL_CERT_FILE', 'SSL_CERT_DIR', 'CTLOG_FILE']);
const ENV_FAMILY_READ = new Set(['NODE_OPTIONS']);
const ENV_FAMILY_INERT = new Set(['NODE_ENV']);
const envNameVerdict = (k: string): 'ok' | 'loader' | 'path' | 'ossl-file' => {
  if (k === 'PATH') return 'path';
  if (ENV_FAMILY_READ.has(k) || ENV_FAMILY_INERT.has(k)) return 'ok';
  if (ENV_LOADER_EXACT.has(k)) return 'ossl-file';
  return ENV_LOADER_NAMESPACE.test(k) ? 'loader' : 'ok';
};

/** Every environment variable NAME this service declares, or why it cannot be read. */
function composeEnvNames(
  svc: Record<string, unknown>,
): { readonly names: string[] } | { readonly why: string } {
  const env = svc['environment'];
  if (env === undefined) return { names: [] };
  if (isRecord(env)) return { names: Object.keys(env) };
  if (Array.isArray(env)) {
    const names: string[] = [];
    for (const entry of env) {
      if (typeof entry !== 'string') {
        return {
          why: `declares an environment: entry ${JSON.stringify(entry)} this gate cannot read`,
        };
      }
      const i = entry.indexOf('=');
      names.push(i < 0 ? entry : entry.slice(0, i));
    }
    return { names };
  }
  return { why: `declares environment: as ${JSON.stringify(env)}, which this gate cannot read` };
}

/** Every environment variable NAME the stage chain assigns (both ENV forms). */
function dockerfileEnvNames(chain: readonly Stage[]): string[] {
  const names: string[] = [];
  for (const stage of chain) {
    for (const line of stage.lines) {
      const m = /^ENV\s+(.*)$/i.exec(line);
      if (m === null) continue;
      const toks = tokenise((m[1] ?? '').trim());
      const first = toks[0] ?? '';
      if (first !== '' && !first.includes('=')) {
        names.push(first); // the legacy `ENV KEY value with spaces` form
        continue;
      }
      for (const tok of toks) {
        const i = tok.indexOf('=');
        if (i > 0) names.push(tok.slice(0, i));
      }
    }
  }
  return names;
}

/** PID 1's script, as a repository file, for one (composed file, service). */
function resolvePid1(
  rel: string,
  name: string,
): { readonly file: string } | { readonly why: string } {
  const own = composedServices.find((c) => c.rel === rel)?.svcs[name] ?? {};
  const fromBase = base?.[name] ?? {};
  // Compose merges the base with the overlay; for every key this rule reads,
  // the overlay's value REPLACES the base's (sequences and scalars both), which
  // is compose's own rule for these keys. `environment` is the one exception
  // and is merged per variable, so the base's NODE_OPTIONS is still read when
  // the overlay sets something else.
  const svc: Record<string, unknown> = { ...fromBase, ...own };
  const envMerged: Record<string, unknown> = {};
  for (const src of [fromBase, own]) {
    const e = src['environment'];
    if (isRecord(e)) Object.assign(envMerged, e);
  }
  if (
    Object.keys(envMerged).length > 0 &&
    !Array.isArray(own['environment']) &&
    !Array.isArray(fromBase['environment'])
  ) {
    svc['environment'] = envMerged;
  }

  // (10) §7c — THE KEY SPACE. Every key this service declares must be one this
  // gate has classified. An unclassified key is refused and the pair is
  // UNRESOLVED, because a key that might decide what PID 1 is makes the rest of
  // this resolution a statement about a process that may not exist.
  for (const key of Object.keys(svc).sort()) {
    if (PID1_MODELLED_KEYS.includes(key) || PID1_NEUTRAL_KEYS.includes(key)) continue;
    return {
      why:
        `declares the compose key '${key}:', which the stop-grace rule (§7) has not classified. ` +
        `An application service may declare only keys §7 RESOLVES (${PID1_MODELLED_KEYS.join(', ')}) ` +
        `or has argued cannot change what PID 1 is (${PID1_NEUTRAL_KEYS.join(', ')}).` +
        (PID1_KEY_NOTES[key] ?? '') +
        ` This is an ALLOW-LIST and it is deliberate (T-182 rework 1, QA-1): the keys that decide ` +
        `WHAT PID 1 IS are not a list this gate can enumerate, so an unclassified key fails ` +
        `closed. If it cannot change PID 1, add it to PID1_NEUTRAL_KEYS in ` +
        `scripts/gates/app-images.ts with the argument; if it can, §7 must resolve it`,
    };
  }
  // `pull_policy:` decides whether the image PID 1 comes from is BUILT here or
  // FETCHED. Only the two values that mean "not fetched" are read.
  const pullPolicy = svc['pull_policy'];
  if (pullPolicy !== undefined && !['build', 'never'].includes(String(pullPolicy).trim())) {
    return {
      why:
        `declares pull_policy: ${String(pullPolicy)}, so the image that becomes PID 1 may be ` +
        `FETCHED instead of built from this repository — and §7 resolves PID 1 from the build in ` +
        `this repository, so a fetched image would be a PID 1 this gate never read. Only ` +
        `'build' and 'never' are read`,
    };
  }

  const img = composedServices.find((c) => c.rel === rel)?.svcs;
  const image = img === undefined ? null : imageOf(img, name);
  const build = buildOfService.get(name) ?? (image === null ? undefined : buildOfImage.get(image));
  if (build === undefined) {
    return {
      why:
        `runs ${image === null ? 'no image this gate can name' : `image '${image}'`} and no ` +
        `composed file declares an application build for it, so this gate cannot resolve which ` +
        `image — and therefore which PID 1 — it runs`,
    };
  }
  const stage = stageOfBuild.get(stageKey(build.dockerfile, build.target));
  if (stage === undefined) {
    return {
      why:
        `is built from ${build.dockerfile} stage '${build.target}', for which §6 resolved no ` +
        `exec-form ENTRYPOINT (see §6's failures above), so there is no PID 1 to read`,
    };
  }

  // (2) compose entrypoint:/command: override the image's ENTRYPOINT/CMD.
  const epRaw = svc['entrypoint'];
  const cmdRaw = svc['command'];
  const shellForm = (key: string, v: string): { readonly why: string } => ({
    why:
      `declares ${key}: as the STRING '${v}'. Compose reads that as SHELL form, so PID 1 is ` +
      `/bin/sh -c and not node at all — and sh does not forward SIGTERM to its child`,
  });
  if (typeof epRaw === 'string') return shellForm('entrypoint', epRaw);
  if (typeof cmdRaw === 'string') return shellForm('command', cmdRaw);
  const argvOf = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.map((x) => String(x)) : null;
  const epCompose = argvOf(epRaw);
  const cmdCompose = argvOf(cmdRaw);
  if (epRaw !== undefined && epCompose === null) {
    return { why: `declares entrypoint: as ${JSON.stringify(epRaw)}, which this gate cannot read` };
  }
  if (cmdRaw !== undefined && cmdCompose === null) {
    return { why: `declares command: as ${JSON.stringify(cmdRaw)}, which this gate cannot read` };
  }
  // A compose `entrypoint:` also CLEARS the image's CMD (compose's documented
  // behaviour), so the image's CMD is only appended when compose overrides
  // neither.
  const imageCmd = ((): string[] => {
    if (epCompose !== null) return [];
    const cmd = resolveSetting(stage.chain, 'CMD');
    if (cmd === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(cmd.value);
    } catch {
      parsed = null;
    }
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  })();
  const argv = [...(epCompose ?? stage.argv), ...(cmdCompose ?? imageCmd)];

  // (4) the node argv.
  const script = nodeScriptOf(argv);
  if ('why' in script) return script;

  // (5) NODE_OPTIONS: the image's own ENV, overridden by compose's.
  const fromCompose = composeEnv(svc, 'NODE_OPTIONS');
  if ('why' in fromCompose) return fromCompose;
  const nodeOptions = fromCompose.value ?? dockerfileEnv(stage.chain, 'NODE_OPTIONS');
  if (nodeOptions !== null) {
    for (const tok of tokenise(nodeOptions).map(unquote)) {
      const v = flagVerdict(tok);
      if (v === 'inert') continue;
      return {
        why:
          `has NODE_OPTIONS='${nodeOptions}' in effect, and '${tok}' ` +
          (v === 'loads-code'
            ? `makes node run code from another file INSIDE PID 1 before the script — measured ` +
              `running in PID 1 of kinvara/core:dev (T-180 rework 1, F6). The code PID 1 runs is ` +
              `then not the file this gate read`
            : `is not a NODE_OPTIONS token this rule models, so what PID 1 loads is not resolved ` +
              `(add it to INERT_NODE_FLAGS in scripts/gates/app-images.ts, in review, if it is inert)`),
      };
    }
  }

  // (11) §7d — the environment variable NAMES that decide what is loaded into
  // PID 1, from compose and from the image's own ENV, judged by the loaders'
  // namespaces rather than by a list of spellings.
  const composeNames = composeEnvNames(svc);
  if ('why' in composeNames) return composeNames;
  for (const [source, names] of [
    ['compose environment:', composeNames.names],
    [`${build.dockerfile} stage '${build.target}' ENV`, dockerfileEnvNames(stage.chain)],
  ] as const) {
    for (const key of names) {
      const v = envNameVerdict(key);
      if (v === 'ok') continue;
      if (v === 'ossl-file') {
        return {
          why:
            `sets ${key} in ${source}. node links OpenSSL 3.5.7 STATICALLY into PID 1's own ` +
            `binary (measured: no libcrypto.so in ldd, T-182 § Rework 2 M4), and ${key} is one ` +
            `of that library's file inputs. REFUSED ON THE ARGUMENT, NOT ON A MEASUREMENT: the ` +
            `FIFO sweep of § Rework 2 M5 did NOT observe this name being opened under either ` +
            `workload, because node uses its bundled CA store unless the application asks for ` +
            `OpenSSL's — refusing it is the fail-closed direction, and admitting it is a review ` +
            `decision in ENV_LOADER_EXACT in scripts/gates/app-images.ts (T-182 rework 2, §7d)`,
        };
      }
      return {
        why:
          v === 'path'
            ? `sets PATH in ${source}, and PID 1's argv[0] is ${JSON.stringify(argv[0] ?? '')} — ` +
              `so PATH decides WHICH BINARY is PID 1, not this gate. MEASURED on ` +
              `kinvara/core:dev: with PATH=/nonexistent the container cannot start at all ` +
              `('exec: "node": executable file not found in $PATH', docker run exit 127). The ` +
              `silent direction puts a different \`node\` first on the path. Refused rather than ` +
              `resolved (T-182 rework 1, §7d)`
            : `sets ${key} in ${source}, which is in a LOADER's own namespace. The loaders in ` +
              `PID 1's process are MEASURED, not assumed (T-182 § Rework 2 M4): musl's ld.so ` +
              `(LD_*, and DYLD_* where it is Darwin's), node/V8 (NODE_*, node(1) ENVIRONMENT), ` +
              `and the OpenSSL 3.5.7 node links STATICALLY (OPENSSL_*). A variable there can put ` +
              `code into PID 1 without naming a file this gate reads: MEASURED for LD_PRELOAD ` +
              `(five mappings of the named object in PID 1's own /proc/1/maps against zero ` +
              `without it — § Rework 1 M2) and for OPENSSL_CONF (a \`providers\` section under ` +
              `the \`nodejs_conf\` app name dlopens the module it names; with a real .so PID 1 ` +
              `dies in node::InitializeOncePerProcessInternal, SIGABRT, ExitCode=139 — ` +
              `§ Rework 2 M5/M6). Only NODE_OPTIONS (resolved token by token, input (5)) and ` +
              `NODE_ENV (it loads nothing) are read; anything else in those namespaces is ` +
              `refused. NOTE THE BOUND: §7d is a DENY-LIST over measured namespaces, so a name ` +
              `outside them is admitted WITHOUT being read — T-183 is the allow-list that ends ` +
              `that (T-182 rework 2, §7d)`,
      };
    }
  }

  // (6) the WORKDIR a relative script resolves against, and compose's override.
  let workdir = '/';
  for (const st of stage.chain) {
    for (const l of st.lines) {
      const wd = /^WORKDIR\s+(.+)$/i.exec(l);
      if (wd !== null) workdir = path.posix.resolve(workdir, (wd[1] ?? '').trim());
    }
  }
  const wdCompose = svc['working_dir'];
  if (wdCompose !== undefined) {
    if (typeof wdCompose !== 'string' || wdCompose.includes('${')) {
      return {
        why: `declares working_dir: as ${JSON.stringify(wdCompose)}, which this gate cannot read`,
      };
    }
    workdir = path.posix.resolve('/', wdCompose);
  }
  const imagePath = path.posix.resolve(workdir, script.script);

  // (7) anything mounted over that path.
  const mounts = mountTargets(svc);
  if ('why' in mounts) {
    return {
      why: `${mounts.why}, so this gate cannot tell whether PID 1's own script is mounted over`,
    };
  }
  for (const t of mounts.targets) {
    if (imagePath === t || imagePath.startsWith(`${t.replace(/\/$/, '')}/`)) {
      return {
        why:
          `mounts something over ${t}, which covers PID 1's script ${imagePath}: the file in the ` +
          `container is then not the file this gate read, whatever the image was built from`,
      };
    }
  }

  // (9) the COPY/ADD that puts the script there, and anything that rewrites it.
  const src = copySourceOf(stage.chain, build.context, imagePath);
  if ('why' in src) {
    return {
      why:
        `PID 1 runs ${imagePath}, and this gate cannot map it to a repository file: ${src.why}. ` +
        `§7 reads GROUP_DRAIN_MS from the file the container actually runs, and refuses rather ` +
        `than falling back to a fixed path (T-180, T-182)`,
    };
  }
  return { file: src.file };
}

/**
 * repository file -> the `<composed file>:<service>` list whose PID 1 runs it.
 * One entry per (file, service), because an overlay can make one service's PID
 * 1 different from the same service's in the base file.
 */
const entrypointFiles = new Map<string, string[]>();
/** Printed: every resolution, and its inputs, so a green run is readable. */
const pid1Resolved: string[] = [];
let pid1Attempted = 0;
for (const name of [...graceWhy.keys()].sort()) {
  for (const { rel, svcs } of composedServices) {
    if (svcs[name] === undefined) continue;
    pid1Attempted += 1;
    const who = `${rel.replace('docker/', '')}:${name}`;

    // (3) init: — docker-init becomes PID 1 and everything below is false of it.
    const svcHere: Record<string, unknown> = { ...(base?.[name] ?? {}), ...svcs[name] };
    const init = svcHere['init'];
    if (init === true || init === 'true') {
      failures.push(
        `${rel}: application service '${name}' declares init: true, so /sbin/docker-init is PID 1 ` +
          `and the entrypoint this rule reads is its CHILD. MEASURED, both directions, same ` +
          `image and app (T-182 § Evidence E6): the group wait gets SHORTER, because tini reaps ` +
          `the leftover child — 4.12 s and ExitCode=0 against 25.18 s and ExitCode=0 without it, ` +
          `so tech-lead's judgement on that axis holds. What also changes is the SIGNAL ` +
          `DISPOSITION: the entrypoint is no longer a namespace init, so a signal it installs no ` +
          `handler for KILLS it instead of being ignored — SIGQUIT ended the container in 2.17 s ` +
          `with ExitCode=131 and no drain, where without init: true it was still running 35 s ` +
          `later. That is a different lifecycle from the one §7 holds the grace against, so it is ` +
          `refused here and argued in review, not assumed harmless.`,
      );
    }
    // (8) stop_signal: — PID 1 handles SIGTERM and SIGINT and nothing else.
    const stopSignal = svcHere['stop_signal'];
    if (stopSignal !== undefined) {
      const sig = String(stopSignal).trim().toUpperCase();
      if (!['SIGTERM', 'TERM', 'SIGINT', 'INT'].includes(sig)) {
        failures.push(
          `${rel}: application service '${name}' declares stop_signal: ${String(stopSignal)}, and ` +
            `PID 1 (docker/app-runtime/entrypoint.mjs) installs handlers for SIGTERM and SIGINT ` +
            `only. A namespace init with no handler IGNORES the signal, so nothing is forwarded, ` +
            `the application never drains, and docker SIGKILLs at stop_grace_period: measured ` +
            `ExitCode=137 at 30.13 s (qa-verification on T-180, X1). Use SIGTERM or SIGINT, or ` +
            `teach PID 1 to forward this signal in a ticket that changes the image (T-182).`,
        );
      }
    }

    const r = resolvePid1(rel, name);
    if ('why' in r) {
      failures.push(`${rel}: application service '${name}' ${r.why}.`);
      continue;
    }
    entrypointFiles.set(r.file, [...(entrypointFiles.get(r.file) ?? []), who]);
    pid1Resolved.push(`${who}->${r.file}`);
  }
}
if (graceWhy.size > 0 && pid1Attempted === 0) {
  failures.push(
    `the stop-grace rule (§7) resolved PID 1 for ZERO (composed file, application service) ` +
      `pairs while ${String(graceWhy.size)} application service(s) were derived — it would then ` +
      `read GROUP_DRAIN_MS from nothing while reporting a pass (PROTOCOL §5.1).`,
  );
}
if (entrypointsResolved.length === 0) {
  failures.push(
    `the stop-grace rule (§7) resolved no exec-form ENTRYPOINT for any application stage, ` +
      `so it has no PID 1 to read GROUP_DRAIN_MS from (see §6's failures above).`,
  );
}

/**
 * GROUP_DRAIN_MS as ONE numeric literal on ONE top-level `const`, used in code
 * at exactly ONE place, the DEADLINE_STATEMENT (T-180).
 *
 * D13 (T-182, from qa-verification's second pass on T-180): THE VALUE IS READ
 * FROM THE DECLARATION THE CODE USES, not from a line a text match found.
 * Until T-182 the number came from a line-anchored regex while the syntax tree
 * was consulted only for the COUNTS — so putting `const GROUP_DRAIN_MS =
 * 25_000;` inside a comment and writing the real declaration across two lines
 * gave the gate 25 000 to hold the graces against while PID 1 waited 60 s,
 * with one declaration and one use in the tree and the gate green (measured).
 * The declaration, its value, its line and its one use are now all the same
 * node.
 */
function readGroupDrain(file: string): { readonly ms: number; readonly at: string } | null {
  const text = read(file);
  if (text === null) {
    failures.push(
      `${file} does not exist, so the stop-grace rule (§7) cannot read ` +
        `GROUP_DRAIN_MS — the wait every application service's grace must cover. Refusing ` +
        `rather than checking the graces against a number this gate made up.`,
    );
    return null;
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const refs: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'GROUP_DRAIN_MS') refs.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  // T-180 rework 1 (QA-F4): EVERY binding of the name, not only a line that
  // STARTS `const GROUP_DRAIN_MS`. A same-named `let`/`var`, or a `const` with
  // a second declarator (`const pad = 0, GROUP_DRAIN_MS = 60_000;`), inside a
  // function SHADOWS the constant, and the held statement then reads the
  // shadow — green, before this count (cases 166-168). A parameter, a
  // destructured binding or a function of that name is not a
  // VariableDeclaration, so it counts as a use below and is refused there.
  const decls = refs.filter((r) => ts.isVariableDeclaration(r.parent) && r.parent.name === r);
  const decl = decls[0];
  if (decls.length !== 1 || decl === undefined) {
    failures.push(
      `${file}: GROUP_DRAIN_MS is declared ${String(decls.length)} time(s) in the syntax tree ` +
        `(line ${decls.map((d) => String(lineOf(d))).join(', ')}); exactly one declaration is ` +
        `allowed. A same-named let/var/const in an inner scope shadows the constant, and the ` +
        `held statement would read the shadow (T-180 rework 1, QA-F4).`,
    );
    return null;
  }
  const declaration = decl.parent;
  if (!ts.isVariableDeclaration(declaration)) return null; // unreachable: `decls` filtered on it
  const list = declaration.parent;
  const statement = ts.isVariableDeclarationList(list) ? list.parent : undefined;
  const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
  if (
    !isConst ||
    statement === undefined ||
    !ts.isVariableStatement(statement) ||
    statement.parent !== sf
  ) {
    failures.push(
      `${file}:${String(lineOf(decl))}: GROUP_DRAIN_MS must be declared as a TOP-LEVEL \`const\`. ` +
        `The stop-grace rule (§7) holds every application service's grace against this one ` +
        `declaration, so a re-assignable or scoped binding is refused rather than read (T-182).`,
    );
    return null;
  }
  const init = declaration.initializer;
  const rhs = init === undefined ? '(none)' : init.getText(sf).trim();
  if (init === undefined || !ts.isNumericLiteral(init) || !/^\d[\d_]*$/.test(rhs)) {
    failures.push(
      `${file}:${String(lineOf(decl))}: GROUP_DRAIN_MS = ${rhs} is not a single ` +
        `numeric literal, so the stop-grace rule (§7) cannot read the group wait. Write it ` +
        `as one literal (e.g. 25_000); an expression is refused rather than evaluated.`,
    );
    return null;
  }
  const uses = refs.filter((r) => !(ts.isVariableDeclaration(r.parent) && r.parent.name === r));
  if (uses.length !== 1) {
    failures.push(
      `${file}: GROUP_DRAIN_MS is used in code at ${String(uses.length)} place(s)` +
        (uses.length === 0 ? '' : ` (line ${uses.map((u) => String(lineOf(u))).join(', ')})`) +
        `; it must be used at exactly one, \`${DEADLINE_STATEMENT}\`, where the deadline is ` +
        `fixed at the first forwarded signal. A second read is a second wait this rule does ` +
        `not hold (T-180).`,
    );
    return null;
  }
  const use = uses[0];
  const add = use?.parent;
  const assign = add?.parent;
  const shaped =
    use !== undefined &&
    add !== undefined &&
    assign !== undefined &&
    ts.isBinaryExpression(add) &&
    add.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    add.right === use &&
    ts.isIdentifier(add.left) &&
    add.left.text === 'signalledAt' &&
    ts.isBinaryExpression(assign) &&
    assign.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assign.right === add &&
    ts.isIdentifier(assign.left) &&
    assign.left.text === 'deadline' &&
    ts.isExpressionStatement(assign.parent);
  if (!shaped) {
    const stmt = use === undefined ? '' : (text.split('\n')[lineOf(use) - 1] ?? '').trim();
    failures.push(
      `${file}:${String(use === undefined ? 0 : lineOf(use))}: the one use of GROUP_DRAIN_MS is ` +
        `\`${stmt}\`, not \`${DEADLINE_STATEMENT}\`. The stop-grace rule (§7) holds the ` +
        `grace against the constant, so a multiplier or an override where it is used would ` +
        `change the real wait with this gate green (T-180; QA-7 g02/g03 on T-179).`,
    );
    return null;
  }
  return { ms: Number(rhs.replaceAll('_', '')), at: `${file}:${String(lineOf(decl))}` };
}

let groupDrainMs: number | null = null;
const groupDrainReads: string[] = [];
let groupDrainUnread = entrypointFiles.size === 0;
for (const [file, stages] of [...entrypointFiles].sort(([a], [b]) => a.localeCompare(b))) {
  const r = readGroupDrain(file);
  if (r === null) {
    groupDrainUnread = true;
    continue;
  }
  groupDrainReads.push(
    `${String(r.ms)} ms at ${r.at} (PID 1 of ${[...new Set(stages)].join(', ')})`,
  );
  groupDrainMs = Math.max(groupDrainMs ?? 0, r.ms);
}
if (groupDrainUnread) groupDrainMs = null;
const groupDrainAt = groupDrainReads.join('; ');
const graceFloorMs = groupDrainMs === null ? null : groupDrainMs + EXIT_MARGIN_MS;

/**
 * A compose duration in milliseconds, following Go's time.ParseDuration, which
 * is what compose uses. `docker compose config` REFUSES a bare number ("must be
 * a string") and a unit-less string ("missing unit in duration"), measured in
 * state/EP-1/T-179.md — so both are refused here too, never read as seconds.
 * It does NOT refuse everything compose refuses (QA-7): surrounding whitespace
 * is trimmed, so `"30s "` / `" 30s"` / `"30s\t"` pass here while compose
 * rejects the file. Harmless — compose then refuses at `svc up` — but the claim
 * is only that a bare number and a unit-less string are refused.
 */
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const parseDurationMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '0') return 0;
  if (!/^\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)) {
    total += Number(m[1]) * (DURATION_UNIT_MS[m[2] ?? ''] ?? Number.NaN);
  }
  return Number.isFinite(total) ? total : null;
};

/** Printed per service: `<file>=<declared>` for every file that declares one. */
const graceSeen: string[] = [];
for (const name of [...graceWhy.keys()].sort()) {
  const why = [...(graceWhy.get(name) ?? [])].join('+');
  const declaring = composedServices.filter((c) => c.svcs[name] !== undefined);
  const inBase = base?.[name] !== undefined;
  const mustDeclare = inBase ? declaring.filter((c) => c.rel === BASE_FILE) : declaring;
  const seen: string[] = [];
  for (const { rel, svcs } of declaring) {
    const svc = svcs[name];
    if (svc === undefined) continue;
    const raw = svc['stop_grace_period'];
    if (raw === undefined) {
      if (mustDeclare.some((c) => c.rel === rel)) {
        failures.push(
          `${rel}: application service '${name}' (${why}) declares no stop_grace_period, ` +
            `so it takes compose's 10 s default. Its PID 1 (${groupDrainAt === '' ? 'unread' : groupDrainAt}) may ` +
            `wait until GROUP_DRAIN_MS${groupDrainMs === null ? '' : ` = ${String(groupDrainMs)} ms`} ` +
            `after the first forwarded SIGTERM for the app's process group; docker's SIGKILL would land inside ` +
            `that wait and the container would report 137 for a clean drain (T-179, TL-1; T-180). ` +
            `Declare stop_grace_period${graceFloorMs === null ? '' : ` of at least ${String(Math.ceil(graceFloorMs / 1000))}s`} ` +
            `${inBase ? `in ${BASE_FILE}, which every project applies` : `in ${rel}, which adds this service and may be the only file that does`}.`,
        );
      }
      continue;
    }
    const ms = parseDurationMs(raw);
    seen.push(`${rel.replace('docker/', '')}=${String(raw)}`);
    if (ms === null || ms < 0) {
      failures.push(
        `${rel}: application service '${name}' declares stop_grace_period ` +
          `${JSON.stringify(raw)}, which is not a non-negative compose duration ` +
          `(a string such as '30s' or '1m' — compose refuses a bare number and a unit-less ` +
          `string). The stop-grace rule (§7) refuses rather than guessing a unit.`,
      );
      continue;
    }
    if (graceFloorMs === null) continue; // the unreadable wait is already a failure
    const wholeSecondsMs = Math.floor(ms / 1000) * 1000;
    if (wholeSecondsMs < graceFloorMs) {
      failures.push(
        `${rel}: application service '${name}' (${why}) declares stop_grace_period ` +
          `${String(raw)}, BELOW the floor of ${String(graceFloorMs)} ms = GROUP_DRAIN_MS ` +
          `${String(groupDrainMs)} ms (${groupDrainAt}) + ${String(EXIT_MARGIN_MS)} ms exit ` +
          `margin. docker's SIGKILL would land inside PID 1's group wait, and a clean drain ` +
          `would report 137 (T-179, TL-1; T-180). Raise the grace, or lower the wait, in the same ` +
          `change.` +
          (wholeSecondsMs !== ms
            ? ` (Judged as ${String(wholeSecondsMs / 1000)} s: docker's StopTimeout is whole seconds.)`
            : ''),
      );
    }
  }
  graceSeen.push(`${name}[${why}; ${seen.length === 0 ? 'none declared' : seen.join(' ')}]`);
}
if (graceWhy.size === 0) {
  failures.push(
    `the stop-grace rule (§7) judged ZERO application services. It derives them from ` +
      `apps/*, the built-by label, every application build and every service running one of ` +
      `their images, over every composed file — and found none, so it would report a pass ` +
      `while asserting nothing (PROTOCOL §5.1).`,
  );
}

console.log(
  `  stop_grace_period floor (§7)    ` +
    (graceFloorMs === null
      ? '(unreadable — see the failure above)'
      : `${String(graceFloorMs)} ms = GROUP_DRAIN_MS ${String(groupDrainMs)} ms + ${String(EXIT_MARGIN_MS)} ms exit margin; read ${groupDrainAt}, its one use \`${DEADLINE_STATEMENT}\` held (T-180)`),
);
console.log(
  `  PID 1 resolved, per service (§7b, T-182)  ${String(pid1Resolved.length)} of ` +
    `${String(pid1Attempted)} (composed file, application service) pair(s): ` +
    `${pid1Resolved.join(' ')}` +
    `  (WHICH FILE: the image ENTRYPOINT/CMD, compose entrypoint:/command:/init:/working_dir:/` +
    `stop_signal:/env_file:, NODE_OPTIONS, every mount target, and the COPY/ADD that puts the ` +
    `script there — anything unresolved is REFUSED, never defaulted. WHAT PID 1 IS: an ` +
    `ALLOW-LIST over compose KEYS — only these on an application service ` +
    `[${[...PID1_MODELLED_KEYS].sort().join(' ')} | ${[...PID1_NEUTRAL_KEYS].sort().join(' ')}], ` +
    `anything else REFUSED as unclassified — plus a DENY-LIST over environment NAMES: the ` +
    `MEASURED loader namespaces [LD_* DYLD_* NODE_* OPENSSL_*] and [PATH SSL_CERT_FILE ` +
    `SSL_CERT_DIR CTLOG_FILE], less NODE_OPTIONS and NODE_ENV. **A VARIABLE NAME OUTSIDE THAT ` +
    `DENY-LIST IS ADMITTED WITHOUT BEING READ** — OPENSSL_CONF was, until rework 2 measured it ` +
    `loading a shared object into PID 1 (OE-44). T-183 is the allow-list that ends it — T-182 ` +
    `rework 2)`,
);
console.log(
  `  app services held to it (§7)    ${String(graceWhy.size)}: ${graceSeen.join(' ')}` +
    `  (derived: contract-set = apps/* ∪ built-by label; app-build; runs <an app image> — T-179)`,
);

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
  // The parenthetical used to read "all five still T-001 placeholders" — a
  // literal beside a set this ticket made derived. With a sixth apps/*
  // directory present it printed `6:` and "all five" in the same run
  // (tech-lead, T-037 review). The count now comes from the same variable the
  // sentence describes.
  `  apps with src/                  ${String(withSource)}` +
    // QA-N1's sibling, found by tech-lead on this same tree (T-037 § TL-4):
    // this line read "all five" — a literal, printed beside a set the same
    // commit made DERIVED. With a sixth apps/* directory present the gate
    // printed `application services (anchor) 6:` and "all five" in one run.
    // The number now comes from the variable the sentence is about, which is
    // `appsChecked`, printed on the line directly above this one.
    (withSource === 0
      ? `  (all ${String(appsChecked)} apps read are still T-001 placeholders — the images run the reference entrypoint)`
      : ''),
);
console.log(
  `  compose reader                  lib/compose-parse.ts, shared with gate:egress-boundary` +
    `  (merge keys resolved; one lexer, two SCHEMAS compared value by value and by kind, key order NOT compared. Refused, each by a named case: ` +
    `a scalar the schemas read differently (75), a 1.1 Date (128), a second document (88), a U+0085/U+2028/U+2029 character (124-127), a lone carriage return (130, 132; in compose.verify.yml, compose.dev.yml, compose.chaos.yml 141-143), ` +
    `U+0000/U+FFFD e.g. UTF-16 (133), the \\/ escape (135), two SCALAR keys naming one property (137-139 — an ALIAS or collection key is not modelled and NOT refused); the other members MEASURED are in its header — not exhaustive)`,
);
console.log(
  `  files whose 1.1 and 1.2 SCHEMA readings A3 found equal  ${String(schemasAgreedFiles.length)}: ` +
    `${schemasAgreedFiles.sort().join(' ')}  (by kind and value, key order not compared — one lexer)`,
);

finish('gate:app-images', failures);
