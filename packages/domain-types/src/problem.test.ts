/**
 * SD §BE-2: "The RFC 9457 body carries `type`, `title`, `status`, `code`,
 * `field?`, `retryable` — and never a `value`."
 *
 * The leak tests plant a distinctive string in every channel a caller can
 * reach (the input, the field argument, the cause, the policy basis, an
 * extension's `value`) and search the SERIALISED body for it, so they do not
 * depend on knowing which key it might have landed under.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ConflictError,
  DomainRuleViolationError,
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
  type ProblemExtensions,
} from './errors.ts';
import { toProblem } from './problem.ts';
import { e164 } from './phone.ts';
import { ulid } from './ids.ts';

/** OE-15 (stakeholder, 2026-09-11): the error-type host is errors.kinvara.cy. */
const BASE = 'https://errors.kinvara.cy/';
/** Numbers in test data use the ITU-T 991 country code (SQ-27). */
const CANARY = 'T023-CANARY-cert-CY-0042-99199123456';
/** QA's canary from T-023 § Review, QA6 P6. */
const QA_CANARY = 'QA-T023-CANARY-9912';

const INTERNAL_ERROR_BODY = {
  type: `${BASE}internal_error`,
  title: 'Internal error',
  status: 500,
  code: 'internal_error',
  retryable: false,
};

/** QA-F1's reproduction, verbatim (T-023 § Review, QA6 P6): an input passed as the code. */
class CodeLeak extends ConflictError {
  constructor(input: string) {
    super(input, 'Conflict', {});
  }
}

/** A code-shaped input: it matches ERROR_CODE, so the shape check alone does not refuse it (QR-R1). */
const SHAPED = 'papadopoulou';

/**
 * QR-R1's reproduction as QA wrote it (T-023 § qa-verification re-review (rework 1), Q4 B2): a
 * subclass that redeclares `code` and assigns it after super(). The one change is `override`, which
 * noImplicitOverride requires and which is erased before the code runs.
 */
class LateCodeLeak extends ConflictError {
  override code: string;
  constructor(i: string) {
    super('late_code_leak', 'Conflict', {});
    this.code = i;
  }
}

/** The same late assignment with no redeclaration: a plain assignment to the instance after super(). */
class LateAssignLeak extends ConflictError {
  constructor(i: string) {
    super('late_assign_leak', 'Conflict', {});
    (this as { code: string }).code = i;
  }
}

/** A subclass that redeclares `code` as a class field with an initializer. */
class FieldCodeLeak extends ConflictError {
  override readonly code: string = SHAPED;
  constructor() {
    super('field_code_leak', 'Conflict', {});
  }
}

/**
 * QR-R1's getter shapes (Q4 D1 and D1b): a `code` accessor on the subclass prototype, with a no-op
 * setter and without one. Installed with defineProperty rather than a class `get code()`; at run
 * time it is the same prototype accessor as in QA's classes.
 */
class GetterCodeLeak extends ConflictError {
  readonly qaInput: string;
  constructor(i: string) {
    super('getter_code_leak', 'Conflict', {});
    this.qaInput = i;
  }
}
class GetterOnlyCodeLeak extends ConflictError {
  readonly qaInput: string;
  constructor(i: string) {
    super('getter_only_code_leak', 'Conflict', {});
    this.qaInput = i;
  }
}
Object.defineProperty(GetterCodeLeak.prototype, 'code', {
  get(this: GetterCodeLeak) {
    return this.qaInput;
  },
  set: () => undefined,
  configurable: true,
});
Object.defineProperty(GetterOnlyCodeLeak.prototype, 'code', {
  get(this: GetterOnlyCodeLeak) {
    return this.qaInput;
  },
  configurable: true,
});

/** What a constructed error puts where, for a failure message: the body, Error.message, the stack. */
function channels(e: DomainError): string {
  return `body=${JSON.stringify(toProblem(e, BASE).body)} message=${e.message} stack-has-input=${String(e.stack).includes(SHAPED)}`;
}

/** Construct, expecting a TypeError. If it constructs, fail with what the late code reached. */
function refusedAtConstruction(make: () => DomainError): void {
  let built: DomainError | undefined;
  let refusal: unknown;
  try {
    built = make();
  } catch (e) {
    refusal = e;
  }
  if (built !== undefined) assert.fail(`constructed: ${channels(built)}`);
  assert.ok(refusal instanceof TypeError, 'the refusal is a TypeError');
  assert.equal(refusal.message.includes(SHAPED), false, refusal.message);
  assert.equal(String(refusal.stack).includes(SHAPED), false);
  assert.deepEqual(toProblem(refusal, BASE).body, INTERNAL_ERROR_BODY);
}

