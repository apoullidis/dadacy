-- 0030_i1_bookable_state.down.sql
--
-- Ticket: T-028 (tech-lead). The inverse of the up file. After this file the database is the 0029
-- state: the four triggers, the eight functions and the policy are gone, and sitter_credential's
-- table comment is 0026's text again, byte for byte.
--
-- ORDER. Triggers, then the policy, then the functions (callers before callees). No CASCADE
-- (gate:migration-lint R-CASCADE): if anything outside this migration came to depend on a function,
-- the DROP is refused and the transaction rolls back.
--
-- What stays: every value the derivation wrote into sitter_profile (bookable_state, tier,
-- tier_rank, bookable_since) and every pgboss.job row it enqueued. After this file nothing derives
-- bookable_state and nothing enqueues on its change.
--
-- WHO RUNS THIS FILE. The bootstrap superuser, as its up file does (T-136 § contract §6: a down
-- file runs as its up file). Transactional.

DROP TRIGGER trg_sitter_profile_i1_enqueue ON public.sitter_profile;
DROP TRIGGER trg_account_i1_rederive ON public.account;
DROP TRIGGER trg_sitter_credential_i1_truncate ON public.sitter_credential;
DROP TRIGGER trg_sitter_credential_i1_rederive ON public.sitter_credential;

DROP POLICY sitter_credential_i1_derivation_select ON public.sitter_credential;

DROP FUNCTION public.i1_sitter_profile_enqueue();
DROP FUNCTION public.i1_account_rederive();
DROP FUNCTION public.i1_sitter_credential_truncate_rederive();
DROP FUNCTION public.i1_sitter_credential_rederive();
DROP FUNCTION public.i1_reconcile_bookable_state();
DROP FUNCTION public.i1_rederive_sitter(pg_catalog.bpchar);
DROP FUNCTION public.i1_enqueue_slot_materialise(pg_catalog.bpchar);
DROP FUNCTION public.i1_derived_bookable(pg_catalog.bpchar);

COMMENT ON TABLE public.sitter_credential IS
  'A sitter''s credential per scheme (SD §DB-4, SA §DA-4r). No certificate content, no free text, no notes. reference_number is plain text; its format is credential_scheme.reference_format_regex, applied by the application, never DDL. Row-level security is FORCEd; policies are TO app_rw and read app.actor_id, app.actor_role and app.break_glass, an empty value counting as unset. A sitter sees and writes only their own rows, can write only status not_started or submitted, and cannot update a row in review_hold; the system actor sees and writes every row; break-glass reads every row. app_rw holds no DELETE.';
