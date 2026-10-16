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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCopyPipeline } from '../src/review.ts';
import { enabledLocales } from '../src/index.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PKG, 'tools', 'safety-review-currency.ts');

const REVIEW = 'packages/i18n/review.json';
const TIERS = 'packages/i18n/tiers.json';
const REGISTRY = 'packages/i18n/locale-registry.json';
const CATALOGUE_RU = 'packages/i18n/catalogues/ru/session.json';
const CATALOGUE_EL = 'packages/i18n/catalogues/el/session.json';
const COMPILED = 'packages/i18n/compiled/index.ts';
const RULINGS = 'packages/i18n/tools/rulings.ts';
// T-264
const READ_ALOUD = 'packages/i18n/checks/read-aloud.json';
const RENDER = 'packages/i18n/checks/render-360.json';
const PINS = 'packages/i18n/tools/automated-checks.ts';
const GATE_SRC = 'packages/i18n/tools/safety-review-currency.ts';
const CATALOGUE_EL_SAFETY = 'packages/i18n/catalogues/el/safety.json';
const APP_PLANT = 'apps/web/src/sos-confirm.tsx';
const APP_PLANT_TEST = 'apps/web/src/sos-confirm.test.tsx';
const PIPELINE_TEST = 'src/pipeline.test.ts';
/** The R3-F1 stage-manifest test, as T-264 titles it. */
const MANIFEST_TITLE =
  'R3-F1: four stage ids, that order, ALL BLOCKING (T-264: the 360 px and read-aloud checks are gates, not stages)';
/** The paths the driver requires clean before it starts and after it ends. */
const WATCHED = ['packages/i18n', 'apps/web', 'apps/admin'];

/** The waived `safety_critical` key these cases use. */
const KEY = 'session.checkins_missed';

