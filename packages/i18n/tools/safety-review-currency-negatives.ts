/**
 * `pnpm --filter @kinvara/i18n run gate:safety-review-currency:negatives` — T-044;
 * T-258 (the OE-5 terminal state; cases from OE5-FINAL-CONTROL on; rework 1,
 * the closed record field set and the content checks inside the waiver, cases
 * from WAIVED-UNDEFINED-FIELD on).
 *
 * The committed negative cases for `gate:safety-review-currency` THAT CANNOT BE
 * RUN FROM A TEMPORARY ROOT, because they are about the COMMITTED artefacts of
 * this package as they sit in the working tree: `review.json`, `tiers.json`,
 * `locale-registry.json` and `compiled/`. Everything that can be planted in a
 * temporary root is in `tools/safety-review-currency.test.ts` instead, where
 * `pnpm test` — and therefore `gate:unit-tests` and `gate:pr` — runs it on
 * every PR.
 *
 * TWO OF THESE ARE THE TICKET'S ACCEPTANCE CRITERION on the real tree: a
 * `safety_critical` string with a STALE review record, and one with an ABSENT
 * one. Both are reached without inventing a review record and without moving
 * any entry to `signed_off`: the plant takes ONE key out of the waiver's `keys`
 * list, which is exactly the shape of `T-049` delivering that key (the waiver
 * pin is a subset check precisely so that partial delivery is free — T-040
 * QA-F4), and then staleness or absence is planted over the real (since T-233,
 * AI-authored and unreviewed) record.
 *
 * T-258's cases that need a TRACKED SOURCE FILE mutated — `tools/rulings.ts`,
 * which the gate subprocess imports — or the full run (readings B and C) over
 * a register in the terminal state live here too. They move the real register
 * to that state in the working tree for the length of one run, which is
 * exactly the edit T-259 commits, and restore it.
 *
 * Each case plants one edit in each of one or more TRACKED files, ASSERTS THE
 * EDITS LANDED, runs `node tools/safety-review-currency.ts` with no arguments
 * (the same command `pnpm gate:safety-review-currency` runs), judges it on the
 * exit status, the banner and the expected reason lines, then restores every
 * file BYTE FOR BYTE and asserts the restore. A CONTROL run at the start and an
 * identical one at the end bracket the whole thing.
 *
 * It refuses to start unless `git status --porcelain packages/i18n` is empty,
 * and it takes no arguments. It is NOT a `*.test.ts` file, so neither Vitest
 * nor `tools/run-tests.ts` reads it, `pnpm test` does not run it, and — like
 * `test:negatives` and `T-042`'s equivalent — NO GATE RUNS IT (OD-57 is
 * `T-005`'s; this script inherits that status rather than changing it). It
 * mutates the working tree, so it must never run while `gate:pr` is running:
 * `gate:pr` refuses a dirty tree (`T-005` § Published contract §4).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PKG, 'tools', 'safety-review-currency.ts');

const REVIEW = 'packages/i18n/review.json';
const TIERS = 'packages/i18n/tiers.json';
const REGISTRY = 'packages/i18n/locale-registry.json';
const CATALOGUE_RU = 'packages/i18n/catalogues/ru/session.json';
const COMPILED = 'packages/i18n/compiled/index.ts';
const RULINGS = 'packages/i18n/tools/rulings.ts';

/** The waived `safety_critical` key these cases use. */
const KEY = 'session.checkins_missed';

interface Edit {
  /** Repository-relative path, as git prints it. */
  readonly file: string;
  readonly plant: (s: string) => string;
}

interface Case {
  readonly name: string;
  readonly why: string;
  readonly edits: readonly Edit[];
  readonly expect: 'PASS' | 'FAIL';
  readonly mustInclude: readonly string[];
  readonly mustExclude: readonly string[];
  /** Exactly how many problem lines start with a refusal name. `n` may be `{PAIRS}` or `{KEYS}`. */
  readonly mustCount?: readonly { readonly name: string; readonly n: string }[];
}

/** JSON in, JSON out — for plants that are easier to state as data than as text. */
function json(mutate: (doc: Record<string, unknown>) => void): (s: string) => string {
  return (s) => {
    const doc = JSON.parse(s) as Record<string, unknown>;
    mutate(doc);
    return `${JSON.stringify(doc, null, 2)}\n`;
  };
}

