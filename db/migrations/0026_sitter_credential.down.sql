-- 0026_sitter_credential.down.sql
--
-- Ticket: T-252 (tech-lead). The inverse of the up file: removes public.sitter_credential with its
-- three partial indexes, its constraints and three foreign keys, its seven policies, its comment
-- and its grants, all of which go with the table. After this file the database is the 0025 state.
--
-- No CASCADE (gate:migration-lint R-CASCADE). Once a later migration adds a foreign key into this
-- table (T-071's sitter_credential_sighting.sitter_credential_id, SD 3506), this DROP is refused
-- until that migration is reverted first, which is the order db:migrate down applies them in.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6). Transactional.

DROP TABLE public.sitter_credential;
