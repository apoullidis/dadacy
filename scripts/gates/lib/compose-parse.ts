/**
 * THE ONE PLACE THESE GATES READ A COMPOSE FILE (T-130).
 *
 * First written as `T-037` rework cycle 1 (`66d28d5`), which never merged:
 * `T-037` was retired under OE-11 and this reader was re-cut as its own
 * ticket. It is re-applied here with the one regression that retired it
 * closed (OD-41), and with the members of its class `T-130` found or was
 * handed (OD-42, the `%YAML` directive, the self-referential alias, QA8's
 * uncaught exception).
 *
 * WHY ONE READER
 * --------------
 * There were three `parse()` call sites — `app-images.ts`, `egress-boundary.ts`
 * and the straggler scan in `composed-files.ts` — each with its own idea of
 * what an unreadable file means. `extends:` is the standing proof that this
 * does not work: it was REFUSED by `egress-boundary.ts` (`T-017` §R5) and
 * IGNORED by `app-images.ts` at the same commit, because the refusal was
 * written in one gate and nothing carried it to its sibling (`T-039` § contract
 * 0 row C). Every rule below now lives here, once, and every caller gets it.
 *
 * WHAT COMPOSE IS, MEASURED — AND WHAT THE TWO READINGS DO AND DO NOT COMPARE
 * --------------------------------------------------------------------------
 * `T-037` cycle 1 measured `docker compose config` on one file (§ Evidence R2):
 * compose resolves `<<` merge keys; it reads `A: on` as the STRING 'on', which
 * is YAML 1.2's reading; and it reads `B: 0777` as 511, which is YAML 1.1's.
 * **Compose is neither YAML version, and it splits within one document.** So
 * no `yaml` option equals it, and naming either version "compose's" would be a
 * claim wider than that measurement.
 *
 * This reader reads every file TWICE with ONE LEXER — `yaml`'s, which is YAML
 * 1.2 SYNTAX in both readings — once under the YAML 1.2 core SCHEMA and once
 * under the YAML 1.1 SCHEMA, both with `<<` resolved, and refuses any file on
 * which those two readings disagree. `yaml`'s `version: '1.1'` option selects
 * how a scalar or tag RESOLVES; it does not select how the text is TOKENISED
 * (T-130 rework 1, TL-F1, measured against PyYAML and compose). So the
 * comparison (A3) detects a SCHEMA difference between the versions and is
 * structurally blind to a SYNTAX difference: a file YAML 1.1 and YAML 1.2
 * tokenise differently is read identically twice. It does NOT read the file
 * "as YAML 1.1", and it does pick a syntax: 1.2's. The one syntax difference
 * that is handled is handled by refusal, not by comparison — A10 below.
 *
 * THE CLASS — every member MEASURED, each MODELLED or FAIL-CLOSED. NOT
 * EXHAUSTIVE: a construct nobody has measured is not in this list, and it is
 * not claimed to be refused (see WHAT IS NOT CLOSED, below).
 * ----------------------------------------------------------------------
 *   A1  `<<` merge keys ................. MODELLED (both readings resolve them)
 *   A2  anchors and plain aliases ....... MODELLED (`yaml` resolves them; both
 *                                         readings agree)
 *   A3  a scalar the two SCHEMAS resolve differently (`on`, `yes`, `0777`,
 *       `12:30`, a bare `.`, …) ......... FAIL CLOSED — derived by comparing
 *                                         the two readings, not by a list of
 *                                         spellings; a divergent KEY counts too
 *   A4  a tag no reading resolves (`!reset`, `!override`, a remapped `!!`)
 *       .................................. FAIL CLOSED, from the reader's own
 *                                         warnings
 *   A5  a `%YAML` directive ............. FAIL CLOSED. The directive overrides
 *       the `version` option, so BOTH readings become the directive's version
 *       and A3's comparison compares a reading with itself (measured, T-130).
 *       A `%TAG` that remaps `!!` is refused on the same ground.
 *   A6  MORE THAN ONE DOCUMENT .......... FAIL CLOSED (OD-41). Compose merges
 *       every document in a file (`T-037` QA2-3, measured); a reader of one
 *       document is blind to the rest, and both readings agree on the first,
 *       so A3 never fires. An empty or comment-only extra document counts: the
 *       file still holds more than one document, and `main`'s `parse()` threw
 *       on exactly that shape too.
 *   A7  a parse error, a duplicate key, a non-mapping root, no document
 *       .................................. FAIL CLOSED
 *   A8  a document that refers to ITSELF through an alias
 *       .................................. FAIL CLOSED. It has no finite reading;
 *       `JSON.stringify` on it threw an uncaught `TypeError` in
 *       `egress-boundary.ts` — exit 1 with NO `GATE FAIL` banner — and the
 *       same file was `GATE PASS` in `app-images.ts` (`T-039` QA8, isolated
 *       by T-130). A self-referential MERGE makes `toJS()` itself throw.
 *   A9  ANY EXCEPTION INSIDE THE READ ... FAIL CLOSED, as a reported problem.
 *       A parse layer is exactly where an exception replaces a verdict, so
 *       nothing thrown here reaches the caller as a throw.
 *   B1  `extends:` on a service ......... FAIL CLOSED — it can name a service in
 *                                         a file this gate never reads
 *   B2  a top-level `include:` .......... FAIL CLOSED — the same, a file up
 *   A10 U+0085, U+2028 or U+2029 anywhere in the file
 *       .................................. FAIL CLOSED (OD-43). The one YAML
 *       1.1/1.2 SYNTAX difference measured here: YAML 1.1 and compose break
 *       lines on them, YAML 1.2 — this reader's one lexer — does not, so a
 *       build:, a port or a service can sit after one on a comment line.
 *       Refused by presence, because A3's comparison cannot see it. Both entry
 *       points (`parseCompose`, `composeShape`).
 *
 * THE STRAGGLER SCAN (OD-42) is a different question — "is this file a compose
 * file at all?" — so it gets its own entry point, `composeShape()`, over the
 * same `yaml` reads. A file with a top-level `services:` mapping in ANY of its
 * documents, under EITHER reading, is compose-shaped; a file this reader cannot
 * read is UNREADABLE, and the caller reports that as a failure rather than
 * skipping it. Before T-130 the scan caught `parse()`'s throw and `continue`d,
 * so a two-document straggler was silent where the same services in one
 * document were reported.
 *
 * WHAT IS NOT CLOSED, AND IS STATED RATHER THAN GUESSED: this reads compose
 * files with `yaml`, not with compose's own parser. A construct on which both
 * `yaml` readings AGREE and compose disagrees with both is still misread, and
 * nothing here detects it — A6 was exactly such a construct until it was
 * found, and A10 was another. EVERY 1.1/1.2 SYNTAX difference is of this kind,
 * because both readings share one lexer; the YAML 1.2 specification names the
 * line-break change (A10) and otherwise says only "production bug fixes", so
 * no list of the rest exists to check against (T-130 § Published contract §0,
 * the lexer table). The instrument for finding the next one is `docker compose config`,
 * which these gates cannot run: they have no Docker socket, by design
 * (`gate:toolbox` §6). A UNIVERSAL IS ONLY AS WIDE AS THE PARSE IT IS COMPUTED
 * FROM.
 */
