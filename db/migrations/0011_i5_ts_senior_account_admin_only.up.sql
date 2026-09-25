-- 0011_i5_ts_senior_account_admin_only.up.sql
--
-- @phase: expand
-- @compliance-review: assert_ts_senior_written_by_admin — T-192 (T-186 C4 (iv) hardening; OD-224 A4), two-approval path (PROTOCOL §3); replaced: the admin test also refuses a writer holding app_rw's privileges, and a TRUNCATE branch is added
-- @compliance-review: trg_account_role_ts_senior_no_truncate — T-192 (OD-224 A4), two-approval path (PROTOCOL §3); created here
-- @compliance-review: assert_ts_senior_account_written_by_admin — T-192 (OE-48), two-approval path (PROTOCOL §3); created here
-- @compliance-review: trg_account_ts_senior_status_admin_only — T-192 (OE-48), two-approval path (PROTOCOL §3); created here
--
-- Ticket:  T-192 (tech-lead). The last two routes to a ts_senior countersignature by app_rw.
-- Spec:    SA §SA-4 I-5; decisions.md OE-48 (from OD-222, widened by T-186 QA-A1), OE-45, OE-47,
--          OD-224 (T-186 QA-A2/A3/A4); T-186 § tech-lead verification C4 (iv) and TL-RUN H.
-- Contracts: T-186 § Published contract (what 0008 creates; its §3 routes this file closes);
--          T-140 § Published contract (account, account_role, their grants); T-020 § Published
--          contract §3 (roles; RLS scoped by OD-223); T-021 / T-031 (lint).
--
-- 1. OE-48: ONLY app_admin_rw MAY CHANGE WHAT OE-45's READ DEPENDS ON, FOR A ts_senior HOLDER.
--    assert_second_actor_differs() (0008) admits a countersigner whose account row has
--    status = 'active', joined on account.id; account_min_age_verified lets status be 'active'
--    only with dob_verified_18 true. app_rw holds UPDATE on account (0005), so it could set a
--    suspended ts_senior holder active around a countersignature, or commit the activation
--    (T-186 OD-222; QA OD-a..OD-d). A BEFORE UPDATE row trigger on account,
--    trg_account_ts_senior_status_admin_only, now refuses a change to id, status or
--    dob_verified_18 of an account that holds an UNREVOKED ts_senior row, unless the writer is an
--    admin writer (3. below): KV055 I5_TS_SENIOR_ACCOUNT_WRITE_REFUSED. A change is
--    IS DISTINCT FROM; setting a column to the value it has is not one. It is row-scoped, as OE-48
--    rules: every other account, and every other column of a ts_senior holder, stays writable by
--    app_rw, so signup and verification writes are unaffected. The read of account_role is as the
--    updating transaction sees it.
--
-- 2. OD-224 A4: TRUNCATE account_role. Row triggers do not fire on TRUNCATE, so the owner could
--    remove every ts_senior row without KV053. Decided: refused at the database. A BEFORE TRUNCATE
--    statement trigger, trg_account_role_ts_senior_no_truncate, calls the OE-47 function, which
--    refuses (KV053) while any ts_senior row exists (revoked or not, as for DELETE) unless the
--    writer is an admin writer. app_admin_rw holds no TRUNCATE privilege, so in practice no
--    application principal truncates the table while it holds a ts_senior row.
--
-- 3. THE ADMIN-WRITER TEST, HARDENED (T-186 C4 (iv), TL-RUN H). Both guards admit a writer only
--    when pg_has_role(current_user, 'app_admin_rw', 'USAGE') AND NOT
--    pg_has_role(current_user, 'app_rw', 'USAGE'). 0008's test was the first half alone, so a
--    login in both roles (T-186 QA P1), every app_rw login after GRANT app_admin_rw TO app_rw
--    (QA P10), a superuser acting as itself (the compose core login, OD-116) and a superuser-owned
--    SECURITY DEFINER function called by app_rw (QA P9) all passed it. Under the hardened test each
--    is refused. A superuser that runs SET ROLE app_admin_rw is admitted. Cost, and it fails
--    closed: if app_admin_rw were ever made a member of app_rw, admins would be refused too.
--
-- 4. GRANTS. There are no default privileges (T-020 § contract §4), so each is explicit:
--      app_admin_rw   SELECT (id, status, dob_verified_18) and UPDATE (status, dob_verified_18) on
--                     account: the least that lets OE-48's principal find an account and change
--                     the two columns. Column-level, so it reads no email, phone or password hash.
--                     No INSERT, no DELETE. RLS: account is not one of the tables SD lines 1309
--                     and 3906 name (OD-223), so no policy.
--    account_role's ACL is unchanged.
--
-- WHAT THIS DOES NOT CLOSE. A superuser can still bypass every trigger (session_replication_role =
-- replica), or SET ROLE app_admin_rw. app_ddl owns account, account_role and approval and can
-- DISABLE a trigger at the database (break-glass); gate:migration-lint refuses a migration that
-- does so by name or renames a protected trigger or function (R-TRIGGER-BYPASS,
-- R-PROTECTED-RENAME). I-5 clause (c) is T-067's.
--
-- PRINCIPAL. app_ddl (T-136 § contract §6): it owns both functions' tables and 0008's function.
-- No -- @run-as marker. Transactional; no -- @no-transaction marker.

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
  ELSIF TG_OP = 'DELETE' THEN
    v_touches := OLD.role = 'ts_senior';
  ELSE
    -- TRUNCATE, a statement-level trigger: there is no row. Refused while any ts_senior row exists.
    v_touches := EXISTS (SELECT 1 FROM public.account_role WHERE role = 'ts_senior');
  END IF;

  IF v_touches AND NOT (pg_has_role(current_user, 'app_admin_rw', 'USAGE')
                        AND NOT pg_has_role(current_user, 'app_rw', 'USAGE')) THEN
    RAISE EXCEPTION 'I5_TS_SENIOR_WRITE_REFUSED: % of a ts_senior row in %.% by role %',
                    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = 'KV053',
            HINT = 'decisions.md OE-47: only app_admin_rw may grant, revoke, un-revoke or move ts_senior.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.assert_ts_senior_written_by_admin() IS
  'SA §SA-4 I-5, decisions.md OE-47 (T-186, T-192). BEFORE ROW trigger on account_role: an INSERT, UPDATE or DELETE whose new or old row has role ts_senior is refused (KV053) unless current_user holds the privileges of app_admin_rw and not those of app_rw. BEFORE TRUNCATE statement trigger: a TRUNCATE while any ts_senior row exists is refused the same way (OD-224). Other roles are not read.';

