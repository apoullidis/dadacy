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
 * TWO OF THESE ARE T-044'S ACCEPTANCE CRITERION on the real tree: a
 * `safety_critical` string with a STALE review record, and one with an ABSENT
 * one. Since T-259 the committed register is final under OE-5 with no waiver,
 * so both are planted directly over the real records.
 *
 * T-258's cases that need a TRACKED SOURCE FILE mutated — `tools/rulings.ts`,
 * which the gate subprocess imports — and the full run (readings B and C) over
 * the terminal-state register live here too. Since T-259 that register is the
 * committed one.
 *
 * T-259's six real-tree negatives (`OE-5-cut.md` §3) are the `T259-*` cases
 * and `WAIVER-RENEWED`. Cases about the WAIVER path rebuild the pre-T-259
 * register (`unflip`) and run the gate at a faked clock inside that waiver
 * (`now`), so they mean the same thing after 2026-12-05; the driver asserts the
 * gate printed the faked day.
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
const CATALOGUE_EL = 'packages/i18n/catalogues/el/session.json';
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
  /**
   * T-259: run the gate with `Date.now` faked to this instant (a `--import`
   * preload; the gate has no clock option). The driver asserts the gate printed
   * that day, so a clock that did not land is a HARNESS ERROR, not a verdict.
   */
  readonly now?: string;
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

/**
 * T-259 committed the terminal state and `pending_pipeline: null`, so the cases
 * that attack the WAIVER path rebuild the register as it stood before T-259
 * (`main` `34aaadf`): this waiver — the six fields the gate reads, as committed
 * then — over every record moved back to `pending_review` with no
 * `review_ruling`. A literal, so the cases do not depend on a committed waiver.
 */
const PRE_FLIP_WAIVER = {
  opened_at: '2026-09-05',
  expected_by: '2026-12-05',
  owner:
    'frontend-developer (T-049) — Greek-authoring safeguarding practitioner + briefed Russian translator + DSL sign-off',
  ticket: 'T-049',
  reason: 'the pre-T-259 waiver, rebuilt as a fixture by tools/safety-review-currency-negatives.ts',
  keys: [
    'safety.emergency.address_prompt',
    'safety.emergency.call_112.label',
    'safety.emergency.call_112.script',
    'safety.helpline.116111.label',
    'safety.helpline.1466.label',
    'safety.helpline.199.label',
    'safety.sos.confirm',
    'session.checkins_missed',
  ],
};

/**
 * A day on which PRE_FLIP_WAIVER is in force. Waiver-path cases run at it so
 * they mean the same thing after 2026-12-05, when no waiver can be in force.
 */
const WAIVER_DAY = '2026-11-01T12:00:00Z';

/** The pre-T-259 register: PRE_FLIP_WAIVER, every record at pending_review, no review_ruling. */
function unflip(doc: Record<string, unknown>): void {
  doc['pending_pipeline'] = { ...PRE_FLIP_WAIVER, keys: [...PRE_FLIP_WAIVER.keys] };
  const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
  for (const perLocale of Object.values(entries)) {
    for (const record of Object.values(perLocale)) {
      record['status'] = 'pending_review';
      delete record['review_ruling'];
    }
  }
}

/** The ru record of KEY, or a refusal to plant. */
function ruRecord(doc: Record<string, unknown>): Record<string, unknown> {
  const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
  const r = entries['ru']?.[KEY];
  if (r === undefined) throw new Error(`no ru record for ${KEY}`);
  return r;
}

/** Replace exactly one occurrence, or refuse — a plant that matched nothing would judge nothing. */
function once(s: string, from: string | RegExp, to: string): string {
  const hits = typeof from === 'string' ? s.split(from).length - 1 : [...s.matchAll(from)].length;
  if (hits !== 1)
    throw new Error(`expected exactly one match of ${String(from)}, found ${String(hits)}`);
  return s.replace(from, to);
}

/** Whether a waiver expiring on the 2026-12-05 anchor is still in force today (WAIVER-READDED-EDITED). */
const READDED_IN_FORCE = Date.now() <= Date.parse('2026-12-05T23:59:59.999Z');

