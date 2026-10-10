-- 0024_credential_scheme.down.sql
--
-- Ticket: T-251 (tech-lead). The inverse of the up file: removes public.credential_scheme, its
-- two seed rows, its identity sequence, its comments and its app_rw grant (a table's ACL, its
-- comments and its identity sequence go with the table). After this file the database is the
-- 0023 state.
--
-- No CASCADE (gate:migration-lint R-CASCADE). Once a later migration adds a foreign key into this
-- table (MR-2's sitter_credential.scheme_id, T-252), this DROP is refused until that migration is
-- reverted first, which is the order db:migrate down applies them in.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6). Transactional.

DROP TABLE public.credential_scheme;
