-- 0031_decision_record.down.sql
--
-- Ticket: T-268 (tech-lead). The inverse of the up file. After this file the database is the 0030
-- state.
--
-- statement_of_reasons first: its foreign key references decision_record. DROP TABLE takes each
-- table's primary key, foreign key, comment and ACL with it. The up file creates no function,
-- trigger, rule or policy.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend on
-- either table, the DROP is refused and the transaction rolls back. Rows are dropped with the
-- tables: once T-270 or T-079 has written any, this file destroys records SA SEC-8 says are never
-- deleted, so a down past 0031 on a database holding real decisions is a data-loss operation.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.statement_of_reasons;
DROP TABLE public.decision_record;
