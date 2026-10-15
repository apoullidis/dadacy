/**
 * `gate:prohibited-claims` — T-043. PM §MVP-L4 AC6, §MVP-S8 AC5, §MVP-IS9 AC6;
 * SA §TS-12.3; SD's gate block (`gate:prohibited-claims`) and §INT-C note 3.
 *
 * THE RULE: no catalogue string, in any enabled locale, at any tier, contains
 * a prohibited claim — the English strings PM fixes as testable constants, the
 * DV-3 "escrow" terms SD names in all three languages, or any phrase of the
 * Greek or Russian list in `prohibited/<locale>.json`. Every list applies to
 * every locale's catalogue: Greek and Russian copy borrow English phrases, and
 * SD's block says the gate scans "every locale catalogue" for the English
 * strings "AND their Greek and Russian equivalents".
 *
 * SCOPE IS `catalogues/**` AND `prohibited/**`, AND NOTHING ELSE (T-049
 * § Published contract §6). `PIPELINE.md` quotes the banned English phrases
 * verbatim and `prohibited/*.json` IS a list of banned phrases; a gate that
 * scanned either as copy would fail on its own explanation and its own input.
 * SD also names "every (public) MDX page and every support macro": neither
 * exists in this repository today, and this gate does not look for them.
 *
 * FAIL CLOSED (T-040 § Published contract §8; CONTRACTS.md, T-043's carried
 * obligation). Every enabled non-default locale in `locale-registry.json` must
 * have `prohibited/<locale>.json`. An absent, unreadable or malformed list, a
 * list missing one of the ten PM claims, a claim with no phrase, or a phrase
 * that normalises to nothing, is a GATE FAIL — never "zero findings". The
 * locale set comes from the REGISTRY, not from `readdir('prohibited/')`, so
 * deleting a list cannot shrink what is required.
 *
 * AUTHORSHIP (OE-66, EV-16 as extended by OE-5). The `el`/`ru` lists are
 * AI-authored. "Named authorship" here is `T-233` § Published contract §1's
 * AI-author provenance rule applied to a list: `provenance: "ai_authored"`,
 * a `ruling` that is a stakeholder ruling making a model an author and that
 * covers the list's locale, and `authored_by` EXACTLY the model that ruling
 * names (raw string equality, no normalisation). Since OE-5 no human reviews
 * this copy, so a list that records or claims a review — any field whose name
 * contains "review" with a non-null value — is refused. The rulings are a
 * literal in THIS file, never read from the lists: a list that named its own
 * authority could widen it in the same commit as the phrase that needs it
 * (PROTOCOL §5.1). A human-authored list is not accepted by this gate; that
 * would be a stakeholder decision and an edit here.
 *
 * MATCHING: case-insensitive substring after `fold()` (below), applied to the
 * catalogue string and to the phrase alike. It follows the lists' own authors'
 * stated assumptions (`tasks/state/EP-0/OE-66/{el,ru}/NOTES.md` §4: NFC,
 * lowercase, Greek tonos/diaeresis stripped, ё→е). SD says matching "runs
 * through packages/text-normalise (SE-10)"; that package is `T-065`'s and is
 * not built, so this is a local fold, and Greeklish is NOT covered — § contract.
 *
 * NO ALLOW-LIST. Substring matching flags an honest negation («мы НЕ работаем
 * круглосуточно»), and the `ru` author asked for an allow-list. Measured on the
 * real catalogues at T-043: zero hits of any kind, so zero cases to allow. An
 * allow-list is added when a real catalogue string needs one, as narrow as
 * that string.
 *
 * USAGE:  node packages/i18n/tools/prohibited-claims.ts [--root <dir>]
 *
 * `--root` points every reading at another package root (the Vitest cases
 * build one in a temporary directory). The banner names the root on both the
 * pass and the fail path, so a `--root` run cannot be pasted as the real one.
 * Any other argument exits 2 with no banner. Output: all stdout.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = 'gate:prohibited-claims';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------- the spec, as constants */

/**
 * The ten prohibited English claims, transcribed from PM §MVP-IS9 AC6
 * (product-manager.md:1262 — the first five) and §MVP-S8 AC5
 * (product-manager.md:706 — the last five). Each list's `banned[].claim` must
 * be EXACTLY this set: a list that dropped a claim would scan fewer claims and
 * stay green.
 *
 * The phrases matched for each claim are the claim itself, with two readings
 * stated: "we check daily/weekly" is matched as its two expansions (the
 * literal with a slash is not English copy anyone writes, and each expansion
 * contains the literal's prefix), and "round-the-clock team" is also matched
 * bare, as SA §TS-12.3 lists it (solutions-architect.md:1048).
 */
