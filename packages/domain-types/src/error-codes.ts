/**
 * THE CLOSED ERROR-CODE SET — SD §BE-2: "`code` comes from a single enum in
 * `packages/contracts`". This file is that enum's DECLARATION; `@kinvara/contracts`
 * re-exports it as `ERROR_CODES` and is the surface every other module codes
 * against (T-022 § Published contract).
 *
 * WHY THE DECLARATION SITS HERE AND NOT IN `packages/contracts` (a recorded
 * deviation from SD §BE-2's wording, not from its substance — there is still
 * exactly ONE set): the check that has to refuse a non-member is
 * `DomainError`'s constructor, in this package. `packages/contracts` imports
 * `packages/domain-types` for `MinorUnits`, so a `domain-types -> contracts`
 * import would be a cycle, and `gate:deps`' `no-circular` rule refuses it
 * (.dependency-cruiser.cjs). Declaring the set here and re-exporting it there
 * keeps one declaration, one check, and no cycle.
 * Held by `contracts/src/error-codes.test.ts` ›
 * *the contracts enum IS the domain-types declaration, not a copy of it*,
 * which compares the two by identity, so a second list cannot appear.
 *
 * HOW A MODULE ADDS A CODE — one place, three consequences, all mechanical:
 *   1. Add the string to `ERROR_CODES` below, in status order. That is the
 *      only edit; there is no second list to keep in step.
 *   2. `pnpm --filter @kinvara/contracts run generate` regenerates
 *      `openapi.json` and the typed client, which carry the enum. Committing
 *      the schema edit without regenerating is what `gate:contract-drift`
 *      refuses.
 *   3. Subclass the right abstract category with the new code as a LITERAL
 *      (`ConflictError`, `DomainRuleViolationError`, `LockedError`). The
 *      constructor parameter is typed `ErrorCode`, so a string that is not a
 *      member does not compile, and the runtime check below refuses one that
 *      reaches it through a cast.
 *
 * This is what closes T-023 § contract §6 OPEN (a), the construction-time
 * residue: a code-shaped INPUT (`papadopoulou` — a lower-cased surname) used
 * to pass the pattern check and reach the body's `code` and `type`,
 * `Error.message` and every logged stack (PROTOCOL §9.2). It is now refused at
 * construction, because it is not a member. It also closes the code half of
 * OPEN (b): `toProblem` re-checks MEMBERSHIP, so an object that never ran the
 * constructor no longer emits an arbitrary code-shaped code.
 */

/**
 * Every `code` this system may put on the wire. Adding a member is the whole
 * process of adding a code (see above); removing one is a wire-contract break.
 *
 * The 400/401/403/404/409/412/429/503 members are the concrete classes in
 * errors.ts. `slot_taken`, `rate_below_floor`, `outside_staffed_hours` and
 * `sitter_review_hold` are the subclass codes SD §BE-2 and errors.ts name as
 * the examples for the three abstract categories; they are members so that a
 * module subclassing a category has a code to use without editing this file on
 * day one. `internal_error` is `toProblem`'s fallback body.
 */
export const ERROR_CODES = [
  'invalid_input',
  'unauthenticated',
  'policy_denied',
  'not_found',
  'state_transition_invalid',
  'idempotency_key_reuse',
  'slot_taken',
  'precondition_failed',
  'rate_below_floor',
  'outside_staffed_hours',
  'sitter_review_hold',
  'rate_limited',
  'upstream_unavailable',
  'internal_error',
] as const;

/** The compile-time half: a string that is not a member is not assignable. */
export type ErrorCode = (typeof ERROR_CODES)[number];

const MEMBERS: ReadonlySet<string> = new Set<string>(ERROR_CODES);

/**
 * The runtime half: membership, not shape. A cast, a `JSON.parse` result or an
 * object that never ran a constructor all reach this.
 */
export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && MEMBERS.has(code);
}

/**
 * The SHAPE every member must have — lower-case ASCII snake_case. The
 * constructor no longer consults it: membership is the check, and it is
 * strictly narrower. It is kept and exported because it is the guard on the
 * SET ITSELF — asserted over every member by
 * `error-codes.test.ts` › *every member of ERROR_CODES is lower-case ASCII
 * snake_case, so a badly shaped code cannot be added quietly*. Without it the
 * set could gain `Slot Taken` and nothing would notice.
 */
export const ERROR_CODE_SHAPE = /^[a-z][a-z0-9_]*$/;

/** Deliberately constant: a refusal must never echo the code it refuses (PROTOCOL §9.2). */
export const CODE_REFUSED =
  'DomainError: code is not a member of ERROR_CODES (the rejected code is not shown)';
