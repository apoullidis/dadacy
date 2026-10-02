/**
 * T-215 — the audit_log hash chain (migration 0021): P-AUDIT-CHAIN of tasks/state/EP-8b/OD-226-cut.md,
 * the chain half of T-067's MR-3, built against OE-34 Part C U-5 and U-6 as OE-50 accepted them, on
 * T-214's 0020 table. trg_audit_log_chain (BEFORE INSERT, FOR EACH ROW, on the partitioned parent and
 * cloned to every partition) runs public.audit_log_chain(), SECURITY DEFINER: a supplied hash is KV070;
 * a writer not in READ COMMITTED is KV072; then pg_advisory_xact_lock(5428598235315393603); seq drawn
 * under the lock; the head (greatest seq) chained to, genesis 32 zero bytes, KV071 if seq is not above
 * it; entry_hash = sha256(prev_entry_hash || convert_to(canonical_json, 'UTF8')).
 *
 * THE VECTORS are not this database's reading of itself (PROTOCOL §5.1). Their expected hashes were
 * computed on the host by `.cache/t215/vectors.sh` with sha256sum over canonical_json bytes written by
 * hand from the rules in 0021's header, and are pasted here as literals (tasks/state/EP-3/T-215.md
 * § Published contract). T-067's TypeScript verifier must reproduce the same three hashes.
 *
 * Concurrency cases run two or three psql sessions at once, ordered by pg_sleep: a session that must
 * start later sleeps first. Each asserts the observed lock wait (pg_locks) as well as the chain, so a
 * run whose timing slipped cannot pass for one that serialised.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND exactly one
 * ERROR line. Privilege-bearing statements run over REAL LOGIN principals, each a member of exactly one
 * role. File order matters: the vector and genesis cases run on an empty table inside transactions that
 * are never committed; the concurrency cases then COMMIT rows; the KV071 case moves the sequence back and
 * restores it in `finally`.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  PROBE_PASSWORD,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused } from '../src/expect.ts';

const SUITE = 'audit-chain';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't215_app_rw_probe',
  app_rw_b: 't215_app_rw_probe_b',
  app_ddl: 't215_app_ddl_probe',
} as const;
const ROLE_OF: Record<string, string> = {
  [LOGINS.app_rw]: 'app_rw',
  [LOGINS.app_rw_b]: 'app_rw',
  [LOGINS.app_ddl]: 'app_ddl',
};

/** The chain key, and how pg_locks shows it (single-key form: objsubid 1). */
const KEY = '5428598235315393603';
const KEY_CLASSID = '1263944021';
const KEY_OBJID = '1145656387';
const GENESIS = '00'.repeat(32);

/**
 * EXTERNAL VECTORS: computed on the host by .cache/t215/vectors.sh (sha256sum 0.10.0, 2026-10-02T23:25:51Z),
 * NOT by this database. Inputs are the three INSERTs below; the chain starts from GENESIS.
 */
const VECTORS = [
  {
    name: 'V1',
    seq: '9007199254740993',
    entry: 'eb4e8c36d32941902f505542fd021f2a8b4a65aeb885c2043b75a1c60fb3b6a5',
    sql: `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context)
          VALUES ('2026-10-15 12:34:56.789123+00', 'system', 'vector.genesis', 'probe', '{}')`,
  },
  {
    name: 'V2',
    seq: '9007199254740995',
    entry: 'd509d63d297addddb2cfdd7345a679e31d2b7735decc228276e818ed321f13c5',
    sql: `INSERT INTO public.audit_log (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class,
                                       policy_basis, reason_code, rationale, before_hash, after_hash, request_context,
                                       source_outbox_id)
          VALUES ('2026-11-01 00:00:00+00', 'user', '01J9ABCDEFGHJKMNPQRSTVWXYZ', 'booking.read', 'booking', 'ab', 'C2',
                  'relationship:window', 'R-1',
                  E'Quote " back\\\\slash, line1\\ntab\\t\\u00e9 NFC e\\u0301 NFD \\u20ac \\U0001F600 ctl\\u0001 del\\u007f',
                  '\\x00ff10', decode(repeat('deadbeef', 8), 'hex'),
                  '{"trace_id":"t-1","ip_prefix":"203.0.113.0/24","n":{"big":9007199254740993,"dec":1.10,"exp":1e2,"neg0":-0,"tiny":1E-7,"arr":[3,"x",null,true,false]},"z":"\\u00e9"}',
                  9223372036854775807)`,
  },
  {
    name: 'V3',
    seq: '9007199254740997',
    entry: '36531f3ba61d3c3c6de1897dd8ebc18617861ba507ce12b9a5ce919b4e4af485',
    sql: `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, data_class, before_hash,
                                       request_context, source_outbox_id)
          VALUES ('2027-03-09 18:30:00.5+00', 'provider', 'credential.verify', 'credential', 'C4', '\\x0102',
                  '{"trace_id":"t-3"}', 42)`,
  },
] as const;

