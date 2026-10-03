-- 0022_advisory_lock_revoke.down.sql
-- @restore-public: OE-76 (OD-275); T-240 — restores the PUBLIC EXECUTE that 0022's up revoked, on exactly its 21 routines
--
-- Ticket: T-240. Reverses 0022: removes the two grants and gives PUBLIC back EXECUTE on all 21
-- advisory-lock functions, which is the effective privilege set before 0022 (every role may EXECUTE
-- every one of them). Runs as the bootstrap superuser, as its up file does (T-136 § contract §6).
--
-- WHAT "RESTORED" MEANS HERE, measured in tasks/state/EP-3/T-240.md: before 0022 each function's
-- proacl is NULL (the built-in default, EXECUTE for PUBLIC and the owner). No GRANT can write NULL
-- back, so after this file proacl reads {app=X/app,=X/app}: the same privileges spelled out. A
-- schema dump taken after this file is byte-identical to one of a project that never went past 0021
-- (T-240 evidence, E4).
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
