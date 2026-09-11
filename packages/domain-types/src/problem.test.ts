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

const BASE = 'https://errors.example.test/';
const CANARY = 'T023-CANARY-cert-CY-0042-99123456';

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
  for (const field of [CANARY, '+35799123456', 'maria@example.test', 'two words', '99123456', '']) {
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
    assert.deepEqual(p.body, {
      type: `${BASE}internal_error`,
      title: 'Internal error',
      status: 500,
      code: 'internal_error',
      retryable: false,
    });
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
