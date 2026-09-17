-- 0006_pgboss_schema.up.sql
--
-- @phase: expand
-- @run-as: bootstrap-superuser — OD-90; T-146 (CREATE SCHEMA needs CREATE on the database;
--   app_ddl holds CREATE on schema public only. Measured on this branch, Q3: app_ddl's
--   has_database_privilege(...,'CREATE') is false, and `SET ROLE app_ddl; CREATE SCHEMA ...`
--   is refused "permission denied for database kinvara" and does not land)
--
-- Ticket:  T-146 (tech-lead). Schema `pgboss` and pg-boss 12.26.4's tables, created by a
--          migration so that pg-boss never performs DDL at install time.
-- Spec:    SD §DB-1 line 1751 (one logical schema "plus `pgboss` for the job tables"; the
--          name `kinvara` is superseded by EV-4, `pgboss` stands) and line 1755 ("hand-written
--          SQL migration files for all DDL"); SD line 915 (pg-boss 12.26.4); SA §SA-5
--          lines 607-638.
-- Brief:   `tasks/state/EP-12/OD-90-cut.md` (the cut), plus the Q1 measurement in this
--          ticket's evidence file in place of a `## Migration request` (G8, orchestrator
--          ruling in that file).
-- Contracts: T-020 § contract §3-§4 (roles; no default privileges, every grant explicit);
--          T-021 (rework 2) / T-031 § contract §3.2-§3.3 (lint, numbering, @run-as);
--          T-136 § contract §6, §8 (principal); T-137 (rework 1) § contract §5 (tripwire);
--          T-138 § contract §4 and T-145 (rework 1) § contract — LIVE (schema `pgboss` is
--          admitted as deliberately out of scope by `db:introspect:check`).
--
-- WHERE THIS SQL COMES FROM (Q1, measured; evidence `tasks/state/EP-2/T-146.md` § Q1).
-- Every statement from `CREATE SCHEMA IF NOT EXISTS pgboss` down to the `INSERT INTO
-- pgboss.version` is pg-boss 12.26.4's OWN construction output, taken from its public API
-- `Contractor.constructionPlans('pgboss', { createSchema: true })` (equivalently the package
-- export `getConstructionPlans`), which is the same plan `pg-boss` would run itself at install
-- time. It is committed literally. Exactly two statement lines of that output were removed and
-- no line was edited: `BEGIN;` and `COMMIT;` (the output's leading blank line and its trailing
-- whitespace-only line also go, so three lines in all differ). The migration runner already
-- wraps each file in one transaction, and a file that ends the runner's transaction itself is a
-- MIGRATE FAIL with the work committed (T-136 § contract §5, case C3). pg-boss's own `SET LOCAL`
-- statements and its `pg_advisory_xact_lock` are kept as written.
--
-- WHY A MIGRATION AND NOT PG-BOSS'S INSTALLER. SD line 1755 puts all DDL in migration files,
-- and T-020 § contract §3-§4 gives the runtime role `app_rw` no `CREATE` and forbids default
-- privileges, so a self-installing pg-boss would have to be granted DDL rights the model
-- withholds. pg-boss is therefore run with `migrate: false`; see the grants below and this
-- ticket's § Q2.
--
-- WHO OWNS WHAT. This file runs as the bootstrap superuser, so schema `pgboss` and everything
-- in it is owned by the bootstrap superuser, as `kinvara_guard` is (0003). It is NOT handed to
-- `app_ddl`: T-020 § contract §3 makes `app_ddl` the owner of schema `public` and of what is
-- created in it, and this is a vendor schema no break-glass session should be able to reshape.
-- The consequence, stated rather than discovered: every later pg-boss schema change (a version
-- bump) is likewise a migration carrying `-- @run-as: bootstrap-superuser`.
--
-- THE SA §INT-10 GUARD. `CREATE SCHEMA`, `CREATE TABLE`, `CREATE FUNCTION` and `GRANT` are all
-- event-trigger tags of the guard 0003 relocated to `kinvara_guard`, so it fires throughout
-- this file. Nothing here grants `answering_service` anything, and schema `pgboss` is not
-- granted to PUBLIC, so the vendor role cannot even name an object in it.
--
-- NOT DETERMINISTIC ACROSS DAYS, BY PG-BOSS'S DESIGN. pg-boss's plan ends its `queue_stats`
-- section with a DO block that creates the daily partitions for TODAY and TOMORROW (UTC),
-- computing both the name and the bounds in SQL. So an `up` run on 2026-09-17 creates
-- `pgboss.queue_stats_20260917` and `pgboss.queue_stats_20260918`, and an `up` run on another
-- day creates that day's pair. The block is `IF NOT EXISTS`-guarded and idempotent. The
-- relations this migration creates are therefore the TEN fixed ones (bam, job, job_common,
-- job_dependency, queue, queue_stats, schedule, subscription, version, warning) plus exactly two
-- date-named `queue_stats_YYYYMMDD` partitions; see § Q1 and § Q4 in the evidence file.

    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint
  );
