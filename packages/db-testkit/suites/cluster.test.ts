/**
 * T-161 — `public.cluster` (migration 0027): SD §DB-10 lines 2961–2967 as finalised in
 * tasks/state/EP-9/T-160.md § Migration request › Requested DDL [F], under OE-30-34-rulings.md E.4
 * (T-160 U-1 identity key, U-4 grants, U-10 no DELETE, U-11 index name, U-12 no UNIQUE) and Part F
 * (OE-50: C14 (a) name_i18n, C15 (b) metro, U-9 boundary bounds, G-5 no seed), OE-52 (C12 is
 * T-211's) and OE-53 (the two ops-entered columns). These are T-160's cases V1–V8.
 *
 * T-211 (migration 0028) adds a trigger, a CHECK and two comments to this table. The pins below
 * that 0028 changes (constraint set, one-line trigger pin, comments) were changed in T-211's change
 * set, and the cases that wrote state 'open' or a non-empty snapshot now do so as 0028 admits. The
 * transition matrix itself is suites/cluster-state.test.ts.
 *
 * The table's catalogue is pinned: its columns (type, nullability, default, identity), owner, ACL,
 * its whole constraint set by name and deparse (NOT NULL constraints included, contype 'n' on
 * PostgreSQL 18), its indexes, its identity sequence's owner and ACL, its comments, and in ONE
 * assertion the counts of its non-internal triggers, rewrite rules and policies with both
 * row-level security flags. So a constraint, grant, index, trigger, rule or policy added to or
 * removed from the table turns a case red. What is not in those catalogues is not pinned (an event
 * trigger, for example), and a change that keeps every reading here cannot turn a case red.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field, and exactly one ERROR line,
 * so a crash, a syntax error or a refusal for another reason cannot read as this one. Each rule has
 * a CONTROL beside it that differs from a refused case only in the value under test.
 *
 * Every refusal and control in V1–V8 runs over the REAL LOGIN of a member of exactly one role
 * (T-020 Evidence §4): app_rw for every write, as the brief requires, so what is measured is what
 * core and worker meet. The superuser is used only for the ?& plant and the superuser rows of V5,
 * and says so. OVERRIDING SYSTEM VALUE needs no privilege beyond INSERT, and V8 pins app_rw using
 * it (T-161 rework 1, QA Q-2). Every write runs inside a transaction
 * that is never committed (`inTransaction`), so the table is empty throughout, and the last test of
 * the file re-reads it.
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

const SUITE = 'cluster';
const TABLE = 'public.cluster';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't161_app_rw_probe',
  app_admin_rw: 't161_app_admin_rw_probe',
  app_safety_rw: 't161_app_safety_rw_probe',
  answering_service: 't161_answering_service_probe',
} as const;

/**
 * A closed WGS 84 polygon (a small square near Limassol's longitude and latitude; the place is not
 * stored anywhere, only the coordinates). Written without trailing zeros so that ST_AsText reads it
 * back byte-equal (measured).
 */
const POLY = 'POLYGON((33 34.6,33.1 34.6,33.1 34.7,33 34.7,33 34.6))';
/** A point POLY covers, as (lon, lat), for Q1. */
const INSIDE = { lon: 33.05, lat: 34.65 };
/** The display names, Greek and Cyrillic included (C14 (a)). */
const NAMES = '{"el": "Συστάδα δοκιμής", "en": "Test cluster", "ru": "Тестовый кластер"}';

/** The texts 0027 installs, verbatim: a change to a comment must change this suite too. */
const TABLE_COMMENT =
  'Discovery clusters (SD DB-10): operator-drawn WGS 84 polygons with an open, waitlist or closed ' +
  'state. Retired by state closed; no application role holds DELETE. Which state changes are legal is held by ' +
  'trg_cluster_state_transition and cluster_open_requires_passing_snapshot (C12).';
/** 0028's comment on density_snapshot (T-211). */
const SNAPSHOT_COMMENT =
  "Written by the density job: computedAt (equal to the writing transaction's now()) and thresholds bookableSitters, " +
  'fridayPeakSitters, infantQualifiedSitters, simulatedSearchMedian, russianValidatedSitters and visitorReadySitters, ' +
  'each with measured, required and a boolean pass. The empty object until first computed.';
const NAME_I18N_COMMENT =
  'The display name in en, el and ru, each a string that is not empty after trimming spaces (U+0020). ' +
  'name is the operator label and is never shown to users.';
const SHARE_COMMENT =
  'Ops-entered estimate of the Russian-speaking share, whole percent 0 to 100. NULL means unknown and is never a pass.';
const INVENTORY_COMMENT =
  'Ops-entered: the cluster contains hotel or holiday-let inventory. NULL means unknown and is never a pass.';

/** Each CHECK as PostgreSQL deparses it (measured, pg_get_constraintdef), not as 0027 writes it. */
const DEPARSE = {
  cluster_state_check:
    "CHECK ((state = ANY (ARRAY['waitlist'::text, 'open'::text, 'closed'::text])))",
  cluster_name_i18n_three_locales:
    "CHECK (((jsonb_typeof(name_i18n) = 'object'::text) AND (name_i18n ?& ARRAY['en'::text, 'el'::text, 'ru'::text]) AND " +
    "(jsonb_typeof((name_i18n -> 'en'::text)) = 'string'::text) AND (btrim((name_i18n ->> 'en'::text)) <> ''::text) AND " +
    "(jsonb_typeof((name_i18n -> 'el'::text)) = 'string'::text) AND (btrim((name_i18n ->> 'el'::text)) <> ''::text) AND " +
    "(jsonb_typeof((name_i18n -> 'ru'::text)) = 'string'::text) AND (btrim((name_i18n ->> 'ru'::text)) <> ''::text)))",
  cluster_russian_speaking_share_pct_range:
    'CHECK (((russian_speaking_share_pct >= 0) AND (russian_speaking_share_pct <= 100)))',
  cluster_open_requires_passing_snapshot:
    'CHECK (((state <> \'open\'::text) OR (density_snapshot @> \'{"thresholds": {"bookableSitters": {"pass": true}, ' +
    '"fridayPeakSitters": {"pass": true}, "visitorReadySitters": {"pass": true}, "simulatedSearchMedian": {"pass": true}, ' +
    '"infantQualifiedSitters": {"pass": true}, "russianValidatedSitters": {"pass": true}}}\'::jsonb)))',
} as const;