interface Edit {
  /** Repository-relative path, as git prints it. */
  readonly file: string;
  readonly plant: (s: string) => string;
  /**
   * T-264: the file does NOT exist before the case. The plant receives `''`,
   * the driver asserts the file was absent, and the restore deletes it.
   */
  readonly create?: boolean;
  /** T-264: after writing a created file, `git add --intent-to-add` it so it is tracked; the restore un-adds it. */
  readonly track?: boolean;
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
  /**
   * T-264: instead of the gate, run ONE Vitest case of this package by its
   * title and judge it: exactly one test ran, it FAILED (`expect: 'FAIL'`) or
   * passed, and `mustInclude`/`mustExclude` are read from Vitest's output.
   * There is no banner; a filter that matched nothing is a misbehaviour.
   */
  readonly vitest?: { readonly file: string; readonly title: string };
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
      'be green under a waiver covering every key, as the pre-T-259 one did (rebuilt here by unflip).',
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
    name: 'WAIVER-READDED-LAPSED',
    why:
      'T-259 LIVE §5 item 3: a waiver re-added to the flipped register with expected_by on or ' +
      'before the anchor is a new dated instrument, not a renewal. Once its date has passed it ' +
      'is WAIVER-EXPIRED, which fails the build by itself even though every record is final.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          if (doc['pending_pipeline'] !== null) throw new Error('expected no committed waiver');
          doc['pending_pipeline'] = { ...PRE_FLIP_WAIVER, expected_by: '2026-09-19' };
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "WAIVER-EXPIRED the safety-copy waiver's DECISION REVIEW DATE 2026-09-19 has passed",
      'GATE FAIL  gate:safety-review-currency — 1 problem(s):',
    ],
    mustExclude: ['GATE PASS', 'CRASH', '  - NOT-FINAL ', '  - WAIVER-RENEWED '],
    mustCount: [{ name: 'WAIVER-EXPIRED', n: '1' }],
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
  // ───────────────────────────── T-264: the automated checks (OE-82) ─────────────────────────────
  // Every case below is one of `OE-82-cut.md` §3 T-264's negatives, red-first: the gate at `main`
  // `cfe0886` (which reads neither record file nor the app source) PASSES every one of them.
  {
    name: 'T264-AUTOMATED-CONTROL',
    why:
      'T-264 CONTROL: the committed tree passes, and the automated-checks line it prints equals ' +
      'the counts computed HERE from package exports (`loadCopyPipeline()` channels x ' +
      '`enabledLocales()`, and the committed render-360.json), never from gate output.',
    edits: [],
    expect: 'PASS',
    mustInclude: ['{AUTOMATED_LINE}'],
    mustExclude: ['GATE FAIL', 'CRASH'],
  },
  {
    name: 'T264-READ-ALOUD-RU-DELETED',
    why:
      'Cut negative 1: the ru address_prompt read-aloud record deleted. Its register record is ' +
      'terminal, so the pair is NO-READ-ALOUD-CHECK, and nothing else.',
    edits: [
      {
        file: READ_ALOUD,
        plant: json((doc) => {
          const ru = (doc['records'] as Record<string, Record<string, unknown>>)['ru'];
          if (ru?.['safety.emergency.address_prompt'] === undefined)
            throw new Error('no ru address_prompt record');
          delete ru['safety.emergency.address_prompt'];
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: ["NO-READ-ALOUD-CHECK 'safety.emergency.address_prompt' in ru"],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'NO-READ-ALOUD-CHECK', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-READ-ALOUD-EL-STALE',
    why:
      'Cut negative 2: el call_112.script edited, with the register hash AND AUTHORED_CONTENT_PINNED ' +
      'updated to match (so STALE-RECORD and UNPINNED-CONTENT cannot fire), but the read-aloud ' +
      'record not re-written. STALE-READ-ALOUD-CHECK alone.',
    edits: [
      {
        file: CATALOGUE_EL_SAFETY,
        plant: json((doc) => {
          doc['emergency.call_112.script'] = `${String(doc['emergency.call_112.script'])} !!`;
        }),
      },
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, Record<string, unknown>>>;
          const el = entries['el']?.['safety.emergency.call_112.script'];
          if (el === undefined) throw new Error('no el call_112.script record');
          el['content_hash'] = rehashKey(CATALOGUE_EL_SAFETY, 'emergency.call_112.script');
        }),
      },
      {
        file: GATE_SRC,
        plant: (s) =>
          once(
            s,
            "'sha256:5f5e2816b748dd4fa2153bd83b1d002a955aaa4ec43aa3e26100df3d802978b6'",
            `'${rehashKey(CATALOGUE_EL_SAFETY, 'emergency.call_112.script')}'`,
          ),
      },
    ],
    expect: 'FAIL',
    mustInclude: ["STALE-READ-ALOUD-CHECK 'safety.emergency.call_112.script' in el"],
    mustExclude: ['GATE PASS', 'CRASH', '  - STALE-RECORD ', '  - UNPINNED-CONTENT '],
    mustCount: [
      { name: 'STALE-READ-ALOUD-CHECK', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-READ-ALOUD-FAILED',
    why: 'Cut negative 3: a read-aloud record with result "fail".',
    edits: [
      {
        file: READ_ALOUD,
        plant: json((doc) => {
          checkRecord(doc, 'el', 'safety.emergency.call_112.script')['result'] = 'fail';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: ['READ-ALOUD-FAILED \'safety.emergency.call_112.script\' in el: result is "fail"'],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'READ-ALOUD-FAILED', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-UNPINNED-CHECK-TOOL',
    why: "Cut negative 4: a read-aloud record's tool version changed from the CHECK_TOOLS pin.",
    edits: [
      {
        file: READ_ALOUD,
        plant: json((doc) => {
          checkRecord(doc, 'en', 'session.checkins_missed')['tool'] = 'espeak-ng 1.52';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'UNPINNED-CHECK-TOOL \'session.checkins_missed\' in en: tool is "espeak-ng 1.52"',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'UNPINNED-CHECK-TOOL', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-AWAITING-REMOVED',
    why:
      'Cut negative 5: safety.sos.confirm removed from AWAITING_SURFACE with no render record — ' +
      'NO-RENDER-CHECK in each of the three locales, and nothing else.',
    edits: [{ file: PINS, plant: (s) => once(s, "  'safety.sos.confirm': 'T-110',\n", '') }],
    expect: 'FAIL',
    mustInclude: [
      "NO-RENDER-CHECK 'safety.sos.confirm' in en",
      "NO-RENDER-CHECK 'safety.sos.confirm' in el",
      "NO-RENDER-CHECK 'safety.sos.confirm' in ru",
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'NO-RENDER-CHECK', n: '3' },
      { name: '*', n: '3' },
    ],
  },
  {
    name: 'T264-RENDERED-UNCHECKED',
    why:
      "Cut negative 6: `t('safety.sos.confirm')` planted in a TRACKED file under apps/web/src/ " +
      '(created and added to the index with --intent-to-add; no tracked file exists there today) ' +
      'while the key is still in AWAITING_SURFACE.',
    edits: [{ file: APP_PLANT, create: true, track: true, plant: () => APP_SOURCE }],
    expect: 'FAIL',
    mustInclude: [
      `RENDERED-UNCHECKED 'safety.sos.confirm': it is in AWAITING_SURFACE (against T-110), and tracked app source names it: ${APP_PLANT}`,
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'RENDERED-UNCHECKED', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-BOUND-UNTRACKED-APP-FILE',
    why:
      'The bound of RENDERED-UNCHECKED, measured rather than argued: the same file, NOT added to ' +
      'the index, is not read (`git ls-files`), so the gate passes.',
    edits: [{ file: APP_PLANT, create: true, plant: () => APP_SOURCE }],
    expect: 'PASS',
    mustInclude: ['{AUTOMATED_LINE}'],
    mustExclude: ['GATE FAIL', 'CRASH', 'RENDERED-UNCHECKED'],
  },
  {
    name: 'T264-BOUND-TRACKED-TEST-FILE',
    why:
      'The other bound: a TRACKED *.test.tsx file under apps/web/src naming the key is a test ' +
      'file and is not read, so the gate passes.',
    edits: [{ file: APP_PLANT_TEST, create: true, track: true, plant: () => APP_SOURCE }],
    expect: 'PASS',
    mustInclude: ['{AUTOMATED_LINE}'],
    mustExclude: ['GATE FAIL', 'CRASH', 'RENDERED-UNCHECKED'],
  },
  {
    name: 'T264-AWAITING-AND-CHECKED',
    why:
      'Cut negative 7 (on the real tree; the --root case is in the Vitest file): a passing, current ' +
      'render record added for safety.sos.confirm in en, which is still in AWAITING_SURFACE.',
    edits: [
      {
        file: RENDER,
        plant: json((doc) => {
          addRenderRecord(doc, 'en', 'safety.sos.confirm', RENDER_CHECKED_BY_LITERAL);
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: ["AWAITING-AND-CHECKED 'safety.sos.confirm' in en"],
    mustExclude: ['GATE PASS', 'CRASH', 'CLAIMS-HUMAN-CHECK'],
    mustCount: [
      { name: 'AWAITING-AND-CHECKED', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-CLAIMS-HUMAN-CHECK-READ-ALOUD',
    why: 'Cut negative 8, first file: checked_by "A. Person" on a read-aloud record.',
    edits: [
      {
        file: READ_ALOUD,
        plant: json((doc) => {
          checkRecord(doc, 'ru', 'safety.emergency.address_prompt')['checked_by'] = 'A. Person';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'CLAIMS-HUMAN-CHECK checks/read-aloud.json \'safety.emergency.address_prompt\' in ru: checked_by is "A. Person"',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'CLAIMS-HUMAN-CHECK', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-CLAIMS-HUMAN-CHECK-RENDER',
    why:
      'Cut negative 8, second file: a render record whose checked_by is "A. Person". The key is ' +
      'still awaiting, so AWAITING-AND-CHECKED fires beside it.',
    edits: [
      {
        file: RENDER,
        plant: json((doc) => {
          addRenderRecord(doc, 'el', 'safety.sos.confirm', 'A. Person');
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'CLAIMS-HUMAN-CHECK checks/render-360.json \'safety.sos.confirm\' in el: checked_by is "A. Person"',
      "AWAITING-AND-CHECKED 'safety.sos.confirm' in el",
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'CLAIMS-HUMAN-CHECK', n: '1' },
      { name: 'AWAITING-AND-CHECKED', n: '1' },
      { name: '*', n: '2' },
    ],
  },
  {
    name: 'T264-CHANNEL-DRIFT',
    why:
      "Cut negative 9: call_112.script's channel flipped to screen in review.json, no pin moved. It " +
      'leaves the read-aloud set and changes channel in the render set: one CHANNEL-DRIFT per pin.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const a = (doc['pipeline'] as Record<string, Record<string, Record<string, unknown>>>)[
            'assignments'
          ]?.['safety.emergency.call_112.script'];
          if (a === undefined) throw new Error('no call_112.script assignment');
          a['channel'] = 'screen';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      'CHANNEL-DRIFT \'safety.emergency.call_112.script\': READ_ALOUD_KEYS_PINNED pins it as "spoken_by_user", and review.json gives it channel "screen"',
      'CHANNEL-DRIFT \'safety.emergency.call_112.script\': review.json\'s channel is "screen", and RENDER_KEYS_PINNED pins it as "spoken_by_user"',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'CHANNEL-DRIFT', n: '2' },
      { name: '*', n: '2' },
    ],
  },
  {
    name: 'T264-CHANNEL-DRIFT-VOICE',
    why:
      'CHANNEL-DRIFT, the render half alone: sos.confirm moved to voice. It joins the read-aloud ' +
      'set and leaves the render set — one line per pin.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const a = (doc['pipeline'] as Record<string, Record<string, Record<string, unknown>>>)[
            'assignments'
          ]?.['safety.sos.confirm'];
          if (a === undefined) throw new Error('no sos.confirm assignment');
          a['channel'] = 'voice';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "CHANNEL-DRIFT 'safety.sos.confirm': review.json's channel is \"voice\", and READ_ALOUD_KEYS_PINNED does not list it",
      'CHANNEL-DRIFT \'safety.sos.confirm\': RENDER_KEYS_PINNED pins it as "screen", and review.json gives it channel "voice"',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'CHANNEL-DRIFT', n: '2' },
      { name: '*', n: '2' },
    ],
  },
  {
    name: 'T264-MALFORMED-AWAITING',
    why: 'Cut negative 11: an AWAITING_SURFACE entry with an empty ticket id.',
    edits: [
      {
        file: PINS,
        plant: (s) =>
          once(s, "  'session.checkins_missed': 'T-107',\n", "  'session.checkins_missed': '',\n"),
      },
    ],
    expect: 'FAIL',
    mustInclude: ['MALFORMED-AWAITING \'session.checkins_missed\': owning ticket is ""'],
    mustExclude: ['GATE PASS', 'CRASH'],
    mustCount: [
      { name: 'MALFORMED-AWAITING', n: '1' },
      { name: '*', n: '1' },
    ],
  },
  {
    name: 'T264-STAGE-READDED-DSL',
    why:
      'Cut negative 10: in_context_screenshot_review re-added to pipeline.stages with who "dsl". ' +
      'The R3-F1 stage-manifest test in src/pipeline.test.ts (a literal manifest of four stages since ' +
      'T-264) is red. Red-first is the cfe0886 tree itself, which carries this stage and whose ' +
      'six-stage manifest test passes (the plant changes nothing there, so this case is a HARNESS ' +
      'ERROR at cfe0886 by construction).',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const stages = (doc['pipeline'] as Record<string, unknown>)['stages'] as Record<
            string,
            unknown
          >[];
          if (stages.some((st) => st['id'] === 'in_context_screenshot_review')) return;
          const at = stages.findIndex((st) => st['id'] === 'dsl_signoff');
          if (at < 0) throw new Error('no dsl_signoff stage to re-add after');
          stages.splice(at + 1, 0, {
            id: 'in_context_screenshot_review',
            blocking: true,
            who: 'dsl',
            what: 'In-context review in the running product at the target locale, on a 360 px Android viewport.',
            output: 'Screenshots per locale.',
            completed_at: null,
          });
        }),
      },
    ],
    vitest: { file: PIPELINE_TEST, title: MANIFEST_TITLE },
    expect: 'FAIL',
    mustInclude: ['in_context_screenshot_review', 'is a change to the pipeline, not to a list'],
    mustExclude: [],
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

/* ------------------------------------------------------- T-264 helpers */

/** The app-source plant: a component naming an awaiting key the way a surface would. */
const APP_SOURCE =
  "import { t } from '@kinvara/i18n';\n\n" +
  '// T-264 NEG fixture: planted and removed by tools/safety-review-currency-negatives.ts.\n' +
  "export function SosConfirm(): string {\n  return t('safety.sos.confirm');\n}\n";

/** `checks/render-360.json`'s checked_by literal, written HERE rather than imported (T-265 owns it). */
const RENDER_CHECKED_BY_LITERAL = 'automation:gate:safety-copy-render';

/** The NFC-sha256 of one catalogue string as it is on disk NOW (plants run in order). */
function rehashKey(file: string, localKey: string): string {
  const doc = JSON.parse(readFileSync(join(REPO, file), 'utf8')) as Record<string, unknown>;
  const str = doc[localKey];
  if (typeof str !== 'string' || !str.endsWith(' !!')) {
    throw new Error(`rehashKey ran before the catalogue edit landed (${file} ${localKey})`);
  }
  return `sha256:${createHash('sha256').update(str.normalize('NFC'), 'utf8').digest('hex')}`;
}

/** One record of a check-record file, or a refusal to plant. */
function checkRecord(
  doc: Record<string, unknown>,
  locale: string,
  key: string,
): Record<string, unknown> {
  const r = (doc['records'] as Record<string, Record<string, Record<string, unknown>>>)[locale]?.[
    key
  ];
  if (r === undefined) throw new Error(`no check record for ${key} in ${locale}`);
  return r;
}

/** A render-360 record in T-265's schema, bound to the register's current hash for the pair. */
function addRenderRecord(
  doc: Record<string, unknown>,
  locale: string,
  key: string,
  checkedBy: string,
): void {
  const review = JSON.parse(readFileSync(join(REPO, REVIEW), 'utf8')) as Record<string, unknown>;
  const entry = (review['entries'] as Record<string, Record<string, Record<string, unknown>>>)[
    locale
  ]?.[key];
  if (entry === undefined) throw new Error(`no register record for ${key} in ${locale}`);
  const records = doc['records'] as Record<string, Record<string, unknown>>;
  records[locale] = {
    ...(records[locale] ?? {}),
    [key]: {
      content_hash: entry['content_hash'],
      surface: '/fixture/sos',
      viewport: 'android-360',
      assertions: [
        'NOT-VISIBLE',
        'TEXT-MISMATCH',
        'CLIPPED',
        'TRUNCATED',
        'OFF-VIEWPORT',
        'HORIZONTAL-SCROLL',
        'TAP-TARGET-SMALL',
      ],
      result: 'pass',
      tool: 'playwright 1.62.0 chromium',
      checked_by: checkedBy,
    },
  };
}

/**
 * The automated-checks line the CONTROL must print, computed from PACKAGE
 * EXPORTS and the committed record — never from the gate's output: read-aloud
 * pairs = keys whose `review.json` channel is not `screen` x enabled locales;
 * render pairs = keys whose channel is not `voice` x enabled locales, of which
 * those with a `checks/render-360.json` record are "checked" and the rest
 * "awaiting". (OE-82-cut §3 T-264 CONTROL.) The per-ticket split is not
 * re-derived here; it lives only in AWAITING_SURFACE.
 */
function expectedAutomatedLine(): string {
  const assignments = loadCopyPipeline().assignments;
  const locales = enabledLocales().map((d) => d.code);
  const readAloudKeys = Object.keys(assignments).filter(
    (k) => assignments[k]?.channel !== 'screen',
  );
  const renderKeys = Object.keys(assignments).filter((k) => assignments[k]?.channel !== 'voice');
  const render = JSON.parse(readFileSync(join(REPO, RENDER), 'utf8')) as {
    records: Record<string, Record<string, unknown>>;
  };
  let checked = 0;
  for (const l of locales)
    for (const k of renderKeys) if (render.records[l]?.[k] !== undefined) checked += 1;
  const ra = readAloudKeys.length * locales.length;
  const rp = renderKeys.length * locales.length;
  return `automated checks: read-aloud ${String(ra)}/${String(ra)} pairs current; render-360 ${String(checked)} checked, ${String(rp - checked)} awaiting surface (`;
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

/** T-264: one Vitest case of this package, by title. Judged by the caller. */
function runVitest(file: string, title: string): { code: number; out: string; ran: boolean } {
  const r = spawnSync(
    process.execPath,
    [join(PKG, 'node_modules', 'vitest', 'vitest.mjs'), 'run', file, '-t', title, '--no-color'],
    { cwd: PKG, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // Exactly one test ran, whatever its result: a filter that matched nothing
  // (a renamed title) must not read as a verdict.
  return { code: r.status ?? -1, out, ran: /Tests\s+1 (?:failed|passed)\b/u.test(out) };
}

if (process.argv.length > 2) {
  console.error('safety-review-currency-negatives: takes no arguments');
  process.exit(2);
}

const dirty = git(['status', '--porcelain', '--', ...WATCHED]).trim();
if (dirty !== '') {
  console.error(
    `REFUSED: ${WATCHED.join(', ')} is not clean. Commit first — this script mutates it.`,
  );
  console.error(dirty);
  process.exit(2);
}

let unexpected = 0;
let ran = 0;

/** Thrown after a Vitest-judged case, so the gate-judging half of the loop body is skipped. */
class SkipGate extends Error {}

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
const AUTOMATED_LINE = expectedAutomatedLine();
function fill(s: string): string {
  return s
    .replaceAll('{PAIRS}', PAIRS)
    .replaceAll('{KEYS}', KEYS)
    .replaceAll('{AUTOMATED_LINE}', AUTOMATED_LINE);
}
console.log(`  (expectations filled from CONTROL: ${PAIRS} pair(s), ${KEYS} key(s))`);
console.log(`  (automated-checks line expected from package exports: ${AUTOMATED_LINE}…)`);

for (const c of CASES) {
  ran += 1;
  const originals = new Map<string, string>();
  const created: { file: string; tracked: boolean }[] = [];
  const problems: string[] = [];
  try {
    for (const edit of c.edits) {
      const abs = join(REPO, edit.file);
      if (edit.create === true) {
        if (existsSync(abs))
          throw new Error(`${edit.file} exists; a created plant must start absent`);
        const planted = edit.plant('');
        writeFileSync(abs, planted, 'utf8');
        created.push({ file: edit.file, tracked: false });
        if (readFileSync(abs, 'utf8') !== planted)
          throw new Error(`the plant is not on disk: ${edit.file}`);
        if (edit.track === true) {
          git(['add', '--intent-to-add', '--', edit.file]);
          created[created.length - 1] = { file: edit.file, tracked: true };
          if (git(['ls-files', '--', edit.file]).trim() !== edit.file) {
            throw new Error(`${edit.file} is not tracked after --intent-to-add`);
          }
        }
        continue;
      }
      const before = readFileSync(abs, 'utf8');
      originals.set(edit.file, before);
      const planted = edit.plant(before);
      if (planted === before) throw new Error(`the plant changed nothing in ${edit.file}`);
      writeFileSync(abs, planted, 'utf8');
      // The mutation is asserted from disk, not from the variable above.
      if (readFileSync(abs, 'utf8') !== planted)
        throw new Error(`the plant is not on disk: ${edit.file}`);
    }
    if (c.vitest !== undefined) {
      const v = runVitest(c.vitest.file, c.vitest.title);
      if (!v.ran) problems.push(`vitest: no single case ran for ${JSON.stringify(c.vitest.title)}`);
      if (c.expect === 'FAIL' ? v.code === 0 : v.code !== 0) {
        problems.push(
          `vitest exit=${String(v.code)} expected ${c.expect === 'PASS' ? '0' : 'non-zero'}`,
        );
      }
      for (const raw of c.mustInclude)
        if (!v.out.includes(fill(raw))) problems.push(`missing: ${fill(raw)}`);
      for (const raw of c.mustExclude)
        if (v.out.includes(fill(raw))) problems.push(`present but banned: ${fill(raw)}`);
      if (problems.length > 0) console.log(v.out.trimEnd());
      else
        console.log(
          `   ${c.name.padEnd(28)} ok  vitest exit=${String(v.code)}  ${c.expect === 'FAIL' ? 'Tests 1 failed' : 'Tests 1 passed'}`,
        );
      throw new SkipGate();
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
      // T-264: `*` counts EVERY problem line, so a case can say "this, and nothing else".
      const got = run.out
        .split('\n')
        .filter((l) => (name === '*' ? l.startsWith('  - ') : l.startsWith(`  - ${name} `))).length;
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
    if (!(err instanceof SkipGate)) {
      problems.push(`HARNESS ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    for (const [file, before] of originals) {
      const abs = join(REPO, file);
      writeFileSync(abs, before, 'utf8');
      if (readFileSync(abs, 'utf8') !== before) problems.push(`RESTORE FAILED: ${file}`);
    }
    for (const { file, tracked } of created) {
      try {
        if (tracked) git(['rm', '--cached', '--quiet', '--', file]);
        unlinkSync(join(REPO, file));
      } catch (err) {
        problems.push(
          `RESTORE FAILED: ${file} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (existsSync(join(REPO, file))) problems.push(`RESTORE FAILED: ${file} still exists`);
    }
  }
  if (problems.length > 0) {
    unexpected += 1;
    console.error(`!! ${c.name}  UNEXPECTED`);
    for (const p of problems) console.error(`       ${p}`);
    console.error(`       why: ${c.why}`);
  }
}

const after = git(['status', '--porcelain', '--', ...WATCHED]).trim();
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
