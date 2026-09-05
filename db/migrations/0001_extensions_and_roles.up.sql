-- 0001_extensions_and_roles.up.sql
--
-- Ticket:  T-020 (tech-lead)
-- Spec:    SD §DH-1 "First thirteen tickets" #3; SD §DB-13 (migration strategy);
--          SD §DB-16 (collation); SD §DB-11 (session_safety_projection / app_safety_rw);
--          SA §INT-10 (the answering-service write-only seam); SA §SEC-9, §SEC-8;
--          SA §DV-13 (ILIKE banned; the collation half of the reason).
--
-- WHO RUNS THIS FILE. 0001 is the bootstrap migration and is the ONLY migration that
-- runs as a superuser (locally `postgres`; on RDS the `rds_superuser` master user).
-- CREATE EXTENSION for postgis/pg_stat_statements/pg_partman is not a trusted-extension
-- operation, and the role that will run migrations from 0002 onward (`app_ddl`) does not
-- exist until this file creates it. Every migration from 0002 onward runs as `app_ddl`,
-- whose credentials require a break-glass checkout (SD §DB-13 rule 6, SA §I-6).
--
-- TRANSACTION. This file is transactional; run it with `psql --single-transaction`.
-- It contains no CREATE INDEX CONCURRENTLY and no ALTER TABLE ... VALIDATE CONSTRAINT,
-- so it carries no `-- @no-transaction` marker (SD §DB-13 rule 4).
--
-- WHAT THIS FILE DOES NOT DO. It does not CREATE DATABASE. A database's locale provider
-- and collation cannot be changed after creation, so the collation is a PROVISIONING
-- decision, not a migration one. Section 0 below therefore ASSERTS the database was
-- created correctly and refuses to run if it was not. The exact CREATE DATABASE statement
-- is published in the T-020 evidence file's `## Published contract`.


-- ===========================================================================
-- Section 0 — preflight. Refuse to run against a wrongly-provisioned database.
-- ===========================================================================
--
-- Why this is an assertion and not a fix: ALTER DATABASE cannot change datlocprovider,
-- datlocale or encoding. The only remedy is to drop and recreate the database, which is
-- cheap on day one and ruinous on day four hundred. SD §DB-16 chooses the ICU provider
-- with the root locale `und`, DETERMINISTIC, for a specific reason: a mixed-script corpus
-- (Greek, Cyrillic, Latin, Greeklish) has no correct single-language collation, and a
-- NON-deterministic collation would disable pattern-matching index support and interact
-- badly with pg_trgm — which this product needs more than it needs a free case-insensitive
-- `=`. Case-insensitivity is achieved by explicit normalisation in packages/text-normalise
-- instead, which is also inspectable.
DO $preflight$
DECLARE
  v_provider "char";
  v_locale   text;
  v_encoding text;
  v_deterministic boolean;
