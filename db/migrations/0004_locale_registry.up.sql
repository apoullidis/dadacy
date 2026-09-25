-- 0004_locale_registry.up.sql
--
-- @phase: expand
--
-- Ticket:  T-144 (tech-lead -> backend-credential-trust), migration ticket for T-064.
-- Brief:   tasks/state/EP-0/T-064.md § Migration request, built exactly (ADR 0001 §2).
-- Spec:    SD §DB-17 lines 3386-3401 (DDL and seed); SD §DB-2 lines 1780-1781
--          (account.locale REFERENCES locale_registry(code) DEFAULT 'en'); SA §TS-12.2 rule 5;
--          T-040 § Published contract §8; EV-4 (application tables in public); OD-70, OD-89.
--
-- THE LOCALE SET IS DATA, NOT A TYPE. Adding a locale (Turkish, PM Q9/Q10; a visitor-segment
-- language, PM Q14) is a NEW data migration inserting a row, never an edit to this file:
-- once merged, what this file does is immutable (PROTOCOL §3, gate:migration-lint R-MERGED).
--
-- WHY THIS PRECEDES account. T-140's account.locale is NOT NULL DEFAULT 'en' REFERENCES
-- locale_registry(code), so an account insert relying on the default fails its foreign key
-- unless the 'en' row below exists (OD-70, OD-89). The 'en' seed row is load-bearing.
--
-- PRIMARY KEY (T-144 Q1). A natural text key, as SD §DB-17 writes it. ADR 0001 §1's "a ULID or
-- IDENTITY, never serial" exists for T-020 § contract §4's reason, a serial default needing
-- USAGE on a sequence; this key has no default and no sequence, and answering_service is
-- granted nothing on this table.
--
-- SEED (T-144 Q2). Literal INSERTs, equal field by field to SD line 3400-3401 and to
-- packages/i18n/locale-registry.json at e42464d. A migration cannot read that file at apply
-- time (psql meta-commands are refused by gate:migration-lint R-ROLE-SWITCH). The check that
-- the two do not drift is T-064's parity test, which reads these rows as app_rw and compares
-- them with the JSON parsed separately.
--
-- GRANTS. There are no default privileges (T-020 § contract §4), so each grant is explicit:
--   app_rw             SELECT only. core reads the registry; no INSERT/UPDATE/DELETE, because
--                      adding a locale is a data migration, not application code (SD line 3385).
--   app_admin_rw       nothing. No admin code reads it yet; the admin ticket that needs this
--                      table requests its grant. locale_registry is not one of the tables SD
--                      lines 1309 and 3906 give RLS, so such a grant needs no policy (SA §SEC-7;
--                      OD-223; corrected 2026-09-25 under R-MERGED, T-192: this cited SA §SEC-9,
--                      which is break-glass access).
--   app_safety_rw      nothing. T-020 § contract §3: SELECT on session_safety_projection and
--                      INSERT on its four tables, "and nothing else".
--   answering_service  nothing. SA §INT-10.
-- The SA §INT-10 guard fires on this file's CREATE TABLE and GRANT (T-020 § contract §5).
--
-- WHO RUNS THIS FILE. app_ddl (T-136 § contract §6): no CREATE EXTENSION, no superuser-owned
-- object replaced, so no -- @run-as marker. Transactional; no -- @no-transaction marker.

-- The endonyms below are UTF-8 (Greek, Cyrillic). State the client encoding rather than
-- inherit it from whatever locale the psql process happens to run under.
SET client_encoding = 'UTF8';

CREATE TABLE public.locale_registry (
  code               text    PRIMARY KEY,                     -- BCP-47: 'en','el','ru'
  endonym            text    NOT NULL,                        -- each language in its own language
  direction          text    NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr','rtl')),
  is_safety_language boolean NOT NULL,                        -- TRUE = lexicon, red-team, an operator
                                                              -- on every shift, a full catalogue
  plural_categories  text[]  NOT NULL,                        -- read by gate:plural-completeness (EV-2)
  enabled            boolean NOT NULL DEFAULT true
);

GRANT SELECT ON public.locale_registry TO app_rw;

INSERT INTO public.locale_registry
  (code, endonym, direction, is_safety_language, plural_categories, enabled)
VALUES
  ('en', 'English',  'ltr', true, ARRAY['one','other'],              true),
  ('el', 'Ελληνικά', 'ltr', true, ARRAY['one','other'],              true),
  ('ru', 'Русский',  'ltr', true, ARRAY['one','few','many','other'], true);
