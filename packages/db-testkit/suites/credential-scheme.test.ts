/**
 * T-251 — `public.credential_scheme` (migration 0024): SD §DB-4 lines 2073–2107 as ruled in
 * tasks/state/EP-5/CUT-T-060.md §1 (R-3 the closed `mandatory_rules` v1 grammar with no default; R-4
 * the IDENTITY key; R-5 `check_type` per seed row; R-6 `en` + `el` names and the object CHECK; R-9
 * grants; R-10 the interim CHECKs on the text columns, accepted by the stakeholder as S-1 (a) (ii)).
 * These are the database-layer refusals `T-060.md` § Migration request › MR-1 and the T-251 role-file
 * row list, the two seed rows ("seed applies"), and what the database does NOT refuse.
 *
 * The table's catalogue is pinned: its columns (type, nullability, default, identity), owner, ACL,
 * its whole constraint set by name and definition (NOT NULL constraints included, contype 'n' on
 * PostgreSQL 18), its indexes, its identity sequence's owner and ACL, its three comments, and in ONE
 * assertion the counts of its non-internal triggers, rewrite rules and policies with both row-level
 * security flags ('0 triggers, 0 rules, rls=false, force=false, 0 policies'; tech-lead.md failure
 * mode 5). So a constraint, grant, index, trigger, rule or policy added to or removed from the table
 * turns a case red. What is not in those catalogues is not pinned (for example an event trigger, or
 * a function no trigger on this table calls), and a change that keeps every reading here cannot
 * turn a case red.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field, and exactly one ERROR line,
 * so a crash, a syntax error or a refusal for another reason cannot read as this one. Each rule has
 * a CONTROL beside it that differs from a refused case only in the value under test.
 *
 * Every UPDATE or DELETE refusal first reads its target row in the same psql session and asserts
 * that reading, so a statement that matched no row can pass for neither a refusal nor a control.
 *
 * Privilege refusals run over REAL LOGIN principals, each a member of exactly one role (T-020
 * Evidence §4). Constraint refusals run as the superuser, so no privilege is what refuses them.
 * Every write runs inside a transaction that is never committed (`inTransaction`), so the seed rows
 * are the table's only rows throughout, and the last test of the file re-reads them.
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

const SUITE = 'credential-scheme';
const TABLE = 'public.credential_scheme';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't251_app_rw_probe',
  app_admin_rw: 't251_app_admin_rw_probe',
  app_safety_rw: 't251_app_safety_rw_probe',
  answering_service: 't251_answering_service_probe',
} as const;

/**
 * The `el` names, copied byte for byte from PM §MVP-S3's table (product-manager.md lines 678–679)
 * by a script, not typed (T-251 evidence E3 diffs them against the PM file). Note the Greek capital
 * Nu and Iota in `Ν.91(Ι)`.
 */
const EL_ART22 = 'Πιστοποιητικό βάσει του άρθρου 22(6) του Ν.91(Ι)/2014';
const EL_WHITE = 'Πιστοποιητικό Λευκού Ποινικού Μητρώου';
const V1 = '{"v": 1, "mandatory": "all_tiers"}';

/** The two seed rows, as `psql -A -t` prints them, ordered by scheme_name (COLLATE "C"). */
const SEED_ROWS = [
  'CY|child_protection_register|Certificate under Art. 22(6), Law 91(I)/2014|' +
    `{"el": "${EL_ART22}", "en": "Certificate under Article 22(6) of Law 91(I)/2014"}|` +
    `Cyprus Police|point_in_time_annual_reissue|12|3|-|-|NULL|${V1}`,
  'CY|criminal_record|White Criminal Record Certificate|' +
    `{"el": "${EL_WHITE}", "en": "White Criminal Record Certificate"}|` +
    `Cyprus Police|point_in_time_annual_reissue|12|3|-|-|NULL|${V1}`,
].join('\n');
const SEED_SQL = `SELECT jurisdiction, check_type, scheme_name, scheme_name_i18n, issuing_body, validity_model,
                         coalesce(default_validity_months::text, '-'), coalesce(max_age_at_submission_months::text, '-'),
                         coalesce(attestation_interval_days::text, '-'), coalesce(attestation_grace_days::text, '-'),
                         coalesce(reference_format_regex, 'NULL'), mandatory_rules
                    FROM ${TABLE} ORDER BY scheme_name COLLATE "C"`;

