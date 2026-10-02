-- 0020_audit_log.down.sql
--
-- Ticket: T-214 (tech-lead). The inverse of the up file. After this file the database is the
-- 0019 state.
--
-- DROP TABLE on the partitioned parent drops its 36 partitions with it, and with them the identity
-- sequence, every index (the parent's and each partition's), every constraint, the comment and
-- every ACL. The up file creates no function, trigger or rule.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend on
-- the table or a partition, the DROP is refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.audit_log;
