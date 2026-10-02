/**
 * T-213 — `public.audit_anchor` (migration 0019): P-AUDIT-ANCHOR of
 * tasks/state/EP-8b/OD-226-cut.md, T-067's MR-2, built against OE-34 Part C as OE-50 accepted it
 * (U-1 identity key, U-11 (2a) UNIQUE (head_seq), U-5 (5) 32-byte head_hash, U-7/U-8 no other
 * role, no RLS). V-A1: an anchor record is never rewritten or removed by an application role.
 *
 * gate:migration-lint's R-APPEND-ONLY does not cover this table's name (D-11, OD-143, OD-264), so
 * these database refusals are its guard.
 *
 * What the database does NOT refuse is pinned too, each in a case named NOT HELD: head_seq
 * monotonicity (U-11 (4), the verifier's), head_hash content, s3_key uniqueness and format, and
 * every write by the owner app_ddl or the superuser beyond the UNIQUE, the CHECK and the NOT NULLs.
 * The catalogue reads (columns, identity, constraints, indexes, the identity sequence, table and
 * column ACLs, the comment, and the counts of triggers, rewrite rules, policies and both
 * row-level-security flags) turn red if a grant, a constraint, a trigger, a rule or a policy is
 * added to or removed from the table.
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

const SUITE = 'audit-anchor';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't213_app_rw_probe',
  app_admin_rw: 't213_app_admin_rw_probe',
  app_safety_rw: 't213_app_safety_rw_probe',
  answering_service: 't213_answering_service_probe',
  app_ddl: 't213_app_ddl_probe',
} as const;

/** A SHA-256 digest (32 bytes) as SQL, distinct per label. */
const digest = (label: string): string => `sha256('${label}'::bytea)`;
/** A bytea of exactly n bytes, as SQL (n <= 64). */
const bytesOf = (n: number): string =>
  `substring(${digest('long')} || ${digest('longer')} from 1 for ${String(n)})`;

/** The S3 key U-11 (1) gives a head_seq (the job's scheme; the table does not check it). */
const keyOf = (headSeq: number): string => `'audit-anchor/${String(headSeq).padStart(20, '0')}'`;

/** T-067 Q6, the anchor record: exactly the three columns app_rw may write. */
const anchor = (headSeq: string, headHash: string, s3Key: string): string =>
  `INSERT INTO public.audit_anchor (head_seq, head_hash, s3_key) VALUES (${headSeq}, ${headHash}, ${s3Key})`;

/** The two fixture anchors: head_seq 100 and 200. */
const FIXTURE_A = 100;
const FIXTURE_B = 200;

/** One fixture row's state, read in the session that then writes it. */
const readRow = (headSeq: number): string =>
  `SELECT 'anchor ${String(headSeq)} count=' || count(*) || ' hash32=' || coalesce(string_agg((octet_length(head_hash) = 32)::text, ','), '-')
     FROM public.audit_anchor WHERE head_seq = ${String(headSeq)}`;
const PRESENT = (headSeq: number): string => `anchor ${String(headSeq)} count=1 hash32=true`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      anchor(String(FIXTURE_A), digest('head-100'), keyOf(FIXTURE_A)),
      anchor(String(FIXTURE_B), digest('head-200'), keyOf(FIXTURE_B)),
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

const DENIED = 'ERROR:  42501: permission denied for table audit_anchor';
const IDENTITY_428C9 = 'ERROR:  428C9: cannot insert a non-DEFAULT value into column "id"';
const UNIQUE_23505 =
  'ERROR:  23505: duplicate key value violates unique constraint "audit_anchor_head_seq_key"';
const UNIQUE_FIELD = 'CONSTRAINT NAME:  audit_anchor_head_seq_key';
const CHECK_23514 =
  'ERROR:  23514: new row for relation "audit_anchor" violates check constraint "audit_anchor_head_hash_len"';
