/**
 * T-163 — `public.availability_template`, `public.availability_exception` and
 * `public.availability_slot` (migration 0029): T-089's § Migration request, built against
 * tasks/state/EP-8b/OD-226-cut.md § 4 row T-163 (OE-50): tasks/state/EP-2/OE-30-34-rulings.md E.3
 * U-1 (the slot ULID key), U-2 (template grants), U-23 (the template sitter_id index), and Part F:
 * OE-32 U-5 (1a)/(2)/(3a) (exception times), U-6 (a) (exceptions insert-only), U-15 (a) (the slot
 * span shape, EV-28 with OE-77), U-21 (a) (nothing to app_admin_rw, no RLS), U-22 (no CHECK on
 * reason), C7 (a) (time '24:00'), C9 (b) (weekday 0..6, 0 = Monday).
 *
 * V1 (no two slots of one sitter overlap) is held by SD 2261's EXCLUDE alone, and these cases are its
 * only evidence: db:introspect:check does not render an exclusion constraint (OE-31 IC-2, measured
 * again by T-163). The delete-then-insert CONTROL is the materialiser's shape (SD 2268; T-089.md
 * Q6; E.3 U-1).
 *
 * What the database does NOT refuse is pinned too, each in a case named NOT HELD: touching slots, a
 * voided template row (effective_to before effective_from), tz, reason and cluster_ids content,
 * app_rw-chosen created_at/generated_at/version, an ON CONFLICT DO NOTHING (no target, or naming the
 * exclusion constraint) that silently skips an overlapping slot, and every write by the owner app_ddl or the superuser beyond the constraints.
 * The catalogue reads (columns, defaults, constraints, indexes and their operator classes, table and
 * column ACLs, the comments, and the counts of triggers, rewrite rules, policies and both
 * row-level-security flags on each table) turn red if a grant, a constraint, an index, a trigger, a
 * rule or a policy is added to or removed from any of the three tables. One case pins what
 * db/schema.ts renders for the (sitter_id, on_date) index against pg_index (OD-110).
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` field, and exactly one ERROR line, so a crash, a
 * syntax error or a refusal for another reason cannot read as this one. Each rule has a CONTROL.
 * Every UPDATE or DELETE refusal first reads its target row in the same psql session and asserts it,
 * except app_admin_rw's: it holds no SELECT, so its DELETE and UPDATE read no column (no WHERE) and a
 * CONTROL shows each succeeding with only the named privilege added.
 *
 * Privilege refusals run over REAL LOGIN principals, each a member of exactly one role (T-020
 * Evidence §4). Constraint refusals run as the single-membership app_rw login unless a case says
 * the superuser or the owner.
 *
 * The tests share one cluster in file order. Fixture rows are written in `beforeAll`; every other
 * write runs inside a transaction that is never committed. The LAST describe block migrates down to
 * 0028 and up again.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  acquireMigratedCluster,
  judgeMigrateRun,
  MIGRATIONS_DIR,
  PROBE_PASSWORD,
  REPO_ROOT,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'availability';
const COMMITTED_DIR = path.join(REPO_ROOT, MIGRATIONS_DIR);

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't163_app_rw_probe',
  app_admin_rw: 't163_app_admin_rw_probe',
  app_safety_rw: 't163_app_safety_rw_probe',
  answering_service: 't163_answering_service_probe',
  app_ddl: 't163_app_ddl_probe',
} as const;

/** A 26-character id (the char(26) ULID columns), distinct per label. */
const ulid = (label: string): string => {
  const id = `01J163${label}`.padEnd(26, '0');
  if (id.length !== 26) throw new Error(`ulid label too long: ${label}`);
  return id;
};
const q = (s: string): string => `'${s}'`;

const SIT_A = ulid('SITA');
const SIT_B = ulid('SITB');
const NO_SUCH = ulid('NOSUCH');
const TPL_A1 = ulid('TPLA1');
const TPL_A2 = ulid('TPLA2');
const EXC_A1 = ulid('EXCA1');
const SLOT_A1 = ulid('SLOTA1');
const SLOT_A2 = ulid('SLOTA2');
const SLOT_B1 = ulid('SLOTB1');

const TABLES = ['availability_template', 'availability_exception', 'availability_slot'] as const;

/** A half-open UTC span literal. */
const span = (from: string, to: string): string => `'[${from}, ${to})'::tstzrange`;
/** Fixture slots: Friday 16 and Saturday 17 October 2026, 19:00-01:00 local (EEST, UTC+3). */
const SPAN_A1 = span('2026-10-16T16:00:00Z', '2026-10-16T22:00:00Z');
const SPAN_A2 = span('2026-10-17T16:00:00Z', '2026-10-17T22:00:00Z');

/** T-089.md Q2 step 6: one template row. weekday 4 = Friday under C9 (b). */
const template = (
  id: string,
  sitter: string,
  weekday: string,
  start: string,
  end: string,
  effectiveFrom = `'2026-10-01'`,
): string =>
  `INSERT INTO public.availability_template (id, sitter_id, weekday, start_local, end_local, effective_from)
   VALUES (${q(id)}, ${q(sitter)}, ${weekday}, ${start}, ${end}, ${effectiveFrom})`;

/** T-089.md Q3: one exception row. */
const exception = (
  id: string,
  sitter: string,
  kind: string,
  start: string,
  end: string,
  onDate = `'2026-10-16'`,
): string =>
  `INSERT INTO public.availability_exception (id, sitter_id, on_date, kind, start_local, end_local, reason)
   VALUES (${q(id)}, ${q(sitter)}, ${onDate}, ${kind}, ${start}, ${end}, 'fixture')`;

/** One slot row (the materialiser writes many in one statement; see the V1 cases). */
const slot = (id: string, sitter: string, spanSql: string, clusters = `'{1}'`): string =>
  `INSERT INTO public.availability_slot (id, sitter_id, span, cluster_ids) VALUES (${q(id)}, ${q(sitter)}, ${spanSql}, ${clusters})`;

/** E.3 U-1's Q6 step 9: many slots of one sitter in ONE statement. */
const slotsQ6 = (sitter: string, rows: ReadonlyArray<readonly [string, string, string]>): string =>
  `INSERT INTO public.availability_slot (id, sitter_id, span, cluster_ids)
   SELECT u.id, ${q(sitter)}, tstzrange(u.s, u.e, '[)'), '{1,2}'::int[]
     FROM unnest(ARRAY[${rows.map((r) => q(r[0])).join(', ')}]::char(26)[],
                 ARRAY[${rows.map((r) => q(r[1])).join(', ')}]::timestamptz[],
                 ARRAY[${rows.map((r) => q(r[2])).join(', ')}]::timestamptz[]) AS u(id, s, e)`;

const readRow = (table: string, id: string): string =>
  `SELECT '${table} ${id} count=' || count(*) FROM public.${table} WHERE id = ${q(id)}`;
const PRESENT = (table: string, id: string): string => `${table} ${id} count=1`;
const readSlots = (sitter: string): string =>
  `SELECT 'slots of ${sitter}: ' || count(*) FROM public.availability_slot WHERE sitter_id = ${q(sitter)}`;

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
         (${q(SIT_A)}, ${q(ulid('PSEUDOA'))}, 't163'), (${q(SIT_B)}, ${q(ulid('PSEUDOB'))}, 't163')`,
      `INSERT INTO public.sitter_profile (id) VALUES (${q(SIT_A)}), (${q(SIT_B)})`,
      template(TPL_A1, SIT_A, '4', `'19:00'`, `'24:00'`),
      template(TPL_A2, SIT_A, '5', `'00:00'`, `'01:00'`),
      exception(EXC_A1, SIT_A, `'REMOVE'`, 'NULL', 'NULL'),
      slot(SLOT_A1, SIT_A, SPAN_A1),
      slot(SLOT_A2, SIT_A, SPAN_A2),
      slot(SLOT_B1, SIT_B, SPAN_A1),
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** Every invocation runs inside one transaction that is never committed. */
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
const asAppRw = (...commands: string[]): Promise<PsqlResult> => asLogin(LOGINS.app_rw, ...commands);

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
    `${what}: expected ${JSON.stringify(state)} in the output.\n${r.output}`,
  );
}

const denied = (table: string): string => `ERROR:  42501: permission denied for table ${table}`;
const EXCL = 'availability_slot_sitter_id_span_excl';
const EXCL_23P01 = `ERROR:  23P01: conflicting key value violates exclusion constraint "${EXCL}"`;
const EXCL_FIELD = `CONSTRAINT NAME:  ${EXCL}`;
const check23514 = (table: string, constraint: string): string =>
  `ERROR:  23514: new row for relation "${table}" violates check constraint "${constraint}"`;
const field = (constraint: string): string => `CONSTRAINT NAME:  ${constraint}`;
const SHAPE = 'availability_slot_span_shape';
const pkey = (table: string): string =>
  `ERROR:  23505: duplicate key value violates unique constraint "${table}_pkey"`;
const fkInsert = (table: string): string =>
  `ERROR:  23503: insert or update on table "${table}" violates foreign key constraint "${table}_sitter_id_fkey"`;
const notNull = (table: string, column: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "${table}" violates not-null constraint`;

