-- 0013_otp_challenge.down.sql
--
-- Ticket: T-194 (tech-lead). The inverse of the up file. After this file the database is the
-- 0012 state.
--
-- ORDER. The table first: DROP TABLE removes its trigger, its index, its constraints and its ACL
-- with it, and nothing outside this migration references otp_challenge. Then the two trigger
-- functions, which nothing uses once the triggers are gone.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend
-- on either object, the DROP is refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.otp_challenge;
DROP FUNCTION public.assert_otp_challenge_single_use();
DROP FUNCTION public.set_otp_challenge_created_at();
