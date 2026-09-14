-- 0005_identity_schema.up.sql
--
-- @phase: expand
-- @run-as: bootstrap-superuser — OD-70; T-140 (CREATE EXTENSION citext needs CREATE on the
--   database, which app_ddl does not hold: refused 42501 "permission denied to create extension",
--   measured as the runner's role and as an app_ddl-only login, T-140 evidence P0)
--
-- Ticket:  T-140 (tech-lead). Identity schema: account, account_role (+ sod_finance_ts),
--          app_session. webauthn_credential is NOT here (T-027 requests it).
-- Spec:    SD §DB-2 lines 1759-1821; SD §DB-1 lines 1755-1757 (conventions); SA §SEC-5 line 2209
--          (server-side session table); OD-70 (citext, locale_registry); OE-22.
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the INT-10 guard);
--          T-144 § Published contract and § Tech-lead second approval items 1 and 3 (the
--          locale foreign key); T-136 § contract §6 (principal); T-021 / T-031 (lint).
--
-- WHY THIS FILE RUNS AS THE BOOTSTRAP SUPERUSER. citext is a trusted extension, and a trusted
-- extension needs CREATE on the database; app_ddl holds CREATE on schema public only (T-020
-- § contract §3). No role switch appears in this file (gate:migration-lint R-ROLE-SWITCH). So
-- that app_ddl still owns everything created in public (T-020 § contract §3), each table and
-- the enum are handed to app_ddl with OWNER TO immediately after they are created. The
-- extension stays owned by the bootstrap superuser, as 0001's seven extensions are.
--
-- CITEXT AND THE SA §INT-10 GUARD. CREATE EXTENSION is one of the guard's event-trigger tags,
-- and the trigger fires inside citext's install script (T-140 evidence P0e: a planted
-- detective-only grant makes CREATE EXTENSION citext fail KV010 at citextin). On a clean state
-- it passes. citext has 47 functions and no SECURITY DEFINER function, and owns no relation
-- (P0d). Its functions keep PostgreSQL's default PUBLIC EXECUTE; they compute over their
-- arguments and read no table (T-020 § contract §5: invoker functions are not checked, OD-52).
-- account.email_ci is the one allowlisted citext column (T-020 § contract §1; ILIKE is banned,
-- SA §DV-13).
--
-- DEVIATION FROM SD §DB-2's TEXT (recorded, T-140 row). SD writes the CHECK
-- account_min_age_verified inside CREATE TABLE and then adds dob_verified_18 with a separate
-- ALTER TABLE ... ADD COLUMN, so the CHECK names a column that does not exist yet and the
-- CREATE TABLE fails. Here the column is declared inside CREATE TABLE, after erased_at, which is
-- the position SD's ALTER would have given it, and the CHECK follows it. The column type,
-- default and constraint are SD's.
--
-- account.locale (T-144 second approval, rules 1-5). REFERENCES locale_registry(code) with no
-- ON UPDATE or ON DELETE clause, so both are NO ACTION: a referenced code can be neither renamed
-- nor deleted. Never ON UPDATE CASCADE, which was measured rewriting a row in a table no
-- application role may update. Plain text with the database's deterministic default collation;
-- never a nondeterministic one (refused 42P21 anyway). DEFAULT 'en' relies on 0004's 'en' row.
-- The foreign key does not read locale_registry.enabled.
--
-- GRANTS. There are no default privileges (T-020 § contract §4), so each is explicit:
--   app_rw             SELECT, INSERT, UPDATE on all three tables. No DELETE on any of them:
--                      an account is erased by tombstone, keeping its row and pseudonym (SD lines
--                      1766, 1772, 1793); a role is revoked by revoked_at (line 1802); a session is
--                      revoked by revoked_at (lines 1819-1821). The retention hard-delete of
--                      expired sessions (SD line 3143) is the retention ticket's to request.
--   app_admin_rw       nothing. An admin grant needs its FORCE ROW LEVEL SECURITY policy
--                      (T-020 § contract §3, SA §SEC-9); the admin ticket requests both.
--   app_safety_rw      nothing (T-020 § contract §3). SD line 923 has safety-gw reading
--                      app_session; that tension is OD-95, not a grant made here.
--   answering_service  nothing. SA §INT-10.
--
-- Transactional; no -- @no-transaction marker. The down file runs as this file does.

