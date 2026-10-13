/**
 * T-211 — the cluster state transition trigger and CHECK (migration 0028): C12 (b) of
 * tasks/state/EP-2/OE-30-34-rulings.md (resolved by precedence, OE-49 (2)) as cut in
 * tasks/state/EP-8b/OD-226-cut.md § 3 P-C12, under OE-52 (the forged-snapshot bound is accepted;
 * no sixth role) and B.3 T-160 U-3 (1a), U-7 (a) (OE-50). The table itself is T-161's and is pinned
 * by suites/cluster.test.ts, which also carries the one-line trigger / rule / policy pin.
 *
 * What is pinned here: the function (owner, SECURITY INVOKER, ACL, the search_path pin, comment),
 * the trigger (timing, events, level, enabled, comment), the CHECK (deparse as measured, comment),
 * and every row of the transition matrix in 0028's header, each refusal beside a control that
 * differs from it only in the value under test.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND the
 * `COLUMN NAME:` field the trigger sets (or the `CONSTRAINT NAME:` PostgreSQL sets for a CHECK),
 * AND exactly one ERROR line, so a crash, a syntax error or a refusal for another reason cannot
 * read as this one. Where a refusal needs a row in a given state first, the case reads that state
 * back before the refused statement (`state=` lines), so a setup that silently failed cannot make
 * the refusal look like the trigger's.
 *
 * Every write in the matrix runs over the REAL LOGIN of a member of exactly one role, app_rw
 * (T-020 Evidence §4): what is measured is what core (T-209) and worker (T-216) meet. The bootstrap
 * superuser is used only for the cases that say so (the trigger and the CHECK bind it too; the CHECK
 * alone, with the trigger disabled in a rolled-back transaction, plant asserted landed). Every write
 * runs inside a transaction that is never committed (`inTransaction`), so the table is empty
 * throughout, and a "fresh" snapshot is one stamped with that transaction's now().
 *
 * The LAST describe block runs db:migrate down to 0027 and up again, so it changes the cluster and
 * stays last.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  acquireMigratedCluster,
  judgeMigrateRun,
  MIGRATIONS_DIR,
  PROBE_PASSWORD,
  REPO_ROOT,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused } from '../src/expect.ts';

const SUITE = 'cluster-state';
const TABLE = 'public.cluster';
const COMMITTED_DIR = path.join(REPO_ROOT, MIGRATIONS_DIR);
const APP_RW = 't211_app_rw_probe';

/** The six threshold keys 0028 reads, in PM order (PM 1636–1641). Published in T-211's contract. */
const KEYS = [
  'bookableSitters',
  'fridayPeakSitters',
  'infantQualifiedSitters',
  'simulatedSearchMedian',
  'russianValidatedSitters',
  'visitorReadySitters',
] as const;
type Key = (typeof KEYS)[number];
const REQUIRED: Readonly<Record<Key, number>> = {
  bookableSitters: 20,
  fridayPeakSitters: 8,
  infantQualifiedSitters: 4,
  simulatedSearchMedian: 5,
  russianValidatedSitters: 3,
  visitorReadySitters: 5,
};

/** The thresholds object as JSON text: every entry passing unless `fail` names it; `omit` drops entries. */
function thresholds(fail: readonly Key[] = [], omit: readonly Key[] = []): string {
  const entries = KEYS.filter((k) => !omit.includes(k)).map((k) => {
    const pass = !fail.includes(k);
    const measured = pass ? REQUIRED[k] + 1 : REQUIRED[k] - 1;
    return `"${k}": {"measured": ${String(measured)}, "required": ${String(REQUIRED[k])}, "pass": ${String(pass)}}`;
  });
  return `{${entries.join(', ')}}`;
}

/**
 * A snapshot as a SQL expression. `computedAt` is a SQL jsonb expression, by default the writing
 * transaction's now() (fresh); `thresholdsJson` is JSON text.
 */
function snapshot(
  opts: { readonly computedAt?: string; readonly thresholdsJson?: string } = {},
): string {
  return `jsonb_build_object('computedAt', ${opts.computedAt ?? 'to_jsonb(now())'}, 'thresholds', '${opts.thresholdsJson ?? thresholds()}'::jsonb)`;
}
const FRESH_ALL_PASS = snapshot();
const STALE_ALL_PASS = snapshot({ computedAt: `to_jsonb(now() - interval '1 second')` });

const POLY = 'POLYGON((33 34.6,33.1 34.6,33.1 34.7,33 34.7,33 34.6))';
const NAMES = '{"el": "Συστάδα δοκιμής", "en": "Test cluster", "ru": "Тестовый кластер"}';
const ROW = `name = 't211 control'`;

