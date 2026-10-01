/**
 * T-196 — `public.webauthn_credential` (migration 0016): SD §DB-2 lines 1823–1828 plus the accepted
 * OE-30 / OE-49 / OE-50 rulings (tasks/state/EP-2/OE-30-34-rulings.md Part A.1 U-W1/U-W3, Part E.1
 * U-W2, Part B.3 U-W4 with Part F, and C2 standing resolved as (c)), and T-196's column-level grants
 * where no ruling speaks (INSERT on T-027 W2's seven columns; UPDATE on W4's two).
 * These are the database-layer refusals TK-3 lists, plus what the database does NOT refuse. The table's
 * catalogue is pinned: its columns, constraints, index, ACL, comments, and the COUNTS of its
 * non-internal triggers, rewrite rules (pg_rewrite, T-234) and policies, and its row-level security
 * flags. So a grant, constraint, index, trigger, rule or policy added to or removed from the table turns
 * a case red; a conditional INSTEAD rule that silently drops a zero-byte credential_id INSERT was
 * measured passing every case before the rule count (T-196 QA2-F1, QR1). What is not in those
 * catalogues is not pinned (for example a function the triggers or rules would call, or an event
 * trigger), and a change that keeps every count and definition read here cannot turn a case red.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field, and exactly one ERROR line,
 * so a crash, a syntax error or a refusal for another reason cannot read as this one. Each rule has
 * a CONTROL beside it.
 *
 * Every UPDATE refusal and control first reads its target row in the same psql session and asserts
 * that reading, so an UPDATE that matched no row can pass for neither a refusal nor a control.
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

const SUITE = 'webauthn-credential';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't196_app_rw_probe',
  app_admin_rw: 't196_app_admin_rw_probe',
  app_safety_rw: 't196_app_safety_rw_probe',
  answering_service: 't196_answering_service_probe',
  app_ddl: 't196_app_ddl_probe',
} as const;

/** Fixture ids, each exactly `char(26)` wide. */
const ACCOUNT_A = '01K4T196ACCOUNTA0000000001';
const ACCOUNT_B = '01K4T196ACCOUNTB0000000001';
const CRED_A1 = '01K4T196CREDA1000000000001';
const CRED_A2 = '01K4T196CREDA2000000000001';
const CRED_B1 = '01K4T196CREDB1000000000001';
const SCRATCH = '01K4T196CREDSCRATCH0000001';
const NO_SUCH_ACCOUNT = '01K4T196NOSUCHACCOUNT00001';
for (const id of [ACCOUNT_A, ACCOUNT_B, CRED_A1, CRED_A2, CRED_B1, SCRATCH, NO_SUCH_ACCOUNT]) {
  assert.equal(id.length, 26, `fixture id ${id} is not char(26) wide`);
}

/** Byte-string stand-ins; a real credential id is opaque bytes and a public key a COSE key. */
const B = (byte: string, n = 16): string => `decode(repeat('${byte}', ${String(n)}), 'hex')`;
const A1_CRED = B('a1');
const KEY = B('c0', 77);

/** T-027 W2's INSERT: exactly the seven columns app_rw may write. */
const insert = (
  id: string,
  opts: {
    account?: string;
    cred?: string;
    key?: string;
    count?: string;
    transports?: string;
    aaguid?: string;
  } = {},
): string =>
  `INSERT INTO public.webauthn_credential (id, account_id, credential_id, public_key, sign_count, transports, aaguid) VALUES (${
    id === 'NULL' ? 'NULL' : `'${id}'`
  }, ${opts.account ?? `'${ACCOUNT_A}'`}, ${opts.cred ?? B('77')}, ${opts.key ?? KEY}, ${
    opts.count ?? '0'
  }, ${opts.transports ?? `ARRAY['internal', 'hybrid']`}, ${
    opts.aaguid ?? `'08987058-cadc-4b81-b6e1-30de50dcbe96'`
  })`;

