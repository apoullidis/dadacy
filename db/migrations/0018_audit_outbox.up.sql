-- 0018_audit_outbox.up.sql
--
-- @phase: expand
--
-- Ticket:  T-212 (tech-lead -> bct), P-AUDIT-OUTBOX of tasks/state/EP-8b/OD-226-cut.md § 3.
-- Request: tasks/state/EP-3/T-067.md § Migration request, MR-1 (ADR 0001 §1); the requesting code
--          is T-067 (the outbox writer, the relay and the audit log).
-- Spec:    SD §DB-10 lines 2850-2854 (the DDL); SD 3908 (@AuditAccess writes audit_outbox in the
--          same transaction as the read); SD 935 (core writes the outbox, worker relays); SA §SEC-8
--          line 2260 (the transactional outbox: the action and the obligation to log it commit
--          together).
-- Rulings: OE-34 Part C of tasks/state/EP-2/OE-30-34-rulings.md, accepted by OE-50 (Part F):
--          U-1 (b), U-7 (1a)/(2a)/(3b), U-8 (2a), U-9 (a), U-10 (1)/(3); D-11 (OD-143).
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-231 (the guard after 0014); T-153 (int8 renders as a JS bigint); T-021 (rework 2) and
--          T-031 (lint); T-136 (runner); T-137 (tripwire).
--
-- WHAT IT CREATES. public.audit_outbox with SD 2851-2852's four columns in SD's order, SD's
-- nullability and defaults, and SD 2854's partial index; then what the rulings change:
--   U-1   id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, not SD's bigserial. An INSERT
--         naming an id is refused (428C9) for every writer, app_rw included; only OVERRIDING
--         SYSTEM VALUE supplies one, and that needs INSERT on id, which app_rw does not hold.
--         app_rw inserts without USAGE on the sequence, and holds none. db/schema.ts renders the
--         column in drizzle's bigint mode (T-153). EV proposed by T-212.
--   U-10 (1)  CONSTRAINT audit_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'):
--         a payload is a JSON object, never an array, a scalar or JSON null. Its fields are the
--         Zod payload contract's (T-067), not this table's. SD 2851 writes no CHECK: EV proposed
--         by T-212.
--   SD 2854's index, named here: audit_outbox_created_at_unrelayed_idx ON (created_at) WHERE
--         relayed_at IS NULL, on the predicate and order key of the relay's claim (T-067 Q2).
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a numbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit.
--   app_rw: SELECT; INSERT on (payload) only; UPDATE on (relayed_at) only (V-O1). A column UPDATE
--   privilege also admits SELECT ... FOR UPDATE, which the relay's claim takes.
--   No DELETE (U-10 (3)): pruning relayed rows is the retention engine's (T-069; OD-226 cut N-6).
--   No TRUNCATE.
--   Nothing to app_admin_rw (U-7 (2a): admin actions reach the outbox through core as app_rw),
--   app_safety_rw (U-7 (3b): safety events are audited by worker; a closed list, T-020 §3) or
--   answering_service (SA §INT-10). No row-level security (U-8 (2a)).
--
-- WHERE NO RULING SPEAKS (T-212's choices, stated in its Published contract):
--   INSERT is column-level, (payload) only, as T-067 Q1 writes it. So for app_rw created_at always
--   takes DEFAULT now() (the inserting transaction's start), and relayed_at always starts NULL.
--   Naming either is refused (42501), even with the DEFAULT keyword. created_at becomes
--   audit_log.occurred_at (U-9 (a)), so app_rw cannot back-date an action at INSERT. A row
--   inserted with relayed_at already set would never be selected by the relay's claim (T-067 Q2
--   reads relayed_at IS NULL), so app_rw cannot insert a row already marked relayed. It can still
--   mark one afterwards (NOT HELD, below).
--   NO TRIGGER FIXES created_at FOR OTHER WRITERS (unlike OE-61/OE-63's created_at, which a TTL
--   CHECK reads): no CHECK reads created_at here, the column grant decides it for app_rw, and the
--   owner app_ddl and the superuser are bound by no grant. This is 0016 and 0017's precedent.
--
-- NOT HELD HERE. These are grants, not triggers: they bind app_rw only. The owner app_ddl and the
-- superuser can INSERT any created_at or relayed_at, supply an id with OVERRIDING SYSTEM VALUE,
-- and UPDATE or DELETE any row. app_rw itself can, through its UPDATE (relayed_at):
--   - set relayed_at on a row the relay never published, so the relay's claim no longer selects it;
--   - set relayed_at back to NULL, so the relay's claim selects a relayed row again;
--   - set relayed_at to any value, earlier than created_at included.
-- Exactly-once relay (U-10 (2a)) is the relay's transaction (T-067), not this table's.
-- The payload's fields, size and content are not checked; '{}' is accepted. PostgreSQL's own
-- refusals print values in their DETAIL (a CHECK's or NOT NULL's prints the whole row, payload
-- included) to the writer and, by default, to the server log (OD-241). That is platform-wide,
-- OD-241 -> T-230; this file does not change it.
--
-- NOT IN gate:migration-lint's R-APPEND-ONLY NAME SET (D-11, OD-143). That rule matches audit_log,
-- case_note and decision_record (and their _<suffix> names), not audit_outbox, so a later GRANT
-- widening app_rw here passes the lint. The suite's refusals are this table's guard.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table, its identity
-- sequence and its two indexes. No -- @run-as marker: every object is new, and no CREATE
-- EXTENSION is needed (bigint, jsonb and timestamptz are core).
--
-- THE SA §INT-10 GUARD. Of this file's statements, CREATE TABLE and GRANT carry tags in
-- trg_int10_answering_service's WHEN TAG IN list (0001); CREATE INDEX and COMMENT do not. This
-- file creates no function, no trigger and no rule.

CREATE TABLE public.audit_outbox (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  relayed_at timestamptz,
  CONSTRAINT audit_outbox_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX audit_outbox_created_at_unrelayed_idx
  ON public.audit_outbox (created_at)
  WHERE relayed_at IS NULL;

GRANT SELECT ON public.audit_outbox TO app_rw;
GRANT INSERT (payload) ON public.audit_outbox TO app_rw;
GRANT UPDATE (relayed_at) ON public.audit_outbox TO app_rw;

COMMENT ON TABLE public.audit_outbox IS
  'The transactional audit outbox (SD §DB-10 lines 2850-2854; SA §SEC-8). id is an identity column, GENERATED ALWAYS. CHECK audit_outbox_payload_object holds payload to a JSON object. app_rw may SELECT, may INSERT only payload, so created_at takes now() and relayed_at starts NULL for it, and may UPDATE only relayed_at. It holds no DELETE or TRUNCATE: pruning relayed rows is the retention engine''s (OE-50 U-10 (3)). These are grants: they bind app_rw, not the table owner app_ddl or the superuser. No other role is granted any privilege, and there is no row-level security.';
