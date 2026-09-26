/**
 * T-195 — `public.magic_link` (migration 0015): SD §DB-2 lines 1837–1840 plus the accepted OE-30 /
 * OE-49 / OE-50 rulings (tasks/state/EP-2/OE-30-34-rulings.md Part A.1 U-M1/U-M2, Part E.1 U-M4,
 * Part B.2 Q-D2, Part B.3 U-M6, Part F), and T-194's otp_challenge pattern where no ruling speaks
 * (column-level grants, single use set once, fixed columns). These are the database-layer refusals
 * TK-2 lists, plus KV066–KV068.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field (or the trigger's CONTEXT
 * line), so a crash, a syntax error or a refusal for another reason cannot read as this one. Each
 * rule has a CONTROL beside it.
 *
 * Every UPDATE refusal and control first reads its target row in the same psql session and asserts
 * that reading, so an UPDATE that matched no row can pass for neither a refusal nor a control.
 *
 * Privilege refusals, and the single-use trigger's refusals, run over REAL LOGIN principals, each a
 * member of exactly one role (T-020 Evidence §4). Constraint refusals run as the superuser, so no
 * privilege is what refuses them.
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

const SUITE = 'magic-link';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't195_app_rw_probe',
  app_admin_rw: 't195_app_admin_rw_probe',
  app_safety_rw: 't195_app_safety_rw_probe',
  answering_service: 't195_answering_service_probe',
} as const;

/** Fixture ids, each exactly `char(26)` wide. */
const ACCOUNT_A = '01K4T195ACCOUNTA0000000001';
const ACCOUNT_B = '01K4T195ACCOUNTB0000000001';
const LIVE = '01K4T195LINKLIVE0000000001';
const CONSUMED = '01K4T195LINKCONSUMED000001';
const OF_B = '01K4T195LINKOFB00000000001';
const SCRATCH = '01K4T195LINKSCRATCH0000001';
const NO_SUCH_ACCOUNT = '01K4T195NOSUCHACCOUNT00001';
for (const id of [ACCOUNT_A, ACCOUNT_B, LIVE, CONSUMED, OF_B, SCRATCH, NO_SUCH_ACCOUNT]) {
  assert.equal(id.length, 26, `fixture id ${id} is not char(26) wide`);
}

/** 32-byte digest stand-ins, distinct per fixture; `sha256(…)` is used where the shape matters. */
const H = (byte: string, n = 32): string => `decode(repeat('${byte}', ${String(n)}), 'hex')`;
const LIVE_HASH = H('ab');

/** T-027 M1's INSERT: exactly the five columns app_rw may write. */
const insert = (
  id: string,
  opts: { account?: string; hash?: string; expires?: string; fingerprint?: string } = {},
): string =>
  `INSERT INTO public.magic_link (id, account_id, token_hash, expires_at, requested_device_fingerprint) VALUES (${
    id === 'NULL' ? 'NULL' : `'${id}'`
  }, ${opts.account ?? `'${ACCOUNT_A}'`}, ${opts.hash ?? H('77')}, ${
    opts.expires ?? `now() + interval '10 minutes'`
  }, ${opts.fingerprint ?? `'fp-1'`})`;

