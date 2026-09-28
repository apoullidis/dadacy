/**
 * T-226 — `public.account_sso_identity` (migration 0017): P-SSO-SUBJECT of
 * tasks/state/EP-2/OD-231-cut.md, as decisions.md OE-55 rules it (bind each admin account to its
 * Cloudflare identity at first login). One subject per account (the primary key), one account per
 * subject (the UNIQUE); app_rw holds SELECT and INSERT (account_id, subject) only; no other role
 * holds anything, because re-binding has no ruled grant (T-226, question Q-T226-1).
 *
 * What the database does NOT refuse is pinned too, each in a case named NOT HELD or NOT REFUSED.
 * The catalogue reads (columns, constraints, indexes, table and column ACLs, the comment, and the
 * counts of triggers, rewrite rules, policies and row-level security) turn red if a grant, a
 * constraint, a trigger, a rule or a policy is added to or removed from the table.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field, and exactly one ERROR line,
 * so a crash, a syntax error or a refusal for another reason cannot read as this one. Each rule has
 * a CONTROL beside it.
 *
 * Every UPDATE or DELETE refusal and control first reads its target row in the same psql session
 * and asserts that reading, so a statement that matched no row can pass for neither.
 *
 * Privilege refusals run over REAL LOGIN principals, each a member of exactly one role (T-020
 * Evidence §4). Constraint refusals run as the superuser unless a case says app_rw, so no privilege
 * is what refuses them.
 *
 * The tests share one cluster in file order. Fixture rows are written in `beforeAll`; every other
 * write runs inside a transaction that is never committed (`inTransaction`).
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

const SUITE = 'account-sso-identity';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't226_app_rw_probe',
  app_admin_rw: 't226_app_admin_rw_probe',
  app_safety_rw: 't226_app_safety_rw_probe',
  answering_service: 't226_answering_service_probe',
  app_ddl: 't226_app_ddl_probe',
} as const;

/** Fixture ids, each exactly `char(26)` wide. A and B are bound; C is an unbound operator; P a parent. */
const ACCOUNT_A = '01K4T226ACCOUNTA0000000001';
const ACCOUNT_B = '01K4T226ACCOUNTB0000000001';
const ACCOUNT_C = '01K4T226ACCOUNTC0000000001';
const ACCOUNT_P = '01K4T226ACCOUNTP0000000001';
const NO_SUCH_ACCOUNT = '01K4T226NOSUCHACCOUNT00001';
for (const id of [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_P, NO_SUCH_ACCOUNT]) {
  assert.equal(id.length, 26, `fixture id ${id} is not char(26) wide`);
}

/** Stand-ins for Cloudflare Access `sub` values (opaque strings to this table). */
const SUB_A = '7f1c2a90-2260-4a00-8000-00000000000a';
const SUB_B = '7f1c2a90-2260-4a00-8000-00000000000b';
const SUB_NEW = '7f1c2a90-2260-4a00-8000-0000000000ff';

/** The exchange's first-login INSERT: exactly the two columns app_rw may write. */
const bind = (account: string, subject: string): string =>
  `INSERT INTO public.account_sso_identity (account_id, subject) VALUES (${
    account === 'NULL' ? 'NULL' : `'${account}'`
  }, ${subject === 'NULL' ? 'NULL' : `'${subject}'`})`;

/** One account's binding, read in the session that then writes it. */
const readBinding = (account: string): string =>
  `SELECT 'binding ' || count(*) || ' subject=' || coalesce(string_agg(subject, ','), '-')
     FROM public.account_sso_identity WHERE account_id = '${account}'`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      `INSERT INTO public.account (id, pseudonym, tos_version) VALUES
         ('${ACCOUNT_A}', '01K4T226PSEUDOA00000000001', 'v1'),
         ('${ACCOUNT_B}', '01K4T226PSEUDOB00000000001', 'v1'),
         ('${ACCOUNT_C}', '01K4T226PSEUDOC00000000001', 'v1'),
         ('${ACCOUNT_P}', '01K4T226PSEUDOP00000000001', 'v1')`,
      `INSERT INTO public.account_role (account_id, role) VALUES
         ('${ACCOUNT_A}', 'ts_operator'), ('${ACCOUNT_B}', 'engineer'),
         ('${ACCOUNT_C}', 'support'), ('${ACCOUNT_P}', 'parent')`,
      bind(ACCOUNT_A, SUB_A),
      bind(ACCOUNT_B, SUB_B),
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/**
 * Every invocation runs inside one transaction that is never committed: BEGIN is prepended unless
 * the caller opened one, and psql's session end rolls it back.
 */
