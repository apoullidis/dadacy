/**
 * `@kinvara/db-testkit` — how a constraint suite acquires a database.
 *
 * Published contract: `tasks/state/EP-QA/T-115.md` § Published contract.
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

import { acquireCluster, applyBaseline, type Cluster } from './cluster.ts';

/**
 * The common case: a fresh cluster with `0001` applied and asserted green.
 *
 * The three suites that exist to watch `0001` REFUSE use `acquireCluster` +
 * `applyBaseline` directly, because for them a non-zero exit is the pass.
 */
export async function acquireMigratedCluster(suite: string): Promise<Cluster> {
  const cluster = await acquireCluster(suite);
  try {
    const applied = await applyBaseline(cluster);
    if (applied.code !== 0) {
      throw new Error(
        `0001 did not apply to this suite's cluster (psql exit ${String(applied.code)}).\n` +
          `If this is the SA §INT-10 guard raising KV010, the guard has found a real read path.\n` +
          applied.output,
      );
    }
    return cluster;
  } catch (err) {
    await cluster.stop();
    throw err;
  }
}