import { parseAllDocuments } from 'yaml';

export interface ComposeParse {
  /** The document, as both readings (one lexer, two schemas) agree. `null` means FAIL CLOSED. */
  readonly doc: Record<string, unknown> | null;
  /** Diagnostics the caller must push onto its failure list. */
  readonly problems: readonly string[];
  /** True when the 1.2- and 1.1-SCHEMA readings agreed and the file was read. Schema only. */
  readonly schemasAgreed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `!!` handle's standard prefix; anything else means a `%TAG` remapped it. */
const CORE_TAG_PREFIX = 'tag:yaml.org,2002:';

const READ_12 = { merge: true, logLevel: 'silent' } as const;
const READ_11 = { version: '1.1', merge: true, logLevel: 'silent' } as const;

/** True if `v` contains itself — an ancestor revisited, not merely a shared node. */
function hasCycle(v: unknown, ancestors: Set<object> = new Set()): boolean {
  if (typeof v !== 'object' || v === null) return false;
  if (ancestors.has(v)) return true;
  ancestors.add(v);
  const children: unknown[] = Array.isArray(v) ? v : Object.values(v);
  for (const c of children) if (hasCycle(c, ancestors)) return true;
  ancestors.delete(v);
  return false;
}

/** The first few paths at which two readings of the same file disagree. */
function divergences(a: unknown, b: unknown, at: string, out: string[]): void {
  if (out.length >= 4) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const bothArr = Array.isArray(a) && Array.isArray(b);
  const bothObj = isRecord(a) && isRecord(b);
  if (bothArr || bothObj) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      divergences(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${at}.${k}`,
        out,
      );
    }
    return;
  }
  out.push(
    `${at || '(root)'}: YAML 1.2 reads ${JSON.stringify(a)}, YAML 1.1 reads ${JSON.stringify(b)}`,
  );
}

/** Read a composed file the way both readings (one lexer, two schemas) agree it reads, or fail closed. */
export function parseCompose(rel: string, text: string): ComposeParse {
  try {
    return parseComposeUnguarded(rel, text);
  } catch (err) {
    // A9. Never a throw to the caller: a gate that crashes instead of printing
    // its verdict is indistinguishable, by exit status, from a refusal.
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return {
      doc: null,
      problems: [
        `${rel}: this gate's compose reader could not read it — ${msg ?? 'unknown error'}. ` +
          `Reported as a failure rather than thrown, so the gate still prints its verdict ` +
          `(T-130, A9).`,
      ],
      schemasAgreed: false,
    };
  }
}

