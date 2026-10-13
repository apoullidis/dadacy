/**
 * The RLS actor with no database (T-254): the constructors, the re-validation `withActor` runs
 * before any SQL, and the one statement it sends. Against a real Postgres (the GUCs read back, the
 * next transaction, a FORCE-RLS scratch table): `test/actor-context.spec.ts`.
 *
 * The role set's expected members are read from `@kinvara/policy`'s `ROLES` (the contract the set
 * is defined by), and the refused names are spelled out here, so a copied list that drifted from
 * the policy would fail one side or the other.
 */
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Pool } from 'pg';
import { ROLES } from '@kinvara/policy';
import {
  ACTOR_GUCS,
  ActorRefusedError,
  bindSystemActor,
  Database,
  personActor,
  SYSTEM_ACTOR_ROLE,
  systemActor,
  type Actor,
  type ActorRefusal,
} from './index.ts';
import { actorSettings } from './actor.ts';
import { SET_ACTOR_SQL } from './database.ts';

const ID = '01J9Z8Y7X6W5V4T3S2R1Q0P9N8';
const SENTINEL = 'postgres://SENTINEL-T254-user:SENTINEL-T254-pw@127.0.0.1:1/x';

function refused(reason: ActorRefusal): (e: unknown) => boolean {
  return (e: unknown) => {
    assert.ok(e instanceof ActorRefusedError, `expected ActorRefusedError, got ${String(e)}`);
    assert.equal(e.reason, reason);
    assert.equal(e.name, 'ActorRefusedError');
    assert.ok(!e.message.includes('SENTINEL'));
    return true;
  };
}

const ABSENT: readonly unknown[] = [undefined, null, '', 0, Number.NaN, false, {}, []];

test("a person actor: every role in @kinvara/policy's ROLES is accepted, with a well-formed account id", () => {
  assert.ok(ROLES.length >= 1, 'the policy contract has roles');
  for (const role of ROLES) {
    const a = personActor(ID, role);
    assert.equal(a.kind, 'person');
    assert.equal(a.accountId, ID);
    assert.equal(a.role, role);
    assert.ok(Object.isFrozen(a));
  }
});

test("a person actor's account id: '', null, 0 and every other spelling of absence or malformation is refused", () => {
  for (const bad of [
    ...ABSENT,
    ID.toLowerCase(),
    ID.slice(1),
    `${ID}0`,
    ` ${ID}`,
    '81J9Z8Y7X6W5V4T3S2R1Q0P9N8',
  ]) {
    assert.throws(() => personActor(bad, 'sitter'), refused('account_id'));
  }
});

test("a person actor's role outside @kinvara/policy's set is refused: 'system', 'deputy_dsl', 'referee', case and spacing variants", () => {
  for (const bad of [
    ...ABSENT,
    'system',
    'deputy_dsl',
    'referee',
    'Sitter',
    'SITTER',
    'sitter ',
    'admin',
    'operator',
  ]) {
    assert.throws(() => personActor(ID, bad), refused('role'));
  }
});

test("EV-40 CAVEAT: 'dsl' is accepted because @kinvara/policy's ROLES still holds it; 'deputy_dsl' is refused because the policy does not model it", () => {
  assert.equal((ROLES as readonly string[]).includes('dsl'), true);
  assert.equal(personActor(ID, 'dsl').role, 'dsl');
  assert.equal((ROLES as readonly string[]).includes('deputy_dsl'), false);
  assert.throws(() => personActor(ID, 'deputy_dsl'), refused('role'));
});

test('a system actor: a named job identity is accepted; absence, upper case, a ULID, spaces, quotes and 64 characters are refused', () => {
  for (const job of [
    'search.slot_materialise',
    'credential.q5-sweep',
    'reconcile:i1',
    'a',
    `a${'b'.repeat(62)}`,
  ]) {
    const a = systemActor(job);
    assert.equal(a.kind, 'system');
    assert.equal(a.job, job);
    assert.ok(Object.isFrozen(a));
  }
  for (const bad of [
    ...ABSENT,
    'Search.x',
    '1job',
    '_job',
    ID,
    'a b',
    "a'b",
    'a;b',
    `a${'b'.repeat(63)}`,
    'job\n',
  ]) {
    assert.throws(() => systemActor(bad), refused('job_identity'));
  }
});

test("actorSettings: a person sets (account id, role, 'off'), a system job sets (job, 'system', 'off')", () => {
  assert.deepEqual(actorSettings(personActor(ID, 'sitter'), undefined), {
    actorId: ID,
    actorRole: 'sitter',
    breakGlass: 'off',
  });
  assert.deepEqual(actorSettings(systemActor('credential.sweep'), undefined), {
    actorId: 'credential.sweep',
    actorRole: SYSTEM_ACTOR_ROLE,
    breakGlass: 'off',
  });
  assert.equal(SYSTEM_ACTOR_ROLE, 'system');
});

