/**
 * T-020 Evidence §4 — THE negative test. Which of §4's refusals this file
 * carries is the port map in T-115 § Published contract §12.
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
import {
  assertPermitted,
  assertRefused,
  INT10_RAISE,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
} from '../src/expect.ts';

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

/**
 * OD-242 (T-231): check (6) reads column-level INSERT. Until 0014 a grant of INSERT on some
 * columns of any table fired the event trigger and the guard returned clean, because check (5)
 * reads has_table_privilege(INSERT), which a column grant does not satisfy, and check (6) read
 * SELECT, UPDATE and REFERENCES only (qa-verification, T-194 QA2-3). Every case below is red on
 * 0013's guard and green on 0014's (T-231 evidence, RED-SUITE and the gate run).
 */
describe('OD-242 — a column-level INSERT grant to answering_service', () => {
  // Every relation check (6) reads, except the one permitted INSERT target.
  const RELATIONS_SQL = `
    SELECT format('%I.%I', n.nspname, c.relname) || '|' ||
           (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
       AND format('%s.%s', n.nspname, c.relname) <> 'public.out_of_hours_report'
     ORDER BY 1`;
  const ANY_COLUMN_INSERT_SQL = `
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
       AND format('%s.%s', n.nspname, c.relname) <> 'public.out_of_hours_report'
       AND has_any_column_privilege('answering_service', c.oid, 'INSERT')`;
  const QA_COLUMNS = 'id, phone_e164, code_hash, expires_at, created_ip_prefix';

  test('is REFUSED KV010 at the GRANT on every application relation, and none is left holding one', async () => {
    const rows = (await db.value(RELATIONS_SQL))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [rel = '', cols = ''] = l.split('|');
        assert.ok(rel !== '' && cols !== '', `unreadable catalogue row: ${l}`);
        return { rel, cols };
      });
    const names = rows.map((r) => r.rel);
    // Not vacuous: the relations QA used, 0005's, and a pgboss partitioned table are all read.
    for (const must of ['public.otp_challenge', 'public.account', 'pgboss.job']) {
      assert.ok(
        names.includes(must),
        `${must} is not among the relations read: ${names.join(', ')}`,
      );
    }
    for (const { rel, cols } of rows) {
      const r = await db.psql({
        commands: [`GRANT INSERT (${cols}) ON ${rel} TO answering_service`],
        verbose: true,
      });
      assertRefused(`GRANT INSERT (<every column>) ON ${rel}`, r, {
        message: INT10_RAISE,
        sqlstate: 'KV010',
      });
      assert.ok(
        r.output.includes(`holds column privilege INSERT on ${rel}.`),
        `${rel}: the refusal does not name the column INSERT it found.\n${r.output}`,
      );
    }
    assert.equal(await db.value(ANY_COLUMN_INSERT_SQL), '0');
  });

  test("QA's grant on otp_challenge is refused, and the vendor login's INSERT is refused 42501 with nothing landing", async () => {
    assertRefused(
      "QA2-3's GRANT",
      await db.psql({
        commands: [`GRANT INSERT (${QA_COLUMNS}) ON public.otp_challenge TO answering_service`],
        verbose: true,
      }),
      { message: INT10_RAISE, sqlstate: 'KV010' },
    );
    assertRefused(
      "QA2-3's INSERT, as the vendor login",
      await db.psql({
        ...asVendor(
          `INSERT INTO public.otp_challenge (${QA_COLUMNS})
             VALUES ('01J00000000000000000T231S1', '+35799000231', decode(repeat('ab',32),'hex'),
                     now() + interval '5 minutes', '10.0.0.0/24')`,
        ),
        verbose: true,
      }),
      {
        message: 'permission denied for table otp_challenge',
        sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE,
      },
    );
    assert.equal(await db.value(`SELECT count(*) FROM public.otp_challenge`), '0');
  });

  test('committed with the event trigger silenced, it is DETECTED by a direct call (the reconciler path)', async () => {
    // session_replication_role = replica stops an ENABLE'd (origin) event trigger from firing:
    // the one way to get a column grant past the preventive layer and ask the detective one.
    const r = await db.psql({
      commands: [
        'SET LOCAL session_replication_role = replica',
        'GRANT INSERT (phone_e164) ON public.otp_challenge TO answering_service',
        'SET LOCAL session_replication_role = origin',
        'SELECT kinvara_guard.assert_answering_service_write_only()',
      ],
      singleTransaction: true,
      verbose: true,
    });
    assertRefused('the direct call', r, { message: INT10_RAISE, sqlstate: 'KV010' });
    assert.ok(
      r.output.includes('holds column privilege INSERT on public.otp_challenge.phone_e164'),
      `the DETAIL does not name the column INSERT.\n${r.output}`,
    );
    assert.equal(
      await db.value(ANY_COLUMN_INSERT_SQL),
      '0',
      'the transaction must have rolled back',
    );
  });

  test('CONTROL — on out_of_hours_report a column INSERT is permitted, the guard is clean, and the vendor writes through it', async () => {
    const cols = 'id, provider_call_ref, severity, structured_report, caller_locale';
    await db.sql({
      commands: [
        'REVOKE INSERT ON public.out_of_hours_report FROM answering_service',
        `GRANT INSERT (${cols}) ON public.out_of_hours_report TO answering_service`,
        'SELECT kinvara_guard.assert_answering_service_write_only()',
      ],
    });
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service','public.out_of_hours_report','INSERT')::text || '/' ||
                has_any_column_privilege('answering_service','public.out_of_hours_report','INSERT')::text`,
      ),
      'false/true',
      'the control must hold a COLUMN grant only, or it tests check (5) instead',
    );
    assertPermitted(
      'the vendor INSERT through the column grant',
      await db.psql(
        asVendor(
          `INSERT INTO public.out_of_hours_report (${cols})
             VALUES ('01J00000000000000000T231C1','CALLREF-T231','low','{}','el')`,
        ),
      ),
    );
    await db.sql({
      commands: [
        `REVOKE INSERT (${cols}) ON public.out_of_hours_report FROM answering_service`,
        'GRANT INSERT ON public.out_of_hours_report TO answering_service',
        'SELECT kinvara_guard.assert_answering_service_write_only()',
      ],
    });
    assert.equal(
      await db.value(
        `SELECT count(*) FROM public.out_of_hours_report WHERE id = '01J00000000000000000T231C1'`,
      ),
      '1',
    );
  });

  test('CONTROL — a TABLE-level INSERT elsewhere is still check (5), reported once, with no column line added', async () => {
    const r = await db.psql({
      commands: ['GRANT INSERT ON public.account TO answering_service'],
      verbose: true,
    });
    assertRefused('GRANT INSERT ON account', r, { message: INT10_RAISE, sqlstate: 'KV010' });
    assert.ok(
      r.output.includes(
        'answering_service holds INSERT on public.account — the only permitted target is public.out_of_hours_report',
      ),
      `check (5)'s line is missing.\n${r.output}`,
    );
    assert.ok(
      !r.output.includes('column privilege INSERT'),
      `a column line was added to check (5)'s case.\n${r.output}`,
    );
  });
});

