-- 0032_i1_hardening.up.sql
--
-- @phase: expand
-- @run-as: bootstrap-superuser — T-274 (replaces public.i1_enqueue_slot_materialise, owned by the bootstrap superuser under EV-57; T-020 §3's replace exception)
-- @compliance-review: i1_rederive_sitter — T-274 (T-028 approval 2 TL-A, L-4 (i)), two-approval path (PROTOCOL §3); replaced: refuses any isolation level but READ COMMITTED (KV083) before its row lock
-- @compliance-review: i1_enqueue_slot_materialise — T-274 (T-028 approval 2 TL-D, L-4 (iii); EV-57 unchanged), two-approval path (PROTOCOL §3); replaced: the WARNING 01K81 text only, and its COMMENT
-- @compliance-review: i1_derived_bookable — T-274, two-approval path (PROTOCOL §3); called by the replaced writer, not changed
-- @compliance-review: trg_sitter_profile_i1_enqueue — T-274, two-approval path (PROTOCOL §3); named only in the COMMENT text, not changed
--
-- Ticket:  T-274 (tech-lead). The successor T-028's tech-lead approval 2 cut (state/EP-5/T-028.md
--          § Tech-lead review (approval 2) › L-4 (i) and (iii)). It changes two functions 0030
--          created and creates nothing.
-- Spec:    SA §SA-4 I-1 (layer 1); T-028 § Published contract (rework 1) §1, §3, §8; decisions.md
--          EV-57 (OE-91 (a)); T-020 § Published contract §3 (a migration that must replace a
--          superuser-owned object runs as the bootstrap superuser).
--
-- (i) THE ISOLATION GUARD (T-028 TL-A, measured there as TL-6). public.i1_rederive_sitter locks the
-- sitter_profile row and then reads the sitter's credentials and account through
-- i1_derived_bookable. Under READ COMMITTED each statement takes a fresh snapshot, so the read sees
-- every row committed while the call waited for the lock. Under REPEATABLE READ or SERIALIZABLE the
-- transaction's snapshot is older than the lock, so a sitter whose mandatory credential a concurrent
-- READ COMMITTED transaction had withdrawn was committed 'bookable' (TL-6: RR and SR, both). This is
-- the lock-then-read class 0021 guards with KV072 AUDIT_CHAIN_ISOLATION, and the guard has 0021's
-- form: current_setting('transaction_isolation') <> 'read committed' raises SQLSTATE KV083
-- (I1_DERIVATION_ISOLATION; the message carries no value), checked BEFORE the row lock, so a
-- refused call neither waits for nor takes it.
-- WHICH CALLS IT REFUSES. A call whose id names a sitter_profile row the call can see. The writer
-- first reads, without a lock, whether that row exists; when it does not, it returns NULL at any
-- isolation level, as 0030's writer did, and writes nothing. That is what keeps an account
-- status or jurisdiction change of an account that is not a sitter (account trigger -> this writer)
-- working at REPEATABLE READ and SERIALIZABLE: I-5's suites drive exactly such changes at those
-- levels (four-eyes.test.ts; measured, state/EP-5/T-274.md). BOUND: under REPEATABLE READ or
-- SERIALIZABLE, a sitter_profile row committed after the transaction's snapshot is not seen, so the
-- call returns NULL and derives nothing for it. A new row is inserted with the derived columns at
-- their defaults ('onboarding', NULL, 0, NULL; app_rw may INSERT only id, 0025), so what that leaves is
-- a stored non-bookable state, which the reconciler pages if the derivation disagrees.
-- Every path to the derivation goes through this function: the credential row and TRUNCATE
-- triggers, the account trigger, and a direct call by app_rw or app_admin_rw.
--
-- (iii) THE TWO SHIPPED STRINGS (T-028 TL-D; QA round 3's deferred item). The WARNING 01K81 text
-- said "the change commits without a job" and the enqueue's COMMENT said "any other new state
-- commits without a job". Neither holds when the change shares a statement or a transaction with a
-- change INTO 'bookable' (KV081 aborts both: T-028 contract §3 r4's bound), nor for a transaction
-- that rolls back for any other reason. They now read, in QA round 3's proposed wording:
--   WARNING: "...; if this transaction commits, the change has no job"
--   COMMENT: "...any other new state raises WARNING 01K81 and inserts no job (the write commits only
--            if nothing in its statement or transaction raises KV081)..."
-- Nothing else in the enqueue changes: the body is 0030's byte for byte apart from that one string
-- literal. CREATE OR REPLACE keeps the function's owner (the bootstrap superuser), its ACL (EXECUTE
-- app_ddl only, PUBLIC revoked) and its comment's object; SECURITY DEFINER and the pinned search_path
-- are restated, because CREATE OR REPLACE sets every attribute it is given and defaults the rest.
-- EV-57's terms are unchanged; the T-274 evidence compares the catalogue before and after.
--
-- WHO RUNS THIS FILE. The bootstrap superuser (@run-as above), because app_ddl cannot replace a
-- superuser-owned function (42501 must be owner of function, T-021 S1-O). The writer stays owned by
-- app_ddl: a CREATE OR REPLACE by a superuser does not change a function's owner. Transactional.
-- The SA §INT-10 guard's event trigger fires on each CREATE FUNCTION here.

