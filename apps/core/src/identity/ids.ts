/**
 * ULIDs for `account.id`, `account.pseudonym` and `app_session.id` (SD §DB-2: `char(26)`).
 *
 * The first 10 characters are 48 bits of millisecond time, and the last 16 are 80 random bits from
 * `node:crypto`, all Crockford base32 in upper case. Every value is passed through
 * `@kinvara/domain-types`' constructor, which refuses a malformed id before it can be stored.
 * No ordering within one millisecond is claimed.
 */
import { randomBytes } from 'node:crypto';
import {
  accountId,
  sessionId,
  ulid,
  type AccountId,
  type SessionId,
  type Ulid,
} from '@kinvara/domain-types';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(value: bigint, length: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD.charAt(Number(rest % 32n)) + out;
    rest /= 32n;
  }
  return out;
}

function newUlidText(): string {
  return (
    base32(BigInt(Date.now()), 10) + base32(BigInt(`0x${randomBytes(10).toString('hex')}`), 16)
  );
}

export function newAccountId(): AccountId {
  return accountId(newUlidText(), 'accountId');
}

export function newSessionId(): SessionId {
  return sessionId(newUlidText(), 'sessionId');
}

export function newPseudonym(): Ulid {
  return ulid(newUlidText(), 'pseudonym');
}
