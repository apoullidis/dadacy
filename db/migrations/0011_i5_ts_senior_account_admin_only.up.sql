-- 0011_i5_ts_senior_account_admin_only.up.sql
--
-- @phase: expand
-- @compliance-review: assert_ts_senior_written_by_admin — T-192 (T-186 C4 (iv) hardening; OD-224 A4), two-approval path (PROTOCOL §3); replaced: the admin test also refuses a writer holding app_rw's privileges, and a TRUNCATE branch is added
-- @compliance-review: trg_account_role_ts_senior_no_truncate — T-192 (OD-224 A4), two-approval path (PROTOCOL §3); created here
-- @compliance-review: assert_ts_senior_account_written_by_admin — T-192 (OE-48 as narrowed by OE-57 and OE-58), two-approval path (PROTOCOL §3); created here
-- @compliance-review: trg_account_ts_senior_status_admin_only — T-192 (OE-48), two-approval path (PROTOCOL §3); created here
--
-- Ticket:  T-192 (tech-lead). The last two routes to a ts_senior countersignature by app_rw.
-- Spec:    SA §SA-4 I-5; decisions.md OE-48 (from OD-222, widened by T-186 QA-A1), narrowed by
--          OE-57 (T-192 QA-A3) and OE-58 (OD-236): towards less eligibility only; OE-45, OE-47;
--          OD-224 (T-186 QA-A2/A3/A4);
--          T-186 § tech-lead verification C4 (iv) and TL-RUN H; T-192 QA-A1, QA-A2.
-- Contracts: T-186 § Published contract (what 0008 creates; its §3 routes this file closes);
--          T-140 § Published contract (account, account_role, their grants); T-020 § Published
--          contract §3 (roles; RLS scoped by OD-223); T-021 / T-031 (lint).
--
-- 1. OE-48 AS NARROWED BY OE-57 AND OE-58: FOR A ts_senior HOLDER, app_rw MAY ONLY MOVE THE
--    ACCOUNT TOWARDS LESS ELIGIBILITY. assert_second_actor_differs() (0008) admits a countersigner
--    whose account row has status = 'active', joined on account.id; account_min_age_verified lets
--    status be 'active' only with dob_verified_18 true. app_rw holds UPDATE on account (0005), so
--    it could set a suspended ts_senior holder active around a countersignature, or commit the
--    activation (T-186 OD-222; QA OD-a..OD-d). A BEFORE UPDATE row trigger on account,
--    trg_account_ts_senior_status_admin_only, now admits, for an account that holds an UNREVOKED
--    ts_senior row and a writer that is not an admin writer (3. below), exactly these moves:
--      status          active -> suspended, removed or erased; pending -> suspended, removed
--                      or erased; suspended -> removed or erased; removed -> erased (OE-57:
--                      app_rw MAY suspend, remove or erase; OE-58: nothing out of suspended,
--                      removed or erased but towards less eligibility);
--      dob_verified_18 true -> false.
--    Everything else is refused, KV055 I5_TS_SENIOR_ACCOUNT_WRITE_REFUSED: any other status change
--    (into active from anything; into pending from anything; out of suspended other than to
--    removed or erased, which is lifting a suspension and is app_admin_rw's decision, OE-58; out of
--    removed other than to erased; out of erased), dob_verified_18 false -> true, and any id
--    change (OE-45's read joins on it). A NULL status or dob_verified_18 is not refused by this
--    guard: the columns' NOT NULL refuses it, 23502 (T-192 QA-B2); since 0012 (T-227) the guard,
--    now AFTER UPDATE, refuses it too, after NOT NULL has.
--    So an automated suspension by app_rw takes effect and cannot be undone by app_rw, and the
--    suspended holder's next countersignature is refused KV054 (0008). The guard is row-scoped, as
--    OE-48 rules: every other account, and every other column of a ts_senior holder, stays
--    writable by app_rw, so signup and verification writes are unaffected. When a refused move is
--    attempted, the account's ts_senior rows (revoked or not) are read FOR SHARE and revoked_at is
--    taken from the locked version (T-192 QA-A2): a concurrent app_admin_rw un-revoke WAITS for
--    the writing transaction, and one committed after a REPEATABLE READ or SERIALIZABLE snapshot
--    raises 40001 instead of going unseen. FOR SHARE and not FOR KEY SHARE: an un-revoke changes
--    revoked_at, which is in no unique key, so it takes FOR NO KEY UPDATE, which FOR KEY SHARE
--    does not block (measured in T-192 rework 1). A new ts_senior row INSERTed concurrently is
--    not seen: under READ COMMITTED a first-ever grant committing inside the open writing
--    transaction let it countersign and re-suspend (T-192 QA-B1; OE-59), which 0012 (T-227)
--    closes by locking the account row FOR SHARE when a ts_senior row becomes live.
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
--    is refused WHEN IT WRITES AS ITSELF. The test reads current_user, so any session that can
--    SET ROLE app_admin_rw is admitted after it: the superuser, a login in both roles, and every
--    app_rw login after GRANT app_admin_rw TO app_rw (T-192 QA-A1 measured the OD-a flip
--    committing that way, P1f and P10f). gate:migration-lint's R-ADMIN-MEMBERSHIP refuses the
--    migration route to such a membership. Cost, and it fails closed: if app_admin_rw were ever
--    made a member of app_rw, admins would be refused too.
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
-- replica), and any session that can SET ROLE app_admin_rw is an admin writer after it (3.).
-- app_ddl owns account, account_role and approval and can DISABLE a trigger at the database
-- (break-glass); gate:migration-lint refuses a migration that does so by name or renames a
-- protected trigger or function (R-TRIGGER-BYPASS, R-PROTECTED-RENAME). I-5 clause (c) is T-067's.
-- QA-B1, the READ COMMITTED first-grant race (1. above): closed by 0012 (T-227). TL-1: this file's
-- guard is a BEFORE ROW trigger, so a BEFORE UPDATE trigger on account whose name sorts after it
-- could change status after it approved the row (T-192 tech-lead ORD1); 0012 (T-227) makes it
-- AFTER UPDATE. TL-2: renaming account, account_role or approval and creating a replacement under
-- the old name leaves the protected triggers on the old table (T-192 tech-lead RT2);
-- gate:migration-lint refuses it since T-227 (R-PROTECTED-TABLE). [Corrected 2026-09-26 under
-- R-MERGED, comment lines only, T-227: §1's last sentence said the outcome was the permitted order.]
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

CREATE TRIGGER trg_account_ts_senior_status_admin_only
  BEFORE UPDATE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.assert_ts_senior_account_written_by_admin();

CREATE TRIGGER trg_account_role_ts_senior_no_truncate
  BEFORE TRUNCATE ON public.account_role
  FOR EACH STATEMENT EXECUTE FUNCTION public.assert_ts_senior_written_by_admin();

GRANT SELECT (id, status, dob_verified_18), UPDATE (status, dob_verified_18)
  ON public.account TO app_admin_rw;
