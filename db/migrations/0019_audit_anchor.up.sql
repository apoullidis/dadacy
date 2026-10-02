-- 0019_audit_anchor.up.sql
--
-- @phase: expand
--
-- Ticket:  T-213 (tech-lead -> bct), P-AUDIT-ANCHOR of tasks/state/EP-8b/OD-226-cut.md § 3.
-- Request: tasks/state/EP-3/T-067.md § Migration request, MR-2 (ADR 0001 §1); the requesting code
--          is T-067 (the hourly anchor job and the chain verifier).
-- Spec:    SD §DB-10 lines 2856-2859 (the DDL); SD 1362 (governance.anchor: hourly, exactly-once,
--          writes the audit head hash to S3 Object Lock); SA §DA-9 1376 and SA §SEC-8 2259 (the
--          anchor is the S3 object under Object Lock, compliance mode).
-- Rulings: OE-34 Part C of tasks/state/EP-2/OE-30-34-rulings.md, accepted by OE-50 (Part F):
--          U-1 (b), U-5 (5), U-7, U-8 (1a), U-11 (1)-(4), U-12 (2); D-11 (OD-143, OD-264).
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-231 (the guard after 0014); T-153 (int8 renders as a JS bigint); T-150 (bytea renders
--          as a Buffer); T-021 (rework 2) and T-031 (lint); T-136 (runner); T-137 (tripwire);
--          T-212 (0018, the precedent this file follows).
--
-- WHAT IT CREATES. public.audit_anchor with SD 2857-2858's five columns in SD's order, with SD's
-- nullability and default; then what the rulings change:
--   U-1   id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, not SD's bigserial. An INSERT
--         naming an id is refused (428C9) for every writer, app_rw included; only OVERRIDING
--         SYSTEM VALUE supplies one, and that needs INSERT on id, which app_rw does not hold.
--         app_rw inserts without USAGE on the sequence, and holds none. EV proposed by T-213.
--   U-11 (2a)  CONSTRAINT audit_anchor_head_seq_key UNIQUE (head_seq): one anchor record per
--         chain head. A second INSERT of a head_seq already recorded is refused (23505), for every
--         writer; a concurrent one waits for the first to commit or roll back. An hour with no new
--         audit rows therefore cannot be recorded again under the same head; the job skips it
--         (U-11 (3)). SD writes no UNIQUE: EV proposed by T-213. Its index is the only one on
--         head_seq, and the verifier's ORDER BY head_seq can use it.
--   U-5 (5)  CONSTRAINT audit_anchor_head_hash_len CHECK (octet_length(head_hash) = 32): a
--         head hash is a SHA-256 digest, 32 bytes, never 31, never 33, never empty. SD writes no
--         CHECK: EV proposed by T-213.
--   id and head_seq render in drizzle's bigint mode (T-153); head_hash as a Buffer (T-150).
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a numbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit.
--   app_rw: SELECT (U-8 (1a): the anchor job reads the previous anchor; the verifier lists the
--   anchors as an index to S3, never as the reference, U-12 (2)); INSERT on (head_seq, head_hash,
--   s3_key) only. No UPDATE, no DELETE, no TRUNCATE (V-A1): an anchor record is never rewritten
--   or removed by an application role.
--   Nothing to app_admin_rw, app_safety_rw or answering_service (U-7, U-8: only worker, as
--   app_rw, anchors and verifies). No row-level security.
--
-- WHERE NO RULING SPEAKS (T-213's choices, stated in its Published contract):
--   INSERT is column-level, (head_seq, head_hash, s3_key), as T-067 Q6 writes it. So for app_rw
--   anchored_at always takes DEFAULT now() (the inserting transaction's start). Naming it is
--   refused (42501), even with the DEFAULT keyword. This is 0016, 0017 and 0018's precedent: a
--   time column the database sets for app_rw by grant exclusion, with no trigger, because no
--   CHECK reads it. The owner app_ddl and the superuser are bound by no grant.
--
-- NOT HELD HERE. The database does not check:
--   - that head_seq increases from one anchor to the next (U-11 (4): the verifier checks it); a
--     lower head_seq than an existing one, 0 and a negative value are accepted;
--   - that head_seq names a row of audit_log, or that head_hash equals that row's entry_hash (no
--     foreign key; audit_log is T-214's): the CHECK reads only the length, and 32 zero bytes
--     are accepted;
--   - anything about s3_key: no UNIQUE is ruled (two rows may share a key), no format (U-11 (1)'s
--     audit-anchor/<20-digit head_seq> is the job's), the empty string is accepted;
--   - that the S3 object exists, or agrees with the row. The S3 object under Object Lock is the
--     anchor (SA 1376, 2259); this table is a ledger and an index to it. U-12 (2) has the verifier
--     compare against S3, never against this table; nothing here can hold that.
--   These are grants, not triggers: they bind app_rw only. The owner app_ddl and the superuser can
--   INSERT any anchored_at, supply an id with OVERRIDING SYSTEM VALUE, and UPDATE or DELETE any
--   row. The UNIQUE, the CHECK and the NOT NULLs still bind them (the suite shows the UNIQUE and
--   the CHECK refusing the owner and the superuser, and the NOT NULLs refusing the superuser).
--   PostgreSQL's own refusals print values in their DETAIL (a 23505 prints the duplicated
--   head_seq; a CHECK's or NOT NULL's prints the whole row, head_hash and s3_key included) to the
--   writer and, by default, to the server log (OD-241). That is platform-wide, OD-241 -> T-230;
--   this file does not change it.
--
-- NOT IN gate:migration-lint's R-APPEND-ONLY NAME SET (D-11, OD-143, OD-264). That rule matches
-- audit_log, case_note and decision_record (and their _<suffix> names), not audit_anchor, so a
-- later GRANT of UPDATE or DELETE here passes the lint. The suite's refusals are this table's
-- guard.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table, its identity
-- sequence and its two indexes. No -- @run-as marker: every object is new, and no CREATE
-- EXTENSION is needed (bigint, bytea, text and timestamptz are core).
--
-- THE SA §INT-10 GUARD. Of this file's statements, CREATE TABLE and GRANT carry tags in
-- trg_int10_answering_service's WHEN TAG IN list (0001); COMMENT does not. This file creates no
-- function, no trigger and no rule.

CREATE TABLE public.audit_anchor (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  head_seq    bigint      NOT NULL,
  head_hash   bytea       NOT NULL,
  s3_key      text        NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_anchor_head_seq_key UNIQUE (head_seq),
  CONSTRAINT audit_anchor_head_hash_len CHECK (octet_length(head_hash) = 32)
);

GRANT SELECT ON public.audit_anchor TO app_rw;
GRANT INSERT (head_seq, head_hash, s3_key) ON public.audit_anchor TO app_rw;

COMMENT ON TABLE public.audit_anchor IS
  'The ledger of hourly audit-chain anchors (SD §DB-10 lines 2856-2859; SA §SEC-8). The anchor itself is the S3 object under Object Lock; this table records it, and under OE-50 U-12 (2) a verifier compares against the S3 object, not this table. id is an identity column, GENERATED ALWAYS. UNIQUE audit_anchor_head_seq_key: one row per chain head. CHECK audit_anchor_head_hash_len: head_hash is 32 bytes. app_rw may SELECT and may INSERT only head_seq, head_hash and s3_key, so anchored_at takes now() for it. It holds no UPDATE, DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. The database does not check that head_seq increases, that head_hash matches the chain, or anything about s3_key beyond NOT NULL. No other role is granted any privilege, and there is no row-level security.';
