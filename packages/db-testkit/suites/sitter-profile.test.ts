/**
 * T-158 — `public.sitter_profile` and its two enums (migration 0025): SD §DB-4 lines 2002–2035, as
 * requested by tasks/state/EP-5/T-157.md § Migration request and finalised in § Finalisation 2026-10-10
 * (F-3: V1 amended, V2–V6, V7 amended, V8 new), with the stakeholder's 2026-10-10 rulings: EV-35 and
 * EV-36 (the eight CHECKs), EV-37 (bookable_since protected), EV-38 (the §DB-14 note in COMMENT ON
 * TABLE), and OE-33 G-3 (option (c): column grants here, ONE definer derivation function in T-028).
 *
 * The table's catalogue is pinned: its columns (type, nullability, default) with the owner, the table
 * ACL AND every column ACL; app_rw's effective privilege on every column; the two enum types (labels in
 * order, owner, ACL); its whole constraint set by name and definition (NOT NULL constraints included,
 * contype 'n' on PostgreSQL 18); its indexes and the GiST index's operator class; its comment; and in
 * ONE assertion its non-internal triggers, rewrite rules, policies and both row-level security flags.
 * So a constraint, grant (table or column), index, trigger, rule or policy added to or removed from the
 * table turns a case red. A grant that widens app_rw, or any grant to app_admin_rw, passes
 * gate:migration-lint (T-251 § contract §5): the ACL pin is the guard. What is not in those catalogues
 * is not pinned (an event trigger; a function no trigger on this table calls).
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field, and exactly one ERROR line, so
 * a crash, a syntax error or a refusal for another reason cannot read as this one. Each rule has a
 * CONTROL beside it that differs from a refused case only in the value or principal under test.
 *
 * Every UPDATE or DELETE refusal over a login that can read the table first reads its target row in the
 * same psql session and asserts that reading, so a statement that matched no row can pass for neither
 * a refusal nor a control.
 *
 * Privilege refusals run over REAL LOGIN principals, each a member of exactly one role (T-020 Evidence
 * §4). Constraint refusals run as the superuser, so no privilege is what refuses them. Every write runs
 * inside a transaction that is never committed (`inTransaction`), so the one committed fixture row is
 * the table's only row throughout, and the last test of the file re-reads it. The G-3 stand-in and the
 * OD-317 pg_temp-shadow definers are the two committed plants; each is created and dropped inside its
 * own describe block, and each drop is asserted.
 *
 * NOT COVERED, by design (C17 (a), F-3 V1): the owner app_ddl (break-glass RB-2) and the superuser can
 * write the protected four. The grants bind app_rw only; the NOT HELD cases pin that.
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

const SUITE = 'sitter-profile';
const TABLE = 'public.sitter_profile';

/** One login per role, each a member of that role alone. app_ddl's is the break-glass principal. */
const LOGINS = {
  app_rw: 't158_app_rw_probe',
  app_admin_rw: 't158_app_admin_rw_probe',
  app_safety_rw: 't158_app_safety_rw_probe',
  answering_service: 't158_answering_service_probe',
  app_ddl: 't158_app_ddl_probe',
} as const;

/** Account ids (char(26)). SITTER has the one committed profile row; FRESH has none; UNKNOWN is no account. */
const SITTER = '01T158SITTERPROFILE0000001';
const FRESH = '01T158FRESHACCOUNT00000001';
const UNKNOWN = '01T158NOACCOUNT00000000001';
for (const id of [SITTER, FRESH, UNKNOWN]) assert.equal(id.length, 26, id);

/** SD's 25 columns in SD's order (SD 2006–2032). */
const COLUMNS = [
  'id',
  'bookable_state',
  'tier',
  'tier_rank',
  'bio',
  'headline',
  'bio_authored_locale',
  'headline_authored_locale',
  'base_location',
  'travel_radius_m',
  'transport_mode',
  'travel_buffer_before',
  'travel_buffer_after',
  'max_bookings_per_day',
  'max_consecutive_hours',
  'take_home_hourly_minor',
  'currency',
  'weekend_uplift_pct',
  'after_22_uplift_pct',
  'per_additional_child_minor',
  'profile_photo_key',
  'profile_photo_source_verification_id',
  'version',
  'bookable_since',
  'created_at',
] as const;
type Column = (typeof COLUMNS)[number];

/** The protected four (SD 2007–2008 DERIVED; EV-37 bookable_since): no app_rw UPDATE (E.4 U-3). */
const PROTECTED: readonly Column[] = ['bookable_state', 'tier', 'tier_rank', 'bookable_since'];
/** Not derived, and still no app_rw UPDATE: the key, the creation time, currency (no ruled writer). */
const NOT_UPDATABLE_OTHER: readonly Column[] = ['id', 'currency', 'created_at'];
/** The 18 columns app_rw may UPDATE (F-3 § Grants (final)), in attnum order. Literal, not a reading. */
const APP_RW_UPDATE: readonly Column[] = [
  'bio',
  'headline',
  'bio_authored_locale',
  'headline_authored_locale',
  'base_location',
  'travel_radius_m',
  'transport_mode',
  'travel_buffer_before',
  'travel_buffer_after',
  'max_bookings_per_day',
  'max_consecutive_hours',
  'take_home_hourly_minor',
  'weekend_uplift_pct',
  'after_22_uplift_pct',
  'per_additional_child_minor',
  'profile_photo_key',
  'profile_photo_source_verification_id',
  'version',
];
assert.equal(APP_RW_UPDATE.length, 18);
assert.equal(APP_RW_UPDATE.length + PROTECTED.length + NOT_UPDATABLE_OTHER.length, COLUMNS.length);

/** A well-formed, non-default SQL literal per column: a refusal of it is the privilege's, not the value's. */
const VALUE: Readonly<Record<Column, string>> = {
  id: `'${FRESH}'`,
  bookable_state: `'bookable'`,
  tier: `'sitter'`,
  tier_rank: '1',
  bio: `'t158 bio'`,
  headline: `'t158 headline'`,
  bio_authored_locale: `'el'`,
  headline_authored_locale: `'el'`,
  base_location: `'SRID=4326;POINT(33.04 34.68)'`,
  travel_radius_m: '6000',
  transport_mode: `'car'`,
  travel_buffer_before: `'15 minutes'`,
  travel_buffer_after: `'15 minutes'`,
  max_bookings_per_day: '3',
  max_consecutive_hours: '8',
  take_home_hourly_minor: '1500',
  currency: `'EUR'`,
  weekend_uplift_pct: '10.0',
  after_22_uplift_pct: '20.0',
  per_additional_child_minor: '300',
  profile_photo_key: `'t158/photo'`,
  profile_photo_source_verification_id: `'01T158IDVRESULT00000000001'`,
  version: '2',
  bookable_since: 'now()',
  created_at: 'now()',
};

/** The texts 0025 installs, verbatim: a change to the comment must change this suite too. */
const TABLE_COMMENT =
  "Sitter profile (SD §DB-4 lines 2005-2035; SA §SA-4 I-1). id is the sitter's account id. " +
  'bookable_state, tier, tier_rank and bookable_since are DERIVED: app_rw holds no UPDATE on them; the I-1 ' +
  'derivation and break-glass app_ddl write them. app_rw may INSERT only id, may UPDATE every other column ' +
  'except id, currency and created_at, and holds no DELETE. Retention (§DB-14 row added by stakeholder ' +
  'ruling 2026-10-10): on erasure the row is kept and every nullable non-derived column is set to NULL (bio, ' +
  'headline, bio_authored_locale, headline_authored_locale, base_location, max_bookings_per_day, ' +
  'max_consecutive_hours, take_home_hourly_minor, weekend_uplift_pct, after_22_uplift_pct, ' +
  'per_additional_child_minor, profile_photo_key, profile_photo_source_verification_id); no role holds DELETE.';