const CHECK_FIELD = 'CONSTRAINT NAME:  audit_anchor_head_hash_len';
const notNull = (column: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "audit_anchor" violates not-null constraint`;

/** The text 0019 installs, verbatim: a change to the comment must change this suite too. */
const TABLE_COMMENT =
  'The ledger of hourly audit-chain anchors (SD §DB-10 lines 2856-2859; SA §SEC-8). The anchor itself is the S3 ' +
  'object under Object Lock; this table records it, and under OE-50 U-12 (2) a verifier compares against the S3 ' +
  'object, not this table. id is ' +
  'an identity column, GENERATED ALWAYS. UNIQUE audit_anchor_head_seq_key: one row per chain head. CHECK ' +
  'audit_anchor_head_hash_len: head_hash is 32 bytes. app_rw may SELECT and may INSERT only head_seq, head_hash ' +
  'and s3_key, so anchored_at takes now() for it. It holds no UPDATE, DELETE or TRUNCATE. These are grants: they ' +
  'bind app_rw, not the table owner app_ddl or the superuser. The database does not check that head_seq ' +
  'increases, that head_hash matches the chain, or anything about s3_key beyond NOT NULL. No other role is ' +
  'granted any ' +
  'privilege, and there is no row-level security.';

describe('0019 — the table, its owner, columns, identity, constraints, indexes, ACL and comment', () => {
  test('five columns in order, types, nullability, identity and defaults; owner app_ddl; ACL: app_rw SELECT, INSERT on head_seq, head_hash and s3_key only', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   CASE attidentity WHEN 'a' THEN 'identity-always' WHEN 'd' THEN 'identity-by-default' ELSE '-' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.audit_anchor'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = c.oid AND attacl IS NOT NULL)
           FROM pg_class c WHERE c.oid = 'public.audit_anchor'::regclass`,
      ),
      'id:bigint:nn:identity-always:-,head_seq:bigint:nn:-:-,head_hash:bytea:nn:-:-,s3_key:text:nn:-:-,' +
        'anchored_at:timestamp with time zone:nn:-:now()' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}' +
        '|head_seq={app_rw=a/app_ddl},head_hash={app_rw=a/app_ddl},s3_key={app_rw=a/app_ddl}',
    );
  });

  test('the primary key, the UNIQUE (not deferrable), the CHECK and the five NOT NULLs are exactly these, by these definitions', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid) || ' deferrable=' || condeferrable, ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'public.audit_anchor'::regclass`,
      ),
      'audit_anchor_anchored_at_not_null=NOT NULL anchored_at deferrable=false ; ' +
        'audit_anchor_head_hash_len=CHECK ((octet_length(head_hash) = 32)) deferrable=false ; ' +
        'audit_anchor_head_hash_not_null=NOT NULL head_hash deferrable=false ; ' +
        'audit_anchor_head_seq_key=UNIQUE (head_seq) deferrable=false ; ' +
        'audit_anchor_head_seq_not_null=NOT NULL head_seq deferrable=false ; ' +
        'audit_anchor_id_not_null=NOT NULL id deferrable=false ; ' +
        'audit_anchor_pkey=PRIMARY KEY (id) deferrable=false ; ' +
        'audit_anchor_s3_key_not_null=NOT NULL s3_key deferrable=false',
    );
  });

  test('the only indexes are the primary key and audit_anchor_head_seq_key UNIQUE (head_seq); none on s3_key', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid = 'public.audit_anchor'::regclass`,
      ),
      'CREATE UNIQUE INDEX audit_anchor_head_seq_key ON public.audit_anchor USING btree (head_seq) ; ' +
        'CREATE UNIQUE INDEX audit_anchor_pkey ON public.audit_anchor USING btree (id)',
    );
  });

  test('the identity sequence is audit_anchor_id_seq: bigint, from 1 by 1 to 2^63-1, no cycle, owned by app_ddl, granted to no role', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_serial_sequence('public.audit_anchor', 'id') || '|' || s.seqtypid::regtype || ' start=' || s.seqstart ||
                ' inc=' || s.seqincrement || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cycle=' || s.seqcycle ||
                '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, 'acl-null')
           FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid
          WHERE c.oid = pg_get_serial_sequence('public.audit_anchor', 'id')::regclass`,
      ),
      'public.audit_anchor_id_seq|bigint start=1 inc=1 min=1 max=9223372036854775807 cycle=false|app_ddl|acl-null',
    );
  });

  test('no non-internal trigger, no rewrite rule, row-level security neither enabled nor forced, and no policy', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
           FROM pg_class c WHERE c.oid = 'public.audit_anchor'::regclass`,
      ),
      '0 triggers, 0 rules, rls=false, force=false, 0 policies',
    );
  });

  test('COMMENT ON TABLE is exactly this text, and no column carries a comment', async () => {
    assert.equal(
      await db.value(`SELECT obj_description('public.audit_anchor'::regclass, 'pg_class')`),
      TABLE_COMMENT,
    );
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.audit_anchor'::regclass
            AND attnum > 0 AND col_description(attrelid, attnum) IS NOT NULL`,
      ),
      '0',
    );
  });
});

describe('0019 — id is GENERATED ALWAYS AS IDENTITY (U-1)', () => {
  test('app_rw supplying an explicit id is REFUSED by the identity (428C9), not by a privilege', async () => {
    assertRefusedBy(
      'app_rw explicit id',
      await asLogin(
        LOGINS.app_rw,
        `INSERT INTO public.audit_anchor (id, head_seq, head_hash, s3_key) VALUES (1, 301, ${digest('x')}, ${keyOf(301)})`,
      ),
      IDENTITY_428C9,
    );
  });

  test('the superuser supplying an explicit id is REFUSED by the identity too (428C9)', async () => {
    assertRefusedBy(
      'superuser explicit id',
      await asSuperuser(
        `INSERT INTO public.audit_anchor (id, head_seq, head_hash, s3_key) VALUES (1, 301, ${digest('x')}, ${keyOf(301)})`,
      ),
      IDENTITY_428C9,
    );
  });

  for (const [label, sql] of [
    [
      'OVERRIDING SYSTEM VALUE with an id',
      `INSERT INTO public.audit_anchor (id, head_seq, head_hash, s3_key) OVERRIDING SYSTEM VALUE VALUES (1, 301, ${digest('x')}, ${keyOf(301)})`,
    ],
    [
      'naming id with the DEFAULT keyword',
      `INSERT INTO public.audit_anchor (id, head_seq, head_hash, s3_key) VALUES (DEFAULT, 301, ${digest('x')}, ${keyOf(301)})`,
    ],
  ] as const) {
    test(`app_rw ${label} is REFUSED by the column grant (42501): app_rw holds no INSERT on id`, async () => {
      assertRefusedBy(`app_rw ${label}`, await asLogin(LOGINS.app_rw, sql), DENIED);
    });
  }

  test('CONTROL — app_rw inserts without any privilege on the identity sequence; ids are assigned increasing; a rolled-back insert leaves a gap', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'seq usage=' || has_sequence_privilege('public.audit_anchor_id_seq', 'USAGE') ||
              ' select=' || has_sequence_privilege('public.audit_anchor_id_seq', 'SELECT') ||
              ' update=' || has_sequence_privilege('public.audit_anchor_id_seq', 'UPDATE')`,
      anchor('401', digest('gap-a'), keyOf(401)),
      'SAVEPOINT b',
      anchor('402', digest('gap-b'), keyOf(402)),
      'ROLLBACK TO SAVEPOINT b',
      anchor('403', digest('gap-c'), keyOf(403)),
      `SELECT 'c minus a=' || ((SELECT id FROM public.audit_anchor WHERE head_seq = 403) -
                               (SELECT id FROM public.audit_anchor WHERE head_seq = 401)) ||
              ' rows=' || (SELECT count(*) FROM public.audit_anchor WHERE head_seq BETWEEN 401 AND 403)`,
    );
    assertPermitted('app_rw inserts', r);
    assertRead('app_rw inserts', r, 'seq usage=false select=false update=false');
    assertRead('app_rw inserts', r, 'c minus a=2 rows=2');
  });

  test('app_rw calling nextval on the identity sequence is REFUSED (42501)', async () => {
    assertRefusedBy(
      'app_rw nextval',
      await asLogin(LOGINS.app_rw, `SELECT nextval('public.audit_anchor_id_seq')`),
      'ERROR:  42501: permission denied for sequence audit_anchor_id_seq',
    );
  });

  test('NOT HELD — the owner app_ddl and the superuser supply an id with OVERRIDING SYSTEM VALUE: the identity binds callers that do not override', async () => {
    const owner = await asLogin(
      LOGINS.app_ddl,
      `INSERT INTO public.audit_anchor (id, head_seq, head_hash, s3_key) OVERRIDING SYSTEM VALUE
       VALUES (900001, 501, ${digest('o')}, ${keyOf(501)}) RETURNING 'owner supplied id ' || id`,
    );
    assertPermitted('owner overrides the identity', owner);
    assertRead('owner overrides the identity', owner, 'owner supplied id 900001');
    const su = await asSuperuser(
      `INSERT INTO public.audit_anchor (id, head_seq, head_hash, s3_key) OVERRIDING SYSTEM VALUE
       VALUES (900002, 502, ${digest('s')}, ${keyOf(502)}) RETURNING 'superuser supplied id ' || id`,
    );
    assertPermitted('superuser overrides the identity', su);
    assertRead('superuser overrides the identity', su, 'superuser supplied id 900002');
  });
});

