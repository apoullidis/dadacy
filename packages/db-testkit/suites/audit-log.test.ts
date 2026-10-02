/**
 * T-214 — `public.audit_log` (migration 0020): P-AUDIT-LOG of tasks/state/EP-8b/OD-226-cut.md, the
 * table half of T-067's MR-3, built against OE-34 Part C as OE-50 accepted it (U-1 identity seq,
 * U-2 / D-1 the (seq, occurred_at) key, U-3 36 premade monthly partitions and no default, U-5 (5)
 * 32-byte chain hashes, U-7/U-8 app_rw only, no RLS, U-16 no search index) and OE-72 RQ-2
 * (source_outbox_id, and UNIQUE (source_outbox_id, occurred_at), kept as an exception to U-16 by
 * OE-73). T-067 MR-3's V-L1…V-L5 and V-L7's
 * premise are the refusals below. The hash chain (V-L6) is T-215's and is not tested here.
 *
 * gate:migration-lint's R-APPEND-ONLY covers audit_log and audit_log_<suffix> (every partition here).
 * It does not read the predefined roles or GRANT … ON ALL TABLES IN SCHEMA (OD-264), so these database
 * refusals are the guard that holds on the day.
 *
 * What the database does NOT refuse is pinned too, each in a case named NOT HELD: the owner app_ddl's
 * and the superuser's writes (V-L7, OD-78), one source_outbox_id at two occurred_at values, NULL
 * source_outbox_id twice, any 32 bytes as a hash, and SD's unconstrained columns (U-14 (a)). The
 * catalogue reads pin, for the parent AND for every one of the 36 partitions: columns, the identity,
 * constraints, indexes, the sequence, owner, table and column ACLs, the comment, and the counts of
 * non-internal triggers, rewrite rules and policies with both row-level-security flags (T-234's pin).
 *
 * 0021 (T-215) puts trg_audit_log_chain on this table: it refuses a supplied hash (KV070) and draws seq
 * itself. This file tests the TABLE 0020 built, so every superuser and owner (app_ddl) session here runs
 * with that trigger DISABLED inside its never-committed transaction (CHAIN_OFF, the owner's V-L7
 * position), and the committed fixture rows are written the same way and the trigger re-enabled before
 * COMMIT. app_rw sessions cannot disable it and run with the chain ON: their rows land with hashes the
 * trigger computed. The chain itself is tested in audit-chain.test.ts.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field, and exactly one ERROR line, so a
 * crash, a syntax error or a refusal for another reason cannot read as this one. Each rule has a
 * CONTROL beside it. Every UPDATE or DELETE refusal and control first reads its target row in the same
 * psql session and asserts that reading, so a statement that matched no row can pass for neither.
 *
 * Privilege refusals run over REAL LOGIN principals, each a member of exactly one role (T-020 Evidence
 * §4). Constraint refusals run as the superuser unless a case says otherwise, so no privilege is what
 * refuses them. The tests share one cluster in file order. Fixture rows are written in `beforeAll`;
 * every other write runs inside a transaction that is never committed (`inTransaction`).
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

const SUITE = 'audit-log';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't214_app_rw_probe',
  app_admin_rw: 't214_app_admin_rw_probe',
  app_safety_rw: 't214_app_safety_rw_probe',
  answering_service: 't214_answering_service_probe',
  app_ddl: 't214_app_ddl_probe',
} as const;

/** The 36 partitions 0020 premakes, derived here from the calendar, not read from the catalogue. */
const PARTITIONS: readonly { name: string; from: string; to: string }[] = Array.from(
  { length: 36 },
  (_, i) => {
    const at = (k: number): { y: number; m: number } => ({
      y: 2026 + Math.floor((9 + k) / 12),
      m: ((9 + k) % 12) + 1,
    });
    const a = at(i);
    const b = at(i + 1);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return {
      name: `audit_log_p${String(a.y)}${pad(a.m)}`,
      from: `${String(a.y)}-${pad(a.m)}-01 00:00:00+00`,
      to: `${String(b.y)}-${pad(b.m)}-01 00:00:00+00`,
    };
  },
);
const FIRST = 'audit_log_p202610';
const OTHER = 'audit_log_p202703';
const LAST = 'audit_log_p202909';

/** The fourteen columns app_rw may INSERT: every column but seq, prev_entry_hash and entry_hash. */
const RW_INSERT_COLUMNS = [
  'occurred_at',
  'actor_type',
  'actor_id',
  'action',
  'subject_type',
  'subject_id',
  'data_class',
  'policy_basis',
  'reason_code',
  'rationale',
  'before_hash',
  'after_hash',
  'request_context',
  'source_outbox_id',
] as const;

/** A SHA-256 digest (32 bytes) as SQL, distinct per label. */
const digest = (label: string): string => `sha256('${label}'::bytea)`;
/** A bytea of exactly n bytes, as SQL (n <= 64). */
const bytesOf = (n: number): string =>
  `substring(${digest('long')} || ${digest('longer')} from 1 for ${String(n)})`;

interface RowSpec {
  table?: string;
  occurredAt?: string;
  actorType?: string;
  action?: string;
  subjectType?: string;
  dataClass?: string;
  requestContext?: string;
  prev?: string;
  entry?: string;
  source?: string;
}

/** A full row as the superuser (or the owner) writes it: hashes supplied. Values are SQL. */
const fullRow = (r: RowSpec): string =>
  `INSERT INTO public.${r.table ?? 'audit_log'} (occurred_at, actor_type, action, subject_type, data_class, request_context, prev_entry_hash, entry_hash, source_outbox_id)
   VALUES (${r.occurredAt ?? "'2026-10-15 12:00:00+00'"}, ${r.actorType ?? "'system'"}, ${r.action ?? "'probe.row'"},
           ${r.subjectType ?? "'probe'"}, ${r.dataClass ?? 'NULL'}, ${r.requestContext ?? `'{"trace_id":"t"}'`},
           ${r.prev ?? digest('p')}, ${r.entry ?? digest('e')}, ${r.source ?? 'NULL'})`;

/** T-067 Q4 as app_rw writes it once T-215 exists: no seq, no hashes. Values are SQL. */
const relayRow = (r: RowSpec): string =>
  `INSERT INTO public.${r.table ?? 'audit_log'} (occurred_at, actor_type, action, subject_type, data_class, request_context, source_outbox_id)
   VALUES (${r.occurredAt ?? "'2026-10-15 12:00:00+00'"}, ${r.actorType ?? "'system'"}, ${r.action ?? "'probe.relay'"},
           ${r.subjectType ?? "'probe'"}, ${r.dataClass ?? 'NULL'}, ${r.requestContext ?? `'{"trace_id":"t"}'`},
           ${r.source ?? 'NULL'})`;

/** The fixture rows: two relayed rows (sources 1001, 1002) and one direct row (NULL source). */
const FIX_A = { occurredAt: "'2026-10-15 12:00:00+00'", source: '1001', action: "'fixture.a'" };
const FIX_B = { occurredAt: "'2027-03-10 08:30:00+00'", source: '1002', action: "'fixture.b'" };
const FIX_C = { occurredAt: "'2026-11-05 00:00:00+00'", source: 'NULL', action: "'fixture.c'" };

