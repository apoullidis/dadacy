-- 0007_approval_four_eyes.up.sql
--
-- @phase: expand
--
-- Ticket:  T-030 (tech-lead). SA §SA-4 I-5, four-eyes approvals, at the DATABASE layer: the
--          `approval` table SD writes for it, its CHECK (clause a), and the trigger that holds
--          the role clause (clause b) as the stakeholder ruled it (OE-21: `ts_senior` ONLY).
-- Spec:    SA §SA-4 I-5 (solutions-architect.md line 483); SD `approval` (software-design.md
--          lines 2755-2760); SD §BE-10 grid lines 1269-1284 and the countersign endpoint, line
--          1083 ("DB CHECK is the real guard"); decisions.md OE-21, OD-66.
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the INT-10 guard);
--          T-140 § Published contract (account, account_role) and its second approval TL-A3;
--          T-136 § contract §6 (principal: app_ddl, no marker needed); T-021 / T-031 (lint).
--
-- WHAT I-5 REQUIRES, AND WHERE EACH CLAUSE LIVES.
--   (a) the approver is a DIFFERENT actor from the submitter. SD's CHECK
--       `approval_distinct_actors`, verbatim. The trigger below repeats the comparison after
--       upper-casing and trimming both ids, so a case or whitespace variant of the submitter's
--       own id is refused too (the CHECK compares bytes).
--   (b) the approver holds `ts_senior` (SA's "policy rule that an approver must hold ts_senior";
--       OE-21: ts_senior ONLY, whoever performed the action). A foreign key cannot carry this:
--       T-140's second approver measured an FK to account_role accepting a REVOKED ts_senior
--       (T-140 TL-A3 (ii)). So it is a trigger, reading the role row with revoked_at IS NULL.
--   (c) "an audit entry for both roles" is NOT here: audit_log does not exist yet (T-067).
--
-- THE TRIGGER READS THE ROLE ROW `FOR SHARE`. A plain read, or FOR KEY SHARE, does not block a
-- concurrent revoke of that role; FOR SHARE does (T-140 TL-A3 (iii), 55P03). So an approval and
-- a revoke of its approver's ts_senior cannot both commit: whichever is second waits for the
-- first, and a countersignature that waited for a committed revoke re-reads the row and is
-- refused.
--
-- IT IS AN AFTER TRIGGER, ON PURPOSE. CHECK constraints are evaluated before AFTER ROW triggers
-- fire, so an exact self-countersignature is refused by SD's own CHECK, by name, and the trigger
-- is what refuses the rest.
--
-- WHAT IT DOES NOT READ. The approver account's `status`. A live ts_senior role on a SUSPENDED
-- account satisfies this trigger. SA §SA-4 I-5, OE-21 and SD name the role only and say nothing
-- about account status, so this is reported (decisions.md), not decided here (T-140 TL-A3 (i)).
--
-- GENERIC. `public.assert_second_actor_differs(<first column>, <second column>)` is written so
-- any table that records a second actor can attach it; the two column names are its trigger
-- arguments. A trigger naming a column the row does not have is refused when it fires (KV050),
-- never read as "not countersigned".
--
-- REFUSALS (raised with these SQLSTATEs; `app/packages/db-testkit/suites/four-eyes.test.ts`):
--   23514  approval_distinct_actors            approver_id = submitter_id, byte for byte
--   KV051  I5_SECOND_ACTOR_NOT_DIFFERENT       the same id up to case/whitespace, or no first actor
--   KV052  I5_APPROVER_LACKS_TS_SENIOR         no unrevoked ts_senior row for the second actor
--   KV050  I5_TRIGGER_MISCONFIGURED            wrong argument count, or a column the row lacks
--
-- PRINCIPAL. app_ddl (T-136 § contract §6). No statement here needs the superuser: app_ddl owns
-- schema public, account_role and account. No -- @run-as marker.
--
-- GRANTS. There are no default privileges (T-020 § contract §4), so each is explicit:
--   app_rw             SELECT, INSERT, UPDATE on approval. No DELETE: an approval is a record of
--                      who countersigned what. `apps/core` serves /v1/admin/approvals/{id}/countersign.
--   app_admin_rw       nothing. An admin grant needs its FORCE ROW LEVEL SECURITY policy (T-020
--                      § contract §3, SA §SEC-9); the admin ticket requests both.
--   app_safety_rw      nothing (T-020 § contract §3).
--   answering_service  nothing. SA §INT-10.
-- The trigger function is SECURITY INVOKER, so the role writing `approval` must itself be able to
-- read account_role FOR SHARE (SELECT and UPDATE on it). app_rw holds both (0005). A role that
-- cannot is refused 42501 at the countersignature: it fails closed.
--
-- Transactional; no -- @no-transaction marker.

CREATE TABLE public.approval (                     -- four-eyes (SA I-5)
  id char(26) PRIMARY KEY, subject_type text NOT NULL, subject_id char(26) NOT NULL,
  action text NOT NULL, submitter_id char(26) NOT NULL, submitted_at timestamptz NOT NULL,
  approver_id char(26), approved_at timestamptz, decision text, rationale text,
  CONSTRAINT approval_distinct_actors CHECK (approver_id IS DISTINCT FROM submitter_id)
);
GRANT SELECT, INSERT, UPDATE ON public.approval TO app_rw;

CREATE FUNCTION public.assert_second_actor_differs() RETURNS trigger
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

CREATE TRIGGER trg_approval_four_eyes
  AFTER INSERT OR UPDATE ON public.approval
  FOR EACH ROW EXECUTE FUNCTION public.assert_second_actor_differs('submitter_id', 'approver_id');