/** An INSERT of a well-formed row; `density_snapshot` is omitted unless given (its default is {}). */
function insertRow(state: string, densitySnapshot?: string): string {
  const cols = ['metro', 'name', 'boundary', 'state', 'name_i18n'];
  const vals = [`'CY'`, `'t211 control'`, `'SRID=4326;${POLY}'`, `'${state}'`, `'${NAMES}'`];
  if (densitySnapshot !== undefined) {
    cols.push('density_snapshot');
    vals.push(densitySnapshot);
  }
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
}
const update = (set: string): string => `UPDATE ${TABLE} SET ${set} WHERE ${ROW}`;
const READ_STATE = `SELECT 'state=' || state FROM ${TABLE} WHERE ${ROW}`;
/** The statement that opens a waitlist row legitimately (C1). */
const OPEN_IT = update(`state = 'open', density_snapshot = ${FRESH_ALL_PASS}`);

/** Setup statements leaving the control row in `state`, read back. */
function rowIn(state: 'waitlist' | 'open' | 'closed'): string[] {
  if (state === 'open') return [insertRow('waitlist'), OPEN_IT, READ_STATE];
  return [insertRow(state), READ_STATE];
}

const KV073 = (rule: string): string =>
  `ERROR:  KV073: CLUSTER_STATE_TRANSITION_REFUSED: ${rule} (trg_cluster_state_transition)`;
const R_INSERT_OPEN = KV073('a cluster is inserted as waitlist or closed, never open');
const R_INSERT_SNAPSHOT = KV073('a cluster is inserted with the empty density snapshot');
const R_CLOSED_OPEN = KV073('a closed cluster reopens to waitlist, never directly to open');
const R_NEW_SNAPSHOT = KV073(
  'a cluster moves into or out of open only in a statement that writes a new density snapshot',
);
const R_MALFORMED = KV073('the density snapshot written with this change is not well formed');
const R_STALE = KV073(
  'the density snapshot written with this change was not computed in the writing transaction',
);
const R_ALL_PASS = KV073('a cluster becomes open only when all six density thresholds pass');
const R_NEEDS_FAIL = KV073(
  'an open cluster returns to waitlist only when a density threshold fails',
);
const CHECK = 'cluster_open_requires_passing_snapshot';
const CHECK_23514 = (name: string): string =>
  `ERROR:  23514: new row for relation "cluster" violates check constraint "${name}"`;
const COL_STATE = 'COLUMN NAME:  state';
const COL_SNAPSHOT = 'COLUMN NAME:  density_snapshot';

/** The CHECK as PostgreSQL deparses it (measured, pg_get_constraintdef): jsonb reorders the keys. */
const CHECK_DEPARSE =
  'CHECK (((state <> \'open\'::text) OR (density_snapshot @> \'{"thresholds": {"bookableSitters": {"pass": true}, ' +
  '"fridayPeakSitters": {"pass": true}, "visitorReadySitters": {"pass": true}, "simulatedSearchMedian": {"pass": true}, ' +
  '"infantQualifiedSitters": {"pass": true}, "russianValidatedSitters": {"pass": true}}}\'::jsonb)))';

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [`CREATE ROLE ${APP_RW} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_rw`],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** BEGIN is prepended; psql's session end rolls the transaction back. */
const inTransaction = (commands: readonly string[]): string[] => ['BEGIN', ...commands];

function asAppRw(...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: APP_RW,
    password: PROBE_PASSWORD,
    commands: inTransaction(commands),
    verbose: true,
    stopOnError: true,
  });
}

function asSuperuser(...commands: string[]): Promise<PsqlResult> {
  return db.psql({ commands: inTransaction(commands), verbose: true, stopOnError: true });
}

/** Refused with exactly this ERROR line and this field, and there was exactly one ERROR. */
function assertRefusedBy(what: string, r: PsqlResult, errorLine: string, field: string): void {
  assertRefused(what, r, { message: errorLine });
  assert.ok(r.output.includes(field), `${what}: expected ${JSON.stringify(field)}.\n${r.output}`);
  assert.equal(
    (r.output.match(/ERROR: {2}[0-9A-Z]{5}:/g) ?? []).length,
    1,
    `${what}: expected exactly one ERROR line.\n${r.output}`,
  );
}

/** The setup reached `state` before the statement under test (read back by READ_STATE). */
function assertReached(what: string, r: PsqlResult, state: string): void {
  assert.ok(
    r.output.includes(`state=${state}`),
    `${what}: precondition state=${state} not read.\n${r.output}`,
  );
}