const EN_CLAIMS: readonly (readonly [claim: string, phrases: readonly string[]])[] = [
  ['24/7 support', ['24/7 support']],
  ['24/7 staffed', ['24/7 staffed']],
  ['always on', ['always on']],
  ['round-the-clock team', ['round-the-clock team', 'round-the-clock']],
  ['someone is always watching', ['someone is always watching']],
  ['continuously monitored', ['continuously monitored']],
  ['live monitoring', ['live monitoring']],
  ['real-time checks', ['real-time checks']],
  ['always up to date', ['always up to date']],
  ['we check daily/weekly', ['we check daily', 'we check weekly']],
];

/**
 * SA DV-3: the payment model is not escrow, and the word may not appear. SD
 * names the three spellings this gate carries (software-design.md:1546 and
 * :3696; SA §TS-12.3, solutions-architect.md:1049). Spec constants, applied to
 * every locale; not part of the AI-authored lists.
 */
const DV3_TERMS: readonly string[] = ['escrow', 'μεσεγγύηση', 'эскроу'];

/**
 * The permitted claims, exactly (PM §MVP-S8 AC5, product-manager.md:706, and
 * §MVP-IS9 AC6, product-manager.md:1262). No banned phrase of any list may
 * match one of these, nor a list's own rendering of the first three: a list
 * that banned a permitted claim would make the required copy unshippable.
 */
const PERMITTED_S8: readonly string[] = [
  'Re-verified every 12 months',
  'Attested every 90 days',
  'Re-checked immediately on any concern',
];
const PERMITTED_IS9: readonly string[] = [
  'A trained safeguarding operator is on shift for every minute of every sit, and for an hour after it ends',
  'Out of hours, we answer within 15 minutes and call you back within 30',
];

/**
 * The ONLY stakeholder ruling that makes an AI model the author of a
 * prohibited-claim list. Written here from `tasks/state/decisions.md`, never
 * read from a list:
 *   - OE-66, 2026-09-27T18:54:51Z: AI agents (Claude Opus) author the `el` and
 *     `ru` copy, "INCLUDING ... `T-043`'s prohibited-claim lists" (EV-16).
 * OE-67 (the `en` safety copy) is NOT here: there is no `en` list, and OE-67
 * does not cover one. Adding a ruling, a locale or a model is a stakeholder
 * decision recorded in decisions.md first, and must cost an edit to this
 * literal. The model string is the one `src/pipeline.test.ts`'s `MODEL`
 * carries for the register (T-233 § Published contract §1).
 */
const LIST_RULINGS: readonly {
  readonly id: string;
  readonly locales: readonly string[];
  readonly author: string;
}[] = [{ id: 'OE-66', locales: ['el', 'ru'], author: 'Claude Opus (claude-opus-5-5), AI agent' }];

/* ------------------------------------------------------------------- fold */

/**
 * The comparison form of a string. Applied to the catalogue text AND to every
 * phrase, so it widens what matches and never what is shipped.
 *
 *   1. NFKC — compatibility forms fold to their plain letters: NBSP and the
 *      other fixed-width spaces to a space, fullwidth `２４/７` to `24/7`.
 *   2. lower case (locale-independent).
 *   3. NFD, then drop U+0301 (acute/tonos) and U+0308 (diaeresis/dialytika) —
 *      the Greek author's "tonos and diaeresis stripped", which on Cyrillic is
 *      also the Russian author's ё→е — and every Default_Ignorable code point
 *      (zero-width space/joiners, BOM, soft hyphen), so an invisible character
 *      cannot split a phrase. Then NFC. Other marks (й's breve) are kept.
 *   4. Greek final sigma ς → σ, so either sigma form matches (SD's block).
 *   5. Every dash-punctuation code point (\p{Pd}: U+2010, U+2011, en/em dash,
 *      …) → `-`; every run of whitespace → one space; trimmed.
 */
function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[́̈]|\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFC')
    .replace(/ς/gu, 'σ')
    .replace(/\p{Pd}/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

/* ------------------------------------------------------------------ argv */

function parseArgs(argv: readonly string[]): { root: string; explicitRoot: boolean } {
  let root = PACKAGE_ROOT;
  let explicitRoot = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`${GATE}: --root needs a directory`);
        process.exit(2);
      }
      root = value;
      explicitRoot = true;
      i += 1;
      continue;
    }
    // Refused rather than ignored: an argument this gate does not understand
    // is far more likely to be a narrowing someone expected to take effect.
    console.error(`${GATE}: unrecognised argument ${JSON.stringify(arg)}`);
    process.exit(2);
  }
  return { root, explicitRoot };
}

