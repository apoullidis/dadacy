-- 0023_staffed_schedule.up.sql
--
-- @phase: expand
--
-- Ticket:  T-206 (tech-lead -> bbp), P-STAFFED of tasks/state/EP-8b/OD-226-cut.md § 3.
-- Request: tasks/state/EP-8b/T-080.md § Migration request (ADR 0001 §1); the requesting code is
--          T-080 (the Europe/Nicosia generator). T-086 (the publisher) writes the rows.
-- Spec:    SD §DB-15 lines 3156-3189 (the DDL), 3058 (idx_staffed_interval_span), 3196-3207 (the
--          containment query it serves); SA §SA-4 I-7 (493-548), §DA-14 1441-1443.
-- Rulings: tasks/state/EP-2/OE-30-34-rulings.md, binding under OE-50 (Part F): A.2 U-1 and U-4;
--          E.2 U-3, U-5, U-7, U-14; B.1 C5 (a) and C6 (a); B.3 OE-31 U-8 (a) and U-15 (a);
--          decisions.md OE-31 IC-1 (as amended) and IC-2; OD-223.
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-231 (the guard after 0014); T-150 (the closed type map) and T-145; T-021 (rework 2)
--          and T-031 (lint); T-136 (runner); T-137 (tripwire); T-140 (account), T-030 (approval).
--
-- WHAT IT CREATES. SD 3156-3189's three tables, verbatim in column order, types, nullability and
-- defaults, schema-qualified (EV-4), with two additions the rulings make:
--   A.2 U-1  staffed_interval.id char(26) PRIMARY KEY, a ULID the generator supplies. SD declares
--            no key for the table; ADR 0001 §1 requires one. The EXCLUDE stays as SD 3180 writes
--            it. EV proposed by T-206.
--   U-15 (a) CONSTRAINT staffed_interval_span_shape: a span is non-empty, has a lower and an upper
--            bound, includes its lower bound and excludes its upper bound ('[)'). SD writes no
--            CHECK. EV proposed by T-206. The CHECK reads the bounds' presence, not their values:
--            a bound of 'infinity' or '-infinity' is a value, so a span ending at 'infinity' passes
--            it (the suite pins that as NOT HELD).
--   E.2 U-3  staffed_schedule_current, verbatim (jurisdiction text PRIMARY KEY; current_version_id
--            char(26) NOT NULL REFERENCES staffed_schedule_version(id), no ON DELETE clause).
-- The EXCLUDE is unnamed, as SD writes it; PostgreSQL names it staffed_interval_version_id_span_excl
-- (measured, T-206). It needs btree_gist for char(26) WITH =, which 0001 installs. Every foreign key
-- is SD's, with no ON DELETE or ON UPDATE clause (NO ACTION). The indexes are SD 3182-3183's:
-- idx_staffed_interval_span, and the unnamed (version_id) index PostgreSQL names
-- staffed_interval_version_id_idx (measured, T-206).
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a numbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- WHAT IT DOES NOT CREATE. No seed row (U-8 (a): the launch schedule is published at runtime). No
-- horizon column (E.2 U-7: a version's horizon end is max(upper(span)) at read time). No extension
-- job and no INSERT path beyond the publisher's (C6 (a)). No CHECK on pattern (E.2 U-14: its shape
-- is T-080's StaffedPatternV1 Zod contract). No trigger: containment, version immutability and the
-- once-only rule on superseded_at (C5 (a)) are T-082's.
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit.
--   staffed_schedule_version: app_rw SELECT; INSERT on (id, jurisdiction, effective_from,
--     published_by, approval_id, pattern, note) only (A.2 U-4); UPDATE (superseded_at) only
--     (C5 (a)).
--   staffed_interval: app_rw SELECT, INSERT (A.2 U-4). No UPDATE.
--   staffed_schedule_current: app_rw SELECT, INSERT, UPDATE (current_version_id) (E.2 U-3).
--   No DELETE and no TRUNCATE to any role. Nothing to app_admin_rw (A.2 U-4, E.2 U-5),
--   app_safety_rw or answering_service. No row-level security (E.2 U-5; OD-223: SD 1309 and 3906
--   do not name these tables).
--
-- WHERE NO RULING SPEAKS (T-206's choices, stated in its Published contract):
--   The version table's INSERT is column-level, the seven columns T-080.md's Q1 writes. So for
--   app_rw published_at always takes DEFAULT now() (the inserting transaction's start) and
--   superseded_at always starts NULL; naming either is refused (42501), even with the DEFAULT
--   keyword. This is 0016-0019's precedent: a time column the database sets for app_rw by grant
--   exclusion, with no trigger, because no CHECK reads it.
--
-- NOT HELD HERE. Until T-082's trigger lands, app_rw can set superseded_at to any value, any number
-- of times, and back to NULL: the column grant is the whole of C5 (a) that this file holds. Nor does
-- the database check: that intervals are added to a version only at publish (app_rw may INSERT an
-- interval into any existing version, at any time); that the pointer names a version of its own
-- jurisdiction, or one that is not superseded; that a version has any interval; that published_by
-- is an operator or that approval_id is a countersigned approval of this publish (T-086's); a span's
-- length, or that its bounds are finite; anything about jurisdiction, note or pattern beyond NOT
-- NULL (a JSON null is a non-NULL jsonb). These are grants and constraints: the grants bind app_rw
-- only, and the owner app_ddl and the superuser can UPDATE or DELETE any row. The constraints bind
-- every writer. PostgreSQL's own refusals print values in their DETAIL (a 23505 or 23P01 prints the
-- key, a CHECK or NOT NULL prints the whole row, pattern and note included) to the writer and, by
-- default, to the server log (OD-241 -> T-230); this file does not change that.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the three tables and their
-- indexes. No -- @run-as marker: every object is new, btree_gist is already installed (0001), and
-- account (0005) and approval (0007) are app_ddl's, so REFERENCES needs nothing further (measured,
-- T-206: up runs without the marker).
--
-- THE SA §INT-10 GUARD. Of this file's statements, CREATE TABLE and GRANT carry tags in
-- trg_int10_answering_service's WHEN TAG IN list; CREATE INDEX and COMMENT do not. This file creates
-- no function, no trigger and no rule.

CREATE TABLE public.staffed_schedule_version (
  id             char(26) PRIMARY KEY,
  jurisdiction   text NOT NULL,
  effective_from date NOT NULL,
  published_at   timestamptz NOT NULL DEFAULT now(),
  published_by   char(26) NOT NULL REFERENCES public.account(id),
  approval_id    char(26) NOT NULL REFERENCES public.approval(id),
  pattern        jsonb NOT NULL,
  note           text NOT NULL,
  superseded_at  timestamptz
);

CREATE TABLE public.staffed_interval (
  id         char(26) PRIMARY KEY,
  version_id char(26) NOT NULL REFERENCES public.staffed_schedule_version(id),
  span       tstzrange NOT NULL,
  EXCLUDE USING gist (version_id WITH =, span WITH &&),
  CONSTRAINT staffed_interval_span_shape CHECK (NOT isempty(span) AND NOT lower_inf(span) AND NOT upper_inf(span) AND lower_inc(span) AND NOT upper_inc(span))
);
CREATE INDEX idx_staffed_interval_span ON public.staffed_interval USING gist (span);
CREATE INDEX ON public.staffed_interval (version_id);

CREATE TABLE public.staffed_schedule_current (
  jurisdiction text PRIMARY KEY,
  current_version_id char(26) NOT NULL REFERENCES public.staffed_schedule_version(id)
);

GRANT SELECT ON public.staffed_schedule_version TO app_rw;
GRANT INSERT (id, jurisdiction, effective_from, published_by, approval_id, pattern, note) ON public.staffed_schedule_version TO app_rw;
GRANT UPDATE (superseded_at) ON public.staffed_schedule_version TO app_rw;
GRANT SELECT, INSERT ON public.staffed_interval TO app_rw;
GRANT SELECT, INSERT ON public.staffed_schedule_current TO app_rw;
GRANT UPDATE (current_version_id) ON public.staffed_schedule_current TO app_rw;

COMMENT ON TABLE public.staffed_schedule_version IS
  'A published Staffed-Hours schedule version (SD §DB-15; SA §SA-4 I-7). app_rw may SELECT, may INSERT only id, jurisdiction, effective_from, published_by, approval_id, pattern and note, so published_at takes now() and superseded_at starts NULL for it, and may UPDATE only superseded_at. The rule that superseded_at is set once, from NULL, is not held by this table. It holds no DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. pattern is the authored pattern, kept for provenance; its shape is not checked here. No other role is granted any privilege, and there is no row-level security.';
COMMENT ON TABLE public.staffed_interval IS
  'The materialised absolute UTC intervals of a staffed schedule version (SD §DB-15; SA §SA-4 I-7). id is a ULID the generator supplies. No two intervals of one version overlap (the exclusion constraint). CHECK staffed_interval_span_shape: a span is non-empty, has both bounds, includes its lower bound and excludes its upper bound; it does not check that a bound is finite. app_rw may SELECT and INSERT, and holds no UPDATE, DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. Nothing here refuses an interval added to an existing version. No other role is granted any privilege, and there is no row-level security.';
COMMENT ON TABLE public.staffed_schedule_current IS
  'The current staffed schedule version of each jurisdiction (SD §DB-15). app_rw may SELECT, INSERT and UPDATE only current_version_id, and holds no DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. The database does not check that the version belongs to this jurisdiction or is not superseded. No other role is granted any privilege, and there is no row-level security.';