/** T-067 Q4's shape: no seq, no hashes. Values are SQL. */
const row = (
  action: string,
  opts: { table?: string; at?: string; context?: string; source?: string } = {},
): string =>
  `INSERT INTO public.${opts.table ?? 'audit_log'} (occurred_at, actor_type, action, subject_type, request_context, source_outbox_id)
   VALUES (${opts.at ?? "'2026-10-15 12:00:00+00'"}, 'system', '${action}', 'probe', ${opts.context ?? "'{}'"}, ${opts.source ?? 'NULL'})`;
const returning = (action: string): string =>
  ` RETURNING '${action} seq=' || seq || ' prev=' || encode(prev_entry_hash, 'hex') || ' entry=' || encode(entry_hash, 'hex')`;

/** Each named row as `action<-predecessor` in seq order; GENESIS for 32 zero bytes, ?? for no row. */
const walkOf = (actions: readonly string[]): string =>
  `SELECT coalesce(string_agg(a.action || '<-' ||
            coalesce((SELECT b.action FROM public.audit_log b WHERE b.entry_hash = a.prev_entry_hash LIMIT 1),
                     CASE WHEN a.prev_entry_hash = '\\x${GENESIS}'::bytea THEN 'GENESIS' ELSE '??' END),
            ' ' ORDER BY a.seq), '(none)')
     FROM public.audit_log a WHERE a.action IN (${actions.map((x) => `'${x}'`).join(', ')})`;
const SHARED_PREDECESSORS = `SELECT 'rows sharing a predecessor: ' || coalesce((SELECT string_agg(n::text, ',') FROM
   (SELECT count(*) AS n FROM public.audit_log GROUP BY prev_entry_hash HAVING count(*) > 1) x), 'none')`;