/** The texts 0024 installs, verbatim: a change to a comment must change this suite too. */
const TABLE_COMMENT =
  'Credential schemes per jurisdiction (SD §DB-4, SA §DA-4r). Reference data written only by migrations; ' +
  'app_rw reads it. A scheme name is data, never a column, type or enum value.';
const REGEX_COMMENT =
  'The certificate-reference format, as data. NULL means record the reference verbatim and validate ' +
  'nothing (SQ-25). No reference format is encoded in DDL.';
const RULES_COMMENT =
  'Who must hold this scheme. Grammar v1 has one value, {"v": 1, "mandatory": "all_tiers"}. A reader ' +
  'that cannot parse a value treats the scheme as unmet (not bookable), never as optional.';

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

/** Column → SQL literal for a well-formed row; each case overrides one column. */
const GOOD: Readonly<Record<string, string>> = {
  jurisdiction: `'GR'`,
  check_type: `'identity'`,
  scheme_name: `'t251 control scheme'`,
  scheme_name_i18n: `'{"en": "T-251 control"}'`,
  issuing_body: `'t251 issuer'`,
  validity_model: `'expiring'`,
  reference_format_regex: 'NULL',
  mandatory_rules: `'${V1}'`,
};

/** An INSERT of GOOD with `overrides` applied; a value of `undefined` omits the column. */
function insertRow(overrides: Readonly<Record<string, string | undefined>> = {}): string {
  const row: Record<string, string | undefined> = { ...GOOD, ...overrides };
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const CHECK_23514 = (name: string): string =>
  `ERROR:  23514: new row for relation "credential_scheme" violates check constraint "${name}"`;
const NOTNULL_23502 = (column: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "credential_scheme" violates not-null constraint`;
const DENIED = 'ERROR:  42501: permission denied for table credential_scheme';
const WHITE_BEFORE = 'White Criminal Record Certificate|criminal_record';
const READ_WHITE = `SELECT scheme_name || '|' || check_type FROM ${TABLE}
                     WHERE jurisdiction = 'CY' AND scheme_name = 'White Criminal Record Certificate'`;

describe('0024 — the table, its owner, columns, constraints, indexes, sequence, ACL and comments', () => {
  test("SD 2073–2107's thirteen columns in SD's order; id integer GENERATED ALWAYS AS IDENTITY (R-4); scheme_name_i18n DEFAULT '{}'; mandatory_rules NOT NULL with NO default (R-3); owner app_ddl; ACL app_rw SELECT only, no column ACL (R-9)", async () => {
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
      'id:integer:nn:-:a,jurisdiction:text:nn:-:-,check_type:text:nn:-:-,scheme_name:text:nn:-:-,' +
        "scheme_name_i18n:jsonb:nn:'{}'::jsonb:-,issuing_body:text:nn:-:-,validity_model:text:nn:-:-," +
        'default_validity_months:integer:null:-:-,max_age_at_submission_months:integer:null:-:-,' +
        'attestation_interval_days:integer:null:-:-,attestation_grace_days:integer:null:-:-,' +
        'reference_format_regex:text:null:-:-,mandatory_rules:jsonb:nn:-:-' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}|no column ACL',
    );
  });

  test('the constraint set is exactly these names and definitions: PK, UNIQUE (SD 2106), the two SD CHECKs (eight check_type values, five validity_model values), R-3, R-6, the four R-10 CHECKs, and the eight NOT NULLs; no FOREIGN KEY, no EXCLUDE, none deferrable', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || ' ' || contype::text || ' ' || condeferrable::text || ' ' ||
                           pg_get_constraintdef(oid), E'\\n' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass`,
      ),
      [
        "credential_scheme_check_type_check c false CHECK ((check_type = ANY (ARRAY['criminal_record'::text, 'child_protection_register'::text, 'identity'::text, 'right_to_work'::text, 'qualification'::text, 'insurance'::text, 'attestation'::text, 'training'::text])))",
        'credential_scheme_check_type_not_null n false NOT NULL check_type',
        'credential_scheme_id_not_null n false NOT NULL id',
        "credential_scheme_issuing_body_bounds c false CHECK (((btrim(issuing_body) <> ''::text) AND (char_length(issuing_body) <= 200)))",
        'credential_scheme_issuing_body_not_null n false NOT NULL issuing_body',
        "credential_scheme_jurisdiction_alpha2 c false CHECK ((jurisdiction ~ '^[A-Z]{2}$'::text))",
        'credential_scheme_jurisdiction_not_null n false NOT NULL jurisdiction',
        'credential_scheme_jurisdiction_scheme_name_key u false UNIQUE (jurisdiction, scheme_name)',
        'credential_scheme_mandatory_rules_not_null n false NOT NULL mandatory_rules',
        `credential_scheme_mandatory_rules_v1 c false CHECK ((mandatory_rules = '${V1}'::jsonb))`,
        'credential_scheme_pkey p false PRIMARY KEY (id)',
        'credential_scheme_reference_format_regex_bounds c false CHECK (((reference_format_regex IS NULL) OR ((char_length(reference_format_regex) >= 1) AND (char_length(reference_format_regex) <= 512))))',
        "credential_scheme_scheme_name_bounds c false CHECK (((btrim(scheme_name) <> ''::text) AND (char_length(scheme_name) <= 200)))",
        'credential_scheme_scheme_name_i18n_not_null n false NOT NULL scheme_name_i18n',
        "credential_scheme_scheme_name_i18n_object c false CHECK ((jsonb_typeof(scheme_name_i18n) = 'object'::text))",
        'credential_scheme_scheme_name_not_null n false NOT NULL scheme_name',
        "credential_scheme_validity_model_check c false CHECK ((validity_model = ANY (ARRAY['point_in_time_annual_reissue'::text, 'periodic_attestation'::text, 'expiring'::text, 'point_in_time'::text, 'continuously_monitored'::text])))",
        'credential_scheme_validity_model_not_null n false NOT NULL validity_model',
      ].join('\n'),
    );
  });

  test('the indexes are exactly the PK and the UNIQUE (SD 4035: a handful of rows, read whole)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text)
           FROM pg_index WHERE indrelid = '${TABLE}'::regclass`,
      ),
      'CREATE UNIQUE INDEX credential_scheme_jurisdiction_scheme_name_key ON public.credential_scheme USING btree (jurisdiction, scheme_name) ; ' +
        'CREATE UNIQUE INDEX credential_scheme_pkey ON public.credential_scheme USING btree (id)',
    );
  });

  test('0 non-internal triggers, 0 rewrite rules, no row-level security, 0 policies (credential_scheme is not on SD 1309/3906\'s RLS list; OD-223)', async () => {
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

  test('the identity sequence credential_scheme_id_seq is owned by app_ddl, carries no grant to any role (R-4), and is the only sequence the table owns', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(s.relname || ' ' || pg_get_userbyid(s.relowner) || ' ' || coalesce(s.relacl::text, 'NULL'), ' ; ')
           FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
          WHERE d.refobjid = '${TABLE}'::regclass AND d.classid = 'pg_class'::regclass`,
      ),
      'credential_scheme_id_seq app_ddl NULL',
    );
  });

  test('no role but app_ddl (owner) and app_rw holds any privilege on the table or its sequence, PUBLIC included (superusers, predefined pg_* roles and this suite\'s own t251_* probe logins, each a member of one role, are not read)', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(DISTINCT r.rolname, ',' ORDER BY r.rolname), '(none)')
           FROM (SELECT rolname FROM pg_roles UNION ALL SELECT 'public') r(rolname)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
          WHERE r.rolname NOT IN ('app_ddl') AND r.rolname NOT LIKE 'pg\\_%' AND r.rolname NOT LIKE 't251\\_%'
            AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = r.rolname) IS TRUE
            AND (has_table_privilege(r.rolname, '${TABLE}', p)
                 OR (p IN ('SELECT','UPDATE') AND has_sequence_privilege(r.rolname, 'public.credential_scheme_id_seq', p))
                 OR (p = 'SELECT' AND has_sequence_privilege(r.rolname, 'public.credential_scheme_id_seq', 'USAGE')))`,
      ),
      'app_rw',
    );
  });

  test('COMMENT ON TABLE and the two column comments are exactly these texts, and no other column carries one', async () => {
    assert.equal(await db.value(`SELECT obj_description('${TABLE}'::regclass, 'pg_class')`), TABLE_COMMENT);
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || col_description(attrelid, attnum), E'\\n' ORDER BY attnum)
           FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attnum > 0
            AND col_description(attrelid, attnum) IS NOT NULL`,
      ),
      `reference_format_regex=${REGEX_COMMENT}\nmandatory_rules=${RULES_COMMENT}`,
    );
  });
});

