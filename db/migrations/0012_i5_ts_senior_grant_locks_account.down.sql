-- 0012_i5_ts_senior_grant_locks_account.down.sql
--
-- @compliance-review: assert_ts_senior_written_by_admin — T-227 (OE-59), two-approval path (PROTOCOL §3); restored to 0011's definition
-- @compliance-review: trg_account_role_ts_senior_admin_only — T-227 (OD-237 TL-1), two-approval path (PROTOCOL §3); restored to BEFORE ROW (0008)
-- @compliance-review: assert_ts_senior_account_written_by_admin — T-227 (T-192 QA-B2), two-approval path (PROTOCOL §3); restored to 0011's definition
-- @compliance-review: trg_account_ts_senior_status_admin_only — T-227 (OD-237 TL-1), two-approval path (PROTOCOL §3); restored to BEFORE UPDATE (0011)
--
-- Ticket: T-227 (tech-lead). The inverse of the up file. After this file the database is the 0011
-- state: both row guards fire BEFORE the row is written again, and both functions and their
-- COMMENTs are exactly as 0011 created them (the two function blocks below are 0011's text, copied
-- byte for byte, with CREATE made CREATE OR REPLACE for the second).
--
-- ORDER. Each function before the trigger that calls it: the replaced bodies return NEW (or OLD),
-- which a BEFORE trigger needs, so they are in place before a trigger becomes BEFORE again.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

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

CREATE OR REPLACE FUNCTION public.assert_ts_senior_account_written_by_admin() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $fn$
DECLARE
  v_refused text[] := ARRAY[]::text[];
  v_live    boolean := false;
  v_role    record;
BEGIN
  -- OE-57 + OE-58: a writer that is not an admin writer may move a live ts_senior holder only
  -- TOWARDS less eligibility. A status change is admitted only if it is one of the nine moves
  -- below; every other status change (into active, into pending, and any move out of suspended
  -- other than to removed or erased, out of removed other than to erased, out of erased) is refused.
  -- dob_verified_18 true -> false is admitted, false -> true refused; any id change is refused.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    v_refused := v_refused || 'id'::text;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status::text || '>' || NEW.status::text) = ANY (ARRAY[
           'active>suspended', 'active>removed', 'active>erased',
           'pending>suspended', 'pending>removed', 'pending>erased',
           'suspended>removed', 'suspended>erased',
           'removed>erased']) THEN
    v_refused := v_refused || 'status'::text;
  END IF;
  IF NEW.dob_verified_18 IS TRUE AND OLD.dob_verified_18 IS NOT TRUE THEN
    v_refused := v_refused || 'dob_verified_18'::text;
  END IF;

  IF cardinality(v_refused) = 0
     OR (pg_has_role(current_user, 'app_admin_rw', 'USAGE')
         AND NOT pg_has_role(current_user, 'app_rw', 'USAGE')) THEN
    RETURN NEW;
  END IF;

  -- Every ts_senior row of the account, revoked or not, locked FOR SHARE, and revoked_at read from
  -- the locked version: a concurrent un-revoke waits for this transaction, and one committed after a
  -- REPEATABLE READ or SERIALIZABLE snapshot raises 40001 here instead of going unseen (T-192 QA-A2).
  FOR v_role IN
    SELECT ar.revoked_at
      FROM public.account_role ar
     WHERE ar.account_id = OLD.id
       AND ar.role = 'ts_senior'
       FOR SHARE
  LOOP
    IF v_role.revoked_at IS NULL THEN
      v_live := true;
    END IF;
  END LOOP;

  IF v_live THEN
    RAISE EXCEPTION 'I5_TS_SENIOR_ACCOUNT_WRITE_REFUSED: UPDATE of % on %.% for an account holding a live ts_senior role, by role %',
                    array_to_string(v_refused, ', '), TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = 'KV055',
            HINT = 'decisions.md OE-48, OE-57, OE-58: for an account holding a live ts_senior role, app_rw may only move status towards less eligibility (active to suspended, removed or erased; pending to suspended, removed or erased; suspended to removed or erased; removed to erased) and dob_verified_18 from true to false; every other change of status, dob_verified_18 or id is app_admin_rw''s.';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.assert_ts_senior_account_written_by_admin() IS
  'SA §SA-4 I-5, decisions.md OE-48, OE-57 and OE-58 (T-192). BEFORE UPDATE row trigger on account: for an account holding an unrevoked ts_senior role, a writer that does not hold the privileges of app_admin_rw, or that also holds those of app_rw, is refused (KV055) every change of status except active to suspended, removed or erased, pending to suspended, removed or erased, suspended to removed or erased, and removed to erased; a change of dob_verified_18 from false to true; and any change of id. dob_verified_18 true to false is admitted. The ts_senior rows are read FOR SHARE. Every other account and column is not read.';

CREATE OR REPLACE TRIGGER trg_account_role_ts_senior_admin_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_role
  FOR EACH ROW EXECUTE FUNCTION public.assert_ts_senior_written_by_admin();

CREATE OR REPLACE TRIGGER trg_account_ts_senior_status_admin_only
  BEFORE UPDATE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.assert_ts_senior_account_written_by_admin();
