-- 0007_approval_four_eyes.down.sql
--
-- Ticket: T-030 (tech-lead). The inverse of the up file. After this file the database is the
-- 0006 state: no `approval` table and no `assert_second_actor_differs()` function.
--
-- ORDER. The table first: dropping it drops its trigger `trg_approval_four_eyes`, its CHECK and
-- its ACL. Then the function, which nothing references once the trigger is gone.
--
-- No CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration has come to
-- reference `approval` (a later migration's `approval_id REFERENCES approval(id)`, SD lines 3164
-- and enforcement_action), or attached the function as a trigger on another table, the DROP is
-- refused and the transaction rolls back.
--
-- WHO RUNS THIS FILE. app_ddl, as its up file does (T-136 § contract §6).

DROP TABLE public.approval;
DROP FUNCTION public.assert_second_actor_differs();
