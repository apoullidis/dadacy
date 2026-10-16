/**
 * `gate:read-aloud` — T-263. SA §TS-12.4 (solutions-architect.md:1084-1087)
 * as ruled by OE-82 (2026-10-11): the read-aloud pass over spoken safety copy
 * is an AUTOMATED check enforced by a gate, not a `who: "dsl"` stage. Cut:
 * tasks/state/EP-0/OE-82-cut.md § T-263.
 *
 * THE RULE. For every enabled locale (`locale-registry.json`) x every key in
 * `READ_ALOUD_KEYS_PINNED` (tools/automated-checks.ts — a literal, never read
 * from review.json), expand the ICU message into EVERY FORM — each cardinal
 * plural category the locale has, derived from `Intl.PluralRules` and never
 * from the catalogue, each explicit `=N` branch, each `select` branch — and
 * for each form:
 *
 *   R1 UNSPEAKABLE-CHAR   template text ({param} and # inert) and the spoken
 *                         text: a character that is not a letter of the
 *                         locale's script, a decimal digit, a space or one of
 *                         SPEAKABLE_PUNCTUATION — or a U+002D that is not
 *                         between two letters of one script (OD-356). Leftover ICU syntax is caught
 *                         here, in the spoken text, when a fixture is missing.
 *   R2 MIXED-SCRIPT-WORD  a word with letters from two scripts.
 *   R3 UNLISTED-NUMBER    a digit run (inner spaces allowed) not in SPOKEN_NUMBERS.
 *   R4 UNLISTED-ACRONYM   two or more consecutive capitals, not an allowed token.
 *   R5 SENTENCE-TOO-LONG  more than MAX_WORDS_PER_SENTENCE words in a sentence.
 *   R6 TTS                synthesise the fixture-substituted text with
 *                         `espeak-ng -v <voice> -x -w <wav>`. No binary on PATH
 *                         -> TTS-UNAVAILABLE (never a pass). Non-zero exit, ANY
 *                         stderr output, or a WAV with no audio -> TTS-FAILED
 *                         (T-262: espeak-ng exits 0 with a missing dictionary,
 *                         and says so only on stderr). Duration from the WAV
 *                         header over the channel's budget -> TOO-LONG-SPOKEN,
 *                         with the measured ms.
 *
 * THE RECORD, `checks/read-aloud.json`: one entry per (locale, key) with the
 * register's `content_hash`, per form `text_sha256`, `duration_ms`,
 * `audio_sha256`, `phonemes_sha256`, `result: "pass"`, `tool`, and
 * `checked_by: "automation:gate:read-aloud"`. No wall-clock field: git dates
 * the commit, and a timestamp would make re-derivation non-deterministic.
 *
 * MODES. With no argument it VERIFIES: everything is recomputed and the
 * committed record must equal it (RECORD-DRIFT, MISSING-RECORD, EXTRA-RECORD,
 * CLAIMS-HUMAN-CHECK). `--write` regenerates the record, and only when every
 * check passes. Both refuse FORMS-INCOMPLETE (the forms expanded differ from
 * the forms `Intl.PluralRules` and the message's own branches require),
 * CHANNEL-DRIFT (the review.json keys whose channel is not `screen`, with
 * their channels, differ from READ_ALOUD_KEYS_PINNED) and NOTHING-CHECKED.
 *
 * TWO READINGS THAT ARE NOT EACH OTHER (PROTOCOL §5.1). The form's spoken text
 * is rendered by this file's own walker AND by `intl-messageformat` (the real
 * ICU evaluator); they must agree (RENDER-MISMATCH). The forms expanded are
 * compared with a set computed by a separate function straight from
 * `Intl.PluralRules` (FORMS-INCOMPLETE).
 *
 * USAGE:  node packages/i18n/tools/read-aloud.ts [--write] [--root <dir>]
 *
 * `--root` points every reading (registry, review.json, catalogues, record) at
 * another package root; the Vitest cases build one in a temporary directory.
 * The banner names the root on both paths, so a `--root` run cannot be pasted
 * as the real one. Any other argument exits 2 with no banner. Output: stdout.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { IntlMessageFormat } from 'intl-messageformat';
import {
  CHECKED_BY,
  CHECK_TOOLS,
  DURATION_BUDGET_MS,
  FIXTURE_PARAMS,
  FIXTURE_PLURAL_COUNTS,
  LOCALE_SCRIPT,
  MAX_WORDS_PER_SENTENCE,
  READ_ALOUD_KEYS_PINNED,
  SPEAKABLE_PUNCTUATION,
  SPOKEN_NUMBERS,
  SPOKEN_TOKENS_ALLOWED,
  VOICES,
} from './automated-checks.ts';
import type { SpokenChannel } from './automated-checks.ts';

const GATE = 'gate:read-aloud';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD_PATH = join('checks', 'read-aloud.json');
const TOOL = 'espeak-ng';

/* ------------------------------------------------------------------ argv */

