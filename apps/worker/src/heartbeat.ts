/**
 * The heartbeat the image's HEALTHCHECK reads (OD-198).
 *
 * docker/app-runtime/healthcheck.mjs, under KINVARA_APP_KIND=worker, requires
 * `/tmp/kinvara-heartbeat` to hold JSON with an `at` (epoch ms) fresher than
 * KINVARA_HEARTBEAT_MAX_AGE_MS (default 15000). Until T-148 only the entrypoint's PLACEHOLDER wrote
 * it, so the first real `start` would never have become healthy (T-151 TL-2).
 *
 * A beat is written only after a round trip to the database AS THE WORKER'S ROLE reads
 * `pgboss.version`, so "healthy" means the event loop is turning AND the worker can still reach
 * its queue schema — not merely that a timer fires. It is first written after pg-boss has started
 * and every handler is registered (src/worker.ts), and stops on the first stop signal.
 *
 * The file is written to a sibling and renamed, so the healthcheck never reads half a file.
 */
import { renameSync, writeFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { HEARTBEAT_INTERVAL_MS, PGBOSS_SCHEMA } from './config.ts';

export interface Heartbeat {
  stop(): void;
}

export async function startHeartbeat(
  pool: Pool,
  path: string,
  log: (line: string) => void,
): Promise<Heartbeat> {
  let failing = false;
  const beat = async (): Promise<void> => {
    try {
      await pool.query(`SELECT 1 FROM ${PGBOSS_SCHEMA}.version`);
      const tmp = `${path}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ app: 'worker', at: Date.now(), pid: process.pid, mode: 'real' }),
      );
      renameSync(tmp, path);
      if (failing) log('heartbeat: database reachable again, beating');
      failing = false;
    } catch (thrown) {
      if (!failing) {
        const code =
          typeof thrown === 'object' && thrown !== null && 'code' in thrown
            ? String(thrown.code)
            : 'none';
        log(`heartbeat: NOT written — the database round trip failed (code=${code})`);
      }
      failing = true;
    }
  };
  await beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  return {
    stop: () => clearInterval(timer),
  };
}