/** One fixture row's state, read in the session that then writes it. */
const readRow = (action: string): string =>
  `SELECT 'row ${action} count=' || count(*) FROM public.audit_log WHERE action = '${action}'`;
const PRESENT = (action: string): string => `row ${action} count=1`;

let db: Cluster;

/** 0021's chain trigger, switched off inside a superuser's or the owner's transaction (see the header). */
const CHAIN_OFF = 'ALTER TABLE public.audit_log DISABLE TRIGGER trg_audit_log_chain';

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      'BEGIN',
      CHAIN_OFF,
      fullRow(FIX_A),
      fullRow(FIX_B),
      fullRow(FIX_C),
      'ALTER TABLE public.audit_log ENABLE TRIGGER trg_audit_log_chain',
      'COMMIT',
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/**
 * Every invocation runs inside one transaction that is never committed: BEGIN is prepended unless the
 * caller opened one, and psql's session end rolls it back.
 */
const inTransaction = (commands: string[]): string[] =>
  commands[0] === 'BEGIN' ? commands : ['BEGIN', ...commands];
/** The same, with 0021's chain trigger disabled for the transaction (superuser and owner only). */
const beneathChain = (commands: string[]): string[] => {
  const t = inTransaction(commands);
  return [t[0] ?? 'BEGIN', CHAIN_OFF, ...t.slice(1)];
};

/** Statements as the bootstrap superuser, SQLSTATE in the message, stopping at the first error. */
function asSuperuser(...commands: string[]): Promise<PsqlResult> {
  return db.psql({ commands: beneathChain(commands), verbose: true, stopOnError: true });
}

/** Statements over a real login, SQLSTATE in the message, stopping at the first error. */
function asLogin(login: string, ...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands: login === LOGINS.app_ddl ? beneathChain(commands) : inTransaction(commands),
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

const denied = (table: string): string => `ERROR:  42501: permission denied for table ${table}`;
const DENIED = denied('audit_log');
const IDENTITY_428C9 = 'ERROR:  428C9: cannot insert a non-DEFAULT value into column "seq"';
const NO_PARTITION_23514 = 'ERROR:  23514: no partition of relation "audit_log" found for row';
const check23514 = (relation: string, constraint: string): string =>
  `ERROR:  23514: new row for relation "${relation}" violates check constraint "${constraint}"`;
const notNull = (column: string, relation: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "${relation}" violates not-null constraint`;
const unique23505 = (partition: string): string =>
  `ERROR:  23505: duplicate key value violates unique constraint "${partition}_source_outbox_id_occurred_at_key"`;

/** The text 0020 installs, verbatim: a change to the comment must change this suite too. */
const TABLE_COMMENT =
  'The audit log (SD §DB-10 lines 2835-2848; SA §SA-4 I-6; SA §SEC-8), partitioned by month on occurred_at. ' +
  'seq is an identity column, GENERATED ALWAYS; the primary key is (seq, occurred_at) because a key on a ' +
  'partitioned table must include occurred_at. prev_entry_hash and entry_hash are 32 bytes each (CHECK ' +
  'audit_log_prev_entry_hash_len, audit_log_entry_hash_len). source_outbox_id is the audit_outbox.id a relayed ' +
  'row came from, NULL for a row written without one; it is not a foreign key. UNIQUE ' +
  'audit_log_source_outbox_id_occurred_at_key refuses a second row with the same source_outbox_id and ' +
  'occurred_at (OE-73), not one with the same source_outbox_id at another occurred_at; NULL source_outbox_id ' +
  'values never collide. Partitions audit_log_p202610 to ' +
  'audit_log_p202909 are premade, with no default partition: a row whose occurred_at falls in none is refused. ' +
  'app_rw may SELECT and may INSERT every column except seq, prev_entry_hash and entry_hash, on the parent and ' +
  'on each partition. It holds no UPDATE, DELETE or TRUNCATE. These are grants: they bind app_rw, not the table ' +
  'owner app_ddl or the superuser. No other role is granted any privilege, and there is no row-level security.';

/** The column signature both the parent and every partition must have. */
const COLUMNS =
  'seq:bigint:nn:identity-always:-,occurred_at:timestamp with time zone:nn:-:now(),' +
  'actor_type:text:nn:-:-,actor_id:character(26):null:-:-,action:text:nn:-:-,subject_type:text:nn:-:-,' +
  'subject_id:character(26):null:-:-,data_class:text:null:-:-,policy_basis:text:null:-:-,' +
  'reason_code:text:null:-:-,rationale:text:null:-:-,before_hash:bytea:null:-:-,after_hash:bytea:null:-:-,' +
  'request_context:jsonb:nn:-:-,prev_entry_hash:bytea:nn:-:-,entry_hash:bytea:nn:-:-,' +
  'source_outbox_id:bigint:null:-:-';
const RELACL = '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}';
const COLACL = RW_INSERT_COLUMNS.map((c) => `${c}={app_rw=a/app_ddl}`).join(',');

const COLUMN_SIG = (rel: string): string =>
  `(SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                      CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                      CASE attidentity WHEN 'a' THEN 'identity-always' WHEN 'd' THEN 'identity-by-default' ELSE '-' END || ':' ||
                      coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ${rel} AND attnum > 0 AND NOT attisdropped)`;

describe('0020 — the parent: owner, columns, identity, constraints, indexes, sequence, ACL, comment', () => {
  test('seventeen columns in order (SD 2836-2846 and source_outbox_id), types, nullability, identity and defaults; owner app_ddl; ACL: app_rw SELECT and INSERT on the fourteen columns only', async () => {
    assert.equal(
      await db.value(
        `SELECT ${COLUMN_SIG('c.oid')} || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = c.oid AND attacl IS NOT NULL) || '|' || c.relkind::text
           FROM pg_class c WHERE c.oid = 'public.audit_log'::regclass`,
      ),
      `${COLUMNS}|app_ddl|${RELACL}|${COLACL}|p`,
    );
  });

  test('partitioned BY RANGE (occurred_at), with NO default partition', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_partkeydef('public.audit_log'::regclass) || ' default=' ||
                coalesce((SELECT partdefid::regclass::text FROM pg_partitioned_table
                           WHERE partrelid = 'public.audit_log'::regclass AND partdefid <> 0), 'none')`,
      ),
      'RANGE (occurred_at) default=none',
    );
  });

  test('the constraints are exactly these, by these definitions, none deferrable: the (seq, occurred_at) key, the UNIQUE, SD 2838/2841 CHECKs, the two hash-length CHECKs and the eight NOT NULLs', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid) || ' deferrable=' || condeferrable, ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'public.audit_log'::regclass`,
      ),
      'audit_log_action_not_null=NOT NULL action deferrable=false ; ' +
        "audit_log_actor_type_check=CHECK ((actor_type = ANY (ARRAY['user'::text, 'operator'::text, 'system'::text, 'provider'::text]))) deferrable=false ; " +
        'audit_log_actor_type_not_null=NOT NULL actor_type deferrable=false ; ' +
        "audit_log_data_class_check=CHECK ((data_class = ANY (ARRAY['C1'::text, 'C2'::text, 'C3'::text, 'C4'::text]))) deferrable=false ; " +
        'audit_log_entry_hash_len=CHECK ((octet_length(entry_hash) = 32)) deferrable=false ; ' +
        'audit_log_entry_hash_not_null=NOT NULL entry_hash deferrable=false ; ' +
        'audit_log_occurred_at_not_null=NOT NULL occurred_at deferrable=false ; ' +
        'audit_log_pkey=PRIMARY KEY (seq, occurred_at) deferrable=false ; ' +
        'audit_log_prev_entry_hash_len=CHECK ((octet_length(prev_entry_hash) = 32)) deferrable=false ; ' +
        'audit_log_prev_entry_hash_not_null=NOT NULL prev_entry_hash deferrable=false ; ' +
        'audit_log_request_context_not_null=NOT NULL request_context deferrable=false ; ' +
        'audit_log_seq_not_null=NOT NULL seq deferrable=false ; ' +
        'audit_log_source_outbox_id_occurred_at_key=UNIQUE (source_outbox_id, occurred_at) deferrable=false ; ' +
        'audit_log_subject_type_not_null=NOT NULL subject_type deferrable=false',
    );
  });

  test("the parent's only indexes are the key's and the UNIQUE's, with btree opclasses int8_ops/timestamptz_ops (OD-110's catalogue side); no search index (U-16)", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(i.indexrelid) || ' opclasses=' ||
                  (SELECT string_agg(o.opcname, ',' ORDER BY k.n)
                     FROM unnest(i.indclass::oid[]) WITH ORDINALITY AS k(cls, n) JOIN pg_opclass o ON o.oid = k.cls),
                  ' ; ' ORDER BY i.indexrelid::regclass::text)
           FROM pg_index i WHERE i.indrelid = 'public.audit_log'::regclass`,
      ),
      'CREATE UNIQUE INDEX audit_log_pkey ON ONLY public.audit_log USING btree (seq, occurred_at) opclasses=int8_ops,timestamptz_ops ; ' +
        'CREATE UNIQUE INDEX audit_log_source_outbox_id_occurred_at_key ON ONLY public.audit_log USING btree (source_outbox_id, occurred_at) opclasses=int8_ops,timestamptz_ops',
    );
  });

  test('the identity sequence is audit_log_seq_seq: bigint, from 1 by 1 to 2^63-1, no cycle, owned by app_ddl, granted to no role; no partition has a sequence of its own', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_serial_sequence('public.audit_log', 'seq') || '|' || s.seqtypid::regtype || ' start=' || s.seqstart ||
                ' inc=' || s.seqincrement || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cycle=' || s.seqcycle ||
                '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, 'acl-null') || '|partition sequences=' ||
                (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = 'public.audit_log'::regclass
                    AND pg_get_serial_sequence(i.inhrelid::regclass::text, 'seq') IS NOT NULL) ||
                '|sequences named audit_log%=' || (SELECT count(*) FROM pg_class WHERE relkind = 'S' AND relname LIKE 'audit\\_log%')
           FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid
          WHERE c.oid = pg_get_serial_sequence('public.audit_log', 'seq')::regclass`,
      ),
      'public.audit_log_seq_seq|bigint start=1 inc=1 min=1 max=9223372036854775807 cycle=false|app_ddl|acl-null|partition sequences=0|sequences named audit_log%=1',
    );
  });

  test('COMMENT ON TABLE is exactly this text; no column and no partition carries a comment', async () => {
    assert.equal(
      await db.value(`SELECT obj_description('public.audit_log'::regclass, 'pg_class')`),
      TABLE_COMMENT,
    );
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                  WHERE (c.oid = 'public.audit_log'::regclass OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass))
                    AND a.attnum > 0 AND col_description(a.attrelid, a.attnum) IS NOT NULL) || ' column comments, ' ||
                (SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass
                    AND obj_description(inhrelid, 'pg_class') IS NOT NULL) || ' partition comments'`,
      ),
      '0 column comments, 0 partition comments',
    );
  });
});

