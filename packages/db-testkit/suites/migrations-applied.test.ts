/**
 * T-137 — the harness applies EVERY committed migration, not `0001` alone.
 *
 * `acquireMigratedCluster` runs `T-136`'s `db:migrate up` against this suite's
 * cluster. This file checks the result from the database side, over its own
 * connection: the record, and the objects the migrations keyed in `CREATED_BY`
 * create.
 *
 * THE TRIPWIRE, in two halves (T-137 § Published contract (rework 1) §5).
 *
 *   1. `HIGHEST_COMMITTED` is a literal, not a reading of the directory, so the
 *      first test is anchored outside the thing it checks: a new up file in
 *      db/migrations turns it red.
 *   2. Moving the literal alone is not enough (tech-lead TV-F1, OD-82).
 *      `CREATED_BY` keys probes by migration number. The LAST describe block
 *      reads the highest up file in db/migrations and requires: at least one
 *      probe keyed to it; every one of those probes ran and held after `up`;
 *      and, after `db:migrate down --to <highest - 1>`, every one of them exits
 *      0 and no longer holds. A probe must therefore tell the new migration's
 *      state from the state below it.
 *
 * What it cannot see is WHICH object a probe names. Any reading that differs
 * between the two states satisfies it; the database's own record does.
 * Review checks that each probe names an object its migration creates.
 *
 * The down step changes the cluster, so its describe block stays LAST.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  acquireMigratedCluster,
  highestMigrationIn,
  judgeMigrateRun,
  MIGRATIONS_DIR,
  REPO_ROOT,
  SUPERUSER,
  type Cluster,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'migrations-applied';
const HIGHEST_COMMITTED = '0032';
const COMMITTED_DIR = path.join(REPO_ROOT, MIGRATIONS_DIR);
const RECORD_SQL = `SELECT coalesce(shobj_description(oid, 'pg_database'), '(no comment)')
                      FROM pg_database WHERE datname = current_database()`;

interface Probe {
  /** The test title. */
  readonly title: string;
  /**
   * One value, and it must not raise: it is read again after the down step,
   * where the object it names may be gone.
   */
  readonly sql: string;
  /** What `sql` returns once every committed migration is applied. */
  readonly holds: string;
}

/**
 * Probes, keyed by the migration whose objects they assert. The ticket that
 * adds a migration adds its entry here, in the same change set.
 */
const CREATED_BY: Readonly<
  Record<string, { readonly source: string; readonly probes: readonly Probe[] }>