/** An input passed as the title. */
class TitleLeak extends ConflictError {
  constructor(input: string) {
    super('title_leak', input, {});
  }
}

class OutsideWindowError extends DomainRuleViolationError {
  constructor(options: DomainErrorOptions = {}) {
    super('outside_window', 'Outside window', options);
  }
  override problemExtensions(): ProblemExtensions {
    return {
      tailMinutes: 60,
      value: CANARY,
      requested: { startsAt: '2026-11-12T20:30:00Z', value: CANARY },
      windows: [{ value: CANARY, weekday: 3 }],
      status: 200,
      code: 'forged',
      type: 'https://evil.test/x',
      retryable: true,
      detail: CANARY,
      instance: CANARY,
    };
  }
}

test('InvalidInputError is a 400 problem+json with exactly the standard members', () => {
  const p = toProblem(new InvalidInputError({ field: 'startsAt' }), BASE);
  assert.equal(p.status, 400);
  assert.equal(p.contentType, 'application/problem+json');
  assert.deepEqual(p.body, {
    type: `${BASE}invalid_input`,
    title: 'Invalid input',
    status: 400,
    code: 'invalid_input',
    field: 'startsAt',
    retryable: false,
  });
});

test('every concrete class maps to its SD §BE-2 status and retryable flag', () => {
  const table: [DomainError, number, string, boolean][] = [
    [new InvalidInputError(), 400, 'invalid_input', false],
    [new UnauthenticatedError(), 401, 'unauthenticated', false],
    [new PolicyDeniedError({ basis: 'rebac:none' }), 403, 'policy_denied', false],
    [new NotFoundError(), 404, 'not_found', false],
    [new StateTransitionInvalidError(), 409, 'state_transition_invalid', false],
    [new IdempotencyKeyReuseError(), 409, 'idempotency_key_reuse', false],
    [new PreconditionFailedError(), 412, 'precondition_failed', false],
    [new OutsideWindowError(), 422, 'outside_window', false],
    [new RateLimitedError(), 429, 'rate_limited', true],
    [new UpstreamUnavailableError(), 503, 'upstream_unavailable', true],
  ];
  for (const [error, status, code, retryable] of table) {
    const p = toProblem(error, BASE);
    assert.deepEqual(
      [p.status, p.body.status, p.body.code, p.body.type, p.body.retryable],
      [status, status, code, `${BASE}${code}`, retryable],
    );
  }
});

test('a constructor refusal does not echo the offending input into the body, the message or the name', () => {
  for (const attempt of [() => e164(CANARY, 'phone'), () => ulid(CANARY, 'recipientAccountId')]) {
    let caught: unknown;
    try {
      attempt();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof InvalidInputError);
    assert.equal(JSON.stringify(toProblem(caught, BASE)).includes(CANARY), false);
    assert.equal(caught.message, 'invalid_input');
    assert.equal(caught.name, 'InvalidInputError');
    assert.equal(String(caught.stack).includes(CANARY), false);
  }
});

test('a value passed where the field NAME belongs is dropped, not emitted', () => {
  for (const field of [
    CANARY,
    '+99199123456',
    'maria@example.test',
    'two words',
    '99199123456',
    '',
  ]) {
    const error = new InvalidInputError({ field });
    assert.equal(error.field, undefined, field);
    assert.equal('field' in toProblem(error, BASE).body, false, field);
  }
  assert.equal(new InvalidInputError({ field: 'address.postalCode' }).field, 'address.postalCode');
});

test('the cause and the policy basis are kept on the error and never serialised', () => {
  const denied = new PolicyDeniedError({ basis: CANARY, cause: new Error(CANARY) });
  assert.equal(denied.basis, CANARY);
  assert.ok(denied.cause instanceof Error);
  assert.equal(JSON.stringify(toProblem(denied, BASE)).includes(CANARY), false);
});

test('extensions are emitted, with every value key stripped at any depth and no standard member replaced', () => {
  const p = toProblem(new OutsideWindowError({ field: 'startsAt' }), BASE);
  assert.equal(JSON.stringify(p).includes(CANARY), false);
  assert.deepEqual(p.body, {
    tailMinutes: 60,
    requested: { startsAt: '2026-11-12T20:30:00Z' },
    windows: [{ weekday: 3 }],
    type: `${BASE}outside_window`,
    title: 'Outside window',
    status: 422,
    code: 'outside_window',
    field: 'startsAt',
    retryable: false,
  });
});

