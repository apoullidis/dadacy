-- 0001_extensions_and_roles.down.sql
--
-- Ticket: T-020 (tech-lead). The inverse of 0001_extensions_and_roles.up.sql.
--
-- WHO RUNS THIS FILE. The bootstrap superuser, for the same reason the up file needs one:
-- DROP EVENT TRIGGER requires superuser, and so does DROP EXTENSION for the three
-- extensions here that are not trusted. `app_ddl` deliberately cannot run this file —
-- which is the same property that stops a later migration quietly removing the SA §INT-10
-- guard (see the note at the end of the up file's Section 5).
--
-- SD §DB-13 rule 3: a down migration exists for an EXPAND step, and 0001 is entirely
-- expand. It is written to leave the database in the state a freshly-created database is
-- in, not merely to undo the statements in order — hence the explicit restoration of
-- PostgreSQL's own defaults for schema `public` and for the database ACL, which the up
-- file replaced rather than added to.
--
-- Run it with `psql --single-transaction`, as with the up file.


-- ===========================================================================
-- 1. The SA §INT-10 guard
-- ===========================================================================
-- Dropped FIRST. It fires on GRANT, and everything below revokes; leaving it in place
-- would run a full catalogue scan on every REVOKE for no benefit.
DROP EVENT TRIGGER IF EXISTS trg_int10_answering_service;
DROP FUNCTION IF EXISTS public.trg_assert_answering_service_write_only();
DROP FUNCTION IF EXISTS public.assert_answering_service_write_only();


-- ===========================================================================
-- 2. Schema and database privileges — back to PostgreSQL's own defaults
-- ===========================================================================
-- The owner must go back BEFORE the DROP OWNED BY below. `public` is owned by app_ddl
-- after the up migration, and `DROP OWNED BY app_ddl` would therefore DROP SCHEMA PUBLIC
-- along with everything in it. That is a genuinely destructive ordering bug and it is the
-- reason this statement is here rather than further down.
ALTER SCHEMA public OWNER TO pg_database_owner;

REVOKE ALL ON SCHEMA public FROM app_rw, app_admin_rw, app_safety_rw, app_ddl, answering_service;

-- PostgreSQL 15+ ships schema `public` with USAGE for PUBLIC and no CREATE. Restore
-- exactly that, not the pre-15 form.
GRANT USAGE ON SCHEMA public TO PUBLIC;

DO $dbgrants$
DECLARE
  db text := quote_ident(current_database());
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %s FROM app_rw, app_admin_rw, app_safety_rw, app_ddl, answering_service', db);
  -- The default database ACL is CONNECT + TEMPORARY for PUBLIC.
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %s TO PUBLIC', db);
END
$dbgrants$;


-- ===========================================================================
-- 3. The five roles
-- ===========================================================================
-- DROP OWNED BY clears any remaining privilege granted TO the role and any object owned
-- by it IN THIS DATABASE. Roles are cluster-global: if one of these roles has been used in
-- another database of the same cluster, DROP ROLE will fail with a dependency error naming
-- it. That is correct — dropping a role out from under another database's grants would be
-- worse — and it is why 0001 is only ever rolled back on a database whose starting state
-- the operator controls.
-- This also removes the SELECT grants the up file issued to these roles on the extensions'
-- own relations (spatial_ref_sys and friends). The PUBLIC grants it revoked on those same
-- relations are handled with the extensions themselves, in Section 4.
DROP OWNED BY app_rw, app_admin_rw, app_safety_rw, app_ddl, answering_service;

DROP ROLE IF EXISTS answering_service;
DROP ROLE IF EXISTS app_ddl;
DROP ROLE IF EXISTS app_safety_rw;
DROP ROLE IF EXISTS app_admin_rw;
DROP ROLE IF EXISTS app_rw;


-- ===========================================================================
-- 4. Extensions
-- ===========================================================================
-- Dropped in the reverse of the order they were created. No CASCADE anywhere: if a later
-- migration has built something on postgis or btree_gist, this must fail loudly rather
-- than silently taking that object with it. A down migration that quietly drops a
-- downstream table is worse than one that refuses.
-- The PUBLIC grants the up file revoked on spatial_ref_sys, geometry_columns,
-- geography_columns and the two pg_stat_statements views are NOT restored here, and must
-- not be: DROP EXTENSION destroys those relations outright, and the next `up` recreates
-- them with the grants the extension ships. Re-granting first would be dead code, and it
-- would make a down-then-up cycle look like it had exercised the revoke when it had not.
DROP EXTENSION IF EXISTS pg_stat_statements;
DROP EXTENSION IF EXISTS pg_partman;
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS unaccent;
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS btree_gist;
DROP EXTENSION IF EXISTS postgis;

-- NOT UNDONE, and it cannot be: the database's ICU `und` collation. `datlocprovider`,
-- `datlocale` and `encoding` are fixed at CREATE DATABASE and no ALTER can change them
-- (SD §DB-16; recorded as OD-5). The up file only ever ASSERTED them, so there is nothing
-- here to reverse — which is the point of asserting rather than attempting to set.
