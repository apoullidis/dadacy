/**
 * Account creation: SD §BE-4 `POST /v1/auth/register`, as ruled by decisions.md OE-22.
 *
 * THE ORDER, and why:
 *   1. HIBP range check (SA §SEC-5, SD §INT-F). It runs first, so a breached password costs no
 *      argon2id run.
 *        - `breached` → `PasswordBreachedError` (422), and nothing is written.
 *        - `unavailable` → FAIL OPEN (OE-22 G2; SD line 3763): write one log line carrying the
 *          alert marker, then continue.
 *        - `clean` → continue.
 *   2. argon2id at SA §SEC-5's parameters (`password.ts`).
 *   3. One `app_rw` transaction: `account`, `account_role`, `app_session` (its token hash only).
 *      A `23505` on `account_email_ci_key` → `EmailInUseError` (409). OE-22 G1: this is NOT
 *      enumeration-resistant, and register adds no padding.
 *
 * THE FAIL-OPEN LOG LINE carries fixed text plus the verdict's `reason`: a kit-computed literal
 * (`kit_timeout`, `kit_circuit_open`, …) or `status_<n>`. It never carries the password, its SHA-1
 * or prefix, the email, or anything the upstream sent. Held by `test/identity.inprocess.test.ts`
 * (a sentinel password asserted ABSENT from every captured line). The alert ROUTE is `T-009`'s;
 * `alert=hibp_unavailable` is the marker it will match. No pager is wired here.
 */
import type { AccountId } from '@kinvara/domain-types';
import {
  ACCOUNT_EMAIL_UNIQUE,
  insertAccount,
  insertRole,
  insertSession,
  isUniqueViolation,
} from './account.repository.ts';
import type { Database, LogLine } from './database.ts';
import { EmailInUseError, PasswordBreachedError } from './errors.ts';
import type { HibpChecker, HibpVerdict } from './hibp.ts';
import { newAccountId, newPseudonym, newSessionId } from './ids.ts';
import { hashPassword } from './password.ts';
import {
  CONSUMER_ABSOLUTE_TTL_SECONDS,
  newSessionToken,
  type SessionToken,
} from './session-token.ts';

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly role: 'parent' | 'sitter';
  readonly tosVersion: string;
}

export interface Registered {
  readonly accountId: AccountId;
  /** Its `cookieValue` goes to `Set-Cookie` and nowhere else. */
  readonly session: SessionToken;
  /** What the breach check concluded: `clean`, or `unavailable` when this registration failed open. */
  readonly hibp: Exclude<HibpVerdict['kind'], 'breached'>;
}

export const REGISTER_LOG = Object.freeze({
  hibpUnavailable:
    'identity: HIBP unavailable on password set; accepted without the breach check ' +
    '(fail open, OE-22 G2) alert=hibp_unavailable',
});

const toStderr: LogLine = (line) => {
  process.stderr.write(`[core] ${line}\n`);
};

export class RegisterService {
  readonly #db: Database;
  readonly #hibp: HibpChecker;
  readonly #log: LogLine;

  constructor(db: Database, hibp: HibpChecker, log: LogLine = toStderr) {
    this.#db = db;
    this.#hibp = hibp;
    this.#log = log;
  }

  async register(input: RegisterInput): Promise<Registered> {
    const verdict = await this.#hibp.check(input.password);
    if (verdict.kind === 'breached') throw new PasswordBreachedError({ field: 'password' });
    if (verdict.kind === 'unavailable') {
      this.#log(`${REGISTER_LOG.hibpUnavailable} reason=${verdict.reason}`);
    }

    const passwordHash = await hashPassword(input.password);
    const id = newAccountId();
    const session = newSessionToken();
    const absoluteExpiresAt = new Date(Date.now() + CONSUMER_ABSOLUTE_TTL_SECONDS * 1000);

    try {
      await this.#db.withAppRw(async (tx) => {
        await insertAccount(tx, {
          id,
          pseudonym: newPseudonym(),
          email: input.email,
          passwordHash,
          tosVersion: input.tosVersion,
        });
        await insertRole(tx, id, input.role);
        await insertSession(tx, {
          id: newSessionId(),
          accountId: id,
          tokenHash: session.tokenHash,
          absoluteExpiresAt,
        });
      });
    } catch (thrown) {
      if (isUniqueViolation(thrown, ACCOUNT_EMAIL_UNIQUE)) {
        throw new EmailInUseError({ field: 'email' });
      }
      throw thrown;
    }
    return { accountId: id, session, hibp: verdict.kind };
  }
}