/** One row's consumed state, read in the session that then writes it. */
const readRow = (id: string): string =>
  `SELECT 'row ' || count(*) || ' consumed=' || coalesce(string_agg((consumed_at IS NOT NULL)::text, ','), '-')
     FROM public.magic_link WHERE id = '${id}'`;

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
         ('${ACCOUNT_A}', '01K4T195PSEUDOA00000000001', 'v1'),
         ('${ACCOUNT_B}', '01K4T195PSEUDOB00000000001', 'v1')`,
      insert(LIVE, { hash: LIVE_HASH }),
      insert(CONSUMED, { hash: H('cd') }),
      `UPDATE public.magic_link SET consumed_at = now() WHERE id = '${CONSUMED}'`,
      insert(OF_B, { account: `'${ACCOUNT_B}'`, hash: H('01') }),
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

const TRIGGER_CONTEXT = 'CONTEXT:  PL/pgSQL function public.assert_magic_link_single_use()';
const DENIED = 'ERROR:  42501: permission denied for table magic_link';

describe('0015 — the table, its owner, its columns, its constraints and its ACL', () => {
  test("SD's six columns in SD's order, no defaults; owner app_ddl; ACL: app_rw SELECT, INSERT on five columns, UPDATE on consumed_at", async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.magic_link'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = c.oid AND attacl IS NOT NULL)
           FROM pg_class c WHERE c.oid = 'public.magic_link'::regclass`,
      ),
      'id:character(26):nn:-,account_id:character(26):nn:-,token_hash:bytea:nn:-,' +
        'expires_at:timestamp with time zone:nn:-,consumed_at:timestamp with time zone:null:-,' +
        'requested_device_fingerprint:text:null:-' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}' +
        '|id={app_rw=a/app_ddl},account_id={app_rw=a/app_ddl},token_hash={app_rw=a/app_ddl},' +
        'expires_at={app_rw=a/app_ddl},consumed_at={app_rw=w/app_ddl},' +
        'requested_device_fingerprint={app_rw=a/app_ddl}',
    );
  });

  test('the key, UNIQUE, FOREIGN KEY and CHECK constraints are exactly these, by these definitions', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'public.magic_link'::regclass AND contype IN ('p', 'u', 'f', 'c')`,
      ),
      'magic_link_account_id_fkey=FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE ; ' +
        'magic_link_pkey=PRIMARY KEY (id) ; ' +
        'magic_link_token_hash_key=UNIQUE (token_hash) ; ' +
        'magic_link_token_hash_length_check=CHECK ((octet_length(token_hash) = 32))',
    );
  });

  test('magic_link carries exactly one non-internal trigger: AFTER UPDATE single use', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(tgname || ':' || tgtype || ':' || tgfoid::regprocedure::text, ',' ORDER BY tgname)
           FROM pg_trigger WHERE tgrelid = 'public.magic_link'::regclass AND NOT tgisinternal`,
      ),
      'trg_magic_link_single_use:17:assert_magic_link_single_use()',
    );
  });
});

describe('0015 — token_hash: UNIQUE (SD 1838) and 32 bytes (Q-D2, EV-9)', () => {
  test('a second link with an existing token_hash is REFUSED by magic_link_token_hash_key (23505)', async () => {
    assertRefusedBy(
      'duplicate token_hash',
      await asSuperuser(insert(SCRATCH, { hash: LIVE_HASH })),
      'ERROR:  23505: duplicate key value violates unique constraint "magic_link_token_hash_key"',
      'CONSTRAINT NAME:  magic_link_token_hash_key',
    );
  });

  test('a second link with an existing id is REFUSED by magic_link_pkey (23505)', async () => {
    assertRefusedBy(
      'duplicate id',
      await asSuperuser(insert(LIVE, { hash: H('99') })),
      'ERROR:  23505: duplicate key value violates unique constraint "magic_link_pkey"',
      'CONSTRAINT NAME:  magic_link_pkey',
    );
  });

  for (const n of [0, 31, 33, 64]) {
    test(`a token_hash of ${String(n)} bytes is REFUSED by magic_link_token_hash_length_check (23514)`, async () => {
      assertRefusedBy(
        `${String(n)}-byte token_hash`,
        await asSuperuser(insert(SCRATCH, { hash: H('ab', n) })),
        'ERROR:  23514: new row for relation "magic_link" violates check constraint "magic_link_token_hash_length_check"',
        'CONSTRAINT NAME:  magic_link_token_hash_length_check',
      );
    });
  }

  test('CONTROL — a SHA-256 digest of a 256-bit token is accepted (U-M2)', async () => {
    assertPermitted(
      'sha256 token_hash',
      await asSuperuser(
        'BEGIN',
        insert(SCRATCH, { hash: 'sha256(gen_random_bytes(32))' }),
        'ROLLBACK',
      ),
    );
  });
});

