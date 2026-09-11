/**
 * The domain-error hierarchy — SD §DH-2: "Domain errors are typed classes
 * mapped to `problem+json` by a single exception filter." The mapping itself
 * is `toProblem` in problem.ts.
 *
 * Two properties are designed in, because SD §BE-2 and SA I-3 layers 5–6 make
 * an echoed input a certificate or child-data leak:
 *
 *   1. No constructor here takes a message. A concrete error's identity (code,
 *      status, title, retryable) is fixed by its class; the caller supplies only
 *      a `field` name and an optional `cause`. `Error.message` is the code, so a
 *      logged stack reads `NotFoundError: not_found` and never carries prose.
 *   2. `field` must be shaped like a property path (`startsAt`,
 *      `address.postalCode`). Anything else — a phone number, an email, text
 *      with spaces — is dropped to `undefined`, so a caller who passes the
 *      offending VALUE where the field NAME belongs does not leak it.
 *
 * `cause` is kept on the Error (ES2022) for server-side diagnosis and is never
 * emitted by `toProblem`. `PolicyDeniedError.basis` likewise: SD §BE-2 — "403
 * policy denial (with `basis` omitted from the body — never leak the policy
 * reason to an attacker, log it)".
 *
 * Codes: SD §BE-2 says `code` comes from "a single enum in `packages/contracts`".
 * That package does not exist yet (T-022). The codes below are the ones SD §BE-2
 * names (`state_transition_invalid`, `idempotency_key_reuse`) plus generic ones
 * for the status families it lists; T-022 owes the reconciliation.
 */

/** A JSON value an error may add to its problem body (SD §BE-15's extension members). */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ProblemExtensions = { readonly [key: string]: JsonValue };

export interface DomainErrorOptions {
  /** The NAME of the offending input (`startsAt`), never its value. */
  readonly field?: string;
  /** Kept for server-side logs; never serialised. */
  readonly cause?: unknown;
}

interface ErrorIdentity {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly retryable: boolean;
}

/** A property path: identifier segments joined by dots. See point 2 above. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

export abstract class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly retryable: boolean;
  readonly field: string | undefined;

  protected constructor(identity: ErrorIdentity, options: DomainErrorOptions) {
    super(identity.code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = identity.code;
    this.status = identity.status;
    this.title = identity.title;
    this.retryable = identity.retryable;
    this.field =
      options.field !== undefined && FIELD_NAME.test(options.field) ? options.field : undefined;
  }

  /**
   * Extra members for the problem body (SD §BE-15). Override to add them.
   * `toProblem` never lets these replace a standard member, and strips any
   * `value` key at any depth (SD §BE-2's backstop).
   */
  problemExtensions(): ProblemExtensions {
    return {};
  }
}

// ── 400 ────────────────────────────────────────────────────────────────────
/** Input that is malformed: the branded-type constructors in this package throw it. */
export class InvalidInputError extends DomainError {
  constructor(options: DomainErrorOptions = {}) {
    super(
      { code: 'invalid_input', status: 400, title: 'Invalid input', retryable: false },
      options,
    );
  }
}

// ── 401 / 403 / 404 ────────────────────────────────────────────────────────
export class UnauthenticatedError extends DomainError {
  constructor(options: DomainErrorOptions = {}) {
    super(
      { code: 'unauthenticated', status: 401, title: 'Unauthenticated', retryable: false },
      options,
    );
  }
}

export interface PolicyDeniedOptions extends DomainErrorOptions {
  /** The ReBAC policy basis (SA §TS-7). Logged by the caller; never in the body. */
  readonly basis: string;
}

export class PolicyDeniedError extends DomainError {
  readonly basis: string;
  constructor(options: PolicyDeniedOptions) {
    super({ code: 'policy_denied', status: 403, title: 'Forbidden', retryable: false }, options);
    this.basis = options.basis;
  }
}

/** SD §BE-2: "404 not found *or* not visible (identical response, deliberately)". */
export class NotFoundError extends DomainError {
  constructor(options: DomainErrorOptions = {}) {
    super({ code: 'not_found', status: 404, title: 'Not found', retryable: false }, options);
  }
}

// ── 409 ────────────────────────────────────────────────────────────────────
/** A 409. Modules subclass it with their own code (e.g. `slot_taken`). */
export abstract class ConflictError extends DomainError {
  protected constructor(code: string, title: string, options: DomainErrorOptions) {
    super({ code, status: 409, title, retryable: false }, options);
  }
}

/** SD §DB state machines: "An invalid transition is a 409 `state_transition_invalid`, never a silent no-op." */
export class StateTransitionInvalidError extends ConflictError {
  constructor(options: DomainErrorOptions = {}) {
    super('state_transition_invalid', 'State transition invalid', options);
  }
}

/** SD §BE-2: same Idempotency-Key, different request hash. */
export class IdempotencyKeyReuseError extends ConflictError {
  constructor(options: DomainErrorOptions = {}) {
    super('idempotency_key_reuse', 'Idempotency key reused', options);
  }
}

// ── 412 ────────────────────────────────────────────────────────────────────
export class PreconditionFailedError extends DomainError {
  constructor(options: DomainErrorOptions = {}) {
    super(
      { code: 'precondition_failed', status: 412, title: 'Precondition failed', retryable: false },
      options,
    );
  }
}

// ── 422 / 423 ──────────────────────────────────────────────────────────────
/** A 422 domain-rule violation. Modules subclass it (`rate_below_floor`, `outside_staffed_hours`). */
export abstract class DomainRuleViolationError extends DomainError {
  protected constructor(code: string, title: string, options: DomainErrorOptions) {
    super({ code, status: 422, title, retryable: false }, options);
  }
}

/** A 423. Modules subclass it (`sitter_review_hold`). */
export abstract class LockedError extends DomainError {
  protected constructor(code: string, title: string, options: DomainErrorOptions) {
    super({ code, status: 423, title, retryable: false }, options);
  }
}

// ── 429 / 503 ──────────────────────────────────────────────────────────────
export class RateLimitedError extends DomainError {
  constructor(options: DomainErrorOptions = {}) {
    super(
      { code: 'rate_limited', status: 429, title: 'Too many requests', retryable: true },
      options,
    );
  }
}

/** SD §BE-2: "502/503/504 upstream provider issues with `retryable: true`". */
export class UpstreamUnavailableError extends DomainError {
  constructor(options: DomainErrorOptions = {}) {
    super(
      {
        code: 'upstream_unavailable',
        status: 503,
        title: 'Upstream unavailable',
        retryable: true,
      },
      options,
    );
  }
}
