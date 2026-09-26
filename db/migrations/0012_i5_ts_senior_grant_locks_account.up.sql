-- 0012_i5_ts_senior_grant_locks_account.up.sql
--
-- @phase: expand
-- @compliance-review: assert_ts_senior_written_by_admin — T-227 (decisions.md OE-59, T-192 QA-B1), two-approval path (PROTOCOL §3); replaced: an admitted write that makes a ts_senior row live locks the account row FOR SHARE
-- @compliance-review: trg_account_role_ts_senior_admin_only — T-227 (OD-237 TL-1), two-approval path (PROTOCOL §3); replaced in place: BEFORE ROW becomes AFTER ROW, same events, same function
-- @compliance-review: assert_ts_senior_account_written_by_admin — T-227 (T-192 QA-B2, QA-B3, C3 (iii)), two-approval path (PROTOCOL §3); replaced: typed (OLD, NEW) status pairs, a NULL refused, the COMMENT and KV055 HINT re-issued
-- @compliance-review: trg_account_ts_senior_status_admin_only — T-227 (OD-237 TL-1), two-approval path (PROTOCOL §3); replaced in place: BEFORE UPDATE becomes AFTER UPDATE, same function
--
-- Ticket:  T-227 (tech-lead). I-5: a first ts_senior grant serialises with an open activation.
-- Spec:    SA §SA-4 I-5; decisions.md OE-59 (T-192 QA-B1), OE-47, OE-48 as narrowed by OE-57 and
--          OE-58, OD-235, OD-237 (T-192 tech-lead TL-1, TL-2); T-192 § tech-lead verification C3.
-- Contracts: T-192 § Published contract (what 0011 creates, and its §4 bounds this file closes);
--          T-186 § Published contract (0008's OE-47 guard); T-140 § Published contract (account,
--          account_role); T-021 / T-031 (lint).
--
-- 1. OE-59: A ts_senior ROW THAT BECOMES LIVE LOCKS ITS ACCOUNT ROW. Under READ COMMITTED, an
--    app_rw transaction could activate an account holding no ts_senior row (nothing for 0011's
--    guard to read), and an app_admin_rw grant of that account's FIRST ts_senior row did not wait
--    for it: the grant's foreign key takes FOR KEY SHARE on the account row, which does not
--    conflict with the activation's FOR NO KEY UPDATE. The open transaction then saw the committed
--    grant, countersigned as the account and suspended it again, and committed (T-192 QA-B1,
--    NG-RC; T-227 RACE-RED). assert_ts_senior_written_by_admin() now, AFTER its admin test admits
--    a write whose new row is a live ts_senior row that the old row was not (an INSERT, an
--    un-revoke, a re-role to ts_senior, or a move onto another account), locks that account row
--    FOR SHARE. FOR SHARE conflicts with the FOR NO KEY UPDATE an UPDATE of the account takes, in
--    both directions: the grant waits for an open activation, whose countersignature then cannot
--    see it (KV052); and an activation waits for an open grant, whose row its guard then reads
--    (KV055). Measured in T-227 against FOR KEY SHARE (the race stays open) and FOR UPDATE (it
--    also closes it, and also makes a login's session insert wait on an open grant, because it
--    conflicts with the foreign key's FOR KEY SHARE); FOR SHARE is the weakest mode that closes
--    it. A revoke, and every write of another role, takes no account lock.
--
-- 2. OD-237 TL-1: BOTH ROW GUARDS FIRE AFTER THE ROW IS WRITTEN. A BEFORE ROW trigger sees NEW as
--    it stood when it fired, and PostgreSQL fires BEFORE ROW triggers in name order, each receiving
--    the previous one's NEW. So a later-sorting BEFORE trigger could change status after 0011's
--    guard had approved the row, or re-role a row to ts_senior after 0008's guard had approved it
--    (T-192 tech-lead ORD1; T-227 ORD1, ORD2: each stored a countersignature). An AFTER ROW trigger
--    reads the row as stored, after every BEFORE trigger, and its RAISE still aborts the statement.
--    CREATE OR REPLACE TRIGGER keeps each trigger's name, events and function; only the timing
--    changes. What this moves: an AFTER trigger fires after the table's constraints are checked,
--    so a NULL status or dob_verified_18 is refused 23502 (NOT NULL) and an id change of a ts_senior
--    holder 23503 (account_role's foreign key, whose internal trigger fires first) before the guard
--    runs; and an upsert of a ts_senior row reports the operation that happened (UPDATE on a
--    conflict), where the BEFORE INSERT trigger fired on the proposed row first. Each is still
--    refused. The TRUNCATE statement trigger (0011) is unchanged.
--
-- 3. T-192 QA-B2: THE ACCOUNT GUARD NAMES ITS ALLOWED MOVES AS TYPED PAIRS, AND A NULL IS REFUSED.
--    0011 compared OLD.status || '>' || NEW.status against nine strings; a NULL NEW.status made
--    that comparison NULL, and IF NULL admitted it (QA NULLGUARD; the column's NOT NULL refused it).
--    Now the status move is admitted only when (OLD.status, NEW.status) IN (VALUES …) IS TRUE,
--    over nine account_status pairs, so a NULL is refused, and a pair misspelt in the list raises
--    (22P02) on every guarded write instead of silently refusing one move. dob_verified_18 is
--    admitted only unchanged or true -> false. The COMMENT and the KV055 HINT are re-issued to say
--    so. The KV055 and KV053 message texts are unchanged.
--
-- WHAT THIS DOES NOT CLOSE. The superuser's session_replication_role = replica switches every
-- trigger off; any session that can SET ROLE app_admin_rw is an admin writer after it (T-192 §4).
-- app_ddl owns account, account_role and approval and can DISABLE a trigger at the database
-- (break-glass). A NEW ts_senior row granted after a REPEATABLE READ or SERIALIZABLE app_rw
-- transaction's snapshot is invisible to it, so its activation commits and leaves the account
-- active with a live ts_senior: the permitted order (activation, then grant); that transaction
-- cannot countersign with the grant (KV052, T-192 QA NG-RRC). A grant racing an activation can
-- also deadlock when the admin transaction locked the role row before writing it (40P01 for one
-- side; either outcome is a serial order, T-227 DL-A/DL-B). gate:migration-lint's new refusals
-- (a rename or re-creation of these three tables, DEPENDS ON EXTENSION, U&"…" names) are
-- T-227's lint change, not this file's. I-5 clause (c) is T-067's.
--
-- ORDER. Both triggers become AFTER before either function is replaced: the new bodies return NULL,
-- which a BEFORE ROW trigger would read as "skip this row".
--
-- PRINCIPAL. app_ddl (T-136 § contract §6): it owns both functions and both tables. No -- @run-as
-- marker. Transactional; no -- @no-transaction marker.

CREATE OR REPLACE TRIGGER trg_account_role_ts_senior_admin_only
  AFTER INSERT OR UPDATE OR DELETE ON public.account_role
  FOR EACH ROW EXECUTE FUNCTION public.assert_ts_senior_written_by_admin();
CREATE OR REPLACE TRIGGER trg_account_ts_senior_status_admin_only
  AFTER UPDATE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.assert_ts_senior_account_written_by_admin();

CREATE OR REPLACE FUNCTION public.assert_ts_senior_written_by_admin() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $fn$
DECLARE
  v_touches boolean;
  v_becomes_live boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches := NEW.role = 'ts_senior';
    v_becomes_live := NEW.role = 'ts_senior' AND NEW.revoked_at IS NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_touches := NEW.role = 'ts_senior' OR OLD.role = 'ts_senior';
    v_becomes_live := NEW.role = 'ts_senior' AND NEW.revoked_at IS NULL
                      AND NOT (OLD.role = 'ts_senior' AND OLD.revoked_at IS NULL
                               AND OLD.account_id = NEW.account_id);
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

  -- OE-59 (T-192 QA-B1): a ts_senior row becoming live on an account locks that account row FOR
  -- SHARE, so this write and an open change of the account's status serialise (see 1. above).
  IF v_becomes_live THEN
    PERFORM 1 FROM public.account a WHERE a.id = NEW.account_id FOR SHARE;
  END IF;

  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.assert_ts_senior_written_by_admin() IS
  'SA §SA-4 I-5, decisions.md OE-47 (T-186, T-192) and OE-59 (T-227). AFTER ROW trigger on account_role (since T-227; it reads the row as stored, after every BEFORE trigger): an INSERT, UPDATE or DELETE whose new or old row has role ts_senior is refused (KV053) unless current_user holds the privileges of app_admin_rw and not those of app_rw. When an admitted INSERT or UPDATE makes a ts_senior row live on an account that it was not live on before (a grant, an un-revoke, a re-role to ts_senior, a move to another account), the account row is locked FOR SHARE: the write waits for an open transaction that has updated that row, and a later update of the row waits for the write. BEFORE TRUNCATE statement trigger: a TRUNCATE while any ts_senior row exists is refused the same way (OD-224). Other roles are not read.';

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
  -- TOWARDS less eligibility. A status change is admitted only if (OLD, NEW) is one of the nine
  -- pairs below; every other change, a NULL included, is refused. dob_verified_18 is admitted only
  -- unchanged or true -> false. Any id change is refused.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    v_refused := v_refused || 'id'::text;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND ((OLD.status, NEW.status) IN (VALUES
           ('active'::public.account_status, 'suspended'::public.account_status),
           ('active', 'removed'), ('active', 'erased'),
           ('pending', 'suspended'), ('pending', 'removed'), ('pending', 'erased'),
           ('suspended', 'removed'), ('suspended', 'erased'),
           ('removed', 'erased'))) IS NOT TRUE THEN
    v_refused := v_refused || 'status'::text;
  END IF;
  IF NEW.dob_verified_18 IS DISTINCT FROM OLD.dob_verified_18
     AND NOT (OLD.dob_verified_18 IS TRUE AND NEW.dob_verified_18 IS FALSE) THEN
    v_refused := v_refused || 'dob_verified_18'::text;
  END IF;

  IF cardinality(v_refused) = 0
     OR (pg_has_role(current_user, 'app_admin_rw', 'USAGE')
         AND NOT pg_has_role(current_user, 'app_rw', 'USAGE')) THEN
    RETURN NULL;
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
            HINT = 'decisions.md OE-48, OE-57, OE-58: for an account holding a live ts_senior role, app_rw may only move status towards less eligibility (active to suspended, removed or erased; pending to suspended, removed or erased; suspended to removed or erased; removed to erased) and dob_verified_18 from true to false; every other change of status, dob_verified_18 or id, to NULL included, is app_admin_rw''s.';
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.assert_ts_senior_account_written_by_admin() IS
  'SA §SA-4 I-5, decisions.md OE-48, OE-57 and OE-58 (T-192); AFTER UPDATE since T-227 (OD-237). AFTER UPDATE row trigger on account, so it reads the row as stored, after every BEFORE trigger: for an account holding an unrevoked ts_senior role, a writer that does not hold the privileges of app_admin_rw, or that also holds those of app_rw, is refused (KV055) every change of status other than active to suspended, removed or erased, pending to suspended, removed or erased, suspended to removed or erased, and removed to erased (a NULL status included); every change of dob_verified_18 other than true to false (NULL included); and any change of id. Before it runs, the columns'' NOT NULL refuses a NULL status or dob_verified_18 (23502), and account_role''s foreign key refuses an id change (23503). The ts_senior rows are read FOR SHARE. Every other account and column is not read.';
