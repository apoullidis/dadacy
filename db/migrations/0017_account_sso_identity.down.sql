-- 0017_account_sso_identity.down.sql
--
-- Ticket: T-226 (tech-lead). The inverse of the up file. After this file the database is the
-- 0016 state.
--
-- DROP TABLE removes the table's two key indexes, its constraints (the foreign key to account
-- included), its comment and its ACL with it. The up file creates no function, trigger or rule.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend
-- on the table, the DROP is refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.account_sso_identity;
