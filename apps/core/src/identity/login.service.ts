/**
 * Password login: SD §BE-4 line 1021 `POST /v1/auth/login`, as ruled by decisions.md OE-22 G4/G5.
 *
 * ENUMERATION RESISTANCE (SD §SEC-I7 line 3976; SA §SEC-5 line 2210). Every refusal throws the same
 * `InvalidCredentialsError`, which takes no options, so its body has one form (errors.ts). Refused:
 *   - no account holds the address (an erased account's `email_ci` is NULL, SD line 1766, so it
 *     lands here as well);
 *   - the account's `password_hash` is NULL: a passwordless registration (T-141);
 *   - the stored hash is not the PHC form `hashPassword` writes (`isStoredPasswordHash`);
 *   - verifying the stored hash throws (rework 1, QR-A1: a hash of that form the library cannot use,
 *     e.g. a non-canonical base64 salt). The dummy is then verified instead, once;
 *   - the password does not verify;
 *   - the account's status is not in `LOGIN_STATUSES`. That set is a READING (decisions.md OD-130).
 *
 * THE MECHANISM (OE-22 G4/G5), which is this file's contract:
 *   1. EXACTLY ONE argon2id verify on every path, at the one call site in `#attempt`. With no
 *      verifiable stored hash, the submitted password is verified against `DUMMY_PASSWORD_HASH`,
 *      which has SA §SEC-5's parameters. The status is judged AFTER the verify, so a suspended
 *      account costs the same verify as any other.
 *   2. Every path, success included, returns or throws no sooner than `LOGIN_FLOOR_MS` after
 *      `login` was called: the floor is awaited in `finally`.
 * Held in-process by `test/login.inprocess.test.ts` (a counting verifier, and the elapsed time),
 * and against the containerised core by `test/login.container.test.ts` (byte-identical bodies,
 * every path ≥ 250 ms) plus a count of `VERIFY_LOG` lines in core's output (state/EP-2/T-026.md).
 * Wall-clock distribution is a measurement, never gated: when the verify and the session insert
 * take longer than the floor, the paths' times differ by what those cost.
 *
 * THE PASSWORD is verified exactly as sent: no trimming and no Unicode normalisation (T-141 LIVE §5,
 * QR-A3). Its shape is `LoginRequest`'s, the same rule register applies, checked by the controller.
 *
 * NEVER EMAIL PROOF. Nothing here reads `app_session.auth_method` or writes `email_verified_at`. A
 * passwordless registration's session carries `registration` and proves nothing about the address
 * (OE-28 (B), OD-127).
 *
 * THE SESSION on success mirrors register's (T-141 LIVE §3–§4): a new 256-bit cookie value, only its
 * SHA-256 in `app_session`, `auth_method = 'password'`. Its absolute TTL is SD line 1235's: 30 days,
 * or 8 hours when the account holds an unrevoked role other than `parent` or `sitter` (OD-131).
 */
import type { AccountId } from '@kinvara/domain-types';
import { activeRoles, findLoginCandidate, insertSession } from './account.repository.ts';
import type { Database } from './database.ts';
import { InvalidCredentialsError } from './errors.ts';
import { newSessionId } from './ids.ts';
import {
  DUMMY_PASSWORD_HASH,
  createPasswordVerifier,
  isStoredPasswordHash,
  type PasswordVerifier,
} from './password.ts';
import {
  ADMIN_ABSOLUTE_TTL_SECONDS,
  CONSUMER_ABSOLUTE_TTL_SECONDS,
  newSessionToken,
  type SessionToken,
} from './session-token.ts';

/** SD §SEC-I7 line 3976: "constant-time padding to a fixed 250 ms floor". */
export const LOGIN_FLOOR_MS = 250;

/** The account statuses that may log in. A READING, not a rule SD states (decisions.md OD-130). */
export const LOGIN_STATUSES: ReadonlySet<string> = new Set(['pending', 'active']);

/** Roles whose sessions take the consumer TTL (SD line 1235). Any other role is read as admin. */
const CONSUMER_ROLES: ReadonlySet<string> = new Set(['parent', 'sitter']);

export interface LoggedIn {
  readonly accountId: AccountId;
  readonly roles: readonly string[];
  /**
   * A READING (OD-131): always `true`. The new session's `step_up_until` is NULL, and a password is
   * not a step-up method (SD line 1028), so every step-up-gated action still needs one.
   */
  readonly stepUpRequired: boolean;
  /** Its `cookieValue` goes to `Set-Cookie` and nowhere else. */
  readonly session: SessionToken;
  /** The session's absolute TTL, which is also the cookie's `Max-Age`. */
  readonly maxAgeSeconds: number;
}

/** Waits until `floorMs` have passed since `startedAt`. Re-checks, so a timer firing early cannot shorten it. */
async function awaitFloor(startedAt: number, floorMs: number): Promise<void> {
  for (;;) {
    const left = floorMs - (performance.now() - startedAt);
    if (left <= 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.ceil(left));
    });
  }
}

export class LoginService {
  readonly #db: Database;
  readonly #verify: PasswordVerifier;

  constructor(db: Database, verify: PasswordVerifier = createPasswordVerifier()) {
    this.#db = db;
    this.#verify = verify;
  }

  async login(email: string, password: string): Promise<LoggedIn> {
    const startedAt = performance.now();
    try {
      return await this.#attempt(email, password);
    } finally {
      await awaitFloor(startedAt, LOGIN_FLOOR_MS);
    }
  }

  async #attempt(email: string, password: string): Promise<LoggedIn> {
    const candidate = await this.#db.withAppRw((tx) => findLoginCandidate(tx, email));
    const stored =
      candidate !== undefined && isStoredPasswordHash(candidate.passwordHash)
        ? candidate.passwordHash
        : undefined;
    let target = stored;
    let verified: boolean;
    try {
      verified = await this.#verify(target ?? DUMMY_PASSWORD_HASH, password);
    } catch (thrown) {
      // QR-A1: a stored hash of the admitted form that the library cannot use throws. QA measured
      // the non-canonical-salt case costing no argon2 work. It is treated like an absent hash: the
      // dummy is verified instead, once. A throw while verifying the dummy itself propagates.
      if (target === undefined) throw thrown;
      target = undefined;
      verified = await this.#verify(DUMMY_PASSWORD_HASH, password);
    }
    if (
      candidate === undefined ||
      target === undefined ||
      !verified ||
      !LOGIN_STATUSES.has(candidate.status)
    ) {
      throw new InvalidCredentialsError();
    }

    const owner = candidate.id;
    const session = newSessionToken();
    const { roles, maxAgeSeconds } = await this.#db.withAppRw(async (tx) => {
      const held = await activeRoles(tx, owner);
      const ttl = held.every((role) => CONSUMER_ROLES.has(role))
        ? CONSUMER_ABSOLUTE_TTL_SECONDS
        : ADMIN_ABSOLUTE_TTL_SECONDS;
      await insertSession(tx, {
        id: newSessionId(),
        accountId: owner,
        tokenHash: session.tokenHash,
        absoluteExpiresAt: new Date(Date.now() + ttl * 1000),
        authMethod: 'password',
      });
      return { roles: held, maxAgeSeconds: ttl };
    });
    return { accountId: owner, roles, stepUpRequired: true, session, maxAgeSeconds };
  }
}
