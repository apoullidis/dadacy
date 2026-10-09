/**
 * T-149 — THE TRANSACTIONAL ENQUEUE, against the real Postgres of the ticket's project and the real
 * pg-boss 12.26.4 (SD §QD Jobs row, line 4125). Run under
 * `scripts/svc run <t> -- pnpm --filter @kinvara/core test:integration`, which injects
 * `DATABASE_URL` (the bootstrap superuser). Without it every test FAILS; none skips.
 *
 * THE PRINCIPAL IS AN `app_rw`-ONLY LOGIN, not the superuser. `beforeAll` creates a throwaway login
 * whose only membership is `app_rw` (asserted, not assumed: case *(login) …*), and both the
 * package's `Database` and the pg-boss sender connect as it. The superuser pool is used only to
 * create and drop that login and to OBSERVE rows from outside the transaction under test.
 *
 * The code under test is `@kinvara/core-modules/jobs` (`JobEnqueuer`, EV-30) and
 * `@kinvara/core-modules/runtime` (`Database`, the branded `Tx`). The state row is an `account`
 * written by `src/identity/account.repository.ts` (core's own), the job a `NotifyJobBase` payload
 * (`@kinvara/contracts`, T-147) addressed to that account.
 *
 * Expectations are anchored outside the code under test (PROTOCOL §5.1): a row's presence is read
 * by a SEPARATE superuser session, never through the transaction that wrote it; the stored payload
 * is compared with the input built here; the five function names are T-146 § contract §1's.
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { LocaleSchema, NotifyJobBase } from '@kinvara/contracts';
import { ulid, type AccountId } from '@kinvara/domain-types';
import { defineJob, JobEnqueuer, JobPayloadRefusedError } from '@kinvara/core-modules/jobs';
import { Database, TransactionClosedError, type Tx } from '@kinvara/core-modules/runtime';
import { insertAccount } from '../src/identity/account.repository.ts';
import { newAccountId, newPseudonym } from '../src/identity/ids.ts';

const QUEUE = 't149.enqueue';
const NOTIFY = defineJob(QUEUE, NotifyJobBase);
/** T-146 § contract §1: the five functions `0006` creates in schema `pgboss`. */
const PGBOSS_FUNCTIONS = [
  'create_queue',
  'delete_queue',
  'job_table_format',
  'job_table_run',
  'job_table_run_async',
];

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TypeError(`${name} is not set: run under \`scripts/svc run <ticket> --\``);
  }
  return value;
}

const LOGIN = `t149_rw_${randomBytes(4).toString('hex')}`;
const PASSWORD = randomBytes(16).toString('hex');

let superuserPool: InstanceType<typeof pg.Pool> | undefined;
function superuser(): InstanceType<typeof pg.Pool> {
  superuserPool ??= new pg.Pool({ connectionString: env('DATABASE_URL'), max: 2 });
  return superuserPool;
}
let rwUrl = '';
let db: Database | undefined;
let boss: PgBoss | undefined;
let enqueuer: JobEnqueuer | undefined;
const accounts: AccountId[] = [];

function database(): Database {
  assert.ok(db !== undefined, 'beforeAll built the Database');
  return db;
}
function jobs(): JobEnqueuer {
  assert.ok(enqueuer !== undefined, 'beforeAll built the enqueuer');
  return enqueuer;
}

beforeAll(async () => {
  // Fixed, generated identifiers only: DDL takes no parameters.
  await superuser().query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${PASSWORD}' IN ROLE app_rw`);
  const url = new URL(env('DATABASE_URL'));
  url.username = LOGIN;
  url.password = PASSWORD;
  rwUrl = url.toString();
  db = new Database({ connectionString: rwUrl, application_name: 'kinvara-core' }, (line) =>
    process.stderr.write(`[core] ${line}\n`),
  );
  boss = new PgBoss({
    connectionString: rwUrl,
    application_name: 't149-sender',
    max: 2,
    migrate: false,
    supervise: false,
    schedule: false,
    persistQueueStats: false,
    useListenNotify: false,
  });
  boss.on('error', (e: unknown) => process.stderr.write(`[t149 boss] ${String(e)}\n`));
  await boss.start();
  await boss.createQueue(QUEUE);
  enqueuer = new JobEnqueuer(boss);
});

afterAll(async () => {
  await boss?.deleteQueue(QUEUE);
  await boss?.stop({ graceful: false });
  await db?.onApplicationShutdown();
  if (accounts.length > 0) {
    await superuser().query('DELETE FROM account WHERE id = ANY($1::text[])', [accounts]);
  }
  await superuser().query(`DROP ROLE IF EXISTS ${LOGIN}`);
  await superuserPool?.end();
});