> = {
  '0003': {
    source: 'T-143',
    probes: [
      {
        title: 'schema kinvara_guard exists, owned by the bootstrap superuser',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace
                              WHERE nspname = 'kinvara_guard'), '(absent)')`,
        holds: SUPERUSER,
      },
      {
        title:
          'the check function lives in kinvara_guard, and no schema but kinvara_guard holds one',
        sql: `SELECT coalesce(string_agg(n.nspname, ',' ORDER BY n.nspname), '(none)')
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE p.proname = 'assert_answering_service_write_only'`,
        holds: 'kinvara_guard',
      },
      {
        title: 'the event trigger calls the trigger function relocated into kinvara_guard',
        sql: `SELECT coalesce((SELECT n.nspname || '.' || p.proname
                               FROM pg_event_trigger e
                               JOIN pg_proc p ON p.oid = e.evtfoid
                               JOIN pg_namespace n ON n.oid = p.pronamespace
                              WHERE e.evtname = 'trg_int10_answering_service'), '(absent)')`,
        holds: 'kinvara_guard.trg_assert_answering_service_write_only',
      },
    ],
  },
  '0004': {
    source: 'T-144',
    probes: [
      {
        // Names the one relation 0004 creates. to_regclass returns NULL rather than raising
        // when the table is absent, so the reading still returns a value after the down step.
        title: 'table public.locale_registry exists',
        sql: `SELECT (to_regclass('public.locale_registry') IS NOT NULL)::text`,
        holds: 'true',
      },
    ],
  },
  '0005': {
    source: 'T-140',
    // Each probe names one object 0005 creates, and each reading returns a value (not an
    // error) once that object is gone: to_regclass and to_regtype return NULL for a missing name.
    probes: [
      {
        title: 'table public.account exists',
        sql: `SELECT (to_regclass('public.account') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'table public.account_role exists',
        sql: `SELECT (to_regclass('public.account_role') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'partial unique index public.sod_finance_ts exists',
        sql: `SELECT (to_regclass('public.sod_finance_ts') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'table public.app_session exists',
        sql: `SELECT (to_regclass('public.app_session') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'enum type public.account_status exists',
        sql: `SELECT (to_regtype('public.account_status') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'extension citext is installed',
        sql: `SELECT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citext'))::text`,
        holds: 'true',
      },
    ],
  },
  '0006': {
    source: 'T-146',
    // Each probe names one object 0006 creates, and each reading returns a value
    // rather than raising once that object is gone: to_regtype and to_regprocedure
    // return NULL for a missing name, and the catalogue reads are subqueries over
    // pg_namespace/pg_class that yield no row. The dated queue_stats partitions are
    // deliberately NOT probed: their names depend on the UTC date the file is
    // applied (pg-boss's own DO block computes them), so a probe on one would be a
    // reading of the clock, not of the migration.
    probes: [
      {
        title: 'schema pgboss exists, owned by the bootstrap superuser',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace
                              WHERE nspname = 'pgboss'), '(absent)')`,
        holds: SUPERUSER,
      },
      {
        title: 'pgboss.job exists and is a partitioned table (relkind p)',
        sql: `SELECT coalesce((SELECT c.relkind::text FROM pg_class c
                               JOIN pg_namespace n ON n.oid = c.relnamespace
                              WHERE n.nspname = 'pgboss' AND c.relname = 'job'), '(absent)')`,
        holds: 'p',
      },
      {
        title: 'pgboss.job_common is the DEFAULT partition of pgboss.job',
        sql: `SELECT coalesce((SELECT pg_get_expr(c.relpartbound, c.oid) FROM pg_class c
                               JOIN pg_namespace n ON n.oid = c.relnamespace
                              WHERE n.nspname = 'pgboss' AND c.relname = 'job_common'), '(absent)')`,
        holds: 'DEFAULT',
      },
      {
        title: 'enum type pgboss.job_state exists',
        sql: `SELECT (to_regtype('pgboss.job_state') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'function pgboss.create_queue(text, jsonb) exists',
        sql: `SELECT (to_regprocedure('pgboss.create_queue(text, jsonb)') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'app_rw holds USAGE on schema pgboss and not CREATE',
        sql: `SELECT coalesce((SELECT has_schema_privilege('app_rw', n.oid, 'USAGE')::text || ',' ||
                                     has_schema_privilege('app_rw', n.oid, 'CREATE')::text
                               FROM pg_namespace n WHERE n.nspname = 'pgboss'), '(absent)')`,
        holds: 'true,false',
      },
    ],
  },
  '0007': {
    source: 'T-030',
    // Each probe names one object 0007 creates, and each reading returns a value rather
    // than raising once that object is gone: to_regclass and to_regprocedure return NULL
    // for a missing name, and the trigger read is a count over pg_trigger.
    probes: [
      {
        title: 'table public.approval exists',
        sql: `SELECT (to_regclass('public.approval') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'function public.assert_second_actor_differs() exists',
        sql: `SELECT (to_regprocedure('public.assert_second_actor_differs()') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'trigger trg_approval_four_eyes exists',
        sql: `SELECT count(*)::text FROM pg_trigger WHERE tgname = 'trg_approval_four_eyes'`,
        holds: '1',
      },
    ],
  },
  '0008': {
    source: 'T-186',
    // Each probe names one object 0008 creates, or the replacement it makes, and each returns a
    // value rather than raising once it is gone: to_regprocedure returns NULL for a missing name,
    // the trigger read is a count, the privilege read names only roles 0001 creates, and the
    // prosrc read is a count over the function 0007 creates and 0008 replaces (its down restores
    // 0007's body, which has no status clause).
    probes: [
      {
        title: 'function public.assert_ts_senior_written_by_admin() exists',
        sql: `SELECT (to_regprocedure('public.assert_ts_senior_written_by_admin()') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'trigger trg_account_role_ts_senior_admin_only exists on account_role',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_account_role_ts_senior_admin_only'
                 AND tgrelid = 'public.account_role'::regclass`,
        holds: '1',
      },
      {
        title: 'app_admin_rw holds INSERT and UPDATE on account_role',
        sql: `SELECT has_table_privilege('app_admin_rw', 'public.account_role', 'INSERT')::text || ','
                     || has_table_privilege('app_admin_rw', 'public.account_role', 'UPDATE')::text`,
        holds: 'true,true',
      },
      {
        title: "assert_second_actor_differs() reads account.status = 'active' (OE-45)",
        sql: `SELECT count(*)::text FROM pg_proc
               WHERE oid = 'public.assert_second_actor_differs()'::regprocedure
                 AND prosrc LIKE '%a.status = ''active''%'`,
        holds: '1',
      },
    ],
  },
  '0009': {
    source: 'T-193',
    // 0009 creates no object: it replaces app_session_auth_method_check under the same name
    // (OE-28 (B)). The probe names that constraint and reads whether its definition admits
    // 'registration', which is what 0009 changes; after the down to 0008 the same constraint
    // exists without it. to_regclass keeps the reading from raising if app_session is absent.
    probes: [
      {
        title: "app_session_auth_method_check admits 'registration' (OE-28 (B))",
        sql: `SELECT count(*)::text FROM pg_constraint
               WHERE conname = 'app_session_auth_method_check'
                 AND conrelid = to_regclass('public.app_session')
                 AND pg_get_constraintdef(oid) LIKE '%''registration''::text%'`,
        holds: '1',
      },
    ],
  },
  '0010': {
    source: 'T-192',
    // 0010 creates no object: it re-issues app_admin_rw's COMMENT (T-186 C4 (i), OD-223). The
    // probe reads that COMMENT from pg_shdescription for the SA SEC-7 citation 0010 adds; 0001's
    // text, which the down restores, cites SEC-9 and not SEC-7. The role exists from 0001 on, so
    // the reading never raises. This suite's down step reverts only the highest migration (0011),
    // so this probe is checked after up only; 0010's down is measured in T-192's evidence (E1).
    probes: [
      {
        title: "app_admin_rw's COMMENT cites SA SEC-7 and SD's RLS tables (T-186 C4 (i))",
        sql: `SELECT (shobj_description(oid, 'pg_authid') LIKE '%per SA SEC-7%'
                      AND shobj_description(oid, 'pg_authid') LIKE '%lines 1309 and 3906%')::text
                FROM pg_roles WHERE rolname = 'app_admin_rw'`,
        holds: 'true',
      },
    ],
  },
  '0011': {
    source: 'T-192',
    // Each probe names one object 0011 creates, or the replacement or grant it makes, and each
    // returns a value rather than raising once it is gone: to_regprocedure returns NULL for a
    // missing name, the trigger reads are counts, the privilege read names a column 0005 creates
    // and a role 0001 creates, and the prosrc reads are counts: one over the function 0008 creates
    // and 0011 replaces (its down restores 0008's body, which has no app_rw clause), one over the
    // function 0011 creates (absent after its down).
    probes: [
      {
        title: 'function public.assert_ts_senior_account_written_by_admin() exists',
        sql: `SELECT (to_regprocedure('public.assert_ts_senior_account_written_by_admin()') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'trigger trg_account_ts_senior_status_admin_only exists on account (OE-48)',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_account_ts_senior_status_admin_only'
                 AND tgrelid = 'public.account'::regclass`,
        holds: '1',
      },
      {
        title: 'trigger trg_account_role_ts_senior_no_truncate exists on account_role (OD-224)',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_account_role_ts_senior_no_truncate'
                 AND tgrelid = 'public.account_role'::regclass`,
        holds: '1',
      },
      {
        title: 'app_admin_rw holds UPDATE on account.status',
        sql: `SELECT has_column_privilege('app_admin_rw', 'public.account', 'status', 'UPDATE')::text`,
        holds: 'true',
      },
      {
        title:
          "assert_ts_senior_written_by_admin() refuses a writer holding app_rw's privileges (T-186 C4 (iv))",
        sql: `SELECT count(*)::text FROM pg_proc
               WHERE oid = 'public.assert_ts_senior_written_by_admin()'::regprocedure
                 AND prosrc LIKE '%NOT pg_has_role(current_user, ''app_rw'', ''USAGE'')%'`,
        holds: '1',
      },
      {
        // T-227 (T-192 QA-B3): this probe used to be titled "admits only the nine status moves", and
        // it read three of the nine in 0011's source; adding a tenth left it green (QA QM4). 0012
        // replaces the body, so what this probe can still assert of 0011 at HEAD is the FOR SHARE read.
        // That no move but the nine is admitted is pinned by four-eyes.test.ts's 5×5 matrix (T-227),
        // and the exact pair list in the source by 0012's probe below.
        title:
          'assert_ts_senior_account_written_by_admin() locks its ts_senior read FOR SHARE (T-192 QA-A2)',
        sql: `SELECT count(*)::text FROM pg_proc
               WHERE oid = to_regprocedure('public.assert_ts_senior_account_written_by_admin()')
                 AND prosrc LIKE '%FOR SHARE%'`,
        holds: '1',
      },
    ],
  },
  '0012': {
    source: 'T-227',
    // 0012 creates no object: it replaces two trigger functions and changes two triggers' timing, in
    // place. Each probe reads one of those changes, and each returns a value rather than raising after
    // the down to 0011: the trigger reads are counts filtered on tgtype (0x02 = BEFORE, 0x04 INSERT,
    // 0x08 DELETE, 0x10 UPDATE); the prosrc reads are a count and a string_agg over to_regprocedure
    // (0011's bodies have no account lock and no typed pairs); the COMMENT read is a boolean.
    probes: [
      {
        title:
          'trg_account_ts_senior_status_admin_only fires AFTER UPDATE, not BEFORE (OD-237 TL-1)',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_account_ts_senior_status_admin_only'
                 AND tgrelid = 'public.account'::regclass
                 AND tgtype & 2 = 0 AND tgtype & 16 = 16`,
        holds: '1',
      },
      {
        title:
          'trg_account_role_ts_senior_admin_only fires AFTER INSERT OR UPDATE OR DELETE, not BEFORE (OD-237 TL-1)',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_account_role_ts_senior_admin_only'
                 AND tgrelid = 'public.account_role'::regclass
                 AND tgtype & 2 = 0 AND tgtype & 28 = 28`,
        holds: '1',
      },
      {
        title:
          'assert_ts_senior_written_by_admin() locks the account row FOR SHARE when a ts_senior row becomes live (OE-59)',
        sql: `SELECT count(*)::text FROM pg_proc
               WHERE oid = to_regprocedure('public.assert_ts_senior_written_by_admin()')
                 AND prosrc LIKE '%FROM public.account a WHERE a.id = NEW.account_id FOR SHARE;%'`,
        holds: '1',
      },
      {
        // The SOURCE's pair list, exactly: a tenth pair, or a missing one, changes the string. It reads
        // text, not behaviour; four-eyes.test.ts's 5×5 matrix pins what the guard admits.
        title:
          "the account guard's source lists exactly the nine typed (OLD, NEW) status pairs (T-192 QA-B3)",
        sql: `SELECT coalesce((SELECT string_agg(m[1] || '>' || m[2], ',' ORDER BY m[1] || '>' || m[2])
                                FROM pg_proc p,
                                     regexp_matches(p.prosrc,
                                       '\\(''([a-z]+)''(?:::public\\.account_status)?, ''([a-z]+)''(?:::public\\.account_status)?\\)',
                                       'g') AS m
                               WHERE p.oid = to_regprocedure('public.assert_ts_senior_account_written_by_admin()')),
                              '(none)')`,
        holds:
          'active>erased,active>removed,active>suspended,pending>erased,pending>removed,pending>suspended,removed>erased,suspended>erased,suspended>removed',
      },
      {
        title:
          "the account guard's COMMENT is re-issued with the NULL clause (T-192 QA-B2, C3 (iii))",
        sql: `SELECT coalesce((obj_description(to_regprocedure('public.assert_ts_senior_account_written_by_admin()'), 'pg_proc')
                               LIKE '%(a NULL status included)%')::text, 'false')`,
        holds: 'true',
      },
    ],
  },
  '0013': {
    source: 'T-194',
    // Each probe names one object 0013 creates, and each returns a value rather than raising once it
    // is gone: to_regclass and to_regprocedure return NULL for a missing name (coalesced), and the
    // trigger read is a count. The index probe reads its definition, so it asserts SD 1835's columns
    // and order as well as the name PostgreSQL chose for the unnamed index.
    probes: [
      {
        title: 'table public.otp_challenge exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.otp_challenge')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title:
          'index otp_challenge_phone_e164_expires_at_idx is (phone_e164, expires_at DESC) (SD 1835)',
        sql: `SELECT coalesce(pg_get_indexdef(to_regclass('public.otp_challenge_phone_e164_expires_at_idx')),
                              '(absent)')`,
        holds:
          'CREATE INDEX otp_challenge_phone_e164_expires_at_idx ON public.otp_challenge USING btree (phone_e164, expires_at DESC)',
      },
      {
        title:
          "otp_challenge's ACL: app_rw SELECT, INSERT on five columns, UPDATE on attempts and consumed_at (U-O6, OE-60, OE-61)",
        sql: `SELECT coalesce((SELECT c.relacl::text || ' ' ||
                                      (SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
                                         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL)
                                 FROM pg_class c WHERE c.oid = to_regclass('public.otp_challenge')), '(absent)')`,
        holds:
          '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} id={app_rw=a/app_ddl},phone_e164={app_rw=a/app_ddl},' +
          'code_hash={app_rw=a/app_ddl},attempts={app_rw=w/app_ddl},expires_at={app_rw=a/app_ddl},' +
          'consumed_at={app_rw=w/app_ddl},created_ip_prefix={app_rw=a/app_ddl}',
      },
      {
        title: 'function public.assert_otp_challenge_single_use() exists',
        sql: `SELECT (to_regprocedure('public.assert_otp_challenge_single_use()') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title:
          'trigger trg_otp_challenge_single_use fires AFTER UPDATE FOR EACH ROW on otp_challenge (U-O5)',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_otp_challenge_single_use'
                 AND tgrelid = to_regclass('public.otp_challenge')
                 AND tgtype = 17`,
        holds: '1',
      },
      {
        title:
          'trigger trg_otp_challenge_created_at fires BEFORE INSERT FOR EACH ROW on otp_challenge (OE-61)',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_otp_challenge_created_at'
                 AND tgrelid = to_regclass('public.otp_challenge')
                 AND tgtype = 7
                 AND tgfoid = coalesce(to_regprocedure('public.set_otp_challenge_created_at()'), 0)`,
        holds: '1',
      },
    ],
  },
  '0014': {
    source: 'T-231',
    // 0014 creates no object: it replaces kinvara_guard.assert_answering_service_write_only() in
    // place (CREATE OR REPLACE; OID, owner, ACL and COMMENT kept), adding one branch to check (6)
    // that reads column-level INSERT (OD-242), and a check (18) refusing grant options and ADMIN
    // OPTION (OE-62). Each probe reads its addition from the function's source; the down restores
    // 0003's body, which has neither, so each reads '0' there. They are counts, so they never raise.
    // The behaviour is int10-write-only's OD-242 and OE-62 cases.
    probes: [
      {
        title:
          'the INT-10 guard reads column-level INSERT outside out_of_hours_report, disjoint from check (5) (OD-242)',
        sql: `SELECT count(*)::text FROM pg_proc
               WHERE oid = to_regprocedure('kinvara_guard.assert_answering_service_write_only()')
                 AND prosrc LIKE '%answering_service holds column privilege INSERT on %'
                 AND prosrc LIKE '%AND NOT has_table_privilege(k_oid, c.oid, ''INSERT'')%'`,
        holds: '1',
      },
      {
        title:
          'the INT-10 guard refuses a grant option and ADMIN OPTION on answering_service, check (18) (OE-62)',
        sql: `SELECT count(*)::text FROM pg_proc
               WHERE oid = to_regprocedure('kinvara_guard.assert_answering_service_write_only()')
                 AND prosrc LIKE '%has_table_privilege(k_oid, c.oid, p.priv || '' WITH GRANT OPTION'')%'
                 AND prosrc LIKE '%pg_has_role(r.oid, k_oid, ''MEMBER WITH ADMIN OPTION'')%'`,
        holds: '1',
      },
    ],
  },
  '0015': {
    source: 'T-195',
    // Each probe names one object 0015 creates, and each returns a value rather than raising once it
    // is gone: to_regclass and to_regprocedure return NULL for a missing name (coalesced), and the
    // constraint and trigger reads are counts or coalesced definitions.
    probes: [
      {
        title: 'table public.magic_link exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.magic_link')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title:
          'index magic_link_account_id_live_idx is (account_id) WHERE consumed_at IS NULL (U-M4, rulings E.1)',
        sql: `SELECT coalesce(pg_get_indexdef(to_regclass('public.magic_link_account_id_live_idx')), '(absent)')`,
        holds:
          'CREATE INDEX magic_link_account_id_live_idx ON public.magic_link USING btree (account_id) WHERE (consumed_at IS NULL)',
      },
      {
        title:
          'magic_link_account_id_fkey references account(id) ON DELETE CASCADE, ON UPDATE NO ACTION (U-M1)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) || ' del=' || confdeltype::text || ' upd=' || confupdtype::text
                                 FROM pg_constraint
                                WHERE conrelid = to_regclass('public.magic_link')
                                  AND conname = 'magic_link_account_id_fkey'), '(absent)')`,
        holds: 'FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE del=c upd=a',
      },
      {
        title:
          "magic_link's ACL: app_rw SELECT, INSERT on five columns, UPDATE on consumed_at only (U-M6)",
        sql: `SELECT coalesce((SELECT c.relacl::text || ' ' ||
                                      (SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
                                         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL)
                                 FROM pg_class c WHERE c.oid = to_regclass('public.magic_link')), '(absent)')`,
        holds:
          '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} id={app_rw=a/app_ddl},account_id={app_rw=a/app_ddl},' +
          'token_hash={app_rw=a/app_ddl},expires_at={app_rw=a/app_ddl},consumed_at={app_rw=w/app_ddl},' +
          'requested_device_fingerprint={app_rw=a/app_ddl}',
      },
      {
        title:
          'trigger trg_magic_link_single_use fires AFTER UPDATE FOR EACH ROW on magic_link, calling assert_magic_link_single_use()',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_magic_link_single_use'
                 AND tgrelid = to_regclass('public.magic_link')
                 AND tgtype = 17
                 AND tgfoid = coalesce(to_regprocedure('public.assert_magic_link_single_use()'), 0)`,
        holds: '1',
      },
      {
        title:
          'trigger trg_magic_link_created_at fires BEFORE INSERT FOR EACH ROW on magic_link, calling set_magic_link_created_at() (OE-63)',
        sql: `SELECT count(*)::text FROM pg_trigger
               WHERE tgname = 'trg_magic_link_created_at'
                 AND tgrelid = to_regclass('public.magic_link')
                 AND tgtype = 7
                 AND tgfoid = coalesce(to_regprocedure('public.set_magic_link_created_at()'), 0)`,
        holds: '1',
      },
      {
        title:
          'magic_link_ttl_check bounds expires_at to 10 minutes after created_at (OE-63, EV-13)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.magic_link')
                                 AND conname = 'magic_link_ttl_check'), '(absent)')`,
        holds:
          "CHECK (((expires_at > created_at) AND ((expires_at - created_at) <= '00:10:00'::interval)))",
      },
    ],
  },
  '0016': {
    source: 'T-196',
    // Each probe names one object 0016 creates, and each returns a value rather than raising once it
    // is gone: to_regclass returns NULL for a missing name (coalesced), and the constraint reads are
    // coalesced definitions. 0016 creates no function and no trigger.
    probes: [
      {
        title: 'table public.webauthn_credential exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.webauthn_credential')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title:
          "webauthn_credential's columns are SD 1823-1828's nine, sign_count bigint NOT NULL DEFAULT 0 (U-W1)",
        sql: `SELECT coalesce((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                                                 a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
                                                 ',' ORDER BY a.attnum)
                                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                WHERE a.attrelid = to_regclass('public.webauthn_credential') AND a.attnum > 0
                                  AND NOT a.attisdropped), '(absent)')`,
        holds:
          'id:character(26):true:-,account_id:character(26):true:-,credential_id:bytea:true:-,' +
          'public_key:bytea:true:-,sign_count:bigint:true:0,transports:text[]:false:-,aaguid:uuid:false:-,' +
          'created_at:timestamp with time zone:true:now(),last_used_at:timestamp with time zone:false:-',
      },
      {
        title: 'index webauthn_credential_account_id_idx is (account_id) (U-W3)',
        sql: `SELECT coalesce(pg_get_indexdef(to_regclass('public.webauthn_credential_account_id_idx')), '(absent)')`,
        holds:
          'CREATE INDEX webauthn_credential_account_id_idx ON public.webauthn_credential USING btree (account_id)',
      },
      {
        title:
          'webauthn_credential_account_id_fkey references account(id) ON DELETE CASCADE, ON UPDATE NO ACTION (SD 1824)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) || ' del=' || confdeltype::text || ' upd=' || confupdtype::text
                                 FROM pg_constraint
                                WHERE conrelid = to_regclass('public.webauthn_credential')
                                  AND conname = 'webauthn_credential_account_id_fkey'), '(absent)')`,
        holds: 'FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE del=c upd=a',
      },
      {
        title: 'webauthn_credential_credential_id_key is UNIQUE (credential_id) (SD 1825)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.webauthn_credential')
                                 AND conname = 'webauthn_credential_credential_id_key'), '(absent)')`,
        holds: 'UNIQUE (credential_id)',
      },
      {
        title: 'webauthn_credential_sign_count_range holds sign_count to 0..4294967295 (U-W2)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.webauthn_credential')
                                 AND conname = 'webauthn_credential_sign_count_range'), '(absent)')`,
        holds: "CHECK (((sign_count >= 0) AND (sign_count <= '4294967295'::bigint)))",
      },
      {
        title:
          "webauthn_credential's ACL: app_rw SELECT and DELETE (U-W4), INSERT on seven columns, UPDATE on sign_count and last_used_at; nothing to app_admin_rw (C2 (c))",
        sql: `SELECT coalesce((SELECT c.relacl::text || ' ' ||
                                      (SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
                                         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL)
                                 FROM pg_class c WHERE c.oid = to_regclass('public.webauthn_credential')), '(absent)')`,
        holds:
          '{app_ddl=arwdDxtm/app_ddl,app_rw=rd/app_ddl} id={app_rw=a/app_ddl},account_id={app_rw=a/app_ddl},' +
          'credential_id={app_rw=a/app_ddl},public_key={app_rw=a/app_ddl},sign_count={app_rw=aw/app_ddl},' +
          'transports={app_rw=a/app_ddl},aaguid={app_rw=a/app_ddl},last_used_at={app_rw=w/app_ddl}',
      },
      {
        title: 'webauthn_credential has no row-level security, enabled or forced (C2 (c))',
        sql: `SELECT coalesce((SELECT relrowsecurity::text || ',' || relforcerowsecurity::text FROM pg_class
                               WHERE oid = to_regclass('public.webauthn_credential')), '(absent)')`,
        holds: 'false,false',
      },
    ],
  },
  '0017': {
    source: 'T-226',
    // Each probe names one object 0017 creates, and each returns a value rather than raising once it
    // is gone: to_regclass returns NULL for a missing name (coalesced), and the constraint reads are
    // coalesced definitions. 0017 creates no function, no trigger and no rule.
    probes: [
      {
        title: 'table public.account_sso_identity exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.account_sso_identity')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title:
          "account_sso_identity's columns are account_id char(26), subject text, bound_at timestamptz DEFAULT now(), all NOT NULL",
        sql: `SELECT coalesce((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                                                 a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
                                                 ',' ORDER BY a.attnum)
                                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                WHERE a.attrelid = to_regclass('public.account_sso_identity') AND a.attnum > 0
                                  AND NOT a.attisdropped), '(absent)')`,
        holds:
          'account_id:character(26):true:-,subject:text:true:-,bound_at:timestamp with time zone:true:now()',
      },
      {
        title:
          'account_sso_identity_pkey is PRIMARY KEY (account_id): one subject per account (OE-55)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.account_sso_identity')
                                 AND conname = 'account_sso_identity_pkey'), '(absent)')`,
        holds: 'PRIMARY KEY (account_id)',
      },
      {
        title:
          'account_sso_identity_subject_key is UNIQUE (subject): one account per subject (OE-55)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.account_sso_identity')
                                 AND conname = 'account_sso_identity_subject_key'), '(absent)')`,
        holds: 'UNIQUE (subject)',
      },
      {
        title:
          'account_sso_identity_account_id_fkey references account(id) ON DELETE CASCADE, ON UPDATE NO ACTION',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) || ' del=' || confdeltype::text || ' upd=' || confupdtype::text
                                 FROM pg_constraint
                                WHERE conrelid = to_regclass('public.account_sso_identity')
                                  AND conname = 'account_sso_identity_account_id_fkey'), '(absent)')`,
        holds: 'FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE del=c upd=a',
      },
      {
        title:
          "account_sso_identity's ACL: app_rw SELECT and INSERT (account_id, subject) only; nothing to any other role",
        sql: `SELECT coalesce((SELECT c.relacl::text || ' ' ||
                                      (SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
                                         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL)
                                 FROM pg_class c WHERE c.oid = to_regclass('public.account_sso_identity')), '(absent)')`,
        holds:
          '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} account_id={app_rw=a/app_ddl},subject={app_rw=a/app_ddl}',
      },
    ],
  },
  '0018': {
    source: 'T-212',
    // Each probe names one object 0018 creates, and each returns a value rather than raising once it
    // is gone: to_regclass returns NULL for a missing name (coalesced), and the constraint, index and
    // sequence reads are coalesced definitions. 0018 creates no function, no trigger and no rule.
    probes: [
      {
        title: 'table public.audit_outbox exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.audit_outbox')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title:
          "audit_outbox's columns are id bigint GENERATED ALWAYS AS IDENTITY, payload jsonb, created_at timestamptz DEFAULT now(), relayed_at timestamptz",
        sql: `SELECT coalesce((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                                                 a.attnotnull::text || ':' || a.attidentity::text || ':' ||
                                                 coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY a.attnum)
                                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                WHERE a.attrelid = to_regclass('public.audit_outbox') AND a.attnum > 0
                                  AND NOT a.attisdropped), '(absent)')`,
        holds:
          'id:bigint:true:a:-,payload:jsonb:true::-,created_at:timestamp with time zone:true::now(),relayed_at:timestamp with time zone:false::-',
      },
      {
        title:
          'audit_outbox_pkey is PRIMARY KEY (id), and its identity sequence is audit_outbox_id_seq',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) || ' ' || pg_get_serial_sequence('public.audit_outbox', 'id')
                                 FROM pg_constraint
                                WHERE conrelid = to_regclass('public.audit_outbox')
                                  AND conname = 'audit_outbox_pkey'), '(absent)')`,
        holds: 'PRIMARY KEY (id) public.audit_outbox_id_seq',
      },
      {
        title: "audit_outbox_payload_object is CHECK (jsonb_typeof(payload) = 'object') (U-10 (1))",
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.audit_outbox')
                                 AND conname = 'audit_outbox_payload_object'), '(absent)')`,
        holds: "CHECK ((jsonb_typeof(payload) = 'object'::text))",
      },
      {
        title:
          'audit_outbox_created_at_unrelayed_idx is (created_at) WHERE relayed_at IS NULL (SD 2854)',
        sql: `SELECT coalesce((SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i
                               WHERE i.indexrelid = to_regclass('public.audit_outbox_created_at_unrelayed_idx')), '(absent)')`,
        holds:
          'CREATE INDEX audit_outbox_created_at_unrelayed_idx ON public.audit_outbox USING btree (created_at) WHERE (relayed_at IS NULL)',
      },
      {
        title:
          "audit_outbox's ACL: app_rw SELECT, INSERT (payload) and UPDATE (relayed_at) only; nothing to any other role",
        sql: `SELECT coalesce((SELECT c.relacl::text || ' ' ||
                                      (SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
                                         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL)
                                 FROM pg_class c WHERE c.oid = to_regclass('public.audit_outbox')), '(absent)')`,
        holds:
          '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} payload={app_rw=a/app_ddl},relayed_at={app_rw=w/app_ddl}',
      },
    ],
  },
  '0019': {
    source: 'T-213',
    // Each probe names one object 0019 creates, and each returns a value rather than raising once it
    // is gone: to_regclass returns NULL for a missing name (coalesced), and the constraint and
    // sequence reads are coalesced definitions. 0019 creates no function, no trigger and no rule.
    probes: [
      {
        title: 'table public.audit_anchor exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.audit_anchor')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title:
          "audit_anchor's columns are id bigint GENERATED ALWAYS AS IDENTITY, head_seq bigint, head_hash bytea, s3_key text, anchored_at timestamptz DEFAULT now(), all NOT NULL",
        sql: `SELECT coalesce((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                                                 a.attnotnull::text || ':' || a.attidentity::text || ':' ||
                                                 coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY a.attnum)
                                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                WHERE a.attrelid = to_regclass('public.audit_anchor') AND a.attnum > 0
                                  AND NOT a.attisdropped), '(absent)')`,
        holds:
          'id:bigint:true:a:-,head_seq:bigint:true::-,head_hash:bytea:true::-,s3_key:text:true::-,anchored_at:timestamp with time zone:true::now()',
      },
      {
        title:
          'audit_anchor_pkey is PRIMARY KEY (id), and its identity sequence is audit_anchor_id_seq',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) || ' ' || pg_get_serial_sequence('public.audit_anchor', 'id')
                                 FROM pg_constraint
                                WHERE conrelid = to_regclass('public.audit_anchor')
                                  AND conname = 'audit_anchor_pkey'), '(absent)')`,
        holds: 'PRIMARY KEY (id) public.audit_anchor_id_seq',
      },
      {
        title: 'audit_anchor_head_seq_key is UNIQUE (head_seq) (U-11 (2a))',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.audit_anchor')
                                 AND conname = 'audit_anchor_head_seq_key'), '(absent)')`,
        holds: 'UNIQUE (head_seq)',
      },
      {
        title: 'audit_anchor_head_hash_len is CHECK (octet_length(head_hash) = 32) (U-5 (5))',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.audit_anchor')
                                 AND conname = 'audit_anchor_head_hash_len'), '(absent)')`,
        holds: 'CHECK ((octet_length(head_hash) = 32))',
      },
      {
        title:
          "audit_anchor's ACL: app_rw SELECT and INSERT (head_seq, head_hash, s3_key) only; nothing to any other role",
        sql: `SELECT coalesce((SELECT c.relacl::text || ' ' ||
                                      (SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
                                         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL)
                                 FROM pg_class c WHERE c.oid = to_regclass('public.audit_anchor')), '(absent)')`,
        holds:
          '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} head_seq={app_rw=a/app_ddl},head_hash={app_rw=a/app_ddl},s3_key={app_rw=a/app_ddl}',
      },
    ],
  },
  '0020': {
    source: 'T-214',
    // Each probe names one object 0020 creates, and each returns a value rather than raising once it
    // is gone: to_regclass returns NULL for a missing name (coalesced), and the constraint, sequence,
    // partition and ACL reads are coalesced. 0020 creates no function, no trigger and no rule.
    probes: [
      {
        title:
          'partitioned table public.audit_log exists, owned by app_ddl, PARTITION BY RANGE (occurred_at)',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) || ' ' || relkind::text || ' ' || pg_get_partkeydef(oid) FROM pg_class
                               WHERE oid = to_regclass('public.audit_log')), '(absent)')`,
        holds: 'app_ddl p RANGE (occurred_at)',
      },
      {
        title:
          "audit_log's columns are SD 2836-2846's sixteen with seq an identity, then source_outbox_id bigint (OE-72 RQ-2)",
        sql: `SELECT coalesce((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                                                 a.attnotnull::text || ':' || a.attidentity::text, ',' ORDER BY a.attnum)
                                 FROM pg_attribute a
                                WHERE a.attrelid = to_regclass('public.audit_log') AND a.attnum > 0
                                  AND NOT a.attisdropped), '(absent)')`,
        holds:
          'seq:bigint:true:a,occurred_at:timestamp with time zone:true:,actor_type:text:true:,actor_id:character(26):false:,action:text:true:,subject_type:text:true:,subject_id:character(26):false:,data_class:text:false:,policy_basis:text:false:,reason_code:text:false:,rationale:text:false:,before_hash:bytea:false:,after_hash:bytea:false:,request_context:jsonb:true:,prev_entry_hash:bytea:true:,entry_hash:bytea:true:,source_outbox_id:bigint:false:',
      },
      {
        title:
          'audit_log_pkey is PRIMARY KEY (seq, occurred_at) (U-2), and the identity sequence is audit_log_seq_seq',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) || ' ' || pg_get_serial_sequence('public.audit_log', 'seq')
                                 FROM pg_constraint
                                WHERE conrelid = to_regclass('public.audit_log')
                                  AND conname = 'audit_log_pkey'), '(absent)')`,
        holds: 'PRIMARY KEY (seq, occurred_at) public.audit_log_seq_seq',
      },
      {
        title:
          'audit_log_source_outbox_id_occurred_at_key is UNIQUE (source_outbox_id, occurred_at) (OE-72 RQ-2)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.audit_log')
                                 AND conname = 'audit_log_source_outbox_id_occurred_at_key'), '(absent)')`,
        holds: 'UNIQUE (source_outbox_id, occurred_at)',
      },
      {
        title:
          'audit_log_prev_entry_hash_len and audit_log_entry_hash_len are the 32-byte CHECKs (U-5 (5))',
        sql: `SELECT coalesce((SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), ' ; ' ORDER BY conname)
                                 FROM pg_constraint WHERE conrelid = to_regclass('public.audit_log')
                                  AND conname IN ('audit_log_prev_entry_hash_len', 'audit_log_entry_hash_len')), '(absent)')`,
        holds:
          'audit_log_entry_hash_len CHECK ((octet_length(entry_hash) = 32)) ; audit_log_prev_entry_hash_len CHECK ((octet_length(prev_entry_hash) = 32))',
      },
      {
        title:
          'exactly 36 partitions, audit_log_p202610 first and audit_log_p202909 last, each with its own app_rw SELECT grant (U-3)',
        sql: `SELECT coalesce((SELECT count(*) || ' ' || min(c.relname) || ' ' || max(c.relname) || ' with app_rw SELECT: ' ||
                                      count(*) FILTER (WHERE c.relacl::text = '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}')
                                 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                                WHERE i.inhparent = to_regclass('public.audit_log')
                               HAVING count(*) > 0), '(absent)')`,
        holds: '36 audit_log_p202610 audit_log_p202909 with app_rw SELECT: 36',
      },
      {
        title:
          "audit_log's ACL: app_rw SELECT, and INSERT on every column but seq, prev_entry_hash and entry_hash; nothing to any other role",
        sql: `SELECT coalesce((SELECT c.relacl::text || ' ' ||
                                      (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
                                         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl::text = '{app_rw=a/app_ddl}')
                                 FROM pg_class c WHERE c.oid = to_regclass('public.audit_log')), '(absent)')`,
        holds:
          '{app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} occurred_at,actor_type,actor_id,action,subject_type,subject_id,data_class,policy_basis,reason_code,rationale,before_hash,after_hash,request_context,source_outbox_id',
      },
    ],
  },
  '0021': {
    source: 'T-215',
    // Each probe names one object 0021 creates (the function audit_log_chain() or the trigger
    // trg_audit_log_chain), and each returns a value rather than raising once it is gone:
    // to_regprocedure returns NULL for a missing function, and every read is coalesced.
    probes: [
      {
        title:
          'function public.audit_log_chain() exists: owner app_ddl, SECURITY DEFINER, EXECUTE revoked from PUBLIC, search_path pinned',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(proowner) || ' ' || prosecdef::text || ' ' || proacl::text || ' ' ||
                                      array_to_string(proconfig, ';')
                                 FROM pg_proc WHERE oid = to_regprocedure('public.audit_log_chain()')), '(absent)')`,
        holds: 'app_ddl true {app_ddl=X/app_ddl} search_path=pg_catalog, pg_temp',
      },
      {
        title:
          'trigger trg_audit_log_chain is BEFORE INSERT FOR EACH ROW on public.audit_log, enabled, executing audit_log_chain()',
        sql: `SELECT coalesce((SELECT tgtype::text || ' ' || tgenabled::text FROM pg_trigger
                               WHERE tgrelid = to_regclass('public.audit_log') AND tgname = 'trg_audit_log_chain'
                                 AND tgfoid = to_regprocedure('public.audit_log_chain()')), '(absent)')`,
        holds: '7 O',
      },
      {
        title: 'trg_audit_log_chain is cloned to all 36 partitions (37 trigger rows, 36 clones)',
        sql: `SELECT coalesce((SELECT count(*) || ' ' || count(*) FILTER (WHERE tgparentid <> 0) FROM pg_trigger
                               WHERE tgname = 'trg_audit_log_chain' AND tgfoid = to_regprocedure('public.audit_log_chain()')
                              HAVING count(*) > 0), '(absent)')`,
        holds: '37 36',
      },
    ],
  },
  '0022': {
    source: 'T-240',
    // 0022 creates no object: it changes the ACL of the 21 pg_catalog advisory-lock functions. Each
    // probe names those functions and reads their privileges, which differ between 0021 (a NULL ACL:
    // EXECUTE for PUBLIC) and 0022.
    probes: [
      {
        title:
          'PUBLIC holds EXECUTE on none of the 21 pg_catalog advisory-lock functions, so answering_service, app_safety_rw and app_admin_rw may EXECUTE none',
        sql: `SELECT count(*) FILTER (WHERE a.grantee = 0) || ' ' ||
                     (SELECT count(*) FILTER (WHERE has_function_privilege(r, p2.oid, 'EXECUTE'))
                        FROM unnest(ARRAY['answering_service','app_safety_rw','app_admin_rw']) r
                       CROSS JOIN pg_proc p2
                       WHERE p2.pronamespace = 'pg_catalog'::regnamespace AND p2.proname ~ '^pg_(try_)?advisory_')
                FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_'`,
        holds: '0 0',
      },
      {
        title:
          'app_rw holds EXECUTE on pg_advisory_xact_lock(bigint) and (integer, integer) only; app_ddl on pg_advisory_xact_lock(bigint) only, granted explicitly',
        sql: `SELECT coalesce(string_agg(pg_get_userbyid(a.grantee) || ':' || replace(p.oid::regprocedure::text, ' ', ''), ' '
                                     ORDER BY pg_get_userbyid(a.grantee) || ':' || replace(p.oid::regprocedure::text, ' ', '') COLLATE "C"), '(none)')
                FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
               WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_'
                 AND a.grantee IN ('app_rw'::regrole, 'app_ddl'::regrole)`,
        holds:
          'app_ddl:pg_advisory_xact_lock(bigint) app_rw:pg_advisory_xact_lock(bigint) app_rw:pg_advisory_xact_lock(integer,integer)',
      },
    ],
  },
  '0023': {
    source: 'T-206',
    // Each probe names one object 0023 creates (one of its three tables, or the exclusion constraint
    // on staffed_interval), and each returns a value rather than raising once it is gone: to_regclass
    // returns NULL for a missing name (coalesced), and the constraint and ACL reads are coalesced.
    // 0023 creates no function, no trigger and no rule.
    probes: [
      {
        title: 'table public.staffed_schedule_version exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.staffed_schedule_version')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title: 'table public.staffed_interval exists, owned by app_ddl',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.staffed_interval')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title: 'table public.staffed_schedule_current exists, owned by app_ddl (E.2 U-3)',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) FROM pg_class
                               WHERE oid = to_regclass('public.staffed_schedule_current')), '(absent)')`,
        holds: 'app_ddl',
      },
      {
        title:
          "staffed_interval's exclusion constraint (contype 'x') is EXCLUDE USING gist (version_id WITH =, span WITH &&), SD 3180 verbatim (V1)",
        sql: `SELECT coalesce((SELECT string_agg(conname || ' ' || contype::text || ' ' || pg_get_constraintdef(oid), ' ; ')
                                 FROM pg_constraint
                                WHERE conrelid = to_regclass('public.staffed_interval') AND contype = 'x'), '(absent)')`,
        holds:
          'staffed_interval_version_id_span_excl x EXCLUDE USING gist (version_id WITH =, span WITH &&)',
      },
      {
        title:
          'staffed_interval_span_shape is CHECK (non-empty, both bounds present and finite, lower included, upper excluded) (U-15 (a), OE-77)',
        sql: `SELECT coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conrelid = to_regclass('public.staffed_interval')
                                 AND conname = 'staffed_interval_span_shape'), '(absent)')`,
        holds:
          'CHECK (((NOT isempty(span)) AND (NOT lower_inf(span)) AND (NOT upper_inf(span)) AND lower_inc(span) AND (NOT upper_inc(span)) AND isfinite(lower(span)) AND isfinite(upper(span))))',
      },
      {
        title:
          "the three tables' ACLs: app_rw only (SELECT; version INSERT on seven columns and UPDATE (superseded_at); interval INSERT; pointer INSERT and UPDATE (current_version_id))",
        sql: `SELECT coalesce((SELECT string_agg(c.relname || ' ' || c.relacl::text || ' ' ||
                                      coalesce((SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
                                                  FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL), '-'),
                                      ' ; ' ORDER BY c.relname)
                                 FROM pg_class c
                                WHERE c.oid IN (to_regclass('public.staffed_schedule_version'), to_regclass('public.staffed_interval'),
                                                to_regclass('public.staffed_schedule_current'))), '(absent)')`,
        holds:
          'staffed_interval {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl} - ; ' +
          'staffed_schedule_current {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl} current_version_id={app_rw=w/app_ddl} ; ' +
          'staffed_schedule_version {app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} id={app_rw=a/app_ddl},jurisdiction={app_rw=a/app_ddl},' +
          'effective_from={app_rw=a/app_ddl},published_by={app_rw=a/app_ddl},approval_id={app_rw=a/app_ddl},pattern={app_rw=a/app_ddl},' +
          'note={app_rw=a/app_ddl},superseded_at={app_rw=w/app_ddl}',
      },
    ],
  },
  '0024': {
    source: 'T-251',
    // Each probe names the one table 0024 creates and returns a value rather than raising once it is
    // gone: to_regclass returns NULL for a missing name, and the ACL read is coalesced. The seed rows
    // are asserted by suites/credential-scheme.test.ts, not here (T-137 TV2-A1: a probe names an object).
    probes: [
      {
        title: 'table public.credential_scheme exists (CUT-T-060 R-9)',
        sql: `SELECT (to_regclass('public.credential_scheme') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title: 'credential_scheme is owned by app_ddl, and its ACL is app_rw SELECT only (R-9)',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) || ' ' || relacl::text FROM pg_class
                               WHERE oid = to_regclass('public.credential_scheme')), '(absent)')`,
        holds: 'app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl}',
      },
    ],
  },
  '0025': {
    source: 'T-158',
    // Each probe names an object 0025 creates and returns a value rather than raising once it is gone:
    // to_regclass/to_regtype return NULL for a missing name, and the ACL read is coalesced. The
    // refusals are asserted by suites/sitter-profile.test.ts, not here (T-137 TV2-A1).
    probes: [
      {
        title:
          'table public.sitter_profile, types bookable_state and sitter_tier, index idx_sitter_base_location exist (T-157 F-3)',
        sql: `SELECT (to_regclass('public.sitter_profile') IS NOT NULL)::text || ' ' ||
                     (to_regtype('public.bookable_state') IS NOT NULL)::text || ' ' ||
                     (to_regtype('public.sitter_tier') IS NOT NULL)::text || ' ' ||
                     (to_regclass('public.idx_sitter_base_location') IS NOT NULL)::text`,
        holds: 'true true true true',
      },
      {
        title:
          'sitter_profile is owned by app_ddl, its table ACL is app_rw SELECT only, and app_rw may UPDATE none of the protected four (E.4 U-3)',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) || ' ' || relacl::text || ' ' ||
                                      (SELECT count(*) FROM pg_attribute WHERE attrelid = c.oid
                                         AND attname IN ('bookable_state', 'tier', 'tier_rank', 'bookable_since')
                                         AND attacl IS NULL)::text
                                 FROM pg_class c WHERE oid = to_regclass('public.sitter_profile')), '(absent)')`,
        holds: 'app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=r/app_ddl} 4',
      },
    ],
  },
  '0026': {
    source: 'T-252',
    // Each probe names the one table 0026 creates and returns a value rather than raising once it is
    // gone: to_regclass returns NULL for a missing name, and the reads are coalesced. The refusals, the
    // policies and the C6 catalogue probe are asserted by suites/sitter-credential.test.ts, not here
    // (T-137 TV2-A1: a probe names an object).
    probes: [
      {
        title: 'table public.sitter_credential exists (CUT-T-060 R-9)',
        sql: `SELECT (to_regclass('public.sitter_credential') IS NOT NULL)::text`,
        holds: 'true',
      },
      {
        title:
          'sitter_credential is owned by app_ddl, its table ACL is app_rw SELECT + INSERT, and row-level security is enabled and forced (R-2, R-9)',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) || ' ' || relacl::text || ' ' ||
                                      relrowsecurity::text || ' ' || relforcerowsecurity::text
                                 FROM pg_class WHERE oid = to_regclass('public.sitter_credential')), '(absent)')`,
        holds: 'app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl} true true',
      },
    ],
  },
  '0027': {
    source: 'T-161',
    // Each probe names an object 0027 creates and returns a value rather than raising once it is gone:
    // to_regclass returns NULL for a missing name, and the ACL read is coalesced. The refusals (V1-V8)
    // are asserted by suites/cluster.test.ts, not here (T-137 TV2-A1: a probe names an object).
    probes: [
      {
        title:
          'table public.cluster and index public.idx_cluster_boundary exist (T-160 request; E.4 U-11)',
        sql: `SELECT (to_regclass('public.cluster') IS NOT NULL)::text || ' ' ||
                     (to_regclass('public.idx_cluster_boundary') IS NOT NULL)::text`,
        holds: 'true true',
      },
      {
        title:
          'cluster is owned by app_ddl, its table ACL is app_rw SELECT + INSERT, 8 columns other than id carry a column ACL, and row-level security is off (E.4 U-4, U-10; T-161 rework 1); which column privilege, and that id carries none, is pinned by suites/cluster.test.ts',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(relowner) || ' ' || relacl::text || ' ' ||
                                      (SELECT count(*) FROM pg_attribute WHERE attrelid = c.oid
                                         AND attacl IS NOT NULL AND attname <> 'id')::text || ' ' ||
                                      relrowsecurity::text || ' ' || relforcerowsecurity::text
                                 FROM pg_class c WHERE oid = to_regclass('public.cluster')), '(absent)')`,
        holds: 'app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl} 8 false false',
      },
    ],
  },
  '0028': {
    source: 'T-211',
    // Each probe names an object 0028 creates (the function cluster_state_transition(), the trigger
    // trg_cluster_state_transition, the CHECK cluster_open_requires_passing_snapshot) and returns a
    // value rather than raising once it is gone: to_regprocedure returns NULL for a missing function,
    // and every read is coalesced. The transition matrix is asserted by suites/cluster-state.test.ts,
    // not here (T-137 TV2-A1: a probe names an object).
    probes: [
      {
        title:
          'function public.cluster_state_transition() exists: owner app_ddl, SECURITY INVOKER, EXECUTE revoked from PUBLIC, search_path pinned',
        sql: `SELECT coalesce((SELECT pg_get_userbyid(proowner) || ' ' || prosecdef::text || ' ' || proacl::text || ' ' ||
                                      array_to_string(proconfig, ';')
                                 FROM pg_proc WHERE oid = to_regprocedure('public.cluster_state_transition()')), '(absent)')`,
        holds: 'app_ddl false {app_ddl=X/app_ddl} search_path=pg_catalog, pg_temp',
      },
      {
        title:
          'trigger trg_cluster_state_transition is BEFORE INSERT OR UPDATE FOR EACH ROW on public.cluster, enabled, executing cluster_state_transition()',
        sql: `SELECT coalesce((SELECT tgtype::text || ' ' || tgenabled::text FROM pg_trigger
                               WHERE tgrelid = to_regclass('public.cluster') AND tgname = 'trg_cluster_state_transition'
                                 AND tgfoid = to_regprocedure('public.cluster_state_transition()')), '(absent)')`,
        holds: '23 O',
      },
      {
        title:
          'CHECK cluster_open_requires_passing_snapshot exists on public.cluster, validated and not deferrable (C12 (b))',
        sql: `SELECT coalesce((SELECT contype::text || ' ' || convalidated::text || ' ' || condeferrable::text
                                 FROM pg_constraint WHERE conrelid = to_regclass('public.cluster')
                                  AND conname = 'cluster_open_requires_passing_snapshot'), '(absent)')`,
        holds: 'c true false',
      },
    ],
  },
  '0029': {
    source: 'T-163',
    // Each probe names an object 0029 creates (the three availability tables, their indexes, the
    // slot exclusion constraint) and returns a value rather than raising once it is gone: to_regclass
    // returns NULL for a missing name, and every read is coalesced. The refusals are asserted by
    // suites/availability.test.ts, not here (T-137 TV2-A1: a probe names an object).
    probes: [
      {
        title:
          'tables availability_template, availability_exception, availability_slot and indexes idx_slot_span, idx_slot_cluster, idx_slot_sitter, availability_template_sitter_id_idx, availability_exception_sitter_id_on_date_idx exist (SD §DB-5; E.3 U-23)',
        sql: `SELECT string_agg((to_regclass('public.' || n) IS NOT NULL)::text, ' ' ORDER BY o)
                FROM unnest(ARRAY['availability_template', 'availability_exception', 'availability_slot', 'idx_slot_span',
                                  'idx_slot_cluster', 'idx_slot_sitter', 'availability_template_sitter_id_idx',
                                  'availability_exception_sitter_id_on_date_idx']) WITH ORDINALITY AS t(n, o)`,
        holds: 'true true true true true true true true',
      },
      {
        title:
          'the slot exclusion constraint availability_slot_sitter_id_span_excl (contype x) and CHECK availability_slot_span_shape exist on public.availability_slot (SD 2261; OE-32 U-15 (a))',
        sql: `SELECT coalesce((SELECT string_agg(conname || '=' || contype::text, ' ' ORDER BY conname) FROM pg_constraint
                                WHERE conrelid = to_regclass('public.availability_slot')
                                  AND conname IN ('availability_slot_sitter_id_span_excl', 'availability_slot_span_shape')), '(absent)')`,
        holds: 'availability_slot_sitter_id_span_excl=x availability_slot_span_shape=c',
      },
      {
        title:
          'the three tables are owned by app_ddl with table ACLs app_rw SELECT+INSERT (template, exception) and SELECT+INSERT+DELETE (slot), and no row-level security (E.3 U-2, U-6 (a), U-21 (a))',
        sql: `SELECT coalesce((SELECT string_agg(relname || ' ' || pg_get_userbyid(relowner) || ' ' || relacl::text || ' ' ||
                                             relrowsecurity::text, ' ; ' ORDER BY relname)
                                 FROM pg_class WHERE oid IN (to_regclass('public.availability_template'),
                                                             to_regclass('public.availability_exception'),
                                                             to_regclass('public.availability_slot'))), '(absent)')`,
        holds:
          'availability_exception app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl} false ; ' +
          'availability_slot app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ard/app_ddl} false ; ' +
          'availability_template app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl} false',
      },
    ],
  },
  '0030': {
    source: 'T-028',
    // Each probe names an object 0030 creates (the I-1 functions, the four triggers, the app_ddl read
    // policy on sitter_credential) and returns a value rather than raising once it is gone:
    // to_regprocedure returns NULL for a missing function, and every read is coalesced. The behaviour
    // is asserted by suites/i1-bookable-state.test.ts, not here (T-137 TV2-A1: a probe names an object).
    probes: [
      {
        title:
          'the I-1 writer public.i1_rederive_sitter(bpchar) and reconciler public.i1_reconcile_bookable_state() exist: SECURITY DEFINER, owner app_ddl, search_path pinned (SA §SA-4 I-1; T-158 G-3 (c))',
        sql: `SELECT coalesce((SELECT string_agg(proname || ' ' || pg_get_userbyid(proowner) || ' ' || prosecdef::text || ' ' ||
                                               array_to_string(proconfig, ';'), ' ; ' ORDER BY proname)
                                 FROM pg_proc WHERE oid IN (to_regprocedure('public.i1_rederive_sitter(bpchar)'),
                                                            to_regprocedure('public.i1_reconcile_bookable_state()'))), '(absent)')`,
        holds:
          'i1_reconcile_bookable_state app_ddl true search_path=pg_catalog, pg_temp;app.i1_derivation=on ; ' +
          'i1_rederive_sitter app_ddl true search_path=pg_catalog, pg_temp;app.i1_derivation=on',
      },
      {
        title:
          'the four I-1 triggers exist on sitter_credential (row, TRUNCATE), account and sitter_profile, enabled (EV-39; E.3 U-12)',
        sql: `SELECT coalesce((SELECT string_agg(tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text, ' ' ORDER BY tgname)
                                 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_sitter_credential_i1_rederive',
                                   'trg_sitter_credential_i1_truncate', 'trg_account_i1_rederive', 'trg_sitter_profile_i1_enqueue')), '(absent)')`,
        holds:
          'account:trg_account_i1_rederive:O sitter_credential:trg_sitter_credential_i1_rederive:O ' +
          'sitter_credential:trg_sitter_credential_i1_truncate:O sitter_profile:trg_sitter_profile_i1_enqueue:O',
      },
      {
        title:
          'policy sitter_credential_i1_derivation_select exists on sitter_credential, TO app_ddl (OD-325)',
        sql: `SELECT coalesce((SELECT polroles::regrole[]::text FROM pg_policy
                                WHERE polrelid = to_regclass('public.sitter_credential')
                                  AND polname = 'sitter_credential_i1_derivation_select'), '(absent)')`,
        holds: '{app_ddl}',
      },
    ],
  },
  '0031': {
    source: 'T-268',
    // Each probe names an object 0031 creates (decision_record, statement_of_reasons, their keys) and
    // returns a value rather than raising once it is gone: to_regclass returns NULL for a missing name,
    // and every read is coalesced. The refusals are asserted by suites/decision-record.test.ts, not
    // here (T-137 TV2-A1: a probe names an object).
    probes: [
      {
        title:
          'tables decision_record and statement_of_reasons exist, owned by app_ddl, table ACLs app_rw and app_admin_rw SELECT+INSERT only, no row-level security (SD 2735-2752; SA SEC-8)',
        sql: `SELECT coalesce((SELECT string_agg(relname || ' ' || pg_get_userbyid(relowner) || ' ' || relacl::text || ' ' ||
                                             relrowsecurity::text, ' ; ' ORDER BY relname)
                                 FROM pg_class WHERE oid IN (to_regclass('public.decision_record'),
                                                             to_regclass('public.statement_of_reasons'))), '(absent)')`,
        holds:
          'decision_record app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl,app_admin_rw=ar/app_ddl} false ; ' +
          'statement_of_reasons app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl,app_admin_rw=ar/app_ddl} false',
      },
      {
        title:
          'constraints decision_record_pkey, statement_of_reasons_pkey and statement_of_reasons_decision_record_id_fkey exist (SD 2736, 2747)',
        sql: `SELECT coalesce((SELECT string_agg(conname || '=' || contype::text, ' ' ORDER BY conname) FROM pg_constraint
                                WHERE conrelid IN (to_regclass('public.decision_record'), to_regclass('public.statement_of_reasons'))
                                  AND contype <> 'n'), '(absent)')`,
        holds:
          'decision_record_pkey=p statement_of_reasons_decision_record_id_fkey=f statement_of_reasons_pkey=p',
      },
    ],
  },
  '0032': {
    source: 'T-274',
    // 0032 creates no object: it replaces two of 0030's functions. Each probe names one of them and
    // reads what 0032 changes in it (the writer's body carries the KV083 guard; the enqueue's body and
    // COMMENT carry the reworded strings), so it returns 'false' after a down to 0031 restores 0030's
    // text, and '(absent)' if the function is gone. Owner, SECURITY DEFINER and proconfig are 0030's
    // probes above, which must still hold. The behaviour is asserted by suites/i1-bookable-state.test.ts.
    probes: [
      {
        title:
          'public.i1_rederive_sitter(bpchar) carries the READ COMMITTED guard (KV083 I1_DERIVATION_ISOLATION) and the account row lock (T-028 TL-A; T-274, rework 1 QA-1, QA-3)',
        sql: `SELECT coalesce((SELECT (prosrc LIKE '%KV083%' AND prosrc LIKE '%I1_DERIVATION_ISOLATION%'
                                       AND prosrc LIKE '%FROM public.account AS a WHERE a.id = p_sitter_id FOR SHARE%')::text FROM pg_proc
                                WHERE oid = to_regprocedure('public.i1_rederive_sitter(bpchar)')), '(absent)')`,
        holds: 'true',
      },
      {
        title:
          'public.i1_enqueue_slot_materialise(bpchar): the WARNING 01K81 text and the COMMENT carry the mixed-statement bound (T-028 TL-D; T-274)',
        sql: `SELECT coalesce((SELECT (prosrc LIKE '%if this transaction commits, the change has no job%')::text || ' ' ||
                                      (obj_description(oid, 'pg_proc') LIKE '%the write commits only if nothing in its statement or transaction raises KV081%')::text
                                 FROM pg_proc WHERE oid = to_regprocedure('public.i1_enqueue_slot_materialise(bpchar)')), '(absent)')`,
        holds: 'true true',
      },
    ],
  },
};

