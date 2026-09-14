/**
 * The identity module's domain errors (T-023 hierarchy; codes added to `ERROR_CODES` by T-141 and
 * T-026). Codes and titles are literals. `field` names a request property and never carries its
 * value.
 */
import {
  ConflictError,
  DomainError,
  DomainRuleViolationError,
  type DomainErrorOptions,
} from '@kinvara/domain-types';

/** SD §BE-4: registering an address already in use → 409. OE-22 G1: NOT enumeration-resistant. */
export class EmailInUseError extends ConflictError {
  constructor(options: DomainErrorOptions = {}) {
    super('email_in_use', 'Email in use', options);
  }
}

/** SD §BE-4: the HIBP range check found the password → 422. */
export class PasswordBreachedError extends DomainRuleViolationError {
  constructor(options: DomainErrorOptions = {}) {
    super('password_breached', 'Password breached', options);
  }
}

/**
 * SD §BE-4 line 1021: login's `401 invalid_credentials (uniform)`. SD §SEC-I7 line 3976 and SA
 * §SEC-5 line 2210: identical responses for existent and non-existent accounts (T-026).
 *
 * It TAKES NO OPTIONS: no `field` and no `cause`. So every refusal it answers serialises to one
 * body, whichever path threw it. T-023's abstract categories are 409, 422 and 423 only, so it
 * extends `DomainError` directly, with literals for every member.
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super(
      {
        code: 'invalid_credentials',
        status: 401,
        title: 'Invalid credentials',
        retryable: false,
      },
      {},
    );
  }
}