/** The committed fixture row as READ_SITTER prints it: SD's defaults, every derived column at its default. */
const DEFAULTS_READ =
  'onboarding|NULL|0|NULL|5000|public_transport|00:30:00|00:30:00|EUR|1|created';
const readRow = (id: string): string =>
  `SELECT 'row:' || id || '|' || bookable_state || '|' || coalesce(tier::text, 'NULL') || '|' || tier_rank || '|' ||
          coalesce(bookable_since::text, 'NULL') || '|' || travel_radius_m || '|' || transport_mode || '|' ||
          travel_buffer_before || '|' || travel_buffer_after || '|' || currency || '|' || version || '|' ||
          CASE WHEN created_at IS NOT NULL THEN 'created' ELSE 'no created_at' END
     FROM ${TABLE} WHERE id = '${id}'`;
const READ_SITTER = readRow(SITTER);
const SITTER_BEFORE = `row:${SITTER}|${DEFAULTS_READ}`;

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
         ('${SITTER}', '01T158PSEUDO00000000000001', 't158'),
         ('${FRESH}', '01T158PSEUDO00000000000002', 't158')`,
      `INSERT INTO ${TABLE} (id) VALUES ('${SITTER}')`,
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** Every invocation runs inside one transaction that is never committed: psql's session end rolls it back. */
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

/** Accepted, and psql reported exactly this command tag (e.g. INSERT 0 1, UPDATE 1). */
function assertTag(what: string, r: PsqlResult, tag: string): void {
  assertPermitted(what, r);
  assert.ok(r.output.includes(tag), `${what}: expected ${tag}.\n${r.output}`);
}

/** The precondition read happened in this session, so the statement after it had a row to act on. */
function assertReadFirst(what: string, r: PsqlResult): void {
  assert.ok(r.output.includes(SITTER_BEFORE), `${what}: precondition not read:\n${r.output}`);
}

/** An INSERT for FRESH with these columns set (id always included). */
function insertFresh(set: Readonly<Partial<Record<Column, string>>> = {}): string {
  const cols = ['id', ...Object.keys(set).filter((c) => c !== 'id')];
  const vals = cols.map((c) => (c === 'id' ? `'${FRESH}'` : (set as Record<string, string>)[c]));
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
}

const CHECK_23514 = (name: string): string =>
  `ERROR:  23514: new row for relation "sitter_profile" violates check constraint "${name}"`;
const NOTNULL_23502 = (column: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "sitter_profile" violates not-null constraint`;
const FK_23503 = (name: string): string =>
  `ERROR:  23503: insert or update on table "sitter_profile" violates foreign key constraint "${name}"`;
const DENIED = 'ERROR:  42501: permission denied for table sitter_profile';