describe('0019 — one row per chain head: audit_anchor_head_seq_key UNIQUE (head_seq) (U-11 (2a))', () => {
  test('app_rw recording a head_seq already recorded is REFUSED by audit_anchor_head_seq_key (23505)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(FIXTURE_A),
      anchor(String(FIXTURE_A), digest('again'), `'audit-anchor/another-key'`),
    );
    assertRead('app_rw duplicate head_seq', r, PRESENT(FIXTURE_A));
    assertRefusedBy('app_rw duplicate head_seq', r, UNIQUE_23505, UNIQUE_FIELD);
  });

  test('the superuser recording a head_seq already recorded is REFUSED too (23505): the UNIQUE binds every writer', async () => {
    const r = await asSuperuser(
      readRow(FIXTURE_A),
      anchor(String(FIXTURE_A), digest('again'), keyOf(FIXTURE_A)),
    );
    assertRead('superuser duplicate head_seq', r, PRESENT(FIXTURE_A));
    assertRefusedBy('superuser duplicate head_seq', r, UNIQUE_23505, UNIQUE_FIELD);
  });

  test('the owner app_ddl is bound too: a recorded head_seq (23505) and a 31-byte head_hash (23514) are REFUSED', async () => {
    const dup = await asLogin(
      LOGINS.app_ddl,
      readRow(FIXTURE_A),
      anchor(String(FIXTURE_A), digest('owner-again'), keyOf(FIXTURE_A)),
    );
    assertRead('owner duplicate head_seq', dup, PRESENT(FIXTURE_A));
    assertRefusedBy('owner duplicate head_seq', dup, UNIQUE_23505, UNIQUE_FIELD);
    assertRefusedBy(
      'owner 31-byte head_hash',
      await asLogin(LOGINS.app_ddl, anchor('604', bytesOf(31), keyOf(604))),
      CHECK_23514,
      CHECK_FIELD,
    );
  });

  test('two new rows with one head_seq in a single INSERT are REFUSED (23505)', async () => {
    assertRefusedBy(
      'one statement, two rows, one head_seq',
      await asLogin(
        LOGINS.app_rw,
        `INSERT INTO public.audit_anchor (head_seq, head_hash, s3_key)
         VALUES (601, ${digest('p')}, ${keyOf(601)}), (601, ${digest('q')}, ${keyOf(601)})`,
      ),
      UNIQUE_23505,
      UNIQUE_FIELD,
    );
  });

  test("the superuser moving one anchor's head_seq onto another's is REFUSED (23505)", async () => {
    const r = await asSuperuser(
      readRow(FIXTURE_B),
      `UPDATE public.audit_anchor SET head_seq = ${String(FIXTURE_A)} WHERE head_seq = ${String(FIXTURE_B)}`,
    );
    assertRead('superuser head_seq collision', r, PRESENT(FIXTURE_B));
    assertRefusedBy('superuser head_seq collision', r, UNIQUE_23505, UNIQUE_FIELD);
  });

  test('CONTROL — app_rw records a new head; and INSERT … ON CONFLICT (head_seq) DO NOTHING on a recorded head inserts nothing (the skipped hour, U-11 (3))', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `${anchor('300', digest('head-300'), keyOf(300))} RETURNING 'recorded ' || head_seq`,
      `${anchor(String(FIXTURE_B), digest('again'), keyOf(FIXTURE_B))} ON CONFLICT (head_seq) DO NOTHING`,
      `SELECT 'anchors at ${String(FIXTURE_B)}: ' || count(*) || ' with the original hash: ' ||
              bool_and(head_hash = ${digest('head-200')})
         FROM public.audit_anchor WHERE head_seq = ${String(FIXTURE_B)}`,
    );
    assertPermitted('new head, then a skipped hour', r);
    assertRead('new head, then a skipped hour', r, 'recorded 300');
    assertRead('new head, then a skipped hour', r, 'INSERT 0 0');
    assertRead(
      'new head, then a skipped hour',
      r,
      `anchors at ${String(FIXTURE_B)}: 1 with the original hash: true`,
    );
  });
});

