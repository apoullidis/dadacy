/**
 * T-206 — `public.staffed_schedule_version`, `public.staffed_interval` and
 * `public.staffed_schedule_current` (migration 0023): P-STAFFED of tasks/state/EP-8b/OD-226-cut.md,
 * T-080's § Migration request, built against tasks/state/EP-2/OE-30-34-rulings.md as OE-50 accepted
 * it: A.2 U-1 (the interval ULID key) and U-4 (app_rw writes; nothing to app_admin_rw), E.2 U-3 (the
 * pointer) and U-5 (no admin grant, no RLS), C5 (a) (UPDATE (superseded_at)), OE-31 U-15 (a) (the
 * span-shape CHECK), U-8 (a)/E.2 U-7/C6 (a)/E.2 U-14 (no seed, horizon column, extension job or
 * pattern CHECK).
 *
 * V1 (no two intervals of one version overlap) is held by SD 3180's EXCLUDE alone, and these cases
 * are its only evidence: db:introspect:check does not render an exclusion constraint (OE-31 IC-2,
 * measured by T-206).
 *
 * What the database does NOT refuse is pinned too, each in a case named NOT HELD: the once-only rule
 * on superseded_at (T-082's), an interval added to an existing version, a pointer to another
 * jurisdiction's or a superseded version, a span bounded by 'infinity', the content of pattern, note
 * and jurisdiction, row locks app_rw can take, and every write by the owner app_ddl or the superuser
 * beyond the constraints. The catalogue reads (columns, defaults, constraints, indexes, table and
 * column ACLs, the comments, and the counts of triggers, rewrite rules, policies and both
 * row-level-security flags on each table) turn red if a grant, a constraint, an index, a trigger, a
 * rule or a policy is added to or removed from any of the three tables.
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

const SUITE = 'staffed-schedule';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't206_app_rw_probe',
  app_admin_rw: 't206_app_admin_rw_probe',
  app_safety_rw: 't206_app_safety_rw_probe',
  answering_service: 't206_answering_service_probe',
  app_ddl: 't206_app_ddl_probe',
} as const;

/** A 26-character id (the char(26) ULID columns), distinct per label. */
const ulid = (label: string): string => {
  const id = `01J206${label}`.padEnd(26, '0');
  if (id.length !== 26) throw new Error(`ulid label too long: ${label}`);
  return id;
};
const q = (s: string): string => `'${s}'`;

const ACC = ulid('ACC');
const APR_A = ulid('APRA');
const APR_B = ulid('APRB');
const VER_A = ulid('VERA');
const VER_B = ulid('VERB');
const INT_A1 = ulid('INTA1');
const INT_A2 = ulid('INTA2');
const NO_SUCH = ulid('NOSUCH');

/** A half-open UTC span literal. */
const span = (from: string, to: string): string => `'[${from}, ${to})'::tstzrange`;
/** The two fixture intervals of VER_A (a Friday and a Saturday, standard season, 14:00-02:00 local). */
const SPAN_A1 = span('2026-10-02T11:00:00Z', '2026-10-02T23:00:00Z');
const SPAN_A2 = span('2026-10-03T11:00:00Z', '2026-10-03T23:00:00Z');

const TABLES = [
  'staffed_schedule_version',
  'staffed_interval',
  'staffed_schedule_current',
] as const;

type VersionField = 'jurisdiction' | 'effective_from' | 'published_by' | 'pattern' | 'note';
/** T-080.md Q1, the version row: exactly the seven columns app_rw may write. */
const version = (
  id: string,
  approval: string,
  over: Partial<Record<VersionField, string>> = {},
): string =>
  `INSERT INTO public.staffed_schedule_version (id, jurisdiction, effective_from, published_by, approval_id, pattern, note)
   VALUES (${q(id)}, ${over.jurisdiction ?? `'CY'`}, ${over.effective_from ?? `'2026-10-01'`}, ${over.published_by ?? q(ACC)},
           ${q(approval)}, ${over.pattern ?? `'{"schema": 1}'`}, ${over.note ?? `'t206 fixture'`})`;

/** One interval row (T-080.md Q2 writes many in one statement; see the V1 cases). */
const interval = (id: string, versionId: string, spanSql: string): string =>
  `INSERT INTO public.staffed_interval (id, version_id, span) VALUES (${q(id)}, ${q(versionId)}, ${spanSql})`;

/** A fixture approval: pending, submitted by ACC (0007's table; this suite needs only its id). */
const approval = (id: string): string =>
  `INSERT INTO public.approval (id, subject_type, subject_id, action, submitter_id, submitted_at)
   VALUES (${q(id)}, 'staffed_schedule_version', ${q(VER_A)}, 'publish', ${q(ACC)}, now())`;

/** One row's state, read in the session that then writes it. */
const readVersion = (id: string): string =>
  `SELECT 'version ${id} count=' || count(*) || ' superseded=' || coalesce(string_agg((superseded_at IS NOT NULL)::text, ','), '-')
     FROM public.staffed_schedule_version WHERE id = ${q(id)}`;
const VERSION_PRESENT = (id: string): string => `version ${id} count=1 superseded=false`;
const readInterval = (id: string): string =>
  `SELECT 'interval ${id} count=' || count(*) FROM public.staffed_interval WHERE id = ${q(id)}`;
const INTERVAL_PRESENT = (id: string): string => `interval ${id} count=1`;
const READ_POINTER = `SELECT 'pointer CY -> ' || coalesce((SELECT current_version_id::text FROM public.staffed_schedule_current WHERE jurisdiction = 'CY'), 'none')`;
const POINTER_PRESENT = `pointer CY -> ${VER_A}`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      `INSERT INTO public.account (id, pseudonym, tos_version) VALUES (${q(ACC)}, ${q(ulid('PSEUDO'))}, 't206')`,
      approval(APR_A),
      approval(APR_B),
      version(VER_A, APR_A),
      version(VER_B, APR_B, { effective_from: `'2027-04-01'` }),
      interval(INT_A1, VER_A, SPAN_A1),
      interval(INT_A2, VER_A, SPAN_A2),
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('CY', ${q(VER_A)})`,
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

const denied = (table: string): string => `ERROR:  42501: permission denied for table ${table}`;
const EXCL = 'staffed_interval_version_id_span_excl';
const EXCL_23P01 = `ERROR:  23P01: conflicting key value violates exclusion constraint "${EXCL}"`;
const EXCL_FIELD = `CONSTRAINT NAME:  ${EXCL}`;
const SHAPE_23514 =
  'ERROR:  23514: new row for relation "staffed_interval" violates check constraint "staffed_interval_span_shape"';
const SHAPE_FIELD = 'CONSTRAINT NAME:  staffed_interval_span_shape';
const pkey = (table: string): string =>
  `ERROR:  23505: duplicate key value violates unique constraint "${table}_pkey"`;
const fkInsert = (table: string, constraint: string): string =>
  `ERROR:  23503: insert or update on table "${table}" violates foreign key constraint "${constraint}"`;
const fkDelete = (table: string, constraint: string, on: string): string =>
  `ERROR:  23503: update or delete on table "${table}" violates foreign key constraint "${constraint}" on table "${on}"`;
const notNull = (table: string, column: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "${table}" violates not-null constraint`;

