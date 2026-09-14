/**
 * The session credential.
 *
 * - SD line 1235: the `__Host-kv_session` cookie holds an "opaque 256-bit random id", `HttpOnly`,
 *   `Secure`, `SameSite=Lax`, with no path scoping. A consumer session is "30 min sliding,
 *   30-day absolute", an admin session "30 min idle, 8 h absolute" (also SA §SEC-5, line 2209).
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

/** SD line 1235 / SA §SEC-5: 8-hour absolute TTL for an admin session (T-026). */
export const ADMIN_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;

/** SD line 1235: "30 min sliding" (consumer) and "30 min idle" (admin), the same figure (T-026). */
export const IDLE_TIMEOUT_SECONDS = 30 * 60;

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

/**
 * `__Host-` requires `Secure`, `Path=/` and no `Domain`. `Max-Age` is the session's absolute TTL:
 * 30 days unless the caller passes the admin figure (T-026).
 */
export function sessionSetCookie(
  token: SessionToken,
  maxAgeSeconds: number = CONSUMER_ABSOLUTE_TTL_SECONDS,
): string {
  return (
    `${SESSION_COOKIE_NAME}=${token.cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${String(maxAgeSeconds)}`
  );
}

/** Logout (T-026): the same name and attributes, an empty value and `Max-Age=0`. */
export function sessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** What `newSessionToken` issues: 43 base64url characters. */
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Every well-formed `__Host-kv_session` value in a `Cookie` request header, distinct, in the order
 * sent (T-026). A pair whose name is not exactly `__Host-kv_session`, or whose value is not 43
 * base64url characters, is ignored. Nothing is decoded or logged.
 */
export function sessionCookieValues(header: string | readonly string[] | undefined): string[] {
  const text = typeof header === 'string' ? header : (header ?? []).join('; ');
  const values: string[] = [];
  for (const pair of text.split(';')) {
    const equals = pair.indexOf('=');
    if (equals === -1 || pair.slice(0, equals).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(equals + 1).trim();
    if (COOKIE_VALUE.test(value) && !values.includes(value)) values.push(value);
  }
  return values;
}
