/**
 * T-137 — the harness applies EVERY committed migration, not `0001` alone.
 *
 * `acquireMigratedCluster` runs `T-136`'s `db:migrate up` against this suite's
 * cluster. This file checks the result from the database side, over its own
 * connection: the record, and the object the HIGHEST committed migration creates.
 *
 * THE TRIPWIRE. `HIGHEST_COMMITTED` is a literal, not a reading of the
 * directory, so it is an anchor from outside the thing it checks. When `0004`
 * lands, the first test goes red on purpose: whoever adds a migration adds an
 * assertion here for the object it creates, and moves the literal. Without it
 * this suite would keep passing on `0003`'s object while no longer asserting the
 * highest migration at all.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  acquireMigratedCluster,
  highestMigrationIn,
  MIGRATIONS_DIR,
  REPO_ROOT,
  SUPERUSER,
  type Cluster,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'migrations-applied';
const HIGHEST_COMMITTED = '0003';
let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

describe('every committed migration is applied', () => {
  test('TRIPWIRE — the highest committed migration is the one this suite asserts', async () => {
    assert.equal(
      highestMigrationIn(path.join(REPO_ROOT, MIGRATIONS_DIR)),
      HIGHEST_COMMITTED,
      `db/migrations has a migration above ${HIGHEST_COMMITTED}. Add a test below for an object ` +
        `it creates, then move HIGHEST_COMMITTED (T-137 § Published contract).`,
    );
  });

  test('the database records the highest committed migration, read back over this suite’s connection', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(shobj_description(oid, 'pg_database'), '(no comment)')
           FROM pg_database WHERE datname = current_database()`,
      ),
      `kinvara-migrate version=${HIGHEST_COMMITTED}`,
    );
  });
});

describe('0003 (T-143) — the objects the highest committed migration creates', () => {
  test('schema kinvara_guard exists, owned by the bootstrap superuser', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace
                           WHERE nspname = 'kinvara_guard'), '(absent)')`,
      ),
      SUPERUSER,
    );
  });

  test('the check function lives in kinvara_guard, and no schema but kinvara_guard holds one', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(n.nspname, ',' ORDER BY n.nspname), '(none)')
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'assert_answering_service_write_only'`,
      ),
      'kinvara_guard',
    );
  });

  test('the event trigger calls the trigger function relocated into kinvara_guard', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce((SELECT n.nspname || '.' || p.proname
                            FROM pg_event_trigger e
                            JOIN pg_proc p ON p.oid = e.evtfoid
                            JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE e.evtname = 'trg_int10_answering_service'), '(absent)')`,
      ),
      'kinvara_guard.trg_assert_answering_service_write_only',
    );
  });
});

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
