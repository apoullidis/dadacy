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
import { inspect } from 'node:util';
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

/**
 * Q-1 (rework 1). Every surface a refusal can be read through, as text: message, stack, `cause`
 * (inspected), every own property (inspected), JSON, and `util.inspect` with hidden fields. The
 * names of the surfaces that contain `canary` are returned; [] means the refused value is absent.
 */
function canarySurfaces(e: unknown, canary: string): string[] {
  const err = e as { message?: unknown; stack?: unknown; cause?: unknown };
  const surfaces: Record<string, string> = {
    message: String(err.message),
    stack: String(err.stack),
    cause: inspect(err.cause, { depth: null, showHidden: true }),
    ownProperties: inspect(
      Object.fromEntries(
        Reflect.ownKeys(e as object).map((k) => [
          String(k),
          (e as Record<PropertyKey, unknown>)[k],
        ]),
      ),
      { depth: null, showHidden: true },
    ),
    json: JSON.stringify(e) ?? '',
    inspect: inspect(e, { depth: null, showHidden: true }),
  };
  return Object.entries(surfaces)
    .filter(([, text]) => text.includes(canary))
    .map(([name]) => name);
}

/** A refused value that carries a canary, per refusal site (each one IS refused, asserted). */
const CANARY = 'CANARYT254';
const CANARY_ID = `${CANARY}0000000000000000`; // 26 characters; first character C (> 7), so not a ULID
const CANARY_ROLE = `${CANARY.toLowerCase()}_role`;
const CANARY_JOB = `${CANARY}.job`; // upper case: refused by the job shape

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

test('Q-1 CANARY: no refusal carries its refused value: a canary in each refused id, role, job, kind, actor and break-glass value is absent from message, stack, cause, own properties, JSON and util.inspect', () => {
  const sites: readonly [string, ActorRefusal, () => unknown][] = [
    ['personActor id', 'account_id', () => personActor(CANARY_ID, 'sitter')],
    ['personActor role', 'role', () => personActor(ID, CANARY_ROLE)],
    ['systemActor job', 'job_identity', () => systemActor(CANARY_JOB)],
    [
      'bindSystemActor job',
      'job_identity',
      () =>
        bindSystemActor(
          new Database(
            { connectionString: undefined, application_name: 'kinvara-test' },
            () => undefined,
          ),
          CANARY_JOB,
        ),
    ],
    ['actorSettings actor', 'actor_missing', () => actorSettings(CANARY, undefined)],
    [
      'actorSettings kind',
      'actor_kind',
      () => actorSettings({ kind: CANARY, accountId: ID, role: 'sitter' }, undefined),
    ],
    [
      'actorSettings id',
      'account_id',
      () => actorSettings({ kind: 'person', accountId: CANARY_ID, role: 'sitter' }, undefined),
    ],
    [
      'actorSettings role',
      'role',
      () => actorSettings({ kind: 'person', accountId: ID, role: CANARY_ROLE }, undefined),
    ],
    [
      'actorSettings job',
      'job_identity',
      () => actorSettings({ kind: 'system', job: CANARY_JOB }, undefined),
    ],
    [
      'break-glass value',
      'break_glass_option',
      () => actorSettings(personActor(ID, 'sitter'), { breakGlass: CANARY }),
    ],
    [
      'break-glass key',
      'break_glass_option',
      () => actorSettings(personActor(ID, 'sitter'), { [CANARY]: true }),
    ],
    [
      'break-glass options',
      'break_glass_option',
      () => actorSettings(personActor(ID, 'sitter'), CANARY),
    ],
  ];
  const leaks: string[] = [];
  for (const [site, reason, run] of sites) {
    let caught: unknown = undefined;
    try {
      run();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ActorRefusedError, `${site}: refused`);
    assert.equal(caught.reason, reason, `${site}: reason`);
    for (const surface of canarySurfaces(caught, CANARY)) leaks.push(`${site} -> ${surface}`);
  }
  assert.deepEqual(leaks, [], 'no refusal surface carries the refused value');
});

test('Q-1 CONTROL: canarySurfaces does see a canary on each surface it reads (so the case above can fail)', () => {
  const inMessage = new Error(`x ${CANARY}`);
  assert.deepEqual(
    canarySurfaces(inMessage, CANARY).sort(),
    ['inspect', 'message', 'ownProperties', 'stack'].sort(),
  );
  const inCause = new Error('x', { cause: CANARY });
  assert.deepEqual(
    canarySurfaces(inCause, CANARY).sort(),
    ['cause', 'inspect', 'ownProperties'].sort(),
  );
  const inProp = Object.assign(new Error('x'), { input: CANARY });
  assert.deepEqual(
    canarySurfaces(inProp, CANARY).sort(),
    ['inspect', 'json', 'ownProperties'].sort(),
  );
});

