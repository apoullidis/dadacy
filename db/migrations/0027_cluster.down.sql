-- 0027_cluster.down.sql
--
-- Ticket: T-161 (tech-lead). The inverse of the up file: removes public.cluster, with its identity
-- sequence, its GiST index idx_cluster_boundary, its constraints, its comments and its app_rw grant
-- (all of which go with the table). After this file the database is the 0026 state.
--
-- No CASCADE (gate:migration-lint R-CASCADE). Once T-211 adds its trigger, function and CHECK on
-- this table, db:migrate down reverts T-211's migration first, which is the order it applies them in.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6). Transactional.

DROP TABLE public.cluster;