describe('0019 — head_hash is 32 bytes: audit_anchor_head_hash_len (U-5 (5)), and the NOT NULLs', () => {
  for (const n of [31, 33, 0, 64]) {
    test(`a ${String(n)}-byte head_hash is REFUSED by audit_anchor_head_hash_len (23514), as the superuser`, async () => {
      assertRefusedBy(
        `superuser ${String(n)}-byte head_hash`,
        await asSuperuser(anchor('701', bytesOf(n), keyOf(701))),
        CHECK_23514,
        CHECK_FIELD,
      );
    });
  }

  for (const n of [31, 33]) {
    test(`app_rw writing a ${String(n)}-byte head_hash is REFUSED by audit_anchor_head_hash_len (23514)`, async () => {
      assertRefusedBy(
        `app_rw ${String(n)}-byte head_hash`,
        await asLogin(LOGINS.app_rw, anchor('702', bytesOf(n), keyOf(702))),
        CHECK_23514,
        CHECK_FIELD,
      );
    });
  }

  test('app_rw writing a SHA-256 digest as its 64 hex characters (text cast to bytea, no \\x) is REFUSED (23514): that is 64 bytes, not 32', async () => {
    assertRefusedBy(
      'app_rw hex text as head_hash',
      await asLogin(
        LOGINS.app_rw,
        anchor('703', `convert_to(encode(${digest('hex')}, 'hex'), 'UTF8')`, keyOf(703)),
      ),
      CHECK_23514,
      CHECK_FIELD,
    );
  });

  test("the superuser updating a row's head_hash to 31 bytes is REFUSED (23514): the CHECK binds every writer", async () => {
    const r = await asSuperuser(
      readRow(FIXTURE_A),
      `UPDATE public.audit_anchor SET head_hash = ${bytesOf(31)} WHERE head_seq = ${String(FIXTURE_A)}`,
    );
    assertRead('superuser head_hash to 31 bytes', r, PRESENT(FIXTURE_A));
    assertRefusedBy('superuser head_hash to 31 bytes', r, CHECK_23514, CHECK_FIELD);
  });

  test("CONTROL — app_rw records a 32-byte head_hash (a SHA-256 digest, and 32 bytes from decode(hex)); anchored_at is the transaction's now(), returned to it", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `${anchor('704', digest('ok'), keyOf(704))}
       RETURNING 'recorded 704 bytes=' || octet_length(head_hash) || ' anchored_at=now():' || (anchored_at = now())`,
      `${anchor('705', `decode(encode(${digest('ok2')}, 'hex'), 'hex')`, keyOf(705))}
       RETURNING 'recorded 705 bytes=' || octet_length(head_hash)`,
    );
    assertPermitted('app_rw 32-byte head_hash', r);
    assertRead('app_rw 32-byte head_hash', r, 'recorded 704 bytes=32 anchored_at=now():true');
    assertRead('app_rw 32-byte head_hash', r, 'recorded 705 bytes=32');
  });

  for (const column of ['head_seq', 'head_hash', 's3_key'] as const) {
    test(`${column} NULL is REFUSED (23502, naming the column), as the superuser and as app_rw`, async () => {
      const values = {
        head_seq: '801',
        head_hash: digest('n'),
        s3_key: keyOf(801),
        [column]: 'NULL',
      };
      const sql = anchor(values.head_seq, values.head_hash, values.s3_key);
      for (const [who, r] of [
        ['superuser', await asSuperuser(sql)],
        ['app_rw', await asLogin(LOGINS.app_rw, sql)],
      ] as const) {
        assertRefusedBy(`${who} ${column} NULL`, r, notNull(column), `COLUMN NAME:  ${column}`);
      }
    });
  }

  test('anchored_at NULL is REFUSED (23502, naming the column), as the superuser', async () => {
    assertRefusedBy(
      'superuser anchored_at NULL',
      await asSuperuser(
        `INSERT INTO public.audit_anchor (head_seq, head_hash, s3_key, anchored_at) VALUES (802, ${digest('n')}, ${keyOf(802)}, NULL)`,
      ),
      notNull('anchored_at'),
      'COLUMN NAME:  anchored_at',
    );
  });
});

