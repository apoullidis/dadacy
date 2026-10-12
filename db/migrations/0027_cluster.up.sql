-- 0027_cluster.up.sql
--
-- @phase: expand
--
-- Ticket:  T-161 (tech-lead -> backend-booking-payments), the migration for T-160's request.
-- Request: tasks/state/EP-9/T-160.md § Migration request › Requested DDL (finalised) [F], and
--          § Finalisation 2026-10-12T18:56:16Z (ADR 0001 §1). The requesting code is the discovery
--          module: T-209 (admin route), T-210 (reassign job), T-211 (C12), T-216 (density job).
-- Spec:    SD §DB-10 lines 2961-2967 (the DDL); SD 3054 (idx_cluster_boundary, point-in-polygon
--          cluster assignment); SD 3089 (a user-facing text column has an _i18n sibling); PM
--          1640-1641 (density thresholds 5 and 6).
-- Rulings: tasks/state/EP-2/OE-30-34-rulings.md E.4 (OE-49) T-160 U-1, U-4, U-10, U-11, U-12; Part
--          F (OE-50): C14 (a), C15 (b), T-160 U-3, U-7 (a), U-9, G-5; OE-52 (C12 is T-211's); OE-53
--          (the two ops-entered columns); OD-223 (no RLS off SD's list); EV-4 (tables in public);
--          EV-40 (nothing here names or grants to the dsl or deputy_dsl roles).
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-021 (rework 2), T-031, T-229, T-173, T-253 (lint); T-136 (runner); T-137 (tripwire);
--          T-138 / T-159 (db/schema.ts; geography(Polygon,4326) admitted per column).
--
-- WHAT IT CREATES. SD 2961-2967's cluster, schema-qualified (EV-4): SD's six columns first, in SD's
-- order, types and nullability; then the three columns the rulings add; one GiST index. Departures
-- from SD, each an EV proposed in tasks/state/EP-9/T-161.md (numbers are the orchestrator's to
-- confirm):
--   EV-44 (E.4 T-160 U-1)  id integer GENERATED ALWAYS AS IDENTITY, not serial. It stays integer for
--                          the int[] consumers (SD 1909, 2259); never bigint (OD-107).
--   EV-45 (C14 (a))        name_i18n jsonb NOT NULL with no default, and CHECK
--                          cluster_name_i18n_three_locales: a JSON object holding en, el and ru, each
--                          a string not empty after trimming spaces (U+0020 only). name stays as the
--                          operator's label.
--   EV-46 (OE-53)          russian_speaking_share_pct integer (CHECK 0-100) and
--                          has_hotel_or_holiday_let_inventory boolean, both nullable: NULL = unknown,
--                          which the density job never reads as a pass.
-- The state CHECK is named cluster_state_check explicitly (the name PostgreSQL would generate), and
-- the index takes SD 3054's name idx_cluster_boundary (E.4 U-11). Neither changes SD's meaning.
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a renumbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- WHY THE name_i18n CHECK TESTS KEYS WITH ?& FIRST. name_i18n -> 'ru' is SQL NULL when the key is
-- missing, so jsonb_typeof(...) = 'string' is NULL, and a CHECK passes on NULL. Without the ?&
-- conjunct a name with no ru would be accepted. Extra keys are admitted, and keys are not checked
-- against locale_registry (the 0024 bound). btrim strips U+0020 only.
--
-- GRANTS (E.4 T-160 U-4, U-10). No default privileges exist (T-020 § contract §4).
--   app_rw             SELECT and INSERT at table level; UPDATE on every column but id (E.4 U-4's
--                      UPDATE, narrowed by a column list; T-161 rework 1, QA Q-1). core (search,
--                      gating, the admin route T-209) and worker (T-210, T-216) both connect as
--                      app_rw. No DELETE, and no UPDATE of id: a cluster is retired by
--                      state = 'closed', and app_rw can neither delete nor renumber one, so no
--                      int[] id (address.cluster_ids, availability_slot.cluster_ids) dangles that
--                      way through app_rw (E.4 U-10). The owner and the superuser are not bound.
--                      INSERT of an id is refused by the identity (428C9) unless OVERRIDING SYSTEM
--                      VALUE is used (see NOT HELD). UPDATE of id to a value is refused by the
--                      identity (428C9; measured: the rewriter runs before the privilege check);
--                      UPDATE of id to DEFAULT, which the identity admits, is refused by the column
--                      grant (42501).
--   app_admin_rw       nothing. The admin BFF calls core (SD 1237).
--   app_safety_rw      nothing (T-020 § contract §3).
--   answering_service  nothing (SA §INT-10).
-- No grant on the identity sequence to any role: an identity insert needs none (the 0018 precedent).
-- No row-level security: cluster is not on SD 1309/3906's list and app_admin_rw holds nothing
-- (OD-223).
--
-- NOT HELD HERE (each pinned as accepted in suites/cluster.test.ts):
--   * which state transitions are legal, and that open needs an all-pass density snapshot: T-211
--     (C12 (b), OE-52). Until T-211 merges, app_rw can write state = 'open' unguarded;
--   * the shape of density_snapshot: T-211 publishes its keys, T-216 writes it;
--   * metro holding the market code CY only: T-209's body schema (C15 (b), no DDL change);
--   * a valid (not self-intersecting) boundary: T-209 refuses one in code (U-9 (1b));
--   * clusters not overlapping (U-9 (2a), overlap is legal) and lying inside the service area
--     (U-9 (3), deferred to the service-area ticket);
--   * uniqueness of name (E.4 U-12). No seed (G-5): operators draw clusters through T-209.
-- Any role holding INSERT on the table, app_rw included, can supply an id with OVERRIDING SYSTEM
-- VALUE, as can the owner app_ddl and the superuser. An id ahead of the sequence makes a later
-- ordinary insert fail 23505. No grant closes this while drizzle lists id in every insert; every
-- writer omits id (T-161 rework 1, QA Q-2). The owner and the superuser are not bound by the grants.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table, its identity
-- sequence and its index. postgis is installed by 0001, so geography exists; no CREATE EXTENSION and
-- no superuser-owned object replaced: no marker. Transactional. Of this file's statements, CREATE
-- TABLE and GRANT fire the SA §INT-10 guard's event trigger (T-020 § contract §5).

CREATE TABLE public.cluster (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metro text NOT NULL,                              -- the market code 'CY' (C15 (b)); not held here
  name text NOT NULL,                               -- the operator's label; display is name_i18n
  boundary geography(Polygon,4326) NOT NULL,        -- operator-drawn (G-5); validity checked in code
  state text NOT NULL CONSTRAINT cluster_state_check
        CHECK (state IN ('waitlist','open','closed')),  -- transitions: T-211 (C12)
  density_snapshot jsonb NOT NULL DEFAULT '{}',     -- shape and writer: T-211 / T-216
  name_i18n jsonb NOT NULL,                         -- no default: every insert states three names
  russian_speaking_share_pct integer,               -- NULL = unknown, never a pass
  has_hotel_or_holiday_let_inventory boolean,       -- NULL = unknown, never a pass
  CONSTRAINT cluster_name_i18n_three_locales CHECK (
        jsonb_typeof(name_i18n) = 'object'
    AND name_i18n ?& ARRAY['en','el','ru']
    AND jsonb_typeof(name_i18n -> 'en') = 'string' AND btrim(name_i18n ->> 'en') <> ''
    AND jsonb_typeof(name_i18n -> 'el') = 'string' AND btrim(name_i18n ->> 'el') <> ''
    AND jsonb_typeof(name_i18n -> 'ru') = 'string' AND btrim(name_i18n ->> 'ru') <> ''),
  CONSTRAINT cluster_russian_speaking_share_pct_range
    CHECK (russian_speaking_share_pct BETWEEN 0 AND 100)
);

CREATE INDEX idx_cluster_boundary ON public.cluster USING gist (boundary);

COMMENT ON TABLE public.cluster IS
  'Discovery clusters (SD DB-10): operator-drawn WGS 84 polygons with an open, waitlist or closed state. Retired by state closed; no application role holds DELETE. Which state changes are legal, and the density snapshot shape, are held elsewhere (C12), not by this table.';
COMMENT ON COLUMN public.cluster.name_i18n IS
  'The display name in en, el and ru, each a string that is not empty after trimming spaces (U+0020). name is the operator label and is never shown to users.';
COMMENT ON COLUMN public.cluster.russian_speaking_share_pct IS
  'Ops-entered estimate of the Russian-speaking share, whole percent 0 to 100. NULL means unknown and is never a pass.';
COMMENT ON COLUMN public.cluster.has_hotel_or_holiday_let_inventory IS
  'Ops-entered: the cluster contains hotel or holiday-let inventory. NULL means unknown and is never a pass.';

GRANT SELECT, INSERT ON public.cluster TO app_rw;
GRANT UPDATE (metro, name, boundary, state, density_snapshot, name_i18n, russian_speaking_share_pct,
               has_hotel_or_holiday_let_inventory) ON public.cluster TO app_rw;