/** The texts 0023 installs, verbatim: a change to a comment must change this suite too. */
const COMMENTS: Record<(typeof TABLES)[number], string> = {
  staffed_schedule_version:
    'A published Staffed-Hours schedule version (SD §DB-15; SA §SA-4 I-7). app_rw may SELECT, may INSERT only id, ' +
    'jurisdiction, effective_from, published_by, approval_id, pattern and note, so published_at takes now() and ' +
    'superseded_at starts NULL for it, and may UPDATE only superseded_at. The rule that superseded_at is set once, ' +
    'from NULL, is not held by this table. It holds no DELETE or TRUNCATE. These are grants: they bind app_rw, not ' +
    'the table owner app_ddl or the superuser. pattern is the authored pattern, kept for provenance; its shape is ' +
    'not checked here. No other role is granted any privilege, and there is no row-level security.',
  staffed_interval:
    'The materialised absolute UTC intervals of a staffed schedule version (SD §DB-15; SA §SA-4 I-7). id is a ULID ' +
    'the generator supplies. No two intervals of one version overlap (the exclusion constraint). CHECK ' +
    'staffed_interval_span_shape: a span is non-empty, has both bounds, both finite, includes its lower bound and ' +
    'excludes its upper bound; it does not bound the length of a span. app_rw may SELECT and INSERT, and holds no UPDATE, ' +
    'DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. Nothing ' +
    'here refuses an interval added to an existing version. No other role is granted any privilege, and there is ' +
    'no row-level security.',
  staffed_schedule_current:
    'The current staffed schedule version of each jurisdiction (SD §DB-15). app_rw may SELECT, INSERT and UPDATE ' +
    'only current_version_id, and holds no DELETE or TRUNCATE. These are grants: they bind app_rw, not the table ' +
    'owner app_ddl or the superuser. The database does not check that the version belongs to this jurisdiction or ' +
    'is not superseded. No other role is granted any privilege, and there is no row-level security.',
};