describe('0025 — the table, its types, owner, columns, ACLs, constraints, indexes and comment', () => {
  test("SD 2006–2032's 25 columns in SD's order with SD's types, nullability and defaults; owner app_ddl; table ACL app_rw SELECT only; column ACLs: app_rw INSERT on id, UPDATE on the 18 columns, nothing on the protected four, currency or created_at", async () => {
    const W = '{app_rw=w/app_ddl}';
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' ||
                                   coalesce(attacl::text, '-'), E'\\n' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped)
                || E'\\n' || pg_get_userbyid(c.relowner) || ' ' || c.relacl::text
           FROM pg_class c WHERE c.oid = '${TABLE}'::regclass`,
      ),
      [
        'id:character(26):nn:-:{app_rw=a/app_ddl}',
        "bookable_state:bookable_state:nn:'onboarding'::bookable_state:-",
        'tier:sitter_tier:null:-:-',
        'tier_rank:smallint:nn:0:-',
        `bio:text:null:-:${W}`,
        `headline:text:null:-:${W}`,
        `bio_authored_locale:text:null:-:${W}`,
        `headline_authored_locale:text:null:-:${W}`,
        `base_location:geography(Point,4326):null:-:${W}`,
        `travel_radius_m:integer:nn:5000:${W}`,
        `transport_mode:text:nn:'public_transport'::text:${W}`,
        `travel_buffer_before:interval:nn:'00:30:00'::interval:${W}`,
        `travel_buffer_after:interval:nn:'00:30:00'::interval:${W}`,
        `max_bookings_per_day:smallint:null:-:${W}`,
        `max_consecutive_hours:smallint:null:-:${W}`,
        `take_home_hourly_minor:bigint:null:-:${W}`,
        "currency:character(3):nn:'EUR'::bpchar:-",
        `weekend_uplift_pct:numeric(4,1):null:-:${W}`,
        `after_22_uplift_pct:numeric(4,1):null:-:${W}`,
        `per_additional_child_minor:bigint:null:-:${W}`,
        `profile_photo_key:text:null:-:${W}`,
        `profile_photo_source_verification_id:character(26):null:-:${W}`,
        `version:integer:nn:1:${W}`,
        'bookable_since:timestamp with time zone:null:-:-',
        'created_at:timestamp with time zone:nn:now():-',
        'app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}',
      ].join('\n'),
    );
  });

  test("app_rw's effective privileges: SELECT on the table and every column; INSERT on id only; UPDATE on exactly the 18 columns; no DELETE, TRUNCATE, REFERENCES or TRIGGER (has_table_privilege / has_column_privilege, anchored on literals)", async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE',
                   'REFERENCES','TRIGGER','MAINTAIN']) p WHERE has_table_privilege('app_rw', '${TABLE}', p)) || '|' ||
                (SELECT string_agg(p || '=' || coalesce((SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
                   WHERE attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped
                     AND has_column_privilege('app_rw', '${TABLE}', attname, p)), '-'), ' ' ORDER BY p)
                   FROM unnest(ARRAY['INSERT','REFERENCES','UPDATE']) p) || '|select-columns=' ||
                (SELECT count(*) FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attnum > 0
                   AND NOT attisdropped AND has_column_privilege('app_rw', '${TABLE}', attname, 'SELECT'))`,
      ),
      `SELECT|INSERT=id REFERENCES=- UPDATE=${APP_RW_UPDATE.join(',')}|select-columns=25`,
    );
  });

  test("no role but app_ddl (owner) and app_rw holds any table OR column privilege, PUBLIC included (superusers, predefined pg_* roles and this suite's t158_* probe logins, each a member of one role, are not read)", async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(DISTINCT r.rolname, ',' ORDER BY r.rolname), '(none)')
           FROM (SELECT rolname FROM pg_roles UNION ALL SELECT 'public') r(rolname)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
          WHERE r.rolname NOT IN ('app_ddl') AND r.rolname NOT LIKE 'pg\\_%' AND r.rolname NOT LIKE 't158\\_%'
            AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = r.rolname) IS TRUE
            AND (has_table_privilege(r.rolname, '${TABLE}', p)
                 OR (p IN ('SELECT','INSERT','UPDATE','REFERENCES')
                     AND has_any_column_privilege(r.rolname, '${TABLE}', p)))`,
      ),
      'app_rw',
    );
  });

  test("the enum types bookable_state (SD 2002's five values, in SD's order; C16) and sitter_tier (SD 2003), each owned by app_ddl with the default ACL (PUBLIC USAGE)", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(t.typname || ' ' || pg_get_userbyid(t.typowner) || ' ' || coalesce(t.typacl::text, 'NULL') || ' ' ||
                           (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid),
                           ' ; ' ORDER BY t.typname)
           FROM pg_type t WHERE t.oid IN ('public.bookable_state'::regtype, 'public.sitter_tier'::regtype)`,
      ),
      'bookable_state app_ddl NULL onboarding,bookable,review_hold,suspended,removed ; ' +
        'sitter_tier app_ddl NULL sitter,childcare_professional,infant_qualified',
    );
  });

  test('the constraint set is exactly these names and definitions: the PK, the three FKs (no ON DELETE / ON UPDATE clause: NO ACTION), the eight CHECKs of EV-35/EV-36, and the ten NOT NULLs; no UNIQUE, no EXCLUDE, none deferrable', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || ' ' || contype::text || ' ' || condeferrable::text || ' ' ||
                           pg_get_constraintdef(oid), E'\\n' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass`,
      ),
      [
        'sitter_profile_bio_authored_locale_fkey f false FOREIGN KEY (bio_authored_locale) REFERENCES locale_registry(code)',
        'sitter_profile_bio_locale_paired c false CHECK (((bio IS NULL) = (bio_authored_locale IS NULL)))',
        'sitter_profile_bookable_state_not_null n false NOT NULL bookable_state',
        'sitter_profile_created_at_not_null n false NOT NULL created_at',
        'sitter_profile_currency_not_null n false NOT NULL currency',
        'sitter_profile_headline_authored_locale_fkey f false FOREIGN KEY (headline_authored_locale) REFERENCES locale_registry(code)',
        'sitter_profile_headline_locale_paired c false CHECK (((headline IS NULL) = (headline_authored_locale IS NULL)))',
        'sitter_profile_id_fkey f false FOREIGN KEY (id) REFERENCES account(id)',
        'sitter_profile_id_not_null n false NOT NULL id',
        'sitter_profile_max_bookings_per_day_nonneg c false CHECK (((max_bookings_per_day IS NULL) OR (max_bookings_per_day >= 0)))',
        'sitter_profile_max_consecutive_hours_nonneg c false CHECK (((max_consecutive_hours IS NULL) OR (max_consecutive_hours >= 0)))',
        'sitter_profile_per_child_nonneg c false CHECK (((per_additional_child_minor IS NULL) OR (per_additional_child_minor >= 0)))',
        'sitter_profile_pkey p false PRIMARY KEY (id)',
        'sitter_profile_take_home_nonneg c false CHECK (((take_home_hourly_minor IS NULL) OR (take_home_hourly_minor >= 0)))',
        'sitter_profile_tier_rank_not_null n false NOT NULL tier_rank',
        'sitter_profile_transport_mode_not_null n false NOT NULL transport_mode',
        "sitter_profile_travel_buffer_after_nonneg c false CHECK ((travel_buffer_after >= '00:00:00'::interval))",
        'sitter_profile_travel_buffer_after_not_null n false NOT NULL travel_buffer_after',
        "sitter_profile_travel_buffer_before_nonneg c false CHECK ((travel_buffer_before >= '00:00:00'::interval))",
        'sitter_profile_travel_buffer_before_not_null n false NOT NULL travel_buffer_before',
        'sitter_profile_travel_radius_m_not_null n false NOT NULL travel_radius_m',
        'sitter_profile_version_not_null n false NOT NULL version',
      ].join('\n'),
    );
  });

  test("the indexes are exactly the PK and idx_sitter_base_location, GiST over base_location with opclass gist_geography_ops, partial on bookable_state = 'bookable' (SD 2034–2035); there is NO idx_sitter_tier (E.4 U-7 (b))", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(i.indexrelid) || ' [' ||
                           (SELECT string_agg(o.opcname, ',') FROM unnest(i.indclass) WITH ORDINALITY u(oid, n)
                              JOIN pg_opclass o ON o.oid = u.oid) || ']', ' ; ' ORDER BY i.indexrelid::regclass::text)
           FROM pg_index i WHERE i.indrelid = '${TABLE}'::regclass`,
      ),
      "CREATE INDEX idx_sitter_base_location ON public.sitter_profile USING gist (base_location) WHERE (bookable_state = 'bookable'::bookable_state) [gist_geography_ops] ; " +
        'CREATE UNIQUE INDEX sitter_profile_pkey ON public.sitter_profile USING btree (id) [bpchar_ops]',
    );
  });

  test("0 non-internal triggers, 0 rewrite rules, no row-level security, 0 policies (U-9 (a); sitter_profile is not on SD 1309/3906's RLS list, OD-223)", async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
           FROM pg_class c WHERE c.oid = '${TABLE}'::regclass`,
      ),
      '0 triggers, 0 rules, rls=false, force=false, 0 policies',
    );
  });

  test('COMMENT ON TABLE is exactly this text, carrying the §DB-14 row (EV-38: retained, every nullable non-derived column nulled on erasure, no DELETE); no column carries a comment', async () => {
    assert.equal(
      await db.value(`SELECT obj_description('${TABLE}'::regclass, 'pg_class')`),
      TABLE_COMMENT,
    );
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attnum > 0
            AND col_description(attrelid, attnum) IS NOT NULL`,
      ),
      '0',
    );
  });

  test("the §DB-14 comment's column list is exactly the table's nullable columns that are not derived (E-3 (b)), read from the catalogue", async () => {
    const listed = /set to NULL \(([^)]*)\)/.exec(TABLE_COMMENT)?.[1]?.split(', ') ?? [];
    assert.equal(
      await db.value(
        `SELECT string_agg(attname, ', ' ORDER BY attnum) FROM pg_attribute
          WHERE attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped AND NOT attnotnull
            AND attname NOT IN (${PROTECTED.map((c) => `'${c}'`).join(', ')})`,
      ),
      listed.join(', '),
    );
    assert.equal(listed.length, 13);
  });
});

describe('V1 — app_rw cannot write the protected four (bookable_state, tier, tier_rank, bookable_since); only the derivation (definer) and break-glass app_ddl can', () => {
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

  test('CONTROL — app_rw INSERT (id) is accepted (U-1 (a)) and stores onboarding / NULL tier / rank 0 / NULL bookable_since and every SD default', async () => {
    const r = await asLogin(LOGINS.app_rw, insertFresh(), readRow(FRESH));
    assertTag('app_rw INSERT (id)', r, 'INSERT 0 1');
    assert.ok(
      r.output.includes(`row:${FRESH}|${DEFAULTS_READ}`),
      `defaults not stored:\n${r.output}`,
    );
  });

  for (const column of COLUMNS.filter((c) => c !== 'id')) {
    test(`app_rw INSERT naming ${column} (besides id) is REFUSED (42501): the grant is INSERT (id)`, async () => {
      assertRefusedBy(
        `app_rw INSERT (id, ${column})`,
        await asLogin(LOGINS.app_rw, insertFresh({ [column]: VALUE[column] })),
        DENIED,
      );
    });
  }

  for (const column of [...PROTECTED, ...NOT_UPDATABLE_OTHER]) {
    test(`app_rw UPDATE of ${column} is REFUSED (42501)${PROTECTED.includes(column) ? ' — protected (E.4 U-3)' : ''}, the row read first`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        READ_SITTER,
        `UPDATE ${TABLE} SET ${column} = ${column === 'id' ? `'${UNKNOWN}'` : VALUE[column]} WHERE id = '${SITTER}'`,
      );
      assertReadFirst(`app_rw UPDATE ${column}`, r);
      assertRefusedBy(`app_rw UPDATE ${column}`, r, DENIED);
    });
  }

  test('app_rw UPDATE setting a protected column to its own current value (SET bookable_state = bookable_state) is REFUSED (42501): the privilege is on the column named, not on the value', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_SITTER,
      `UPDATE ${TABLE} SET bio = 'x', bio_authored_locale = 'el', bookable_state = bookable_state WHERE id = '${SITTER}'`,
    );
    assertReadFirst('app_rw SET bookable_state = bookable_state', r);
    assertRefusedBy('app_rw SET bookable_state = bookable_state', r, DENIED);
  });

  /** The 18 granted columns as UPDATE controls; each text column with its locale, so V8's pairing CHECK holds. */
  const UPDATE_CONTROLS: ReadonlyArray<readonly Column[]> = [
    ['bio', 'bio_authored_locale'],
    ['headline', 'headline_authored_locale'],
    ...APP_RW_UPDATE.filter((c) => !/^(bio|headline)/.test(c)).map((c) => [c] as const),
  ];
  assert.equal(UPDATE_CONTROLS.flat().length, 18);
  for (const set of UPDATE_CONTROLS) {
    test(`CONTROL — app_rw UPDATE of ${set.join(' + ')} on the same row is ACCEPTED (UPDATE 1)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        READ_SITTER,
        `UPDATE ${TABLE} SET ${set.map((c) => `${c} = ${VALUE[c]}`).join(', ')} WHERE id = '${SITTER}'`,
      );
      assertReadFirst(`app_rw UPDATE ${set.join('+')}`, r);
      assertTag(`app_rw UPDATE ${set.join('+')}`, r, 'UPDATE 1');
    });
  }

  test('CONTROL — app_rw takes the row locks the I-1 paths need: Q2 SELECT … FOR SHARE (assert_sitter_bookable) and SELECT … FOR UPDATE (SD 1407)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT 'share:' || count(*) FROM (SELECT 1 FROM ${TABLE} s WHERE s.id = '${SITTER}' AND s.bookable_state = 'onboarding' FOR SHARE) q`,
      `SELECT 'update:' || count(*) FROM (SELECT 1 FROM ${TABLE} WHERE id = '${SITTER}' FOR UPDATE) q`,
    );
    assertPermitted('app_rw row locks', r);
    assert.ok(r.output.includes('share:1') && r.output.includes('update:1'), r.output);
  });

  test('NOT HELD (C17 (2a) break-glass) — a real app_ddl login UPDATEs all four protected columns: the grants bind app_rw only', async () => {
    const r = await asLogin(
      LOGINS.app_ddl,
      `UPDATE ${TABLE} SET bookable_state = 'review_hold', tier = 'sitter', tier_rank = 1, bookable_since = now() WHERE id = '${SITTER}'`,
    );
    assertTag('app_ddl break-glass UPDATE', r, 'UPDATE 1');
  });

  test('NOT HELD — the superuser UPDATEs all four protected columns', async () => {
    assertTag(
      'superuser UPDATE',
      await asSuperuser(
        `UPDATE ${TABLE} SET bookable_state = 'removed', tier = 'infant_qualified', tier_rank = 3, bookable_since = NULL WHERE id = '${SITTER}'`,
      ),
      'UPDATE 1',
    );
  });
});