-- ---------------------------------------------------------------------------------------------
-- (i) The writer, with the isolation guard
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.i1_rederive_sitter(p_sitter_id pg_catalog.bpchar)
  RETURNS public.bookable_state
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  SET app.i1_derivation = 'on'
AS $fn$
DECLARE
  cur record;
  der record;
BEGIN
  PERFORM 1 FROM public.sitter_profile AS p WHERE p.id = p_sitter_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'I1_DERIVATION_ISOLATION: bookable_state is derived only under READ COMMITTED'
      USING ERRCODE = 'KV083',
            HINT = 'Under REPEATABLE READ or SERIALIZABLE the derivation would read a snapshot older than the sitter_profile row lock and miss a credential or account change committed while it waited; write credentials and account status in a READ COMMITTED transaction.';
  END IF;

  SELECT p.bookable_state, p.tier, p.tier_rank, p.bookable_since
    INTO cur
    FROM public.sitter_profile AS p
   WHERE p.id = p_sitter_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT d.o_bookable_state AS bookable_state, d.o_tier AS tier, d.o_tier_rank AS tier_rank
    INTO der
    FROM public.i1_derived_bookable(p_sitter_id) AS d;

  IF der.bookable_state IS DISTINCT FROM cur.bookable_state
     OR der.tier IS DISTINCT FROM cur.tier
     OR der.tier_rank IS DISTINCT FROM cur.tier_rank
     OR (der.bookable_state = 'bookable'::public.bookable_state) IS DISTINCT FROM (cur.bookable_since IS NOT NULL) THEN
    UPDATE public.sitter_profile AS p
       SET bookable_state = der.bookable_state,
           tier = der.tier,
           tier_rank = der.tier_rank,
           bookable_since = CASE
                              WHEN der.bookable_state <> 'bookable'::public.bookable_state THEN NULL::pg_catalog.timestamptz
                              WHEN cur.bookable_state = 'bookable'::public.bookable_state AND cur.bookable_since IS NOT NULL
                                THEN cur.bookable_since
                              ELSE pg_catalog.now()
                            END
     WHERE p.id = p_sitter_id;
  END IF;

  RETURN der.bookable_state;
END
$fn$;

COMMENT ON FUNCTION public.i1_rederive_sitter(pg_catalog.bpchar) IS
  'I-1 layer 1, the only writer of the derived columns (T-028; T-158 G-3 option (c); T-274). For an id with no visible sitter_profile row returns NULL and writes nothing. Otherwise refuses any transaction isolation but READ COMMITTED (KV083 I1_DERIVATION_ISOLATION), before the row lock; then locks the sitter_profile row, compares it with i1_derived_bookable and, when they differ, writes bookable_state, tier, tier_rank and bookable_since (now() on entry to bookable, kept while bookable, NULL otherwise); never version. Returns the derived state. SECURITY DEFINER, owner app_ddl, search_path pg_catalog, pg_temp, app.i1_derivation on; EXECUTE app_rw and app_admin_rw (the account.status writers). Takes only the id.';