const CASES: readonly Case[] = [
  {
    name: 'DELIVERED-THEN-STALE',
    why:
      "T-044's acceptance criterion, half one, on the committed (since T-259, final) register: " +
      'a `safety_critical` string edited under its record is STALE. The record and the pin still ' +
      'carry the old hash, so STALE-RECORD fires alone — editing accepted safety copy fails the build.',
    edits: [
      {
        file: CATALOGUE_RU,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'waiver: none in force',
      `STALE-RECORD '${KEY}' in ru`,
      'the catalogue string now hashes to sha256:',
    ],
    mustExclude: ['GATE PASS', 'CRASH', '  - NOT-FINAL ', '  - UNPINNED-CONTENT '],
    mustCount: [{ name: 'STALE-RECORD', n: '1' }],
  },
  {
    name: 'DELIVERED-THEN-ABSENT',
    why:
      "T-044's acceptance criterion, half two: a `safety_critical` string with an ABSENT review " +
      'record fails the build. Absence must fail, or the gate could be satisfied by deleting ' +
      'records (T-040 § contract §6). Since T-259 there is no waiver to take the key out of.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
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
      'One key put back to the pre-T-259 state, with no waiver: AI-authored copy (OE-66/OE-67, ' +
      'T-233), hash current and pinned, at pending_review with no review_ruling. It is refused ' +
      'as NOT FINAL and as citing no review-dropping ruling, and its authorship is ACCEPTED by ' +
      'this gate alone, reading tools/rulings.ts (OD-258).',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          for (const perLocale of Object.values(entries)) {
            const r = perLocale[KEY];
            if (r === undefined) throw new Error(`no record for ${KEY}`);
            r['status'] = 'pending_review';
            delete r['review_ruling'];
          }
        }),
      },
    ],
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
      'THE SELF-CLOSING PROPERTY, kept (T-259): the pre-T-259 register is rebuilt, waiver and ' +
      'all, with the decision review date in the past. Every waived pair is checked exactly as ' +
      'an unwaived one. Before T-259 this is what happened by itself on 2026-12-06.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          unflip(doc);
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
      'T-259 (cut §3 negative 5; T-040 QA-F3): the anti-renewal bound survives the waiver being ' +
      'retired. A `pending_pipeline` RE-ADDED to the flipped register with expected_by ' +
      '2027-01-01 is refused by the anchor pinned in the gate, which the register cannot edit.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          if (doc['pending_pipeline'] !== null) throw new Error('expected no committed waiver');
          doc['pending_pipeline'] = { ...PRE_FLIP_WAIVER, expected_by: '2027-01-01' };
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'WAIVER-RENEWED `pending_pipeline.expected_by` is 2027-01-01, later than the 2026-12-05 anchor pinned in this gate',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [{ name: 'WAIVER-RENEWED', n: '1' }],
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
          doc['pending_pipeline'] = {
            ...PRE_FLIP_WAIVER,
            keys: [...PRE_FLIP_WAIVER.keys, 'legal.terms.accept'],
          };
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
    mustInclude: [`TIER-ESCAPE '${KEY}' was tiered safety_critical on 2026-09-20`, 'TIER-DRIFT'],
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
          unflip(doc);
          const entries = doc['entries'] as Record<string, Record<string, unknown>>;
          for (const locale of Object.keys(entries)) entries[locale] = {};
        }),
      },
    ],
    now: WAIVER_DAY,
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
          unflip(doc);
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const record = entries['ru']?.[KEY];
          if (record === undefined) throw new Error(`no ru record for ${KEY}`);
          record['status'] = 'signed_off';
          record['reviewed_by'] = 'Eleni Constantinou, Designated Safeguarding Lead';
          record['reviewed_at'] = '2026-10-12T09:00:00Z';
        }),
      },
    ],
    now: WAIVER_DAY,
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
      'T-258 CONTROL on the FULL run (readings A, B and C). Since T-259 the COMMITTED register is ' +
      'the OE-5 terminal state, so this case plants nothing: it passes with every pair accepted as ' +
      'AI-authored and reviewed by nobody. Without this, every refusal below could be an ' +
      'always-failing gate.',
    edits: [],
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
          unflip(doc);
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const ru = entries['ru']?.[KEY];
          const el = entries['el']?.[KEY];
          if (ru === undefined || el === undefined) throw new Error(`no ru/el record for ${KEY}`);
          ru['signed_off_by'] = 'Eleni Constantinou, Designated Safeguarding Lead';
          el['dsl_signoff'] = '2026-10-01';
        }),
      },
    ],
    now: WAIVER_DAY,
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
      'T-258 rework 1 (QA-F2, P2): under the pre-T-259 waiver a safety string is edited and its ' +
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
          unflip(doc);
          ruRecord(doc)['content_hash'] = rehashRu();
        }),
      },
    ],
    now: WAIVER_DAY,
    expect: 'FAIL',
    mustInclude: ['(in force)', `UNPINNED-CONTENT '${KEY}' in ru (waived)`],
    mustExclude: ['GATE PASS', 'CRASH', '  - STALE-RECORD ', '  - NOT-FINAL '],
    mustCount: [{ name: 'UNPINNED-CONTENT', n: '1' }],
  },
  {
    name: 'WAIVED-THEN-STALE',
    why:
      'T-258 rework 1 (QA-F2): under the pre-T-259 waiver a safety string is edited under its record. ' +
      'Currency is checked inside the waiver too.',
    edits: [
      {
        file: CATALOGUE_RU,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
      { file: REVIEW, plant: json(unflip) },
    ],
    now: WAIVER_DAY,
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
  {
    name: 'FINAL-NOTE-OBJECT',
    why:
      'T-259, OD-353 (T-258 QA D-NEST1): on the full run over the terminal-state register, a ' +
      'sign-off nested in `note` as an object must not be counted "reviewed by nobody".',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          finalise(doc);
          ruRecord(doc)['note'] = {
            signed_off_by: 'Eleni Constantinou, Designated Safeguarding Lead',
            signed_off_at: '2026-10-01',
          };
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'waiver: none in force',
      `NOTE-NOT-TEXT '${KEY}' in ru: note is {"signed_off_by":`,
    ],
    mustExclude: ['GATE PASS', 'CRASH', 'OE-5: {PAIRS} of {PAIRS}', '  - CLAIMS-REVIEW '],
    mustCount: [{ name: 'NOTE-NOT-TEXT', n: '1' }],
  },
  {
    name: 'FINAL-NOTE-ARRAY-NUMBER',
    why:
      'T-259, OD-353 (T-258 QA D-NEST2, R2-NOTE-NUM): an array and a number in `note` on the ' +
      'terminal-state register, full run.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          finalise(doc);
          ruRecord(doc)['note'] = [
            'Signed off by Eleni Constantinou, Designated Safeguarding Lead',
          ];
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const en = entries['en']?.['safety.sos.confirm'];
          if (en === undefined) throw new Error('no en record for safety.sos.confirm');
          en['note'] = 42;
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `NOTE-NOT-TEXT '${KEY}' in ru: note is ["Signed off by`,
      "NOTE-NOT-TEXT 'safety.sos.confirm' in en: note is 42",
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [{ name: 'NOTE-NOT-TEXT', n: '2' }],
  },
  {
    name: 'WAIVED-NOTE-OBJECT-BOOL',
    why:
      'T-259, OD-353 (T-258 QA D-NEST8, R2-NOTE-BOOL): the same, on a record INSIDE a waiver in ' +
      'force (the pre-T-259 register rebuilt, at a faked clock inside the waiver).',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          unflip(doc);
          ruRecord(doc)['note'] = {
            signed_off_by: 'Eleni Constantinou, Designated Safeguarding Lead',
            signed_off_at: '2026-10-01',
          };
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const el = entries['el']?.[KEY];
          if (el === undefined) throw new Error(`no el record for ${KEY}`);
          el['note'] = true;
        }),
      },
    ],
    now: WAIVER_DAY,
    expect: 'FAIL',
    mustInclude: [
      '(in force)',
      '{PAIRS} waived, 0 with a record read',
      `NOTE-NOT-TEXT '${KEY}' in ru (waived): note is {`,
      `NOTE-NOT-TEXT '${KEY}' in el (waived): note is true`,
    ],
    mustExclude: ['GATE PASS', 'CRASH', '  - NOT-FINAL '],
    mustCount: [{ name: 'NOTE-NOT-TEXT', n: '2' }],
  },
  {
    name: 'T259-SIGNED-OFF',
    why:
      'T-259 cut §3 negative 1, on the flipped register: one record moved to signed_off is a ' +
      'review claim (CLAIMS-REVIEW), and is no longer final (NOT-FINAL).',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          ruRecord(doc)['status'] = 'signed_off';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `CLAIMS-REVIEW '${KEY}' in ru: status is "signed_off"`,
      `NOT-FINAL '${KEY}' in ru`,
    ],
    mustExclude: ['GATE PASS', 'CRASH', '  - UNPINNED-CONTENT ', '  - STALE-RECORD '],
    mustCount: [{ name: 'CLAIMS-REVIEW', n: '1' }],
  },
  {
    name: 'T259-REVIEWED-BY',
    why:
      'T-259 cut §3 negative 2, on the flipped register: one record names a reviewer and is ' +
      'otherwise final — CLAIMS-REVIEW, and nothing else.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          ruRecord(doc)['reviewed_by'] = 'Eleni Constantinou, Designated Safeguarding Lead';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `CLAIMS-REVIEW '${KEY}' in ru: reviewed_by is "Eleni Constantinou, Designated Safeguarding Lead"`,
    ],
    mustExclude: ['GATE PASS', 'CRASH', '  - NOT-FINAL ', '  - UNDEFINED-FIELD '],
    mustCount: [{ name: 'CLAIMS-REVIEW', n: '1' }],
  },
  {
    name: 'T259-EL-EDIT-REHASHED',
    why:
      'T-259 cut §3 negative 3, on the flipped register: an el safety string edited and its ' +
      'record re-hashed to match, with no edit to the gate. STALE-RECORD cannot fire; the pin ' +
      'in the gate (UNPINNED-CONTENT) is what refuses it.',
    edits: [
      {
        file: CATALOGUE_EL,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const el = entries['el']?.[KEY];
          if (el === undefined) throw new Error(`no el record for ${KEY}`);
          el['content_hash'] = rehash(CATALOGUE_EL);
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [`UNPINNED-CONTENT '${KEY}' in el:`, 'AUTHORED_CONTENT_PINNED'],
    mustExclude: ['GATE PASS', 'CRASH', '  - STALE-RECORD '],
    mustCount: [{ name: 'UNPINNED-CONTENT', n: '1' }],
  },
  {
    name: 'T259-RECORD-DELETED',
    why:
      'T-259 cut §3 negative 4, on the flipped register: one record deleted. With no waiver ' +
      'there is nothing to hide behind: MISSING-RECORD, for that pair only.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, unknown>>;
          if (entries['ru']?.[KEY] === undefined) throw new Error(`no ru record for ${KEY}`);
          delete entries['ru'][KEY];
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [`MISSING-RECORD '${KEY}' in ru`],
    mustExclude: ['GATE PASS', 'CRASH', 'WAIVED-NO-RECORD'],
    mustCount: [{ name: 'MISSING-RECORD', n: '1' }],
  },
  {
    name: 'T259-CLOCK-PAST-ANCHOR',
    why:
      'T-259 cut §3 negative 6: the date faked to just past the old waiver anchor (2026-12-06, ' +
      "the first red day before T-259) on the committed tree, nothing else planted. The gate's " +
      'own `today (UTC)` line proves the clock landed. Green: 12-06 no longer turns the build red.',
    edits: [],
    now: '2026-12-06T00:00:01Z',
    expect: 'PASS',
    mustInclude: [
      'today (UTC): 2026-12-06',
      'waiver: none in force — every record is checked in full',
      'OE-5: {PAIRS} of {PAIRS} pair(s) accepted as AI-authored and reviewed by nobody',
    ],
    mustExclude: ['GATE FAIL', 'CRASH', 'WAIVER-EXPIRED', 'NOTE: all'],
  },
  {
    name: 'T259-CLOCK-2027',
    why:
      'T-259 cut §3 negative 6, a second point: the clock a year and a half past the anchor ' +
      '(2027-06-01). Still green, so the absence of a red day is not a one-day margin.',
    edits: [],
    now: '2027-06-01T12:00:00Z',
    expect: 'PASS',
    mustInclude: [
      'today (UTC): 2027-06-01',
      'OE-5: {PAIRS} of {PAIRS} pair(s) accepted as AI-authored and reviewed by nobody',
    ],
    mustExclude: ['GATE FAIL', 'CRASH', 'WAIVER-EXPIRED'],
  },
];

/** The NFC-sha256 of a catalogue's `checkins_missed` string as it is on disk now (the edit plants run first). */
function rehash(file: string): string {
  const doc = JSON.parse(readFileSync(join(REPO, file), 'utf8')) as Record<string, unknown>;
  const str = String(doc['checkins_missed']);
  if (!str.endsWith(' !!')) throw new Error('rehash ran before the catalogue edit landed');
  return `sha256:${createHash('sha256').update(str.normalize('NFC'), 'utf8').digest('hex')}`;
}

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

function runGate(now?: string): { code: number; out: string; banner: string } {
  const pre =
    now === undefined
      ? []
      : [
          '--import',
          `data:text/javascript,${encodeURIComponent(`Date.now = () => ${String(Date.parse(now))};`)}`,
        ];
  const r = spawnSync(process.execPath, [...pre, GATE_SCRIPT], {
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
    const run = runGate(c.now);
    if (c.now !== undefined && !run.out.includes(`today (UTC): ${c.now.slice(0, 10)}`)) {
      throw new Error(`the faked clock ${c.now} did not land`);
    }
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