describe('V1 / G-3 option (c) — a planted stand-in for T-028: an INVOKER trigger fired by an app_rw write calls ONE SECURITY DEFINER function owned by app_ddl, which writes the protected four', () => {
  // The required form for T-028 (OD-317): search_path = pg_catalog, pg_temp (pg_temp named LAST, the
  // 0021 form) and every relation schema-qualified. Why both: the OD-317 describe block below.
  const PLANT = [
    `CREATE FUNCTION public.t158_derive_standin(p_id char) RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS
       $f$ UPDATE public.sitter_profile SET bookable_state = 'bookable', tier = 'sitter', tier_rank = 1,
             bookable_since = now() WHERE id = p_id $f$`,
    // SA §INT-10 check (8): a definer function PUBLIC may EXECUTE is refused (KV010), so EXECUTE is
    // revoked first and the function made SECURITY DEFINER after (the 0021 precedent).
    'REVOKE ALL ON FUNCTION public.t158_derive_standin(char) FROM PUBLIC',
    'ALTER FUNCTION public.t158_derive_standin(char) OWNER TO app_ddl',
    'ALTER FUNCTION public.t158_derive_standin(char) SECURITY DEFINER',
    'GRANT EXECUTE ON FUNCTION public.t158_derive_standin(char) TO app_rw',
    `CREATE FUNCTION public.t158_credential_standin_trg() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
       $f$ BEGIN PERFORM public.t158_derive_standin(NEW.sitter_id); RETURN NEW; END $f$`,
    'CREATE TABLE public.t158_credential_standin (sitter_id char(26) NOT NULL)',
    'GRANT INSERT ON public.t158_credential_standin TO app_rw',
    `CREATE TRIGGER t158_standin AFTER INSERT ON public.t158_credential_standin
       FOR EACH ROW EXECUTE FUNCTION public.t158_credential_standin_trg()`,
  ];
  const UNPLANT = [
    'DROP TABLE public.t158_credential_standin',
    'DROP FUNCTION public.t158_credential_standin_trg()',
    'DROP FUNCTION public.t158_derive_standin(char)',
  ];
  const DERIVED = `SELECT 'derived:' || bookable_state || '|' || coalesce(tier::text, 'NULL') || '|' || tier_rank || '|' ||
                          (bookable_since IS NOT NULL) FROM ${TABLE} WHERE id = '${SITTER}'`;
  const FIRE = `INSERT INTO public.t158_credential_standin VALUES ('${SITTER}')`;

  test('plant (committed, as the superuser): the definer function, the invoker trigger and its table', async () => {
    assertPermitted('plant', await db.psql({ commands: PLANT, verbose: true, stopOnError: true }));
    assert.equal(
      await db.value(
        `SELECT p.prosecdef || ' ' || pg_get_userbyid(p.proowner) || ' ' || p.proacl::text
           FROM pg_proc p WHERE p.oid = 'public.t158_derive_standin(char)'::regprocedure`,
      ),
      'true app_ddl {app_ddl=X/app_ddl,app_rw=X/app_ddl}',
    );
    assert.equal(
      await db.value(
        `SELECT string_agg(proname || ':' || array_to_string(proconfig, ','), ' ' ORDER BY proname)
           FROM pg_proc WHERE proname IN ('t158_derive_standin', 't158_credential_standin_trg')`,
      ),
      't158_credential_standin_trg:search_path=pg_catalog, pg_temp t158_derive_standin:search_path=pg_catalog, pg_temp',
    );
  });

  test('an app_rw write that fires the trigger CHANGES bookable_state, tier, tier_rank and bookable_since through the definer, while the same login is refused writing them itself (42501)', async () => {
    const r = await asLogin(LOGINS.app_rw, READ_SITTER, FIRE, DERIVED);
    assertReadFirst('derivation fired', r);
    assertTag('derivation fired', r, 'INSERT 0 1');
    assert.ok(
      r.output.includes('derived:bookable|sitter|1|true'),
      `derivation did not write:\n${r.output}`,
    );
    assertRefusedBy(
      'app_rw direct write in the same state',
      await asLogin(
        LOGINS.app_rw,
        `UPDATE ${TABLE} SET bookable_state = 'bookable' WHERE id = '${SITTER}'`,
      ),
      DENIED,
    );
  });

  test("app_rw, holding EXECUTE, can also call the definer directly, and it writes: this plant writes constants, so this pins only that EXECUTE is the whole gate. Under (c) a direct call can only recompute ONLY IF T-028's function takes only the id, DERIVES every value from its inputs, pins search_path = pg_catalog, pg_temp (pg_temp last) AND schema-qualifies every relation it names: with an unqualified read an app_rw TEMP table chooses the value (OD-317, the next describe block). An obligation on T-028, not shown here", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `SELECT public.t158_derive_standin('${SITTER}')`,
      DERIVED,
    );
    assertPermitted('direct call', r);
    assert.ok(r.output.includes('derived:bookable|sitter|1|true'), r.output);
  });

  test('WITH THE DEFINER REMOVED (the function made SECURITY INVOKER): the same app_rw write is REFUSED (42501) — a column grant refuses an invoker derivation too, which is why G-3 needs the definer', async () => {
    assertPermitted(
      'make invoker',
      await db.psql({
        commands: ['ALTER FUNCTION public.t158_derive_standin(char) SECURITY INVOKER'],
        verbose: true,
        stopOnError: true,
      }),
    );
    assert.equal(
      await db.value(
        `SELECT prosecdef::text FROM pg_proc WHERE oid = 'public.t158_derive_standin(char)'::regprocedure`,
      ),
      'false',
    );
    assertRefusedBy('invoker derivation', await asLogin(LOGINS.app_rw, FIRE), DENIED);
  });

  test('unplant (committed): no t158_ function, table or trigger remains, and the profile row is unchanged', async () => {
    assertPermitted(
      'unplant',
      await db.psql({ commands: UNPLANT, verbose: true, stopOnError: true }),
    );
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_proc WHERE proname LIKE 't158\\_%') + (SELECT count(*) FROM pg_class WHERE relname LIKE 't158\\_%')
                + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 't158\\_%')`,
      ),
      '0',
    );
    assert.equal(await db.value(READ_SITTER), SITTER_BEFORE);
  });
});

describe('OD-317 — the pg_temp shadow: app_rw holds TEMP, so a TEMP table can stand in for an input a SECURITY DEFINER derivation reads by an UNQUALIFIED name; a schema-qualified read is not shadowed (the required form for T-028: search_path = pg_catalog, pg_temp, every relation qualified)', () => {
  // Five id-only definers owned by app_ddl, each DERIVING bookable_state from one committed input
  // table (bookable iff the input has a row for the id). They differ ONLY in search_path and in
  // whether the read is qualified. QA measured the first two shapes (T-158 QA-H, H03/H04).
  const INPUT = 'public.t158_cred_input';
  const body = (rel: string): string =>
    `$f$ BEGIN IF EXISTS (SELECT 1 FROM ${rel} WHERE sitter_id = p_id) THEN
       UPDATE public.sitter_profile SET bookable_state = 'bookable' WHERE id = p_id; END IF; END $f$`;
  const FORMS = {
    /** The required form: pg_temp named last, the read qualified. */
    t158_shadow_required: { path: 'pg_catalog, pg_temp', rel: INPUT },
    /** pg_temp unnamed, so searched FIRST for relations; unqualified read (QA H03). */
    t158_shadow_public: { path: 'pg_catalog, public', rel: 't158_cred_input' },
    /** The 0021 path, unqualified: pg_temp is the only schema on the path that can hold the name. */
    t158_shadow_unqualified: { path: 'pg_catalog, pg_temp', rel: 't158_cred_input' },
    /** pg_temp named last after public, unqualified (QA H04). */
    t158_shadow_temp_last: { path: 'pg_catalog, public, pg_temp', rel: 't158_cred_input' },
    /** pg_temp unnamed, the read qualified (the stand-in's pre-OD-317 path). */
    t158_shadow_qualified: { path: 'pg_catalog', rel: INPUT },
  } as const;
  type Form = keyof typeof FORMS;
  const NAMES = Object.keys(FORMS) as Form[];
  const PLANT = [
    `CREATE TABLE ${INPUT} (sitter_id char(26) NOT NULL)`,
    `ALTER TABLE ${INPUT} OWNER TO app_ddl`,
    ...NAMES.flatMap((f) => [
      `CREATE FUNCTION public.${f}(p_id char) RETURNS void LANGUAGE plpgsql SET search_path = ${FORMS[f].path} AS
         ${body(FORMS[f].rel)}`,
      // SA §INT-10 check (8): EXECUTE revoked from PUBLIC before SECURITY DEFINER (the 0021 order).
      `REVOKE ALL ON FUNCTION public.${f}(char) FROM PUBLIC`,
      `ALTER FUNCTION public.${f}(char) OWNER TO app_ddl`,
      `ALTER FUNCTION public.${f}(char) SECURITY DEFINER`,
      `GRANT EXECUTE ON FUNCTION public.${f}(char) TO app_rw`,
    ]),
  ];
  const UNPLANT = [...NAMES.map((f) => `DROP FUNCTION public.${f}(char)`), `DROP TABLE ${INPUT}`];
  const STATE = `SELECT 'state:' || bookable_state FROM ${TABLE} WHERE id = '${SITTER}'`;
  const call = (f: Form): string => `SELECT public.${f}('${SITTER}')`;
  /** app_rw's own TEMP table under the input's name, holding a forged row, readable by the definer's owner. */
  const SHADOW = [
    'CREATE TEMP TABLE t158_cred_input (sitter_id char(26))',
    `INSERT INTO t158_cred_input VALUES ('${SITTER}')`,
    'GRANT SELECT ON t158_cred_input TO app_ddl',
  ];
  const shadowed = (f: Form): Promise<PsqlResult> =>
    asLogin(
      LOGINS.app_rw,
      READ_SITTER,
      `SELECT 'temp:' || has_database_privilege(current_database(), 'TEMP')`,
      ...SHADOW,
      call(f),
      STATE,
    );
  const assertShadowRan = (what: string, r: PsqlResult): void => {
    assertReadFirst(what, r);
    assert.ok(r.output.includes('temp:true'), `${what}: app_rw holds no TEMP:\n${r.output}`);
    assertTag(what, r, 'GRANT');
    assert.ok(r.output.includes('INSERT 0 1'), `${what}: forged row not inserted:\n${r.output}`);
  };

  test('plant (committed, as the superuser): the input table owned by app_ddl and five id-only definers, each owned by app_ddl, EXECUTE to app_rw only, with its search_path pinned', async () => {
    assertPermitted('plant', await db.psql({ commands: PLANT, verbose: true, stopOnError: true }));
    assert.equal(
      await db.value(
        `SELECT string_agg(proname || '|' || prosecdef || '|' || pg_get_userbyid(proowner) || '|' || proacl::text || '|' ||
                           array_to_string(proconfig, ','), E'\\n' ORDER BY proname)
           FROM pg_proc WHERE proname LIKE 't158\\_shadow\\_%'`,
      ),
      [...NAMES]
        .sort()
        .map(
          (f) =>
            `${f}|true|app_ddl|{app_ddl=X/app_ddl,app_rw=X/app_ddl}|search_path=${FORMS[f].path}`,
        )
        .join('\n'),
    );
  });

  test('CONTROL (as the superuser, so the definer runs as app_ddl): with a REAL input row, every form that can reach public derives bookable — each reads its input', async () => {
    for (const f of NAMES.filter((n) => n !== 't158_shadow_unqualified')) {
      const r = await asSuperuser(`INSERT INTO ${INPUT} VALUES ('${SITTER}')`, call(f), STATE);
      assertPermitted(f, r);
      assert.ok(
        r.output.includes('state:bookable'),
        `${f}: did not derive from its input:\n${r.output}`,
      );
    }
  });

  test('CONTROL (app_rw, no TEMP table, no input row): each of those four leaves the sitter onboarding; the UNQUALIFIED read under pg_catalog, pg_temp finds nothing and is REFUSED 42P01, so that slip fails every honest call', async () => {
    for (const f of NAMES.filter((n) => n !== 't158_shadow_unqualified')) {
      const r = await asLogin(LOGINS.app_rw, READ_SITTER, call(f), STATE);
      assertReadFirst(f, r);
      assert.ok(r.output.includes('state:onboarding'), `${f}:\n${r.output}`);
    }
    const r = await asLogin(LOGINS.app_rw, READ_SITTER, call('t158_shadow_unqualified'));
    assertReadFirst('unqualified, no temp', r);
    assertRefusedBy(
      'unqualified, no temp',
      r,
      'ERROR:  42P01: relation "t158_cred_input" does not exist',
    );
  });

  test('THE BYPASS (QA H03): search_path = pg_catalog, public (pg_temp unnamed, so searched first) and an unqualified read — an app_rw TEMP table with a forged row makes the uncredentialed sitter BOOKABLE', async () => {
    const r = await shadowed('t158_shadow_public');
    assertShadowRan('public', r);
    assert.ok(r.output.includes('state:bookable'), `expected the shadow to be read:\n${r.output}`);
  });

  test('THE BYPASS, with the required path: search_path = pg_catalog, pg_temp and an UNQUALIFIED read — pg_temp is the only schema on the path holding the name, so the forged row is read and the sitter becomes BOOKABLE (pg_temp last is not enough on its own)', async () => {
    const r = await shadowed('t158_shadow_unqualified');
    assertShadowRan('unqualified', r);
    assert.ok(r.output.includes('state:bookable'), `expected the shadow to be read:\n${r.output}`);
  });

  test('NOT SHADOWED (QA H04): search_path = pg_catalog, public, pg_temp (pg_temp named last) with an unqualified read — public.t158_cred_input is found first and the sitter stays onboarding', async () => {
    const r = await shadowed('t158_shadow_temp_last');
    assertShadowRan('temp last', r);
    assert.ok(r.output.includes('state:onboarding'), `the shadow was read:\n${r.output}`);
  });

  test('NOT SHADOWED — THE REQUIRED FORM: search_path = pg_catalog, pg_temp and the read schema-qualified — the sitter stays onboarding', async () => {
    const r = await shadowed('t158_shadow_required');
    assertShadowRan('required', r);
    assert.ok(r.output.includes('state:onboarding'), `the shadow was read:\n${r.output}`);
  });

  test('NOT SHADOWED — a qualified read with pg_temp UNNAMED (search_path = pg_catalog): the sitter stays onboarding, so for a relation read it is the qualification that closes the shadow', async () => {
    const r = await shadowed('t158_shadow_qualified');
    assertShadowRan('qualified', r);
    assert.ok(r.output.includes('state:onboarding'), `the shadow was read:\n${r.output}`);
  });

  test('unplant (committed): no t158_ function, table or trigger remains, and the profile row is unchanged', async () => {
    assertPermitted(
      'unplant',
      await db.psql({ commands: UNPLANT, verbose: true, stopOnError: true }),
    );
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_proc WHERE proname LIKE 't158\\_%') + (SELECT count(*) FROM pg_class WHERE relname LIKE 't158\\_%')
                + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 't158\\_%')`,
      ),
      '0',
    );
    assert.equal(await db.value(READ_SITTER), SITTER_BEFORE);
  });
});

