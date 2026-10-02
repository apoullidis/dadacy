-- 0020_audit_log.up.sql
--
-- @phase: expand
--
-- Ticket:  T-214 (tech-lead -> bct), P-AUDIT-LOG of tasks/state/EP-8b/OD-226-cut.md § 3.
-- Request: tasks/state/EP-3/T-067.md § Migration request, MR-3, the table half (ADR 0001 §1); the
--          requesting code is T-067 (the outbox relay, the crypto-shred path, the anchor job and the
--          chain verifier). The hash-chain trigger and its advisory lock are T-215 (P-AUDIT-CHAIN),
--          not this file.
-- Spec:    SD §DB-10 lines 2835-2848 (the DDL); SA §SA-4 I-6 (490-491); SA §DA-9 1371-1380;
--          SA §SEC-8 2257-2262.
-- Rulings: OE-34 Part C of tasks/state/EP-2/OE-30-34-rulings.md, accepted by OE-50 (Part F):
--          U-1 (b), U-2 / D-1 (OD-141), U-3, U-5 (5), U-7, U-8, U-9, U-13, U-14, U-16; and OE-72 RQ-2
--          (decisions.md: audit_log records its source audit_outbox.id, a plain bigint, no FK).
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-231 (the guard after 0014); T-153 (int8 renders as a JS bigint); T-150 (bytea renders
--          as a Buffer); T-165 rework 2 and T-214 (a partitioned table renders as its parent, its
--          identity from the parent's sequence); T-021 (rework 2) and T-031 (lint); T-136 (runner);
--          T-137 (tripwire); T-212 and T-213 (0018 and 0019, the precedents this file follows).
--
-- WHAT IT CREATES. public.audit_log, PARTITION BY RANGE (occurred_at), with SD 2836-2846's sixteen
-- columns in SD's order with SD's types, nullability, defaults and its two CHECKs (U-14: verbatim);
-- then what the rulings change:
--   U-1 (b)  seq bigint GENERATED ALWAYS AS IDENTITY, not SD's bigserial. An INSERT naming a seq is
--         refused (428C9) for every writer. A row inserted into a partition by name takes the
--         parent's sequence too: a partition has no sequence of its own. EV proposed by T-214.
--   U-2 / D-1  SD's PRIMARY KEY (seq) on a table partitioned by occurred_at is refused by PostgreSQL
--         (0A000: a unique constraint on a partitioned table must include every partition-key
--         column; measured by T-214), so the key is CONSTRAINT audit_log_pkey PRIMARY KEY
--         (seq, occurred_at). seq's own uniqueness rests on the identity sequence, not a
--         constraint: two rows can share a seq at two occurred_at values if one was supplied with
--         OVERRIDING SYSTEM VALUE, which only the owner and the superuser can do. EV proposed by T-214.
--   U-5 (5)  CONSTRAINT audit_log_prev_entry_hash_len CHECK (octet_length(prev_entry_hash) = 32)
--         and CONSTRAINT audit_log_entry_hash_len CHECK (octet_length(entry_hash) = 32): each is a
--         SHA-256 digest. Length only, not content. EV proposed by T-214.
--   OE-72 RQ-2  source_outbox_id bigint, NULL allowed: the audit_outbox.id a relayed row came from.
--         A plain bigint with no foreign key (outbox rows are pruned at 30 days). NULL for a row with
--         no outbox row: the crypto-shred path inserts directly (U-7 (4a)). EV proposed by T-214.
--   OE-72 RQ-2  CONSTRAINT audit_log_source_outbox_id_occurred_at_key UNIQUE (source_outbox_id,
--         occurred_at). UNIQUE (source_outbox_id) alone is refused on this table (0A000, measured),
--         for the same reason as the key. Because the relay copies audit_outbox.created_at into
--         occurred_at (U-9), a second relay of one outbox row carries the same pair and is refused
--         (23505, naming the PARTITION's constraint, audit_log_pYYYYMM_source_outbox_id_occurred_at_key).
--         It does NOT refuse one outbox id relayed with a different occurred_at, including a copy
--         of created_at cut to the millisecond on its way through a driver (measured by T-214: pg's
--         Date), and NULLs never collide. It adds one index per partition beside the primary key's (U-16 said only the
--         primary key; OE-72 RQ-2 asked for this to be considered). EV proposed by T-214.
--   seq and source_outbox_id render in drizzle's bigint mode (T-153); the four hashes as Buffers
--   (T-150).
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a numbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- PARTITIONS (U-3). 36 monthly partitions, premade here: audit_log_p202610 (the month this migration
-- was written) to audit_log_p202909, each FOR VALUES FROM the first instant of its month in UTC TO
-- the first instant of the next, written with +00 so the session TimeZone cannot move a bound. No
-- default partition: a row whose occurred_at falls outside 2026-10-01 .. 2029-10-01 UTC is refused
-- (23514 "no partition of relation "audit_log" found for row", measured; V-L5), so the outbox keeps
-- it and the relay's lag alert fires (U-3 (1)). No pg_partman create_parent and no run-time DDL
-- principal: the next partitions come from a later migration (U-3 (2c); EV against SD 2848, proposed
-- by T-214). Each partition is named audit_log_pYYYYMM, inside gate:migration-lint R-APPEND-ONLY's
-- name rule (audit_log and audit_log_<suffix>), and carries its own GRANTs (R-TABLE-GRANT).
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit, on the parent and
-- on every partition alike.
--   app_rw: SELECT (U-8 (1a): the relay's head read, the anchor job, the verifier and the admin
--   search through core). INSERT on fourteen columns: every column but seq, prev_entry_hash and
--   entry_hash. seq is the identity's; the two chain hashes are computed by T-215's trigger, and
--   callers supply neither (U-5 (1a)), so naming either is refused (42501). occurred_at IS in the
--   grant: the relay copies it from the outbox (U-9). No UPDATE, no DELETE, no TRUNCATE (SA I-6;
--   V-L1).
--   Nothing to app_admin_rw, app_safety_rw or answering_service (U-7, U-8). No row-level security.
--   A partition's grants matter only to a statement naming the partition: one through the parent
--   is checked against the parent's grants.
--   Until T-215's trigger exists, an app_rw INSERT cannot succeed: the hashes are NOT NULL and
--   app_rw may not supply them (23502). Nothing writes this table before T-067, which waits on T-215.
--
-- NOT HELD HERE. The database does not check:
--   - that a row's hashes link to the previous row's (T-215's trigger and T-067's verifier);
--   - action, subject_type, reason_code or request_context's keys (U-14 (a): T-067's Zod payload
--     contract), or that actor_id/subject_id name anything (no foreign key);
--   - that source_outbox_id names an outbox row, or that every relayed outbox row has its audit row
--     (OE-72: T-067's verifier, while both rows exist);
--   - that occurred_at equals the outbox row's created_at (U-9 is the relay's), nor any ordering of
--     occurred_at against seq.
--   These are grants, not triggers: they bind app_rw only. The owner app_ddl and the superuser hold
--   UPDATE, DELETE, TRUNCATE, DETACH and DROP with no grant (V-L7, OD-78; U-13 (a): detected by the
--   chain and the S3 anchor, not prevented here). The CHECKs, the NOT NULLs, the UNIQUE and the
--   partition bounds still bind them.
--   PostgreSQL's own refusals print values in their DETAIL to the writer and, by default, to the
--   server log (OD-241): a 23505 here prints source_outbox_id and occurred_at, a CHECK's or NOT
--   NULL's prints the whole row (rationale and request_context included), a 23514 for a missing
--   partition prints occurred_at. That is platform-wide, OD-241 -> T-230; this file does not change it.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the parent, its 36 partitions,
-- the identity sequence and every index. No -- @run-as marker: every object is new, and no CREATE
-- EXTENSION is needed.
--
-- THE SA §INT-10 GUARD. Of this file's statements, CREATE TABLE (the parent and each CREATE TABLE
-- ... PARTITION OF, whose command tag is CREATE TABLE) and GRANT carry tags in
-- trg_int10_answering_service's WHEN TAG IN list (0001); COMMENT does not. This file creates no
-- function, no trigger and no rule.

