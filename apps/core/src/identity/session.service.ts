/**
 * Sessions after they are issued (T-026): logout (SD §BE-4 line 1029) and resolution with the
 * sliding expiry (SD §BE-10 lines 1235–1236; SA §SEC-5 line 2209).
 *
 * A session is found by the SHA-256 of a well-formed `__Host-kv_session` value (`session-token.ts`);
 * the cookie value itself is never sent to the database or logged.
 *
 * LOGOUT revokes every live session the `Cookie` header names, server-side, at once ("Server-side
 * revocation is immediate", SD line 1236). A header naming no live session (none, malformed,
 * unknown, already revoked) changes nothing. Nothing here writes `revoked_at` to NULL, and a revoked
 * session's `revoked_at` is never moved (`account.repository.ts` › `revokeSessions`).
 *
 * RESOLVE is for routes that need the current session. No route calls it at T-026: it is published
 * for `T-027` and later tickets, and held by `test/login.inprocess.test.ts` only. It refuses a
 * header that names no, or more than one, distinct session value, and whatever `touchLiveSession`
 * refuses. That includes a session whose account status is not in `LOGIN_STATUSES`, checked AT
 * RESOLVE TIME: suspending an account revokes no row, and its sessions stop resolving (rework 1,
 * QR-A2).
 */
import { revokeSessions, touchLiveSession, type LiveSession } from './account.repository.ts';
import type { Database } from './database.ts';
import { LOGIN_STATUSES } from './login.service.ts';
import { digestSessionCookie, sessionCookieValues } from './session-token.ts';

export type CookieHeader = string | readonly string[] | undefined;

export class SessionService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Revokes every live session the header names. Returns how many were revoked. */
  async logout(cookieHeader: CookieHeader): Promise<number> {
    const digests = sessionCookieValues(cookieHeader).map(digestSessionCookie);
    if (digests.length === 0) return 0;
    return this.#db.withAppRw((tx) => revokeSessions(tx, digests, 'logout'));
  }

  /** The one live session the header names, slid; otherwise `undefined`. */
  async resolve(cookieHeader: CookieHeader): Promise<LiveSession | undefined> {
    const values = sessionCookieValues(cookieHeader);
    const [only] = values;
    if (values.length !== 1 || only === undefined) return undefined;
    return this.#db.withAppRw((tx) =>
      touchLiveSession(tx, digestSessionCookie(only), [...LOGIN_STATUSES]),
    );
  }
}
