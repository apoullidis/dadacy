/**
 * T-212 — `public.audit_outbox` (migration 0018): P-AUDIT-OUTBOX of
 * tasks/state/EP-8b/OD-226-cut.md, T-067's MR-1, built against OE-34 Part C as OE-50 accepted it
 * (U-1 identity key, U-10 (1) payload CHECK, U-10 (3) no DELETE, U-7/U-8 no other role, no RLS).
 * V-O1: once written, an outbox row's payload and created_at cannot be changed, nor the row
 * deleted, by an application role; app_rw may set only relayed_at.
 *
 * gate:migration-lint's R-APPEND-ONLY does not cover this table's name (D-11, OD-143), so these
 * database refusals are its guard.
 *
 * What the database does NOT refuse is pinned too, each in a case named NOT HELD.
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

const SUITE = 'audit-outbox';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't212_app_rw_probe',
  app_admin_rw: 't212_app_admin_rw_probe',
  app_safety_rw: 't212_app_safety_rw_probe',
  answering_service: 't212_answering_service_probe',
  app_ddl: 't212_app_ddl_probe',
} as const;

/** The two fixture rows: R is unrelayed, S was relayed a day ago. Found by their `fixture` key. */
const rowOf = (fixture: 'R' | 'S'): string => `payload->>'fixture' = '${fixture}'`;

/** One fixture row's state, read in the session that then writes it. */
const readRow = (fixture: 'R' | 'S'): string =>
  `SELECT 'row ${fixture} count=' || count(*) || ' relayed=' || coalesce(string_agg((relayed_at IS NOT NULL)::text, ','), '-')
     FROM public.audit_outbox WHERE ${rowOf(fixture)}`;
const R_UNRELAYED = 'row R count=1 relayed=false';
const S_RELAYED = 'row S count=1 relayed=true';

/** T-067 Q1, the outbox write: exactly the one column app_rw may write. */
const write = (payload: string): string =>
  `INSERT INTO public.audit_outbox (payload) VALUES (${payload})`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      write(`'{"fixture":"R","action":"fixture.r"}'`),
      write(`'{"fixture":"S","action":"fixture.s"}'`),
      `UPDATE public.audit_outbox SET relayed_at = now() - interval '1 day' WHERE ${rowOf('S')}`,
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

const DENIED = 'ERROR:  42501: permission denied for table audit_outbox';
const IDENTITY_428C9 = 'ERROR:  428C9: cannot insert a non-DEFAULT value into column "id"';
const CHECK_23514 =
  'ERROR:  23514: new row for relation "audit_outbox" violates check constraint "audit_outbox_payload_object"';
const CHECK_FIELD = 'CONSTRAINT NAME:  audit_outbox_payload_object';
const PAYLOAD_23502 =
  'ERROR:  23502: null value in column "payload" of relation "audit_outbox" violates not-null constraint';
const PAYLOAD_FIELD = 'COLUMN NAME:  payload';

/** The text 0018 installs, verbatim: a change to the comment must change this suite too. */
const TABLE_COMMENT =
  'The transactional audit outbox (SD §DB-10 lines 2850-2854; SA §SEC-8). id is an identity column, GENERATED ' +
  'ALWAYS. CHECK ' +
  'audit_outbox_payload_object holds payload to a JSON object. app_rw may SELECT, may INSERT only payload, so ' +
  'created_at takes now() and relayed_at starts NULL for it, and may UPDATE only relayed_at. It holds no DELETE ' +
  "or TRUNCATE: pruning relayed rows is the retention engine's (OE-50 U-10 (3)). These are grants: they bind " +
  'app_rw, not the table owner app_ddl or the superuser. No other role is granted any privilege, and there is no ' +
  'row-level security.';