const WHOLE_CHAIN_LINKS = `SELECT 'whole chain: ' || count(*) || ' rows, ' || count(*) FILTER (WHERE NOT linked) || ' mislinked'
   FROM (SELECT prev_entry_hash IS NOT DISTINCT FROM coalesce(lag(entry_hash) OVER (ORDER BY seq), '\\x${GENESIS}'::bytea) AS linked
           FROM public.audit_log) x`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${ROLE_OF[login] ?? 'nobody'}`,
      ),
      // A volatile delay a writer can put in its own VALUES list, after the seq default has drawn.
      `CREATE FUNCTION public.t215_slow(j jsonb, s float8) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_sleep(s); RETURN j; END $$`,
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** Statements in one session, never committed unless the caller COMMITs. */
function session(
  user: string | undefined,
  commands: string[],
  opts: { raw?: boolean } = {},
): Promise<PsqlResult> {
  return db.psql({
    ...(user === undefined ? {} : { user, password: PROBE_PASSWORD }),
    commands:
      commands[0] === 'BEGIN' || commands[0]?.startsWith('SET application_name') === true
        ? commands
        : ['BEGIN', ...commands],
    verbose: true,
    stopOnError: true,
    raw: opts.raw ?? true,
  });
}
const asRw = (...c: string[]): Promise<PsqlResult> => session(LOGINS.app_rw, c);
const asOwner = (...c: string[]): Promise<PsqlResult> => session(LOGINS.app_ddl, c);
const asSuperuser = (...c: string[]): Promise<PsqlResult> => session(undefined, c);

/** Refused with exactly this ERROR line, and exactly one ERROR line. */
function assertRefusedBy(what: string, r: PsqlResult, errorLine: string): void {
  assertRefused(what, r, { message: errorLine });
  assert.equal(
    (r.output.match(/ERROR: {2}[0-9A-Z]{5}:/g) ?? []).length,
    1,
    `${what}: expected exactly one ERROR line.\n${r.output}`,
  );
}
function assertHas(what: string, r: PsqlResult, text: string): void {
  assert.ok(r.output.includes(text), `${what}: expected ${JSON.stringify(text)}.\n${r.output}`);
}
/** The value printed after `<label> ` on its own line. */
function field(r: PsqlResult, label: string): string {
  const line = r.stdout.split('\n').find((l) => l.startsWith(`${label} `));
  assert.ok(line !== undefined, `no line starting ${JSON.stringify(label)}.\n${r.output}`);
  return line.slice(label.length + 1);
}

const KV070 =
  'ERROR:  KV070: AUDIT_CHAIN_HASH_SUPPLIED: audit_log.prev_entry_hash and entry_hash are set by trg_audit_log_chain; a writer supplies neither';
const KV071 =
  "ERROR:  KV071: AUDIT_CHAIN_SEQ_NOT_ABOVE_HEAD: the seq drawn for this audit_log row is not above the chain head's";
const KV072 =
  'ERROR:  KV072: AUDIT_CHAIN_ISOLATION: an audit_log row is chained only under READ COMMITTED';
const DENIED = 'ERROR:  42501: permission denied for table audit_log';

const FUNCTION_COMMENT =
  'BEFORE INSERT row trigger on audit_log (trg_audit_log_chain; T-215; SA §DA-9 1376; OE-50 Part C U-5, U-6). Per row: a supplied prev_entry_hash or entry_hash is KV070; a transaction not READ COMMITTED is KV072; then pg_advisory_xact_lock(5428598235315393603); seq := nextval(audit_log_seq_seq) under the lock; the head is the row with the greatest seq (none: 32 zero bytes), and a seq not above it is KV071; prev_entry_hash := the head\'s entry_hash; entry_hash := sha256(prev_entry_hash || convert_to(canonical_json, UTF8)), canonical_json being jsonb_build_object over the fifteen non-hash columns as text, with occurred_at as to_char(occurred_at AT TIME ZONE UTC, YYYY-MM-DD"T"HH24:MI:SS.US"Z") and before_hash, after_hash as lowercase hex. SECURITY DEFINER (nextval); EXECUTE revoked from PUBLIC.';

describe('0021 — the catalogue: the function, the trigger on the parent and its clones (T-234 pin)', () => {
  test('public.audit_log_chain(): owner app_ddl, plpgsql, VOLATILE, SECURITY DEFINER, search_path pinned to pg_catalog, pg_temp, EXECUTE held by its owner alone (PUBLIC revoked), and its COMMENT', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_userbyid(p.proowner) || '|' || l.lanname || '|' || p.provolatile::text || '|' || p.prosecdef || '|' ||
                array_to_string(p.proconfig, ';') || '|' || p.proacl::text || '|' || p.prorettype::regtype::text || '|' || p.pronargs
           FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.audit_log_chain()'::regprocedure`,
      ),
      'app_ddl|plpgsql|v|true|search_path=pg_catalog, pg_temp|{app_ddl=X/app_ddl}|trigger|0',
    );
    assert.equal(
      await db.value(`SELECT obj_description('public.audit_log_chain()'::regprocedure, 'pg_proc')`),
      FUNCTION_COMMENT,
    );
  });

  test('no role but the owner may EXECUTE it (app_rw, app_admin_rw, app_safety_rw, answering_service: false), and a direct call is refused (0A000)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(r || '=' || has_function_privilege(r, 'public.audit_log_chain()', 'EXECUTE'), ',' ORDER BY r)
           FROM unnest(ARRAY['app_rw','app_admin_rw','app_safety_rw','answering_service','app_ddl']) r`,
      ),
      'answering_service=false,app_admin_rw=false,app_ddl=true,app_rw=false,app_safety_rw=false',
    );
    assertRefusedBy(
      'direct call',
      await asSuperuser('SELECT public.audit_log_chain()'),
      'ERROR:  0A000: trigger functions can only be called as triggers',
    );
  });

  test('trg_audit_log_chain: BEFORE INSERT FOR EACH ROW on the parent, enabled (O), executing audit_log_chain(); and on EVERY one of the 36 partitions exactly one clone of it; no other non-internal trigger on any of the 37', async () => {
    assert.equal(
      await db.value(
        `SELECT t.tgtype::text || ' ' || t.tgenabled::text || ' ' || t.tgfoid::regprocedure::text || ' ' || (t.tgparentid = 0)
           FROM pg_trigger t WHERE t.tgrelid = 'public.audit_log'::regclass AND t.tgname = 'trg_audit_log_chain'`,
      ),
      '7 O audit_log_chain() true',
    );
    assert.equal(
      await db.value(
        `SELECT string_agg(DISTINCT (SELECT string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgtype::text || ':' || t.tgfoid::regprocedure::text || ':' ||
                                        CASE WHEN t.tgparentid = (SELECT oid FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND tgname = 'trg_audit_log_chain')
                                             THEN 'clone' ELSE 'own' END, ',')
                                      FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), ' ## ') || ' x' || count(*)
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'public.audit_log'::regclass`,
      ),
      'trg_audit_log_chain:O:7:audit_log_chain():clone x36',
    );
  });

  test("a partition created later (2029-10, the premake's next) gets the clone, and a row routed into it is chained (superuser, rolled back)", async () => {
    const r = await asSuperuser(
      `CREATE TABLE public.audit_log_p202910 PARTITION OF public.audit_log FOR VALUES FROM ('2029-10-01 00:00:00+00') TO ('2029-11-01 00:00:00+00')`,
      `SELECT 'clone on p202910: ' || count(*) FROM pg_trigger WHERE tgrelid = 'public.audit_log_p202910'::regclass AND tgname = 'trg_audit_log_chain' AND tgparentid <> 0`,
      `${row('later', { at: "'2029-10-15 00:00:00+00'" })} RETURNING 'later landed in ' || tableoid::regclass || ' prev=' || encode(prev_entry_hash, 'hex')`,
    );
    assertPermitted('later partition', r);
    assertHas('later partition', r, 'clone on p202910: 1');
    assertHas('later partition', r, `later landed in audit_log_p202910 prev=${GENESIS}`);
  });

  test('after up, kinvara_guard.assert_answering_service_write_only() called directly returns clean', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(kinvara_guard.assert_answering_service_write_only()::text, 'returned')`,
      ),
      '',
    );
  });
});

