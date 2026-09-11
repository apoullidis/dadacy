/**
 * THE ONE PLACE THESE GATES READ A COMPOSE FILE (T-130; its parse residue, T-131).
 *
 * First written as `T-037` rework cycle 1 (`66d28d5`), which never merged:
 * `T-037` was retired under OE-11 and this reader was re-cut as its own
 * ticket. It is re-applied here with the one regression that retired it
 * closed (OD-41), and with the members of its class `T-130` found or was
 * handed (OD-42, the `%YAML` directive, the self-referential alias, QA8's
 * uncaught exception). `T-131` added A11-A14 and made A3's comparison typed
 * (OD-44, OD-45, OD-46, OD-48).
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
 * This reader reads every file TWICE with ONE LEXER — `yaml@2.8.1`'s, which
 * TARGETS YAML 1.2 syntax and is measured to DEPART from it on a lone CR
 * (OD-45; refused by presence, A11) — once under the YAML 1.2 core SCHEMA and
 * once under the YAML 1.1 SCHEMA, both with `<<` resolved. A3 compares the two
 * readings VALUE BY VALUE, BY KIND: two values agree when both are null, a
 * boolean, a number, a string, an array or a plain mapping, of the same kind,
 * and (for a scalar) `Object.is`-equal. Anything else at a path in EITHER
 * reading is a divergence. The one such value measured is the `Date` YAML
 * 1.1 makes of a timestamp. Until T-131 the comparison was `JSON.stringify`
 * text, and a timestamp in `Date.toJSON()` form (`2026-09-11T00:00:00.000Z`)
 * printed the same as the 1.2 string and passed (OD-46; cases 128 / 62). KEY
 * ORDER is NOT compared. The one construction measured to make the two
 * readings differ only in order (OD-48 (1)) is refused by A14 instead.
 * `yaml`'s `version: '1.1'` option selects how a scalar or tag RESOLVES; it
 * does not select how the text is TOKENISED (T-130 rework 1, TL-F1, measured
 * against PyYAML and compose). So A3 can only see a SCHEMA difference, and is
 * structurally blind to a SYNTAX difference: a file YAML 1.1 and YAML 1.2
 * tokenise differently is read identically twice. It does NOT read the file
 * "as YAML 1.1"; it tokenises as `yaml`'s lexer does. TWO 1.1/1.2 syntax
 * differences have been measured, and each is refused, in different places:
 * the Unicode line breaks BY PRESENCE anywhere in the file (A10), and the `\/`
 * escape only INSIDE A DOUBLE-QUOTED SCALAR (A13). A `\/` in a comment or in a
 * plain, single-quoted or block scalar is accepted, and compose reads those
 * literally too (measured, T-131 QA-2; T-131 rework 1, QA-F3).
 *
 * THE CLASS — every member MEASURED, each MODELLED or FAIL-CLOSED. NOT
 * EXHAUSTIVE: a construct nobody has measured is not in this list, and it is
 * not claimed to be refused (see WHAT IS NOT CLOSED, below).
 * ----------------------------------------------------------------------
 *   A1  `<<` merge keys ................. MODELLED (both readings resolve them)
 *   A2  anchors and plain aliases ....... MODELLED (`yaml` resolves them; both
 *                                         readings agree) — as VALUES. An alias
 *                                         used as a KEY (`*k : v`) is NOT seen
 *                                         by A14's collision check (below)
 *   A3  a value whose 1.1- and 1.2-SCHEMA readings differ in KIND or in
 *       scalar value (`on`, `yes`, `0777`, `12:30`, a bare `.`, a 1.1 `Date`
 *       timestamp, …) FAIL CLOSED — derived by comparing the two readings value
 *                                         by value, not by a list of spellings;
 *                                         a divergent KEY counts too. Key ORDER
 *                                         is not compared (OD-48; see A14)
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
 *   A7  a parse error, a non-mapping root, no document
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
 *       .................................. FAIL CLOSED (OD-43). One of the TWO
 *       YAML 1.1/1.2 SYNTAX differences measured (the other is A13): YAML 1.1
 *       and compose break lines on them, YAML 1.2 — and this reader's one
 *       lexer — do not, so a build:, a port or a service can sit after one on
 *       a comment line. Refused by presence, because A3's comparison cannot see
 *       it. Both entry points (`parseCompose`, `composeShape`).
 *   A11 a LONE CR — `\r` not followed by `\n` — anywhere in the file
 *       .................................. FAIL CLOSED (OD-45 (1), T-131). Not a
 *       1.1/1.2 difference: YAML 1.2 itself (1.2.2 [28] `b-break`), compose and
 *       PyYAML break lines on it and `yaml@2.8.1` does not, so a build: or a
 *       service can hide behind one exactly as behind A10's characters. CRLF is
 *       not this and is read normally. Both entry points.
 *   A12 U+0000 or U+FFFD anywhere in the text as decoded
 *       .................................. FAIL CLOSED (OD-45 (2), T-131). The
 *       callers decode every file as UTF-8. The three UTF-16 variants measured
 *       (LE with and without a BOM, BE with one) decode to text carrying U+0000,
 *       and the two with a BOM U+FFFD too; compose reads UTF-16 (measured), so
 *       this reader would be reading different text from the file compose loads.
 *       U+0000 is not a YAML character at all. U+FFFD is what an invalid UTF-8
 *       byte decodes to, and the reader cannot tell that from the character
 *       itself, so both are refused. Both entry points. A LITERAL U+FFFD in a
 *       valid UTF-8 file is therefore refused too, and compose ACCEPTS that
 *       file (measured, T-131 QA-2): an over-refusal, and the message says so
 *       rather than calling the file not UTF-8 (T-131 rework 1, QA-F2).
 *   A13 the `\/` escape inside a double-quoted scalar
 *       .................................. FAIL CLOSED (OD-44, T-131). YAML 1.2
 *       added it; compose REFUSES the file (measured: "found unknown escape
 *       character"). Refusing it here makes the gate and compose agree, rather
 *       than the gate passing a file compose will not load. Found by walking
 *       the parsed document's double-quoted scalars and their escapes, so `\\/`
 *       (an escaped backslash) and a `\/` in a comment or a single-quoted or
 *       plain scalar are not refused. `parseCompose` only: it changes no key.
 *   A14 two SCALAR keys in one mapping that name the SAME property
 *       .................................. FAIL CLOSED (OD-48, T-131). `toJS()`
 *       names each property `String(key)`, and `yaml`'s own duplicate-key
 *       check compares values with `===`, so `1:` and `"1":` (or, under 1.1,
 *       `017:` and `"15":`) were two keys to the check and one property to
 *       every rule here: one value was dropped without a word, and the two
 *       readings could differ in key order alone. Compose calls such keys
 *       duplicates (measured: `mapping key "1" already defined`). Refused by
 *       giving `yaml` a key equality that also compares the property name, in
 *       both readings and at both entry points. NOT MODELLED, and so NOT
 *       refused by A14: a key that is not a scalar node — an ALIAS key
 *       (`*k : v`, an `Alias` node even when its anchor is a scalar) or a
 *       COLLECTION key — and an object-valued scalar key (a 1.1 `Date`), which
 *       `yaml` names with its own stringifier. A timestamp key is refused by
 *       A3. Measured (T-131 QA-F1, QA-4b): OD-48's two shapes (cases 137 and
 *       138) written with ALIAS keys pass both gates at exit 0, and so does an
 *       alias key beside the scalar key it names. Compose refuses the first two
 *       and keeps the same (later) value as this reader on the third. Two
 *       collection keys naming one property are accepted here and refused by
 *       compose. So OD-48 is closed for SCALAR keys only (T-131 rework 1).
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
 * found, and A10 and A11 were others. EVERY 1.1/1.2 SYNTAX difference is of
 * this kind, because both readings share one lexer; the YAML 1.2 specification
 * names the line-break change (A10) and otherwise says only "production bug
 * fixes", so no list of the rest exists to check against (T-130 § Published
 * contract §0, the 1.1→1.2 syntax-change table). So is a departure of
 * `yaml@2.8.1` from YAML 1.2 itself: the lone CR (A11) is the one measured, and
 * no walk of the spec's change list can find another. OPEN AT THE TIME OF
 * WRITING:
 *   - the spec's unenumerated "production bug fixes", and any other departure
 *     of `yaml@2.8.1` from YAML 1.2 — none known, none claimed absent;
 *   - key ORDER, which A3 does not compare (the order-only construction
 *     measured is refused by A14 when its keys are scalars, and ACCEPTED when
 *     two of them are written as alias keys — T-131 QA-F1);
 *   - keys that are not scalar nodes (alias keys, collection keys) and
 *     object-valued scalar keys, which A14 does not model: two such keys, or
 *     one beside the scalar key it names, are NOT refused (QA-F1, QA-4b);
 *   - an encoding other than UTF-8 that decodes WITHOUT U+0000 or U+FFFD (none
 *     known; every UTF-16 and UTF-32 variant measured carries U+0000, T-131
 *     QA-2).
 * The instrument for finding the next one is `docker compose config`,
 * which these gates cannot run: they have no Docker socket, by design
 * (`gate:toolbox` §6). A UNIVERSAL IS ONLY AS WIDE AS THE PARSE IT IS COMPUTED
 * FROM.
 */