describe('0015 — account_id REFERENCES account(id) ON DELETE CASCADE (U-M1)', () => {
  test('an unknown account_id is REFUSED by magic_link_account_id_fkey (23503)', async () => {
    assertRefusedBy(
      'unknown account_id',
      await asSuperuser(insert(SCRATCH, { account: `'${NO_SUCH_ACCOUNT}'` })),
      'ERROR:  23503: insert or update on table "magic_link" violates foreign key constraint "magic_link_account_id_fkey"',
      'CONSTRAINT NAME:  magic_link_account_id_fkey',
    );
  });

  test("deleting an account as the superuser deletes its links and no other account's (the cascade)", async () => {
    const r = await asSuperuser(
      `SELECT 'before: B ' || (SELECT count(*) FROM public.magic_link WHERE account_id = '${ACCOUNT_B}') ||
              ', A ' || (SELECT count(*) FROM public.magic_link WHERE account_id = '${ACCOUNT_A}')`,
      `DELETE FROM public.account WHERE id = '${ACCOUNT_B}'`,
      `SELECT 'after: B ' || (SELECT count(*) FROM public.magic_link WHERE account_id = '${ACCOUNT_B}') ||
              ', A ' || (SELECT count(*) FROM public.magic_link WHERE account_id = '${ACCOUNT_A}') ||
              ', account B ' || (SELECT count(*) FROM public.account WHERE id = '${ACCOUNT_B}')`,
    );
    assertPermitted('account delete cascades', r);
    assertRead('account delete cascades', r, 'before: B 1, A 2');
    assertRead('account delete cascades', r, 'after: B 0, A 2, account B 0');
  });

  test('renaming a referenced account.id is REFUSED by magic_link_account_id_fkey (23503): no ON UPDATE CASCADE', async () => {
    assertRefusedBy(
      'account id renamed',
      await asSuperuser(
        `UPDATE public.account SET id = '01K4T195ACCOUNTRENAMED0001' WHERE id = '${ACCOUNT_A}'`,
      ),
      'ERROR:  23503: update or delete on table "account" violates foreign key constraint "magic_link_account_id_fkey" on table "magic_link"',
      'CONSTRAINT NAME:  magic_link_account_id_fkey',
    );
  });

  test('CONTROL — app_rw inserts a link for an existing account (the FK check needs no grant on account)', async () => {
    const r = await asLogin(LOGINS.app_rw, 'BEGIN', insert(SCRATCH), readRow(SCRATCH), 'ROLLBACK');
    assertPermitted('app_rw insert', r);
    assertRead('app_rw insert', r, 'row 1 consumed=false');
  });
});

