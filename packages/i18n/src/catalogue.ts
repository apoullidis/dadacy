/**
 * The catalogue loader — SD §FE-10.
 *
 * This module resolves *which compiled function* renders a key in a locale, and
 * whether doing so is a fallback. It deliberately does **not** format: there is
 * exactly one function that renders a template and its signature is
 * `render(templateId, locale, params)` with no default locale (SE-8), and that
 * function belongs to `T-041`. What is left here is the shape it composes over.
 */
import { CATALOGUES } from '../compiled/index.ts';
import type { MessageFunction } from './runtime.ts';
import { defaultLocale, describeLocale } from './registry.ts';
import { isStrictTier, tierOf } from './tiers.ts';
import type { MessageKey } from '../compiled/tiers.ts';
import type { Locale, Tier } from './types.ts';

export interface ResolvedMessage {
  readonly key: MessageKey;
  readonly tier: Tier;
  /** The locale whose catalogue actually supplies the message. */
  readonly renderedIn: Locale;
  /** The locale that was asked for. Differs from `renderedIn` only on a fallback. */
  readonly requested: Locale;
  /**
   * True when the requested locale had no translation and the default locale's
   * string is being used. The surface MUST then render the §MVP-L4 AC5 "not yet
   * available in your language" notice — visibly, not in a tooltip.
   */
  readonly usedFallback: boolean;
  /** Metric to increment on a fallback render, or `null` when no fallback exists. */
  readonly fallbackMetric: string | null;
  readonly message: MessageFunction;
}

export class MissingMessageError extends Error {
  constructor(key: MessageKey, locale: Locale, tier: Tier) {
    super(
      `'${key}' (tier ${tier}) is missing from the '${locale}' catalogue. ` +
        `A ${tier} key has no runtime fallback path by design (SA §TS-12.1) — ` +
        `this should have failed at build time, so reaching this error means the ` +
        `compiled catalogue was bypassed.`,
    );
    this.name = 'MissingMessageError';
  }
}

/** The compiled catalogue for one locale. Throws for an unregistered or disabled locale. */
export function getCatalogue(locale: Locale): Readonly<Record<string, MessageFunction>> {
  describeLocale(locale);
  const catalogue = CATALOGUES[locale];
  if (catalogue === undefined) {
    throw new RangeError(
      `'${locale}' is registered but has no compiled catalogue — run the i18n build`,
    );
  }
  return catalogue;
}

/**
 * Resolve a key in a locale, applying the tier's fallback policy.
 *
 * `locale` is a required positional parameter and there is no default and no
 * fallback argument. A caller that has not been given a locale cannot invent one
 * here.
 */
export function resolveMessage(key: MessageKey, locale: Locale): ResolvedMessage {
  const tier = tierOf(key);
  const direct = getCatalogue(locale)[key];
  if (direct !== undefined) {
    return {
      key,
      tier,
      renderedIn: locale,
      requested: locale,
      usedFallback: false,
      fallbackMetric: null,
      message: direct,
    };
  }
  if (isStrictTier(tier)) throw new MissingMessageError(key, locale, tier);

  const fallbackLocale = defaultLocale();
  const fallback = getCatalogue(fallbackLocale)[key];
  if (fallback === undefined) throw new MissingMessageError(key, fallbackLocale, tier);
  return {
    key,
    tier,
    renderedIn: fallbackLocale,
    requested: locale,
    usedFallback: true,
    fallbackMetric: 'i18n.fallback_rendered',
    message: fallback,
  };
}