import { isScalar, parseAllDocuments, visit } from 'yaml';
import type { Document, ParsedNode } from 'yaml';

export interface ComposeParse {
  /** The document, as both readings (one lexer, two schemas) agree on it. `null` means FAIL CLOSED. */
  readonly doc: Record<string, unknown> | null;
  /** Diagnostics the caller must push onto its failure list. */
  readonly problems: readonly string[];
  /**
   * True when the 1.2- and 1.1-SCHEMA readings agreed under A3 (value by value,
   * by kind; key order not compared) and the file was read. Schema only.
   */
  readonly schemasAgreed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `!!` handle's standard prefix; anything else means a `%TAG` remapped it. */
const CORE_TAG_PREFIX = 'tag:yaml.org,2002:';

/**
 * A14 (OD-48). The JS property a scalar KEY becomes in `toJS()`, mirroring
 * `yaml@2.8.1`'s `stringifyKey` for the keys modelled here: `null` → '' and any
 * other non-object value → `String(value)`. `null` means "not modelled": a
 * merge key (it becomes no property: `addPairToJSMap`'s `addToJSMap` and
 * bare-`<<` branches), an ALIAS key (an `Alias` node, not a `Scalar`; it is
 * not resolved to its anchor here, so a collision through one is not seen —
 * T-131 QA-F1), a collection key, or an object-valued scalar such as a 1.1
 * `Date`, which `yaml` names with its own stringifier.
 */
function propertyName(n: ParsedNode): string | null {
  if (!isScalar(n)) return null;
  if ((n as { addToJSMap?: unknown }).addToJSMap !== undefined) return null;
  const v: unknown = n.value;
  if (v === '<<' && (n.type === undefined || n.type === 'PLAIN')) return null;
  if (v === null) return '';
  if (typeof v === 'object' || typeof v === 'function') return null;
  return String(v as string | number | boolean | bigint | symbol);
}

/**
 * A14. `yaml`'s own key equality (its default, kept verbatim) OR the same
 * property name. Handed to `yaml` as `uniqueKeys`, so a collision is reported
 * as the library's own DUPLICATE_KEY error, in whichever reading it arises.
 */
const sameKey = (a: ParsedNode, b: ParsedNode): boolean => {
  if (a === b || (isScalar(a) && isScalar(b) && a.value === b.value)) return true;
  const pa = propertyName(a);
  return pa !== null && pa === propertyName(b);
};

const READ_12 = { merge: true, logLevel: 'silent', uniqueKeys: sameKey } as const;
const READ_11 = { version: '1.1', merge: true, logLevel: 'silent', uniqueKeys: sameKey } as const;

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

/** What A3 compares a reading's value as. `other` is never equal to anything. */
type Kind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'mapping' | 'other';
function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'object': {
      const proto: unknown = Object.getPrototypeOf(v);
      return proto === Object.prototype || proto === null ? 'mapping' : 'other';
    }
    default:
      // `undefined` (a key one reading lacks), bigint, symbol, function.
      return 'other';
  }
}