const inTransaction = (commands: string[]): string[] =>
  commands[0] === 'BEGIN' ? commands : ['BEGIN', ...commands];

/** Statements as the bootstrap superuser, SQLSTATE in the message, stopping at the first error. */
function asSuperuser(...commands: string[]): Promise<PsqlResult> {
  return db.psql({ commands: inTransaction(commands), verbose: true, stopOnError: true });
}

/** Statements over a real login, SQLSTATE in the message, stopping at the first error. */
function asLogin(login: string, ...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands: inTransaction(commands),
    verbose: true,
    stopOnError: true,
  });
}

/** Refused with exactly this ERROR line, and exactly one ERROR line; `field` too when given. */
function assertRefusedBy(what: string, r: PsqlResult, errorLine: string, field?: string): void {
  assertRefused(what, r, { message: errorLine });
  if (field !== undefined) {
    assert.ok(
      r.output.includes(field),
      `${what}: expected ${JSON.stringify(field)} in the output.\n${r.output}`,
    );
  }
  assert.equal(
    (r.output.match(/ERROR: {2}[0-9A-Z]{5}:/g) ?? []).length,
    1,
    `${what}: expected exactly one ERROR line.\n${r.output}`,
  );
}

/** The session read what it then relied on. */
function assertRead(what: string, r: PsqlResult, state: string): void {
  assert.ok(
    r.output.includes(state),
    `${what}: expected the precondition ${JSON.stringify(state)}.\n${r.output}`,
  );
}

const DENIED = 'ERROR:  42501: permission denied for table account_sso_identity';
const PKEY_23505 =
  'ERROR:  23505: duplicate key value violates unique constraint "account_sso_identity_pkey"';
const PKEY_FIELD = 'CONSTRAINT NAME:  account_sso_identity_pkey';
const SUBJECT_23505 =
  'ERROR:  23505: duplicate key value violates unique constraint "account_sso_identity_subject_key"';
const SUBJECT_FIELD = 'CONSTRAINT NAME:  account_sso_identity_subject_key';
const FKEY_FIELD = 'CONSTRAINT NAME:  account_sso_identity_account_id_fkey';
const A_BOUND = `binding 1 subject=${SUB_A}`;

/** The text 0017 installs, verbatim: a change to the comment must change this suite too. */
const TABLE_COMMENT =
  'Binds an admin account to its Cloudflare Access subject, at the first SSO exchange (decisions.md OE-55). ' +
  'The primary key on account_id allows one subject per account; the UNIQUE on subject allows one account per ' +
  'subject. account_id references account, ON DELETE CASCADE. app_rw may SELECT, and may INSERT only ' +
  'account_id and subject, so bound_at takes now() for it. It holds no UPDATE, DELETE or TRUNCATE. These are ' +
  'grants: they bind app_rw, not the table owner app_ddl or the superuser. No other role holds any privilege. ' +
  'The database does not check that the account holds an admin role.';

