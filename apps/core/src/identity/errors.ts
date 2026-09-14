/**
 * The identity module's domain errors (T-023 hierarchy; codes added to `ERROR_CODES` by T-141).
 * Codes and titles are literals. `field` names a request property and never carries its value.
 */
import {
  ConflictError,
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
