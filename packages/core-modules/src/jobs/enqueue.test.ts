/**
 * The transactional enqueue with NO database (T-149). `pg` is replaced by a recording fake, so the
 * real `Database.withAppRw` mints a real `Tx` over a fake connection, and every statement — the
 * transaction's own and those the sender runs through `fromDrizzle(tx, sql)` — is recorded in the
 * order the connection received it. The sender is a stand-in for a started `PgBoss`: it runs one
 * statement on the `db` it is handed, as pg-boss's `createJob` does (`manager.js` 771–781).
 *
 * What this cannot show, and `apps/core/test/enqueue.inprocess.test.ts` does against a real
 * Postgres and real pg-boss: that the job row commits and rolls back with the transaction.
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { SendOptions } from 'pg-boss';
import { z } from 'zod';
import type { Tx } from '../runtime/index.ts';

interface Recorded {
  readonly client: number;
  readonly text: string;
  readonly values: readonly unknown[];
}
const recorded: Recorded[] = [];
let clients = 0;

vi.mock('pg', () => {
  class FakeClient {
    readonly #n: number;
    constructor(n: number) {
      this.#n = n;
    }
    query(config: unknown, values?: unknown[]) {
      const text =
        typeof config === 'string' ? config : String((config as { text?: unknown }).text ?? '');
      const vals =
        values ??
        (typeof config === 'object' && config !== null
          ? ((config as { values?: unknown[] }).values ?? [])
          : []);
      recorded.push({ client: this.#n, text, values: vals });
      const rows = text.startsWith('SEND ') ? [{ id: 'job-from-fake' }] : [];
      return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', fields: [] });
    }
    release() {}
  }
  class FakePool {
    connect() {
      clients += 1;
      return Promise.resolve(new FakeClient(clients));
    }
    on() {}
    end() {
      return Promise.resolve();
    }
  }
  return { default: { Pool: FakePool } };
});

const { Database, TRANSACTION_CLOSED, TransactionClosedError } =
  await import('../runtime/index.ts');
const { defineJob, JOB_QUEUE_REFUSED, JobEnqueuer, JobPayloadRefusedError } =
  await import('./index.ts');

const SENTINEL = 'SENTINEL-T149-value-never-echoed';

interface SendCall {
  readonly name: string;
  readonly data: unknown;
  readonly options: SendOptions | undefined;
}

/** A started-PgBoss stand-in: one statement on the `db` it is given, then the id it read. */
function fakeSender(result: 'id' | 'null' = 'id') {
  const calls: SendCall[] = [];
  return {
    calls,
    sender: {
      async send(name: string, data?: object | null, options?: SendOptions) {
        calls.push({ name, data, options });
        assert.ok(options?.db !== undefined, 'the enqueue always hands the sender a db');
        const { rows } = await options.db.executeSql('SEND $1 $2', [name, JSON.stringify(data)]);
        return result === 'null' ? null : String((rows[0] as { id: string }).id);
      },
    },
  };
}

function database() {
  return new Database(
    { connectionString: 'postgres://fake/fake', application_name: 'kinvara-test' },
    () => {},
  );
}

const Notify = defineJob(
  't149.unit',
  z.strictObject({
    recipientAccountId: z.string().length(26),
    recipientLocale: z.enum(['en', 'el', 'ru']),
    enqueuedAt: z.string().datetime(),
  }),
);
const GOOD = {
  recipientAccountId: '01J9ZC8QW1K2Y3M4N5P6R7S8T9',
  recipientLocale: 'el',
  enqueuedAt: '2026-10-09T17:00:00Z',
} as const;

test('the send runs on the caller transaction: on the Tx connection, after SET LOCAL ROLE and before COMMIT', async () => {
  recorded.length = 0;
  const { calls, sender } = fakeSender();
  const db = database();
  const id = await db.withAppRw(async (tx) => {
    await tx.execute('STATE WRITE');
    return await new JobEnqueuer(sender).enqueue(tx, Notify, GOOD);
  });
  assert.equal(id, 'job-from-fake');
  assert.equal(calls.length, 1);
  assert.deepEqual(
    recorded.map((r) => r.text),
    ['BEGIN', 'SET LOCAL ROLE app_rw', 'STATE WRITE', 'SEND $1 $2', 'COMMIT'],
  );
  assert.equal(new Set(recorded.map((r) => r.client)).size, 1, 'one connection throughout');
  assert.deepEqual(recorded[3]?.values, ['t149.unit', JSON.stringify(GOOD)]);
  await db.onApplicationShutdown();
});

test('the parsed OUTPUT is sent, not the input', async () => {
  const job = defineJob('t149.unit', z.strictObject({ a: z.string(), b: z.number().default(7) }));
  const { calls, sender } = fakeSender();
  const db = database();
  await db.withAppRw(async (tx) => await new JobEnqueuer(sender).enqueue(tx, job, { a: 'x' }));
  assert.deepEqual(calls[0]?.data, { a: 'x', b: 7 });
  await db.onApplicationShutdown();
});