/** Accepted, and the last statement left the row in `state` (read back after it). */
function assertNowIn(what: string, r: PsqlResult, state: string): void {
  assertPermitted(what, r);
  const states = r.output.match(/state=[a-z]+/g) ?? [];
  assert.equal(states.at(-1), `state=${state}`, `${what}: final state.\n${r.output}`);
}

describe('0028 — the function, the trigger and the CHECK in the catalogue', () => {
  test('public.cluster_state_transition(): owner app_ddl, SECURITY INVOKER, EXECUTE revoked from PUBLIC (owner only), search_path pinned to pg_catalog, pg_temp, plpgsql, returns trigger', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || coalesce(p.proacl::text, 'NULL') || '|' ||
                array_to_string(p.proconfig, ';') || '|' || l.lanname || '|' || format_type(p.prorettype, NULL)
           FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.oid = 'public.cluster_state_transition()'::regprocedure`,
      ),
      'app_ddl|false|{app_ddl=X/app_ddl}|search_path=pg_catalog, pg_temp|plpgsql|trigger',
    );
  });

  test('trg_cluster_state_transition is the only non-internal trigger on cluster: BEFORE, INSERT OR UPDATE (no column list), FOR EACH ROW, enabled (O), no WHEN, executing cluster_state_transition()', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(tgname || '|' || tgtype::text || '|' || tgenabled::text || '|' ||
                           coalesce(pg_get_expr(tgqual, tgrelid), 'no WHEN') || '|' || tgattr::text || '|' ||
                           tgfoid::regprocedure::text, ' ; ')
           FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal`,
      ),
      // tgtype 23 = ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16).
      'trg_cluster_state_transition|23|O|no WHEN||cluster_state_transition()',
    );
  });

  test(`${CHECK} deparses exactly as measured (jsonb containment of six "pass": true entries), is not deferrable, and is validated`, async () => {
    assert.equal(
      await db.value(
        `SELECT condeferrable::text || ' ' || convalidated::text || ' ' || pg_get_constraintdef(oid)
           FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND conname = '${CHECK}'`,
      ),
      `false true ${CHECK_DEPARSE}`,
    );
  });

  test('the function, trigger and CHECK carry their comments, each naming C12', async () => {
    const r = await db.value(
      `SELECT (obj_description('public.cluster_state_transition()'::regprocedure, 'pg_proc') LIKE 'BEFORE INSERT OR UPDATE row trigger function on cluster (trg_cluster_state_transition; C12 (b)).%')::text || ' ' ||
              (SELECT obj_description(oid, 'pg_trigger') LIKE 'C12 (b): the cluster state transition matrix%' FROM pg_trigger
                WHERE tgrelid = '${TABLE}'::regclass AND tgname = 'trg_cluster_state_transition')::text || ' ' ||
              (SELECT obj_description(oid, 'pg_constraint') FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND conname = '${CHECK}')`,
    );
    assert.equal(
      r,
      'true true C12 (b), PM 1634: an open cluster holds a density snapshot in which all six thresholds have pass true.',
    );
  });

  test(`the probe login ${APP_RW} is a real login, not a superuser, and a member of app_rw alone`, async () => {
    const r = await db.psql({
      user: APP_RW,
      password: PROBE_PASSWORD,
      raw: true,
      commands: [
        `SELECT session_user || '|' || rolsuper || '|' ||
                (SELECT string_agg(b.rolname, ',') FROM pg_auth_members m
                   JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid)
           FROM pg_roles r WHERE r.rolname = session_user`,
      ],
    });
    assertPermitted('probe login', r);
    assert.equal(r.stdout.trim(), `${APP_RW}|false|app_rw`);
  });
});

