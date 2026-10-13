/**
 * The `sitter_credential` repository without a database (T-255): the actor snapshot, the input
 * checks that run before any SQL, the refusal mapping, the sweep's actor read-back, and the id
 * generator. Against Postgres the same repository is `test/sitter-credential-repository.spec.ts`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { isUlid, NotFoundError, toProblem } from '@kinvara/domain-types';
import { DrizzleQueryError } from 'drizzle-orm';
import {
  ActorRefusedError,
  personActor,
  systemActor,
  type Database,
  type SystemActorDatabase,
  type Tx,
} from '../runtime/index.ts';
import {
  dueForAttestation,
  dueForExpiry,
  dueForRecertification,
  ensureOnboardingCredentials,
  listOwnCredentials,
  REFERENCE_BOUNDS_CONSTRAINT,
  ReferenceNumberOutOfBoundsError,
  SITTER_CREDENTIAL_REFUSED,
  SitterCredentialRefusedError,
  sitterActor,
  submitCertificate,
  SweepActorRefusedError,
  type SitterActor,
} from './index.ts';
import { newSitterCredentialId } from './ids.ts';
import { isIsoDate, mapRefusal } from './repository.ts';

const ID = '01J9Z8Y7X6W5V4T3S2R1Q0P9N8';
const CRED = '01J9Z8Y7X6W5V4T3S2R1Q0P9N9';
const CANARY = 'CANARY-T255-UNIT-77031';
const noLog = (): void => undefined;

/** Everything an error exposes as text: message, stack, own properties, cause, JSON, inspect, toProblem. */
function exposed(e: unknown): string {
  const parts: string[] = [String(e), inspect(e, { depth: 5 })];
  if (e instanceof Error) {
    parts.push(e.message, String(e.stack), String(e.cause));
    for (const k of Object.getOwnPropertyNames(e)) {
      parts.push(k, String((e as unknown as Record<string, unknown>)[k]));
    }
    parts.push(JSON.stringify(e), JSON.stringify(toProblem(e, 'https://errors.kinvara.test/')));
  }
  return parts.join('|');
}

/** A `Database` that counts `withActor` calls and records the actor it was given; never connects. */
function countingDb(): { db: Database; calls: { actor: unknown }[] } {
  const calls: { actor: unknown }[] = [];
  const db = {
    withActor: (actor: unknown) => {
      calls.push({ actor });
      return Promise.resolve([]);
    },
  } as unknown as Database;
  return { db, calls };
}

test('sitterActor is personActor(id, sitter): a malformed id is refused account_id', () => {
  const a = sitterActor(ID);
  assert.equal(a.kind, 'person');
  assert.equal(a.role, 'sitter');
  assert.equal(a.accountId, ID);
  for (const bad of ['', null, undefined, 0, ID.toLowerCase(), `${ID} `]) {
    assert.throws(() => sitterActor(bad), (e: unknown) => e instanceof ActorRefusedError && e.reason === 'account_id');
  }
});

test('a non-sitter, system or forged actor is refused before any transaction, by every sitter function', async () => {
  const forged: unknown[] = [
    personActor(ID, 'parent'),
    personActor(ID, 'ts_operator'),
    systemActor('credential.sweep'),
    { kind: 'person', accountId: ID, role: 'Sitter' },
    { kind: 'person', accountId: 'not-an-id', role: 'sitter' },
    null,
    undefined,
  ];
  const reasons = ['role', 'role', 'actor_kind', 'role', 'account_id', 'actor_missing', 'actor_missing'];
  for (const [i, actor] of forged.entries()) {
    const { db, calls } = countingDb();
    const as = actor as SitterActor;
    const sub = { credentialId: CRED, jurisdiction: 'CY', referenceNumber: '0', issuedOn: null };
    for (const call of [
      () => listOwnCredentials(db, as),
      () => ensureOnboardingCredentials(db, as, 'CY'),
      () => submitCertificate(db, as, sub, noLog),
    ]) {
      await assert.rejects(call(), (e: unknown) => e instanceof ActorRefusedError && e.reason === reasons[i]);
    }
    assert.equal(calls.length, 0, `actor ${String(i)} reached withActor`);
  }
});