describe('0020 — the 36 premade partitions (U-3)', () => {
  test('exactly the 36 partitions audit_log_p202610 … audit_log_p202909, each bounded by its UTC month (expected bounds derived from the calendar, not the catalogue)', async () => {
    // pg_get_expr prints a bound in the session's TimeZone, so the session is set to UTC first.
    const r = await db.sql({
      raw: true,
      commands: [
        "SET TimeZone = 'UTC'",
        `SELECT string_agg(c.relname || ' ' || pg_get_expr(c.relpartbound, c.oid), ' ; ' ORDER BY c.relname)
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'public.audit_log'::regclass`,
      ],
    });
    const got = r.stdout.trim().split('\n').at(-1);
    assert.equal(
      got,
      PARTITIONS.map((p) => `${p.name} FOR VALUES FROM ('${p.from}') TO ('${p.to}')`).join(' ; '),
    );
    assert.equal(PARTITIONS[0]?.name, FIRST);
    assert.equal(PARTITIONS[35]?.name, LAST);
  });

  test("EVERY partition: an ordinary table in public, not itself partitioned, owned by app_ddl, with the parent's columns, the parent's table ACL and column ACLs", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(DISTINCT n.nspname || '|' || c.relkind::text || '|' || c.relispartition || '|' || pg_get_userbyid(c.relowner) || '|' ||
                           ${COLUMN_SIG('c.oid')} || '|' || c.relacl::text || '|' ||
                           (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                             WHERE attrelid = c.oid AND attacl IS NOT NULL), ' ## ') || ' x' || count(*)
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE i.inhparent = 'public.audit_log'::regclass`,
      ),
      `public|r|true|app_ddl|${COLUMNS}|${RELACL}|${COLACL} x36`,
    );
  });

  test("EVERY partition: exactly two indexes, attached to the parent's two, and exactly the parent's constraints by name or as the key's and UNIQUE's per-partition children", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(DISTINCT
                  (SELECT string_agg(replace(pg_get_indexdef(ix.indexrelid), c.relname, '<p>') || ' <- ' || coalesce(pi.inhparent::regclass::text, 'none'),
                                     ' , ' ORDER BY pg_get_indexdef(ix.indexrelid))
                     FROM pg_index ix LEFT JOIN pg_inherits pi ON pi.inhrelid = ix.indexrelid WHERE ix.indrelid = c.oid)
                  || ' | ' ||
                  (SELECT string_agg(replace(con.conname, c.relname, '<p>') || '<-' || coalesce(pc.conname, '-'), ',' ORDER BY replace(con.conname, c.relname, '<p>'))
                     FROM pg_constraint con LEFT JOIN pg_constraint pc ON pc.oid = con.conparentid
                    WHERE con.conrelid = c.oid AND con.contype <> 'n'), ' ## ') || ' x' || count(*)
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'public.audit_log'::regclass`,
      ),
      'CREATE UNIQUE INDEX <p>_pkey ON public.<p> USING btree (seq, occurred_at) <- audit_log_pkey , ' +
        'CREATE UNIQUE INDEX <p>_source_outbox_id_occurred_at_key ON public.<p> USING btree (source_outbox_id, occurred_at) <- audit_log_source_outbox_id_occurred_at_key | ' +
        '<p>_pkey<-audit_log_pkey,<p>_source_outbox_id_occurred_at_key<-audit_log_source_outbox_id_occurred_at_key,' +
        'audit_log_actor_type_check<--,audit_log_data_class_check<--,audit_log_entry_hash_len<--,audit_log_prev_entry_hash_len<-- x36',
    );
  });

  test("the parent AND every partition: exactly 1 non-internal trigger (0021's trg_audit_log_chain, enabled: its own pin is audit-chain.test.ts), 0 rewrite rules, 0 policies, row-level security neither enabled nor forced (T-234)", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(DISTINCT
                  (SELECT count(*) || ' triggers ' || string_agg(tgname || ':' || tgenabled::text, ',') FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ', ' ||
                  (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                  c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                  (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies', ' ## ') || ' x' || count(*)
           FROM pg_class c
          WHERE c.oid = 'public.audit_log'::regclass
             OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass)`,
      ),
      '1 triggers trg_audit_log_chain:O, 0 rules, rls=false, force=false, 0 policies x37',
    );
  });
});

describe('0020 — routing: no default partition, so an occurred_at outside the premade range is refused (V-L5)', () => {
  for (const [label, at] of [
    ['the first instant past the range, 2029-10-01 00:00:00+00', "'2029-10-01 00:00:00+00'"],
    [
      'the last microsecond before the range, 2026-09-30 23:59:59.999999+00',
      "'2026-09-30 23:59:59.999999+00'",
    ],
    ['2031-06-01', "'2031-06-01 00:00:00+00'"],
  ] as const) {
    test(`${label}: REFUSED as the superuser (23514, no partition found for row)`, async () => {
      assertRefusedBy(
        `superuser occurred_at ${label}`,
        await asSuperuser(fullRow({ occurredAt: at })),
        NO_PARTITION_23514,
      );
    });
  }

  test('app_rw writing T-067 Q4 with an occurred_at past the range is REFUSED by routing (23514), before anything else', async () => {
    assertRefusedBy(
      'app_rw occurred_at past the range',
      await asLogin(LOGINS.app_rw, relayRow({ occurredAt: "'2030-01-01 00:00:00+00'" })),
      NO_PARTITION_23514,
    );
  });

  test('occurred_at NULL through the parent is REFUSED by routing (23514): with no default partition a NULL key has nowhere to go', async () => {
    assertRefusedBy(
      'superuser occurred_at NULL through the parent',
      await asSuperuser(fullRow({ occurredAt: 'NULL' })),
      NO_PARTITION_23514,
    );
  });

  test('CONTROL — each bound lands in its own partition: the first instant, the last microsecond of a month, the next month, the last microsecond of the range; and a Nicosia local time just past midnight on 1 November lands in October (UTC bounds)', async () => {
    const r = await asSuperuser(
      "SET LOCAL TimeZone = 'Asia/Nicosia'",
      `${fullRow({ occurredAt: "'2026-10-01 00:00:00+00'", action: "'b1'" })} RETURNING 'b1 -> ' || tableoid::regclass`,
      `${fullRow({ occurredAt: "'2026-10-31 23:59:59.999999+00'", action: "'b2'" })} RETURNING 'b2 -> ' || tableoid::regclass`,
      `${fullRow({ occurredAt: "'2026-11-01 00:00:00+00'", action: "'b3'" })} RETURNING 'b3 -> ' || tableoid::regclass`,
      `${fullRow({ occurredAt: "'2029-09-30 23:59:59.999999+00'", action: "'b4'" })} RETURNING 'b4 -> ' || tableoid::regclass`,
      `${fullRow({ occurredAt: "'2026-11-01 01:30:00'", action: "'b5'" })} RETURNING 'b5 local 01:30 -> ' || tableoid::regclass`,
    );
    assertPermitted('bounds', r);
    for (const line of [
      'b1 -> audit_log_p202610',
      'b2 -> audit_log_p202610',
      'b3 -> audit_log_p202611',
      'b4 -> audit_log_p202909',
      'b5 local 01:30 -> audit_log_p202610',
    ]) {
      assertRead('bounds', r, line);
    }
  });

  test('a row inserted into a partition by name with an occurred_at of another month is REFUSED (23514, partition constraint)', async () => {
    assertRefusedBy(
      'superuser wrong-month row into a partition',
      await asSuperuser(
        fullRow({ table: 'audit_log_p202611', occurredAt: "'2026-10-15 00:00:00+00'" }),
      ),
      'ERROR:  23514: new row for relation "audit_log_p202611" violates partition constraint',
    );
  });
});

describe('0020 — seq is GENERATED ALWAYS AS IDENTITY (U-1); the key is (seq, occurred_at) (U-2 / D-1)', () => {
  test('app_rw supplying an explicit seq is REFUSED by the identity (428C9), not by a privilege', async () => {
    assertRefusedBy(
      'app_rw explicit seq',
      await asLogin(
        LOGINS.app_rw,
        `INSERT INTO public.audit_log (seq, occurred_at, actor_type, action, subject_type, request_context) VALUES (5, '2026-10-15+00', 'system', 'x', 'probe', '{}')`,
      ),
      IDENTITY_428C9,
    );
  });

  test('the superuser supplying an explicit seq is REFUSED by the identity too (428C9)', async () => {
    assertRefusedBy(
      'superuser explicit seq',
      await asSuperuser(
        `INSERT INTO public.audit_log (seq, occurred_at, actor_type, action, subject_type, request_context, prev_entry_hash, entry_hash) VALUES (5, '2026-10-15+00', 'system', 'x', 'probe', '{}', ${digest('p')}, ${digest('e')})`,
      ),
      IDENTITY_428C9,
    );
  });

  for (const [label, sql] of [
    [
      'OVERRIDING SYSTEM VALUE with a seq',
      `INSERT INTO public.audit_log (seq, occurred_at, actor_type, action, subject_type, request_context) OVERRIDING SYSTEM VALUE VALUES (5, '2026-10-15+00', 'system', 'x', 'probe', '{}')`,
    ],
    [
      'naming seq with the DEFAULT keyword',
      `INSERT INTO public.audit_log (seq, occurred_at, actor_type, action, subject_type, request_context) VALUES (DEFAULT, '2026-10-15+00', 'system', 'x', 'probe', '{}')`,
    ],
  ] as const) {
    test(`app_rw ${label} is REFUSED by the column grant (42501): app_rw holds no INSERT on seq`, async () => {
      assertRefusedBy(`app_rw ${label}`, await asLogin(LOGINS.app_rw, sql), DENIED);
    });
  }

  test('app_rw calling nextval on the identity sequence is REFUSED (42501)', async () => {
    assertRefusedBy(
      'app_rw nextval',
      await asLogin(LOGINS.app_rw, `SELECT nextval('public.audit_log_seq_seq')`),
      'ERROR:  42501: permission denied for sequence audit_log_seq_seq',
    );
  });

  test("CONTROL — a row written into a partition BY NAME takes the parent's sequence: seq values from the parent and from two partitions by name increase in one series", async () => {
    const r = await asSuperuser(
      `${fullRow({ action: "'s1'" })} RETURNING 's1 ' || seq`,
      `${fullRow({ table: OTHER, occurredAt: "'2027-03-01 00:00:00+00'", action: "'s2'" })} RETURNING 's2 ' || seq`,
      `${fullRow({ table: LAST, occurredAt: "'2029-09-01 00:00:00+00'", action: "'s3'" })} RETURNING 's3 ' || seq`,
      `SELECT 'one series: ' || ((SELECT seq FROM public.audit_log WHERE action = 's1') < (SELECT seq FROM public.audit_log WHERE action = 's2')
                                AND (SELECT seq FROM public.audit_log WHERE action = 's2') < (SELECT seq FROM public.audit_log WHERE action = 's3'))
              || ' distinct=' || (SELECT count(DISTINCT seq) FROM public.audit_log WHERE action IN ('s1', 's2', 's3'))`,
    );
    assertPermitted('one series', r);
    assertRead('one series', r, 'one series: true distinct=3');
  });

  test('the owner app_ddl duplicating an existing (seq, occurred_at) with OVERRIDING SYSTEM VALUE is REFUSED by the key (23505)', async () => {
    const r = await asLogin(
      LOGINS.app_ddl,
      readRow('fixture.a'),
      `INSERT INTO public.audit_log (seq, occurred_at, actor_type, action, subject_type, request_context, prev_entry_hash, entry_hash)
       OVERRIDING SYSTEM VALUE
       SELECT seq, occurred_at, 'system', 'dup', 'probe', '{}', ${digest('p')}, ${digest('e')} FROM public.audit_log WHERE action = 'fixture.a'`,
    );
    assertRead('owner duplicate key', r, PRESENT('fixture.a'));
    assertRefusedBy(
      'owner duplicate key',
      r,
      'ERROR:  23505: duplicate key value violates unique constraint "audit_log_p202610_pkey"',
      'CONSTRAINT NAME:  audit_log_p202610_pkey',
    );
  });

  test("NOT HELD — the owner app_ddl gives an existing seq to a row at ANOTHER occurred_at (OVERRIDING SYSTEM VALUE): accepted; seq's own uniqueness rests on the identity sequence, not a constraint", async () => {
    const r = await asLogin(
      LOGINS.app_ddl,
      readRow('fixture.a'),
      `INSERT INTO public.audit_log (seq, occurred_at, actor_type, action, subject_type, request_context, prev_entry_hash, entry_hash)
       OVERRIDING SYSTEM VALUE
       SELECT seq, occurred_at + interval '1 day', 'system', 'dup-seq', 'probe', '{}', ${digest('p')}, ${digest('e')} FROM public.audit_log WHERE action = 'fixture.a'
       RETURNING 'owner wrote seq twice'`,
      `SELECT 'rows sharing that seq: ' || count(*) FROM public.audit_log WHERE seq = (SELECT seq FROM public.audit_log WHERE action = 'fixture.a')`,
    );
    assertPermitted('owner seq twice', r);
    assertRead('owner seq twice', r, 'owner wrote seq twice');
    assertRead('owner seq twice', r, 'rows sharing that seq: 2');
  });
});

describe('0020 — OE-72 RQ-2: source_outbox_id and UNIQUE (source_outbox_id, occurred_at)', () => {
  test("a second row with the same (source_outbox_id, occurred_at) is REFUSED (23505, naming the PARTITION's constraint), as the superuser", async () => {
    const r = await asSuperuser(readRow('fixture.a'), fullRow({ ...FIX_A, action: "'again'" }));
    assertRead('duplicate relay', r, PRESENT('fixture.a'));
    assertRefusedBy(
      'duplicate relay',
      r,
      unique23505('audit_log_p202610'),
      'CONSTRAINT NAME:  audit_log_p202610_source_outbox_id_occurred_at_key',
    );
  });

  test('two rows with one (source_outbox_id, occurred_at) in a single INSERT are REFUSED (23505)', async () => {
    assertRefusedBy(
      'one statement, two rows',
      await asSuperuser(
        `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context, prev_entry_hash, entry_hash, source_outbox_id)
         VALUES ('2027-03-02+00', 'system', 'x', 'probe', '{}', ${digest('p')}, ${digest('e')}, 2001),
                ('2027-03-02+00', 'system', 'y', 'probe', '{}', ${digest('p')}, ${digest('e')}, 2001)`,
      ),
      unique23505(OTHER),
    );
  });

  test('the owner app_ddl is bound by the UNIQUE too (23505)', async () => {
    const r = await asLogin(
      LOGINS.app_ddl,
      readRow('fixture.b'),
      fullRow({ ...FIX_B, action: "'owner-again'" }),
    );
    assertRead('owner duplicate relay', r, PRESENT('fixture.b'));
    assertRefusedBy('owner duplicate relay', r, unique23505(OTHER));
  });

  test('CONTROL — INSERT … ON CONFLICT (source_outbox_id, occurred_at) DO NOTHING on a relayed pair inserts nothing, and the original row is untouched', async () => {
    const r = await asSuperuser(
      `${fullRow({ ...FIX_A, action: "'again'" })} ON CONFLICT (source_outbox_id, occurred_at) DO NOTHING`,
      `SELECT 'rows for 1001: ' || count(*) || ' original: ' || bool_and(action = 'fixture.a') FROM public.audit_log WHERE source_outbox_id = 1001`,
    );
    assertPermitted('on conflict do nothing', r);
    assertRead('on conflict do nothing', r, 'INSERT 0 0');
    assertRead('on conflict do nothing', r, 'rows for 1001: 1 original: true');
  });

  test('NOT HELD — the same source_outbox_id at ANOTHER occurred_at is accepted: the UNIQUE refuses a duplicate relay only when it carries the same occurred_at (U-9)', async () => {
    const r = await asSuperuser(
      `${fullRow({ occurredAt: "'2026-10-15 12:00:00.000001+00'", source: '1001', action: "'shifted'" })} RETURNING 'second row for 1001 one microsecond later'`,
      `${fullRow({ occurredAt: "'2027-01-01 00:00:00+00'", source: '1001', action: "'other-month'" })} RETURNING 'third row for 1001 in another partition'`,
      `SELECT 'rows for 1001: ' || count(*) FROM public.audit_log WHERE source_outbox_id = 1001`,
    );
    assertPermitted('same source, other time', r);
    assertRead('same source, other time', r, 'second row for 1001 one microsecond later');
    assertRead('same source, other time', r, 'third row for 1001 in another partition');
    assertRead('same source, other time', r, 'rows for 1001: 3');
  });

  test('NOT HELD — source_outbox_id NULL twice at one occurred_at is accepted (NULLs never collide): rows written without an outbox row (U-7 (4a)) are not deduplicated', async () => {
    const r = await asSuperuser(
      `${fullRow({ ...FIX_C, action: "'direct-2'" })} RETURNING 'second NULL-source row at the fixture time'`,
      `SELECT 'NULL-source rows at that time: ' || count(*) FROM public.audit_log WHERE source_outbox_id IS NULL AND occurred_at = ${FIX_C.occurredAt}`,
    );
    assertPermitted('NULL source twice', r);
    assertRead('NULL source twice', r, 'NULL-source rows at that time: 2');
  });

  test('NOT HELD — source_outbox_id names nothing: an id with no audit_outbox row, 0 and a negative id are accepted (no foreign key, OE-72 RQ-2)', async () => {
    const r = await asSuperuser(
      `${fullRow({ source: '987654321', action: "'n1'" })} RETURNING 'accepted ' || source_outbox_id`,
      `${fullRow({ source: '0', action: "'n2'" })} RETURNING 'accepted ' || source_outbox_id`,
      `${fullRow({ source: '-7', action: "'n3'" })} RETURNING 'accepted ' || source_outbox_id`,
      `SELECT 'outbox rows with those ids: ' || count(*) FROM public.audit_outbox WHERE id IN (987654321, 0, -7)`,
    );
    assertPermitted('source names nothing', r);
    for (const line of [
      'accepted 987654321',
      'accepted 0',
      'accepted -7',
      'outbox rows with those ids: 0',
    ]) {
      assertRead('source names nothing', r, line);
    }
  });
});

describe('0020 — the CHECKs (SD 2838, 2841; U-5 (5)) and the NOT NULLs (V-L3, V-L4)', () => {
  for (const value of ["'admin'", "'User'"]) {
    test(`actor_type ${value} is REFUSED by audit_log_actor_type_check (23514), as the superuser`, async () => {
      assertRefusedBy(
        `actor_type ${value}`,
        await asSuperuser(fullRow({ actorType: value })),
        check23514(FIRST, 'audit_log_actor_type_check'),
        'CONSTRAINT NAME:  audit_log_actor_type_check',
      );
    });
  }

  for (const value of ["'C5'", "'c1'"]) {
    test(`data_class ${value} is REFUSED by audit_log_data_class_check (23514), as the superuser`, async () => {
      assertRefusedBy(
        `data_class ${value}`,
        await asSuperuser(fullRow({ dataClass: value })),
        check23514(FIRST, 'audit_log_data_class_check'),
        'CONSTRAINT NAME:  audit_log_data_class_check',
      );
    });
  }

  test('CONTROL — each declared actor_type and data_class is accepted, and data_class NULL', async () => {
    const r = await asSuperuser(
      ...['user', 'operator', 'system', 'provider'].map(
        (a, i) =>
          `${fullRow({ actorType: `'${a}'`, dataClass: `'C${String(i + 1)}'`, action: `'ok-${a}'` })} RETURNING 'ok ${a} C${String(i + 1)}'`,
      ),
      `${fullRow({ dataClass: 'NULL', action: "'ok-null'" })} RETURNING 'ok data_class NULL'`,
    );
    assertPermitted('declared values', r);
    for (const line of [
      'ok user C1',
      'ok operator C2',
      'ok system C3',
      'ok provider C4',
      'ok data_class NULL',
    ]) {
      assertRead('declared values', r, line);
    }
  });

  for (const [column, constraint] of [
    ['prev', 'audit_log_prev_entry_hash_len'],
    ['entry', 'audit_log_entry_hash_len'],
  ] as const) {
    for (const n of [31, 33, 0]) {
      test(`a ${String(n)}-byte ${column === 'prev' ? 'prev_entry_hash' : 'entry_hash'} is REFUSED by ${constraint} (23514), as the superuser`, async () => {
        assertRefusedBy(
          `${column} ${String(n)} bytes`,
          await asSuperuser(fullRow({ [column]: bytesOf(n) })),
          check23514(FIRST, constraint),
          `CONSTRAINT NAME:  ${constraint}`,
        );
      });
    }
  }

  test('the owner app_ddl writing a 31-byte prev_entry_hash is REFUSED (23514): the CHECKs bind the owner too', async () => {
    assertRefusedBy(
      'owner 31-byte prev_entry_hash',
      await asLogin(LOGINS.app_ddl, fullRow({ prev: bytesOf(31) })),
      check23514(FIRST, 'audit_log_prev_entry_hash_len'),
      'CONSTRAINT NAME:  audit_log_prev_entry_hash_len',
    );
  });

  test("the superuser updating a row's entry_hash to 31 bytes is REFUSED (23514): the CHECK binds every writer", async () => {
    const r = await asSuperuser(
      readRow('fixture.a'),
      `UPDATE public.audit_log SET entry_hash = ${bytesOf(31)} WHERE action = 'fixture.a'`,
    );
    assertRead('superuser entry_hash to 31 bytes', r, PRESENT('fixture.a'));
    assertRefusedBy(
      'superuser entry_hash to 31 bytes',
      r,
      check23514(FIRST, 'audit_log_entry_hash_len'),
    );
  });

  for (const column of [
    'actor_type',
    'action',
    'subject_type',
    'request_context',
    'prev_entry_hash',
    'entry_hash',
  ] as const) {
    test(`${column} NULL is REFUSED (23502, naming the column), as the superuser`, async () => {
      const key = {
        actor_type: 'actorType',
        action: 'action',
        subject_type: 'subjectType',
        request_context: 'requestContext',
        prev_entry_hash: 'prev',
        entry_hash: 'entry',
      } as const;
      const spec: RowSpec = { [key[column]]: 'NULL' };
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(fullRow(spec)),
        notNull(column, FIRST),
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('occurred_at NULL into a partition BY NAME is REFUSED (23502, naming the column): through the parent, routing refuses it first (above)', async () => {
    assertRefusedBy(
      'occurred_at NULL by name',
      await asSuperuser(fullRow({ table: FIRST, occurredAt: 'NULL' })),
      notNull('occurred_at', FIRST),
      'COLUMN NAME:  occurred_at',
    );
  });

  test("NOT HELD — any 32 bytes are accepted as either hash (32 zero bytes measured): the CHECKs read only the length; the chain is T-215's", async () => {
    const r = await asSuperuser(
      `${fullRow({ prev: `decode(repeat('00', 32), 'hex')`, entry: `decode(repeat('00', 32), 'hex')`, action: "'zeros'" })} RETURNING 'zeros accepted'`,
    );
    assertPermitted('zero hashes', r);
    assertRead('zero hashes', r, 'zeros accepted');
  });

  test("NOT HELD — SD's unconstrained columns (U-14 (a)): an empty action and subject_type, a request_context that is an array, a 10000-character rationale, an actor_id naming nothing", async () => {
    const r = await asSuperuser(
      `INSERT INTO public.audit_log (occurred_at, actor_type, actor_id, action, subject_type, rationale, request_context, prev_entry_hash, entry_hash)
       VALUES ('2026-10-20+00', 'user', '00000000000000000000000000', '', '', repeat('x', 10000), '[1,2]', ${digest('p')}, ${digest('e')})
       RETURNING 'unconstrained accepted, rationale ' || length(rationale)`,
    );
    assertPermitted('unconstrained columns', r);
    assertRead('unconstrained columns', r, 'unconstrained accepted, rationale 10000');
  });
});

describe('0020 — app_rw: SELECT, and INSERT on fourteen columns; no UPDATE, DELETE or TRUNCATE, on the parent or a partition (V-L1)', () => {
  test('on the parent AND on every partition, app_rw holds INSERT on exactly the fourteen columns, UPDATE on none, table SELECT, and no table INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER', async () => {
    const expected =
      'seq=false/false,' +
      [
        'occurred_at',
        'actor_type',
        'actor_id',
        'action',
        'subject_type',
        'subject_id',
        'data_class',
        'policy_basis',
        'reason_code',
        'rationale',
        'before_hash',
        'after_hash',
        'request_context',
      ]
        .map((c) => `${c}=true/false`)
        .join(',') +
      ',prev_entry_hash=false/false,entry_hash=false/false,source_outbox_id=true/false' +
      ' table:SELECT=true,INSERT=false,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false';
    assert.equal(
      await db.value(
        `SELECT string_agg(DISTINCT
                  (SELECT string_agg(attname || '=' || has_column_privilege('app_rw', c.oid, attname, 'INSERT') || '/' ||
                                     has_column_privilege('app_rw', c.oid, attname, 'UPDATE'), ',' ORDER BY attnum)
                     FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 AND NOT attisdropped) || ' table:' ||
                  (SELECT string_agg(p || '=' || has_table_privilege('app_rw', c.oid, p), ',')
                     FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p), ' ## ') || ' x' || count(*)
           FROM pg_class c
          WHERE c.oid = 'public.audit_log'::regclass
             OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass)`,
      ),
      `${expected} x37`,
    );
  });

  for (const [label, column] of [
    ['prev_entry_hash', 'prev_entry_hash'],
    ['entry_hash', 'entry_hash'],
  ] as const) {
    test(`app_rw INSERT naming ${label} is REFUSED by the column grant (42501): callers supply no hash (U-5 (1a))`, async () => {
      assertRefusedBy(
        `app_rw names ${label}`,
        await asLogin(
          LOGINS.app_rw,
          `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context, ${column}) VALUES ('2026-10-15+00', 'system', 'x', 'probe', '{}', ${digest('h')})`,
        ),
        DENIED,
      );
    });
  }

  test("app_rw INSERT naming entry_hash into a partition BY NAME is REFUSED by that partition's column grant (42501)", async () => {
    assertRefusedBy(
      'app_rw names entry_hash by partition',
      await asLogin(
        LOGINS.app_rw,
        `INSERT INTO public.${FIRST} (occurred_at, actor_type, action, subject_type, request_context, entry_hash) VALUES ('2026-10-15+00', 'system', 'x', 'probe', '{}', ${digest('h')})`,
      ),
      denied(FIRST),
    );
  });

  for (const target of ['audit_log', FIRST] as const) {
    test(`CONTROL — app_rw writing T-067 Q4 (the fourteen columns, no hash) into ${target} passes every privilege check and lands, both hashes set by 0021's chain trigger (T-215)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        `${relayRow({ table: target, source: '3001' })} RETURNING 'q4 hashes ' || octet_length(prev_entry_hash) || '/' || octet_length(entry_hash)`,
      );
      assertPermitted(`app_rw Q4 into ${target}`, r);
      assertRead(`app_rw Q4 into ${target}`, r, 'q4 hashes 32/32');
    });
  }

  for (const [label, sql] of [
    [
      'UPDATE of rationale',
      (t: string) => `UPDATE public.${t} SET rationale = 'forged' WHERE action = 'fixture.a'`,
    ],
    [
      'UPDATE of entry_hash',
      (t: string) =>
        `UPDATE public.${t} SET entry_hash = ${digest('forged')} WHERE action = 'fixture.a'`,
    ],
    [
      'UPDATE of occurred_at (a move between partitions)',
      (t: string) =>
        `UPDATE public.${t} SET occurred_at = occurred_at + interval '1 month' WHERE action = 'fixture.a'`,
    ],
    ['DELETE', (t: string) => `DELETE FROM public.${t} WHERE action = 'fixture.a'`],
    [
      'SELECT … FOR UPDATE',
      (t: string) => `SELECT seq FROM public.${t} WHERE action = 'fixture.a' FOR UPDATE`,
    ],
  ] as const) {
    for (const role of ['app_rw', 'app_admin_rw'] as const) {
      for (const target of ['audit_log', FIRST] as const) {
        test(`${role} ${label} on ${target === 'audit_log' ? 'the parent' : `partition ${target} by name`} is REFUSED (42501)`, async () => {
          const pre = role === 'app_rw' ? [readRow('fixture.a')] : [];
          const r = await asLogin(LOGINS[role], ...pre, sql(target));
          if (role === 'app_rw') assertRead(`${role} ${label} ${target}`, r, PRESENT('fixture.a'));
          assertRefusedBy(`${role} ${label} ${target}`, r, denied(target));
        });
      }
    }
  }

  for (const role of ['app_rw', 'app_admin_rw'] as const) {
    for (const target of ['audit_log', FIRST] as const) {
      test(`${role} TRUNCATE of ${target === 'audit_log' ? 'the parent' : `partition ${target} by name`} is REFUSED (42501)`, async () => {
        assertRefusedBy(
          `${role} TRUNCATE ${target}`,
          await asLogin(LOGINS[role], `TRUNCATE public.${target}`),
          denied(target),
        );
      });
    }
  }

  test("CONTROL — app_rw reads: the head (ORDER BY seq DESC LIMIT 1), the verifier's scan (ORDER BY seq), one partition by name", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'head ' || action FROM public.audit_log ORDER BY seq DESC LIMIT 1`,
      `SELECT 'scan ' || string_agg(action, ',' ORDER BY seq) FROM public.audit_log`,
      `SELECT 'by name ' || string_agg(action, ',') FROM public.${OTHER}`,
    );
    assertPermitted('app_rw reads', r);
    assertRead('app_rw reads', r, 'head fixture.c');
    assertRead('app_rw reads', r, 'scan fixture.a,fixture.b,fixture.c');
    assertRead('app_rw reads', r, 'by name fixture.b');
  });
});

describe("0020 — app_rw rows land, their hashes set by 0021's trg_audit_log_chain (T-215)", () => {
  test("CONTROL — app_rw's Q4 lands through the parent and through a partition by name, each in its month, with a seq and both hashes; a duplicate relay is REFUSED (23505); ON CONFLICT DO NOTHING inserts nothing", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `${relayRow({ occurredAt: "'2026-12-24 18:00:00+00'", source: '4001', action: "'rw-parent'" })} RETURNING 'parent row -> ' || tableoid::regclass || ' seq>0:' || (seq > 0) || ' hashes:' || octet_length(prev_entry_hash) || '/' || octet_length(entry_hash)`,
      `${relayRow({ table: OTHER, occurredAt: "'2027-03-20 00:00:00+00'", source: '4002', action: "'rw-by-name'" })} RETURNING 'by-name row -> ' || tableoid::regclass`,
      `${relayRow({ occurredAt: "'2026-12-24 18:00:00+00'", source: '4001', action: "'rw-again'" })} ON CONFLICT (source_outbox_id, occurred_at) DO NOTHING`,
      `SELECT 'rows for 4001: ' || count(*) FROM public.audit_log WHERE source_outbox_id = 4001`,
    );
    assertPermitted('app_rw rows land', r);
    assertRead('app_rw rows land', r, 'parent row -> audit_log_p202612 seq>0:true hashes:32/32');
    assertRead('app_rw rows land', r, `by-name row -> ${OTHER}`);
    assertRead('app_rw rows land', r, 'INSERT 0 0');
    assertRead('app_rw rows land', r, 'rows for 4001: 1');
    const dup = await asLogin(
      LOGINS.app_rw,
      relayRow({ occurredAt: "'2026-10-15 12:00:00+00'", source: '1001', action: "'rw-dup'" }),
    );
    assertRefusedBy('app_rw duplicate relay', dup, unique23505(FIRST));
  });
});

describe('0020 — no other role reads or writes it (U-7, U-8; V-L2), over real single-membership logins', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    for (const target of ['audit_log', FIRST] as const) {
      test(`${role} SELECT on ${target} is REFUSED (42501)`, async () => {
        assertRefusedBy(
          `${role} SELECT ${target}`,
          await asLogin(LOGINS[role], `SELECT count(*) FROM public.${target}`),
          denied(target),
        );
      });

      test(`${role} INSERT into ${target} is REFUSED (42501)`, async () => {
        assertRefusedBy(
          `${role} INSERT ${target}`,
          await asLogin(LOGINS[role], relayRow({ table: target })),
          denied(target),
        );
      });
    }
  }

  test('no role but app_ddl (the owner) and app_rw holds any privilege on the parent or on any partition, PUBLIC included', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(DISTINCT r || '=' ||
                  (has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
                   has_any_column_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')), ',')
           FROM unnest(ARRAY['app_admin_rw', 'app_safety_rw', 'answering_service', 'app_rw', 'public']) r,
                pg_class c
          WHERE c.oid = 'public.audit_log'::regclass
             OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass)`,
      ),
      'answering_service=false,app_admin_rw=false,app_rw=true,app_safety_rw=false,public=false',
    );
  });
});