/** A payload for `account`, built here: the expectation the stored row is compared with. */
function payloadFor(owner: AccountId) {
  return {
    recipientAccountId: ulid(owner, 'recipientAccountId'),
    recipientLocale: LocaleSchema.parse('el'),
    enqueuedAt: new Date().toISOString(),
  };
}

async function newAccount(tx: Tx): Promise<AccountId> {
  const id = newAccountId();
  accounts.push(id);
  await insertAccount(tx, {
    id,
    pseudonym: newPseudonym(),
    email: `t149-${randomBytes(6).toString('hex')}@example.cy`,
    passwordHash: null,
    tosVersion: 't149',
  });
  return id;
}

/** Read from OUTSIDE the transaction under test. */
async function accountExists(id: AccountId): Promise<boolean> {
  const { rows } = await superuser().query('SELECT 1 FROM account WHERE id = $1', [id]);
  return rows.length === 1;
}
async function jobRow(id: string): Promise<{ name: string; data: unknown } | undefined> {
  const { rows } = await superuser().query<{ name: string; data: unknown }>(
    'SELECT name, data FROM pgboss.job WHERE id = $1',
    [id],
  );
  return rows[0];
}
/** The transaction id that wrote a row (`xmin`), read from OUTSIDE: one transaction, one value. */
async function accountXmin(id: AccountId): Promise<string | undefined> {
  const { rows } = await superuser().query<{ x: string }>(
    'SELECT xmin::text AS x FROM account WHERE id = $1',
    [id],
  );
  return rows[0]?.x;
}
async function jobXmins(owner: AccountId): Promise<string[]> {
  const { rows } = await superuser().query<{ x: string }>(
    "SELECT xmin::text AS x FROM pgboss.job WHERE name = $1 AND data->>'recipientAccountId' = $2",
    [QUEUE, owner],
  );
  return rows.map((r) => r.x);
}
async function jobsFor(owner: AccountId): Promise<number> {
  const { rows } = await superuser().query<{ n: string }>(
    "SELECT count(*) AS n FROM pgboss.job WHERE name = $1 AND data->>'recipientAccountId' = $2",
    [QUEUE, owner],
  );
  return Number(rows[0]?.n);
}

test('(login) the test connects as a login whose only membership is app_rw, not a superuser; withAppRw runs as app_rw', async () => {
  const { rows } = await superuser().query<{ super: boolean; member_of: string[] }>(
    `SELECT u.rolsuper AS super,
            ARRAY(SELECT r.rolname::text FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
                   WHERE m.member = u.oid ORDER BY 1) AS member_of
       FROM pg_roles u WHERE u.rolname = $1`,
    [LOGIN],
  );
  assert.deepEqual(rows, [{ super: false, member_of: ['app_rw'] }]);
  const who = await database().withAppRw(async (tx) => {
    const r = await tx.execute<{ s: string; c: string }>(
      sql`SELECT session_user::text AS s, current_user::text AS c`,
    );
    return r.rows[0];
  });
  assert.deepEqual(who, { s: LOGIN, c: 'app_rw' });
  const sender = await superuser().query<{ usename: string }>(
    "SELECT DISTINCT usename::text FROM pg_stat_activity WHERE application_name = 't149-sender'",
  );
  assert.deepEqual(sender.rows, [{ usename: LOGIN }], "the sender's own pool is the same login");
});

test('(a) control: a state row and a job written in one transaction both exist after commit, the job invisible to another session until then, its stored payload equal to the validated input', async () => {
  let owner: AccountId | undefined;
  let input: ReturnType<typeof payloadFor> | undefined;
  let seenBeforeCommit: unknown = 'not read';
  const id = await database().withAppRw(async (tx) => {
    owner = await newAccount(tx);
    input = payloadFor(owner);
    const jobId = await jobs().enqueue(tx, NOTIFY, input);
    assert.ok(typeof jobId === 'string');
    seenBeforeCommit = await jobRow(jobId);
    return jobId;
  });
  assert.ok(owner !== undefined && input !== undefined && id !== null);
  assert.equal(seenBeforeCommit, undefined, 'the job was not visible outside the transaction');
  assert.equal(await accountExists(owner), true, 'the state row committed');
  const row = await jobRow(id);
  assert.equal(row?.name, QUEUE, 'the job committed');
  assert.deepEqual(row.data, { ...input });
});