describe('0017 — the table, its owner, columns, constraints, indexes, ACL and comment', () => {
  test('three columns in order, types, nullability and defaults; owner app_ddl; ACL: app_rw SELECT, INSERT on account_id and subject only', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.account_sso_identity'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = c.oid AND attacl IS NOT NULL)
           FROM pg_class c WHERE c.oid = 'public.account_sso_identity'::regclass`,
      ),
      'account_id:character(26):nn:-,subject:text:nn:-,bound_at:timestamp with time zone:nn:now()' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}' +
        '|account_id={app_rw=a/app_ddl},subject={app_rw=a/app_ddl}',
    );
  });

  test('the primary key, the UNIQUE, the FOREIGN KEY and the three NOT NULLs are exactly these, by these definitions, and there is no CHECK', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid) ||
                           CASE WHEN contype = 'f' THEN ' upd=' || confupdtype::text || ' del=' || confdeltype::text ||
                                                        ' deferrable=' || condeferrable::text ELSE '' END,
                           ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'public.account_sso_identity'::regclass`,
      ),
      'account_sso_identity_account_id_fkey=FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE upd=a del=c deferrable=false ; ' +
        'account_sso_identity_account_id_not_null=NOT NULL account_id ; ' +
        'account_sso_identity_bound_at_not_null=NOT NULL bound_at ; ' +
        'account_sso_identity_pkey=PRIMARY KEY (account_id) ; ' +
        'account_sso_identity_subject_key=UNIQUE (subject) ; ' +
        'account_sso_identity_subject_not_null=NOT NULL subject',
    );
  });

  test('the only indexes are the two the keys create', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid = 'public.account_sso_identity'::regclass`,
      ),
      'CREATE UNIQUE INDEX account_sso_identity_pkey ON public.account_sso_identity USING btree (account_id) ; ' +
        'CREATE UNIQUE INDEX account_sso_identity_subject_key ON public.account_sso_identity USING btree (subject)',
    );
  });

  test('no non-internal trigger, no rewrite rule, no row-level security and no policy', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
           FROM pg_class c WHERE c.oid = 'public.account_sso_identity'::regclass`,
      ),
      '0 triggers, 0 rules, rls=false, force=false, 0 policies',
    );
  });

  test('COMMENT ON TABLE is exactly this text, and no column carries a comment', async () => {
    assert.equal(
      await db.value(`SELECT obj_description('public.account_sso_identity'::regclass, 'pg_class')`),
      TABLE_COMMENT,
    );
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.account_sso_identity'::regclass
            AND attnum > 0 AND col_description(attrelid, attnum) IS NOT NULL`,
      ),
      '0',
    );
  });
});

describe('0017 — one subject per account: account_sso_identity_pkey (OE-55)', () => {
  test('app_rw binding an already-bound account to a second subject is REFUSED by account_sso_identity_pkey (23505)', async () => {
    const r = await asLogin(LOGINS.app_rw, readBinding(ACCOUNT_A), bind(ACCOUNT_A, SUB_NEW));
    assertRead('second subject for A', r, A_BOUND);
    assertRefusedBy('second subject for A', r, PKEY_23505, PKEY_FIELD);
  });

  test('app_rw binding an already-bound account AGAIN to the SAME subject is also REFUSED by account_sso_identity_pkey (23505): a repeat bind is not a no-op', async () => {
    const r = await asLogin(LOGINS.app_rw, readBinding(ACCOUNT_A), bind(ACCOUNT_A, SUB_A));
    assertRead('same subject again for A', r, A_BOUND);
    assertRefusedBy('same subject again for A', r, PKEY_23505, PKEY_FIELD);
  });

  test("CONTROL — app_rw binds the unbound account C to a new subject; bound_at is the transaction's now()", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readBinding(ACCOUNT_C),
      bind(ACCOUNT_C, SUB_NEW),
      `SELECT 'C bound to ' || subject || ' at now():' || (bound_at = now())
         FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_C}'`,
    );
    assertPermitted('bind C', r);
    assertRead('bind C', r, 'binding 0 subject=-');
    assertRead('bind C', r, `C bound to ${SUB_NEW} at now():true`);
  });
});