describe('0024 — the seed: exactly the two CY schemes (SD 3103, 3622; PM §MVP-S3; R-5, R-6)', () => {
  test('seed applies: exactly 2 rows, both CY, both point_in_time_annual_reissue, 12/3, no attestation interval, regex NULL, mandatory_rules v1, names en + el', async () => {
    const r = await db.psql({ commands: [SEED_SQL], raw: true });
    assertPermitted('read the seed rows', r);
    assert.equal(r.stdout.trim(), SEED_ROWS);
  });

  test('every scheme_name_i18n key of every row is a locale_registry.code, and the key set is exactly {el, en}: no ru (R-6)', async () => {
    assert.equal(
      await db.value(
        `SELECT count(*) FILTER (WHERE l.code IS NULL) || ' unregistered; keys ' ||
                string_agg(DISTINCT k.key, ',' ORDER BY k.key)
           FROM ${TABLE} s CROSS JOIN LATERAL jsonb_object_keys(s.scheme_name_i18n) k(key)
           LEFT JOIN public.locale_registry l ON l.code = k.key`,
      ),
      '0 unregistered; keys el,en',
    );
  });

  test('no row is continuously_monitored, and the ids are the identity\'s 1 and 2 (seeded with no id; R-4)', async () => {
    assert.equal(
      await db.value(
        `SELECT count(*) FILTER (WHERE validity_model = 'continuously_monitored') || ' monitored; ids ' ||
                string_agg(id::text, ',' ORDER BY id) FROM ${TABLE}`,
      ),
      '0 monitored; ids 1,2',
    );
  });
});