/** `<id> <title>` of every probe that ran and held after `up`. */
const heldAfterUp = new Set<string>();
const heldKey = (id: string, probe: Probe): string => `${id} ${probe.title}`;

const WHAT_IS_CHECKED =
  'The gate checks the literal, and that CREATED_BY[<highest>] has probes that held after up and ' +
  'stop holding after a down to the migration below. It does not check that a probe names an ' +
  'object the migration creates; review does (T-137 § Published contract (rework 1) §5).';

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

describe('every committed migration is applied', () => {
  test('TRIPWIRE, first half — the highest up file in db/migrations equals the literal HIGHEST_COMMITTED', async () => {
    const actual = highestMigrationIn(COMMITTED_DIR);
    assert.equal(
      actual,
      HIGHEST_COMMITTED,
      `db/migrations' highest up file is ${actual}; this suite asserts ${HIGHEST_COMMITTED}. ` +
        `If you added ${actual}: in this file, add CREATED_BY['${actual}'] with probes asserting ` +
        `objects ${actual} creates, and move HIGHEST_COMMITTED, in the same change set. If ` +
        `${actual} is below ${HIGHEST_COMMITTED}, a committed migration is missing. ${WHAT_IS_CHECKED}`,
    );
  });

  test('the database records the highest committed migration, read back over this suite’s connection', async () => {
    assert.equal(await db.value(RECORD_SQL), `kinvara-migrate version=${HIGHEST_COMMITTED}`);
  });
});