CREATE TABLE public.audit_log (
  seq              bigint      GENERATED ALWAYS AS IDENTITY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text        NOT NULL CHECK (actor_type IN ('user','operator','system','provider')),
  actor_id         char(26),
  action           text        NOT NULL,
  subject_type     text        NOT NULL,
  subject_id       char(26),
  data_class       text        CHECK (data_class IN ('C1','C2','C3','C4')),
  policy_basis     text,
  reason_code      text,
  rationale        text,
  before_hash      bytea,
  after_hash       bytea,
  request_context  jsonb       NOT NULL,
  prev_entry_hash  bytea       NOT NULL,
  entry_hash       bytea       NOT NULL,
  source_outbox_id bigint,
  CONSTRAINT audit_log_pkey PRIMARY KEY (seq, occurred_at),
  CONSTRAINT audit_log_source_outbox_id_occurred_at_key UNIQUE (source_outbox_id, occurred_at),
  CONSTRAINT audit_log_prev_entry_hash_len CHECK (octet_length(prev_entry_hash) = 32),
  CONSTRAINT audit_log_entry_hash_len CHECK (octet_length(entry_hash) = 32)
) PARTITION BY RANGE (occurred_at);

GRANT SELECT ON public.audit_log TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log TO app_rw;

COMMENT ON TABLE public.audit_log IS
  'The audit log (SD §DB-10 lines 2835-2848; SA §SA-4 I-6; SA §SEC-8), partitioned by month on occurred_at. seq is an identity column, GENERATED ALWAYS; the primary key is (seq, occurred_at) because a key on a partitioned table must include occurred_at. prev_entry_hash and entry_hash are 32 bytes each (CHECK audit_log_prev_entry_hash_len, audit_log_entry_hash_len). source_outbox_id is the audit_outbox.id a relayed row came from, NULL for a row written without one; it is not a foreign key. UNIQUE audit_log_source_outbox_id_occurred_at_key refuses a second row with the same source_outbox_id and occurred_at, not one with the same source_outbox_id at another occurred_at. Partitions audit_log_p202610 to audit_log_p202909 are premade, with no default partition: a row whose occurred_at falls in none is refused. app_rw may SELECT and may INSERT every column except seq, prev_entry_hash and entry_hash, on the parent and on each partition. It holds no UPDATE, DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. No other role is granted any privilege, and there is no row-level security.';