describe('0018 — the table, its owner, columns, identity, constraints, indexes, ACL and comment', () => {
  test('four columns in order, types, nullability, identity and defaults; owner app_ddl; ACL: app_rw SELECT, INSERT on payload only, UPDATE on relayed_at only', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   CASE attidentity WHEN 'a' THEN 'identity-always' WHEN 'd' THEN 'identity-by-default' ELSE '-' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.audit_outbox'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = c.oid AND attacl IS NOT NULL)
           FROM pg_class c WHERE c.oid = 'public.audit_outbox'::regclass`,
      ),
      'id:bigint:nn:identity-always:-,payload:jsonb:nn:-:-,' +
        'created_at:timestamp with time zone:nn:-:now(),relayed_at:timestamp with time zone:null:-:-' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}' +
        '|payload={app_rw=a/app_ddl},relayed_at={app_rw=w/app_ddl}',
    );
  });

  test('the primary key, the payload CHECK and the three NOT NULLs are exactly these, by these definitions', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'public.audit_outbox'::regclass`,
      ),
      'audit_outbox_created_at_not_null=NOT NULL created_at ; ' +
        'audit_outbox_id_not_null=NOT NULL id ; ' +
        'audit_outbox_payload_not_null=NOT NULL payload ; ' +
        "audit_outbox_payload_object=CHECK ((jsonb_typeof(payload) = 'object'::text)) ; " +
        'audit_outbox_pkey=PRIMARY KEY (id)',
    );
  });

  test('the only indexes are the primary key and audit_outbox_created_at_unrelayed_idx (created_at) WHERE relayed_at IS NULL (SD 2854)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid = 'public.audit_outbox'::regclass`,
      ),
      'CREATE INDEX audit_outbox_created_at_unrelayed_idx ON public.audit_outbox USING btree (created_at) WHERE (relayed_at IS NULL) ; ' +
        'CREATE UNIQUE INDEX audit_outbox_pkey ON public.audit_outbox USING btree (id)',
    );
  });

  test('the identity sequence is audit_outbox_id_seq: bigint, from 1 by 1 to 2^63-1, no cycle, owned by app_ddl, granted to no role', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_serial_sequence('public.audit_outbox', 'id') || '|' || s.seqtypid::regtype || ' start=' || s.seqstart ||
                ' inc=' || s.seqincrement || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cycle=' || s.seqcycle ||
                '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, 'acl-null')
           FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid
          WHERE c.oid = pg_get_serial_sequence('public.audit_outbox', 'id')::regclass`,
      ),
      'public.audit_outbox_id_seq|bigint start=1 inc=1 min=1 max=9223372036854775807 cycle=false|app_ddl|acl-null',
    );
  });

  test('no non-internal trigger, no rewrite rule, row-level security neither enabled nor forced, and no policy', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
           FROM pg_class c WHERE c.oid = 'public.audit_outbox'::regclass`,
      ),
      '0 triggers, 0 rules, rls=false, force=false, 0 policies',
    );
  });

  test('COMMENT ON TABLE is exactly this text, and no column carries a comment', async () => {
    assert.equal(
      await db.value(`SELECT obj_description('public.audit_outbox'::regclass, 'pg_class')`),
      TABLE_COMMENT,
    );
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.audit_outbox'::regclass
            AND attnum > 0 AND col_description(attrelid, attnum) IS NOT NULL`,
      ),
      '0',
    );
  });
});

describe('0018 — id is GENERATED ALWAYS AS IDENTITY (U-1)', () => {
  test('app_rw supplying an explicit id is REFUSED by the identity (428C9), not by a privilege', async () => {
    assertRefusedBy(
      'app_rw explicit id',
      await asLogin(
        LOGINS.app_rw,
        `INSERT INTO public.audit_outbox (id, payload) VALUES (1, '{}')`,
      ),
      IDENTITY_428C9,
    );
  });

  test('the superuser supplying an explicit id is REFUSED by the identity too (428C9)', async () => {
    assertRefusedBy(
      'superuser explicit id',
      await asSuperuser(`INSERT INTO public.audit_outbox (id, payload) VALUES (1, '{}')`),
      IDENTITY_428C9,
    );
  });

  for (const [label, sql] of [
    [
      'OVERRIDING SYSTEM VALUE with an id',
      `INSERT INTO public.audit_outbox (id, payload) OVERRIDING SYSTEM VALUE VALUES (1, '{}')`,
    ],
    [
      'naming id with the DEFAULT keyword',
      `INSERT INTO public.audit_outbox (id, payload) VALUES (DEFAULT, '{}')`,
    ],
  ] as const) {
    test(`app_rw ${label} is REFUSED by the column grant (42501): app_rw holds no INSERT on id`, async () => {
      assertRefusedBy(`app_rw ${label}`, await asLogin(LOGINS.app_rw, sql), DENIED);
    });
  }

  test('CONTROL — app_rw inserts without any privilege on the identity sequence; ids are assigned increasing; a rolled-back insert leaves a gap', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'seq usage=' || has_sequence_privilege('public.audit_outbox_id_seq', 'USAGE') ||
              ' select=' || has_sequence_privilege('public.audit_outbox_id_seq', 'SELECT') ||
              ' update=' || has_sequence_privilege('public.audit_outbox_id_seq', 'UPDATE')`,
      write(`'{"gap":"a"}'`),
      'SAVEPOINT b',
      write(`'{"gap":"b"}'`),
      'ROLLBACK TO SAVEPOINT b',
      write(`'{"gap":"c"}'`),
      `SELECT 'c minus a=' || ((SELECT id FROM public.audit_outbox WHERE payload->>'gap' = 'c') -
                               (SELECT id FROM public.audit_outbox WHERE payload->>'gap' = 'a')) ||
              ' rows=' || (SELECT count(*) FROM public.audit_outbox WHERE payload ? 'gap')`,
    );
    assertPermitted('app_rw inserts', r);
    assertRead('app_rw inserts', r, 'seq usage=false select=false update=false');
    assertRead('app_rw inserts', r, 'c minus a=2 rows=2');
  });

  test('app_rw calling nextval on the identity sequence is REFUSED (42501)', async () => {
    assertRefusedBy(
      'app_rw nextval',
      await asLogin(LOGINS.app_rw, `SELECT nextval('public.audit_outbox_id_seq')`),
      'ERROR:  42501: permission denied for sequence audit_outbox_id_seq',
    );
  });

  test('NOT HELD — the owner app_ddl and the superuser supply an id with OVERRIDING SYSTEM VALUE: the identity binds callers that do not override', async () => {
    const owner = await asLogin(
      LOGINS.app_ddl,
      `INSERT INTO public.audit_outbox (id, payload) OVERRIDING SYSTEM VALUE VALUES (900001, '{}')
       RETURNING 'owner supplied id ' || id`,
    );
    assertPermitted('owner overrides the identity', owner);
    assertRead('owner overrides the identity', owner, 'owner supplied id 900001');
    const su = await asSuperuser(
      `INSERT INTO public.audit_outbox (id, payload) OVERRIDING SYSTEM VALUE VALUES (900002, '{}')
       RETURNING 'superuser supplied id ' || id`,
    );
    assertPermitted('superuser overrides the identity', su);
    assertRead('superuser overrides the identity', su, 'superuser supplied id 900002');
  });
});

