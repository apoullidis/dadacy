/**
 * The published error-code enum. See `error-codes.ts` for why the declaration
 * sits in `@kinvara/domain-types` and what that costs.
 *
 * OD-57: no gate runs this file.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ERROR_CODES as DECLARED, isErrorCode as declaredIsErrorCode } from '@kinvara/domain-types';
import { ERROR_CODES, ERROR_CODE_SHAPE, isErrorCode } from './error-codes.ts';

test('the contracts enum IS the domain-types declaration, not a copy of it', () => {
  // Reference identity, deliberately, not deep equality. Deep equality would
  // pass against a second hand-maintained list that happened to agree today,
  // which is exactly the failure mode SD §BE-2's "a SINGLE enum" forbids.
  assert.equal(ERROR_CODES, DECLARED);
  assert.equal(isErrorCode, declaredIsErrorCode);
});

test('the published enum is non-empty, duplicate-free, and every member is lower-case ASCII snake_case', () => {
  assert.ok(ERROR_CODES.length >= 10, `only ${String(ERROR_CODES.length)} codes`);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, 'a duplicate code');
  for (const code of ERROR_CODES) {
    assert.ok(ERROR_CODE_SHAPE.test(code), `${code} is not lower-case ASCII snake_case`);
  }
});

test('isErrorCode is membership, not shape: a code-shaped non-member is refused', () => {
  // `papadopoulou` is T-023's pinned example of the residue this set closes:
  // a lower-cased surname passes the shape and is not a code.
  for (const bad of ['papadopoulou', 'slot_stolen', 'a', 'not_found_2', '', null, 42]) {
    assert.equal(isErrorCode(bad), false, JSON.stringify(bad));
  }
  for (const code of ERROR_CODES) assert.ok(isErrorCode(code), code);
});
