/**
 * Identity's contact read path (T-246): an account's email and phone, by `AccountId`.
 *
 * WHY IT IS HERE. A delivering handler resolves its recipient's contact itself — `NotifyJobBase`
 * carries `recipientAccountId`, never an address (SD §BE-14 lines 1504–1511, `T-147` § contract) —
 * and SA §SA-2 forbids reading `account` other than through identity. Those handlers run in
 * `apps/worker` (OE-30-34 X-4), so this read is code SD §BE-1 loads in more than one deployable,
 * and lives in `packages/core-modules/src/identity/` (EV-30; T-245 RW1-C §5 row 1).
 *
 * WHAT IT RETURNS: the stored `email_ci` and `phone_e164`, either of which may be NULL (a
 * passwordless account with no phone; an erased account's `email_ci` is NULL, SD line 1766). It
 * judges neither: whether an unverified or absent channel may be used is the caller's rule.
 *
 * IT IS NOT EVERY RECIPIENT (T-246 rework 1, QA-F1, OD-301). It is the recipient for a magic link
 * (the account's email) and for a step-up OTP to the account's own verified phone. It is NOT the
 * recipient of an OTP that verifies a first or changed phone: that number is the challenge's
 * `otp_challenge.phone_e164`, stored in clear; in T-027's design (O1/O4) `account.phone_e164` is
 * written by `/otp/verify`, after the code checks — until then NULL for a first phone and the OLD
 * number for a change.
 * Only the OTP code and the link token are digests (`code_hash`, `token_hash`). A read of a
 * challenge's phone, if the job payload does not carry it, is `T-198`'s, written in this directory
 * (BOARD T-198/T-200 addenda, 2026-10-09).
 *
 * AN ABSENT ID IS A NAMED REFUSAL: `AccountNotFoundError` (./errors.ts), never `undefined`, so a
 * caller cannot read "no such account" as "no contact". Held without a database by
 * `contact.test.ts`, and against the real `account` table in the containerised worker
 * (`apps/worker` test `(T-246)`).
 *
 * ONE PARAMETERISED SELECT, by primary key, inside the caller's `Database.withAppRw` (so as
 * `app_rw`, which holds SELECT on `account`: T-140 § contract). No SQL text is built from input.
 * The table is a value import from the generated `db/schema.ts` (T-150 § contract §5), the same
 * relative path `apps/core`'s repository uses; the runtime images carry that one file at
 * `/srv/kinvara/db/schema.ts` (app.Dockerfile, T-154).
 */
import { eq } from 'drizzle-orm';
import type { AccountId } from '@kinvara/domain-types';
import { account } from '../../../../db/schema.ts';
import type { Database, Tx } from '../runtime/index.ts';
import { AccountNotFoundError } from './errors.ts';

export interface AccountContact {
  readonly accountId: AccountId;
  /** `account.email_ci` as stored, or NULL. */
  readonly email: string | null;
  /** `account.phone_e164` as stored, or NULL. */
  readonly phoneE164: string | null;
}

interface ContactRow {
  readonly email: string | null;
  readonly phoneE164: string | null;
}

/**
 * The one row a primary-key read returns, or the named refusal. Pure, so the refusal is held
 * without a database (`contact.test.ts`).
 */
export function contactFromRows(id: AccountId, rows: readonly ContactRow[]): AccountContact {
  const row = rows[0];
  if (row === undefined) throw new AccountNotFoundError();
  return { accountId: id, email: row.email, phoneE164: row.phoneE164 };
}

/** Inside the caller's transaction. */
export async function findAccountContact(tx: Tx, id: AccountId): Promise<AccountContact> {
  const rows = await tx
    .select({ email: account.emailCi, phoneE164: account.phoneE164 })
    .from(account)
    .where(eq(account.id, id));
  return contactFromRows(id, rows);
}

/** The provider a handler injects (./identity.module.ts). One `withAppRw` per lookup. */
export class AccountContacts {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Rejects `AccountNotFoundError` when no `account` row has this id. */
  async contactOf(id: AccountId): Promise<AccountContact> {
    return this.#db.withAppRw((tx) => findAccountContact(tx, id));
  }
}
