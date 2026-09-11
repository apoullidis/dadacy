/**
 * The set of compose files a ticket-scoped project is actually composed from —
 * DERIVED FROM `scripts/svc`'S OWN `-f` ASSEMBLY, not written down (T-037, OD-37).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `gate:app-images` and `gate:egress-boundary` each carried a hand-written list
 * of compose files, and each list was described by a sentence quantifying over
 * *every* compose file ("every compose file that can declare a `build:`", "a
 * fifth file appearing does not silently pass"). Neither list had any behaviour
 * in that direction: `does not exist — this gate's file list is stale` fires
 * when a LISTED file is MISSING, and a file APPEARING is not a listed file
 * missing. Measured by `tech-lead` on `T-036` (OD-37): a fifth compose file
 * carrying a target-less two-stage application build, literal pins, `ports:`,
 * `mem_limit: 8g` and `networks: [default]` was exit 0 on BOTH gates, and every
 * rule `T-036` added was silent in it. Reproduced independently on `T-037`'s
 * branch before this file was written.
 *
 * WHY `scripts/svc` AND NOT A `docker/compose*.yml` GLOB
 * -----------------------------------------------------
 * `tech-lead` named the preference and `T-037`'s brief adopts it: a glob is a
 * SECOND ENUMERATION OF THE SAME KIND — it just moves the list from a `const`
 * into a pattern — and `docker/chaos-extra.yml` would not match it. What
 * actually decides which files reach a ticket-scoped project is
 * `scripts/svc`'s `compose_files_for()`, because `svc` is the only supported
 * way to start services (`T-016` § contract 2). So that function IS the set,
 * and this module reads it.
 *
 * That also satisfies `PROTOCOL.md` §5.1's same-source rule in the direction
 * that matters here: the scope is derived from `scripts/svc`, and the things
 * checked are the compose files. Someone editing `docker/compose.chaos.yml`
 * cannot narrow the scope that reads it; narrowing it takes an edit to
 * `scripts/svc`, which also removes the overlay from every bring-up.
 *
 * AND A SECOND ANCHOR, POINTED THE OTHER WAY
 * ------------------------------------------
 * A derivation from `svc` alone says nothing about a compose file that exists
 * on disk and is composed by nothing. So `stragglers()` walks `docker/` and
 * reports any file that PARSES AS A COMPOSE FILE — top-level `services:`
 * mapping — and is not in the derived set. That is a CONTENT test, not a name
 * pattern, so `docker/chaos-extra.yml` is caught by it. It closes the two
 * honest mistakes the derivation alone would miss: adding a compose file and
 * forgetting to wire it in, and deleting an `-f` line from `svc` while leaving
 * a live-looking file behind.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER is stated in `T-037` § Published
 * contract § What is NOT claimed: a compose-shaped file that is neither in
 * `svc`'s assembly nor under `docker/` with a `.yml`/`.yaml` extension. Such a
 * file reaches no ticket-scoped project, because `svc` cannot pass it.
 *
 * FAIL CLOSED. Every parse failure here is a problem returned to the caller,
 * which pushes it onto the gate's failure list. A gate that cannot work out
 * what it is supposed to read must go red, never green over an empty set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './run.ts';
import { composeShape } from './compose-parse.ts';

/**
 * `base` — passed unconditionally, so it is in every project. It is the file
 *          the override/addition set difference is taken against.
 * `dev`  — added only for the literal `dev` project (the shared long-lived
 *          stack, the one project that publishes host ports: `T-016` § contract
 *          6). Derived from the `-f` being guarded by `IS_DEV`, not from the
 *          file's name.
 * `overlay` — added by a flag (`--verify`, `--chaos`). This is the budget
 *          scope of `gate:app-images` §4.
 */
export type ComposeRole = 'base' | 'dev' | 'overlay';

export interface ComposedFile {
  /** Repository-root-relative path, e.g. `docker/compose.verify.yml`. */
  readonly rel: string;
  readonly role: ComposeRole;
  /** The shell variable guarding the `-f`, e.g. `USE_VERIFY`; '' when unguarded. */
  readonly guard: string;
}