test('(b) rolled back after enqueue: neither the state row nor the job exists', async () => {
  let owner: AccountId | undefined;
  let jobId: string | null | undefined;
  const ROLLBACK = new Error('T-149 (b): the caller rolls back after the enqueue');
  await assert.rejects(
    database().withAppRw(async (tx) => {
      owner = await newAccount(tx);
      jobId = await jobs().enqueue(tx, NOTIFY, payloadFor(owner));
      throw ROLLBACK;
    }),
    (e: unknown) => e === ROLLBACK,
  );
  assert.ok(owner !== undefined && typeof jobId === 'string', 'the enqueue had returned an id');
  assert.equal(await accountExists(owner), false, 'the state row is absent');
  assert.equal(await jobRow(jobId), undefined, 'the job is absent');
  assert.equal(await jobsFor(owner), 0);
});

test('(c) a payload with no recipientLocale throws inside the transaction, and the state row written earlier in it is absent afterwards', async () => {
  let owner: AccountId | undefined;
  await assert.rejects(
    database().withAppRw(async (tx) => {
      owner = await newAccount(tx);
      const withoutLocale: Record<string, unknown> = { ...payloadFor(owner) };
      delete withoutLocale['recipientLocale'];
      const missing: unknown = withoutLocale;
      return await jobs().enqueue(tx, NOTIFY, missing as ReturnType<typeof payloadFor>);
    }),
    (e: unknown) => {
      assert.ok(e instanceof JobPayloadRefusedError);
      assert.deepEqual(e.issues, [{ path: 'recipientLocale', code: 'custom' }]);
      assert.ok(owner !== undefined && !e.message.includes(owner), 'the id is not echoed');
      return true;
    },
  );
  assert.ok(owner !== undefined);
  assert.equal(await accountExists(owner), false, 'the state row rolled back with the refusal');
  assert.equal(await jobsFor(owner), 0, 'no job was written');
});

test('(d) at run time: a Tx kept past its committed transaction is refused TransactionClosedError, and no job is written', async () => {
  let kept: Tx | undefined;
  let owner: AccountId | undefined;
  await database().withAppRw(async (tx) => {
    kept = tx;
    owner = await newAccount(tx);
  });
  assert.ok(kept !== undefined && owner !== undefined);
  assert.equal(await accountExists(owner), true);
  await assert.rejects(
    jobs().enqueue(kept, NOTIFY, payloadFor(owner)),
    (e: unknown) => e instanceof TransactionClosedError,
  );
  assert.equal(await jobsFor(owner), 0, 'nothing was enqueued after commit');
});

test('(e) MEASURED, NOT REFUSED: an app_rw session writes a pgboss.job row whose payload lacks recipientLocale, and the database accepts it (G5)', async () => {
  const owner = newAccountId();
  const rwPool = new pg.Pool({ connectionString: rwUrl, max: 1 });
  const rw = await rwPool.connect();
  try {
    const who = await rw.query<{ c: string }>('SELECT current_user::text AS c');
    assert.equal(who.rows[0]?.c, LOGIN);
    const inserted = await rw.query<{ id: string }>(
      'INSERT INTO pgboss.job (name, data) VALUES ($1, $2::jsonb) RETURNING id::text',
      [QUEUE, JSON.stringify({ recipientAccountId: owner, enqueuedAt: new Date().toISOString() })],
    );
    const id = inserted.rows[0]?.id;
    assert.ok(typeof id === 'string', 'the database accepted the row');
    const row = await jobRow(id);
    assert.equal(row?.name, QUEUE);
    assert.equal(
      Object.hasOwn(row.data as object, 'recipientLocale'),
      false,
      'stored with no locale',
    );
    await rw.query('DELETE FROM pgboss.job WHERE id = $1', [id]);
  } finally {
    rw.release();
    await rwPool.end();
  }
});

test('(G11) pg-boss 12.26.4 installs no SQL-callable send: pgboss.send(...) is 42883 for app_rw, and schema pgboss has exactly the five functions 0006 creates', async () => {
  const { rows } = await superuser().query<{ f: string }>(
    "SELECT p.proname::text AS f FROM pg_proc p WHERE p.pronamespace = 'pgboss'::regnamespace ORDER BY 1",
  );
  assert.deepEqual(
    rows.map((r) => r.f),
    PGBOSS_FUNCTIONS,
  );
  const rwPool = new pg.Pool({ connectionString: rwUrl, max: 1 });
  const rw = await rwPool.connect();
  try {
    await assert.rejects(
      rw.query("SELECT pgboss.send($1, '{}'::jsonb)", [QUEUE]),
      (e: unknown) => e instanceof Error && (e as Error & { code?: string }).code === '42883',
    );
  } finally {
    rw.release();
    await rwPool.end();
  }
});

