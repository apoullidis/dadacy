-- 0022_advisory_lock_revoke.down.sql
--
-- Ticket: T-240. Reverses 0022: removes the two grants and gives PUBLIC back EXECUTE on all 21
-- advisory-lock functions, which is the effective privilege set before 0022 (every role may EXECUTE
-- every one of them). Runs as the bootstrap superuser, as its up file does (T-136 § contract §6).
--
-- WHAT "RESTORED" MEANS HERE, measured in tasks/state/EP-3/T-240.md: before 0022 each function's
-- proacl is NULL (the built-in default, EXECUTE for PUBLIC and the owner). No GRANT can write NULL
-- back, so after this file proacl reads {=X/app,app=X/app}: the same privileges spelled out. pg_dump
-- treats the two the same (the schema dump after this file is compared with a pristine 0021's).
--
-- This file re-opens OD-273 (answering_service can again take the chain key). That is what reverting
-- 0022 means.

REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(integer, integer) FROM app_rw;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) FROM app_rw, app_ddl;

GRANT EXECUTE ON FUNCTION
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
TO PUBLIC;
