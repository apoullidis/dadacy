/**
 * T-146 — the privilege boundary around schema `pgboss`, at the database.
 *
 * `0006` creates pg-boss 12.26.4's own tables so that pg-boss never performs DDL
 * (SD §DB-1 lines 1751, 1755). The migration grants `app_rw` and nobody else, and
 * grants no role `CREATE` on the schema. This suite is the negative half of that
 * claim: every refusal below is asserted with its SQLSTATE, and each has a control
 * next to it, because "permission denied" proves nothing about a grant set that is
 * simply absent (PROTOCOL §5.1).
 *
 * `app_safety_rw` is refused deliberately and temporarily: SD §BE-3 line 1008 needs
 * `safety-gw` to enqueue in its write transaction and closes that role's grant set
 * in the same sentence. That is OD-91, with the stakeholder. Until it is ruled,
 * these two tests are what the state actually is.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  asSafetyGw,
  asVendor,
  installInt10Fixtures,
  installSafetyFixtures,
  PROBE_PASSWORD,
  type Cluster,
} from '../src/index.ts';
import {
  assertPermitted,
  assertRefused,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
} from '../src/expect.ts';

const SUITE = 'pgboss-grants';
const RW_PROBE = 't146_rw_probe';
const ADMIN_PROBE = 't146_admin_probe';

/** The ten relations `0006` creates whose names do not depend on the day it is applied. */
const FIXED_RELATIONS = [
  'bam',
  'job',
  'job_common',
  'job_dependency',
  'queue',
  'queue_stats',
  'schedule',
  'subscription',
  'version',
  'warning',
] as const;

let db: Cluster;

const asRw = (sql: string) =>
  ({ user: RW_PROBE, password: PROBE_PASSWORD, commands: [sql], stopOnError: true }) as const;
const asAdmin = (sql: string) =>
  ({ user: ADMIN_PROBE, password: PROBE_PASSWORD, commands: [sql], stopOnError: true }) as const;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await installInt10Fixtures(db);
  await installSafetyFixtures(db);
  await db.sql({
    commands: [
      `CREATE ROLE ${RW_PROBE} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_rw`,
      `CREATE ROLE ${ADMIN_PROBE} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_admin_rw`,
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

describe('T-146 — what 0006 created', () => {
  test('schema pgboss exists and is owned by the bootstrap superuser, not app_ddl', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace
                           WHERE nspname = 'pgboss'), '(absent)')`,
      ),
      'app',
    );
  });

  test('the fixed relation set is exactly pg-boss 12.26.4 schema 37, plus two dated queue_stats partitions', async () => {
    const fixed = await db.value(
      `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '(none)')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relkind IN ('r','p')
          AND c.relname !~ '^queue_stats_[0-9]{8}$'`,
    );
    assert.equal(fixed, FIXED_RELATIONS.join(','));
    // The DO block at the end of pg-boss's plan creates today's and tomorrow's
    // partitions, computing both from the UTC date, so their names depend on the
    // apply date and their COUNT does not.
    assert.equal(
      await db.value(
        `SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relname ~ '^queue_stats_[0-9]{8}$'`,
      ),
      '2',
    );
    // and pg-boss's own version row, which is what makes the set a version claim
    assert.equal(await db.value(`SELECT version::text FROM pgboss.version`), '37');
  });

  test('both partitioned parents are partitioned, and job_common is the DEFAULT partition', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(c.relname || '=' || p.partstrat, ',' ORDER BY c.relname), '(none)')
           FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss'`,
      ),
      'job=l,queue_stats=r',
    );
    assert.equal(
      await db.value(
        `SELECT coalesce((SELECT pg_get_expr(c.relpartbound, c.oid) FROM pg_class c
                           JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'pgboss' AND c.relname = 'job_common'), '(absent)')`,
      ),
      'DEFAULT',
    );
  });
});