/** One row's account, counter and last use, read in the session that then writes it. */
const readRow = (id: string): string =>
  `SELECT 'row ' || count(*) || ' account=' || coalesce(string_agg(account_id, ','), '-') ||
          ' sign_count=' || coalesce(string_agg(sign_count::text, ','), '-') ||
          ' used=' || coalesce(string_agg((last_used_at IS NOT NULL)::text, ','), '-')
     FROM public.webauthn_credential WHERE id = '${id}'`;

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
         ('${ACCOUNT_A}', '01K4T196PSEUDOA00000000001', 'v1'),
         ('${ACCOUNT_B}', '01K4T196PSEUDOB00000000001', 'v1')`,
      insert(CRED_A1, { cred: A1_CRED, count: '10' }),
      insert(CRED_A2, { cred: B('a2') }),
      insert(CRED_B1, { account: `'${ACCOUNT_B}'`, cred: B('b1') }),
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

/** Refused with exactly this ERROR line, and psql named the object that refused it. */
function assertRefusedBy(what: string, r: PsqlResult, errorLine: string, field: string): void {
  assertRefused(what, r, { message: errorLine });
  assert.ok(
    r.output.includes(field),
    `${what}: expected ${JSON.stringify(field)} in the output.\n${r.output}`,
  );
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

const DENIED = 'ERROR:  42501: permission denied for table webauthn_credential';
const RANGE_23514 =
  'ERROR:  23514: new row for relation "webauthn_credential" violates check constraint "webauthn_credential_sign_count_range"';
const RANGE_FIELD = 'CONSTRAINT NAME:  webauthn_credential_sign_count_range';
const A1_BEFORE = `row 1 account=${ACCOUNT_A} sign_count=10 used=false`;

/** The texts 0016 installs, verbatim: a change to either comment must change this suite too. */
const TABLE_COMMENT =
  'WebAuthn passkey credentials (SD §DB-2 lines 1823-1828). credential_id is UNIQUE across all accounts. ' +
  'account_id references account, ON DELETE CASCADE. app_rw may SELECT and DELETE (a user removes a passkey; ' +
  "erasure deletes the account's credentials: OE-50 U-W4), may INSERT only id, account_id, credential_id, " +
  'public_key, sign_count, transports and aaguid, and may UPDATE only sign_count and last_used_at. These are ' +
  'grants: they bind app_rw, not the table owner app_ddl or the superuser. No grant to app_admin_rw and no ' +
  "row-level security (admin passkeys are Cloudflare Access's: C2 (c)).";
const SIGN_COUNT_COMMENT =
  "The authenticator's signature counter, an unsigned 32-bit value: CHECK webauthn_credential_sign_count_range " +
  'holds it to 0..4294967295 (OE-49 U-W2). The database does not refuse a decrease: U-W2 assigns that refusal ' +
  'to the WebAuthn library, at login.';

describe('0016 — the table, its owner, columns, constraints, index, ACL and comments', () => {
  test("SD 1823–1828's nine columns in SD's order, types and defaults; owner app_ddl; ACL: app_rw SELECT and DELETE, INSERT on seven columns, UPDATE on sign_count and last_used_at", async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.webauthn_credential'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = c.oid AND attacl IS NOT NULL)
           FROM pg_class c WHERE c.oid = 'public.webauthn_credential'::regclass`,
      ),
      'id:character(26):nn:-,account_id:character(26):nn:-,credential_id:bytea:nn:-,public_key:bytea:nn:-,' +
        'sign_count:bigint:nn:0,transports:text[]:null:-,aaguid:uuid:null:-,' +
        'created_at:timestamp with time zone:nn:now(),last_used_at:timestamp with time zone:null:-' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=rd/app_ddl}' +
        '|id={app_rw=a/app_ddl},account_id={app_rw=a/app_ddl},credential_id={app_rw=a/app_ddl},' +
        'public_key={app_rw=a/app_ddl},sign_count={app_rw=aw/app_ddl},transports={app_rw=a/app_ddl},' +
        'aaguid={app_rw=a/app_ddl},last_used_at={app_rw=w/app_ddl}',
    );
  });

  test('the key, UNIQUE, FOREIGN KEY and the range CHECK are exactly these, by these definitions', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid) ||
                           CASE WHEN contype = 'f' THEN ' upd=' || confupdtype::text || ' del=' || confdeltype::text ELSE '' END,
                           ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'public.webauthn_credential'::regclass AND contype IN ('p', 'u', 'f', 'c')`,
      ),
      'webauthn_credential_account_id_fkey=FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE upd=a del=c ; ' +
        'webauthn_credential_credential_id_key=UNIQUE (credential_id) ; ' +
        'webauthn_credential_pkey=PRIMARY KEY (id) ; ' +
        "webauthn_credential_sign_count_range=CHECK (((sign_count >= 0) AND (sign_count <= '4294967295'::bigint)))",
    );
  });

  test('webauthn_credential_account_id_idx is (account_id) (U-W3), and the table has no other non-key index', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid = 'public.webauthn_credential'::regclass`,
      ),
      'CREATE INDEX webauthn_credential_account_id_idx ON public.webauthn_credential USING btree (account_id) ; ' +
        'CREATE UNIQUE INDEX webauthn_credential_credential_id_key ON public.webauthn_credential USING btree (credential_id) ; ' +
        'CREATE UNIQUE INDEX webauthn_credential_pkey ON public.webauthn_credential USING btree (id)',
    );
  });

  test('no non-internal trigger (U-W2 (i): none refuses a decrease), no rewrite rule (T-196 QA2-F1), no row-level security and no policy (C2 (c))', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
           FROM pg_class c WHERE c.oid = 'public.webauthn_credential'::regclass`,
      ),
      '0 triggers, 0 rules, rls=false, force=false, 0 policies',
    );
  });

  test('COMMENT ON TABLE and COMMENT ON COLUMN sign_count are exactly these texts, and no other column carries one', async () => {
    assert.equal(
      await db.value(`SELECT obj_description('public.webauthn_credential'::regclass, 'pg_class')`),
      TABLE_COMMENT,
    );
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || col_description(attrelid, attnum), ' | ')
           FROM pg_attribute WHERE attrelid = 'public.webauthn_credential'::regclass AND attnum > 0
            AND col_description(attrelid, attnum) IS NOT NULL`,
      ),
      `sign_count=${SIGN_COUNT_COMMENT}`,
    );
  });
});

