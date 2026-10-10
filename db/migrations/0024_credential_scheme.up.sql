-- 0024_credential_scheme.up.sql
--
-- @phase: expand
--
-- Ticket:  T-251 (tech-lead -> bct), MR-1 of T-060's migration request.
-- Request: tasks/state/EP-5/T-060.md § Migration request › MR-1 (ADR 0001 §1), as ruled in
--          tasks/state/EP-5/CUT-T-060.md §1 (R-3, R-4, R-5, R-6, R-9, R-10). The requesting
--          code is T-060 (the credential_scheme read path and the reference validator).
-- Spec:    SD §DB-4 lines 2054-2107 (the DDL and its comment block); SD 3103 (0072's seed),
--          SD 3622 (both certificates are hard gates for every tier); SA §DA-4r 1246-1262, 1291;
--          PM §MVP-S3 table lines 678-679 (Greek names), AC1 (both mandatory, 3-month recency),
--          AC7 (English display form); SQ-25 (the reference formats are unverified).
-- Rulings: stakeholder 2026-10-10T07:05:42Z (decisions.md § Escalations): S-1 accepted, so
--          (a) option (ii) stands as built here; the EVs below approved. EV-4 (tables in public).
-- Contracts: T-020 § Published contract §3-§5 (roles, explicit grants, the SA §INT-10 guard);
--          T-021 (rework 2) and T-031 (lint); T-136 (runner); T-137 (tripwire); T-138 (schema.ts).
--
-- WHAT IT CREATES. SD 2073-2107's credential_scheme, in SD's column order, types and nullability,
-- schema-qualified (EV-4), with these departures, each an EV in decisions.md:
--   EV-31 (R-4)  id integer GENERATED ALWAYS AS IDENTITY, not serial (ADR 0001 §1; the E.4
--                T-160 U-1 precedent). It stays integer for scheme_id and SD 2946's int[].
--   EV-32 (R-3)  mandatory_rules has NO DEFAULT (SD 2105: DEFAULT '{}'), and its CHECK admits the
--                single v1 value {"v": 1, "mandatory": "all_tiers"} only. '{}' is refused.
--   EV-33 (R-6)  scheme_name_i18n must be a JSON object. Its keys are not constrained here.
--   EV-34 (R-10, S-1 (a) (ii))  jurisdiction is two upper-case ASCII letters; scheme_name and
--                issuing_body are not blank (btrim) and at most 200 characters;
--                reference_format_regex is NULL or 1 to 512 characters.
-- check_type keeps SD's eight values (SD governs schema over SA §DA-4r's seven; R-5).
-- validity_model keeps SD's five values: continuously_monitored is in the CHECK and has no row.
-- EV numbers are cited only in these top-level -- lines, never in a COMMENT ON, so a renumbering
-- changes no applied effect (PROTOCOL §3, R-MERGED).
--
-- THE FORMAT IS DATA (SD 2065-2070, 2098-2104; SD §Revision Log C6). Nothing in this file encodes a
-- certificate-reference format: no CHECK, domain, char(n)/varchar(n) or trigger. The format lives
-- only in reference_format_regex, seeded NULL ("record verbatim, validate nothing", SQ-25). The
-- R-10 length bound on that column bounds the stored pattern, not any reference. When SQ-25 is
-- answered, the format arrives as a data migration that UPDATEs the column.
--
-- SEED (R-5, R-6; SD 3103, 3622; PM §MVP-S3). Two literal INSERTs (the 0004 precedent), with no id:
-- schemes are looked up by (jurisdiction, scheme_name), never by a literal id (R-4).
--   scheme_name       English, as SD 2055 / SA 1250 and SD 3103 write it. It is a key, not display.
--   scheme_name_i18n  en from PM AC7 / the PM table; el copied byte for byte from PM lines 678-679.
--                     No ru: no Russian name has a source, and none is invented (R-6).
--   both              Cyprus Police; point_in_time_annual_reissue; 12-month validity; 3-month
--                     recency; no attestation interval; reference_format_regex NULL; v1 rules.
-- NOT seeded: the periodic_attestation scheme (T-257), credential_storage_policy rows (R-8), and
-- PM AC9's foreign-national certificate (a third, nationality-conditional scheme).
--
-- GRANTS. No default privileges exist (T-020 § contract §4), so each is explicit.
--   app_rw             SELECT only. A scheme is written by a migration, never by application code:
--                      adding a mandatory scheme changes who is bookable (R-9).
--   app_admin_rw       nothing. The scheme editor (SD 347) is a later ticket; credential_scheme
--                      is not on SD 1309/3906's RLS list, so such a grant needs no policy (OD-223).
--   app_safety_rw      nothing (T-020 § contract §3).
--   answering_service  nothing (SA §INT-10).
-- No grant on the identity sequence to any role (R-4). No row-level security (not on SD's list).
--
-- NOT HELD HERE. The owner app_ddl and the superuser can write any row, and can supply an id with
-- OVERRIDING SYSTEM VALUE; the grants bind app_rw only. btrim strips spaces only, so a name of
-- tabs or newlines is not blank to the CHECK. The i18n keys are not checked against
-- locale_registry, and the integer columns carry no range. These are stated in T-251's contract.
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6), which then owns the table, its identity
-- sequence and its indexes. No CREATE EXTENSION, no superuser-owned object replaced: no marker.
-- Transactional. Of this file's statements, CREATE TABLE and GRANT fire the SA §INT-10 guard's
-- event trigger (T-020 § contract §5).

