/**
 * T-252 — `public.sitter_credential` (migration 0026): SD §DB-4 lines 2120–2150, as requested by
 * tasks/state/EP-5/T-060.md § Migration request › MR-2 and ruled in tasks/state/EP-5/CUT-T-060.md §1
 * (R-2 row-level security, R-7 the C6 catalogue probe, R-9 grants) and §2 S-1 (stakeholder,
 * 2026-10-10: (b) (ii) the reference_number capacity bound; (c) (i) and (d) (i) NULL-only columns;
 * (e) (ii) the attestation_template_version shape). OD-324 widens R-7's probe to policies, index
 * expressions and predicates, and generated columns.
 *
 * The table's catalogue is pinned: its twenty columns (type, nullability, default) with the owner, the
 * table ACL and every column ACL; its whole constraint set by name and definition (NOT NULL constraints
 * included, contype 'n' on PostgreSQL 18); its indexes; its seven policies (name, command, permissive,
 * roles, USING and WITH CHECK as PostgreSQL deparses them); its comment; and in ONE assertion the counts
 * of its non-internal triggers, rewrite rules and policies with both row-level security flags:
 * '0 triggers, 0 rules, rls=true, force=true, 7 policies' (tech-lead.md failure mode 5). Seven is R-2 as
 * written in 0026: one policy per command per actor class, sitter SELECT/INSERT/UPDATE, system
 * SELECT/INSERT/UPDATE, break-glass SELECT. So a constraint, grant, index, trigger, rule or policy added
 * to or removed from the table turns a case red. What is not in those catalogues is not pinned (an event
 * trigger; a function no trigger on this table calls).
 *
 * THE C6 CATALOGUE PROBE (R-7, OD-324) is PROBE_SQL below. It reports a finding when, on this table:
 * reference_number is absent or is not plain `text` (pg_catalog.text, no typmod; a domain or char(n) is
 * caught here); a constraint names the column in its deparsed definition or lists it in conkey, other
 * than `sitter_credential_reference_number_bounds` with exactly the deparse S1_DEPARSE (PostgreSQL's
 * reading of S-1 (b)(ii), measured, not S-1's source bytes); a non-internal trigger's function `prosrc`
 * or its definition (a WHEN clause) mentions it; a policy's USING or WITH CHECK mentions it; an index's
 * expressions or predicate mention it; or a generated column's expression mentions it. "Mentions" is a
 * case-insensitive substring match of the name in the catalogue's own text. BOUND: it keys on the column
 * NAME (CUT-T-060 R-7). A format on a differently named column of the same meaning, a function called by
 * a trigger function, a CHECK passing the whole row to a function, a view, and any other table are not
 * read. Each branch has a red case below with its plant asserted landed before the probe is judged.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` field, and exactly one ERROR line. Every RLS case asserts
 * a row count or a SQLSTATE, never "no error". Privilege and RLS cases run over REAL LOGIN principals,
 * each a member of exactly one role (T-020 Evidence §4); constraint refusals run as the superuser, who
 * bypasses RLS, so no privilege or policy is what refuses them. The GUCs are set with SET LOCAL, as
 * T-254's runtime will. Every write runs inside a transaction that is never committed (`inTransaction`),
 * so the two committed fixture rows are the table's only rows throughout, and the last test re-reads them.
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

const SUITE = 'sitter-credential';
const TABLE = 'public.sitter_credential';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't252_app_rw_probe',
  app_admin_rw: 't252_app_admin_rw_probe',
  app_safety_rw: 't252_app_safety_rw_probe',
  answering_service: 't252_answering_service_probe',
  app_ddl: 't252_app_ddl_probe',
} as const;

/** Account / sitter_profile ids (char(26)) and the two committed credential rows. */
const SITTER_A = '01T252SITTERA0000000000001';
const SITTER_B = '01T252SITTERB0000000000001';
const UNKNOWN = '01T252NOSITTER000000000001';
const CRED_A = '01T252CREDA000000000000001';
const CRED_B = '01T252CREDB000000000000001';
const CRED_NEW = '01T252CREDNEW0000000000001';
for (const id of [SITTER_A, SITTER_B, UNKNOWN, CRED_A, CRED_B, CRED_NEW]) {
  assert.equal(id.length, 26, id);
}

/** Schemes are looked up by (jurisdiction, scheme_name), never by a literal id (CUT-T-060 R-4). */
const WHITE = `(SELECT id FROM public.credential_scheme WHERE jurisdiction = 'CY' AND scheme_name = 'White Criminal Record Certificate')`;
const ART22 = `(SELECT id FROM public.credential_scheme WHERE jurisdiction = 'CY' AND scheme_name = 'Certificate under Art. 22(6), Law 91(I)/2014')`;

/** PostgreSQL's deparse of S-1 (b)(ii) as 0026 installs it (measured, T-252 E1). */
const S1_NAME = 'sitter_credential_reference_number_bounds';
const S1_DEPARSE =
  "CHECK ((((char_length(reference_number) >= 1) AND (char_length(reference_number) <= 64)) AND (reference_number !~ '[[:cntrl:]]'::text)))";

/** The text 0026 installs, verbatim: a change to the comment must change this suite too. */
const TABLE_COMMENT =
  "A sitter's credential per scheme (SD §DB-4, SA §DA-4r). No certificate content, no free text, no notes. " +
  'reference_number is plain text; its format is credential_scheme.reference_format_regex, applied by the ' +
  'application, never DDL. Row-level security is FORCEd; policies are TO app_rw and read app.actor_id, ' +
  'app.actor_role and app.break_glass, an empty value counting as unset. A sitter sees and writes only her ' +
  'own rows and can write only status not_started or submitted; the system actor sees and writes every row; ' +
  'break-glass reads every row. app_rw holds no DELETE.';

/** The 16 columns app_rw may UPDATE (CUT-T-060 R-9), in attnum order. Literal, not a reading. */
const APP_RW_UPDATE = [
  'status',
  'reference_number',
  'issued_on',
  'expires_on',
  'expiry_provenance',
  'next_recertification_due_at',
  'last_attestation_at',
  'next_attestation_due_at',
  'attestation_template_version',
  'attestation_locale',
  'decision',
  'decided_by',
  'decided_at',
  'decision_reason_code',
  'provider',
  'provider_ref',
] as const;
assert.equal(APP_RW_UPDATE.length, 16);

/**
 * The C6 catalogue probe (R-7, OD-324). One row: 'clean', or one 'FINDING <kind> <object>' line per
 * finding. See the file header for what it reads and its bound.
 */
