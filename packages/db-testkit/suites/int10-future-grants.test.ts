/**
 * T-020 Evidence §5 — the guard refuses FUTURE grants, not just today's. Which of
 * §5's refusals this file carries, and which it does not (G6 among them), is the
 * port map in T-115 § Published contract §12.
 *
 * A grant is a fact about today. Fifteen tickets code against this schema and
 * none of their authors will have read SA §INT-10, so `0001` installs
 * `assert_answering_service_write_only()` on an event trigger — in schema
 * `kinvara_guard` since `0003` (T-143), which the harness applies (T-137). G1–G7 are
 * the seven ways someone reopens the hole; **G7 was a real hole found by
 * testing G6** — `PUBLIC` holds `EXECUTE` on every new function by default, so
 * a `SECURITY DEFINER` function is a read path created by a `CREATE` statement
 * with no `GRANT` written anywhere.
 *
 * The invoker-function control is not padding. Without it this file would pass
 * against a guard that refused every `CREATE FUNCTION`, and "the guard is a
 * scalpel, not a blanket" would be an assertion rather than a measurement.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ACCOUNT_EMAIL,
  acquireMigratedCluster,
  asVendor,
  installInt10Fixtures,
  type Cluster,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'int10-future-grants';
let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await installInt10Fixtures(db);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

interface Attempt {
  readonly id: string;
  readonly why: string;
  readonly sql: string;
  /** The DETAIL line the refusal must carry — what the guard actually SAW. */
  readonly detail: string;
}

const ATTEMPTS: readonly Attempt[] = [
  {
    id: 'G1',
    why: 'the direct grant',
    sql: 'GRANT SELECT ON public.account TO answering_service',
    detail: 'answering_service holds SELECT on public.account',
  },
  {
    id: 'G2',
    why: 'the blanket grant — the commonest way this happens by accident',
    sql: 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO answering_service',
    detail: 'holds SELECT on public.',
  },
  {
    id: 'G3',
    why: 'column-level, which has_table_privilege() alone cannot see',
    sql: 'GRANT SELECT (email_ci) ON public.account TO answering_service',
    detail: 'answering_service holds column privilege SELECT on public.account.email_ci',
  },
  {
    id: 'G4',
    why: 'the time bomb — a default privilege grants on a table three epics from now',
    sql: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO answering_service',
    detail:
      'a default privilege grants SELECT on table objects in schema public to answering_service',
  },
  {
    id: 'G5',
    why: 'via PUBLIC — this statement never names the role at all',
    sql: 'GRANT SELECT ON public.account TO PUBLIC',
    detail: 'answering_service holds SELECT on public.account',
  },
  // G6 — `GRANT EXECUTE ON FUNCTION public.peek() TO answering_service` — is NOT
  // carried. T-020 ran it while a definer function still existed; once G7 below
  // refuses the CREATE there is nothing to grant on, so reaching G6 would need
  // the guard disarmed first. Recorded in T-115's port map (rework 1); until
  // then this test's title said "G6/G7" and ran G7 alone.
  {
    id: 'G7',
    why: 'a SECURITY DEFINER function is a read channel, refused at CREATE with no GRANT written anywhere',
    sql: `CREATE FUNCTION public.peek() RETURNS SETOF public.account
            LANGUAGE sql SECURITY DEFINER AS 'SELECT * FROM public.account'`,
    detail: 'a definer function is a read channel',
  },
];