test('anything that is not a DomainError is a 500 internal_error carrying nothing from the thrown value', () => {
  for (const thrown of [
    new Error(CANARY),
    new TypeError(CANARY),
    CANARY,
    { value: CANARY },
    undefined,
  ]) {
    const p = toProblem(thrown, BASE);
    assert.deepEqual(p.body, INTERNAL_ERROR_BODY);
  }
});

// ── QA-F1: a subclass's code is refused unless it is lower-case snake_case ──
test('QA-F1: an input passed as a subclass code is refused at construction, and the refusal does not echo it', () => {
  let built: DomainError | undefined;
  let refusal: unknown;
  try {
    built = new CodeLeak(QA_CANARY);
  } catch (e) {
    refusal = e;
  }
  if (built !== undefined) {
    assert.fail(
      `CodeLeak was constructed, and the input reached code=${built.code} type=${String(toProblem(built, BASE).body.type)} message=${built.message}`,
    );
  }
  assert.ok(refusal instanceof TypeError, 'the refusal is a TypeError');
  assert.equal(refusal.message.includes(QA_CANARY), false, refusal.message);
  assert.equal(String(refusal.stack).includes(QA_CANARY), false);
});

test('a code that is not lower-case ASCII snake_case is refused, and one that is is accepted', () => {
  for (const code of [
    'Slot_taken',
    'SLOT',
    'slot-taken',
    'slot taken',
    'slot.taken',
    '_slot',
    '1slot',
    '',
    'slot_taken\n',
    'σλοτ',
    'slot_tаken',
    undefined as unknown as string,
  ]) {
    assert.throws(() => new CodeLeak(code), TypeError, JSON.stringify(code));
  }
  for (const code of ['slot_taken', 'a', 'x9_']) assert.equal(new CodeLeak(code).code, code);
});

test('QA-F1 backstop: an object that passes instanceof DomainError without running its constructor, with a non-snake_case code, gets the 500', () => {
  const forged: unknown = Object.create(NotFoundError.prototype, {
    code: { value: QA_CANARY },
    title: { value: 'Not found' },
    status: { value: 404 },
    retryable: { value: false },
  });
  assert.ok(forged instanceof NotFoundError, 'premise: the forged object passes instanceof');
  const p = toProblem(forged, BASE);
  assert.equal(JSON.stringify(p).includes(QA_CANARY), false, JSON.stringify(p.body));
  assert.equal(p.status, 500);
  assert.deepEqual(p.body, INTERNAL_ERROR_BODY);
});

// ── QR-R1 (OE-16): a code assigned after construction cannot take effect ──
test('QR-R1: QA LateCodeLeak, a redeclared code assigned a code-shaped value after super(), cannot be constructed', () => {
  refusedAtConstruction(() => new LateCodeLeak(SHAPED));
});

test('QR-R1: a code-shaped value assigned to the code after super() with no redeclaration cannot be constructed', () => {
  refusedAtConstruction(() => new LateAssignLeak(SHAPED));
});

test('QR-R1: a subclass that redeclares code as a class field with an initializer cannot be constructed', () => {
  refusedAtConstruction(() => new FieldCodeLeak());
});

test('QR-R1: e.code set on a shipped error throws in strict code, is ignored in sloppy code, and the error keeps its code', () => {
  const e = new StateTransitionInvalidError();
  const before = JSON.stringify(toProblem(e, BASE));
  let thrown: unknown;
  try {
    (e as { code: string }).code = SHAPED;
  } catch (x) {
    thrown = x;
  }
  assert.equal(e.code, 'state_transition_invalid', channels(e));
  const sloppy = new Function('e', 'v', 'e.code = v; return e.code;') as (
    e: unknown,
    v: string,
  ) => unknown;
  assert.equal(sloppy(e, SHAPED), 'state_transition_invalid', 'the sloppy assignment is ignored');
  assert.ok(thrown instanceof TypeError, 'the strict assignment throws');
  assert.equal(thrown.message.includes(SHAPED), false, thrown.message);
  assert.equal(JSON.stringify(toProblem(e, BASE)), before);
  assert.equal(e.message, 'state_transition_invalid');
  assert.equal(String(e.stack).includes(SHAPED), false);
});