describe('0017 — one account per subject: account_sso_identity_subject_key (OE-55)', () => {
  test("app_rw binding account C to account A's subject is REFUSED by account_sso_identity_subject_key (23505)", async () => {
    const r = await asLogin(LOGINS.app_rw, readBinding(ACCOUNT_C), bind(ACCOUNT_C, SUB_A));
    assertRead("C to A's subject", r, 'binding 0 subject=-');
    assertRefusedBy("C to A's subject", r, SUBJECT_23505, SUBJECT_FIELD);
  });
});

describe('0017 — account_id REFERENCES account(id) ON DELETE CASCADE', () => {
  test('app_rw binding an unknown account_id is REFUSED by account_sso_identity_account_id_fkey (23503)', async () => {
    assertRefusedBy(
      'unknown account_id',
      await asLogin(LOGINS.app_rw, bind(NO_SUCH_ACCOUNT, SUB_NEW)),
      'ERROR:  23503: insert or update on table "account_sso_identity" violates foreign key constraint "account_sso_identity_account_id_fkey"',
      FKEY_FIELD,
    );
  });

  test("deleting an account as the superuser deletes its binding and no other account's (the cascade)", async () => {
    const r = await asSuperuser(
      `SELECT 'before: B ' || (SELECT count(*) FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_B}') ||
              ', A ' || (SELECT count(*) FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_A}')`,
      `DELETE FROM public.account WHERE id = '${ACCOUNT_B}'`,
      `SELECT 'after: B ' || (SELECT count(*) FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_B}') ||
              ', A ' || (SELECT count(*) FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_A}') ||
              ', account B ' || (SELECT count(*) FROM public.account WHERE id = '${ACCOUNT_B}')`,
    );
    assertPermitted('account delete cascades', r);
    assertRead('account delete cascades', r, 'before: B 1, A 1');
    assertRead('account delete cascades', r, 'after: B 0, A 1, account B 0');
  });

  test('renaming a referenced account.id is REFUSED by account_sso_identity_account_id_fkey (23503): no ON UPDATE CASCADE', async () => {
    assertRefusedBy(
      'account id renamed',
      await asSuperuser(
        // B's account_role row is removed first, so that no other table's foreign key refuses first.
        `DELETE FROM public.account_role WHERE account_id = '${ACCOUNT_B}'`,
        `UPDATE public.account SET id = '01K4T226ACCOUNTRENAMED0001' WHERE id = '${ACCOUNT_B}'`,
      ),
      'ERROR:  23503: update or delete on table "account" violates foreign key constraint "account_sso_identity_account_id_fkey" on table "account_sso_identity"',
      FKEY_FIELD,
    );
  });
});