/* ----------------------------------------------------------------- output */

function finish(banner: string, failures: readonly string[]): never {
  if (failures.length === 0) {
    console.log(`\nGATE PASS  ${banner}`);
    process.exit(0);
  }
  console.log(`\nGATE FAIL  ${banner} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ input */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Read = { ok: true; value: unknown } | { ok: false; why: string };

function readJson(path: string): Read {
  if (!existsSync(path)) return { ok: false, why: 'absent' };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

/** One phrase the scan matches, and where it came from. */
interface Phrase {
  readonly text: string;
  readonly folded: string;
  readonly claim: string;
  readonly source: string;
}

/** Enabled locales and the default, from the registry, or a reason it cannot be read. */
function readRegistry(
  root: string,
  failures: string[],
): { enabled: readonly string[]; defaultLocale: string } | undefined {
  const r = readJson(join(root, 'locale-registry.json'));
  if (!r.ok) {
    failures.push(`INPUT locale-registry.json could not be read (${r.why}).`);
    return undefined;
  }
  const doc = r.value;
  if (!isRecord(doc) || typeof doc.defaultLocale !== 'string' || !Array.isArray(doc.locales)) {
    failures.push('INPUT locale-registry.json has no `defaultLocale` string or `locales` array.');
    return undefined;
  }
  const enabled: string[] = [];
  for (const row of doc.locales as unknown[]) {
    if (isRecord(row) && row.enabled === true && typeof row.code === 'string') {
      enabled.push(row.code);
    }
  }
  return { enabled, defaultLocale: doc.defaultLocale };
}

/**
 * Validates one `prohibited/<locale>.json` and returns its phrases. Every
 * refusal here is a reason the list cannot be believed, and each fails the
 * gate on its own: a list is either whole and attributed, or it is not a list.
 */
function readList(
  root: string,
  locale: string,
  failures: string[],
): { phrases: Phrase[]; permitted: string[] } {
  const rel = `prohibited/${locale}.json`;
  const phrases: Phrase[] = [];
  const permitted: string[] = [];
  const r = readJson(join(root, rel));
  if (!r.ok) {
    failures.push(
      r.why === 'absent'
        ? `ABSENT-LIST ${rel} does not exist, and '${locale}' is enabled in locale-registry.json. ` +
            'A missing list is a failure, not zero findings — otherwise this gate is green precisely ' +
            'while it checks nothing in that language (T-040 § Published contract §8).'
        : `MALFORMED-LIST ${rel} is not valid JSON (${r.why}).`,
    );
    return { phrases, permitted };
  }
  const doc = r.value;
  if (!isRecord(doc)) {
    failures.push(`MALFORMED-LIST ${rel} is not a JSON object.`);
    return { phrases, permitted };
  }
  if (doc.locale !== locale) {
    failures.push(
      `LOCALE-MISMATCH ${rel} declares locale ${JSON.stringify(doc.locale)}, not '${locale}'.`,
    );
  }

  // Authorship — T-233 § Published contract §1's rule, applied to a list.
  const ruling = LIST_RULINGS.find((x) => x.id === doc.ruling);
  if (doc.provenance !== 'ai_authored' || doc.ruling === undefined) {
    failures.push(
      `UNRULED-AUTHOR ${rel}: provenance ${JSON.stringify(doc.provenance)}, ruling ` +
        `${JSON.stringify(doc.ruling)}. A list is accepted only as \`ai_authored\` under a cited ` +
        `stakeholder ruling (known: ${LIST_RULINGS.map((x) => x.id).join(', ')}).`,
    );
  } else if (ruling === undefined) {
    failures.push(
      `UNRULED-AUTHOR ${rel} cites ${JSON.stringify(doc.ruling)}, which is not a stakeholder ` +
        `ruling that makes a model the author of a prohibited-claim list (known: ` +
        `${LIST_RULINGS.map((x) => x.id).join(', ')}).`,
    );
  } else if (!ruling.locales.includes(locale)) {
    failures.push(
      `UNRULED-AUTHOR ${rel} cites ${ruling.id}, which covers [${ruling.locales.join(', ')}], ` +
        `not '${locale}'.`,
    );
  } else if (doc.authored_by !== ruling.author) {
    failures.push(
      `WRONG-AUTHOR ${rel}: authored_by is ${JSON.stringify(doc.authored_by)}, not the model ` +
        `${ruling.id} names (${JSON.stringify(ruling.author)}), character for character. Record ` +
        'the model truthfully — never a human name, never another engine.',
    );
  }
  for (const [field, value] of Object.entries(doc)) {
    if (/review/iu.test(field) && value !== null) {
      failures.push(
        `CLAIMS-REVIEW ${rel}: '${field}' is ${JSON.stringify(value)}. Since OE-5 no human ` +
          'reviews this copy (EV-16), and nothing may record or claim a review.',
      );
    }
  }

  // The banned claims: exactly the ten PM claims, each with phrases.
  const expected = EN_CLAIMS.map(([c]) => c);
  if (!Array.isArray(doc.banned)) {
    failures.push(`MALFORMED-LIST ${rel} has no \`banned\` array.`);
  } else {
    const seen = new Set<string>();
    for (const [i, entry] of (doc.banned as unknown[]).entries()) {
      if (!isRecord(entry) || typeof entry.claim !== 'string' || !Array.isArray(entry.phrases)) {
        failures.push(`MALFORMED-LIST ${rel} banned[${String(i)}] is not { claim, phrases[] }.`);
        continue;
      }
      const claim = entry.claim;
      if (!expected.includes(claim)) {
        failures.push(
          `UNKNOWN-CLAIM ${rel} banned[${String(i)}].claim ${JSON.stringify(claim)} is not one of ` +
            'the ten PM claims (§MVP-S8 AC5, §MVP-IS9 AC6).',
        );
      }
      if (seen.has(claim)) {
        failures.push(`DUPLICATE-CLAIM ${rel} lists ${JSON.stringify(claim)} twice.`);
      }
      seen.add(claim);
      if (entry.phrases.length === 0) {
        failures.push(`EMPTY-CLAIM ${rel} ${JSON.stringify(claim)} has no phrases.`);
      }
      for (const [j, p] of (entry.phrases as unknown[]).entries()) {
        if (typeof p !== 'string' || fold(p) === '') {
          failures.push(
            `EMPTY-PHRASE ${rel} ${JSON.stringify(claim)} phrases[${String(j)}] is ` +
              `${JSON.stringify(p)}, which is not a string with content. An empty phrase would ` +
              'match nothing a reader sees.',
          );
          continue;
        }
        phrases.push({ text: p, folded: fold(p), claim, source: rel });
      }
    }
    for (const c of expected) {
      if (!seen.has(c)) {
        failures.push(
          `MISSING-CLAIM ${rel} has no entry for ${JSON.stringify(c)} — that claim would go ` +
            `unchecked in '${locale}'.`,
        );
      }
    }
  }

  // The permitted renderings: one per PM §MVP-S8 AC5 claim, keyed by its English.
  if (!Array.isArray(doc.permitted)) {
    failures.push(`MALFORMED-LIST ${rel} has no \`permitted\` array.`);
  } else {
    const ens: string[] = [];
    for (const p of doc.permitted as unknown[]) {
      if (isRecord(p) && typeof p.en === 'string') ens.push(p.en);
      const rendered = isRecord(p) ? p[locale] : undefined;
      if (typeof rendered === 'string' && fold(rendered) !== '') permitted.push(rendered);
      else failures.push(`PERMITTED-SET ${rel} has a permitted entry with no '${locale}' rendering.`);
    }
    const missing = PERMITTED_S8.filter((e) => !ens.includes(e));
    const extra = ens.filter((e) => !PERMITTED_S8.includes(e));
    if (missing.length > 0 || extra.length > 0 || ens.length !== PERMITTED_S8.length) {
      failures.push(
        `PERMITTED-SET ${rel}'s permitted claims are not exactly PM §MVP-S8 AC5's three — ` +
          `missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(extra)}.`,
      );
    }
  }
  return { phrases, permitted };
}

