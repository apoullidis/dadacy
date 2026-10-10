-- 0025_sitter_profile.down.sql
--
-- Ticket: T-158 (tech-lead). The inverse of the up file: removes public.sitter_profile (with its
-- index, its constraints, its two FKs to locale_registry and its FK to account, its comment and
-- its grants, which go with the table), then the two enum types. After this file the database is
-- the 0024 state.
--
-- No CASCADE (gate:migration-lint R-CASCADE). Once a later migration adds a foreign key into this
-- table (T-252's sitter_credential.sitter_id, and the other referencing tables of T-157 § Order),
-- this DROP is refused until that migration is reverted first, which is the order db:migrate down
-- applies them in. The table goes before the types because its columns use them.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6). Transactional.

DROP TABLE public.sitter_profile;
DROP TYPE public.sitter_tier;
DROP TYPE public.bookable_state;
