/**
 * T-150 (OD-93, OD-97). A TYPE-ONLY import of the generated db/schema.ts, inside the root
 * typecheck program. Never executed. `import type` pulls db/schema.ts into the program exactly as
 * a value import does, so before T-150 this file alone made `pnpm -w typecheck` exit 2.
 * `scripts/negative-tests/schema-typecheck.sh` compiles it with the value importer removed.
 */
import type { account, appSession } from '../../../db/schema.ts';

export type AccountEmail = (typeof account.$inferSelect)['emailCi'];
export type SessionDigest = (typeof appSession.$inferSelect)['tokenHash'];

export const typedEmail: AccountEmail = 'parent@example.cy';
export const typedDigest: SessionDigest = Buffer.alloc(32);
