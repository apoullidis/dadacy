/**
 * Account creation and lookup against migration `0005`'s tables (`T-140` § Published contract),
 * as Drizzle parameterised queries (SD §DB-1 line 1755; §SEC-I2 line 3893, "No dynamic SQL"). No
 * SQL text appears in this file. Every function takes the caller's transaction, which
 * `Database.withAppRw` opens as `app_rw`.
 *
 * THE TABLES are value imports from the generated `db/schema.ts` (T-150 § contract §5). A column
 * renamed there fails `pnpm -w typecheck` here.
 *
 * NOT IN ANY IMAGE ON `main` 59a7952 (decisions.md OD-118). The image does not carry `db/`, so this
 * import cannot load in the containerised `core` until that is fixed.
 *
 * THE EMAIL COMPARAND (decisions.md OD-98; T-140 TL-A8). `eq(account.emailCi, v)` sends an UNTYPED
 * parameter, which resolves to `citext`, so the comparison is case-insensitive and served by
 * `account_email_ci_key`. T-140's second approver measured this with pg 8.23.0 and drizzle-orm
 * 0.45.2 (TL-T D1). A `text`-typed comparand would compare case-sensitively. Held by
 * `test/identity.inprocess.test.ts` › *findAccountIdByEmail finds an address differing only in
 * case …*.
 *
 * There is no `delete` and no write to `revokedAt` anywhere in this file (`T-140` § contract §5;
 * TL-A1).
 */
import { eq } from 'drizzle-orm';
import { accountId, type AccountId, type SessionId, type Ulid } from '@kinvara/domain-types';
import { account, accountRole, appSession } from '../../../../db/schema.ts';
import type { Tx } from './database.ts';
import { assertSessionDigest } from './session-token.ts';

/** `T-140` § contract §2: the unique index a second registration of an address hits. */
export const ACCOUNT_EMAIL_UNIQUE = 'account_email_ci_key';

export interface NewAccount {
  readonly id: AccountId;
  readonly pseudonym: Ulid;
  readonly email: string;
  readonly passwordHash: string;
  readonly tosVersion: string;
}

export interface NewSession {
  readonly id: SessionId;
  readonly accountId: AccountId;
  readonly tokenHash: Buffer;
  readonly absoluteExpiresAt: Date;
}

/** `status`, `locale`, `jurisdiction` and the other columns take SD §DB-2's defaults. */
export async function insertAccount(tx: Tx, created: NewAccount): Promise<void> {
  await tx.insert(account).values({
    id: created.id,
    pseudonym: created.pseudonym,
    emailCi: created.email,
    passwordHash: created.passwordHash,
    tosVersion: created.tosVersion,
  });
}

export async function insertRole(
  tx: Tx,
  owner: AccountId,
  role: 'parent' | 'sitter',
): Promise<void> {
  await tx.insert(accountRole).values({ accountId: owner, role });
}

/** A password session. The token hash is checked to be a 32-byte digest before it is sent. */
export async function insertSession(tx: Tx, session: NewSession): Promise<void> {
  await tx.insert(appSession).values({
    id: session.id,
    tokenHash: assertSessionDigest(session.tokenHash),
    accountId: session.accountId,
    authMethod: 'password',
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
  });
}

/** For `T-026`'s login, and for T-141's OD-98 case. Case-insensitive through `citext`. */
export async function findAccountIdByEmail(tx: Tx, email: string): Promise<AccountId | undefined> {
  const rows = await tx.select({ id: account.id }).from(account).where(eq(account.emailCi, email));
  const found = rows[0]?.id;
  return found === undefined ? undefined : accountId(found, 'accountId');
}

/**
 * A PostgreSQL `23505` on exactly `constraint`, as thrown by `pg` or wrapped by Drizzle in an error
 * whose `cause` is `pg`'s. It reads `code`, `constraint` and `cause`, and nothing else.
 */
export function isUniqueViolation(thrown: unknown, constraint: string): boolean {
  try {
    let current: unknown = thrown;
    for (let depth = 0; depth < 3; depth++) {
      if (typeof current !== 'object' || current === null) return false;
      const fields = current as {
        readonly code?: unknown;
        readonly constraint?: unknown;
        readonly cause?: unknown;
      };
      if (fields.code === '23505' && fields.constraint === constraint) return true;
      current = fields.cause;
    }
    return false;
  } catch {
    return false;
  }
}