const PROBE_SQL = `
WITH t AS (SELECT 'public.sitter_credential'::regclass AS rel),
col AS (SELECT a.attnum, a.atttypid, a.atttypmod FROM pg_attribute a, t
         WHERE a.attrelid = t.rel AND a.attname = 'reference_number' AND NOT a.attisdropped),
f AS (
  SELECT 'column-absent reference_number' AS finding WHERE NOT EXISTS (SELECT 1 FROM col)
  UNION ALL
  SELECT 'type ' || format_type(col.atttypid, col.atttypmod) FROM col
   WHERE col.atttypid <> 'pg_catalog.text'::regtype OR col.atttypmod <> -1
  UNION ALL
  SELECT 'constraint ' || c.conname FROM pg_constraint c, t, col
   WHERE c.conrelid = t.rel
     AND (pg_get_constraintdef(c.oid) ~* 'reference_number' OR col.attnum = ANY (c.conkey))
     AND NOT (c.conname = '${S1_NAME}' AND pg_get_constraintdef(c.oid) = '${S1_DEPARSE.replaceAll("'", "''")}')
  UNION ALL
  SELECT 'trigger ' || tg.tgname FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid, t
   WHERE tg.tgrelid = t.rel AND NOT tg.tgisinternal
     AND (p.prosrc ~* 'reference_number' OR pg_get_triggerdef(tg.oid) ~* 'reference_number')
  UNION ALL
  SELECT 'policy ' || po.polname FROM pg_policy po, t
   WHERE po.polrelid = t.rel
     AND (coalesce(pg_get_expr(po.polqual, po.polrelid), '') ~* 'reference_number'
          OR coalesce(pg_get_expr(po.polwithcheck, po.polrelid), '') ~* 'reference_number')
  UNION ALL
  SELECT 'index ' || i.indexrelid::regclass::text FROM pg_index i, t
   WHERE i.indrelid = t.rel
     AND (coalesce(pg_get_expr(i.indexprs, i.indrelid), '') ~* 'reference_number'
          OR coalesce(pg_get_expr(i.indpred, i.indrelid), '') ~* 'reference_number')
  UNION ALL
  SELECT 'generated ' || a.attname
    FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum, t
   WHERE a.attrelid = t.rel AND a.attgenerated <> '' AND NOT a.attisdropped
     AND pg_get_expr(d.adbin, d.adrelid) ~* 'reference_number'
)
SELECT coalesce(string_agg('FINDING ' || finding, E'\\n' ORDER BY finding), 'clean') FROM f`;

/** The committed fixture rows as READ_ROWS prints them. */
const ROWS_BEFORE =
  `${CRED_A}|${SITTER_A}|White Criminal Record Certificate|submitted|NULL\n` +
  `${CRED_B}|${SITTER_B}|Certificate under Art. 22(6), Law 91(I)/2014|valid|NULL`;
const READ_ROWS = `SELECT c.id || '|' || c.sitter_id || '|' || s.scheme_name || '|' || c.status || '|' ||
                          coalesce(c.reference_number, 'NULL')
                     FROM ${TABLE} c JOIN public.credential_scheme s ON s.id = c.scheme_id ORDER BY c.id`;

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
         ('${SITTER_A}', '01T252PSEUDO00000000000001', 't252'),
         ('${SITTER_B}', '01T252PSEUDO00000000000002', 't252')`,
      `INSERT INTO public.sitter_profile (id) VALUES ('${SITTER_A}'), ('${SITTER_B}')`,
      `INSERT INTO ${TABLE} (id, sitter_id, scheme_id, status) VALUES
         ('${CRED_A}', '${SITTER_A}', ${WHITE}, 'submitted'),
         ('${CRED_B}', '${SITTER_B}', ${ART22}, 'valid')`,
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** Every invocation runs inside one transaction that is never committed: psql's session end rolls it back. */
const inTransaction = (commands: string[]): string[] => ['BEGIN', ...commands];

/** Statements as the bootstrap superuser (bypasses RLS), SQLSTATE in the message, stopping at the first error. */
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

/** Statements over the app_rw login. */
const asRw = (...commands: string[]): Promise<PsqlResult> => asLogin(LOGINS.app_rw, ...commands);

/** The actor contexts T-254 sets, as SET LOCAL inside the transaction (SD 3906, SA-10). */
const SITTER = (id: string): string[] => [
  `SET LOCAL app.actor_role = 'sitter'`,
  `SET LOCAL app.actor_id = '${id}'`,
];
const SYSTEM = [`SET LOCAL app.actor_role = 'system'`, `SET LOCAL app.actor_id = 'job:t252-sweep'`];
const BREAK_GLASS = [`SET LOCAL app.break_glass = 'on'`];

/** `n=<count>;` of the rows the session can see, optionally filtered. */
const COUNT = (where = 'true'): string =>
  `SELECT 'n=' || count(*) || ';' FROM ${TABLE} WHERE ${where}`;

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

/** Accepted, and the output carries every one of these markers (row counts, command tags). */
function assertPermittedWith(what: string, r: PsqlResult, ...markers: string[]): void {
  assertPermitted(what, r);
  for (const m of markers) {
    assert.ok(
      r.output.includes(m),
      `${what}: expected ${JSON.stringify(m)} in the output.\n${r.output}`,
    );
  }
}

/** Column → SQL literal for a well-formed new row; each case overrides one column. */
const GOOD: Readonly<Record<string, string>> = {
  id: `'${CRED_NEW}'`,
  sitter_id: `'${SITTER_A}'`,
  scheme_id: ART22,
  status: `'not_started'`,
};

/** An INSERT of GOOD with `overrides` applied (new columns are appended). */
function insertRow(overrides: Readonly<Record<string, string>> = {}): string {
  const row: Record<string, string> = { ...GOOD, ...overrides };
  const cols = Object.keys(row);
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map((c) => row[c]).join(', ')})`;
}

const CHECK_23514 = (name: string): string =>
  `ERROR:  23514: new row for relation "sitter_credential" violates check constraint "${name}"`;
const FK_23503 = (name: string): string =>
  `ERROR:  23503: insert or update on table "sitter_credential" violates foreign key constraint "${name}"`;
const NOTNULL_23502 = (column: string): string =>
  `ERROR:  23502: null value in column "${column}" of relation "sitter_credential" violates not-null constraint`;
const DENIED = 'ERROR:  42501: permission denied for table sitter_credential';
const RLS_DENIED =
  'ERROR:  42501: new row violates row-level security policy for table "sitter_credential"';

