-- 0031_decision_record.up.sql
--
-- @phase: expand
--
-- Ticket:  T-268 (tech-lead -> bct), cut in tasks/state/EP-5/OD-350-cut.md § 4.1 (the request: the
--          module that owns these tables is trust, bct). Pulled forward from EP-13 because I-8's step 5
--          (T-270) is the first writer; T-079 (statement-of-reasons issuance) is the first reader.
-- Spec:    SD §DB-10 lines 2735-2752 (the DDL, verbatim, schema-qualified per EV-4); SD 763 (Flow 6
--          step 7: any adverse action -> decision_record -> statement of reasons); SA §DG-7; SA §DG-11r
--          row 5; SA §SEC-8 (decision_record is append-only: INSERT, never UPDATE or DELETE).
-- Contracts: T-020 § Published contract §3-§4 (roles; explicit grants, no default privileges; the
--          decision_record row of §4's table); T-031 (lint, protocol); T-136 (runner); T-137 (tripwire).
--          0001 Section 4 lists this grant as the plan of record.
--
-- WHAT IT CREATES. public.decision_record (SD 2735-2744) and public.statement_of_reasons (SD
-- 2746-2752), each with SD's columns in SD's order, with SD's types, nullability and defaults, SD's
-- primary keys and SD's one foreign key (statement_of_reasons.decision_record_id REFERENCES
-- decision_record(id), ON DELETE NO ACTION, PostgreSQL's default, as SD writes it). Constraint names
-- are PostgreSQL's defaults: decision_record_pkey, statement_of_reasons_pkey,
-- statement_of_reasons_decision_record_id_fkey.
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit.
--   app_rw and app_admin_rw: SELECT and INSERT on both tables, at table level. Nothing else: no
--   UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN (SA §SEC-8; 0001:175, 181, 367-369).
--   statement_of_reasons takes the same grants: a statement is a record of what was told to the
--   subject, and is read back by its issuer (OD-350 cut § 4.1). gate:migration-lint R-APPEND-ONLY
--   refuses UPDATE/DELETE/TRUNCATE/ALL on decision_record and decision_record_<suffix> by name; it
--   does not name statement_of_reasons, so for that table the grants below are the whole control.
--   Nothing to app_safety_rw or answering_service (OD-350 cut § 4.1; SA §INT-10).
--   No row-level security: neither table is on SD's list (lines 1309, 3906; OD-223 ruled on T-186).
--   These are grants, not triggers: they bind the two application roles only. The owner app_ddl and
--   the superuser keep UPDATE, DELETE and TRUNCATE with no grant (as for audit_log, 0020).
--
-- NOT HELD HERE.
--   - inputs carries ALLOWLISTED inputs only (SD 2741, SA DA-7): the per-decision_type allowlist is
--     EP-13's. The database checks only that inputs is non-NULL jsonb. T-270 validates its own inputs
--     in code.
--   - decision_type: SD lists nine values in a comment (2737-2738) and writes no CHECK; none is added.
--   - subject_id, reviewer_id, appeal_id, case_id and recipient_id name nothing the database checks
--     (no foreign key in SD; case and appeal do not exist yet).
--   - No locale column on statement_of_reasons (SD gives none). If DSA per-language evidence needs
--     one, T-079 requests it by migration request.
--   - No index beyond the two primary keys (SD writes none); decision_record_id is not indexed.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns both tables and their indexes.
-- No -- @run-as marker: every object is new.
--
-- THE SA §INT-10 GUARD. CREATE TABLE and GRANT carry tags in trg_int10_answering_service's list
-- (0001); COMMENT does not. This file creates no function, no trigger, no rule and no policy.

CREATE TABLE public.decision_record (
  id              char(26)    PRIMARY KEY,
  subject_id      char(26)    NOT NULL,
  decision_type   text        NOT NULL,
  made_at         timestamptz NOT NULL DEFAULT now(),
  automated       boolean     NOT NULL,
  ruleset_id      text,
  ruleset_version text,
  inputs          jsonb       NOT NULL,
  output          text        NOT NULL,
  explanation     text        NOT NULL,
  human_reviewed  boolean     NOT NULL DEFAULT false,
  reviewer_id     char(26),
  reviewed_at     timestamptz,
  appeal_id       char(26),
  case_id         char(26)
);

GRANT SELECT, INSERT ON public.decision_record TO app_rw, app_admin_rw;

COMMENT ON TABLE public.decision_record IS
  'Decision records (SD §DB-10 lines 2735-2744; SA DG-7), append-only (SA SEC-8). app_rw and app_admin_rw may SELECT and INSERT; neither holds UPDATE, DELETE or TRUNCATE. These are grants: they bind those two roles, not the table owner app_ddl or the superuser. No other role is granted any privilege, and there is no row-level security. inputs must hold allowlisted inputs only (SA DA-7); the database does not check which keys it carries.';

CREATE TABLE public.statement_of_reasons (
  id                   char(26)    PRIMARY KEY,
  decision_record_id   char(26)    NOT NULL REFERENCES public.decision_record (id),
  recipient_id         char(26)    NOT NULL,
  ground               text        NOT NULL,
  facts_relied_on      text        NOT NULL,
  automated_means_used boolean     NOT NULL,
  redress_route        text        NOT NULL,
  template_version     text        NOT NULL,
  issued_at            timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz
);

GRANT SELECT, INSERT ON public.statement_of_reasons TO app_rw, app_admin_rw;

COMMENT ON TABLE public.statement_of_reasons IS
  'Statements of reasons (SD §DB-10 lines 2746-2752; DSA Art 17), one or more per decision_record. app_rw and app_admin_rw may SELECT and INSERT; neither holds UPDATE, DELETE or TRUNCATE. These are grants: they bind those two roles, not the table owner app_ddl or the superuser. No other role is granted any privilege, and there is no row-level security.';