export interface ComposedSet {
  /** In `scripts/svc`'s own `-f` order. Empty if the derivation failed. */
  readonly files: readonly ComposedFile[];
  /** Diagnostics the caller must push onto its failure list. */
  readonly problems: readonly string[];
}

const SVC = 'scripts/svc';

/** Strip a shell comment. Same convention as the gates' own `liveLines`. */
const live = (line: string): string => (line.split('#')[0] ?? '').trimEnd();

/**
 * Read `compose_files_for()` out of `scripts/svc` and return what it composes.
 *
 * The parse is deliberately narrow and every way it can fail is a problem
 * rather than a smaller set: a shape this cannot read is a shape whose scope
 * nobody has established, and reporting a confident subset of it is exactly
 * the defect this module exists to remove.
 */
export function composedFiles(): ComposedSet {
  const problems: string[] = [];
  const svcPath = path.join(REPO_ROOT, SVC);
  if (!fs.existsSync(svcPath)) {
    return {
      files: [],
      problems: [`${SVC} does not exist; the composed file set cannot be derived`],
    };
  }
  const lines = fs.readFileSync(svcPath, 'utf8').split('\n').map(live);

  // --- the directory and the file variables ---------------------------------
  let dockerDir: string | null = null;
  const varPath = new Map<string, string>();
  for (const l of lines) {
    const dd = /^DOCKER_DIR="\$\{REPO_ROOT\}\/([^"]+)"\s*$/.exec(l.trim());
    if (dd !== null && dd[1] !== undefined) dockerDir = dd[1];
    const fv = /^([A-Za-z_][A-Za-z0-9_]*)="\$\{DOCKER_DIR\}\/([^"]+)"\s*$/.exec(l.trim());
    if (fv !== null && fv[1] !== undefined && fv[2] !== undefined && dockerDir !== null) {
      varPath.set(fv[1], `${dockerDir}/${fv[2]}`);
    }
  }
  if (dockerDir === null) {
    problems.push(
      `${SVC} no longer defines DOCKER_DIR="\${REPO_ROOT}/..." in live code, so the set of ` +
        `compose files a ticket project is composed from cannot be derived from it. This ` +
        `gate refuses to fall back to a written-down list — that list was OD-37.`,
    );
  }

  // --- the function body ----------------------------------------------------
  const start = lines.findIndex((l) => /^compose_files_for\(\)\s*\{/.test(l.trim()));
  if (start === -1) {
    problems.push(
      `${SVC} declares no compose_files_for() in live code. That function IS the composed ` +
        `file set (T-016 § contract 2: svc is the only supported way to start services), ` +
        `and these gates derive their scope from it (OD-37).`,
    );
    return { files: [], problems };
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\}/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    problems.push(
      `${SVC}: compose_files_for() has no closing brace at column 0 that this gate can find`,
    );
    return { files: [], problems };
  }

  // --- every `-f` the function contributes, with the guard that gates it -----
  const files: ComposedFile[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(start + 1, end)) {
    const l = raw.trim();
    if (!l.includes('-f ')) continue;
    // The guard, if any: `[[ "${USE_VERIFY:-0}" -eq 1 ]] && COMPOSE_FILES+=(...)`.
    const guardMatch = /^\[\[\s*"?\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(l);
    const guard = guardMatch?.[1] ?? '';
    for (const m of l.matchAll(/-f\s+"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"/g)) {
      const varName = m[1];
      if (varName === undefined) continue;
      const rel = varPath.get(varName);
      if (rel === undefined) {
        problems.push(
          `${SVC}: compose_files_for() passes -f "\${${varName}}", but this gate cannot ` +
            `resolve ${varName} to a path under DOCKER_DIR. The composed file set is ` +
            `therefore unknown, and an unknown scope is a failure, not a smaller scope.`,
        );
        continue;
      }
      if (seen.has(rel)) continue;
      seen.add(rel);
      const role: ComposeRole = guard === '' ? 'base' : guard === 'IS_DEV' ? 'dev' : 'overlay';
      files.push({ rel, role, guard });
    }
    for (const m of l.matchAll(/-f\s+"\$\{DOCKER_DIR\}\/([^"]+)"/g)) {
      const namePart = m[1];
      if (namePart === undefined || dockerDir === null) continue;
      const rel = `${dockerDir}/${namePart}`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const role: ComposeRole = guard === '' ? 'base' : guard === 'IS_DEV' ? 'dev' : 'overlay';
      files.push({ rel, role, guard });
    }
  }

  if (files.length === 0) {
    problems.push(
      `${SVC}: compose_files_for() contributes no -f file this gate can read. Deriving an ` +
        `EMPTY composed set would make every check below vacuously green, which is the ` +
        `shape of defect this derivation exists to remove.`,
    );
    return { files: [], problems };
  }
  const bases = files.filter((f) => f.role === 'base');
  if (bases.length !== 1) {
    problems.push(
      `${SVC}: compose_files_for() passes ${String(bases.length)} UNCONDITIONAL -f file(s); ` +
        `these gates need exactly one. The base file is what the addition/override set ` +
        `difference is taken against, and it cannot be computed without knowing which it is.`,
    );
  }
  for (const f of files) {
    if (!fs.existsSync(path.join(REPO_ROOT, f.rel))) {
      problems.push(
        `${SVC} composes ${f.rel}, which does not exist. A -f naming a missing file makes ` +
          `every 'svc up' fail; it is reported here because these gates derive their scope ` +
          `from that assembly.`,
      );
    }
  }

  problems.push(...stragglers(files.map((f) => f.rel)));
  return { files, problems };
}

