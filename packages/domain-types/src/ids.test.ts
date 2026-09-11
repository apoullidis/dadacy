import { test } from 'vitest';
import assert from 'node:assert/strict';
import { accountId, bookingId, isUlid, sessionId, ulid } from './ids.ts';
import { InvalidInputError } from './errors.ts';

// The ULID spec's own example: 26 characters, Crockford base32, upper case.
const CANONICAL = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function refused(fn: () => unknown, field: string): void {
  assert.throws(fn, (e: unknown) => e instanceof InvalidInputError && e.field === field);
}

test('a canonical ULID is accepted and returned unchanged by every id constructor', () => {
  assert.equal(ulid(CANONICAL, 'id'), CANONICAL);
  assert.equal(accountId(CANONICAL, 'accountId'), CANONICAL);
  assert.equal(bookingId(CANONICAL, 'bookingId'), CANONICAL);
  assert.equal(sessionId(CANONICAL, 'sessionId'), CANONICAL);
  assert.equal(isUlid('7ZZZZZZZZZZZZZZZZZZZZZZZZZ'), true);
});

test('lower case is refused, so one id cannot be stored in two spellings', () => {
  refused(() => ulid(CANONICAL.toLowerCase(), 'id'), 'id');
});

test('a first character above 7 is refused: it overflows 128 bits', () => {
  refused(() => ulid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'id'), 'id');
});

test('the four letters Crockford base32 excludes (I, L, O, U) are refused', () => {
  for (const c of ['I', 'L', 'O', 'U']) {
    refused(() => ulid(`01ARZ3NDEKTSV4RRFFQ69G5FA${c}`, 'id'), 'id');
  }
});

test('25 and 27 characters are refused', () => {
  refused(() => ulid(CANONICAL.slice(1), 'id'), 'id');
  refused(() => ulid(`${CANONICAL}0`, 'id'), 'id');
});

test('a non-string is refused by every id constructor, naming the field it was given', () => {
  refused(() => ulid(12345, 'id'), 'id');
  refused(() => accountId(undefined, 'recipientAccountId'), 'recipientAccountId');
  refused(() => bookingId(null, 'bookingId'), 'bookingId');
  refused(() => sessionId({}, 'sessionId'), 'sessionId');
});
