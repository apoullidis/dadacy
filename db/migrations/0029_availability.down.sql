-- 0029_availability.down.sql
--
-- Ticket: T-163 (tech-lead). The inverse of the up file. After this file the database is the 0028
-- state.
--
-- The three tables reference sitter_profile and not one another, so the order is free; the slot
-- table goes first as the derived one. DROP TABLE removes each table's indexes (the primary keys',
-- the exclusion constraint's, idx_slot_span, idx_slot_cluster, idx_slot_sitter,
-- availability_template_sitter_id_idx and availability_exception_sitter_id_on_date_idx), its
-- constraints, its comment and its ACL with it. The up file creates no function, trigger or rule.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend on
-- a table, the DROP is refused and the transaction rolls back. Rows are dropped with the tables:
-- the slot table is derived, and the template and exception rows are sitter-authored data that a
-- down migration on a database holding them destroys.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.availability_slot;
DROP TABLE public.availability_exception;
DROP TABLE public.availability_template;
