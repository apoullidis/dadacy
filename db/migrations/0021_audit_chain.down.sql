-- 0021_audit_chain.down.sql
--
-- Ticket: T-215 (tech-lead). The inverse of the up file. After this file the database is the
-- 0020 state.
--
-- ORDER. The trigger first: DROP TRIGGER on the partitioned parent removes its clone on every
-- partition with it. Then the function, which nothing uses once the trigger is gone.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend on
-- the function, the DROP is refused and the transaction rolls back.
--
-- The rows already in audit_log, and the hashes the trigger wrote into them, stay. After this file
-- app_rw can complete no INSERT again (0020: 23502 on prev_entry_hash).
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TRIGGER trg_audit_log_chain ON public.audit_log;
DROP FUNCTION public.audit_log_chain();