describe('0026 — the table, its owner, columns, ACL, constraints, indexes, policies and comment', () => {
  test("SD 2120–2150's twenty columns in SD's order, types, nullability and default; owner app_ddl; table ACL app_rw SELECT + INSERT; column UPDATE on exactly the 16 R-9 columns", async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' ||
                                   coalesce(attacl::text, '-'), ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text
           FROM pg_class c WHERE c.oid = '${TABLE}'::regclass`,
      ),
      [
        'id:character(26):nn:-:-',
        'sitter_id:character(26):nn:-:-',
        'scheme_id:integer:nn:-:-',
        'status:text:nn:-:{app_rw=w/app_ddl}',
        'reference_number:text:null:-:{app_rw=w/app_ddl}',
        'issued_on:date:null:-:{app_rw=w/app_ddl}',
        'expires_on:date:null:-:{app_rw=w/app_ddl}',
        'expiry_provenance:text:null:-:{app_rw=w/app_ddl}',
        'next_recertification_due_at:date:null:-:{app_rw=w/app_ddl}',
        'last_attestation_at:timestamp with time zone:null:-:{app_rw=w/app_ddl}',
        'next_attestation_due_at:timestamp with time zone:null:-:{app_rw=w/app_ddl}',
        'attestation_template_version:text:null:-:{app_rw=w/app_ddl}',
        'attestation_locale:text:null:-:{app_rw=w/app_ddl}',
        'decision:text:null:-:{app_rw=w/app_ddl}',
        'decided_by:character(26):null:-:{app_rw=w/app_ddl}',
        'decided_at:timestamp with time zone:null:-:{app_rw=w/app_ddl}',
        'decision_reason_code:text:null:-:{app_rw=w/app_ddl}',
        'provider:text:null:-:{app_rw=w/app_ddl}',
        'provider_ref:text:null:-:{app_rw=w/app_ddl}',
        'created_at:timestamp with time zone:nn:now():-',
      ].join(',') + '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl}',
    );
  });

  test("app_rw's effective UPDATE privilege is exactly the 16 R-9 columns (not id, sitter_id, scheme_id, created_at); no role but app_ddl and app_rw holds any privilege on the table, PUBLIC included (superusers, pg_* roles and this suite's t252_* logins are not read)", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
          WHERE attrelid = '${TABLE}'::regclass AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege('app_rw', '${TABLE}', attname, 'UPDATE')`,
      ),
      APP_RW_UPDATE.join(','),
    );
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(DISTINCT r.rolname || ':' || p, ',' ORDER BY r.rolname || ':' || p), '(none)')
           FROM (SELECT rolname FROM pg_roles UNION ALL SELECT 'public') r(rolname)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
          WHERE r.rolname NOT IN ('app_ddl') AND r.rolname NOT LIKE 'pg\\_%' AND r.rolname NOT LIKE 't252\\_%'
            AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = r.rolname) IS TRUE
            AND (has_table_privilege(r.rolname, '${TABLE}', p)
                 OR (p IN ('UPDATE', 'INSERT', 'SELECT', 'REFERENCES')
                     AND has_any_column_privilege(r.rolname, '${TABLE}', p)))`,
      ),
      'app_rw:INSERT,app_rw:SELECT,app_rw:UPDATE',
    );
  });

  test("the constraint set is exactly these names and definitions: PK; UNIQUE (sitter_id, scheme_id); the three FKs (sitter_profile ON DELETE CASCADE, credential_scheme and locale_registry NO ACTION, decided_by none); SD's two CHECKs; S-1's six CHECKs; the five NOT NULLs; none deferrable", async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || ' ' || contype::text || ' ' || condeferrable::text || ' ' ||
                           pg_get_constraintdef(oid), E'\\n' ORDER BY conname COLLATE "C")
           FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass`,
      ),
      [
        'sitter_credential_attestation_locale_fkey f false FOREIGN KEY (attestation_locale) REFERENCES locale_registry(code)',
        "sitter_credential_attestation_template_version_shape c false CHECK ((attestation_template_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'::text))",
        'sitter_credential_decision_null_only c false CHECK ((decision IS NULL))',
        'sitter_credential_decision_reason_code_null_only c false CHECK ((decision_reason_code IS NULL))',
        "sitter_credential_expiry_provenance_check c false CHECK ((expiry_provenance = ANY (ARRAY['from_document'::text, 'platform_default'::text])))",
        'sitter_credential_id_not_null n false NOT NULL id',
        'sitter_credential_pkey p false PRIMARY KEY (id)',
        'sitter_credential_provider_null_only c false CHECK ((provider IS NULL))',
        'sitter_credential_provider_ref_null_only c false CHECK ((provider_ref IS NULL))',
        `${S1_NAME} c false ${S1_DEPARSE}`,
        'sitter_credential_scheme_id_fkey f false FOREIGN KEY (scheme_id) REFERENCES credential_scheme(id)',
        'sitter_credential_scheme_id_not_null n false NOT NULL scheme_id',
        'sitter_credential_sitter_id_fkey f false FOREIGN KEY (sitter_id) REFERENCES sitter_profile(id) ON DELETE CASCADE',
        'sitter_credential_sitter_id_not_null n false NOT NULL sitter_id',
        'sitter_credential_sitter_id_scheme_id_key u false UNIQUE (sitter_id, scheme_id)',
        "sitter_credential_status_check c false CHECK ((status = ANY (ARRAY['not_started'::text, 'submitted'::text, 'in_review'::text, 'valid'::text, 'expired'::text, 'failed'::text, 'review_hold'::text, 'withdrawn'::text])))",
        'sitter_credential_status_not_null n false NOT NULL status',
        'sitter_credential_created_at_not_null n false NOT NULL created_at',
      ]
        .sort()
        .join('\n'),
    );
  });

  test('the indexes are exactly the PK, the UNIQUE and the three partial indexes of SD 2148–2150 (single-column; OD-110 does not apply)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(pg_get_indexdef(indexrelid), ' ; ' ORDER BY indexrelid::regclass::text COLLATE "C")
           FROM pg_index WHERE indrelid = '${TABLE}'::regclass`,
      ),
      [
        "CREATE INDEX idx_sitter_credential_attestation_due ON public.sitter_credential USING btree (next_attestation_due_at) WHERE (status = 'valid'::text)",
        "CREATE INDEX idx_sitter_credential_expires ON public.sitter_credential USING btree (expires_on) WHERE ((status = 'valid'::text) AND (expires_on IS NOT NULL))",
        "CREATE INDEX idx_sitter_credential_recert_due ON public.sitter_credential USING btree (next_recertification_due_at) WHERE (status = 'valid'::text)",
        'CREATE UNIQUE INDEX sitter_credential_pkey ON public.sitter_credential USING btree (id)',
        'CREATE UNIQUE INDEX sitter_credential_sitter_id_scheme_id_key ON public.sitter_credential USING btree (sitter_id, scheme_id)',
      ].join(' ; '),
    );
  });

  test('ONE-LINE PIN: 0 triggers, 0 rules, rls=true, force=true, 7 policies (R-2: one per command per actor class)', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
           FROM pg_class c WHERE c.oid = '${TABLE}'::regclass`,
      ),
      '0 triggers, 0 rules, rls=true, force=true, 7 policies',
    );
  });

  test('relrowsecurity and relforcerowsecurity are both t, read from pg_class directly (QR-A1: db:introspect cannot see them)', async () => {
    assert.equal(
      await db.value(
        `SELECT relrowsecurity::text || ' ' || relforcerowsecurity::text FROM pg_class WHERE oid = '${TABLE}'::regclass`,
      ),
      'true true',
    );
  });

  test("the seven policies are exactly these: permissive, TO app_rw, each GUC read through NULLIF(current_setting(…, true), ''); no operator policy (S-2 → T-070); no DELETE policy", async () => {
    const SITTER_P =
      "(NULLIF(current_setting('app.actor_role'::text, true), ''::text) = 'sitter'::text) AND " +
      "((sitter_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text))";
    const SYSTEM_P =
      "(NULLIF(current_setting('app.actor_role'::text, true), ''::text) = 'system'::text) AND " +
      "(NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NOT NULL)";
    const SITTER_STATUS = "(status = ANY (ARRAY['not_started'::text, 'submitted'::text]))";
    assert.equal(
      await db.value(
        `SELECT string_agg(polname || '|' || polcmd::text || '|' || polpermissive::text || '|' ||
                           polroles::regrole[]::text || '|' ||
                           coalesce(pg_get_expr(polqual, polrelid), '-') || '|' ||
                           coalesce(pg_get_expr(polwithcheck, polrelid), '-'), E'\\n' ORDER BY polname COLLATE "C")
           FROM pg_policy WHERE polrelid = '${TABLE}'::regclass`,
      ),
      [
        "sitter_credential_break_glass_select|r|true|{app_rw}|(NULLIF(current_setting('app.break_glass'::text, true), ''::text) = 'on'::text)|-",
        `sitter_credential_sitter_insert|a|true|{app_rw}|-|(${SITTER_P} AND ${SITTER_STATUS})`,
        `sitter_credential_sitter_select|r|true|{app_rw}|(${SITTER_P})|-`,
        `sitter_credential_sitter_update|w|true|{app_rw}|(${SITTER_P})|(${SITTER_P} AND ${SITTER_STATUS})`,
        `sitter_credential_system_insert|a|true|{app_rw}|-|(${SYSTEM_P})`,
        `sitter_credential_system_select|r|true|{app_rw}|(${SYSTEM_P})|-`,
        `sitter_credential_system_update|w|true|{app_rw}|(${SYSTEM_P})|(${SYSTEM_P})`,
      ].join('\n'),
    );
  });

  test('COMMENT ON TABLE is exactly this text, and no column carries a comment', async () => {
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
});