interface Args {
  root: string;
  explicitRoot: boolean;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { root: PACKAGE_ROOT, explicitRoot: false, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      args.write = true;
      continue;
    }
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`${GATE}: --root needs a directory`);
        process.exit(2);
      }
      args.root = value;
      args.explicitRoot = true;
      i += 1;
      continue;
    }
    // Refused rather than ignored: an unknown argument is most likely a
    // narrowing someone expected to take effect.
    console.error(`${GATE}: unrecognised argument ${JSON.stringify(arg)}`);
    process.exit(2);
  }
  return args;
}

/* --------------------------------------------------------------- helpers */

function sha256(data: string | Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function codePoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/* ------------------------------------------------------- the ICU forms */

/** A plural or select argument the message branches on. */
interface Branching {
  kind: 'plural' | 'select';
  /** option keys written in the message (`one`, `=0`, `male`, `other`, …) */
  keys: Set<string>;
}

class UnsupportedIcu extends Error {}

/** Every branching argument, found anywhere in the message, nested ones included. */
function branchingArgs(ast: readonly MessageFormatElement[], out = new Map<string, Branching>()) {
  for (const el of ast) {
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      const kind = el.type === TYPE.plural ? 'plural' : 'select';
      if (el.type === TYPE.plural && el.pluralType === 'ordinal')
        throw new UnsupportedIcu(`selectordinal {${el.value}} is not modelled`);
      if (el.type === TYPE.plural && el.offset !== 0)
        throw new UnsupportedIcu(`plural {${el.value}} has offset:${String(el.offset)}`);
      const b = out.get(el.value) ?? { kind, keys: new Set<string>() };
      if (b.kind !== kind) throw new UnsupportedIcu(`{${el.value}} is both plural and select`);
      for (const [k, opt] of Object.entries(el.options)) {
        b.keys.add(k);
        branchingArgs(opt.value, out);
      }
      out.set(el.value, b);
    } else if (
      el.type === TYPE.number ||
      el.type === TYPE.date ||
      el.type === TYPE.time ||
      el.type === TYPE.tag
    ) {
      throw new UnsupportedIcu(`element type ${String(el.type)} is not modelled`);
    }
  }
  return out;
}

/** The categories THE EXPANSION enumerates for a cardinal plural. */
function expansionCategories(locale: string): string[] {
  return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories];
}

/** The values the expansion enumerates for one argument. */
function expansionValues(locale: string, b: Branching): string[] {
  if (b.kind === 'select') return [...b.keys].sort();
  const explicit = [...b.keys].filter((k) => k.startsWith('=')).sort();
  return [...expansionCategories(locale), ...explicit];
}

type Combo = ReadonlyArray<readonly [string, string]>;

/** Every combination of argument values; one empty combination for a message with none. */
function combos(locale: string, args: Map<string, Branching>): Combo[] {
  let acc: Combo[] = [[]];
  for (const name of [...args.keys()].sort()) {
    const b = args.get(name);
    if (b === undefined) continue;
    const next: Combo[] = [];
    for (const c of acc) for (const v of expansionValues(locale, b)) next.push([...c, [name, v]]);
    acc = next;
  }
  return acc;
}

function formName(c: Combo): string {
  return c.length === 0 ? 'base' : c.map(([n, v]) => `${n}=${v}`).join(';');
}

/**
 * The forms the message REQUIRES, computed separately from the expansion,
 * straight from `Intl.PluralRules` and the message's own option keys.
 */
function requiredForms(locale: string, args: Map<string, Branching>): Set<string> {
  let names: string[][] = [[]];
  for (const name of [...args.keys()].sort()) {
    const b = args.get(name);
    if (b === undefined) continue;
    const values =
      b.kind === 'select'
        ? [...b.keys]
        : [
            ...new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
            ...[...b.keys].filter((k) => k.startsWith('=')),
          ];
    names = names.flatMap((prefix) => values.map((v) => [...prefix, `${name}=${v}`]));
  }
  return new Set(names.map((parts) => (parts.length === 0 ? 'base' : parts.sort().join(';'))));
}

