-- 0023_staffed_schedule.down.sql
--
-- Ticket: T-206 (tech-lead). The inverse of the up file. After this file the database is the
-- 0022 state.
--
-- staffed_schedule_current goes first: its foreign key references staffed_schedule_version (E.2
-- U-3, "the down file drops it first"). Then staffed_interval, whose foreign key references the
-- version table, then the version table. DROP TABLE removes each table's indexes (the primary
-- keys', the exclusion constraint's, idx_staffed_interval_span and staffed_interval_version_id_idx),
-- its constraints, its comment and its ACL with it. The up file creates no function, trigger or
-- rule.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend on
-- a table (T-082's booking.staffed_schedule_version_id, for one), the DROP is refused and the
-- transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.staffed_schedule_current;
DROP TABLE public.staffed_interval;
DROP TABLE public.staffed_schedule_version;
