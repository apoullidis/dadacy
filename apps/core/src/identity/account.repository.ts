/**
 * SQL for account creation and lookup against migration `0005`'s tables (`T-140` § Published
 * contract). Every function takes the caller's transaction, which `Database.withAppRw` opens as
 * `app_rw`.
 *
 * ROW TYPES come from `db/schema.ts` by `import type`, so a column renamed there fails
 * `pnpm -w typecheck` here: each row object `satisfies` its table's `$inferInsert`. It is a type
 * import, not a value import, because the runtime image does not carry `db/`: the `runtime` stage
 * of `docker/app.Dockerfile` copies only `apps/core`, `packages` and `node_modules`. A type import
 * is erased and loads nothing.
 *
 * THE EMAIL COMPARAND (decisions.md OD-98; T-140 TL-A8). Every `email_ci` value is sent as
 * `$n::citext`. A `text`-typed comparand compares case-sensitively, by sequential scan. Held by
 * `test/identity.inprocess.test.ts` › *findAccountIdByEmail finds an address differing only in
 * case …*.
 *
 * NO `DELETE`, and no write to `revoked_at`, anywhere in this file (`T-140` § contract §5; TL-A1).
 */
import { accountId, type AccountId, type SessionId, type Ulid } from '@kinvara/domain-types';
import type { account, accountRole, appSession } from '../../../../db/schema.ts';
import type { Tx } from './database.ts';
import { assertSessionDigest } from './session-token.ts';

type AccountInsert = (typeof account)['$inferInsert'];
type AccountRoleInsert = (typeof accountRole)['$inferInsert'];
type AppSessionInsert = (typeof appSession)['$inferInsert'];

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
  const row = {
    id: created.id,
    pseudonym: created.pseudonym,
    emailCi: created.email,
    passwordHash: created.passwordHash,
    tosVersion: created.tosVersion,
  } satisfies AccountInsert;
  await tx.query(
    'INSERT INTO public.account (id, pseudonym, email_ci, password_hash, tos_version) ' +
      'VALUES ($1, $2, $3::citext, $4, $5)',
    [row.id, row.pseudonym, row.emailCi, row.passwordHash, row.tosVersion],
  );
}

export async function insertRole(
  tx: Tx,
  owner: AccountId,
  role: 'parent' | 'sitter',
): Promise<void> {
  const row = { accountId: owner, role } satisfies AccountRoleInsert;
  await tx.query('INSERT INTO public.account_role (account_id, role) VALUES ($1, $2)', [
    row.accountId,
    row.role,
  ]);
}

/** A password session. The token hash is checked to be a 32-byte digest before it is sent. */
export async function insertSession(tx: Tx, session: NewSession): Promise<void> {
  const row = {
    id: session.id,
    tokenHash: assertSessionDigest(session.tokenHash),
    accountId: session.accountId,
    authMethod: 'password',
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
  } satisfies AppSessionInsert;
  await tx.query(
    'INSERT INTO public.app_session (id, token_hash, account_id, auth_method, absolute_expires_at) ' +
      'VALUES ($1, $2, $3, $4, $5)',
    [row.id, row.tokenHash, row.accountId, row.authMethod, row.absoluteExpiresAt],
  );
}

/** For `T-026`'s login and for T-141's OD-98 case. Case-insensitive through `citext`. */
export async function findAccountIdByEmail(tx: Tx, email: string): Promise<AccountId | undefined> {
  const result = await tx.query<{ id: string }>(
    'SELECT id FROM public.account WHERE email_ci = $1::citext',
    [email],
  );
  const found = result.rows[0]?.id;
  return found === undefined ? undefined : accountId(found, 'accountId');
}

/** A PostgreSQL `23505` on exactly `constraint`. Reads `code` and `constraint`, nothing else. */
export function isUniqueViolation(thrown: unknown, constraint: string): boolean {
  try {
    if (typeof thrown !== 'object' || thrown === null) return false;
    const fields = thrown as { readonly code?: unknown; readonly constraint?: unknown };
    return fields.code === '23505' && fields.constraint === constraint;
  } catch {
    return false;
  }
}