const INERT_OPEN = '⟦';
const INERT_CLOSE = '⟧';
const INERT = /⟦[^⟧]*⟧/gu;

interface Rendered {
  template: string;
  spoken: string;
  /** values to hand intl-messageformat for the cross-check; undefined if a fixture is missing */
  values: Record<string, string | number> | undefined;
  problems: string[];
}

function renderForm(locale: string, ast: readonly MessageFormatElement[], c: Combo): Rendered {
  const chosen = new Map(c);
  const fixtures = FIXTURE_PARAMS[locale] ?? {};
  const counts = FIXTURE_PLURAL_COUNTS[locale] ?? {};
  const nf = new Intl.NumberFormat(locale);
  const problems: string[] = [];
  const values: Record<string, string | number> = {};
  let complete = true;

  const walk = (
    els: readonly MessageFormatElement[],
    count: number | undefined,
  ): [string, string] => {
    let t = '';
    let s = '';
    for (const el of els) {
      if (el.type === TYPE.literal) {
        t += el.value;
        s += el.value;
      } else if (el.type === TYPE.argument) {
        t += `${INERT_OPEN}${el.value}${INERT_CLOSE}`;
        const f = fixtures[el.value];
        if (f === undefined) {
          complete = false;
          s += `{${el.value}}`;
        } else {
          values[el.value] = f;
          s += f;
        }
      } else if (el.type === TYPE.pound) {
        t += `${INERT_OPEN}#${INERT_CLOSE}`;
        s += count === undefined ? '#' : nf.format(count);
      } else if (el.type === TYPE.plural) {
        const key = chosen.get(el.value) ?? 'other';
        let n: number | undefined;
        if (key.startsWith('=')) n = Number(key.slice(1));
        else {
          n = counts[key];
          if (n === undefined) {
            problems.push(`NO-FIXTURE no plural count for category '${key}' in ${locale}`);
            complete = false;
          }
        }
        if (n !== undefined) values[el.value] = n;
        const opt = el.options[key] ?? el.options['other'];
        if (opt === undefined) throw new UnsupportedIcu(`plural {${el.value}} has no other`);
        const [tt, ss] = walk(opt.value, n);
        t += tt;
        s += ss;
      } else if (el.type === TYPE.select) {
        const key = chosen.get(el.value) ?? 'other';
        values[el.value] = key;
        const opt = el.options[key] ?? el.options['other'];
        if (opt === undefined) throw new UnsupportedIcu(`select {${el.value}} has no other`);
        const [tt, ss] = walk(opt.value, count);
        t += tt;
        s += ss;
      } else {
        throw new UnsupportedIcu(`element type ${String(el.type)} is not modelled`);
      }
    }
    return [t, s];
  };
  const [template, spoken] = walk(ast, undefined);
  return {
    template: template.normalize('NFC'),
    spoken: spoken.normalize('NFC'),
    values: complete ? values : undefined,
    problems,
  };
}

/* -------------------------------------------------------- R1 to R5 */

const SCRIPT_RE: Readonly<Record<string, RegExp>> = {
  Latin: /\p{Script=Latin}/u,
  Greek: /\p{Script=Greek}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
};

function scriptOf(ch: string): string {
  for (const [name, re] of Object.entries(SCRIPT_RE)) if (re.test(ch)) return name;
  return 'Other';
}

const ALLOWED_TOKEN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${SPOKEN_TOKENS_ALLOWED.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);

/**
 * OD-356 (ruled 2026-10-16T08:48:17Z; stated in tools/automated-checks.ts): a U+002D is speakable
 * only between two letters of the same script. Inert tokens and allowed tokens
 * have already become spaces, so a hyphen next to `{param}` or `#` is refused.
 */
function wordInternalHyphen(prev: string | undefined, next: string | undefined): boolean {
  if (prev === undefined || next === undefined) return false;
  if (!/\p{L}/u.test(prev) || !/\p{L}/u.test(next)) return false;
  return scriptOf(prev) === scriptOf(next) && scriptOf(prev) !== 'Other';
}