CREATE EXTENSION citext WITH SCHEMA public;

CREATE TYPE public.account_status AS ENUM ('pending','active','suspended','removed','erased');
ALTER TYPE public.account_status OWNER TO app_ddl;

CREATE TABLE public.account (
  id                char(26) PRIMARY KEY,
  email_ci          public.citext UNIQUE,                -- NULL after erasure tombstone
  email_verified_at timestamptz,
  phone_e164        text UNIQUE,
  phone_verified_at timestamptz,
  password_hash     text,                                -- NULLABLE: no flow may require a password (SA CC-1)
  status            public.account_status NOT NULL DEFAULT 'pending',
  pseudonym         char(26) NOT NULL UNIQUE,            -- survives erasure (DG-4)
  jurisdiction      text NOT NULL DEFAULT 'CY',          -- ISO 3166-1 alpha-2 (SA DA-4r)
  data_region       text NOT NULL DEFAULT 'eu-central-1',-- Frankfurt (SA TS-8r)
  -- LOCALE: the actor attribute the entire i18n design rests on (SA TS-12.1, SE-8).
  locale            text NOT NULL DEFAULT 'en'
                      REFERENCES public.locale_registry(code),  -- DATA, never a TS union (§DB-17)
  locale_source     text NOT NULL DEFAULT 'inferred'
                      CHECK (locale_source IN ('inferred','chosen')),
  locale_set_at     timestamptz,
  -- Grammatical gender for person-referring copy (SA TS-12.2 rule 2). NOT the §MVP-D1 AC3
  -- gender filter attribute, which lives in sitter_attribute (UC-6).
  grammatical_reference text NOT NULL DEFAULT 'other'
                      CHECK (grammatical_reference IN ('feminine','masculine','other')),
  tos_version       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  erased_at         timestamptz,
  dob_verified_18   boolean NOT NULL DEFAULT false,      -- A7; declared before the CHECK below
  CONSTRAINT account_min_age_verified CHECK (status <> 'active' OR dob_verified_18 IS TRUE)
);
ALTER TABLE public.account OWNER TO app_ddl;
GRANT SELECT, INSERT, UPDATE ON public.account TO app_rw;

CREATE TABLE public.account_role (
  account_id char(26) NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('parent','sitter','support','ts_operator',
              'ts_senior','dsl','deputy_dsl','finance','compliance','engineer')),
  granted_by char(26), granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  PRIMARY KEY (account_id, role)
);
ALTER TABLE public.account_role OWNER TO app_ddl;
GRANT SELECT, INSERT, UPDATE ON public.account_role TO app_rw;
-- Separation of duties, enforced at grant time, not by convention:
CREATE UNIQUE INDEX sod_finance_ts ON public.account_role(account_id)
  WHERE role IN ('finance','ts_operator') AND revoked_at IS NULL;   -- at most one of the pair

CREATE TABLE public.app_session (
  id char(26) PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,              -- SHA-256 of the cookie value; the value is never stored
  account_id char(26) NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  auth_method text NOT NULL CHECK (auth_method IN ('password','magic_link','passkey','otp','sso')),
  device_fingerprint text, ip_prefix inet,       -- /24 or /48 only, never a full IP (SEC PII rule)
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  step_up_until timestamptz,
  revoked_at timestamptz, revoked_reason text
);
ALTER TABLE public.app_session OWNER TO app_ddl;
GRANT SELECT, INSERT, UPDATE ON public.app_session TO app_rw;
CREATE INDEX ON public.app_session(account_id) WHERE revoked_at IS NULL;