CREATE FUNCTION public.assert_ts_senior_account_written_by_admin() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $fn$
DECLARE
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    v_changed := v_changed || 'id'::text;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changed := v_changed || 'status'::text;
  END IF;
  IF NEW.dob_verified_18 IS DISTINCT FROM OLD.dob_verified_18 THEN
    v_changed := v_changed || 'dob_verified_18'::text;
  END IF;

  IF cardinality(v_changed) = 0
     OR (pg_has_role(current_user, 'app_admin_rw', 'USAGE')
         AND NOT pg_has_role(current_user, 'app_rw', 'USAGE')) THEN
    RETURN NEW;
  END IF;

  PERFORM 1
     FROM public.account_role ar
    WHERE ar.account_id = OLD.id
      AND ar.role = 'ts_senior'
      AND ar.revoked_at IS NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'I5_TS_SENIOR_ACCOUNT_WRITE_REFUSED: UPDATE of % on %.% for an account holding a live ts_senior role, by role %',
                    array_to_string(v_changed, ', '), TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = 'KV055',
            HINT = 'decisions.md OE-48: only app_admin_rw may change the status or dob_verified_18 of an account holding a live ts_senior role.';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.assert_ts_senior_account_written_by_admin() IS
  'SA §SA-4 I-5, decisions.md OE-48 (T-192). BEFORE UPDATE row trigger on account: a change to id, status or dob_verified_18 of an account holding an unrevoked ts_senior role is refused (KV055) unless current_user holds the privileges of app_admin_rw and not those of app_rw. Every other account and column is not read.';

CREATE TRIGGER trg_account_ts_senior_status_admin_only
  BEFORE UPDATE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.assert_ts_senior_account_written_by_admin();

CREATE TRIGGER trg_account_role_ts_senior_no_truncate
  BEFORE TRUNCATE ON public.account_role
  FOR EACH STATEMENT EXECUTE FUNCTION public.assert_ts_senior_written_by_admin();

GRANT SELECT (id, status, dob_verified_18), UPDATE (status, dob_verified_18)
  ON public.account TO app_admin_rw;
