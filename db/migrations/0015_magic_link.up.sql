-- 0015_magic_link.up.sql
--
-- @phase: expand
--
-- Ticket:  T-195 (tech-lead -> tech-lead), TK-2 of tasks/state/EP-2/OE-30-34-rulings.md § D.3.
-- Request: tasks/state/EP-2/T-027.md § Migration request, Request 2 (ADR 0001 §1).
-- Spec:    SD §DB-2 lines 1837-1840 (the DDL); SD §BE-4 lines 1022-1023; SA §TS-7 line 817 and
--          SA §SEC-5 line 2206 (10-minute TTL, single use, invalidated on any later login).
-- Rulings: OE-30 as accepted (rulings Part A.1: U-M1, U-M2), OE-49 (rulings Part E.1: U-M4) and
--          OE-50 (rulings Part F: Q-D2 and U-M6 accepted as recommended in Parts B.2/B.3).
-- Contracts: T-140 § Published contract (account, the FK target); T-194 § Rework 2 › Published
--          contract (rework 2) (the otp_challenge pattern this file follows where no ruling
--          speaks); T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10
--          guard); T-231 (the guard after 0014); T-021 (rework 2) and T-031 (lint); T-136
--          (runner); T-137 (tripwire).
--
-- WHAT IT CREATES. public.magic_link with SD 1838-1840's six columns in SD's order, SD's types
-- and nullability (SD gives no default), SD 1838's PRIMARY KEY and UNIQUE; then what the rulings
-- add:
--   U-M1  account_id REFERENCES public.account(id) ON DELETE CASCADE, no ON UPDATE (so NO
--         ACTION), as its siblings SD 1799, 1812 and 1824 do. SD 1838 writes no REFERENCES, so
--         this is an EV (proposed by T-195; its number is the orchestrator's).
--   U-M2  token_hash is the SHA-256 digest of a 256-bit CSPRNG token, as app_session.token_hash
--         (code only; the column stays bytea NOT NULL UNIQUE as SD writes it).
--   Q-D2  CHECK (octet_length(token_hash) = 32): a SHA-256 digest is 32 bytes. EV-9.
--   U-M4  CREATE INDEX magic_link_account_id_live_idx ON magic_link (account_id) WHERE
--         consumed_at IS NULL (rulings E.1), serving "invalidated on any subsequent login"
--         (SA 2206): UPDATE ... SET consumed_at = now() WHERE account_id = $1 AND consumed_at IS
--         NULL AND expires_at > now(). SD 1837-1841 gives no index; this mirrors SD 1821's
--         app_session index. An EV (proposed by T-195; its number is the orchestrator's).
--   U-M6  no DELETE for app_rw. Retention is a spec addition, EV-10: a new SD §DB-14 row,
--         magic_link, hard_delete 90 d after expires_at, run by the retention engine (T-069).
--         This migration records it in the table's COMMENT only.
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON or a function
-- body, so a (re)numbering changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- WHERE NO RULING SPEAKS, T-194's otp_challenge pattern (decisions.md OE-60, OE-61) is applied,
-- and T-195 § Published contract says so:
--   GRANTS, column-level. app_rw may INSERT only (id, account_id, token_hash, expires_at,
--   requested_device_fingerprint), T-027 M1's column list, so a link cannot be inserted already
--   consumed; and may UPDATE only consumed_at, which is what M2 (consume) and U-M4's invalidation
--   write. A column UPDATE privilege also admits SELECT ... FOR UPDATE.
--   SINGLE USE, SET ONCE (SA 2206; the reading of decisions.md OE-50 Q-D3): once consumed_at is
--   set it never returns to NULL and never changes.
--   FIXED COLUMNS: after insert, only consumed_at may change. Every other column is held for
--   every writer, not only through app_rw's grant.
--
-- THE SINGLE-USE TRIGGER. An AFTER UPDATE row trigger refuses, on a row that changed, in this
-- order:
--   KV066 MAGIC_LINK_CONSUMED_AT_CLEARED    a set consumed_at returned to NULL;
--   KV067 MAGIC_LINK_CONSUMED_AT_REWRITTEN  a set consumed_at changed to another timestamp;
--   KV068 MAGIC_LINK_FIXED_COLUMN           id, account_id, token_hash, expires_at or
--                                           requested_device_fingerprint changed. For app_rw the
--                                           column grant refuses these first (42501); KV068 holds
--                                           the rule for every writer the grant does not bind.
-- The first that applies is raised. "Changed" is NEW IS DISTINCT FROM OLD: an UPDATE writing
-- identical values is not refused. The trigger's own messages carry no column value (token_hash
-- is a bearer token's digest). PostgreSQL's own refusals DO: the DETAIL of a CHECK or NOT NULL
-- refusal ("Failing row contains (...)"), of the UNIQUE ("Key (token_hash)=(...)") and of the
-- FK ("Key (account_id)=(...)") prints values to the writer and, by default, to the server log.
-- That is platform-wide and is OD-241 -> T-230; this migration does not change it.
-- AFTER, not BEFORE (OD-237 TL-1): the trigger reads the row as stored, after every BEFORE
-- trigger, and its RAISE still aborts the statement. CHECK, NOT NULL, UNIQUE and the FK's insert
-- check are evaluated first.
--
-- NOT HELD HERE (not ruled for this table; T-195 reports it): the 10-minute TTL. magic_link has
-- no created_at (SD 1837-1840), so expires_at is set by code (now() + interval '10 minutes',
-- T-027 M1) and nothing bounds it. Nor is consuming an expired link refused: M2's
-- expires_at > now() predicate is the control.
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit. No DELETE or
-- TRUNCATE (U-M6). Nothing to app_admin_rw, app_safety_rw (a closed list) or answering_service
-- (SA §INT-10).
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table, the index and the
-- function. No -- @run-as marker: every object is new, account is owned by app_ddl (T-140 §
-- contract §1), and no CREATE EXTENSION is needed (bytea, char, text and timestamptz are core).
--
-- THE SA §INT-10 GUARD. CREATE TABLE, CREATE INDEX, CREATE FUNCTION and GRANT fire
-- trg_int10_answering_service. The function is SECURITY INVOKER, so check 8 (SECURITY DEFINER
-- functions) does not apply to it.

CREATE TABLE public.magic_link (
  id                           char(26)    PRIMARY KEY,
  account_id                   char(26)    NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  token_hash                   bytea       NOT NULL UNIQUE,
  expires_at                   timestamptz NOT NULL,
  consumed_at                  timestamptz,
  requested_device_fingerprint text,
  CONSTRAINT magic_link_token_hash_length_check
    CHECK (octet_length(token_hash) = 32)
);

CREATE INDEX magic_link_account_id_live_idx
  ON public.magic_link (account_id)
  WHERE consumed_at IS NULL;

GRANT SELECT ON public.magic_link TO app_rw;
GRANT INSERT (id, account_id, token_hash, expires_at, requested_device_fingerprint) ON public.magic_link TO app_rw;
GRANT UPDATE (consumed_at) ON public.magic_link TO app_rw;

COMMENT ON TABLE public.magic_link IS
  'Email magic links (SD §DB-2 lines 1837-1840; SA §SEC-5). token_hash: SHA-256 of a 256-bit token, 32 bytes; the token is never stored. account_id references account, ON DELETE CASCADE. Single use: once consumed_at is set it never changes, and no other column changes after insert (trg_magic_link_single_use). app_rw may INSERT only id, account_id, token_hash, expires_at and requested_device_fingerprint, may UPDATE only consumed_at, and holds no DELETE. The 10-minute TTL is set by code in expires_at; the database does not bound it. Retention: hard_delete 90 d after expires_at, by the retention engine (OE-50 U-M6).';

CREATE FUNCTION public.assert_magic_link_single_use() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $fn$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;

  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'MAGIC_LINK_CONSUMED_AT_CLEARED: a consumed magic_link row cannot return to unconsumed'
      USING ERRCODE = 'KV066',
            HINT = 'SA §SEC-5: a magic link is single use; consumed_at never returns to NULL.';
  END IF;

  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at <> OLD.consumed_at THEN
    RAISE EXCEPTION 'MAGIC_LINK_CONSUMED_AT_REWRITTEN: a consumed magic_link row keeps its consumed_at'
      USING ERRCODE = 'KV067',
            HINT = 'SA §SEC-5: a magic link is single use; once set, consumed_at never changes.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.requested_device_fingerprint IS DISTINCT FROM OLD.requested_device_fingerprint THEN
    RAISE EXCEPTION 'MAGIC_LINK_FIXED_COLUMN: only consumed_at may change after a magic_link row is inserted'
      USING ERRCODE = 'KV068',
            HINT = 'A magic link is never re-armed, re-keyed or re-bound: id, account_id, token_hash, expires_at and requested_device_fingerprint are fixed after insert.';
  END IF;

  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.assert_magic_link_single_use() IS
  'AFTER UPDATE row trigger on magic_link (T-195; SA §SEC-5 single use). On a changed row, first match raised: a set consumed_at returned to NULL is KV066; a set consumed_at changed to another value is KV067; a change to id, account_id, token_hash, expires_at or requested_device_fingerprint is KV068. An UPDATE writing identical values is not refused.';

CREATE TRIGGER trg_magic_link_single_use
  AFTER UPDATE ON public.magic_link
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_magic_link_single_use();
