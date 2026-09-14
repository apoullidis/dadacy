-- 0005_identity_schema.down.sql
--
-- Ticket: T-140 (tech-lead). The inverse of the up file. After this file the database is the
-- 0004 state.
--
-- ORDER (T-144 second approval, rule 3). Dependents first: app_session and account_role
-- reference account; account references locale_registry. DROP TABLE public.account removes
-- the only reference this migration adds into locale_registry (account_locale_fkey), so
-- 0004's down can run next. Each table's ACL and indexes (sod_finance_ts included) go with the
-- table. Then the enum, then citext, which nothing else uses once account is gone.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration still
-- depends on one of these objects, the DROP is refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. The bootstrap superuser, as its up file does (T-136 § contract §6:
-- a down file runs as its up file does; the -- @run-as marker belongs to the up file only).

DROP TABLE public.app_session;
DROP TABLE public.account_role;
DROP TABLE public.account;
DROP TYPE public.account_status;
DROP EXTENSION citext;