describe('0023 — the tables, their owner, columns, constraints, indexes, ACLs and comments', () => {
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
           FROM pg_class c WHERE c.oid IN ('public.staffed_schedule_version'::regclass, 'public.staffed_interval'::regclass,
                                           'public.staffed_schedule_current'::regclass)`,
      ),
      'staffed_interval|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl}|' +
        'id:character(26):nn:-:-,version_id:character(26):nn:-:-,span:tstzrange:nn:-:- ; ' +
        'staffed_schedule_current|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl}|' +
        'jurisdiction:text:nn:-:-,current_version_id:character(26):nn:-:{app_rw=w/app_ddl} ; ' +
        'staffed_schedule_version|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}|' +
        'id:character(26):nn:-:{app_rw=a/app_ddl},jurisdiction:text:nn:-:{app_rw=a/app_ddl},' +
        'effective_from:date:nn:-:{app_rw=a/app_ddl},published_at:timestamp with time zone:nn:now():-,' +
        'published_by:character(26):nn:-:{app_rw=a/app_ddl},approval_id:character(26):nn:-:{app_rw=a/app_ddl},' +
        'pattern:jsonb:nn:-:{app_rw=a/app_ddl},note:text:nn:-:{app_rw=a/app_ddl},' +
        'superseded_at:timestamp with time zone:null:-:{app_rw=w/app_ddl}',
    );
  });

  test('the constraints of the three tables are exactly these, by these definitions, none deferrable', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conrelid::regclass::text || '.' || conname || '=' || contype::text || ' ' || pg_get_constraintdef(oid) ||
                           ' deferrable=' || condeferrable || ' del=' || confdeltype::text || ' upd=' || confupdtype::text,
                           ' ; ' ORDER BY conrelid::regclass::text, conname)
           FROM pg_constraint WHERE conrelid IN ('public.staffed_schedule_version'::regclass, 'public.staffed_interval'::regclass,
                                                 'public.staffed_schedule_current'::regclass)`,
      ),
      [
        'staffed_interval.staffed_interval_id_not_null=n NOT NULL id deferrable=false del=  upd= ',
        'staffed_interval.staffed_interval_pkey=p PRIMARY KEY (id) deferrable=false del=  upd= ',
        'staffed_interval.staffed_interval_span_not_null=n NOT NULL span deferrable=false del=  upd= ',
        'staffed_interval.staffed_interval_span_shape=c CHECK (((NOT isempty(span)) AND (NOT lower_inf(span)) AND (NOT upper_inf(span)) AND lower_inc(span) AND (NOT upper_inc(span)) AND isfinite(lower(span)) AND isfinite(upper(span)))) deferrable=false del=  upd= ',
        'staffed_interval.staffed_interval_version_id_fkey=f FOREIGN KEY (version_id) REFERENCES staffed_schedule_version(id) deferrable=false del=a upd=a',
        'staffed_interval.staffed_interval_version_id_not_null=n NOT NULL version_id deferrable=false del=  upd= ',
        'staffed_interval.staffed_interval_version_id_span_excl=x EXCLUDE USING gist (version_id WITH =, span WITH &&) deferrable=false del=  upd= ',
        'staffed_schedule_current.staffed_schedule_current_current_version_id_fkey=f FOREIGN KEY (current_version_id) REFERENCES staffed_schedule_version(id) deferrable=false del=a upd=a',
        'staffed_schedule_current.staffed_schedule_current_current_version_id_not_null=n NOT NULL current_version_id deferrable=false del=  upd= ',
        'staffed_schedule_current.staffed_schedule_current_jurisdiction_not_null=n NOT NULL jurisdiction deferrable=false del=  upd= ',
        'staffed_schedule_current.staffed_schedule_current_pkey=p PRIMARY KEY (jurisdiction) deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_approval_id_fkey=f FOREIGN KEY (approval_id) REFERENCES approval(id) deferrable=false del=a upd=a',
        'staffed_schedule_version.staffed_schedule_version_approval_id_not_null=n NOT NULL approval_id deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_effective_from_not_null=n NOT NULL effective_from deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_id_not_null=n NOT NULL id deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_jurisdiction_not_null=n NOT NULL jurisdiction deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_note_not_null=n NOT NULL note deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_pattern_not_null=n NOT NULL pattern deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_pkey=p PRIMARY KEY (id) deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_published_at_not_null=n NOT NULL published_at deferrable=false del=  upd= ',
        'staffed_schedule_version.staffed_schedule_version_published_by_fkey=f FOREIGN KEY (published_by) REFERENCES account(id) deferrable=false del=a upd=a',
        // value() trims the output, so the last entry's trailing blank (confupdtype ' ') is not compared.
        'staffed_schedule_version.staffed_schedule_version_published_by_not_null=n NOT NULL published_by deferrable=false del=  upd=',
      ].join(' ; '),
    );
  });

  test("the indexes are SD 3180-3183's and the keys': the exclusion's gist, idx_staffed_interval_span, staffed_interval_version_id_idx, and the three primary keys", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid IN ('public.staffed_schedule_version'::regclass, 'public.staffed_interval'::regclass,
                                            'public.staffed_schedule_current'::regclass)`,
      ),
      [
        'CREATE INDEX idx_staffed_interval_span ON public.staffed_interval USING gist (span)',
        'CREATE UNIQUE INDEX staffed_interval_pkey ON public.staffed_interval USING btree (id)',
        'CREATE INDEX staffed_interval_version_id_idx ON public.staffed_interval USING btree (version_id)',
        'CREATE INDEX staffed_interval_version_id_span_excl ON public.staffed_interval USING gist (version_id, span)',
        'CREATE UNIQUE INDEX staffed_schedule_current_pkey ON public.staffed_schedule_current USING btree (jurisdiction)',
        'CREATE UNIQUE INDEX staffed_schedule_version_pkey ON public.staffed_schedule_version USING btree (id)',
      ].join(' ; '),
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
           FROM pg_class c WHERE c.oid IN ('public.staffed_schedule_version'::regclass, 'public.staffed_interval'::regclass,
                                           'public.staffed_schedule_current'::regclass)`,
      ),
      'staffed_interval: 0 triggers, 0 rules, rls=false, force=false, 0 policies ; ' +
        'staffed_schedule_current: 0 triggers, 0 rules, rls=false, force=false, 0 policies ; ' +
        'staffed_schedule_version: 0 triggers, 0 rules, rls=false, force=false, 0 policies',
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

  test("the EXCLUDE's equality half on char(26) uses btree_gist's gist_bpchar_ops, and its overlap half range_ops", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(opc.opcname || '@' || coalesce(e.extname, 'core'), ',' ORDER BY k.ord)
           FROM pg_index i CROSS JOIN LATERAL unnest(i.indclass) WITH ORDINALITY AS k(cls, ord)
           JOIN pg_opclass opc ON opc.oid = k.cls
           LEFT JOIN pg_depend d ON d.classid = 'pg_opclass'::regclass AND d.objid = opc.oid AND d.deptype = 'e'
           LEFT JOIN pg_extension e ON e.oid = d.refobjid
          WHERE i.indexrelid = 'public.staffed_interval_version_id_span_excl'::regclass`,
      ),
      'gist_bpchar_ops@btree_gist,range_ops@core',
    );
  });
});

describe('0023 — V1: no two intervals of one version overlap (SD 3180, the EXCLUDE)', () => {
  test('app_rw inserting a span that overlaps an existing interval of the same version is REFUSED by the exclusion constraint (23P01)', async () => {
    assertRefusedBy(
      'app_rw overlap',
      await asLogin(
        LOGINS.app_rw,
        readInterval(INT_A1),
        interval(ulid('OVL1'), VER_A, span('2026-10-02T22:00:00Z', '2026-10-03T01:00:00Z')),
      ),
      EXCL_23P01,
      EXCL_FIELD,
    );
  });

  test('the superuser inserting the identical span again is REFUSED (23P01): the constraint binds every writer', async () => {
    const r = await asSuperuser(readInterval(INT_A1), interval(ulid('OVL2'), VER_A, SPAN_A1));
    assertRead('superuser identical span', r, INTERVAL_PRESENT(INT_A1));
    assertRefusedBy('superuser identical span', r, EXCL_23P01, EXCL_FIELD);
  });

  test('a span contained in an existing interval is REFUSED (23P01), as the owner app_ddl', async () => {
    assertRefusedBy(
      'owner contained span',
      await asLogin(
        LOGINS.app_ddl,
        interval(ulid('OVL3'), VER_A, span('2026-10-02T12:00:00Z', '2026-10-02T13:00:00Z')),
      ),
      EXCL_23P01,
      EXCL_FIELD,
    );
  });

  test("two overlapping NEW rows inside one multi-row INSERT … SELECT unnest(…) (Q2's shape) are REFUSED (23P01) and none lands", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `INSERT INTO public.staffed_interval (id, version_id, span)
       SELECT i, ${q(VER_B)}, tstzrange(s, e, '[)')
         FROM unnest(ARRAY[${q(ulid('Q2A'))}, ${q(ulid('Q2B'))}]::char(26)[],
                     ARRAY['2027-04-02T11:00:00Z', '2027-04-02T22:00:00Z']::timestamptz[],
                     ARRAY['2027-04-02T23:00:00Z', '2027-04-03T01:00:00Z']::timestamptz[]) AS t(i, s, e)`,
    );
    assertRefusedBy('one statement, two overlapping rows', r, EXCL_23P01, EXCL_FIELD);
    assert.equal(
      await db.value(`SELECT count(*) FROM public.staffed_interval WHERE version_id = ${q(VER_B)}`),
      '0',
    );
  });

  test('the superuser moving an interval onto its sibling (UPDATE) is REFUSED (23P01)', async () => {
    const r = await asSuperuser(
      readInterval(INT_A2),
      `UPDATE public.staffed_interval SET span = ${SPAN_A1} WHERE id = ${q(INT_A2)}`,
    );
    assertRead('superuser UPDATE onto a sibling', r, INTERVAL_PRESENT(INT_A2));
    assertRefusedBy('superuser UPDATE onto a sibling', r, EXCL_23P01, EXCL_FIELD);
  });

  test("CONTROL — app_rw writes Q2's shape: the same spans under ANOTHER version, and contiguous half-open spans [a,b) [b,c) in one version, in one INSERT … SELECT unnest(…)", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `INSERT INTO public.staffed_interval (id, version_id, span)
       SELECT i, ${q(VER_B)}, tstzrange(s, e, '[)')
         FROM unnest(ARRAY[${q(ulid('CTLA'))}, ${q(ulid('CTLB'))}, ${q(ulid('CTLC'))}]::char(26)[],
                     ARRAY['2026-10-02T11:00:00Z', '2026-10-02T23:00:00Z', '2026-10-03T11:00:00Z']::timestamptz[],
                     ARRAY['2026-10-02T23:00:00Z', '2026-10-03T02:00:00Z', '2026-10-03T23:00:00Z']::timestamptz[]) AS t(i, s, e)
       RETURNING 'inserted ' || id`,
      `SELECT 'version B intervals=' || count(*) || ' contiguous=' ||
              bool_or(upper(a.span) = lower(b.span))
         FROM public.staffed_interval a JOIN public.staffed_interval b ON a.version_id = b.version_id AND a.id < b.id
        WHERE a.version_id = ${q(VER_B)}`,
    );
    assertPermitted('same spans elsewhere; contiguous spans', r);
    assertRead('same spans elsewhere; contiguous spans', r, 'INSERT 0 3');
    assertRead(
      'same spans elsewhere; contiguous spans',
      r,
      'version B intervals=3 contiguous=true',
    );
  });
});

describe('0023 — the span shape: staffed_interval_span_shape (OE-31 U-15 (a), OE-77)', () => {
  for (const [label, literal] of [
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
  ] as const) {
    test(`a span ${label} is REFUSED by staffed_interval_span_shape (23514), as the superuser`, async () => {
      assertRefusedBy(
        `superuser span ${label}`,
        await asSuperuser(interval(ulid('SHAPE'), VER_B, literal)),
        SHAPE_23514,
        SHAPE_FIELD,
      );
    });
  }

  for (const [label, literal] of [
    ["'empty'", `'empty'::tstzrange`],
    ['[a,) — no upper bound', `'[2027-10-01T00:00:00Z,)'::tstzrange`],
    ['[a,b] — upper included', `'[2027-10-01T00:00:00Z,2027-10-02T00:00:00Z]'::tstzrange`],
  ] as const) {
    test(`app_rw writing a span ${label} is REFUSED by staffed_interval_span_shape (23514)`, async () => {
      assertRefusedBy(
        `app_rw span ${label}`,
        await asLogin(LOGINS.app_rw, interval(ulid('SHAPE'), VER_B, literal)),
        SHAPE_23514,
        SHAPE_FIELD,
      );
    });
  }

  test('the superuser moving a fixture interval to an unbounded span (UPDATE) is REFUSED (23514)', async () => {
    const r = await asSuperuser(
      readInterval(INT_A1),
      `UPDATE public.staffed_interval SET span = '[2026-10-02T11:00:00Z,)' WHERE id = ${q(INT_A1)}`,
    );
    assertRead('superuser UPDATE to unbounded', r, INTERVAL_PRESENT(INT_A1));
    assertRefusedBy('superuser UPDATE to unbounded', r, SHAPE_23514, SHAPE_FIELD);
  });

  test('a span whose upper bound is below its lower is REFUSED by the range type itself (22000), before the CHECK', async () => {
    assertRefusedBy(
      'reversed bounds',
      await asSuperuser(
        interval(ulid('REV'), VER_B, span('2027-10-02T00:00:00Z', '2027-10-01T00:00:00Z')),
      ),
      'ERROR:  22000: range lower bound must be less than or equal to range upper bound',
    );
  });

  test("CONTROL — app_rw writes a '[)' span, built as SD 3196 builds them (tstzrange(a, b, '[)')) and as a literal", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `${interval(ulid('OKA'), VER_B, `tstzrange('2027-10-01T11:00:00Z', '2027-10-01T23:00:00Z', '[)')`)} RETURNING 'ok ' || lower_inc(span) || ',' || upper_inc(span)`,
      `${interval(ulid('OKB'), VER_B, span('2027-10-02T11:00:00Z', '2027-10-02T23:00:00Z'))} RETURNING 'ok ' || isempty(span)`,
    );
    assertPermitted("app_rw '[)' spans", r);
    assertRead("app_rw '[)' spans", r, 'ok true,false');
    assertRead("app_rw '[)' spans", r, 'ok false');
  });

  // OE-77: 'infinity' and '-infinity' are values, so lower_inf/upper_inf alone admit them; isfinite refuses them.
  const INFINITE = [
    ['[a, infinity) — an infinite upper bound', `'[2030-01-01T00:00:00Z,infinity)'::tstzrange`],
    ['[-infinity, b) — an infinite lower bound', `'[-infinity,2030-01-01T00:00:00Z)'::tstzrange`],
    ['[-infinity, infinity) — both bounds infinite', `'[-infinity,infinity)'::tstzrange`],
  ] as const;
  for (const [label, literal] of INFINITE) {
    for (const [who, run] of [
      ['the superuser', (...c: string[]) => asSuperuser(...c)],
      ['app_rw', (...c: string[]) => asLogin(LOGINS.app_rw, ...c)],
    ] as const) {
      test(`a span ${label} is REFUSED by staffed_interval_span_shape (23514), as ${who} (OE-77)`, async () => {
        const r = await run(
          `SELECT 'bounds present: ' || (NOT lower_inf(${literal}) AND NOT upper_inf(${literal}))`,
          interval(ulid('INF'), VER_B, literal),
        );
        assertRead(`${who} span ${label}`, r, 'bounds present: true');
        assertRefusedBy(`${who} span ${label}`, r, SHAPE_23514, SHAPE_FIELD);
      });
    }
  }

  test('the superuser moving a fixture interval to an infinite upper bound (UPDATE) is REFUSED (23514, OE-77)', async () => {
    const r = await asSuperuser(
      readInterval(INT_A1),
      `UPDATE public.staffed_interval SET span = '[2026-10-02T11:00:00Z,infinity)' WHERE id = ${q(INT_A1)}`,
    );
    assertRead('superuser UPDATE to infinity', r, INTERVAL_PRESENT(INT_A1));
    assertRefusedBy('superuser UPDATE to infinity', r, SHAPE_23514, SHAPE_FIELD);
  });

  test('NOT HELD — app_rw writes a 100-year span: accepted; the CHECK does not bound the length of a span', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      version(ulid('LONGV'), APR_B),
      `${interval(ulid('LONG'), ulid('LONGV'), span('2020-01-01T00:00:00Z', '2120-01-01T00:00:00Z'))} RETURNING 'accepted 100 years'`,
    );
    assertPermitted('long span', r);
    assertRead('long span', r, 'accepted 100 years');
  });
});

describe('0023 — keys, references and NOT NULLs (V2, V3, V4)', () => {
  test('a duplicate interval id is REFUSED by staffed_interval_pkey (23505), even under another version and a disjoint span, as app_rw', async () => {
    assertRefusedBy(
      'duplicate interval id',
      await asLogin(
        LOGINS.app_rw,
        interval(INT_A1, VER_B, span('2028-01-01T00:00:00Z', '2028-01-02T00:00:00Z')),
      ),
      pkey('staffed_interval'),
      'CONSTRAINT NAME:  staffed_interval_pkey',
    );
  });

  test('a duplicate version id is REFUSED by staffed_schedule_version_pkey (23505), as app_rw', async () => {
    assertRefusedBy(
      'duplicate version id',
      await asLogin(LOGINS.app_rw, version(VER_A, APR_B)),
      pkey('staffed_schedule_version'),
      'CONSTRAINT NAME:  staffed_schedule_version_pkey',
    );
  });

  test('an interval naming no version is REFUSED by staffed_interval_version_id_fkey (23503), as app_rw', async () => {
    assertRefusedBy(
      'interval of no version',
      await asLogin(
        LOGINS.app_rw,
        interval(ulid('ORPHAN'), NO_SUCH, span('2028-01-01T00:00:00Z', '2028-01-02T00:00:00Z')),
      ),
      fkInsert('staffed_interval', 'staffed_interval_version_id_fkey'),
      'CONSTRAINT NAME:  staffed_interval_version_id_fkey',
    );
  });

  for (const [column, constraint, over] of [
    ['published_by', 'staffed_schedule_version_published_by_fkey', { published_by: q(NO_SUCH) }],
  ] as const) {
    test(`a version whose ${column} names no account is REFUSED by ${constraint} (23503), as app_rw`, async () => {
      assertRefusedBy(
        `unknown ${column}`,
        await asLogin(LOGINS.app_rw, version(ulid('VERX'), APR_B, over)),
        fkInsert('staffed_schedule_version', constraint),
        `CONSTRAINT NAME:  ${constraint}`,
      );
    });
  }

  test('a version whose approval_id names no approval is REFUSED by staffed_schedule_version_approval_id_fkey (23503), as app_rw', async () => {
    assertRefusedBy(
      'unknown approval_id',
      await asLogin(LOGINS.app_rw, version(ulid('VERX'), NO_SUCH)),
      fkInsert('staffed_schedule_version', 'staffed_schedule_version_approval_id_fkey'),
      'CONSTRAINT NAME:  staffed_schedule_version_approval_id_fkey',
    );
  });

  test('deleting a version that an interval references is REFUSED by staffed_interval_version_id_fkey (23503), as the superuser (NO ACTION)', async () => {
    const r = await asSuperuser(
      readVersion(VER_A),
      `DELETE FROM public.staffed_schedule_current WHERE jurisdiction = 'CY'`,
      `DELETE FROM public.staffed_schedule_version WHERE id = ${q(VER_A)}`,
    );
    assertRead('delete a referenced version', r, VERSION_PRESENT(VER_A));
    assertRefusedBy(
      'delete a referenced version',
      r,
      fkDelete('staffed_schedule_version', 'staffed_interval_version_id_fkey', 'staffed_interval'),
      'CONSTRAINT NAME:  staffed_interval_version_id_fkey',
    );
  });

  test('deleting a version that only the pointer references is REFUSED by staffed_schedule_current_current_version_id_fkey (23503), as the superuser', async () => {
    const r = await asSuperuser(
      readVersion(VER_B),
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('GR', ${q(VER_B)})`,
      `DELETE FROM public.staffed_schedule_version WHERE id = ${q(VER_B)}`,
    );
    assertRead('delete a version the pointer names', r, VERSION_PRESENT(VER_B));
    assertRefusedBy(
      'delete a version the pointer names',
      r,
      fkDelete(
        'staffed_schedule_version',
        'staffed_schedule_current_current_version_id_fkey',
        'staffed_schedule_current',
      ),
      'CONSTRAINT NAME:  staffed_schedule_current_current_version_id_fkey',
    );
  });

  test('changing a referenced version id is REFUSED (23503, NO ACTION on update), as the superuser', async () => {
    const r = await asSuperuser(
      readVersion(VER_A),
      `DELETE FROM public.staffed_schedule_current WHERE jurisdiction = 'CY'`,
      `UPDATE public.staffed_schedule_version SET id = ${q(ulid('RENAMED'))} WHERE id = ${q(VER_A)}`,
    );
    assertRead('rename a referenced version', r, VERSION_PRESENT(VER_A));
    assertRefusedBy(
      'rename a referenced version',
      r,
      fkDelete('staffed_schedule_version', 'staffed_interval_version_id_fkey', 'staffed_interval'),
      'CONSTRAINT NAME:  staffed_interval_version_id_fkey',
    );
  });

  for (const [table, constraint] of [
    ['account', 'staffed_schedule_version_published_by_fkey'],
    ['approval', 'staffed_schedule_version_approval_id_fkey'],
  ] as const) {
    test(`deleting the ${table} row a version names is REFUSED by ${constraint} (23503), as the superuser`, async () => {
      const id = table === 'account' ? ACC : APR_A;
      const r = await asSuperuser(
        `SELECT '${table} present=' || count(*) FROM public.${table} WHERE id = ${q(id)}`,
        `DELETE FROM public.${table} WHERE id = ${q(id)}`,
      );
      assertRead(`delete the ${table}`, r, `${table} present=1`);
      assertRefusedBy(
        `delete the ${table}`,
        r,
        fkDelete(table, constraint, 'staffed_schedule_version'),
        `CONSTRAINT NAME:  ${constraint}`,
      );
    });
  }

  for (const column of [
    'jurisdiction',
    'effective_from',
    'published_by',
    'pattern',
    'note',
  ] as const) {
    test(`staffed_schedule_version.${column} NULL is REFUSED (23502, naming the column), as app_rw`, async () => {
      const over: Partial<Record<VersionField, string>> = {};
      over[column] = 'NULL';
      assertRefusedBy(
        `version ${column} NULL`,
        await asLogin(LOGINS.app_rw, version(ulid('NULLV'), APR_B, over)),
        notNull('staffed_schedule_version', column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  for (const [column, sql] of [
    [
      'id',
      `INSERT INTO public.staffed_schedule_version (id, jurisdiction, effective_from, published_by, approval_id, pattern, note)
       VALUES (NULL, 'CY', '2026-10-01', ${q(ACC)}, ${q(APR_B)}, '{}', 'n')`,
    ],
    [
      'approval_id',
      `INSERT INTO public.staffed_schedule_version (id, jurisdiction, effective_from, published_by, approval_id, pattern, note)
       VALUES (${q(ulid('NULLV'))}, 'CY', '2026-10-01', ${q(ACC)}, NULL, '{}', 'n')`,
    ],
    [
      'published_at',
      `INSERT INTO public.staffed_schedule_version (id, jurisdiction, effective_from, published_at, published_by, approval_id, pattern, note)
       VALUES (${q(ulid('NULLV'))}, 'CY', '2026-10-01', NULL, ${q(ACC)}, ${q(APR_B)}, '{}', 'n')`,
    ],
  ] as const) {
    test(`staffed_schedule_version.${column} NULL is REFUSED (23502, naming the column), as the superuser`, async () => {
      assertRefusedBy(
        `version ${column} NULL`,
        await asSuperuser(sql),
        notNull('staffed_schedule_version', column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  for (const [column, sql] of [
    [
      'id',
      interval('NULL', VER_B, span('2028-01-01T00:00:00Z', '2028-01-02T00:00:00Z')).replace(
        "'NULL'",
        'NULL',
      ),
    ],
    [
      'version_id',
      interval(ulid('NULLI'), 'NULL', span('2028-01-01T00:00:00Z', '2028-01-02T00:00:00Z')).replace(
        "'NULL'",
        'NULL',
      ),
    ],
    ['span', interval(ulid('NULLI'), VER_B, 'NULL')],
  ] as const) {
    test(`staffed_interval.${column} NULL is REFUSED (23502, naming the column), as app_rw`, async () => {
      assertRefusedBy(
        `interval ${column} NULL`,
        await asLogin(LOGINS.app_rw, sql),
        notNull('staffed_interval', column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  for (const [column, sql] of [
    [
      'jurisdiction',
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES (NULL, ${q(VER_B)})`,
    ],
    [
      'current_version_id',
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('GR', NULL)`,
    ],
  ] as const) {
    test(`staffed_schedule_current.${column} NULL is REFUSED (23502, naming the column), as app_rw`, async () => {
      assertRefusedBy(
        `pointer ${column} NULL`,
        await asLogin(LOGINS.app_rw, sql),
        notNull('staffed_schedule_current', column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }
});

describe('0023 — the pointer: staffed_schedule_current (E.2 U-3)', () => {
  test('app_rw pointing a jurisdiction at no version is REFUSED by staffed_schedule_current_current_version_id_fkey (23503)', async () => {
    assertRefusedBy(
      'pointer to no version',
      await asLogin(
        LOGINS.app_rw,
        `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('GR', ${q(NO_SUCH)})`,
      ),
      fkInsert('staffed_schedule_current', 'staffed_schedule_current_current_version_id_fkey'),
      'CONSTRAINT NAME:  staffed_schedule_current_current_version_id_fkey',
    );
  });

  test('app_rw moving the CY pointer to no version (UPDATE) is REFUSED (23503)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_POINTER,
      `UPDATE public.staffed_schedule_current SET current_version_id = ${q(NO_SUCH)} WHERE jurisdiction = 'CY'`,
    );
    assertRead('pointer moved to no version', r, POINTER_PRESENT);
    assertRefusedBy(
      'pointer moved to no version',
      r,
      fkInsert('staffed_schedule_current', 'staffed_schedule_current_current_version_id_fkey'),
      'CONSTRAINT NAME:  staffed_schedule_current_current_version_id_fkey',
    );
  });

  test('app_rw inserting a second row for CY (a plain INSERT) is REFUSED by staffed_schedule_current_pkey (23505)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_POINTER,
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('CY', ${q(VER_B)})`,
    );
    assertRead('second CY pointer', r, POINTER_PRESENT);
    assertRefusedBy(
      'second CY pointer',
      r,
      pkey('staffed_schedule_current'),
      'CONSTRAINT NAME:  staffed_schedule_current_pkey',
    );
  });

  test('app_rw DELETE of the CY pointer is REFUSED (42501)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_POINTER,
      `DELETE FROM public.staffed_schedule_current WHERE jurisdiction = 'CY'`,
    );
    assertRead('pointer DELETE', r, POINTER_PRESENT);
    assertRefusedBy('pointer DELETE', r, denied('staffed_schedule_current'));
  });

  test('app_rw UPDATE (jurisdiction) of the CY pointer is REFUSED (42501)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_POINTER,
      `UPDATE public.staffed_schedule_current SET jurisdiction = 'GR' WHERE jurisdiction = 'CY'`,
    );
    assertRead('pointer jurisdiction UPDATE', r, POINTER_PRESENT);
    assertRefusedBy('pointer jurisdiction UPDATE', r, denied('staffed_schedule_current'));
  });

  test('app_rw TRUNCATE of the pointer is REFUSED (42501)', async () => {
    assertRefusedBy(
      'pointer TRUNCATE',
      await asLogin(LOGINS.app_rw, 'TRUNCATE public.staffed_schedule_current'),
      denied('staffed_schedule_current'),
    );
  });

  test('CONTROL — app_rw publishes in one transaction: Q1, Q2, the pointer upsert (INSERT … ON CONFLICT (jurisdiction) DO UPDATE SET current_version_id = EXCLUDED.current_version_id) and superseded_at on the outgoing version', async () => {
    const vNew = ulid('PUBNEW');
    const r = await asLogin(
      LOGINS.app_rw,
      READ_POINTER,
      `${version(vNew, APR_B, { effective_from: `'2027-10-01'` })} RETURNING 'published ' || id || ' at now()=' || (published_at = now()) || ' superseded null=' || (superseded_at IS NULL)`,
      `INSERT INTO public.staffed_interval (id, version_id, span)
       SELECT i, ${q(vNew)}, tstzrange(s, e, '[)')
         FROM unnest(ARRAY[${q(ulid('PUBI1'))}, ${q(ulid('PUBI2'))}]::char(26)[],
                     ARRAY['2027-10-01T11:00:00Z', '2027-10-02T11:00:00Z']::timestamptz[],
                     ARRAY['2027-10-01T20:00:00Z', '2027-10-02T23:00:00Z']::timestamptz[]) AS t(i, s, e)`,
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('CY', ${q(vNew)})
       ON CONFLICT (jurisdiction) DO UPDATE SET current_version_id = EXCLUDED.current_version_id
       RETURNING 'pointer now ' || current_version_id`,
      `UPDATE public.staffed_schedule_version SET superseded_at = now() WHERE id = ${q(VER_A)} AND superseded_at IS NULL
       RETURNING 'superseded ' || id`,
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('GR', ${q(vNew)})
       ON CONFLICT (jurisdiction) DO UPDATE SET current_version_id = EXCLUDED.current_version_id
       RETURNING 'pointer created ' || jurisdiction`,
    );
    assertPermitted('publish transaction', r);
    assertRead('publish transaction', r, POINTER_PRESENT);
    assertRead('publish transaction', r, `published ${vNew} at now()=true superseded null=true`);
    assertRead('publish transaction', r, 'INSERT 0 2');
    assertRead('publish transaction', r, `pointer now ${vNew}`);
    assertRead('publish transaction', r, `superseded ${VER_A}`);
    assertRead('publish transaction', r, 'pointer created GR');
  });
});

describe('0023 — app_rw: the grants (A.2 U-4, C5 (a), E.2 U-3); no UPDATE on intervals, no DELETE or TRUNCATE anywhere', () => {
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
           FROM unnest(ARRAY['staffed_schedule_version', 'staffed_interval', 'staffed_schedule_current']) t`,
      ),
      'staffed_interval id=true/false,version_id=true/false,span=true/false ' +
        'table:SELECT=true,INSERT=true,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false,MAINTAIN=false ; ' +
        'staffed_schedule_current jurisdiction=true/false,current_version_id=true/true ' +
        'table:SELECT=true,INSERT=true,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false,MAINTAIN=false ; ' +
        'staffed_schedule_version id=true/false,jurisdiction=true/false,effective_from=true/false,published_at=false/false,' +
        'published_by=true/false,approval_id=true/false,pattern=true/false,note=true/false,superseded_at=false/true ' +
        'table:SELECT=true,INSERT=false,UPDATE=false,DELETE=false,TRUNCATE=false,REFERENCES=false,TRIGGER=false,MAINTAIN=false',
    );
  });

  for (const [label, column, value] of [
    ['published_at (back-dated)', 'published_at', "now() - interval '1 day'"],
    ['published_at (the DEFAULT keyword)', 'published_at', 'DEFAULT'],
    ['superseded_at (a value)', 'superseded_at', 'now()'],
    ['superseded_at (NULL)', 'superseded_at', 'NULL'],
  ] as const) {
    test(`app_rw INSERT of a version naming ${label} is REFUSED by the column grant (42501)`, async () => {
      assertRefusedBy(
        `app_rw insert ${label}`,
        await asLogin(
          LOGINS.app_rw,
          `INSERT INTO public.staffed_schedule_version (id, jurisdiction, effective_from, published_by, approval_id, pattern, note, ${column})
           VALUES (${q(ulid('COLV'))}, 'CY', '2026-10-01', ${q(ACC)}, ${q(APR_B)}, '{}', 'n', ${value})`,
        ),
        denied('staffed_schedule_version'),
      );
    });
  }

  for (const [column, set] of [
    ['id', `id = ${q(ulid('NEWID'))}`],
    ['jurisdiction', `jurisdiction = 'GR'`],
    ['effective_from', `effective_from = '2026-01-01'`],
    ['published_at', `published_at = now() - interval '1 day'`],
    ['published_by', `published_by = ${q(ACC)}`],
    ['approval_id', `approval_id = ${q(APR_B)}`],
    ['pattern', `pattern = '{"schema": 2}'`],
    ['note', `note = 'rewritten'`],
  ] as const) {
    test(`app_rw UPDATE of staffed_schedule_version.${column} is REFUSED (42501): superseded_at is its only writable column`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readVersion(VER_A),
        `UPDATE public.staffed_schedule_version SET ${set} WHERE id = ${q(VER_A)}`,
      );
      assertRead(`app_rw update ${column}`, r, VERSION_PRESENT(VER_A));
      assertRefusedBy(`app_rw update ${column}`, r, denied('staffed_schedule_version'));
    });
  }

  for (const [column, set] of [
    ['span', `span = ${span('2026-10-02T11:00:00Z', '2026-10-02T12:00:00Z')}`],
    ['version_id', `version_id = ${q(VER_B)}`],
    ['id', `id = ${q(ulid('NEWINT'))}`],
  ] as const) {
    test(`app_rw UPDATE of staffed_interval.${column} is REFUSED (42501)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readInterval(INT_A1),
        `UPDATE public.staffed_interval SET ${set} WHERE id = ${q(INT_A1)}`,
      );
      assertRead(`app_rw update interval ${column}`, r, INTERVAL_PRESENT(INT_A1));
      assertRefusedBy(`app_rw update interval ${column}`, r, denied('staffed_interval'));
    });
  }

  test('app_rw DELETE of a version is REFUSED (42501)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readVersion(VER_B),
      `DELETE FROM public.staffed_schedule_version WHERE id = ${q(VER_B)}`,
    );
    assertRead('app_rw DELETE version', r, VERSION_PRESENT(VER_B));
    assertRefusedBy('app_rw DELETE version', r, denied('staffed_schedule_version'));
  });

  test('app_rw DELETE of an interval is REFUSED (42501)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readInterval(INT_A1),
      `DELETE FROM public.staffed_interval WHERE id = ${q(INT_A1)}`,
    );
    assertRead('app_rw DELETE interval', r, INTERVAL_PRESENT(INT_A1));
    assertRefusedBy('app_rw DELETE interval', r, denied('staffed_interval'));
  });

  for (const table of ['staffed_schedule_version', 'staffed_interval'] as const) {
    test(`app_rw TRUNCATE of ${table} is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `app_rw TRUNCATE ${table}`,
        await asLogin(LOGINS.app_rw, `TRUNCATE public.${table}`),
        denied(table),
      );
    });
  }

  for (const lock of ['FOR UPDATE', 'FOR SHARE', 'FOR KEY SHARE'] as const) {
    test(`app_rw SELECT … ${lock} on an interval is REFUSED (42501): with no UPDATE privilege, app_rw cannot row-lock intervals`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readInterval(INT_A1),
        `SELECT id FROM public.staffed_interval WHERE id = ${q(INT_A1)} ${lock}`,
      );
      assertRead(`app_rw interval ${lock}`, r, INTERVAL_PRESENT(INT_A1));
      assertRefusedBy(`app_rw interval ${lock}`, r, denied('staffed_interval'));
    });
  }

  for (const table of TABLES) {
    test(`app_rw LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE (and SHARE MODE) is REFUSED (42501)`, async () => {
      for (const mode of ['ACCESS EXCLUSIVE', 'SHARE'] as const) {
        assertRefusedBy(
          `app_rw LOCK ${table} ${mode}`,
          await asLogin(LOGINS.app_rw, `LOCK TABLE public.${table} IN ${mode} MODE`),
          denied(table),
        );
      }
    });
  }

  test("CONTROL — app_rw publishes a version (Q1, the seven columns): published_at is the transaction's now(), superseded_at is NULL; and reads Q5/Q6", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `${version(ulid('Q1'), APR_B, { effective_from: `'2028-04-01'` })}
       RETURNING 'q1 published_at=now():' || (published_at = now()) || ' superseded_at null:' || (superseded_at IS NULL)`,
      `SELECT 'q5 ' || string_agg(lower(span) || '/' || upper(span), ',' ORDER BY lower(span))
         FROM public.staffed_interval
        WHERE version_id = ${q(VER_A)} AND span && tstzrange('2026-10-02T00:00:00Z', '2026-10-04T00:00:00Z', '[)')`,
      `SELECT 'q6 ' || effective_from || ' ' || (pattern ->> 'schema') FROM public.staffed_schedule_version WHERE id = ${q(VER_A)}`,
    );
    assertPermitted('app_rw Q1, Q5, Q6', r);
    assertRead('app_rw Q1, Q5, Q6', r, 'q1 published_at=now():true superseded_at null:true');
    assertRead(
      'app_rw Q1, Q5, Q6',
      r,
      'q5 2026-10-02 11:00:00+00/2026-10-02 23:00:00+00,2026-10-03 11:00:00+00/2026-10-03 23:00:00+00',
    );
    assertRead('app_rw Q1, Q5, Q6', r, 'q6 2026-10-01 1');
  });

  test("CONTROL — app_rw runs SD 3200-3207's containment shape (range_agg over && then @>) against the fixture version", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'inside=' || (range_agg(span) @> tstzrange('2026-10-02T20:30:00Z', '2026-10-02T22:30:00Z', '[)')) ||
              ' gap=' || (range_agg(span) @> tstzrange('2026-10-02T22:30:00Z', '2026-10-03T00:30:00Z', '[)'))
         FROM public.staffed_interval
        WHERE version_id = ${q(VER_A)} AND span && tstzrange('2026-10-02T20:30:00Z', '2026-10-03T00:30:00Z', '[)')`,
    );
    assertPermitted('containment shape', r);
    assertRead('containment shape', r, 'inside=true gap=false');
  });
});

describe('0023 — NOT HELD until T-082: the once-only rule on superseded_at (C5 (a))', () => {
  test('NOT HELD — app_rw sets superseded_at, sets it again, sets it to a past date and sets it back to NULL: all accepted; only the column grant holds here', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readVersion(VER_A),
      `UPDATE public.staffed_schedule_version SET superseded_at = now() WHERE id = ${q(VER_A)} RETURNING 'set once'`,
      `UPDATE public.staffed_schedule_version SET superseded_at = now() + interval '1 day' WHERE id = ${q(VER_A)} RETURNING 'set twice'`,
      `UPDATE public.staffed_schedule_version SET superseded_at = '2000-01-01T00:00:00Z' WHERE id = ${q(VER_A)} RETURNING 'set to 2000'`,
      `UPDATE public.staffed_schedule_version SET superseded_at = NULL WHERE id = ${q(VER_A)} RETURNING 'set back to NULL'`,
    );
    assertPermitted('superseded_at rewritten', r);
    assertRead('superseded_at rewritten', r, VERSION_PRESENT(VER_A));
    for (const line of ['set once', 'set twice', 'set to 2000', 'set back to NULL']) {
      assertRead('superseded_at rewritten', r, line);
    }
  });
});

describe('0023 — no other role reads or writes them (A.2 U-4, E.2 U-5), over real single-membership logins', () => {
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
        ['staffed_schedule_version', version(ulid('OTHER'), APR_B)],
        [
          'staffed_interval',
          interval(ulid('OTHER'), VER_B, span('2029-01-01T00:00:00Z', '2029-01-02T00:00:00Z')),
        ],
        [
          'staffed_schedule_current',
          `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('GR', ${q(VER_B)})`,
        ],
      ] as const) {
        assertRefusedBy(`${role} INSERT ${table}`, await asLogin(LOGINS[role], sql), denied(table));
      }
    });
  }

  for (const [table, sql] of [
    [
      'staffed_schedule_version',
      `UPDATE public.staffed_schedule_version SET superseded_at = now() WHERE id = ${q(VER_A)}`,
    ],
    ['staffed_interval', `DELETE FROM public.staffed_interval WHERE id = ${q(INT_A1)}`],
    [
      'staffed_schedule_current',
      `UPDATE public.staffed_schedule_current SET current_version_id = ${q(VER_B)} WHERE jurisdiction = 'CY'`,
    ],
  ] as const) {
    test(`app_admin_rw writing ${table} (UPDATE or DELETE) is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `app_admin_rw write ${table}`,
        await asLogin(LOGINS.app_admin_rw, sql),
        denied(table),
      );
    });
  }

  test('no role but app_ddl (the owner) and app_rw holds any privilege on any of the three tables or their columns, PUBLIC included', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(t || ':' || r || '=' ||
                  (has_table_privilege(r, ('public.' || t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR
                   has_any_column_privilege(r, ('public.' || t)::regclass, 'SELECT,INSERT,UPDATE,REFERENCES')), ',' ORDER BY t, r)
           FROM unnest(ARRAY['staffed_schedule_version', 'staffed_interval', 'staffed_schedule_current']) t
          CROSS JOIN unnest(ARRAY['app_admin_rw', 'app_safety_rw', 'answering_service', 'app_rw', 'public']) r`,
      ),
      [
        'staffed_interval:answering_service=false,staffed_interval:app_admin_rw=false,staffed_interval:app_rw=true,',
        'staffed_interval:app_safety_rw=false,staffed_interval:public=false,',
        'staffed_schedule_current:answering_service=false,staffed_schedule_current:app_admin_rw=false,',
        'staffed_schedule_current:app_rw=true,staffed_schedule_current:app_safety_rw=false,staffed_schedule_current:public=false,',
        'staffed_schedule_version:answering_service=false,staffed_schedule_version:app_admin_rw=false,',
        'staffed_schedule_version:app_rw=true,staffed_schedule_version:app_safety_rw=false,staffed_schedule_version:public=false',
      ].join(''),
    );
  });
});

describe('0023 — NOT HELD (disclosed)', () => {
  test('NOT HELD — app_rw adds an interval to the CURRENT version after publish, and to a superseded one: accepted; nothing refuses an INSERT into an existing version', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_POINTER,
      `${interval(ulid('LATE1'), VER_A, span('2026-10-04T11:00:00Z', '2026-10-04T23:00:00Z'))} RETURNING 'appended to the current version'`,
      `UPDATE public.staffed_schedule_version SET superseded_at = now() WHERE id = ${q(VER_A)}`,
      `${interval(ulid('LATE2'), VER_A, span('2026-10-05T11:00:00Z', '2026-10-05T23:00:00Z'))} RETURNING 'appended to a superseded version'`,
    );
    assertPermitted('interval appended late', r);
    assertRead('interval appended late', r, POINTER_PRESENT);
    assertRead('interval appended late', r, 'appended to the current version');
    assertRead('interval appended late', r, 'appended to a superseded version');
  });

  test('NOT HELD — app_rw points GR at a CY version, and CY at a superseded version and at a version with no interval: all accepted', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `INSERT INTO public.staffed_schedule_current (jurisdiction, current_version_id) VALUES ('GR', ${q(VER_A)}) RETURNING 'GR -> a CY version'`,
      `UPDATE public.staffed_schedule_version SET superseded_at = now() WHERE id = ${q(VER_A)}`,
      `UPDATE public.staffed_schedule_current SET current_version_id = ${q(VER_A)} WHERE jurisdiction = 'CY' RETURNING 'CY -> a superseded version'`,
      `${version(ulid('EMPTYV'), APR_B)}`,
      `UPDATE public.staffed_schedule_current SET current_version_id = ${q(ulid('EMPTYV'))} WHERE jurisdiction = 'CY'
       RETURNING 'CY -> a version with ' || (SELECT count(*) FROM public.staffed_interval WHERE version_id = current_version_id) || ' intervals'`,
    );
    assertPermitted('pointer not checked', r);
    assertRead('pointer not checked', r, 'GR -> a CY version');
    assertRead('pointer not checked', r, 'CY -> a superseded version');
    assertRead('pointer not checked', r, 'CY -> a version with 0 intervals');
  });

  test("NOT HELD — app_rw publishes versions whose pattern is a JSON null, a number and an empty object, whose note is '', whose jurisdiction is 'zz', reusing one approval, by a pending account: all accepted", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'publisher status ' || status FROM public.account WHERE id = ${q(ACC)}`,
      `${version(ulid('JNULL'), APR_A, { pattern: `'null'::jsonb` })} RETURNING 'pattern ' || jsonb_typeof(pattern)`,
      `${version(ulid('JNUM'), APR_A, { pattern: `'42'::jsonb` })} RETURNING 'pattern ' || jsonb_typeof(pattern)`,
      `${version(ulid('JOBJ'), APR_A, { pattern: `'{}'::jsonb`, note: `''`, jurisdiction: `'zz'` })}
       RETURNING 'empty object, note length ' || length(note) || ', jurisdiction ' || jurisdiction`,
      `SELECT 'versions on approval A: ' || count(*) FROM public.staffed_schedule_version WHERE approval_id = ${q(APR_A)}`,
    );
    assertPermitted('content not checked', r);
    assertRead('content not checked', r, 'publisher status pending');
    assertRead('content not checked', r, 'pattern null');
    assertRead('content not checked', r, 'pattern number');
    assertRead('content not checked', r, 'empty object, note length 0, jurisdiction zz');
    assertRead('content not checked', r, 'versions on approval A: 4');
  });

  test('NOT HELD — app_rw writes an interval id that is not a ULID (char(26) pads it with spaces): accepted', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `${interval('not-a-ulid', VER_B, span('2029-02-01T00:00:00Z', '2029-02-02T00:00:00Z'))} RETURNING 'id length ' || octet_length(id)`,
    );
    assertPermitted('id shape not checked', r);
    assertRead('id shape not checked', r, 'id length 26');
  });

  test('NOT HELD — app_rw takes FOR UPDATE row locks on a version and on the pointer (its column UPDATE grants allow it), which would block the publisher', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'locked version ' || id FROM public.staffed_schedule_version WHERE id = ${q(VER_A)} FOR UPDATE`,
      `SELECT 'locked pointer ' || jurisdiction FROM public.staffed_schedule_current WHERE jurisdiction = 'CY' FOR UPDATE`,
    );
    assertPermitted('row locks', r);
    assertRead('row locks', r, `locked version ${VER_A}`);
    assertRead('row locks', r, 'locked pointer CY');
  });

  test('NOT HELD — the owner app_ddl and the superuser each back-date published_at, rewrite a span, delete an interval and delete the pointer: the grants bind app_rw only', async () => {
    for (const [who, run] of [
      ['owner', (...c: string[]) => asLogin(LOGINS.app_ddl, ...c)],
      ['superuser', (...c: string[]) => asSuperuser(...c)],
    ] as const) {
      const r = await run(
        readInterval(INT_A2),
        `UPDATE public.staffed_schedule_version SET published_at = now() - interval '1 year' WHERE id = ${q(VER_A)}
         RETURNING '${who} back-dated:' || (published_at < now() - interval '364 days')`,
        `UPDATE public.staffed_interval SET span = ${span('2026-10-03T00:00:00Z', '2026-10-03T23:00:00Z')} WHERE id = ${q(INT_A2)}
         RETURNING '${who} rewrote a span'`,
        `DELETE FROM public.staffed_interval WHERE id = ${q(INT_A2)} RETURNING '${who} deleted an interval'`,
        `DELETE FROM public.staffed_schedule_current WHERE jurisdiction = 'CY' RETURNING '${who} deleted the pointer'`,
      );
      assertPermitted(`${who} rewrites`, r);
      assertRead(`${who} rewrites`, r, INTERVAL_PRESENT(INT_A2));
      for (const line of [
        'back-dated:true',
        'rewrote a span',
        'deleted an interval',
        'deleted the pointer',
      ]) {
        assertRead(`${who} rewrites`, r, `${who} ${line}`);
      }
    }
  });

  test('the fixture rows survive every refusal and rolled-back write above', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(id || ':' || effective_from || ':' || (superseded_at IS NULL), ',' ORDER BY id) FROM public.staffed_schedule_version) || ' | ' ||
                (SELECT string_agg(id || ':' || version_id || ':' || lower(span) || '/' || upper(span), ',' ORDER BY id) FROM public.staffed_interval) || ' | ' ||
                (SELECT string_agg(jurisdiction || '->' || current_version_id, ',') FROM public.staffed_schedule_current)`,
      ),
      `${VER_A}:2026-10-01:true,${VER_B}:2027-04-01:true | ` +
        `${INT_A1}:${VER_A}:2026-10-02 11:00:00+00/2026-10-02 23:00:00+00,${INT_A2}:${VER_A}:2026-10-03 11:00:00+00/2026-10-03 23:00:00+00 | ` +
        `CY->${VER_A}`,
    );
  });
});

describe('0023 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON staffed_interval TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.staffed_interval TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.staffed_interval'),
      `the guard's DETAIL does not name staffed_interval.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.staffed_interval', 'SELECT')::text`,
      ),
      'false',
    );
  });

  test('GRANT INSERT (note) ON staffed_schedule_version TO answering_service (a column grant) is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser(
      'GRANT INSERT (note) ON public.staffed_schedule_version TO answering_service',
    );
    assertRefused('column grant to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.equal(
      await db.value(
        `SELECT has_any_column_privilege('answering_service', 'public.staffed_schedule_version', 'INSERT')::text`,
      ),
      'false',
    );
  });

  test("of 0023's statement kinds, CREATE TABLE and GRANT fire the guard; CREATE INDEX and COMMENT do not (a detective-only grant held open, rolled back)", async () => {
    const quiet = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'CREATE INDEX t206_guard_probe_idx ON public.staffed_interval (version_id)',
      `COMMENT ON TABLE public.staffed_interval IS 'probe'`,
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
      'CREATE TABLE public.t206_guard_probe (span tstzrange)',
    );
    assertRefused('CREATE TABLE with the guard armed', create, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    const grant = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'GRANT SELECT ON public.staffed_interval TO app_rw',
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