/**
 * OE-62 (T-231 rework 1, the ruling on OD-243): the vendor must not be able to delegate. Check (18)
 * refuses any privilege held WITH GRANT OPTION, the permitted INSERT on out_of_hours_report
 * included, and any non-superuser role holding ADMIN OPTION on answering_service. The grant-option
 * cases on per-database objects are refused at the GRANT; the two on shared catalogues (a database
 * grant, a role grant) fire no event trigger and are caught by a direct call. Each refusal case is
 * red with check (18) removed from 0014 (T-231 § Rework 1, RW-MUT).
 */
describe('OE-62 — no grant option and no ADMIN OPTION for the vendor', () => {
  const GO_SQL = `SELECT has_table_privilege('answering_service','public.out_of_hours_report','INSERT WITH GRANT OPTION')::text || '/' ||
                         has_column_privilege('answering_service','public.out_of_hours_report','id','INSERT WITH GRANT OPTION')::text`;

  test('CONTROL — the permitted INSERT on out_of_hours_report, with no grant option, is accepted and the guard is clean', async () => {
    await db.sql({
      commands: [
        'GRANT INSERT ON public.out_of_hours_report TO answering_service',
        'SELECT kinvara_guard.assert_answering_service_write_only()',
      ],
    });
    assert.equal(await db.value(GO_SQL), 'false/false');
  });

  test('INSERT ON out_of_hours_report WITH GRANT OPTION (table level) is REFUSED KV010 at the GRANT', async () => {
    const r = await db.psql({
      commands: [
        'GRANT INSERT ON public.out_of_hours_report TO answering_service WITH GRANT OPTION',
      ],
      verbose: true,
    });
    assertRefused('table-level grant option', r, { message: INT10_RAISE, sqlstate: 'KV010' });
    assert.ok(
      r.output.includes(
        'answering_service holds INSERT WITH GRANT OPTION on public.out_of_hours_report',
      ),
      `the DETAIL does not name the grant option.\n${r.output}`,
    );
    assert.equal(await db.value(GO_SQL), 'false/false', 'nothing may land');
  });

  test('INSERT (id) ON out_of_hours_report WITH GRANT OPTION (column level) is REFUSED KV010 at the GRANT', async () => {
    const r = await db.psql({
      commands: [
        'GRANT INSERT (id) ON public.out_of_hours_report TO answering_service WITH GRANT OPTION',
      ],
      verbose: true,
    });
    assertRefused('column-level grant option', r, { message: INT10_RAISE, sqlstate: 'KV010' });
    assert.ok(
      r.output.includes(
        'answering_service holds column privilege INSERT WITH GRANT OPTION on public.out_of_hours_report.id',
      ),
      `the DETAIL does not name the column grant option.\n${r.output}`,
    );
    assert.equal(await db.value(GO_SQL), 'false/false', 'nothing may land');
  });

  test('a grant option on a privilege 0001 gives it (USAGE on schema public) is REFUSED KV010 at the GRANT', async () => {
    const r = await db.psql({
      commands: ['GRANT USAGE ON SCHEMA public TO answering_service WITH GRANT OPTION'],
      verbose: true,
    });
    assertRefused('schema USAGE grant option', r, { message: INT10_RAISE, sqlstate: 'KV010' });
    assert.ok(
      r.output.includes('answering_service holds USAGE WITH GRANT OPTION on schema public'),
      `the DETAIL does not name the grant option.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_schema_privilege('answering_service','public','USAGE WITH GRANT OPTION')::text`,
      ),
      'false',
    );
  });

  test('CONNECT ON DATABASE WITH GRANT OPTION fires no trigger (shared catalogue) and is DETECTED by a direct call', async () => {
    const r = await db.psql({
      commands: [
        'GRANT CONNECT ON DATABASE kinvara TO answering_service WITH GRANT OPTION',
        'SELECT kinvara_guard.assert_answering_service_write_only()',
      ],
      singleTransaction: true,
      verbose: true,
    });
    assertRefused('the direct call', r, { message: INT10_RAISE, sqlstate: 'KV010' });
    assert.ok(
      r.output.includes('answering_service holds CONNECT WITH GRANT OPTION on database kinvara'),
      `the DETAIL does not name the grant option.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_database_privilege('answering_service','kinvara','CONNECT WITH GRANT OPTION')::text`,
      ),
      'false',
      'the transaction must have rolled back',
    );
  });

  test('ADMIN OPTION on answering_service fires no trigger (GRANT ROLE) and is DETECTED by a direct call', async () => {
    const r = await db.psql({
      commands: [
        'CREATE ROLE t231_admin_probe NOLOGIN',
        'GRANT answering_service TO t231_admin_probe WITH ADMIN OPTION',
        'SELECT kinvara_guard.assert_answering_service_write_only()',
      ],
      singleTransaction: true,
      verbose: true,
    });
    assertRefused('the direct call', r, { message: INT10_RAISE, sqlstate: 'KV010' });
    assert.ok(
      r.output.includes('role t231_admin_probe holds ADMIN OPTION on answering_service'),
      `the DETAIL does not name the ADMIN OPTION.\n${r.output}`,
    );
    assert.equal(
      await db.value(`SELECT count(*) FROM pg_roles WHERE rolname = 't231_admin_probe'`),
      '0',
      'the transaction must have rolled back',
    );
  });

  test('CONTROL — the guard is clean on the state this suite leaves', async () => {
    await db.sql({ commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'] });
  });
});
