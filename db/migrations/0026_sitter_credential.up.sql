-- 0026_sitter_credential.up.sql
--
-- @phase: expand
--
-- Ticket:  T-252 (tech-lead -> backend-credential-trust), MR-2 of T-060's migration request.
-- Request: tasks/state/EP-5/T-060.md § Migration request › MR-2 (ADR 0001 §1), as ruled in
--          tasks/state/EP-5/CUT-T-060.md §1 (R-2 row-level security, R-7 the C6 catalogue probe,
--          R-9 grants) and §2 S-1, which the stakeholder ruled on 2026-10-10T07:05:42Z (all
--          recommendations accepted; decisions.md § Escalations). S-2 (the T&S operator's read
--          scope) belongs to T-070's migration: this file adds no operator policy.
-- Spec:    SD §DB-4 lines 2120-2150 (the DDL and its three partial indexes); SD 1309 and 3906 (the
--          RLS list, FORCE, the GUCs app.actor_id / app.actor_role / app.break_glass set by SET LOCAL
--          per transaction); SD 1975-1986 (the worked predicate; break-glass is app.break_glass =
--          'on'); SD 1240 (the worker is actor_type 'system' with a named job identity); SD 1432-1434
--          (the credential lifecycle); SA 835 (RLS is a backstop); SA §DA-4r 1272-1280.
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-021 (rework 2), T-031 and T-253 (lint; R-CRED-REF admits exactly S-1 (b)(ii)'s CHECK);
--          T-136 (runner); T-137 (tripwire); T-251 (credential_scheme); T-158 (sitter_profile).
--
-- WHAT IT CREATES. SD 2120-2150's sitter_credential: its twenty columns in SD's order, types,
-- nullability and default, no more and no fewer, schema-qualified (EV-4). The PK on id (a ULID,
-- app-generated). sitter_id REFERENCES sitter_profile(id) ON DELETE CASCADE, as SD writes it; it is
-- NOT the erasure path (R-2.7; T-157 U-10 (a): the profile row is kept and nulled, never deleted).
-- scheme_id REFERENCES credential_scheme(id) and attestation_locale REFERENCES
-- locale_registry(code), both NO ACTION. decided_by has no FK (SD writes none). UNIQUE (sitter_id,
-- scheme_id). SD's two CHECKs (status, expiry_provenance). The three partial indexes, named as the
-- request proposes. S-1's CHECKs, as ruled:
--   (b) (ii)  sitter_credential_reference_number_bounds: 1 to 64 characters, no control character.
--             A capacity bound, not a format. It is the ONLY constraint naming reference_number, and
--             its text is CUT-T-060 S-1 (b)(ii)'s byte for byte (T-253 § contract §6).
--   (c) (i)   decision and decision_reason_code are NULL-only until their value sets exist.
--   (d) (i)   provider and provider_ref are NULL-only until T-076's adapter set exists.
--   (e) (ii)  attestation_template_version has an identifier shape.
-- Widening any of the NULL-only CHECKs is an expand. EV numbers for these departures are assigned
-- when the orchestrator records them; they are cited only in -- lines, never in a COMMENT ON.
--
-- THE FORMAT IS DATA (SD 2126; SD 2065-2070; SD §Revision Log C6). reference_number is plain text.
-- No CHECK other than (b) (ii), no domain, no char(n)/varchar(n), no trigger, no index expression
-- or predicate, no generated column and no policy expression names it. Its format lives in
-- credential_scheme.reference_format_regex and is applied by the application. The applied state is
-- held by the catalogue probe in packages/db-testkit/suites/sitter-credential.test.ts (R-7, OD-324).
--
-- ROW-LEVEL SECURITY (R-2). ENABLE and FORCE, so the owner app_ddl is subject to policy as well.
-- Every policy is TO app_rw (the only role granted anything here) and reads each GUC as
-- NULLIF(current_setting('<guc>', true), ''): once a custom GUC has been SET LOCAL in one
-- transaction, a later transaction on the same connection reads it as '' rather than NULL, and
-- '' must not count as a value. With no actor set, nothing is visible and every write is refused.
-- Seven policies, one per command per actor class:
--   sitter (self)   SELECT, INSERT, UPDATE where actor_role = 'sitter' and sitter_id = actor_id.
--                   INSERT and UPDATE also require the new row's status to be one a sitter causes:
--                   not_started (Q-3, onboarding) or submitted (her submission). Every other status
--                   (in_review, valid, expired, failed, review_hold, withdrawn) is caused by the
--                   system or an operator, never by the sitter (SD 1432-1434; R-2.4). A
--                   self-validated credential is I-1's attack.
--   system          SELECT, INSERT, UPDATE on every row where actor_role = 'system' and actor_id
--                   (the job identity, SD 1240) is set.
--   break-glass     SELECT on every row where app.break_glass = 'on' (SD 1986). Nothing else.
-- No DELETE policy: no role holds DELETE. No operator policy: operators see nothing without
-- break-glass until T-070's migration adds one (S-2, ruled (a)).
-- BOUND (R-2.5): any app_rw session can set these GUCs, app.break_glass included. This RLS is SA
-- 835's backstop against an application-layer bug, not a control against hostile application code.
--
-- GRANTS (R-9). No default privileges exist (T-020 § contract §4).
--   app_rw             SELECT; INSERT; UPDATE on exactly 16 columns (every column but id,
--                      sitter_id, scheme_id and created_at). No DELETE (withdrawal is a status), no
--                      TRUNCATE, REFERENCES or TRIGGER.
--   app_admin_rw       nothing.
--   app_safety_rw      nothing (T-020 § contract §3).
--   answering_service  nothing (SA §INT-10).
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table, its indexes and
-- its policies. sitter_profile (0025), credential_scheme (0024) and locale_registry (0004) were
-- created by app_ddl runs, so the REFERENCES need nothing more. No CREATE EXTENSION, no
-- superuser-owned object replaced, no protected object named: no marker. Transactional.

CREATE TABLE public.sitter_credential (
  id char(26) PRIMARY KEY,
  sitter_id char(26) NOT NULL REFERENCES public.sitter_profile(id) ON DELETE CASCADE,
  scheme_id integer NOT NULL REFERENCES public.credential_scheme(id),
  status text NOT NULL CHECK (status IN ('not_started','submitted','in_review','valid',
          'expired','failed','review_hold','withdrawn')),
  reference_number text,                  -- format validated in the APP against
                                          -- credential_scheme.reference_format_regex, not in DDL
  issued_on date, expires_on date,
  expiry_provenance text CHECK (expiry_provenance IN ('from_document','platform_default')),
  next_recertification_due_at date,       -- point_in_time_annual_reissue
  last_attestation_at timestamptz,        -- periodic_attestation
  next_attestation_due_at timestamptz,
  attestation_template_version text,      -- the exact wording shown ...
  attestation_locale text REFERENCES public.locale_registry(code),   -- ... and its locale
  decision text, decided_by char(26), decided_at timestamptz, decision_reason_code text,
  provider text, provider_ref text,       -- IDV only; no vetting provider exists in Cyprus
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sitter_id, scheme_id),
  CONSTRAINT sitter_credential_reference_number_bounds CHECK (char_length(reference_number) BETWEEN 1 AND 64 AND reference_number !~ '[[:cntrl:]]'),
  CONSTRAINT sitter_credential_decision_null_only CHECK (decision IS NULL),
  CONSTRAINT sitter_credential_decision_reason_code_null_only CHECK (decision_reason_code IS NULL),
  CONSTRAINT sitter_credential_provider_null_only CHECK (provider IS NULL),
  CONSTRAINT sitter_credential_provider_ref_null_only CHECK (provider_ref IS NULL),
  CONSTRAINT sitter_credential_attestation_template_version_shape
    CHECK (attestation_template_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
  -- NO bytea. NO jsonb. NO unconstrained free text. NO notes column. NO monitoring_status.
);
CREATE INDEX idx_sitter_credential_attestation_due ON public.sitter_credential (next_attestation_due_at)
  WHERE status = 'valid';
CREATE INDEX idx_sitter_credential_recert_due ON public.sitter_credential (next_recertification_due_at)
  WHERE status = 'valid';
CREATE INDEX idx_sitter_credential_expires ON public.sitter_credential (expires_on)
  WHERE status = 'valid' AND expires_on IS NOT NULL;

COMMENT ON TABLE public.sitter_credential IS
  'A sitter''s credential per scheme (SD §DB-4, SA §DA-4r). No certificate content, no free text, no notes. reference_number is plain text; its format is credential_scheme.reference_format_regex, applied by the application, never DDL. Row-level security is FORCEd; policies are TO app_rw and read app.actor_id, app.actor_role and app.break_glass, an empty value counting as unset. A sitter sees and writes only her own rows and can write only status not_started or submitted; the system actor sees and writes every row; break-glass reads every row. app_rw holds no DELETE.';

ALTER TABLE public.sitter_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sitter_credential FORCE ROW LEVEL SECURITY;

CREATE POLICY sitter_credential_sitter_select ON public.sitter_credential
  FOR SELECT TO app_rw
  USING (NULLIF(current_setting('app.actor_role', true), '') = 'sitter'
         AND sitter_id = NULLIF(current_setting('app.actor_id', true), ''));
CREATE POLICY sitter_credential_sitter_insert ON public.sitter_credential
  FOR INSERT TO app_rw
  WITH CHECK (NULLIF(current_setting('app.actor_role', true), '') = 'sitter'
              AND sitter_id = NULLIF(current_setting('app.actor_id', true), '')
              AND status IN ('not_started','submitted'));
CREATE POLICY sitter_credential_sitter_update ON public.sitter_credential
  FOR UPDATE TO app_rw
  USING (NULLIF(current_setting('app.actor_role', true), '') = 'sitter'
         AND sitter_id = NULLIF(current_setting('app.actor_id', true), ''))
  WITH CHECK (NULLIF(current_setting('app.actor_role', true), '') = 'sitter'
              AND sitter_id = NULLIF(current_setting('app.actor_id', true), '')
              AND status IN ('not_started','submitted'));
CREATE POLICY sitter_credential_system_select ON public.sitter_credential
  FOR SELECT TO app_rw
  USING (NULLIF(current_setting('app.actor_role', true), '') = 'system'
         AND NULLIF(current_setting('app.actor_id', true), '') IS NOT NULL);
CREATE POLICY sitter_credential_system_insert ON public.sitter_credential
  FOR INSERT TO app_rw
  WITH CHECK (NULLIF(current_setting('app.actor_role', true), '') = 'system'
              AND NULLIF(current_setting('app.actor_id', true), '') IS NOT NULL);
CREATE POLICY sitter_credential_system_update ON public.sitter_credential
  FOR UPDATE TO app_rw
  USING (NULLIF(current_setting('app.actor_role', true), '') = 'system'
         AND NULLIF(current_setting('app.actor_id', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('app.actor_role', true), '') = 'system'
              AND NULLIF(current_setting('app.actor_id', true), '') IS NOT NULL);
CREATE POLICY sitter_credential_break_glass_select ON public.sitter_credential
  FOR SELECT TO app_rw
  USING (NULLIF(current_setting('app.break_glass', true), '') = 'on');

GRANT SELECT, INSERT ON public.sitter_credential TO app_rw;
GRANT UPDATE (status, reference_number, issued_on, expires_on, expiry_provenance,
              next_recertification_due_at, last_attestation_at, next_attestation_due_at,
              attestation_template_version, attestation_locale, decision, decided_by, decided_at,
              decision_reason_code, provider, provider_ref)
  ON public.sitter_credential TO app_rw;