-- The Greek names below are UTF-8. State the client encoding rather than inherit it.
SET client_encoding = 'UTF8';

CREATE TABLE public.credential_scheme (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jurisdiction text NOT NULL,                      -- ISO 3166-1 alpha-2; 'CY' only at MVP
  check_type text NOT NULL CHECK (check_type IN ('criminal_record','child_protection_register',
              'identity','right_to_work','qualification','insurance','attestation','training')),
  scheme_name text NOT NULL,                       -- DATA
  scheme_name_i18n jsonb NOT NULL DEFAULT '{}',    -- per-locale display name (SA DA-4r)
  issuing_body text NOT NULL,                      -- 'Cyprus Police'
  validity_model text NOT NULL CHECK (validity_model IN (
      'point_in_time_annual_reissue',
      'periodic_attestation',
      'expiring',
      'point_in_time',
      'continuously_monitored')),                  -- retained, deliberately unused in CY
  default_validity_months int,
  max_age_at_submission_months int,
  attestation_interval_days int, attestation_grace_days int,
  reference_format_regex text,                     -- the format is DATA; NULL = record verbatim
  mandatory_rules jsonb NOT NULL,                  -- no default: every row states its rule
  UNIQUE (jurisdiction, scheme_name),
  CONSTRAINT credential_scheme_mandatory_rules_v1
    CHECK (mandatory_rules = '{"v": 1, "mandatory": "all_tiers"}'::jsonb),
  CONSTRAINT credential_scheme_scheme_name_i18n_object
    CHECK (jsonb_typeof(scheme_name_i18n) = 'object'),
  CONSTRAINT credential_scheme_jurisdiction_alpha2
    CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  CONSTRAINT credential_scheme_scheme_name_bounds
    CHECK (btrim(scheme_name) <> '' AND char_length(scheme_name) <= 200),
  CONSTRAINT credential_scheme_issuing_body_bounds
    CHECK (btrim(issuing_body) <> '' AND char_length(issuing_body) <= 200),
  CONSTRAINT credential_scheme_reference_format_regex_bounds
    CHECK (reference_format_regex IS NULL OR char_length(reference_format_regex) BETWEEN 1 AND 512)
);

COMMENT ON TABLE public.credential_scheme IS
  'Credential schemes per jurisdiction (SD §DB-4, SA §DA-4r). Reference data written only by migrations; app_rw reads it. A scheme name is data, never a column, type or enum value.';
COMMENT ON COLUMN public.credential_scheme.reference_format_regex IS
  'The certificate-reference format, as data. NULL means record the reference verbatim and validate nothing (SQ-25). No reference format is encoded in DDL.';
COMMENT ON COLUMN public.credential_scheme.mandatory_rules IS
  'Who must hold this scheme. Grammar v1 has one value, {"v": 1, "mandatory": "all_tiers"}. A reader that cannot parse a value treats the scheme as unmet (not bookable), never as optional.';

GRANT SELECT ON public.credential_scheme TO app_rw;

INSERT INTO public.credential_scheme
  (jurisdiction, check_type, scheme_name, scheme_name_i18n, issuing_body, validity_model,
   default_validity_months, max_age_at_submission_months, attestation_interval_days,
   attestation_grace_days, reference_format_regex, mandatory_rules)
VALUES
  ('CY', 'child_protection_register', 'Certificate under Art. 22(6), Law 91(I)/2014',
   '{"en": "Certificate under Article 22(6) of Law 91(I)/2014", "el": "Πιστοποιητικό βάσει του άρθρου 22(6) του Ν.91(Ι)/2014"}',
   'Cyprus Police', 'point_in_time_annual_reissue', 12, 3, NULL, NULL, NULL,
   '{"v": 1, "mandatory": "all_tiers"}'),
  ('CY', 'criminal_record', 'White Criminal Record Certificate',
   '{"en": "White Criminal Record Certificate", "el": "Πιστοποιητικό Λευκού Ποινικού Μητρώου"}',
   'Cyprus Police', 'point_in_time_annual_reissue', 12, 3, NULL, NULL, NULL,
   '{"v": 1, "mandatory": "all_tiers"}');