describe('INSERT — a cluster starts waitlist or closed, with the empty snapshot, as app_rw', () => {
  test("INSERT with state 'open' and the default snapshot is REFUSED (KV073)", async () => {
    assertRefusedBy('insert open', await asAppRw(insertRow('open')), R_INSERT_OPEN, COL_STATE);
  });

  test("INSERT with state 'open' and a fresh all-pass snapshot is REFUSED too (KV073): open is reached only by an UPDATE", async () => {
    assertRefusedBy(
      'insert open, all-pass',
      await asAppRw(insertRow('open', FRESH_ALL_PASS)),
      R_INSERT_OPEN,
      COL_STATE,
    );
  });

  for (const state of ['waitlist', 'closed']) {
    test(`INSERT ${state} with a non-empty snapshot (a fresh all-pass one) is REFUSED (KV073)`, async () => {
      assertRefusedBy(
        `insert ${state} with snapshot`,
        await asAppRw(insertRow(state, FRESH_ALL_PASS)),
        R_INSERT_SNAPSHOT,
        COL_SNAPSHOT,
      );
    });
  }

  test(`INSERT waitlist with a JSON array as the snapshot is REFUSED (KV073): only the empty object is accepted`, async () => {
    assertRefusedBy(
      'insert waitlist with []',
      await asAppRw(insertRow('waitlist', `'[]'`)),
      R_INSERT_SNAPSHOT,
      COL_SNAPSHOT,
    );
  });

  test("CONTROL — INSERT waitlist omitting density_snapshot (stores '{}'), waitlist with an explicit '{}', and closed with '{}' are each accepted", async () => {
    const r = await asAppRw(
      insertRow('waitlist'),
      `SELECT 'snap=' || density_snapshot::text FROM ${TABLE} WHERE ${ROW}`,
      insertRow('waitlist', `'{}'`),
      insertRow('closed', `'{}'::jsonb`),
    );
    assertPermitted('inserts', r);
    assert.equal((r.output.match(/INSERT 0 1/g) ?? []).length, 3, r.output);
    assert.ok(r.output.includes('snap={}'), `default snapshot:\n${r.output}`);
  });

  test('a NULL density_snapshot on INSERT is left to its NOT NULL (23502), not read by the trigger', async () => {
    assertRefusedBy(
      'insert NULL snapshot',
      await asAppRw(insertRow('waitlist', 'NULL')),
      'ERROR:  23502: null value in column "density_snapshot" of relation "cluster" violates not-null constraint',
      COL_SNAPSHOT,
    );
  });
});

describe('waitlist → open — only with a new, well-formed, fresh, all-pass snapshot in the same statement, as app_rw', () => {
  test('CONTROL — waitlist → open with a fresh all-pass snapshot is accepted (UPDATE 1, state open)', async () => {
    const r = await asAppRw(...rowIn('waitlist'), OPEN_IT, READ_STATE);
    assertReached('open control', r, 'waitlist');
    assert.ok(r.output.includes('UPDATE 1'), r.output);
    assertNowIn('open control', r, 'open');
  });

  test('waitlist → open with no snapshot change (state only) is REFUSED (KV073)', async () => {
    const r = await asAppRw(...rowIn('waitlist'), update(`state = 'open'`));
    assertReached('state only', r, 'waitlist');
    assertRefusedBy('state only', r, R_NEW_SNAPSHOT, COL_SNAPSHOT);
  });

  test('waitlist → open re-writing the snapshot it already holds (a fresh all-pass one written while waitlist, in the same transaction) is REFUSED (KV073): the snapshot must differ', async () => {
    const r = await asAppRw(
      ...rowIn('waitlist'),
      update(`density_snapshot = ${FRESH_ALL_PASS}`),
      READ_STATE,
      update(`state = 'open', density_snapshot = density_snapshot`),
    );
    assertReached('same snapshot', r, 'waitlist');
    assertRefusedBy('same snapshot', r, R_NEW_SNAPSHOT, COL_SNAPSHOT);
  });

  test('waitlist → open with a stale computedAt (now() minus one second) is REFUSED (KV073)', async () => {
    const r = await asAppRw(
      ...rowIn('waitlist'),
      update(`state = 'open', density_snapshot = ${STALE_ALL_PASS}`),
    );
    assertReached('stale', r, 'waitlist');
    assertRefusedBy('stale', r, R_STALE, COL_SNAPSHOT);
  });

  test('waitlist → open with a computedAt from a client clock (millisecond precision, an hour ago) is REFUSED (KV073)', async () => {
    const r = await asAppRw(
      ...rowIn('waitlist'),
      update(
        `state = 'open', density_snapshot = ${snapshot({ computedAt: `to_jsonb(to_char((now() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))` })}`,
      ),
    );
    assertReached('client clock', r, 'waitlist');
    assertRefusedBy('client clock', r, R_STALE, COL_SNAPSHOT);
  });

  for (const failing of KEYS) {
    test(`waitlist → open with five of six passing (${failing} fails; RK-8) is REFUSED by the trigger (KV073), before the CHECK`, async () => {
      const r = await asAppRw(
        ...rowIn('waitlist'),
        update(
          `state = 'open', density_snapshot = ${snapshot({ thresholdsJson: thresholds([failing]) })}`,
        ),
      );
      assertReached('five of six', r, 'waitlist');
      assertRefusedBy(`five of six (${failing})`, r, R_ALL_PASS, COL_STATE);
    });
  }

  test("CONTROL — computedAt written in another TimeZone (SET LOCAL TimeZone 'Asia/Nicosia', so the text carries +03:00) is accepted: the comparison is of instants", async () => {
    const r = await asAppRw(
      ...rowIn('waitlist'),
      `SET LOCAL TimeZone = 'Asia/Nicosia'`,
      `SELECT 'offset=' || (to_jsonb(now()) #>> '{}')`,
      OPEN_IT,
      READ_STATE,
    );
    assert.ok(/offset=\S+\+0[23]:00/.test(r.output), `offset not shown:\n${r.output}`);
    assertNowIn('Nicosia', r, 'open');
  });

  test('CONTROL — the two OE-53 columns are not read: a cluster with both NULL (unknown) opens on a fresh all-pass snapshot (T-216 must not write a pass for an unknown)', async () => {
    const r = await asAppRw(
      ...rowIn('waitlist'),
      `SELECT 'oe53=' || coalesce(russian_speaking_share_pct::text, 'NULL') || '/' ||
              coalesce(has_hotel_or_holiday_let_inventory::text, 'NULL') FROM ${TABLE} WHERE ${ROW}`,
      OPEN_IT,
      READ_STATE,
    );
    assert.ok(r.output.includes('oe53=NULL/NULL'), r.output);
    assertNowIn('OE-53 unread', r, 'open');
  });

  test('NOT HELD (OE-52) — a snapshot app_rw simply asserts (no density computation behind it) opens the cluster: the database cannot tell the density job from core', async () => {
    const r = await asAppRw(
      ...rowIn('waitlist'),
      update(
        `state = 'open', density_snapshot = jsonb_build_object('computedAt', to_jsonb(now()), 'thresholds', '${thresholds().replace(/"measured": \d+/g, '"measured": 0')}'::jsonb)`,
      ),
      READ_STATE,
    );
    assertNowIn('forged', r, 'open');
  });

  test('NOT HELD — extra keys are not read: a seventh entry and an entry "bookableSittersX", each with pass false, leave an all-six-pass snapshot opening the cluster', async () => {
    const extra = thresholds().replace(
      /}$/,
      ', "seventh": {"pass": false}, "bookableSittersX": {"pass": false}}',
    );
    const r = await asAppRw(
      ...rowIn('waitlist'),
      update(`state = 'open', density_snapshot = ${snapshot({ thresholdsJson: extra })}`),
      READ_STATE,
    );
    assertNowIn('extra keys', r, 'open');
  });
});