test('(f) OD-303: an UN-AWAITED enqueue, then the caller rolls back: neither the state row nor the job exists', async () => {
  let owner: AccountId | undefined;
  let floating: Promise<string | null> | undefined;
  const ROLLBACK = new Error('T-149 (f): the state change fails after the enqueue was started');
  await assert.rejects(
    database().withAppRw(async (tx) => {
      owner = await newAccount(tx);
      floating = jobs().enqueue(tx, NOTIFY, payloadFor(owner)); // NOT awaited
      throw ROLLBACK;
    }),
    (e: unknown) => e === ROLLBACK,
  );
  assert.ok(owner !== undefined && floating !== undefined);
  // Whatever the floating promise did, it has settled; then look from outside.
  await floating.then(
    () => undefined,
    () => undefined,
  );
  assert.equal(await accountExists(owner), false, 'the state row is absent');
  assert.equal(
    await jobsFor(owner),
    0,
    'no job exists: the late INSERT did not escape the ROLLBACK',
  );
});

test("(g) OD-303: an UN-AWAITED enqueue, then the caller commits: the job commits IN the caller's transaction (the state row's xmin), not after it", async () => {
  let owner: AccountId | undefined;
  let floating: Promise<string | null> | undefined;
  await database().withAppRw(async (tx) => {
    owner = await newAccount(tx);
    floating = jobs().enqueue(tx, NOTIFY, payloadFor(owner)); // NOT awaited
  });
  assert.ok(owner !== undefined && floating !== undefined);
  const id = await floating;
  assert.ok(typeof id === 'string', 'the floating enqueue resolved an id');
  const stateXmin = await accountXmin(owner);
  assert.ok(stateXmin !== undefined, 'the state row committed');
  assert.deepEqual(await jobXmins(owner), [stateXmin], 'one job, written by the same transaction');
});

test("(h) OD-303: an UN-AWAITED enqueue whose payload is refused rolls the caller's transaction back: withAppRw rejects JobPayloadRefusedError, no state row, no job", async () => {
  let owner: AccountId | undefined;
  let floating: Promise<string | null> | undefined;
  const outcome = await database()
    .withAppRw(async (tx) => {
      owner = await newAccount(tx);
      const withoutLocale: Record<string, unknown> = { ...payloadFor(owner) };
      delete withoutLocale['recipientLocale'];
      const missing: unknown = withoutLocale;
      floating = jobs().enqueue(tx, NOTIFY, missing as ReturnType<typeof payloadFor>); // NOT awaited
    })
    .then(
      () => 'resolved',
      (e: unknown) => e,
    );
  assert.ok(owner !== undefined && floating !== undefined);
  const settled = await floating.then(
    () => 'resolved',
    (e: unknown) => e,
  );
  assert.ok(settled instanceof JobPayloadRefusedError, 'the floating enqueue was refused');
  assert.equal(outcome, settled, 'withAppRw rejected with that refusal');
  assert.equal(await accountExists(owner), false, 'the state row rolled back with it');
  assert.equal(await jobsFor(owner), 0);
});

test('(d2) at run time: a Tx kept past its ROLLED-BACK transaction is refused TransactionClosedError, and no job is written', async () => {
  let kept: Tx | undefined;
  let owner: AccountId | undefined;
  const ROLLBACK = new Error('T-149 (d2): the caller rolls back');
  await assert.rejects(
    database().withAppRw(async (tx) => {
      kept = tx;
      owner = await newAccount(tx);
      throw ROLLBACK;
    }),
    (e: unknown) => e === ROLLBACK,
  );
  assert.ok(kept !== undefined && owner !== undefined);
  await assert.rejects(
    jobs().enqueue(kept, NOTIFY, payloadFor(owner)),
    (e: unknown) => e instanceof TransactionClosedError,
  );
  assert.equal(await accountExists(owner), false);
  assert.equal(await jobsFor(owner), 0, 'nothing was enqueued after the rollback');
});

test('(j) MEASURED, NOT REFUSED (QA-F2): the Tx of a NESTED withAppRw is accepted — its job commits with the inner transaction while the outer state change rolls back', async () => {
  let owner: AccountId | undefined;
  let jobId: string | null | undefined;
  const OUTER = new Error('T-149 (j): the outer transaction rolls back');
  await assert.rejects(
    database().withAppRw(async (outer) => {
      owner = await newAccount(outer);
      const o = owner;
      jobId = await database().withAppRw(
        async (inner) => await jobs().enqueue(inner, NOTIFY, payloadFor(o)),
      );
      throw OUTER;
    }),
    (e: unknown) => e === OUTER,
  );
  assert.ok(owner !== undefined && typeof jobId === 'string');
  assert.equal(await accountExists(owner), false, 'the outer state change rolled back');
  assert.equal((await jobRow(jobId))?.name, QUEUE, 'the job committed with the inner transaction');
  await superuser().query('DELETE FROM pgboss.job WHERE id = $1', [jobId]);
});