/** A reading's value, for a diagnostic: JSON for plain kinds, named for anything else. */
function describe(v: unknown): string {
  if (kindOf(v) !== 'other') return JSON.stringify(v);
  if (v === undefined) return 'nothing (the key is absent)';
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? 'an invalid Date' : `a Date (${v.toISOString()})`;
  }
  if (typeof v === 'object') {
    const ctor: unknown = (v as { constructor?: { name?: unknown } }).constructor?.name;
    return `a ${typeof ctor === 'string' ? ctor : 'non-plain object'}`;
  }
  return `a ${typeof v}`;
}

/**
 * The first few paths at which two readings of the same file DIVERGE — A3.
 * Value by value, by kind: see the header. Key order is not compared.
 */
function divergences(a: unknown, b: unknown, at: string, out: string[]): void {
  if (out.length >= 4) return;
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka === kb && (ka === 'array' || ka === 'mapping')) {
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
  if (ka === kb && ka !== 'other' && Object.is(a, b)) return;
  out.push(`${at || '(root)'}: YAML 1.2 reads ${describe(a)}, YAML 1.1 reads ${describe(b)}`);
}

/** Read a composed file as both readings (one lexer, two schemas) agree on it, or fail closed. */
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

/** 1-based line of offset `at`, counting `\n` only. */
const lineOf = (text: string, at: number): string => String(text.slice(0, at).split('\n').length);

