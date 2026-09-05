/**
 * The table-driven ICU rendering test — SD §QD-2 ("ICU rendering: table-driven,
 * one test file"), and the gate `T-040` must turn green.
 *
 * Two things are being tested and neither of them is visible in English:
 *
 *   1. **Russian's four CLDR cardinal categories.** `one` / `few` / `many` /
 *      `other` change hands at boundaries a representative sample walks straight
 *      past, so the table below is the *boundary set*, not a sample: 0, 1, 2, 3,
 *      4, 5, 11, 21, 22, 23, 24, 101, 102, 111 and 1.5. A catalogue supplying
 *      only `one`/`other` loads, renders and is silently wrong on most of them —
 *      which is demonstrated, not asserted, in `tools/compile.test.ts`.
 *
 *   2. **Greek grammatical gender through ICU `select`.** «Επαληθευμένη» applied
 *      to a sitter, «Επαληθευμένος» to a man, «Επαληθευμένο» to a generic
 *      subject. The overwhelming majority of sitters are women and the Trust
 *      Dossier copy is person-referring throughout, so this is the common case
 *      and not an edge case (SA §TS-12.2, SD §FE-10).
 *
 * English passes whatever we write here; that is exactly why it is the third
 * table and not the first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages as en } from '../compiled/en/index.ts';
import { messages as el } from '../compiled/el/index.ts';
import { messages as ru } from '../compiled/ru/index.ts';
import { pluralCategories, assertLocale } from './registry.ts';

const SITTER = 'Άδα Χριστοδούλου';
/** Fixed instant so the date argument is deterministic; the toolbox runs with TZ=UTC. */
const DATE = new Date(Date.UTC(2026, 8, 5, 14, 30, 0));

/* ------------------------------------------------------- Russian: four categories */

/**
 * `category` is the CLDR category the count must select. It is **not trusted**:
 * every row is checked against `Intl.PluralRules`, which is the same CLDR data
 * ICU selects with, so the column is an independent oracle rather than a second
 * hand-written statement of the same belief. A check derived from the same
 * reading as the thing it checks can only ever confirm it (PROTOCOL §5.1).
 *
 * The counts are the SD §QD-2 boundary set — 0, 1, 2, 5, 11, 21, 22, 101, 111,
 * 1.5 — plus the ones the role file names (3, 4, 23, 24, 102) and the teens and
 * hundreds where `few`/`many` change hands (12–14, 25, 112–114, 121, 122, 212,
 * 1002, 1005, 1013).
 */
const RU_CHECKINS: readonly [count: number, category: string, expected: string][] = [
  [0, 'many', 'Пропущено 0 отметок'],
  [1, 'one', 'Пропущена 1 отметка'],
  [2, 'few', 'Пропущено 2 отметки'],
  [3, 'few', 'Пропущено 3 отметки'],
  [4, 'few', 'Пропущено 4 отметки'],
  [5, 'many', 'Пропущено 5 отметок'],
  [11, 'many', 'Пропущено 11 отметок'],
  [12, 'many', 'Пропущено 12 отметок'],
  [13, 'many', 'Пропущено 13 отметок'],
  [14, 'many', 'Пропущено 14 отметок'],
  [21, 'one', 'Пропущена 21 отметка'],
  [22, 'few', 'Пропущено 22 отметки'],
  [23, 'few', 'Пропущено 23 отметки'],
  [24, 'few', 'Пропущено 24 отметки'],
  [25, 'many', 'Пропущено 25 отметок'],
  [101, 'one', 'Пропущена 101 отметка'],
  [102, 'few', 'Пропущено 102 отметки'],
  [111, 'many', 'Пропущено 111 отметок'],
  [112, 'many', 'Пропущено 112 отметок'],
  [113, 'many', 'Пропущено 113 отметок'],
  [114, 'many', 'Пропущено 114 отметок'],
  [121, 'one', 'Пропущена 121 отметка'],
  [122, 'few', 'Пропущено 122 отметки'],
  [212, 'many', 'Пропущено 212 отметок'],
  [1002, 'few', 'Пропущено 1\u00a0002 отметки'],
  [1005, 'many', 'Пропущено 1\u00a0005 отметок'],
  [1013, 'many', 'Пропущено 1\u00a0013 отметок'],
  [1.5, 'other', 'Пропущено 1,5 отметки'],
];
// Note the four-digit rows: Russian groups thousands with U+00A0, a NO-BREAK
// SPACE, and separates decimals with a comma. Both come from Intl, and both are
// the kind of thing a hand-rolled formatter gets wrong invisibly.