describe('V2 — a profile belongs to an existing account (SD 2006; FK, NO ACTION)', () => {
  test(`an unknown id is REFUSED by sitter_profile_id_fkey (23503)`, async () => {
    assertRefusedBy(
      'unknown account',
      await asSuperuser(`INSERT INTO ${TABLE} (id) VALUES ('${UNKNOWN}')`),
      FK_23503('sitter_profile_id_fkey'),
      'CONSTRAINT NAME:  sitter_profile_id_fkey',
    );
  });

  test('DELETE of the referenced account is REFUSED by sitter_profile_id_fkey (23503, NO ACTION: not cascaded), even as the superuser', async () => {
    assertRefusedBy(
      'DELETE account',
      await asSuperuser(`DELETE FROM public.account WHERE id = '${SITTER}'`),
      'ERROR:  23503: update or delete on table "account" violates foreign key constraint "sitter_profile_id_fkey" on table "sitter_profile"',
      'CONSTRAINT NAME:  sitter_profile_id_fkey',
    );
    assert.equal(await db.value(READ_SITTER), SITTER_BEFORE);
  });

  test('CONTROL — an existing account id with no profile is accepted', async () => {
    assertTag('existing account', await asSuperuser(insertFresh()), 'INSERT 0 1');
  });
});

describe('V3 — an authored-locale column names a registered locale, byte for byte (SD 2010–2011)', () => {
  for (const [text, locale] of [
    ['bio', 'bio_authored_locale'],
    ['headline', 'headline_authored_locale'],
  ] as const) {
    for (const bad of ['tr', 'EN', 'en-GB']) {
      test(`${locale} '${bad}' is REFUSED by sitter_profile_${locale}_fkey (23503)`, async () => {
        assertRefusedBy(
          `${locale} ${bad}`,
          await asSuperuser(insertFresh({ [text]: `'x'`, [locale]: `'${bad}'` })),
          FK_23503(`sitter_profile_${locale}_fkey`),
          `CONSTRAINT NAME:  sitter_profile_${locale}_fkey`,
        );
      });
    }
    test(`CONTROL — ${locale} 'el' (with ${text}) and both NULL are accepted`, async () => {
      assertTag(
        `${locale} el`,
        await asSuperuser(insertFresh({ [text]: `'x'`, [locale]: `'el'` })),
        'INSERT 0 1',
      );
      assertTag(
        `${locale} NULL`,
        await asSuperuser(insertFresh({ [text]: 'NULL', [locale]: 'NULL' })),
        'INSERT 0 1',
      );
    });
  }
});

