-- 0029_availability.up.sql
--
-- @phase: expand
--
-- Ticket:  T-163 (tech-lead -> bbp).
-- Request: tasks/state/EP-9/T-089.md § Migration request (ADR 0001 §1); the requesting code is T-089
--          (the slot materialiser and the availability endpoints). T-162 and T-216 read the tables.
-- Spec:    SD §DB-5 lines 2235-2268 (the DDL and the materialisation rules); SA §DA-3 1206-1239.
-- Rulings: tasks/state/EP-8b/OD-226-cut.md § 4 row T-163 (the binding brief addendum, OE-50), which
--          names tasks/state/EP-2/OE-30-34-rulings.md E.3 U-1, U-2 and U-23, and from Part F (OE-50):
--          OE-32 U-5 (1a), (2) and (3a), U-6 (a), U-15 (a), U-21 (a), U-22, C7 (a) and C9 (b);
--          decisions.md EV-28 and OE-77 (the span shape this file copies), OE-31 IC-1 (as amended)
--          and IC-2.
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard); T-231
--          (the guard after 0014); T-150 (the closed type map); T-206 (the tstzrange type-map entry,
--          consumed here, not added); T-021 (rework 2) and T-031 (lint); T-136 (runner); T-137
--          (tripwire); T-158 (sitter_profile, 0025).
--
-- WHAT IT CREATES. SD 2238-2265's three tables, verbatim in column order, types, nullability,
-- defaults, constraints and indexes, schema-qualified (EV-4), with these additions the rulings make:
--   E.3 U-1   availability_slot.id char(26) PRIMARY KEY, a ULID the materialiser supplies per row.
--             SD declares no key for the table; ADR 0001 §1 requires one. Ids are not stable across
--             regenerations. EV proposed by T-163.
--   U-15 (a)  CONSTRAINT availability_slot_span_shape: the same span shape as staffed_interval's
--             (EV-28, OE-77 included): a span is non-empty, has a lower and an upper bound, both
--             finite, includes its lower bound and excludes its upper bound ('[)'). SD writes no
--             CHECK. It does not bound a span's length. EV proposed by T-163.
--   U-5 (2)   CONSTRAINT availability_exception_times_paired: start_local and end_local are both
--             NULL or both set, and when set end_local > start_local. SD 2251 writes no CHECK.
--             Written as the ruling words it; with both times NULL the comparison is NULL, and a
--             CHECK that evaluates to NULL passes. EV proposed by T-163.
--   U-5 (1a)  CONSTRAINT availability_exception_whole_day_remove_only: NULL times mean the whole
--             local day and are allowed only for REMOVE, so an ADD row carries both times. The ruling
--             states the rule; holding it here rather than in the materialiser alone is T-163's
--             choice (PROTOCOL §9 item 1), stated for review. Same EV as U-5 (2).
--   E.3 U-23  availability_template_sitter_id_idx on availability_template (sitter_id). EV proposed
--             by T-163 (minor).
-- SD's unnamed constraints and index keep PostgreSQL's generated names (measured, T-163):
-- availability_template_weekday_check, availability_template_check (end_local > start_local),
-- availability_exception_kind_check, availability_slot_sitter_id_span_excl, and the index
-- availability_exception_sitter_id_on_date_idx. The EXCLUDE needs btree_gist for char(26) WITH =,
-- which 0001 installs. Every foreign key is SD's: REFERENCES sitter_profile(id) ON DELETE CASCADE.
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a numbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- WHAT THE RULINGS LEAVE AS SD WRITES IT (no DDL):
--   C7 (a)    a block crossing local midnight is two rows, e.g. Friday 19:00-24:00 and Saturday
--             00:00-01:00. time accepts '24:00:00', and SD 2245's CHECK (end_local > start_local)
--             accepts 19:00-24:00 (measured, T-163). The materialiser merges them (E.3 U-14).
--   C9 (b)    weekday 0 = Monday ... 6 = Sunday; SD 2240's CHECK (weekday BETWEEN 0 AND 6) verbatim.
--   U-5 (3a)  an "available now" window past local midnight is two exception rows.
--   U-22      reason is a sitter-private note; its 200-character bound is the API contract's, not a
--             CHECK here, and it has no locale sibling.
--   U-3       overlapping template blocks are allowed (no UNIQUE or EXCLUDE on the template).
--   U-9 (a)   an empty cluster_ids array is legal; no CHECK on the array.
--   E.3 U-2   a voided template row carries effective_to = effective_from - 1 day, so there is no
--             CHECK relating effective_to to effective_from (SD writes none).
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit.
--   availability_template:  app_rw SELECT, INSERT, UPDATE (effective_to, version) (E.3 U-2).
--   availability_exception: app_rw SELECT, INSERT (U-6 (a): insert-only; a mistake is corrected by
--                           an opposite exception).
--   availability_slot:      app_rw SELECT, INSERT, DELETE; no UPDATE (T-089.md § Grants: the
--                           materialiser deletes a sitter's slots and re-inserts them, SD 2268).
--   No DELETE on the template or the exception table, and no TRUNCATE on any, to any role. Nothing to
--   app_admin_rw (U-21 (a)), app_safety_rw or answering_service. No row-level security (U-21 (a)).
--
-- WHERE NO RULING SPEAKS (T-163's choices, stated in its Published contract): the INSERT grants are
-- table-level, as T-089.md § Grants requests, so app_rw may write id, created_at, generated_at and
-- version on insert (no CHECK reads them); and the template's version column carries no CHECK.
--
-- NOT HELD HERE. The database does not check: that a slot conflicts with no confirmed booking (C8
-- (a): the materialiser and search's NOT EXISTS hold it); that a sitter is bookable (E.3 U-12 is the
-- materialiser's); that slots lie inside the 8-week horizon or match the templates and exceptions;
-- that adjacent slots are merged (E.3 U-14 is the materialiser's; the EXCLUDE refuses overlap, not
-- contact); tz is a real zone; the content of reason or cluster_ids (NULL elements, duplicates,
-- unknown cluster ids: an array has no foreign key); that effective_to only ever moves earlier or
-- that version only increases. These are grants and constraints: the grants bind app_rw only, and
-- the owner app_ddl and the superuser can UPDATE or DELETE any row. The constraints bind every
-- writer. PostgreSQL's own refusals print values in their DETAIL (a 23505 or 23P01 prints the key, a
-- CHECK or NOT NULL prints the whole row, reason included) to the writer and, by default, to the
-- server log (OD-241 -> T-230); this file does not change that.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the three tables and their
-- indexes. No -- @run-as marker: every object is new, btree_gist is already installed (0001), and
-- sitter_profile (0025) is app_ddl's, so REFERENCES needs nothing further (measured, T-163: up runs
-- without the marker).
--
-- THE SA §INT-10 GUARD. Of this file's statements, CREATE TABLE and GRANT carry tags in
-- trg_int10_answering_service's WHEN TAG IN list; CREATE INDEX and COMMENT do not. This file creates
-- no function, no trigger and no rule.

CREATE TABLE public.availability_template (
  id char(26) PRIMARY KEY, sitter_id char(26) NOT NULL REFERENCES public.sitter_profile(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local time NOT NULL, end_local time NOT NULL,
  tz text NOT NULL DEFAULT 'Europe/Nicosia',
  effective_from date NOT NULL, effective_to date,
  version int NOT NULL DEFAULT 1,
  CHECK (end_local > start_local)
);
CREATE INDEX availability_template_sitter_id_idx ON public.availability_template (sitter_id);

CREATE TABLE public.availability_exception (
  id char(26) PRIMARY KEY, sitter_id char(26) NOT NULL REFERENCES public.sitter_profile(id) ON DELETE CASCADE,
  on_date date NOT NULL, kind text NOT NULL CHECK (kind IN ('ADD','REMOVE')),
  start_local time, end_local time, tz text NOT NULL DEFAULT 'Europe/Nicosia',
  reason text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exception_times_paired
    CHECK ((start_local IS NULL) = (end_local IS NULL) AND end_local > start_local),
  CONSTRAINT availability_exception_whole_day_remove_only
    CHECK (start_local IS NOT NULL OR kind = 'REMOVE')
);
CREATE INDEX ON public.availability_exception (sitter_id, on_date);

CREATE TABLE public.availability_slot (
  id char(26) PRIMARY KEY,
  sitter_id char(26) NOT NULL REFERENCES public.sitter_profile(id) ON DELETE CASCADE,
  span tstzrange NOT NULL,
  cluster_ids int[] NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (sitter_id WITH =, span WITH &&),
  CONSTRAINT availability_slot_span_shape CHECK (NOT isempty(span) AND NOT lower_inf(span) AND NOT upper_inf(span) AND lower_inc(span) AND NOT upper_inc(span) AND isfinite(lower(span)) AND isfinite(upper(span)))
);
CREATE INDEX idx_slot_span    ON public.availability_slot USING gist (span);
CREATE INDEX idx_slot_cluster ON public.availability_slot USING gin  (cluster_ids);
CREATE INDEX idx_slot_sitter  ON public.availability_slot (sitter_id);

GRANT SELECT, INSERT ON public.availability_template TO app_rw;
GRANT UPDATE (effective_to, version) ON public.availability_template TO app_rw;
GRANT SELECT, INSERT ON public.availability_exception TO app_rw;
GRANT SELECT, INSERT, DELETE ON public.availability_slot TO app_rw;

COMMENT ON TABLE public.availability_template IS
  'A sitter''s weekly availability blocks (SD §DB-5; SA §DA-3). weekday is 0 = Monday ... 6 = Sunday. start_local and end_local are local times in tz; a block crossing local midnight is stored as two rows, the first ending at 24:00. Replacing a template retires rows by effective_to and never deletes them. app_rw may SELECT and INSERT, may UPDATE only effective_to and version, and holds no DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. Overlapping blocks are not refused. No other role is granted any privilege, and there is no row-level security.';
COMMENT ON TABLE public.availability_exception IS
  'One-day additions to and removals from a sitter''s availability (SD §DB-5; SA §DA-3). Both times NULL means the whole local day and is allowed only for REMOVE; otherwise both are set and end_local > start_local. A window past local midnight is two rows. reason is a private note of the sitter''s. app_rw may SELECT and INSERT, and holds no UPDATE, DELETE or TRUNCATE: a mistaken exception is countered by an opposite one. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. No other role is granted any privilege, and there is no row-level security.';
COMMENT ON TABLE public.availability_slot IS
  'Materialised availability, what search queries (SD §DB-5, §DB-12; SA §DA-3). id is a ULID the materialiser supplies; ids are not stable across regenerations. No two slots of one sitter overlap (the exclusion constraint); touching slots are not refused. CHECK availability_slot_span_shape: a span is non-empty, has both bounds, both finite, includes its lower bound and excludes its upper bound; it does not bound the length of a span. app_rw may SELECT, INSERT and DELETE, and holds no UPDATE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. Nothing here refuses a slot that conflicts with a booking. No other role is granted any privilege, and there is no row-level security.';
