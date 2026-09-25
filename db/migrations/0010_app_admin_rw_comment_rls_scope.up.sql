-- 0010_app_admin_rw_comment_rls_scope.up.sql
--
-- @run-as: bootstrap-superuser — T-192 (T-186 tech-lead condition C4 (i); OD-223): COMMENT ON ROLE is refused to app_ddl, which is NOCREATEROLE (42501, measured in T-192 E1)
-- @phase: expand
--
-- Ticket:  T-192 (tech-lead). T-186's second approval, condition C4 (i), and decisions.md OD-223 as
--          ruled there: 0001's installed COMMENT ON ROLE app_admin_rw says "RLS with FORCE ROW LEVEL
--          SECURITY applies to it (SA SEC-9)". Two things are wrong with it:
--            1. SA §SEC-9 (solutions-architect.md line 2264) is break-glass access and says nothing
--               about RLS. The sentence it restates is SA §SEC-7's Database row (line 2249).
--            2. It reads as "every table admin touches". SD names the tables that carry RLS with
--               FORCE ROW LEVEL SECURITY (software-design.md lines 1309 and 3906: child,
--               child_health, sitter_credential, idv_result, message, case_note, reference_check),
--               and SA §TS-7 layer 2 (line 835) scopes it the same way. SD governs mechanism
--               (PROTOCOL §2), so a grant to app_admin_rw on any other table needs no policy.
-- Spec:    SA §SEC-7 (line 2249); SA §TS-7 layer 2 (line 835); SD lines 1309, 3906; decisions.md
--          OD-223; T-020 § Published contract §3 as corrected by OD-223 (signed, T-186 C3).
--
-- WHY A NEW MIGRATION. A COMMENT ON ROLE installs into pg_shdescription, so it is part of 0001's
-- applied effect; editing 0001's string is refused by gate:migration-lint (R-MERGED, R-BASELINE).
-- 0001's `--` copies of the same claim are corrected in place under R-MERGED, comment lines only.
--
-- WHAT IT DOES. It re-issues the one COMMENT and nothing else. The role's attributes, memberships
-- and grants are untouched.
--
-- WHO RUNS THIS FILE. The bootstrap superuser (the -- @run-as line above). Measured in T-192's
-- evidence (E1): under SET ROLE app_ddl the same statement is refused with 42501, "The current
-- user must have the CREATEROLE attribute".

COMMENT ON ROLE app_admin_rw IS
  'Back-office role for apps/admin. Privileges only on the tables admin needs. RLS with ENABLE and '
  'FORCE ROW LEVEL SECURITY is required on the tables SD names (lines 1309 and 3906: child, '
  'child_health, sitter_credential, idv_result, message, case_note, reference_check), per SA SEC-7 '
  'and SA TS-7 layer 2. A table outside that list needs no policy (OD-223). INSERT-only on the '
  'append-only tables. Tickets T-020, T-192.';
