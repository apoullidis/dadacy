/**
 * COMPILE-TIME REFUSALS for the transactional enqueue — T-149 refusal (d), SD §BE-11 line 1313
 * ("No job is enqueued from an HTTP response handler after commit"). Never executed; compiled by
 * `pnpm -w typecheck` (in `gate:pr`), which fails with TS2578 if a line under a `@ts-expect-error`
 * directive stops being an error.
 *
 * THE BOUND (as T-022 § contract §7 and T-147's `jobs-refusals.ts`): a directive accepts ANY error
 * on its line. The codes named below were read off one real `tsc` run with the directives removed,
 * recorded in state/EP-2/T-149.md § Evidence; nothing re-checks them.
 *
 * Lines marked CONTROL must compile.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { defineJob, type JobEnqueuer, type JobSender } from '@kinvara/core-modules/jobs';
import type { Database, Tx } from '@kinvara/core-modules/runtime';

declare const q: JobEnqueuer;
declare const db: Database;
declare const tx: Tx;
declare const boss: PgBoss;
const J = defineJob('t149.types', z.strictObject({ n: z.number() }));
const p = { n: 1 };
const pooled = drizzle({ client: new pg.Pool() });

// No transaction handle at all: the API has no overload without one.
// @ts-expect-error TS2554 expected 3-4 arguments
void q.enqueue(J, p);

// `undefined` where the transaction belongs.
// @ts-expect-error TS2345 undefined is not assignable to Tx
void q.enqueue(undefined, J, p);

// A POOL-bound Drizzle handle is not a transaction: each statement would autocommit on its own
// connection. The brand on `Tx` is what refuses it.
// @ts-expect-error TS2379 the pool handle lacks the Tx brand (TS2345 under exactOptionalPropertyTypes)
void q.enqueue(pooled, J, p);

// The payload type is the schema's input: a wrong field type does not compile.
// @ts-expect-error TS2322 string is not assignable to number
void q.enqueue(tx, J, { n: 'one' });

// CONTROL: inside withAppRw, with the transaction it hands you.
void db.withAppRw(async (t) => await q.enqueue(t, J, p));

// CONTROL: a started `PgBoss` is a `JobSender` (the worker passes `BossHost`'s instance).
export const sender: JobSender = boss;