describe('0015 — the U-M4 index (rulings E.1)', () => {
  test('magic_link_account_id_live_idx is (account_id) WHERE consumed_at IS NULL', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(pg_get_indexdef(to_regclass('public.magic_link_account_id_live_idx')), '(absent)')`,
      ),
      'CREATE INDEX magic_link_account_id_live_idx ON public.magic_link USING btree (account_id) WHERE (consumed_at IS NULL)',
    );
  });
});

describe('0015 — NOT NULL (23502, naming the column)', () => {
  for (const column of ['id', 'account_id', 'token_hash', 'expires_at'] as const) {
    test(`${column} NULL is REFUSED (23502)`, async () => {
      const sql =
        column === 'id'
          ? insert('NULL')
          : column === 'account_id'
            ? insert(SCRATCH, { account: 'NULL' })
            : column === 'token_hash'
              ? insert(SCRATCH, { hash: 'NULL' })
              : insert(SCRATCH, { expires: 'NULL' });
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(sql),
        `ERROR:  23502: null value in column "${column}" of relation "magic_link" violates not-null constraint`,
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('CONTROL — requested_device_fingerprint NULL is accepted', async () => {
    assertPermitted(
      'fingerprint NULL',
      await asSuperuser('BEGIN', insert(SCRATCH, { fingerprint: 'NULL' }), 'ROLLBACK'),
    );
  });
});

describe('0015 — single use, set once: trg_magic_link_single_use (KV066, KV067), as the app_rw login', () => {
  test("CONTROL — app_rw runs T-027's M1, M2 (atomic consume), M3 and U-M4's invalidation", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      'BEGIN',
      insert(SCRATCH),
      `UPDATE public.magic_link SET consumed_at = now()
          WHERE token_hash = ${H('77')} AND consumed_at IS NULL AND expires_at > now()
        RETURNING 'consumed for ' || account_id || ' fp=' || requested_device_fingerprint`,
      `SELECT 'lookup used=' || (consumed_at IS NOT NULL) FROM public.magic_link WHERE token_hash = ${H('77')}`,
      `UPDATE public.magic_link SET consumed_at = now()
          WHERE account_id = '${ACCOUNT_A}' AND consumed_at IS NULL AND expires_at > now()
        RETURNING 'invalidated ' || id`,
      readRow(LIVE),
      'ROLLBACK',
    );
    assertPermitted('M1-M3, U-M4', r);
    assertRead('M1-M3, U-M4', r, `consumed for ${ACCOUNT_A} fp=fp-1`);
    assertRead('M1-M3, U-M4', r, 'lookup used=true');
    assertRead('M1-M3, U-M4', r, `invalidated ${LIVE}`);
    assertRead('M1-M3, U-M4', r, 'row 1 consumed=true');
  });

  test('a consumed link returning to unconsumed (consumed_at -> NULL) is REFUSED KV066', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(CONSUMED),
      `UPDATE public.magic_link SET consumed_at = NULL WHERE id = '${CONSUMED}'`,
    );
    assertRead('consumed_at -> NULL', r, 'row 1 consumed=true');
    assertRefusedBy(
      'consumed_at -> NULL',
      r,
      'ERROR:  KV066: MAGIC_LINK_CONSUMED_AT_CLEARED: a consumed magic_link row cannot return to unconsumed',
      TRIGGER_CONTEXT,
    );
  });

  test('the same, as the superuser, is REFUSED KV066 (the trigger is not a grant)', async () => {
    const r = await asSuperuser(
      readRow(CONSUMED),
      `UPDATE public.magic_link SET consumed_at = NULL WHERE id = '${CONSUMED}'`,
    );
    assertRead('consumed_at -> NULL as superuser', r, 'row 1 consumed=true');
    assertRefusedBy(
      'consumed_at -> NULL as superuser',
      r,
      'ERROR:  KV066: MAGIC_LINK_CONSUMED_AT_CLEARED:',
      TRIGGER_CONTEXT,
    );
  });

  test('a consumed link given another consumed_at is REFUSED KV067', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(CONSUMED),
      `UPDATE public.magic_link SET consumed_at = consumed_at + interval '1 second' WHERE id = '${CONSUMED}'`,
    );
    assertRead('consumed_at rewritten', r, 'row 1 consumed=true');
    assertRefusedBy(
      'consumed_at rewritten',
      r,
      'ERROR:  KV067: MAGIC_LINK_CONSUMED_AT_REWRITTEN: a consumed magic_link row keeps its consumed_at',
      TRIGGER_CONTEXT,
    );
  });

  test('an invalidation without "AND consumed_at IS NULL" over an account holding a consumed link is REFUSED KV067', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(CONSUMED),
      `UPDATE public.magic_link SET consumed_at = now() WHERE account_id = '${ACCOUNT_A}'`,
    );
    assertRead('unfiltered invalidation', r, 'row 1 consumed=true');
    assertRefusedBy(
      'unfiltered invalidation',
      r,
      'ERROR:  KV067: MAGIC_LINK_CONSUMED_AT_REWRITTEN:',
      TRIGGER_CONTEXT,
    );
  });

  test("CONTROL — writing a consumed link's consumed_at to its own value, and locking it FOR UPDATE, are accepted", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      'BEGIN',
      `SELECT 'locked ' || id FROM public.magic_link WHERE id = '${CONSUMED}' FOR UPDATE`,
      `UPDATE public.magic_link SET consumed_at = consumed_at WHERE id = '${CONSUMED}' RETURNING 'updated ' || id`,
      'ROLLBACK',
    );
    assertPermitted('consumed_at unchanged', r);
    assertRead('consumed_at unchanged', r, `locked ${CONSUMED}`);
    assertRead('consumed_at unchanged', r, `updated ${CONSUMED}`);
  });
});

describe('0015 — fixed columns: only consumed_at changes after insert (KV068; the column grants)', () => {
  test('app_rw holds UPDATE on consumed_at and on no other column', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || has_column_privilege('app_rw', 'public.magic_link', attname, 'UPDATE'),
                           ',' ORDER BY attnum)
           FROM pg_attribute WHERE attrelid = 'public.magic_link'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id=false,account_id=false,token_hash=false,expires_at=false,consumed_at=true,' +
        'requested_device_fingerprint=false',
    );
  });

  test('app_rw holds INSERT on every column but consumed_at', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || has_column_privilege('app_rw', 'public.magic_link', attname, 'INSERT'),
                           ',' ORDER BY attnum)
           FROM pg_attribute WHERE attrelid = 'public.magic_link'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id=true,account_id=true,token_hash=true,expires_at=true,consumed_at=false,' +
        'requested_device_fingerprint=true',
    );
  });

  test('app_rw INSERT naming consumed_at (a link inserted already consumed) is REFUSED by the column grant (42501)', async () => {
    assertRefused(
      'app_rw insert consumed',
      await asLogin(
        LOGINS.app_rw,
        `INSERT INTO public.magic_link (id, account_id, token_hash, expires_at, consumed_at)
           VALUES ('${SCRATCH}', '${ACCOUNT_A}', ${H('77')}, now() + interval '10 minutes', now())`,
      ),
      { message: DENIED },
    );
  });

  const FIXED = [
    ['id changed', "id = '01K4T195LINKOTHERID0000001'"],
    ['account_id moved to another account', `account_id = '${ACCOUNT_B}'`],
    ['token_hash replaced (re-keyed)', `token_hash = ${H('55')}`],
    ['expires_at extended (re-armed)', "expires_at = expires_at + interval '1 year'"],
    ['requested_device_fingerprint replaced (re-bound)', "requested_device_fingerprint = 'fp-other'"],
  ] as const;

  for (const [label, set] of FIXED) {
    test(`app_rw: ${label} is REFUSED by the column grant (42501)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readRow(LIVE),
        `UPDATE public.magic_link SET ${set} WHERE id = '${LIVE}'`,
      );
      assertRead(`app_rw ${label}`, r, 'row 1 consumed=false');
      assertRefused(`app_rw ${label}`, r, { message: DENIED });
    });
  }

  for (const [label, set] of FIXED) {
    test(`a writer the grant does not bind (the superuser): ${label} is REFUSED KV068`, async () => {
      const r = await asSuperuser(
        readRow(LIVE),
        `UPDATE public.magic_link SET ${set} WHERE id = '${LIVE}'`,
      );
      assertRead(`superuser ${label}`, r, 'row 1 consumed=false');
      assertRefusedBy(
        `superuser ${label}`,
        r,
        'ERROR:  KV068: MAGIC_LINK_FIXED_COLUMN: only consumed_at may change after a magic_link row is inserted',
        TRIGGER_CONTEXT,
      );
    });
  }

  test('CONTROL — the superuser consuming a live link (only consumed_at changes) is accepted', async () => {
    const r = await asSuperuser(
      readRow(LIVE),
      `UPDATE public.magic_link SET consumed_at = now() WHERE id = '${LIVE}' RETURNING 'consumed ' || id`,
    );
    assertPermitted('superuser consume', r);
    assertRead('superuser consume', r, `consumed ${LIVE}`);
  });
});