describe('0016 — credential_id UNIQUE across all accounts (SD 1825)', () => {
  test("app_rw registering account B's existing credential_id to account A is REFUSED by webauthn_credential_credential_id_key (23505)", async () => {
    assertRefusedBy(
      'duplicate credential_id across accounts',
      await asLogin(LOGINS.app_rw, insert(SCRATCH, { account: `'${ACCOUNT_A}'`, cred: B('b1') })),
      'ERROR:  23505: duplicate key value violates unique constraint "webauthn_credential_credential_id_key"',
      'CONSTRAINT NAME:  webauthn_credential_credential_id_key',
    );
  });

  test('the same credential_id twice on one account is REFUSED by webauthn_credential_credential_id_key (23505)', async () => {
    assertRefusedBy(
      'duplicate credential_id, same account',
      await asSuperuser(insert(SCRATCH, { cred: A1_CRED })),
      'ERROR:  23505: duplicate key value violates unique constraint "webauthn_credential_credential_id_key"',
      'CONSTRAINT NAME:  webauthn_credential_credential_id_key',
    );
  });

  test('a second credential with an existing id is REFUSED by webauthn_credential_pkey (23505)', async () => {
    assertRefusedBy(
      'duplicate id',
      await asSuperuser(insert(CRED_A1, { cred: B('99') })),
      'ERROR:  23505: duplicate key value violates unique constraint "webauthn_credential_pkey"',
      'CONSTRAINT NAME:  webauthn_credential_pkey',
    );
  });

  test('CONTROL — app_rw registers a third, distinct credential on account A (an account holds several passkeys)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      insert(SCRATCH, { cred: B('5c') }),
      `SELECT 'account A holds ' || count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}'`,
    );
    assertPermitted('third credential', r);
    assertRead('third credential', r, 'account A holds 3');
  });
});

