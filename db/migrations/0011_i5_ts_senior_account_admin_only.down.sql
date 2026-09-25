-- 0011_i5_ts_senior_account_admin_only.down.sql
--
-- @compliance-review: assert_ts_senior_written_by_admin — T-192 (T-186 C4 (iv); OD-224 A4), two-approval path (PROTOCOL §3); restored to 0008's definition
-- @compliance-review: trg_account_role_ts_senior_no_truncate — T-192 (OD-224 A4), two-approval path (PROTOCOL §3); dropped
-- @compliance-review: assert_ts_senior_account_written_by_admin — T-192 (OE-48), two-approval path (PROTOCOL §3); dropped
-- @compliance-review: trg_account_ts_senior_status_admin_only — T-192 (OE-48), two-approval path (PROTOCOL §3); dropped
--
-- Ticket: T-192 (tech-lead). The inverse of the up file. After this file the database is the 0010
-- state: no trigger on account, no TRUNCATE trigger on account_role, no
-- assert_ts_senior_account_written_by_admin(), no privilege for app_admin_rw on account, and
-- assert_ts_senior_written_by_admin() and its COMMENT exactly as 0008 created them (the function
-- below is 0008's text, copied byte for byte, with CREATE made CREATE OR REPLACE).
--
-- ORDER. Each trigger before its function (no CASCADE: gate:migration-lint R-CASCADE), then the
-- column privileges, then 0008's function, restored.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TRIGGER trg_account_ts_senior_status_admin_only ON public.account;
DROP FUNCTION public.assert_ts_senior_account_written_by_admin();
DROP TRIGGER trg_account_role_ts_senior_no_truncate ON public.account_role;

REVOKE SELECT (id, status, dob_verified_18), UPDATE (status, dob_verified_18)
  ON public.account FROM app_admin_rw;

CREATE OR REPLACE FUNCTION public.assert_ts_senior_written_by_admin() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $fn$
DECLARE
  v_touches boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches := NEW.role = 'ts_senior';
  ELSIF TG_OP = 'UPDATE' THEN
    v_touches := NEW.role = 'ts_senior' OR OLD.role = 'ts_senior';
  ELSE
    v_touches := OLD.role = 'ts_senior';
  END IF;

  IF v_touches AND NOT pg_has_role(current_user, 'app_admin_rw', 'USAGE') THEN
    RAISE EXCEPTION 'I5_TS_SENIOR_WRITE_REFUSED: % of a ts_senior row in %.% by role %',
                    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = 'KV053',
            HINT = 'decisions.md OE-47: only app_admin_rw may grant, revoke, un-revoke or move ts_senior.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.assert_ts_senior_written_by_admin() IS
  'SA §SA-4 I-5, decisions.md OE-47 (T-186). BEFORE ROW trigger on account_role: an INSERT, UPDATE or DELETE whose new or old row has role ts_senior is refused (KV053) unless current_user holds the privileges of app_admin_rw. Other roles are not read.';