describe('0026 — the C6 catalogue probe (CUT-T-060 R-7, OD-324): clean as migrated, red on each plant', () => {
  test('as migrated, the probe is clean, and the one admitted constraint is S-1 (b)(ii) by name with exactly the measured deparse', async () => {
    assert.equal(await db.value(PROBE_SQL), 'clean');
    assert.equal(
      await db.value(
        `SELECT conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid = '${TABLE}'::regclass AND pg_get_constraintdef(oid) ~* 'reference_number'`,
      ),
      `${S1_NAME} ${S1_DEPARSE}`,
    );
  });

  /**
   * Each plant runs as the superuser in a transaction never committed: the plant, then a `landed=`
   * reading that must be true (the plant is in the catalogue), then the probe. The probe must report
   * exactly the expected finding line.
   */
  const PLANTS: readonly {
    readonly name: string;
    readonly plant: readonly string[];
    readonly landed: string;
    readonly finding: string;
  }[] = [
    {
      name: "SD 2066's exact leak: ADD CONSTRAINT cred_ref_format CHECK (reference_number ~ '^[0-9]{12}$')",
      plant: [
        `ALTER TABLE ${TABLE} ADD CONSTRAINT cred_ref_format CHECK (reference_number ~ '^[0-9]{12}$')`,
      ],
      landed: `SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND conname = 'cred_ref_format'`,
      finding: 'FINDING constraint cred_ref_format',
    },
    {
      name: 'S-1 (b)(ii) re-added under its own name with a narrower bound (the deparse differs)',
      plant: [
        `ALTER TABLE ${TABLE} DROP CONSTRAINT ${S1_NAME}`,
        `ALTER TABLE ${TABLE} ADD CONSTRAINT ${S1_NAME} CHECK (char_length(reference_number) BETWEEN 1 AND 12 AND reference_number !~ '[[:cntrl:]]')`,
      ],
      landed: `SELECT pg_get_constraintdef(oid) LIKE '%<= 12)%' FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND conname = '${S1_NAME}'`,
      finding: `FINDING constraint ${S1_NAME}`,
    },
    {
      name: 'reference_number retyped char(12)',
      plant: [`ALTER TABLE ${TABLE} ALTER COLUMN reference_number TYPE char(12)`],
      landed: `SELECT format_type(atttypid, atttypmod) = 'character(12)' FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attname = 'reference_number'`,
      finding: 'FINDING type character(12)',
    },
    {
      name: 'reference_number retyped to a domain over text carrying the format',
      plant: [
        `CREATE DOMAIN public.t252_ref_format AS text CHECK (VALUE ~ '^[0-9]{12}$')`,
        `ALTER TABLE ${TABLE} ALTER COLUMN reference_number TYPE public.t252_ref_format`,
      ],
      landed: `SELECT atttypid = 'public.t252_ref_format'::regtype FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attname = 'reference_number'`,
      finding: 'FINDING type t252_ref_format',
    },
    {
      name: 'a trigger whose function body enforces the format',
      plant: [
        `CREATE FUNCTION public.t252_ref_guard() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.reference_number !~ '^[0-9]{12}$' THEN RAISE EXCEPTION 'reference format'; END IF; RETURN NEW; END $f$`,
        `CREATE TRIGGER t252_ref_guard BEFORE INSERT OR UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION public.t252_ref_guard()`,
      ],
      landed: `SELECT count(*) = 1 FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND tgname = 't252_ref_guard'`,
      finding: 'FINDING trigger t252_ref_guard',
    },
    {
      name: 'a trigger whose WHEN clause carries the format (its function never names the column)',
      plant: [
        `CREATE FUNCTION public.t252_refuse() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'refused'; END $f$`,
        `CREATE TRIGGER t252_ref_when BEFORE INSERT ON ${TABLE} FOR EACH ROW WHEN (NEW.reference_number !~ '^[0-9]{12}$') EXECUTE FUNCTION public.t252_refuse()`,
      ],
      landed: `SELECT count(*) = 1 FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND tgname = 't252_ref_when'`,
      finding: 'FINDING trigger t252_ref_when',
    },
    {
      name: "OD-324: a new policy's WITH CHECK carries the format (T-253 TL01's shape)",
      plant: [
        `CREATE POLICY t252_ref_policy ON ${TABLE} AS RESTRICTIVE FOR INSERT TO app_rw WITH CHECK (reference_number ~ '^[0-9]{12}$')`,
      ],
      landed: `SELECT count(*) = 1 FROM pg_policy WHERE polrelid = '${TABLE}'::regclass AND polname = 't252_ref_policy'`,
      finding: 'FINDING policy t252_ref_policy',
    },
    {
      name: "OD-324: an existing policy's WITH CHECK altered to carry the format (T-253 TL02's shape; polwithcheck)",
      plant: [
        `ALTER POLICY sitter_credential_sitter_insert ON ${TABLE} WITH CHECK (status IN ('not_started','submitted') AND reference_number ~ '^[0-9]{12}$')`,
      ],
      landed: `SELECT pg_get_expr(polwithcheck, polrelid) LIKE '%reference_number%' FROM pg_policy WHERE polrelid = '${TABLE}'::regclass AND polname = 'sitter_credential_sitter_insert'`,
      finding: 'FINDING policy sitter_credential_sitter_insert',
    },
    {
      name: "OD-324: an existing policy's USING altered to carry the format (polqual)",
      plant: [
        `ALTER POLICY sitter_credential_sitter_select ON ${TABLE} USING (NULLIF(current_setting('app.actor_role', true), '') = 'sitter' AND reference_number ~ '^[0-9]{12}$')`,
      ],
      landed: `SELECT pg_get_expr(polqual, polrelid) LIKE '%reference_number%' FROM pg_policy WHERE polrelid = '${TABLE}'::regclass AND polname = 'sitter_credential_sitter_select'`,
      finding: 'FINDING policy sitter_credential_sitter_select',
    },
    {
      name: 'OD-324: an expression index casting the column (T-253 CK38; pg_index.indexprs)',
      plant: [`CREATE INDEX t252_ref_expr ON ${TABLE} ((reference_number::bigint))`],
      landed: `SELECT indexprs IS NOT NULL FROM pg_index WHERE indexrelid = 'public.t252_ref_expr'::regclass`,
      finding: 'FINDING index t252_ref_expr',
    },
    {
      name: 'OD-324: a partial index whose predicate carries the format (pg_index.indpred)',
      plant: [`CREATE INDEX t252_ref_pred ON ${TABLE} (id) WHERE reference_number ~ '^[0-9]{12}$'`],
      landed: `SELECT indpred IS NOT NULL FROM pg_index WHERE indexrelid = 'public.t252_ref_pred'::regclass`,
      finding: 'FINDING index t252_ref_pred',
    },
    {
      name: 'OD-324: a generated copy carrying a format CHECK under another name (T-253 CK37; pg_attrdef)',
      plant: [
        `ALTER TABLE ${TABLE} ADD COLUMN t252_ref_digits text GENERATED ALWAYS AS (reference_number) STORED CHECK (t252_ref_digits ~ '^[0-9]{12}$')`,
      ],
      landed: `SELECT attgenerated = 's' FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attname = 't252_ref_digits'`,
      finding: 'FINDING generated t252_ref_digits',
    },
    {
      name: 'the column renamed away (the probe fails closed)',
      plant: [`ALTER TABLE ${TABLE} RENAME COLUMN reference_number TO ref_no`],
      landed: `SELECT count(*) = 1 FROM pg_attribute WHERE attrelid = '${TABLE}'::regclass AND attname = 'ref_no'`,
      finding: 'FINDING column-absent reference_number',
    },
  ];

  for (const p of PLANTS) {
    test(`RED — ${p.name}`, async () => {
      const r = await db.psql({
        commands: [
          'BEGIN',
          ...p.plant,
          `SELECT 'landed=' || (${p.landed})::text`,
          `SELECT 'probe:' || (${PROBE_SQL})`,
        ],
        raw: true,
        stopOnError: true,
      });
      assertPermitted(`plant ${p.name}`, r);
      assert.ok(
        r.stdout.includes('landed=true'),
        `${p.name}: the plant did not land.\n${r.output}`,
      );
      assert.ok(
        !r.stdout.includes('probe:clean'),
        `${p.name}: the probe reported clean.\n${r.output}`,
      );
      assert.ok(
        r.stdout.split('\n').some((l) => l === p.finding || l === `probe:${p.finding}`),
        `${p.name}: expected the probe line ${JSON.stringify(p.finding)}.\n${r.output}`,
      );
    });
  }

  test('CONTROL — neutral plants that name no reference_number (a CHECK, a partial index and an expression index on other columns, a restrictive policy, a trigger whose body does not name it) all land and leave the probe clean', async () => {
    const r = await db.psql({
      commands: [
        'BEGIN',
        `ALTER TABLE ${TABLE} ADD CONSTRAINT t252_ctl_check CHECK (provider_ref IS NULL OR provider_ref <> '')`,
        `CREATE INDEX t252_ctl_pred ON ${TABLE} (id) WHERE status = 'submitted'`,
        `CREATE INDEX t252_ctl_expr ON ${TABLE} ((lower(status)))`,
        `CREATE POLICY t252_ctl_policy ON ${TABLE} AS RESTRICTIVE FOR INSERT TO app_rw WITH CHECK (status <> 'valid')`,
        `CREATE FUNCTION public.t252_ctl() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`,
        `CREATE TRIGGER t252_ctl BEFORE INSERT ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION public.t252_ctl()`,
        `SELECT 'landed=' || ((SELECT count(*) FROM pg_constraint WHERE conname = 't252_ctl_check') +
                              (SELECT count(*) FROM pg_class WHERE relname IN ('t252_ctl_pred', 't252_ctl_expr')) +
                              (SELECT count(*) FROM pg_policy WHERE polname = 't252_ctl_policy') +
                              (SELECT count(*) FROM pg_trigger WHERE tgname = 't252_ctl'))::text`,
        `SELECT 'probe:' || (${PROBE_SQL})`,
      ],
      raw: true,
      stopOnError: true,
    });
    assertPermittedWith('neutral plants', r, 'landed=5', 'probe:clean');
  });
});