describe("0020 — V-L7's premise: the owner is not bound by V-L1 (OD-78; U-13 (a))", () => {
  test('MEASURED — an app_ddl-only login (rolsuper false, member of app_ddl alone) UPDATEs and DELETEs rows through the parent and a partition, TRUNCATEs a partition and DETACHes one (BEGIN … ROLLBACK)', async () => {
    const r = await asLogin(
      LOGINS.app_ddl,
      `SELECT 'login super=' || rolsuper || ' member_of=' || (SELECT string_agg(b.rolname, ',') FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid) FROM pg_roles r WHERE rolname = session_user`,
      readRow('fixture.a'),
      `UPDATE public.audit_log SET rationale = 'forged' WHERE action = 'fixture.a' RETURNING 'owner updated ' || action || ' to ' || rationale`,
      `DELETE FROM public.${OTHER} WHERE action = 'fixture.b' RETURNING 'owner deleted ' || action`,
      `TRUNCATE public.audit_log_p202611`,
      `ALTER TABLE public.audit_log DETACH PARTITION public.${LAST}`,
      `SELECT 'partitions now ' || count(*) FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass`,
    );
    assertPermitted('owner rewrites', r);
    assertRead('owner rewrites', r, 'login super=false member_of=app_ddl');
    assertRead('owner rewrites', r, PRESENT('fixture.a'));
    assertRead('owner rewrites', r, 'owner updated fixture.a to forged');
    assertRead('owner rewrites', r, 'owner deleted fixture.b');
    assertRead('owner rewrites', r, 'partitions now 35');
  });

  test('NOT HELD — the superuser rewrites and deletes rows too: the grants bind app_rw only', async () => {
    const r = await asSuperuser(
      readRow('fixture.a'),
      `UPDATE public.audit_log SET rationale = 'forged', occurred_at = occurred_at - interval '1 day' WHERE action = 'fixture.a' RETURNING 'superuser rewrote ' || action`,
      `DELETE FROM public.audit_log WHERE action = 'fixture.b' RETURNING 'superuser deleted ' || action`,
    );
    assertPermitted('superuser rewrites', r);
    assertRead('superuser rewrites', r, 'superuser rewrote fixture.a');
    assertRead('superuser rewrites', r, 'superuser deleted fixture.b');
  });

  test('the fixture rows survive every refusal and rolled-back write above: three rows, nothing else, 36 partitions', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(action || '@' || tableoid::regclass || ':' || coalesce(source_outbox_id::text, 'NULL') || ':' || coalesce(rationale, '-'), ',' ORDER BY action) ||
                ' total=' || (SELECT count(*) FROM public.audit_log) ||
                ' partitions=' || (SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass)
           FROM public.audit_log`,
      ),
      `fixture.a@${FIRST}:1001:-,fixture.b@${OTHER}:1002:-,fixture.c@audit_log_p202611:NULL:- total=3 partitions=36`,
    );
  });
});

describe('0020 — the SA §INT-10 guard', () => {
  for (const target of ['audit_log', FIRST] as const) {
    test(`GRANT SELECT ON ${target} TO answering_service is REFUSED by the guard (KV010) and lands nothing`, async () => {
      const r = await asSuperuser(`GRANT SELECT ON public.${target} TO answering_service`);
      assertRefused(`grant SELECT on ${target} to the vendor`, r, {
        message: `ERROR:  KV010: ${INT10_RAISE}`,
      });
      assert.ok(
        r.output.includes(`answering_service holds SELECT on public.${target}`),
        `the guard's DETAIL does not name ${target}.\n${r.output}`,
      );
      assert.equal(
        await db.value(
          `SELECT has_table_privilege('answering_service', 'public.${target}', 'SELECT')::text`,
        ),
        'false',
      );
    });
  }

  test(`GRANT INSERT (action) ON ${FIRST} TO answering_service (a column grant on a partition) is REFUSED by the guard (KV010)`, async () => {
    const r = await asSuperuser(`GRANT INSERT (action) ON public.${FIRST} TO answering_service`);
    assertRefused('column grant on a partition to the vendor', r, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
  });

  test('GRANT USAGE ON SEQUENCE audit_log_seq_seq TO answering_service is REFUSED by the guard (KV010)', async () => {
    const r = await asSuperuser(
      'GRANT USAGE ON SEQUENCE public.audit_log_seq_seq TO answering_service',
    );
    assertRefused('sequence grant to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
  });

  test("of 0020's statement kinds, CREATE TABLE … PARTITION OF and GRANT fire the guard and COMMENT does not (a detective-only grant held open, rolled back)", async () => {
    const quiet = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      `COMMENT ON TABLE public.audit_log IS 'probe'`,
      `SELECT 'comment accepted'`,
    );
    assertPermitted('COMMENT with the guard armed', quiet);
    assertRead('COMMENT with the guard armed', quiet, 'comment accepted');
    const partition = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      `CREATE TABLE public.audit_log_p202910 PARTITION OF public.audit_log FOR VALUES FROM ('2029-10-01 00:00:00+00') TO ('2029-11-01 00:00:00+00')`,
    );
    assertRefused('CREATE TABLE … PARTITION OF with the guard armed', partition, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    const grant = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      `GRANT SELECT ON public.${FIRST} TO app_rw`,
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
