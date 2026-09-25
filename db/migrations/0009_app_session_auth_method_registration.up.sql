-- 0009_app_session_auth_method_registration.up.sql
--
-- @phase: expand
--
-- Ticket:  T-193 (tech-lead). Stakeholder ruling OE-28 (B), 2026-09-25: a passwordless
--          registration's session gets its own auth_method, 'registration'.
-- Spec:    SD §DB-2 line 1813 (the CHECK, five values); SD §BE-4 line 1020 (POST /v1/auth/register
--          takes password? and answers 201 + a session cookie); SA §CC-1 line 2551.
--          decisions.md OE-28 (B), OD-127.
-- Request: tasks/state/EP-2/T-193.md § Migration request (ADR 0001 §1).
--
-- WHAT IT DOES. It replaces app_session_auth_method_check, keeping its name, with SD's five values
-- in SD's order followed by 'registration'. No factor is presented at a passwordless registration,
-- so none of SD's five values describes the session it issues (OD-127).
--
-- EXPAND. Every value admitted before is still admitted, so ADD CONSTRAINT validates every existing
-- row, including the 'magic_link' rows T-141 rework 1 wrote for passwordless registrations. Those
-- rows are left as they are: T-193.md § Interim rows says why there is no data migration.
--
-- ONE STATEMENT. The DROP and the ADD are two actions of one ALTER TABLE, so no statement ever
-- sees app_session without the constraint. The runner also wraps the file in one transaction
-- (T-136 § contract §5).
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6). app_ddl owns app_session (T-140 § contract
-- §1), so it may replace the constraint. The table's ACL is not touched.

ALTER TABLE public.app_session
  DROP CONSTRAINT app_session_auth_method_check,
  ADD CONSTRAINT app_session_auth_method_check
    CHECK (auth_method IN ('password','magic_link','passkey','otp','sso','registration'));