BEGIN
  SELECT d.datlocprovider, d.datlocale, pg_encoding_to_char(d.encoding)
    INTO v_provider, v_locale, v_encoding
    FROM pg_database d
   WHERE d.datname = current_database();

  IF v_encoding IS DISTINCT FROM 'UTF8' THEN
    RAISE EXCEPTION 'database % has encoding %, expected UTF8', current_database(), v_encoding
      USING ERRCODE = 'KV001';
  END IF;

  IF v_provider IS DISTINCT FROM 'i' THEN
    RAISE EXCEPTION
      'database % uses locale provider %, expected the ICU provider (i). '
      'The collation cannot be altered after CREATE DATABASE — recreate the database '
      'with LOCALE_PROVIDER icu ICU_LOCALE ''und'' (SD DB-16).',
      current_database(), v_provider
      USING ERRCODE = 'KV001';
  END IF;

  -- PostgreSQL renders the root ICU locale as 'und'; the collation OBJECT of the same
  -- locale is named "und-x-icu". Both spellings are checked so that either provisioning
  -- style is accepted and neither a typo nor a nearby locale (e.g. 'und-u-ks-level2')
  -- passes.
  IF v_locale IS DISTINCT FROM 'und' AND v_locale IS DISTINCT FROM 'und-x-icu' THEN
    RAISE EXCEPTION
      'database % has ICU locale %, expected the root locale ''und'' (SD DB-16)',
      current_database(), v_locale
      USING ERRCODE = 'KV001';
  END IF;

  -- A database default collation is always deterministic (PostgreSQL rejects a
  -- non-deterministic one at CREATE DATABASE), but the named collation this schema will
  -- cite in column definitions must be deterministic too, and that is worth asserting
  -- rather than assuming.
  SELECT c.collisdeterministic INTO v_deterministic
    FROM pg_collation c WHERE c.collname = 'und-x-icu' AND c.collprovider = 'i';
  IF v_deterministic IS NULL THEN
    RAISE EXCEPTION 'collation "und-x-icu" is not present — this build lacks ICU support'
      USING ERRCODE = 'KV001';
  END IF;
  IF NOT v_deterministic THEN
    RAISE EXCEPTION 'collation "und-x-icu" is non-deterministic; SD DB-16 requires deterministic'
      USING ERRCODE = 'KV001';
  END IF;

  -- pg_stat_statements is the one extension below that installs SUCCESSFULLY and is then
  -- dead. Without the library in shared_preload_libraries, CREATE EXTENSION returns
  -- CREATE EXTENSION and every read of the view raises "must be loaded via
  -- shared_preload_libraries". SD DB-12's weekly review of statements over 50 ms mean on
  -- the request path is the thing that stops working, and nothing goes red. Asserting it
  -- here converts a silent half-install into a refusal (recorded as OD-7).
  IF ('pg_stat_statements' <> ALL (string_to_array(
        translate(current_setting('shared_preload_libraries'), ' ', ''), ','))) THEN
    RAISE EXCEPTION
      'shared_preload_libraries does not contain pg_stat_statements (it is %). CREATE '
      'EXTENSION would succeed and the view would raise on every read — SD DB-12 would be '
      'silently dead. Fix the server parameter, restart, and re-run.',
      quote_literal(current_setting('shared_preload_libraries'))
      USING ERRCODE = 'KV001';
  END IF;
END
$preflight$;