/** The texts 0029 installs, verbatim: a change to a comment must change this suite too. */
const COMMENTS: Record<(typeof TABLES)[number], string> = {
  availability_template:
    "A sitter's weekly availability blocks (SD §DB-5; SA §DA-3). weekday is 0 = Monday ... 6 = Sunday. start_local and " +
    'end_local are local times in tz; a block crossing local midnight is stored as two rows, the first ending at 24:00. ' +
    'Replacing a template retires rows by effective_to and never deletes them. app_rw may SELECT and INSERT, may UPDATE ' +
    'only effective_to and version, and holds no DELETE or TRUNCATE. These are grants: they bind app_rw, not the table ' +
    'owner app_ddl or the superuser. Overlapping blocks are not refused. No other role is granted any privilege, and ' +
    'there is no row-level security.',
  availability_exception:
    "One-day additions to and removals from a sitter's availability (SD §DB-5; SA §DA-3). Both times NULL means the " +
    'whole local day and is allowed only for REMOVE; otherwise both are set and end_local > start_local. A window past ' +
    "local midnight is two rows. reason is a private note of the sitter's. app_rw may SELECT and INSERT, and holds no " +
    'UPDATE, DELETE or TRUNCATE: a mistaken exception is countered by an opposite one. These are grants: they bind ' +
    'app_rw, not the table owner app_ddl or the superuser. No other role is granted any privilege, and there is no ' +
    'row-level security.',
  availability_slot:
    'Materialised availability, what search queries (SD §DB-5, §DB-12; SA §DA-3). id is a ULID the materialiser ' +
    'supplies; ids are not stable across regenerations. No two slots of one sitter overlap (the exclusion constraint); ' +
    'touching slots are not refused. CHECK availability_slot_span_shape: a span is non-empty, has both bounds, both ' +
    'finite, includes its lower bound and excludes its upper bound; it does not bound the length of a span. app_rw may ' +
    'SELECT, INSERT and DELETE, and holds no UPDATE or TRUNCATE. These are grants: they bind app_rw, not the table ' +
    'owner app_ddl or the superuser. Nothing here refuses a slot that conflicts with a booking. No other role is ' +
    'granted any privilege, and there is no row-level security.',
};

const IN_TABLES = TABLES.map((t) => `'public.${t}'::regclass`).join(', ');

