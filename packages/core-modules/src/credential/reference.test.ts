/**
 * The reference validator without a database (T-060; SD 2098–2104, 2126; SD §DB-18 layers 5–6).
 * The same properties against a pattern planted on a real row are `test/credential-scheme.spec.ts`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { toProblem } from '@kinvara/domain-types';
import {
  REFERENCE_PATTERN_UNUSABLE,
  REFERENCE_REFUSED_LOG,
  REFERENCE_REGEX_FLAGS,
  ReferenceNumberRefusedError,
  ReferencePatternUnusableError,
  validateReference,
} from './index.ts';

const CANARY = 'CANARY-T060-REF-58213';
const TYPE_BASE = 'https://errors.kinvara.test/';
const problem = (e: unknown) => toProblem(e, TYPE_BASE);
const NULL_SCHEME = { id: 1, referenceFormatRegex: null };
const TWELVE = { id: 2, referenceFormatRegex: '[0-9]{12}' };

/** Everything an error exposes as text: message, stack, own properties, JSON, toProblem. */
function exposed(e: unknown): string {
  const parts: string[] = [String(e)];
  if (e instanceof Error) {
    parts.push(e.message, String(e.stack));
    for (const k of Object.getOwnPropertyNames(e)) {
      parts.push(k, String((e as unknown as Record<string, unknown>)[k]));
    }
    parts.push(JSON.stringify(e), JSON.stringify(problem(e)));
  }
  return parts.join('|');
}

test('a NULL regex records 0, a Greek reference and a 20-digit string verbatim, logging nothing', () => {
  const lines: string[] = [];
  for (const ref of ['0', 'ΑΒΓ-123', '12345678901234567890']) {
    const out = validateReference(NULL_SCHEME, ref, (l) => lines.push(l));
    assert.equal(out.status, 'recorded_verbatim');
    assert.equal(out.referenceNumber, ref);
  }
  assert.deepEqual(lines, []);
});

test('a NULL regex validates nothing: not trimmed, not normalised, not length-checked', () => {
  const decomposed = 'Ά'; // Α + combining acute: NFC would compose it
  for (const ref of [' 12 ', '', 'x'.repeat(500), decomposed, 'a\tb', 'ab\u0000']) {
    const out = validateReference(NULL_SCHEME, ref, () => assert.fail('nothing may be logged'));
    assert.equal(out.status, 'recorded_verbatim');
    assert.equal(out.referenceNumber, ref);
    assert.equal(out.referenceNumber.length, ref.length);
  }
  assert.notEqual(decomposed.normalize('NFC'), decomposed);
});

test('a non-NULL regex accepts a reference matching the whole pattern', () => {
  const out = validateReference(TWELVE, '123456789012', () => assert.fail('nothing logged'));
  assert.deepEqual(out, { status: 'format_matched', referenceNumber: '123456789012' });
});

test('the pattern is matched against the whole string, not a substring', () => {
  for (const ref of ['x123456789012', '123456789012x', '1234567890123', '12345678901']) {
    assert.throws(
      () => validateReference(TWELVE, ref, () => undefined),
      ReferenceNumberRefusedError,
      ref,
    );
  }
  // `a|ab` accepts `ab` (with or without the grouping; the grouping is pinned by the next test)
  assert.equal(
    validateReference({ id: 3, referenceFormatRegex: 'a|ab' }, 'ab', () => undefined).status,
    'format_matched',
  );
});

test('an alternation is grouped before anchoring: a|b refuses ax and xb, and accepts a and b', () => {
  // Under `^a|b$` (anchors not grouped) `ax` would match the first branch as a prefix and `xb` the
  // second as a suffix; under `^(?:a|b)$` both are refused (T-060 QA Q-1).
  const AB = { id: 5, referenceFormatRegex: 'a|b' };
  for (const ref of ['ax', 'xb']) {
    assert.throws(
      () => validateReference(AB, ref, () => undefined),
      ReferenceNumberRefusedError,
      ref,
    );
  }
  for (const ref of ['a', 'b']) {
    assert.equal(validateReference(AB, ref, () => undefined).status, 'format_matched', ref);
  }
});

