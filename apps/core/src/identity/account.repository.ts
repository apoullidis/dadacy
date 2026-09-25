/**
 * Account creation, login lookup and session reads and writes against migration `0005`'s tables
 * (`T-140` § Published contract), as Drizzle parameterised queries (SD §DB-1 line 1755; §SEC-I2
 * line 3893, "No dynamic SQL"). No SQL text is built from input here. Every function takes the
 * caller's transaction, which `Database.withAppRw` opens as `app_rw`.
 *
 * THE TABLES are value imports from the generated `db/schema.ts` (T-150 § contract §5). A column
 * renamed there fails `pnpm -w typecheck` here.
 *
 * THE EMAIL COMPARAND (decisions.md OD-98; T-140 TL-A8). `eq(account.emailCi, v)` sends an UNTYPED
 * parameter, which resolves to `citext`, so the comparison is case-insensitive and served by
 * `account_email_ci_key`. T-140's second approver measured this with pg 8.23.0 and drizzle-orm
 * 0.45.2 (TL-T D1). A `text`-typed comparand would compare case-sensitively. Held by
 * `test/identity.inprocess.test.ts` › *findAccountIdByEmail finds an address differing only in
 * case …* and, for login, `test/login.inprocess.test.ts` › *the login lookup compares …*.
 *
 * `revoked_at` (T-140 § contract §5; TL-A1: `app_rw` could UPDATE it back to NULL and the database
 * would not refuse). There is no `delete` in this file. `revokedAt` is written in exactly one
 * place, `revokeSessions`, only as `now()`, and only on rows where it IS NULL, so a revoked session
 * is never moved and never revived through this module.
 */
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  accountId,
  sessionId,
  type AccountId,
  type SessionId,
  type Ulid,
} from '@kinvara/domain-types';
import { account, accountRole, appSession } from '../../../../db/schema.ts';
import type { Tx } from './database.ts';
import { IDLE_TIMEOUT_SECONDS, assertSessionDigest } from './session-token.ts';

/** `T-140` § contract §2: the unique index a second registration of an address hits. */
export const ACCOUNT_EMAIL_UNIQUE = 'account_email_ci_key';

export interface NewAccount {
  readonly id: AccountId;
  readonly pseudonym: Ulid;
  readonly email: string;
  /** NULL for a passwordless registration (SD §DB-2 line 1770; SA §CC-1). */
  readonly passwordHash: string | null;
  readonly tosVersion: string;
}

export interface NewSession {
  readonly id: SessionId;
  readonly accountId: AccountId;
  readonly tokenHash: Buffer;
  readonly absoluteExpiresAt: Date;
  readonly authMethod: 'password' | 'registration';
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

/** A session. The token hash is checked to be a 32-byte digest before it is sent. */
export async function insertSession(tx: Tx, session: NewSession): Promise<void> {
  await tx.insert(appSession).values({
    id: session.id,
    tokenHash: assertSessionDigest(session.tokenHash),
    accountId: session.accountId,
    authMethod: session.authMethod,
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
  });
}

/** For T-141's OD-98 case. Case-insensitive through `citext`. */
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

// ---- T-026: login and sessions ------------------------------------------------------------------

export interface LoginCandidate {
  readonly id: AccountId;
  /** As stored: NULL for a passwordless account, and not checked here. */
  readonly passwordHash: string | null;
  readonly status: string;
}

/** Login's lookup: the same untyped `citext` comparand as `findAccountIdByEmail` (OD-98). */
export async function findLoginCandidate(
  tx: Tx,
  email: string,
): Promise<LoginCandidate | undefined> {
  const rows = await tx
    .select({ id: account.id, passwordHash: account.passwordHash, status: account.status })
    .from(account)
    .where(eq(account.emailCi, email));
  const row = rows[0];
  if (row === undefined) return undefined;
  return { id: accountId(row.id, 'accountId'), passwordHash: row.passwordHash, status: row.status };
}

/** The account's roles whose `revoked_at` IS NULL, in code-point order. */
export async function activeRoles(tx: Tx, owner: AccountId): Promise<string[]> {
  const rows = await tx
    .select({ role: accountRole.role })
    .from(accountRole)
    .where(and(eq(accountRole.accountId, owner), isNull(accountRole.revokedAt)))
    .orderBy(asc(accountRole.role));
  return rows.map((row) => row.role);
}

/**
 * Logout: `revoked_at = now()` and `revoked_reason = reason` on every session whose digest is given
 * and whose `revoked_at` IS NULL. Returns how many rows changed. A revoked session matches nothing.
 */
export async function revokeSessions(
  tx: Tx,
  digests: readonly Buffer[],
  reason: 'logout',
): Promise<number> {
  if (digests.length === 0) return 0;
  const rows = await tx
    .update(appSession)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(
      and(
        inArray(appSession.tokenHash, digests.map(assertSessionDigest)),
        isNull(appSession.revokedAt),
      ),
    )
    .returning({ id: appSession.id });
  return rows.length;
}

export interface LiveSession {
  readonly id: SessionId;
  readonly accountId: AccountId;
  readonly authMethod: string;
  readonly stepUpUntil: string | null;
}

/**
 * Resolve a session by its digest and slide it (SD line 1235). The database clock decides, in one
 * statement. Refused, as `undefined`: no row; `revoked_at` set; `absolute_expires_at` not in the
 * future; `last_seen_at` 30 minutes old or older; the account's status not among `statuses` (rework 1,
 * QR-A2: read at resolve time, so a suspension ends a session at its next resolve without revoking
 * the row). A live session's `last_seen_at` becomes now.
 */
export async function touchLiveSession(
  tx: Tx,
  digest: Buffer,
  statuses: readonly string[],
): Promise<LiveSession | undefined> {
  if (statuses.length === 0) return undefined;
  const rows = await tx
    .update(appSession)
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(appSession.tokenHash, assertSessionDigest(digest)),
        isNull(appSession.revokedAt),
        gt(appSession.absoluteExpiresAt, sql`now()`),
        gt(appSession.lastSeenAt, sql`now() - make_interval(secs => ${IDLE_TIMEOUT_SECONDS})`),
        sql`EXISTS (SELECT 1 FROM public.account a WHERE a.id = app_session.account_id AND a.status::text IN (${sql.join(
          statuses.map((status) => sql`${status}`),
          sql`, `,
        )}))`,
      ),
    )
    .returning({
      id: appSession.id,
      accountId: appSession.accountId,
      authMethod: appSession.authMethod,
      stepUpUntil: appSession.stepUpUntil,
    });
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: sessionId(row.id, 'sessionId'),
    accountId: accountId(row.accountId, 'accountId'),
    authMethod: row.authMethod,
    stepUpUntil: row.stepUpUntil,
  };
}
