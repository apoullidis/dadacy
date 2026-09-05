/**
 * The catalogue runtime — the only thing `compiled/**` imports at run time.
 *
 * SA §TS-12.2 rule 4 / SD §FE-10: **catalogues are compiled to functions at
 * build time, not parsed at run time.** `tools/compile.ts` runs the ICU parser;
 * what ships is a pre-parsed AST plus `intl-messageformat`'s evaluator. Three
 * consequences, in the order SD §FE-10 weights them: a malformed ICU message is
 * a build failure rather than a runtime exception on a safety screen; the ~40 KB
 * ICU parser never enters the 180 KB route budget; and a route that never
 * imports `legal` never ships it.
 */
import { IntlMessageFormat } from 'intl-messageformat';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';

/**
 * One compiled message. Deliberately typed so it cannot be called without its
 * own parameter object: each generated function declares the exact params its
 * ICU source needs, and this alias is only the *storage* type.
 */
export type MessageFunction = (...args: never[]) => string;

const evaluators = new WeakMap<object, IntlMessageFormat>();

/**
 * Format a pre-parsed AST. Cached by AST identity: each generated module holds
 * its ASTs as module-level constants, so one `IntlMessageFormat` is constructed
 * per message per process and reused.
 *
 * `locale` is a required positional parameter and there is no default — the
 * SE-8 rule starts here, at the bottom of the stack, so that no layer above it
 * can invent one. `T-041` puts the same rule on `render()` and adds the lint
 * rule that bans a call site passing a locale it did not receive.
 */
export function formatAst(
  ast: readonly MessageFormatElement[],
  locale: string,
  values: Readonly<Record<string, unknown>>,
): string {
  let evaluator = evaluators.get(ast);
  if (evaluator === undefined) {
    evaluator = new IntlMessageFormat(ast as MessageFormatElement[], locale);
    evaluators.set(ast, evaluator);
  }
  return String(evaluator.format(values as Record<string, string | number | Date>));
}