-- The 36 premade monthly partitions (OE-50 U-3 (1), (2c), (3), (5)): each with the parent's grants,
-- in its own statements, written out rather than generated so the file is literal SQL.

CREATE TABLE public.audit_log_p202610 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202610 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202610 TO app_rw;

CREATE TABLE public.audit_log_p202611 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202611 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202611 TO app_rw;

CREATE TABLE public.audit_log_p202612 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202612 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202612 TO app_rw;

CREATE TABLE public.audit_log_p202701 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202701 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202701 TO app_rw;

CREATE TABLE public.audit_log_p202702 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202702 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202702 TO app_rw;

CREATE TABLE public.audit_log_p202703 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202703 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202703 TO app_rw;

CREATE TABLE public.audit_log_p202704 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202704 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202704 TO app_rw;

CREATE TABLE public.audit_log_p202705 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202705 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202705 TO app_rw;

CREATE TABLE public.audit_log_p202706 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202706 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202706 TO app_rw;

CREATE TABLE public.audit_log_p202707 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-07-01 00:00:00+00') TO ('2027-08-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202707 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202707 TO app_rw;

CREATE TABLE public.audit_log_p202708 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-08-01 00:00:00+00') TO ('2027-09-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202708 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202708 TO app_rw;

CREATE TABLE public.audit_log_p202709 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-09-01 00:00:00+00') TO ('2027-10-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202709 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202709 TO app_rw;