describe('0021 — the external vectors and the genesis (empty table; never committed)', () => {
  for (const [tz, ds, bo] of [
    ['UTC', 'ISO, MDY', 'hex'],
    ['Asia/Nicosia', 'ISO, MDY', 'hex'],
    ['Pacific/Kiritimati', 'SQL, DMY', 'escape'],
  ] as const) {
    test(`as app_rw under TimeZone ${tz}, DateStyle ${ds}, bytea_output ${bo}: V1 chains to 32 zero bytes, and V1, V2, V3 carry the seq and the entry_hash computed OUTSIDE the database`, async () => {
      // The sequence is placed so the trigger's draws are 2^53+1, +3, +5 (the default draws one before each).
      await db.sql({
        commands: [`SELECT setval('public.audit_log_seq_seq', 9007199254740991, true)`],
      });
      const r = await asRw(
        `SELECT 'rows before: ' || count(*) FROM public.audit_log`,
        `SET LOCAL TimeZone = '${tz}'`,
        `SET LOCAL DateStyle = '${ds}'`,
        `SET LOCAL bytea_output = '${bo}'`,
        ...VECTORS.map((v) => `${v.sql}${returning(v.name)}`),
      );
      assertPermitted(`vectors ${tz}`, r);
      assertHas(`vectors ${tz}`, r, 'rows before: 0');
      let prev: string = GENESIS;
      for (const v of VECTORS) {
        assertHas(
          `vectors ${tz} ${v.name}`,
          r,
          `${v.name} seq=${v.seq} prev=${prev} entry=${v.entry}`,
        );
        prev = v.entry;
      }
    });
  }

  test("the first row's prev_entry_hash is the genesis constant, 32 zero bytes (U-5 (4)), through the parent and through a partition by name", async () => {
    for (const table of ['audit_log', 'audit_log_p202611']) {
      const r = await asRw(
        `SELECT 'rows before: ' || count(*) FROM public.audit_log`,
        `${row('first', { table, at: "'2026-11-02 00:00:00+00'" })}${returning('first')}`,
      );
      assertPermitted(`genesis ${table}`, r);
      assertHas(`genesis ${table}`, r, 'rows before: 0');
      assertHas(`genesis ${table}`, r, `prev=${GENESIS}`);
    }
  });
});