/**
 * A density snapshot 0028 admits for waitlist → open in the writing transaction: computedAt is that
 * transaction's now(), and all six thresholds pass (T-211 § Published contract).
 */
const FRESH_ALL_PASS =
  "jsonb_build_object('computedAt', to_jsonb(now()), 'thresholds', '{" +
  '"bookableSitters": {"pass": true}, "fridayPeakSitters": {"pass": true}, "infantQualifiedSitters": {"pass": true}, ' +
  '"simulatedSearchMedian": {"pass": true}, "russianValidatedSitters": {"pass": true}, "visitorReadySitters": {"pass": true}' +
  "}'::jsonb)";

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: Object.entries(LOGINS).map(
      ([role, login]) => `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
    ),
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/**
 * Every invocation runs inside one transaction that is never committed: BEGIN is prepended, and
 * psql's session end rolls it back.
 */
const inTransaction = (commands: string[]): string[] => ['BEGIN', ...commands];

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

/** Statements as the app_rw probe login. */
const asAppRw = (...commands: string[]): Promise<PsqlResult> => asLogin(LOGINS.app_rw, ...commands);

/** Refused with exactly this ERROR line, psql named what refused it, and there was one ERROR. */
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

/** Accepted, and the INSERT reported exactly one row. */
function assertInsertedOne(what: string, r: PsqlResult): void {
  assertPermitted(what, r);
  assert.ok(r.output.includes('INSERT 0 1'), `${what}: expected INSERT 0 1.\n${r.output}`);
}

/** Column → SQL literal for a well-formed row (no id: the identity supplies it); each case overrides one column. */
const GOOD: Readonly<Record<string, string>> = {
  metro: `'CY'`,
  name: `'t161 control'`,
  boundary: `'SRID=4326;${POLY}'`,
  state: `'waitlist'`,
  name_i18n: `'${NAMES}'`,
};

/** An INSERT of GOOD with `overrides` applied; a value of `undefined` omits the column. */
function insertRow(overrides: Readonly<Record<string, string | undefined>> = {}): string {
  const row: Record<string, string | undefined> = { ...GOOD, ...overrides };
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const CHECK_23514 = (name: string): string =>
  `ERROR:  23514: new row for relation "cluster" violates check constraint "${name}"`;
const NOTNULL_23502 = (column: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "cluster" violates not-null constraint`;
const DENIED = 'ERROR:  42501: permission denied for table cluster';
/** Reads the control row inserted earlier in the same transaction, so a 0-row statement is visible. */
const READ_CONTROL = `SELECT 'before=' || count(*) FROM ${TABLE} WHERE name = 't161 control'`;

describe('0027 — the table, its owner, columns, constraints, indexes, sequence, ACL and comments', () => {
  test("SD 2961–2965's six columns first in SD's order, then name_i18n (C14 (a)) and the two OE-53 columns; id integer GENERATED ALWAYS AS IDENTITY (E.4 U-1); boundary geography(Polygon,4326); density_snapshot DEFAULT '{}'; name_i18n NOT NULL with NO default; the OE-53 columns nullable; owner app_ddl; table ACL app_rw SELECT + INSERT only; column ACL app_rw UPDATE on each of the eight columns but id (rework 1, QA Q-1)", async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' ||
                                   CASE attidentity WHEN '' THEN '-' ELSE attidentity::text END, ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                coalesce((SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                           WHERE attrelid = c.oid AND attacl IS NOT NULL), 'no column ACL')
           FROM pg_class c WHERE c.oid = '${TABLE}'::regclass`,
      ),
      'id:integer:nn:-:a,metro:text:nn:-:-,name:text:nn:-:-,boundary:geography(Polygon,4326):nn:-:-,' +
        "state:text:nn:-:-,density_snapshot:jsonb:nn:'{}'::jsonb:-,name_i18n:jsonb:nn:-:-," +
        'russian_speaking_share_pct:integer:null:-:-,has_hotel_or_holiday_let_inventory:boolean:null:-:-' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl}|' +
        'metro={app_rw=w/app_ddl},name={app_rw=w/app_ddl},boundary={app_rw=w/app_ddl},state={app_rw=w/app_ddl},' +
        'density_snapshot={app_rw=w/app_ddl},name_i18n={app_rw=w/app_ddl},russian_speaking_share_pct={app_rw=w/app_ddl},' +
        'has_hotel_or_holiday_let_inventory={app_rw=w/app_ddl}',
    );
  });

  test('the constraint set is exactly these names and deparses: PK, cluster_state_check (SD 2964, named explicitly), cluster_name_i18n_three_locales (C14 (a)), cluster_russian_speaking_share_pct_range (OE-53), and the seven NOT NULLs; no FOREIGN KEY, no UNIQUE (E.4 U-12), no EXCLUDE (U-9 (2a)), no CHECK on metro (C15 (b)) or boundary validity (U-9 (1b)); since 0028 (T-211), cluster_open_requires_passing_snapshot; none deferrable', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || ' ' || contype::text || ' ' || condeferrable::text || ' ' ||
                           pg_get_constraintdef(oid), E'\\n' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass`,
      ),
      [
        'cluster_boundary_not_null n false NOT NULL boundary',
        'cluster_density_snapshot_not_null n false NOT NULL density_snapshot',
        'cluster_id_not_null n false NOT NULL id',
        'cluster_metro_not_null n false NOT NULL metro',
        'cluster_name_i18n_not_null n false NOT NULL name_i18n',
        `cluster_name_i18n_three_locales c false ${DEPARSE.cluster_name_i18n_three_locales}`,
        'cluster_name_not_null n false NOT NULL name',
        `cluster_open_requires_passing_snapshot c false ${DEPARSE.cluster_open_requires_passing_snapshot}`,
        'cluster_pkey p false PRIMARY KEY (id)',
        `cluster_russian_speaking_share_pct_range c false ${DEPARSE.cluster_russian_speaking_share_pct_range}`,
        `cluster_state_check c false ${DEPARSE.cluster_state_check}`,
        'cluster_state_not_null n false NOT NULL state',
      ].join('\n'),
    );
  });

  test('the indexes are exactly the PK and idx_cluster_boundary, GiST over boundary, not partial (E.4 U-11; U-7 (a): closed rows stay indexed); single-column, so OD-110 does not apply', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid = '${TABLE}'::regclass`,
      ),
      'CREATE UNIQUE INDEX cluster_pkey ON public.cluster USING btree (id) ; ' +
        'CREATE INDEX idx_cluster_boundary ON public.cluster USING gist (boundary)',
    );
  });

  test('ONE-LINE PIN: 1 non-internal trigger (trg_cluster_state_transition, 0028, T-211), 0 rewrite rules, rls=false, force=false, 0 policies (no RLS: cluster is not on SD 1309/3906, app_admin_rw holds nothing; OD-223, E.4 U-4)', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
           FROM pg_class c WHERE c.oid = '${TABLE}'::regclass`,
      ),
      '1 triggers, 0 rules, rls=false, force=false, 0 policies',
    );
  });

  test('relrowsecurity and relforcerowsecurity are both false, read from pg_class directly (QR-A1: db:introspect cannot see them)', async () => {
    assert.equal(
      await db.value(
        `SELECT relrowsecurity::text || ' ' || relforcerowsecurity::text FROM pg_class WHERE oid = '${TABLE}'::regclass`,
      ),
      'false false',
    );
  });

  test('the identity sequence cluster_id_seq is owned by app_ddl, carries no grant to any role (E.4 U-1), and is the only sequence the table owns', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(s.relname || ' ' || pg_get_userbyid(s.relowner) || ' ' || coalesce(s.relacl::text, 'NULL'), ' ; ')
           FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
          WHERE d.refobjid = '${TABLE}'::regclass AND d.classid = 'pg_class'::regclass`,
      ),
      'cluster_id_seq app_ddl NULL',
    );
  });

  test("app_rw's effective table privileges are exactly SELECT, INSERT (no table-level UPDATE; no DELETE, E.4 U-10 (1); no TRUNCATE, REFERENCES, TRIGGER, MAINTAIN); its UPDATE is on exactly the eight columns but id (rework 1, QA Q-1); and no role but app_ddl (owner) and app_rw holds any table, column or sequence privilege, PUBLIC included (superusers, pg_* roles and this suite's t161_* logins are not read)", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(p, ',' ORDER BY ord) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
                WITH ORDINALITY AS u(p, ord) WHERE has_table_privilege('app_rw', '${TABLE}', p)`,
      ),
      'SELECT,INSERT',
    );
    assert.equal(
      await db.value(
        `SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
          WHERE attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege('app_rw', '${TABLE}', attname, 'UPDATE')`,
      ),
      'metro,name,boundary,state,density_snapshot,name_i18n,russian_speaking_share_pct,has_hotel_or_holiday_let_inventory',
    );
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(DISTINCT r.rolname, ',' ORDER BY r.rolname), '(none)')
           FROM (SELECT rolname FROM pg_roles UNION ALL SELECT 'public') r(rolname)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
          WHERE r.rolname NOT IN ('app_ddl') AND r.rolname NOT LIKE 'pg\\_%' AND r.rolname NOT LIKE 't161\\_%'
            AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = r.rolname) IS TRUE
            AND (has_table_privilege(r.rolname, '${TABLE}', p)
                 OR CASE WHEN p IN ('SELECT','INSERT','UPDATE','REFERENCES')
                         THEN has_any_column_privilege(r.rolname, '${TABLE}', p) ELSE false END
                 OR (p IN ('SELECT','UPDATE') AND has_sequence_privilege(r.rolname, 'public.cluster_id_seq', p))
                 OR (p = 'SELECT' AND has_sequence_privilege(r.rolname, 'public.cluster_id_seq', 'USAGE')))`,
      ),
      'app_rw',
    );
  });

  test('COMMENT ON TABLE and the four column comments (density_snapshot since 0028) are exactly these texts, and no other column carries one', async () => {
    assert.equal(
      await db.value(`SELECT obj_description('${TABLE}'::regclass, 'pg_class')`),
      TABLE_COMMENT,
    );
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || col_description(attrelid, attnum), E'\\n' ORDER BY attnum)
           FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attnum > 0
            AND col_description(attrelid, attnum) IS NOT NULL`,
      ),
      `density_snapshot=${SNAPSHOT_COMMENT}\nname_i18n=${NAME_I18N_COMMENT}\nrussian_speaking_share_pct=${SHARE_COMMENT}\n` +
        `has_hotel_or_holiday_let_inventory=${INVENTORY_COMMENT}`,
    );
  });

  test('no seed (G-5): the table holds no row after up', async () => {
    assert.equal(await db.value(`SELECT count(*)::text FROM ${TABLE}`), '0');
  });
});

