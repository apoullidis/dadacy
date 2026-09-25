/**
 * T-140 — the identity schema (migration 0005): `account`, `account_role` with the
 * `sod_finance_ts` separation-of-duties index, `app_session`, and the `citext`
 * extension, per SD §DB-2 lines 1759–1821. These are the database-layer refusals the
 * T-140 row lists.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line
 * AND the `CONSTRAINT NAME:` field, so a crash, a connection failure or a refusal for
 * another reason cannot read as this one (T-115 § contract TL2-F4). Each constraint
 * refusal has a CONTROL beside it: the same statement with the violating value changed
 * is accepted, so the named constraint is what refused it.
 *
 * Privilege refusals run over REAL LOGIN principals, each a member of exactly one role,
 * never `SET ROLE` from a superuser session (T-020 Evidence §4).
 *
 * The tests share one cluster in file order. The fixtures (account A, its session S1)
 * are written in `beforeAll`. Every control that writes runs inside BEGIN … ROLLBACK,
 * and every refused multi-statement write runs inside BEGIN, so psql stopping on the
 * error leaves nothing behind.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  PROBE_PASSWORD,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'identity-schema';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't140_app_rw_probe',
  app_admin_rw: 't140_app_admin_rw_probe',
  app_safety_rw: 't140_app_safety_rw_probe',
  answering_service: 't140_answering_service_probe',
} as const;

/** Fixture ids, each exactly `char(26)` wide. */
const ACCOUNT_A = '01K4T140ACCOUNT0000000000A';
const ACCOUNT_B = '01K4T140ACCOUNT0000000000B';
const PSEUDONYM_A = '01K4T140PSEUDONYM00000000A';
const PSEUDONYM_B = '01K4T140PSEUDONYM00000000B';
const SESSION_1 = '01K4T140SESSION00000000001';
const SESSION_2 = '01K4T140SESSION00000000002';
for (const id of [ACCOUNT_A, ACCOUNT_B, PSEUDONYM_A, PSEUDONYM_B, SESSION_1, SESSION_2]) {
  assert.equal(id.length, 26, `fixture id ${id} is not char(26) wide`);
}
const TOKEN_1 = `sha256('t140-cookie-1'::bytea)`;
const TOKEN_2 = `sha256('t140-cookie-2'::bytea)`;

/** An account row naming only what has no default. */
const insertAccount = (id: string, pseudonym: string, extra = ''): string =>
  `INSERT INTO public.account (id, pseudonym, tos_version${extra === '' ? '' : ', ' + extra.split('=')[0]})
     VALUES ('${id}', '${pseudonym}', 't140-tos-1'${extra === '' ? '' : ', ' + extra.split('=').slice(1).join('=')})`;

const insertSession = (id: string, account: string, token: string, method = 'password'): string =>
  `INSERT INTO public.app_session (id, token_hash, account_id, auth_method, absolute_expires_at)
     VALUES ('${id}', ${token}, '${account}', '${method}', now() + interval '30 days')`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      insertAccount(ACCOUNT_A, PSEUDONYM_A, `email_ci='Parent@Example.CY'`),
      insertSession(SESSION_1, ACCOUNT_A, TOKEN_1),
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** Statements as the bootstrap superuser, SQLSTATE in the message, stopping at the first error. */
function asSuperuser(...commands: string[]): Promise<PsqlResult> {
  return db.psql({ commands, verbose: true, stopOnError: true });
}

/** Statements over a real login, SQLSTATE in the message, stopping at the first error. */
function asLogin(login: string, ...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands,
    verbose: true,
    stopOnError: true,
  });
}

/** Refused with exactly this ERROR line, and psql named the constraint that refused it. */
function assertRefusedBy(what: string, r: PsqlResult, errorLine: string, constraint: string): void {
  assertRefused(what, r, { message: errorLine });
  const field = `CONSTRAINT NAME:  ${constraint}`;
  assert.ok(
    r.output.includes(field),
    `${what}: expected ${JSON.stringify(field)} in the output.\n${r.output}`,
  );
}