describe('0026 — constraint refusals (as the superuser, who bypasses RLS; in a transaction never committed)', () => {
  test('CONTROL — a well-formed row is accepted, and created_at takes now()', async () => {
    assertPermittedWith(
      'good row',
      await asSuperuser(
        insertRow(),
        `SELECT 'created=' || (created_at IS NOT NULL)::text FROM ${TABLE} WHERE id = '${CRED_NEW}'`,
      ),
      'INSERT 0 1',
      'created=true',
    );
  });

  test("status 'pending' is REFUSED (23514 sitter_credential_status_check); each of SD's eight values is accepted", async () => {
    assertRefusedBy(
      'status pending',
      await asSuperuser(insertRow({ status: `'pending'` })),
      CHECK_23514('sitter_credential_status_check'),
    );
    for (const s of [
      'not_started',
      'submitted',
      'in_review',
      'valid',
      'expired',
      'failed',
      'review_hold',
      'withdrawn',
    ]) {
      assertPermittedWith(
        `status ${s}`,
        await asSuperuser(insertRow({ status: `'${s}'` })),
        'INSERT 0 1',
      );
    }
  });

  test("expiry_provenance 'guessed' is REFUSED (23514 sitter_credential_expiry_provenance_check); 'from_document' and 'platform_default' are accepted", async () => {
    assertRefusedBy(
      'expiry_provenance guessed',
      await asSuperuser(insertRow({ expiry_provenance: `'guessed'` })),
      CHECK_23514('sitter_credential_expiry_provenance_check'),
    );
    for (const v of ['from_document', 'platform_default']) {
      assertPermittedWith(
        v,
        await asSuperuser(insertRow({ expiry_provenance: `'${v}'` })),
        'INSERT 0 1',
      );
    }
  });

  test('a second row for the same (sitter_id, scheme_id) is REFUSED (23505 sitter_credential_sitter_id_scheme_id_key)', async () => {
    assertRefusedBy(
      'duplicate (sitter, scheme)',
      await asSuperuser(insertRow({ scheme_id: WHITE })),
      'ERROR:  23505: duplicate key value violates unique constraint "sitter_credential_sitter_id_scheme_id_key"',
    );
  });

  test('an unknown scheme_id, sitter_id or attestation_locale is REFUSED (23503, each by its own FK)', async () => {
    assertRefusedBy(
      'unknown scheme',
      await asSuperuser(insertRow({ scheme_id: '-1' })),
      FK_23503('sitter_credential_scheme_id_fkey'),
    );
    assertRefusedBy(
      'unknown sitter',
      await asSuperuser(insertRow({ sitter_id: `'${UNKNOWN}'` })),
      FK_23503('sitter_credential_sitter_id_fkey'),
    );
    assertRefusedBy(
      'unknown locale',
      await asSuperuser(insertRow({ attestation_locale: `'xx'` })),
      FK_23503('sitter_credential_attestation_locale_fkey'),
    );
    assertPermittedWith(
      'locale el',
      await asSuperuser(insertRow({ attestation_locale: `'el'` })),
      'INSERT 0 1',
    );
  });

  test('deleting a credential_scheme that a credential references is REFUSED (23503, NO ACTION)', async () => {
    assertRefusedBy(
      'delete referenced scheme',
      await asSuperuser(
        `DELETE FROM public.credential_scheme WHERE jurisdiction = 'CY' AND scheme_name = 'White Criminal Record Certificate'`,
      ),
      'ERROR:  23503: update or delete on table "credential_scheme" violates foreign key constraint "sitter_credential_scheme_id_fkey" on table "sitter_credential"',
    );
  });

  test('NULL id, sitter_id, scheme_id or status is REFUSED by its NOT NULL (23502)', async () => {
    for (const column of ['id', 'sitter_id', 'scheme_id', 'status']) {
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(insertRow({ [column]: 'NULL' })),
        NOTNULL_23502(column),
      );
    }
  });

  test(`S-1 (b)(ii): reference_number '' or 65 characters, or carrying a control character (tab, LF, CR, BEL, DEL, U+0085), is REFUSED (23514 ${S1_NAME})`, async () => {
    for (const v of [
      `''`,
      `repeat('1', 65)`,
      `E'12\\t34'`,
      `E'12\\n34'`,
      `E'12\\r34'`,
      `E'12\\x0734'`,
      `E'12\\x7f34'`,
      `U&'12\\008534'`,
    ]) {
      assertRefusedBy(
        `reference_number ${v}`,
        await asSuperuser(insertRow({ reference_number: v })),
        CHECK_23514(S1_NAME),
      );
    }
  });

  test("S-1 (b)(ii) CONTROL: reference_number NULL, '0', 'ΑΒΓ-123', a 20-digit string, 64 characters, and U+00A0 / U+2028 inside (not [[:cntrl:]] here, measured) are accepted", async () => {
    for (const v of [
      'NULL',
      `'0'`,
      `'ΑΒΓ-123'`,
      `'12345678901234567890'`,
      `repeat('1', 64)`,
      `U&'12\\00A034'`,
      `U&'12\\202834'`,
    ]) {
      assertPermittedWith(
        `reference_number ${v}`,
        await asSuperuser(insertRow({ reference_number: v })),
        'INSERT 0 1',
      );
    }
  });

  test('S-1 (c) (i) and (d) (i): decision, decision_reason_code, provider and provider_ref are NULL-only (23514, each by its own CHECK); NULL is accepted', async () => {
    for (const column of ['decision', 'decision_reason_code', 'provider', 'provider_ref']) {
      assertRefusedBy(
        `${column} set`,
        await asSuperuser(insertRow({ [column]: `'x'` })),
        CHECK_23514(`sitter_credential_${column}_null_only`),
      );
      assertPermittedWith(
        `${column} NULL`,
        await asSuperuser(insertRow({ [column]: 'NULL' })),
        'INSERT 0 1',
      );
    }
  });

  test("S-1 (e) (ii): attestation_template_version 'V1', '', '-v1', '.v1', 'v 1', 'v1/2' and 65 characters are REFUSED (23514 sitter_credential_attestation_template_version_shape); 'v1', 'att-2026.10_a' and 64 characters are accepted", async () => {
    for (const v of [`'V1'`, `''`, `'-v1'`, `'.v1'`, `'v 1'`, `'v1/2'`, `repeat('a', 65)`]) {
      assertRefusedBy(
        `attestation_template_version ${v}`,
        await asSuperuser(insertRow({ attestation_template_version: v })),
        CHECK_23514('sitter_credential_attestation_template_version_shape'),
      );
    }
    for (const v of [`'v1'`, `'att-2026.10_a'`, `repeat('a', 64)`]) {
      assertPermittedWith(
        `attestation_template_version ${v}`,
        await asSuperuser(insertRow({ attestation_template_version: v })),
        'INSERT 0 1',
      );
    }
  });
});