describe('0019 — app_rw: SELECT and INSERT (head_seq, head_hash, s3_key) only; no UPDATE, DELETE or TRUNCATE (V-A1)', () => {
  test('app_rw holds INSERT on head_seq, head_hash and s3_key only, UPDATE on no column, and no table-level INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' ||
                           has_column_privilege('app_rw', 'public.audit_anchor', attname, 'INSERT') || '/' ||
                           has_column_privilege('app_rw', 'public.audit_anchor', attname, 'UPDATE'),
                           ',' ORDER BY attnum) || ' table:' ||
                (SELECT string_agg(p || '=' || has_table_privilege('app_rw', 'public.audit_anchor', p), ',')
                   FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
           FROM pg_attribute WHERE attrelid = 'public.audit_anchor'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id=false/false,head_seq=true/false,head_hash=true/false,s3_key=true/false,anchored_at=false/false ' +
        'table:SELECT=true,INSERT=false,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false',
    );
  });

  for (const [label, value] of [
    ['anchored_at (back-dated)', "now() - interval '1 day'"],
    ['anchored_at (the DEFAULT keyword)', 'DEFAULT'],
  ] as const) {
    test(`app_rw INSERT naming ${label} is REFUSED by the column grant (42501)`, async () => {
      assertRefusedBy(
        `app_rw insert ${label}`,
        await asLogin(
          LOGINS.app_rw,
          `INSERT INTO public.audit_anchor (head_seq, head_hash, s3_key, anchored_at)
           VALUES (901, ${digest('d')}, ${keyOf(901)}, ${value})`,
        ),
        DENIED,
      );
    });
  }

  for (const [label, set] of [
    ['head_hash', `head_hash = ${digest('forged')}`],
    ['head_seq', 'head_seq = head_seq + 1'],
    ['s3_key', `s3_key = 'audit-anchor/forged'`],
    ['anchored_at', "anchored_at = anchored_at - interval '1 day'"],
  ] as const) {
    test(`app_rw UPDATE of ${label} is REFUSED (42501)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readRow(FIXTURE_A),
        `UPDATE public.audit_anchor SET ${set} WHERE head_seq = ${String(FIXTURE_A)}`,
      );
      assertRead(`app_rw update ${label}`, r, PRESENT(FIXTURE_A));
      assertRefusedBy(`app_rw update ${label}`, r, DENIED);
    });
  }

  test('app_rw DELETE of an anchor is REFUSED (42501)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(FIXTURE_A),
      `DELETE FROM public.audit_anchor WHERE head_seq = ${String(FIXTURE_A)}`,
    );
    assertRead('app_rw DELETE', r, PRESENT(FIXTURE_A));
    assertRefusedBy('app_rw DELETE', r, DENIED);
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefusedBy(
      'app_rw TRUNCATE',
      await asLogin(LOGINS.app_rw, 'TRUNCATE public.audit_anchor'),
      DENIED,
    );
  });

  test('app_rw SELECT … FOR UPDATE on an anchor is REFUSED (42501): with no UPDATE privilege, app_rw cannot row-lock this table', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(FIXTURE_A),
      `SELECT head_seq FROM public.audit_anchor WHERE head_seq = ${String(FIXTURE_A)} FOR UPDATE`,
    );
    assertRead('app_rw FOR UPDATE', r, PRESENT(FIXTURE_A));
    assertRefusedBy('app_rw FOR UPDATE', r, DENIED);
  });

  test("CONTROL — app_rw reads the previous anchor (ORDER BY head_seq DESC LIMIT 1) and the verifier's list (ORDER BY head_seq)", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'previous ' || head_seq || ' ' || s3_key FROM public.audit_anchor ORDER BY head_seq DESC LIMIT 1`,
      `SELECT 'list ' || string_agg(head_seq::text, ',' ORDER BY head_seq) FROM public.audit_anchor`,
    );
    assertPermitted('app_rw reads', r);
    assertRead(
      'app_rw reads',
      r,
      `previous ${String(FIXTURE_B)} audit-anchor/00000000000000000200`,
    );
    assertRead('app_rw reads', r, `list ${String(FIXTURE_A)},${String(FIXTURE_B)}`);
  });
});