/**
 * A10 (OD-43). The three characters YAML 1.1 treats as LINE BREAKS and YAML
 * 1.2 does not (YAML 1.2.2 §5.4: "YAML version 1.1 did support the above
 * non-ASCII line break characters … YAML treats them as non-break characters
 * as of version 1.2"). `yaml`'s lexer is 1.2 in both readings, so text after
 * one of them on a comment line is a COMMENT to every rule here — and, measured
 * with `docker compose config`, LIVE YAML to compose. Refused wherever they
 * appear, because compose files have no use for them and the comparison in A3
 * cannot see the difference (one lexer, two schemas).
 */
const YAML11_ONLY_LINE_BREAKS: readonly (readonly [string, string])[] = [
  ['U+0085 (NEL)', '\u0085'],
  ['U+2028 (LINE SEPARATOR)', '\u2028'],
  ['U+2029 (PARAGRAPH SEPARATOR)', '\u2029'],
];

/** The A10 refusal text for `text`, or `null` if it carries none of the three. */
function yaml11LineBreaks(text: string): string | null {
  const found: string[] = [];
  for (const [name, ch] of YAML11_ONLY_LINE_BREAKS) {
    const at = text.indexOf(ch);
    if (at >= 0) {
      const line = text.slice(0, at).split('\n').length;
      found.push(`${name} at line ${String(line)}`);
    }
  }
  if (found.length === 0) return null;
  return (
    `contains ${found.join(', ')} — a character YAML 1.1 treats as a LINE BREAK and YAML ` +
    `1.2 does not. Docker Compose breaks lines on it (measured, OD-43), so text after it on ` +
    `a comment line is live YAML to compose and a comment to every rule here: a build:, a ` +
    `port or a whole service can hide behind one. This reader's two readings share one ` +
    `lexer and cannot see the difference (T-130, A10). Remove the character.`
  );
}