describe('SA §INT-10 — the guard refuses future grants', () => {
  for (const a of ATTEMPTS) {
    test(`${a.id} — ${a.why}`, async () => {
      const r = await db.psql({ commands: [a.sql] });
      assertRefused(a.id, r, { message: INT10_RAISE });
      assert.ok(
        r.output.includes(a.detail),
        `${a.id}: the refusal must carry the DETAIL naming what the guard saw — ${a.detail}\n${r.output}`,
      );
    });
  }

  test('the HINT tells the reader what to do instead of leaving them guessing', async () => {
    const r = await db.psql({ commands: ['GRANT SELECT ON public.account TO answering_service'] });
    assert.ok(
      r.output.includes('SA INT-10') && r.output.includes('two-approval review'),
      `the refusal must name SA §INT-10 and the two-approval route.\n${r.output}`,
    );
  });

  test('CONTROL — an ordinary INVOKER function is still permitted, and gives the vendor nothing', async () => {
    // If this test ever fails, the guard has become a blanket refusal of
    // CREATE FUNCTION and G6/G7 above stop meaning anything.
    assertPermitted(
      'CREATE FUNCTION (invoker)',
      await db.psql({
        commands: [
          `CREATE FUNCTION public.ordinary() RETURNS SETOF public.account
             LANGUAGE sql AS 'SELECT * FROM public.account'`,
        ],
      }),
    );
    const read = await db.psql(asVendor('SELECT * FROM public.ordinary()'));
    assertRefused('the vendor calling the invoker function', read, {
      message: 'permission denied for table account',
    });
    assert.ok(
      !read.output.includes(ACCOUNT_EMAIL),
      `the invoker function must not leak the row.\n${read.output}`,
    );
  });

  test('CONTROL — the permitted INT-10 grant is still accepted', async () => {
    // Re-granting what SA §INT-10 permits must not trip the guard. Without
    // this the suite could not distinguish "refuses the right things" from
    // "refuses everything".
    assertPermitted(
      'GRANT INSERT ON out_of_hours_report TO answering_service',
      await db.psql({
        commands: ['GRANT INSERT ON public.out_of_hours_report TO answering_service'],
      }),
    );
    assertPermitted(
      'the explicit assertion',
      await db.psql({ commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'] }),
    );
  });

  test('THE KNOWN GAP — GRANT ROLE succeeds, is a real read path, and the assertion catches it', async () => {
    // PostgreSQL refuses an event trigger on GRANT ROLE outright ("event
    // triggers are not supported for GRANT ROLE") because roles are
    // cluster-global. T-020 states this as a gap rather than hiding it; this
    // test is what stops the statement from decaying into folklore. All five
    // steps, in order.
    assertPermitted(
      '1. GRANT app_rw TO answering_service — accepted, nothing fires',
      await db.psql({ commands: ['GRANT app_rw TO answering_service'] }),
    );

    const leaked = await db.psql(asVendor('SELECT email_ci FROM public.account'));
    assertPermitted('2. and it is a real read path', leaked);
    assert.ok(
      leaked.output.includes(ACCOUNT_EMAIL),
      `2. the vendor principal must actually read the row — otherwise this gap is theoretical.\n${leaked.output}`,
    );

    assertRefused(
      '3. the assertion catches it, which is why it is also a reconciler query (T-033)',
      await db.psql({ commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'] }),
      { message: 'answering_service is a member of role app_rw' },
    );

    assertPermitted(
      '4. revoked',
      await db.psql({ commands: ['REVOKE app_rw FROM answering_service'] }),
    );
    assertPermitted(
      '4. the boundary is restored',
      await db.psql({ commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'] }),
    );

    assertRefused(
      '5. and the read path is closed again',
      await db.psql(asVendor('SELECT email_ci FROM public.account')),
      { message: 'permission denied for table account' },
    );
  });

  test('PREMISES ONLY — app_ddl is NOSUPERUSER and trg_int10_answering_service is enabled (disarming is not attempted here)', async () => {
    // Asserts two premises and nothing more: app_ddl's rolsuper is false, and the
    // event trigger is enabled ('O'). It does NOT show that app_ddl cannot disarm
    // the guard. On 0001 alone that claim was false (OD-73/OD-75 routes A4, A5).
    // The harness now applies every committed migration (T-137), so 0003 is
    // present and the guard's functions live in kinvara_guard (T-143); the
    // refusals of A4/A5 on that state (T-143 R1-3..R1-5) are not ported here —
    // carried to T-122.
    assert.equal(
      await db.value(`SELECT rolsuper::text FROM pg_roles WHERE rolname = 'app_ddl'`),
      'false',
    );
    assert.equal(
      await db.value(
        `SELECT evtenabled FROM pg_event_trigger WHERE evtname = 'trg_int10_answering_service'`,
      ),
      'O',
    );
  });
});
