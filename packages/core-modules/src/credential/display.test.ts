/**
 * `schemeDisplayName` (T-060; CUT-T-060 R-6; `T-251` § Published contract — LIVE §4–§5): a missing,
 * null, non-string or blank locale value is answered `missing`, never filled from another locale.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { schemeDisplayName } from './index.ts';

const EN = 'White Criminal Record Certificate';
const EL = 'Πιστοποιητικό Λευκού Ποινικού Μητρώου';

test('a present locale returns its text byte for byte', () => {
  const s = { schemeNameI18n: { en: EN, el: EL } };
  assert.deepEqual(schemeDisplayName(s, 'el'), { status: 'present', locale: 'el', text: EL });
  assert.deepEqual(schemeDisplayName(s, 'en'), { status: 'present', locale: 'en', text: EN });
  const padded = { schemeNameI18n: { en: ` ${EN} ` } };
  assert.equal((schemeDisplayName(padded, 'en') as { text: string }).text, ` ${EN} `);
});

test('ru absent is answered missing, with no fallback to en, el or scheme_name', () => {
  const s = { schemeNameI18n: { en: EN, el: EL } };
  assert.deepEqual(schemeDisplayName(s, 'ru'), { status: 'missing', locale: 'ru' });
});

test('null, non-string and blank values are answered missing like an absent key', () => {
  const values: unknown[] = [
    null,
    42,
    true,
    false,
    { a: 1 },
    ['a'],
    '',
    ' ',
    '\t\n\r\v\f',
    '\u0085',
    ' ',
    ' ',
    ' ',
    '　',
    '​',
    '﻿',
    ' ​ ﻿ ',
  ];
  for (const v of values) {
    assert.deepEqual(
      schemeDisplayName({ schemeNameI18n: { ru: v, en: EN } }, 'ru'),
      { status: 'missing', locale: 'ru' },
      JSON.stringify(v),
    );
  }
});

test('locale keys are compared exactly, and inherited properties are not locales', () => {
  const s = { schemeNameI18n: { el: EL } };
  for (const locale of ['EL', 'el-CY', ' el', 'toString', '__proto__', 'constructor']) {
    assert.equal(schemeDisplayName(s, locale).status, 'missing', locale);
  }
});