for (const [id, keyed] of Object.entries(CREATED_BY)) {
  describe(`${id} (${keyed.source}) — the objects this migration creates`, () => {
    for (const probe of keyed.probes) {
      test(probe.title, async () => {
        assert.equal(await db.value(probe.sql), probe.holds);
        heldAfterUp.add(heldKey(id, probe));
      });
    }
  });
}

describe('check 17 (0002, T-021) — re-runnable now that the harness applies past 0001', () => {
  // T-021 § Published contract (rework 2) §4, cases S2-N1, S2-N2 and S2-C. The
  // body 0003 installs is 0002's (T-143 § contract §1), so these exercise the
  // guard as it stands, not which of the two files put check 17 there.
  test('S2-N1 — GRANT EXECUTE on pg_stat_statements(boolean) to answering_service is REFUSED', async () => {
    const r = await db.psql({
      commands: [
        'GRANT EXECUTE ON FUNCTION public.pg_stat_statements(boolean) TO answering_service',
      ],
    });
    assertRefused('S2-N1', r, { message: INT10_RAISE });
    assert.ok(
      r.output.includes('a function of extension pg_stat_statements'),
      `S2-N1: the DETAIL must name check 17's finding.\n${r.output}`,
    );
  });

  test('S2-N2 — the same GRANT to PUBLIC is REFUSED', async () => {
    assertRefused(
      'S2-N2',
      await db.psql({
        commands: ['GRANT EXECUTE ON FUNCTION public.pg_stat_statements(boolean) TO PUBLIC'],
      }),
      { message: INT10_RAISE },
    );
  });

  test('S2-C — CONTROL: a list, not a rule — EXECUTE on an unlisted extension’s function is accepted', async () => {
    assertPermitted(
      'S2-C',
      await db.psql({
        commands: ['GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO answering_service'],
      }),
    );
    assertPermitted(
      'S2-C revoked, leaving the cluster as it was',
      await db.psql({
        commands: [
          'REVOKE EXECUTE ON FUNCTION public.similarity(text, text) FROM answering_service',
          'SELECT kinvara_guard.assert_answering_service_write_only()',
        ],
      }),
    );
  });
});

