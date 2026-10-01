-- 0018_audit_outbox.down.sql
--
-- Ticket: T-212 (tech-lead). The inverse of the up file. After this file the database is the
-- 0017 state.
--
-- DROP TABLE removes the table's identity sequence, its two indexes, its constraints, its comment
-- and its ACL with it. The up file creates no function, trigger or rule.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend
-- on the table, the DROP is refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.audit_outbox;