describe('0017 — NOT NULL (23502, naming the column)', () => {
  const NULLS = [
    ['account_id', bind('NULL', SUB_NEW)],
    ['subject', bind(ACCOUNT_C, 'NULL')],
    [
      'bound_at',
      `INSERT INTO public.account_sso_identity (account_id, subject, bound_at) VALUES ('${ACCOUNT_C}', '${SUB_NEW}', NULL)`,
    ],
  ] as const;
  for (const [column, sql] of NULLS) {
    test(`${column} NULL is REFUSED (23502), as the superuser`, async () => {
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(sql),
        `ERROR:  23502: null value in column "${column}" of relation "account_sso_identity" violates not-null constraint`,
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('app_rw binding with subject NULL is REFUSED (23502) too', async () => {
    assertRefusedBy(
      'app_rw subject NULL',
      await asLogin(LOGINS.app_rw, bind(ACCOUNT_C, 'NULL')),
      'ERROR:  23502: null value in column "subject" of relation "account_sso_identity" violates not-null constraint',
      'COLUMN NAME:  subject',
    );
  });
});

describe('0017 — app_rw: SELECT and INSERT (account_id, subject) only; no UPDATE, DELETE or TRUNCATE', () => {
  test('app_rw holds INSERT on exactly account_id and subject (not bound_at), UPDATE on no column, and no table-level INSERT, UPDATE, DELETE or TRUNCATE', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' ||
                           has_column_privilege('app_rw', 'public.account_sso_identity', attname, 'INSERT') || '/' ||
                           has_column_privilege('app_rw', 'public.account_sso_identity', attname, 'UPDATE'),
                           ',' ORDER BY attnum) || ' table:' ||
                (SELECT string_agg(p || '=' || has_table_privilege('app_rw', 'public.account_sso_identity', p), ',')
                   FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p)
           FROM pg_attribute WHERE attrelid = 'public.account_sso_identity'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'account_id=true/false,subject=true/false,bound_at=false/false ' +
        'table:SELECT=true,INSERT=false,UPDATE=false,DELETE=false,TRUNCATE=false',
    );
  });

  for (const [label, value] of [
    ['a back-dated bound_at', "now() - interval '1 year'"],
    ['the DEFAULT keyword', 'DEFAULT'],
  ] as const) {
    test(`app_rw INSERT naming bound_at (${label}) is REFUSED by the column grant (42501)`, async () => {
      assertRefusedBy(
        `app_rw insert bound_at ${label}`,
        await asLogin(
          LOGINS.app_rw,
          `INSERT INTO public.account_sso_identity (account_id, subject, bound_at) VALUES ('${ACCOUNT_C}', '${SUB_NEW}', ${value})`,
        ),
        DENIED,
      );
    });
  }

  for (const [label, set] of [
    ['subject replaced (a binding moved in place)', `subject = '${SUB_NEW}'`],
    ['account_id moved to another account', `account_id = '${ACCOUNT_C}'`],
    ['bound_at moved', "bound_at = bound_at - interval '1 day'"],
  ] as const) {
    test(`app_rw UPDATE: ${label} is REFUSED (42501)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readBinding(ACCOUNT_A),
        `UPDATE public.account_sso_identity SET ${set} WHERE account_id = '${ACCOUNT_A}'`,
      );
      assertRead(`app_rw ${label}`, r, A_BOUND);
      assertRefusedBy(`app_rw ${label}`, r, DENIED);
    });
  }

  test('app_rw DELETE of a binding is REFUSED (42501)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readBinding(ACCOUNT_A),
      `DELETE FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_A}'`,
    );
    assertRead('app_rw DELETE', r, A_BOUND);
    assertRefusedBy('app_rw DELETE', r, DENIED);
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefusedBy(
      'app_rw TRUNCATE',
      await asLogin(LOGINS.app_rw, 'TRUNCATE public.account_sso_identity'),
      DENIED,
    );
  });

  test('app_rw upsert ON CONFLICT (account_id) DO UPDATE SET subject = EXCLUDED.subject is REFUSED (42501): no UPDATE privilege', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readBinding(ACCOUNT_A),
      `${bind(ACCOUNT_A, SUB_NEW)} ON CONFLICT (account_id) DO UPDATE SET subject = EXCLUDED.subject`,
    );
    assertRead('app_rw upsert', r, A_BOUND);
    assertRefusedBy('app_rw upsert', r, DENIED);
  });

  test('app_rw SELECT … FOR SHARE (and FOR UPDATE) of a binding is REFUSED (42501): a row lock needs UPDATE privilege', async () => {
    for (const lock of ['FOR SHARE', 'FOR UPDATE']) {
      assertRefusedBy(
        `app_rw ${lock}`,
        await asLogin(
          LOGINS.app_rw,
          `SELECT subject FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_A}' ${lock}`,
        ),
        DENIED,
      );
    }
  });

  test("CONTROL — app_rw reads a binding by account_id and by subject (the exchange's two lookups)", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readBinding(ACCOUNT_A),
      `SELECT 'by subject ' || account_id FROM public.account_sso_identity WHERE subject = '${SUB_A}'`,
    );
    assertPermitted('app_rw SELECT', r);
    assertRead('app_rw SELECT', r, A_BOUND);
    assertRead('app_rw SELECT', r, `by subject ${ACCOUNT_A}`);
  });

  test('NOT REFUSED — app_rw INSERT … ON CONFLICT DO NOTHING with a DIFFERENT subject on a bound account is accepted and writes NOTHING: the caller must read the binding back', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readBinding(ACCOUNT_A),
      `WITH i AS (${bind(ACCOUNT_A, SUB_NEW)} ON CONFLICT DO NOTHING RETURNING 1)
       SELECT 'upsert-nothing wrote ' || count(*) FROM i`,
      readBinding(ACCOUNT_A),
    );
    assertPermitted('ON CONFLICT DO NOTHING', r);
    assertRead('ON CONFLICT DO NOTHING', r, 'upsert-nothing wrote 0');
    assert.equal(
      (r.output.match(new RegExp(A_BOUND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [])
        .length,
      2,
      `the binding must read the same before and after.\n${r.output}`,
    );
  });
});