function parseComposeUnguarded(rel: string, text: string): ComposeParse {
  const problems: string[] = [];
  const fail = (): ComposeParse => ({ doc: null, problems, schemasAgreed: false });

  // A10 — before any parse: every later check reads what the 1.2 lexer
  // tokenised, and on these characters that is not what compose tokenises.
  const breaks = yaml11LineBreaks(text);
  if (breaks !== null) {
    problems.push(`${rel} ${breaks}`);
    return fail();
  }

  const docs12 = Array.from(parseAllDocuments(text, READ_12));
  const docs11 = Array.from(parseAllDocuments(text, READ_11));

  // A6 / A7 — the document count, first, because every later check reads ONE
  // document and would otherwise report on the first while compose merges all.
  if (docs12.length > 1 || docs11.length > 1) {
    problems.push(
      `${rel} contains multiple documents (${String(Math.max(docs12.length, docs11.length))}, ` +
        `separated by '---'). Docker Compose MERGES every document in a compose file — a ` +
        `service named in two documents keeps the first one's image: and gains the second ` +
        `one's build: — while every rule in this gate reads one. A second document could ` +
        `therefore carry a build:, a ports: key, a network or a budget no check here sees ` +
        `(OD-41). Put everything in one document.`,
    );
    return fail();
  }
  const d12 = docs12[0];
  const d11 = docs11[0];
  if (d12 === undefined || d11 === undefined) {
    problems.push(`${rel} contains no YAML document — refusing to report a pass on it`);
    return fail();
  }

  // A7.
  for (const d of [d12, d11]) {
    for (const e of d.errors) {
      problems.push(`${rel} is not parseable YAML: ${e.message.split('\n')[0] ?? e.message}`);
    }
  }
  if (problems.length > 0) return fail();

  // A5. A directive pins one version for BOTH readings, so the comparison in
  // A3 below would compare a reading with itself and never fire.
  if (d12.directives?.yaml.explicit === true || d11.directives?.yaml.explicit === true) {
    problems.push(
      `${rel} carries a %YAML directive. It overrides the schema this gate reads with, so ` +
        `both of its readings become that one version and the check that refuses a file the ` +
        `1.1 and 1.2 schemas resolve differently can no longer fire (T-130, A5). Compose ` +
        `files need no %YAML directive; remove it.`,
    );
    return fail();
  }
  for (const d of [d12, d11]) {
    const bang = d.directives?.tags['!!'];
    if (bang !== undefined && bang !== CORE_TAG_PREFIX) {
      problems.push(
        `${rel} carries a %TAG directive remapping '!!' to '${bang}', so every '!!' tag in it ` +
          `means something this gate cannot resolve (T-130, A5). Remove the directive.`,
      );
      return fail();
    }
  }

  // A4. Derived from the READER: anything it could not resolve is a construct
  // this gate does not model, and an unmodelled construct must fail rather than
  // be silently dropped to a default value.
  const warned = new Set<string>();
  for (const d of [d12, d11]) {
    for (const w of d.warnings) warned.add(w.message.split('\n')[0] ?? w.message);
  }
  for (const w of warned) {
    problems.push(
      `${rel}: this gate's YAML reader could not resolve a construct in it — ${w}. ` +
        `Compose may resolve it, and this gate would then be reading a different file ` +
        `from the one that gets built (OD-39). Compose Spec tags such as !reset and ` +
        `!override are refused here rather than silently dropped to a default: teach ` +
        `this gate the construct before using it.`,
    );
  }
  if (problems.length > 0) return fail();

  // A8 / A9. `toJS()` itself throws on a self-referential MERGE and on alias
  // explosion (both land in parseCompose's catch); a self-referential plain
  // alias returns a circular object instead, which is caught here before any
  // JSON.stringify below can throw on it.
  const parsed: unknown = d12.toJS();
  const parsed11: unknown = d11.toJS();
  if (hasCycle(parsed) || hasCycle(parsed11)) {
    problems.push(
      `${rel} refers to itself through an alias, so it has no finite reading this gate ` +
        `can check (T-130, A8). Remove the self-reference.`,
    );
    return fail();
  }
  if (!isRecord(parsed)) {
    problems.push(`${rel} did not parse to a mapping — refusing to report a pass on it`);
    return fail();
  }

  // A3. The property is about the FILE, not about the reader: a composed file
  // must not resolve to two different values under the 1.1 and 1.2 SCHEMAS,
  // because no reading of it can then be trusted to be compose's. The repair is
  // to quote the scalar, which changes nothing for compose. SCHEMA only: both
  // readings share one lexer, so this cannot see a SYNTAX difference (A10).
  const diffs: string[] = [];
  divergences(parsed, parsed11, '', diffs);
  if (diffs.length > 0) {
    problems.push(
      `${rel} means something DIFFERENT under YAML 1.1 and YAML 1.2 value resolution (the ` +
        `two schemas), so no reading of it can be trusted to be the one Docker Compose ` +
        `takes: ${diffs.join('; ')}. ` +
        `'on'/'yes'/'off' are booleans in 1.1 and strings in 1.2, '0777' is 511 in 1.1 and ` +
        `777 in 1.2, '12:30' is 750 in 1.1 and a string in 1.2, and a bare '.' is null in ` +
        `1.1 and '.' in 1.2. Quote the value. (Merge keys are NOT this: both readings ` +
        `resolve '<<', so an x- fragment is fine.)`,
    );
    return fail();
  }

  // B2. `include:` pulls whole compose files in; nothing here follows it.
  if ('include' in parsed) {
    problems.push(
      `${rel} uses the top-level 'include:' key, which this gate does not follow — the ` +
        `included file may declare services, builds, ports and networks it never reads. ` +
        `Wire the file into scripts/svc's compose_files_for() instead, where it is part ` +
        `of the derived set (OD-37), or teach this gate to resolve 'include:' first.`,
    );
    return fail();
  }

  // B1. `extends:` names a service, possibly in another file. `T-017` §R5 ruled
  // this a hard failure in gate:egress-boundary; the ruling belongs at the
  // PARSE, where every reader gets it.
  const services = parsed['services'];
  if (isRecord(services)) {
    for (const [name, svc] of Object.entries(services)) {
      if (isRecord(svc) && 'extends' in svc) {
        problems.push(
          `${rel}: service '${name}' uses 'extends', which this gate cannot follow — the ` +
            `inherited definition may carry a build:, a ports: key or a networks: key ` +
            `this gate never sees. Teach the gate to resolve 'extends' before using it ` +
            `here. (An unmodelled compose feature FAILS; it is never passed — T-017 §R5.)`,
        );
      }
    }
  }
  if (problems.length > 0) return fail();

  return { doc: parsed, problems, schemasAgreed: true };
}

