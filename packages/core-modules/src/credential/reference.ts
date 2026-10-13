/**
 * THE REFERENCE VALIDATOR (T-060; SD 2098–2104 and 2126, SQ-25; SD §Revision Log C6; SD §DB-18
 * layers 5 and 6).
 *
 * WHEN `reference_format_regex` IS NULL — both Cyprus rows today (`T-251` §2) — THE REFERENCE IS
 * RECORDED VERBATIM AND NOTHING IS VALIDATED. The returned `referenceNumber` is the input string
 * itself: not trimmed, not case-folded, not normalised (no NFC), not length-checked. Capacity is
 * the database's (`sitter_credential_reference_number_bounds`, 1–64 characters and no
 * `[[:cntrl:]]`, S-1 (b)(ii), `T-252`), and `T-255`'s repository maps that refusal by constraint
 * name. This file encodes no jurisdiction's format: the only format is the row's data.
 *
 * WHEN IT IS NON-NULL, the reference must match the WHOLE pattern:
 *   - DIALECT: ECMAScript regular expressions as the running V8 compiles them (`new RegExp`), with
 *     the `u` flag and no other. Named for `T-251` § Published contract — LIVE §5, which fixes no
 *     dialect in the database: a pattern written for PostgreSQL's ARE (`[[:digit:]]`) does not
 *     compile here with `u`, and that is an uncompilable pattern (below), not a skipped check.
 *   - WHOLE-STRING MATCH: the pattern is compiled once as written (that compile is the
 *     "does it compile" test) and then as `^(?:<pattern>)$`, which is the one used to match. So
 *     `[0-9]{12}` does not accept `x123456789012x`, and the group keeps an alternation inside the
 *     anchors: `a|b` refuses `ax` and `xb`. A pattern that already carries `^…$` is unaffected.
 *   - FAIL CLOSED: a pattern that does not compile (either compile throws) refuses the submission
 *     with `ReferencePatternUnusableError` — never "validated", never skipped. That error is a
 *     server fault (it extends `Error`, not `InvalidInputError`), because the sitter's input was
 *     never judged.
 *   - A non-matching reference is refused with `ReferenceNumberRefusedError` (`invalid_input`,
 *     field `referenceNumber`).
 *
 * NEVER ECHOED. Neither error carries the reference, in its message, a property, its `cause` or its
 * stack; nor does the log line written on each refusal, which names the scheme id and a fixed reason
 * only. The pattern is not carried either (it is not personal data, but V8's `SyntaxError` text is
 * not ours to bound, so no `cause` is attached). Held by `reference.test.ts` and, against a pattern
 * planted on a real row in a rolled-back transaction, by `test/credential-scheme.spec.ts`, each with
 * a canary reference asserted absent from the error (message, stack, own properties, JSON) and from
 * every captured log line, AND the refusal line asserted present, so an empty log cannot pass.
 *
 * NOT BOUNDED: the matching time of a pathological pattern (catastrophic backtracking; `(a+)+b`
 * roughly doubles per input character). Patterns arrive only by reviewed data migration (`T-251`
 * §5's last row), and none exists today. Whichever ticket lets an operator author the pattern (SD's
 * scheme editor, SD line 347) owes a bound on it (T-060 § Published contract — LIVE §6).
 */
import { InvalidInputError } from '@kinvara/domain-types';
import type { LogLine } from '../runtime/index.ts';
import type { CredentialScheme } from './scheme.ts';

/** The one flag set the validator compiles `reference_format_regex` with. */
export const REFERENCE_REGEX_FLAGS = 'u';

export type ReferenceOutcome =
  /** `reference_format_regex` is NULL: recorded verbatim, nothing validated. */
  | { readonly status: 'recorded_verbatim'; readonly referenceNumber: string }
  /** The reference matched the scheme's whole pattern. */
  | { readonly status: 'format_matched'; readonly referenceNumber: string };

/** Why a reference was refused. Fixed codes: none carries a value. */
export type ReferenceRefusalReason = 'format_mismatch' | 'not_a_string';

/**
 * The reference does not satisfy the scheme's pattern (or is not a string). `invalid_input`, field
 * `referenceNumber`, message the fixed code. Carries the scheme id and the reason; never the value.
 */
export class ReferenceNumberRefusedError extends InvalidInputError {
  readonly schemeId: number;
  readonly reason: ReferenceRefusalReason;
  constructor(schemeId: number, reason: ReferenceRefusalReason) {
    super({ field: 'referenceNumber' });
    this.schemeId = schemeId;
    this.reason = reason;
  }
}

/** Fixed text of `ReferencePatternUnusableError`. */
export const REFERENCE_PATTERN_UNUSABLE =
  'credential: reference_format_regex does not compile as an ECMAScript (u) pattern; the submission is refused (fail closed)';

/** The scheme's non-NULL pattern does not compile. The submission is refused; nothing validated. */
export class ReferencePatternUnusableError extends Error {
  override readonly name = 'ReferencePatternUnusableError';
  readonly schemeId: number;
  constructor(schemeId: number) {
    super(REFERENCE_PATTERN_UNUSABLE);
    this.schemeId = schemeId;
  }
}

/** The log line's fixed prefix. Each refusal writes exactly one line beginning with it. */
export const REFERENCE_REFUSED_LOG = 'credential: reference refused';

function compileWhole(pattern: string): RegExp | undefined {
  try {
    new RegExp(pattern, REFERENCE_REGEX_FLAGS);
    return new RegExp(`^(?:${pattern})$`, REFERENCE_REGEX_FLAGS);
  } catch {
    return undefined;
  }
}

/**
 * Judge `reference` against `scheme`. Returns the outcome, or throws one of the two errors above
 * after writing one log line (`<REFERENCE_REFUSED_LOG> scheme_id=<n> reason=<code>`).
 */
export function validateReference(
  scheme: Pick<CredentialScheme, 'id' | 'referenceFormatRegex'>,
  reference: unknown,
  log: LogLine,
): ReferenceOutcome {
  const refuse = (reason: ReferenceRefusalReason | 'pattern_uncompilable'): never => {
    log(`${REFERENCE_REFUSED_LOG} scheme_id=${String(scheme.id)} reason=${reason}`);
    if (reason === 'pattern_uncompilable') throw new ReferencePatternUnusableError(scheme.id);
    throw new ReferenceNumberRefusedError(scheme.id, reason);
  };
  if (typeof reference !== 'string') return refuse('not_a_string');
  const pattern = scheme.referenceFormatRegex;
  if (pattern === null) return { status: 'recorded_verbatim', referenceNumber: reference };
  const whole = compileWhole(pattern);
  if (whole === undefined) return refuse('pattern_uncompilable');
  if (!whole.test(reference)) return refuse('format_mismatch');
  return { status: 'format_matched', referenceNumber: reference };
}
