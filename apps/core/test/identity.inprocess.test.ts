/**
 * T-141 IN-PROCESS, against the real Postgres and the real `hibp-fake` of the ticket's project.
 * Run under `scripts/svc run T-141 -- pnpm --filter @kinvara/core test:integration`, which
 * injects `DATABASE_URL` and `HIBP_API_BASE`. Without them every test FAILS; none skips.
 *
 * The service, checker, repository and database classes are `src/`'s own. The only things
 * injected are the HIBP transport, caller or breaker. That is how these tests produce the failures
 * `hibp-fake` cannot: it has no fault mode (T-139 § contract §5). The containerised route is
 * `test/register.container.test.ts`.
 *
 * The expectations are anchored outside `src/` (PROTOCOL §5.1):
 *   - the kit's worst case, 18195 ms, is T-142 § contract (rework 1) §3's figure, written here;
 *   - "no password material" is checked against a sentinel password, its SHA-1 prefix and the
 *     email, all derived here;
 *   - the premise of each failure (a 400 came from hibp-fake itself, six attempts were made, no
 *     request reached the upstream) is asserted before its effect is judged.
 */
import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import {
  createCircuitBreaker,
  createUpstreamCaller,
  UpstreamCallFailedError,
  type CircuitBreaker,
} from '@kinvara/integration-kit';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { findAccountIdByEmail, insertSession } from '../src/identity/account.repository.ts';
import { Database } from '../src/identity/database.ts';
import { EmailInUseError } from '../src/identity/errors.ts';
import { HibpChecker } from '../src/identity/hibp.ts';
import { newSessionId } from '../src/identity/ids.ts';
import {
  REGISTER_LOG,
  RegisterService,
  type Registered,
} from '../src/identity/register.service.ts';
import { DIGEST_REFUSED, assertSessionDigest } from '../src/identity/session-token.ts';

/** T-142 § contract (rework 1) §3: 6 × 2000 ms + 199 + 399 + 799 + 1599 + 3199 ms. */
const KIT_WORST_CASE_MS = 18195;
const SENTINEL_PASSWORD = 'KINVARA-T141-SENTINEL-inprocess-pw-7c3e';
const T139_BREACHED_01 = 'kinvara-T139-synthetic-breached-01';
const T139_CLEAN_01 = 'kinvara-T139-synthetic-clean-01';
const T139_CLEAN_SIBLING = 'kinvara-T139-synthetic-clean-sibling-66358';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TypeError(`${name} is not set: run under \`scripts/svc run <ticket> --\``);
  }
  return value;
}

const db = new Database(process.env['DATABASE_URL']);
let superuserPool: InstanceType<typeof pg.Pool> | undefined;
function superuser(): InstanceType<typeof pg.Pool> {
  superuserPool ??= new pg.Pool({ connectionString: env('DATABASE_URL'), max: 2 });
  return superuserPool;
}
afterAll(async () => {
  await db.onApplicationShutdown();
  await superuserPool?.end();
});

function sha1Upper(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').toUpperCase();
}

function uniqueEmail(tag: string): string {
  return `t141-${tag}-${randomBytes(6).toString('hex')}@example.cy`;
}

function capture(): { readonly lines: string[]; readonly log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

function input(email: string, password: string = SENTINEL_PASSWORD) {
  return { email, password, role: 'parent' as const, tosVersion: 'tos-t141' };
}

/** The production caller shape: the kit's defaults, a breaker of the test's own. */
function realChecker(breaker: CircuitBreaker = createCircuitBreaker()): HibpChecker {
  return new HibpChecker({ base: env('HIBP_API_BASE'), caller: createUpstreamCaller({ breaker }) });
}

async function accountRows(id: string): Promise<number> {
  const { rows } = await superuser().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.account WHERE id = $1',
    [id],
  );
  return rows[0]?.n ?? -1;
}

/**
 * What a fail-open registration must leave:
 *   - the account exists;
 *   - exactly one alert line carrying `reason`;
 *   - no line anywhere carrying the password, its SHA-1 prefix, or the email.
 */
