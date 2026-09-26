-- 0013_otp_challenge.up.sql
--
-- @phase: expand
--
-- Ticket:  T-194 (tech-lead -> tech-lead), TK-1 of tasks/state/EP-2/OE-30-34-rulings.md § D.3.
-- Request: tasks/state/EP-2/T-027.md § Migration request, Request 1 (ADR 0001 §1).
-- Spec:    SD §DB-2 lines 1830-1835 (the DDL); SD §BE-4 lines 1024-1025; SA §SEC-5 line 2205
--          (6 digits, 5-minute TTL, single use, max 3 attempts).
-- Rulings: OE-30 as accepted (rulings Part A.1: U-O1..U-O5, U-O4's binding half only) and OE-50
--          (rulings Part F: Q-D1, Q-D2, Q-D3 and U-O6 accepted as recommended in Parts B.2/B.3).
-- Contracts: T-140 § Published contract (the identity tables' grant pattern); T-020 § Published
--          contract §3-§5 (roles, explicit grants, the SA §INT-10 guard); T-021 (rework 2) and
--          T-031 (lint); T-136 (runner); T-137 (tripwire).
--
-- WHAT IT CREATES. public.otp_challenge with SD 1831-1833's seven columns in SD's order, SD's
-- types, nullability and the one default SD gives (attempts DEFAULT 0), and SD 1835's index; then
-- what the rulings add:
--   U-O1  code_hash is an HMAC-SHA-256 output under a server secret (code only; the column stays
--         bytea NOT NULL as SD writes it).
--   Q-D2  CHECK (octet_length(code_hash) = 32): an HMAC-SHA-256 output is 32 bytes. EV-9 (proposed;
--         a CHECK SD 1831 does not write).
--   U-O2  CHECK (attempts BETWEEN 0 AND 3).
--   U-O3  no limit column: send limits live in Valkey (SD §SEC-I4), not here.
--   U-O4  expires_at is set by code (now() + interval '5 minutes'); no column DEFAULT.
--   Q-D1  created_at timestamptz NOT NULL DEFAULT now() and the TTL CHECK. EV-8 (proposed; SD 1830-
--         1833 has no created_at). The CHECK is written with timestamptz - timestamptz, which is
--         IMMUTABLE, rather than the ruling's created_at + interval '5 minutes' (timestamptz +
--         interval is STABLE). For an interval of whole minutes the two are the same predicate.
--         created_at is appended after SD's seven columns so SD's column order is kept.
--   U-O5 + Q-D3  a single-use trigger (below).
--   U-O6  no DELETE for app_rw. Retention is a spec addition, EV-10 (proposed): a new SD §DB-14
--         row, otp_challenge, hard_delete 90 d after expires_at, run by the retention engine
--         (T-069). This migration records it in the table's COMMENT only; the retention_rule row
--         and the role that deletes belong to T-069.
-- The EV numbers are proposed by T-194 and allocated by the orchestrator in decisions.md. They
-- are cited only in these top-level -- lines, never in a COMMENT ON or a function body, so a
-- renumbering changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- THE SINGLE-USE TRIGGER (U-O5 option (B), widened by Q-D3 (a)). An AFTER UPDATE row trigger
-- refuses, on a row that changed:
--   KV060 OTP_CHALLENGE_CONSUMED_AT_CLEARED   a set consumed_at returned to NULL;
--   KV061 OTP_CHALLENGE_CONSUMED_AT_REWRITTEN a set consumed_at changed to another timestamp;
--   KV062 OTP_CHALLENGE_EXHAUSTED             any change to a row whose stored attempts is 3.
-- The consumed_at checks run first, so a consumed row that is also at 3 attempts reports KV060 or
-- KV061. "Changed" is NEW IS DISTINCT FROM OLD: an UPDATE writing identical values is not refused.
-- AFTER, not BEFORE (OD-237 TL-1): the trigger reads the row as stored, after every BEFORE
-- trigger, and its RAISE still aborts the statement. CHECK and NOT NULL are evaluated first, so
-- attempts = 4 is 23514 and a NULL is 23502 before the trigger runs. The messages carry no column
-- value: phone_e164 is personal data (SD 3924) and code_hash is a secret's digest.
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit: app_rw gets
-- SELECT, INSERT, UPDATE (UPDATE also covers SELECT ... FOR UPDATE). No DELETE (U-O6). Nothing to
-- app_admin_rw, app_safety_rw (a closed list) or answering_service (SA §INT-10).
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table, the index and the
-- function. No -- @run-as marker: every object is new, and no CREATE EXTENSION is needed (bytea,
-- inet, smallint, text and timestamptz are core types).
--
-- THE SA §INT-10 GUARD. CREATE TABLE, CREATE FUNCTION and GRANT fire trg_int10_answering_service.
-- The function is SECURITY INVOKER, so check 8 (SECURITY DEFINER functions) does not apply to it.

CREATE TABLE public.otp_challenge (
  id                char(26)    PRIMARY KEY,
  phone_e164        text        NOT NULL,
  code_hash         bytea       NOT NULL,
  attempts          smallint    NOT NULL DEFAULT 0,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_ip_prefix inet,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenge_attempts_check
    CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT otp_challenge_code_hash_length_check
    CHECK (octet_length(code_hash) = 32),
  CONSTRAINT otp_challenge_ttl_check
    CHECK (expires_at > created_at AND expires_at - created_at <= interval '5 minutes')
);

CREATE INDEX ON public.otp_challenge (phone_e164, expires_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.otp_challenge TO app_rw;

COMMENT ON TABLE public.otp_challenge IS
  'Phone OTP challenges (SD §DB-2 lines 1830-1835; SA §SEC-5). code_hash: HMAC-SHA-256 of the code under a server secret, 32 bytes. At most 3 attempts; a 5-minute TTL checked against created_at; single use enforced by trg_otp_challenge_single_use (decisions.md OE-30, OE-50). app_rw holds no DELETE. Retention: hard_delete 90 d after expires_at, by the retention engine (OE-50 U-O6).';

CREATE FUNCTION public.assert_otp_challenge_single_use() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $fn$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;

  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'OTP_CHALLENGE_CONSUMED_AT_CLEARED: a consumed otp_challenge row cannot return to unconsumed'
      USING ERRCODE = 'KV060',
            HINT = 'SD 1833 and decisions.md OE-30 U-O5: a challenge is single use; consumed_at never returns to NULL.';
  END IF;

  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at <> OLD.consumed_at THEN
    RAISE EXCEPTION 'OTP_CHALLENGE_CONSUMED_AT_REWRITTEN: a consumed otp_challenge row keeps its consumed_at'
      USING ERRCODE = 'KV061',
            HINT = 'decisions.md OE-50 Q-D3: once set, consumed_at never changes.';
  END IF;

  IF OLD.attempts = 3 THEN
    RAISE EXCEPTION 'OTP_CHALLENGE_EXHAUSTED: an otp_challenge row at 3 attempts cannot change'
      USING ERRCODE = 'KV062',
            HINT = 'SA §SEC-5 and decisions.md OE-30 U-O5: after the third attempt the challenge is spent.';
  END IF;

  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.assert_otp_challenge_single_use() IS
  'AFTER UPDATE row trigger on otp_challenge (T-194; decisions.md OE-30 U-O5, OE-50 Q-D3). On a changed row: a set consumed_at returned to NULL is KV060; a set consumed_at changed to another value is KV061; any change to a row whose stored attempts is 3 is KV062. An UPDATE writing identical values is not refused.';

CREATE TRIGGER trg_otp_challenge_single_use
  AFTER UPDATE ON public.otp_challenge
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_otp_challenge_single_use();
