/**
 * The closed error-code set (T-022), and the construction-time route it closes.
 *
 * T-023 § contract §6 OPEN (a) was: a code-shaped INPUT passed as a subclass's
 * code is accepted and reaches the body's `code` and `type`, `Error.message`
 * and every logged stack. `papadopoulou` — a lower-cased Cypriot surname —
 * was the pinned example. These tests are the proof it is closed, and the
 * canary is the same string so the two files line up.
 *
 * OD-57 bounds all of it: no gate runs this file. It runs when someone runs
 * `pnpm --filter @kinvara/domain-types test` or `pnpm -w test` by hand.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CODE_REFUSED, ERROR_CODES, ERROR_CODE_SHAPE, isErrorCode } from './error-codes.ts';
import {
  ConflictError,
  IdempotencyKeyReuseError,
  InvalidInputError,
  NotFoundError,
  PolicyDeniedError,
  PreconditionFailedError,
  RateLimitedError,
  StateTransitionInvalidError,
  UnauthenticatedError,
  UpstreamUnavailableError,
  type DomainError,
  type DomainErrorOptions,
} from './errors.ts';
import type { ErrorCode } from './error-codes.ts';

/** T-023's pinned example of the residue: a lower-cased surname that matches the old pattern. */
const SHAPED_NON_MEMBER = 'papadopoulou';

/**
 * A subclass that takes its code as an argument, so a non-member can be forced
 * past the compile-time half with a cast. The cast is the point: it is how a
 * value that did not come from a literal reaches the constructor in real code
 * (`JSON.parse`, an untyped library return — OD-60).
 */
class ForcedCode extends ConflictError {
  constructor(code: string, options: DomainErrorOptions = {}) {
    super(code as ErrorCode, 'Conflict', options);
  }
}

test('every member of ERROR_CODES is lower-case ASCII snake_case, so a badly shaped code cannot be added quietly', () => {
  for (const code of ERROR_CODES) {
    assert.ok(ERROR_CODE_SHAPE.test(code), `${code} is not lower-case ASCII snake_case`);
  }
  // The guard on the guard: a set that somehow emptied would pass the loop above.
  assert.ok(ERROR_CODES.length >= 10, `only ${String(ERROR_CODES.length)} codes`);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, 'ERROR_CODES has a duplicate');
});

test('isErrorCode answers membership, not shape: a code-shaped non-member is refused', () => {
  for (const code of ERROR_CODES) assert.ok(isErrorCode(code), code);
  for (const code of [
    SHAPED_NON_MEMBER,
    'slot_stolen',
    'a',
    'x9_',
    'internal_errors',
    'Not_Found',
    '',
    undefined,
    null,
    42,
  ]) {
    assert.equal(isErrorCode(code), false, JSON.stringify(code));
  }
});

test('T-022 closes T-023 OPEN (a): a code-shaped input passed as a subclass code is refused at construction', () => {
  let built: DomainError | undefined;
  let refusal: unknown;
  try {
    built = new ForcedCode(SHAPED_NON_MEMBER);
  } catch (e) {
    refusal = e;
  }
  if (built !== undefined) {
    assert.fail(
      `constructed: the input reached code=${built.code} message=${built.message} — OPEN (a) is not closed`,
    );
  }
  assert.ok(refusal instanceof TypeError, 'the refusal is a TypeError');
  // PROTOCOL §9.2: the refusal must not echo what it refused, in any channel.
  assert.equal(refusal.message, CODE_REFUSED);
  assert.equal(refusal.message.includes(SHAPED_NON_MEMBER), false, refusal.message);
  assert.equal(String(refusal.stack).includes(SHAPED_NON_MEMBER), false);
});

test('a member passed as a subclass code still constructs, so the check is narrow and not a blanket refusal', () => {
  const e = new ForcedCode('slot_taken');
  assert.equal(e.code, 'slot_taken');
  assert.equal(e.status, 409);
  assert.equal(e.message, 'slot_taken');
});

test('every concrete error class carries a code that is a member of the closed set', () => {
  const classes: DomainError[] = [
    new InvalidInputError(),
    new UnauthenticatedError(),
    new PolicyDeniedError({ basis: 'rebac:none' }),
    new NotFoundError(),
    new StateTransitionInvalidError(),
    new IdempotencyKeyReuseError(),
    new PreconditionFailedError(),
    new RateLimitedError(),
    new UpstreamUnavailableError(),
  ];
  for (const e of classes) {
    assert.ok(isErrorCode(e.code), `${e.name} carries ${e.code}, which is not in ERROR_CODES`);
  }
  // Non-vacuity: if the list above were emptied the loop would pass silently.
  assert.equal(classes.length, 9);
});