test('A7 (rework 1): actorSettings reads each actor field EXACTLY ONCE, so a getter cannot pass validation with one value and bind another', () => {
  const reads: Record<string, number> = {};
  const counted =
    <T>(name: string, values: readonly T[]) =>
    () => {
      const n = reads[name] ?? 0;
      reads[name] = n + 1;
      return values[Math.min(n, values.length - 1)];
    };
  const roleFlip = Object.defineProperties(
    { accountId: ID },
    {
      kind: { get: counted('kind', ['person', 'system']), enumerable: true },
      role: { get: counted('role', ['sitter', 'system']), enumerable: true },
    },
  );
  assert.deepEqual(actorSettings(roleFlip, undefined), {
    actorId: ID,
    actorRole: 'sitter',
    breakGlass: 'off',
  });
  const idFlip = Object.defineProperties(
    { kind: 'person', role: 'sitter' },
    {
      accountId: { get: counted('accountId', [ID, "x'); DROP TABLE t; --"]), enumerable: true },
    },
  );
  assert.deepEqual(actorSettings(idFlip, undefined), {
    actorId: ID,
    actorRole: 'sitter',
    breakGlass: 'off',
  });
  const jobFlip = Object.defineProperties(
    { kind: 'system' },
    {
      job: { get: counted('job', ['credential.sweep', ID]), enumerable: true },
    },
  );
  assert.deepEqual(actorSettings(jobFlip, undefined), {
    actorId: 'credential.sweep',
    actorRole: 'system',
    breakGlass: 'off',
  });
  assert.deepEqual(reads, { kind: 1, role: 1, accountId: 1, job: 1 });
  // The other direction: a getter that is refused on its one read stays refused.
  const badFirst = Object.defineProperties(
    { kind: 'person', accountId: ID },
    {
      role: { get: counted('roleBad', ['system', 'sitter']), enumerable: true },
    },
  );
  assert.throws(() => actorSettings(badFirst, undefined), refused('role'));
  // A Proxy over a valid actor: every key is read at most once.
  const gets: Record<string, number> = {};
  const proxied = new Proxy(personActor(ID, 'sitter'), {
    get(target, key, receiver) {
      gets[String(key)] = (gets[String(key)] ?? 0) + 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  assert.deepEqual(actorSettings(proxied, undefined), {
    actorId: ID,
    actorRole: 'sitter',
    breakGlass: 'off',
  });
  assert.deepEqual(gets, { kind: 1, accountId: 1, role: 1 });
});

test('A8 (rework 1): break-glass needs breakGlass as the ONE OWN key; an inherited breakGlass: true, an extra symbol or non-enumerable key, are refused', () => {
  const inherited = Object.assign(Object.create({ breakGlass: true }) as object, { purpose: 'x' });
  assert.throws(
    () => actorSettings(personActor(ID, 'parent'), inherited),
    refused('break_glass_option'),
  );
  assert.throws(
    () => actorSettings(personActor(ID, 'parent'), Object.create({ breakGlass: true })),
    refused('break_glass_option'),
  );
  const symbolExtra = { breakGlass: true, [Symbol('purpose')]: 'x' };
  assert.throws(
    () => actorSettings(personActor(ID, 'parent'), symbolExtra),
    refused('break_glass_option'),
  );
  const hiddenExtra = Object.defineProperty({ breakGlass: true }, 'purpose', {
    value: 'x',
    enumerable: false,
  });
  assert.throws(
    () => actorSettings(personActor(ID, 'parent'), hiddenExtra),
    refused('break_glass_option'),
  );
  // CONTROLS: an own breakGlass: true is 'on', also on an object whose prototype has other keys.
  assert.equal(actorSettings(personActor(ID, 'parent'), { breakGlass: true }).breakGlass, 'on');
  const ownOnTop = Object.assign(Object.create({ purpose: 'x' }) as object, { breakGlass: true });
  assert.equal(actorSettings(personActor(ID, 'parent'), ownOnTop).breakGlass, 'on');
  // An own getter is read once: it cannot pass the check and then answer differently.
  let n = 0;
  const flip = Object.defineProperty({}, 'breakGlass', {
    get: () => (n += 1) === 1,
    enumerable: true,
  });
  assert.equal(actorSettings(personActor(ID, 'parent'), flip).breakGlass, 'on');
  assert.equal(n, 1);
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
