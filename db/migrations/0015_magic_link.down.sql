-- 0015_magic_link.down.sql
--
-- Ticket: T-195 (tech-lead). The inverse of the up file. After this file the database is the
-- 0014 state.
--
-- ORDER. The table first: DROP TABLE removes its two triggers, its index, its constraints (the foreign
-- key to account included) and its ACL with it, and nothing outside this migration references
-- magic_link. Then the two trigger functions, which nothing uses once the triggers are gone.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration came to depend
-- on either object, the DROP is refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.magic_link;
DROP FUNCTION public.assert_magic_link_single_use();
DROP FUNCTION public.set_magic_link_created_at();