describe('V4 — enum columns accept only their declared values (as the superuser, so V1 is not what refuses)', () => {
  test(`bookable_state 'active' is REFUSED (22P02)`, async () => {
    assertRefusedBy(
      'bookable_state active',
      await asSuperuser(insertFresh({ bookable_state: `'active'` })),
      'ERROR:  22P02: invalid input value for enum bookable_state: "active"',
    );
  });
  test(`tier 'infant' is REFUSED (22P02)`, async () => {
    assertRefusedBy(
      'tier infant',
      await asSuperuser(insertFresh({ tier: `'infant'` })),
      'ERROR:  22P02: invalid input value for enum sitter_tier: "infant"',
    );
  });
  test('CONTROL — each declared value of both enums is accepted', async () => {
    for (const v of ['onboarding', 'bookable', 'review_hold', 'suspended', 'removed']) {
      assertTag(
        `bookable_state ${v}`,
        await asSuperuser(insertFresh({ bookable_state: `'${v}'` })),
        'INSERT 0 1',
      );
    }
    for (const v of ['sitter', 'childcare_professional', 'infant_qualified']) {
      assertTag(`tier ${v}`, await asSuperuser(insertFresh({ tier: `'${v}'` })), 'INSERT 0 1');
    }
  });
});

describe('V5 — base_location is one WGS 84 point (SD 2017; the column typmod, SQLSTATEs measured)', () => {
  test('a POLYGON is REFUSED (22023, typmod)', async () => {
    assertRefusedBy(
      'polygon',
      await asSuperuser(
        insertFresh({ base_location: `'SRID=4326;POLYGON((33 35,34 35,34 36,33 35))'` }),
      ),
      'ERROR:  22023: Geometry type (Polygon) does not match column type (Point)',
    );
  });
  test('a POINT with SRID 4269 (lon/lat, not 4326) is REFUSED (22023, typmod)', async () => {
    assertRefusedBy(
      'srid 4269',
      await asSuperuser(insertFresh({ base_location: `'SRID=4269;POINT(33.04 34.68)'` })),
      'ERROR:  22023: Geometry SRID (4269) does not match column SRID (4326)',
    );
  });
  test('a POINT with SRID 3857 (projected) is REFUSED (22023: geography takes lon/lat systems only, refused at the cast)', async () => {
    assertRefusedBy(
      'srid 3857',
      await asSuperuser(
        insertFresh({
          base_location: 'ST_SetSRID(ST_MakePoint(3677000, 4150000), 3857)::geography',
        }),
      ),
      'ERROR:  22023: Only lon/lat coordinate systems are supported in geography.',
    );
  });
  test('CONTROL — ST_SetSRID(ST_MakePoint(33.04, 34.68), 4326)::geography is accepted and reads back POINT(33.04 34.68), SRID 4326', async () => {
    const r = await asSuperuser(
      insertFresh({ base_location: 'ST_SetSRID(ST_MakePoint(33.04, 34.68), 4326)::geography' }),
      `SELECT 'geo:' || ST_AsText(base_location) || '|' || ST_SRID(base_location) FROM ${TABLE} WHERE id = '${FRESH}'`,
    );
    assertTag('point', r, 'INSERT 0 1');
    assert.ok(r.output.includes('geo:POINT(33.04 34.68)|4326'), r.output);
  });
});

