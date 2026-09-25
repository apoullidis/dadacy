-- 0008_i5_active_approver_admin_ts_senior.up.sql
--
-- @phase: expand
-- @compliance-review: assert_second_actor_differs — T-186 (OE-45), two-approval path (PROTOCOL §3); replaced to add the account-status clause
-- @compliance-review: assert_ts_senior_written_by_admin — T-186 (OE-47), two-approval path (PROTOCOL §3); created here
-- @compliance-review: trg_account_role_ts_senior_admin_only — T-186 (OE-47), two-approval path (PROTOCOL §3); created here
--
-- Ticket:  T-186 (tech-lead). SA §SA-4 I-5 follow-ups the stakeholder ruled after T-030:
--          OE-45 (only an ACTIVE account's ts_senior satisfies I-5) and OE-47 (only
--          app_admin_rw may grant, revoke, un-revoke or move a ts_senior row in account_role;
--          app_rw is refused at the database).
-- Spec:    SA §SA-4 I-5 (solutions-architect.md line 483); decisions.md OE-21, OE-45, OE-47,
--          OD-214, OD-216.
-- Contracts: T-030 § Rework 1 › Published contract (rework 1) — LIVE (what 0007 creates);
--          T-020 § Published contract §3-§5 (roles, explicit grants, the INT-10 guard);
--          T-140 § Published contract (account.status, account_role and its grants);
--          T-021 / T-031 (lint).
--
-- 1. OE-45: THE COUNTERSIGNER'S ACCOUNT MUST BE ACTIVE. `assert_second_actor_differs()` is
--    replaced (same name, signature, owner, SECURITY INVOKER, search_path). Its clause (b) read
--    now joins account_role to account and requires status = 'active', FOR SHARE, so it locks the
--    account row as well as the role row: a concurrent change of that account's status waits for
--    an open countersignature, as a concurrent revoke of the role already did (0007).
--    A countersigner whose unrevoked ts_senior row sits on an account that is not active is
--    refused with KV054 I5_APPROVER_NOT_ACTIVE. KV052 keeps its meaning (no unrevoked ts_senior
--    row at all) and its exact text. Which of the two is raised is decided by a second, unlocked
--    read made only after the joined read has already refused, so it chooses the message and
--    never the verdict.
--
-- 2. OE-47: ONLY app_admin_rw MAY WRITE A ts_senior ROW. A BEFORE ROW trigger on account_role,
--    `trg_account_role_ts_senior_admin_only`, refuses an INSERT, UPDATE or DELETE whose new row
--    or old row has role = 'ts_senior' unless current_user holds the privileges of app_admin_rw
--    (pg_has_role … 'USAGE'), with KV053 I5_TS_SENIOR_WRITE_REFUSED. It is scoped to ts_senior
--    ROWS on purpose: T-030 measured (RM1) that revoking app_rw's INSERT/UPDATE on account_role
--    table-wide refuses every countersignature, because the SECURITY INVOKER clause-(b) read
--    locks the role row FOR SHARE, which needs UPDATE. app_rw keeps SELECT, INSERT and UPDATE
--    on the table and keeps writing every other role.
--    Who passes the check: a role holding app_admin_rw's privileges, and a superuser (PostgreSQL
--    answers pg_has_role true for one). [0011 (T-192) replaces this function: a writer that also
--    holds app_rw's privileges is refused, the superuser acting as itself included. Corrected
--    2026-09-25 under R-MERGED, comment lines only.] Who does not: app_rw, app_ddl, app_safety_rw,
--    answering_service, and the table owner when PostgreSQL runs a foreign-key action as it
--    (an ON DELETE CASCADE from account reaching a ts_senior row is refused; no application
--    role holds DELETE on account).
--
-- 3. GRANTS. There are no default privileges (T-020 § contract §4), so each is explicit:
--      app_admin_rw   SELECT, INSERT, UPDATE on account_role, so that OE-47's principal can
--                     write the rows the trigger reserves to it. No DELETE: a role is revoked by
--                     revoked_at (T-140 § contract §5). Nothing on account, account's foreign key
--                     is checked as the table owner.
--    RLS. T-020 § contract §3 said RLS with FORCE ROW LEVEL SECURITY applies to app_admin_rw
--    (SA §SEC-7's Database row; §SEC-9, cited here until 2026-09-25, is break-glass: corrected
--    under R-MERGED, T-192). SD names the tables that carry it (software-design.md lines 1309 and 3906:
--    child, child_health, sitter_credential, idv_result, message, case_note, reference_check),
--    and account_role is not one of them, so no policy is written here (T-186 evidence,
--    Deviations).
--
-- WHAT THIS DOES NOT CLOSE. account.status is written by app_rw (UPDATE on account, 0005), so
-- with this migration alone app_rw can set a non-active approver's account to 'active' and
-- countersign, in one transaction or committed with no flip-back (T-186 OD-222; QA OD-a..OD-d),
-- exactly as it could un-revoke a role before this migration. 0011 (T-192, decisions.md OE-48)
-- closes that for an account holding a live ts_senior role. The superuser bounds of 0007 stand
-- (session_replication_role = replica), and app_ddl, as owner of account_role and approval, can
-- still DISABLE either trigger at the database. gate:migration-lint refuses a migration that
-- disables either trigger BY NAME (R-TRIGGER-BYPASS; naming it at all needs R-PROTECTED's
-- marker); until T-192 it did not refuse one marked migration that renamed a trigger and then
-- disabled it under the new name (T-186 QA X5), which R-PROTECTED-RENAME now refuses.
-- (Corrected 2026-09-25 under R-MERGED, comment lines only, T-192: this said the lint "refuses a
-- migration that does", which was wider than the by-name rule.)
--
-- PRINCIPAL. app_ddl (T-136 § contract §6): it owns the function, account_role and account.
-- No -- @run-as marker. Transactional; no -- @no-transaction marker.

CREATE OR REPLACE FUNCTION public.assert_second_actor_differs() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $fn$
DECLARE
  v_row    jsonb := to_jsonb(NEW);
  v_first  text;
  v_second text;
BEGIN
  IF TG_NARGS <> 2 OR NOT (v_row ? TG_ARGV[0]) OR NOT (v_row ? TG_ARGV[1]) THEN
    RAISE EXCEPTION 'I5_TRIGGER_MISCONFIGURED: trigger % on %.% must name two columns of the row',
                    TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'KV050';
  END IF;
  v_first  := v_row ->> TG_ARGV[0];
  v_second := v_row ->> TG_ARGV[1];

  -- Not yet countersigned: nothing to check.
  IF v_second IS NULL THEN
    RETURN NULL;
  END IF;

  -- Clause (a). Absence of the first actor is not "different".
  IF v_first IS NULL OR upper(btrim(v_first)) = upper(btrim(v_second)) THEN
    RAISE EXCEPTION 'I5_SECOND_ACTOR_NOT_DIFFERENT: %.% requires % to be a different actor from %',
                    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[1], TG_ARGV[0]
      USING ERRCODE = 'KV051',
            HINT = 'SA §SA-4 I-5: a countersignature must come from a second, different account.';
  END IF;

  -- Clause (b), OE-21 and OE-45: an unrevoked ts_senior on an ACTIVE account. FOR SHARE locks
  -- the role row and the account row, so a concurrent revoke or status change waits.
  PERFORM 1
     FROM public.account_role ar
     JOIN public.account a ON a.id = ar.account_id
    WHERE ar.account_id = v_second::bpchar
      AND ar.role = 'ts_senior'
      AND ar.revoked_at IS NULL
      AND a.status = 'active'
      FOR SHARE;
  IF NOT FOUND THEN
    -- Refused either way; this read only chooses which refusal to report.
    PERFORM 1
       FROM public.account_role ar
      WHERE ar.account_id = v_second::bpchar
        AND ar.role = 'ts_senior'
        AND ar.revoked_at IS NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'I5_APPROVER_NOT_ACTIVE: %.%.% holds ts_senior on an account that is not active',
                      TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[1]
        USING ERRCODE = 'KV054',
              HINT = 'SA §SA-4 I-5 and decisions.md OE-45: only an ACTIVE account''s ts_senior may countersign.';
    END IF;
    RAISE EXCEPTION 'I5_APPROVER_LACKS_TS_SENIOR: %.%.% holds no unrevoked ts_senior role',
                    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[1]
      USING ERRCODE = 'KV052',
            HINT = 'SA §SA-4 I-5 and decisions.md OE-21: only an account holding ts_senior may countersign.';
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.assert_second_actor_differs() IS
  'SA §SA-4 I-5 (T-030, T-186). AFTER ROW trigger: args (first_actor_column, second_actor_column). When the second is set it must differ from the first (KV051) and hold an unrevoked ts_senior role on an account whose status is active, read FOR SHARE (KV052 no such role; KV054 the account is not active; OE-21, OE-45). Misconfigured args: KV050.';

CREATE FUNCTION public.assert_ts_senior_written_by_admin() RETURNS trigger
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

CREATE TRIGGER trg_account_role_ts_senior_admin_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_role
  FOR EACH ROW EXECUTE FUNCTION public.assert_ts_senior_written_by_admin();

GRANT SELECT, INSERT, UPDATE ON public.account_role TO app_admin_rw;
