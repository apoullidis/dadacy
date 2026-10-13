/**
 * E.3 U-11: every transaction that recomputes or replaces a sitter's availability (the materialiser,
 * `T-089.md` Q6, and the template replacement, Q2) first takes
 * `pg_advisory_xact_lock(AVAILABILITY_LOCK_NS, hashtext(sitterId))`. Transaction-scoped: it is
 * released at COMMIT or ROLLBACK, never by hand.
 *
 * `AVAILABILITY_LOCK_NS` is the one `int4` namespace for it, defined here and nowhere else. A
 * `hashtext` collision between two sitters only serialises them; it is never incorrect.
 * `app_rw`'s EXECUTE on `pg_advisory_xact_lock(integer, integer)` is `0022`'s (T-240).
 *
 * Not booking acceptance: SD 700 and 1379's "no advisory lock" govern acceptance, which this does
 * not touch (E.3 U-11). Held against the database by the worker suite's concurrency case, which
 * goes red (`23P01`) with this call deleted.
 */
import { sql } from 'drizzle-orm';
import type { Ulid } from '@kinvara/domain-types';
import type { Tx } from '../runtime/index.ts';

/** `0x41564C42`, ASCII "AVLB". */
export const AVAILABILITY_LOCK_NS = 1_096_174_658;

export async function lockSitterAvailability(tx: Tx, sitterId: Ulid): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${AVAILABILITY_LOCK_NS}::integer, hashtext(${sitterId}::text))`,
  );
}