describe('0026 — privileges (real logins; R-9)', () => {
  test('app_rw DELETE is REFUSED (42501) on a row the session can see', async () => {
    assertRefusedBy(
      'app_rw DELETE',
      await asRw(
        ...SYSTEM,
        COUNT(`id = '${CRED_B}'`),
        `DELETE FROM ${TABLE} WHERE id = '${CRED_B}'`,
      ),
      DENIED,
    );
  });

  test('app_rw TRUNCATE is REFUSED (42501)', async () => {
    assertRefusedBy('app_rw TRUNCATE', await asRw(`TRUNCATE ${TABLE}`), DENIED);
  });

  test('app_rw UPDATE of id, sitter_id, scheme_id or created_at is REFUSED (42501) on a row the session can see; CONTROL: UPDATE of status on it affects 1 row', async () => {
    for (const set of [
      `id = '${CRED_NEW}'`,
      `sitter_id = '${SITTER_A}'`,
      `scheme_id = ${WHITE}`,
      'created_at = now()',
    ]) {
      const r = await asRw(
        ...SYSTEM,
        COUNT(`id = '${CRED_B}'`),
        `UPDATE ${TABLE} SET ${set} WHERE id = '${CRED_B}'`,
      );
      assert.ok(
        r.output.includes('n=1;'),
        `UPDATE SET ${set}: the row was not visible first.\n${r.output}`,
      );
      assertRefusedBy(`app_rw UPDATE SET ${set}`, r, DENIED);
    }
    assertPermittedWith(
      'app_rw UPDATE status',
      await asRw(...SYSTEM, `UPDATE ${TABLE} SET status = 'review_hold' WHERE id = '${CRED_B}'`),
      'UPDATE 1',
    );
  });

  test('app_admin_rw, app_safety_rw and answering_service SELECT are REFUSED (42501)', async () => {
    for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
      assertRefusedBy(
        `${role} SELECT`,
        await asLogin(LOGINS[role], `SELECT count(*) FROM ${TABLE}`),
        DENIED,
      );
    }
  });
});

