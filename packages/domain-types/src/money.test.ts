import { test } from 'vitest';
import assert from 'node:assert/strict';
import { minorUnits, parseMinorUnits } from './money.ts';
import { InvalidInputError } from './errors.ts';

function refused(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof InvalidInputError && e.field === 'amountMinor');
}

test('a bigint is accepted, including zero and negatives: ledger lines are signed', () => {
  assert.equal(minorUnits(5042n, 'amountMinor'), 5042n);
  assert.equal(minorUnits(0n, 'amountMinor'), 0n);
  assert.equal(minorUnits(-5042n, 'amountMinor'), -5042n);
});

test('a number is refused at run time too, integer or not, for a caller the compiler cannot see', () => {
  refused(() => minorUnits(5042, 'amountMinor'));
  refused(() => minorUnits(50.42, 'amountMinor'));
  refused(() => minorUnits('5042', 'amountMinor'));
});

test('the Postgres bigint range is the bound, at both ends', () => {
  assert.equal(minorUnits(2n ** 63n - 1n, 'amountMinor'), 2n ** 63n - 1n);
  assert.equal(minorUnits(-(2n ** 63n), 'amountMinor'), -(2n ** 63n));
  refused(() => minorUnits(2n ** 63n, 'amountMinor'));
  refused(() => minorUnits(-(2n ** 63n) - 1n, 'amountMinor'));
});

test('a decimal-integer string parses to the same bigint', () => {
  assert.equal(parseMinorUnits('5042', 'amountMinor'), 5042n);
  assert.equal(parseMinorUnits('-5042', 'amountMinor'), -5042n);
  assert.equal(parseMinorUnits('0', 'amountMinor'), 0n);
  assert.equal(parseMinorUnits('9223372036854775807', 'amountMinor'), 2n ** 63n - 1n);
});

test('a decimal point, an exponent, a signed zero, leading zeros, whitespace and out-of-range strings are refused', () => {
  for (const s of ['50.42', '5e3', '-0', '007', ' 1', '1 ', '', '+1', '9223372036854775808']) {
    refused(() => parseMinorUnits(s, 'amountMinor'));
  }
  refused(() => parseMinorUnits(5042n, 'amountMinor'));
});