describe('0018 — payload is a JSON object: audit_outbox_payload_object (U-10 (1)), and NOT NULL', () => {
  for (const value of [`'[]'`, `'"x"'`, `'null'`, `'1'`, `'true'`]) {
    test(`payload ${value} (jsonb) is REFUSED by audit_outbox_payload_object (23514), as the superuser`, async () => {
      assertRefusedBy(
        `superuser payload ${value}`,
        await asSuperuser(write(value)),
        CHECK_23514,
        CHECK_FIELD,
      );
    });
  }

  for (const value of [`'[]'`, `'"x"'`]) {
    test(`app_rw writing payload ${value} is REFUSED by audit_outbox_payload_object (23514)`, async () => {
      assertRefusedBy(
        `app_rw payload ${value}`,
        await asLogin(LOGINS.app_rw, write(value)),
        CHECK_23514,
        CHECK_FIELD,
      );
    });
  }

  test("the superuser updating a row's payload to an array is REFUSED by audit_outbox_payload_object (23514): the CHECK binds every writer", async () => {
    const r = await asSuperuser(
      readRow('R'),
      `UPDATE public.audit_outbox SET payload = '[]' WHERE ${rowOf('R')}`,
    );
    assertRead('superuser payload to []', r, R_UNRELAYED);
    assertRefusedBy('superuser payload to []', r, CHECK_23514, CHECK_FIELD);
  });

  test('payload NULL is REFUSED (23502, naming the column), as the superuser and as app_rw', async () => {
    assertRefusedBy(
      'superuser payload NULL',
      await asSuperuser(write('NULL')),
      PAYLOAD_23502,
      PAYLOAD_FIELD,
    );
    assertRefusedBy(
      'app_rw payload NULL',
      await asLogin(LOGINS.app_rw, write('NULL')),
      PAYLOAD_23502,
      PAYLOAD_FIELD,
    );
  });

  test("CONTROL — app_rw writes '{}' and a nested object (T-067 Q1); created_at is the transaction's now() and relayed_at is NULL", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      write(`'{}'`),
      write(`'{"action":"x","context":{"trace_id":"t","list":[1,2]}}'`),
      `SELECT 'written ' || count(*) || ' created_at=now():' || bool_and(created_at = now()) ||
              ' relayed_at null:' || bool_and(relayed_at IS NULL)
         FROM public.audit_outbox WHERE payload = '{}' OR payload->>'action' = 'x'`,
    );
    assertPermitted('app_rw writes objects', r);
    assertRead('app_rw writes objects', r, 'written 2 created_at=now():true relayed_at null:true');
  });
});