describe('T-146 — app_rw: the control, so every refusal below means something', () => {
  test('app_rw holds USAGE on schema pgboss and does NOT hold CREATE', async () => {
    assert.equal(
      await db.value(
        `SELECT has_schema_privilege('app_rw','pgboss','USAGE')::text || ',' ||
                has_schema_privilege('app_rw','pgboss','CREATE')::text`,
      ),
      'true,false',
    );
  });

  test('app_rw can enqueue and read back a job through pg-boss own function and table', async () => {
    assertPermitted(
      "create_queue + INSERT into the queue's table",
      await db.psql({
        user: RW_PROBE,
        password: PROBE_PASSWORD,
        stopOnError: true,
        commands: [
          `SELECT pgboss.create_queue('t146.control', '{}'::jsonb)`,
          `INSERT INTO pgboss.job_common (name, data) VALUES ('t146.control', '{"a":1}'::jsonb)`,
        ],
      }),
    );
    const r = await db.psql({
      ...asRw(`SELECT data->>'a' FROM pgboss.job WHERE name = 't146.control'`),
      raw: true,
    });
    assertPermitted('SELECT through the partitioned parent', r);
    assert.equal(r.stdout.trim(), '1');
  });
});

describe('T-146 — the refusals, each with SQLSTATE 42501', () => {
  test('answering_service SELECT on the job table is REFUSED (SA §INT-10: SELECT on nothing, ever)', async () => {
    assertRefused(
      'answering_service SELECT pgboss.job',
      await db.psql({ ...asVendor('SELECT * FROM pgboss.job'), verbose: true }),
      { message: 'permission denied for schema pgboss', sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE },
    );
  });

  test('app_safety_rw SELECT on the job table is REFUSED (the state until OD-91 is ruled)', async () => {
    assertRefused(
      'app_safety_rw SELECT pgboss.job',
      await db.psql({ ...asSafetyGw('SELECT * FROM pgboss.job'), verbose: true }),
      { message: 'permission denied for schema pgboss', sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE },
    );
  });

  test('app_safety_rw INSERT into the job table is REFUSED (the state until OD-91 is ruled)', async () => {
    assertRefused(
      'app_safety_rw INSERT pgboss.job_common',
      await db.psql({
        ...asSafetyGw(`INSERT INTO pgboss.job_common (name) VALUES ('t146.control')`),
        verbose: true,
      }),
      { message: 'permission denied for schema pgboss', sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE },
    );
  });

  test('app_admin_rw SELECT on the job table is REFUSED', async () => {
    assertRefused(
      'app_admin_rw SELECT pgboss.job',
      await db.psql({ ...asAdmin('SELECT * FROM pgboss.job'), verbose: true }),
      { message: 'permission denied for schema pgboss', sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE },
    );
  });

  test('app_rw CREATE in schema pgboss is REFUSED — no role may add a relation there', async () => {
    assertRefused(
      'app_rw CREATE TABLE pgboss.*',
      await db.psql({ ...asRw('CREATE TABLE pgboss.t146_rogue (i int)'), verbose: true }),
      { message: 'permission denied for schema pgboss', sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE },
    );
    assert.equal(await db.value(`SELECT (to_regclass('pgboss.t146_rogue') IS NULL)::text`), 'true');
  });

  test('app_rw EXECUTE on the three DDL helper functions is REFUSED — that is what makes "no run-time DDL" a privilege', async () => {
    assertRefused(
      'app_rw SELECT pgboss.job_table_run(...)',
      await db.psql({
        ...asRw(`SELECT pgboss.job_table_run('ALTER TABLE pgboss.job ADD COLUMN t146 int', 'job_common')`),
        verbose: true,
      }),
      {
        message: 'permission denied for function job_table_run',
        sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE,
      },
    );
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(p.proname || '=' ||
                   has_function_privilege('app_rw', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname), '(none)')
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'pgboss'`,
      ),
      'create_queue=true,delete_queue=true,job_table_format=false,job_table_run=false,job_table_run_async=false',
    );
  });

  test('none of the other three roles holds USAGE on schema pgboss', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(r.rolname || '=' ||
                   has_schema_privilege(r.rolname, 'pgboss', 'USAGE')::text, ',' ORDER BY r.rolname), '(none)')
           FROM pg_roles r
          WHERE r.rolname IN ('app_admin_rw','app_safety_rw','answering_service')`,
      ),
      'answering_service=false,app_admin_rw=false,app_safety_rw=false',
    );
  });

  test('the SA §INT-10 guard, called DIRECTLY, returns clean with 0006 applied (OD-76)', async () => {
    assertPermitted(
      'direct call of the guard after 0006',
      await db.psql({ commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'] }),
    );
  });
});