function waiverOf(doc: Record<string, unknown>): Record<string, unknown> {
  const w = doc['pending_pipeline'];
  if (typeof w !== 'object' || w === null) throw new Error('review.json has no pending_pipeline');
  return w as Record<string, unknown>;
}

/**
 * T-258: the OE-5 terminal state, as T-259 will commit it — every record final
 * with no review under OE-5, no waiver. Refuses to plant over a record that
 * already claims a review, so a case can never start from a forged baseline.
 */
function finalise(doc: Record<string, unknown>): void {
  doc['pending_pipeline'] = null;
  const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
  for (const [locale, perLocale] of Object.entries(entries)) {
    for (const [key, record] of Object.entries(perLocale)) {
      if (record['reviewed_by'] !== null || record['reviewed_at'] !== null) {
        throw new Error(`${locale}/${key} already claims a review`);
      }
      record['status'] = 'unreviewed_by_ruling';
      record['review_ruling'] = 'OE-5';
    }
  }
}

/** Replace exactly one occurrence, or refuse — a plant that matched nothing would judge nothing. */
function once(s: string, from: string | RegExp, to: string): string {
  const hits = typeof from === 'string' ? s.split(from).length - 1 : [...s.matchAll(from)].length;
  if (hits !== 1)
    throw new Error(`expected exactly one match of ${String(from)}, found ${String(hits)}`);
  return s.replace(from, to);
}

/** Take one key out of the waiver — the shape of T-049 delivering that key. */
function unwaive(doc: Record<string, unknown>, key: string): void {
  const w = waiverOf(doc);
  const keys = w['keys'] as string[];
  if (!keys.includes(key)) throw new Error(`${key} is not in the waiver`);
  w['keys'] = keys.filter((k) => k !== key);
}

/** Whether a waiver expiring on the 2026-12-05 anchor is still in force today (WAIVER-READDED-EDITED). */
const READDED_IN_FORCE = Date.now() <= Date.parse('2026-12-05T23:59:59.999Z');