describe('0016 — account_id REFERENCES account(id) ON DELETE CASCADE (SD 1824)', () => {
  test('app_rw inserting an unknown account_id is REFUSED by webauthn_credential_account_id_fkey (23503)', async () => {
    assertRefusedBy(
      'unknown account_id',
      await asLogin(LOGINS.app_rw, insert(SCRATCH, { account: `'${NO_SUCH_ACCOUNT}'` })),
      'ERROR:  23503: insert or update on table "webauthn_credential" violates foreign key constraint "webauthn_credential_account_id_fkey"',
      'CONSTRAINT NAME:  webauthn_credential_account_id_fkey',
    );
  });

  test("deleting an account as the superuser deletes its credentials and no other account's (the cascade)", async () => {
    const r = await asSuperuser(
      `SELECT 'before: B ' || (SELECT count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_B}') ||
              ', A ' || (SELECT count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}')`,
      `DELETE FROM public.account WHERE id = '${ACCOUNT_B}'`,
      `SELECT 'after: B ' || (SELECT count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_B}') ||
              ', A ' || (SELECT count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}') ||
              ', account B ' || (SELECT count(*) FROM public.account WHERE id = '${ACCOUNT_B}')`,
    );
    assertPermitted('account delete cascades', r);
    assertRead('account delete cascades', r, 'before: B 1, A 2');
    assertRead('account delete cascades', r, 'after: B 0, A 2, account B 0');
  });

  test('renaming a referenced account.id is REFUSED by webauthn_credential_account_id_fkey (23503): no ON UPDATE CASCADE', async () => {
    assertRefusedBy(
      'account id renamed',
      await asSuperuser(
        `UPDATE public.account SET id = '01K4T196ACCOUNTRENAMED0001' WHERE id = '${ACCOUNT_B}'`,
      ),
      'ERROR:  23503: update or delete on table "account" violates foreign key constraint "webauthn_credential_account_id_fkey" on table "webauthn_credential"',
      'CONSTRAINT NAME:  webauthn_credential_account_id_fkey',
    );
  });
});