describe('0018 — app_rw: SELECT, INSERT (payload), UPDATE (relayed_at) only; no DELETE, no TRUNCATE (V-O1, U-10 (3))', () => {
  test('app_rw holds INSERT on payload only and UPDATE on relayed_at only, and no table-level INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' ||
                           has_column_privilege('app_rw', 'public.audit_outbox', attname, 'INSERT') || '/' ||
                           has_column_privilege('app_rw', 'public.audit_outbox', attname, 'UPDATE'),
                           ',' ORDER BY attnum) || ' table:' ||
                (SELECT string_agg(p || '=' || has_table_privilege('app_rw', 'public.audit_outbox', p), ',')
                   FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
           FROM pg_attribute WHERE attrelid = 'public.audit_outbox'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id=false/false,payload=true/false,created_at=false/false,relayed_at=false/true ' +
        'table:SELECT=true,INSERT=false,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false',
    );
  });

  for (const [label, columns, values] of [
    ['created_at (back-dated)', 'created_at', "now() - interval '1 day'"],
    ['created_at (the DEFAULT keyword)', 'created_at', 'DEFAULT'],
    ['relayed_at (already relayed)', 'relayed_at', 'now()'],
    ['relayed_at (the DEFAULT keyword)', 'relayed_at', 'DEFAULT'],
  ] as const) {
    test(`app_rw INSERT naming ${label} is REFUSED by the column grant (42501)`, async () => {
      assertRefusedBy(
        `app_rw insert ${label}`,
        await asLogin(
          LOGINS.app_rw,
          `INSERT INTO public.audit_outbox (payload, ${columns}) VALUES ('{}', ${values})`,
        ),
        DENIED,
      );
    });
  }

  for (const [label, set] of [
    ['payload', `payload = '{"action":"tampered"}'`],
    ['created_at', "created_at = created_at - interval '1 day'"],
  ] as const) {
    test(`app_rw UPDATE of ${label} is REFUSED (42501)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readRow('R'),
        `UPDATE public.audit_outbox SET ${set} WHERE ${rowOf('R')}`,
      );
      assertRead(`app_rw update ${label}`, r, R_UNRELAYED);
      assertRefusedBy(`app_rw update ${label}`, r, DENIED);
    });
  }

  test("app_rw DELETE of a relayed row is REFUSED (42501): the 30-day prune is not app_rw's", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow('S'),
      `DELETE FROM public.audit_outbox WHERE ${rowOf('S')}`,
    );
    assertRead('app_rw DELETE', r, S_RELAYED);
    assertRefusedBy('app_rw DELETE', r, DENIED);
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefusedBy(
      'app_rw TRUNCATE',
      await asLogin(LOGINS.app_rw, 'TRUNCATE public.audit_outbox'),
      DENIED,
    );
  });

  test("CONTROL — app_rw runs the relay's claim (T-067 Q2, FOR UPDATE SKIP LOCKED) and mark (Q5, UPDATE relayed_at) on R", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow('R'),
      `SELECT 'claimed ' || string_agg(payload->>'fixture', ',')
         FROM (SELECT id, payload, created_at FROM public.audit_outbox WHERE relayed_at IS NULL
                ORDER BY created_at, id LIMIT 10 FOR UPDATE SKIP LOCKED) q`,
      `UPDATE public.audit_outbox SET relayed_at = now() WHERE ${rowOf('R')}
       RETURNING 'marked ' || (payload->>'fixture') || ' relayed_at=now():' || (relayed_at = now())`,
    );
    assertPermitted('relay claim and mark', r);
    assertRead('relay claim and mark', r, R_UNRELAYED);
    assertRead('relay claim and mark', r, 'claimed R');
    assertRead('relay claim and mark', r, 'marked R relayed_at=now():true');
  });
});

describe('0018 — no other role reads or writes it (U-7, U-8), over real single-membership logins', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} SELECT`,
        await asLogin(LOGINS[role], 'SELECT count(*) FROM public.audit_outbox'),
        DENIED,
      );
    });

    test(`${role} INSERT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} INSERT`,
        await asLogin(LOGINS[role], write(`'{"action":"x"}'`)),
        DENIED,
      );
    });
  }

  for (const [what, sql] of [
    ['UPDATE', `UPDATE public.audit_outbox SET relayed_at = now() WHERE ${rowOf('R')}`],
    ['DELETE', `DELETE FROM public.audit_outbox WHERE ${rowOf('S')}`],
  ] as const) {
    test(`app_admin_rw ${what} is REFUSED (42501)`, async () => {
      assertRefusedBy(`app_admin_rw ${what}`, await asLogin(LOGINS.app_admin_rw, sql), DENIED);
    });
  }

  test('no role but app_ddl (the owner) and app_rw holds any privilege on the table or a column, PUBLIC included', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(r || '=' ||
                  (has_table_privilege(r, 'public.audit_outbox', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
                   has_any_column_privilege(r, 'public.audit_outbox', 'SELECT,INSERT,UPDATE,REFERENCES')), ',' ORDER BY r)
           FROM unnest(ARRAY['app_admin_rw', 'app_safety_rw', 'answering_service', 'app_rw', 'public']) r`,
      ),
      'answering_service=false,app_admin_rw=false,app_rw=true,app_safety_rw=false,public=false',
    );
  });
});

describe('0018 — NOT HELD (disclosed)', () => {
  test('NOT HELD — app_rw marks the unrelayed row R relayed without relaying it: accepted, and the relay can no longer claim it', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow('R'),
      `UPDATE public.audit_outbox SET relayed_at = now() WHERE ${rowOf('R')}`,
      `SELECT 'claimable R ' || count(*)
         FROM (SELECT id FROM public.audit_outbox WHERE relayed_at IS NULL AND ${rowOf('R')} FOR UPDATE SKIP LOCKED) q`,
    );
    assertPermitted('mark without relay', r);
    assertRead('mark without relay', r, R_UNRELAYED);
    assertRead('mark without relay', r, 'claimable R 0');
  });

  test('NOT HELD — app_rw returns the relayed row S to NULL (so the relay would publish it again), and sets relayed_at earlier than created_at: both accepted', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow('S'),
      `UPDATE public.audit_outbox SET relayed_at = NULL WHERE ${rowOf('S')}`,
      `SELECT 'claimable S ' || count(*)
         FROM (SELECT id FROM public.audit_outbox WHERE relayed_at IS NULL AND ${rowOf('S')} FOR UPDATE SKIP LOCKED) q`,
      `UPDATE public.audit_outbox SET relayed_at = created_at - interval '1 year' WHERE ${rowOf('S')}
       RETURNING 'S relayed before created:' || (relayed_at < created_at)`,
    );
    assertPermitted('relayed_at rewound', r);
    assertRead('relayed_at rewound', r, S_RELAYED);
    assertRead('relayed_at rewound', r, 'claimable S 1');
    assertRead('relayed_at rewound', r, 'S relayed before created:true');
  });

  test('NOT HELD — the owner app_ddl and the superuser each back-date created_at and preset relayed_at at INSERT, rewrite payload, and delete a row (the owner rewrites created_at too): the grants bind app_rw only', async () => {
    const owner = await asLogin(
      LOGINS.app_ddl,
      readRow('R'),
      `INSERT INTO public.audit_outbox (payload, created_at, relayed_at)
       VALUES ('{"owner":"o"}', now() - interval '1 year', now())
       RETURNING 'owner wrote back-dated:' || (created_at < now()) || ' pre-relayed:' || (relayed_at IS NOT NULL)`,
      `UPDATE public.audit_outbox SET payload = '{"action":"rewritten"}', created_at = created_at - interval '1 day'
        WHERE ${rowOf('R')} RETURNING 'owner rewrote ' || (payload->>'action')`,
      `DELETE FROM public.audit_outbox WHERE ${rowOf('S')} RETURNING 'owner deleted S'`,
    );
    assertPermitted('owner rewrites and deletes', owner);
    assertRead('owner rewrites and deletes', owner, R_UNRELAYED);
    assertRead('owner rewrites and deletes', owner, 'owner wrote back-dated:true pre-relayed:true');
    assertRead('owner rewrites and deletes', owner, 'owner rewrote rewritten');
    assertRead('owner rewrites and deletes', owner, 'owner deleted S');
    const su = await asSuperuser(
      readRow('R'),
      `INSERT INTO public.audit_outbox (payload, created_at, relayed_at)
       VALUES ('{"superuser":"s"}', now() - interval '1 year', now())
       RETURNING 'superuser wrote back-dated:' || (created_at < now()) || ' pre-relayed:' || (relayed_at IS NOT NULL)`,
      `UPDATE public.audit_outbox SET payload = '{"action":"su"}' WHERE ${rowOf('R')}
       RETURNING 'superuser rewrote ' || (payload->>'action')`,
      `DELETE FROM public.audit_outbox WHERE ${rowOf('S')} RETURNING 'superuser deleted S'`,
    );
    assertPermitted('superuser writes, rewrites and deletes', su);
    assertRead('superuser writes, rewrites and deletes', su, R_UNRELAYED);
    assertRead(
      'superuser writes, rewrites and deletes',
      su,
      'superuser wrote back-dated:true pre-relayed:true',
    );
    assertRead('superuser writes, rewrites and deletes', su, 'superuser rewrote su');
    assertRead('superuser writes, rewrites and deletes', su, 'superuser deleted S');
  });

  test('the fixture rows survive every refusal and rolled-back write above: R unrelayed, S relayed, nothing else', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg((payload->>'fixture') || '=' || (relayed_at IS NOT NULL), ',' ORDER BY id) || ' total=' ||
                (SELECT count(*) FROM public.audit_outbox)
           FROM public.audit_outbox`,
      ),
      'R=false,S=true total=2',
    );
  });
});