describe('0015 — grants (U-M6, EV-10; T-020 § contract §3), over real single-membership logins', () => {
  for (const [what, sql] of [
    ['DELETE', `DELETE FROM public.magic_link WHERE id = '${LIVE}'`],
    ['TRUNCATE', 'TRUNCATE public.magic_link'],
  ] as const) {
    test(`app_rw ${what} is REFUSED (42501)`, async () => {
      assertRefused(`app_rw ${what}`, await asLogin(LOGINS.app_rw, sql), { message: DENIED });
    });
  }

  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefused(
        `${role} SELECT`,
        await asLogin(LOGINS[role], 'SELECT count(*) FROM public.magic_link'),
        { message: DENIED },
      );
    });
  }

  test('CONTROL — app_rw SELECTs magic_link', async () => {
    const r = await asLogin(LOGINS.app_rw, readRow(LIVE));
    assertPermitted('app_rw SELECT', r);
    assertRead('app_rw SELECT', r, 'row 1 consumed=false');
  });

  test('the rows survive every refusal above: three fixture links, LIVE still unconsumed', async () => {
    assert.equal(
      await db.value(
        `SELECT count(*) || '|' || (SELECT (consumed_at IS NULL)::text FROM public.magic_link WHERE id = '${LIVE}')
           FROM public.magic_link`,
      ),
      '3|true',
    );
  });
});

describe('0015 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON magic_link TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.magic_link TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.magic_link'),
      `the guard's DETAIL does not name magic_link.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.magic_link', 'SELECT')::text`,
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
