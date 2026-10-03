/**
 * T-240 — migration 0022: EXECUTE on the advisory-lock functions, revoked from PUBLIC (OE-74; OD-273).
 *
 * Before 0022 every role could call every one of PostgreSQL's 21 advisory-lock functions (their ACL is
 * NULL, i.e. EXECUTE for PUBLIC), so the vendor principal answering_service could take the audit chain's
 * published key, 5428598235315393603, and stall every audit_log append (T-215 QA-F2). 0022 revokes all
 * 21 from PUBLIC and grants back exactly:
 *   pg_advisory_xact_lock(bigint)            app_rw, app_ddl
 *   pg_advisory_xact_lock(integer, integer)  app_rw
 * app_ddl's grant is load-bearing: audit_log_chain() is SECURITY DEFINER owned by app_ddl, and its lock
 * call is checked against the definer (T-215 bct D1).
 *
 * Every call below runs over a REAL LOGIN that is a member of exactly one role (T-020 Evidence §4: a
 * refusal under SET ROLE is a weaker claim). Every refusal asserts psql's non-zero exit, the message
 * naming the function, and SQLSTATE 42501; each refused role has the superuser and app_rw beside it as
 * the controls. The expected function list and grant map are literals here, not readings of the
 * catalogue, so the catalogue cases are anchored outside the thing they check.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  installInt10Fixtures,
  installSafetyFixtures,
  AS_PROBE,
  SAFETY_PROBE,
  PROBE_PASSWORD,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused, SQLSTATE_INSUFFICIENT_PRIVILEGE } from '../src/expect.ts';

const SUITE = 'advisory-locks';

/** The chain key (T-215 § contract §3) and its two 32-bit halves. */
const KEY = '5428598235315393603';
const KEY_CLASSID = '1263944021';
const KEY_OBJID = '1145656387';
const GENESIS = '00'.repeat(32);

/** Every advisory-lock function PostgreSQL 18 ships, by signature, with the call this suite makes. */
interface Form {
  readonly sig: string;
  readonly name: string;
  readonly call: string;
}
const FORMS: readonly Form[] = (
  [
    'pg_advisory_lock',
    'pg_advisory_lock_shared',
    'pg_advisory_xact_lock',
    'pg_advisory_xact_lock_shared',
    'pg_try_advisory_lock',
    'pg_try_advisory_lock_shared',
    'pg_try_advisory_xact_lock',
    'pg_try_advisory_xact_lock_shared',
    'pg_advisory_unlock',
    'pg_advisory_unlock_shared',
  ] as const
)
  .flatMap((name): Form[] => [
    { sig: `${name}(bigint)`, name, call: `${name}(${KEY})` },
    { sig: `${name}(integer,integer)`, name, call: `${name}(${KEY_CLASSID}, ${KEY_OBJID})` },
  ])
  .concat([
    {
      sig: 'pg_advisory_unlock_all()',
      name: 'pg_advisory_unlock_all',
      call: 'pg_advisory_unlock_all()',
    },
  ]);

/** What 0022 grants, per signature (the owner, the bootstrap superuser, is left out). */
const GRANTED: Readonly<Record<string, string>> = {
  'pg_advisory_xact_lock(bigint)': 'app_ddl,app_rw',
  'pg_advisory_xact_lock(integer,integer)': 'app_rw',
};

/** One login per role, each a member of that role alone (the vendor and safety-gw logins come from fixtures). */
const LOGIN = {
  answering_service: AS_PROBE,
  app_safety_rw: SAFETY_PROBE,
  app_admin_rw: 't240_admin_probe',
  app_rw: 't240_rw_probe',
  app_rw_b: 't240_rw_probe_b',
  app_ddl: 't240_ddl_probe',
  pg_monitor: 't240_monitor_probe',
  fresh: 't240_fresh_probe',
} as const;

let db: Cluster;

const as = (user: string, ...commands: string[]): Promise<PsqlResult> =>
  db.psql({ user, password: PROBE_PASSWORD, commands, verbose: true, stopOnError: true });
const asSuperuser = (...commands: string[]): Promise<PsqlResult> =>
  db.psql({ commands, verbose: true, stopOnError: true });

function assertHas(what: string, r: PsqlResult, needle: string): void {
  assert.ok(
    r.output.includes(needle),
    `${what}: expected ${JSON.stringify(needle)} in the output.\n${r.output}`,
  );
}