/** R1 over one text: the distinct characters that are not speakable in `locale`. */
function unspeakable(locale: string, text: string): string[] {
  const script = LOCALE_SCRIPT[locale];
  // Inert tokens become ONE space in both readings, so a hyphen beside `{param}`
  // or `#` has a space for a neighbour and is refused (OD-356). Allowed tokens
  // are blanked for the script test only, and padded to their own length, so
  // the hyphen test reads the ORIGINAL letters on both sides: `SOS-ready` has
  // S and r, both Latin, and is admitted, as the ruling says (T-263 rework 1, QA F1).
  const withInert = Array.from(text.replace(INERT, ' '));
  const chars = Array.from(
    text.replace(INERT, ' ').replace(ALLOWED_TOKEN_RE, (m) => ' '.repeat(Array.from(m).length)),
  );
  if (chars.length !== withInert.length)
    throw new Error('allowed-token blanking changed the text length');
  const bad = new Set<string>();
  for (const [i, ch] of chars.entries()) {
    if (ch === ' ' || (ch >= '0' && ch <= '9') || SPEAKABLE_PUNCTUATION.includes(ch)) continue;
    if (ch === '-' && wordInternalHyphen(withInert[i - 1], withInert[i + 1])) continue;
    if (/\p{L}/u.test(ch) && script !== undefined && scriptOf(ch) === script) continue;
    bad.add(ch);
  }
  return [...bad];
}

function words(text: string): string[] {
  return text
    .replace(INERT, ' ')
    .split(/[^\p{L}\p{M}\p{N}'’-]+/u)
    .map((w) => w.replace(/^['’-]+|['’-]+$/gu, ''))
    .filter((w) => w !== '');
}

const SENTENCE_END: Readonly<Record<string, RegExp>> = {
  el: /[.!;;?]+/u,
};
const DEFAULT_SENTENCE_END = /[.!?]+/u;

function lint(locale: string, form: string, r: Rendered, where: string): string[] {
  const p: string[] = [];
  const at = `${where} [${form}]`;
  if (LOCALE_SCRIPT[locale] === undefined)
    p.push(`UNSPEAKABLE-CHAR ${at}: no script is pinned for '${locale}'`);
  for (const ch of unspeakable(locale, r.template))
    p.push(`UNSPEAKABLE-CHAR ${at}: ${codePoint(ch)} ${JSON.stringify(ch)} in the template text`);
  for (const ch of unspeakable(locale, r.spoken))
    p.push(
      `UNSPEAKABLE-CHAR ${at}: ${codePoint(ch)} ${JSON.stringify(ch)} in the spoken text ${JSON.stringify(r.spoken)}`,
    );
  const allowed = new Set(SPOKEN_TOKENS_ALLOWED);
  for (const w of words(r.template)) {
    if (allowed.has(w)) continue;
    const scripts = new Set([...w].filter((ch) => /\p{L}/u.test(ch)).map(scriptOf));
    if (scripts.size > 1)
      p.push(
        `MIXED-SCRIPT-WORD ${at}: ${JSON.stringify(w)} mixes ${[...scripts].sort().join(' + ')}`,
      );
    for (const part of w.split('-'))
      if (!allowed.has(part) && /\p{Lu}{2,}/u.test(part))
        p.push(`UNLISTED-ACRONYM ${at}: ${JSON.stringify(part)}`);
  }
  const bare = r.template.replace(INERT, ' ');
  for (const m of bare.matchAll(/\d+(?: \d+)*/gu))
    if (!SPOKEN_NUMBERS.includes(m[0]))
      p.push(
        `UNLISTED-NUMBER ${at}: ${JSON.stringify(m[0])} is not one of ${SPOKEN_NUMBERS.join(', ')}`,
      );
  const ends = SENTENCE_END[locale] ?? DEFAULT_SENTENCE_END;
  for (const sentence of r.template.split(ends)) {
    const n = sentence
      .split(/\s+/u)
      .filter((tok) => /[\p{L}\p{N}]/u.test(tok) || tok.includes(INERT_OPEN)).length;
    if (n > MAX_WORDS_PER_SENTENCE)
      p.push(
        `SENTENCE-TOO-LONG ${at}: ${String(n)} words > ${String(MAX_WORDS_PER_SENTENCE)} in ${JSON.stringify(sentence.trim())}`,
      );
  }
  return p;
}

/* --------------------------------------------------------------- R6 TTS */

type Probe = { ok: true; version: string } | { ok: false; unavailable: boolean; why: string };

function probeTool(): Probe {
  const r = spawnSync(TOOL, ['--version'], { encoding: 'utf8' });
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      unavailable: code === 'ENOENT',
      why: `${TOOL} --version: ${r.error.message}`,
    };
  }
  if (r.status !== 0)
    return {
      ok: false,
      unavailable: false,
      why: `${TOOL} --version exited ${String(r.status)}: ${r.stderr.trim()}`,
    };
  const m = /text-to-speech:\s+(\S+)/u.exec(r.stdout);
  if (m?.[1] === undefined)
    return {
      ok: false,
      unavailable: false,
      why: `${TOOL} --version printed no version: ${JSON.stringify(r.stdout.trim())}`,
    };
  return { ok: true, version: m[1] };
}