describe('0029 — the tables, their owner, columns, constraints, indexes, ACLs and comments', () => {
  test('columns in order with types, nullability and defaults; owner app_ddl; table and column ACLs: app_rw only', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(c.relname || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                  (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                                     CASE WHEN a.attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                     coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' || coalesce(a.attacl::text, '-'),
                                     ',' ORDER BY a.attnum)
                     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), ' ; ' ORDER BY c.relname)
           FROM pg_class c WHERE c.oid IN (${IN_TABLES})`,
      ),
      'availability_exception|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl}|' +
        'id:character(26):nn:-:-,sitter_id:character(26):nn:-:-,on_date:date:nn:-:-,kind:text:nn:-:-,' +
        "start_local:time without time zone:null:-:-,end_local:time without time zone:null:-:-,tz:text:nn:'Europe/Nicosia'::text:-," +
        'reason:text:null:-:-,created_at:timestamp with time zone:nn:now():- ; ' +
        'availability_slot|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ard/app_ddl}|' +
        'id:character(26):nn:-:-,sitter_id:character(26):nn:-:-,span:tstzrange:nn:-:-,cluster_ids:integer[]:nn:-:-,' +
        'generated_at:timestamp with time zone:nn:now():- ; ' +
        'availability_template|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl}|' +
        'id:character(26):nn:-:-,sitter_id:character(26):nn:-:-,weekday:smallint:nn:-:-,' +
        'start_local:time without time zone:nn:-:-,end_local:time without time zone:nn:-:-,' +
        "tz:text:nn:'Europe/Nicosia'::text:-,effective_from:date:nn:-:-,effective_to:date:null:-:{app_rw=w/app_ddl}," +
        'version:integer:nn:1:{app_rw=w/app_ddl}',
    );
  });

  test('the constraints of the three tables are exactly these, by these definitions, none deferrable', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conrelid::regclass::text || '.' || conname || '=' || contype::text || ' ' || pg_get_constraintdef(oid) ||
                           ' deferrable=' || condeferrable || ' del=' || confdeltype::text,
                           ' ; ' ORDER BY conrelid::regclass::text, conname)
           FROM pg_constraint WHERE conrelid IN (${IN_TABLES}) AND contype <> 'n'`,
      ),
      [
        "availability_exception.availability_exception_kind_check=c CHECK ((kind = ANY (ARRAY['ADD'::text, 'REMOVE'::text]))) deferrable=false del= ",
        'availability_exception.availability_exception_pkey=p PRIMARY KEY (id) deferrable=false del= ',
        'availability_exception.availability_exception_sitter_id_fkey=f FOREIGN KEY (sitter_id) REFERENCES sitter_profile(id) ON DELETE CASCADE deferrable=false del=c',
        'availability_exception.availability_exception_times_paired=c CHECK ((((start_local IS NULL) = (end_local IS NULL)) AND (end_local > start_local))) deferrable=false del= ',
        "availability_exception.availability_exception_whole_day_remove_only=c CHECK (((start_local IS NOT NULL) OR (kind = 'REMOVE'::text))) deferrable=false del= ",
        'availability_slot.availability_slot_pkey=p PRIMARY KEY (id) deferrable=false del= ',
        'availability_slot.availability_slot_sitter_id_fkey=f FOREIGN KEY (sitter_id) REFERENCES sitter_profile(id) ON DELETE CASCADE deferrable=false del=c',
        'availability_slot.availability_slot_sitter_id_span_excl=x EXCLUDE USING gist (sitter_id WITH =, span WITH &&) deferrable=false del= ',
        'availability_slot.availability_slot_span_shape=c CHECK (((NOT isempty(span)) AND (NOT lower_inf(span)) AND (NOT upper_inf(span)) AND lower_inc(span) AND (NOT upper_inc(span)) AND isfinite(lower(span)) AND isfinite(upper(span)))) deferrable=false del= ',
        'availability_template.availability_template_check=c CHECK ((end_local > start_local)) deferrable=false del= ',
        'availability_template.availability_template_pkey=p PRIMARY KEY (id) deferrable=false del= ',
        'availability_template.availability_template_sitter_id_fkey=f FOREIGN KEY (sitter_id) REFERENCES sitter_profile(id) ON DELETE CASCADE deferrable=false del=c',
        // value() trims the output, so the last entry's trailing blank (confdeltype ' ') is not compared.
        'availability_template.availability_template_weekday_check=c CHECK (((weekday >= 0) AND (weekday <= 6))) deferrable=false del=',
      ].join(' ; '),
    );
  });

  test("the indexes are SD 2254/2261-2265's, E.3 U-23's and the keys'", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid IN (${IN_TABLES})`,
      ),
      [
        'CREATE UNIQUE INDEX availability_exception_pkey ON public.availability_exception USING btree (id)',
        'CREATE INDEX availability_exception_sitter_id_on_date_idx ON public.availability_exception USING btree (sitter_id, on_date)',
        'CREATE UNIQUE INDEX availability_slot_pkey ON public.availability_slot USING btree (id)',
        'CREATE INDEX availability_slot_sitter_id_span_excl ON public.availability_slot USING gist (sitter_id, span)',
        'CREATE UNIQUE INDEX availability_template_pkey ON public.availability_template USING btree (id)',
        'CREATE INDEX availability_template_sitter_id_idx ON public.availability_template USING btree (sitter_id)',
        'CREATE INDEX idx_slot_cluster ON public.availability_slot USING gin (cluster_ids)',
        'CREATE INDEX idx_slot_sitter ON public.availability_slot USING btree (sitter_id)',
        'CREATE INDEX idx_slot_span ON public.availability_slot USING gist (span)',
      ].join(' ; '),
    );
  });

  test('each index column carries this operator class, read from pg_index.indclass (OD-110; the EXCLUDE uses btree_gist for char(26))', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(i.indexrelid::regclass::text || '=' || (
                  SELECT string_agg(opc.opcname || '@' || coalesce(e.extname, 'core'), ',' ORDER BY k.ord)
                    FROM unnest(i.indclass) WITH ORDINALITY AS k(cls, ord)
                    JOIN pg_opclass opc ON opc.oid = k.cls
                    LEFT JOIN pg_depend d ON d.classid = 'pg_opclass'::regclass AND d.objid = opc.oid AND d.deptype = 'e'
                    LEFT JOIN pg_extension e ON e.oid = d.refobjid), ' ; ' ORDER BY i.indexrelid::regclass::text)
           FROM pg_index i WHERE i.indrelid IN (${IN_TABLES})`,
      ),
      [
        'availability_exception_pkey=bpchar_ops@core',
        'availability_exception_sitter_id_on_date_idx=bpchar_ops@core,date_ops@core',
        'availability_slot_pkey=bpchar_ops@core',
        'availability_slot_sitter_id_span_excl=gist_bpchar_ops@btree_gist,range_ops@core',
        'availability_template_pkey=bpchar_ops@core',
        'availability_template_sitter_id_idx=bpchar_ops@core',
        'idx_slot_cluster=array_ops@core',
        'idx_slot_sitter=bpchar_ops@core',
        'idx_slot_span=range_ops@core',
      ].join(' ; '),
    );
  });

  test('OD-110, the stated difference: db/schema.ts renders availability_exception_sitter_id_on_date_idx with date_ops on BOTH columns, while pg_index holds bpchar_ops on sitter_id; the single-column availability indexes render as the catalogue holds them', async () => {
    const schema = readFileSync(path.join(REPO_ROOT, 'db/schema.ts'), 'utf8');
    const rendered = (name: string): string => {
      const line = schema.split('\n').find((l) => l.includes(`index("${name}")`));
      assert.ok(line !== undefined, `db/schema.ts renders no index ${name}`);
      return [...line.matchAll(/table\.(\w+)\.asc\(\)\.nullsLast\(\)\.op\("(\w+)"\)/g)]
        .map((m) => `${m[1]}:${m[2]}`)
        .join(',');
    };
    assert.equal(
      [
        'availability_exception_sitter_id_on_date_idx',
        'availability_template_sitter_id_idx',
        'idx_slot_cluster',
        'idx_slot_sitter',
        'idx_slot_span',
      ]
        .map((n) => `${n}=${rendered(n)}`)
        .join(' ; '),
      'availability_exception_sitter_id_on_date_idx=sitterId:date_ops,onDate:date_ops ; ' +
        'availability_template_sitter_id_idx=sitterId:bpchar_ops ; idx_slot_cluster=clusterIds:array_ops ; ' +
        'idx_slot_sitter=sitterId:bpchar_ops ; idx_slot_span=span:range_ops',
    );
    assert.ok(
      !schema.includes(EXCL) && !/exclude/i.test(schema),
      'db/schema.ts now mentions the exclusion constraint; OE-31 IC-2 no longer holds as measured',
    );
  });

  test('each table: no non-internal trigger, no rewrite rule, row-level security neither enabled nor forced, and no policy', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(c.relname || ': ' ||
                  (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                  (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                  c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                  (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies', ' ; ' ORDER BY c.relname)
           FROM pg_class c WHERE c.oid IN (${IN_TABLES})`,
      ),
      'availability_exception: 0 triggers, 0 rules, rls=false, force=false, 0 policies ; ' +
        'availability_slot: 0 triggers, 0 rules, rls=false, force=false, 0 policies ; ' +
        'availability_template: 0 triggers, 0 rules, rls=false, force=false, 0 policies',
    );
  });

  for (const table of TABLES) {
    test(`COMMENT ON TABLE ${table} is exactly this text, and none of its columns carries a comment`, async () => {
      assert.equal(
        await db.value(`SELECT obj_description('public.${table}'::regclass, 'pg_class')`),
        COMMENTS[table],
      );
      assert.equal(
        await db.value(
          `SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.${table}'::regclass
              AND attnum > 0 AND col_description(attrelid, attnum) IS NOT NULL`,
        ),
        '0',
      );
    });
  }
});

describe('0029 — V1: no two slots of one sitter overlap (SD 2261, the EXCLUDE)', () => {
  test('app_rw inserting a slot that overlaps an existing slot of the same sitter is REFUSED by the exclusion constraint (23P01)', async () => {
    const r = await asAppRw(
      readRow('availability_slot', SLOT_A1),
      slot(ulid('OVL1'), SIT_A, span('2026-10-16T21:00:00Z', '2026-10-16T23:00:00Z')),
    );
    assertRead('app_rw overlap', r, PRESENT('availability_slot', SLOT_A1));
    assertRefusedBy('app_rw overlap', r, EXCL_23P01, EXCL_FIELD);
  });

  test('the superuser inserting the identical span again for the same sitter is REFUSED (23P01): the constraint binds every writer', async () => {
    const r = await asSuperuser(
      readRow('availability_slot', SLOT_A1),
      slot(ulid('OVL2'), SIT_A, SPAN_A1),
    );
    assertRead('superuser identical', r, PRESENT('availability_slot', SLOT_A1));
    assertRefusedBy('superuser identical', r, EXCL_23P01, EXCL_FIELD);
  });

  test('a span contained in an existing slot is REFUSED (23P01), as the owner app_ddl', async () => {
    assertRefusedBy(
      'owner contained',
      await asLogin(
        LOGINS.app_ddl,
        slot(ulid('OVL3'), SIT_A, span('2026-10-16T17:00:00Z', '2026-10-16T18:00:00Z')),
      ),
      EXCL_23P01,
      EXCL_FIELD,
    );
  });

  test("two overlapping NEW rows inside one multi-row INSERT … SELECT unnest(…) (E.3 U-1's Q6 shape) are REFUSED (23P01) and none lands", async () => {
    const r = await asAppRw(
      slotsQ6(SIT_B, [
        [ulid('Q6A'), '2026-11-06T16:00:00Z', '2026-11-06T20:00:00Z'],
        [ulid('Q6B'), '2026-11-06T19:00:00Z', '2026-11-06T22:00:00Z'],
      ]),
    );
    assertRefusedBy('one statement, two overlapping rows', r, EXCL_23P01, EXCL_FIELD);
    assert.equal(
      await db.value(`SELECT count(*) FROM public.availability_slot WHERE sitter_id = ${q(SIT_B)}`),
      '1',
    );
  });

  test("the materialiser's INSERT WITHOUT its DELETE: app_rw re-inserting an overlapping set over the sitter's existing slots is REFUSED (23P01)", async () => {
    const r = await asAppRw(
      readSlots(SIT_A),
      slotsQ6(SIT_A, [
        [ulid('NODEL1'), '2026-10-16T15:00:00Z', '2026-10-16T22:00:00Z'],
        [ulid('NODEL2'), '2026-10-17T16:00:00Z', '2026-10-17T21:00:00Z'],
      ]),
    );
    assertRead('insert without delete', r, `slots of ${SIT_A}: 2`);
    assertRefusedBy('insert without delete', r, EXCL_23P01, EXCL_FIELD);
  });

  test('the superuser moving a slot onto its sibling (UPDATE) is REFUSED (23P01)', async () => {
    const r = await asSuperuser(
      readRow('availability_slot', SLOT_A2),
      `UPDATE public.availability_slot SET span = ${SPAN_A1} WHERE id = ${q(SLOT_A2)}`,
    );
    assertRead('superuser UPDATE onto a sibling', r, PRESENT('availability_slot', SLOT_A2));
    assertRefusedBy('superuser UPDATE onto a sibling', r, EXCL_23P01, EXCL_FIELD);
  });

  test("CONTROL — delete-then-insert (SD 2268, T-089.md Q6 steps 8-9): app_rw, in ONE transaction, deletes the sitter's slots and inserts an overlapping replacement set in one statement; accepted, and the other sitter's slot is untouched", async () => {
    const r = await asAppRw(
      readSlots(SIT_A),
      `DELETE FROM public.availability_slot WHERE sitter_id = ${q(SIT_A)}`,
      slotsQ6(SIT_A, [
        [ulid('REM1'), '2026-10-16T15:00:00Z', '2026-10-16T22:00:00Z'],
        [ulid('REM2'), '2026-10-17T16:00:00Z', '2026-10-17T21:00:00Z'],
      ]),
      `SELECT 'after: ' || string_agg(lower(span) || '/' || upper(span), ',' ORDER BY lower(span)) FROM public.availability_slot WHERE sitter_id = ${q(SIT_A)}`,
      readSlots(SIT_B),
    );
    assertPermitted('delete then insert', r);
    assertRead('delete then insert', r, `slots of ${SIT_A}: 2`);
    assertRead('delete then insert', r, 'DELETE 2');
    assertRead('delete then insert', r, 'INSERT 0 2');
    assertRead(
      'delete then insert',
      r,
      'after: 2026-10-16 15:00:00+00/2026-10-16 22:00:00+00,2026-10-17 16:00:00+00/2026-10-17 21:00:00+00',
    );
    assertRead('delete then insert', r, `slots of ${SIT_B}: 1`);
  });

  test('CONTROL — adjacent half-open spans [a,b) [b,c) of ONE sitter, and the same spans under ANOTHER sitter, in one INSERT … SELECT unnest(…), are accepted (touching slots are not refused)', async () => {
    const r = await asAppRw(
      slotsQ6(SIT_B, [
        [ulid('ADJ1'), '2026-11-06T16:00:00Z', '2026-11-06T19:00:00Z'],
        [ulid('ADJ2'), '2026-11-06T19:00:00Z', '2026-11-06T22:00:00Z'],
      ]),
      slotsQ6(SIT_A, [
        [ulid('ADJ3'), '2026-11-06T16:00:00Z', '2026-11-06T19:00:00Z'],
        [ulid('ADJ4'), '2026-11-06T19:00:00Z', '2026-11-06T22:00:00Z'],
      ]),
      `SELECT 'adjacent pairs: ' || count(*) FROM public.availability_slot a JOIN public.availability_slot b
          ON a.sitter_id = b.sitter_id AND a.id < b.id AND a.span -|- b.span
       WHERE lower(a.span) >= '2026-11-06'`,
    );
    assertPermitted('adjacent spans', r);
    assertRead('adjacent spans', r, 'adjacent pairs: 2');
  });

  test('NOT HELD — app_rw INSERT … ON CONFLICT DO NOTHING (no target) of an overlapping slot: NO error, the row is silently skipped (INSERT 0 0)', async () => {
    const r = await asAppRw(
      readRow('availability_slot', SLOT_A1),
      `${slot(ulid('OCN1'), SIT_A, span('2026-10-16T21:00:00Z', '2026-10-16T23:00:00Z'))} ON CONFLICT DO NOTHING`,
    );
    assertPermitted('targetless ON CONFLICT DO NOTHING', r);
    assertRead('targetless ON CONFLICT DO NOTHING', r, PRESENT('availability_slot', SLOT_A1));
    assertRead('targetless ON CONFLICT DO NOTHING', r, 'INSERT 0 0');
  });

  test('NOT HELD — app_rw INSERT … ON CONFLICT ON CONSTRAINT availability_slot_sitter_id_span_excl DO NOTHING (the exclusion constraint named) of an overlapping slot: NO error, the row is silently skipped (INSERT 0 0)', async () => {
    const r = await asAppRw(
      readRow('availability_slot', SLOT_A1),
      `${slot(ulid('OCN2'), SIT_A, span('2026-10-16T21:00:00Z', '2026-10-16T23:00:00Z'))} ON CONFLICT ON CONSTRAINT ${EXCL} DO NOTHING`,
      readRow('availability_slot', ulid('OCN2')),
    );
    assertPermitted('named-constraint ON CONFLICT DO NOTHING', r);
    assertRead('named-constraint ON CONFLICT DO NOTHING', r, PRESENT('availability_slot', SLOT_A1));
    assertRead('named-constraint ON CONFLICT DO NOTHING', r, 'INSERT 0 0');
    assertRead(
      'named-constraint ON CONFLICT DO NOTHING',
      r,
      `availability_slot ${ulid('OCN2')} count=0`,
    );
  });

  test('CONTROL — app_rw INSERT … ON CONFLICT (id) DO NOTHING of an overlapping slot is REFUSED 23P01 naming the exclusion constraint (an id target does not arbitrate it)', async () => {
    assertRefusedBy(
      'ON CONFLICT (id) DO NOTHING',
      await asAppRw(
        readRow('availability_slot', SLOT_A1),
        `${slot(ulid('OCN3'), SIT_A, span('2026-10-16T21:00:00Z', '2026-10-16T23:00:00Z'))} ON CONFLICT (id) DO NOTHING`,
      ),
      EXCL_23P01,
      EXCL_FIELD,
    );
  });
});

describe('0029 — the slot span shape: availability_slot_span_shape (OE-32 U-15 (a); EV-28 with OE-77)', () => {
  const BAD = [
    ["'empty'", `'empty'::tstzrange`],
    [
      '[a,a), which PostgreSQL normalises to empty',
      span('2027-10-01T00:00:00Z', '2027-10-01T00:00:00Z'),
    ],
    ['(,b) — no lower bound', `'(,2027-10-01T00:00:00Z)'::tstzrange`],
    ['[a,) — no upper bound', `'[2027-10-01T00:00:00Z,)'::tstzrange`],
    ['(,) — no bound at all', `'(,)'::tstzrange`],
    [
      '(a,b] — lower excluded, upper included',
      `'(2027-10-01T00:00:00Z,2027-10-02T00:00:00Z]'::tstzrange`,
    ],
    ['[a,b] — upper included', `'[2027-10-01T00:00:00Z,2027-10-02T00:00:00Z]'::tstzrange`],
    ['(a,b) — lower excluded', `'(2027-10-01T00:00:00Z,2027-10-02T00:00:00Z)'::tstzrange`],
    ['[a, infinity) — an infinite upper bound', `'[2030-01-01T00:00:00Z,infinity)'::tstzrange`],
    ['[-infinity, b) — an infinite lower bound', `'[-infinity,2030-01-01T00:00:00Z)'::tstzrange`],
  ] as const;
  for (const [label, literal] of BAD) {
    test(`app_rw writing a slot span ${label} is REFUSED by availability_slot_span_shape (23514)`, async () => {
      assertRefusedBy(
        `app_rw span ${label}`,
        await asAppRw(slot(ulid('SHAPE'), SIT_B, literal)),
        check23514('availability_slot', SHAPE),
        field(SHAPE),
      );
    });
  }

  test('the superuser writing an unbounded slot span is REFUSED (23514): the CHECK binds every writer', async () => {
    assertRefusedBy(
      'superuser unbounded',
      await asSuperuser(slot(ulid('SHAPE'), SIT_B, `'[2027-10-01T00:00:00Z,)'::tstzrange`)),
      check23514('availability_slot', SHAPE),
      field(SHAPE),
    );
  });

  test('the superuser moving a fixture slot to an infinite upper bound (UPDATE) is REFUSED (23514)', async () => {
    const r = await asSuperuser(
      readRow('availability_slot', SLOT_A1),
      `UPDATE public.availability_slot SET span = '[2026-10-16T16:00:00Z,infinity)' WHERE id = ${q(SLOT_A1)}`,
    );
    assertRead('superuser UPDATE to infinity', r, PRESENT('availability_slot', SLOT_A1));
    assertRefusedBy(
      'superuser UPDATE to infinity',
      r,
      check23514('availability_slot', SHAPE),
      field(SHAPE),
    );
  });

  test("CONTROL — app_rw writes a '[)' span built as tstzrange(a, b, '[)') and as a literal", async () => {
    const r = await asAppRw(
      `${slot(ulid('OKA'), SIT_B, `tstzrange('2027-10-01T16:00:00Z', '2027-10-01T22:00:00Z', '[)')`)} RETURNING 'ok ' || lower_inc(span) || ',' || upper_inc(span)`,
      `${slot(ulid('OKB'), SIT_B, span('2027-10-02T16:00:00Z', '2027-10-02T22:00:00Z'))} RETURNING 'ok ' || isempty(span)`,
    );
    assertPermitted("app_rw '[)' spans", r);
    assertRead("app_rw '[)' spans", r, 'ok true,false');
    assertRead("app_rw '[)' spans", r, 'ok false');
  });
});

describe('0029 — keys, foreign keys and NOT NULL', () => {
  for (const [table, sql] of [
    [
      'availability_slot',
      slot(SLOT_A1, SIT_B, span('2028-01-01T00:00:00Z', '2028-01-01T01:00:00Z')),
    ],
    ['availability_template', template(TPL_A1, SIT_B, '0', `'09:00'`, `'10:00'`)],
    ['availability_exception', exception(EXC_A1, SIT_B, `'REMOVE'`, 'NULL', 'NULL')],
  ] as const) {
    test(`a duplicate ${table} id is REFUSED by ${table}_pkey (23505), as app_rw`, async () => {
      assertRefusedBy(
        `duplicate ${table} id`,
        await asAppRw(sql),
        pkey(table),
        field(`${table}_pkey`),
      );
    });
  }

  for (const [table, sql] of [
    [
      'availability_slot',
      slot(ulid('FK'), NO_SUCH, span('2028-01-01T00:00:00Z', '2028-01-01T01:00:00Z')),
    ],
    ['availability_template', template(ulid('FK'), NO_SUCH, '0', `'09:00'`, `'10:00'`)],
    ['availability_exception', exception(ulid('FK'), NO_SUCH, `'REMOVE'`, 'NULL', 'NULL')],
  ] as const) {
    test(`a ${table} row naming no sitter_profile is REFUSED by ${table}_sitter_id_fkey (23503), as app_rw`, async () => {
      assertRefusedBy(
        `${table} unknown sitter`,
        await asAppRw(sql),
        fkInsert(table),
        field(`${table}_sitter_id_fkey`),
      );
    });
  }

  const NN: ReadonlyArray<readonly [string, string, string]> = [
    [
      'availability_template',
      'id',
      `${template(ulid('NN'), SIT_B, '0', `'09:00'`, `'10:00'`)}`.replace(q(ulid('NN')), 'NULL'),
    ],
    [
      'availability_template',
      'sitter_id',
      template(ulid('NN'), SIT_B, '0', `'09:00'`, `'10:00'`).replace(`, ${q(SIT_B)},`, ', NULL,'),
    ],
    ['availability_template', 'weekday', template(ulid('NN'), SIT_B, 'NULL', `'09:00'`, `'10:00'`)],
    ['availability_template', 'start_local', template(ulid('NN'), SIT_B, '0', 'NULL', `'10:00'`)],
    ['availability_template', 'end_local', template(ulid('NN'), SIT_B, '0', `'09:00'`, 'NULL')],
    [
      'availability_template',
      'effective_from',
      template(ulid('NN'), SIT_B, '0', `'09:00'`, `'10:00'`, 'NULL'),
    ],
    [
      'availability_template',
      'tz',
      `INSERT INTO public.availability_template (id, sitter_id, weekday, start_local, end_local, tz, effective_from)
       VALUES (${q(ulid('NN'))}, ${q(SIT_B)}, 0, '09:00', '10:00', NULL, '2026-10-01')`,
    ],
    [
      'availability_template',
      'version',
      `INSERT INTO public.availability_template (id, sitter_id, weekday, start_local, end_local, effective_from, version)
       VALUES (${q(ulid('NN'))}, ${q(SIT_B)}, 0, '09:00', '10:00', '2026-10-01', NULL)`,
    ],
    [
      'availability_exception',
      'id',
      exception(ulid('NN'), SIT_B, `'REMOVE'`, 'NULL', 'NULL').replace(q(ulid('NN')), 'NULL'),
    ],
    [
      'availability_exception',
      'sitter_id',
      exception(ulid('NN'), SIT_B, `'REMOVE'`, 'NULL', 'NULL').replace(`, ${q(SIT_B)},`, ', NULL,'),
    ],
    [
      'availability_exception',
      'on_date',
      exception(ulid('NN'), SIT_B, `'REMOVE'`, 'NULL', 'NULL', 'NULL'),
    ],
    ['availability_exception', 'kind', exception(ulid('NN'), SIT_B, 'NULL', `'09:00'`, `'10:00'`)],
    [
      'availability_exception',
      'tz',
      `INSERT INTO public.availability_exception (id, sitter_id, on_date, kind, tz) VALUES (${q(ulid('NN'))}, ${q(SIT_B)}, '2026-10-16', 'REMOVE', NULL)`,
    ],
    [
      'availability_exception',
      'created_at',
      `INSERT INTO public.availability_exception (id, sitter_id, on_date, kind, created_at) VALUES (${q(ulid('NN'))}, ${q(SIT_B)}, '2026-10-16', 'REMOVE', NULL)`,
    ],
    [
      'availability_slot',
      'id',
      slot(ulid('NN'), SIT_B, span('2028-01-01T00:00:00Z', '2028-01-01T01:00:00Z')).replace(
        q(ulid('NN')),
        'NULL',
      ),
    ],
    [
      'availability_slot',
      'sitter_id',
      slot(ulid('NN'), SIT_B, span('2028-01-01T00:00:00Z', '2028-01-01T01:00:00Z')).replace(
        `, ${q(SIT_B)},`,
        ', NULL,',
      ),
    ],
    ['availability_slot', 'span', slot(ulid('NN'), SIT_B, 'NULL')],
    [
      'availability_slot',
      'cluster_ids',
      slot(ulid('NN'), SIT_B, span('2028-01-01T00:00:00Z', '2028-01-01T01:00:00Z'), 'NULL'),
    ],
    [
      'availability_slot',
      'generated_at',
      `INSERT INTO public.availability_slot (id, sitter_id, span, cluster_ids, generated_at)
       VALUES (${q(ulid('NN'))}, ${q(SIT_B)}, ${span('2028-01-01T00:00:00Z', '2028-01-01T01:00:00Z')}, '{}', NULL)`,
    ],
  ];
  for (const [table, column, sql] of NN) {
    test(`${table}.${column} NULL is REFUSED (23502, naming the column), as app_rw`, async () => {
      const r = await asAppRw(sql);
      assertRefusedBy(
        `${table}.${column} NULL`,
        r,
        notNull(table, column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test("ON DELETE CASCADE: the superuser deleting sitter A's profile removes A's templates, exceptions and slots, and leaves B's slot", async () => {
    const counts = `SELECT 'A=' || (SELECT count(*) FROM public.availability_template WHERE sitter_id = ${q(SIT_A)}) || '/' ||
                         (SELECT count(*) FROM public.availability_exception WHERE sitter_id = ${q(SIT_A)}) || '/' ||
                         (SELECT count(*) FROM public.availability_slot WHERE sitter_id = ${q(SIT_A)}) || ' B slots=' ||
                         (SELECT count(*) FROM public.availability_slot WHERE sitter_id = ${q(SIT_B)})`;
    const r = await asSuperuser(
      counts,
      `DELETE FROM public.sitter_profile WHERE id = ${q(SIT_A)}`,
      counts,
    );
    assertPermitted('cascade', r);
    assertRead('cascade', r, 'A=2/1/2 B slots=1');
    assertRead('cascade', r, 'DELETE 1');
    assertRead('cascade', r, 'A=0/0/0 B slots=1');
  });
});

describe('0029 — availability_template: weekday (C9 (b)), end after start, and 24:00 (C7 (a))', () => {
  for (const wd of ['7', '-1'] as const) {
    test(`weekday ${wd} is REFUSED by availability_template_weekday_check (23514), as app_rw`, async () => {
      assertRefusedBy(
        `weekday ${wd}`,
        await asAppRw(template(ulid('WD'), SIT_B, wd, `'09:00'`, `'10:00'`)),
        check23514('availability_template', 'availability_template_weekday_check'),
        field('availability_template_weekday_check'),
      );
    });
  }

  for (const [label, start, end] of [
    ['19:00-01:00 (a block crossing midnight as one row)', `'19:00'`, `'01:00'`],
    ['19:00-19:00 (empty)', `'19:00'`, `'19:00'`],
    ['24:00-24:00 (empty at the end of the day)', `'24:00'`, `'24:00'`],
    ['00:00-00:00 (24:00 is not 00:00 and 00:00 is not 24:00)', `'00:00'`, `'00:00'`],
  ] as const) {
    test(`a template block ${label} is REFUSED by availability_template_check (23514), as app_rw`, async () => {
      assertRefusedBy(
        `template ${label}`,
        await asAppRw(template(ulid('ORD'), SIT_B, '4', start, end)),
        check23514('availability_template', 'availability_template_check'),
        field('availability_template_check'),
      );
    });
  }

  test("CONTROL — weekdays 0 and 6, a 19:00-23:00 block, and C7 (a)'s pair Friday (4) 19:00-24:00 + Saturday (5) 00:00-01:00 are accepted; time reads 24:00 back as 24:00:00", async () => {
    const r = await asAppRw(
      template(ulid('C0'), SIT_B, '0', `'09:00'`, `'10:00'`),
      template(ulid('C6'), SIT_B, '6', `'09:00'`, `'10:00'`),
      template(ulid('C1923'), SIT_B, '4', `'19:00'`, `'23:00'`),
      `${template(ulid('CFRI'), SIT_B, '4', `'19:00'`, `'24:00'`)} RETURNING 'fri ' || start_local || '-' || end_local`,
      `${template(ulid('CSAT'), SIT_B, '5', `'00:00'`, `'01:00'`)} RETURNING 'sat ' || start_local || '-' || end_local`,
    );
    assertPermitted('template controls', r);
    assertRead('template controls', r, 'fri 19:00:00-24:00:00');
    assertRead('template controls', r, 'sat 00:00:00-01:00:00');
  });

  test("CONTROL — app_rw can count sitters from availability_template for a Friday 19:00-01:00 window stored as C7 (a)'s two rows (weekday 4 19:00-24:00, weekday 5 00:00-01:00); the predicate (effective_to IS NULL, one row per day) is a fixture, not T-216's threshold 2 rule", async () => {
    const r = await asAppRw(
      `SELECT 'peak sitters: ' || count(*) FROM public.sitter_profile s
        WHERE EXISTS (SELECT 1 FROM public.availability_template t WHERE t.sitter_id = s.id AND t.effective_to IS NULL
                         AND t.weekday = 4 AND t.start_local <= '19:00' AND t.end_local = '24:00')
          AND EXISTS (SELECT 1 FROM public.availability_template t WHERE t.sitter_id = s.id AND t.effective_to IS NULL
                         AND t.weekday = 5 AND t.start_local = '00:00' AND t.end_local >= '01:00')`,
    );
    assertPermitted('peak count', r);
    assertRead('peak count', r, 'peak sitters: 1');
  });
});

describe('0029 — availability_template grants (E.3 U-2): retire by effective_to, never delete', () => {
  for (const [column, set] of [
    ['start_local', `start_local = '18:00'`],
    ['end_local', `end_local = '23:00'`],
    ['weekday', 'weekday = 3'],
    ['effective_from', `effective_from = '2026-01-01'`],
    ['tz', `tz = 'UTC'`],
    ['sitter_id', `sitter_id = ${q(SIT_B)}`],
    ['id', `id = ${q(ulid('NEWID'))}`],
  ] as const) {
    test(`app_rw UPDATE of availability_template.${column} is REFUSED (42501): effective_to and version are its only writable columns`, async () => {
      const r = await asAppRw(
        readRow('availability_template', TPL_A1),
        `UPDATE public.availability_template SET ${set} WHERE id = ${q(TPL_A1)}`,
      );
      assertRead(`update ${column}`, r, PRESENT('availability_template', TPL_A1));
      assertRefusedBy(`update ${column}`, r, denied('availability_template'));
    });
  }

  test('app_rw DELETE of a template row is REFUSED (42501)', async () => {
    const r = await asAppRw(
      readRow('availability_template', TPL_A1),
      `DELETE FROM public.availability_template WHERE id = ${q(TPL_A1)}`,
    );
    assertRead('template DELETE', r, PRESENT('availability_template', TPL_A1));
    assertRefusedBy('template DELETE', r, denied('availability_template'));
  });

  test("CONTROL — E.3 U-2's PUT as app_rw in one transaction: retire a live row (effective_to = effectiveFrom - 1 day), void a future one (effective_to = effective_from - 1 day), bump both versions, insert the new block at version 1", async () => {
    const r = await asAppRw(
      template(ulid('FUT'), SIT_A, '2', `'09:00'`, `'12:00'`, `'2026-12-01'`),
      `UPDATE public.availability_template SET effective_to = date '2026-11-01' - 1, version = version + 1
        WHERE id = ${q(TPL_A1)} RETURNING 'retired to ' || effective_to || ' v' || version`,
      `UPDATE public.availability_template SET effective_to = effective_from - 1, version = version + 1
        WHERE id = ${q(ulid('FUT'))} RETURNING 'voided: to ' || effective_to || ' < from ' || effective_from || ' v' || version`,
      `${template(ulid('NEW'), SIT_A, '4', `'18:00'`, `'24:00'`, `'2026-11-01'`)} RETURNING 'new v' || version`,
    );
    assertPermitted('U-2 PUT', r);
    assertRead('U-2 PUT', r, 'retired to 2026-10-31 v2');
    assertRead('U-2 PUT', r, 'voided: to 2026-11-30 < from 2026-12-01 v2');
    assertRead('U-2 PUT', r, 'new v1');
  });

  test('NOT HELD — app_rw moves effective_to later again, back to NULL, and version down to -5 and 0: accepted; only the column grant holds here', async () => {
    const r = await asAppRw(
      `UPDATE public.availability_template SET effective_to = '2026-10-10' WHERE id = ${q(TPL_A1)} RETURNING 'set'`,
      `UPDATE public.availability_template SET effective_to = '2030-01-01' WHERE id = ${q(TPL_A1)} RETURNING 'later'`,
      `UPDATE public.availability_template SET effective_to = NULL, version = -5 WHERE id = ${q(TPL_A1)} RETURNING 'null v' || version`,
      `UPDATE public.availability_template SET version = 0 WHERE id = ${q(TPL_A1)} RETURNING 'v' || version`,
    );
    assertPermitted('template rewritten', r);
    for (const line of ['set', 'later', 'null v-5', 'v0'])
      assertRead('template rewritten', r, line);
  });
});

describe('0029 — availability_exception: kind, the time pairing (U-5 (2)), whole day REMOVE only (U-5 (1a)), insert-only (U-6 (a))', () => {
  for (const kind of [`'add'`, `'CANCEL'`, `'REMOVE '`] as const) {
    test(`kind ${kind} is REFUSED by availability_exception_kind_check (23514), as app_rw`, async () => {
      assertRefusedBy(
        `kind ${kind}`,
        await asAppRw(exception(ulid('KIND'), SIT_B, kind, `'09:00'`, `'10:00'`)),
        check23514('availability_exception', 'availability_exception_kind_check'),
        field('availability_exception_kind_check'),
      );
    });
  }

  for (const [label, kind, start, end] of [
    ['REMOVE with only start_local', `'REMOVE'`, `'09:00'`, 'NULL'],
    ['REMOVE with only end_local', `'REMOVE'`, 'NULL', `'10:00'`],
    ['ADD with only start_local', `'ADD'`, `'09:00'`, 'NULL'],
    [
      'ADD 20:00-02:00 (past midnight as one row; U-5 (3a) makes it two)',
      `'ADD'`,
      `'20:00'`,
      `'02:00'`,
    ],
    ['REMOVE 10:00-10:00 (empty)', `'REMOVE'`, `'10:00'`, `'10:00'`],
  ] as const) {
    test(`an exception ${label} is REFUSED by availability_exception_times_paired (23514), as app_rw`, async () => {
      assertRefusedBy(
        `exception ${label}`,
        await asAppRw(exception(ulid('PAIR'), SIT_B, kind, start, end)),
        check23514('availability_exception', 'availability_exception_times_paired'),
        field('availability_exception_times_paired'),
      );
    });
  }

  test('an ADD with both times NULL (a whole-day ADD) is REFUSED by availability_exception_whole_day_remove_only (23514), as app_rw', async () => {
    assertRefusedBy(
      'whole-day ADD',
      await asAppRw(exception(ulid('WDADD'), SIT_B, `'ADD'`, 'NULL', 'NULL')),
      check23514('availability_exception', 'availability_exception_whole_day_remove_only'),
      field('availability_exception_whole_day_remove_only'),
    );
  });

  test("CONTROL — 'ADD' and 'REMOVE' with times, a whole-day REMOVE (both NULL), and U-5 (3a)'s available-now past midnight as two ADD rows (20:00-24:00, then 00:00-02:00 the next day) are accepted", async () => {
    const r = await asAppRw(
      exception(ulid('CADD'), SIT_B, `'ADD'`, `'09:00'`, `'10:00'`),
      exception(ulid('CREM'), SIT_B, `'REMOVE'`, `'09:00'`, `'10:00'`),
      `${exception(ulid('CWD'), SIT_B, `'REMOVE'`, 'NULL', 'NULL')} RETURNING 'whole day ' || kind || ' ' || coalesce(start_local::text, 'null')`,
      `${exception(ulid('CAN1'), SIT_B, `'ADD'`, `'20:00'`, `'24:00'`, `'2026-10-16'`)} RETURNING 'an1 ' || on_date || ' ' || end_local`,
      `${exception(ulid('CAN2'), SIT_B, `'ADD'`, `'00:00'`, `'02:00'`, `'2026-10-17'`)} RETURNING 'an2 ' || on_date || ' ' || start_local`,
    );
    assertPermitted('exception controls', r);
    assertRead('exception controls', r, 'whole day REMOVE null');
    assertRead('exception controls', r, 'an1 2026-10-16 24:00:00');
    assertRead('exception controls', r, 'an2 2026-10-17 00:00:00');
  });

  for (const [column, set] of [
    ['reason', `reason = 'changed'`],
    ['kind', `kind = 'ADD'`],
    ['on_date', `on_date = '2026-10-17'`],
  ] as const) {
    test(`app_rw UPDATE of availability_exception.${column} is REFUSED (42501)`, async () => {
      const r = await asAppRw(
        readRow('availability_exception', EXC_A1),
        `UPDATE public.availability_exception SET ${set} WHERE id = ${q(EXC_A1)}`,
      );
      assertRead(`exception update ${column}`, r, PRESENT('availability_exception', EXC_A1));
      assertRefusedBy(`exception update ${column}`, r, denied('availability_exception'));
    });
  }

  test('app_rw DELETE of an exception is REFUSED (42501)', async () => {
    const r = await asAppRw(
      readRow('availability_exception', EXC_A1),
      `DELETE FROM public.availability_exception WHERE id = ${q(EXC_A1)}`,
    );
    assertRead('exception DELETE', r, PRESENT('availability_exception', EXC_A1));
    assertRefusedBy('exception DELETE', r, denied('availability_exception'));
  });

  test("NOT HELD (U-22) — app_rw writes a 10000-character reason and a tz that is no zone: accepted (the 200-character bound is the contract's)", async () => {
    const r = await asAppRw(
      `INSERT INTO public.availability_exception (id, sitter_id, on_date, kind, tz, reason)
       VALUES (${q(ulid('LONG'))}, ${q(SIT_B)}, '2026-10-20', 'REMOVE', 'Mars/Phobos', repeat('x', 10000))
       RETURNING 'reason length ' || length(reason) || ' tz ' || tz`,
    );
    assertPermitted('reason and tz unchecked', r);
    assertRead('reason and tz unchecked', r, 'reason length 10000 tz Mars/Phobos');
  });
});

describe('0029 — availability_slot grants: SELECT, INSERT, DELETE; no UPDATE', () => {
  for (const [column, set] of [
    ['span', `span = ${span('2026-10-16T16:00:00Z', '2026-10-16T17:00:00Z')}`],
    ['cluster_ids', `cluster_ids = '{9}'`],
    ['generated_at', 'generated_at = now()'],
    ['sitter_id', `sitter_id = ${q(SIT_B)}`],
  ] as const) {
    test(`app_rw UPDATE of availability_slot.${column} is REFUSED (42501)`, async () => {
      const r = await asAppRw(
        readRow('availability_slot', SLOT_A1),
        `UPDATE public.availability_slot SET ${set} WHERE id = ${q(SLOT_A1)}`,
      );
      assertRead(`slot update ${column}`, r, PRESENT('availability_slot', SLOT_A1));
      assertRefusedBy(`slot update ${column}`, r, denied('availability_slot'));
    });
  }

  for (const lock of ['FOR UPDATE', 'FOR SHARE'] as const) {
    test(`app_rw SELECT … ${lock} on a slot is REFUSED (42501): with no UPDATE privilege, app_rw cannot row-lock slots`, async () => {
      const r = await asAppRw(
        readRow('availability_slot', SLOT_A1),
        `SELECT id FROM public.availability_slot WHERE id = ${q(SLOT_A1)} ${lock}`,
      );
      assertRead(`slot ${lock}`, r, PRESENT('availability_slot', SLOT_A1));
      assertRefusedBy(`slot ${lock}`, r, denied('availability_slot'));
    });
  }

  for (const table of TABLES) {
    test(`app_rw TRUNCATE of ${table} is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `TRUNCATE ${table}`,
        await asAppRw(`TRUNCATE public.${table}`),
        denied(table),
      );
    });
  }

  test('app_rw holds exactly these column and table privileges on the three tables', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(t || ' ' ||
                  (SELECT string_agg(attname || '=' ||
                             has_column_privilege('app_rw', ('public.' || t)::regclass, attname, 'INSERT') || '/' ||
                             has_column_privilege('app_rw', ('public.' || t)::regclass, attname, 'UPDATE'), ',' ORDER BY attnum)
                     FROM pg_attribute WHERE attrelid = ('public.' || t)::regclass AND attnum > 0 AND NOT attisdropped) ||
                  ' table:' ||
                  (SELECT string_agg(p || '=' || has_table_privilege('app_rw', ('public.' || t)::regclass, p), ',')
                     FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p),
                  ' ; ' ORDER BY t)
           FROM unnest(ARRAY['availability_template', 'availability_exception', 'availability_slot']) t`,
      ),
      'availability_exception id=true/false,sitter_id=true/false,on_date=true/false,kind=true/false,start_local=true/false,' +
        'end_local=true/false,tz=true/false,reason=true/false,created_at=true/false ' +
        'table:SELECT=true,INSERT=true,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false,MAINTAIN=false ; ' +
        'availability_slot id=true/false,sitter_id=true/false,span=true/false,cluster_ids=true/false,generated_at=true/false ' +
        'table:SELECT=true,INSERT=true,UPDATE=false,DELETE=true,TRUNCATE=false,REFERENCES=false,TRIGGER=false,MAINTAIN=false ; ' +
        'availability_template id=true/false,sitter_id=true/false,weekday=true/false,start_local=true/false,end_local=true/false,' +
        'tz=true/false,effective_from=true/false,effective_to=true/true,version=true/true ' +
        'table:SELECT=true,INSERT=true,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false,MAINTAIN=false',
    );
  });

  test("CONTROL — app_rw reads as T-089's Q8 and Q10 and T-099's Q7 shapes (span && / @> and cluster_ids &&)", async () => {
    const r = await asAppRw(
      `SELECT 'q8 ' || count(*) FROM public.availability_slot WHERE sitter_id = ${q(SIT_A)}
          AND span && tstzrange('2026-10-16T00:00:00Z', '2026-10-18T00:00:00Z', '[)')`,
      `SELECT 'q10 ' || count(*) FROM public.availability_slot WHERE sitter_id = ${q(SIT_A)}
          AND span @> tstzrange('2026-10-16T17:00:00Z', '2026-10-16T20:00:00Z', '[)')`,
      `SELECT 'q7 ' || count(*) FROM public.availability_slot
        WHERE span @> tstzrange('2026-10-16T17:00:00Z', '2026-10-16T20:00:00Z', '[)') AND cluster_ids && '{1}'::int[]`,
    );
    assertPermitted('reads', r);
    assertRead('reads', r, 'q8 2');
    assertRead('reads', r, 'q10 1');
    assertRead('reads', r, 'q7 2');
  });

  test("NOT HELD — app_rw writes slots with an empty cluster_ids (legal, U-9 (a)), one with NULL and repeated elements, and its own generated_at and an exception's created_at in 2000: accepted", async () => {
    const r = await asAppRw(
      `${slot(ulid('EMPTYC'), SIT_B, span('2029-01-01T00:00:00Z', '2029-01-01T01:00:00Z'), `'{}'`)} RETURNING 'empty ' || cardinality(cluster_ids)`,
      `${slot(ulid('NULLC'), SIT_B, span('2029-01-02T00:00:00Z', '2029-01-02T01:00:00Z'), `'{NULL,7,7}'`)} RETURNING 'odd ' || array_to_string(cluster_ids, ',', 'null')`,
      `INSERT INTO public.availability_slot (id, sitter_id, span, cluster_ids, generated_at)
       VALUES (${q(ulid('GENAT'))}, ${q(SIT_B)}, ${span('2029-01-03T00:00:00Z', '2029-01-03T01:00:00Z')}, '{1}', '2000-01-01T00:00:00Z')
       RETURNING 'generated ' || extract(year FROM generated_at)`,
      `INSERT INTO public.availability_exception (id, sitter_id, on_date, kind, created_at)
       VALUES (${q(ulid('CRAT'))}, ${q(SIT_B)}, '2026-10-21', 'REMOVE', '2000-01-01T00:00:00Z')
       RETURNING 'created ' || extract(year FROM created_at)`,
    );
    assertPermitted('content unchecked', r);
    for (const line of ['empty 0', 'odd null,7,7', 'generated 2000', 'created 2000']) {
      assertRead('content unchecked', r, line);
    }
  });

  test('NOT HELD — the owner app_ddl and the superuser each UPDATE a slot span, DELETE a template row and DELETE an exception: the grants bind app_rw only', async () => {
    for (const [who, run] of [
      ['owner', (...c: string[]) => asLogin(LOGINS.app_ddl, ...c)],
      ['superuser', (...c: string[]) => asSuperuser(...c)],
    ] as const) {
      const r = await run(
        `UPDATE public.availability_slot SET span = ${span('2026-10-16T16:00:00Z', '2026-10-16T18:00:00Z')} WHERE id = ${q(SLOT_A1)} RETURNING '${who} moved a slot'`,
        `DELETE FROM public.availability_template WHERE id = ${q(TPL_A2)} RETURNING '${who} deleted a template'`,
        `DELETE FROM public.availability_exception WHERE id = ${q(EXC_A1)} RETURNING '${who} deleted an exception'`,
      );
      assertPermitted(`${who} rewrites`, r);
      for (const line of ['moved a slot', 'deleted a template', 'deleted an exception']) {
        assertRead(`${who} rewrites`, r, `${who} ${line}`);
      }
    }
  });
});

describe('0029 — no other role reads or writes them (U-21 (a)), over real single-membership logins', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    for (const table of TABLES) {
      test(`${role} SELECT on ${table} is REFUSED (42501)`, async () => {
        assertRefusedBy(
          `${role} SELECT ${table}`,
          await asLogin(LOGINS[role], `SELECT count(*) FROM public.${table}`),
          denied(table),
        );
      });
    }

    test(`${role} INSERT into each of the three tables is REFUSED (42501)`, async () => {
      for (const [table, sql] of [
        ['availability_template', template(ulid('OTHER'), SIT_B, '1', `'09:00'`, `'10:00'`)],
        ['availability_exception', exception(ulid('OTHER'), SIT_B, `'REMOVE'`, 'NULL', 'NULL')],
        [
          'availability_slot',
          slot(ulid('OTHER'), SIT_B, span('2029-02-01T00:00:00Z', '2029-02-01T01:00:00Z')),
        ],
      ] as const) {
        assertRefusedBy(`${role} INSERT ${table}`, await asLogin(LOGINS[role], sql), denied(table));
      }
    });
  }

  // app_admin_rw holds no SELECT, so a WHERE that reads a column would be refused for the missing
  // SELECT whatever DELETE or UPDATE it held (T-163 QA Q-1). These statements read no column: a bare
  // DELETE needs DELETE on the table alone, and a bare UPDATE setting a constant needs UPDATE on that
  // column alone. The CONTROL below shows each succeeding with only that privilege added.
  test('app_admin_rw DELETE FROM availability_slot with no WHERE (needs DELETE alone) is REFUSED (42501)', async () => {
    assertRefusedBy(
      'admin bare DELETE slot',
      await asLogin(LOGINS.app_admin_rw, `DELETE FROM public.availability_slot`),
      denied('availability_slot'),
    );
  });

  test('app_admin_rw UPDATE availability_template SET effective_to = <constant> with no WHERE (needs UPDATE on effective_to alone) is REFUSED (42501)', async () => {
    assertRefusedBy(
      'admin bare UPDATE template',
      await asLogin(
        LOGINS.app_admin_rw,
        `UPDATE public.availability_template SET effective_to = '2026-10-01'`,
      ),
      denied('availability_template'),
    );
  });

  test('CONTROL — with ONLY DELETE on availability_slot, or ONLY UPDATE (effective_to) on availability_template, granted to app_admin_rw (rolled back, no SELECT), the same bare statements SUCCEED as its login', async () => {
    const del = await asSuperuser(
      'GRANT DELETE ON public.availability_slot TO app_admin_rw',
      `SET LOCAL ROLE ${LOGINS.app_admin_rw}`,
      `SELECT 'admin slot SELECT=' || has_table_privilege('public.availability_slot', 'SELECT') ||
              ' DELETE=' || has_table_privilege('public.availability_slot', 'DELETE')`,
      `DELETE FROM public.availability_slot`,
    );
    assertPermitted('admin bare DELETE with DELETE granted', del);
    assertRead('admin bare DELETE with DELETE granted', del, 'admin slot SELECT=false DELETE=true');
    assertRead('admin bare DELETE with DELETE granted', del, 'DELETE 3');
    const upd = await asSuperuser(
      'GRANT UPDATE (effective_to) ON public.availability_template TO app_admin_rw',
      `SET LOCAL ROLE ${LOGINS.app_admin_rw}`,
      `SELECT 'admin template SELECT=' || has_any_column_privilege('public.availability_template', 'SELECT') ||
              ' UPDATE(effective_to)=' || has_column_privilege('public.availability_template', 'effective_to', 'UPDATE')`,
      `UPDATE public.availability_template SET effective_to = '2026-10-01'`,
    );
    assertPermitted('admin bare UPDATE with UPDATE (effective_to) granted', upd);
    assertRead(
      'admin bare UPDATE with UPDATE (effective_to) granted',
      upd,
      'admin template SELECT=false UPDATE(effective_to)=true',
    );
    assertRead('admin bare UPDATE with UPDATE (effective_to) granted', upd, 'UPDATE 2');
  });

  test('no role but app_ddl (the owner) and app_rw holds any privilege on any of the three tables or their columns, PUBLIC included', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(t || ':' || r || '=' ||
                  (has_table_privilege(r, ('public.' || t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR
                   has_any_column_privilege(r, ('public.' || t)::regclass, 'SELECT,INSERT,UPDATE,REFERENCES')), ',' ORDER BY t, r)
           FROM unnest(ARRAY['availability_template', 'availability_exception', 'availability_slot']) t
          CROSS JOIN unnest(ARRAY['app_admin_rw', 'app_safety_rw', 'answering_service', 'app_rw', 'public']) r`,
      ),
      [
        'availability_exception:answering_service=false,availability_exception:app_admin_rw=false,availability_exception:app_rw=true,',
        'availability_exception:app_safety_rw=false,availability_exception:public=false,',
        'availability_slot:answering_service=false,availability_slot:app_admin_rw=false,availability_slot:app_rw=true,',
        'availability_slot:app_safety_rw=false,availability_slot:public=false,',
        'availability_template:answering_service=false,availability_template:app_admin_rw=false,availability_template:app_rw=true,',
        'availability_template:app_safety_rw=false,availability_template:public=false',
      ].join(''),
    );
  });
});