test('a non-matching reference is refused, and the canary is absent from the error and the log', () => {
  const lines: string[] = [];
  let caught: unknown;
  try {
    validateReference(TWELVE, CANARY, (l) => lines.push(l));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ReferenceNumberRefusedError);
  assert.equal(caught.code, 'invalid_input');
  assert.equal(caught.status, 400);
  assert.equal(caught.field, 'referenceNumber');
  assert.equal(caught.reason, 'format_mismatch');
  assert.equal(caught.schemeId, 2);
  assert.equal(caught.cause, undefined);
  // the log is not empty, so "absent" below is not vacuous
  assert.deepEqual(lines, [`${REFERENCE_REFUSED_LOG} scheme_id=2 reason=format_mismatch`]);
  assert.ok(!exposed(caught).includes(CANARY));
  assert.ok(!lines.join('\n').includes(CANARY));
  assert.ok(!exposed(caught).includes('58213'));
});

test('the problem body names the field pointer and never the value', () => {
  try {
    validateReference(TWELVE, CANARY, () => undefined);
    assert.fail('expected a refusal');
  } catch (e) {
    const p = problem(e);
    assert.equal(p.status, 400);
    assert.equal(p.body.code, 'invalid_input');
    assert.equal(p.body.field, 'referenceNumber');
    assert.ok(!JSON.stringify(p).includes(CANARY));
  }
});

test('a pattern that does not compile fails closed: refused, never validated, never skipped', () => {
  // '(' fails everywhere; '[[:digit:]]{8}' is PostgreSQL ARE and fails in JS with u; 'a)(b'
  // compiles only once wrapped, so the as-written compile is what refuses it.
  for (const pattern of ['(', '[[:digit:]]{8}', 'a)(b', '\\', '[', 'x{2,1}']) {
    const lines: string[] = [];
    let caught: unknown;
    try {
      validateReference({ id: 9, referenceFormatRegex: pattern }, CANARY, (l) => lines.push(l));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ReferencePatternUnusableError, pattern);
    assert.equal(caught.message, REFERENCE_PATTERN_UNUSABLE);
    assert.equal(caught.schemeId, 9);
    assert.equal(caught.cause, undefined);
    assert.deepEqual(lines, [`${REFERENCE_REFUSED_LOG} scheme_id=9 reason=pattern_uncompilable`]);
    assert.ok(!exposed(caught).includes(CANARY));
    assert.equal(problem(caught).status, 500);
  }
});

test('the dialect is ECMAScript with u: a named group compiles and matches', () => {
  const out = validateReference(
    { id: 4, referenceFormatRegex: '(?<n>[0-9]{4})-\\k<n>' },
    '1234-1234',
    () => undefined,
  );
  assert.equal(out.status, 'format_matched');
});

test('the flag set is u only: REFERENCE_REGEX_FLAGS is the literal u', () => {
  // T-060 QA Q-2. The two behavioural cases below go red on their own under `um` and `ui`.
  assert.equal(REFERENCE_REGEX_FLAGS, 'u');
});

test('not multiline: [0-9]{12} refuses a reference with a line before or after the digits', () => {
  // under `m`, `^`/`$` would match at the line break and both would be accepted
  for (const ref of ['123456789012\nx', 'x\n123456789012']) {
    assert.throws(
      () => validateReference(TWELVE, ref, () => undefined),
      ReferenceNumberRefusedError,
      JSON.stringify(ref),
    );
  }
});

test('not case-insensitive: [A-Z]{3} refuses abc and accepts ABC', () => {
  // under `i`, `[A-Z]` would accept lower case
  const UPPER = { id: 6, referenceFormatRegex: '[A-Z]{3}' };
  assert.throws(
    () => validateReference(UPPER, 'abc', () => undefined),
    ReferenceNumberRefusedError,
  );
  assert.equal(validateReference(UPPER, 'ABC', () => undefined).status, 'format_matched');
});

test('a non-string reference is refused under either scheme kind, with a fixed reason', () => {
  for (const scheme of [NULL_SCHEME, TWELVE]) {
    for (const ref of [undefined, null, 123456789012, { toString: () => CANARY }]) {
      const lines: string[] = [];
      assert.throws(
        () => validateReference(scheme, ref, (l) => lines.push(l)),
        (e: unknown) =>
          e instanceof ReferenceNumberRefusedError &&
          e.reason === 'not_a_string' &&
          !exposed(e).includes(CANARY),
      );
      assert.equal(lines.length, 1);
      assert.ok(!lines[0]?.includes(CANARY));
    }
  }
});
