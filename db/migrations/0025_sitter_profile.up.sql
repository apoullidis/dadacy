-- 0025_sitter_profile.up.sql
--
-- @phase: expand
--
-- Ticket:  T-158 (tech-lead -> backend-credential-trust), the migration for T-157's request.
-- Request: tasks/state/EP-5/T-157.md § Migration request, as finalised by § Finalisation 2026-10-10
--          (F-0...F-11) and accepted (§ Orchestrator acceptance, 2026-10-10T11:27:09Z). The module
--          is `profile` (SD 925, SA 325), owned by backend-credential-trust (OE-33 G-1).
-- Spec:    SD §DB-4 lines 2002-2035 (the two enums, the table, the partial GiST index); SD 3049
--          (§DB-12 index row); SA §SA-4 I-1 (407-431): this file creates the column I-1 derives,
--          not I-1's three layers (T-028).
-- Rulings: stakeholder 2026-10-10T11:26:56Z (decisions.md § Escalations, on T-157's finalisation);
--          the EVs below; OE-33 G-3 (the derived-column guard is this ticket's choice, between
--          options (a) and (c)); EV-4 (tables in public); OD-107/T-153 (bigint money columns);
--          OE-33 G-6/T-159 (geography(Point,4326) admitted by db:introspect).
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-021 (rework 2) and T-031 (lint); T-136 (runner); T-137 (tripwire); T-138, T-150,
--          T-153, T-159 (schema.ts).
--
-- WHAT IT CREATES. SD 2002-2035 verbatim, schema-qualified (EV-4): the enums bookable_state (five
-- values, SD's order; C16) and sitter_tier; sitter_profile's 25 columns in SD's order, types,
-- nullability and defaults; the PK on id, which REFERENCES account(id) with no ON DELETE clause
-- (NO ACTION; an account is tombstoned, never deleted); the two authored-locale FKs to
-- locale_registry(code), NO ACTION; and idx_sitter_base_location, the partial GiST index.
-- Departures, each an accepted EV in decisions.md:
--   EV-35  four non-negative CHECKs on the travel buffers and the two daily limits (OE-32 U-20).
--   EV-36  two text/locale pairing CHECKs (bio, headline) and two non-negative money CHECKs
--          (take_home_hourly_minor, per_additional_child_minor) (E.4 U-6).
--   EV-37  bookable_since is derived and protected with the three SD marks DERIVED: see GRANTS.
--   EV-38  the §DB-14 row SD lacks, recorded in COMMENT ON TABLE (the EV-10 precedent).
-- Not created: idx_sitter_tier (SD 3050; E.4 U-7 (b): the search ticket's migration creates it),
-- row-level security (U-9 (a); not on SD 1309/3906's list, OD-223), any trigger or function.
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a renumbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- GRANTS (F-3 § Grants (final)). No default privileges exist (T-020 § contract §4).
--   app_rw             SELECT on the table. INSERT (id) only: the profile is created in the
--                      registration transaction with every other column at its default (U-1 (a)).
--                      UPDATE on exactly 18 columns: the stage (f) columns (U-5 (1a)), the
--                      availability settings (SD 1105), the rates (SD 1053) and version (SD 954).
--                      NO UPDATE on id, created_at, currency (no ruled or SD writer) or the
--                      protected four: bookable_state, tier, tier_rank, bookable_since (E.4 U-3).
--                      No DELETE (U-10 (a)), no TRUNCATE, REFERENCES or TRIGGER.
--   app_admin_rw       nothing (U-9 (a)): admin reaches the table through core as app_rw.
--   app_safety_rw      nothing (SD 1008; T-020 § contract §3).
--   answering_service  nothing (SA §INT-10).
--
-- G-3 (OE-33; narrowed by E.4 U-3 and C17 (a)): HOW app_rw IS REFUSED THE DERIVED COLUMNS WHILE
-- THE I-1 DERIVATION STILL WRITES THEM. Chosen: OPTION (c). Recorded in T-158.md § G-3.
--   This file's half, the same under (a) and (c): the column grants above. Any app_rw statement
--   naming a protected column in an INSERT or UPDATE is refused 42501 at parse/plan time, whatever
--   the code path.
--   T-028's half under (c): ONE SECURITY DEFINER function, owned by a role holding UPDATE on the
--   protected four, with search_path pinned and EXECUTE revoked from PUBLIC (SA §INT-10 check 8),
--   that DERIVES the values from its inputs and writes them; the triggers on sitter_credential and
--   on account (EV-39: the derivation re-runs on an account status change) are SECURITY INVOKER and
--   call it. The reconciler recomputes with the same derivation. app_rw calling the function can
--   cause a recompute only, never choose a value.
--   Not refused by this file: the owner app_ddl (break-glass RB-2, C17 (2a)) and the superuser.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns both types, the table and its
-- indexes. account is app_ddl-owned (0005) and locale_registry was created by an app_ddl run
-- (0004), so the REFERENCES need nothing more; postgis is installed by 0001. No CREATE EXTENSION,
-- no superuser-owned object replaced: no -- @run-as marker. Transactional. Of this file's
-- statements, CREATE TABLE and the three GRANTs (column grants included, check (6) since 0014)
-- fire the SA §INT-10 guard's event trigger (T-020 § contract §5).

CREATE TYPE public.bookable_state AS ENUM ('onboarding','bookable','review_hold','suspended','removed');
CREATE TYPE public.sitter_tier    AS ENUM ('sitter','childcare_professional','infant_qualified');

CREATE TABLE public.sitter_profile (
  id char(26) PRIMARY KEY REFERENCES public.account(id),
  bookable_state public.bookable_state NOT NULL DEFAULT 'onboarding',   -- DERIVED. Never set by app code.
  tier public.sitter_tier, tier_rank smallint NOT NULL DEFAULT 0,       -- DERIVED
  bio text, headline text,
  bio_authored_locale text REFERENCES public.locale_registry(code),      -- PM §MVP-L2 AC1: the language
  headline_authored_locale text REFERENCES public.locale_registry(code), -- the text was WRITTEN in
  base_location geography(Point,4326),          -- COARSE: municipality/locality centroid, or a
                                                -- jittered point in the community boundary. NOT the
                                                -- home address, NOT a postal-code centroid (SD 2017).
  travel_radius_m int NOT NULL DEFAULT 5000,
  transport_mode text NOT NULL DEFAULT 'public_transport',
  travel_buffer_before interval NOT NULL DEFAULT '30 minutes',
  travel_buffer_after  interval NOT NULL DEFAULT '30 minutes',
  max_bookings_per_day smallint, max_consecutive_hours smallint,
  take_home_hourly_minor bigint, currency char(3) NOT NULL DEFAULT 'EUR',
  weekend_uplift_pct numeric(4,1), after_22_uplift_pct numeric(4,1),
  per_additional_child_minor bigint,
  profile_photo_key text, profile_photo_source_verification_id char(26),  -- INT-2
  version int NOT NULL DEFAULT 1,
  bookable_since timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sitter_profile_travel_buffer_before_nonneg
    CHECK (travel_buffer_before >= interval '0'),
  CONSTRAINT sitter_profile_travel_buffer_after_nonneg
    CHECK (travel_buffer_after >= interval '0'),
  CONSTRAINT sitter_profile_max_bookings_per_day_nonneg
    CHECK (max_bookings_per_day IS NULL OR max_bookings_per_day >= 0),
  CONSTRAINT sitter_profile_max_consecutive_hours_nonneg
    CHECK (max_consecutive_hours IS NULL OR max_consecutive_hours >= 0),
  CONSTRAINT sitter_profile_bio_locale_paired
    CHECK ((bio IS NULL) = (bio_authored_locale IS NULL)),
  CONSTRAINT sitter_profile_headline_locale_paired
    CHECK ((headline IS NULL) = (headline_authored_locale IS NULL)),
  CONSTRAINT sitter_profile_take_home_nonneg
    CHECK (take_home_hourly_minor IS NULL OR take_home_hourly_minor >= 0),
  CONSTRAINT sitter_profile_per_child_nonneg
    CHECK (per_additional_child_minor IS NULL OR per_additional_child_minor >= 0)
);
CREATE INDEX idx_sitter_base_location ON public.sitter_profile USING gist (base_location)
  WHERE bookable_state = 'bookable';

COMMENT ON TABLE public.sitter_profile IS
  'Sitter profile (SD §DB-4 lines 2005-2035; SA §SA-4 I-1). id is the sitter''s account id. bookable_state, tier, tier_rank and bookable_since are DERIVED: app_rw holds no UPDATE on them; the I-1 derivation and break-glass app_ddl write them. app_rw may INSERT only id, may UPDATE every other column except id, currency and created_at, and holds no DELETE. Retention (§DB-14 row added by stakeholder ruling 2026-10-10): on erasure the row is kept and every nullable non-derived column is set to NULL (bio, headline, bio_authored_locale, headline_authored_locale, base_location, max_bookings_per_day, max_consecutive_hours, take_home_hourly_minor, weekend_uplift_pct, after_22_uplift_pct, per_additional_child_minor, profile_photo_key, profile_photo_source_verification_id); no role holds DELETE.';

GRANT SELECT ON public.sitter_profile TO app_rw;
GRANT INSERT (id) ON public.sitter_profile TO app_rw;
GRANT UPDATE (bio, headline, bio_authored_locale, headline_authored_locale, base_location,
              travel_radius_m, transport_mode, profile_photo_key, profile_photo_source_verification_id,
              travel_buffer_before, travel_buffer_after, max_bookings_per_day, max_consecutive_hours,
              take_home_hourly_minor, weekend_uplift_pct, after_22_uplift_pct,
              per_additional_child_minor, version)
  ON public.sitter_profile TO app_rw;