-- ---------------------------------------------------------------------------------------------
-- (iii) The enqueue (owned by the bootstrap superuser, EV-57): the WARNING text and the COMMENT
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.i1_enqueue_slot_materialise(p_sitter_id pg_catalog.bpchar)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_state public.bookable_state;
BEGIN
  SELECT p.bookable_state INTO v_state FROM public.sitter_profile AS p WHERE p.id = p_sitter_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'I1_SLOT_MATERIALISE_NO_SITTER: the id names no sitter_profile row, so no search.slot_materialise job is enqueued'
      USING ERRCODE = 'KV082';
  END IF;

  PERFORM 1 FROM pgboss.queue AS q WHERE q.name = 'search.slot_materialise'::pg_catalog.text;
  IF NOT FOUND THEN
    IF v_state = 'bookable'::public.bookable_state THEN
      RAISE EXCEPTION 'I1_SLOT_MATERIALISE_QUEUE_ABSENT: bookable_state changed to bookable, and the pg-boss queue search.slot_materialise does not exist, so the change cannot be enqueued'
        USING ERRCODE = 'KV081',
              HINT = 'The queue row is created when a worker boots (AvailabilityHandler). Boot a worker against this database, then retry the write.';
    END IF;
    RAISE WARNING 'I1_SLOT_MATERIALISE_SKIPPED: bookable_state changed to a non-bookable state and the pg-boss queue search.slot_materialise does not exist; if this transaction commits, the change has no job'
      USING ERRCODE = '01K81';
    RETURN;
  END IF;

  INSERT INTO pgboss.job (
      id, name, data, priority, start_after, singleton_key, singleton_on, group_id, group_tier,
      expire_seconds, deletion_seconds, keep_until, retry_limit, retry_delay, retry_backoff,
      retry_delay_max, policy, dead_letter, heartbeat_seconds, blocked, blocking,
      pending_dependencies)
  SELECT pg_catalog.gen_random_uuid(),
         q.name,
         pg_catalog.jsonb_build_object('sitterId'::pg_catalog.text, p_sitter_id::pg_catalog.text),
         0,
         pg_catalog.now(),
         NULL::pg_catalog.text,
         NULL::pg_catalog.timestamp,
         NULL::pg_catalog.text,
         NULL::pg_catalog.text,
         q.expire_seconds,
         q.deletion_seconds,
         pg_catalog.now() + (q.retention_seconds::pg_catalog.float8 * '1 second'::pg_catalog.interval),
         q.retry_limit,
         q.retry_delay,
         COALESCE(q.retry_backoff, false),
         q.retry_delay_max,
         q.policy,
         q.dead_letter,
         q.heartbeat_seconds,
         false,
         false,
         0
    FROM pgboss.queue AS q
   WHERE q.name = 'search.slot_materialise'::pg_catalog.text
  ON CONFLICT DO NOTHING;
END
$fn$;

COMMENT ON FUNCTION public.i1_enqueue_slot_materialise(pg_catalog.bpchar) IS
  'Inserts one pgboss.job row on queue search.slot_materialise with data {"sitterId": <id>}, copying the queue''s retry, expiry, retention, policy, dead-letter and heartbeat settings from pgboss.queue as pg-boss 12.26.4''s send does (T-028; E.3 U-12; T-089 contract section 7). Refuses an id with no sitter_profile (KV082). Queue row absent: refuses a change to bookable (KV081); any other new state raises WARNING 01K81 and inserts no job (the write commits only if nothing in its statement or transaction raises KV081; T-274). SECURITY DEFINER, owner the bootstrap superuser (EV-57); EXECUTE app_ddl only. Called by trg_sitter_profile_i1_enqueue.';
