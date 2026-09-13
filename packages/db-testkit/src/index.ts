/**
 * `@kinvara/db-testkit` — how a constraint suite acquires a database.
 *
 * Published contract: `tasks/state/EP-QA/T-115.md` § Published contract, as
 * amended by `tasks/state/EP-QA/T-137.md` § Published contract (every committed
 * migration, not `0001` alone).
 *
 * ```ts
 * import { afterAll, beforeAll, test } from 'vitest';
 * import assert from 'node:assert/strict';
 * import { acquireMigratedCluster, type Cluster } from '@kinvara/db-testkit';
 *
 * let db: Cluster;
 * beforeAll(async () => { db = await acquireMigratedCluster('my-suite'); }, 300_000);
 * afterAll(async () => { if (db !== undefined) await db.stop(); });
 * ```
 *
 * One cluster per suite FILE. Never share one between files: roles are
 * cluster-global and a shared cluster makes a negative test lie (see
 * `src/cluster.ts`).
 */
import path from 'node:path';

export {
  acquireCluster,
  applyBaseline,
  revertBaseline,
  baselineExists,
  assertDisposable,
  assertPinnedImage,
  composePostgresImage,
  COMPOSE_FILE,
  FIVE_ROLES,
  APP_DATABASE,
  SUPERUSER,
  BASELINE_UP,
  BASELINE_DOWN,
  REPO_ROOT,
} from './cluster.ts';
export type { Cluster, PsqlOptions, PsqlResult } from './cluster.ts';
export { DockerUnavailableError, DOCKER_SOCKET } from './engine.ts';
export {
  POSTGRES_IMAGE,
  POSTGRES_BASE_IMAGE,
  FORBIDDEN_IMAGE_PREFIX,
  PGDATA_MOUNTPOINT,
} from './image.ts';
export {
  installInt10Fixtures,
  installSafetyFixtures,
  asVendor,
  asSafetyGw,
  VENDOR_CONN,
  SAFETY_CONN,
  AS_PROBE,
  SAFETY_PROBE,
  PROBE_PASSWORD,
  ACCOUNT_ID,
  ACCOUNT_EMAIL,
} from './fixtures.ts';
export {
  applyMigrations,
  assertCarriesEveryCommittedMigration,
  highestMigrationIn,
  judgeMigrateRun,
  MigrationsNotApplied,
  MIGRATE_RUNNER,
  MIGRATIONS_DIR,
} from './migrate.ts';
export type { MigrateVerdict, NotAppliedKind } from './migrate.ts';

import { acquireCluster, REPO_ROOT, type Cluster } from './cluster.ts';
import {
  applyMigrations,
  assertCarriesEveryCommittedMigration,
  MIGRATIONS_DIR,
} from './migrate.ts';

export interface MigratedClusterOptions {
  /**
   * A migrations directory other than `db/migrations`. It must carry every
   * committed migration byte for byte (refused before a cluster starts
   * otherwise), so it can only ADD migrations — the scratch-migration case.
   */
  readonly dir?: string;
}

/**
 * The common case: a fresh cluster with EVERY committed migration applied, in
 * order, by `T-136`'s runner (`db:migrate up`), the run judged by exit status and
 * banner together, and the database's record read back.
 *
 * On anything else it stops the cluster and throws `MigrationsNotApplied`, whose
 * `kind` separates a migration that failed (`FAIL`: the file and psql's exit are
 * named) from a runner that crashed (`CRASH`), a refused directory or record
 * (`REFUSED`), an unreachable database (`ERROR`), a run that recorded less than
 * it claimed (`NOT_RECORDED`), and a `dir` missing a committed migration
 * (`INCOMPLETE_DIR`, before any cluster starts).
 *
 * The three suites that exist to watch `0001` REFUSE use `acquireCluster` +
 * `applyBaseline` directly, because for them a non-zero exit is the pass.
 */
export async function acquireMigratedCluster(
  suite: string,
  options: MigratedClusterOptions = {},
): Promise<Cluster> {
  const dir = path.resolve(options.dir ?? path.join(REPO_ROOT, MIGRATIONS_DIR));
  assertCarriesEveryCommittedMigration(suite, dir);
  const cluster = await acquireCluster(suite);
  try {
    await applyMigrations(cluster, dir);
    return cluster;
  } catch (err) {
    await cluster.stop();
    throw err;
  }
}
