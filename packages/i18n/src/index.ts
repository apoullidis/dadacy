/**
 * `@kinvara/i18n` — the public surface.
 *
 * `./review` is a separate entry point on purpose: it reads the filesystem and
 * belongs to build steps and gates, never to a rendered page.
 *
 * There is no `render()` and no `t()` here. That is `T-041`'s
 * `render(templateId, locale, params)` — one function, no default locale
 * parameter, plus the lint rule banning any call site that passes a locale it
 * did not receive as an argument (SE-8).
 */
export type {
  Locale,
  Direction,
  PluralCategory,
  LocaleDescriptor,
  Tier,
  TierPolicy,
  FallbackBehaviour,
  ReviewProvenance,
  ReviewStatus,
} from './types.ts';
export { TIERS as TIER_NAMES } from './types.ts';

export {
  allLocales,
  enabledLocales,
  safetyLocales,
  isLocale,
  asLocale,
  assertLocale,
  describeLocale,
  pluralCategories,
  defaultLocale,
} from './registry.ts';

export {
  TIER_POLICY,
  STRICT_TIERS,
  isStrictTier,
  tierOf,
  keysAtTier,
  strictKeys,
  allKeys,
} from './tiers.ts';
export type { MessageKey, StrictMessageKey } from './tiers.ts';

export { getCatalogue, resolveMessage, MissingMessageError } from './catalogue.ts';
export type { ResolvedMessage } from './catalogue.ts';

export { formatAst } from './runtime.ts';
export type { MessageFunction } from './runtime.ts';

export { CATALOGUES, STRICT_TIER_COMPLETENESS } from '../compiled/index.ts';