test('the declared categories match Intl.PluralRules, not our reading of CLDR', () => {
  const rules = new Intl.PluralRules('ru');
  for (const [count, category] of RU_CHECKINS) {
    assert.equal(
      rules.select(count),
      category,
      `ru count=${String(count)}: the table claims '${category}'`,
    );
  }
  const elRules = new Intl.PluralRules('el');
  for (const [count, category] of EL_CHECKINS_CATEGORIES) {
    assert.equal(elRules.select(count), category, `el count=${String(count)}`);
  }
});

test('ru — session.checkins_missed selects all four CLDR categories at their boundaries', () => {
  for (const [count, category, expected] of RU_CHECKINS) {
    assert.equal(
      ru['session.checkins_missed']({ count, sitterName: SITTER }),
      `${expected} от ${SITTER}`,
      `ru count=${String(count)} must render the '${category}' form`,
    );
  }
});

test('ru — all four categories are actually exercised by the table', () => {
  const covered = new Set(RU_CHECKINS.map(([, category]) => category));
  assert.deepEqual([...covered].sort(), ['few', 'many', 'one', 'other']);
});

test('ru — the four categories are mutually distinct at their boundaries', () => {
  // 1 (one), 2 (few), 5 (many) and 1.5 (other) must produce four different
  // strings. A catalogue that collapsed two categories would still pass a
  // per-count assertion if the copy happened to match; this is the check that
  // the DISTINCTION survives.
  const forms = [1, 2, 5, 1.5].map((count) =>
    ru['session.checkins_missed']({ count, sitterName: SITTER }),
  );
  assert.equal(
    new Set(forms).size,
    4,
    `expected four distinct forms, got ${JSON.stringify(forms)}`,
  );
});

test('every category the ru registry declares is reachable from some count', () => {
  // Derived rather than listed: whatever `pluralCategories('ru')` says, a count
  // must exist in the table that selects it. If a fourth locale is added with a
  // category set we have never seen, this fails rather than silently passing.
  const rules = new Intl.PluralRules('ru');
  const reachable = new Set(RU_CHECKINS.map(([count]) => rules.select(count)));
  for (const category of pluralCategories(assertLocale('ru'))) {
    assert.ok(reachable.has(category), `no count in the table selects ru '${category}'`);
  }
});

const RU_BOOKINGS: readonly [number, string][] = [
  [1, '1 предстоящее бронирование'],
  [2, '2 предстоящих бронирования'],
  [4, '4 предстоящих бронирования'],
  [5, '5 предстоящих бронирований'],
  [21, '21 предстоящее бронирование'],
  [1.5, '1,5 предстоящего бронирования'],
];

test('ru — booking.count.upcoming agrees in the adjective as well as the noun', () => {
  for (const [count, expected] of RU_BOOKINGS) {
    assert.equal(ru['booking.count.upcoming']({ count }), expected, `ru count=${String(count)}`);
  }
});

/* ------------------------------------------------- Greek: gender through `select` */

const EL_GENDER: readonly [ref: 'feminine' | 'masculine' | 'other', expected: string][] = [
  ['feminine', 'Επαληθευμένη στις 5 Σεπτεμβρίου 2026'],
  ['masculine', 'Επαληθευμένος στις 5 Σεπτεμβρίου 2026'],
  ['other', 'Επαληθευμένο στις 5 Σεπτεμβρίου 2026'],
];

test('el — common.dossier.verified agrees in gender through ICU select', () => {
  for (const [grammaticalRef, expected] of EL_GENDER) {
    assert.equal(el['common.dossier.verified']({ grammaticalRef, date: DATE }), expected);
  }
});

test('el — the three gendered forms are distinct, and the feminine is not the fallback', () => {
  const forms = EL_GENDER.map(([ref]) =>
    el['common.dossier.verified']({ grammaticalRef: ref, date: DATE }),
  );
  assert.equal(new Set(forms).size, 3);
  assert.notEqual(forms[0], forms[2], 'feminine must not collapse into the `other` form');
});

