-- 0008_i5_active_approver_admin_ts_senior.down.sql
--
-- @compliance-review: assert_second_actor_differs — T-186 (OE-45), two-approval path (PROTOCOL §3); restored to 0007's definition
-- @compliance-review: assert_ts_senior_written_by_admin — T-186 (OE-47), two-approval path (PROTOCOL §3); dropped
-- @compliance-review: trg_account_role_ts_senior_admin_only — T-186 (OE-47), two-approval path (PROTOCOL §3); dropped
--
-- Ticket: T-186 (tech-lead). The inverse of the up file. After this file the database is the
-- 0007 state: no trigger on account_role, no assert_ts_senior_written_by_admin(), no grant to
-- app_admin_rw on account_role, and assert_second_actor_differs() and its COMMENT exactly as
-- 0007 created them (the function below is 0007's text, copied byte for byte).
--
-- ORDER. The trigger before its function (no CASCADE: gate:migration-lint R-CASCADE), then the
-- grant, then the function 0007 owns, restored.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TRIGGER trg_account_role_ts_senior_admin_only ON public.account_role;
DROP FUNCTION public.assert_ts_senior_written_by_admin();

REVOKE SELECT, INSERT, UPDATE ON public.account_role FROM app_admin_rw;

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

  -- Clause (b), OE-21: ts_senior ONLY. FOR SHARE blocks a concurrent revoke (T-140 TL-A3).
  PERFORM 1
     FROM public.account_role ar
    WHERE ar.account_id = v_second::bpchar
      AND ar.role = 'ts_senior'
      AND ar.revoked_at IS NULL
      FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'I5_APPROVER_LACKS_TS_SENIOR: %.%.% holds no unrevoked ts_senior role',
                    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[1]
      USING ERRCODE = 'KV052',
            HINT = 'SA §SA-4 I-5 and decisions.md OE-21: only an account holding ts_senior may countersign.';
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.assert_second_actor_differs() IS
  'SA §SA-4 I-5 (T-030). AFTER ROW trigger: args (first_actor_column, second_actor_column). When the second is set it must differ from the first (KV051) and hold an unrevoked ts_senior role, read FOR SHARE (KV052; OE-21). Does not read account.status. Misconfigured args: KV050.';
