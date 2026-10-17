/**
 * Sitter tiers and their ranks — SD §DB-4 lines 2003 and 2008 (`sitter_tier`, `tier_rank`), SD 3029
 * (`s.tier_rank >= $required_tier_rank`), OE-30…34 rulings E.4 U-4 (a) (one total function; a NULL
 * tier is rank 0) and the stakeholder's T-157 E-1 ruling (2026-10-10T11:26:56Z, option (a)):
 * `sitter` = 1 < `childcare_professional` = 2 < `infant_qualified` = 3; a youngest child aged 0–2
 * requires rank 3, aged 3 or over requires rank 1.
 *
 * The database writes `tier_rank` with the same mapping (migration 0030, `i1_derived_bookable`);
 * `packages/db-testkit/suites/i1-bookable-state.test.ts` reads the rank the database derives and
 * compares it with E-1's literal ranks, not with this module.
 */
export const SITTER_TIERS = ['sitter', 'childcare_professional', 'infant_qualified'] as const;
export type SitterTier = (typeof SITTER_TIERS)[number];

const RANK: Readonly<Record<SitterTier, number>> = Object.freeze({
  sitter: 1,
  childcare_professional: 2,
  infant_qualified: 3,
});

/** E.4 U-4 (a): total over the enum and NULL; NULL (no tier) is 0, every tier is positive. */
export function tierRank(tier: SitterTier | null): number {
  return tier === null ? 0 : RANK[tier];
}

/**
 * E-1: the minimum `tier_rank` a booking whose youngest child is `youngestChildAgeYears` old
 * requires (0–2 → 3, 3 and over → 1). A negative, fractional or non-finite age is refused with a
 * `RangeError` naming no value.
 */
export function requiredTierRank(youngestChildAgeYears: number): number {
  if (!Number.isInteger(youngestChildAgeYears) || youngestChildAgeYears < 0) {
    throw new RangeError('requiredTierRank: the age must be a whole number of years, 0 or more');
  }
  return youngestChildAgeYears <= 2 ? 3 : 1;
}
