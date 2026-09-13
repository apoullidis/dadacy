-- 0004_locale_registry.down.sql
--
-- Ticket: T-144 (tech-lead). The inverse of the up file: removes public.locale_registry, its
-- seed rows and its app_rw grant (a table's ACL goes with the table). After this file the
-- database is the 0003 state.
--
-- No CASCADE (gate:migration-lint R-CASCADE). If a later migration has added a foreign key
-- into this table (T-140's account.locale), this DROP is refused until that migration is
-- reverted first, which is the order db:migrate down applies them in.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6). Transactional.

DROP TABLE public.locale_registry;