describe('0026 — row-level security (R-2; real app_rw login; GUCs by SET LOCAL)', () => {
  test('with no actor set, app_rw sees 0 of the 2 rows, and an INSERT is REFUSED (42501, RLS)', async () => {
    assertPermittedWith('superuser count', await asSuperuser(COUNT()), 'n=2;');
    assertPermittedWith('no actor count', await asRw(COUNT()), 'n=0;');
    assertRefusedBy('no actor INSERT', await asRw(insertRow()), RLS_DENIED);
  });

  test("a sitter sees her own row and not another sitter's", async () => {
    assertPermittedWith(
      'sitter A',
      await asRw(
        ...SITTER(SITTER_A),
        COUNT(),
        COUNT(`id = '${CRED_A}'`).replace("'n='", "'own='"),
        COUNT(`id = '${CRED_B}'`).replace("'n='", "'other='"),
      ),
      'n=1;',
      'own=1;',
      'other=0;',
    );
  });

  test("a sitter's UPDATE of another sitter's row affects 0 rows; CONTROL: the same UPDATE of her own row affects 1", async () => {
    assertPermittedWith(
      'sitter A updates B',
      await asRw(
        ...SITTER(SITTER_A),
        `UPDATE ${TABLE} SET status = 'submitted' WHERE id = '${CRED_B}'`,
      ),
      'UPDATE 0',
    );
    assertPermittedWith(
      'sitter A updates A',
      await asRw(
        ...SITTER(SITTER_A),
        `UPDATE ${TABLE} SET status = 'submitted' WHERE id = '${CRED_A}'`,
      ),
      'UPDATE 1',
    );
  });

  test("a sitter's write producing valid is REFUSED (42501, RLS), and so is every status a sitter does not cause (in_review, expired, failed, review_hold, withdrawn), by UPDATE and by INSERT; CONTROL: not_started and submitted are accepted both ways", async () => {
    for (const s of ['valid', 'in_review', 'expired', 'failed', 'review_hold', 'withdrawn']) {
      const u = await asRw(
        ...SITTER(SITTER_A),
        COUNT(`id = '${CRED_A}'`),
        `UPDATE ${TABLE} SET status = '${s}' WHERE id = '${CRED_A}'`,
      );
      assert.ok(
        u.output.includes('n=1;'),
        `UPDATE to ${s}: the row was not visible first.\n${u.output}`,
      );
      assertRefusedBy(`sitter UPDATE to ${s}`, u, RLS_DENIED);
      assertRefusedBy(
        `sitter INSERT as ${s}`,
        await asRw(...SITTER(SITTER_A), insertRow({ status: `'${s}'` })),
        RLS_DENIED,
      );
    }
    for (const s of ['not_started', 'submitted']) {
      assertPermittedWith(
        `sitter UPDATE to ${s}`,
        await asRw(
          ...SITTER(SITTER_A),
          `UPDATE ${TABLE} SET status = '${s}' WHERE id = '${CRED_A}'`,
        ),
        'UPDATE 1',
      );
      assertPermittedWith(
        `sitter INSERT as ${s}`,
        await asRw(...SITTER(SITTER_A), insertRow({ status: `'${s}'` })),
        'INSERT 0 1',
      );
    }
  });

  test("a sitter's INSERT of a row for another sitter is REFUSED (42501, RLS)", async () => {
    assertRefusedBy(
      'sitter A inserts for B',
      await asRw(...SITTER(SITTER_A), insertRow({ sitter_id: `'${SITTER_B}'`, scheme_id: WHITE })),
      RLS_DENIED,
    );
  });

  test("Q-3: a sitter's INSERT … ON CONFLICT (sitter_id, scheme_id) DO NOTHING inserts 0 rows for a scheme she holds and 1 for one she does not", async () => {
    const q3 = (scheme: string): string =>
      `INSERT INTO ${TABLE} (id, sitter_id, scheme_id, status) VALUES ('${CRED_NEW}', '${SITTER_A}', ${scheme}, 'not_started')
         ON CONFLICT (sitter_id, scheme_id) DO NOTHING`;
    assertPermittedWith(
      'Q-3 held scheme',
      await asRw(...SITTER(SITTER_A), q3(WHITE)),
      'INSERT 0 0',
    );
    assertPermittedWith('Q-3 new scheme', await asRw(...SITTER(SITTER_A), q3(ART22)), 'INSERT 0 1');
  });

  test("a sitter records reference_number '0', 'ΑΒΓ-123' and a 20-digit string on her own row (each affects 1 row; S-1's bound)", async () => {
    for (const v of ['0', 'ΑΒΓ-123', '12345678901234567890']) {
      assertPermittedWith(
        `sitter reference ${v}`,
        await asRw(
          ...SITTER(SITTER_A),
          `UPDATE ${TABLE} SET reference_number = '${v}' WHERE id = '${CRED_A}'`,
          `SELECT 'ref=' || reference_number || ';' FROM ${TABLE} WHERE id = '${CRED_A}'`,
        ),
        'UPDATE 1',
        `ref=${v};`,
      );
    }
  });

  test('the system actor sees every row, updates any row and inserts for any sitter; actor_role system with no actor_id sees 0 rows', async () => {
    assertPermittedWith(
      'system',
      await asRw(
        ...SYSTEM,
        COUNT(),
        `UPDATE ${TABLE} SET status = 'review_hold' WHERE id = '${CRED_B}'`,
        insertRow({ sitter_id: `'${SITTER_B}'`, scheme_id: WHITE, status: `'in_review'` }),
      ),
      'n=2;',
      'UPDATE 1',
      'INSERT 0 1',
    );
    assertPermittedWith(
      'system, no actor_id',
      await asRw(`SET LOCAL app.actor_role = 'system'`, COUNT()),
      'n=0;',
    );
  });

  test("break-glass (app.break_glass = 'on') sees every row; its UPDATE affects 0 rows and its INSERT is REFUSED (42501, RLS); 'ON' and 'true' are not break-glass", async () => {
    assertPermittedWith(
      'break-glass read and update',
      await asRw(
        ...BREAK_GLASS,
        COUNT(),
        `UPDATE ${TABLE} SET status = 'submitted' WHERE id = '${CRED_B}'`,
      ),
      'n=2;',
      'UPDATE 0',
    );
    assertRefusedBy('break-glass INSERT', await asRw(...BREAK_GLASS, insertRow()), RLS_DENIED);
    for (const v of ['ON', 'true']) {
      assertPermittedWith(
        `break_glass ${v}`,
        await asRw(`SET LOCAL app.break_glass = '${v}'`, COUNT()),
        'n=0;',
      );
    }
  });

  test("MEASURED — after SET LOCAL in one transaction, a later transaction on the same connection reads each GUC as '' (never set: NULL); the NULLIF predicates then show 0 rows and refuse an INSERT", async () => {
    const r = await db.psql({
      user: LOGINS.app_rw,
      password: PROBE_PASSWORD,
      commands: [
        `SELECT 'fresh=' || coalesce(current_setting('app.actor_id', true), '<NULL>') || ';'`,
        'BEGIN',
        ...SITTER(SITTER_A),
        ...BREAK_GLASS,
        COUNT().replace("'n='", "'inside='"),
        'COMMIT',
        `SELECT 'after=' || coalesce(current_setting('app.actor_id', true), '<NULL>') || '|' ||
                coalesce(current_setting('app.actor_role', true), '<NULL>') || '|' ||
                coalesce(current_setting('app.break_glass', true), '<NULL>') || ';'`,
        COUNT().replace("'n='", "'visible='"),
        insertRow(),
      ],
      verbose: true,
      stopOnError: true,
    });
    assert.ok(r.output.includes('fresh=<NULL>;'), `fresh:\n${r.output}`);
    assert.ok(r.output.includes('inside=2;'), `inside:\n${r.output}`);
    assert.ok(r.output.includes('after=||;'), `after:\n${r.output}`);
    assert.ok(r.output.includes('visible=0;'), `visible:\n${r.output}`);
    assertRefusedBy('INSERT after the reset', r, RLS_DENIED);
  });

  test('MEASURED — the owner app_ddl is subject to FORCE: with no GUC, and with the system actor and break-glass set, it sees 0 rows (every policy is TO app_rw), and its INSERT is REFUSED (42501, RLS)', async () => {
    assertPermittedWith('app_ddl, no GUC', await asLogin(LOGINS.app_ddl, COUNT()), 'n=0;');
    assertPermittedWith(
      'app_ddl, system + break-glass',
      await asLogin(LOGINS.app_ddl, ...SYSTEM, ...BREAK_GLASS, COUNT()),
      'n=0;',
    );
    assertRefusedBy(
      'app_ddl INSERT',
      await asLogin(LOGINS.app_ddl, ...SYSTEM, insertRow()),
      RLS_DENIED,
    );
  });

  test("MEASURED — a cascade from sitter_profile removes a sitter's credential rows under FORCE even when the deleting role (app_ddl) can see none of them", async () => {
    const r = await asSuperuser(
      COUNT(`sitter_id = '${SITTER_B}'`).replace("'n='", "'before='"),
      'SET ROLE app_ddl',
      COUNT().replace("'n='", "'ddl-sees='"),
      `DELETE FROM public.sitter_profile WHERE id = '${SITTER_B}'`,
      'RESET ROLE',
      COUNT(`sitter_id = '${SITTER_B}'`).replace("'n='", "'after='"),
      COUNT(`sitter_id = '${SITTER_A}'`).replace("'n='", "'untouched='"),
    );
    assertPermittedWith(
      'cascade',
      r,
      'before=1;',
      'ddl-sees=0;',
      'DELETE 1',
      'after=0;',
      'untouched=1;',
    );
  });
});