describe('the probe logins', () => {
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
});

describe('V1 — a cluster state is exactly one of waitlist, open, closed (SD 2964), as app_rw', () => {
  for (const value of ['opened', 'Open', '']) {
    test(`state '${value}' is REFUSED by cluster_state_check (23514)`, async () => {
      assertRefusedBy(
        `state '${value}'`,
        await asAppRw(insertRow({ state: `'${value}'` })),
        CHECK_23514('cluster_state_check'),
        'CONSTRAINT NAME:  cluster_state_check',
      );
    });
  }

  test("CONTROL — 'waitlist' and 'closed' are each accepted on INSERT, and 'open' by an UPDATE writing a fresh all-pass snapshot (an INSERT as open is 0028's refusal, T-211)", async () => {
    for (const value of ['waitlist', 'closed']) {
      assertInsertedOne(`state '${value}'`, await asAppRw(insertRow({ state: `'${value}'` })));
    }
    const r = await asAppRw(
      insertRow(),
      `UPDATE ${TABLE} SET state = 'open', density_snapshot = ${FRESH_ALL_PASS} WHERE name = 't161 control'`,
      `SELECT 'now=' || state FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertPermitted("state 'open'", r);
    assert.ok(r.output.includes('now=open'), `open not reached:\n${r.output}`);
  });

  test("an UPDATE to state 'Open' is REFUSED by cluster_state_check (23514), the row read first", async () => {
    const r = await asAppRw(
      insertRow(),
      READ_CONTROL,
      `UPDATE ${TABLE} SET state = 'Open' WHERE name = 't161 control'`,
    );
    assert.ok(r.output.includes('before=1'), `precondition not read:\n${r.output}`);
    assertRefusedBy(
      "UPDATE state 'Open'",
      r,
      CHECK_23514('cluster_state_check'),
      'CONSTRAINT NAME:  cluster_state_check',
    );
  });
});

describe('V2 — a cluster boundary is one WGS 84 polygon (SD 2963), as app_rw', () => {
  const REFUSED: ReadonlyArray<readonly [what: string, value: string, error: string]> = [
    [
      'a POINT',
      'SRID=4326;POINT(33.05 34.65)',
      'ERROR:  22023: Geometry type (Point) does not match column type (Polygon)',
    ],
    [
      'a MULTIPOLYGON',
      'SRID=4326;MULTIPOLYGON(((33 34.6,33.1 34.6,33.1 34.7,33 34.6)))',
      'ERROR:  22023: Geometry type (MultiPolygon) does not match column type (Polygon)',
    ],
    [
      'a polygon with SRID 3857 (projected)',
      'SRID=3857;POLYGON((0 0,1000 0,1000 1000,0 0))',
      'ERROR:  22023: Only lon/lat coordinate systems are supported in geography.',
    ],
    [
      'a polygon with SRID 4269 (geodetic, not 4326)',
      'SRID=4269;POLYGON((33 34.6,33.1 34.6,33.1 34.7,33 34.6))',
      'ERROR:  22023: Geometry SRID (4269) does not match column SRID (4326)',
    ],
  ];
  for (const [what, value, error] of REFUSED) {
    test(`${what} is REFUSED by the column's typmod (22023; measured)`, async () => {
      assertRefusedBy(what, await asAppRw(insertRow({ boundary: `'${value}'` })), error);
    });
  }

  test('a polygon with an SRID absent from spatial_ref_sys (9999) is REFUSED with XX000, not 22023 (measured; rework 1, QA Q-4)', async () => {
    assertRefusedBy(
      'SRID 9999',
      await asAppRw(insertRow({ boundary: `'SRID=9999;${POLY}'` })),
      'ERROR:  XX000: Cannot find SRID (9999) in spatial_ref_sys',
    );
  });

  test('a polygon UPDATEd to a POINT is REFUSED (22023), the row read first', async () => {
    const r = await asAppRw(
      insertRow(),
      READ_CONTROL,
      `UPDATE ${TABLE} SET boundary = 'SRID=4326;POINT(33.05 34.65)' WHERE name = 't161 control'`,
    );
    assert.ok(r.output.includes('before=1'), `precondition not read:\n${r.output}`);
    assertRefusedBy(
      'UPDATE to a POINT',
      r,
      'ERROR:  22023: Geometry type (Point) does not match column type (Polygon)',
    );
  });

  test('CONTROL — a closed POLYGON with SRID 4326 is accepted and read back by ST_AsText equal to the literal written, SRID 4326', async () => {
    const r = await asAppRw(
      insertRow(),
      `SELECT 'back=' || ST_AsText(boundary) || '|' || ST_SRID(boundary) FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertInsertedOne('4326 polygon', r);
    assert.ok(r.output.includes(`back=${POLY}|4326`), `read-back differs:\n${r.output}`);
  });
});

describe('V3 — every column SD marks NOT NULL refuses NULL (SD 2962–2965), and name_i18n too; the OE-53 columns admit NULL, as app_rw', () => {
  for (const column of ['metro', 'name', 'boundary', 'state', 'density_snapshot', 'name_i18n']) {
    test(`${column} NULL is REFUSED by its NOT NULL (23502)`, async () => {
      assertRefusedBy(
        `${column} NULL`,
        await asAppRw(insertRow({ [column]: 'NULL' })),
        NOTNULL_23502(column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('an INSERT omitting name_i18n is REFUSED by its NOT NULL (23502): there is no default to fall back on', async () => {
    assertRefusedBy(
      'name_i18n omitted',
      await asAppRw(insertRow({ name_i18n: undefined })),
      NOTNULL_23502('name_i18n'),
      'COLUMN NAME:  name_i18n',
    );
  });

  test("CONTROL — an INSERT omitting density_snapshot stores '{}'::jsonb, and omitting both OE-53 columns stores NULL in both", async () => {
    const r = await asAppRw(
      insertRow(),
      `SELECT 'snap=' || density_snapshot::text || '|share=' || coalesce(russian_speaking_share_pct::text, 'NULL') ||
              '|inv=' || coalesce(has_hotel_or_holiday_let_inventory::text, 'NULL')
         FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertInsertedOne('defaults', r);
    assert.ok(r.output.includes('snap={}|share=NULL|inv=NULL'), `defaults differ:\n${r.output}`);
  });

  test('CONTROL — russian_speaking_share_pct NULL and has_hotel_or_holiday_let_inventory NULL, written explicitly, are accepted (OE-53: NULL = unknown)', async () => {
    assertInsertedOne(
      'explicit NULLs',
      await asAppRw(
        insertRow({
          russian_speaking_share_pct: 'NULL',
          has_hotel_or_holiday_let_inventory: 'NULL',
        }),
      ),
    );
  });
});

describe('V4 — only app_rw reads or writes the table: SELECT, INSERT, and UPDATE of every column but id (E.4 U-4, U-10; rework 1, QA Q-1)', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} SELECT`,
        await asLogin(LOGINS[role], `SELECT id FROM ${TABLE}`),
        DENIED,
      );
    });
  }

  test('app_rw DELETE of an existing row is REFUSED (42501; E.4 U-10 (1)), the row read first', async () => {
    const r = await asAppRw(
      insertRow(),
      READ_CONTROL,
      `DELETE FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assert.ok(r.output.includes('before=1'), `precondition not read:\n${r.output}`);
    assertRefusedBy('app_rw DELETE', r, DENIED);
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefusedBy('app_rw TRUNCATE', await asAppRw(`TRUNCATE ${TABLE}`), DENIED);
  });

  test('app_rw nextval on the identity sequence is REFUSED (42501): no sequence grant (E.4 U-1)', async () => {
    assertRefusedBy(
      'app_rw nextval',
      await asAppRw(`SELECT nextval('public.cluster_id_seq')`),
      'ERROR:  42501: permission denied for sequence cluster_id_seq',
    );
  });

  test("CONTROL — app_rw, holding no sequence privilege, inserts (every column but id, T-209's GeoJSON form included), updates name_i18n, boundary, state and both OE-53 columns, and runs T-160's Q1, Q2 and Q3", async () => {
    const r = await asAppRw(
      insertRow({ russian_speaking_share_pct: '11', has_hotel_or_holiday_let_inventory: 'true' }),
      `INSERT INTO ${TABLE} (metro, name, name_i18n, boundary, state, russian_speaking_share_pct, has_hotel_or_holiday_let_inventory)
         VALUES ('CY', 't161 geojson', '${NAMES}'::jsonb,
                 ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[33,34.6],[33.1,34.6],[33.1,34.7],[33,34.7],[33,34.6]]]}'), 4326)::geography,
                 'waitlist', NULL, NULL)`,
      `UPDATE ${TABLE} SET name_i18n = '{"en": "Renamed", "el": "Μετονομάστηκε", "ru": "Переименован"}',
                           boundary = 'SRID=4326;POLYGON((33 34.6,33.2 34.6,33.2 34.8,33 34.8,33 34.6))',
                           state = 'open', density_snapshot = ${FRESH_ALL_PASS},
                           russian_speaking_share_pct = 9, has_hotel_or_holiday_let_inventory = false
         WHERE name = 't161 control'`,
      // Q1 (point-in-polygon, SD 3054): both rows cover INSIDE.
      `SELECT 'q1=' || string_agg(name || ':' || state, ',' ORDER BY id) FROM (
         SELECT id, name, state FROM ${TABLE} WHERE state <> 'closed'
            AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint(${INSIDE.lon}, ${INSIDE.lat}), 4326)::geography) ORDER BY id) q`,
      // Q2 (the materialiser's set, OE-32 U-9 (a)): centroid within 5 km of INSIDE. The geojson row's
      // centroid is INSIDE; the updated control row's centroid is about 7 km away, so it is not returned.
      `SELECT 'q2=' || string_agg(name, ',' ORDER BY id) FROM (SELECT c.id, c.name FROM ${TABLE} c WHERE c.state <> 'closed'
          AND ST_DWithin(ST_Centroid(c.boundary), 'SRID=4326;POINT(${INSIDE.lon} ${INSIDE.lat})'::geography, 5000) ORDER BY c.id) q`,
      // Q3 (the gating read before search).
      `SELECT 'q3=' || string_agg(state || ':' || CASE WHEN density_snapshot = '{}' THEN '{}' ELSE 'snapshot' END, ',' ORDER BY id) FROM (
         SELECT id, state, density_snapshot FROM ${TABLE}
          WHERE id = ANY((SELECT array_agg(id) FROM ${TABLE})::int[]) AND state <> 'closed' ORDER BY id) q`,
      `SELECT 'upd=' || (name_i18n ->> 'ru') || '|' || ST_AsText(boundary) || '|' || russian_speaking_share_pct || '|' ||
              has_hotel_or_holiday_let_inventory FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertPermitted('app_rw control', r);
    assert.equal(
      (r.output.match(/INSERT 0 1/g) ?? []).length,
      2,
      `two inserts expected:\n${r.output}`,
    );
    assert.ok(r.output.includes('UPDATE 1'), `UPDATE 1 expected:\n${r.output}`);
    assert.ok(r.output.includes('q1=t161 control:open,t161 geojson:waitlist'), `Q1:\n${r.output}`);
    assert.ok(r.output.includes('q2=t161 geojson\n'), `Q2:\n${r.output}`);
    assert.ok(r.output.includes('q3=open:snapshot,waitlist:{}'), `Q3:\n${r.output}`);
    assert.ok(
      r.output.includes(
        'upd=Переименован|POLYGON((33 34.6,33.2 34.6,33.2 34.8,33 34.8,33 34.6))|9|false',
      ),
      `updated values:\n${r.output}`,
    );
  });

  test('CONTROL — Q1 does not match a closed cluster, nor a point outside every cluster (U-7 (a), U-9 (4))', async () => {
    const r = await asAppRw(
      insertRow({ state: `'closed'` }),
      `SELECT 'q1closed=' || count(*) FROM ${TABLE} WHERE state <> 'closed'
          AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint(${INSIDE.lon}, ${INSIDE.lat}), 4326)::geography)`,
      `UPDATE ${TABLE} SET state = 'waitlist' WHERE name = 't161 control'`,
      `SELECT 'q1outside=' || count(*) FROM ${TABLE} WHERE state <> 'closed'
          AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint(32.5, 34.9), 4326)::geography)`,
      `SELECT 'q1inside=' || count(*) FROM ${TABLE} WHERE state <> 'closed'
          AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint(${INSIDE.lon}, ${INSIDE.lat}), 4326)::geography)`,
    );
    assertPermitted('Q1 closed / outside', r);
    assert.ok(r.output.includes('q1closed=0'), `closed matched:\n${r.output}`);
    assert.ok(r.output.includes('q1outside=0'), `outside matched:\n${r.output}`);
    assert.ok(r.output.includes('q1inside=1'), `reopened row not matched:\n${r.output}`);
  });
});

describe('V5 — the primary key is unique and GENERATED ALWAYS (E.4 U-1)', () => {
  test('app_rw INSERT with an explicit id is REFUSED (428C9; measured)', async () => {
    assertRefusedBy(
      'app_rw explicit id',
      await asAppRw(insertRow({ id: '5' })),
      'ERROR:  428C9: cannot insert a non-DEFAULT value into column "id"',
    );
  });

  test('app_rw UPDATE … SET id = 7 is REFUSED by the identity (428C9; measured: the rewriter runs before the privilege check), the row read first', async () => {
    const r = await asAppRw(
      insertRow(),
      READ_CONTROL,
      `UPDATE ${TABLE} SET id = 7 WHERE name = 't161 control'`,
    );
    assert.ok(r.output.includes('before=1'), `precondition not read:\n${r.output}`);
    assertRefusedBy(
      'app_rw UPDATE id',
      r,
      'ERROR:  428C9: column "id" can only be updated to DEFAULT',
    );
  });

  test('app_rw UPDATE … SET id = DEFAULT (a renumber, which the identity admits) is REFUSED (42501): UPDATE is granted on every column but id (rework 1, QA Q-1), the row read first', async () => {
    const r = await asAppRw(
      insertRow(),
      READ_CONTROL,
      `UPDATE ${TABLE} SET id = DEFAULT WHERE name = 't161 control'`,
    );
    assert.ok(r.output.includes('before=1'), `precondition not read:\n${r.output}`);
    assertRefusedBy('app_rw renumber', r, DENIED);
  });

  test('CONTROL — the superuser CAN renumber (SET id = DEFAULT, UPDATE 1, the id changes): the identity alone does not stop it, so the column grant is what refuses app_rw above', async () => {
    const r = await asSuperuser(
      `${insertRow()} RETURNING 'before=' || id`,
      `UPDATE ${TABLE} SET id = DEFAULT WHERE name = 't161 control' RETURNING 'after=' || id`,
    );
    assertPermitted('superuser renumber', r);
    assert.ok(r.output.includes('UPDATE 1'), `UPDATE 1 expected:\n${r.output}`);
    const before = /before=(\d+)/.exec(r.output)?.[1];
    const after = /after=(\d+)/.exec(r.output)?.[1];
    assert.ok(
      before !== undefined && after !== undefined && before !== after,
      `id not changed:\n${r.output}`,
    );
  });

  test('CONTROL — app_rw UPDATEs each of the eight columns but id on its own (UPDATE 1 each): every legitimate update column is granted (T-160 Q6, Q7)', async () => {
    const SETS: ReadonlyArray<readonly [column: string, value: string]> = [
      ['metro', `'CY'`],
      ['name', `'t161 renamed'`],
      ['boundary', `'SRID=4326;POLYGON((33 34.6,33.2 34.6,33.2 34.8,33 34.8,33 34.6))'`],
      ['state', `'closed'`],
      ['density_snapshot', `'{"computedAt": "2026-10-13"}'`],
      ['name_i18n', `'{"en": "Renamed", "el": "Μετονομάστηκε", "ru": "Переименован"}'`],
      ['russian_speaking_share_pct', '50'],
      ['has_hotel_or_holiday_let_inventory', 'true'],
    ];
    const r = await asAppRw(
      `${insertRow()} RETURNING 'rid=' || id`,
      ...SETS.map(([c, v]) => `UPDATE ${TABLE} SET ${c} = ${v} WHERE metro = 'CY'`),
    );
    assertPermitted('eight column updates', r);
    assert.equal(
      (r.output.match(/UPDATE 1/g) ?? []).length,
      8,
      `eight UPDATE 1 expected:\n${r.output}`,
    );
  });

  test('a duplicate id supplied by the superuser with OVERRIDING SYSTEM VALUE is REFUSED by cluster_pkey (23505)', async () => {
    const withId = (): string =>
      insertRow({ id: '1000' }).replace(') VALUES (', ') OVERRIDING SYSTEM VALUE VALUES (');
    const r = await asSuperuser(withId(), withId());
    assert.ok(r.output.includes('INSERT 0 1'), `first insert not read:\n${r.output}`);
    assertRefusedBy(
      'duplicate id',
      r,
      'ERROR:  23505: duplicate key value violates unique constraint "cluster_pkey"',
      'CONSTRAINT NAME:  cluster_pkey',
    );
  });

  test('CONTROL — two app_rw inserts get two distinct ids from RETURNING id', async () => {
    const r = await asAppRw(
      `${insertRow()} RETURNING 'rid=' || id`,
      `${insertRow({ name: `'t161 second'` })} RETURNING 'rid=' || id`,
      `SELECT 'distinct=' || count(DISTINCT id) || '/' || count(*) FROM ${TABLE}`,
    );
    assertPermitted('two inserts', r);
    assert.equal(
      (r.output.match(/rid=\d+/g) ?? []).length,
      2,
      `two returned ids expected:\n${r.output}`,
    );
    assert.ok(r.output.includes('distinct=2/2'), `ids not distinct:\n${r.output}`);
  });
});

describe('V6 — a display name exists in en, el and ru, each a string not empty after trimming U+0020 (C14 (a); SD 3089), as app_rw', () => {
  const REFUSED: ReadonlyArray<readonly [what: string, value: string]> = [
    [
      'the ru key missing (accepted if ?& is removed: see the plant below)',
      '{"en": "Test", "el": "Δοκιμή"}',
    ],
    ['the en key missing', '{"el": "Δοκιμή", "ru": "Тест"}'],
    ['the el key missing', '{"en": "Test", "ru": "Тест"}'],
    ['{}', '{}'],
    ['ru a JSON null', '{"en": "Test", "el": "Δοκιμή", "ru": null}'],
    ['ru the number 5', '{"en": "Test", "el": "Δοκιμή", "ru": 5}'],
    ['en two spaces', '{"en": "  ", "el": "Δοκιμή", "ru": "Тест"}'],
    ['en the number 5', '{"en": 5, "el": "Δοκιμή", "ru": "Тест"}'],
    ['el two spaces', '{"en": "Test", "el": "  ", "ru": "Тест"}'],
    ['el the number 5', '{"en": "Test", "el": 5, "ru": "Тест"}'],
    ['ru two spaces', '{"en": "Test", "el": "Δοκιμή", "ru": "  "}'],
    ['ru empty', '{"en": "Test", "el": "Δοκιμή", "ru": ""}'],
    ['a JSON array of the three codes', '["en", "el", "ru"]'],
    ['a JSON string', '"Test cluster"'],
  ];
  for (const [what, value] of REFUSED) {
    test(`name_i18n with ${what} is REFUSED by cluster_name_i18n_three_locales (23514)`, async () => {
      assertRefusedBy(
        `name_i18n ${what}`,
        await asAppRw(insertRow({ name_i18n: `'${value}'` })),
        CHECK_23514('cluster_name_i18n_three_locales'),
        'CONSTRAINT NAME:  cluster_name_i18n_three_locales',
      );
    });
  }

  test("an UPDATE removing ru (name_i18n - 'ru') is REFUSED (23514), the row read first", async () => {
    const r = await asAppRw(
      insertRow(),
      READ_CONTROL,
      `UPDATE ${TABLE} SET name_i18n = name_i18n - 'ru' WHERE name = 't161 control'`,
    );
    assert.ok(r.output.includes('before=1'), `precondition not read:\n${r.output}`);
    assertRefusedBy(
      'UPDATE drop ru',
      r,
      CHECK_23514('cluster_name_i18n_three_locales'),
      'CONSTRAINT NAME:  cluster_name_i18n_three_locales',
    );
  });

  test('CONTROL — en, el and ru with Greek and Cyrillic text are accepted and read back byte-equal', async () => {
    const r = await asAppRw(
      insertRow(),
      `SELECT 'names=' || (name_i18n ->> 'en') || '|' || (name_i18n ->> 'el') || '|' || (name_i18n ->> 'ru')
         FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertInsertedOne('three names', r);
    assert.ok(
      r.output.includes('names=Test cluster|Συστάδα δοκιμής|Тестовый кластер'),
      `names differ:\n${r.output}`,
    );
  });

  test('WHY ?& — with the CHECK re-planted WITHOUT the ?& conjunct (superuser, in a transaction rolled back; plant asserted landed), the missing-ru name is ACCEPTED: jsonb_typeof of a missing key is NULL and a CHECK passes on NULL', async () => {
    const r = await asSuperuser(
      `ALTER TABLE ${TABLE} DROP CONSTRAINT cluster_name_i18n_three_locales`,
      `ALTER TABLE ${TABLE} ADD CONSTRAINT cluster_name_i18n_three_locales CHECK (
            jsonb_typeof(name_i18n) = 'object'
        AND jsonb_typeof(name_i18n -> 'en') = 'string' AND btrim(name_i18n ->> 'en') <> ''
        AND jsonb_typeof(name_i18n -> 'el') = 'string' AND btrim(name_i18n ->> 'el') <> ''
        AND jsonb_typeof(name_i18n -> 'ru') = 'string' AND btrim(name_i18n ->> 'ru') <> '')`,
      `SELECT 'planted=' || (pg_get_constraintdef(oid) NOT LIKE '%?&%')::text FROM pg_constraint
        WHERE conrelid = '${TABLE}'::regclass AND conname = 'cluster_name_i18n_three_locales'`,
      insertRow({ name_i18n: `'{"en": "Test", "el": "Δοκιμή"}'` }),
    );
    assert.ok(r.output.includes('planted=true'), `the plant did not land:\n${r.output}`);
    assertInsertedOne('missing ru without ?&', r);
  });
});

