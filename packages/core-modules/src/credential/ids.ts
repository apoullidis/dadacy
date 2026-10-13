/**
 * `sitter_credential.id`: a ULID GENERATED HERE, ON THE SERVER, for every row Q-3 inserts (T-252
 * § Published contract — LIVE §4, the primary-key row, and §6: the primary key is an oracle, since
 * RLS does not hide uniqueness, so no id is ever taken from a client). 48 bits of time, 80 random
 * bits from `node:crypto`. Not monotonic within one millisecond: nothing orders credential rows by
 * id (Q-2 orders by `scheme_id`). Held by `repository.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { ulid, type Ulid } from '@kinvara/domain-types';

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

/** A fresh ULID for a `sitter_credential` row. `now` is injectable for tests only. */
export function newSitterCredentialId(now: () => number = Date.now): Ulid {
  const random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  return ulid(base32(BigInt(now()), 10) + base32(random, 16), 'id');
}