describe('0019 — no other role reads or writes it (U-7, U-8), over real single-membership logins', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} SELECT`,
        await asLogin(LOGINS[role], 'SELECT count(*) FROM public.audit_anchor'),
        DENIED,
      );
    });

    test(`${role} INSERT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} INSERT`,
        await asLogin(LOGINS[role], anchor('1001', digest('r'), keyOf(1001))),
        DENIED,
      );
    });
  }

  for (const [what, sql] of [
    ['UPDATE', `UPDATE public.audit_anchor SET s3_key = 'x' WHERE head_seq = ${String(FIXTURE_A)}`],
    ['DELETE', `DELETE FROM public.audit_anchor WHERE head_seq = ${String(FIXTURE_A)}`],
  ] as const) {
    test(`app_admin_rw ${what} is REFUSED (42501)`, async () => {
      assertRefusedBy(`app_admin_rw ${what}`, await asLogin(LOGINS.app_admin_rw, sql), DENIED);
    });
  }

  test('no role but app_ddl (the owner) and app_rw holds any privilege on the table or a column, PUBLIC included', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(r || '=' ||
                  (has_table_privilege(r, 'public.audit_anchor', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
                   has_any_column_privilege(r, 'public.audit_anchor', 'SELECT,INSERT,UPDATE,REFERENCES')), ',' ORDER BY r)
           FROM unnest(ARRAY['app_admin_rw', 'app_safety_rw', 'answering_service', 'app_rw', 'public']) r`,
      ),
      'answering_service=false,app_admin_rw=false,app_rw=true,app_safety_rw=false,public=false',
    );
  });
});

