/**
 * Test numbers use the ITU-T E.164 country code 991 (SQ-27): at Cyprus mobile
 * density a plausible-looking +357 9x number is very likely a real person's.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { e164, isE164 } from './phone.ts';
import { InvalidInputError } from './errors.ts';

test('an E.164 number is accepted unchanged, from 2 to 15 digits', () => {
  assert.equal(e164('+99199123456', 'phone'), '+99199123456');
  assert.equal(isE164('+12'), true);
  assert.equal(isE164('+123456789012345'), true);
});

test('no plus, a leading zero, punctuation, spaces, 16 digits and non-strings are refused', () => {
  for (const s of [
    '99199123456',
    '+099199123456',
    '+991 99 123456',
    '+991-99-123456',
    '+1',
    '+1234567890123456',
    '',
    99199123456,
  ]) {
    assert.throws(
      () => e164(s, 'phone'),
      (e: unknown) => e instanceof InvalidInputError && e.field === 'phone',
    );
  }
});