const RU_GENDER: readonly [ref: 'feminine' | 'masculine' | 'other', expected: string][] = [
  ['feminine', 'Проверена 5 сентября 2026 г.'],
  ['masculine', 'Проверен 5 сентября 2026 г.'],
  ['other', 'Проверено 5 сентября 2026 г.'],
];

test('ru — gender agreement is required in Russian too, not only in Greek', () => {
  for (const [grammaticalRef, expected] of RU_GENDER) {
    assert.equal(ru['common.dossier.verified']({ grammaticalRef, date: DATE }), expected);
  }
});

/** Greek category expectations, checked against Intl.PluralRules in the same test as Russian. */
const EL_CHECKINS_CATEGORIES: readonly [number, string][] = [
  [0, 'other'],
  [1, 'one'],
  [2, 'other'],
  [5, 'other'],
  [11, 'other'],
  [21, 'other'],
  [101, 'other'],
  [1.5, 'other'],
];

const EL_CHECKINS: readonly [number, string][] = [
  [0, '0 χαμένες καταγραφές'],
  [1, '1 χαμένη καταγραφή'],
  [2, '2 χαμένες καταγραφές'],
  [5, '5 χαμένες καταγραφές'],
  [11, '11 χαμένες καταγραφές'],
  [21, '21 χαμένες καταγραφές'],
  [101, '101 χαμένες καταγραφές'],
  [1.5, '1,5 χαμένες καταγραφές'],
];

test('el — cardinals are two-category, and the singular is only 1', () => {
  for (const [count, expected] of EL_CHECKINS) {
    assert.equal(
      el['session.checkins_missed']({ count, sitterName: SITTER }),
      `${expected} από ${SITTER}`,
      `el count=${String(count)}`,
    );
  }
});

/* ------------------------------------------------------------- English: the control */

const EN_CHECKINS: readonly [number, string][] = [
  [0, '0 missed check-ins'],
  [1, '1 missed check-in'],
  [2, '2 missed check-ins'],
  [5, '5 missed check-ins'],
  [1.5, '1.5 missed check-ins'],
];

test('en — the naive ternary happens to work here, which is why the bug is invisible', () => {
  for (const [count, expected] of EN_CHECKINS) {
    assert.equal(
      en['session.checkins_missed']({ count, sitterName: 'Ada' }),
      `${expected} from Ada`,
      `en count=${String(count)}`,
    );
  }
});

/* ----------------------------------------------- Intl formatting inside a message */

test('currency renders through Intl and the symbol moves per locale', () => {
  // SA §TS-12.2 rule 3: Greek and Russian place the symbol AFTER the amount with
  // a non-breaking space, English before it. Hand-rolled formatting gets this
  // wrong in a way no English test can see.
  assert.equal(en['booking.cancel.fee_notice']({ fee: 12.5 }), 'Cancelling now costs €12.50.');
  assert.equal(el['booking.cancel.fee_notice']({ fee: 12.5 }), 'Η ακύρωση τώρα κοστίζει 12,50 €.');
  assert.equal(ru['booking.cancel.fee_notice']({ fee: 12.5 }), 'Отмена сейчас стоит 12,50 €.');
});

/* ------------------------------------------------ the emergency panel, per locale */

test('the 112 script and the helpline labels render, per locale, from human-authored keys', () => {
  // PM §MVP-IS5 AC7: the emergency panel is never machine-translated and never
  // translated at runtime. The mechanism that keeps it so is review.json; what
  // is asserted here is only that each locale has its OWN string, so a silent
  // English fallback on this surface would fail rather than pass.
  const rendered = [
    en['safety.emergency.call_112.script']({ address: 'Λεωφ. Μακαρίου 1, 1065' }),
    el['safety.emergency.call_112.script']({ address: 'Λεωφ. Μακαρίου 1, 1065' }),
    ru['safety.emergency.call_112.script']({ address: 'Λεωφ. Μακαρίου 1, 1065' }),
  ];
  assert.equal(new Set(rendered).size, 3, 'each locale must have its own 112 script');
  for (const r of rendered) assert.match(r, /Λεωφ\. Μακαρίου 1, 1065/);
  assert.match(el['safety.helpline.116111.label'](), /^116 111 — /);
  assert.match(ru['safety.helpline.1466.label'](), /^1466 — /);
});