describe('a snapshot that is not well formed is REFUSED, never read as passing (waitlist → open, as app_rw)', () => {
  const without = (k: Key): string => thresholds([], [k]);
  const withPass = (v: string): string =>
    thresholds().replace(
      '"visitorReadySitters": {"measured": 6, "required": 5, "pass": true}',
      `"visitorReadySitters": {"measured": 6, "required": 5, "pass": ${v}}`,
    );
  const CASES: ReadonlyArray<readonly [what: string, snap: string]> = [
    ...KEYS.map(
      (k) => [`the ${k} entry missing`, snapshot({ thresholdsJson: without(k) })] as const,
    ),
    [
      'visitorReadySitters pass the string "true"',
      snapshot({ thresholdsJson: withPass('"true"') }),
    ],
    ['visitorReadySitters pass the number 1', snapshot({ thresholdsJson: withPass('1') })],
    ['visitorReadySitters pass JSON null', snapshot({ thresholdsJson: withPass('null') })],
    [
      'visitorReadySitters an entry that is a JSON true, not an object',
      snapshot({
        thresholdsJson: thresholds().replace(
          /"visitorReadySitters": \{[^}]*\}/,
          '"visitorReadySitters": true',
        ),
      }),
    ],
    ['thresholds missing', `jsonb_build_object('computedAt', to_jsonb(now()))`],
    [
      'thresholds a JSON array',
      `jsonb_build_object('computedAt', to_jsonb(now()), 'thresholds', '[]'::jsonb)`,
    ],
    ['computedAt missing', `jsonb_build_object('thresholds', '${thresholds()}'::jsonb)`],
    [
      'computedAt a JSON number (epoch seconds of now())',
      snapshot({ computedAt: `to_jsonb(extract(epoch FROM now()))` }),
    ],
    [
      "computedAt the string 'now' (valid timestamptz input, refused by the format rule)",
      snapshot({ computedAt: `'"now"'::jsonb` }),
    ],
    [
      'computedAt with no offset (now() at UTC, written without a zone: it would depend on TimeZone)',
      snapshot({
        computedAt: `to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))`,
      }),
    ],
    [
      'computedAt not a date (2026-13-45T00:00:00Z)',
      snapshot({ computedAt: `'"2026-13-45T00:00:00Z"'::jsonb` }),
    ],
    ['the snapshot a JSON array', `'[]'::jsonb`],
    [
      'an object with neither computedAt nor thresholds (the empty object is no change, refused above)',
      `'{"note": "none"}'::jsonb`,
    ],
  ];
  for (const [what, snap] of CASES) {
    test(`${what} → REFUSED (KV073, not well formed)`, async () => {
      const r = await asAppRw(
        ...rowIn('waitlist'),
        update(`state = 'open', density_snapshot = ${snap}`),
      );
      assertReached(what, r, 'waitlist');
      assertRefusedBy(what, r, R_MALFORMED, COL_SNAPSHOT);
    });
  }
});

