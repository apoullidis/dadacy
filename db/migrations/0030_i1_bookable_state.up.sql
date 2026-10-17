-- 0030_i1_bookable_state.up.sql
--
-- @phase: expand
-- @run-as: bootstrap-superuser — T-028 (public.i1_enqueue_slot_materialise is owned by the bootstrap superuser: it inserts into pgboss.job, which only app_rw and the superuser may write, OD-90/T-146)
--
-- Ticket:  T-028 (tech-lead). SA §SA-4 I-1, layers 1 and 3. Layer 2 (assert_sitter_bookable() on
--          booking, SITTER_NOT_BOOKABLE) is T-091's (OD-351): no booking table exists.
-- Spec:    SA §SA-4 I-1 (407-431); SA 1303 (tier derivation); SD 1447-1449 (sitter bookable state:
--          derived, recomputed by trigger on any sitter_credential change); SD 680; SD 1364
--          (recon.bookable_state: hourly, pages on any divergence); SD 4039 (the same transaction
--          enqueues search.slot_materialise); SD 4242-4247 (RB-2).
-- Rulings: T-157 E-1 (tier_rank 1/2/3), E-2 (erased -> removed, pending never bookable), E-4 (b)
--          as re-ruled by OE-90 (OD-360: the RB-2 hold is account.status = 'suspended'); EV-39 (the
--          derivation reads account.status and re-runs when it changes); C17 (3a) (the reconciler
--          only pages); E.3 U-12 (the enqueue); E.4 U-3 (bookable_since written, version not).
-- Contracts: T-158 § Published contract §5 row T-028 (G-3 option (c); OD-317, OD-318); T-252 §
--          Published contract §2, §5, §6 (FORCE RLS; OD-325; nothing here may name the reference
--          column); T-060 §6 (mandatory_rules grammar v1 in SQL; the reference format is never
--          evaluated in SQL); T-061 §6 (no SQL recomputes an attestation due date: none is read);
--          T-089 §7 (search.slot_materialise, payload {"sitterId": <id>}, the queue's retry policy);
--          T-149 G11 (pg-boss 12.26.4 has no SQL send); T-020 §3-§5 (roles; SA §INT-10 check 8).
--
-- THE DERIVATION (layer 1). public.i1_derived_bookable(id) is a pure read; for the sitter whose
-- sitter_profile.id is the argument it returns (bookable_state, tier, tier_rank):
--   account.status 'suspended'            -> 'suspended'  (E-4 (b) as re-ruled: RB-2's hold)
--   account.status 'removed' or 'erased'  -> 'removed'    (E-2)
--   otherwise, any credential of the sitter in status 'review_hold' -> 'review_hold'
--   otherwise, COMPLETE and account.status 'active'                 -> 'bookable'
--   otherwise                                                       -> 'onboarding' (pending: E-2)
-- COMPLETE: the sitter's jurisdiction (account.jurisdiction) has at least one credential_scheme
-- row, every such row's mandatory_rules is exactly grammar v1 ('{"v": 1, "mandatory": "all_tiers"}',
-- T-060 R-3: v1 means mandatory for every tier), and the sitter holds a credential in status 'valid'
-- for each. A row whose mandatory_rules is any other value is mandatory and UNMET, never optional.
-- A jurisdiction with no scheme is not complete (fail closed).
-- tier: 'sitter' when COMPLETE, else NULL. tier_rank: sitter 1, childcare_professional 2,
-- infant_qualified 3, NULL 0 (E-1). The two higher tiers have no input on main (no qualifying scheme
-- designation, no reference_check table), so the derivation never produces them.
-- Only status columns are read: no date column, no attestation instant, no reference column.
--
-- public.i1_rederive_sitter(id) is THE writer (G-3 (c)): SECURITY DEFINER, owner app_ddl. It locks
-- the sitter_profile row, compares it with i1_derived_bookable(id) and, only when they differ,
-- writes bookable_state, tier, tier_rank and bookable_since in one UPDATE (bookable_since: now() on
-- entry to 'bookable', kept while 'bookable', NULL otherwise). version is not written. It returns
-- the derived state, or NULL when the id has no sitter_profile row.
--
-- WHAT RE-RUNS IT. Three invoker triggers:
--   trg_sitter_credential_i1_rederive   AFTER INSERT OR UPDATE OR DELETE, per row: OLD.sitter_id
--                                        and NEW.sitter_id.
--   trg_sitter_credential_i1_truncate   AFTER TRUNCATE, per statement: every sitter_profile row
--                                        (the owner can TRUNCATE under FORCE, T-252 §4).
--   trg_account_i1_rederive             AFTER UPDATE OF status, jurisdiction, per row, when either
--                                        changed (EV-39).
-- Not re-run by: a credential_scheme write (migrations only, T-251 §3) or a sitter_profile INSERT.
-- Either can leave a stored state that disagrees with the derivation; the reconciler reports it.
--
-- THE ENQUEUE (E.3 U-12). trg_sitter_profile_i1_enqueue, AFTER UPDATE OF bookable_state per row
-- WHEN the value changed, calls public.i1_enqueue_slot_materialise(NEW.id). It sits on
-- sitter_profile, not in the derivation, so EVERY writer of bookable_state enqueues: the definer,
-- and a break-glass app_ddl or superuser UPDATE (RB-2; T-157 F-6 Q13). The function inserts ONE
-- pgboss.job row the way pg-boss 12.26.4's own send does (plans.js insertJobs, every option
-- unset): name 'search.slot_materialise', data {"sitterId": <sitter_profile.id as text>}, priority
-- 0, and the queue's retry_limit, retry_delay, retry_backoff, retry_delay_max, expire_seconds,
-- deletion_seconds, keep_until (now() + retention_seconds), policy, dead_letter and
-- heartbeat_seconds read from pgboss.queue; ON CONFLICT DO NOTHING as pg-boss's. No NOTIFY.
-- IF THE QUEUE ROW IS ABSENT (it exists only once a worker has booted, T-089 §7 T-266 (a)) the
-- function RAISES KV081 and the write that changed bookable_state is refused: nothing is dropped
-- silently. The job is in the writer's transaction: it commits or rolls back with the change.
-- Owner: the bootstrap superuser, because the definer runs as app_ddl and app_ddl holds no
-- privilege in schema pgboss (0006 grants app_rw only); no role gains a privilege or membership
-- for it. EXECUTE: app_ddl only (the only role, with the superuser, that can change bookable_state).
--
-- THE READ PATH (OD-325). Every sitter_credential policy is TO app_rw and the table is FORCEd, so
-- app_ddl, the definer's owner, read 0 rows. Added: sitter_credential_i1_derivation_select,
-- PERMISSIVE, FOR SELECT, TO app_ddl, USING app.i1_derivation = 'on' (read through NULLIF, as
-- 0026's are). i1_rederive_sitter and i1_reconcile_bookable_state pin app.i1_derivation = 'on' in
-- their own SET clause, restored on exit. app_rw cannot reach the policy: it is not TO app_rw, and
-- app_rw is not a member of app_ddl. A break-glass app_ddl session can set the GUC itself and read
-- every row (it could already ALTER TABLE ... NO FORCE, T-252 §4); so can any FUTURE app_ddl-owned
-- SECURITY DEFINER function reading this table, if its caller has set the GUC.
--
-- THE RECONCILER (layer 3). public.i1_reconcile_bookable_state() — SECURITY DEFINER, owner app_ddl,
-- EXECUTE app_rw — computes i1_derived_bookable for EVERY sitter_profile row and compares
-- bookable_state, tier, tier_rank, and (bookable_state = 'bookable') with (bookable_since IS NOT
-- NULL). It writes nothing. Any divergence RAISES SQLSTATE KV080 (I1_BOOKABLE_STATE_DIVERGENCE)
-- naming the count in the message and the sitter ids in DETAIL; clean, it returns the number of
-- rows compared. The schedule and the page are the consumer's (T-273, SD 1364).
--
-- OD-317 / OD-318. Everything that runs as an owner (the two definers, the helper, the three
-- trigger functions fired by their writes and the superuser-owned enqueue) pins
-- SET search_path = pg_catalog, pg_temp, with pg_temp LAST, and schema-qualifies every relation
-- and every type it names, declared or in a :: cast. EXECUTE is revoked from PUBLIC before any
-- function is made SECURITY DEFINER (SA §INT-10 check (8); the 0021 order). These conditions are
-- necessary, not sufficient: the guard is the shadow case in
-- packages/db-testkit/suites/i1-bookable-state.test.ts against this call graph.
--
-- WHO RUNS THIS FILE. The bootstrap superuser (@run-as above), for the one superuser-owned
-- function. Every other function is handed to app_ddl with ALTER FUNCTION ... OWNER TO app_ddl;
-- the triggers and the policy belong to their tables (owner app_ddl). Transactional. The SA §INT-10
-- guard's event trigger fires on CREATE FUNCTION, ALTER FUNCTION and GRANT here.
--
-- sitter_credential's COMMENT ON TABLE said "policies are TO app_rw"; it is restated with the
-- added policy (the down file restores 0026's text).

-- ---------------------------------------------------------------------------------------------
-- The derivation, a pure read (the helper the writer and the reconciler share)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.i1_derived_bookable(
    p_sitter_id pg_catalog.bpchar,
    OUT o_bookable_state public.bookable_state,
    OUT o_tier public.sitter_tier,
    OUT o_tier_rank pg_catalog.int2)
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH acct AS (
    SELECT a.status, a.jurisdiction
      FROM public.account AS a
     WHERE a.id = p_sitter_id
  ),
  scheme AS (
    SELECT cs.id,
           (cs.mandatory_rules = '{"v": 1, "mandatory": "all_tiers"}'::pg_catalog.jsonb) AS v1,
           EXISTS (SELECT 1
                     FROM public.sitter_credential AS sc
                    WHERE sc.sitter_id = p_sitter_id
                      AND sc.scheme_id = cs.id
                      AND sc.status = 'valid'::pg_catalog.text) AS held
      FROM public.credential_scheme AS cs
      JOIN acct ON cs.jurisdiction = acct.jurisdiction
  ),
  facts AS (
    SELECT (SELECT pg_catalog.count(*) FROM scheme) > 0
             AND NOT EXISTS (SELECT 1 FROM scheme WHERE NOT (scheme.v1 AND scheme.held)) AS complete,
           EXISTS (SELECT 1
                     FROM public.sitter_credential AS sc
                    WHERE sc.sitter_id = p_sitter_id
                      AND sc.status = 'review_hold'::pg_catalog.text) AS held_for_review
  ),
  derived AS (
    SELECT CASE
             WHEN acct.status = 'suspended'::public.account_status THEN 'suspended'::public.bookable_state
             WHEN acct.status IN ('removed'::public.account_status, 'erased'::public.account_status)
               THEN 'removed'::public.bookable_state
             WHEN facts.held_for_review THEN 'review_hold'::public.bookable_state
             WHEN facts.complete AND acct.status = 'active'::public.account_status
               THEN 'bookable'::public.bookable_state
             ELSE 'onboarding'::public.bookable_state
           END AS bookable_state,
           CASE WHEN facts.complete THEN 'sitter'::public.sitter_tier END AS tier
      FROM acct, facts
  )
  SELECT derived.bookable_state,
         derived.tier,
         (CASE derived.tier
            WHEN 'sitter'::public.sitter_tier THEN 1
            WHEN 'childcare_professional'::public.sitter_tier THEN 2
            WHEN 'infant_qualified'::public.sitter_tier THEN 3
            ELSE 0
          END)::pg_catalog.int2
    FROM derived
$fn$;

ALTER FUNCTION public.i1_derived_bookable(pg_catalog.bpchar) OWNER TO app_ddl;
REVOKE ALL ON FUNCTION public.i1_derived_bookable(pg_catalog.bpchar) FROM PUBLIC;

COMMENT ON FUNCTION public.i1_derived_bookable(pg_catalog.bpchar) IS
  'I-1 derivation, a pure read (T-028; SA SA-4 I-1; T-157 E-1, E-2, E-4 (b) as re-ruled by OE-90; EV-39). Returns (bookable_state, tier, tier_rank) for one sitter_profile id: account suspended -> suspended; removed or erased -> removed; any credential in review_hold -> review_hold; complete and account active -> bookable; else onboarding. Complete: the account''s jurisdiction has at least one credential_scheme, each with mandatory_rules exactly grammar v1, and the sitter holds a valid credential for each; any other mandatory_rules value is unmet. tier sitter (rank 1) when complete, else NULL (rank 0). Reads sitter_credential only when the caller has app.i1_derivation = on as app_ddl. Owner only.';

-- ---------------------------------------------------------------------------------------------
-- The enqueue (owned by the bootstrap superuser: see the header)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.i1_enqueue_slot_materialise(p_sitter_id pg_catalog.bpchar)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM pgboss.queue AS q WHERE q.name = 'search.slot_materialise'::pg_catalog.text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'I1_SLOT_MATERIALISE_QUEUE_ABSENT: bookable_state changed, and the pg-boss queue search.slot_materialise does not exist, so the change cannot be enqueued'
      USING ERRCODE = 'KV081',
            HINT = 'The queue row is created when a worker boots (AvailabilityHandler). Boot a worker against this database, then retry the write.';
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

REVOKE ALL ON FUNCTION public.i1_enqueue_slot_materialise(pg_catalog.bpchar) FROM PUBLIC;
ALTER FUNCTION public.i1_enqueue_slot_materialise(pg_catalog.bpchar) SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.i1_enqueue_slot_materialise(pg_catalog.bpchar) TO app_ddl;

COMMENT ON FUNCTION public.i1_enqueue_slot_materialise(pg_catalog.bpchar) IS
  'Inserts one pgboss.job row on queue search.slot_materialise with data {"sitterId": <id>}, copying the queue''s retry, expiry, retention, policy, dead-letter and heartbeat settings from pgboss.queue as pg-boss 12.26.4''s send does (T-028; E.3 U-12; T-089 contract section 7). Raises KV081 when the queue row is absent. SECURITY DEFINER, owner the bootstrap superuser; EXECUTE app_ddl only. Called by trg_sitter_profile_i1_enqueue.';

-- ---------------------------------------------------------------------------------------------
-- The writer (G-3 (c)): the one SECURITY DEFINER function that writes the protected four
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.i1_rederive_sitter(p_sitter_id pg_catalog.bpchar)
  RETURNS public.bookable_state
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
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

ALTER FUNCTION public.i1_rederive_sitter(pg_catalog.bpchar) OWNER TO app_ddl;
REVOKE ALL ON FUNCTION public.i1_rederive_sitter(pg_catalog.bpchar) FROM PUBLIC;
ALTER FUNCTION public.i1_rederive_sitter(pg_catalog.bpchar) SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.i1_rederive_sitter(pg_catalog.bpchar) TO app_rw, app_admin_rw;

COMMENT ON FUNCTION public.i1_rederive_sitter(pg_catalog.bpchar) IS
  'I-1 layer 1, the only writer of the derived columns (T-028; T-158 G-3 option (c)). Locks the sitter_profile row, compares it with i1_derived_bookable and, when they differ, writes bookable_state, tier, tier_rank and bookable_since (now() on entry to bookable, kept while bookable, NULL otherwise); never version. Returns the derived state, NULL for an id with no profile. SECURITY DEFINER, owner app_ddl, search_path pg_catalog, pg_temp, app.i1_derivation on; EXECUTE app_rw and app_admin_rw (the account.status writers). Takes only the id.';

-- ---------------------------------------------------------------------------------------------
-- The reconciler (layer 3): compares, writes nothing, raises KV080 on any divergence
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.i1_reconcile_bookable_state()
  RETURNS pg_catalog.int8
  LANGUAGE plpgsql
  STABLE
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
  SET app.i1_derivation = 'on'
AS $fn$
DECLARE
  n_checked  pg_catalog.int8;
  n_diverged pg_catalog.int8;
  diverged   pg_catalog.text;
BEGIN
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (WHERE x.diverges),
         pg_catalog.string_agg(x.id, ','::pg_catalog.text ORDER BY x.id) FILTER (WHERE x.diverges)
    INTO n_checked, n_diverged, diverged
    FROM (SELECT p.id::pg_catalog.text AS id,
                 (d.o_bookable_state IS DISTINCT FROM p.bookable_state
                  OR d.o_tier IS DISTINCT FROM p.tier
                  OR d.o_tier_rank IS DISTINCT FROM p.tier_rank
                  OR (p.bookable_state = 'bookable'::public.bookable_state)
                       IS DISTINCT FROM (p.bookable_since IS NOT NULL)) AS diverges
            FROM public.sitter_profile AS p
            CROSS JOIN LATERAL public.i1_derived_bookable(p.id) AS d) AS x;

  IF n_diverged > 0 THEN
    RAISE EXCEPTION 'I1_BOOKABLE_STATE_DIVERGENCE: % of % sitter_profile rows disagree with the I-1 derivation', n_diverged, n_checked
      USING ERRCODE = 'KV080',
            DETAIL = 'sitter_profile ids: ' || diverged,
            HINT = 'Page (SA SA-4 I-1 layer 3; SD 1364); do not repair from here. SD RB-2: a manual review_hold that the derivation does not produce is itself reported here.';
  END IF;

  RETURN n_checked;
END
$fn$;

ALTER FUNCTION public.i1_reconcile_bookable_state() OWNER TO app_ddl;
REVOKE ALL ON FUNCTION public.i1_reconcile_bookable_state() FROM PUBLIC;
ALTER FUNCTION public.i1_reconcile_bookable_state() SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.i1_reconcile_bookable_state() TO app_rw;

COMMENT ON FUNCTION public.i1_reconcile_bookable_state() IS
  'I-1 layer 3 (T-028; SD 1364 recon.bookable_state; C17 (3a)). For every sitter_profile row compares bookable_state, tier, tier_rank and (bookable_state = bookable) vs (bookable_since IS NOT NULL) with i1_derived_bookable. Writes nothing. Any divergence raises SQLSTATE KV080 I1_BOOKABLE_STATE_DIVERGENCE, the count in the message and the ids in DETAIL; clean, returns the number of rows compared. SECURITY DEFINER, owner app_ddl, app.i1_derivation on; EXECUTE app_rw.';

-- ---------------------------------------------------------------------------------------------
-- The trigger functions (SECURITY INVOKER) and the triggers
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.i1_sitter_credential_rederive()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.i1_rederive_sitter(NEW.sitter_id);
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM public.i1_rederive_sitter(NEW.sitter_id);
    IF OLD.sitter_id IS DISTINCT FROM NEW.sitter_id THEN
      PERFORM public.i1_rederive_sitter(OLD.sitter_id);
    END IF;
  ELSE
    PERFORM public.i1_rederive_sitter(OLD.sitter_id);
  END IF;
  RETURN NULL;
END
$fn$;

CREATE FUNCTION public.i1_sitter_credential_truncate_rederive()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM public.i1_rederive_sitter(p.id) FROM public.sitter_profile AS p;
  RETURN NULL;
END
$fn$;

CREATE FUNCTION public.i1_account_rederive()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM public.i1_rederive_sitter(NEW.id);
  RETURN NULL;
END
$fn$;

CREATE FUNCTION public.i1_sitter_profile_enqueue()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM public.i1_enqueue_slot_materialise(NEW.id);
  RETURN NULL;
END
$fn$;

ALTER FUNCTION public.i1_sitter_credential_rederive() OWNER TO app_ddl;
ALTER FUNCTION public.i1_sitter_credential_truncate_rederive() OWNER TO app_ddl;
ALTER FUNCTION public.i1_account_rederive() OWNER TO app_ddl;
ALTER FUNCTION public.i1_sitter_profile_enqueue() OWNER TO app_ddl;
REVOKE ALL ON FUNCTION public.i1_sitter_credential_rederive() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.i1_sitter_credential_truncate_rederive() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.i1_account_rederive() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.i1_sitter_profile_enqueue() FROM PUBLIC;

CREATE TRIGGER trg_sitter_credential_i1_rederive
  AFTER INSERT OR UPDATE OR DELETE ON public.sitter_credential
  FOR EACH ROW EXECUTE FUNCTION public.i1_sitter_credential_rederive();

CREATE TRIGGER trg_sitter_credential_i1_truncate
  AFTER TRUNCATE ON public.sitter_credential
  FOR EACH STATEMENT EXECUTE FUNCTION public.i1_sitter_credential_truncate_rederive();

CREATE TRIGGER trg_account_i1_rederive
  AFTER UPDATE OF status, jurisdiction ON public.account
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.jurisdiction IS DISTINCT FROM NEW.jurisdiction)
  EXECUTE FUNCTION public.i1_account_rederive();

CREATE TRIGGER trg_sitter_profile_i1_enqueue
  AFTER UPDATE OF bookable_state ON public.sitter_profile
  FOR EACH ROW
  WHEN (OLD.bookable_state IS DISTINCT FROM NEW.bookable_state)
  EXECUTE FUNCTION public.i1_sitter_profile_enqueue();

-- ---------------------------------------------------------------------------------------------
-- The read path (OD-325)
-- ---------------------------------------------------------------------------------------------
CREATE POLICY sitter_credential_i1_derivation_select ON public.sitter_credential
  AS PERMISSIVE
  FOR SELECT TO app_ddl
  USING (NULLIF(pg_catalog.current_setting('app.i1_derivation', true), '') = 'on');

COMMENT ON TABLE public.sitter_credential IS
  'A sitter''s credential per scheme (SD §DB-4, SA §DA-4r). No certificate content, no free text, no notes. reference_number is plain text; its format is credential_scheme.reference_format_regex, applied by the application, never DDL. Row-level security is FORCEd; seven policies are TO app_rw and read app.actor_id, app.actor_role and app.break_glass, an empty value counting as unset. A sitter sees and writes only their own rows, can write only status not_started or submitted, and cannot update a row in review_hold; the system actor sees and writes every row; break-glass reads every row. app_rw holds no DELETE. One SELECT policy is TO app_ddl: it reads every row while app.i1_derivation is on, which the I-1 derivation and reconciler set (0030).';
