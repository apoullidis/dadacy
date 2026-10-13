-- 0028_cluster_state.down.sql
--
-- Ticket: T-211 (tech-lead). The inverse of the up file. After this file the database is the 0027
-- state: the CHECK, the trigger and its function are gone, and the table and density_snapshot
-- comments are 0027's again (the table comment restored to 0027's text byte for byte; 0027 set no
-- comment on density_snapshot, so it is removed).
--
-- ORDER. The constraint, then the trigger, then the function, which nothing uses once the trigger
-- is gone. No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to
-- depend on the function, the DROP is refused and the transaction rolls back.
--
-- The rows in cluster, and any state or snapshot written under the trigger, stay. After this file
-- app_rw can again write any state transition and any snapshot (T-161 § Published contract (rework
-- 1) §3).
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6). Transactional.

ALTER TABLE public.cluster DROP CONSTRAINT cluster_open_requires_passing_snapshot;
DROP TRIGGER trg_cluster_state_transition ON public.cluster;
DROP FUNCTION public.cluster_state_transition();

COMMENT ON TABLE public.cluster IS
  'Discovery clusters (SD DB-10): operator-drawn WGS 84 polygons with an open, waitlist or closed state. Retired by state closed; no application role holds DELETE. Which state changes are legal, and the density snapshot shape, are held elsewhere (C12), not by this table.';
COMMENT ON COLUMN public.cluster.density_snapshot IS NULL;