// LAST: the down step below changes the cluster.
describe('TRIPWIRE, second half — the highest committed migration keys probes that ran, and a down undoes each', () => {
  function keyedToHighest(): { readonly highest: string; readonly probes: readonly Probe[] } {
    const highest = highestMigrationIn(COMMITTED_DIR);
    const probes = CREATED_BY[highest]?.probes ?? [];
    assert.ok(
      probes.length > 0,
      `db/migrations' highest up file is ${highest}, and no probe in this file is keyed to it. ` +
        `In this file, add CREATED_BY['${highest}'] with at least one probe asserting an object ` +
        `${highest} creates, and move HIGHEST_COMMITTED, in the same change set. ${WHAT_IS_CHECKED}`,
    );
    return { highest, probes };
  }

  test('at least one probe is keyed to the highest committed migration, and every one of them ran and held after up', () => {
    const { highest, probes } = keyedToHighest();
    for (const probe of probes) {
      assert.ok(
        heldAfterUp.has(heldKey(highest, probe)),
        `probe '${probe.title}' (keyed ${highest}) did not run and hold after up; see its own test above.`,
      );
    }
  });

  test('after db:migrate down to the migration below it, every probe keyed to the highest committed migration stops holding', async () => {
    const { highest, probes } = keyedToHighest();
    const below = String(Number(highest) - 1).padStart(4, '0');
    const run = await db.migrate(['down', '--to', below, '--dir', COMMITTED_DIR]);
    const verdict = judgeMigrateRun(run);
    assert.equal(
      verdict.kind,
      'OK',
      `db:migrate down --to ${below} was judged ${verdict.kind}, so no probe can be read against ` +
        `${below}'s state. A migration with no down file cannot satisfy this check.\n${run.output}`,
    );
    assert.equal(
      await db.value(RECORD_SQL),
      `kinvara-migrate version=${below}`,
      'the down step must have landed before any probe is read against it',
    );
    for (const probe of probes) {
      const r = await db.psql({ raw: true, commands: [probe.sql] });
      assert.equal(
        r.code,
        0,
        `probe '${probe.title}' raised at ${below}. Write it as a reading that returns a value ` +
          `when the object is absent.\n${r.output}`,
      );
      assert.notEqual(
        r.stdout.trim(),
        probe.holds,
        `probe '${probe.title}' (keyed ${highest}) still returns '${probe.holds}' at ${below}, so ` +
          `it does not tell ${highest}'s state from the state below it. Assert an object ` +
          `${highest} creates. ${WHAT_IS_CHECKED}`,
      );
    }
  });
});
