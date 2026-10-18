-- 0032_i1_hardening.down.sql
--
-- @compliance-review: i1_rederive_sitter — T-274, two-approval path (PROTOCOL §3); restored to 0030's body and COMMENT
-- @compliance-review: i1_enqueue_slot_materialise — T-274 (EV-57 unchanged), two-approval path (PROTOCOL §3); restored to 0030's body and COMMENT
-- @compliance-review: i1_derived_bookable — T-274, two-approval path (PROTOCOL §3); called by the restored writer, not changed
-- @compliance-review: trg_sitter_profile_i1_enqueue — T-274, two-approval path (PROTOCOL §3); named only in the COMMENT text, not changed
--
-- Ticket: T-274 (tech-lead). The inverse of the up file: both functions and both COMMENTs are 0030's
-- again, byte for byte (each body and each COMMENT text below is copied from 0030's up file; only
-- CREATE becomes CREATE OR REPLACE, and SECURITY INVOKER becomes SECURITY DEFINER, which 0030 set
-- with ALTER FUNCTION ... SECURITY DEFINER after its REVOKE). Owners and ACLs are not touched: CREATE
-- OR REPLACE keeps both. After this file the writer has no isolation guard (T-028 TL-A is open
-- again) and the WARNING and COMMENT read "commits without a job" again.
--
-- WHO RUNS THIS FILE. The bootstrap superuser, as its up file does (T-136 § contract §6: a down
-- file runs as its up file). Transactional.

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
  'I-1 layer 1, the only writer of the derived columns (T-028; T-158 G-3 option (c)). Locks the sitter_profile row, compares it with i1_derived_bookable and, when they differ, writes bookable_state, tier, tier_rank and bookable_since (now() on entry to bookable, kept while bookable, NULL otherwise); never version. Returns the derived state, NULL for an id with no profile. SECURITY DEFINER, owner app_ddl, search_path pg_catalog, pg_temp, app.i1_derivation on; EXECUTE app_rw and app_admin_rw (the account.status writers). Takes only the id.';

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
    RAISE WARNING 'I1_SLOT_MATERIALISE_SKIPPED: bookable_state changed to a non-bookable state and the pg-boss queue search.slot_materialise does not exist; the change commits without a job'
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
  'Inserts one pgboss.job row on queue search.slot_materialise with data {"sitterId": <id>}, copying the queue''s retry, expiry, retention, policy, dead-letter and heartbeat settings from pgboss.queue as pg-boss 12.26.4''s send does (T-028; E.3 U-12; T-089 contract section 7). Refuses an id with no sitter_profile (KV082). Queue row absent: refuses a change to bookable (KV081); any other new state commits without a job (WARNING 01K81). SECURITY DEFINER, owner the bootstrap superuser (EV-57); EXECUTE app_ddl only. Called by trg_sitter_profile_i1_enqueue.';
