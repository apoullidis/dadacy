/**
 * Identifiers — SD §DH-2 (branded), SD §BE-2 ("IDs are ULIDs, never
 * emails/phones/postal codes/certificate references") and the SD §DB
 * conventions ("ULID primary keys stored as `char(26)`").
 *
 * Every entity id is a `Ulid` carrying a second tag, so an `AccountId` can go
 * where any `Ulid` is expected but never where a `BookingId` or `SessionId` is.
 *
 * The accepted form is the canonical ULID string: 26 characters of Crockford
 * base32, UPPER case only, first character 0–7 (a larger first character
 * overflows 128 bits). The ULID spec lets decoders accept lower case; this
 * does not, so the same id cannot be stored in two spellings.
 */
import type { Brand } from './brand.ts';
import { InvalidInputError } from './errors.ts';

export type Ulid = Brand<string, 'Ulid'>;
export type AccountId = Brand<Ulid, 'AccountId'>;
export type BookingId = Brand<Ulid, 'BookingId'>;
export type SessionId = Brand<Ulid, 'SessionId'>;

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: unknown): value is Ulid {
  return typeof value === 'string' && ULID.test(value);
}

/** `field` is the input's NAME, reported in the 400; the value never is. */
export function ulid(value: unknown, field: string): Ulid {
  if (!isUlid(value)) throw new InvalidInputError({ field });
  return value;
}

export function accountId(value: unknown, field: string): AccountId {
  return ulid(value, field) as AccountId;
}

export function bookingId(value: unknown, field: string): BookingId {
  return ulid(value, field) as BookingId;
}

export function sessionId(value: unknown, field: string): SessionId {
  return ulid(value, field) as SessionId;
}