/**
 * Compose-shaped files under `docker/` that `scripts/svc` composes from
 * nothing — the other direction of OD-37, and the one a derivation from `svc`
 * alone cannot see.
 *
 * A CONTENT test, deliberately: "does this YAML have a top-level `services:`
 * mapping", not "is it named compose*.yml". `tech-lead`'s objection to a glob
 * was that `docker/chaos-extra.yml` evades it; this does not.
 */
function stragglers(composed: readonly string[]): string[] {
  const out: string[] = [];
  const dir = path.join(REPO_ROOT, 'docker');
  if (!fs.existsSync(dir)) return [`docker/ does not exist`];
  const walk = (abs: string): string[] => {
    const found: string[] = [];
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) found.push(...walk(p));
      else if (/\.ya?ml$/i.test(ent.name)) found.push(p);
    }
    return found;
  };
  for (const abs of walk(dir).sort()) {
    const rel = path.relative(REPO_ROOT, abs);
    if (composed.includes(rel)) continue;
    // OD-42 (T-130). This used to be `try { parse(...) } catch { continue; }`:
    // `parse()` THROWS on a second YAML document, so a two-document straggler
    // was skipped in silence while the same services in ONE document were
    // reported — the two directions disagreed. The shared reader answers the
    // one question asked here ("is it compose-shaped, in ANY document, under
    // EITHER YAML reading?") and an unreadable file is a FAILURE: its
    // compose-ness is unknown, and an unknown is never a skip.
    const shape = composeShape(fs.readFileSync(abs, 'utf8'));
    if (shape.kind === 'unreadable') {
      out.push(
        `${rel} is a YAML file under docker/ that ${SVC}'s compose_files_for() composes ` +
          `from nothing, and this gate cannot read it (${shape.why}) — so it cannot tell ` +
          `whether it is a compose file. An unreadable file here is a failure, never a ` +
          `skip (OD-42). Fix it, or move it out of docker/.`,
      );
      continue;
    }
    if (shape.kind === 'compose') {
      out.push(
        `${rel} is a compose file — it has a top-level services: mapping — and ` +
          `${SVC}'s compose_files_for() composes it from nothing. Either wire it into that ` +
          `assembly, where these gates will read it, or delete it. A compose file that ` +
          `exists but is composed by nothing is checked by nothing and reads as though it ` +
          `were live (OD-37).`,
      );
    }
  }
  return out;
}
