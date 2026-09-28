/**
 * Kinvara i18n — the shared type vocabulary.
 *
 * SA §TS-12.2 rule 5 / SD §FE-10: **the locale set is DATA, never a TypeScript
 * union type.** `Locale` is therefore a branded string, not `'en' | 'el' | 'ru'`.
 * Adding Turkish (PM Q9/Q10) or a visitor-segment language (PM Q14) is a row in
 * `locale-registry.json` plus a translation programme — it is never a
 * codebase-wide type change. Every value that reaches this module from outside
 * is validated against the registry at runtime; that validation is the only
 * legitimate way to obtain a `Locale`.
 */

declare const localeBrand: unique symbol;

/** A registry-validated BCP-47 locale code. Obtain one only via `asLocale`/`assertLocale`. */
export type Locale = string & { readonly [localeBrand]: 'Locale' };

/** Text direction, mirroring `locale_registry.direction`. */
export type Direction = 'ltr' | 'rtl';

/**
 * CLDR cardinal plural categories. This IS a closed union: CLDR defines exactly
 * these six for cardinals, and unlike the locale set it does not grow when a
 * language is added. `gate:plural-completeness` (EV-2, T-045) reads the
 * per-locale subset from the registry, not from this type.
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** One row of `locale_registry` (SD §DB — `locale_registry`). */
export interface LocaleDescriptor {
  /** BCP-47 code, e.g. `en`, `el`, `ru`. Primary key. */
  readonly code: string;
  /** The language named IN ITS OWN LANGUAGE — the switcher never says "Greek". */
  readonly endonym: string;
  readonly direction: Direction;
  /**
   * TRUE ⇒ this locale requires a lexicon, a red-team, an operator on every
   * shift and a complete `safety_critical` catalogue. A fourth SAFETY locale is
   * a materially larger commitment than a fourth UI locale, and this flag is
   * where that is stated rather than discovered (SA §TS-12, PM Q14).
   */
  readonly isSafetyLanguage: boolean;
  /** The CLDR categories this locale actually uses. `ru` has four. */
  readonly pluralCategories: readonly PluralCategory[];
  readonly enabled: boolean;
}

/**
 * SA §TS-12.3 / SD §FE-10 — the tier taxonomy. Every catalogue key carries
 * exactly one tier and **the tier drives the gate**.
 */
export type Tier = 'safety_critical' | 'transactional' | 'operational' | 'marketing';

export const TIERS: readonly Tier[] = [
  'safety_critical',
  'transactional',
  'operational',
  'marketing',
];

/**
 * What a missing translation does, per tier (SA §TS-12.1, SD §FE-10).
 *
 * `build_failure` is not a runtime behaviour — it is the *absence* of one. For
 * the two strict tiers there is no runtime fallback code path to test, because
 * the compiled catalogue makes a missing key a missing function and the
 * typecheck program does not link (see `compiled/index.ts`).
 */
export type FallbackBehaviour = 'build_failure' | 'fallback_to_default_with_notice';

export interface TierPolicy {
  readonly tier: Tier;
  readonly onMissingTranslation: FallbackBehaviour;
  /** Whether the surface must render a visible "not in your language" notice. */
  readonly rendersFallbackNotice: boolean;
  /** Metric incremented on a fallback render, or `null` where no fallback exists. */
  readonly fallbackMetric: string | null;
  /** Machine translation permitted at all? Prohibited outright on the strict tiers (DV-11). */
  readonly machineTranslationPermitted: boolean;
  /** Requires a DSL review record in `review.json` (SA §TS-12.3, SD Revision Log D8). */
  readonly requiresSafetyReview: boolean;
}

/**
 * Provenance of one catalogue string in one locale (`review.json`).
 *
 * `ai_authored` (T-233): the string was written by an AI model under a
 * stakeholder ruling that makes the model the author (OE-66 / OE-67, EV-16).
 * It names who WROTE the string and nothing else — it is never evidence of
 * review, and a record carrying it is valid only while it cites that ruling
 * (`pipelineIncoherences()` in `review.ts`).
 */
export type ReviewProvenance =
  'authored' | 'translated_professional' | 'legal_review' | 'placeholder' | 'ai_authored';

export type ReviewStatus = 'signed_off' | 'pending_review';