describe('0005 — the tables, their owner and SD §DB-2 defaults', () => {
  test('the three tables and the enum are owned by app_ddl, and email_ci is citext', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(relname || ':' || pg_get_userbyid(relowner), ',' ORDER BY relname)
                   FROM pg_class
                  WHERE oid IN ('public.account'::regclass, 'public.account_role'::regclass,
                                'public.app_session'::regclass))
                || '|' || (SELECT pg_get_userbyid(typowner) FROM pg_type
                            WHERE oid = 'public.account_status'::regtype)
                || '|' || (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
                            WHERE attrelid = 'public.account'::regclass AND attname = 'email_ci')`,
      ),
      'account:app_ddl,account_role:app_ddl,app_session:app_ddl|app_ddl|citext',
    );
  });

  test('CONTROL — an account naming only id, pseudonym and tos_version is accepted and takes SD defaults, locale en included', async () => {
    const r = await db.psql({
      raw: true,
      commands: [
        'BEGIN',
        insertAccount(ACCOUNT_B, PSEUDONYM_B),
        `SELECT 'defaults=' || locale || '|' || locale_source || '|' || status || '|' ||
                grammatical_reference || '|' || dob_verified_18 || '|' || jurisdiction || '|' ||
                data_region FROM public.account WHERE id = '${ACCOUNT_B}'`,
        'ROLLBACK',
      ],
    });
    assertPermitted('insert an account with every default', r);
    assert.ok(
      r.stdout.includes('defaults=en|inferred|pending|other|false|CY|eu-central-1'),
      `defaults not applied as SD §DB-2 writes them:\n${r.output}`,
    );
  });
});

describe('0005 — constraint refusals (as the superuser, so no privilege is what refuses them)', () => {
  test("status 'active' without dob_verified_18 is REFUSED by account_min_age_verified (23514)", async () => {
    assertRefusedBy(
      'active, dob_verified_18 false',
      await asSuperuser(`UPDATE public.account SET status = 'active' WHERE id = '${ACCOUNT_A}'`),
      'ERROR:  23514: new row for relation "account" violates check constraint "account_min_age_verified"',
      'account_min_age_verified',
    );
  });

  test("CONTROL — status 'active' WITH dob_verified_18 true is accepted", async () => {
    assertPermitted(
      'active, dob_verified_18 true',
      await asSuperuser(
        'BEGIN',
        `UPDATE public.account SET status = 'active', dob_verified_18 = true WHERE id = '${ACCOUNT_A}'`,
        'ROLLBACK',
      ),
    );
  });

  for (const locale of ['tr', 'EN', 'en-GB']) {
    test(`locale '${locale}', which locale_registry does not hold, is REFUSED by account_locale_fkey (23503)`, async () => {
      assertRefusedBy(
        `locale ${locale}`,
        await asSuperuser(insertAccount(ACCOUNT_B, PSEUDONYM_B, `locale='${locale}'`)),
        'ERROR:  23503: insert or update on table "account" violates foreign key constraint "account_locale_fkey"',
        'account_locale_fkey',
      );
    });
  }

  test("CONTROL — locale 'el', which locale_registry holds, is accepted", async () => {
    assertPermitted(
      "locale 'el'",
      await asSuperuser('BEGIN', insertAccount(ACCOUNT_B, PSEUDONYM_B, `locale='el'`), 'ROLLBACK'),
    );
  });

  test('account_locale_fkey is NO ACTION on update and delete, on a plain deterministic text column', async () => {
    assert.equal(
      await db.value(
        `SELECT c.confupdtype::text || c.confdeltype::text || '|' ||
                (SELECT co.collname || ':' || co.collisdeterministic
                   FROM pg_attribute a JOIN pg_collation co ON co.oid = a.attcollation
                  WHERE a.attrelid = 'public.account'::regclass AND a.attname = 'locale') || '|' ||
                (SELECT count(*) FROM pg_constraint
                  WHERE contype = 'f' AND confrelid = 'public.locale_registry'::regclass)
           FROM pg_constraint c WHERE c.conname = 'account_locale_fkey'`,
      ),
      'aa|default:true|1',
    );
  });

  test("renaming or deleting the referenced locale 'en' is REFUSED by account_locale_fkey (23503), not cascaded", async () => {
    const line =
      'ERROR:  23503: update or delete on table "locale_registry" violates foreign key constraint "account_locale_fkey" on table "account"';
    assertRefusedBy(
      "UPDATE code 'en' -> 'en-GB'",
      await asSuperuser(`UPDATE public.locale_registry SET code = 'en-GB' WHERE code = 'en'`),
      line,
      'account_locale_fkey',
    );
    assertRefusedBy(
      "DELETE code 'en'",
      await asSuperuser(`DELETE FROM public.locale_registry WHERE code = 'en'`),
      line,
      'account_locale_fkey',
    );
    assert.equal(
      await db.value(`SELECT locale FROM public.account WHERE id = '${ACCOUNT_A}'`),
      'en',
    );
  });

  test('finance and ts_operator on one account is REFUSED by sod_finance_ts (23505)', async () => {
    assertRefusedBy(
      'finance + ts_operator',
      await asSuperuser(
        'BEGIN',
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACCOUNT_A}', 'finance')`,
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACCOUNT_A}', 'ts_operator')`,
      ),
      'ERROR:  23505: duplicate key value violates unique constraint "sod_finance_ts"',
      'sod_finance_ts',
    );
  });

  test('CONTROL — finance with parent is accepted, and ts_operator is accepted once finance is revoked', async () => {
    assertPermitted(
      'finance + parent, then finance revoked + ts_operator',
      await asSuperuser(
        'BEGIN',
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACCOUNT_A}', 'finance')`,
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACCOUNT_A}', 'parent')`,
        `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACCOUNT_A}' AND role = 'finance'`,
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACCOUNT_A}', 'ts_operator')`,
        'ROLLBACK',
      ),
    );
  });

  test("a role outside SD's set is REFUSED by account_role_role_check (23514)", async () => {
    assertRefusedBy(
      "role 'admin'",
      await asSuperuser(
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACCOUNT_A}', 'admin')`,
      ),
      'ERROR:  23514: new row for relation "account_role" violates check constraint "account_role_role_check"',
      'account_role_role_check',
    );
  });

  test("auth_method 'sms' is REFUSED by app_session_auth_method_check (23514)", async () => {
    assertRefusedBy(
      "auth_method 'sms'",
      await asSuperuser(insertSession(SESSION_2, ACCOUNT_A, TOKEN_2, 'sms')),
      'ERROR:  23514: new row for relation "app_session" violates check constraint "app_session_auth_method_check"',
      'app_session_auth_method_check',
    );
  });

  // T-193 (0009, OE-28 (B)): the set is byte-exact, so a spelling of the new value that differs
  // only in case or by a trailing space is an unknown value and is refused like 'sms'.
  for (const variant of ['Registration', 'registration ']) {
    test(`auth_method '${variant}' (a spelling of 0009's value) is REFUSED by app_session_auth_method_check (23514)`, async () => {
      assertRefusedBy(
        `auth_method '${variant}'`,
        await asSuperuser(insertSession(SESSION_2, ACCOUNT_A, TOKEN_2, variant)),
        'ERROR:  23514: new row for relation "app_session" violates check constraint "app_session_auth_method_check"',
        'app_session_auth_method_check',
      );
    });
  }

  test("CONTROL — each of the five auth_method values SD names, and 0009's 'registration' (OE-28 (B)), is accepted", async () => {
    const methods = ['password', 'magic_link', 'passkey', 'otp', 'sso', 'registration'];
    assertPermitted(
      'six auth methods',
      await asSuperuser(
        'BEGIN',
        ...methods.map((m, i) =>
          insertSession(
            `01K4T140SESSIONCONTROL000${String(i)}`,
            ACCOUNT_A,
            `sha256('t140-control-${m}'::bytea)`,
            m,
          ),
        ),
        'ROLLBACK',
      ),
    );
  });

  test('a second session with the same token_hash is REFUSED by app_session_token_hash_key (23505)', async () => {
    assertRefusedBy(
      'duplicate token_hash',
      await asSuperuser(insertSession(SESSION_2, ACCOUNT_A, TOKEN_1)),
      'ERROR:  23505: duplicate key value violates unique constraint "app_session_token_hash_key"',
      'app_session_token_hash_key',
    );
  });

  test('CONTROL — a second session with a different token_hash is accepted', async () => {
    assertPermitted(
      'distinct token_hash',
      await asSuperuser('BEGIN', insertSession(SESSION_2, ACCOUNT_A, TOKEN_2), 'ROLLBACK'),
    );
  });

  test('email_ci is citext: parent@example.cy collides with Parent@Example.CY on account_email_ci_key (23505)', async () => {
    assertRefusedBy(
      'email differing only in case',
      await asSuperuser(insertAccount(ACCOUNT_B, PSEUDONYM_B, `email_ci='parent@example.cy'`)),
      'ERROR:  23505: duplicate key value violates unique constraint "account_email_ci_key"',
      'account_email_ci_key',
    );
  });

  test('CONTROL — a different address is accepted', async () => {
    assertPermitted(
      'distinct email',
      await asSuperuser(
        'BEGIN',
        insertAccount(ACCOUNT_B, PSEUDONYM_B, `email_ci='other@example.cy'`),
        'ROLLBACK',
      ),
    );
  });

  test('after the refusals: one account, no role, one session', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM public.account) || '|' ||
                (SELECT count(*) FROM public.account_role) || '|' ||
                (SELECT count(*) FROM public.app_session)`,
      ),
      '1|0|1',
    );
  });
});

describe('0005 — grants: app_rw reads, inserts and updates; nothing else is granted', () => {
  test('each probe is a real login, not a superuser, and a member of exactly its one role', async () => {
    for (const [role, login] of Object.entries(LOGINS)) {
      const r = await db.psql({
        user: login,
        password: PROBE_PASSWORD,
        raw: true,
        commands: [
          `SELECT session_user || '|' || rolsuper || '|' ||
                  (SELECT string_agg(b.rolname, ',') FROM pg_auth_members m
                     JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid)
             FROM pg_roles r WHERE r.rolname = session_user`,
        ],
      });
      assertPermitted(`connect as ${login}`, r);
      assert.equal(r.stdout.trim(), `${login}|false|${role}`);
    }
  });

  // T-186 (decisions.md OE-47): since migration 0008, app_admin_rw also holds SELECT, INSERT,
  // UPDATE on account_role, so that it can write the ts_senior rows app_rw may no longer write.
  test('each table ACL is exactly app_ddl as owner and app_rw SELECT, INSERT, UPDATE; account_role also app_admin_rw SELECT, INSERT, UPDATE since 0008', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(relname || '=' || relacl::text, ' ' ORDER BY relname) FROM pg_class
          WHERE oid IN ('public.account'::regclass, 'public.account_role'::regclass,
                        'public.app_session'::regclass)`,
      ),
      [
        'account={app_ddl=arwdDxtm/app_ddl,app_rw=arw/app_ddl}',
        'account_role={app_ddl=arwdDxtm/app_ddl,app_rw=arw/app_ddl,app_admin_rw=arw/app_ddl}',
        'app_session={app_ddl=arwdDxtm/app_ddl,app_rw=arw/app_ddl}',
      ].join(' '),
    );
  });

  test('app_rw SELECT, INSERT and UPDATE on each table are PERMITTED (rolled back)', async () => {
    assertPermitted(
      'app_rw writes',
      await asLogin(
        LOGINS.app_rw,
        'BEGIN',
        insertAccount(ACCOUNT_B, PSEUDONYM_B),
        `UPDATE public.account SET locale = 'el', locale_source = 'chosen' WHERE id = '${ACCOUNT_B}'`,
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACCOUNT_B}', 'parent')`,
        `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACCOUNT_B}'`,
        insertSession(SESSION_2, ACCOUNT_B, TOKEN_2),
        `UPDATE public.app_session SET revoked_at = now(), revoked_reason = 'logout' WHERE id = '${SESSION_2}'`,
        `SELECT a.id, r.role, s.id FROM public.account a JOIN public.account_role r ON r.account_id = a.id
           JOIN public.app_session s ON s.account_id = a.id`,
        'ROLLBACK',
      ),
    );
  });

  const REFUSED: ReadonlyArray<readonly [what: string, login: string, table: string, sql: string]> =
    [
      [
        'app_rw DELETE',
        LOGINS.app_rw,
        'account',
        `DELETE FROM public.account WHERE id = '${ACCOUNT_A}'`,
      ],
      [
        'app_rw DELETE',
        LOGINS.app_rw,
        'account_role',
        `DELETE FROM public.account_role WHERE account_id = '${ACCOUNT_A}'`,
      ],
      [
        'app_rw DELETE',
        LOGINS.app_rw,
        'app_session',
        `DELETE FROM public.app_session WHERE id = '${SESSION_1}'`,
      ],
      ...(['account', 'account_role', 'app_session'] as const).flatMap(
        (table) =>
          [
            [
              'answering_service SELECT',
              LOGINS.answering_service,
              table,
              `SELECT 1 FROM public.${table}`,
            ],
            ['app_safety_rw SELECT', LOGINS.app_safety_rw, table, `SELECT 1 FROM public.${table}`],
            ...(table === 'account_role'
              ? []
              : ([
                  [
                    'app_admin_rw SELECT',
                    LOGINS.app_admin_rw,
                    table,
                    `SELECT 1 FROM public.${table}`,
                  ],
                ] as const)),
          ] as const,
      ),
      [
        'app_admin_rw DELETE (T-186: 0008 grants it SELECT, INSERT, UPDATE only)',
        LOGINS.app_admin_rw,
        'account_role',
        `DELETE FROM public.account_role WHERE account_id = '${ACCOUNT_A}'`,
      ],
    ];
  for (const [what, login, table, sql] of REFUSED) {
    test(`${what} on ${table} is REFUSED (42501)`, async () => {
      assertRefused(`${what} on ${table}`, await asLogin(login, sql), {
        message: `ERROR:  42501: permission denied for table ${table}`,
      });
    });
  }

  test('T-186: app_admin_rw SELECT on account_role is PERMITTED since 0008 (OE-47), and a CONTROL login in app_safety_rw is still refused', async () => {
    assertPermitted(
      'app_admin_rw SELECT account_role',
      await asLogin(LOGINS.app_admin_rw, 'SELECT count(*) FROM public.account_role'),
    );
    assertRefused(
      'app_safety_rw SELECT account_role',
      await asLogin(LOGINS.app_safety_rw, 'SELECT 1 FROM public.account_role'),
      { message: 'ERROR:  42501: permission denied for table account_role' },
    );
  });

  test('after the refusals: still one account and one session', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM public.account) || '|' || (SELECT count(*) FROM public.app_session)`,
      ),
      '1|1',
    );
  });
});

describe('0005 — citext and the SA §INT-10 guard, called DIRECTLY (OD-76)', () => {
  test('citext is installed in public, owned by the bootstrap superuser, with no SECURITY DEFINER function and no relation', async () => {
    assert.equal(
      await db.value(
        `SELECT e.extname || '|' || n.nspname || '|' || pg_get_userbyid(e.extowner) || '|' ||
                (SELECT count(*) FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid
                  WHERE d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
                    AND d.refobjid = e.oid AND p.prosecdef) || '|' ||
                (SELECT count(*) FROM pg_depend d
                  WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'e' AND d.refobjid = e.oid)
           FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE e.extname = 'citext'`,
      ),
      'citext|public|app|0|0',
    );
  });

  test('the guard event trigger is enabled and CREATE EXTENSION is one of its tags', async () => {
    assert.equal(
      await db.value(
        `SELECT evtenabled::text || '|' || ('CREATE EXTENSION' = ANY (evttags))::text
           FROM pg_event_trigger WHERE evtname = 'trg_int10_answering_service'`,
      ),
      'O|true',
    );
  });

  test('after up the guard returns clean', async () => {
    assertPermitted(
      'direct call after up',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  test('the same reading raises on a known-bad state, and is clean again once it is removed', async () => {
    // A detective-only grant (T-020 § contract §5): it fires no trigger, so only the call sees it.
    assertPermitted(
      'plant',
      await asSuperuser('GRANT TEMPORARY ON DATABASE kinvara TO answering_service'),
    );
    const bad = await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()');
    assertPermitted(
      'remove',
      await asSuperuser('REVOKE TEMPORARY ON DATABASE kinvara FROM answering_service'),
    );
    assertRefused('direct call on the known-bad state', bad, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    assert.ok(
      bad.output.includes('answering_service holds TEMPORARY on database kinvara'),
      `the raise must name the planted grant.\n${bad.output}`,
    );
    assertPermitted(
      'direct call after removal',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  for (const table of ['account', 'account_role', 'app_session']) {
    test(`GRANT SELECT on ${table} to answering_service is REFUSED by the guard (KV010), and lands nothing`, async () => {
      const r = await asSuperuser(`GRANT SELECT ON public.${table} TO answering_service`);
      assertRefused(`GRANT SELECT on ${table}`, r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
      assert.ok(
        r.output.includes(`answering_service holds SELECT on public.${table}`),
        `the raise must name the table.\n${r.output}`,
      );
      assert.equal(
        await db.value(
          `SELECT has_table_privilege('answering_service', 'public.${table}', 'SELECT')::text`,
        ),
        'false',
      );
    });
  }
});