describe('0021 — linking, in one session (as app_rw; never committed)', () => {
  test('each row chains to the previous: through the parent, into a partition BY NAME, and the rows of one multi-row INSERT in seq order; app_rw cannot EXECUTE the function and its rows are chained all the same', async () => {
    const r = await asRw(
      `SELECT 'app_rw may execute: ' || has_function_privilege('public.audit_log_chain()', 'EXECUTE')`,
      row('l1'),
      row('l2', { table: 'audit_log_p202612', at: "'2026-12-01 00:00:00+00'" }),
      `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context)
       VALUES ('2027-01-01 00:00:00+00', 'system', 'l3', 'probe', '{}'), ('2026-10-20 00:00:00+00', 'system', 'l4', 'probe', '{}')`,
      walkOf(['l1', 'l2', 'l3', 'l4']),
      `SELECT 'seq strictly increasing in insert order: ' || (SELECT bool_and(s) FROM (SELECT seq > lag(seq) OVER (ORDER BY seq) AS s FROM public.audit_log) x)`,
      WHOLE_CHAIN_LINKS,
    );
    assertPermitted('linking', r);
    assertHas('linking', r, 'app_rw may execute: false');
    assertHas('linking', r, 'l1<-GENESIS l2<-l1 l3<-l2 l4<-l3');
    assertHas('linking', r, 'whole chain: 4 rows, 0 mislinked');
  });

  test('the lock is held by the inserting transaction until it ends, under the published key: pg_locks shows classid 1263944021, objid 1145656387, objsubid 1, ExclusiveLock, granted', async () => {
    const r = await asRw(
      row('k1'),
      `SELECT 'my advisory locks: ' || string_agg(classid || ' ' || objid || ' ' || objsubid || ' ' || mode || ' ' || granted, ';')
         FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
    );
    assertPermitted('lock key', r);
    assertHas('lock key', r, `my advisory locks: ${KEY_CLASSID} ${KEY_OBJID} 1 ExclusiveLock true`);
  });

  test('seq is drawn by the trigger: a value given with OVERRIDING SYSTEM VALUE (superuser) is replaced by a seq above the head', async () => {
    const r = await asSuperuser(
      row('o1'),
      `INSERT INTO public.audit_log (seq, occurred_at, actor_type, action, subject_type, request_context) OVERRIDING SYSTEM VALUE
       VALUES (777, '2026-10-15 00:00:00+00', 'system', 'o2', 'probe', '{}')`,
      `SELECT 'override replaced: ' || ((SELECT seq FROM public.audit_log WHERE action = 'o2') <> 777) || ' above head: ' ||
              ((SELECT seq FROM public.audit_log WHERE action = 'o2') > (SELECT seq FROM public.audit_log WHERE action = 'o1'))`,
      walkOf(['o1', 'o2']),
    );
    assertPermitted('override', r);
    assertHas('override', r, 'override replaced: true above head: true');
    assertHas('override', r, 'o1<-GENESIS o2<-o1');
  });
});

describe('0021 — a caller-supplied hash never survives (U-5 (1a))', () => {
  for (const [label, cols, vals] of [
    ['prev_entry_hash', 'prev_entry_hash', "sha256('p'::bytea)"],
    ['entry_hash', 'entry_hash', "sha256('e'::bytea)"],
    ['both', 'prev_entry_hash, entry_hash', "sha256('p'::bytea), sha256('e'::bytea)"],
  ] as const) {
    const ins = (table: string): string =>
      `INSERT INTO public.${table} (occurred_at, actor_type, action, subject_type, request_context, ${cols})
       VALUES ('2026-10-15 00:00:00+00', 'system', 'supplied', 'probe', '{}', ${vals})`;
    test(`app_rw supplying ${label}: REFUSED by the column grant (42501), through the parent and a partition by name`, async () => {
      assertRefusedBy(`app_rw ${label}`, await asRw(ins('audit_log')), DENIED);
      assertRefusedBy(
        `app_rw ${label} partition`,
        await asRw(ins('audit_log_p202610')),
        'ERROR:  42501: permission denied for table audit_log_p202610',
      );
    });
    test(`the superuser and the owner app_ddl supplying ${label}: REFUSED by the trigger (KV070), not overwritten`, async () => {
      assertRefusedBy(`superuser ${label}`, await asSuperuser(ins('audit_log')), KV070);
      assertRefusedBy(`owner ${label}`, await asOwner(ins('audit_log')), KV070);
    });
  }

  test('CONTROL — hashes given as explicit NULL are the same as omitted: chained (superuser)', async () => {
    const r = await asSuperuser(
      `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context, prev_entry_hash, entry_hash)
       VALUES ('2026-10-15 00:00:00+00', 'system', 'nulls', 'probe', '{}', NULL, NULL)${returning('nulls')}`,
    );
    assertPermitted('explicit NULL', r);
    assertHas('explicit NULL', r, `prev=${GENESIS}`);
  });

  test("MEASURED — the owner's UPDATE that moves a row to another partition fires this BEFORE INSERT trigger on the destination with the old hashes, and is refused (KV070); one that stays in its partition lands (no UPDATE trigger: V-L7)", async () => {
    const r = await asOwner(
      row('u1'),
      `UPDATE public.audit_log SET rationale = 'rewritten' WHERE action = 'u1' RETURNING 'in-partition update: ' || rationale`,
      `UPDATE public.audit_log SET occurred_at = '2026-12-15 00:00:00+00' WHERE action = 'u1'`,
    );
    assertHas('owner update', r, 'in-partition update: rewritten');
    assertRefusedBy('owner cross-partition update', r, KV070);
  });
});

describe('0021 — isolation (KV072) and the head guard (KV071)', () => {
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
    test(`app_rw in a ${level} transaction is REFUSED (KV072)`, async () => {
      assertRefusedBy(
        level,
        await session(LOGINS.app_rw, [`BEGIN ISOLATION LEVEL ${level}`, row('iso')]),
        KV072,
      );
    });
  }

  test('CONTROL — app_rw in an explicit READ COMMITTED transaction is chained', async () => {
    const r = await session(LOGINS.app_rw, [
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      `${row('rc')}${returning('rc')}`,
    ]);
    assertPermitted('read committed', r);
    assertHas('read committed', r, `prev=${GENESIS}`);
  });
});

describe('0021 — refusals after the trigger ran leave the chain consistent (never committed)', () => {
  test('a CHECK refusal (23514) and a NOT NULL refusal (23502) after the trigger computed its hashes, and a routing refusal (23514, before the trigger), each in a savepoint: the next row chains to the last row that landed; a lock taken inside a savepoint is released by ROLLBACK TO SAVEPOINT', async () => {
    const r = await asRw(
      'SAVEPOINT a',
      row('s0'),
      `SELECT 'in savepoint: my advisory locks ' || count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
      'ROLLBACK TO SAVEPOINT a',
      `SELECT 'after ROLLBACK TO SAVEPOINT: my advisory locks ' || count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
      row('s1'),
    );
    assertPermitted('savepoint lock', r);
    assertHas('savepoint lock', r, 'in savepoint: my advisory locks 1');
    assertHas('savepoint lock', r, 'after ROLLBACK TO SAVEPOINT: my advisory locks 0');
    // The refusals, one psql run each (ON_ERROR_STOP), in one superuser session per refusal kind.
    const refusals: [string, string, string][] = [
      [
        'check',
        `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context) VALUES ('2026-10-15 00:00:00+00', 'admin', 'bad', 'probe', '{}')`,
        'ERROR:  23514: new row for relation "audit_log_p202610" violates check constraint "audit_log_actor_type_check"',
      ],
      [
        'not-null',
        `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context) VALUES ('2026-10-15 00:00:00+00', 'system', NULL, 'probe', '{}')`,
        'ERROR:  23502: null value in column "action" of relation "audit_log_p202610" violates not-null constraint',
      ],
      [
        'routing',
        row('oor', { at: "'2031-01-01 00:00:00+00'" }),
        'ERROR:  23514: no partition of relation "audit_log" found for row',
      ],
    ];
    for (const [label, bad, line] of refusals) {
      const code = line.slice('ERROR:  '.length, 'ERROR:  '.length + 5);
      const refused = await asSuperuser(row('r-before'), 'SAVEPOINT x', bad);
      assertRefusedBy(`${label} refused`, refused, line);
      // The same refusal caught in a subtransaction (a PL/pgSQL EXCEPTION block is a savepoint), then a row.
      const r3 = await asSuperuser(
        row('r-before'),
        `DO $$ BEGIN BEGIN EXECUTE $q$${bad}$q$; EXCEPTION WHEN others THEN RAISE NOTICE 'refused %', SQLSTATE; END; END $$`,
        row('r-after'),
        walkOf(['r-before', 'r-after']),
        WHOLE_CHAIN_LINKS,
      );
      assertPermitted(`${label} then a row`, r3);
      assertHas(`${label} then a row`, r3, `refused ${code}`);
      assertHas(`${label} then a row`, r3, 'r-before<-GENESIS r-after<-r-before');
      assertHas(`${label} then a row`, r3, 'whole chain: 2 rows, 0 mislinked');
    }
  });

  test('ON CONFLICT DO NOTHING on a duplicate (source_outbox_id, occurred_at): the trigger runs, nothing lands, and the next row chains to the row before it', async () => {
    const r = await asRw(
      row('c1', { source: '5' }),
      `${row('c1-dup', { source: '5' })} ON CONFLICT (source_outbox_id, occurred_at) DO NOTHING`,
      row('c2'),
      walkOf(['c1', 'c1-dup', 'c2']),
    );
    assertPermitted('on conflict', r);
    assertHas('on conflict', r, 'INSERT 0 0');
    assertHas('on conflict', r, 'c1<-GENESIS c2<-c1');
  });

  test('MEASURED (OD-241) — a CHECK refusal after the trigger ran prints the computed prev_entry_hash in its DETAIL', async () => {
    const r = await asSuperuser(
      `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context) VALUES ('2026-10-15 00:00:00+00', 'admin', 'detail', 'probe', '{}')`,
    );
    assertRefusedBy('detail', r, 'ERROR:  23514:');
    assertHas('detail', r, `\\x${GENESIS.slice(0, 40)}`);
  });

  test('NOT HELD (V-L7, AV-4) — the owner app_ddl disables the trigger and writes a forged link: it lands; detection is the verifier and the S3 anchor (U-13 (a))', async () => {
    const r = await asOwner(
      'ALTER TABLE public.audit_log DISABLE TRIGGER trg_audit_log_chain',
      `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context, prev_entry_hash, entry_hash)
       VALUES ('2026-10-15 00:00:00+00', 'system', 'forged', 'probe', '{}', sha256('p'::bytea), sha256('e'::bytea)) RETURNING 'forged link landed'`,
    );
    assertPermitted('owner disable', r);
    assertHas('owner disable', r, 'forged link landed');
  });
});

/** A three-way timeline: each session's commands, its start delay (s), and a name for pg_stat_activity. */
async function concurrently(
  sessions: { name: string; user?: string; delay: number; commands: string[] }[],
): Promise<PsqlResult[]> {
  return Promise.all(
    sessions.map((s) =>
      db.psql({
        ...(s.user === undefined ? {} : { user: s.user, password: PROBE_PASSWORD }),
        commands: [
          `SET application_name = '${s.name}'`,
          ...(s.delay > 0 ? [`SELECT pg_sleep(${String(s.delay)})`] : []),
          ...s.commands,
        ],
        verbose: true,
        stopOnError: true,
        raw: true,
      }),
    ),
  );
}
const OBSERVE = `SELECT 'observed: ' || coalesce(string_agg(a.application_name || '=' || CASE WHEN l.granted THEN 'holds' ELSE 'waits' END, ' ' ORDER BY a.application_name), 'nobody')
   FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.classid = ${KEY_CLASSID} AND l.objid = ${KEY_OBJID} AND l.objsubid = 1 AND a.application_name LIKE 't215-%'`;

describe('0021 — concurrency: two sessions never chain off the same head (COMMITTED rows)', () => {
  test('A (app_rw) inserts and holds its transaction 4 s; B (another app_rw login) inserts 1 s later and WAITS on the chain lock; when A commits, B chains to A. No two rows share a predecessor', async () => {
    const [a, b, o] = await concurrently([
      {
        name: 't215-A',
        user: LOGINS.app_rw,
        delay: 0,
        commands: ['BEGIN', `${row('cc-A')}${returning('cc-A')}`, 'SELECT pg_sleep(4)', 'COMMIT'],
      },
      {
        name: 't215-B',
        user: LOGINS.app_rw_b,
        delay: 1,
        commands: [`${row('cc-B')}${returning('cc-B')}`],
      },
      { name: 't215-O', delay: 2.5, commands: [OBSERVE] },
    ]);
    assert.ok(a !== undefined && b !== undefined && o !== undefined);
    assertPermitted('A', a);
    assertPermitted('B', b);
    assertHas('observer', o, 'observed: t215-A=holds t215-B=waits');
    const aEntry = field(a, 'cc-A').split(' entry=')[1];
    assert.ok(aEntry !== undefined && aEntry.length === 64, a.output);
    assert.ok(
      field(b, 'cc-B').includes(` prev=${aEntry} `),
      `B must chain to A.\nA: ${a.output}\nB: ${b.output}`,
    );
    const r = await asSuperuser(SHARED_PREDECESSORS, WHOLE_CHAIN_LINKS);
    assertHas('no fork', r, 'rows sharing a predecessor: none');
    assertHas('no fork', r, ' 0 mislinked');
  });

  test('seq is drawn under the lock: A draws its default seq, then spends 3 s in its own VALUES before its trigger runs; B inserts and commits in between; C follows. All three land, in seq order B, A, C, each chained to the one before', async () => {
    const [a, b] = await concurrently([
      {
        name: 't215-A',
        user: LOGINS.app_rw,
        delay: 0,
        commands: [`${row('ro-A', { context: "public.t215_slow('{}', 3)" })}${returning('ro-A')}`],
      },
      {
        name: 't215-B',
        user: LOGINS.app_rw_b,
        delay: 1,
        commands: [`${row('ro-B')}${returning('ro-B')}`],
      },
    ]);
    assert.ok(a !== undefined && b !== undefined);
    assertPermitted('A', a);
    assertPermitted('B', b);
    const c = await session(LOGINS.app_rw, [`${row('ro-C')}${returning('ro-C')}`, 'COMMIT']);
    assertPermitted('C', c);
    const r = await asSuperuser(
      walkOf(['ro-A', 'ro-B', 'ro-C']),
      SHARED_PREDECESSORS,
      WHOLE_CHAIN_LINKS,
    );
    assertHas('reorder', r, 'ro-B<-cc-B ro-A<-ro-B ro-C<-ro-A');
    assertHas('reorder', r, 'rows sharing a predecessor: none');
    assertHas('reorder', r, ' 0 mislinked');
  });

  test('a REPEATABLE READ writer whose snapshot predates a concurrent commit is REFUSED (KV072) instead of chaining off the stale head; A (READ COMMITTED) lands', async () => {
    const [a, b] = await concurrently([
      {
        name: 't215-A',
        user: LOGINS.app_rw,
        delay: 0,
        commands: ['BEGIN', `${row('rr-A')}${returning('rr-A')}`, 'SELECT pg_sleep(3)', 'COMMIT'],
      },
      {
        name: 't215-B',
        user: LOGINS.app_rw_b,
        delay: 1,
        commands: [
          'BEGIN ISOLATION LEVEL REPEATABLE READ',
          `${row('rr-B')}${returning('rr-B')}`,
          'COMMIT',
        ],
      },
    ]);
    assert.ok(a !== undefined && b !== undefined);
    assertPermitted('A', a);
    assertRefusedBy('B', b, KV072);
    const r = await asSuperuser(SHARED_PREDECESSORS, WHOLE_CHAIN_LINKS);
    assertHas('rr', r, 'rows sharing a predecessor: none');
    assertHas('rr', r, ' 0 mislinked');
  });

  test("the single-key chain lock does not share key space with the two-key form: while A's insert holds it, another session's pg_try_advisory_xact_lock(1263944021, 1145656387) succeeds and pg_try_advisory_xact_lock(5428598235315393603) fails", async () => {
    const [a, o] = await concurrently([
      {
        name: 't215-A',
        user: LOGINS.app_rw,
        delay: 0,
        commands: ['BEGIN', row('ks-A'), 'SELECT pg_sleep(3)', 'COMMIT'],
      },
      {
        name: 't215-O',
        delay: 1,
        commands: [
          'BEGIN',
          `SELECT 'two-key ' || pg_try_advisory_xact_lock(${KEY_CLASSID}, ${KEY_OBJID})`,
          `SELECT 'single-key ' || pg_try_advisory_xact_lock(${KEY})`,
          OBSERVE,
          'ROLLBACK',
        ],
      },
    ]);
    assert.ok(a !== undefined && o !== undefined);
    assertPermitted('A', a);
    assertHas('key space', o, 'two-key true');
    assertHas('key space', o, 'single-key false');
    assertHas('key space', o, 'observed: t215-A=holds');
  });
});

describe('0021 — KV071: the owner moves the sequence back (restored afterwards)', () => {
  test('after setval below the head, the next INSERT is REFUSED (KV071) instead of chaining a lower seq', async () => {
    const before = await db.value(`SELECT last_value FROM public.audit_log_seq_seq`);
    try {
      const r = await asOwner(
        `SELECT 'head above 1: ' || ((SELECT max(seq) FROM public.audit_log) > 2)`,
        `SELECT setval('public.audit_log_seq_seq', 1)`,
        row('behind'),
      );
      assertHas('kv071', r, 'head above 1: true');
      assertRefusedBy('kv071', r, KV071);
    } finally {
      await db.sql({ commands: [`SELECT setval('public.audit_log_seq_seq', ${before})`] });
    }
    const r = await asRw(row('after-restore'), WHOLE_CHAIN_LINKS);
    assertPermitted('restored', r);
    assertHas('restored', r, ' 0 mislinked');
  });
});