CREATE SCHEMA IF NOT EXISTS pgboss;

    CREATE TYPE pgboss.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  ;

    CREATE TABLE pgboss.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone
    )
  ;

    CREATE TABLE pgboss.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES pgboss.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
      partition bool NOT NULL,
      table_name text NOT NULL,
      deferred_count int NOT NULL default 0,
      queued_count int NOT NULL default 0,
      ready_count int NOT NULL default 0,
      warning_queued int NOT NULL default 0,
      active_count int NOT NULL default 0,
      failed_count int NOT NULL default 0,
      total_count int NOT NULL default 0,
      ready_history int[] NOT NULL default '{}',
      heartbeat_seconds int,
      notify bool NOT NULL DEFAULT false,
      singletons_active text[],
      monitor_on timestamp with time zone,
      maintain_on timestamp with time zone,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  ;

    CREATE TABLE pgboss.schedule (
      name text REFERENCES pgboss.queue ON DELETE CASCADE,
      key text not null DEFAULT '',
      cron text not null,
      timezone text,
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name, key)
    )
  ;

    CREATE TABLE pgboss.subscription (
      event text not null,
      name text not null REFERENCES pgboss.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  ;

    CREATE TABLE pgboss.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      -- clock_timestamp() (not now()) so multiple job_table_run_async() enqueues within a single
      -- migration transaction keep their insertion order — BAM applies queued commands in created_on
      -- order, and some migrations enqueue an ordered drop-then-rebuild pair (see migration v33).
      created_on timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  ;

    CREATE FUNCTION pgboss.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  ;

    CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE TABLE pgboss.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state pgboss.job_state not null default 'created',
      retry_limit integer not null default 2,
      retry_count integer not null default 0,
      retry_delay integer not null default 0,
      retry_backoff boolean not null default false,
      retry_delay_max integer,
      expire_seconds int not null default 900,
      deletion_seconds int not null default 604800,
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
      output jsonb,
      dead_letter text,
      policy text,
      heartbeat_on timestamp with time zone,
      heartbeat_seconds int,
      blocked boolean not null default false,
      blocking boolean not null default false,
      pending_dependencies int not null default 0,
      source_name text,
      source_id uuid,
      source_created_on timestamp with time zone,
      source_retry_count int
    ) PARTITION BY LIST (name)
  ;
ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id);

    CREATE TABLE pgboss.job_common (LIKE pgboss.job INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, 'job_common');

    ALTER TABLE pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;
  ;

    CREATE TABLE pgboss.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  ;
CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC);

    CREATE TABLE pgboss.queue_stats (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      name text NOT NULL,
      deferred_count int NOT NULL DEFAULT 0,
      queued_count   int NOT NULL DEFAULT 0,
      ready_count    int NOT NULL DEFAULT 0,
      active_count   int NOT NULL DEFAULT 0,
      failed_count   int NOT NULL DEFAULT 0,
      total_count    int NOT NULL DEFAULT 0,
      captured_on timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, captured_on)
    ) PARTITION BY RANGE (captured_on)
  ;
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);

    DO $$
    DECLARE
      d date;
      i int;
      part_name text;
    BEGIN
      FOR i IN 0..1 LOOP
        d := (now() AT TIME ZONE 'UTC')::date + i;
        part_name := 'queue_stats_' || to_char(d, 'YYYYMMDD');
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE pgboss.%I PARTITION OF pgboss.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  ;

    CREATE TABLE pgboss.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  ;
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id);

    CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO pgboss.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false)
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  ;
INSERT INTO pgboss.version(version) VALUES ('37');

-- ---------------------------------------------------------------------------
-- GRANTS. Everything below this line is Kinvara's, not pg-boss's.
--
-- There are no default privileges anywhere (T-020 § contract §4), so every privilege is
-- explicit and `gate:migration-lint` R-TABLE-GRANT requires a GRANT naming each table this
-- file creates.
--
-- `app_rw` only, exactly as Q2 measured it. `apps/core` and `apps/worker` connect as `app_rw`
-- (T-020 § contract §3). Q2 ran pg-boss 12.26.4 with `migrate: false`, `supervise: true` and
-- `schedule: true` as a login whose only membership is `app_rw`, holding the set below and no
-- `CREATE` on schema `pgboss`: start, create a queue, send, work, schedule, supervise,
-- getQueue, deleteQueue and stop all completed with no error, and the `pgboss` catalogue was
-- identical before and after.
--
-- NOTHING to `app_safety_rw`: SD §BE-3 line 1008 needs `safety-gw` to enqueue in its write
-- transaction and closes its grant set in the same sentence. That is OD-91 and it is with the
-- stakeholder; until it is ruled this migration grants `app_safety_rw` nothing.
-- NOTHING to `app_admin_rw` and NOTHING to `answering_service` (SA §INT-10: `SELECT` on
-- nothing, anywhere, ever).
--
-- NO `CREATE` ON SCHEMA `pgboss` TO ANY APPLICATION ROLE. The three pg-boss code paths that
-- do need it are all opt-in configuration and all three are refused 42501 without it (Q2
-- attacks A, B2 and C): a queue created with `partition: true`; `persistQueueStats: true`,
-- whose supervisor creates the next day's `queue_stats` partition; and `migrate: true`, i.e.
-- pg-boss's own self-migration. `T-148` and `T-149` must leave all three at their defaults.
--
-- The three partition-helper functions (`job_table_format`, `job_table_run`,
-- `job_table_run_async`) execute DDL through `EXECUTE`. PostgreSQL grants EXECUTE on a new
-- function to PUBLIC, so each is revoked and NOT granted to any application role: that is what
-- makes "no DDL at run time" a privilege fact and not a configuration convention.

REVOKE EXECUTE ON FUNCTION pgboss.job_table_format(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgboss.job_table_run(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgboss.job_table_run_async(text, int, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgboss.create_queue(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgboss.delete_queue(text) FROM PUBLIC;

GRANT USAGE ON SCHEMA pgboss TO app_rw;

GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.job TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.job_common TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.queue TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.schedule TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.subscription TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.bam TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.warning TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.queue_stats TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.job_dependency TO app_rw;
GRANT SELECT, UPDATE ON pgboss.version TO app_rw;

GRANT EXECUTE ON FUNCTION pgboss.create_queue(text, jsonb) TO app_rw;
GRANT EXECUTE ON FUNCTION pgboss.delete_queue(text) TO app_rw;
