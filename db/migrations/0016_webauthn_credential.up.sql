-- 0016_webauthn_credential.up.sql
--
-- @phase: expand
--
-- Ticket:  T-196 (tech-lead -> tech-lead), TK-3 of tasks/state/EP-2/OE-30-34-rulings.md § D.3.
-- Request: tasks/state/EP-2/T-027.md § Migration request, Request 3 (ADR 0001 §1).
-- Spec:    SD §DB-2 lines 1823-1828 (the DDL); SD §BE-4 lines 1026-1028 (passkey register, login,
--          step-up); SD line 322 (security page: passkeys, revoke); SD 3150 (erasure tombstones
--          the account, so ON DELETE CASCADE does not fire); SA §TS-7 line 810 (@simplewebauthn).
-- Rulings: OE-30 as accepted (rulings Part A.1: U-W1, U-W3); OE-49 (rulings Part E.1: U-W2; and
--          C2 standing resolved as (c)); OE-50 (rulings Part F: U-W4 accepted as recommended in
--          Part B.3).
-- Contracts: T-140 § Published contract (account, the FK target); T-020 § Published contract
--          §3-§5 (roles, explicit grants, the SA §INT-10 guard); T-231 (the guard after 0014);
--          T-153 (int8 renders as a JS bigint); T-021 (rework 2) and T-031 (lint); T-136
--          (runner); T-137 (tripwire).
--
-- WHAT IT CREATES. public.webauthn_credential with SD 1823-1828's nine columns in SD's order,
-- with SD's types, nullability, defaults, PRIMARY KEY, UNIQUE and FOREIGN KEY; then what the
-- rulings add:
--   U-W1  sign_count bigint NOT NULL DEFAULT 0, verbatim (T-153 is done: db/schema.ts renders it
--         in drizzle's bigint mode, a JS bigint).
--   U-W2  CONSTRAINT webauthn_credential_sign_count_range CHECK (sign_count BETWEEN 0 AND
--         4294967295): the authenticator's signature counter is an unsigned 32-bit value (a
--         reading of W3C WebAuthn, not of SD). SD 1826 writes no CHECK: EV proposed by T-196.
--         NO trigger refuses a DECREASE: rulings E.1 (i) leaves that to @simplewebauthn in T-202,
--         which writes the new counter under T-027 W3's SELECT ... FOR UPDATE.
--   U-W3  CREATE INDEX webauthn_credential_account_id_idx ON (account_id): T-027 W1 and W5 read
--         by account, W6 filters by it, and the FK's ON DELETE CASCADE scans it. SD 1823-1828
--         gives no index: EV proposed by T-196. The name is this file's (A.1 gives none).
--   U-W4  DELETE to app_rw: a user removes a passkey outright (SD 322), and erasure deletes the
--         account's credentials (SD 3150 tombstones the account, so the CASCADE never fires).
--   C2    (c): admin passkeys are Cloudflare Access's, not this table's. Nothing is granted to
--         app_admin_rw, and there is no row-level security.
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a
-- renumbering changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- WHERE NO RULING SPEAKS (T-196's choices, stated in its Published contract):
--   INSERT, column-level: exactly T-027 W2's seven columns (id, account_id, credential_id,
--   public_key, sign_count, transports, aaguid). created_at therefore takes DEFAULT now() and
--   last_used_at starts NULL for app_rw: a credential cannot be inserted back-dated or
--   "already used".
--   UPDATE, column-level: exactly (sign_count, last_used_at), what T-027 W4 writes. A column
--   UPDATE privilege also admits SELECT ... FOR UPDATE (W3, W6). No other column can be changed
--   by app_rw after insert, so a credential is not re-keyed (credential_id, public_key) or
--   re-bound (account_id) by an UPDATE.
--   No TRUNCATE.
--   These are grants, not triggers: they bind app_rw only. The owner app_ddl and the superuser
--   are not held on any column, and app_rw itself can DELETE a row and INSERT a new one under
--   the same id (with a different key, account or a sign_count of 0), which is revoke and
--   re-register. No ruling asks the database to hold more.
--
-- NOT HELD HERE: a non-decreasing sign_count (U-W2 (i), the library's); the value of
-- last_used_at; the length or shape of credential_id and public_key; the contents or array
-- dimensions of transports; the mandatory admin passkey (C2 (c)). PostgreSQL's own refusals
-- print values in their DETAIL (a UNIQUE refusal prints the credential_id, the FK's the
-- account_id, a CHECK's or NOT NULL's the whole row including public_key) to the writer and, by
-- default, to the server log. That is platform-wide, OD-241 -> T-230; this file does not change
-- it.
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit. Nothing to
-- app_admin_rw (C2 (c)), app_safety_rw (a closed list) or answering_service (SA §INT-10).
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table and the index. No
-- -- @run-as marker: every object is new, account is owned by app_ddl (T-140 § contract §1), and
-- no CREATE EXTENSION is needed (bytea, bigint, char, text[], uuid and timestamptz are core).
--
-- THE SA §INT-10 GUARD. CREATE TABLE, CREATE INDEX and GRANT fire trg_int10_answering_service.
-- This file creates no function.

CREATE TABLE public.webauthn_credential (
  id            char(26)    PRIMARY KEY,
  account_id    char(26)    NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  credential_id bytea       NOT NULL UNIQUE,
  public_key    bytea       NOT NULL,
  sign_count    bigint      NOT NULL DEFAULT 0,
  transports    text[],
  aaguid        uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  CONSTRAINT webauthn_credential_sign_count_range
    CHECK (sign_count BETWEEN 0 AND 4294967295)
);

CREATE INDEX webauthn_credential_account_id_idx
  ON public.webauthn_credential (account_id);

GRANT SELECT, DELETE ON public.webauthn_credential TO app_rw;
GRANT INSERT (id, account_id, credential_id, public_key, sign_count, transports, aaguid) ON public.webauthn_credential TO app_rw;
GRANT UPDATE (sign_count, last_used_at) ON public.webauthn_credential TO app_rw;

COMMENT ON TABLE public.webauthn_credential IS
  'WebAuthn passkey credentials (SD §DB-2 lines 1823-1828). credential_id is UNIQUE across all accounts. account_id references account, ON DELETE CASCADE. app_rw may SELECT and DELETE (a user removes a passkey; erasure deletes the account''s credentials: OE-50 U-W4), may INSERT only id, account_id, credential_id, public_key, sign_count, transports and aaguid, and may UPDATE only sign_count and last_used_at. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. No grant to app_admin_rw and no row-level security (admin passkeys are Cloudflare Access''s: C2 (c)).';

COMMENT ON COLUMN public.webauthn_credential.sign_count IS
  'The authenticator''s signature counter, an unsigned 32-bit value: CHECK webauthn_credential_sign_count_range holds it to 0..4294967295 (OE-49 U-W2). The database does not refuse a decrease: U-W2 assigns that refusal to the WebAuthn library, at login.';