test('QR-R1: Object.defineProperty cannot replace the code of a shipped error, and delete cannot remove it', () => {
  const e = new NotFoundError();
  let thrown: unknown;
  try {
    Object.defineProperty(e, 'code', { value: SHAPED });
  } catch (x) {
    thrown = x;
  }
  assert.equal(e.code, 'not_found', channels(e));
  assert.ok(thrown instanceof TypeError, 'defineProperty throws');
  assert.equal(thrown.message.includes(SHAPED), false, thrown.message);
  assert.equal(Reflect.defineProperty(e, 'code', { value: SHAPED }), false);
  assert.equal(Reflect.deleteProperty(e, 'code'), false);
  assert.deepEqual(toProblem(e, BASE).body, {
    type: `${BASE}not_found`,
    title: 'Not found',
    status: 404,
    code: 'not_found',
    retryable: false,
  });
  assert.equal(e.message, 'not_found');
  assert.equal(String(e.stack).includes(SHAPED), false);
});

test('QR-R1: a code accessor on a subclass prototype, with a setter or without, is shadowed by the constructed code', () => {
  for (const e of [new GetterCodeLeak(SHAPED), new GetterOnlyCodeLeak(SHAPED)]) {
    assert.equal(e.code, e.message, channels(e));
    assert.equal(JSON.stringify(toProblem(e, BASE)).includes(SHAPED), false, channels(e));
  }
});

test('LIMITATION: an object that never ran the constructor, carrying a code-shaped code, is emitted with that code', () => {
  const forged: unknown = Object.create(NotFoundError.prototype, {
    code: { value: SHAPED },
    title: { value: 'Not found' },
    status: { value: 404 },
    retryable: { value: false },
  });
  assert.deepEqual(toProblem(forged, BASE).body, {
    type: `${BASE}${SHAPED}`,
    title: 'Not found',
    status: 404,
    code: SHAPED,
    retryable: false,
  });
});

test('LIMITATION until T-022 closes the code enum: a code-shaped input is accepted and reaches code, type, message and stack', () => {
  const surname = 'papadopoulou';
  const e = new CodeLeak(surname);
  const p = toProblem(e, BASE);
  assert.deepEqual([p.body.code, p.body.type, e.message], [surname, `${BASE}${surname}`, surname]);
  assert.equal(String(e.stack).includes(surname), true);
});

test('LIMITATION: an input passed as a subclass title is emitted as the body title, and is not in message or stack', () => {
  const e = new TitleLeak(QA_CANARY);
  assert.equal(toProblem(e, BASE).body.title, QA_CANARY);
  assert.equal(e.message, 'title_leak');
  assert.equal(String(e.stack).includes(QA_CANARY), false);
});

// ── QA-F6 / QA-F7: the strip and the field check go by shape, not meaning ──
class ExtensionShapes extends DomainRuleViolationError {
  constructor() {
    super('extension_shapes', 'Extension shapes', {});
  }
  override problemExtensions(): ProblemExtensions {
    return {
      nested: { detail: CANARY, instance: CANARY },
      Value: CANARY,
      VALUE: CANARY,
      values: [CANARY],
      input: CANARY,
      deep: { rawValue: CANARY },
      valuе: CANARY,
      [CANARY]: true,
    };
  }
}

test('LIMITATION: the strip goes by exact key name, so these shapes are emitted with the input in them', () => {
  const p = toProblem(new ExtensionShapes(), BASE);
  assert.deepEqual(p.body, {
    nested: { detail: CANARY, instance: CANARY },
    Value: CANARY,
    VALUE: CANARY,
    values: [CANARY],
    input: CANARY,
    deep: { rawValue: CANARY },
    valuе: CANARY,
    [CANARY]: true,
    type: `${BASE}extension_shapes`,
    title: 'Extension shapes',
    status: 422,
    code: 'extension_shapes',
    retryable: false,
  });
});

test('LIMITATION: an identifier-shaped value passed as the field is kept and emitted', () => {
  for (const field of [
    'CY00000000000000000000000000',
    'K00000000',
    'XXX000',
    'Papadopoulou',
    'papadopoulou',
    'CERT0042CY',
  ]) {
    assert.equal(toProblem(new InvalidInputError({ field }), BASE).body.field, field);
  }
  for (const field of ['Παπαδοπούλου', 'Попова', '0K1', '+99199123456', 'x y']) {
    assert.equal('field' in toProblem(new InvalidInputError({ field }), BASE).body, false, field);
  }
});

test('typeBase must be an https URL ending in a slash', () => {
  for (const base of [
    'http://errors.example.test/',
    'https://errors.example.test',
    '',
    'errors.example.test/',
  ]) {
    assert.throws(() => toProblem(new NotFoundError(), base), TypeError, base);
  }
});