describe('0026 — what the database does NOT refuse (stated bounds, each pinned so a change to it is seen)', () => {
  test("NOT HELD — R-2's sitter policies constrain the NEW row only: a sitter moves her own valid row, and her own review_hold row, to submitted (each affects 1 row)", async () => {
    assertPermittedWith(
      'sitter B: valid -> submitted',
      await asRw(
        ...SITTER(SITTER_B),
        `UPDATE ${TABLE} SET status = 'submitted' WHERE id = '${CRED_B}' AND status = 'valid'`,
      ),
      'UPDATE 1',
    );
    const r = await asRw(
      ...SYSTEM,
      `UPDATE ${TABLE} SET status = 'review_hold' WHERE id = '${CRED_B}'`,
      ...SITTER(SITTER_B),
      `UPDATE ${TABLE} SET status = 'submitted' WHERE id = '${CRED_B}' AND status = 'review_hold'`,
    );
    assertPermitted('system sets review_hold, then sitter B: review_hold -> submitted', r);
    assert.equal(
      (r.output.match(/^UPDATE 1$/gm) ?? []).length,
      2,
      `expected two UPDATE 1 tags.\n${r.output}`,
    );
  });

  test('MEASURED consequence — a sitter cannot record an attestation on her own valid row: UPDATE of last_attestation_at alone is REFUSED (42501, RLS), because the new row is valid', async () => {
    const r = await asRw(
      ...SITTER(SITTER_B),
      COUNT(`id = '${CRED_B}' AND status = 'valid'`),
      `UPDATE ${TABLE} SET last_attestation_at = now() WHERE id = '${CRED_B}'`,
    );
    assert.ok(r.output.includes('n=1;'), `the valid row was not visible first.\n${r.output}`);
    assertRefusedBy('sitter attestation on valid row', r, RLS_DENIED);
  });

  test('NOT HELD — S-1 (b)(ii) is a capacity bound, not a format: a reference of three spaces, and one with leading and trailing spaces, are accepted', async () => {
    for (const v of [`'   '`, `' 12 '`]) {
      assertPermittedWith(
        `reference_number ${v}`,
        await asSuperuser(insertRow({ reference_number: v })),
        'INSERT 0 1',
      );
    }
  });
});

describe('0026 — the SA §INT-10 guard', () => {
  test('after up, kinvara_guard.assert_answering_service_write_only() called directly returns clean', async () => {
    assertPermitted(
      'direct call after up',
      await db.psql({
        commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'],
        verbose: true,
        stopOnError: true,
      }),
    );
  });

  test('GRANT SELECT on sitter_credential to answering_service is REFUSED by the guard (KV010), and lands nothing', async () => {
    assertRefusedBy(
      'GRANT SELECT to answering_service',
      await asSuperuser(`GRANT SELECT ON ${TABLE} TO answering_service`),
      `ERROR:  KV010: ${INT10_RAISE}`,
    );
    assert.equal(
      await db.value(`SELECT has_table_privilege('answering_service', '${TABLE}', 'SELECT')::text`),
      'false',
    );
  });
});

describe('0026 — after every case', () => {
  test('the table still holds exactly the two committed fixture rows, unchanged, and the probe is still clean', async () => {
    const r = await db.psql({ commands: [READ_ROWS], raw: true });
    assertPermitted('re-read the fixture rows', r);
    assert.equal(r.stdout.trim(), ROWS_BEFORE);
    assert.equal(await db.value(PROBE_SQL), 'clean');
  });
});
