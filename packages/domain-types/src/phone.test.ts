import { test } from 'vitest';
import assert from 'node:assert/strict';
import { e164, isE164 } from './phone.ts';
import { InvalidInputError } from './errors.ts';

test('an E.164 number is accepted unchanged, from 3 to 15 digits', () => {
  assert.equal(e164('+35799123456', 'phone'), '+35799123456');
  assert.equal(isE164('+12'), true);
  assert.equal(isE164('+123456789012345'), true);
});

test('no plus, a leading zero, punctuation, spaces, 16 digits and non-strings are refused', () => {
  for (const s of [
    '35799123456',
    '+035799123456',
    '+357 99 123456',
    '+357-99-123456',
    '+1',
    '+1234567890123456',
    '',
    35799123456,
  ]) {
    assert.throws(
      () => e164(s, 'phone'),
      (e: unknown) => e instanceof InvalidInputError && e.field === 'phone',
    );
  }
});
