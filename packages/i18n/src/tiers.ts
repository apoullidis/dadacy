/**
 * The tier taxonomy and its fallback policy — SA §TS-12.3, SD §FE-10.
 *
 * §MVP-L4's scope boundary is a *policy*; here it is a *mechanism*. Every
 * fully-qualified catalogue key carries exactly one tier, and **the tier drives
 * the gate**. This module is the single place the four tiers' behaviour is
 * stated, so a downstream agent reads one table rather than four gate scripts.
 */
import { TIERS as KEY_TIERS } from '../compiled/tiers.ts';
import type { MessageKey } from '../compiled/tiers.ts';
import type { Tier, TierPolicy } from './types.ts';

export type { MessageKey, StrictMessageKey } from '../compiled/tiers.ts';

/**
 * The whole of SA §TS-12.1's fallback table, as data.
 *
 * `build_failure` is the *absence* of a runtime behaviour, not one of them. For
 * `safety_critical` and `transactional` there is no code path that renders the
 * default locale's string, because `compiled/index.ts` makes a missing key a
 * missing property and the typecheck program does not link.
 */
export const TIER_POLICY: Readonly<Record<Tier, TierPolicy>> = {
  safety_critical: {
    tier: 'safety_critical',
    onMissingTranslation: 'build_failure',
    rendersFallbackNotice: false,
    fallbackMetric: null,
    machineTranslationPermitted: false,
    requiresSafetyReview: true,
  },
  transactional: {
    tier: 'transactional',
    onMissingTranslation: 'build_failure',
    rendersFallbackNotice: false,
    fallbackMetric: null,
    machineTranslationPermitted: false,
    requiresSafetyReview: false,
  },
  operational: {
    tier: 'operational',
    onMissingTranslation: 'fallback_to_default_with_notice',
    rendersFallbackNotice: true,
    fallbackMetric: 'i18n.fallback_rendered',
    machineTranslationPermitted: true,
    requiresSafetyReview: false,
  },
  marketing: {
    tier: 'marketing',
    onMissingTranslation: 'fallback_to_default_with_notice',
    rendersFallbackNotice: true,
    fallbackMetric: 'i18n.fallback_rendered',
    machineTranslationPermitted: true,
    requiresSafetyReview: false,
  },
};

/** The two tiers with no runtime fallback path. Derived from the policy table, not listed twice. */
export const STRICT_TIERS: readonly Tier[] = (Object.keys(TIER_POLICY) as Tier[]).filter(
  (t) => TIER_POLICY[t].onMissingTranslation === 'build_failure',
);

export function isStrictTier(tier: Tier): boolean {
  return TIER_POLICY[tier].onMissingTranslation === 'build_failure';
}

/** The tier of a known key. Unknown keys are impossible: the compiler fails closed on an untiered key. */
export function tierOf(key: MessageKey): Tier {
  return KEY_TIERS[key];
}

/** Every key at a given tier. `gate:safety-review-currency` (T-044) iterates `keysAtTier('safety_critical')`. */
export function keysAtTier(tier: Tier): readonly MessageKey[] {
  return (Object.keys(KEY_TIERS) as MessageKey[]).filter((k) => KEY_TIERS[k] === tier);
}

/** Every key whose tier has no runtime fallback. `gate:locale-completeness` (T-042) iterates this. */
export function strictKeys(): readonly MessageKey[] {
  return (Object.keys(KEY_TIERS) as MessageKey[]).filter((k) => isStrictTier(KEY_TIERS[k]));
}

export function allKeys(): readonly MessageKey[] {
  return Object.keys(KEY_TIERS) as MessageKey[];
}