describe('0016 — NOT NULL (23502, naming the column)', () => {
  const NULLS = [
    ['id', insert('NULL')],
    ['account_id', insert(SCRATCH, { account: 'NULL' })],
    ['credential_id', insert(SCRATCH, { cred: 'NULL' })],
    ['public_key', insert(SCRATCH, { key: 'NULL' })],
    ['sign_count', insert(SCRATCH, { count: 'NULL' })],
    [
      'created_at',
      `INSERT INTO public.webauthn_credential (id, account_id, credential_id, public_key, created_at)
         VALUES ('${SCRATCH}', '${ACCOUNT_A}', ${B('77')}, ${KEY}, NULL)`,
    ],
  ] as const;
  for (const [column, sql] of NULLS) {
    test(`${column} NULL is REFUSED (23502)`, async () => {
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(sql),
        `ERROR:  23502: null value in column "${column}" of relation "webauthn_credential" violates not-null constraint`,
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('CONTROL — app_rw: transports and aaguid NULL are accepted; an omitted sign_count is 0, created_at is now(), last_used_at is NULL', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `INSERT INTO public.webauthn_credential (id, account_id, credential_id, public_key, transports, aaguid)
         VALUES ('${SCRATCH}', '${ACCOUNT_A}', ${B('77')}, ${KEY}, NULL, NULL)`,
      `SELECT 'defaults: sign_count=' || sign_count || ' created_at=now():' || (created_at = now()) ||
              ' last_used_at null:' || (last_used_at IS NULL)
         FROM public.webauthn_credential WHERE id = '${SCRATCH}'`,
    );
    assertPermitted('nullable columns and defaults', r);
    assertRead(
      'nullable columns and defaults',
      r,
      'defaults: sign_count=0 created_at=now():true last_used_at null:true',
    );
  });
});

describe('0016 — sign_count BETWEEN 0 AND 4294967295: webauthn_credential_sign_count_range (U-W2, 23514)', () => {
  for (const value of ['-1', '4294967296']) {
    test(`app_rw INSERT with sign_count = ${value} is REFUSED by webauthn_credential_sign_count_range (23514)`, async () => {
      assertRefusedBy(
        `insert sign_count ${value}`,
        await asLogin(LOGINS.app_rw, insert(SCRATCH, { count: value })),
        RANGE_23514,
        RANGE_FIELD,
      );
    });

    test(`app_rw UPDATE (T-027 W4) setting sign_count = ${value} is REFUSED by webauthn_credential_sign_count_range (23514)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readRow(CRED_A1),
        `UPDATE public.webauthn_credential SET sign_count = ${value}, last_used_at = now() WHERE id = '${CRED_A1}'`,
      );
      assertRead(`update sign_count ${value}`, r, A1_BEFORE);
      assertRefusedBy(`update sign_count ${value}`, r, RANGE_23514, RANGE_FIELD);
    });
  }

  for (const value of ['0', '4294967295']) {
    test(`CONTROL — app_rw INSERT with sign_count = ${value} is accepted, and so is an UPDATE to it`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        insert(SCRATCH, { count: value }),
        `UPDATE public.webauthn_credential SET sign_count = ${value} WHERE id = '${CRED_A2}' RETURNING 'A2 now ' || sign_count`,
        `SELECT 'scratch ' || sign_count FROM public.webauthn_credential WHERE id = '${SCRATCH}'`,
      );
      assertPermitted(`sign_count ${value}`, r);
      assertRead(`sign_count ${value}`, r, `A2 now ${value}`);
      assertRead(`sign_count ${value}`, r, `scratch ${value}`);
    });
  }

  test('NOT REFUSED, as ruled (U-W2 (i): the library refuses it in T-202, no trigger does) — app_rw lowering sign_count from 10 to 9 is accepted', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(CRED_A1),
      `UPDATE public.webauthn_credential SET sign_count = sign_count - 1, last_used_at = now() WHERE id = '${CRED_A1}'
        RETURNING 'lowered to ' || sign_count`,
    );
    assertPermitted('decrease accepted', r);
    assertRead('decrease accepted', r, A1_BEFORE);
    assertRead('decrease accepted', r, 'lowered to 9');
  });
});

describe('0016 — app_rw: column-level INSERT and UPDATE, DELETE, no TRUNCATE (U-W4; T-196)', () => {
  test("app_rw holds INSERT on exactly T-027 W2's seven columns (not created_at, not last_used_at)", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || has_column_privilege('app_rw', 'public.webauthn_credential', attname, 'INSERT'),
                           ',' ORDER BY attnum)
           FROM pg_attribute WHERE attrelid = 'public.webauthn_credential'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id=true,account_id=true,credential_id=true,public_key=true,sign_count=true,transports=true,' +
        'aaguid=true,created_at=false,last_used_at=false',
    );
  });

  test('app_rw holds UPDATE on exactly sign_count and last_used_at (T-027 W4)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || has_column_privilege('app_rw', 'public.webauthn_credential', attname, 'UPDATE'),
                           ',' ORDER BY attnum)
           FROM pg_attribute WHERE attrelid = 'public.webauthn_credential'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id=false,account_id=false,credential_id=false,public_key=false,sign_count=true,transports=false,' +
        'aaguid=false,created_at=false,last_used_at=true',
    );
  });

  for (const [label, column, value] of [
    ['a back-dated created_at', 'created_at', "now() - interval '1 year'"],
    ['a credential inserted already used (last_used_at)', 'last_used_at', 'now()'],
  ] as const) {
    test(`app_rw INSERT naming ${column} (${label}) is REFUSED by the column grant (42501)`, async () => {
      assertRefused(
        `app_rw insert ${column}`,
        await asLogin(
          LOGINS.app_rw,
          `INSERT INTO public.webauthn_credential (id, account_id, credential_id, public_key, ${column})
             VALUES ('${SCRATCH}', '${ACCOUNT_A}', ${B('77')}, ${KEY}, ${value})`,
        ),
        { message: DENIED },
      );
    });
  }

  for (const [label, set] of [
    ['id changed', "id = '01K4T196CREDOTHERID0000001'"],
    ['account_id moved to another account (re-bound)', `account_id = '${ACCOUNT_B}'`],
    ['credential_id replaced (re-keyed)', `credential_id = ${B('55')}`],
    ['public_key replaced (re-keyed)', `public_key = ${B('c1', 77)}`],
    ['transports replaced', "transports = ARRAY['usb']"],
    ['aaguid replaced', "aaguid = '00000000-0000-0000-0000-000000000000'"],
    ['created_at moved', "created_at = created_at - interval '1 day'"],
  ] as const) {
    test(`app_rw UPDATE: ${label} is REFUSED by the column grant (42501)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readRow(CRED_A1),
        `UPDATE public.webauthn_credential SET ${set} WHERE id = '${CRED_A1}'`,
      );
      assertRead(`app_rw ${label}`, r, A1_BEFORE);
      assertRefused(`app_rw ${label}`, r, { message: DENIED });
    });
  }

  test('CONTROL — app_rw runs T-027 W1, W2, W3 (SELECT … FOR UPDATE), W4, W5 and W6 (the account predicate)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'W1 ' || count(*) FROM (SELECT credential_id, transports FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}') s`,
      insert(SCRATCH, { cred: B('5d'), count: '3' }),
      `SELECT 'W3 locked ' || id || ' count ' || sign_count FROM public.webauthn_credential WHERE credential_id = ${A1_CRED} FOR UPDATE`,
      `UPDATE public.webauthn_credential SET sign_count = 11, last_used_at = now() WHERE id = '${CRED_A1}' RETURNING 'W4 ' || sign_count`,
      `SELECT 'W5 ' || EXISTS (SELECT 1 FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}')`,
      `SELECT 'W6 own ' || count(*) FROM (SELECT id FROM public.webauthn_credential WHERE credential_id = ${A1_CRED} AND account_id = '${ACCOUNT_A}' FOR UPDATE) s`,
      `SELECT 'W6 other ' || count(*) FROM (SELECT id FROM public.webauthn_credential WHERE credential_id = ${A1_CRED} AND account_id = '${ACCOUNT_B}' FOR UPDATE) s`,
    );
    assertPermitted('W1-W6', r);
    assertRead('W1-W6', r, 'W1 2');
    assertRead('W1-W6', r, `W3 locked ${CRED_A1} count 10`);
    assertRead('W1-W6', r, 'W4 11');
    assertRead('W1-W6', r, 'W5 true');
    assertRead('W1-W6', r, 'W6 own 1');
    assertRead('W1-W6', r, 'W6 other 0');
  });

  test('CONTROL — app_rw DELETE (U-W4): W7 removes exactly one passkey; an erasure-shaped DELETE by account removes the rest', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `DELETE FROM public.webauthn_credential WHERE id = '${CRED_A2}' AND account_id = '${ACCOUNT_A}' RETURNING 'W7 removed ' || id`,
      `SELECT 'A left ' || count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}'`,
      `WITH d AS (DELETE FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}' RETURNING 1)
       SELECT 'erasure removed ' || count(*) FROM d`,
      `SELECT 'after: A ' || (SELECT count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_A}') ||
              ', B ' || (SELECT count(*) FROM public.webauthn_credential WHERE account_id = '${ACCOUNT_B}')`,
    );
    assertPermitted('app_rw DELETE', r);
    assertRead('app_rw DELETE', r, `W7 removed ${CRED_A2}`);
    assertRead('app_rw DELETE', r, 'A left 1');
    assertRead('app_rw DELETE', r, 'erasure removed 1');
    assertRead('app_rw DELETE', r, 'after: A 0, B 1');
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefused(
      'app_rw TRUNCATE',
      await asLogin(LOGINS.app_rw, 'TRUNCATE public.webauthn_credential'),
      { message: DENIED },
    );
  });
});