test('the actor is read once per field and re-built: a getter cannot answer sitter to the check and bind another value', async () => {
  const reads: Record<string, number> = { kind: 0, accountId: 0, role: 0 };
  const values: Record<string, string[]> = { kind: ['person', 'system'], accountId: [ID, ID], role: ['sitter', 'parent'] };
  const actor = {};
  for (const k of Object.keys(reads)) {
    Object.defineProperty(actor, k, {
      get: () => values[k]?.[reads[k]!++] ?? 'exhausted',
      enumerable: true,
    });
  }
  const { db, calls } = countingDb();
  await listOwnCredentials(db, actor as SitterActor);
  assert.deepEqual(reads, { kind: 1, accountId: 1, role: 1 });
  assert.equal(calls.length, 1);
  const bound = calls[0]?.actor as { kind: string; role: string; accountId: string };
  assert.notEqual(bound, actor, 'the bound actor is a fresh personActor, not the caller object');
  assert.deepEqual({ kind: bound.kind, role: bound.role, accountId: bound.accountId }, { kind: 'person', role: 'sitter', accountId: ID });
});

test('submitCertificate refuses a malformed credentialId or issuedOn before any transaction, naming the field', async () => {
  const { db, calls } = countingDb();
  const base = { credentialId: CRED, jurisdiction: 'CY', referenceNumber: CANARY, issuedOn: '2026-03-04' };
  for (const [override, field] of [
    [{ credentialId: CRED.toLowerCase() }, 'credentialId'],
    [{ credentialId: '' }, 'credentialId'],
    [{ credentialId: `${CANARY}` }, 'credentialId'],
    [{ issuedOn: '2026-02-30' }, 'issuedOn'],
    [{ issuedOn: '2026-3-4' }, 'issuedOn'],
    [{ issuedOn: `${CANARY}` }, 'issuedOn'],
  ] as const) {
    await assert.rejects(
      submitCertificate(db, sitterActor(ID), { ...base, ...override }, noLog),
      (e: unknown) => {
        assert.equal((e as { field?: string }).field, field);
        assert.equal((e as { code?: string }).code, 'invalid_input');
        assert.ok(!exposed(e).includes(CANARY), 'the refused value is echoed');
        return true;
      },
    );
  }
  assert.equal(calls.length, 0);
});

test('isIsoDate accepts real calendar dates written YYYY-MM-DD only', () => {
  for (const ok of ['2026-01-01', '2024-02-29', '1999-12-31']) assert.equal(isIsoDate(ok), true, ok);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-01', '20260101', '2026-01-01T00:00Z', '', null, 20260101]) {
    assert.equal(isIsoDate(bad), false, String(bad));
  }
});

/** A pg-shaped error as drizzle wraps it: the parameters are in the message, the row in `detail`. */
function drizzleRefusal(code: string, constraint: string | undefined): DrizzleQueryError {
  const pgError = Object.assign(new Error(`violates "${constraint ?? 'policy'}"`), {
    code,
    severity: 'ERROR',
    constraint,
    detail: `Failing row contains (${CANARY}).`,
  });
  return new DrizzleQueryError('UPDATE public.sitter_credential SET reference_number = $1', [CANARY], pgError);
}

test('mapRefusal: the reference bound becomes ReferenceNumberOutOfBoundsError (400, field referenceNumber), with no cause and no parameter or detail', () => {
  assert.throws(
    () => mapRefusal(drizzleRefusal('23514', REFERENCE_BOUNDS_CONSTRAINT)),
    (e: unknown) => {
      assert.ok(e instanceof ReferenceNumberOutOfBoundsError);
      assert.equal(e.code, 'invalid_input');
      assert.equal(e.status, 400);
      assert.equal(e.field, 'referenceNumber');
      assert.equal(e.cause, undefined);
      assert.ok(!exposed(e).includes(CANARY));
      return true;
    },
  );
});

