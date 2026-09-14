/**
 * The session credential.
 *
 * - SD line 1235: the `__Host-kv_session` cookie holds an "opaque 256-bit random id", `HttpOnly`,
 *   `Secure`, `SameSite=Lax`, with no path scoping, and a consumer session has a "30-day absolute"
 *   lifetime (also SA §SEC-5, line 2209).
 * - SD line 1811: `app_session.token_hash` is the "SHA-256 of the cookie value; the value is never
 *   stored".
 *
 * The cookie value goes to the client in `Set-Cookie` and nowhere else. It is never written to the
 * database and never logged.
 */
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE_NAME = '__Host-kv_session';

/** SD line 1235 / SA §SEC-5: 30-day absolute TTL for a consumer session. */
export const CONSUMER_ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60;

export const SESSION_DIGEST_BYTES = 32;

/** Fixed text: a refusal never carries the value it refused. */
export const DIGEST_REFUSED =
  'identity: an app_session token_hash must be a 32-byte SHA-256 digest, so it is not stored';

export interface SessionToken {
  /** 256 random bits, base64url: 43 characters. Sent in `Set-Cookie`; never stored or logged. */
  readonly cookieValue: string;
  /** SHA-256 of `cookieValue`'s UTF-8 bytes: what `app_session.token_hash` stores. */
  readonly tokenHash: Buffer;
}

export function digestSessionCookie(cookieValue: string): Buffer {
  return createHash('sha256').update(cookieValue, 'utf8').digest();
}

/**
 * `T-140` TL-A1: the database accepts a `token_hash` of any length (1, 43 and 32 bytes were
 * measured accepted). This check is what refuses anything that is not a 32-byte digest.
 */
export function assertSessionDigest(tokenHash: unknown): Buffer {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== SESSION_DIGEST_BYTES) {
    throw new TypeError(DIGEST_REFUSED);
  }
  return tokenHash;
}

export function newSessionToken(): SessionToken {
  const cookieValue = randomBytes(32).toString('base64url');
  return { cookieValue, tokenHash: assertSessionDigest(digestSessionCookie(cookieValue)) };
}

/** `__Host-` requires `Secure`, `Path=/` and no `Domain`. `Max-Age` is the 30-day absolute TTL. */
export function sessionSetCookie(token: SessionToken): string {
  return (
    `${SESSION_COOKIE_NAME}=${token.cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${String(CONSUMER_ABSOLUTE_TTL_SECONDS)}`
  );
}