describe('open → waitlist — only with a new, well-formed, fresh snapshot in which a threshold fails, as app_rw', () => {
  test('CONTROL — open → waitlist with a fresh snapshot in which one threshold fails is accepted', async () => {
    const r = await asAppRw(
      ...rowIn('open'),
      update(
        `state = 'waitlist', density_snapshot = ${snapshot({ thresholdsJson: thresholds(['infantQualifiedSitters']) })}`,
      ),
      READ_STATE,
    );
    assertReached('demote control', r, 'open');
    assertNowIn('demote control', r, 'waitlist');
  });

  test('open → waitlist with a fresh ALL-PASS snapshot is REFUSED (KV073): an admin closes a cluster, it does not demote one', async () => {
    const r = await asAppRw(
      ...rowIn('open'),
      update(
        `state = 'waitlist', density_snapshot = jsonb_set(${FRESH_ALL_PASS}, '{thresholds,bookableSitters,measured}', '30')`,
      ),
    );
    assertReached('demote all-pass', r, 'open');
    assertRefusedBy('demote all-pass', r, R_NEEDS_FAIL, COL_STATE);
  });

  test('open → waitlist with no snapshot change is REFUSED (KV073)', async () => {
    const r = await asAppRw(...rowIn('open'), update(`state = 'waitlist'`));
    assertReached('demote state only', r, 'open');
    assertRefusedBy('demote state only', r, R_NEW_SNAPSHOT, COL_SNAPSHOT);
  });

  test('open → waitlist with a stale failing snapshot is REFUSED (KV073)', async () => {
    const r = await asAppRw(
      ...rowIn('open'),
      update(
        `state = 'waitlist', density_snapshot = ${snapshot({ computedAt: `to_jsonb(now() - interval '1 day')`, thresholdsJson: thresholds(['bookableSitters']) })}`,
      ),
    );
    assertReached('demote stale', r, 'open');
    assertRefusedBy('demote stale', r, R_STALE, COL_SNAPSHOT);
  });

  test('open → waitlist with a failing snapshot missing an entry is REFUSED (KV073, not well formed)', async () => {
    const r = await asAppRw(
      ...rowIn('open'),
      update(
        `state = 'waitlist', density_snapshot = ${snapshot({ thresholdsJson: '{"bookableSitters": {"pass": false}}' })}`,
      ),
    );
    assertReached('demote malformed', r, 'open');
    assertRefusedBy('demote malformed', r, R_MALFORMED, COL_SNAPSHOT);
  });
});