async function assertFailedOpen(
  result: Registered,
  lines: readonly string[],
  reason: string,
  email: string,
): Promise<void> {
  assert.equal(result.hibp, 'unavailable');
  assert.deepEqual(
    lines.filter((line) => line.includes('alert=hibp_unavailable')),
    [`${REGISTER_LOG.hibpUnavailable} reason=${reason}`],
  );
  const prefix = sha1Upper(SENTINEL_PASSWORD).slice(0, 5);
  for (const line of lines) {
    assert.equal(line.includes(SENTINEL_PASSWORD), false, 'the password is in a log line');
    assert.equal(line.toUpperCase().includes(prefix), false, 'the SHA-1 prefix is in a log line');
    assert.equal(line.includes(email), false, 'the email is in a log line');
  }
  assert.equal(await accountRows(result.accountId), 1, 'fail open did not create the account');
}

test('a resolved 200 carries the verdict: breached-01 is breached, its same-prefix sibling is clean, clean-01 is clean', async () => {
  const checker = realChecker();
  assert.deepEqual(await checker.check(T139_BREACHED_01), { kind: 'breached' });
  assert.equal(sha1Upper(T139_CLEAN_SIBLING).slice(0, 5), sha1Upper(T139_BREACHED_01).slice(0, 5));
  assert.deepEqual(await checker.check(T139_CLEAN_SIBLING), { kind: 'clean' });
  assert.deepEqual(await checker.check(T139_CLEAN_01), { kind: 'clean' });
});

test('fail open on a resolved upstream 400 from hibp-fake itself: the account is created, the alert says status_400, and no password material is logged', async () => {
  const statuses: number[] = [];
  const checker = new HibpChecker({
    base: env('HIBP_API_BASE'),
    caller: createUpstreamCaller({ breaker: createCircuitBreaker() }),
    // T-139 § contract §4a: a full 40-character hash is answered 400. This transport sends one,
    // so the 400 is hibp-fake's answer, not one this test made up.
    fetch: async (url, init) => {
      const full = String(url).replace(
        /\/range\/[0-9A-F]{5}$/,
        `/range/${sha1Upper(SENTINEL_PASSWORD)}`,
      );
      const response = await fetch(full, init);
      statuses.push(response.status);
      return response;
    },
  });
  const { lines, log } = capture();
  const email = uniqueEmail('fail-open-400');
  const result = await new RegisterService(db, checker, log).register(input(email));
  assert.deepEqual(statuses, [400], 'premise: hibp-fake answered one 400, and it was not retried');
  await assertFailedOpen(result, lines, 'status_400', email);
});

test('fail open on a thrown UpstreamCallFailedError: a transport that always fails exhausts six attempts, the account is created, and the alert says kit_transport_error', async () => {
  const failing = (): Promise<Response> =>
    Promise.reject(new TypeError('T-141 planted transport failure'));
  // Premise: this transport, through the kit, THROWS UpstreamCallFailedError.
  await assert.rejects(
    createUpstreamCaller({ breaker: createCircuitBreaker(), random: () => 0 }).call(failing),
    (e: unknown) =>
      e instanceof UpstreamCallFailedError && e.reason === 'transport_error' && e.attempts === 6,
  );
  let attempts = 0;
  const checker = new HibpChecker({
    base: env('HIBP_API_BASE'),
    caller: createUpstreamCaller({ breaker: createCircuitBreaker(), random: () => 0 }),
    fetch: () => {
      attempts++;
      return failing();
    },
  });
  const { lines, log } = capture();
  const email = uniqueEmail('fail-open-thrown');
  const result = await new RegisterService(db, checker, log).register(input(email));
  assert.equal(attempts, 6, 'premise: six attempts reached the transport');
  await assertFailedOpen(result, lines, 'kit_transport_error', email);
});

test('fail open on an upstream 429 that the kit retries and then throws: the alert says kit_rate_limited', async () => {
  let attempts = 0;
  const checker = new HibpChecker({
    base: env('HIBP_API_BASE'),
    caller: createUpstreamCaller({ breaker: createCircuitBreaker(), random: () => 0 }),
    fetch: () => {
      attempts++;
      return Promise.resolve(new Response('', { status: 429 }));
    },
  });
  const { lines, log } = capture();
  const email = uniqueEmail('fail-open-429');
  const result = await new RegisterService(db, checker, log).register(input(email));
  assert.equal(attempts, 6, 'premise: the 429 was retried to the kit limit');
  await assertFailedOpen(result, lines, 'kit_rate_limited', email);
});

