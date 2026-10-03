-- 0021_audit_chain.up.sql
--
-- @phase: expand
--
-- Ticket:  T-215 (tech-lead -> bct), P-AUDIT-CHAIN of tasks/state/EP-8b/OD-226-cut.md § 3.
-- Request: tasks/state/EP-3/T-067.md § Migration request, MR-3, the chain half (V-L6); the requesting
--          code is T-067 (the relay, the crypto-shred path, the anchor job and the chain verifier).
-- Spec:    SA §DA-9 line 1376 (entry_hash = SHA256(prev_entry_hash || canonical_json(entry_without_hashes)));
--          SA §SA-4 I-6; SD §DB-10 lines 2835-2848.
-- Rulings: OE-34 Part C of tasks/state/EP-2/OE-30-34-rulings.md, accepted by OE-50 (Part F): U-5 (1a),
--          (2), (3), (4) and U-6 (d).
-- Contracts: T-214 § Published contract (LIVE) §5 (a)-(e) (0020: the table this trigger is on);
--          T-020 § Published contract §3-§5 and T-231 (roles, explicit grants, the SA §INT-10 guard);
--          T-021 (rework 2) and T-031 (lint); T-136 (runner); T-137 (tripwire); T-234 (trigger pins).
--
-- WHAT IT CREATES. One function, public.audit_log_chain(), and one BEFORE INSERT row trigger,
-- trg_audit_log_chain, on the partitioned parent public.audit_log. PostgreSQL clones a row trigger
-- on a partitioned table to every partition (36 today, and any partition created or attached
-- later; a detached partition loses it; all measured by T-215), so it fires for a row routed through the parent AND for a row inserted into a partition
-- by name (measured by T-215).
--
-- WHAT THE TRIGGER DOES, for every row, in this order:
--   1. A writer supplies neither hash (U-5 (1a)). A non-NULL prev_entry_hash or entry_hash is
--      REFUSED: KV070 AUDIT_CHAIN_HASH_SUPPLIED. For app_rw the column grant refuses first (42501,
--      0020); KV070 holds the rule for the writers the grant does not bind (the owner app_ddl, the
--      superuser). Refused, not overwritten: a restore or copy that forgot the chain fails loudly
--      instead of silently re-hashing the rows it meant to preserve. An explicit NULL is the same as
--      omitting the column.
--   2. pg_advisory_xact_lock(5428598235315393603), the fixed chain key (the big-endian bytes of the
--      ASCII "KVAUDITC"; in pg_locks classid 1263944021, objid 1145656387, objsubid 1). Released at
--      the end of the inserting transaction, so appends are serialised from here to COMMIT or
--      ROLLBACK (U-6 (d)).
--   3. seq := nextval('public.audit_log_seq_seq'), drawn UNDER the lock. The column default has
--      already drawn a value before any BEFORE ROW trigger runs (measured by T-215), but outside
--      the lock, so two writers can draw seq in one order and take the lock in the other. Then
--      the head (the greatest seq) is not the last row chained, and two rows chain off one
--      predecessor (measured by T-215: a fork). Drawing seq again under the lock makes seq order
--      the chain order. The default's value is discarded, as is any value supplied with
--      OVERRIDING SYSTEM VALUE (seq has a default, so inside the trigger a supplied value cannot be
--      told from the default's). seq is strictly increasing along the chain and is not gap-free
--      (identity). Each row consumes at least two sequence values, but two ADJACENT chained rows
--      can still differ by 1 (the later row's default may have been drawn before the earlier row's
--      trigger drew; measured by T-215's QA). Any step of 1 or more between consecutive chained rows
--      is legitimate.
--   4. The head: the row with the greatest seq across every partition (ORDER BY seq DESC LIMIT 1
--      on the parent). Its entry_hash is prev_entry_hash; with no row, the genesis value, 32 zero
--      bytes (U-5 (4)). If the new seq is not above the head's, the row is REFUSED: KV071
--      AUDIT_CHAIN_SEQ_NOT_ABOVE_HEAD. Under the lock that cannot happen to rows this trigger chained;
--      it means the owner moved the sequence back (setval) or wrote a higher seq with this trigger
--      off, and appending would fork.
--   5. entry_hash := SHA-256(prev_entry_hash || convert_to(canonical_json, 'UTF8')), with pgcrypto's
--      public.digest(bytea, 'sha256'). canonical_json (U-5 (2), (3)) is the text of jsonb_build_object
--      over every non-hash column, keys always present, NULL as JSON null:
--        seq                bigint, a JSON number with every digit (above 2^53 too);
--        occurred_at        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
--                           a string, UTC, always six fractional digits; NOT the raw timestamptz,
--                           which jsonb renders in the session TimeZone (measured);
--        before_hash,       encode(…, 'hex'): lowercase hex with no \x prefix; NOT the raw bytea, which
--        after_hash         follows bytea_output (measured);
--        request_context    the jsonb value itself, nested (its own keys ordered the same way);
--        source_outbox_id   bigint, as seq;
--        every other column (actor_type, actor_id, action, subject_type, subject_id, data_class,
--                           policy_basis, reason_code, rationale) as jsonb renders it: a JSON string,
--                           char(26) WITH its blank padding, no Unicode normalisation.
--      jsonb's text form orders keys by length, then bytewise, and separates with ", " and ": ".
--      The published test vectors (T-215 § Published contract) pin the bytes, computed outside the
--      database; T-067's verifier must reproduce them.
--   6. Returns the row; the CHECKs, the NOT NULLs, the key and the UNIQUE are then checked as usual.
--
-- ISOLATION. The head read must see the rows committed while this transaction waited for the lock.
-- Under READ COMMITTED each statement in the function takes a fresh snapshot, so it does. Under
-- REPEATABLE READ or SERIALIZABLE the transaction's snapshot is older than the lock and the read
-- misses them (a fork, measured by T-215), so the trigger REFUSES a row written at any isolation
-- level but READ COMMITTED: KV072 AUDIT_CHAIN_ISOLATION. This check runs before the lock.
--
-- WHAT IS NOT CHECKED. The trigger is the chain's only writer while it is enabled. It does not bind:
--   - the owner app_ddl or the superuser, who can DISABLE it (ALTER TABLE … DISABLE TRIGGER, measured;
--     the superuser's session_replication_role = replica, not measured), drop it, or UPDATE and DELETE rows (V-L7, OD-78);
--     U-13 (a): detected by T-067's verifier and the S3 anchor (AV-4), not prevented here;
--   - an UPDATE: there is no UPDATE trigger. app_rw holds no UPDATE (0020). An owner's UPDATE that
--     moves a row to another partition fires this BEFORE INSERT trigger on the destination with the
--     old hashes, and is therefore refused KV070 (measured); one that stays in its partition is not;
--   - that the head itself is honest: it chains to whatever row has the greatest seq;
--   - a partition while it is detached (it has no clone then; ATTACH gives it one again);
--   - who else takes the chain key: pg_advisory_lock is EXECUTE for PUBLIC, so any role
--     (answering_service included) can hold 5428598235315393603 at session level and stall
--     every append for as long as it holds it (measured by T-215's QA: a lock timeout inside this
--     function, no row). Not prevented here (OD-273); a reconciler is to watch for it.
--
-- LOCKING, FOR WRITERS. Every INSERT into audit_log holds the chain lock until its transaction ends,
-- and every other INSERT waits for it. Insert last and commit promptly. A transaction that holds the
-- chain lock and then waits on a lock held by a transaction that is waiting for the chain lock is a
-- deadlock (40P01). The key is reserved for this chain: anything else that takes it serialises with
-- every append. The two-argument advisory lock form (int4, int4) does not share its key space
-- (objsubid 2; measured by T-215).
--
-- SECURITY DEFINER, deliberately. Step 3's nextval needs USAGE or UPDATE on audit_log_seq_seq, which
-- app_rw does not hold and is not given (0020: the sequence's ACL is NULL and app_rw's nextval is
-- refused 42501). Run as its owner app_ddl, the function draws seq, reads the head and calls digest
-- with app_ddl's privileges. Search path pinned to pg_catalog, pg_temp; every non-catalog object is
-- schema-qualified. A trigger function cannot be called directly (0A000), and PostgreSQL does not
-- check EXECUTE on a trigger's function when the trigger fires (measured by T-215: app_rw's rows are
-- chained with EXECUTE revoked from PUBLIC).
--
-- THE SA §INT-10 GUARD. CREATE FUNCTION and ALTER FUNCTION fire trg_int10_answering_service; CREATE
-- TRIGGER, REVOKE and COMMENT do not (0001's WHEN TAG IN list; REVOKE's tag is REVOKE, not GRANT).
-- Check (8) refuses a SECURITY DEFINER function that answering_service may EXECUTE, and PUBLIC holds
-- EXECUTE on every new function (measured: CREATE FUNCTION ... SECURITY DEFINER is refused KV010). So
-- the function is created SECURITY INVOKER, EXECUTE is revoked from PUBLIC, and only then is it made
-- SECURITY DEFINER; the guard runs again on that ALTER FUNCTION and passes.
--
-- PostgreSQL's own refusals print values in their DETAIL to the writer and, by default, to the
-- server log (OD-241 -> T-230): a CHECK's or NOT NULL's DETAIL now prints the computed hashes too.
-- The trigger's own messages (KV070, KV071, KV072) carry no column value.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which owns audit_log (0020), the sequence and
-- schema public, and so owns the function and may create the trigger. No -- @run-as marker: every
-- object is new and pgcrypto is installed by 0001 (in schema public).
--
-- PROTECTED OBJECTS. None of gate:migration-lint's R-PROTECTED list is named here. Adding
-- trg_audit_log_chain and audit_log_chain() to that list is a recommended T-021 follow-on, not this
-- change set.

CREATE FUNCTION public.audit_log_chain() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  head_seq  bigint;
  head_hash bytea;
BEGIN
  IF NEW.prev_entry_hash IS NOT NULL OR NEW.entry_hash IS NOT NULL THEN
    RAISE EXCEPTION 'AUDIT_CHAIN_HASH_SUPPLIED: audit_log.prev_entry_hash and entry_hash are set by trg_audit_log_chain; a writer supplies neither'
      USING ERRCODE = 'KV070',
            HINT = 'OE-50 Part C U-5 (1a): omit both hash columns; the chain trigger computes them.';
  END IF;

  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'AUDIT_CHAIN_ISOLATION: an audit_log row is chained only under READ COMMITTED'
      USING ERRCODE = 'KV072',
            HINT = 'Under REPEATABLE READ or SERIALIZABLE the head read cannot see a row committed while this transaction waited for the chain lock; write audit_log in a READ COMMITTED transaction.';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(5428598235315393603);

  NEW.seq := pg_catalog.nextval('public.audit_log_seq_seq'::pg_catalog.regclass);

  SELECT a.seq, a.entry_hash
    INTO head_seq, head_hash
    FROM public.audit_log AS a
   ORDER BY a.seq DESC
   LIMIT 1;

  IF head_seq IS NULL THEN
    NEW.prev_entry_hash := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  ELSIF NEW.seq > head_seq THEN
    NEW.prev_entry_hash := head_hash;
  ELSE
    RAISE EXCEPTION 'AUDIT_CHAIN_SEQ_NOT_ABOVE_HEAD: the seq drawn for this audit_log row is not above the chain head''s'
      USING ERRCODE = 'KV071',
            HINT = 'audit_log_seq_seq was moved back, or a row with a higher seq was written with the chain trigger off; appending would fork the chain.';
  END IF;

  NEW.entry_hash := public.digest(
    NEW.prev_entry_hash || pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'seq',              NEW.seq,
        'occurred_at',      pg_catalog.to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actor_type',       NEW.actor_type,
        'actor_id',         NEW.actor_id,
        'action',           NEW.action,
        'subject_type',     NEW.subject_type,
        'subject_id',       NEW.subject_id,
        'data_class',       NEW.data_class,
        'policy_basis',     NEW.policy_basis,
        'reason_code',      NEW.reason_code,
        'rationale',        NEW.rationale,
        'before_hash',      pg_catalog.encode(NEW.before_hash, 'hex'),
        'after_hash',       pg_catalog.encode(NEW.after_hash, 'hex'),
        'request_context',  NEW.request_context,
        'source_outbox_id', NEW.source_outbox_id
      )::text,
      'UTF8'),
    'sha256');

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.audit_log_chain() FROM PUBLIC;

ALTER FUNCTION public.audit_log_chain() SECURITY DEFINER;

COMMENT ON FUNCTION public.audit_log_chain() IS
  'BEFORE INSERT row trigger on audit_log (trg_audit_log_chain; T-215; SA §DA-9 1376; OE-50 Part C U-5, U-6). Per row: a supplied prev_entry_hash or entry_hash is KV070; a transaction not READ COMMITTED is KV072; then pg_advisory_xact_lock(5428598235315393603); seq := nextval(audit_log_seq_seq) under the lock; the head is the row with the greatest seq (none: 32 zero bytes), and a seq not above it is KV071; prev_entry_hash := the head''s entry_hash; entry_hash := sha256(prev_entry_hash || convert_to(canonical_json, UTF8)), canonical_json being jsonb_build_object over the fifteen non-hash columns as text, with occurred_at as to_char(occurred_at AT TIME ZONE UTC, YYYY-MM-DD"T"HH24:MI:SS.US"Z") and before_hash, after_hash as lowercase hex. SECURITY DEFINER (nextval); EXECUTE revoked from PUBLIC.';

CREATE TRIGGER trg_audit_log_chain
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_log_chain();