describe('an open cluster stays open only with an all-pass snapshot, as app_rw', () => {
  test(`a fresh, well-formed snapshot with a failing entry written onto an open row is REFUSED by ${CHECK} (23514)`, async () => {
    const r = await asAppRw(
      ...rowIn('open'),
      update(
        `density_snapshot = ${snapshot({ thresholdsJson: thresholds(['fridayPeakSitters']) })}`,
      ),
    );
    assertReached('failing onto open', r, 'open');
    assertRefusedBy('failing onto open', r, CHECK_23514(CHECK), `CONSTRAINT NAME:  ${CHECK}`);
  });

  test('a stale all-pass snapshot written onto an open row is REFUSED (KV073)', async () => {
    const r = await asAppRw(...rowIn('open'), update(`density_snapshot = ${STALE_ALL_PASS}`));
    assertReached('stale onto open', r, 'open');
    assertRefusedBy('stale onto open', r, R_STALE, COL_SNAPSHOT);
  });

  test("a malformed snapshot written onto an open row (pass the string 'true') is REFUSED (KV073)", async () => {
    const r = await asAppRw(
      ...rowIn('open'),
      update(
        `density_snapshot = jsonb_set(${FRESH_ALL_PASS}, '{thresholds,simulatedSearchMedian,pass}', '"true"')`,
      ),
    );
    assertReached('malformed onto open', r, 'open');
    assertRefusedBy('malformed onto open', r, R_MALFORMED, COL_SNAPSHOT);
  });

  test('a NULL snapshot written onto an open row is left to its NOT NULL (23502)', async () => {
    const r = await asAppRw(...rowIn('open'), update('density_snapshot = NULL'));
    assertReached('NULL onto open', r, 'open');
    assertRefusedBy(
      'NULL onto open',
      r,
      'ERROR:  23502: null value in column "density_snapshot" of relation "cluster" violates not-null constraint',
      COL_SNAPSHOT,
    );
  });

  test('CONTROL — on an open row: a new fresh all-pass snapshot, then name_i18n and both OE-53 columns with no snapshot change, are each accepted, and the row stays open', async () => {
    const r = await asAppRw(
      ...rowIn('open'),
      update(
        `density_snapshot = jsonb_set(${FRESH_ALL_PASS}, '{thresholds,bookableSitters,measured}', '40')`,
      ),
      update(
        `name_i18n = '{"en": "Renamed", "el": "Μετονομάστηκε", "ru": "Переименован"}', russian_speaking_share_pct = 5, has_hotel_or_holiday_let_inventory = false`,
      ),
      READ_STATE,
    );
    assertReached('open edits', r, 'open');
    assert.equal((r.output.match(/UPDATE 1/g) ?? []).length, 3, r.output);
    assertNowIn('open edits', r, 'open');
  });
});

describe('closed, and the admin moves (U-7 (a)), as app_rw', () => {
  test('closed → open with a fresh all-pass snapshot is REFUSED (KV073): reopen is to waitlist', async () => {
    const r = await asAppRw(
      ...rowIn('closed'),
      update(`state = 'open', density_snapshot = ${FRESH_ALL_PASS}`),
    );
    assertReached('closed to open', r, 'closed');
    assertRefusedBy('closed to open', r, R_CLOSED_OPEN, COL_STATE);
  });

  test('CONTROL — closed → waitlist (admin reopen) is accepted, with no snapshot written', async () => {
    const r = await asAppRw(...rowIn('closed'), update(`state = 'waitlist'`), READ_STATE);
    assertReached('reopen', r, 'closed');
    assertNowIn('reopen', r, 'waitlist');
  });

  test('CONTROL — any → closed is accepted: waitlist → closed; open → closed with no snapshot change; open → closed writing {}; closed → closed', async () => {
    const a = await asAppRw(...rowIn('waitlist'), update(`state = 'closed'`), READ_STATE);
    assertReached('waitlist → closed', a, 'waitlist');
    assertNowIn('waitlist → closed', a, 'closed');
    const b = await asAppRw(...rowIn('open'), update(`state = 'closed'`), READ_STATE);
    assertReached('open → closed', b, 'open');
    assertNowIn('open → closed', b, 'closed');
    const c = await asAppRw(
      ...rowIn('open'),
      update(`state = 'closed', density_snapshot = '{}'`),
      READ_STATE,
    );
    assertReached('open → closed, {}', c, 'open');
    assertNowIn('open → closed, {}', c, 'closed');
    const d = await asAppRw(...rowIn('closed'), update(`state = 'closed'`), READ_STATE);
    assertNowIn('closed → closed', d, 'closed');
  });

  test('CONTROL — a closed cluster reopened to waitlist then opens on a fresh all-pass snapshot (closed → waitlist → open)', async () => {
    const r = await asAppRw(...rowIn('closed'), update(`state = 'waitlist'`), OPEN_IT, READ_STATE);
    assertNowIn('closed → waitlist → open', r, 'open');
  });

  test('NOT HELD — a waitlist or closed row may be given a snapshot of any shape (a JSON array, a stale all-pass one); gating reads state, and the next move to open needs a new fresh snapshot', async () => {
    const r = await asAppRw(
      ...rowIn('waitlist'),
      update(`density_snapshot = '[]'`),
      update(`density_snapshot = ${STALE_ALL_PASS}`),
      READ_STATE,
      insertRow('closed'),
      `UPDATE ${TABLE} SET density_snapshot = '"x"' WHERE state = 'closed'`,
    );
    assertPermitted('waitlist/closed snapshots', r);
    assert.equal((r.output.match(/UPDATE 1/g) ?? []).length, 3, r.output);
  });

  test("a NULL state and an unknown state are left to the constraints: waitlist → NULL is 23502, waitlist → 'Open' is cluster_state_check (23514)", async () => {
    const a = await asAppRw(...rowIn('waitlist'), update('state = NULL'));
    assertReached('NULL state', a, 'waitlist');
    assertRefusedBy(
      'NULL state',
      a,
      'ERROR:  23502: null value in column "state" of relation "cluster" violates not-null constraint',
      COL_STATE,
    );
    const b = await asAppRw(
      ...rowIn('waitlist'),
      update(`state = 'Open', density_snapshot = ${FRESH_ALL_PASS}`),
    );
    assertReached("'Open'", b, 'waitlist');
    assertRefusedBy(
      "'Open'",
      b,
      CHECK_23514('cluster_state_check'),
      'CONSTRAINT NAME:  cluster_state_check',
    );
  });
});