describe('0024 — constraint refusals (as the superuser, in a transaction never committed)', () => {
  test('CONTROL — a well-formed row is accepted; scheme_name_i18n takes its default {} when omitted', async () => {
    const r = await asSuperuser(
      insertRow({ scheme_name_i18n: undefined }),
      `SELECT 'i18n=' || scheme_name_i18n::text FROM ${TABLE} WHERE scheme_name = 't251 control scheme'`,
    );
    assertInsertedOne('well-formed row', r);
    assert.ok(r.output.includes('i18n={}'), `default not applied:\n${r.output}`);
  });

  test("check_type 'barred_list' (the UK value SD 2062–2064 retired) is REFUSED by credential_scheme_check_type_check (23514)", async () => {
    assertRefusedBy(
      "check_type 'barred_list'",
      await asSuperuser(insertRow({ check_type: `'barred_list'` })),
      CHECK_23514('credential_scheme_check_type_check'),
      'CONSTRAINT NAME:  credential_scheme_check_type_check',
    );
  });

  test("validity_model 'monitored' is REFUSED by credential_scheme_validity_model_check (23514)", async () => {
    assertRefusedBy(
      "validity_model 'monitored'",
      await asSuperuser(insertRow({ validity_model: `'monitored'` })),
      CHECK_23514('credential_scheme_validity_model_check'),
      'CONSTRAINT NAME:  credential_scheme_validity_model_check',
    );
  });

  test("POSITIVE — validity_model 'continuously_monitored' is ACCEPTED (SD 2088: retained, unused in CY), and rolled back", async () => {
    assertInsertedOne(
      'continuously_monitored',
      await asSuperuser(insertRow({ validity_model: `'continuously_monitored'` })),
    );
  });

  test("a second ('CY', 'White Criminal Record Certificate') is REFUSED by credential_scheme_jurisdiction_scheme_name_key (23505)", async () => {
    assertRefusedBy(
      'duplicate White',
      await asSuperuser(
        insertRow({ jurisdiction: `'CY'`, scheme_name: `'White Criminal Record Certificate'` }),
      ),
      'ERROR:  23505: duplicate key value violates unique constraint "credential_scheme_jurisdiction_scheme_name_key"',
      'CONSTRAINT NAME:  credential_scheme_jurisdiction_scheme_name_key',
    );
  });

  test("CONTROL — the same scheme_name under another jurisdiction is accepted", async () => {
    assertInsertedOne(
      'White under GR',
      await asSuperuser(insertRow({ scheme_name: `'White Criminal Record Certificate'` })),
    );
  });

  const RULES_REFUSED: ReadonlyArray<readonly [what: string, value: string]> = [
    ["'{}' (the value OD-309 shows a reader could take as not mandatory)", `'{}'`],
    [`'{"v":1,"mandatory":"none"}'`, `'{"v":1,"mandatory":"none"}'`],
    ['a v1 value with an extra key', `'{"v": 1, "mandatory": "all_tiers", "tier": "any"}'`],
    ['v as a string', `'{"v": "1", "mandatory": "all_tiers"}'`],
    ['v2', `'{"v": 2, "mandatory": "all_tiers"}'`],
    ['a JSON null', `'null'`],
  ];
  for (const [what, value] of RULES_REFUSED) {
    test(`mandatory_rules ${what} is REFUSED by credential_scheme_mandatory_rules_v1 (23514)`, async () => {
      assertRefusedBy(
        `mandatory_rules ${what}`,
        await asSuperuser(insertRow({ mandatory_rules: value })),
        CHECK_23514('credential_scheme_mandatory_rules_v1'),
        'CONSTRAINT NAME:  credential_scheme_mandatory_rules_v1',
      );
    });
  }

  test('an INSERT omitting mandatory_rules is REFUSED by its NOT NULL (23502): there is no default to fall back on (R-3)', async () => {
    assertRefusedBy(
      'mandatory_rules omitted',
      await asSuperuser(insertRow({ mandatory_rules: undefined })),
      NOTNULL_23502('mandatory_rules'),
      'COLUMN NAME:  mandatory_rules',
    );
  });

  test('CONTROL — v1 with its keys reordered and respaced is accepted (jsonb equality ignores key order and whitespace)', async () => {
    assertInsertedOne(
      'v1 reordered',
      await asSuperuser(insertRow({ mandatory_rules: `'{"mandatory":"all_tiers",   "v":1}'` })),
    );
  });

  const JURISDICTION_REFUSED: ReadonlyArray<readonly [what: string, value: string]> = [
    ["'cy'", `'cy'`],
    ["'CYP'", `'CYP'`],
    ["'C'", `'C'`],
    ["'Gr'", `'Gr'`],
    ["'CY' followed by a newline", `E'CY\\n'`],
    ["Greek capitals 'ΚΥ'", `'ΚΥ'`],
  ];
  for (const [what, value] of JURISDICTION_REFUSED) {
    test(`jurisdiction ${what} is REFUSED by credential_scheme_jurisdiction_alpha2 (23514; R-10)`, async () => {
      assertRefusedBy(
        `jurisdiction ${what}`,
        await asSuperuser(insertRow({ jurisdiction: value })),
        CHECK_23514('credential_scheme_jurisdiction_alpha2'),
        'CONSTRAINT NAME:  credential_scheme_jurisdiction_alpha2',
      );
    });
  }

  const BOUNDS_REFUSED: ReadonlyArray<readonly [column: string, what: string, value: string]> = [
    ['scheme_name', "''", `''`],
    ['scheme_name', 'three spaces', `'   '`],
    ['scheme_name', '201 characters', `repeat('x', 201)`],
    ['issuing_body', "''", `''`],
    ['issuing_body', 'a space', `' '`],
    ['issuing_body', '201 characters', `repeat('x', 201)`],
  ];
  for (const [column, what, value] of BOUNDS_REFUSED) {
    test(`${column} ${what} is REFUSED by credential_scheme_${column}_bounds (23514; R-10)`, async () => {
      assertRefusedBy(
        `${column} ${what}`,
        await asSuperuser(insertRow({ [column]: value })),
        CHECK_23514(`credential_scheme_${column}_bounds`),
        `CONSTRAINT NAME:  credential_scheme_${column}_bounds`,
      );
    });
  }

  test('CONTROL — scheme_name and issuing_body of exactly 200 characters are accepted', async () => {
    assertInsertedOne(
      '200 characters',
      await asSuperuser(
        insertRow({ scheme_name: `repeat('n', 200)`, issuing_body: `repeat('b', 200)` }),
      ),
    );
  });

  test("reference_format_regex '' and 513 characters are each REFUSED by credential_scheme_reference_format_regex_bounds (23514; R-10)", async () => {
    for (const value of [`''`, `repeat('x', 513)`]) {
      assertRefusedBy(
        `reference_format_regex ${value}`,
        await asSuperuser(insertRow({ reference_format_regex: value })),
        CHECK_23514('credential_scheme_reference_format_regex_bounds'),
        'CONSTRAINT NAME:  credential_scheme_reference_format_regex_bounds',
      );
    }
  });

  test('CONTROL — reference_format_regex NULL, one character and 512 characters are accepted; the bound is on the stored pattern, not on any reference', async () => {
    for (const value of ['NULL', `'.'`, `repeat('x', 512)`]) {
      assertInsertedOne(
        `reference_format_regex ${value}`,
        await asSuperuser(insertRow({ reference_format_regex: value })),
      );
    }
  });

  test('scheme_name_i18n an array, a string or a JSON null is REFUSED by credential_scheme_scheme_name_i18n_object (23514; R-6)', async () => {
    for (const value of [`'[]'`, `'"Certificate"'`, `'null'`]) {
      assertRefusedBy(
        `scheme_name_i18n ${value}`,
        await asSuperuser(insertRow({ scheme_name_i18n: value })),
        CHECK_23514('credential_scheme_scheme_name_i18n_object'),
        'CONSTRAINT NAME:  credential_scheme_scheme_name_i18n_object',
      );
    }
  });

  const NULLED = ['jurisdiction', 'check_type', 'scheme_name', 'scheme_name_i18n', 'issuing_body', 'validity_model'];
  for (const column of NULLED) {
    test(`${column} NULL is REFUSED by its NOT NULL (23502)`, async () => {
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(insertRow({ [column]: 'NULL' })),
        NOTNULL_23502(column),
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('an explicit id is REFUSED (428C9: GENERATED ALWAYS; measured, T-251), even by the superuser', async () => {
    assertRefusedBy(
      'explicit id',
      await asSuperuser(
        insertRow({}).replace(`(${Object.keys(GOOD).join(', ')})`, `(id, ${Object.keys(GOOD).join(', ')})`)
          .replace('VALUES (', 'VALUES (99, '),
      ),
      'ERROR:  428C9: cannot insert a non-DEFAULT value into column "id"',
    );
  });
});

describe('0024 — what the database does NOT refuse (stated bounds, each pinned so a change to it is seen)', () => {
  test('NOT HELD — the owner or superuser can supply an id with OVERRIDING SYSTEM VALUE', async () => {
    assertInsertedOne(
      'OVERRIDING SYSTEM VALUE',
      await asSuperuser(
        insertRow({})
          .replace(`(${Object.keys(GOOD).join(', ')})`, `(id, ${Object.keys(GOOD).join(', ')})`)
          .replace(') VALUES (', ') OVERRIDING SYSTEM VALUE VALUES (99, '),
      ),
    );
  });

  test('NOT HELD — btrim strips spaces only: a scheme_name of a tab, or of a newline, is accepted (R-10 as ruled)', async () => {
    for (const value of [`E'\\t'`, `E'\\n'`]) {
      assertInsertedOne(`scheme_name ${value}`, await asSuperuser(insertRow({ scheme_name: value })));
    }
  });

  test('NOT HELD — a scheme_name_i18n key that is not a locale_registry.code is accepted (keys are not constrained in DDL; R-6)', async () => {
    assertInsertedOne(
      'i18n key xx',
      await asSuperuser(insertRow({ scheme_name_i18n: `'{"xx": "unregistered"}'` })),
    );
  });

  test('NOT HELD — the integer columns carry no range: -1 months, 0 days are accepted', async () => {
    const sql = insertRow({})
      .replace(') VALUES (', ', default_validity_months, max_age_at_submission_months, attestation_interval_days, attestation_grace_days) VALUES (')
      .replace(/\)$/, ', -1, -1, 0, 0)');
    assertInsertedOne('negative months', await asSuperuser(sql));
  });

  test("NOT HELD — mandatory_rules v1 with v written 1.0 is accepted (jsonb numeric equality: 1.0 = 1)", async () => {
    assertInsertedOne(
      'v 1.0',
      await asSuperuser(insertRow({ mandatory_rules: `'{"v": 1.0, "mandatory": "all_tiers"}'` })),
    );
  });
});

describe('0024 — grants: app_rw reads, and nothing else is granted (R-9)', () => {
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

  test('app_rw SELECT is PERMITTED (Q-1\'s column list), and reads the two CY schemes', async () => {
    const r = await db.psql({
      user: LOGINS.app_rw,
      password: PROBE_PASSWORD,
      raw: true,
      commands: [
        `SELECT count(*) || ' ' || string_agg(check_type, ',' ORDER BY check_type)
           FROM (SELECT id, jurisdiction, check_type, scheme_name, scheme_name_i18n, issuing_body, validity_model,
                        default_validity_months, max_age_at_submission_months, attestation_interval_days,
                        attestation_grace_days, reference_format_regex, mandatory_rules
                   FROM ${TABLE} WHERE jurisdiction = 'CY') q`,
      ],
    });
    assertPermitted('app_rw SELECT', r);
    assert.equal(r.stdout.trim(), '2 child_protection_register,criminal_record');
  });

  test('app_rw INSERT is REFUSED (42501)', async () => {
    assertRefusedBy('app_rw INSERT', await asLogin(LOGINS.app_rw, insertRow({})), DENIED);
  });

  test('app_rw UPDATE of an existing row is REFUSED (42501), the row read first', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_WHITE,
      `UPDATE ${TABLE} SET mandatory_rules = '{}' WHERE scheme_name = 'White Criminal Record Certificate'`,
    );
    assert.ok(r.output.includes(WHITE_BEFORE), `precondition not read:\n${r.output}`);
    assertRefusedBy('app_rw UPDATE', r, DENIED);
  });

  test('app_rw DELETE of an existing row is REFUSED (42501), the row read first', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      READ_WHITE,
      `DELETE FROM ${TABLE} WHERE scheme_name = 'White Criminal Record Certificate'`,
    );
    assert.ok(r.output.includes(WHITE_BEFORE), `precondition not read:\n${r.output}`);
    assertRefusedBy('app_rw DELETE', r, DENIED);
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefusedBy('app_rw TRUNCATE', await asLogin(LOGINS.app_rw, `TRUNCATE ${TABLE}`), DENIED);
  });

  test('app_rw nextval on the identity sequence is REFUSED (42501): no sequence grant (R-4)', async () => {
    assertRefusedBy(
      'app_rw nextval',
      await asLogin(LOGINS.app_rw, `SELECT nextval('public.credential_scheme_id_seq')`),
      'ERROR:  42501: permission denied for sequence credential_scheme_id_seq',
    );
  });

  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefusedBy(
        `${role} SELECT`,
        await asLogin(LOGINS[role], `SELECT id FROM ${TABLE}`),
        DENIED,
      );
    });
  }
});

describe('0024 — the SA §INT-10 guard, called DIRECTLY (OD-76)', () => {
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

  test('GRANT SELECT on credential_scheme to answering_service is REFUSED by the guard (KV010), and lands nothing', async () => {
    assertRefusedBy(
      'GRANT SELECT to answering_service',
      await asSuperuser(`GRANT SELECT ON ${TABLE} TO answering_service`),
      `ERROR:  KV010: ${INT10_RAISE}`,
      'answering_service holds SELECT on public.credential_scheme',
    );
    assert.equal(
      await db.value(`SELECT has_table_privilege('answering_service', '${TABLE}', 'SELECT')::text`),
      'false',
    );
  });
});

describe('0024 — after every case', () => {
  test('the table still holds exactly the two seed rows', async () => {
    const r = await db.psql({ commands: [SEED_SQL], raw: true });
    assertPermitted('re-read the seed rows', r);
    assert.equal(r.stdout.trim(), SEED_ROWS);
  });
});
