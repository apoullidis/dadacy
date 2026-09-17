-- 0006_pgboss_schema.down.sql
--
-- Ticket: T-146 (tech-lead). The inverse of the up file. After this file the database is the
-- 0005 state: schema `pgboss` does not exist and `to_regnamespace('pgboss')` is NULL.
--
-- WHO RUNS THIS FILE. The bootstrap superuser, as its up file does (T-136 § contract §6: a
-- down file runs as its up file does; the `-- @run-as` marker belongs to the up file only, and
-- the lint refuses it here).
--
-- ORDER. Dependents first. The functions go first: `create_queue` and `delete_queue` read and
-- write `pgboss.queue`, and the three partition helpers are referenced by nothing else. Then
-- the tables, referencing before referenced: `job` and `job_dependency` before `queue`
-- (`job.q_fkey` and `job.dlq_fkey` reference `pgboss.queue(name)`), and `schedule` and
-- `subscription` before `queue` for the same reason. Then the enum, which `job.state` uses,
-- then the schema, which is empty by then.
--
-- NO CASCADE (gate:migration-lint R-CASCADE): if anything outside this migration still depends
-- on one of these objects, the DROP is refused and the transaction rolls back.
--
-- THE TWO PARTITIONED PARENTS. `pgboss.job` is PARTITION BY LIST (name) with `job_common` as
-- its DEFAULT partition, and `pgboss.queue_stats` is PARTITION BY RANGE (captured_on) with two
-- date-named partitions the up file's DO block creates for the apply date and the day after.
-- A partition is a dependent object of its parent, so `DROP TABLE <parent>` removes every
-- partition with it and no CASCADE and no dynamic SQL is needed — which is why the date-named
-- partitions, whose names this file cannot know, need no statement of their own. Measured on
-- this branch: `tasks/state/EP-2/T-146.md` § The gate, the `down` catalogue reading.

DROP FUNCTION pgboss.create_queue(text, jsonb);
DROP FUNCTION pgboss.delete_queue(text);
DROP FUNCTION pgboss.job_table_run_async(text, int, text, text, text);
DROP FUNCTION pgboss.job_table_run(text, text, text);
DROP FUNCTION pgboss.job_table_format(text, text);

DROP TABLE pgboss.job_dependency;
DROP TABLE pgboss.job;
DROP TABLE pgboss.queue_stats;
DROP TABLE pgboss.warning;
DROP TABLE pgboss.bam;
DROP TABLE pgboss.subscription;
DROP TABLE pgboss.schedule;
DROP TABLE pgboss.queue;
DROP TABLE pgboss.version;

DROP TYPE pgboss.job_state;

DROP SCHEMA pgboss;
