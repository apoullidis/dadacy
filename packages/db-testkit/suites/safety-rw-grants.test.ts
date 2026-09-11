/**
 * T-020 Evidence §7, ported — the shape `app_safety_rw`'s grants must take.
 *
 * SD §DB-11 gives `safety-gw` `SELECT` on one table it does not own and
 * `INSERT` on its own four, "and no other grant exists for role
 * `app_safety_rw`". None of those five tables exists yet, so `0001` cannot
 * issue the grants; what it can do — and what this suite pins — is the SHAPE,
 * so `T-101` and the EP-12 tickets copy a demonstrated pattern instead of
 * inventing one.
 *
 * The third case is the one that makes SD §DB-11's design true: the projection
 * is written by `core` in-transaction and is read-only to `safety-gw` AT THE
 * GRANT LEVEL, so `safety-gw` keeps working with `core` entirely down without
 * ever being able to corrupt the read model.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  asSafetyGw,
  installSafetyFixtures,
  type Cluster,
} from '../src/index.ts';
import { assertPermitted, assertRefused } from '../src/expect.ts';

const SUITE = 'safety-rw-grants';
let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await installSafetyFixtures(db);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

describe('SD §DB-11 — app_safety_rw', () => {
  test('SELECT on the one table it does not own — permitted, and it really reads a row', async () => {
    const r = await db.psql({
      ...asSafetyGw('SELECT sitter_display_name FROM public.session_safety_projection'),
      raw: true,
    });
    assertPermitted('SELECT session_safety_projection', r);
    // A Greek-script name on purpose: SD §Revision Log G6 — a fixture that is
    // entirely Latin cannot fail on the cross-script bug.
    assert.equal(r.stdout.trim(), 'Α. Χριστοδούλου');
  });

  test('INSERT into a table it owns — permitted', async () => {
    assertPermitted(
      'INSERT session_event',
      await db.psql(
        asSafetyGw(
          `INSERT INTO public.session_event
             VALUES ('01J000000000000000000000E1','01J000000000000000000000B1','arrived')`,
        ),
      ),
    );
  });

  test('UPDATE on the projection is REFUSED — it is a read model, core owns the writes', async () => {
    assertRefused(
      'UPDATE session_safety_projection',
      await db.psql(
        asSafetyGw(`UPDATE public.session_safety_projection SET sitter_display_name = 'x'`),
      ),
      { message: 'permission denied for table session_safety_projection' },
    );
  });

  test('SELECT on its own write table is REFUSED — it writes events, it does not read them back', async () => {
    assertRefused(
      'SELECT session_event',
      await db.psql(asSafetyGw('SELECT * FROM public.session_event')),
      { message: 'permission denied for table session_event' },
    );
  });

  test("SELECT on core's tables is REFUSED", async () => {
    await db.sql({ commands: [`CREATE TABLE public.account (id char(26) PRIMARY KEY)`] });
    assertRefused('SELECT account', await db.psql(asSafetyGw('SELECT * FROM public.account')), {
      message: 'permission denied for table account',
    });
  });

  test('no TEMPORARY on the database — T-020 § contract §3 says app_safety_rw has none', async () => {
    assert.equal(
      await db.value(
        `SELECT has_database_privilege('app_safety_rw', current_database(), 'TEMPORARY')::text`,
      ),
      'false',
    );
    // The control: app_rw does have it, so this is a property of the role and
    // not of the database.
    assert.equal(
      await db.value(
        `SELECT has_database_privilege('app_rw', current_database(), 'TEMPORARY')::text`,
      ),
      'true',
    );
  });
});
