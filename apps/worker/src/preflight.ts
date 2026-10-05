/**
 * What the worker checks before it lets pg-boss issue a statement, and refuses to start on.
 *
 * Each check is a reading of the catalogue as the worker's own session, so it judges the role
 * the worker actually runs as, not the one it was configured to ask for:
 *
 *   principal       `current_user` is `app_rw` (src/config.ts sets the role at connection start).
 *   schema-missing  schema `pgboss` exists (created by migration 0006, T-146 — never by the worker).
 *   privilege       the grants T-146 § contract §2 says the runtime needs are all held, AND
 *                   `CREATE` on schema `pgboss` is NOT held: a role that could create there could
 *                   run pg-boss's self-migration, which this build forbids (T-146 § contract §3).
 *   schema-version  `pgboss.version` is the one row this pg-boss requires (37 at 12.26.4).
 *
 * pg-boss's own `contractor.check()` (run by `start()` with `migrate: false`) repeats the version
 * comparison. That is a second, independent reading, not the one this file relies on: this one
 * names what it found.
 *
 * `has_table_privilege(t, 'SELECT, INSERT')` is true if ANY listed privilege is held, so each
 * privilege is asked separately. The schema's USAGE is asked first; if it is missing, that is the
 * whole finding (nothing inside the schema can be looked up without it).
 */
import type { PoolClient } from 'pg';
import { PGBOSS_SCHEMA, RUNTIME_ROLE } from './config.ts';
import { WorkerRefusal } from './refusal.ts';

/** T-146 § Published contract §2/§4: what `app_rw` holds on `pgboss`, and what the runtime uses. */
const DML_TABLES = [
  'bam',
  'job',
  'job_common',
  'job_dependency',
  'queue',
  'queue_stats',
  'schedule',
  'subscription',
  'warning',
] as const;
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
const FUNCTIONS = ['create_queue(text, jsonb)', 'delete_queue(text)'] as const;

interface Need {
  readonly kind: 'schema' | 'table' | 'function';
  readonly object: string;
  readonly privilege: string;
}

export const REQUIRED_PRIVILEGES: readonly Need[] = [
  { kind: 'schema', object: PGBOSS_SCHEMA, privilege: 'USAGE' },
  ...DML_TABLES.flatMap((t) =>
    DML.map((p) => ({ kind: 'table' as const, object: `${PGBOSS_SCHEMA}.${t}`, privilege: p })),
  ),
  { kind: 'table', object: `${PGBOSS_SCHEMA}.version`, privilege: 'SELECT' },
  { kind: 'table', object: `${PGBOSS_SCHEMA}.version`, privilege: 'UPDATE' },
  ...FUNCTIONS.map((f) => ({
    kind: 'function' as const,
    object: `${PGBOSS_SCHEMA}.${f}`,
    privilege: 'EXECUTE',
  })),
];

export interface Preflight {
  readonly sessionUser: string;
  readonly currentUser: string;
  readonly sessionIsSuperuser: boolean;
  readonly schemaVersion: number;
}

interface Identity {
  readonly session_user: string;
  readonly current_user: string;
  readonly session_super: boolean | null;
  readonly schema_present: boolean;
}

/** One catalogue question per need; NULL when the object does not exist. */
function heldSql(need: Need): string {
  switch (need.kind) {
    case 'schema':
      return `SELECT CASE WHEN to_regnamespace($1) IS NULL THEN NULL ELSE has_schema_privilege($1, $2) END AS held`;
    case 'table':
      return `SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE has_table_privilege($1, $2) END AS held`;
    case 'function':
      return `SELECT CASE WHEN to_regprocedure($1) IS NULL THEN NULL ELSE has_function_privilege($1, $2) END AS held`;
  }
}

export async function preflight(client: PoolClient, requiredVersion: number): Promise<Preflight> {
  const identity = (
    await client.query<Identity>(
      `SELECT session_user::text AS session_user, current_user::text AS current_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS session_super,
              to_regnamespace($1) IS NOT NULL AS schema_present`,
      [PGBOSS_SCHEMA],
    )
  ).rows[0];
  if (identity === undefined) throw new Error('preflight: the identity query returned no row');

  if (identity.current_user !== RUNTIME_ROLE) {
    throw new WorkerRefusal(
      'principal',
      `the session runs as ${identity.current_user} (login ${identity.session_user}), not ` +
        `${RUNTIME_ROLE}; the worker runs only as ${RUNTIME_ROLE} (T-020 § contract §3)`,
    );
  }
  if (!identity.schema_present) {
    throw new WorkerRefusal(
      'schema-missing',
      `schema ${PGBOSS_SCHEMA} does not exist. It is created by migration 0006 (T-146), never by ` +
        `the worker (migrate: false); run db:migrate`,
    );
  }

  // USAGE on the schema first, and alone: without it PostgreSQL refuses even the NAME lookup of a
  // relation in it (`to_regclass('pgboss.job')` raises 42501 "permission denied for schema
  // pgboss"), so the per-object questions below would crash rather than answer. Measured by
  // tools/refusals.sh case II-b before this branch existed (state/EP-2/T-148.md).
  const missing: string[] = [];
  for (const need of REQUIRED_PRIVILEGES) {
    if (need.kind !== 'schema' && missing.length > 0) break;
    const row = (
      await client.query<{ held: boolean | null }>(heldSql(need), [need.object, need.privilege])
    ).rows[0];
    if (row?.held === null || row?.held === undefined) {
      missing.push(`${need.privilege} on ${need.kind} ${need.object} (absent)`);
    } else if (!row.held) {
      missing.push(`${need.privilege} on ${need.kind} ${need.object}`);
    }
  }
  if (missing.length > 0) {
    throw new WorkerRefusal(
      'privilege',
      `${RUNTIME_ROLE} lacks ${String(missing.length)} privilege(s) the worker needs ` +
        `(T-146 § contract §2): ${missing.join('; ')}`,
    );
  }

  const create = (
    await client.query<{ held: boolean }>(`SELECT has_schema_privilege($1, 'CREATE') AS held`, [
      PGBOSS_SCHEMA,
    ])
  ).rows[0];
  if (create?.held !== false) {
    throw new WorkerRefusal(
      'privilege',
      `${identity.current_user} can CREATE in schema ${PGBOSS_SCHEMA}. The worker must not be ` +
        `able to: pg-boss's self-migration and partitioned queues need exactly that, and this ` +
        `build forbids both (T-146 § contract §3)`,
    );
  }

  const versions = (
    await client.query<{ version: number }>(`SELECT version FROM ${PGBOSS_SCHEMA}.version`)
  ).rows.map((r) => r.version);
  if (versions.length !== 1 || versions[0] !== requiredVersion) {
    throw new WorkerRefusal(
      'schema-version',
      `${PGBOSS_SCHEMA}.version holds ${JSON.stringify(versions)}; this worker's pg-boss ` +
        `requires exactly [${String(requiredVersion)}]. The schema is created and migrated by ` +
        `db/migrations (0006, T-146), never by the worker (migrate: false); a pg-boss version ` +
        `change is a new migration`,
    );
  }

  return {
    sessionUser: identity.session_user,
    currentUser: identity.current_user,
    sessionIsSuperuser: identity.session_super === true,
    schemaVersion: requiredVersion,
  };
}