const CASES: readonly Case[] = [
  {
    name: 'DELIVERED-THEN-STALE',
    why:
      "T-044's acceptance criterion, half one: a `safety_critical` string with a STALE review " +
      'record fails the build. The key leaves the waiver (delivery) and the catalogue string is ' +
      'then edited under its record, which is what editing accepted safety copy looks like. No ' +
      'record is moved to the terminal status to reach this: NOT-FINAL fires alongside (T-258).',
    edits: [
      { file: REVIEW, plant: json((doc) => unwaive(doc, KEY)) },
      {
        file: CATALOGUE_RU,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `STALE-RECORD '${KEY}' in ru`,
      'the catalogue string now hashes to sha256:',
      `NOT-FINAL '${KEY}' in ru`,
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'DELIVERED-THEN-ABSENT',
    why:
      "T-044's acceptance criterion, half two: a `safety_critical` string with an ABSENT review " +
      'record fails the build. Absence must fail, or the gate could be satisfied by deleting ' +
      'records (T-040 § contract §6).',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          unwaive(doc, KEY);
          const entries = doc['entries'] as Record<string, Record<string, unknown>>;
          for (const locale of Object.keys(entries)) delete entries[locale]?.[KEY];
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `MISSING-RECORD '${KEY}' in en`,
      `MISSING-RECORD '${KEY}' in el`,
      `MISSING-RECORD '${KEY}' in ru`,
      'review.json has no record',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'DELIVERED-STILL-PENDING',
    why:
      'The state this repository is actually in, with the waiver taken off one key: the record ' +
      'exists, its hash is current and pinned, and it is AI-authored copy (OE-66/OE-67, T-233) ' +
      'still at pending_review. T-258: it is refused as NOT FINAL and as citing no review-dropping ' +
      'ruling — and its authorship is ACCEPTED by this gate alone, reading tools/rulings.ts (OD-258).',
    edits: [{ file: REVIEW, plant: json((doc) => unwaive(doc, KEY)) }],
    expect: 'FAIL',
    mustInclude: [`NOT-FINAL '${KEY}' in ru`, `UNRULED-NO-REVIEW '${KEY}' in ru`],
    mustExclude: [
      'GATE PASS',
      'STALE-RECORD',
      'CRASH',
      'MALFORMED-RECORD',
      'PLACEHOLDER',
      'NOT-AI-AUTHORED',
      'UNRULED-AUTHOR',
      'WRONG-AUTHOR',
      'CLAIMS-REVIEW',
      'UNPINNED-CONTENT',
    ],
    mustCount: [
      { name: 'NOT-FINAL', n: '3' },
      { name: 'UNRULED-NO-REVIEW', n: '3' },
    ],
  },
  {
    name: 'WAIVER-LAPSED',
    why:
      'THE SELF-CLOSING PROPERTY, on the real tree. The waiver is the only reason this gate is ' +
      'green today; move its decision review date into the past and every waived pair is ' +
      'checked exactly as an unwaived one. This is what happens by itself on 2026-12-06.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          waiverOf(doc)['expected_by'] = '2026-09-19';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "WAIVER-EXPIRED the safety-copy waiver's DECISION REVIEW DATE 2026-09-19 has passed",
      'it is the decision that was due',
      `NOT-FINAL '${KEY}' in ru`,
      "NOT-FINAL 'safety.sos.confirm' in en",
    ],
    mustExclude: ['GATE PASS', 'BECAUSE OF THE WAIVER', 'CRASH'],
    mustCount: [{ name: 'NOT-FINAL', n: '{PAIRS}' }],
  },
  {
    name: 'WAIVER-RENEWED',
    why:
      'T-040 QA-F3: a waiver policed only by its own dates can be renewed indefinitely by ' +
      'moving them. The anchor is a literal in the gate, so a renewal is refused by a file the ' +
      'register cannot edit.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          waiverOf(doc)['expected_by'] = '2027-06-01';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: ['WAIVER-RENEWED', 'later than the 2026-12-05 anchor pinned in this gate'],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'WAIVER-EXTENDED',
    why:
      'T-040 QA-F4: the mechanism invites extending a September waiver over copy written later. ' +
      'Here a `transactional` key is promoted to `safety_critical` and added to the waiver in ' +
      'the same change — the cheapest way to make a new safety key stop failing.',
    edits: [
      {
        file: TIERS,
        plant: json((doc) => {
          (doc['tiers'] as Record<string, string>)['legal.terms.accept'] = 'safety_critical';
        }),
      },
      {
        file: REVIEW,
        plant: json((doc) => {
          const w = waiverOf(doc);
          w['keys'] = [...(w['keys'] as string[]), 'legal.terms.accept'];
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "WAIVER-EXTENDED the waiver names 'legal.terms.accept', which was not in it on 2026-09-20",
      'TIER-DRIFT',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'TIER-ESCAPE',
    why:
      "T-040 QA-F5: after T-049 clears the suite's own waiver assertions, re-tiering a safety " +
      'key is the cheapest way to make this gate check less, and nothing else guards it. The ' +
      'pin is in the gate, so the tier file cannot both be the thing checked and the source of ' +
      'the check.',
    edits: [
      {
        file: TIERS,
        plant: json((doc) => {
          (doc['tiers'] as Record<string, string>)[KEY] = 'operational';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `TIER-ESCAPE '${KEY}' was tiered safety_critical on 2026-09-20`,
      `WAIVER-OVERREACH the waiver names '${KEY}'`,
      'TIER-DRIFT',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'LOCALE-DISABLED',
    why:
      'Disabling a locale removes all of its review records from this gate at once — the other ' +
      'half of "make the gate check less". The locale set is pinned in the gate for the same ' +
      'reason the key set is.',
    edits: [
      {
        file: REGISTRY,
        plant: json((doc) => {
          for (const row of doc['locales'] as Record<string, unknown>[]) {
            if (row['code'] === 'ru') row['enabled'] = false;
          }
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "LOCALE-DISABLED 'ru' was an enabled locale on 2026-09-20",
      'LOCALE-DRIFT locale-registry.json enables',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'WAIVED-NO-RECORD',
    why:
      'The waiver waives the CURRENCY of a review, not the EXISTENCE of the provenance row. ' +
      'Without this the first move anyone makes against a gate — delete what it reads — would ' +
      'be green today, because every key is waived.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, unknown>>;
          for (const locale of Object.keys(entries)) entries[locale] = {};
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `WAIVED-NO-RECORD '${KEY}' in ru`,
      'not the existence of the provenance row',
      "WAIVED-NO-RECORD 'safety.sos.confirm' in en",
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'COMPILED-UNREADABLE',
    why:
      "A broken `compiled/` must produce this gate's OWN banner, not an uncaught exception. " +
      '"Did nothing", "refused" and "crashed" have to be three distinguishable outcomes ' +
      '(PROTOCOL §5.1) — and the reason line must be the diagnosis, not a stack trace.',
    edits: [{ file: COMPILED, plant: (s) => `${s}\nexport const T044_BROKEN = (;\n` }],
    expect: 'FAIL',
    mustInclude: [
      'COMPILED-UNREADABLE the committed compiled artefact could not be loaded',
      'examined {PAIRS} (locale, key) pair(s)',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'WAIVED-CLAIMS-REVIEW',
    why:
      'T-258, cut §3 item 5: CLAIMS-REVIEW also applies to WAIVED records, so "nothing claims a ' +
      'human" holds before T-259 as well. One waived record is signed off by a real-looking ' +
      'reviewer on the real tree; the waiver stays in force.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const record = entries['ru']?.[KEY];
          if (record === undefined) throw new Error(`no ru record for ${KEY}`);
          record['status'] = 'signed_off';
          record['reviewed_by'] = 'Eleni Constantinou, Designated Safeguarding Lead';
          record['reviewed_at'] = '2026-10-12T09:00:00Z';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      '(in force)',
      '{PAIRS} waived, 0 with a record read',
      `CLAIMS-REVIEW '${KEY}' in ru (waived): status is "signed_off"`,
    ],
    mustExclude: ['GATE PASS', 'CRASH', 'NOT-FINAL', 'UNRULED-NO-REVIEW'],
    mustCount: [{ name: 'CLAIMS-REVIEW', n: '1' }],
  },
  {
    name: 'OE5-FINAL-CONTROL',
    why:
      'T-258 CONTROL on the FULL run (readings A, B and C): the real register moved to the OE-5 ' +
      'terminal state — the edit T-259 commits — passes with every pair accepted as AI-authored ' +
      'and reviewed by nobody. Without this, every refusal below could be an always-failing gate.',
    edits: [{ file: REVIEW, plant: json(finalise) }],
    expect: 'PASS',
    mustInclude: [
      'waiver: none in force — every record is checked in full',
      '0 waived, {PAIRS} with a record read',
      'OE-5: {PAIRS} of {PAIRS} pair(s) accepted as AI-authored and reviewed by nobody',
      'compiled artefact: {KEYS} key(s) needing a review record, locales [en, el, ru]',
    ],
    mustExclude: ['GATE FAIL', 'NOTE: all', 'CRASH'],
  },
  {
    name: 'RULINGS-EMPTIED',
    why:
      'T-258, cut §2 item 3: the gate fails closed on its own rulings. Both literals in ' +
      'tools/rulings.ts are emptied over the terminal-state register: every AI record must be ' +
      'refused as unruled, for authorship and for the dropped review alike.',
    edits: [
      { file: REVIEW, plant: json(finalise) },
      {
        file: RULINGS,
        plant: (s) =>
          once(
            once(
              s,
              /export const AI_RULINGS: readonly AiAuthorshipRuling\[\] = \[\n[\s\S]*?\n\];/gu,
              'export const AI_RULINGS: readonly AiAuthorshipRuling[] = [];',
            ),
            /export const REVIEW_DROPPED_RULINGS: readonly ReviewDroppedRuling\[\] = \[\n[\s\S]*?\n\];/gu,
            'export const REVIEW_DROPPED_RULINGS: readonly ReviewDroppedRuling[] = [];',
          ),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `UNRULED-AUTHOR '${KEY}' in ru: cites "OE-66", which is not a stakeholder ruling that makes a model an author (known: none)`,
      `UNRULED-NO-REVIEW '${KEY}' in ru: review_ruling is "OE-5"`,
    ],
    mustExclude: ['GATE PASS', 'CRASH', 'WRONG-AUTHOR', 'CLAIMS-REVIEW', 'UNPINNED-CONTENT'],
    mustCount: [
      { name: 'UNRULED-AUTHOR', n: '{PAIRS}' },
      { name: 'UNRULED-NO-REVIEW', n: '{PAIRS}' },
    ],
  },
  {
    name: 'OE5-LOCALE-UNCOVERED',
    why:
      'T-258: UNRULED-NO-REVIEW checks the ruling covers the LOCALE, not only that it exists. ' +
      "OE-5's locales are narrowed to en/el in tools/rulings.ts over the terminal-state register: " +
      'the ru records, and only they, are refused.',
    edits: [
      { file: REVIEW, plant: json(finalise) },
      {
        file: RULINGS,
        plant: (s) =>
          once(
            s,
            "{ id: 'OE-5', decided_at: '2026-10-11T08:13:50Z', locales: ['en', 'el', 'ru'] }",
            "{ id: 'OE-5', decided_at: '2026-10-11T08:13:50Z', locales: ['en', 'el'] }",
          ),
      },
    ],
    expect: 'FAIL',
    mustInclude: [`UNRULED-NO-REVIEW '${KEY}' in ru: review_ruling is "OE-5"`],
    mustExclude: [
      'GATE PASS',
      'CRASH',
      `UNRULED-NO-REVIEW '${KEY}' in en`,
      `UNRULED-NO-REVIEW '${KEY}' in el`,
      'UNRULED-AUTHOR',
    ],
    mustCount: [{ name: 'UNRULED-NO-REVIEW', n: '{KEYS}' }],
  },
  {
    name: 'WAIVED-UNDEFINED-FIELD',
    why:
      'T-258 rework 1 (QA-F1, A1/A4): the record field set is closed, and the waiver does not ' +
      'cover a field outside it. A sign-off in a field named without "review" (signed_off_by, ' +
      "the register's own stage name dsl_signoff) on a waived record of the real tree.",
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const ru = entries['ru']?.[KEY];
          const el = entries['el']?.[KEY];
          if (ru === undefined || el === undefined) throw new Error(`no ru/el record for ${KEY}`);
          ru['signed_off_by'] = 'Eleni Constantinou, Designated Safeguarding Lead';
          el['dsl_signoff'] = '2026-10-01';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      '(in force)',
      `UNDEFINED-FIELD '${KEY}' in ru (waived): signed_off_by is "Eleni Constantinou, Designated Safeguarding Lead"`,
      `UNDEFINED-FIELD '${KEY}' in el (waived): dsl_signoff is "2026-10-01"`,
    ],
    mustExclude: [
      'GATE PASS',
      'CRASH',
      '  - CLAIMS-REVIEW ',
      '  - NOT-FINAL ',
      '  - UNPINNED-CONTENT ',
    ],
    mustCount: [{ name: 'UNDEFINED-FIELD', n: '2' }],
  },
  {
    name: 'FINAL-UNDEFINED-FIELD',
    why:
      'T-258 rework 1 (QA-F1, A2/A3): after the T-259 flip, on the full run, a sign-off in ' +
      'signed_off_by or approved_by must not be counted "reviewed by nobody".',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          finalise(doc);
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const ru = entries['ru']?.[KEY];
          const en = entries['en']?.['safety.sos.confirm'];
          if (ru === undefined || en === undefined) throw new Error('fixture records missing');
          ru['signed_off_by'] = 'Eleni Constantinou, Designated Safeguarding Lead';
          en['approved_by'] = 'Eleni Constantinou, Designated Safeguarding Lead';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'waiver: none in force',
      `UNDEFINED-FIELD '${KEY}' in ru: signed_off_by is`,
      "UNDEFINED-FIELD 'safety.sos.confirm' in en: approved_by is",
    ],
    mustExclude: ['GATE PASS', 'CRASH', 'OE-5: {PAIRS} of {PAIRS}', '  - NOT-FINAL '],
    mustCount: [{ name: 'UNDEFINED-FIELD', n: '2' }],
  },
  {
    name: 'WAIVED-EDIT-REHASHED',
    why:
      "T-258 rework 1 (QA-F2, P2): under TODAY'S waiver a safety string is edited and its " +
      'record re-hashed, with no gate edit. The pin binds inside the waiver too.',
    edits: [
      {
        file: CATALOGUE_RU,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const ru = entries['ru']?.[KEY];
          if (ru === undefined) throw new Error(`no ru record for ${KEY}`);
          ru['content_hash'] = rehashRu();
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: ['(in force)', `UNPINNED-CONTENT '${KEY}' in ru (waived)`],
    mustExclude: ['GATE PASS', 'CRASH', '  - STALE-RECORD ', '  - NOT-FINAL '],
    mustCount: [{ name: 'UNPINNED-CONTENT', n: '1' }],
  },
  {
    name: 'WAIVED-THEN-STALE',
    why:
      "T-258 rework 1 (QA-F2): under today's waiver a safety string is edited under its record. " +
      'Currency is checked inside the waiver too.',
    edits: [
      {
        file: CATALOGUE_RU,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: ['(in force)', `STALE-RECORD '${KEY}' in ru (waived)`],
    mustExclude: ['GATE PASS', 'CRASH', '  - NOT-FINAL '],
    mustCount: [{ name: 'STALE-RECORD', n: '1' }],
  },
  {
    name: 'WAIVER-READDED-EDITED',
    why:
      "T-258 rework 1 (QA-F2, P3; the negative QA found missing from T-259's plan): after the " +
      'flip, a waiver is re-added with expected_by ON the 2026-12-05 anchor (so not ' +
      'WAIVER-RENEWED) over one key, whose string is then edited and re-hashed with no gate edit.',
    edits: [
      {
        file: CATALOGUE_RU,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
      {
        file: REVIEW,
        plant: json((doc) => {
          // A literal waiver, not the committed one, so the case survives T-259
          // setting `pending_pipeline` to null.
          finalise(doc);
          doc['pending_pipeline'] = {
            opened_at: '2026-10-15',
            expected_by: '2026-12-05',
            owner: 'frontend-developer',
            ticket: 'T-258 rework 1 fixture',
            reason: 'a waiver re-added over one key, to edit its copy without a gate edit',
            keys: [KEY],
          };
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const ru = entries['ru']?.[KEY];
          if (ru === undefined) throw new Error(`no ru record for ${KEY}`);
          ru['content_hash'] = rehashRu();
        }),
      },
    ],
    expect: 'FAIL',
    // Up to and including the anchor day the re-added waiver is in force and
    // the pair is refused as waived; from the day after it has expired and the
    // pair is refused unwaived. Refused either way; the branch is chosen by the
    // same clock the gate reads.
    mustInclude: READDED_IN_FORCE
      ? [
          'waiver: pending_pipeline expires 2026-12-05 (in force), naming 1 key(s)',
          `UNPINNED-CONTENT '${KEY}' in ru (waived)`,
        ]
      : ['  - WAIVER-EXPIRED ', `UNPINNED-CONTENT '${KEY}' in ru:`],
    mustExclude: [
      'GATE PASS',
      'CRASH',
      '  - STALE-RECORD ',
      '  - WAIVER-RENEWED ',
      '  - WAIVER-EXTENDED ',
      ...(READDED_IN_FORCE ? ['  - WAIVER-EXPIRED '] : []),
    ],
    mustCount: [{ name: 'UNPINNED-CONTENT', n: '1' }],
  },
];

/**
 * The NFC-sha256 of the ru catalogue string of KEY AS IT IS ON DISK NOW — the
 * edit plants run in order, so a review.json plant listed after the catalogue
 * plant re-hashes the edited string. The same definition as `contentHash()`
 * (src/review.ts), written out here so the suite does not agree with itself.
 */
function rehashRu(): string {
  const doc = JSON.parse(readFileSync(join(REPO, CATALOGUE_RU), 'utf8')) as Record<string, unknown>;
  const s = String(doc['checkins_missed']);
  if (!s.endsWith(' !!')) throw new Error('rehashRu ran before the catalogue edit landed');
  return `sha256:${createHash('sha256').update(s.normalize('NFC'), 'utf8').digest('hex')}`;
}

/* ------------------------------------------------------------------ driver */

const REPO = join(PKG, '..', '..');

function git(args: readonly string[]): string {
  const r = spawnSync('git', [...args], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function runGate(): { code: number; out: string; banner: string } {
  const r = spawnSync(process.execPath, [GATE_SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const pass = /^GATE PASS {2}gate:safety-review-currency/m.test(out);
  const fail = /^GATE FAIL {2}gate:safety-review-currency/m.test(out);
  let banner = 'NONE';
  if (pass && fail) banner = 'BOTH';
  else if (pass) banner = 'PASS';
  else if (fail) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

if (process.argv.length > 2) {
  console.error('safety-review-currency-negatives: takes no arguments');
  process.exit(2);
}

const dirty = git(['status', '--porcelain', 'packages/i18n']).trim();
if (dirty !== '') {
  console.error('REFUSED: packages/i18n is not clean. Commit first — this script mutates it.');
  console.error(dirty);
  process.exit(2);
}

let unexpected = 0;
let ran = 0;

console.log('CONTROL — the committed tree');
const control = runGate();
console.log(control.out.trimEnd());
if (control.banner !== 'PASS' || control.code !== 0) {
  console.error('!! CONTROL did not pass; every case below would be meaningless.');
  process.exit(1);
}

/**
 * The pair count a case's expected lines need is taken from the CONTROL run
 * rather than typed here, so that adding a safety key or a locale does not
 * silently turn a case into a HARNESS ERROR nobody reads (PROTOCOL §5.3 R1:
 * prefer a number the machine prints).
 */
const pairsMatch = /examined ([0-9]+) \(locale, key\) pair\(s\)/.exec(control.out);
if (pairsMatch?.[1] === undefined) {
  console.error('!! CONTROL printed no pair count');
  process.exit(1);
}
const PAIRS = pairsMatch[1];
const keysMatch = /keys needing a review record \(tiers\.json\): ([0-9]+) of/.exec(control.out);
if (keysMatch?.[1] === undefined) {
  console.error('!! CONTROL printed no key count');
  process.exit(1);
}
const KEYS = keysMatch[1];
function fill(s: string): string {
  return s.replaceAll('{PAIRS}', PAIRS).replaceAll('{KEYS}', KEYS);
}
console.log(`  (expectations filled from CONTROL: ${PAIRS} pair(s), ${KEYS} key(s))`);

for (const c of CASES) {
  ran += 1;
  const originals = new Map<string, string>();
  const problems: string[] = [];
  try {
    for (const edit of c.edits) {
      const abs = join(REPO, edit.file);
      const before = readFileSync(abs, 'utf8');
      originals.set(edit.file, before);
      const planted = edit.plant(before);
      if (planted === before) throw new Error(`the plant changed nothing in ${edit.file}`);
      writeFileSync(abs, planted, 'utf8');
      // The mutation is asserted from disk, not from the variable above.
      if (readFileSync(abs, 'utf8') !== planted)
        throw new Error(`the plant is not on disk: ${edit.file}`);
    }
    const run = runGate();
    if (run.banner !== c.expect) problems.push(`banner=${run.banner} expected=${c.expect}`);
    if (c.expect === 'PASS' ? run.code !== 0 : run.code === 0) {
      problems.push(`exit=${String(run.code)} expected ${c.expect === 'PASS' ? '0' : 'non-zero'}`);
    }
    for (const raw of c.mustInclude) {
      const s = fill(raw);
      if (!run.out.includes(s)) problems.push(`missing: ${s}`);
    }
    for (const raw of c.mustExclude) {
      const s = fill(raw);
      if (run.out.includes(s)) problems.push(`present but banned: ${s}`);
    }
    for (const { name, n } of c.mustCount ?? []) {
      const want = Number(fill(n));
      const got = run.out.split('\n').filter((l) => l.startsWith(`  - ${name} `)).length;
      if (got !== want)
        problems.push(`${name} printed ${String(got)} time(s), expected ${String(want)}`);
    }
    if (problems.length > 0) {
      console.log(run.out.trimEnd());
    } else {
      const line = run.out.split('\n').find((l) => l.startsWith('GATE ')) ?? '';
      console.log(`   ${c.name.padEnd(28)} ok  exit=${String(run.code)}  ${line}`);
    }
  } catch (err) {
    problems.push(`HARNESS ERROR: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const [file, before] of originals) {
      const abs = join(REPO, file);
      writeFileSync(abs, before, 'utf8');
      if (readFileSync(abs, 'utf8') !== before) problems.push(`RESTORE FAILED: ${file}`);
    }
  }
  if (problems.length > 0) {
    unexpected += 1;
    console.error(`!! ${c.name}  UNEXPECTED`);
    for (const p of problems) console.error(`       ${p}`);
    console.error(`       why: ${c.why}`);
  }
}

const after = git(['status', '--porcelain', 'packages/i18n']).trim();
if (after !== '') {
  unexpected += 1;
  console.error('!! the working tree was not restored:');
  console.error(after);
}

console.log('\nCONTROL (re-run on the restored tree)');
const control2 = runGate();
console.log(control2.out.trimEnd());
if (control2.out !== control.out || control2.code !== control.code) {
  unexpected += 1;
  console.error('!! the restored tree does not reproduce the CONTROL run byte for byte');
}

console.log('');
if (unexpected === 0) {
  console.log(`ALL ${String(ran)} CASES BEHAVED AS EXPECTED`);
  process.exit(0);
}
console.log(`!! ${String(unexpected)} of ${String(ran)} CASE(S) MISBEHAVED`);
process.exit(1);