/**
 * A10 (OD-43). The three characters YAML 1.1 treats as LINE BREAKS and YAML
 * 1.2 does not (YAML 1.2.2 §5.4: "YAML version 1.1 did support the above
 * non-ASCII line break characters … YAML treats them as non-break characters
 * as of version 1.2"). `yaml`'s lexer, which targets 1.2 in both readings,
 * treats them as 1.2 does, so text after one of them on a comment line is a
 * COMMENT to every rule here — and, measured with `docker compose config`, LIVE
 * YAML to compose. Refused wherever they appear, because compose files have no
 * use for them and the comparison in A3 cannot see the difference (one lexer,
 * two schemas).
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
    if (at >= 0) found.push(`${name} at line ${lineOf(text, at)}`);
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

/** A11 (OD-45 (1)): the refusal text for a `\r` not followed by `\n`, or `null`. */
function loneCarriageReturn(text: string): string | null {
  const m = /\r(?!\n)/.exec(text);
  if (m === null) return null;
  return (
    `contains a LONE CR (a carriage return not followed by a line feed) at line ` +
    `${lineOf(text, m.index)}. YAML 1.2 itself, Docker Compose and PyYAML break lines on it ` +
    `and yaml@2.8.1, which both of this reader's readings use, does not (measured, OD-45), ` +
    `so text after it on a comment line is live YAML to compose and a comment to every rule ` +
    `here: a build:, a port or a whole service can hide behind one. CRLF line endings are ` +
    `not this and are read normally. Remove the character (T-131, A11).`
  );
}

/** A12 (OD-45 (2)): the refusal text for U+0000 / U+FFFD in the decoded text, or `null`. */
function notUtf8Text(text: string): string | null {
  const found: string[] = [];
  const nul = text.indexOf('\u0000');
  if (nul >= 0) found.push(`U+0000 (NUL) at line ${lineOf(text, nul)}`);
  const bad = text.indexOf('\uFFFD');
  if (bad >= 0) {
    found.push(
      `U+FFFD (what a byte that is not UTF-8 decodes to, or a literal U+FFFD) at line ` +
        `${lineOf(text, bad)}`,
    );
  }
  if (found.length === 0) return null;
  // T-131 rework 1, QA-F2: the message names both things this check cannot
  // tell apart. It changes no verdict: the same two characters are refused.
  const literal =
    bad >= 0
      ? ` Or it IS UTF-8 and carries a literal U+FFFD, which this check cannot tell apart ` +
        `from a byte that is not UTF-8 and refuses as well, although Docker Compose accepts ` +
        `it (measured, T-131 QA-2).`
      : '';
  return (
    `contains ${found.join(' and ')}. Either it is not UTF-8 text as this gate reads it: a ` +
    `UTF-16 file reads like this, and Docker Compose reads UTF-16 (measured, OD-45), so ` +
    `this gate would be checking different text from the file compose loads.${literal} ` +
    `Save the file as UTF-8, with no U+0000 or U+FFFD in it (T-131, A12).`
  );
}

/** The refusals that must run BEFORE any parse, in both entry points. */
function beforeParse(text: string): string | null {
  return notUtf8Text(text) ?? yaml11LineBreaks(text) ?? loneCarriageReturn(text);
}

/**
 * A13 (OD-44). The offset of the first `\/` escape inside a double-quoted
 * scalar of `doc`, or -1. The scalar's source is re-scanned escape by escape,
 * so `\\/` — an escaped backslash, then a slash — is not one.
 */
function jsonSlashEscape(text: string, doc: Document.Parsed): number {
  const hits: number[] = [];
  visit(doc, {
    Scalar(_key, node) {
      if (node.type !== 'QUOTE_DOUBLE' || !node.range) return undefined;
      const [start, end] = node.range;
      for (let i = start; i < end; i += 1) {
        if (text[i] !== '\\') continue;
        if (text[i + 1] === '/') {
          hits.push(i);
          return visit.BREAK;
        }
        i += 1;
      }
      return undefined;
    },
  });
  return hits[0] ?? -1;
}

