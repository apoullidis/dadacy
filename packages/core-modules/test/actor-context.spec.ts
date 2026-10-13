/**
 * T-254's gate against a real Postgres: `scripts/svc up <ticket> db`, then
 * `scripts/svc run <ticket> -- pnpm db:migrate up`, then
 * `scripts/svc run <ticket> -- pnpm --filter @kinvara/core-modules test:integration`.
 *
 * WHAT IS UNDER TEST: `Database.withActor` (src/runtime/database.ts). Every transaction here runs
 * through the package's `Database` (`SET LOCAL ROLE app_rw` first), on a pool of ONE connection, so
 * "the next transaction on the same connection" is literal, and each such case asserts the backend
 * pid is the same.
 *
 * THE SCRATCH TABLE. `beforeAll` creates `public.t254_actor_scratch` as the `svc run` login (the
 * bootstrap superuser, OD-116), with ENABLE + FORCE ROW LEVEL SECURITY and three policies `TO
 * app_rw` in `T-252`'s shape (every GUC read through `NULLIF(current_setting(…, true), '')`): a
 * `sitter` sees and inserts its own rows, `system` (with a non-empty actor id) sees all, break-glass
 * (`'on'`) sees all. It is dropped in `afterAll`. It is NOT a product table and no migration creates
 * it; it exists so this suite does not depend on any table's policy (MR-2's, `T-252`).
 *
 * EXPECTED VALUES are written here (the actor's own inputs), and rows are seeded and counted by the
 * superuser pool with plain SQL, never through `withActor`.
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import {
  ActorRefusedError,
  bindSystemActor,
  Database,
  personActor,
  systemActor,
  type Actor,
  type Tx,
} from '@kinvara/core-modules/runtime';

const A = '01J9Z8Y7X6W5V4T3S2R1Q0P9NA';
const B = '01J9Z8Y7X6W5V4T3S2R1Q0P9NB';
const T = 'public.t254_actor_scratch';

function databaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (value === undefined || value === '') {
    throw new TypeError(
      'DATABASE_URL is not set: run under `scripts/svc run <ticket> --` on a project with `db` up',
    );
  }
  return value;
}

let su: Pool;
let db: Database;

beforeAll(async () => {
  su = new pg.Pool({ connectionString: databaseUrl(), application_name: 'kinvara-t254-su' });
  db = new Database(
    { connectionString: databaseUrl(), application_name: 'kinvara-t254-test', max: 1 },
    () => undefined,
  );
  await su.query(`DROP TABLE IF EXISTS ${T}`);
  await su.query(`CREATE TABLE ${T} (id serial PRIMARY KEY, owner_id char(26) NOT NULL)`);
  await su.query(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
  await su.query(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
  await su.query(`GRANT SELECT, INSERT ON ${T} TO app_rw`);
  await su.query(`GRANT USAGE ON SEQUENCE public.t254_actor_scratch_id_seq TO app_rw`);
  const role = `NULLIF(current_setting('app.actor_role', true), '')`;
  const id = `NULLIF(current_setting('app.actor_id', true), '')`;
  const bg = `NULLIF(current_setting('app.break_glass', true), '')`;
  await su.query(
    `CREATE POLICY t254_sitter_select ON ${T} FOR SELECT TO app_rw USING (${role} = 'sitter' AND owner_id = ${id})`,
  );
  await su.query(
    `CREATE POLICY t254_sitter_insert ON ${T} FOR INSERT TO app_rw WITH CHECK (${role} = 'sitter' AND owner_id = ${id})`,
  );
  await su.query(
    `CREATE POLICY t254_system_select ON ${T} FOR SELECT TO app_rw USING (${role} = 'system' AND ${id} IS NOT NULL)`,
  );
  await su.query(
    `CREATE POLICY t254_break_glass_select ON ${T} FOR SELECT TO app_rw USING (${bg} = 'on')`,
  );
  await su.query(`INSERT INTO ${T} (owner_id) VALUES ($1), ($2)`, [A, B]);
  const flags = await su.query<{ r: boolean; f: boolean; n: string }>(
    `SELECT c.relrowsecurity AS r, c.relforcerowsecurity AS f,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS n
       FROM pg_class c WHERE c.oid = $1::regclass`,
    [T],
  );
  assert.deepEqual(flags.rows, [{ r: true, f: true, n: '4' }], 'the scratch table is FORCE-RLS');
});

afterAll(async () => {
  await db.onApplicationShutdown();
  await su.query(`DROP TABLE IF EXISTS ${T}`);
  await su.end();
});

interface Gucs {
  pid: number;
  who: string;
  actor_id: string | null;
  actor_role: string | null;
  break_glass: string | null;
}

async function readGucs(tx: Tx): Promise<Gucs> {
  const r = await tx.execute<Record<string, unknown>>(
    sql`SELECT pg_backend_pid() AS pid, current_user::text AS who,
               current_setting('app.actor_id', true) AS actor_id,
               current_setting('app.actor_role', true) AS actor_role,
               current_setting('app.break_glass', true) AS break_glass`,
  );
  return r.rows[0] as unknown as Gucs;
}

async function owners(tx: Tx): Promise<string[]> {
  const r = await tx.execute<{ owner_id: string }>(
    sql.raw(`SELECT owner_id FROM ${T} ORDER BY owner_id`),
  );
  return r.rows.map((x) => x.owner_id);
}

test('with a person actor the three GUCs read back equal inside the transaction, as app_rw', async () => {
  const g = await db.withActor(personActor(A, 'sitter'), readGucs);
  assert.equal(g.who, 'app_rw');
  assert.deepEqual([g.actor_id, g.actor_role, g.break_glass], [A, 'sitter', 'off']);
});

test("with a system actor the GUCs read back (job, 'system', 'off'); with break-glass, 'on'", async () => {
  const g = await db.withActor(systemActor('credential.sweep'), readGucs);
  assert.deepEqual(
    [g.actor_id, g.actor_role, g.break_glass],
    ['credential.sweep', 'system', 'off'],
  );
  const h = await db.withActor(personActor(B, 'ts_operator'), readGucs, { breakGlass: true });
  assert.deepEqual([h.actor_id, h.actor_role, h.break_glass], [B, 'ts_operator', 'on']);
});

test("LEAK: the next transaction on the SAME connection does not see the actor: it reads '' (not NULL) after COMMIT and after ROLLBACK; a connection that never set them reads NULL", async () => {
  const fresh = new Database(
    { connectionString: databaseUrl(), application_name: 'kinvara-t254-fresh', max: 1 },
    () => undefined,
  );
  try {
    const never = await fresh.withAppRw(readGucs);
    assert.deepEqual([never.actor_id, never.actor_role, never.break_glass], [null, null, null]);
    const inside = await fresh.withActor(personActor(A, 'sitter'), readGucs, { breakGlass: true });
    const after = await fresh.withAppRw(readGucs);
    assert.equal(after.pid, inside.pid, 'same backend: the pool has one connection');
    assert.deepEqual([after.actor_id, after.actor_role, after.break_glass], ['', '', '']);
    class Rollback extends Error {}
    let rolledPid = -1;
    await assert.rejects(
      fresh.withActor(systemActor('credential.sweep'), async (tx) => {
        rolledPid = (await readGucs(tx)).pid;
        throw new Rollback();
      }),
      Rollback,
    );
    const afterRollback = await fresh.withAppRw(readGucs);
    assert.equal(afterRollback.pid, rolledPid);
    assert.deepEqual(
      [afterRollback.actor_id, afterRollback.actor_role, afterRollback.break_glass],
      ['', '', ''],
    );
    console.log(
      `MEASURED T-254: never-set connection reads ${JSON.stringify([never.actor_id, never.actor_role, never.break_glass])}; ` +
        `the next transaction on pid ${String(after.pid)} after COMMIT reads ${JSON.stringify([after.actor_id, after.actor_role, after.break_glass])}; ` +
        `after ROLLBACK reads ${JSON.stringify([afterRollback.actor_id, afterRollback.actor_role, afterRollback.break_glass])}`,
    );
  } finally {
    await fresh.onApplicationShutdown();
  }
});

test('SCRATCH RLS: with no actor (withAppRw) the FORCE-RLS table returns 0 rows and an INSERT is refused 42501', async () => {
  assert.deepEqual(await db.withAppRw(owners), []);
  await assert.rejects(
    db.withAppRw(async (tx) => tx.execute(sql.raw(`INSERT INTO ${T} (owner_id) VALUES ('${A}')`))),
    (e: unknown) =>
      (e as { cause?: { code?: string }; code?: string }).cause?.code === '42501' ||
      (e as { code?: string }).code === '42501',
  );
});

test('SCRATCH RLS: a sitter sees only their own row; another role sees none; system sees all; break-glass sees all', async () => {
  const total = await su.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${T}`);
  assert.equal(total.rows[0]?.n, '2', 'two rows seeded (superuser count)');
  assert.deepEqual(await db.withActor(personActor(A, 'sitter'), owners), [A]);
  assert.deepEqual(await db.withActor(personActor(B, 'sitter'), owners), [B]);
  assert.deepEqual(await db.withActor(personActor(A, 'parent'), owners), []);
  assert.deepEqual(await db.withActor(systemActor('credential.sweep'), owners), [A, B]);
  assert.deepEqual(await db.withActor(personActor(A, 'parent'), owners, { breakGlass: true }), [
    A,
    B,
  ]);
});

test('SCRATCH RLS LEAK: after a system actor saw every row, the next transaction on the same connection with no actor sees 0 rows', async () => {
  const pid = async (tx: Tx): Promise<number> => (await readGucs(tx)).pid;
  const p1 = await db.withActor(systemActor('credential.sweep'), async (tx) => {
    assert.deepEqual(await owners(tx), [A, B]);
    return pid(tx);
  });
  const [p2, rows] = await db.withAppRw(async (tx) => [await pid(tx), await owners(tx)] as const);
  assert.equal(p2, p1, 'same backend');
  assert.deepEqual(rows, []);
});

test("the worker's binding: bindSystemActor(db, queue).withActor runs as the system actor named after the queue", async () => {
  const bound = bindSystemActor(db, 'search.slot_materialise');
  const g = await bound.withActor(readGucs);
  assert.deepEqual(
    [g.actor_id, g.actor_role, g.break_glass],
    ['search.slot_materialise', 'system', 'off'],
  );
  assert.deepEqual(await bound.withActor(owners), [A, B]);
});

test('REFUSED BEFORE SQL against the database: an empty actor_id and a role outside the set reject ActorRefusedError, work never runs, and the scratch table is unchanged', async () => {
  let ran = 0;
  const forged = [
    [{ kind: 'person', accountId: '', role: 'sitter' }, 'account_id'],
    [{ kind: 'person', accountId: null, role: 'sitter' }, 'account_id'],
    [{ kind: 'person', accountId: A, role: 'system' }, 'role'],
    [{ kind: 'person', accountId: A, role: 'deputy_dsl' }, 'role'],
    [{ kind: 'system', job: '' }, 'job_identity'],
  ] as const;
  for (const [actor, reason] of forged) {
    await assert.rejects(
      db.withActor(actor as unknown as Actor, async (tx) => {
        ran += 1;
        await tx.execute(sql.raw(`INSERT INTO ${T} (owner_id) VALUES ('${A}')`));
      }),
      (e: unknown) => e instanceof ActorRefusedError && e.reason === reason,
    );
  }
  assert.throws(() => personActor('', 'sitter'), ActorRefusedError);
  assert.throws(() => personActor(A, 'admin'), ActorRefusedError);
  assert.equal(ran, 0);
  const total = await su.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${T}`);
  assert.equal(total.rows[0]?.n, '2');
});

test('NOT HELD (CUT-T-060 R-2.5): code holding the Tx can set the GUCs itself, break-glass included, and then sees every row', async () => {
  const rows = await db.withActor(personActor(A, 'parent'), async (tx) => {
    assert.deepEqual(await owners(tx), []);
    await tx.execute(sql`SELECT set_config('app.break_glass', 'on', true)`);
    return owners(tx);
  });
  assert.deepEqual(rows, [A, B]);
});
