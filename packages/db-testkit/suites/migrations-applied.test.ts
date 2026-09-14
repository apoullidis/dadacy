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
const HIGHEST_COMMITTED = '0005';
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
