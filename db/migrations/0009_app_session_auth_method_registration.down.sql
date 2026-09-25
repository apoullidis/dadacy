-- 0009_app_session_auth_method_registration.down.sql
--
-- Ticket: T-193 (tech-lead). The inverse of the up file. After this file the database is in the
-- 0008 state: app_session_auth_method_check again admits exactly 0005's five values, in 0005's
-- order.
--
-- IT REFUSES WHILE ANY 'registration' ROW EXISTS. ADD CONSTRAINT validates every row, so a
-- 'registration' row fails the five-value check with 23514, and the runner rolls the whole file
-- back. That is deliberate. Rewriting 'registration' to 'magic_link' here would restore the
-- ambiguity OE-28 (B) removed (T-193.md § Interim rows, reason 4). The rule is to roll forward
-- (SD §QD-4).
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

ALTER TABLE public.app_session
  DROP CONSTRAINT app_session_auth_method_check,
  ADD CONSTRAINT app_session_auth_method_check
    CHECK (auth_method IN ('password','magic_link','passkey','otp','sso'));
