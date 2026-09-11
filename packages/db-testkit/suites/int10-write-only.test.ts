/**
 * T-020 Evidence §4, ported — THE negative test.
 *
 * SD §INT-10 states the test itself: "An integration test asserts the denial by
 * connecting as `answering_service` and attempting `SELECT 1 FROM account` — a
 * grant document is not a test." Until this file existed the nine refusals had
 * been demonstrated exactly once, by hand, in a session that no longer exists
 * (`T-020` § Review, QA finding 9: "one-off runs, not a committed harness").
 *
 * Every statement below runs over a REAL CONNECTION as a login principal whose
 * only membership is `answering_service`. Not `SET ROLE` from a superuser
 * session: that keeps the session's authenticated identity and its
 * `rolbypassrls`, so it is a weaker claim about a different thing.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ACCOUNT_ID,
  acquireMigratedCluster,
  asVendor,
  VENDOR_CONN,
  installInt10Fixtures,
  type Cluster,
} from '../src/index.ts';
import { assertPermitted, assertRefused, SQLSTATE_INSUFFICIENT_PRIVILEGE } from '../src/expect.ts';

const SUITE = 'int10-write-only';
let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await installInt10Fixtures(db);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

describe('SA §INT-10 — the answering-service principal is write-only', () => {
  test('the principal is who it claims to be, and inherits only answering_service', async () => {
    const row = await db.value(
      `SELECT session_user || '|' || current_user || '|' ||
              pg_has_role(current_user,'answering_service','member')::int`,
      VENDOR_CONN,
    );
    assert.equal(row, 'answering_service_probe|answering_service_probe|1');
  });

  test('POSITIVE — the one thing it may do: INSERT into out_of_hours_report', async () => {
    assertPermitted(
      'the permitted INSERT',
      await db.psql(
        asVendor(
          `INSERT INTO public.out_of_hours_report
             VALUES ('01J000000000000000000000R1','CALLREF-8891','high',
                     '{"summary":"caller reports shouting"}','el', now())`,
        ),
      ),
    );
  });

  // The nine refusals, in T-020 Evidence §4's own order and numbering.
  const REFUSALS: readonly {
    readonly n: number;
    readonly why: string;
    readonly sql: string;
    readonly message: string;
  }[] = [
    {
      n: 1,
      why: 'SELECT on the very table it may write',
      sql: 'SELECT * FROM public.out_of_hours_report',
      message: 'permission denied for table out_of_hours_report',
    },
    {
      n: 2,
      why: "SD §INT-10's own stated test",
      sql: 'SELECT 1 FROM public.account',
      message: 'permission denied for table account',
    },
    {
      n: 3,
      why: 'RETURNING is a read — this is the first of the three ways a write-only role is usually still a read channel',
      sql: `INSERT INTO public.out_of_hours_report
              VALUES ('01J000000000000000000000R3','CALLREF-1','low','{}','el', now())
            RETURNING id`,
      message: 'permission denied for table out_of_hours_report',
    },
    {
      n: 4,
      why: 'INSERT … SELECT is refused at the READ, not at the write',
      sql: `INSERT INTO public.out_of_hours_report
              SELECT id, email_ci, 'low', '{}'::jsonb, locale, now() FROM public.account`,
      message: 'permission denied for table account',
    },
    {
      n: 5,
      why: 'UPDATE',
      sql: `UPDATE public.out_of_hours_report SET severity = 'low'`,
      message: 'permission denied for table out_of_hours_report',
    },
    {
      n: 5,
      why: 'DELETE',
      sql: 'DELETE FROM public.out_of_hours_report',
      message: 'permission denied for table out_of_hours_report',
    },
    {
      n: 6,
      why: 'ON CONFLICT DO UPDATE requires UPDATE',
      sql: `INSERT INTO public.out_of_hours_report
              VALUES ('01J000000000000000000000R1','CALLREF-2','low','{}','el', now())
            ON CONFLICT (id) DO UPDATE SET severity = 'low'`,
      message: 'permission denied for table out_of_hours_report',
    },
    {
      n: 7,
      why: 'a PostGIS relation PUBLIC used to be able to read',
      sql: 'SELECT * FROM public.spatial_ref_sys',
      message: 'permission denied for table spatial_ref_sys',
    },
    {
      n: 8,
      why: 'pg_stat_statements — statement shape, per-statement userid, call counts and timing',
      sql: 'SELECT query FROM public.pg_stat_statements',
      message: 'permission denied for view pg_stat_statements',
    },
    {
      n: 9,
      why: 'CREATE TABLE AS from a table it may not read',
      sql: 'CREATE TABLE public.escape_hatch AS SELECT * FROM public.account',
      message: 'permission denied for table account',
    },
  ];

  for (const r of REFUSALS) {
    test(`NEGATIVE ${String(r.n)} — ${r.why}`, async () => {
      assertRefused(`refusal ${String(r.n)}`, await db.psql(asVendor(r.sql)), {
        message: r.message,
      });
    });
  }

  test('the refusal carries SQLSTATE 42501, insufficient_privilege', async () => {
    assertRefused(
      'SELECT 1 FROM account, verbose',
      await db.psql({ ...asVendor('SELECT 1 FROM public.account'), verbose: true }),
      { message: 'permission denied for table account', sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE },
    );
  });

  test('and the row it could not read is really there — the refusal is not an empty table', async () => {
    // Without this, every refusal above would still pass against an `account`
    // that had no rows in it, and the suite would be asserting nothing.
    assert.equal(await db.value(`SELECT id FROM public.account`), ACCOUNT_ID);
    assert.equal(
      await db.value(`SELECT count(*) FROM public.out_of_hours_report`),
      '1',
      'the permitted INSERT must have landed — otherwise "write-only" is untested in the write direction',
    );
  });

  test('the guard agrees: zero relations are SELECT-able by the vendor principal', async () => {
    const reachable = await db.value(
      `SELECT count(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','v','m','f','p')
          AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND has_table_privilege('answering_service', c.oid, 'SELECT')`,
    );
    assert.equal(reachable, '0');
  });
});