function parseComposeUnguarded(rel: string, text: string): ComposeParse {
  const problems: string[] = [];
  const fail = (): ComposeParse => ({ doc: null, problems, schemasAgreed: false });

  // A12, A10, A11 — before any parse: every later check reads what `yaml`'s
  // lexer tokenised from text decoded as UTF-8, and on these that is not what
  // compose reads.
  const early = beforeParse(text);
  if (early !== null) {
    problems.push(`${rel} ${early}`);
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

  // A7, and A14 — a key collision arrives as the library's DUPLICATE_KEY error,
  // because A14's equality is the `uniqueKeys` option both readings use.
  const reported = new Set<string>();
  for (const d of [d12, d11]) {
    for (const e of d.errors) {
      const first = e.message.split('\n')[0] ?? e.message;
      reported.add(
        e.code === 'DUPLICATE_KEY'
          ? `${rel}: two keys in one mapping name the SAME property (line ` +
              `${String(e.linePos?.[0].line ?? '?')}) — equal keys, or keys that differ only in ` +
              `how YAML types them, such as 1: and "1":, or 017: and "15": under YAML 1.1. ` +
              `Every rule here would see one of them and drop the other without a word, and ` +
              `Docker Compose refuses such a file (measured: 'mapping key "1" already ` +
              `defined', OD-48). Remove or rename one (T-131, A14).`
          : `${rel} is not parseable YAML: ${first}`,
      );
    }
  }
  problems.push(...reported);
  if (problems.length > 0) return fail();

  // A13 — source-level, so it reads the scalar as written, not as resolved.
  const slash = jsonSlashEscape(text, d12);
  if (slash >= 0) {
    problems.push(
      `${rel} uses the \\/ escape inside a double-quoted scalar at line ${lineOf(text, slash)}. ` +
        `YAML 1.2 added it and this reader accepts it, but Docker Compose REFUSES the file ` +
        `(measured: 'found unknown escape character', OD-44), so a pass here would be a pass ` +
        `on a file compose will not load. Write a plain '/' (T-131, A13).`,
    );
    return fail();
  }

  // A5. A directive pins one version for BOTH readings, so the comparison in
  // A3 below would compare a reading with itself and never fire.
  if (d12.directives?.yaml.explicit === true || d11.directives?.yaml.explicit === true) {
    problems.push(
      `${rel} carries a %YAML directive. It overrides the schema this gate reads with, so ` +
        `both of its readings become that one version and the check that compares its 1.1- ` +
        `and 1.2-schema readings can no longer fire (T-130, A5). Compose ` +
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
  // comparison below can recurse into it.
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

  // A3. The property aimed at is about the FILE, not about the reader: a
  // composed file must not resolve to two different values under the 1.1 and
  // 1.2 SCHEMAS, because no reading of it can then be trusted to be compose's.
  // What this CHECKS is narrower: value by value, by kind (see `kindOf`), and
  // not key order. The repair is to quote the scalar, which changes nothing
  // for compose. SCHEMA only: both readings share one lexer, so this cannot
  // see a SYNTAX difference (A10, A11, A13).
  const diffs: string[] = [];
  divergences(parsed, parsed11, '', diffs);
  if (diffs.length > 0) {
    problems.push(
      `${rel} means something DIFFERENT under YAML 1.1 and YAML 1.2 value resolution (the ` +
        `two schemas), so no reading of it can be trusted to be the one Docker Compose ` +
        `takes: ${diffs.join('; ')}. ` +
        `'on'/'yes'/'off' are booleans in 1.1 and strings in 1.2, '0777' is 511 in 1.1 and ` +
        `777 in 1.2, '12:30' is 750 in 1.1 and a string in 1.2, a bare '.' is null in ` +
        `1.1 and '.' in 1.2, and an unquoted timestamp is a Date in 1.1 and a string in 1.2 ` +
        `(compose reads it as a time, OD-46). Quote the value. (Merge keys are NOT this: ` +
        `both readings resolve '<<', so an x- fragment is fine.)`,
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
 * caller reports an unknown as a failure. So is a file carrying U+0000 or
 * U+FFFD (A12), a YAML 1.1 line break (A10) or a lone CR (A11), whose
 * services: `yaml` may read as a comment or not at all.
 */
export function composeShape(text: string): ComposeShape {
  const early = beforeParse(text);
  if (early !== null) return { kind: 'unreadable', why: early };
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
