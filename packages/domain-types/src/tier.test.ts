import { test } from 'vitest';
import assert from 'node:assert/strict';
import { requiredTierRank, SITTER_TIERS, tierRank } from './tier.ts';

// E-1's literal ranks (T-157 E-1 option (a), ruled 2026-10-10), written here, not imported.
const E1_RANKS: ReadonlyArray<readonly [string | null, number]> = [
  [null, 0],
  ['sitter', 1],
  ['childcare_professional', 2],
  ['infant_qualified', 3],
];

test('the tier enum is exactly SD 2003\'s three values, in SD\'s order', () => {
  assert.deepEqual([...SITTER_TIERS], ['sitter', 'childcare_professional', 'infant_qualified']);
});

test('tierRank is E-1: NULL 0, sitter 1, childcare_professional 2, infant_qualified 3', () => {
  for (const [tier, rank] of E1_RANKS) {
    assert.equal(tierRank(tier as (typeof SITTER_TIERS)[number] | null), rank, String(tier));
  }
});

test('requiredTierRank is E-1: a youngest child aged 0, 1 or 2 requires rank 3; 3 and over requires rank 1', () => {
  for (const age of [0, 1, 2]) assert.equal(requiredTierRank(age), 3, String(age));
  for (const age of [3, 4, 12, 17]) assert.equal(requiredTierRank(age), 1, String(age));
});

test('SD 3029 under E-1: only infant_qualified meets a 0–2 band; every tier meets a 3+ band; no tier (rank 0) meets either', () => {
  const meets = (tier: (typeof SITTER_TIERS)[number] | null, age: number): boolean =>
    tierRank(tier) >= requiredTierRank(age);
  assert.deepEqual(
    SITTER_TIERS.filter((t) => meets(t, 1)),
    ['infant_qualified'],
  );
  assert.deepEqual(
    SITTER_TIERS.filter((t) => meets(t, 5)),
    ['sitter', 'childcare_professional', 'infant_qualified'],
  );
  assert.equal(meets(null, 1), false);
  assert.equal(meets(null, 5), false);
});

test('a negative, fractional or non-finite age is refused (RangeError), never read as a band', () => {
  for (const age of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => requiredTierRank(age), RangeError, String(age));
  }
});
