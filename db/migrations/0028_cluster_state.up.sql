-- 0028_cluster_state.up.sql
--
-- @phase: expand
--
-- Ticket:  T-211 (tech-lead -> backend-booking-payments), P-C12 of tasks/state/EP-8b/OD-226-cut.md § 3.
-- Request: the T-211 row of tasks/state/BOARD.md (its brief notes), and OD-226-cut.md § 3 P-C12 and
--          § 5 N-1 (accepted by OE-50); T-160.md § Migration request (finalised) U-2, U-3, U-7 for the
--          state semantics. The requesting code is the discovery module: T-209 (admin route), T-216
--          (density job).
-- Spec:    PM 1634-1643 (a cluster is open only when it satisfies all six density thresholds; below,
--          it is waitlist); SD §DB-10 lines 2964-2965 (state, density_snapshot).
-- Rulings: tasks/state/EP-2/OE-30-34-rulings.md B.1 C12 (b), resolved by precedence (OE-49 (2)): only
--          a density job may set a cluster open or waitlist, admins can only close one; B.3 T-160 U-3
--          (1a) (OE-50): one entry per threshold 1-6 with measured, required and pass, plus
--          computedAt; U-7 (a) (OE-50): closed is retired, and an admin may reopen it to waitlist.
--          decisions.md OE-52 (N-1): the database bound is accepted, with no sixth role and no
--          separate density-job login; OE-53 (the two ops-entered columns, which this file does not
--          read). EV-40: no role outside T-020's five is named or granted here.
-- Contracts: T-161 § Published contract (rework 1) §3-§4 (0027: the table this trigger is on);
--          T-020 § Published contract §3-§5 (roles, the SA §INT-10 guard); T-252 § contract §4 (any
--          app_rw session can set an app.* GUC, so none is read here); T-021 (rework 2), T-031,
--          T-229, T-173, T-253 (lint); T-136 (runner); T-137 (tripwire); T-138 (db/schema.ts).
--
-- WHAT THE DATABASE CAN AND CANNOT HOLD. core (the admin route T-209) and worker (the density job
-- T-216) both connect as app_rw, so the database cannot tell the density job from any other app_rw
-- caller, and OE-52 accepted that with no sixth role. Nor does this file read an app.* GUC to tell
-- them apart: any app_rw session can set one (T-252 § contract §4). What it holds is C12 (b)'s own
-- option text: no cluster becomes or stays open without an all-pass density snapshot, and a cluster
-- becomes open, or leaves open for waitlist, only in a statement that writes a new, well-formed
-- snapshot stamped with the writing transaction's now(). STATED BOUND (OE-52): an app_rw caller that
-- writes a forged all-pass snapshot in one such statement is accepted.
--
-- THE SNAPSHOT KEYS (published for T-216's DensitySnapshotV1; T-211 § Published contract):
--   {
--     "computedAt": "<timestamptz with an explicit offset, equal to the writing transaction's now()>",
--     "thresholds": {
--       "bookableSitters":         {"measured": ..., "required": ..., "pass": <boolean>},  PM 1636
--       "fridayPeakSitters":       {...},                                                  PM 1637
--       "infantQualifiedSitters":  {...},                                                  PM 1638
--       "simulatedSearchMedian":   {...},                                                  PM 1639
--       "russianValidatedSitters": {...},                                                  PM 1640
--       "visitorReadySitters":     {...}                                                   PM 1641
--     }
--   }
-- The database reads computedAt and the six pass values only. measured, required, any further key,
-- and how thresholds 5 and 6 record that they do not apply (OE-53: an unknown is never a pass) are
-- T-216's. A snapshot is WELL FORMED when it is a JSON object whose computedAt is a JSON string of
-- the form YYYY-MM-DD[T ]HH:MI:SS[.fraction] followed by Z or a +/-HH[[:]MI] offset, valid as a
-- timestamptz, and whose thresholds is an object holding all six keys, each an object whose pass is
-- a JSON boolean. A missing entry, or a pass of "true" or 1, is never read as passing. FRESH means
-- computedAt::timestamptz = now(), so the writer stamps it from SQL in the same statement (for
-- example to_jsonb(now())); a value from a client clock with millisecond precision does not equal
-- now() and is refused.
--
-- THE TRANSITION MATRIX (BEFORE INSERT OR UPDATE row trigger trg_cluster_state_transition, function
-- public.cluster_state_transition()). Every refusal is SQLSTATE KV073
-- CLUSTER_STATE_TRANSITION_REFUSED, with a fixed message per rule and no value echoed:
--   INSERT
--     state open                                    REFUSED (a cluster starts waitlist or closed)
--     waitlist or closed, density_snapshot not {}   REFUSED (the empty snapshot on insert)
--     waitlist or closed with {} (the column default included: an INSERT that omits the column
--     stores {})                                    accepted
--   UPDATE, by OLD.state -> NEW.state
--     closed   -> open                              REFUSED (reopen is to waitlist; U-7 (a))
--     waitlist -> open                              only if the statement writes a snapshot that
--                                                   differs from the old one, is well formed, is
--                                                   fresh, and has all six pass = true (RK-8)
--     open     -> open, snapshot changed            only if the new snapshot is well formed and
--                                                   fresh; all six passing is the CHECK's
--     open     -> open, snapshot unchanged          accepted (the CHECK still applies)
--     open     -> waitlist                          only if the statement writes a snapshot that
--                                                   differs from the old one, is well formed, is
--                                                   fresh, and has at least one pass = false
--     any      -> closed                            accepted, whatever snapshot is written
--     closed   -> waitlist                          accepted (admin reopen, U-7 (a))
--     waitlist -> waitlist, closed -> closed        accepted, whatever snapshot is written: gating
--                                                   reads state, and the next move to open needs
--                                                   a new fresh snapshot anyway
-- A NULL state or density_snapshot, and a state outside the three values, are left to the column's
-- NOT NULL (23502) and to cluster_state_check (23514): the trigger returns the row unchanged, and
-- PostgreSQL checks constraints after BEFORE triggers. The trigger never modifies the row.
--
-- THE CHECK cluster_open_requires_passing_snapshot: a row whose state is open holds a snapshot in
-- which all six thresholds have "pass": true (jsonb containment @>, which is never NULL, so a
-- missing entry or a non-boolean pass fails it rather than passing on NULL). It binds every writer,
-- the owner and the superuser included, and it re-checks an open row on every UPDATE, so an open
-- cluster cannot be given a failing snapshot while it stays open. Adding it validates existing rows:
-- if an open row without an all-pass snapshot existed, this file would fail 23514 and roll back (no
-- writer of cluster exists before T-211; T-161 § Published contract (rework 1) §3).
--
-- NOT HELD HERE: a forged all-pass snapshot (above, OE-52); the meaning of measured and required;
-- extra keys in the snapshot or in an entry; any rule on the snapshot of a row that stays waitlist
-- or closed, or that is closed; the two OE-53 columns (the trigger does not read them; T-216 reads
-- them into thresholds 5 and 6); hysteresis and cadence (T-216, OE-53); who may close a cluster
-- (T-209's policy). The owner app_ddl and the superuser can drop or disable the trigger (a
-- migration that switches it off by name is refused by no lint rule today: it is not on
-- gate:migration-lint's PROTECTED list; recommended follow-on, not this change set).
--
-- SECURITY INVOKER: the function runs as the writer and reads nothing but NEW, OLD and now(), so it
-- needs no privilege. Search path pinned to pg_catalog, pg_temp, and every function it calls is
-- schema-qualified. EXECUTE is revoked from PUBLIC; PostgreSQL does not check EXECUTE on a
-- trigger's function when the trigger fires (measured by T-215), and a trigger function cannot be
-- called directly (0A000).
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which owns public.cluster (0027) and schema
-- public, and so owns the function and may create the trigger and the constraint. No -- @run-as
-- marker. Transactional. Of these statements, CREATE FUNCTION and ALTER TABLE fire the SA §INT-10
-- guard's event trigger (T-020 § contract §5); the function is SECURITY INVOKER, so the guard's
-- check on SECURITY DEFINER functions does not apply.

CREATE FUNCTION public.cluster_state_transition() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  keys       constant text[] := ARRAY['bookableSitters', 'fridayPeakSitters', 'infantQualifiedSitters',
                                      'simulatedSearchMedian', 'russianValidatedSitters', 'visitorReadySitters'];
  k          text;
  snap       jsonb;
  computed   text;
  any_failed boolean := false;
BEGIN
  -- NULLs are the NOT NULL constraints' to refuse (23502), after this trigger.
  IF NEW.state IS NULL OR NEW.density_snapshot IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'open' THEN
      RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: a cluster is inserted as waitlist or closed, never open (trg_cluster_state_transition)'
        USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'state',
              HINT = 'C12 (b): insert as waitlist; only a statement writing a fresh all-pass density snapshot moves it to open.';
    END IF;
    IF NEW.density_snapshot <> '{}'::jsonb THEN
      RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: a cluster is inserted with the empty density snapshot (trg_cluster_state_transition)'
        USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'density_snapshot',
              HINT = 'Omit density_snapshot on insert (its default is the empty object); the density job writes it later.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF OLD.state = 'closed' AND NEW.state = 'open' THEN
    RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: a closed cluster reopens to waitlist, never directly to open (trg_cluster_state_transition)'
      USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'state',
            HINT = 'U-7 (a): set state to waitlist; the density job opens it.';
  END IF;

  IF NOT ((OLD.state = 'waitlist' AND NEW.state = 'open')
       OR (OLD.state = 'open' AND NEW.state = 'waitlist')
       OR (OLD.state = 'open' AND NEW.state = 'open'
           AND NEW.density_snapshot IS DISTINCT FROM OLD.density_snapshot)) THEN
    RETURN NEW;
  END IF;

  -- From here: a move into or out of open, or a new snapshot on an open row.
  snap := NEW.density_snapshot;

  IF OLD.state <> NEW.state AND snap = OLD.density_snapshot THEN
    RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: a cluster moves into or out of open only in a statement that writes a new density snapshot (trg_cluster_state_transition)'
      USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'density_snapshot',
            HINT = 'C12 (b): write state and a freshly computed density_snapshot in one statement.';
  END IF;

  computed := snap ->> 'computedAt';
  IF NOT coalesce(pg_catalog.jsonb_typeof(snap) = 'object'
              AND pg_catalog.jsonb_typeof(snap -> 'computedAt') = 'string'
              AND computed ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
              AND pg_catalog.pg_input_is_valid(computed, 'timestamptz')
              AND pg_catalog.jsonb_typeof(snap -> 'thresholds') = 'object', false) THEN
    RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: the density snapshot written with this change is not well formed (trg_cluster_state_transition)'
      USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'density_snapshot',
            HINT = 'A JSON object with computedAt (an ISO 8601 timestamp with an offset) and thresholds holding all six entries, each with a boolean pass.';
  END IF;
  FOREACH k IN ARRAY keys LOOP
    IF pg_catalog.jsonb_typeof(snap -> 'thresholds' -> k -> 'pass') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: the density snapshot written with this change is not well formed (trg_cluster_state_transition)'
        USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'density_snapshot',
              HINT = 'A JSON object with computedAt (an ISO 8601 timestamp with an offset) and thresholds holding all six entries, each with a boolean pass.';
    END IF;
    IF snap -> 'thresholds' -> k -> 'pass' = 'false'::jsonb THEN
      any_failed := true;
    END IF;
  END LOOP;

  IF computed::pg_catalog.timestamptz <> pg_catalog.now() THEN
    RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: the density snapshot written with this change was not computed in the writing transaction (trg_cluster_state_transition)'
      USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'density_snapshot',
            HINT = 'Set computedAt from now() in the writing statement, for example jsonb_set(..., ''{computedAt}'', to_jsonb(now())).';
  END IF;

  IF OLD.state = 'waitlist' AND NEW.state = 'open' AND any_failed THEN
    RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: a cluster becomes open only when all six density thresholds pass (trg_cluster_state_transition)'
      USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'state',
            HINT = 'PM 1634 and RK-8: a threshold is never lowered, softened or partially applied.';
  END IF;

  IF OLD.state = 'open' AND NEW.state = 'waitlist' AND NOT any_failed THEN
    RAISE EXCEPTION 'CLUSTER_STATE_TRANSITION_REFUSED: an open cluster returns to waitlist only when a density threshold fails (trg_cluster_state_transition)'
      USING ERRCODE = 'KV073', SCHEMA = 'public', TABLE = 'cluster', COLUMN = 'state',
            HINT = 'C12 (b): only the density job moves a cluster between open and waitlist; an admin closes it instead.';
  END IF;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.cluster_state_transition() FROM PUBLIC;

COMMENT ON FUNCTION public.cluster_state_transition() IS
  'BEFORE INSERT OR UPDATE row trigger function on cluster (trg_cluster_state_transition; C12 (b)). Refuses with KV073: an INSERT as open; an INSERT with a density_snapshot other than the empty object; closed to open; waitlist to open, open to waitlist, or a new snapshot on an open row, unless the statement writes a well-formed snapshot (computedAt an ISO 8601 timestamp with an offset, equal to now(); thresholds with bookableSitters, fridayPeakSitters, infantQualifiedSitters, simulatedSearchMedian, russianValidatedSitters and visitorReadySitters, each with a boolean pass) that, for a change of state, differs from the old one; waitlist to open unless all six pass; open to waitlist unless one fails. NULLs and unknown states are left to the constraints. SECURITY INVOKER; EXECUTE revoked from PUBLIC.';

CREATE TRIGGER trg_cluster_state_transition
  BEFORE INSERT OR UPDATE ON public.cluster
  FOR EACH ROW
  EXECUTE FUNCTION public.cluster_state_transition();

COMMENT ON TRIGGER trg_cluster_state_transition ON public.cluster IS
  'C12 (b): the cluster state transition matrix (see public.cluster_state_transition()). Any app_rw caller that writes a well-formed, fresh, all-pass snapshot can open a cluster: the database cannot tell the density job from core (OE-52).';

ALTER TABLE public.cluster
  ADD CONSTRAINT cluster_open_requires_passing_snapshot CHECK (
    state <> 'open'
    OR density_snapshot @> '{"thresholds": {"bookableSitters": {"pass": true}, "fridayPeakSitters": {"pass": true}, "infantQualifiedSitters": {"pass": true}, "simulatedSearchMedian": {"pass": true}, "russianValidatedSitters": {"pass": true}, "visitorReadySitters": {"pass": true}}}'::jsonb);

COMMENT ON CONSTRAINT cluster_open_requires_passing_snapshot ON public.cluster IS
  'C12 (b), PM 1634: an open cluster holds a density snapshot in which all six thresholds have pass true.';

COMMENT ON TABLE public.cluster IS
  'Discovery clusters (SD DB-10): operator-drawn WGS 84 polygons with an open, waitlist or closed state. Retired by state closed; no application role holds DELETE. Which state changes are legal is held by trg_cluster_state_transition and cluster_open_requires_passing_snapshot (C12).';

COMMENT ON COLUMN public.cluster.density_snapshot IS
  'Written by the density job: computedAt (equal to the writing transaction''s now()) and thresholds bookableSitters, fridayPeakSitters, infantQualifiedSitters, simulatedSearchMedian, russianValidatedSitters and visitorReadySitters, each with measured, required and a boolean pass. The empty object until first computed.';