/** Every string leaf of a catalogue file, keyed `<ns>.<key>`; the `//` comment key is skipped. */
function stringLeaves(ns: string, v: unknown, path: string, out: [string, string][]): void {
  if (typeof v === 'string') {
    out.push([`${ns}.${path}`, v]);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => {
      stringLeaves(ns, x, `${path}[${String(i)}]`, out);
    });
  } else if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (path === '' && k === '//') continue;
      stringLeaves(ns, x, path === '' ? k : `${path}.${k}`, out);
    }
  }
}

/* ------------------------------------------------------------------- main */

function main(argv: readonly string[]): never {
  const { root, explicitRoot } = parseArgs(argv);
  const banner = explicitRoot ? `${GATE}  [--root ${root}]` : GATE;
  const failures: string[] = [];

  const registry = readRegistry(root, failures);
  if (registry === undefined) finish(banner, failures);
  const { enabled, defaultLocale } = registry;
  console.log(`${GATE} — enabled locales from locale-registry.json: [${enabled.join(', ')}]`);
  if (!enabled.includes(defaultLocale) || enabled.length < 2) {
    failures.push(
      `NO-COMPARISON the registry enables [${enabled.join(', ')}] with default '${defaultLocale}'. ` +
        'Fewer than two locales, or no default, would leave the Greek/Russian half of this gate ' +
        'checking nothing.',
    );
  }

  // 1. The phrases: English spec constants, DV-3 terms, and one list per
  //    enabled non-default locale.
  const phrases: Phrase[] = [];
  for (const [claim, ps] of EN_CLAIMS) {
    for (const p of ps) phrases.push({ text: p, folded: fold(p), claim, source: 'PM (en)' });
  }
  for (const p of DV3_TERMS) {
    phrases.push({ text: p, folded: fold(p), claim: 'escrow (SA DV-3)', source: 'SD (DV-3)' });
  }
  const permitted: string[] = [...PERMITTED_S8, ...PERMITTED_IS9];
  for (const locale of enabled) {
    if (locale === defaultLocale) continue;
    const list = readList(root, locale, failures);
    phrases.push(...list.phrases);
    permitted.push(...list.permitted);
    console.log(`  list prohibited/${locale}.json: ${String(list.phrases.length)} phrase(s)`);
  }
  console.log(
    `  phrases: ${String(phrases.length)} in all (PM en ${String(
      EN_CLAIMS.reduce((n, [, ps]) => n + ps.length, 0),
    )}, DV-3 ${String(DV3_TERMS.length)}, lists the rest)`,
  );

  // 2. No phrase may ban a permitted claim.
  for (const text of permitted) {
    const f = fold(text);
    for (const p of phrases) {
      if (f.includes(p.folded)) {
        failures.push(
          `BANS-PERMITTED ${p.source} phrase ${JSON.stringify(p.text)} (claim ${JSON.stringify(
            p.claim,
          )}) matches the permitted claim ${JSON.stringify(text)}.`,
        );
      }
    }
  }

  // 3. The scan: every string of every catalogue file of every enabled locale.
  let total = 0;
  for (const locale of enabled) {
    const dir = join(root, 'catalogues', locale);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      failures.push(
        `MISSING-CATALOGUE catalogues/${locale}/ does not exist, and '${locale}' is enabled. ` +
          'Nothing scanned is not nothing found.',
      );
      continue;
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    let strings = 0;
    for (const file of files) {
      const r = readJson(join(dir, file));
      if (!r.ok) {
        failures.push(`MALFORMED-CATALOGUE catalogues/${locale}/${file} (${r.why}).`);
        continue;
      }
      const leaves: [string, string][] = [];
      stringLeaves(file.slice(0, -'.json'.length), r.value, '', leaves);
      for (const [key, text] of leaves) {
        strings += 1;
        const f = fold(text);
        for (const p of phrases) {
          if (f.includes(p.folded)) {
            failures.push(
              `PROHIBITED ${locale}/${key} contains ${JSON.stringify(p.text)} — claim ` +
                `${JSON.stringify(p.claim)}, from ${p.source}. Text: ${JSON.stringify(text)}`,
            );
          }
        }
      }
    }
    total += strings;
    console.log(
      `  scanned catalogues/${locale}/: ${String(strings)} string(s) in ${String(files.length)} file(s)`,
    );
    if (strings === 0) {
      failures.push(
        `NOTHING-SCANNED catalogues/${locale}/ yielded no strings, and '${locale}' is enabled.`,
      );
    }
  }
  console.log(`  scanned ${String(total)} string(s) against ${String(phrases.length)} phrase(s)`);
  finish(banner, failures);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  // A crash is not a refusal: it still prints this gate's banner, with CRASH
  // as its reason, so "refused" and "crashed" are two readable outcomes.
  console.log(`\nGATE FAIL  ${GATE} — 1 problem(s):`);
  console.log(`  - CRASH ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
