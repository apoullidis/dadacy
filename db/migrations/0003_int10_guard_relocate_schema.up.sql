-- 0003_int10_guard_relocate_schema.up.sql
--
-- @phase: expand
-- @run-as: bootstrap-superuser — OE-23; T-143 (moves and replaces functions the bootstrap
--          superuser owns — ALTER FUNCTION SET SCHEMA and CREATE OR REPLACE are superuser-
--          only here, T-021 § contract §4 S1-O; app_ddl gets 42501 must be owner of function)
-- @compliance-review: trg_int10_answering_service — T-143, two-approval path (PROTOCOL §3); OE-23, OD-73, OD-75
-- @compliance-review: assert_answering_service_write_only — T-143, two-approval path (PROTOCOL §3); OE-23, OD-73, OD-75
-- @compliance-review: trg_assert_answering_service_write_only — T-143, two-approval path (PROTOCOL §3); OE-23, OD-73, OD-75
--
-- Ticket:  T-143 (tech-lead)
-- Spec:    SA §INT-10, §SA-4 (layering); decisions.md OE-23, OD-73, OD-75, OD-76;
--          T-020 § Published contract §3/§5/§6; T-021 § Published contract (rework 2) §4.
--
-- WHY THIS MIGRATION EXISTS. 0001 makes app_ddl the OWNER of schema public and creates both
-- SA §INT-10 guard functions THERE. A schema's owner may drop any object in it, so a
-- NON-SUPERUSER app_ddl login can disarm the guard two ways, both reproduced on main's 0001
-- and on 0001+0002 (OD-73 by tech-lead, OD-75 by qa-verification):
--   A4  DROP FUNCTION public.assert_answering_service_write_only(); then CREATE a no-op of
--       the same name. The check then returns clean; GRANT SELECT ... TO answering_service
--       succeeds and the vendor reads a planted row.
--   A5  DROP FUNCTION public.trg_assert_answering_service_write_only() CASCADE, which removes
--       the event trigger. GRANT SELECT ... TO answering_service then succeeds.
-- What already held (re-measured, refused 42501 to that login): DROP/DISABLE of the event
-- trigger OBJECT, and SET event_triggers. The event-trigger OBJECT is safe; the guard as a
-- whole was not, because it hangs off two functions app_ddl could drop.
--
-- THE FIX (OE-23, stakeholder chose A). Move both functions into a NEW schema kinvara_guard,
-- owned by the bootstrap superuser. app_ddl does not own it and holds NO CREATE on it; it
-- holds USAGE only, so that its own DDL can fire the guard (see HOW LEGITIMATE DDL STILL
-- FIRES THE GUARD). app_ddl then cannot drop or replace either function, divert the
-- schema-qualified calls with a same-named function in public, or drop the schema (each
-- measured as an app_ddl-only login, T-143 evidence). Ownership of schema public is
-- UNCHANGED (stakeholder rejected option B).
--
-- WHY NOT RE-CREATE THE EVENT TRIGGER. The trigger function is RELOCATED with ALTER FUNCTION
-- ... SET SCHEMA, which keeps its OID, so trg_int10_answering_service keeps pointing at it
-- and is never dropped or re-created. That also keeps the event trigger's WHEN TAG list —
-- 'ALTER DEFAULT PRIVILEGES', 'CREATE TABLE AS' and the rest — out of this migration's text,
-- where gate:migration-lint would (correctly, by its own design) read those string literals
-- as if they were statements. 0001 carries that tag list under the R-BASELINE exemption;
-- this migration keeps it there rather than restating it.
--
-- HOW LEGITIMATE DDL STILL FIRES THE GUARD. An event trigger's function runs with the
-- privileges of the role that fired the DDL, and its body calls kinvara_guard.assert_...().
-- app_ddl fires the event trigger whenever it runs a migration (CREATE TABLE, GRANT, …), so
-- app_ddl is given USAGE on kinvara_guard and EXECUTE on the check function — enough to CALL
-- the guard, not enough to touch it (USAGE is not ownership, and A4/A5 stay 42501; measured,
-- T-143 evidence). Without that grant the trigger body would fail with "permission denied for
-- schema kinvara_guard" and break every future app_ddl migration. The trigger function is
-- SECURITY INVOKER, as 0001's is: a SECURITY DEFINER function would be granted EXECUTE to
-- PUBLIC (hence answering_service) the instant it is created, and the event trigger fires at
-- that same statement's ddl_command_end — before any REVOKE could run — so the guard's own
-- check (8) would see a SECURITY DEFINER function reachable by answering_service and raise
-- (measured, T-143 evidence). The check reads only world-readable catalogues, so its verdict
-- does not depend on the caller.
--
-- WHO RUNS THIS FILE. The bootstrap superuser (the @run-as marker above). The db:migrate
-- runner reads that marker; its down file runs the same way (T-136 § contract §6). Run with
-- `psql --single-transaction`; transactional, no `-- @no-transaction` marker.
--
-- NOT TOUCHED. Merged 0001 and 0002 (PROTOCOL §3 — this is a new migration); extensions (no
-- CREATE EXTENSION here, so TL-A5's mid-install refusal window does not arise); T-033's
-- reconciler, which codes against the kinvara_guard.* names published here.

-- ===========================================================================
-- 1. The guard's own schema — owned by the bootstrap superuser; app_ddl gets USAGE, never CREATE
-- ===========================================================================
CREATE SCHEMA kinvara_guard;
COMMENT ON SCHEMA kinvara_guard IS
  'Holds the SA §INT-10 guard functions. Owned by the bootstrap superuser. app_ddl does not '
  'own it and holds USAGE (to fire the guard) but no CREATE here, which is what puts the '
  'guard functions out of a break-glass DDL session''s reach (OE-23, OD-73). Ticket T-143.';
-- A fresh schema grants PUBLIC nothing; this REVOKE is belt-and-braces and documents intent.
REVOKE ALL ON SCHEMA kinvara_guard FROM PUBLIC;

-- ===========================================================================
-- 2. The check function, in its new home. Body identical to 0002's (check 17 included).
-- ===========================================================================
CREATE FUNCTION kinvara_guard.assert_answering_service_write_only()
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
  -- The extensions whose functions read server-wide statistics (check 17, OD-52). Hardcoded
  -- for the same reason as k_table: widening or narrowing it costs a migration and a
  -- two-approval review.
  k_stat_extensions constant name[] := ARRAY['pg_stat_statements']::name[];
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
    --     grant describes.
    --
    --     An earlier version of this check excluded extension-owned functions on the
    --     reasoning that they are vetted and cannot be revoked without breaking the
    --     extension. qa-verification (QA-F13) measured the exclusion and found it covered
    --     ZERO functions across all seven extensions — so it was buying nothing today while
    --     standing as a permanent blind spot for whichever extension a later epic adds.
    --     CREATE EXTENSION is in this trigger's tag list precisely because that can happen.
    --     The exclusion is removed: if an extension ships a definer function reachable by
    --     this principal, that is a read path and the migration adding it must revoke
    --     EXECUTE from PUBLIC, exactly as Section 3 does for pg_stat_statements.
    SELECT format('answering_service can EXECUTE SECURITY DEFINER function %s — a definer '
                  'function is a read channel', p.oid::regprocedure::text)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname NOT IN ('pg_catalog','information_schema')
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

    -- Checks (11) to (16) exist because qa-verification found QA-F9: checks (1) to (10)
    -- covered relations, columns, sequences, functions, default ACLs, schemas, role
    -- attributes and membership, and NOTHING ELSE — while this function was published as
    -- refusing a read path "by any route". `GRANT SELECT ON LARGE OBJECT 424242 TO
    -- answering_service` returned GRANT, this function returned clean, and the principal
    -- then read the object in full. A large object is not a relation, so no check saw it.
    --
    -- The lesson is the reason these six are written by ENUMERATING PostgreSQL's object
    -- classes rather than by imagining attacks: the classes GRANT can name are a closed,
    -- documented list, and going through it is finite work. Every class is now either
    -- checked below or named in the coverage statement above with the reason it is not.

    UNION ALL
    -- (11) Large objects. QA-F9 itself.
    SELECT format('answering_service holds %s on large object %s', p.priv, l.oid)
      FROM pg_largeobject_metadata l
     CROSS JOIN unnest(ARRAY['SELECT','UPDATE']) AS p(priv)
     WHERE has_largeobject_privilege(k_oid, l.oid, p.priv)

    UNION ALL
    -- (12) Server parameters (PG15+). The second class QA-F9 found unchecked. Not a read
    --      path on its own, but ALTER SYSTEM in the hands of a principal held outside our
    --      own staff boundary (SA §SEC-10) is a configuration-control path, and `SET` on
    --      the wrong parameter is a step towards one.
    SELECT format('answering_service holds %s on parameter %s', p.priv, a.parname)
      FROM pg_parameter_acl a
     CROSS JOIN unnest(ARRAY['SET','ALTER SYSTEM']) AS p(priv)
     WHERE has_parameter_privilege(k_oid, a.parname, p.priv)

    UNION ALL
    -- (13) This database. CONNECT is granted by Section 3 and is required. CREATE would let
    --      the principal create a schema and then objects it owns every privilege on;
    --      TEMPORARY is a resource-exhaustion path. Scoped to current_database() on purpose:
    --      PUBLIC holds CONNECT and TEMPORARY on OTHER databases of the cluster by default,
    --      and 0001 governs its own database, not the cluster's other tenants.
    SELECT format('answering_service holds %s on database %I', p.priv, d.datname)
      FROM pg_database d
     CROSS JOIN unnest(ARRAY['CREATE','TEMPORARY']) AS p(priv)
     WHERE d.datname = current_database()
       AND has_database_privilege(k_oid, d.oid, p.priv)

    UNION ALL
    -- (14) UNTRUSTED PROCEDURAL languages (plpython3u, plperlu, …). USAGE on one, plus
    --      CREATE on a schema, is arbitrary code execution as the server user. Two filters,
    --      both load-bearing and both established by measurement rather than by reading:
    --        lanispl      — excludes `c` and `internal`, which are call handlers rather than
    --                       languages. has_language_privilege() reports USAGE on both for
    --                       every role, and creating a function in either requires superuser
    --                       regardless, so without this filter the check fires on a clean
    --                       database. It did, on the first run.
    --        lanpltrusted — trusted languages are deliberately permitted: PUBLIC holds USAGE
    --                       on plpgsql by default and it is inert without the schema CREATE
    --                       that check (10) forbids.
    SELECT format('answering_service holds USAGE on untrusted language %I', l.lanname)
      FROM pg_language l
     WHERE l.lanispl
       AND NOT l.lanpltrusted
       AND has_language_privilege(k_oid, l.oid, 'USAGE')

    UNION ALL
    -- (15) Foreign servers and foreign data wrappers. USAGE on a server plus a schema CREATE
    --      is a foreign table over whatever that server can reach — including, on a
    --      file_fdw or postgres_fdw, data this database does not hold.
    SELECT format('answering_service holds USAGE on foreign server %I', srv.srvname)
      FROM pg_foreign_server srv
     WHERE has_server_privilege(k_oid, srv.oid, 'USAGE')

    UNION ALL
    SELECT format('answering_service holds USAGE on foreign data wrapper %I', w.fdwname)
      FROM pg_foreign_data_wrapper w
     WHERE has_foreign_data_wrapper_privilege(k_oid, w.oid, 'USAGE')

    UNION ALL
    -- (16) Tablespaces. Not a read path, and included only so that the coverage claim in the
    --      published contract is true of every object class GRANT can name rather than of
    --      every class somebody thought of.
    SELECT format('answering_service holds CREATE on tablespace %I', t.spcname)
      FROM pg_tablespace t
     WHERE has_tablespace_privilege(k_oid, t.oid, 'CREATE')

    UNION ALL
    -- (17) EXECUTE on the functions of a statistics extension. OD-52, T-021.
    --      Check (8) reads only SECURITY DEFINER functions, on the premise that an invoker
    --      function runs with the caller's own privileges. That premise does not hold for a
    --      C function that reads server-wide shared memory: pg_stat_statements(boolean) is
    --      an invoker function and returns statistics for every role's statements. Section 3
    --      of 0001 revokes EXECUTE on it from PUBLIC, and until this check nothing noticed
    --      if that revoke was missing. This check reads extension membership from pg_depend
    --      rather than listing signatures. It covers ONLY the extensions named in
    --      k_stat_extensions; an invoker function anywhere else is not checked.
    SELECT format('answering_service can EXECUTE %s, a function of extension %I that reads '
                  'server-wide statistics which no table privilege describes',
                  p.oid::regprocedure::text, e.extname)
      FROM pg_depend d
      JOIN pg_extension e ON e.oid = d.refobjid
      JOIN pg_proc p ON p.oid = d.objid
     WHERE d.classid = 'pg_proc'::regclass
       AND d.refclassid = 'pg_extension'::regclass
       AND d.deptype = 'e'
       AND e.extname = ANY (k_stat_extensions)
       AND has_function_privilege(k_oid, p.oid, 'EXECUTE')
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

COMMENT ON FUNCTION kinvara_guard.assert_answering_service_write_only() IS
  'SA INT-10 boundary check for role answering_service. Raises SQLSTATE KV010 on any '
  'privilege it finds that lets that role reach data. Uses has_*_privilege(), so it sees '
  'reachability through PUBLIC and through role membership, not only a GRANT naming the role. '
  'CHECKS these object classes: relations, columns, sequences, default ACLs, schema CREATE, '
  'large objects, server parameters, this database, untrusted procedural languages, foreign '
  'servers, foreign data wrappers, tablespaces; role attributes and role membership in both '
  'directions. Of FUNCTIONS it checks only two kinds: SECURITY DEFINER functions, and every '
  'function of the extensions it names (today pg_stat_statements, OD-52). An ordinary invoker '
  'function outside those extensions is NOT checked, and an invoker C function elsewhere that '
  'reads shared state would be a read path this function does not see. '
  'DOES NOT COVER, deliberately: types and domains (PUBLIC USAGE is required and conveys '
  'no data); trusted languages (inert without the schema CREATE this rejects); the system '
  'catalogues, which PostgreSQL makes world-readable — pg_stat_user_tables leaks row '
  'counts and arrival rates but no row data; and other databases of the cluster. '
  'PREVENTIVE only where the GRANT fires an event trigger, which is exactly the '
  'per-database catalogues. DETECTIVE ONLY for the four grantable shared catalogues — '
  'pg_database, pg_parameter_acl, pg_tablespace and pg_auth_members (role membership) — '
  'which fire nothing. A scheduled reconciler (T-033) is what closes those four. '
  'Lives in schema kinvara_guard, owned by the bootstrap superuser, where app_ddl holds USAGE '
  'but no CREATE and owns nothing, so '
  'a break-glass app_ddl session can no longer drop, replace or shadow it (OE-23, OD-73; was '
  'public.assert_answering_service_write_only until T-143). Call it DIRECTLY and assert the '
  'raise; a value selected past it never executes it (OD-76). '
  'Wired to event trigger trg_int10_answering_service. Tickets T-020, T-021, T-143.';

-- The check reads only world-readable catalogues, so PUBLIC EXECUTE would be harmless, but
-- 0001's ethos is to grant to named roles. Two callers need it:
--   * app_ddl — the event trigger's INVOKER body runs as whoever fired the DDL, and that is
--     app_ddl during a migration (see the header). USAGE + EXECUTE, nothing more.
--   * app_rw — the reconciler (T-033) runs under the worker, which connects as app_rw, and
--     calls the guard directly.
-- USAGE is not ownership: neither role can drop, replace or add to kinvara_guard (A4/A5 stay
-- 42501, measured). answering_service is deliberately NOT granted EXECUTE.
REVOKE ALL ON FUNCTION kinvara_guard.assert_answering_service_write_only() FROM PUBLIC;
GRANT USAGE ON SCHEMA kinvara_guard TO app_ddl, app_rw;
GRANT EXECUTE ON FUNCTION kinvara_guard.assert_answering_service_write_only() TO app_ddl, app_rw;

-- ===========================================================================
-- 3. Relocate the event-trigger function (OID kept) and point it at the new check
-- ===========================================================================
-- SET SCHEMA keeps the function's OID, so trg_int10_answering_service follows it and is never
-- re-created. Its body still names public.assert_...() at this instant, which still exists.
ALTER FUNCTION public.trg_assert_answering_service_write_only() SET SCHEMA kinvara_guard;
-- Now repoint the body at the relocated check (see header for why it is SECURITY INVOKER,
-- as 0001's is). CREATE OR REPLACE keeps the OID, so the event trigger's reference stays valid.
CREATE OR REPLACE FUNCTION kinvara_guard.trg_assert_answering_service_write_only()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $int10trg$
BEGIN
  PERFORM kinvara_guard.assert_answering_service_write_only();
END
$int10trg$;
COMMENT ON FUNCTION kinvara_guard.trg_assert_answering_service_write_only() IS
  'Event-trigger body for trg_int10_answering_service. SECURITY INVOKER (as 0001''s was): it '
  'runs as the role that fired the DDL — app_ddl during a migration, which holds USAGE on '
  'kinvara_guard and EXECUTE on the check. Calls kinvara_guard.assert_answering_service_write_'
  'only() by its schema-qualified name, so no public shadow can divert it. Tickets T-020, T-143.';
-- The event trigger is invoked by the system, not via EXECUTE privilege (measured: it fires
-- for a role with no EXECUTE grant on this function), so revoking PUBLIC EXECUTE does not
-- disarm it. Kept for tidiness; answering_service has no reason to call it.
REVOKE ALL ON FUNCTION kinvara_guard.trg_assert_answering_service_write_only() FROM PUBLIC;

-- ===========================================================================
-- 4. Remove the old public check function (the trigger now calls the relocated one)
-- ===========================================================================
-- No CASCADE (R-CASCADE): nothing depends on it now. DROP FUNCTION is not an event-trigger
-- tag, so this fires nothing.
DROP FUNCTION public.assert_answering_service_write_only();

-- ===========================================================================
-- 5. Refresh the event trigger's COMMENT to name the relocated function
-- ===========================================================================
COMMENT ON EVENT TRIGGER trg_int10_answering_service IS
  'SA INT-10. DO NOT DROP OR DISABLE. Fires kinvara_guard.assert_answering_service_write_'
  'only() on any command that can make an object reachable. Its function now lives in schema '
  'kinvara_guard, out of app_ddl''s reach (OE-23, OD-73). Tickets T-020, T-143.';

-- ===========================================================================
-- 6. Correct the COMMENT ON ROLE that ships into pg_shdescription (T-143 brief)
-- ===========================================================================
-- 0001's COMMENT ON ROLE app_ddl said app_ddl runs "migrations from 0002 onward". That is
-- false: 0002 and this migration replace superuser-owned objects and run as the bootstrap
-- superuser (T-021 42501; T-136 § contract §6). A COMMENT ships into pg_shdescription, so it
-- is corrected here, not by editing merged 0001 (PROTOCOL §3).
COMMENT ON ROLE app_ddl IS
  'Migration role. Owner of schema public and of the objects migrations running as it create '
  'there (extension objects in public stay the bootstrap superuser''s), but NOT of schema '
  'kinvara_guard, on which it holds USAGE and no CREATE (T-143). Runs migrations from 0002 onward '
  'EXCEPT one that must replace a superuser-owned object or needs a superuser-only statement, '
  'which runs as the bootstrap superuser — 0002 and 0003 do (T-021, T-143). Break-glass '
  'credential checkout only (SD DB-13 rule 6). Tickets T-020, T-143.';

-- Belt and braces: assert the state this file leaves, by a DIRECT call (OD-76).
SELECT kinvara_guard.assert_answering_service_write_only();
