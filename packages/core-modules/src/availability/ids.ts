/**
 * ULIDs for `availability_slot.id` (E.3 U-1: a fresh ULID per row, never stable across
 * regenerations), `availability_template.id` and `availability_exception.id`.
 *
 * MONOTONIC IN THIS PROCESS. The exception order is (`created_at`, `id`) (amended E.3 U-14,
 * OD-335), and two exceptions written in one transaction share `created_at` (`now()` is the
 * transaction's start). So `id` alone orders them, and it must order them in write order. A plain
 * ULID does not within one millisecond (80 random bits). Here, an id generated in the same
 * millisecond as the previous one (or with the clock behind it) takes the previous id's random
 * part plus one, so every id this process generates sorts after every earlier one. One
 * transaction runs in one process, so that is the order that matters. Held by `ids.test.ts`.
 * Overflow of the 80-bit part within one millisecond is refused (an `Error`), never wrapped.
 */
import { randomBytes } from 'node:crypto';
import { ulid, type Ulid } from '@kinvara/domain-types';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_MAX = (1n << 80n) - 1n;

function base32(value: bigint, length: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD.charAt(Number(rest % 32n)) + out;
    rest /= 32n;
  }
  return out;
}

let lastTime = -1;
let lastRandom = 0n;

/** A monotonic ULID; `now` is injectable for tests only. */
export function newAvailabilityId(now: () => number = Date.now): Ulid {
  let time = now();
  let random: bigint;
  if (time <= lastTime) {
    time = lastTime;
    random = lastRandom + 1n;
    if (random > RANDOM_MAX)
      throw new Error('availability ids: 80-bit counter exhausted in one ms');
  } else {
    random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  }
  lastTime = time;
  lastRandom = random;
  return ulid(base32(BigInt(time), 10) + base32(random, 16), 'id');
}
