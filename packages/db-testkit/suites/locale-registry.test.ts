/**
 * T-144 — `public.locale_registry` (migration 0004), the database-layer refusals
 * `T-064`'s migration request lists (state/EP-0/T-064.md § Migration request).
 *
 * SD §DB-17 lines 3386–3401: the locale set is DATA. Adding a locale is a new data
 * migration inserting a row, never an edit to 0004 and never an application write, so
 * `app_rw` reads the registry and writes nothing, and no other application role holds
 * anything on it. The `en` row is load-bearing: `T-140`'s `account.locale` is
 * `NOT NULL DEFAULT 'en' REFERENCES locale_registry(code)` (SD lines 1780–1781).
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line
 * AND the field naming what refused it, so a crash, a connection failure or a refusal
 * for another reason cannot read as this one (T-115 § contract TL2-F4). Measured on
 * PostgreSQL 18.6: a NOT NULL violation reports `COLUMN NAME`, not `CONSTRAINT NAME`,
 * so those three assert the column (T-144 evidence E2).
 *
 * Privilege refusals run over REAL LOGIN principals, each a member of exactly one role,
 * never `SET ROLE` from a superuser session (T-020 Evidence §4). The test that checks
 * each login's identity runs first, so a refusal cannot be mistaken for a wrong login.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { acquireMigratedCluster, PROBE_PASSWORD, type Cluster, type PsqlResult } from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'locale-registry';
const TABLE = 'public.locale_registry';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't144_app_rw_probe',
  app_admin_rw: 't144_app_admin_rw_probe',
  app_safety_rw: 't144_app_safety_rw_probe',
  answering_service: 't144_answering_service_probe',
} as const;

/** SD §DB-17 lines 3400–3401, as `psql -A -t` prints them, ordered by code. */
const SEED_ROWS = [
  'el|Ελληνικά|ltr|t|{one,other}|t',
  'en|English|ltr|t|{one,other}|t',
  'ru|Русский|ltr|t|{one,few,many,other}|t',
].join('\n');
const SEED_SQL = `SELECT code, endonym, direction, is_safety_language, plural_categories, enabled
                    FROM ${TABLE} ORDER BY code`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: Object.entries(LOGINS).map(
      ([role, login]) => `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
    ),
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** One statement as the bootstrap superuser, SQLSTATE in the message. */
function asSuperuser(sql: string): Promise<PsqlResult> {
  return db.psql({ commands: [sql], verbose: true, stopOnError: true });
}

/** One statement over a real login, SQLSTATE in the message. */
function asLogin(login: string, sql: string): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands: [sql],
    verbose: true,
    stopOnError: true,
  });
}

/** Refused with exactly this ERROR line, and psql named the object that refused it. */
function assertRefusedBy(what: string, r: PsqlResult, errorLine: string, field: string): void {
  assertRefused(what, r, { message: errorLine });
  assert.ok(r.output.includes(field), `${what}: expected ${JSON.stringify(field)} in the output.\n${r.output}`);
}

describe('0004 — the table, and the three rows SD §DB-17 seeds', () => {
  test('the seed rows equal SD §DB-17 lines 3400–3401 field by field, en included', async () => {
    const r = await db.psql({ commands: [SEED_SQL], raw: true });
    assertPermitted('read the seed rows', r);
    assert.equal(r.stdout.trim(), SEED_ROWS);
  });

  test('CONTROL — a well-formed new row is accepted, taking direction ltr and enabled true by default', async () => {
    const r = await db.psql({
      commands: [
        `INSERT INTO ${TABLE} (code, endonym, is_safety_language, plural_categories)
           VALUES ('t144-control', 'Control', false, ARRAY['other'])`,
        `SELECT direction || '|' || enabled FROM ${TABLE} WHERE code = 't144-control'`,
        `DELETE FROM ${TABLE} WHERE code = 't144-control'`,
      ],
      raw: true,
    });
    assertPermitted('insert, read and delete a control row', r);
    assert.ok(r.stdout.includes('ltr|t'), `defaults not applied:\n${r.output}`);
  });
});

describe('0004 — constraint refusals (as the superuser, so no privilege is what refuses them)', () => {
  test('a second row with code en is REFUSED by locale_registry_pkey (23505)', async () => {
    assertRefusedBy(
      'duplicate en',
      await asSuperuser(`INSERT INTO ${TABLE} VALUES ('en', 'English', 'ltr', true, ARRAY['one','other'], true)`),
      'ERROR:  23505: duplicate key value violates unique constraint "locale_registry_pkey"',
      'CONSTRAINT NAME:  locale_registry_pkey',
    );
  });

  test("direction = 'up' is REFUSED by locale_registry_direction_check (23514)", async () => {
    assertRefusedBy(
      "direction 'up'",
      await asSuperuser(
        `INSERT INTO ${TABLE} (code, endonym, direction, is_safety_language, plural_categories)
           VALUES ('t144-up', 'Up', 'up', true, ARRAY['other'])`,
      ),
      'ERROR:  23514: new row for relation "locale_registry" violates check constraint "locale_registry_direction_check"',
      'CONSTRAINT NAME:  locale_registry_direction_check',
    );
  });

  const NULLED: ReadonlyArray<readonly [column: string, values: string]> = [
    ['is_safety_language', `'t144-n1', 'N1', NULL, ARRAY['other']`],
    ['plural_categories', `'t144-n2', 'N2', true, NULL`],
    ['endonym', `'t144-n3', NULL, true, ARRAY['other']`],
  ];
  for (const [column, values] of NULLED) {
    test(`${column} NULL is REFUSED by its NOT NULL constraint (23502)`, async () => {
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(
          `INSERT INTO ${TABLE} (code, endonym, is_safety_language, plural_categories) VALUES (${values})`,
        ),
        `ERROR:  23502: null value in column "${column}" of relation "locale_registry" violates not-null constraint`,
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('after the refusals the table still holds exactly the seed rows', async () => {
    const r = await db.psql({ commands: [SEED_SQL], raw: true });
    assertPermitted('re-read the seed rows', r);
    assert.equal(r.stdout.trim(), SEED_ROWS);
  });
});

describe('0004 — grants: app_rw reads, and nothing else is granted', () => {
  test('each probe is a real login, not a superuser, and a member of exactly its one role', async () => {
    for (const [role, login] of Object.entries(LOGINS)) {
      const r = await db.psql({
        user: login,
        password: PROBE_PASSWORD,
        raw: true,
        commands: [
          `SELECT session_user || '|' || rolsuper || '|' ||
                  (SELECT string_agg(b.rolname, ',') FROM pg_auth_members m
                     JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid)
             FROM pg_roles r WHERE r.rolname = session_user`,
        ],
      });
      assertPermitted(`connect as ${login}`, r);
      assert.equal(r.stdout.trim(), `${login}|false|${role}`);
    }
  });

  test('app_rw SELECT is PERMITTED, and reads the three codes', async () => {
    const r = await db.psql({
      user: LOGINS.app_rw,
      password: PROBE_PASSWORD,
      raw: true,
      commands: [`SELECT string_agg(code, ',' ORDER BY code) FROM ${TABLE}`],
    });
    assertPermitted('app_rw SELECT', r);
    assert.equal(r.stdout.trim(), 'el,en,ru');
  });

  const REFUSED: ReadonlyArray<readonly [what: string, login: string, sql: string]> = [
    ['app_rw INSERT', LOGINS.app_rw, `INSERT INTO ${TABLE} VALUES ('tr', 'Türkçe', 'ltr', false, ARRAY['one','other'], true)`],
    ['app_rw UPDATE', LOGINS.app_rw, `UPDATE ${TABLE} SET enabled = false WHERE code = 'ru'`],
    ['app_rw DELETE', LOGINS.app_rw, `DELETE FROM ${TABLE} WHERE code = 'ru'`],
    ['answering_service SELECT', LOGINS.answering_service, `SELECT code FROM ${TABLE}`],
    ['app_safety_rw SELECT', LOGINS.app_safety_rw, `SELECT code FROM ${TABLE}`],
    ['app_admin_rw SELECT', LOGINS.app_admin_rw, `SELECT code FROM ${TABLE}`],
  ];
  for (const [what, login, sql] of REFUSED) {
    test(`${what} is REFUSED (42501)`, async () => {
      assertRefused(what, await asLogin(login, sql), {
        message: 'ERROR:  42501: permission denied for table locale_registry',
      });
    });
  }

  test('after the refusals the table still holds exactly the seed rows', async () => {
    const r = await db.psql({ commands: [SEED_SQL], raw: true });
    assertPermitted('re-read the seed rows', r);
    assert.equal(r.stdout.trim(), SEED_ROWS);
  });
});

describe('0004 — the SA §INT-10 guard, called DIRECTLY (OD-76)', () => {
  test('after up the guard returns clean', async () => {
    assertPermitted(
      'direct call after up',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  test('the same reading raises on a known-bad state, and is clean again once it is removed', async () => {
    // A detective-only grant (T-020 § contract §5): it fires no trigger, so only the call sees it.
    assertPermitted('plant', await asSuperuser('GRANT TEMPORARY ON DATABASE kinvara TO answering_service'));
    const bad = await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()');
    assertPermitted('remove', await asSuperuser('REVOKE TEMPORARY ON DATABASE kinvara FROM answering_service'));
    assertRefusedBy(
      'direct call on the known-bad state',
      bad,
      `ERROR:  KV010: ${INT10_RAISE}`,
      'answering_service holds TEMPORARY on database kinvara',
    );
    assertPermitted(
      'direct call after removal',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  test('GRANT SELECT on locale_registry to answering_service is REFUSED by the guard, and lands nothing', async () => {
    assertRefusedBy(
      'GRANT SELECT to answering_service',
      await asSuperuser(`GRANT SELECT ON ${TABLE} TO answering_service`),
      `ERROR:  KV010: ${INT10_RAISE}`,
      'answering_service holds SELECT on public.locale_registry',
    );
    assert.equal(
      await db.value(`SELECT has_table_privilege('answering_service', '${TABLE}', 'SELECT')::text`),
      'false',
    );
  });
});
