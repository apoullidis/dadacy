-- 0010_app_admin_rw_comment_rls_scope.down.sql
--
-- Ticket: T-192 (tech-lead). The inverse of the up file: app_admin_rw's COMMENT exactly as 0001
-- installed it (the string below is 0001's, copied byte for byte), so that a down to 0009 leaves
-- pg_shdescription as it was. That text carries the mis-citation the up file corrects; restoring
-- it is what a down means here.
--
-- WHO RUNS THIS FILE. The bootstrap superuser, as its up file does (T-136 § contract §6).

COMMENT ON ROLE app_admin_rw IS
  'Back-office role for apps/admin. Grants only on the tables admin needs; RLS with '
  'FORCE ROW LEVEL SECURITY applies to it (SA SEC-9). INSERT-only on the append-only '
  'tables. Ticket T-020.';