test('mapRefusal: every other database refusal becomes SitterCredentialRefusedError carrying SQLSTATE and constraint name only', () => {
  for (const [code, constraint] of [
    ['42501', undefined],
    ['23514', 'sitter_credential_status_check'],
    ['23505', 'sitter_credential_pkey'],
    ['23503', 'sitter_credential_sitter_id_fkey'],
  ] as const) {
    for (const thrown of [drizzleRefusal(code, constraint), drizzleRefusal(code, constraint).cause]) {
      assert.throws(
        () => mapRefusal(thrown),
        (e: unknown) => {
          assert.ok(e instanceof SitterCredentialRefusedError);
          assert.equal(e.message, SITTER_CREDENTIAL_REFUSED);
          assert.equal(e.sqlstate, code);
          assert.equal(e.constraint, constraint);
          assert.equal(e.cause, undefined);
          assert.ok(!exposed(e).includes(CANARY), 'a parameter or the detail reached the error');
          return true;
        },
      );
    }
  }
});

test('mapRefusal: a drizzle error without a pg cause is replaced by its cause; any other error passes through unchanged', () => {
  const cause = new Error('connect ECONNREFUSED');
  const wrapped = new DrizzleQueryError('SELECT $1', [CANARY], cause);
  assert.throws(() => mapRefusal(wrapped), (e: unknown) => e === cause);
  const mine = new NotFoundError();
  assert.throws(() => mapRefusal(mine), (e: unknown) => e === mine);
  const notPg = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
  assert.throws(() => mapRefusal(notPg), (e: unknown) => e === notPg);
});

/** A bound system runner whose transaction reports `who` as the actor; counts statements. */
function fakeSystem(who: Record<string, unknown> | undefined): { sys: SystemActorDatabase; statements: number[] } {
  const statements: number[] = [];
  const tx = {
    execute: () => {
      statements.push(1);
      return Promise.resolve({ rows: statements.length === 1 && who !== undefined ? [who] : [] });
    },
  } as unknown as Tx;
  const sys = {
    actor: systemActor('credential.sweep'),
    withActor: <T>(work: (t: Tx) => Promise<T>) => work(tx),
  } as unknown as SystemActorDatabase;
  return { sys, statements };
}

test('a sweep whose transaction does not read back a system actor is refused, and its query is never sent', async () => {
  for (const who of [
    { actor_role: null, actor_id: null },
    { actor_role: 'sitter', actor_id: ID },
    { actor_role: 'system', actor_id: null },
    undefined,
  ]) {
    for (const call of [
      (s: SystemActorDatabase) => dueForRecertification(s, '2026-01-20'),
      (s: SystemActorDatabase) => dueForAttestation(s, new Date('2026-01-20T00:00:00Z')),
      (s: SystemActorDatabase) => dueForExpiry(s, '2026-01-20'),
    ]) {
      const { sys, statements } = fakeSystem(who);
      await assert.rejects(call(sys), SweepActorRefusedError);
      assert.equal(statements.length, 1, 'only the actor read-back was sent');
    }
  }
  const { sys, statements } = fakeSystem({ actor_role: 'system', actor_id: 'credential.sweep' });
  assert.deepEqual(await dueForExpiry(sys, '2026-01-20'), []);
  assert.equal(statements.length, 2, 'CONTROL: a system read-back lets the sweep query run');
});

test('a sweep refuses a malformed asOf before any transaction', async () => {
  const { sys, statements } = fakeSystem({ actor_role: 'system', actor_id: 'x' });
  for (const bad of ['2026-02-30', '2026-01-20T00:00:00Z', '']) {
    await assert.rejects(dueForRecertification(sys, bad), (e: unknown) => (e as { field?: string }).field === 'asOf');
    await assert.rejects(dueForExpiry(sys, bad), (e: unknown) => (e as { field?: string }).field === 'asOf');
  }
  for (const bad of [new Date('nope'), '2026-01-20' as unknown as Date]) {
    await assert.rejects(dueForAttestation(sys, bad), (e: unknown) => (e as { field?: string }).field === 'asOf');
  }
  assert.equal(statements.length, 0);
});

test('newSitterCredentialId is a canonical ULID carrying the clock in its first ten characters, and differs per call', () => {
  const t = Date.UTC(2026, 9, 13, 21, 0, 0);
  const a = newSitterCredentialId(() => t);
  const b = newSitterCredentialId(() => t);
  assert.ok(isUlid(a) && isUlid(b));
  assert.equal(a.slice(0, 10), b.slice(0, 10));
  assert.notEqual(a, b);
  assert.ok(newSitterCredentialId(() => t + 1).slice(0, 10) > a.slice(0, 10));
});