describe('V7 — an entered Russian-speaking share is a whole percent from 0 to 100 (OE-53), as app_rw', () => {
  for (const value of ['-1', '101']) {
    test(`russian_speaking_share_pct ${value} is REFUSED by cluster_russian_speaking_share_pct_range (23514)`, async () => {
      assertRefusedBy(
        `share ${value}`,
        await asAppRw(insertRow({ russian_speaking_share_pct: value })),
        CHECK_23514('cluster_russian_speaking_share_pct_range'),
        'CONSTRAINT NAME:  cluster_russian_speaking_share_pct_range',
      );
    });
  }

  test('CONTROL — NULL, 0, 10, 11 and 100 are each accepted', async () => {
    for (const value of ['NULL', '0', '10', '11', '100']) {
      assertInsertedOne(
        `share ${value}`,
        await asAppRw(insertRow({ russian_speaking_share_pct: value })),
      );
    }
  });

  test("a fraction is not stored: 10.5 is rounded by the integer cast to 11 (whole percent), and '10.5' as text is REFUSED (22P02)", async () => {
    const r = await asAppRw(
      insertRow({ russian_speaking_share_pct: '10.5' }),
      `SELECT 'share=' || russian_speaking_share_pct FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertInsertedOne('share 10.5', r);
    assert.ok(r.output.includes('share=11'), `rounding differs:\n${r.output}`);
    assertRefusedBy(
      "share '10.5'",
      await asAppRw(insertRow({ russian_speaking_share_pct: `'10.5'` })),
      'ERROR:  22P02: invalid input syntax for type integer: "10.5"',
    );
  });
});

describe('V8 — what this table does NOT hold (each ACCEPTED as app_rw, so nobody reads the table as guarded)', () => {
  test("NOT HELD — metro 'Limassol' is accepted: CY-only is T-209's body schema (C15 (b): no DDL change)", async () => {
    assertInsertedOne('metro Limassol', await asAppRw(insertRow({ metro: `'Limassol'` })));
  });

  test("HELD SINCE 0028 (T-211) — an INSERT with state 'open' and an empty snapshot is REFUSED (KV073); the transition matrix is suites/cluster-state.test.ts", async () => {
    assertRefusedBy(
      "open, '{}'",
      await asAppRw(insertRow({ state: `'open'`, density_snapshot: `'{}'` })),
      'ERROR:  KV073: CLUSTER_STATE_TRANSITION_REFUSED: a cluster is inserted as waitlist or closed, never open (trg_cluster_state_transition)',
      'COLUMN NAME:  state',
    );
  });

  test('NOT HELD — a density_snapshot of any JSON shape (array, string, number, JSON null) UPDATEd onto a waitlist row is accepted (0028 constrains the snapshot on INSERT and on moves into and out of open only, T-211)', async () => {
    const r = await asAppRw(
      insertRow(),
      ...[`'[]'`, `'"x"'`, `'5'`, `'null'`].map(
        (value) => `UPDATE ${TABLE} SET density_snapshot = ${value} WHERE name = 't161 control'`,
      ),
    );
    assertPermitted('snapshot shapes on waitlist', r);
    assert.equal(
      (r.output.match(/UPDATE 1/g) ?? []).length,
      4,
      `four UPDATE 1 expected:\n${r.output}`,
    );
  });

  test('NOT HELD — two overlapping clusters are accepted (U-9 (2a): overlap is legal), and Q1 returns both', async () => {
    const r = await asAppRw(
      insertRow(),
      insertRow({
        name: `'t161 overlap'`,
        boundary: `'SRID=4326;POLYGON((33.05 34.6,33.2 34.6,33.2 34.7,33.05 34.7,33.05 34.6))'`,
      }),
      `SELECT 'q1=' || count(*) FROM ${TABLE} WHERE state <> 'closed'
          AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint(33.07, 34.65), 4326)::geography)`,
    );
    assertPermitted('overlap', r);
    assert.equal(
      (r.output.match(/INSERT 0 1/g) ?? []).length,
      2,
      `two inserts expected:\n${r.output}`,
    );
    assert.ok(r.output.includes('q1=2'), `Q1 did not return both:\n${r.output}`);
  });

  test('NOT HELD — a polygon far outside the service area (in the Atlantic) is accepted (U-9 (3): containment deferred to the service-area ticket)', async () => {
    assertInsertedOne(
      'outside service area',
      await asAppRw(
        insertRow({ boundary: `'SRID=4326;POLYGON((-30 40,-29 40,-29 41,-30 41,-30 40))'` }),
      ),
    );
  });

  test('NOT HELD — a self-intersecting (invalid) polygon is accepted (U-9 (1b): validity is checked in code by T-209); ST_IsValid reads it false', async () => {
    const r = await asAppRw(
      insertRow({ boundary: `'SRID=4326;POLYGON((33 34.6,33.1 34.7,33.1 34.6,33 34.7,33 34.6))'` }),
      `SELECT 'valid=' || ST_IsValid(boundary::geometry) FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertInsertedOne('bowtie', r);
    assert.ok(r.output.includes('valid=false'), `expected an invalid polygon:\n${r.output}`);
  });

  test('NOT HELD — name_i18n with a fourth key (de) is accepted, and keys are not checked against locale_registry', async () => {
    assertInsertedOne(
      'fourth key',
      await asAppRw(
        insertRow({ name_i18n: `'{"en": "Test", "el": "Δοκιμή", "ru": "Тест", "de": "Test"}'` }),
      ),
    );
  });

  test('NOT HELD — btrim strips U+0020 only: an ru name of a tab is accepted (one example, not the list)', async () => {
    assertInsertedOne(
      'ru tab',
      await asAppRw(insertRow({ name_i18n: `'{"en": "Test", "el": "Δοκιμή", "ru": "\\t"}'` })),
    );
  });

  test('NOT HELD — two clusters with the same metro and name are accepted (E.4 U-12: no UNIQUE)', async () => {
    const r = await asAppRw(insertRow(), insertRow());
    assertPermitted('same name', r);
    assert.equal(
      (r.output.match(/INSERT 0 1/g) ?? []).length,
      2,
      `two inserts expected:\n${r.output}`,
    );
  });

  test('NOT HELD — app_rw, as any role holding INSERT, can supply an id with OVERRIDING SYSTEM VALUE: 1000, -1 and 2147483647 are each accepted (rework 1, QA Q-2)', async () => {
    for (const id of ['1000', '-1', '2147483647']) {
      assertInsertedOne(
        `OVERRIDING id ${id}`,
        await asAppRw(
          insertRow({ id }).replace(') VALUES (', ') OVERRIDING SYSTEM VALUE VALUES ('),
        ),
      );
    }
  });

  test('NOT HELD — an id app_rw supplies ahead of the sequence makes the next ordinary insert fail 23505 cluster_pkey (rework 1, QA Q-2)', async () => {
    const cols = Object.keys(GOOD).join(', ');
    const vals = Object.values(GOOD).join(', ');
    const r = await asAppRw(
      `${insertRow()} RETURNING 'first=' || id`,
      `INSERT INTO ${TABLE} (id, ${cols}) OVERRIDING SYSTEM VALUE SELECT max(id) + 1, ${vals} FROM ${TABLE}`,
      insertRow(),
    );
    assert.equal(
      (r.output.match(/INSERT 0 1/g) ?? []).length,
      2,
      `two inserts before the collision:\n${r.output}`,
    );
    assertRefusedBy(
      'ordinary insert after OVERRIDING',
      r,
      'ERROR:  23505: duplicate key value violates unique constraint "cluster_pkey"',
      'CONSTRAINT NAME:  cluster_pkey',
    );
  });

  test('NOT HELD — POLYGON EMPTY is accepted on INSERT and on UPDATE, and ST_IsValid reads it true (rework 1, QA Q-4: T-209 refuses it in code)', async () => {
    const r = await asAppRw(
      insertRow({ boundary: `'SRID=4326;POLYGON EMPTY'` }),
      `SELECT 'empty=' || ST_AsText(boundary) || '|valid=' || ST_IsValid(boundary::geometry) FROM ${TABLE} WHERE name = 't161 control'`,
      insertRow({ name: `'t161 second'` }),
      `UPDATE ${TABLE} SET boundary = 'SRID=4326;POLYGON EMPTY' WHERE name = 't161 second'`,
    );
    assertPermitted('POLYGON EMPTY', r);
    assert.ok(r.output.includes('empty=POLYGON EMPTY|valid=true'), `empty reading:\n${r.output}`);
    assert.ok(r.output.includes('UPDATE 1'), `UPDATE 1 expected:\n${r.output}`);
  });

  test('NOT HELD — a latitude of 91 is coerced into range with only a NOTICE and stored as 89 (rework 1, QA Q-4)', async () => {
    const r = await asAppRw(
      insertRow({ boundary: `'SRID=4326;POLYGON((33 34.6,33.1 34.6,33.1 91,33 34.6))'` }),
      `SELECT 'stored=' || ST_AsText(boundary) FROM ${TABLE} WHERE name = 't161 control'`,
    );
    assertInsertedOne('latitude 91', r);
    assert.ok(
      r.output.includes(
        'Coordinate values were coerced into range [-180 -90, 180 90] for GEOGRAPHY',
      ),
      `NOTICE expected:\n${r.output}`,
    );
    assert.ok(
      r.output.includes('stored=POLYGON((33 34.6,33.1 34.6,33.1 89,33 34.6))'),
      `coercion:\n${r.output}`,
    );
  });

  test('NOT HELD — a NaN coordinate and a zero-area ring are each accepted, and ST_IsValid reads each false (rework 1, QA Q-4)', async () => {
    for (const poly of [
      'POLYGON((33 34.6,NaN 34.6,33.1 34.7,33 34.6))',
      'POLYGON((33 34.6,33 34.6,33 34.6,33 34.6))',
    ]) {
      const r = await asAppRw(
        insertRow({ boundary: `'SRID=4326;${poly}'` }),
        `SELECT 'valid=' || ST_IsValid(boundary::geometry) FROM ${TABLE} WHERE name = 't161 control'`,
      );
      assertInsertedOne(poly, r);
      assert.ok(r.output.includes('valid=false'), `${poly}:\n${r.output}`);
    }
  });
});

describe('0027 — the SA §INT-10 guard, called DIRECTLY (OD-76)', () => {
  test('after up, SELECT kinvara_guard.assert_answering_service_write_only() returns clean', async () => {
    assertPermitted(
      'direct call after up',
      await db.psql({
        commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'],
        verbose: true,
        stopOnError: true,
      }),
    );
  });

  test('GRANT SELECT on cluster to answering_service is REFUSED by the guard (KV010), and lands nothing', async () => {
    assertRefusedBy(
      'GRANT SELECT to answering_service',
      await asSuperuser(`GRANT SELECT ON ${TABLE} TO answering_service`),
      `ERROR:  KV010: ${INT10_RAISE}`,
      'answering_service holds SELECT on public.cluster',
    );
    assert.equal(
      await db.value(`SELECT has_table_privilege('answering_service', '${TABLE}', 'SELECT')::text`),
      'false',
    );
  });
});

describe('0027 — after every case', () => {
  test('the table still holds no row (every write was rolled back)', async () => {
    assert.equal(await db.value(`SELECT count(*)::text FROM ${TABLE}`), '0');
  });
});
