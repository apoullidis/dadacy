-- 0022_advisory_lock_revoke.up.sql
--
-- @phase: expand
-- @run-as: bootstrap-superuser — T-240; OE-74 (OD-273); T-215 bct D3 (the 21 functions are owned by
--   the bootstrap superuser; a REVOKE on them run as app_ddl revokes nothing and only warns)
--
-- Ticket:  T-240 (tech-lead -> bct).
-- Ruling:  decisions.md OE-74, resolving OD-273 (T-215 QA-F2): block advisory locks for every role
--          that never writes audit entries.
-- Contracts: T-215 § Published contract — LIVE §3 (the chain key), §5 (c) and (k), §6 (the OD-273
--          bullet, bct C3); T-215 bct BCT-3 (D1-D4); T-020 § contract §3-§6 (roles, the INT-10
--          guard); T-136 § contract §6-§7 (runner, @run-as); T-213 bct C2 (the anchor job's lock).
--
-- WHY. Every advisory-lock function in pg_catalog has a NULL ACL, which means EXECUTE for PUBLIC.
-- So any login, the vendor principal answering_service included, could take the audit chain's
-- published key with pg_advisory_lock(5428598235315393603) and stall every audit_log append for as
-- long as it held it (T-215 QA-F2; a shared hold stalls appends too, bct R6).
--
-- WHAT IT DOES. EXECUTE is revoked from PUBLIC on all 21 advisory-lock functions (session and
-- transaction scope, exclusive and shared, try and blocking, the bigint and the (integer, integer)
-- forms, and the three unlock functions). EXECUTE is then granted on exactly two of them:
--   pg_advisory_xact_lock(bigint)            TO app_rw, app_ddl
--   pg_advisory_xact_lock(integer, integer)  TO app_rw
-- Every other form is EXECUTE for nobody but the owner (the bootstrap superuser) and superusers.
--
-- WHO NEEDS WHAT (the inventory, tasks/state/EP-3/T-240.md § Inventory):
--   app_ddl  pg_advisory_xact_lock(bigint). public.audit_log_chain() (0021) is SECURITY DEFINER,
--            owned by app_ddl, and takes the chain key with this function. PostgreSQL checks a
--            function called inside a definer function against the DEFINER. Without this grant every
--            audit_log append is refused 42501 (T-215 bct D1). app_ddl owns none of the 21 functions,
--            so its EXECUTE has to be granted explicitly.
--   app_rw   pg_advisory_xact_lock(bigint): pg-boss 12.26.4 serialises its schema, queue and
--            maintenance statements with it (its plans.js advisoryLock(); the runtime principal is
--            app_rw, T-146); T-067's anchor job serialises with it (T-213 bct C2).
--            pg_advisory_xact_lock(integer, integer): T-089's per-sitter availability lock (OE-32,
--            state/EP-2/OE-30-34-rulings.md § E.3 U-11), planned.
--   No other form is called by a non-superuser in app/ or in the database (§ Inventory).
-- Not needed by anyone today, so not granted: the session-scoped forms (a session hold survives
-- ROLLBACK and is the form that stalled the chain), the shared forms, the try forms and the unlocks.
-- A later use of one of them is a GRANT in a new migration.
--
-- WHAT STAYS OPEN, stated rather than discovered:
--   - superusers and the owner of these functions bypass EXECUTE checks and can still take any key;
--   - app_rw and app_ddl (and every login that is a member of either) can still take the chain key in
--     transaction scope and hold it for as long as their transaction stays open. app_rw is the chain's
--     own writer and app_ddl its owner; the stakeholder's ruling keeps both. T-215 § contract §5 (k)'s
--     reconciler alarm is the monitoring half (a holder outside app_rw/app_ddl, or a hold longer than
--     N seconds);
--   - pg_partman (0001) calls pg_try_advisory_xact_lock, pg_try_advisory_lock and pg_advisory_unlock
--     inside its maintenance functions. Nothing calls them (EV-25: no pg_partman for audit_log); a
--     non-superuser that did would now be refused 42501, and needs a GRANT migration first.
--
-- THE SA §INT-10 GUARD. GRANT is one of trg_int10_answering_service's tags, so each GRANT below runs
-- the guard over the whole database; REVOKE is not a tag. Neither statement gives answering_service
-- anything. The guard does NOT read pg_catalog functions (checks (8), (17) and (18) exclude
-- pg_catalog), so it would not notice an advisory function granted back to answering_service or to
-- PUBLIC; measured in tasks/state/EP-3/T-240.md (M5). This file's own check below does.
--
-- WHO RUNS THIS FILE. The bootstrap superuser (the @run-as marker), as do its down file (T-136
-- § contract §6). Transactional.