-- ===========================================================================
-- Section 1 — extensions (SD §DH-1 first-ticket #3, verbatim list)
-- ===========================================================================
--
-- Each one names the thing that needs it, so that a later reader can tell whether it is
-- still earning its place.

-- postgis            — the two-tier Cyprus address model and the service-area MULTIPOLYGON
--                      checked with ST_Covers (SD §E1; tech-lead EP-9 obligations).
CREATE EXTENSION IF NOT EXISTS postgis;

-- btree_gist         — I-2 double-booking. The exclusion constraint has to mix an equality
--                      operator on sitter_id with an overlap operator on a tstzrange that
--                      includes travel buffers, and GiST alone cannot do the equality half
--                      (SA §SA-4 I-2; T-029).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- pg_trgm            — fuzzy / typo-tolerant matching over the FOLDED form, across all
--                      three scripts with one index. One of the four named substitutes for
--                      the banned ILIKE (SA §DV-13, SD §DB-16).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent           — step 4 of the normalisation pipeline (diacritic folding: Greek
--                      tonos/dialytika, Russian ё→е) (SD §DB-16).
CREATE EXTENSION IF NOT EXISTS unaccent;

-- pgcrypto           — digest()/hmac() for the audit_log hash chain (SA §SEC-8) and
--                      gen_random_bytes for nonces. NOT for envelope encryption: that is
--                      packages/crypto over KMS and it is the only code permitted to hold
--                      a key (SA §SEC-2, tech-lead charter).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_partman         — time-partitioning of the high-volume append-only tables
--                      (audit_log, session_event) so retention is a DETACH rather than a
--                      DELETE (SA §DA-10, §DG-6).
CREATE EXTENSION IF NOT EXISTS pg_partman;

-- pg_stat_statements — SD §DB-12 "reviewed weekly; any statement above 50 ms mean on the
--                      request path gets a ticket". REQUIRES the library to be preloaded:
--                      shared_preload_libraries must contain pg_stat_statements or the
--                      view raises at query time even though CREATE EXTENSION succeeds.
--                      That is a compose/parameter-group obligation, recorded in the
--                      T-020 published contract for T-016 and for the RDS parameter group.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;


-- ===========================================================================
-- Section 2 — the five roles (SD §DH-1 first-ticket #3; SA §SEC-9; SD §DB-11)
-- ===========================================================================
--
-- All five are NOLOGIN group roles with NO password. Login principals are created per
-- environment and granted membership; their credentials live in Secrets Manager and
-- rotate every 30 days (SA §SEC-11). A password in a migration is a password in git.
--
-- The attributes are spelled out rather than left to defaults, because the defaults are
-- what a future `CREATE ROLE x` would inherit and this file is the place a reader looks
-- to find out what these principals can do.

-- app_rw — the runtime role for `core` and `worker`. Ordinary DML on the tables it is
-- granted, INSERT-ONLY on the append-only tables (audit_log, case_note, decision_record —
-- SA §SEC-8, and the grants land with those tables, not here).
CREATE ROLE app_rw
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
COMMENT ON ROLE app_rw IS
  'Runtime role for core and worker. DML only, never DDL. INSERT-only on audit_log, '
  'case_note and decision_record (SA SEC-8). Owns nothing. Ticket T-020.';

-- app_admin_rw — the back-office role for `admin`. A DISTINCT role from app_rw so that
-- SA §T2 (compromise of the back-office) is bounded by grants rather than by application
-- code, and so PgBouncer can hold a separate pool per role (SD §DB-14). RLS is enforced
-- with FORCE ROW LEVEL SECURITY on the tables it reaches, which is the owning table's
-- migration to write, not this one (SA §SEC-9).
CREATE ROLE app_admin_rw
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
COMMENT ON ROLE app_admin_rw IS
  'Back-office role for apps/admin. Grants only on the tables admin needs; RLS with '
  'FORCE ROW LEVEL SECURITY applies to it (SA SEC-9). INSERT-only on the append-only '
  'tables. Ticket T-020.';

-- app_safety_rw — the role for apps/safety-gw. Its whole point is that safety-gw keeps
-- working with `core` entirely down, and that it touches exactly one table it does not
-- own, by published contract (SD §DB-11, SD §Q/UC preamble line "read-only for safety-gw
-- (enforced by a distinct DB role)"). The grants themselves land with the tables:
--   SELECT                    ON session_safety_projection
--   INSERT                    ON session_event, checkin, sos_event, ladder_run
-- and NOTHING else. See the T-020 published contract for the carried obligation.
CREATE ROLE app_safety_rw
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
COMMENT ON ROLE app_safety_rw IS
  'apps/safety-gw. SELECT on session_safety_projection only; INSERT on session_event, '
  'checkin, sos_event, ladder_run only; no other grant exists (SD DB-11). Ticket T-020.';

-- app_ddl — the migration role, from 0002 onward. Owns schema public and therefore every
-- object created in it. Credentials require a break-glass checkout with approval and
-- expiry (SD §DB-13 rule 6; SA §SEC-9, §I-6). No application ever connects as this role.
CREATE ROLE app_ddl
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
COMMENT ON ROLE app_ddl IS
  'Migration role from 0002 onward; owner of schema public and of every object in it. '
  'Break-glass credential checkout only (SD DB-13 rule 6). Ticket T-020.';

-- answering_service — SA §INT-10. THE DEFINING PROPERTY OF THIS ROLE IS WHAT IT CANNOT DO.
--
--   GRANT INSERT ON out_of_hours_report TO answering_service;
--   GRANT SELECT ON NOTHING.  (no SELECT grant exists on any object)
--
-- The contracted out-of-hours answering service is a GDPR processor whose data-minimisation
-- position PM §MVP-IS9 AC4 asserts. A DPA says the vendor will not read personal data; a
-- SELECT-less database role means it cannot. A compromise of the vendor's credential
-- yields the ability to create NOISE, never to READ. That is the whole design, and it is
-- the reason this is enforced at the grant level and not by API design.
--
-- Section 5 below makes the boundary self-enforcing rather than merely documented.
CREATE ROLE answering_service
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
COMMENT ON ROLE answering_service IS
  'SA INT-10 write-only seam. INSERT on public.out_of_hours_report and NOTHING else; '
  'SELECT on nothing, anywhere, ever. Enforced by public.assert_answering_service_'
  'write_only() and the event trigger trg_int10_answering_service. Ticket T-020.';


-- ===========================================================================
-- Section 3 — database- and schema-level grants
-- ===========================================================================
--
-- PUBLIC is stripped first. By default every role in the cluster can CONNECT to and
-- create temporary tables in any database, and can USE schema public. Leaving that in
-- place would mean the five roles' grants describe only part of what they can do.
DO $dbgrants$
DECLARE
  db text := quote_ident(current_database());
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %s FROM PUBLIC', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %s TO app_rw, app_admin_rw, app_safety_rw, app_ddl, answering_service', db);
  -- TEMP is a write channel, not a read channel, but it is also a resource-exhaustion
  -- channel. safety-gw and the vendor principal have no use for it.
  EXECUTE format('GRANT TEMPORARY ON DATABASE %s TO app_rw, app_admin_rw, app_ddl', db);
END
$dbgrants$;

-- app_ddl owns schema public and is the only role that may create in it.
ALTER SCHEMA public OWNER TO app_ddl;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_rw, app_admin_rw, app_safety_rw, answering_service;
GRANT USAGE, CREATE ON SCHEMA public TO app_ddl;

-- NO `ALTER DEFAULT PRIVILEGES` IS ISSUED HERE, DELIBERATELY, AND IT IS THE MOST
-- LOAD-BEARING OMISSION IN THIS FILE.
--
-- The convenient thing to do is `ALTER DEFAULT PRIVILEGES FOR ROLE app_ddl IN SCHEMA
-- public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw`, so that every future
-- table is automatically usable. Two reasons not to:
--
--   1. It fails SILENTLY in the wrong direction. audit_log, case_note and decision_record
--      must be INSERT-only for app_rw (SA §SEC-8). Under a blanket default privilege, the
--      migration that creates audit_log is correct only if its author remembers to REVOKE
--      UPDATE and DELETE. Forgetting produces a tamper-evidence table the application can
--      rewrite, and nothing anywhere goes red. Without default privileges, forgetting a
--      grant produces a query that fails on the first call — loud, immediate, and cheap.
--   2. A default ACL is exactly how `answering_service` or `app_safety_rw` would acquire
--      SELECT on a table created three epics from now, by a migration whose author never
--      thought about either role.
--
-- Consequence, and it is a real cost: EVERY migration that creates a table must grant
-- explicitly. T-021's migration lint owes the rule that a CREATE TABLE without an
-- accompanying GRANT fails (see the T-020 published contract).


-- ===========================================================================
-- Section 4 — grants that belong to tables that do not exist yet
-- ===========================================================================
--
-- Stated here as the specification, and NOT issued, because issuing a grant on a
-- non-existent object is not possible and faking the object would be worse. The owning
-- ticket issues the grant in the same migration that creates the table. This block is the
-- authoritative list; the T-020 published contract repeats it for downstream agents.
--
--   out_of_hours_report        (T-112, safety) :  GRANT INSERT ON out_of_hours_report TO answering_service;
--                                                 and NOTHING else, to anybody's surprise.
--                                                 Its primary key MUST be a ULID or an
--                                                 IDENTITY column, never `serial` — a
--                                                 serial default needs USAGE on a sequence
--                                                 and Section 5 forbids answering_service
--                                                 holding any sequence privilege at all.
--   session_safety_projection  (T-101, safety) :  GRANT SELECT ON ... TO app_safety_rw;
--                                                 GRANT SELECT, INSERT, UPDATE ON ... TO app_rw;
--   session_event, checkin,
--   sos_event, ladder_run      (EP-12, safety) :  GRANT INSERT ON ... TO app_safety_rw;
--   audit_log, case_note,
--   decision_record            (T-035/EP-1)    :  GRANT INSERT ON ... TO app_rw, app_admin_rw;
--                                                 no UPDATE, no DELETE, to any role but app_ddl.


-- ===========================================================================
-- Section 5 — SA §INT-10 made self-enforcing
-- ===========================================================================
--
-- Everything above is a grant. A grant is a fact about today. This section is the part
-- that survives fifteen downstream tickets written by agents who have never read INT-10.
--
-- assert_answering_service_write_only() raises if `answering_service` can reach ANY data
-- by ANY route. It uses has_*_privilege() rather than reading ACLs, so it sees privileges
-- acquired through PUBLIC and through role membership, not only through a GRANT naming the
-- role. It is wired to an event trigger below, and it is also the reconciler query.
CREATE OR REPLACE FUNCTION public.assert_answering_service_write_only()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $int10$
DECLARE
  -- The single permitted INSERT target. Hardcoded on purpose: widening this seam should
  -- cost a migration and a two-approval review (PROTOCOL §3), not a row in a config table.
  k_table  constant text := 'public.out_of_hours_report';
  k_role   constant name := 'answering_service';
  k_oid    oid;
  v_msgs   text[] := '{}';
  v        text;
BEGIN
  SELECT oid INTO k_oid FROM pg_roles WHERE rolname = k_role;
  IF k_oid IS NULL THEN
    -- The role is absent (0001 has been rolled back). Nothing to assert.
    RETURN;
  END IF;

  FOR v IN
    -- (1) Role attributes. BYPASSRLS in particular would defeat every row-level policy
    --     in the system without touching a single GRANT.
    SELECT format('answering_service holds forbidden role attribute(s): %s',
                  concat_ws(', ',
                    CASE WHEN r.rolsuper       THEN 'SUPERUSER'   END,
                    CASE WHEN r.rolcreatedb    THEN 'CREATEDB'    END,
                    CASE WHEN r.rolcreaterole  THEN 'CREATEROLE'  END,
                    CASE WHEN r.rolreplication THEN 'REPLICATION' END,
                    CASE WHEN r.rolbypassrls   THEN 'BYPASSRLS'   END))
      FROM pg_roles r
     WHERE r.oid = k_oid
       AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)

    UNION ALL
    -- (2) Membership in any other role. `GRANT app_rw TO answering_service` cannot be
    --     trapped by an event trigger — role grants are cluster-global objects and
    --     PostgreSQL refuses to fire event triggers for the GRANT ROLE tag. This check is
    --     the compensating control, and it is why the reconciler obligation exists.
    SELECT format('answering_service is a member of role %I — membership confers privileges '
                  'that no GRANT on a table would show', r.rolname)
      FROM pg_roles r
     WHERE r.oid <> k_oid
       AND pg_has_role(k_oid, r.oid, 'MEMBER')   -- MEMBER, not USAGE: a membership granted
                                                --   WITH INHERIT FALSE still permits SET ROLE.

    UNION ALL
    -- (3) The mirror of (2): a per-environment login principal that is a member of
    --     answering_service must be a member of NOTHING ELSE. Superusers are excluded
    --     because pg_has_role() is true for them against every role by definition.
    SELECT format('login role %I is a member of answering_service and also of %I — it can '
                  'read what answering_service cannot', m.rolname, o.rolname)
      FROM pg_roles m
      JOIN pg_roles o ON o.oid <> m.oid AND o.oid <> k_oid
     WHERE m.oid <> k_oid
       AND NOT m.rolsuper
       AND pg_has_role(m.oid, k_oid, 'MEMBER')
       AND pg_has_role(m.oid, o.oid, 'MEMBER')

    UNION ALL
    -- (4) Any relation privilege other than INSERT, anywhere outside the system catalogs.
    SELECT format('answering_service holds %s on %I.%I — INT-10 permits INSERT and nothing else',
                  p.priv, n.nspname, c.relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(priv)
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg\_toast%'
       AND has_table_privilege(k_oid, c.oid, p.priv)

    UNION ALL
    -- (5) INSERT on anything but the one permitted table.
    SELECT format('answering_service holds INSERT on %I.%I — the only permitted target is %s',
                  n.nspname, c.relname, k_table)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg\_toast%'
       AND has_table_privilege(k_oid, c.oid, 'INSERT')
       AND n.nspname || '.' || c.relname <> k_table

    UNION ALL
    -- (6) Column-level privileges. A GRANT SELECT (col) does not show up in
    --     has_table_privilege(), which is exactly why this check is separate.
    SELECT format('answering_service holds column privilege %s on %I.%I.%I',
                  p.priv, n.nspname, c.relname, a.attname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     CROSS JOIN unnest(ARRAY['SELECT','UPDATE','REFERENCES']) AS p(priv)
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg\_toast%'
       AND has_column_privilege(k_oid, c.oid, a.attnum, p.priv)

    UNION ALL
    -- (7) Sequences. SELECT on a sequence discloses row counts and arrival rates; USAGE
    --     is only needed by `serial` defaults, and the permitted table is required by
    --     Section 4 not to use one.
    SELECT format('answering_service holds %s on sequence %I.%I', p.priv, n.nspname, c.relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT','USAGE','UPDATE']) AS p(priv)
     WHERE c.relkind = 'S'
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND has_sequence_privilege(k_oid, c.oid, p.priv)

    UNION ALL
    -- (8) SECURITY DEFINER functions. A definer function is a read channel that no table
    --     grant describes. Extension-owned functions are excluded: they are installed by
    --     Section 1, are not our attack surface, and cannot be revoked without breaking
    --     the extension.
    SELECT format('answering_service can EXECUTE SECURITY DEFINER function %s — a definer '
                  'function is a read channel', p.oid::regprocedure::text)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND has_function_privilege(k_oid, p.oid, 'EXECUTE')

    UNION ALL
    -- (9) Default ACLs — the time bomb. A default privilege granted today applies to a
    --     table created in EP-13 by an agent who never heard of INT-10.
    SELECT format('a default privilege grants %s on %s objects in schema %s to %s',
                  a.privilege_type,
                  CASE d.defaclobjtype WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence'
                                       WHEN 'f' THEN 'function' WHEN 'T' THEN 'type'
                                       WHEN 'n' THEN 'schema' ELSE d.defaclobjtype::text END,
                  coalesce(quote_ident(ns.nspname), '(all)'),
                  CASE WHEN a.grantee = 0 THEN 'PUBLIC — answering_service inherits it'
                       ELSE 'answering_service' END)
      FROM pg_default_acl d
      LEFT JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
     CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
     WHERE a.grantee IN (0, k_oid)

    UNION ALL
    -- (10) CREATE on a schema. Not a read channel by itself, but it lets the principal
    --      create an object it owns and therefore holds every privilege on — including a
    --      view, once it has any SELECT anywhere.
    SELECT format('answering_service holds CREATE on schema %I', n.nspname)
      FROM pg_namespace n
     WHERE n.nspname NOT LIKE 'pg\_%'
       AND n.nspname <> 'information_schema'
       AND has_schema_privilege(k_oid, n.oid, 'CREATE')
  LOOP
    v_msgs := v_msgs || v;
  END LOOP;

  IF array_length(v_msgs, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'INT10_ANSWERING_SERVICE_READ_PATH: the answering-service principal can reach data'
      USING ERRCODE = 'KV010',
            DETAIL  = array_to_string(v_msgs, E'\n'),
            HINT    = 'SA INT-10: this principal has INSERT on public.out_of_hours_report and '
                      'SELECT on nothing. Revoke, or take the change through a two-approval '
                      'review that amends 0001''s allowlist (PROTOCOL section 3).';
  END IF;
END
$int10$;

COMMENT ON FUNCTION public.assert_answering_service_write_only() IS
  'SA INT-10 boundary check. Raises SQLSTATE KV010 if answering_service can reach data by '
  'any route: a grant, PUBLIC, role membership, a column grant, a sequence, a SECURITY '
  'DEFINER function, or a default ACL. Wired to trg_int10_answering_service, and also the '
  'reconciler query. Ticket T-020.';

CREATE OR REPLACE FUNCTION public.trg_assert_answering_service_write_only()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $int10trg$
BEGIN
  PERFORM public.assert_answering_service_write_only();
END
$int10trg$;

-- The tag list is exactly the set of commands that can make a new object reachable.
-- `GRANT ROLE` is absent because PostgreSQL refuses it: "event triggers are not supported
-- for GRANT ROLE" (verified on 18.6). That hole is covered by check (2) above plus the
-- reconciler obligation in the T-020 published contract — it is a KNOWN GAP, stated, not
-- an oversight.
CREATE EVENT TRIGGER trg_int10_answering_service
  ON ddl_command_end
  WHEN TAG IN ('GRANT',
               'ALTER DEFAULT PRIVILEGES',
               'CREATE TABLE',
               'CREATE TABLE AS',
               'CREATE VIEW',
               'CREATE MATERIALIZED VIEW',
               'CREATE FOREIGN TABLE',
               'SELECT INTO')
  EXECUTE FUNCTION public.trg_assert_answering_service_write_only();

COMMENT ON EVENT TRIGGER trg_int10_answering_service IS
  'SA INT-10. DO NOT DROP OR DISABLE. Fires assert_answering_service_write_only() on any '
  'command that can make an object reachable, so a migration in a later epic cannot hand '
  'the answering-service vendor a read path by accident. Ticket T-020.';

-- Belt and braces: assert the state this file itself just created.
SELECT public.assert_answering_service_write_only();