describe('V6 — every column SD marks NOT NULL refuses NULL (23502, the column named)', () => {
  for (const column of [
    'bookable_state',
    'tier_rank',
    'travel_radius_m',
    'transport_mode',
    'travel_buffer_before',
    'travel_buffer_after',
    'currency',
    'version',
    'created_at',
  ] as const) {
    test(`${column} NULL is REFUSED (23502)`, async () => {
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(insertFresh({ [column]: 'NULL' })),
        NOTNULL_23502(column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }
  test('id NULL is REFUSED (23502)', async () => {
    assertRefusedBy(
      'id NULL',
      await asSuperuser(`INSERT INTO ${TABLE} (id) VALUES (NULL)`),
      NOTNULL_23502('id'),
      'COLUMN NAME:  id',
    );
  });
});

describe('V7 — only app_rw holds privileges, at the stated set; the SA §INT-10 guard', () => {
  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} SELECT`,
        await asLogin(LOGINS[role], `SELECT id FROM ${TABLE}`),
        DENIED,
      );
    });
  }

  // No WHERE clause on the UPDATEs and the DELETE: a WHERE needs SELECT on the columns it reads, so a
  // refusal of `… WHERE id = …` would hold even if the privilege under test were granted (found by E5 M09).
  test('app_admin_rw INSERT (id), UPDATE (bio), UPDATE (bookable_state), UPDATE (tier_rank) and DELETE, each with no WHERE, are each REFUSED (42501): nothing is granted (U-9 (a))', async () => {
    for (const sql of [
      insertFresh(),
      `UPDATE ${TABLE} SET bio = 'x', bio_authored_locale = 'el'`,
      `UPDATE ${TABLE} SET bookable_state = 'suspended'`,
      `UPDATE ${TABLE} SET tier_rank = 3`,
      `DELETE FROM ${TABLE}`,
    ]) {
      assertRefusedBy(`app_admin_rw: ${sql}`, await asLogin(LOGINS.app_admin_rw, sql), DENIED);
    }
  });

  test('app_rw DELETE of the existing row is REFUSED (42501), the row read first (U-10 (a): no role holds DELETE)', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_SITTER,
      `DELETE FROM ${TABLE} WHERE id = '${SITTER}'`,
    );
    assertReadFirst('app_rw DELETE', r);
    assertRefusedBy('app_rw DELETE', r, DENIED);
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefusedBy('app_rw TRUNCATE', await asLogin(LOGINS.app_rw, `TRUNCATE ${TABLE}`), DENIED);
  });

  test('after up, SELECT kinvara_guard.assert_answering_service_write_only() called DIRECTLY returns clean (OD-76)', async () => {
    assertPermitted(
      'direct call after up',
      await db.psql({
        commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'],
        verbose: true,
        stopOnError: true,
      }),
    );
  });

  test('GRANT SELECT on sitter_profile to answering_service is REFUSED by the guard (KV010), and lands nothing; so is a column grant', async () => {
    assertRefusedBy(
      'GRANT SELECT to answering_service',
      await asSuperuser(`GRANT SELECT ON ${TABLE} TO answering_service`),
      `ERROR:  KV010: ${INT10_RAISE}`,
      'answering_service holds SELECT on public.sitter_profile',
    );
    assertRefusedBy(
      'GRANT SELECT (id) to answering_service',
      await asSuperuser(`GRANT SELECT (id) ON ${TABLE} TO answering_service`),
      `ERROR:  KV010: ${INT10_RAISE}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', '${TABLE}', 'SELECT')::text || ' ' ||
                has_any_column_privilege('answering_service', '${TABLE}', 'SELECT')::text`,
      ),
      'false false',
    );
  });
});

describe('V8 — the eight CHECKs of EV-35 / EV-36 (as the superuser)', () => {
  const REFUSED: ReadonlyArray<
    readonly [what: string, set: Partial<Record<Column, string>>, name: string]
  > = [
    [
      "travel_buffer_before '-1 minute'",
      { travel_buffer_before: `'-1 minute'` },
      'sitter_profile_travel_buffer_before_nonneg',
    ],
    [
      "travel_buffer_after '-1 minute'",
      { travel_buffer_after: `'-1 minute'` },
      'sitter_profile_travel_buffer_after_nonneg',
    ],
    [
      'max_bookings_per_day -1',
      { max_bookings_per_day: '-1' },
      'sitter_profile_max_bookings_per_day_nonneg',
    ],
    [
      'max_consecutive_hours -1',
      { max_consecutive_hours: '-1' },
      'sitter_profile_max_consecutive_hours_nonneg',
    ],
    [
      'take_home_hourly_minor -1',
      { take_home_hourly_minor: '-1' },
      'sitter_profile_take_home_nonneg',
    ],
    [
      'per_additional_child_minor -1',
      { per_additional_child_minor: '-1' },
      'sitter_profile_per_child_nonneg',
    ],
    ['bio set, bio_authored_locale NULL', { bio: `'x'` }, 'sitter_profile_bio_locale_paired'],
    [
      'bio_authored_locale set, bio NULL',
      { bio_authored_locale: `'el'` },
      'sitter_profile_bio_locale_paired',
    ],
    [
      'headline set, headline_authored_locale NULL',
      { headline: `'x'` },
      'sitter_profile_headline_locale_paired',
    ],
    [
      'headline_authored_locale set, headline NULL',
      { headline_authored_locale: `'el'` },
      'sitter_profile_headline_locale_paired',
    ],
  ];
  for (const [what, set, name] of REFUSED) {
    test(`${what} is REFUSED by ${name} (23514)`, async () => {
      assertRefusedBy(
        what,
        await asSuperuser(insertFresh(set)),
        CHECK_23514(name),
        `CONSTRAINT NAME:  ${name}`,
      );
    });
  }

  test('app_rw UPDATE of bio alone on a row with no locale is REFUSED by sitter_profile_bio_locale_paired (23514): the CHECK binds the application role too', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_SITTER,
      `UPDATE ${TABLE} SET bio = 'x' WHERE id = '${SITTER}'`,
    );
    assertReadFirst('app_rw bio alone', r);
    assertRefusedBy(
      'app_rw bio alone',
      r,
      CHECK_23514('sitter_profile_bio_locale_paired'),
      'CONSTRAINT NAME:  sitter_profile_bio_locale_paired',
    );
  });

  test("CONTROL — zero is accepted in every bounded column (buffers '0', limits and money 0)", async () => {
    assertTag(
      'zeros',
      await asSuperuser(
        insertFresh({
          travel_buffer_before: `'0'`,
          travel_buffer_after: `'0 minutes'`,
          max_bookings_per_day: '0',
          max_consecutive_hours: '0',
          take_home_hourly_minor: '0',
          per_additional_child_minor: '0',
        }),
      ),
      'INSERT 0 1',
    );
  });

  test('CONTROL — NULL is accepted in the four nullable bounded columns; paired text+locale and both-NULL pairs are accepted', async () => {
    assertTag(
      'nulls',
      await asSuperuser(
        insertFresh({
          max_bookings_per_day: 'NULL',
          max_consecutive_hours: 'NULL',
          take_home_hourly_minor: 'NULL',
          per_additional_child_minor: 'NULL',
          bio: 'NULL',
          bio_authored_locale: 'NULL',
          headline: 'NULL',
          headline_authored_locale: 'NULL',
        }),
      ),
      'INSERT 0 1',
    );
    assertTag(
      'paired',
      await asSuperuser(
        insertFresh({
          bio: `'x'`,
          bio_authored_locale: `'ru'`,
          headline: `'y'`,
          headline_authored_locale: `'en'`,
        }),
      ),
      'INSERT 0 1',
    );
  });

  test('CONTROL — a money value above 2^53 (9007199254740993) is stored and read back exactly (bigint; OD-107)', async () => {
    const r = await asSuperuser(
      insertFresh({
        take_home_hourly_minor: '9007199254740993',
        per_additional_child_minor: '9007199254740993',
      }),
      `SELECT 'money:' || take_home_hourly_minor || '|' || per_additional_child_minor FROM ${TABLE} WHERE id = '${FRESH}'`,
    );
    assertTag('2^53+1', r, 'INSERT 0 1');
    assert.ok(r.output.includes('money:9007199254740993|9007199254740993'), r.output);
  });
});

describe('what the database does NOT refuse (stated bounds; each pinned so a change to it is seen)', () => {
  test('NOT HELD — tier and tier_rank are not coupled (E.4 U-4: no CHECK): tier NULL with rank 3, infant_qualified with rank 0', async () => {
    assertTag(
      'tier NULL rank 3',
      await asSuperuser(insertFresh({ tier: 'NULL', tier_rank: '3' })),
      'INSERT 0 1',
    );
    assertTag(
      'infant rank 0',
      await asSuperuser(insertFresh({ tier: `'infant_qualified'`, tier_rank: '0' })),
      'INSERT 0 1',
    );
  });

  test("NOT HELD — bookable_state 'bookable' with a NULL base_location, and bookable_since set while 'onboarding' (no CHECK; the derivation's job, T-028)", async () => {
    assertTag(
      'bookable without location',
      await asSuperuser(insertFresh({ bookable_state: `'bookable'` })),
      'INSERT 0 1',
    );
    assertTag(
      'since while onboarding',
      await asSuperuser(insertFresh({ bookable_since: 'now()' })),
      'INSERT 0 1',
    );
  });

  test("NOT HELD — no CHECK on travel_radius_m, the uplifts, transport_mode or currency (E.4 U-6): -1 radius, -50.0 uplift, free-text mode, currency 'xyz' are accepted", async () => {
    assertTag(
      'unbounded columns',
      await asSuperuser(
        insertFresh({
          travel_radius_m: '-1',
          weekend_uplift_pct: '-50.0',
          after_22_uplift_pct: '999.9',
          transport_mode: `'hovercraft'`,
          currency: `'xyz'`,
        }),
      ),
      'INSERT 0 1',
    );
  });

  test("NOT HELD — app_rw may set version to any integer (no CHECK, no trigger): the optimistic lock is the application's", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_SITTER,
      `UPDATE ${TABLE} SET version = -7 WHERE id = '${SITTER}'`,
    );
    assertReadFirst('version -7', r);
    assertTag('version -7', r, 'UPDATE 1');
  });

  test("NOT HELD — the _nonneg interval CHECKs (`>= interval '0'`) accept MIXED-SIGN intervals and infinity, as app_rw: '1 mon -30 days', '1 day -24:00:00', '-1 mons +30 days', 'infinity'. PostgreSQL compares intervals with 1 mon = 30 days and 1 day = 24 h, but date arithmetic does not: start - '1 mon -30 days' is 2 days AFTER a 2026-03-01 start (any TimeZone), and start - '1 day -24:00:00' is 1 hour AFTER a 2026-03-29 start across the spring-forward under TimeZone Europe/Nicosia (0 under UTC); 0 on a 2026-07-15 control", async () => {
    const SHIFT = `SELECT 'shift:' || string_agg(k || '=' || ((s - b) - s)::text, '|' ORDER BY k)
                     FROM ${TABLE} p, LATERAL (VALUES
                       ('a 03-01 before', timestamptz '2026-03-01 18:00:00 Europe/Nicosia', p.travel_buffer_before),
                       ('b 07-15 before', timestamptz '2026-07-15 18:00:00 Europe/Nicosia', p.travel_buffer_before),
                       ('c 03-29 after', timestamptz '2026-03-29 18:00:00 Europe/Nicosia', p.travel_buffer_after),
                       ('d 07-15 after', timestamptz '2026-07-15 18:00:00 Europe/Nicosia', p.travel_buffer_after)) v(k, s, b)
                    WHERE p.id = '${SITTER}'`;
    const r = await asLogin(
      LOGINS.app_rw,
      READ_SITTER,
      `UPDATE ${TABLE} SET travel_buffer_before = '1 mon -30 days', travel_buffer_after = '1 day -24:00:00' WHERE id = '${SITTER}'`,
      `SELECT 'buffers:' || travel_buffer_before || '|' || travel_buffer_after FROM ${TABLE} WHERE id = '${SITTER}'`,
      `SET LOCAL TimeZone = 'Europe/Nicosia'`,
      SHIFT,
      `SET LOCAL TimeZone = 'UTC'`,
      SHIFT,
      `UPDATE ${TABLE} SET travel_buffer_before = '-1 mon +30 days', travel_buffer_after = 'infinity' WHERE id = '${SITTER}'`,
      `SELECT 'buffers:' || travel_buffer_before || '|' || travel_buffer_after FROM ${TABLE} WHERE id = '${SITTER}'`,
    );
    assertReadFirst('mixed-sign intervals', r);
    assertTag('mixed-sign intervals', r, 'UPDATE 1');
    for (const line of [
      'buffers:1 mon -30 days|1 day -24:00:00',
      'shift:a 03-01 before=2 days|b 07-15 before=00:00:00|c 03-29 after=01:00:00|d 07-15 after=00:00:00',
      'shift:a 03-01 before=2 days|b 07-15 before=00:00:00|c 03-29 after=00:00:00|d 07-15 after=00:00:00',
      'buffers:-1 mons +30 days|infinity',
    ]) {
      assert.ok(r.output.includes(line), `expected ${JSON.stringify(line)}:\n${r.output}`);
    }
  });

  test('NOT HELD — base_location (geography(Point,4326)) accepts POINT EMPTY and POINT(NaN NaN), and COERCES POINT(200 95) to POINT(-160 85) with a NOTICE only, as app_rw', async () => {
    const LOC = `SELECT 'loc:' || ST_AsEWKT(base_location) FROM ${TABLE} WHERE id = '${SITTER}'`;
    const set = (wkt: string): string =>
      `UPDATE ${TABLE} SET base_location = 'SRID=4326;${wkt}' WHERE id = '${SITTER}'`;
    const r = await asLogin(
      LOGINS.app_rw,
      READ_SITTER,
      set('POINT EMPTY'),
      LOC,
      set('POINT(NaN NaN)'),
      LOC,
      set('POINT(200 95)'),
      LOC,
    );
    assertReadFirst('point edges', r);
    assertTag('point edges', r, 'UPDATE 1');
    for (const line of [
      'loc:SRID=4326;POINT EMPTY',
      'loc:SRID=4326;POINT(NaN NaN)',
      'Coordinate values were coerced into range [-180 -90, 180 90] for GEOGRAPHY',
      'loc:SRID=4326;POINT(-160 85)',
    ]) {
      assert.ok(r.output.includes(line), `expected ${JSON.stringify(line)}:\n${r.output}`);
    }
  });

  test("NOT HELD — a blank bio with a locale is accepted: the pairing CHECK tests NULL, not content (bio '' with 'el')", async () => {
    assertTag(
      'blank bio',
      await asSuperuser(insertFresh({ bio: `''`, bio_authored_locale: `'el'` })),
      'INSERT 0 1',
    );
  });
});

describe('0025 — after every case', () => {
  test('the table still holds exactly the one committed fixture row, at its defaults', async () => {
    assert.equal(await db.value(`SELECT count(*) || ' row(s)' FROM ${TABLE}`), '1 row(s)');
    assert.equal(await db.value(READ_SITTER), SITTER_BEFORE);
  });
});