/** A row through the parent, no hash and no seq named (T-215 § contract §5 (a)). */
const row = (action: string): string =>
  `INSERT INTO public.audit_log (occurred_at, actor_type, action, subject_type, request_context)
   VALUES ('2026-10-20 00:00:00+00', 'system', '${action}', 'probe', '{}')
   RETURNING '${action} seq=' || seq || ' prev=' || encode(prev_entry_hash, 'hex') || ' entry=' || encode(entry_hash, 'hex')`;

const WHOLE_CHAIN = `SELECT 'whole chain: ' || count(*) || ' rows, ' ||
       count(*) FILTER (WHERE p IS DISTINCT FROM prev_entry_hash) || ' mislinked'
  FROM (SELECT prev_entry_hash, coalesce(lag(entry_hash) OVER (ORDER BY seq), decode('${GENESIS}', 'hex')) AS p
          FROM public.audit_log) x`;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await installInt10Fixtures(db);
  await installSafetyFixtures(db);
  await db.sql({
    commands: [
      `CREATE ROLE ${LOGIN.app_admin_rw} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_admin_rw`,
      `CREATE ROLE ${LOGIN.app_rw} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_rw`,
      `CREATE ROLE ${LOGIN.app_rw_b} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_rw`,
      `CREATE ROLE ${LOGIN.app_ddl} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_ddl`,
      `CREATE ROLE ${LOGIN.pg_monitor} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE pg_monitor`,
      `CREATE ROLE ${LOGIN.fresh} LOGIN PASSWORD '${PROBE_PASSWORD}'`,
      // 0001 revokes CONNECT from PUBLIC; these two hold no application role that carries it.
      `GRANT CONNECT ON DATABASE kinvara TO ${LOGIN.pg_monitor}, ${LOGIN.fresh}`,
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

describe('0022 — the catalogue', () => {
  test('pg_catalog holds exactly the 21 advisory-lock functions this suite names (a server adding one would leave it unrevoked)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(replace(p.oid::regprocedure::text, ' ', ''), ',' ORDER BY replace(p.oid::regprocedure::text, ' ', '') COLLATE "C")
           FROM pg_proc p WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_'`,
      ),
      [...FORMS.map((f) => f.sig)].sort().join(','),
    );
  });

  test('every one of the 21: owner the bootstrap superuser, PUBLIC holds no EXECUTE, and the grantees are exactly 0022 grant map (no grant option anywhere)', async () => {
    const got = await db.value(
      `SELECT string_agg(sig || '=' || pg_get_userbyid(owner) || '[' || grantees || ']', ' ' ORDER BY sig COLLATE "C")
         FROM (SELECT replace(p.oid::regprocedure::text, ' ', '') AS sig, p.proowner AS owner,
                      coalesce((SELECT string_agg(g, ',' ORDER BY g COLLATE "C")
                                  FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
                                               || CASE WHEN a.is_grantable THEN '*' ELSE '' END AS g
                                          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                         WHERE a.grantee <> p.proowner) y), '') AS grantees
                 FROM pg_proc p WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_') x`,
    );
    const want = [...FORMS.map((f) => f.sig)]
      .sort()
      .map((s) => `${s}=app[${GRANTED[s] ?? ''}]`)
      .join(' ');
    assert.equal(got, want);
  });

  test('has_function_privilege agrees, per role: answering_service, app_safety_rw, app_admin_rw, pg_monitor may EXECUTE none; app_rw two; app_ddl one', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(r || '=' || n, ' ' ORDER BY r COLLATE "C") FROM (
           SELECT r, count(*) FILTER (WHERE has_function_privilege(r, p.oid, 'EXECUTE')) AS n
             FROM unnest(ARRAY['answering_service','app_safety_rw','app_admin_rw','pg_monitor','app_rw','app_ddl']) r
            CROSS JOIN pg_proc p WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_'
            GROUP BY r) x`,
      ),
      'answering_service=0 app_admin_rw=0 app_ddl=1 app_rw=2 app_safety_rw=0 pg_monitor=0',
    );
  });

  test('after up, kinvara_guard.assert_answering_service_write_only() called directly returns clean (OD-76)', async () => {
    assertPermitted(
      'guard',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });
});

describe('0022 — every form REFUSED (42501) over a real login of each role that never writes audit entries', () => {
  for (const [role, user] of [
    ['answering_service', LOGIN.answering_service],
    ['app_safety_rw', LOGIN.app_safety_rw],
    ['app_admin_rw', LOGIN.app_admin_rw],
    ['pg_monitor (a predefined monitoring role)', LOGIN.pg_monitor],
    ['a fresh login (no role at all)', LOGIN.fresh],
  ] as const) {
    test(`${role}: each of the 21 forms is refused 42501, naming the function`, async () => {
      for (const f of FORMS) {
        assertRefused(`${role} ${f.call}`, await as(user, `SELECT ${f.call}`), {
          message: `permission denied for function ${f.name}`,
          sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE,
        });
      }
    });
  }

  test('CONTROL: the bootstrap superuser calls all 21 (so a refusal above is a privilege, not a broken call)', async () => {
    const r = await asSuperuser('BEGIN', ...FORMS.map((f) => `SELECT ${f.call}`), 'ROLLBACK');
    assertPermitted('superuser', r);
  });
});

describe('0022 — app_rw and app_ddl keep exactly the forms the inventory needs', () => {
  test('app_rw: pg_advisory_xact_lock(bigint) and (integer, integer) are permitted and visible in pg_locks as objsubid 1 and 2; the other 19 are refused 42501', async () => {
    const ok = await as(
      LOGIN.app_rw,
      'BEGIN',
      `SELECT pg_advisory_xact_lock(${KEY})`,
      `SELECT pg_advisory_xact_lock(${KEY_CLASSID}, ${KEY_OBJID})`,
      `SELECT 'mine: ' || string_agg(objsubid || ' ' || mode, ',' ORDER BY objsubid) FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
      'COMMIT',
    );
    assertPermitted('app_rw xact', ok);
    assertHas('app_rw xact', ok, 'mine: 1 ExclusiveLock,2 ExclusiveLock');
    for (const f of FORMS.filter((x) => !(GRANTED[x.sig] ?? '').split(',').includes('app_rw'))) {
      assertRefused(`app_rw ${f.call}`, await as(LOGIN.app_rw, `SELECT ${f.call}`), {
        message: `permission denied for function ${f.name}`,
        sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE,
      });
    }
  });

  test('app_ddl: pg_advisory_xact_lock(bigint) is permitted; the other 20 are refused 42501', async () => {
    assertPermitted(
      'app_ddl xact',
      await as(LOGIN.app_ddl, `SELECT pg_advisory_xact_lock(${KEY})`),
    );
    for (const f of FORMS.filter((x) => x.sig !== 'pg_advisory_xact_lock(bigint)')) {
      assertRefused(`app_ddl ${f.call}`, await as(LOGIN.app_ddl, `SELECT ${f.call}`), {
        message: `permission denied for function ${f.name}`,
        sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE,
      });
    }
  });

  test("app_rw runs pg-boss 12.26.4's own lock statement verbatim (plans.js advisoryLock(), schema pgboss)", async () => {
    assertPermitted(
      'pg-boss lock',
      await as(
        LOGIN.app_rw,
        'BEGIN',
        `SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint
  )`,
        'COMMIT',
      ),
    );
  });
});