describe('the bound is the trigger and the CHECK, for every writer (bootstrap superuser, rolled back)', () => {
  test('the superuser meets the trigger too: an INSERT as open is REFUSED (KV073)', async () => {
    assertRefusedBy(
      'superuser insert open',
      await asSuperuser(insertRow('open')),
      R_INSERT_OPEN,
      COL_STATE,
    );
  });

  test(`THE CHECK ALONE — with the trigger disabled in a rolled-back transaction (plant asserted landed), the superuser setting an open row with each of: an entry missing, pass "true", pass 1, the empty object, is REFUSED by ${CHECK} (23514); the all-pass control is accepted`, async () => {
    const disable = [
      `ALTER TABLE ${TABLE} DISABLE TRIGGER trg_cluster_state_transition`,
      `SELECT 'planted=' || tgenabled::text FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND tgname = 'trg_cluster_state_transition'`,
    ];
    for (const [what, snap] of [
      ['entry missing', snapshot({ thresholdsJson: thresholds([], ['russianValidatedSitters']) })],
      [
        'pass "true"',
        `jsonb_set(${FRESH_ALL_PASS}, '{thresholds,russianValidatedSitters,pass}', '"true"')`,
      ],
      ['pass 1', `jsonb_set(${FRESH_ALL_PASS}, '{thresholds,russianValidatedSitters,pass}', '1')`],
      ['the empty object', `'{}'::jsonb`],
    ] as const) {
      const r = await asSuperuser(...disable, insertRow('open', snap));
      assert.ok(r.output.includes('planted=D'), `${what}: the plant did not land:\n${r.output}`);
      assertRefusedBy(`CHECK alone, ${what}`, r, CHECK_23514(CHECK), `CONSTRAINT NAME:  ${CHECK}`);
    }
    const ok = await asSuperuser(...disable, insertRow('open', FRESH_ALL_PASS));
    assert.ok(ok.output.includes('planted=D'), `control: the plant did not land:\n${ok.output}`);
    assertPermitted('CHECK alone, all-pass control', ok);
    assert.ok(ok.output.includes('INSERT 0 1'), ok.output);
  });
});

describe('0028 — after every case', () => {
  test('the table still holds no row (every write was rolled back)', async () => {
    assert.equal(await db.value(`SELECT count(*)::text FROM ${TABLE}`), '0');
  });
});

// LAST: changes the cluster (down to 0027, then up again).
describe('0028 down and up again — the refusals go with the migration and come back with it, as app_rw', () => {
  test('after db:migrate down --to 0027 an INSERT as open is ACCEPTED (T-161 § contract §3) and the function, trigger and CHECK are gone; after db:migrate up it is REFUSED (KV073) again', async () => {
    const down = await db.migrate(['down', '--to', '0027', '--dir', COMMITTED_DIR]);
    assert.equal(judgeMigrateRun(down).kind, 'OK', down.output);
    assert.equal(
      await db.value(
        `SELECT (to_regprocedure('public.cluster_state_transition()') IS NULL)::text || ' ' ||
                (SELECT count(*) FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal)::text || ' ' ||
                (SELECT count(*) FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND conname = '${CHECK}')::text`,
      ),
      'true 0 0',
    );
    const open = await asAppRw(insertRow('open'), READ_STATE);
    assertNowIn('open accepted at 0027', open, 'open');

    const up = await db.migrate(['up', '--dir', COMMITTED_DIR]);
    assert.equal(judgeMigrateRun(up).kind, 'OK', up.output);
    assertRefusedBy(
      'open refused at 0028 again',
      await asAppRw(insertRow('open')),
      R_INSERT_OPEN,
      COL_STATE,
    );
  });
});