CREATE TABLE public.audit_log_p202710 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-10-01 00:00:00+00') TO ('2027-11-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202710 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202710 TO app_rw;

CREATE TABLE public.audit_log_p202711 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-11-01 00:00:00+00') TO ('2027-12-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202711 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202711 TO app_rw;

CREATE TABLE public.audit_log_p202712 PARTITION OF public.audit_log
  FOR VALUES FROM ('2027-12-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202712 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202712 TO app_rw;

CREATE TABLE public.audit_log_p202801 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-01-01 00:00:00+00') TO ('2028-02-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202801 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202801 TO app_rw;

CREATE TABLE public.audit_log_p202802 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-02-01 00:00:00+00') TO ('2028-03-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202802 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202802 TO app_rw;

CREATE TABLE public.audit_log_p202803 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-03-01 00:00:00+00') TO ('2028-04-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202803 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202803 TO app_rw;

CREATE TABLE public.audit_log_p202804 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-04-01 00:00:00+00') TO ('2028-05-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202804 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202804 TO app_rw;

CREATE TABLE public.audit_log_p202805 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-05-01 00:00:00+00') TO ('2028-06-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202805 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202805 TO app_rw;

CREATE TABLE public.audit_log_p202806 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-06-01 00:00:00+00') TO ('2028-07-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202806 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202806 TO app_rw;

CREATE TABLE public.audit_log_p202807 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-07-01 00:00:00+00') TO ('2028-08-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202807 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202807 TO app_rw;

CREATE TABLE public.audit_log_p202808 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-08-01 00:00:00+00') TO ('2028-09-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202808 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202808 TO app_rw;

CREATE TABLE public.audit_log_p202809 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-09-01 00:00:00+00') TO ('2028-10-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202809 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202809 TO app_rw;

CREATE TABLE public.audit_log_p202810 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-10-01 00:00:00+00') TO ('2028-11-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202810 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202810 TO app_rw;

CREATE TABLE public.audit_log_p202811 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-11-01 00:00:00+00') TO ('2028-12-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202811 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202811 TO app_rw;

CREATE TABLE public.audit_log_p202812 PARTITION OF public.audit_log
  FOR VALUES FROM ('2028-12-01 00:00:00+00') TO ('2029-01-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202812 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202812 TO app_rw;

CREATE TABLE public.audit_log_p202901 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-01-01 00:00:00+00') TO ('2029-02-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202901 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202901 TO app_rw;

CREATE TABLE public.audit_log_p202902 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-02-01 00:00:00+00') TO ('2029-03-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202902 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202902 TO app_rw;

CREATE TABLE public.audit_log_p202903 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-03-01 00:00:00+00') TO ('2029-04-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202903 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202903 TO app_rw;

CREATE TABLE public.audit_log_p202904 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-04-01 00:00:00+00') TO ('2029-05-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202904 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202904 TO app_rw;

CREATE TABLE public.audit_log_p202905 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-05-01 00:00:00+00') TO ('2029-06-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202905 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202905 TO app_rw;

CREATE TABLE public.audit_log_p202906 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-06-01 00:00:00+00') TO ('2029-07-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202906 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202906 TO app_rw;

CREATE TABLE public.audit_log_p202907 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-07-01 00:00:00+00') TO ('2029-08-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202907 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202907 TO app_rw;

CREATE TABLE public.audit_log_p202908 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-08-01 00:00:00+00') TO ('2029-09-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202908 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202908 TO app_rw;

CREATE TABLE public.audit_log_p202909 PARTITION OF public.audit_log
  FOR VALUES FROM ('2029-09-01 00:00:00+00') TO ('2029-10-01 00:00:00+00');
GRANT SELECT ON public.audit_log_p202909 TO app_rw;
GRANT INSERT (occurred_at, actor_type, actor_id, action, subject_type, subject_id, data_class, policy_basis, reason_code, rationale, before_hash, after_hash, request_context, source_outbox_id) ON public.audit_log_p202909 TO app_rw;