interface Synth {
  duration_ms: number;
  audio_sha256: string;
  phonemes_sha256: string;
}

/** WAV duration in ms from the RIFF header, or a reason it cannot be read. */
function wavDuration(buf: Buffer): number | string {
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    return 'not a RIFF/WAVE file';
  if (buf.readUInt32LE(4) !== buf.length - 8)
    return `RIFF size ${String(buf.readUInt32LE(4))} != file size ${String(buf.length)} - 8`;
  let off = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      if (buf.readUInt16LE(off + 8) !== 1) return 'fmt chunk is not PCM';
      byteRate = buf.readUInt32LE(off + 16);
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - off - 8);
    }
    off += 8 + size + (size % 2);
  }
  if (byteRate === undefined || byteRate === 0) return 'no fmt chunk';
  if (dataBytes === undefined) return 'no data chunk';
  if (dataBytes === 0) return 'the data chunk is empty — no audio';
  return Math.round((dataBytes * 1000) / byteRate);
}

type SynthResult = { ok: true; s: Synth } | { ok: false; unavailable: boolean; why: string };

function synthesise(dir: string, voice: string, text: string): SynthResult {
  const wav = join(dir, 'form.wav');
  rmSync(wav, { force: true });
  const r = spawnSync(TOOL, ['-v', voice, '-x', '-w', wav, text], { encoding: 'utf8' });
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { ok: false, unavailable: code === 'ENOENT', why: r.error.message };
  }
  if (r.status !== 0)
    return {
      ok: false,
      unavailable: false,
      why: `exited ${String(r.status)}; stderr ${JSON.stringify(r.stderr.trim())}`,
    };
  if (r.stderr.trim() !== '')
    return {
      ok: false,
      unavailable: false,
      why: `exited 0 but wrote to stderr: ${JSON.stringify(r.stderr.trim())}`,
    };
  if (!existsSync(wav)) return { ok: false, unavailable: false, why: 'exited 0 and wrote no WAV' };
  const buf = readFileSync(wav);
  const d = wavDuration(buf);
  if (typeof d === 'string') return { ok: false, unavailable: false, why: `WAV unreadable: ${d}` };
  return {
    ok: true,
    s: { duration_ms: d, audio_sha256: sha256(buf), phonemes_sha256: sha256(r.stdout) },
  };
}

/* ------------------------------------------------------------ the record */

interface FormRecord {
  form: string;
  text_sha256: string;
  duration_ms: number;
  audio_sha256: string;
  phonemes_sha256: string;
}
interface PairRecord {
  content_hash: string;
  forms: FormRecord[];
  result: 'pass';
  tool: string;
  checked_by: string;
}

const RECORD_NOTE =
  'gate:read-aloud (T-263, OE-82): the automated read-aloud/TTS pass over spoken safety copy. GENERATED by `node packages/i18n/tools/read-aloud.ts --write` and VERIFIED by `pnpm gate:read-aloud`, which recomputes every field and refuses any difference (RECORD-DRIFT). Do not hand-edit. Nobody reviewed this copy (OE-5); checked_by names the automation, never a person. A pass means every form is made of speakable tokens and synthesises within budget with espeak-ng; it does not mean a person can say it or understand it (state/EP-0/T-263.md § Published contract).';

function serialise(records: Map<string, Map<string, PairRecord>>): string {
  const out: Record<string, Record<string, PairRecord>> = {};
  for (const [locale, byKey] of records) {
    const o: Record<string, PairRecord> = {};
    for (const key of [...byKey.keys()].sort()) {
      const v = byKey.get(key);
      if (v !== undefined) o[key] = v;
    }
    out[locale] = o;
  }
  return `${JSON.stringify({ '//': RECORD_NOTE, records: out }, null, 2)}\n`;
}