describe('0017 — no other role reads or writes it (re-binding not granted: Q-T226-1), over real single-membership logins', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} SELECT`,
        await asLogin(LOGINS[role], 'SELECT count(*) FROM public.account_sso_identity'),
        DENIED,
      );
    });
  }

  for (const [what, sql] of [
    ['INSERT', bind(ACCOUNT_C, SUB_NEW)],
    [
      'UPDATE',
      `UPDATE public.account_sso_identity SET subject = '${SUB_NEW}' WHERE account_id = '${ACCOUNT_A}'`,
    ],
    ['DELETE', `DELETE FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_A}'`],
  ] as const) {
    test(`app_admin_rw ${what} is REFUSED (42501)`, async () => {
      assertRefusedBy(`app_admin_rw ${what}`, await asLogin(LOGINS.app_admin_rw, sql), DENIED);
    });
  }

  test('no role but app_ddl (the owner) and app_rw holds any privilege on the table or a column', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(r || '=' ||
                  (has_table_privilege(r, 'public.account_sso_identity', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
                   has_any_column_privilege(r, 'public.account_sso_identity', 'SELECT,INSERT,UPDATE,REFERENCES')), ',' ORDER BY r)
           FROM unnest(ARRAY['app_admin_rw', 'app_safety_rw', 'answering_service', 'app_rw', 'public']) r`,
      ),
      'answering_service=false,app_admin_rw=false,app_rw=true,app_safety_rw=false,public=false',
    );
  });
});

describe('0017 — NOT HELD (disclosed)', () => {
  test('NOT HELD — app_rw binds an account whose only role is parent: the database does not check for an admin role (T-221 does)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'P roles ' || string_agg(role, ',') FROM public.account_role WHERE account_id = '${ACCOUNT_P}'`,
      bind(ACCOUNT_P, SUB_NEW),
      readBinding(ACCOUNT_P),
    );
    assertPermitted('parent-only account bound', r);
    assertRead('parent-only account bound', r, 'P roles parent');
    assertRead('parent-only account bound', r, `binding 1 subject=${SUB_NEW}`);
  });

  test('NOT HELD — the UNIQUE compares exactly: a case variant of a bound subject, an empty subject and a padded subject are each accepted as new subjects', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      bind(ACCOUNT_C, SUB_A.toUpperCase()),
      bind(ACCOUNT_P, ''),
      `SELECT 'stored: ' || string_agg(account_id || '=[' || subject || ']', ',' ORDER BY account_id)
         FROM public.account_sso_identity WHERE account_id IN ('${ACCOUNT_C}', '${ACCOUNT_P}')`,
    );
    assertPermitted('exact UNIQUE', r);
    assertRead('exact UNIQUE', r, `stored: ${ACCOUNT_C}=[${SUB_A.toUpperCase()}],${ACCOUNT_P}=[]`);
    const padded = await asLogin(
      LOGINS.app_rw,
      bind(ACCOUNT_C, ` ${SUB_A} `),
      `SELECT 'padded length ' || length(subject) FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_C}'`,
    );
    assertPermitted('padded subject', padded);
    assertRead('padded subject', padded, `padded length ${String(SUB_A.length + 2)}`);
  });

  test('NOT HELD — the owner app_ddl moves a binding in place (subject and bound_at) and deletes one; the superuser moves one too: the grants bind app_rw only', async () => {
    const owner = await asLogin(
      LOGINS.app_ddl,
      readBinding(ACCOUNT_A),
      `UPDATE public.account_sso_identity SET subject = '${SUB_NEW}', bound_at = bound_at - interval '1 day'
        WHERE account_id = '${ACCOUNT_A}' RETURNING 'owner re-bound to ' || subject`,
      `DELETE FROM public.account_sso_identity WHERE account_id = '${ACCOUNT_A}' RETURNING 'owner deleted ' || account_id`,
    );
    assertPermitted('owner re-binds and deletes', owner);
    assertRead('owner re-binds and deletes', owner, A_BOUND);
    assertRead('owner re-binds and deletes', owner, `owner re-bound to ${SUB_NEW}`);
    assertRead('owner re-binds and deletes', owner, `owner deleted ${ACCOUNT_A}`);
    const su = await asSuperuser(
      readBinding(ACCOUNT_A),
      `UPDATE public.account_sso_identity SET subject = '${SUB_NEW}' WHERE account_id = '${ACCOUNT_A}'
        RETURNING 'superuser re-bound to ' || subject`,
    );
    assertPermitted('superuser re-binds', su);
    assertRead('superuser re-binds', su, A_BOUND);
    assertRead('superuser re-binds', su, `superuser re-bound to ${SUB_NEW}`);
  });

  test('NOT HELD — an erasure tombstone written by app_rw (status erased, email NULL) leaves the binding in place: app_rw cannot delete it', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readBinding(ACCOUNT_A),
      `UPDATE public.account SET status = 'erased', email_ci = NULL, erased_at = now()
        WHERE id = '${ACCOUNT_A}' RETURNING 'tombstoned ' || status`,
      readBinding(ACCOUNT_A),
    );
    assertPermitted('tombstone keeps binding', r);
    assertRead('tombstone keeps binding', r, 'tombstoned erased');
    assert.equal(
      (r.output.match(new RegExp(A_BOUND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [])
        .length,
      2,
      `the binding must read the same before and after the tombstone.\n${r.output}`,
    );
  });

  test('the fixture rows survive every refusal and rolled-back write above: A and B bound as written, C and P unbound', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(account_id || '=' || subject, ',' ORDER BY account_id) FROM public.account_sso_identity`,
      ),
      `${ACCOUNT_A}=${SUB_A},${ACCOUNT_B}=${SUB_B}`,
    );
  });
});

describe('0017 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON account_sso_identity TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.account_sso_identity TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.account_sso_identity'),
      `the guard's DETAIL does not name account_sso_identity.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.account_sso_identity', 'SELECT')::text`,
      ),
      'false',
    );
  });

  test('GRANT INSERT (subject) ON account_sso_identity TO answering_service (a column grant) is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser(
      'GRANT INSERT (subject) ON public.account_sso_identity TO answering_service',
    );
    assertRefused('column grant to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.equal(
      await db.value(
        `SELECT has_any_column_privilege('answering_service', 'public.account_sso_identity', 'INSERT')::text`,
      ),
      'false',
    );
  });

  test("of 0017's statement kinds, CREATE TABLE and GRANT fire the guard and COMMENT does not (a detective-only grant held open, rolled back)", async () => {
    const comment = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      `COMMENT ON TABLE public.account_sso_identity IS 'probe'`,
      `SELECT 'comment accepted'`,
    );
    assertPermitted('COMMENT with the guard armed', comment);
    assertRead('COMMENT with the guard armed', comment, 'comment accepted');
    const create = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'CREATE TABLE public.t226_guard_probe (id int)',
    );
    assertRefused('CREATE TABLE with the guard armed', create, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    const grant = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'GRANT SELECT ON public.account_sso_identity TO app_rw',
    );
    assertRefused('GRANT with the guard armed', grant, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
  });

  test('after up the guard, called DIRECTLY, returns clean', async () => {
    assertPermitted(
      'direct guard call',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });
});
