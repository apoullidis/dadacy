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
const HIGHEST_COMMITTED = '0015';
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