test('a payload with no recipientLocale is refused JobPayloadRefusedError before anything is sent, and the transaction rolls back', async () => {
  recorded.length = 0;
  const { calls, sender } = fakeSender();
  const db = database();
  const bad: unknown = { recipientAccountId: GOOD.recipientAccountId, enqueuedAt: SENTINEL };
  await assert.rejects(
    db.withAppRw(async (tx) => {
      await tx.execute('STATE WRITE');
      return await new JobEnqueuer(sender).enqueue(
        tx,
        Notify,
        bad as z.input<typeof Notify.payload>,
      );
    }),
    (e: unknown) => {
      assert.ok(e instanceof JobPayloadRefusedError);
      assert.equal(e.name, 'JobPayloadRefusedError');
      assert.equal(e.queue, 't149.unit');
      assert.deepEqual(
        e.issues.map((i) => i.path),
        ['recipientLocale', 'enqueuedAt'],
      );
      assert.ok(!e.message.includes(SENTINEL), 'the refusal never echoes a value');
      assert.ok(!JSON.stringify(e).includes(SENTINEL));
      assert.ok(!e.message.includes(GOOD.recipientAccountId));
      return true;
    },
  );
  assert.equal(calls.length, 0, 'nothing was sent');
  assert.deepEqual(
    recorded.map((r) => r.text),
    ['BEGIN', 'SET LOCAL ROLE app_rw', 'STATE WRITE', 'ROLLBACK'],
  );
  await db.onApplicationShutdown();
});

test('an unknown key is refused by the strict schema, and its name is not echoed', async () => {
  const { calls, sender } = fakeSender();
  const db = database();
  const bad: unknown = { ...GOOD, [SENTINEL]: 1 };
  await assert.rejects(
    db.withAppRw(async (tx) =>
      new JobEnqueuer(sender).enqueue(tx, Notify, bad as z.input<typeof Notify.payload>),
    ),
    (e: unknown) =>
      e instanceof JobPayloadRefusedError &&
      e.issues.length === 1 &&
      e.issues[0]?.code === 'unrecognized_keys' &&
      !e.message.includes(SENTINEL),
  );
  assert.equal(calls.length, 0);
  await db.onApplicationShutdown();
});

test('a Tx that withAppRw did not mint is refused TransactionClosedError, and nothing is sent', async () => {
  const { calls, sender } = fakeSender();
  const forged = {} as unknown as Tx;
  await assert.rejects(
    new JobEnqueuer(sender).enqueue(forged, Notify, GOOD),
    (e: unknown) =>
      e instanceof TransactionClosedError &&
      e.name === 'TransactionClosedError' &&
      e.message === TRANSACTION_CLOSED,
  );
  assert.equal(calls.length, 0);
});

test('a Tx kept past its transaction (committed, or rolled back) is refused TransactionClosedError, and nothing is sent', async () => {
  const { calls, sender } = fakeSender();
  const db = database();
  let committed: Tx | undefined;
  await db.withAppRw(async (tx) => {
    committed = tx;
  });
  let rolledBack: Tx | undefined;
  await assert.rejects(
    db.withAppRw(async (tx) => {
      rolledBack = tx;
      throw new Error('rollback');
    }),
  );
  recorded.length = 0;
  for (const kept of [committed, rolledBack]) {
    assert.ok(kept !== undefined);
    await assert.rejects(
      new JobEnqueuer(sender).enqueue(kept, Notify, GOOD),
      (e: unknown) => e instanceof TransactionClosedError,
    );
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(recorded, [], 'no statement reached the released connection');
  await db.onApplicationShutdown();
});

test('caller options reach pg-boss, and a db smuggled into them is replaced by the caller Tx', async () => {
  recorded.length = 0;
  const { calls, sender } = fakeSender();
  const db = database();
  const foreign = {
    executeSql: () => {
      throw new Error('the foreign db must not be used');
    },
  };
  const smuggled = { startAfter: 45, singletonKey: 'k', db: foreign } as unknown as Parameters<
    InstanceType<typeof JobEnqueuer>['enqueue']
  >[3];
  await db.withAppRw(
    async (tx) => await new JobEnqueuer(sender).enqueue(tx, Notify, GOOD, smuggled),
  );
  assert.equal(calls[0]?.options?.startAfter, 45);
  assert.equal(calls[0]?.options?.singletonKey, 'k');
  assert.notEqual(calls[0]?.options?.db, foreign);
  assert.ok(recorded.some((r) => r.text === 'SEND $1 $2'));
  await db.onApplicationShutdown();
});

test('a job pg-boss suppresses resolves null', async () => {
  const { sender } = fakeSender('null');
  const db = database();
  const id = await db.withAppRw(
    async (tx) => await new JobEnqueuer(sender).enqueue(tx, Notify, GOOD),
  );
  assert.equal(id, null);
  await db.onApplicationShutdown();
});

test('defineJob refuses an empty queue name and freezes the definition', () => {
  assert.throws(
    () => defineJob('', z.strictObject({})),
    (e: unknown) => e instanceof TypeError && e.message === JOB_QUEUE_REFUSED,
  );
  assert.ok(Object.isFrozen(Notify));
});