describe('0022 — the chain still works for its writers (rows COMMITTED from here on)', () => {
  test('an app_rw login appends two rows: the first chains to genesis, the second to the first; the whole chain walks clean', async () => {
    const r = await as(LOGIN.app_rw, row('t240-a'), row('t240-b'), WHOLE_CHAIN);
    assertPermitted('append', r);
    assertHas('append', r, `t240-a seq=`);
    const a = /t240-a seq=\d+ prev=([0-9a-f]{64}) entry=([0-9a-f]{64})/.exec(r.output);
    const b = /t240-b seq=\d+ prev=([0-9a-f]{64}) entry=([0-9a-f]{64})/.exec(r.output);
    assert.ok(a !== null && b !== null, r.output);
    assert.equal(a[1], GENESIS);
    assert.equal(b[1], a[2]);
    assertHas('append', r, 'whole chain: 2 rows, 0 mislinked');
  });

  test('two app_rw logins: A appends and holds its transaction 3 s; B appends 1 s later, WAITS on the chain lock, then chains to A', async () => {
    const [a, b, o] = await Promise.all([
      db.psql({
        user: LOGIN.app_rw,
        password: PROBE_PASSWORD,
        verbose: true,
        stopOnError: true,
        commands: [
          `SET application_name = 't240-A'`,
          'BEGIN',
          row('t240-cc-A'),
          'SELECT pg_sleep(3)',
          'COMMIT',
        ],
      }),
      db.psql({
        user: LOGIN.app_rw_b,
        password: PROBE_PASSWORD,
        verbose: true,
        stopOnError: true,
        commands: [`SET application_name = 't240-B'`, 'SELECT pg_sleep(1)', row('t240-cc-B')],
      }),
      db.psql({
        verbose: true,
        stopOnError: true,
        commands: [
          'SELECT pg_sleep(2)',
          `SELECT 'observed: ' || coalesce(string_agg(a.application_name || '=' || CASE WHEN l.granted THEN 'holds' ELSE 'waits' END, ' ' ORDER BY a.application_name), 'nobody')
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.classid = ${KEY_CLASSID} AND l.objid = ${KEY_OBJID} AND l.objsubid = 1
              AND a.application_name LIKE 't240-%'`,
        ],
      }),
    ]);
    assertPermitted('A', a);
    assertPermitted('B', b);
    const aEntry = /t240-cc-A seq=\d+ prev=[0-9a-f]{64} entry=([0-9a-f]{64})/.exec(a.output)?.[1];
    assert.ok(aEntry !== undefined, a.output);
    assertHas('B chains to A', b, `prev=${aEntry}`);
    assertHas('observer', o, 'observed: t240-A=holds t240-B=waits');
    assertHas('walk', await asSuperuser(WHOLE_CHAIN), ' 0 mislinked');
  });

  test('OD-273 closed: answering_service tries to take the chain key (exclusive and shared, session scope) and is refused; an app_rw append under lock_timeout 2 s lands', async () => {
    for (const fn of ['pg_advisory_lock', 'pg_advisory_lock_shared', 'pg_try_advisory_lock']) {
      assertRefused(`vendor ${fn}`, await as(LOGIN.answering_service, `SELECT ${fn}(${KEY})`), {
        message: `permission denied for function ${fn}`,
        sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE,
      });
    }
    const r = await as(
      LOGIN.app_rw,
      `SET lock_timeout = '2s'`,
      row('t240-after-vendor'),
      WHOLE_CHAIN,
    );
    assertPermitted('append after vendor', r);
    assertHas('append after vendor', r, ' 0 mislinked');
  });

  test("LOAD-BEARING (T-215 bct D1): with app_ddl's EXECUTE on pg_advisory_xact_lock(bigint) revoked, an app_rw append is refused 42501 inside audit_log_chain() (superuser transaction, rolled back)", async () => {
    const r = await asSuperuser(
      'BEGIN',
      'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) FROM app_ddl',
      `SELECT 'app_ddl may execute: ' || has_function_privilege('app_ddl', 'pg_catalog.pg_advisory_xact_lock(bigint)', 'EXECUTE')`,
      'SET LOCAL ROLE app_rw',
      row('t240-no-definer-grant'),
    );
    assertHas('mutation landed', r, 'app_ddl may execute: false');
    assertRefused('definer grant removed', r, {
      message: 'permission denied for function pg_advisory_xact_lock',
      sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE,
    });
    assertHas('definer grant removed', r, 'audit_log_chain()');
    assert.equal(
      await db.value(
        `SELECT has_function_privilege('app_ddl', 'pg_catalog.pg_advisory_xact_lock(bigint)', 'EXECUTE')::text`,
      ),
      'true',
    );
  });
});

describe('0022 — NOT HELD: the SA §INT-10 guard does not read pg_catalog functions (T-240 M5; superuser, rolled back)', () => {
  for (const grantee of ['answering_service', 'PUBLIC']) {
    test(`a superuser GRANT EXECUTE ON pg_advisory_lock(bigint) TO ${grantee} is accepted, the guard's direct call returns clean, and answering_service then holds EXECUTE`, async () => {
      const r = await asSuperuser(
        'BEGIN',
        `GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO ${grantee}`,
        'SELECT kinvara_guard.assert_answering_service_write_only()',
        `SELECT 'vendor may execute: ' || has_function_privilege('answering_service', 'pg_catalog.pg_advisory_lock(bigint)', 'EXECUTE')`,
        'ROLLBACK',
      );
      assertPermitted(`guard silent on ${grantee}`, r);
      assertHas(`guard silent on ${grantee}`, r, 'vendor may execute: true');
      assert.equal(
        await db.value(
          `SELECT has_function_privilege('answering_service', 'pg_catalog.pg_advisory_lock(bigint)', 'EXECUTE')::text`,
        ),
        'false',
      );
    });
  }
});