describe('0018 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON audit_outbox TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.audit_outbox TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.audit_outbox'),
      `the guard's DETAIL does not name audit_outbox.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.audit_outbox', 'SELECT')::text`,
      ),
      'false',
    );
  });

  test('GRANT INSERT (payload) ON audit_outbox TO answering_service (a column grant) is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser(
      'GRANT INSERT (payload) ON public.audit_outbox TO answering_service',
    );
    assertRefused('column grant to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.equal(
      await db.value(
        `SELECT has_any_column_privilege('answering_service', 'public.audit_outbox', 'INSERT')::text`,
      ),
      'false',
    );
  });

  test('GRANT USAGE ON SEQUENCE audit_outbox_id_seq TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser(
      'GRANT USAGE ON SEQUENCE public.audit_outbox_id_seq TO answering_service',
    );
    assertRefused('sequence grant to the vendor', r, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    assert.equal(
      await db.value(
        `SELECT has_sequence_privilege('answering_service', 'public.audit_outbox_id_seq', 'USAGE')::text`,
      ),
      'false',
    );
  });

  test("of 0018's statement kinds, CREATE TABLE and GRANT fire the guard and CREATE INDEX and COMMENT do not (a detective-only grant held open, rolled back)", async () => {
    const quiet = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'CREATE INDEX t212_guard_probe_idx ON public.audit_outbox (relayed_at)',
      `COMMENT ON TABLE public.audit_outbox IS 'probe'`,
      `SELECT 'index and comment accepted'`,
    );
    assertPermitted('CREATE INDEX and COMMENT with the guard armed', quiet);
    assertRead(
      'CREATE INDEX and COMMENT with the guard armed',
      quiet,
      'index and comment accepted',
    );
    const create = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'CREATE TABLE public.t212_guard_probe (id bigint GENERATED ALWAYS AS IDENTITY)',
    );
    assertRefused('CREATE TABLE with the guard armed', create, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    const grant = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'GRANT SELECT ON public.audit_outbox TO app_rw',
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
