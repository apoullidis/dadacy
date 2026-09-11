/**
 * Money — SD §SE-5 / PROTOCOL §9.6: "Money is `bigint` minor units (EUR cents),
 * never a float". SD's ledger rules: "All amounts are `bigint` euro cents".
 *
 * `MinorUnits` is a branded `bigint`, so a `number` cannot be passed where it
 * is expected, and neither can an unbranded `bigint` (type-tests/refusals.ts).
 * Arithmetic on two `MinorUnits` yields a plain `bigint`, which is refused
 * where `MinorUnits` is expected until it is re-branded through
 * `minorUnits()`: pricing arithmetic is `packages/pricing`'s (T-087), and SD
 * §QD-4's Semgrep rule on arithmetic outside it is T-005's.
 *
 * Range: the column type is Postgres `bigint`, so values outside
 * [-2^63, 2^63 - 1] are refused here rather than at the database. The sign is
 * not constrained: ledger lines are signed. The currency is not part of this
 * type; SD §BE-2 carries it alongside as `currency`.
 */
import type { Brand } from './brand.ts';
import { InvalidInputError } from './errors.ts';

export type MinorUnits = Brand<bigint, 'MinorUnits'>;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** A decimal integer with no sign on zero, no leading zeros, no exponent, no point. */
const DECIMAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/;

export function minorUnits(value: unknown, field: string): MinorUnits {
  if (typeof value !== 'bigint' || value < INT64_MIN || value > INT64_MAX) {
    throw new InvalidInputError({ field });
  }
  return value as MinorUnits;
}

/**
 * From a decimal-integer string — the form node-postgres returns a `bigint`
 * column in. `'50.42'`, `'5e3'`, `'-0'`, `'007'` and `' 1'` are refused.
 */
export function parseMinorUnits(value: unknown, field: string): MinorUnits {
  if (typeof value !== 'string' || !DECIMAL_INTEGER.test(value)) {
    throw new InvalidInputError({ field });
  }
  return minorUnits(BigInt(value), field);
}
