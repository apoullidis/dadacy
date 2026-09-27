-- 0016_webauthn_credential.down.sql
--
-- Ticket: T-196 (tech-lead). The inverse of the up file. After this file the database is the
-- 0015 state.
--
-- DROP TABLE removes the table's index, its constraints (the foreign key to account included),
-- its comments and its ACL with it, and nothing outside this migration references
-- webauthn_credential. The up file creates no function or trigger.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend
-- on the table, the DROP is refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.webauthn_credential;