describe('0029 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON availability_slot TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.availability_slot TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.availability_slot'),
      `the guard's DETAIL does not name availability_slot.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.availability_slot', 'SELECT')::text`,
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
});

describe('0029 — after every case', () => {
  test('the fixture rows survive every refusal and rolled-back write above, and nothing else was committed', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(id || ':' || weekday || ':' || start_local || '-' || end_local || ':' || coalesce(effective_to::text, '-') || ':v' || version, ',' ORDER BY id) FROM public.availability_template) || ' | ' ||
                (SELECT string_agg(id || ':' || kind || ':' || coalesce(start_local::text, 'null'), ',' ORDER BY id) FROM public.availability_exception) || ' | ' ||
                (SELECT string_agg(id || ':' || sitter_id || ':' || lower(span) || '/' || upper(span), ',' ORDER BY id) FROM public.availability_slot)`,
      ),
      `${TPL_A1}:4:19:00:00-24:00:00:-:v1,${TPL_A2}:5:00:00:00-01:00:00:-:v1 | ${EXC_A1}:REMOVE:null | ` +
        `${SLOT_A1}:${SIT_A}:2026-10-16 16:00:00+00/2026-10-16 22:00:00+00,` +
        `${SLOT_A2}:${SIT_A}:2026-10-17 16:00:00+00/2026-10-17 22:00:00+00,` +
        `${SLOT_B1}:${SIT_B}:2026-10-16 16:00:00+00/2026-10-16 22:00:00+00`,
    );
  });
});

// LAST: changes the cluster (down to 0028, then up again).
describe('0029 down and up again', () => {
  test('after db:migrate down --to 0028 the three tables are gone; after db:migrate up they are back and an overlapping slot is REFUSED (23P01) again, as app_rw', async () => {
    const down = await db.migrate(['down', '--to', '0028', '--dir', COMMITTED_DIR]);
    assert.equal(judgeMigrateRun(down).kind, 'OK', down.output);
    assert.equal(
      await db.value(
        `SELECT ${TABLES.map((t) => `(to_regclass('public.${t}') IS NULL)::text`).join(` || ' ' || `)}`,
      ),
      'true true true',
    );
    const up = await db.migrate(['up', '--dir', COMMITTED_DIR]);
    assert.equal(judgeMigrateRun(up).kind, 'OK', up.output);
    const r = await asAppRw(
      slot(ulid('UP1'), SIT_A, SPAN_A1),
      slot(ulid('UP2'), SIT_A, span('2026-10-16T21:00:00Z', '2026-10-16T23:00:00Z')),
    );
    assertRefusedBy('overlap after down/up', r, EXCL_23P01, EXCL_FIELD);
  });
});