REVOKE EXECUTE ON FUNCTION
  pg_catalog.pg_advisory_lock(bigint),
  pg_catalog.pg_advisory_lock(integer, integer),
  pg_catalog.pg_advisory_lock_shared(bigint),
  pg_catalog.pg_advisory_lock_shared(integer, integer),
  pg_catalog.pg_advisory_xact_lock(bigint),
  pg_catalog.pg_advisory_xact_lock(integer, integer),
  pg_catalog.pg_advisory_xact_lock_shared(bigint),
  pg_catalog.pg_advisory_xact_lock_shared(integer, integer),
  pg_catalog.pg_try_advisory_lock(bigint),
  pg_catalog.pg_try_advisory_lock(integer, integer),
  pg_catalog.pg_try_advisory_lock_shared(bigint),
  pg_catalog.pg_try_advisory_lock_shared(integer, integer),
  pg_catalog.pg_try_advisory_xact_lock(bigint),
  pg_catalog.pg_try_advisory_xact_lock(integer, integer),
  pg_catalog.pg_try_advisory_xact_lock_shared(bigint),
  pg_catalog.pg_try_advisory_xact_lock_shared(integer, integer),
  pg_catalog.pg_advisory_unlock(bigint),
  pg_catalog.pg_advisory_unlock(integer, integer),
  pg_catalog.pg_advisory_unlock_shared(bigint),
  pg_catalog.pg_advisory_unlock_shared(integer, integer),
  pg_catalog.pg_advisory_unlock_all()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) TO app_rw, app_ddl;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(integer, integer) TO app_rw;

-- Assert the state this file leaves, from the catalogue, not from the statements' exit status: run by
-- anyone but the owner, the REVOKE above succeeds with a WARNING and changes nothing (T-215 bct D3).
-- The count also refuses a server that has added or removed an advisory-lock function since this
-- file was written: the list above would then be incomplete.
DO $assert$
DECLARE
  v_count   int;
  v_wrong   text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
     AND p.proname ~ '^pg_(try_)?advisory_';
  IF v_count <> 21 THEN
    RAISE EXCEPTION '0022: expected 21 advisory-lock functions in pg_catalog, found %', v_count;
  END IF;

  SELECT pg_catalog.string_agg(fn || ' has [' || got || '], expected [' || want || ']', '; ')
    INTO v_wrong
    FROM (
      SELECT p.oid::pg_catalog.regprocedure::text AS fn,
             coalesce((SELECT pg_catalog.string_agg(g.name, ',' ORDER BY g.name)
                         FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                           ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
                                 FROM pg_catalog.aclexplode(coalesce(p.proacl,
                                                    pg_catalog.acldefault('f', p.proowner))) a
                                WHERE a.grantee <> p.proowner) g), '') AS got,
             CASE p.oid
               WHEN 'pg_catalog.pg_advisory_xact_lock(bigint)'::pg_catalog.regprocedure THEN 'app_ddl,app_rw'
               WHEN 'pg_catalog.pg_advisory_xact_lock(integer,integer)'::pg_catalog.regprocedure THEN 'app_rw'
               ELSE '' END AS want
        FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
         AND p.proname ~ '^pg_(try_)?advisory_') x
   WHERE got <> want;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '0022: advisory-lock EXECUTE is not as intended: %', v_wrong;
  END IF;
END
$assert$;
