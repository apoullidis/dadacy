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

const SITTER = 'Άδα Χριστοδούλου';
/** Fixed instant so the date argument is deterministic; the toolbox runs with TZ=UTC. */
const DATE = new Date(Date.UTC(2026, 8, 5, 14, 30, 0));

/* ------------------------------------------------------- Russian: four categories */

/**
 * `category` is the CLDR category the count must select, and it is stated so a
 * failure says *which rule broke* rather than only which string differed.
 */
const RU_CHECKINS: readonly [count: number, category: string, expected: string][] = [
  [0, 'many', 'Пропущено 0 отметок'],
  [1, 'one', 'Пропущена 1 отметка'],
  [2, 'few', 'Пропущено 2 отметки'],
  [3, 'few', 'Пропущено 3 отметки'],
  [4, 'few', 'Пропущено 4 отметки'],
  [5, 'many', 'Пропущено 5 отметок'],
  [11, 'many', 'Пропущено 11 отметок'],
  [21, 'one', 'Пропущена 21 отметка'],
  [22, 'few', 'Пропущено 22 отметки'],
  [23, 'few', 'Пропущено 23 отметки'],
  [24, 'few', 'Пропущено 24 отметки'],
  [101, 'one', 'Пропущена 101 отметка'],
  [102, 'few', 'Пропущено 102 отметки'],
  [111, 'many', 'Пропущено 111 отметок'],
  [1.5, 'other', 'Пропущено 1,5 отметки'],
];

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
