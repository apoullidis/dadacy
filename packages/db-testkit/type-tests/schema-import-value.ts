/**
 * T-150 (OD-93, OD-97). A VALUE import of the generated db/schema.ts, inside the root typecheck
 * program. This file is never executed; it exists to be compiled by `pnpm -w typecheck`.
 *
 * Before T-150, importing db/schema.ts at all made `pnpm -w typecheck` exit 2 (TS6133 and two
 * TS2693). This file is the committed proof that it no longer does, and that the two columns
 * drizzle-kit cannot render (`account.email_ci citext`, `app_session.token_hash bytea`) carry real
 * types at an importer rather than accepting anything.
 *
 * Each `@ts-expect-error` line is a value the column must refuse. `pnpm -w typecheck` fails with
 * TS2578 if the line stops being an error, but a directive accepts ANY error on its line (T-022
 * § contract §7). The exact code and line are asserted by
 * `scripts/negative-tests/schema-typecheck.sh`, which compiles the same assignments with no
 * directive and requires TS2322 on each.
 */
import { account, appSession, localeRegistry } from '../../../db/schema.ts';

type AccountRow = typeof account.$inferSelect;
type AccountInsert = typeof account.$inferInsert;
type SessionRow = typeof appSession.$inferSelect;
type SessionInsert = typeof appSession.$inferInsert;

export const tables = [account, appSession, localeRegistry] as const;

// CONTROL — the mapped columns accept their driver types (TL-A7: pg 8.23.0 returns string, Buffer).
export const emailRead: AccountRow['emailCi'] = 'parent@example.cy';
export const emailAbsent: AccountRow['emailCi'] = null;
export const emailWrite: AccountInsert['emailCi'] = 'Parent@Example.CY';
export const digestRead: SessionRow['tokenHash'] = Buffer.alloc(32);
export const digestWrite: SessionInsert['tokenHash'] = Buffer.alloc(32);

// @ts-expect-error TS2322 citext column refuses a number (select type)
export const emailNumber: AccountRow['emailCi'] = 12345;
// @ts-expect-error TS2322 bytea column refuses a number
export const digestNumber: SessionRow['tokenHash'] = 12345;
// @ts-expect-error TS2322 bytea column refuses a hex string
export const digestHex: SessionInsert['tokenHash'] = 'deadbeef';