test("break-glass is 'on' only for exactly { breakGlass: true }; every other options value is refused", () => {
  assert.equal(
    actorSettings(personActor(ID, 'ts_operator'), { breakGlass: true }).breakGlass,
    'on',
  );
  assert.equal(actorSettings(systemActor('j'), { breakGlass: true }).breakGlass, 'on');
  for (const bad of [
    null,
    'on',
    true,
    1,
    {},
    { breakGlass: false },
    { breakGlass: 'true' },
    { breakGlass: 'on' },
    { breakGlass: true, purpose: 'x' },
  ]) {
    assert.throws(
      () => actorSettings(personActor(ID, 'sitter'), bad),
      refused('break_glass_option'),
    );
  }
});

test('actorSettings re-validates a FORGED actor (the brand is a type only): no actor, another kind, a bad id, role or job', () => {
  const cases: readonly [unknown, ActorRefusal][] = [
    [undefined, 'actor_missing'],
    [null, 'actor_missing'],
    ['sitter', 'actor_missing'],
    [{}, 'actor_kind'],
    [{ kind: 'operator', accountId: ID, role: 'sitter' }, 'actor_kind'],
    [{ kind: 'person', accountId: '', role: 'sitter' }, 'account_id'],
    [{ kind: 'person', accountId: null, role: 'sitter' }, 'account_id'],
    [{ kind: 'person', accountId: 0, role: 'sitter' }, 'account_id'],
    [{ kind: 'person', accountId: ID, role: 'system' }, 'role'],
    [{ kind: 'person', accountId: ID, role: 'deputy_dsl' }, 'role'],
    [{ kind: 'system', job: '' }, 'job_identity'],
    [{ kind: 'system', job: null }, 'job_identity'],
    [{ kind: 'system', job: 0 }, 'job_identity'],
  ];
  for (const [actor, reason] of cases) {
    assert.throws(() => actorSettings(actor, undefined), refused(reason));
  }
});

test('the one statement withActor adds is transaction-local set_config with three bind parameters, never the session form', () => {
  assert.equal(
    SET_ACTOR_SQL,
    "SELECT set_config('app.actor_id', $1, true), set_config('app.actor_role', $2, true), " +
      "set_config('app.break_glass', $3, true)",
  );
  assert.deepEqual(Object.values(ACTOR_GUCS), [
    'app.actor_id',
    'app.actor_role',
    'app.break_glass',
  ]);
});

// Counts every connection attempt any pg.Pool makes, so "before any SQL" is measured, not inferred.
const realConnect = pg.Pool.prototype.connect;
let connects = 0;
afterEach(() => {
  pg.Pool.prototype.connect = realConnect;
});
function countConnects(): void {
  connects = 0;
  pg.Pool.prototype.connect = function (this: Pool, ...args: never[]) {
    connects += 1;
    return (realConnect as (...a: never[]) => unknown).apply(this, args);
  } as typeof realConnect;
}

test('withActor refuses a forged actor BEFORE any SQL: no pool connection is attempted, and the refusal comes before the URL and shut-down checks', async () => {
  countConnects();
  const forged = [
    { kind: 'person', accountId: '', role: 'sitter' },
    { kind: 'person', accountId: ID, role: 'system' },
    { kind: 'system', job: '' },
    undefined,
  ] as unknown as Actor[];
  const reasons: ActorRefusal[] = ['account_id', 'role', 'job_identity', 'actor_missing'];
  const db = new Database({ connectionString: SENTINEL, application_name: 'kinvara-test' }, () => {
    throw new Error('nothing may be logged');
  });
  for (const [i, actor] of forged.entries()) {
    await assert.rejects(
      db.withActor(actor, async () => 'unreached'),
      refused(reasons[i] ?? 'actor_missing'),
    );
  }
  await assert.rejects(
    db.withActor(personActor(ID, 'sitter'), async () => 'unreached', {
      breakGlass: false,
    } as never),
    refused('break_glass_option'),
  );
  const noUrl = new Database(
    { connectionString: undefined, application_name: 'kinvara-test' },
    () => undefined,
  );
  await assert.rejects(
    noUrl.withActor(forged[0] as Actor, async () => 'unreached'),
    refused('account_id'),
  );
  await db.onApplicationShutdown();
  await assert.rejects(
    db.withActor(forged[0] as Actor, async () => 'unreached'),
    refused('account_id'),
  );
  assert.equal(connects, 0);
});

test('CONTROL for the case above: a valid actor on the same unreachable source DOES attempt a connection (so the counter can see one)', async () => {
  countConnects();
  const db = new Database(
    { connectionString: SENTINEL, application_name: 'kinvara-test' },
    () => undefined,
  );
  await assert.rejects(
    db.withActor(personActor(ID, 'sitter'), async () => 'unreached'),
    (e: unknown) => !(e instanceof ActorRefusedError),
  );
  assert.equal(connects, 1);
  await db.onApplicationShutdown();
});

test("bindSystemActor: the worker's binding refuses a bad job name at bind time, synchronously, and binds the system actor otherwise", () => {
  const db = new Database(
    { connectionString: undefined, application_name: 'kinvara-worker' },
    () => undefined,
  );
  for (const bad of ['', 'Upper', ID]) {
    assert.throws(() => bindSystemActor(db, bad), refused('job_identity'));
  }
  const bound = bindSystemActor(db, 'credential.sweep');
  assert.equal(bound.actor.kind, 'system');
  assert.equal(bound.actor.job, 'credential.sweep');
  assert.ok(Object.isFrozen(bound));
});
