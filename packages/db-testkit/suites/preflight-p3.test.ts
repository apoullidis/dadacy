/**
 * T-020 Evidence §6, P3, ported — `0001` refuses a cluster whose
 * `shared_preload_libraries` lacks `pg_stat_statements`.
 *
 * Its own FILE, not a `describe` inside `preflight.test.ts`: it needs a cluster
 * started with a different server command, and a suite file holds at most one
 * cluster. The runner's `--no-file-parallelism` serialises files, not the
 * clusters inside one; when P3 lived in `preflight.test.ts` a single run held
 * two clusters at once (1 GB against the `db` profile's 512 MB), measured by
 * T-115's sampler under node:test's equivalent flag, `--test-concurrency=1`.
 *
 * `shared_preload_libraries` is a CLUSTER-level parameter, which is the third
 * reason this harness gives every suite a cluster rather than a database
 * (see `src/cluster.ts`).
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { acquireCluster, applyBaseline, type Cluster } from '../src/index.ts';

const PSQL_SCRIPT_ERROR = 3;
let bare: Cluster;

beforeAll(async () => {
  // T-020 produced this state by resetting the parameter and restarting the
  // container by hand; here it is one line, which is the whole difference
  // between a one-off run and a suite.
  bare = await acquireCluster('preflight-no-preload', {
    // `pg_partman_bgw` and NOT the empty string. An EMPTY value is not a
    // shorter version of this test — measured on this image, PostgreSQL 18
    // treats `shared_preload_libraries = ''` as a one-element list whose
    // element is the empty filename and refuses to start:
    // `FATAL: could not access file "": No such file or directory`. A P3
    // cluster that cannot boot would have failed as a harness bug, not as a
    // preflight refusal. A non-empty list that is MISSING one entry is also
    // the realistic mistake: OD-9 is a whole finding about getting the names
    // in this list right.
    command: ['postgres', '-c', 'shared_preload_libraries=pg_partman_bgw'],
  });
}, 300_000);

afterAll(async () => {
  if (bare !== undefined) await bare.stop();
});

test('P3 — shared_preload_libraries without pg_stat_statements (OD-7)', async () => {
  const preload = await bare.value(`SHOW shared_preload_libraries`);
  assert.equal(
    preload,
    'pg_partman_bgw',
    'the probe cluster must really be missing pg_stat_statements, or P3 tests nothing',
  );
  assert.ok(!preload.includes('pg_stat_statements'));
  const r = await applyBaseline(bare);
  assert.equal(r.code, PSQL_SCRIPT_ERROR, `P3: expected psql exit 3.\n${r.output}`);
  assert.ok(
    r.output.includes('shared_preload_libraries does not contain pg_stat_statements'),
    `P3: the refusal must name the parameter.\n${r.output}`,
  );
  // Why it matters, restated as an assertion: CREATE EXTENSION would have
  // SUCCEEDED here, and every read of the view would then raise — SD §DB-12's
  // weekly review of statements over 50 ms silently dead, nothing red.
  assert.equal(
    await bare.value(`SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'`),
    '0',
  );
});
