-- 0014_int10_guard_column_insert.up.sql
--
-- @phase: expand
-- @run-as: bootstrap-superuser — OD-242; T-231 (replaces kinvara_guard.assert_answering_service_
--          write_only(), which the bootstrap superuser owns in a schema app_ddl holds no CREATE on;
--          CREATE OR REPLACE is owner-only: T-143 § contract (rework 1) §2 G06, 42501)
-- @compliance-review: assert_answering_service_write_only — T-231, two-approval path (PROTOCOL §3); OD-242 (T-194 QA2-O1): check (6) also reads column-level INSERT
--
-- Ticket:  T-231 (tech-lead)
-- Spec:    SA §INT-10 ("INSERT on out_of_hours_report and nothing else"); decisions.md OD-242;
--          T-194 § QA verification (rework 2) QA2-3; T-020 § Published contract §5;
--          T-143 § Published contract (rework 1) §1, §3; ADR 0001 §3, §5.
--
-- WHY THIS MIGRATION EXISTS. The SA §INT-10 guard (0001, moved to kinvara_guard by 0003) did
-- not see a COLUMN-level INSERT grant to answering_service. Check (5) reads
-- has_table_privilege(..., 'INSERT'), which a grant on some columns does not satisfy; check (6)
-- reads column privileges SELECT, UPDATE and REFERENCES only. qa-verification granted INSERT on
-- five columns of public.otp_challenge to answering_service as the superuser: no KV010, the
-- direct call returned clean, and a login holding only answering_service inserted a row
-- (T-194 QA2-3). A migration doing the same is already refused by gate:migration-lint
-- (R-ANSWERING-SERVICE, measured there); this closes the database layer, which is what a
-- superuser or break-glass session meets, and what T-033's reconciler calls.
--
-- WHAT CHANGES. One UNION ALL branch is added after check (6): column-level INSERT on every
-- relation check (6) reads, except public.out_of_hours_report, and only where no table-level
-- INSERT is held (that case is check (5)'s, unchanged). Every other line of the function body
-- is 0003's, byte for byte, as are its name, arguments, language, volatility, SECURITY INVOKER
-- and SET search_path. CREATE OR REPLACE keeps the function's OID, owner, ACL and COMMENT, so
-- the event trigger and its function (neither touched here) keep calling it by name, and
-- nothing that granted EXECUTE on it has to be re-granted. For any state in which
-- answering_service holds no column-only INSERT outside the permitted table, the new branch
-- returns no row, so the verdict and the DETAIL are those of 0003's function (T-231 evidence).
--
-- WHY A COLUMN INSERT ON THE PERMITTED TABLE IS NOT REPORTED. SA §INT-10 permits INSERT on
-- public.out_of_hours_report. INSERT on some of its columns is a subset of that privilege and
-- conveys no read. Column SELECT, UPDATE and REFERENCES on it are still reported by check (6).
--
-- WHO RUNS THIS FILE. The bootstrap superuser (the @run-as marker above); its down file runs
-- the same way (T-136 § contract §6). Transactional; `psql --single-transaction`.
-- CREATE OR REPLACE FUNCTION fires trg_int10_answering_service (tag CREATE FUNCTION), which runs
-- the replaced guard on the migrating state before this file's own direct call below.
--
-- NOT TOUCHED. Merged 0001 and 0003 (PROTOCOL §3: this is a new migration); the event trigger,
-- its function, their COMMENTs and ACLs; schema kinvara_guard; the guard's COMMENT (it names
-- object classes, and "columns" stays true).

CREATE OR REPLACE FUNCTION kinvara_guard.assert_answering_service_write_only()
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
    -- (6), continued. Column-level INSERT (OD-242, T-231). An INSERT privilege held on some
    --     columns only does not satisfy has_table_privilege(..., 'INSERT'), so check (5) never
    --     saw it, and the list above does not name INSERT: qa-verification measured a vendor
    --     login inserting a row with no KV010 (T-194 QA2-3). It is read here on every relation
    --     except the one permitted target, where INSERT on some columns is narrower than the
    --     INSERT on the whole table that SA INT-10 permits. The NOT has_table_privilege clause
    --     keeps this branch disjoint from check (5): a table-level INSERT is still reported
    --     there, once, as before, and this branch reports only what (5) cannot see.
    SELECT format('answering_service holds column privilege INSERT on %I.%I.%I — the only '
                  'permitted INSERT target is %s', n.nspname, c.relname, a.attname, k_table)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg\_toast%'
       AND n.nspname || '.' || c.relname <> k_table
       AND NOT has_table_privilege(k_oid, c.oid, 'INSERT')
       AND has_column_privilege(k_oid, c.oid, a.attnum, 'INSERT')

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

-- Assert the state this file leaves, by a DIRECT call (OD-76).
SELECT kinvara_guard.assert_answering_service_write_only();