describe('0019 — NOT HELD (disclosed)', () => {
  test("NOT HELD — app_rw records a head_seq LOWER than the latest anchor, 0 and a negative one: all accepted; monotonicity is the verifier's (U-11 (4))", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(FIXTURE_B),
      `${anchor('150', digest('back'), keyOf(150))} RETURNING 'recorded 150 below ' || (SELECT max(head_seq) FROM public.audit_anchor WHERE head_seq <> 150)`,
      `${anchor('0', digest('zero'), keyOf(0))} RETURNING 'recorded 0'`,
      `${anchor('-5', digest('neg'), `'audit-anchor/-5'`)} RETURNING 'recorded -5'`,
    );
    assertPermitted('non-monotonic head_seq', r);
    assertRead('non-monotonic head_seq', r, PRESENT(FIXTURE_B));
    assertRead('non-monotonic head_seq', r, `recorded 150 below ${String(FIXTURE_B)}`);
    assertRead('non-monotonic head_seq', r, 'recorded 0');
    assertRead('non-monotonic head_seq', r, 'recorded -5');
  });

  test("NOT HELD — app_rw records 32 zero bytes as head_hash, another anchor's s3_key, an empty s3_key and a key naming another head: all accepted; content and s3_key are not checked", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `${anchor('1101', `decode(repeat('00', 32), 'hex')`, keyOf(FIXTURE_A))} RETURNING 'recorded 1101 with the key of ${String(FIXTURE_A)}'`,
      `${anchor('1102', digest('e'), `''`)} RETURNING 'recorded 1102 with an empty key'`,
      `${anchor('1103', digest('w'), keyOf(9999))} RETURNING 'recorded 1103 with the key of 9999'`,
      `SELECT 'rows sharing the key of ${String(FIXTURE_A)}: ' || count(*) FROM public.audit_anchor WHERE s3_key = ${keyOf(FIXTURE_A)}`,
    );
    assertPermitted('content and s3_key unchecked', r);
    assertRead(
      'content and s3_key unchecked',
      r,
      `recorded 1101 with the key of ${String(FIXTURE_A)}`,
    );
    assertRead('content and s3_key unchecked', r, 'recorded 1102 with an empty key');
    assertRead('content and s3_key unchecked', r, 'recorded 1103 with the key of 9999');
    assertRead(
      'content and s3_key unchecked',
      r,
      `rows sharing the key of ${String(FIXTURE_A)}: 2`,
    );
  });

  test('NOT HELD — the owner app_ddl and the superuser each back-date anchored_at at INSERT, rewrite head_hash, head_seq and s3_key, and delete an anchor: the grants bind app_rw only', async () => {
    for (const [who, run] of [
      ['owner', (...c: string[]) => asLogin(LOGINS.app_ddl, ...c)],
      ['superuser', (...c: string[]) => asSuperuser(...c)],
    ] as const) {
      const r = await run(
        readRow(FIXTURE_A),
        `INSERT INTO public.audit_anchor (head_seq, head_hash, s3_key, anchored_at)
         VALUES (1201, ${digest(who)}, ${keyOf(1201)}, now() - interval '1 year')
         RETURNING '${who} wrote back-dated:' || (anchored_at < now() - interval '364 days')`,
        `UPDATE public.audit_anchor SET head_hash = ${digest('forged')}, head_seq = 150, s3_key = 'forged'
          WHERE head_seq = ${String(FIXTURE_A)} RETURNING '${who} rewrote to ' || head_seq || ' ' || s3_key`,
        `DELETE FROM public.audit_anchor WHERE head_seq = ${String(FIXTURE_B)} RETURNING '${who} deleted ${String(FIXTURE_B)}'`,
      );
      assertPermitted(`${who} writes, rewrites and deletes`, r);
      assertRead(`${who} writes, rewrites and deletes`, r, PRESENT(FIXTURE_A));
      assertRead(`${who} writes, rewrites and deletes`, r, `${who} wrote back-dated:true`);
      assertRead(`${who} writes, rewrites and deletes`, r, `${who} rewrote to 150 forged`);
      assertRead(`${who} writes, rewrites and deletes`, r, `${who} deleted ${String(FIXTURE_B)}`);
    }
  });

  test('the fixture rows survive every refusal and rolled-back write above: two anchors, 100 and 200, nothing else', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(head_seq || '=' || (head_hash = sha256(('head-' || head_seq)::bytea)) || ':' || s3_key, ',' ORDER BY head_seq) ||
                ' total=' || (SELECT count(*) FROM public.audit_anchor)
           FROM public.audit_anchor`,
      ),
      '100=true:audit-anchor/00000000000000000100,200=true:audit-anchor/00000000000000000200 total=2',
    );
  });
});

describe('0019 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON audit_anchor TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.audit_anchor TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.audit_anchor'),
      `the guard's DETAIL does not name audit_anchor.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.audit_anchor', 'SELECT')::text`,
      ),
      'false',
    );
  });

  test('GRANT INSERT (head_seq) ON audit_anchor TO answering_service (a column grant) is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser(
      'GRANT INSERT (head_seq) ON public.audit_anchor TO answering_service',
    );
    assertRefused('column grant to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.equal(
      await db.value(
        `SELECT has_any_column_privilege('answering_service', 'public.audit_anchor', 'INSERT')::text`,
      ),
      'false',
    );
  });

  test('GRANT USAGE ON SEQUENCE audit_anchor_id_seq TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser(
      'GRANT USAGE ON SEQUENCE public.audit_anchor_id_seq TO answering_service',
    );
    assertRefused('sequence grant to the vendor', r, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    assert.equal(
      await db.value(
        `SELECT has_sequence_privilege('answering_service', 'public.audit_anchor_id_seq', 'USAGE')::text`,
      ),
      'false',
    );
  });

  test("of 0019's statement kinds, CREATE TABLE and GRANT fire the guard and COMMENT does not (a detective-only grant held open, rolled back)", async () => {
    const quiet = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      `COMMENT ON TABLE public.audit_anchor IS 'probe'`,
      `SELECT 'comment accepted'`,
    );
    assertPermitted('COMMENT with the guard armed', quiet);
    assertRead('COMMENT with the guard armed', quiet, 'comment accepted');
    const create = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'CREATE TABLE public.t213_guard_probe (id bigint GENERATED ALWAYS AS IDENTITY)',
    );
    assertRefused('CREATE TABLE with the guard armed', create, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    const grant = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'GRANT SELECT ON public.audit_anchor TO app_rw',
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
