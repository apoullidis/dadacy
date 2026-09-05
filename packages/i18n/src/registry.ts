/**
 * The locale registry client — SA §TS-12.1, §TS-12.2 rule 5; SD §FE-10.
 *
 * The registry is DATA. This module is the only supported way to turn an
 * untrusted string into a `Locale`, and every entry point that accepts a locale
 * from outside (a query parameter, an `Accept-Language` header, a capability
 * token, a job payload, a database row) must pass it through `asLocale` or
 * `assertLocale` first.
 *
 * What this module deliberately does NOT do: negotiate. The resolution chain of
 * SA §TS-12.1 / SD §FE-10 (account → capability token → `?locale=` → header →
 * default) is request-scoped middleware in `apps/web`, not a package concern,
 * and it is not this ticket's.
 */
import { DEFAULT_LOCALE, LOCALE_DESCRIPTORS } from '../compiled/registry.ts';
import type { Locale, LocaleDescriptor, PluralCategory } from './types.ts';

const byCode = new Map<string, LocaleDescriptor>(LOCALE_DESCRIPTORS.map((d) => [d.code, d]));

/** Every registered locale, enabled or not. */
export function allLocales(): readonly LocaleDescriptor[] {
  return LOCALE_DESCRIPTORS;
}

/** The locales a user may actually be served. */
export function enabledLocales(): readonly LocaleDescriptor[] {
  return LOCALE_DESCRIPTORS.filter((d) => d.enabled);
}

/**
 * The locales that carry a safeguarding commitment: a lexicon, a red-team, an
 * operator on every shift and a complete `safety_critical` catalogue. A fourth
 * SAFETY locale is a materially larger commitment than a fourth UI locale
 * (SA §TS-12, PM Q14) — this is where the distinction is made explicitly rather
 * than by drift.
 */
export function safetyLocales(): readonly LocaleDescriptor[] {
  return LOCALE_DESCRIPTORS.filter((d) => d.enabled && d.isSafetyLanguage);
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (byCode.get(value)?.enabled ?? false);
}

/** Narrow an untrusted string, or `undefined` if it is not an enabled locale. */
export function asLocale(value: unknown): Locale | undefined {
  return isLocale(value) ? value : undefined;
}

/**
 * Narrow an untrusted string or throw.
 *
 * Note what this function does **not** have: a fallback argument. A caller that
 * cannot produce a locale must say so to its own caller; it may not substitute
 * one. That is SE-8 applied one layer below `render()` — see `T-041`.
 */
export function assertLocale(value: unknown): Locale {
  const locale = asLocale(value);
  if (locale === undefined) {
    throw new RangeError(
      `'${String(value)}' is not an enabled locale. Registered: ${enabledLocales()
        .map((d) => d.code)
        .join(', ')}. The locale set is data (locale-registry.json), not a type.`,
    );
  }
  return locale;
}

export function describeLocale(locale: Locale): LocaleDescriptor {
  const d = byCode.get(locale);
  if (d === undefined) throw new RangeError(`'${locale}' is not registered`);
  return d;
}

/** The CLDR categories this locale actually uses — `ru` has four. Read by `gate:plural-completeness` (EV-2, T-045). */
export function pluralCategories(locale: Locale): readonly PluralCategory[] {
  return describeLocale(locale).pluralCategories;
}

/**
 * The registry's default locale (`en`, PM §MVP-L1 AC2 step 5).
 *
 * This is the LAST step of the negotiation chain, and it is not a general
 * purpose fallback: nothing renders in it because a locale was unavailable at
 * the call site. Reaching for it inside a render path is the SE-8 defect.
 */
export function defaultLocale(): Locale {
  return assertLocale(DEFAULT_LOCALE);
}