/** The first differing field path between two JSON values, or undefined. */
function firstDiff(a: unknown, b: unknown, path: string): string | undefined {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d !== undefined) return d;
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const d = firstDiff(a[i], b[i], `${path}[${String(i)}]`);
      if (d !== undefined) return d;
    }
  }
  return `${path}: committed ${JSON.stringify(a)}, computed ${JSON.stringify(b)}`;
}

/* ------------------------------------------------------------------ main */

function finish(banner: string, failures: readonly string[]): never {
  if (failures.length === 0) {
    console.log(`\nGATE PASS  ${banner}`);
    process.exit(0);
  }
  console.log(`\nGATE FAIL  ${banner} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

function main(argv: readonly string[]): never {
  const args = parseArgs(argv);
  const tags: string[] = [];
  if (args.explicitRoot) tags.push(`--root ${args.root}`);
  if (args.write) tags.push('--write');
  const banner = tags.length === 0 ? GATE : `${GATE}  [${tags.join('; ')}]`;
  const failures: string[] = [];

  // ---- the locale set and the register
  const registry = readJson(join(args.root, 'locale-registry.json'));
  const locales =
    isRecord(registry) && Array.isArray(registry['locales'])
      ? registry['locales']
          .filter((l): l is Record<string, unknown> => isRecord(l) && l['enabled'] === true)
          .map((l) => String(l['code']))
      : [];
  const review = readJson(join(args.root, 'review.json'));
  const pipeline =
    isRecord(review) && isRecord(review['pipeline']) ? review['pipeline'] : undefined;
  const assignments =
    pipeline !== undefined && isRecord(pipeline['assignments'])
      ? pipeline['assignments']
      : undefined;
  const entries = isRecord(review) && isRecord(review['entries']) ? review['entries'] : {};

  // ---- CHANNEL-DRIFT: review.json's spoken set against the pin, both directions
  if (assignments === undefined) {
    failures.push(
      'CHANNEL-DRIFT review.json has no pipeline.assignments: the spoken key set cannot be read',
    );
  } else {
    const spoken = new Map<string, string>();
    for (const [key, a] of Object.entries(assignments)) {
      const ch = isRecord(a) ? a['channel'] : undefined;
      if (ch !== 'screen') spoken.set(key, typeof ch === 'string' ? ch : String(ch));
    }
    for (const [key, ch] of spoken)
      if (READ_ALOUD_KEYS_PINNED[key] === undefined)
        failures.push(
          `CHANNEL-DRIFT ${key}: channel '${ch}' in review.json, but not in READ_ALOUD_KEYS_PINNED`,
        );
      else if (READ_ALOUD_KEYS_PINNED[key] !== ch)
        failures.push(
          `CHANNEL-DRIFT ${key}: channel '${ch}' in review.json, pinned '${String(READ_ALOUD_KEYS_PINNED[key])}'`,
        );
    for (const key of Object.keys(READ_ALOUD_KEYS_PINNED))
      if (!spoken.has(key))
        failures.push(
          `CHANNEL-DRIFT ${key}: pinned as spoken, but review.json's channel is 'screen' or the key is absent`,
        );
    if (Object.keys(READ_ALOUD_KEYS_PINNED).length === 0)
      failures.push(
        'CHANNEL-DRIFT READ_ALOUD_KEYS_PINNED is empty: nothing would be checked (fails closed)',
      );
  }

  // ---- the tool
  const probe = probeTool();
  let ttsUnavailable = false;
  let ttsBroken = false;
  if (!probe.ok) {
    if (probe.unavailable) {
      ttsUnavailable = true;
      failures.push(
        `TTS-UNAVAILABLE ${TOOL} is not on PATH (${probe.why}). Nothing was synthesised; this is NOT a pass.`,
      );
    } else {
      ttsBroken = true;
      failures.push(`TTS-FAILED ${probe.why}`);
    }
  } else if (probe.version !== CHECK_TOOLS[TOOL]) {
    ttsBroken = true;
    failures.push(
      `TTS-FAILED ${TOOL} reports '${probe.version}', CHECK_TOOLS pins '${CHECK_TOOLS[TOOL]}'`,
    );
  }
  const toolLabel = probe.ok ? `${TOOL} ${probe.version}` : `${TOOL} UNAVAILABLE`;
  const canSynth = !ttsUnavailable && !ttsBroken;

  // ---- fixtures: each count must land in its category
  for (const locale of locales) {
    const pr = new Intl.PluralRules(locale);
    for (const cat of pr.resolvedOptions().pluralCategories) {
      const n = FIXTURE_PLURAL_COUNTS[locale]?.[cat];
      if (n !== undefined && pr.select(n) !== cat)
        failures.push(
          `FIXTURE-WRONG-CATEGORY ${locale}: count ${String(n)} is '${pr.select(n)}', pinned as '${cat}'`,
        );
    }
  }

  // ---- every pair, every form
  const dir = mkdtempSync(join(tmpdir(), 't263-read-aloud-'));
  const computed = new Map<string, Map<string, PairRecord>>();
  const synthOk = new Set<string>();
  let pairs = 0;
  let forms = 0;
  try {
    for (const locale of locales) {
      const byKey = new Map<string, PairRecord>();
      computed.set(locale, byKey);
      for (const [key, channel] of Object.entries(READ_ALOUD_KEYS_PINNED)) {
        const pair = `${locale} ${key}`;
        pairs += 1;
        const dot = key.indexOf('.');
        const file = join(args.root, 'catalogues', locale, `${key.slice(0, dot)}.json`);
        const cat = existsSync(file) ? readJson(file) : undefined;
        const source = isRecord(cat) ? cat[key.slice(dot + 1)] : undefined;
        if (typeof source !== 'string') {
          failures.push(
            `NO-SOURCE ${pair}: no catalogue string in catalogues/${locale}/${key.slice(0, dot)}.json`,
          );
          continue;
        }
        const reg = isRecord(entries[locale])
          ? (entries[locale] as Record<string, unknown>)[key]
          : undefined;
        const contentHash = isRecord(reg) ? reg['content_hash'] : undefined;
        if (typeof contentHash !== 'string') {
          failures.push(
            `NO-REGISTER-RECORD ${pair}: review.json has no content_hash for this pair`,
          );
          continue;
        }
        const voice = VOICES[locale];
        if (voice === undefined)
          failures.push(`NO-VOICE ${pair}: no espeak-ng voice is pinned for '${locale}'`);
        let ast: MessageFormatElement[];
        let args2: Map<string, Branching>;
        try {
          ast = parse(source, { requiresOtherClause: true });
          args2 = branchingArgs(ast);
        } catch (err) {
          failures.push(
            `UNSUPPORTED-ICU ${pair}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const expanded = combos(locale, args2);
        const got = new Set(expanded.map(formName));
        const want = requiredForms(locale, args2);
        const missing = [...want].filter((f) => !got.has(f));
        const extra = [...got].filter((f) => !want.has(f));
        if (missing.length > 0 || extra.length > 0)
          failures.push(
            `FORMS-INCOMPLETE ${pair}: expanded ${String(got.size)} form(s), Intl.PluralRules and the message require ${String(want.size)}` +
              (missing.length > 0 ? `; missing ${missing.join(', ')}` : '') +
              (extra.length > 0 ? `; unexpected ${extra.join(', ')}` : ''),
          );
        const budget = DURATION_BUDGET_MS[channel as SpokenChannel];
        const formRecords: FormRecord[] = [];
        let pairOk = canSynth && voice !== undefined;
        for (const c of expanded) {
          const form = formName(c);
          forms += 1;
          let r: Rendered;
          try {
            r = renderForm(locale, ast, c);
          } catch (err) {
            failures.push(
              `UNSUPPORTED-ICU ${pair} [${form}]: ${err instanceof Error ? err.message : String(err)}`,
            );
            pairOk = false;
            continue;
          }
          failures.push(...r.problems.map((x) => `${x} (${pair} [${form}])`));
          if (r.values !== undefined) {
            const icu = new IntlMessageFormat(source, locale).format(r.values);
            if (typeof icu !== 'string' || icu.normalize('NFC') !== r.spoken)
              failures.push(
                `RENDER-MISMATCH ${pair} [${form}]: this walker ${JSON.stringify(r.spoken)}, intl-messageformat ${JSON.stringify(icu)}`,
              );
          }
          failures.push(...lint(locale, form, r, pair));
          if (!canSynth || voice === undefined) continue;
          const s = synthesise(dir, voice, r.spoken);
          if (!s.ok) {
            pairOk = false;
            failures.push(
              `${s.unavailable ? 'TTS-UNAVAILABLE' : 'TTS-FAILED'} ${pair} [${form}]: ${s.why}`,
            );
            continue;
          }
          const within = s.s.duration_ms <= budget;
          console.log(
            `  ${within ? 'ok' : '!!'} ${pair} [${form}] ${String(s.s.duration_ms)} ms of ${String(budget)} ms (${channel})`,
          );
          if (!within)
            failures.push(
              `TOO-LONG-SPOKEN ${pair} [${form}]: ${String(s.s.duration_ms)} ms > ${String(budget)} ms (${channel})`,
            );
          formRecords.push({
            form,
            text_sha256: sha256(r.spoken),
            duration_ms: s.s.duration_ms,
            audio_sha256: s.s.audio_sha256,
            phonemes_sha256: s.s.phonemes_sha256,
          });
        }
        byKey.set(key, {
          content_hash: contentHash,
          forms: formRecords,
          result: 'pass',
          tool: toolLabel,
          checked_by: CHECKED_BY,
        });
        if (pairOk) synthOk.add(pair);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (pairs === 0) failures.push('NOTHING-CHECKED zero (locale, key) pairs were examined');

  // ---- the record
  const recordFile = join(args.root, RECORD_PATH);
  const generated = serialise(computed);
  if (args.write) {
    if (failures.length === 0) {
      writeFileSync(recordFile, generated);
      console.log(`  wrote ${RECORD_PATH}`);
    } else {
      console.log(`  ${RECORD_PATH} NOT written: the checks above did not all pass`);
    }
  } else if (!existsSync(recordFile)) {
    failures.push(`MISSING-RECORD ${RECORD_PATH} does not exist (generate it with --write)`);
  } else {
    let committed: unknown;
    try {
      committed = readJson(recordFile);
    } catch (err) {
      committed = undefined;
      failures.push(
        `RECORD-DRIFT ${RECORD_PATH} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (committed !== undefined) {
      const recs =
        isRecord(committed) && isRecord(committed['records']) ? committed['records'] : {};
      let pairDrift = false;
      for (const [locale, byKey] of Object.entries(recs)) {
        if (!isRecord(byKey)) continue;
        for (const [key, rec] of Object.entries(byKey)) {
          if (
            !computed.get(locale)?.has(key) &&
            !(locales.includes(locale) && key in READ_ALOUD_KEYS_PINNED)
          ) {
            failures.push(
              `EXTRA-RECORD ${locale} ${key}: a record for a pair this gate does not check`,
            );
            pairDrift = true;
          }
          if (!isRecord(rec)) continue;
          const reviewish = Object.keys(rec).filter((f) => /review/iu.test(f));
          if (rec['checked_by'] !== CHECKED_BY || reviewish.length > 0)
            failures.push(
              `CLAIMS-HUMAN-CHECK ${locale} ${key}: checked_by ${JSON.stringify(rec['checked_by'])}` +
                (reviewish.length > 0 ? `, field(s) ${reviewish.join(', ')}` : '') +
                `; only ${JSON.stringify(CHECKED_BY)} is accepted — nobody reviews this copy (OE-5, OE-82)`,
            );
        }
      }
      for (const locale of locales)
        for (const key of Object.keys(READ_ALOUD_KEYS_PINNED)) {
          const rec = isRecord(recs[locale])
            ? (recs[locale] as Record<string, unknown>)[key]
            : undefined;
          if (rec === undefined) {
            failures.push(`MISSING-RECORD ${locale} ${key}: no entry in ${RECORD_PATH}`);
            pairDrift = true;
            continue;
          }
          if (!synthOk.has(`${locale} ${key}`)) {
            pairDrift = true; // not comparable: the failure above says why
            continue;
          }
          const d = firstDiff(rec, computed.get(locale)?.get(key), `${locale}.${key}`);
          if (d !== undefined) {
            failures.push(`RECORD-DRIFT ${d}`);
            pairDrift = true;
          }
        }
      if (!pairDrift && readFileSync(recordFile, 'utf8') !== generated)
        failures.push(
          `RECORD-DRIFT ${RECORD_PATH}: its bytes differ from what --write would write`,
        );
    }
  }
  if (ttsUnavailable) console.log('  record NOT verified against synthesis: TTS unavailable');

  console.log(
    `read-aloud: ${String(pairs)} pairs, ${String(forms)} forms, automated (${toolLabel}), reviewed by nobody (OE-5, OE-82)`,
  );
  finish(banner, failures);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  // A crash is not a refusal: it prints this gate's banner with CRASH as its
  // reason, so "refused", "crashed" and "unavailable" are three outcomes.
  console.log(`\nGATE FAIL  ${GATE} — 1 problem(s):`);
  console.log(`  - CRASH ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