test('fail open on an open breaker: no request reaches the upstream, and the alert says kit_circuit_open', async () => {
  const breaker = createCircuitBreaker();
  for (let i = 0; i < 20; i++) {
    const permit = breaker.acquire();
    assert.ok(permit, 'premise: the breaker admits the planted failures');
    breaker.settle(permit, true);
  }
  assert.equal(breaker.state, 'open', 'premise: 20 failures in 60 s opened the breaker');
  let requests = 0;
  const checker = new HibpChecker({
    base: env('HIBP_API_BASE'),
    caller: createUpstreamCaller({ breaker }),
    fetch: (url, init) => {
      requests++;
      return fetch(url, init);
    },
  });
  const { lines, log } = capture();
  const email = uniqueEmail('fail-open-breaker');
  const result = await new RegisterService(db, checker, log).register(input(email));
  assert.equal(requests, 0, 'premise: the open breaker refused before any request');
  await assertFailedOpen(result, lines, 'kit_circuit_open', email);
});

test('with the upstream accepting connections and never answering, register fails open only after the kit worst case of 18195 ms, and the time is printed', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  try {
    // The kit's defaults (2000 ms per attempt), with random() just under 1: the longest waits.
    const checker = new HibpChecker({
      base: `http://127.0.0.1:${String(address.port)}`,
      caller: createUpstreamCaller({ breaker: createCircuitBreaker(), random: () => 0.999999 }),
    });
    const { lines, log } = capture();
    const email = uniqueEmail('fail-open-hang');
    const started = performance.now();
    const result = await new RegisterService(db, checker, log).register(input(email));
    const elapsed = performance.now() - started;
    console.log(
      `T141-MEASURE register with HIBP accepting and never answering: ${elapsed.toFixed(0)} ms ` +
        `(kit defaults: 2000 ms per attempt; random 0.999999)`,
    );
    await assertFailedOpen(result, lines, 'kit_timeout', email);
    // Node's timers fire no earlier than their delay, but at millisecond granularity, so 5 ms of
    // slack is allowed below the figure.
    assert.ok(elapsed >= KIT_WORST_CASE_MS - 5, `failed open after ${elapsed.toFixed(0)} ms`);
    assert.ok(elapsed < KIT_WORST_CASE_MS + 5000, `took ${elapsed.toFixed(0)} ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);

test('findAccountIdByEmail finds an address differing only in case, because the email comparand is citext (OD-98)', async () => {
  const email = `T141.Case.${randomBytes(6).toString('hex')}@Example.CY`;
  const { log } = capture();
  const result = await new RegisterService(db, realChecker(), log).register(
    input(email, T139_CLEAN_01),
  );
  const variant = email.toLowerCase();
  assert.notEqual(variant, email, 'premise: the variant differs in case');
  assert.equal(await db.withAppRw((tx) => findAccountIdByEmail(tx, variant)), result.accountId);
  assert.equal(await db.withAppRw((tx) => findAccountIdByEmail(tx, email)), result.accountId);
  assert.equal(
    await db.withAppRw((tx) => findAccountIdByEmail(tx, uniqueEmail('absent'))),
    undefined,
  );
});

/** The SQLSTATE of a pg error, directly or as the `cause` Drizzle wraps it in. */
function sqlState(thrown: unknown): unknown {
  let current: unknown = thrown;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current !== 'object' || current === null) return undefined;
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

test('withAppRw runs as app_rw: current_user reads app_rw, and a DELETE on account inside it is refused 42501', async () => {
  const who = await db.withAppRw(async (tx) => {
    const result = await tx.execute<{ u: string }>(sql`SELECT current_user AS u`);
    return result.rows[0]?.u;
  });
  assert.equal(who, 'app_rw');
  await assert.rejects(
    db.withAppRw((tx) => tx.execute(sql`DELETE FROM public.account WHERE false`)),
    (e: unknown) => sqlState(e) === '42501',
  );
  // Control: the login this module is given is not app_rw on its own (decisions.md OD-116).
  const plain = await superuser().query<{ u: string }>('SELECT current_user AS u');
  assert.notEqual(plain.rows[0]?.u, 'app_rw');
});

test('registering an address already in use throws EmailInUseError, for the same spelling and for a case variant, and one account holds it', async () => {
  const email = `T141-InProcess-InUse-${randomBytes(6).toString('hex')}@Example.CY`;
  const { log } = capture();
  const service = new RegisterService(db, realChecker(), log);
  await service.register(input(email, T139_CLEAN_01));
  for (const again of [email, email.toLowerCase()]) {
    await assert.rejects(service.register(input(again, T139_CLEAN_01)), (e: unknown) => {
      return e instanceof EmailInUseError && e.code === 'email_in_use' && e.status === 409;
    });
  }
  const { rows } = await superuser().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.account WHERE email_ci = $1::citext',
    [email],
  );
  assert.equal(rows[0]?.n, 1);
});

test('a token_hash that is not a 32-byte SHA-256 digest is refused in code and never reaches app_session', async () => {
  for (const bad of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), 'a'.repeat(32)]) {
    assert.throws(
      () => assertSessionDigest(bad),
      (e: unknown) => e instanceof TypeError && e.message === DIGEST_REFUSED,
    );
  }
  assert.equal(assertSessionDigest(Buffer.alloc(32)).length, 32);

  const { log } = capture();
  const registered = await new RegisterService(db, realChecker(), log).register(
    input(uniqueEmail('digest'), T139_CLEAN_01),
  );
  const id = newSessionId();
  const cookieBytes = Buffer.from(registered.session.cookieValue, 'utf8');
  assert.equal(cookieBytes.length, 43, 'premise: the cookie value is 43 bytes');
  await assert.rejects(
    db.withAppRw((tx) =>
      insertSession(tx, {
        id,
        accountId: registered.accountId,
        tokenHash: cookieBytes,
        absoluteExpiresAt: new Date(Date.now() + 60000),
        authMethod: 'password',
      }),
    ),
    (e: unknown) => e instanceof TypeError && e.message === DIGEST_REFUSED,
  );
  const { rows } = await superuser().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.app_session WHERE id = $1',
    [id],
  );
  assert.equal(rows[0]?.n, 0);
});

test('the seeded breached password is refused with a 422 password_breached error, logs nothing and writes no account', async () => {
  const email = uniqueEmail('breached');
  const { lines, log } = capture();
  await assert.rejects(
    new RegisterService(db, realChecker(), log).register(input(email, T139_BREACHED_01)),
    (e: unknown) =>
      e instanceof Error &&
      'code' in e &&
      e.code === 'password_breached' &&
      'status' in e &&
      e.status === 422,
  );
  assert.deepEqual(lines, []);
  const { rows } = await superuser().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.account WHERE email_ci = $1::citext',
    [email],
  );
  assert.equal(rows[0]?.n, 0);
});

test('no password: no HIBP request is made, nothing is logged, password_hash is NULL and the session is a registration session (OE-28 (B))', async () => {
  let requests = 0;
  const checker = new HibpChecker({
    base: env('HIBP_API_BASE'),
    caller: createUpstreamCaller({ breaker: createCircuitBreaker() }),
    fetch: (url, init) => {
      requests++;
      return fetch(url, init);
    },
  });
  const { lines, log } = capture();
  const email = uniqueEmail('passwordless');
  const result = await new RegisterService(db, checker, log).register({
    email,
    role: 'parent',
    tosVersion: 'tos-t141',
  });
  assert.equal(requests, 0, 'an HIBP request was made for a registration with no password');
  assert.equal(result.hibp, 'not_checked');
  assert.deepEqual(lines, []);
  const { rows } = await superuser().query<{ hash_is_null: boolean; auth_method: string }>(
    'SELECT a.password_hash IS NULL AS hash_is_null, s.auth_method ' +
      'FROM public.account a JOIN public.app_session s ON s.account_id = a.id WHERE a.id = $1',
    [result.accountId],
  );
  assert.deepEqual(rows, [{ hash_is_null: true, auth_method: 'registration' }]);
});
