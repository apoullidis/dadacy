/**
 * A scheme's display name in one locale (`scheme_name_i18n`; CUT-T-060 R-6; `T-251` § Published
 * contract — LIVE §2 "keys", §4, §5).
 *
 * THE MISSING LOCALE IS AN ANSWER, NOT A FALLBACK. `ru` is absent from both Cyprus rows (R-6: no
 * Russian name has a source, and inventing a legal instrument's name is out of bounds). This
 * function never substitutes another locale's name, `scheme_name`, or a default: it returns
 * `{ status: 'missing' }` and the caller decides what to render (PROTOCOL §9 item 4: no default
 * locale). The same answer is given for a value the database accepts but that is not a usable
 * name (`T-251` §4): JSON `null`, a number, a boolean, an object, an array, `""`, and a string made
 * only of blank characters — `\s` as ECMAScript defines it, plus every `\p{Cc}` (U+0085 among them)
 * and `\p{Cf}` (U+200B, U+FEFF among them) character. A present name is returned byte for byte, not
 * trimmed.
 *
 * The locale argument is a key, compared exactly (`el` is not `EL` and not `el-CY`). It is required:
 * there is no default parameter.
 */
import type { CredentialScheme } from './scheme.ts';

export type SchemeDisplayName =
  | { readonly status: 'present'; readonly locale: string; readonly text: string }
  | { readonly status: 'missing'; readonly locale: string };

const BLANK = /^[\s\p{Cc}\p{Cf}]*$/u;

export function schemeDisplayName(
  scheme: Pick<CredentialScheme, 'schemeNameI18n'>,
  locale: string,
): SchemeDisplayName {
  const i18n = scheme.schemeNameI18n;
  const value = Object.prototype.hasOwnProperty.call(i18n, locale) ? i18n[locale] : undefined;
  if (typeof value !== 'string' || BLANK.test(value)) return { status: 'missing', locale };
  return { status: 'present', locale, text: value };
}