describe('0016 — no other role reads or writes it (C2 (c); T-020 § contract §3), over real single-membership logins', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefused(
        `${role} SELECT`,
        await asLogin(LOGINS[role], 'SELECT count(*) FROM public.webauthn_credential'),
        { message: DENIED },
      );
    });
  }

  for (const [what, sql] of [
    ['INSERT', insert(SCRATCH)],
    ['UPDATE', `UPDATE public.webauthn_credential SET sign_count = 0 WHERE id = '${CRED_A1}'`],
    ['DELETE', `DELETE FROM public.webauthn_credential WHERE id = '${CRED_A1}'`],
  ] as const) {
    test(`app_admin_rw ${what} is REFUSED (42501)`, async () => {
      assertRefused(`app_admin_rw ${what}`, await asLogin(LOGINS.app_admin_rw, sql), {
        message: DENIED,
      });
    });
  }

  test('CONTROL — app_rw SELECTs webauthn_credential', async () => {
    const r = await asLogin(LOGINS.app_rw, readRow(CRED_A1));
    assertPermitted('app_rw SELECT', r);
    assertRead('app_rw SELECT', r, A1_BEFORE);
  });
});

describe('0016 — NOT HELD (disclosed): the grants bind app_rw only, not the owner app_ddl or the superuser', () => {
  test('an app_ddl-only login (the owner) re-binds a credential to another account, and the superuser re-keys one: both accepted', async () => {
    const owner = await asLogin(
      LOGINS.app_ddl,
      readRow(CRED_A1),
      `UPDATE public.webauthn_credential SET account_id = '${ACCOUNT_B}', created_at = created_at - interval '1 day'
        WHERE id = '${CRED_A1}' RETURNING 'owner moved to ' || account_id`,
    );
    assertPermitted('owner re-binds', owner);
    assertRead('owner re-binds', owner, A1_BEFORE);
    assertRead('owner re-binds', owner, `owner moved to ${ACCOUNT_B}`);
    const su = await asSuperuser(
      readRow(CRED_A1),
      `UPDATE public.webauthn_credential SET credential_id = ${B('55')}, public_key = ${B('c1', 77)}
        WHERE id = '${CRED_A1}' RETURNING 'superuser re-keyed ' || id`,
    );
    assertPermitted('superuser re-keys', su);
    assertRead('superuser re-keys', su, A1_BEFORE);
    assertRead('superuser re-keys', su, `superuser re-keyed ${CRED_A1}`);
  });

  test('the fixture rows survive every refusal and rolled-back write above: three credentials, CRED_A1 unchanged', async () => {
    assert.equal(
      await db.value(
        `SELECT count(*) || '|' || (SELECT account_id || ',' || sign_count || ',' || (last_used_at IS NULL)
                                      FROM public.webauthn_credential WHERE id = '${CRED_A1}')
           FROM public.webauthn_credential`,
      ),
      `3|${ACCOUNT_A},10,true`,
    );
  });
});

describe('0016 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON webauthn_credential TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.webauthn_credential TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.webauthn_credential'),
      `the guard's DETAIL does not name webauthn_credential.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.webauthn_credential', 'SELECT')::text`,
      ),
      'false',
    );
  });

  test('after up the guard, called DIRECTLY, returns clean', async () => {
    assertPermitted(
      'direct guard call',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  test('the same direct call raises on a known-bad state (a detective-only grant, rolled back)', async () => {
    const r = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'SELECT kinvara_guard.assert_answering_service_write_only()',
    );
    assertRefused('guard on a known-bad state', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(r.output.includes('answering_service holds TEMPORARY on database kinvara'), r.output);
    assert.equal(
      await db.value(
        `SELECT has_database_privilege('answering_service', 'kinvara', 'TEMPORARY')::text`,
      ),
      'false',
    );
  });
});
