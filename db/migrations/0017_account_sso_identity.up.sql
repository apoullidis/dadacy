-- 0017_account_sso_identity.up.sql
--
-- @phase: expand
--
-- Ticket:  T-226 (tech-lead -> tech-lead), P-SSO-SUBJECT of tasks/state/EP-2/OD-231-cut.md § C.
-- Request: tasks/state/EP-2/T-226.md § Migration request (ADR 0001 §1); the requesting code is
--          T-221 (the SSO exchange, P-ADMIN-SESSION of the same cut).
-- Spec:    decisions.md OE-55 (Q-2 (b) of the cut: bind each admin account to its Cloudflare
--          identity at first login, and refuse any other identity later); the cut's § A.4 (the
--          exchange) and § C P-SSO-SUBJECT (the DDL and grants); SA line 821 (SSO deprovisioning
--          is a safeguarding control).
-- Contracts: T-140 § Published contract (account, the FK target); T-020 § Published contract
--          §3-§5 (roles, explicit grants, the SA §INT-10 guard); T-231 (the guard after 0014);
--          T-021 (rework 2) and T-031 (lint); T-136 (runner); T-137 (tripwire).
--
-- WHAT IT CREATES. public.account_sso_identity, exactly as P-SSO-SUBJECT gives it:
--   account_id char(26) PRIMARY KEY REFERENCES public.account(id) ON DELETE CASCADE
--              The primary key is "one subject per account". No ON UPDATE clause, so NO ACTION.
--   subject    text NOT NULL UNIQUE
--              Cloudflare Access's subject for the operator. The UNIQUE is "one account per
--              subject".
--   bound_at   timestamptz NOT NULL DEFAULT now()
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit.
--   app_rw: SELECT, and INSERT on (account_id, subject) only. So bound_at always takes
--   DEFAULT now() for app_rw, and naming it is refused (42501). No UPDATE and no DELETE: a
--   binding is never moved or rewritten in place, and app_rw cannot remove one. No TRUNCATE.
--   Nothing to app_admin_rw: re-binding (an operator's IdP account re-created) has no ruled
--   grant or route, so T-226 did not build it (its evidence, question Q-T226-1).
--   Nothing to app_safety_rw (a closed list) or answering_service (SA §INT-10).
--
-- NO TRIGGER FIXES bound_at FOR OTHER WRITERS (unlike OE-61/OE-63's created_at): no CHECK or
-- other rule reads bound_at, so the column grant is what decides it, and it binds app_rw only.
-- The owner app_ddl and the superuser can write any bound_at, and can UPDATE or DELETE a row.
--
-- NOT HELD HERE:
--   - that the account holds an admin role. The SSO exchange (T-221) requires an active account
--     with an unrevoked admin role before it binds. A CHECK cannot read account_role, and a
--     trigger that did is not ruled (T-226, question Q-T226-2);
--   - refusing a later exchange whose subject differs from the bound one: that comparison is
--     the exchange's (T-221). This table only refuses a second binding for the account (the
--     primary key) and a second account for the subject (the UNIQUE);
--   - the content of subject: '' and surrounding whitespace are accepted, and the UNIQUE compares
--     exactly, so two spellings differing only in case are two subjects;
--   - erasure: app_rw holds no DELETE, and the CASCADE fires only on a DELETE of the account row,
--     which no application role holds, so a tombstoned account keeps its binding (T-069).
--   PostgreSQL's own refusals print values in their DETAIL (the UNIQUE's prints the subject, the
--   FK's the account_id, a NOT NULL's the row) to the writer and, by default, to the server log.
--   That is platform-wide, OD-241 -> T-230; this file does not change it.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table and its two key
-- indexes. No -- @run-as marker: every object is new, account is owned by app_ddl (T-140 §
-- contract §1), and no CREATE EXTENSION is needed (char, text and timestamptz are core).
--
-- THE SA §INT-10 GUARD. Of this file's statements, CREATE TABLE and GRANT carry tags in
-- trg_int10_answering_service's WHEN TAG IN list (0001); COMMENT does not. This file creates no
-- function, no trigger and no rule.

CREATE TABLE public.account_sso_identity (
  account_id char(26)    PRIMARY KEY REFERENCES public.account(id) ON DELETE CASCADE,
  subject    text        NOT NULL UNIQUE,
  bound_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.account_sso_identity TO app_rw;
GRANT INSERT (account_id, subject) ON public.account_sso_identity TO app_rw;

COMMENT ON TABLE public.account_sso_identity IS
  'Binds an admin account to its Cloudflare Access subject, at the first SSO exchange (decisions.md OE-55). The primary key on account_id allows one subject per account; the UNIQUE on subject allows one account per subject. account_id references account, ON DELETE CASCADE. app_rw may SELECT, and may INSERT only account_id and subject, so bound_at takes now() for it. It holds no UPDATE, DELETE or TRUNCATE. These are grants: they bind app_rw, not the table owner app_ddl or the superuser. No other role holds any privilege. The database does not check that the account holds an admin role.';
