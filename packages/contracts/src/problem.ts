/**
 * THE `problem+json` WIRE SCHEMA (RFC 9457) — SD §BE-2, SD §BE-15, and the
 * stakeholder ruling OE-15 of 2026-09-11.
 *
 * OE-15, both halves, and they are not re-openable:
 *   1. **The error-type host is `errors.kinvara.cy`.** SD §BE-2's
 *      `errors.kinvara.co` is superseded — it appears nowhere in this package.
 *      `TYPE_BASE` below is the single spelling, and it is what a caller
 *      passes to T-023's `toProblem(error, typeBase)`, which takes the host as
 *      a required argument rather than hard-coding one.
 *   2. **`detail` and `instance` are NEVER emitted.** Not "optional", not
 *      "omitted by convention": the document forbids them. `detail` is free
 *      text, which is precisely the channel an echoed input would travel
 *      through, and PROTOCOL §9.2 allows no error payload to echo an input.
 *
 * THE TESTS THAT FAIL IF EITHER MEMBER EVER APPEARS — three, deliberately at
 * three different layers, because each catches a different way of failing:
 *   - THE DOCUMENT: `problem.test.ts` › *OE-15: the generated Problem schema
 *     FORBIDS detail and instance, and a body carrying either is refused*.
 *     It reads `openapi.json` from disk and validates candidate bodies with
 *     `json-schema-check.ts` — a validator that is not Zod — so a Zod schema
 *     that quietly started permitting them would still be caught.
 *   - THE MAPPER: `packages/domain-types` › *InvalidInputError is a 400
 *     problem+json with exactly the standard members*, which deep-equals the
 *     WHOLE body. That is T-023's test and it is the behavioural proof that
 *     `toProblem` emits neither, including when an error's
 *     `problemExtensions()` returns them (they are stripped).
 *   - THE TWO TOGETHER: `problem.test.ts` › *every problem body T-023's
 *     toProblem produces validates against the generated Problem schema, and a
 *     body with detail or instance added does not*. The second half is the
 *     falsifier: without it the first half would pass against a schema that
 *     forbade nothing.
 *
 * WHY `looseObject` AND NOT A CLOSED OBJECT. SD §BE-15 lets an error add
 * extension members (`tailMinutes`, `windows`), and T-023's `toProblem`
 * emits them. So the schema must permit unknown keys — `additionalProperties`
 * is `{}` in the emitted document. `detail` and `instance` are carved back out
 * explicitly by `FORBIDDEN_MEMBERS`, because "additional properties are
 * allowed" would otherwise let them straight back in. That carve-out is the
 * one part of the document not expressible in Zod (JSON Schema's `not`), so
 * the generator adds it from the SAME constant the runtime check reads —
 * stated plainly as a bound in T-022 § Published contract §7.
 */
import { ERROR_CODES } from './error-codes.ts';
import * as z from 'zod';

/** OE-15(1). The only spelling of the host in this package. */
export const TYPE_BASE = 'https://errors.kinvara.cy/';

/** OE-15(2). Read by the generator (into JSON Schema `not`) and by the runtime check below. */
export const FORBIDDEN_MEMBERS = ['detail', 'instance'] as const;

/** A property path, matching T-023's `field` rule: identifier segments joined by dots. */
export const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

/**
 * The six standard members, and nothing named `detail` or `instance`.
 * `status` is an integer 400–599; `code` is the closed enum, so a body whose
 * code is not a real code is refused by the document itself.
 */
export const Problem = z.looseObject({
  type: z.string().startsWith(TYPE_BASE),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: z.enum(ERROR_CODES),
  field: z.string().regex(FIELD_NAME_PATTERN).optional(),
  retryable: z.boolean(),
});

/**
 * The runtime half of OE-15(2), for a caller holding a body it did not build:
 * true when the body carries neither forbidden member at the TOP LEVEL, which
 * is the only level `toProblem` can place a standard member at.
 *
 * NOT a claim about nested keys. T-023 § contract §6 (QA-F6) measured that a
 * NESTED `detail` inside an extension IS emitted, and that is still true: the
 * strip goes by exact top-level key name. Pinned by `problem.test.ts` ›
 * *LIMITATION carried from T-023 QA-F6: a nested detail or instance inside an
 * extension is still emitted, and this check does not see it*.
 */
export function hasNoForbiddenMembers(body: Record<string, unknown>): boolean {
  return !FORBIDDEN_MEMBERS.some((member) => Object.hasOwn(body, member));
}

/**
 * The complete Zod-side verdict on a problem body: the schema AND OE-15(2).
 *
 * Why it is two calls and not one schema. `Problem` above is a `looseObject`,
 * because SD §BE-15 permits extension members — so Zod alone ACCEPTS a body
 * carrying `detail`, while the generated document REFUSES it through its
 * `not` clause. Comparing bare Zod against the document would therefore show
 * a disagreement that is not a defect. This function is the like-for-like
 * Zod-side verdict, and it is what `openapi.test.ts`'s conformance corpus
 * compares against the document.
 *
 * THE BOUND, because it matters to what that comparison proves: this check
 * and the document's `not` clause are both derived from `FORBIDDEN_MEMBERS`,
 * one constant. On the `detail`/`instance` question the two readings are NOT
 * independent, and their agreement proves only that the generator copied the
 * constant. Everything else in the corpus — types, patterns, the code enum,
 * required members, `additionalProperties` — IS checked by two independent
 * implementations (Zod, and `json-schema-check.ts`). The independent evidence
 * that neither member is ever EMITTED is T-023's whole-body deep-equal test,
 * named in this module's header.
 */
export function isWireProblem(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  return Problem.safeParse(body).success && hasNoForbiddenMembers(body as Record<string, unknown>);
}