/** What the straggler scan needs to know about a file `scripts/svc` does not compose. */
export type ComposeShape =
  | { readonly kind: 'compose' }
  | { readonly kind: 'not-compose' }
  | { readonly kind: 'unreadable'; readonly why: string };

/**
 * Is this file compose-shaped — a top-level `services:` mapping in ANY of its
 * documents, under EITHER YAML reading? (OD-42.) Deliberately NOT
 * `parseCompose`: a straggler is reported whatever else is wrong with it, so
 * the only question here is whether it is a compose file, and the answer must
 * not depend on how many documents it has. A file that cannot be read is
 * `unreadable`, never `not-compose`: its compose-ness is unknown, and the
 * caller reports an unknown as a failure. So is a file carrying a YAML 1.1
 * line break (A10), whose services: YAML 1.2 would read as a comment.
 */
export function composeShape(text: string): ComposeShape {
  // A10 (OD-43): a file the 1.2 lexer and compose tokenise differently has no
  // shape this reader can vouch for — to YAML 1.2 its services: may be a comment.
  const breaks = yaml11LineBreaks(text);
  if (breaks !== null) return { kind: 'unreadable', why: breaks };
  try {
    let compose = false;
    for (const opts of [READ_12, READ_11]) {
      for (const d of parseAllDocuments(text, opts)) {
        const e = d.errors[0];
        if (e !== undefined) {
          return { kind: 'unreadable', why: e.message.split('\n')[0] ?? e.message };
        }
        const js: unknown = d.toJS();
        if (isRecord(js) && isRecord(js['services'])) compose = true;
      }
    }
    return compose ? { kind: 'compose' } : { kind: 'not-compose' };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { kind: 'unreadable', why: msg ?? 'unknown error' };
  }
}
