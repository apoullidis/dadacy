/**
 * T-026 IN-PROCESS, against the real Postgres of the ticket's project. `LoginService`,
 * `SessionService`, the repository and `Database` are `src/`'s own. The one thing injected is the
 * password verifier, wrapped to COUNT its calls and record the PHC string each call verified.
 * Run under `scripts/svc run T-026 -- pnpm --filter @kinvara/core test:integration`, which injects
 * `DATABASE_URL`. Without it every test FAILS; none skips. No other service is needed.
 *
 * THE EXPECTATIONS ARE ANCHORED OUTSIDE `src/` (PROTOCOL §5.1):
 *   - SA §SEC-5 line 2203's parameters are written here (m=64 MiB = 65536 KiB, t=3, p=1), and each
 *     verified PHC string is parsed by this file's own expression, not by `src/`'s;
 *   - the 250 ms floor is SD §SEC-I7 line 3976's figure, written here and measured by this process;
 *   - "a hash no account holds" is checked against the database, not against a constant in `src/`;
 *   - the accounts and sessions are planted with SQL as the bootstrap superuser, not through the
 *     repository under test.
 */
import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hash, type Algorithm } from '@node-rs/argon2';
import { Database } from '../src/identity/database.ts';
import { InvalidCredentialsError } from '../src/identity/errors.ts';
import { newAccountId, newPseudonym, newSessionId } from '../src/identity/ids.ts';
import { LoginService, type LoggedIn } from '../src/identity/login.service.ts';
import {
  VERIFY_LOG,
  createPasswordVerifier,
  hashPassword,
  type PasswordVerifier,
} from '../src/identity/password.ts';
import { SessionService } from '../src/identity/session.service.ts';
import { newSessionToken } from '../src/identity/session-token.ts';

/** SA §SEC-5 line 2203, in PHC form. */
const SA_SEC5_PARAMETERS = 'm=65536,t=3,p=1';
/** SD §SEC-I7 line 3976. */
const FLOOR_MS = 250;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const EIGHT_HOURS_SECONDS = 8 * 60 * 60;
const PASSWORD = 'kinvara-T026-inprocess-correct-9c2d';
const PHC = /^\$argon2id\$v=19\$(m=\d+,t=\d+,p=\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
/** `Algorithm.Argon2id` in `@node-rs/argon2`'s `index.d.ts`, an ambient const enum. */
const ARGON2ID = 2 as Algorithm;

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

function uniqueEmail(tag: string): string {
  return `t026-${tag}-${randomBytes(6).toString('hex')}@example.cy`;
}

interface Planted {
  readonly id: string;
  readonly email: string;
}

async function plant(options: {
  readonly email?: string;
  readonly passwordHash: string | null;
  readonly status?: string;
  readonly roles?: readonly string[];
  readonly revokedRoles?: readonly string[];
}): Promise<Planted> {
  const id = newAccountId();
  const email = options.email ?? uniqueEmail('planted');
  const status = options.status ?? 'pending';
  await superuser().query(
    'INSERT INTO public.account (id, pseudonym, email_ci, password_hash, tos_version, status, dob_verified_18) ' +
      'VALUES ($1, $2, $3, $4, $5, $6::public.account_status, $7)',
    [id, newPseudonym(), email, options.passwordHash, 'tos-t026', status, status === 'active'],
  );
  for (const role of options.roles ?? ['parent']) {
    await superuser().query('INSERT INTO public.account_role (account_id, role) VALUES ($1, $2)', [
      id,
      role,
    ]);
  }
  for (const role of options.revokedRoles ?? []) {
    await superuser().query(
      'INSERT INTO public.account_role (account_id, role, revoked_at) VALUES ($1, $2, now())',
      [id, role],
    );
  }
  return { id, email };
}

interface Counted {
  readonly verified: string[];
  readonly lines: string[];
  readonly verify: PasswordVerifier;
}

/** `src/`'s real verifier, wrapped to record every call and every log line. */
function counting(): Counted {
  const verified: string[] = [];
  const lines: string[] = [];
  const real = createPasswordVerifier((line) => {
    lines.push(line);
  });
  return {
    verified,
    lines,
    verify: (encoded, password) => {
      verified.push(encoded);
      return real(encoded, password);
    },
  };
}

type Outcome = 'logged_in' | 'invalid_credentials';

interface Attempt {
  readonly outcome: Outcome;
  readonly ms: number;
  readonly result?: LoggedIn;
}

async function attempt(service: LoginService, email: string, password: string): Promise<Attempt> {
  const started = performance.now();
  try {
    const result = await service.login(email, password);
    return { outcome: 'logged_in', ms: performance.now() - started, result };
  } catch (thrown) {
    if (thrown instanceof InvalidCredentialsError) {
      return { outcome: 'invalid_credentials', ms: performance.now() - started };
    }
    throw thrown;
  }
}

interface LoginPath {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly outcome: Outcome;
  /** True where no stored hash may be verified, so the verify must be of a hash no account holds. */
  readonly dummy: boolean;
}

interface Fixtures {
  readonly storedHash: string;
  readonly belowParametersHash: string;
  readonly paths: readonly LoginPath[];
}

let fixtures: Promise<Fixtures> | undefined;
/** One account per path, planted once and shared by the mechanism and the floor tests. */
function pathsOnce(): Promise<Fixtures> {
  fixtures ??= (async () => {
    const storedHash = await hashPassword(PASSWORD);
    // argon2id of the SAME password at m=4096, t=1: were it verified, the password would match.
    const belowParametersHash = await hash(PASSWORD, {
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
      algorithm: ARGON2ID,
    });
    const ok = await plant({ passwordHash: storedHash });
    const passwordless = await plant({ passwordHash: null });
    const suspended = await plant({ passwordHash: storedHash, status: 'suspended' });
    const below = await plant({ passwordHash: belowParametersHash });
    return {
      storedHash,
      belowParametersHash,
      paths: [
        {
          name: 'success',
          email: ok.email,
          password: PASSWORD,
          outcome: 'logged_in',
          dummy: false,
        },
        {
          name: 'wrong password',
          email: ok.email,
          password: `${PASSWORD}-wrong`,
          outcome: 'invalid_credentials',
          dummy: false,
        },
        {
          name: 'absent account',
          email: uniqueEmail('absent'),
          password: PASSWORD,
          outcome: 'invalid_credentials',
          dummy: true,
        },
        {
          name: 'passwordless account (password_hash NULL)',
          email: passwordless.email,
          password: PASSWORD,
          outcome: 'invalid_credentials',
          dummy: true,
        },
        {
          name: 'suspended account with the right password',
          email: suspended.email,
          password: PASSWORD,
          outcome: 'invalid_credentials',
          dummy: false,
        },
        {
          name: 'stored hash below SA SEC-5 parameters, right password',
          email: below.email,
          password: PASSWORD,
          outcome: 'invalid_credentials',
          dummy: true,
        },
      ],
    };
  })();
  return fixtures;
}

test('exactly one argon2id verify per login on every path, at SA SEC-5 m=65536 t=3 p=1, and the absent, passwordless and below-parameter paths verify a hash no account holds', async () => {
  const { paths, storedHash, belowParametersHash } = await pathsOnce();
  for (const path of paths) {
    const counted = counting();
    const { outcome } = await attempt(
      new LoginService(db, counted.verify),
      path.email,
      path.password,
    );
    assert.equal(outcome, path.outcome, path.name);
    assert.equal(
      counted.verified.length,
      1,
      `${path.name}: ${String(counted.verified.length)} verify call(s)`,
    );
    const encoded = counted.verified[0] ?? '';
    assert.equal(
      PHC.exec(encoded)?.[1],
      SA_SEC5_PARAMETERS,
      `${path.name}: not SA SEC-5 parameters`,
    );
    // The log line the container count reads: one per verify, carrying the parameters only.
    assert.deepEqual(counted.lines, [`${VERIFY_LOG} ${SA_SEC5_PARAMETERS}`], path.name);
    if (path.dummy) {
      assert.notEqual(encoded, storedHash, path.name);
      assert.notEqual(encoded, belowParametersHash, path.name);
      const holders = await superuser().query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.account WHERE password_hash = $1',
        [encoded],
      );
      assert.equal(
        holders.rows[0]?.n,
        0,
        `${path.name}: an account holds the hash that was verified`,
      );
    } else {
      assert.equal(encoded, storedHash, `${path.name}: the stored hash was not the one verified`);
    }
  }
});

test('every login path, success and each refusal alike, returns no sooner than the 250 ms floor, and each time is printed', async () => {
  const { paths } = await pathsOnce();
  for (const path of paths) {
    const { outcome, ms } = await attempt(new LoginService(db), path.email, path.password);
    console.log(`T026-MEASURE in-process ${path.name}: ${ms.toFixed(1)} ms`);
    assert.equal(outcome, path.outcome, path.name);
    assert.ok(ms >= FLOOR_MS, `${path.name} returned after ${ms.toFixed(1)} ms`);
  }
});

test('login verifies exactly the string register hashed: hashPassword of an NFC password refuses its NFD spelling, and 12 lone surrogates verify as 12 U+FFFD', async () => {
  const service = new LoginService(db);
  const nfc = 'kinvara-T026-café-exact-string';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfd, nfc, 'premise: the NFD spelling differs');
  const a = await plant({ passwordHash: await hashPassword(nfc) });
  assert.equal((await attempt(service, a.email, nfc)).outcome, 'logged_in');
  assert.equal((await attempt(service, a.email, nfd)).outcome, 'invalid_credentials');

  const b = await plant({ passwordHash: await hashPassword('\uD800'.repeat(12)) });
  assert.equal((await attempt(service, b.email, '\uFFFD'.repeat(12))).outcome, 'logged_in');
});

test('the login lookup compares the address as citext: a case variant of the stored address logs in (OD-98)', async () => {
  const email = `T026.Case.${randomBytes(6).toString('hex')}@Example.CY`;
  const a = await plant({ email, passwordHash: await hashPassword(PASSWORD) });
  const service = new LoginService(db);
  for (const variant of [email.toLowerCase(), email.toUpperCase()]) {
    assert.notEqual(variant, email, 'premise: the variant differs in case');
    const { outcome, result } = await attempt(service, variant, PASSWORD);
    assert.equal(outcome, 'logged_in', variant);
    assert.equal(result?.accountId, a.id, variant);
  }
});

test('a login session lasts 30 days, or 8 hours when the account holds an unrevoked role other than parent or sitter, and roles lists the unrevoked roles only', async () => {
  const storedHash = await hashPassword(PASSWORD);
  const cases: readonly {
    readonly name: string;
    readonly roles: readonly string[];
    readonly revokedRoles: readonly string[];
    readonly listed: readonly string[];
    readonly ttl: number;
  }[] = [
    {
      name: 'parent and sitter',
      roles: ['parent', 'sitter'],
      revokedRoles: [],
      listed: ['parent', 'sitter'],
      ttl: THIRTY_DAYS_SECONDS,
    },
    {
      name: 'parent and support',
      roles: ['parent', 'support'],
      revokedRoles: [],
      listed: ['parent', 'support'],
      ttl: EIGHT_HOURS_SECONDS,
    },
    {
      name: 'parent with a revoked ts_operator',
      roles: ['parent'],
      revokedRoles: ['ts_operator'],
      listed: ['parent'],
      ttl: THIRTY_DAYS_SECONDS,
    },
  ];
  const service = new LoginService(db);
  for (const c of cases) {
    const a = await plant({
      passwordHash: storedHash,
      roles: c.roles,
      revokedRoles: c.revokedRoles,
    });
    const { outcome, result } = await attempt(service, a.email, PASSWORD);
    assert.equal(outcome, 'logged_in', c.name);
    assert.deepEqual(result?.roles, c.listed, c.name);
    assert.equal(result?.maxAgeSeconds, c.ttl, c.name);
    assert.equal(result?.stepUpRequired, true, c.name);
    const { rows } = await superuser().query<{ ttl_seconds: number; auth_method: string }>(
      'SELECT extract(epoch FROM absolute_expires_at - created_at)::float8 AS ttl_seconds, auth_method ' +
        'FROM public.app_session WHERE account_id = $1',
      [a.id],
    );
    assert.equal(rows.length, 1, c.name);
    assert.ok(
      Math.abs((rows[0]?.ttl_seconds ?? 0) - c.ttl) < 60,
      `${c.name}: TTL ${String(rows[0]?.ttl_seconds)}`,
    );
    assert.equal(rows[0]?.auth_method, 'password', c.name);
  }
});

interface PlantedSession {
  readonly id: string;
  readonly cookieValue: string;
  readonly header: string;
}

/** A session planted as the superuser, so the resolver is judged on rows it did not write. */
async function plantSession(
  owner: string,
  options: {
    readonly expiresIn: string;
    readonly lastSeenAgo: string;
    readonly revokedAt?: string;
  },
): Promise<PlantedSession> {
  const token = newSessionToken();
  const id = newSessionId();
  await superuser().query(
    'INSERT INTO public.app_session (id, token_hash, account_id, auth_method, absolute_expires_at, last_seen_at, revoked_at, revoked_reason) ' +
      "VALUES ($1, $2, $3, 'password', now() + $4::interval, now() - $5::interval, $6::timestamptz, " +
      "CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE 'planted' END)",
    [id, token.tokenHash, owner, options.expiresIn, options.lastSeenAgo, options.revokedAt ?? null],
  );
  return { id, cookieValue: token.cookieValue, header: `__Host-kv_session=${token.cookieValue}` };
}

interface SessionState {
  readonly lastSeen: number;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

async function sessionState(id: string): Promise<SessionState> {
  const { rows } = await superuser().query<{
    last_seen: number;
    revoked_at: string | null;
    revoked_reason: string | null;
  }>(
    'SELECT extract(epoch FROM last_seen_at)::float8 AS last_seen, revoked_at::text AS revoked_at, revoked_reason ' +
      'FROM public.app_session WHERE id = $1',
    [id],
  );
  const row = rows[0];
  assert.ok(row, `no session ${id}`);
  return { lastSeen: row.last_seen, revokedAt: row.revoked_at, revokedReason: row.revoked_reason };
}

test('resolve refuses a revoked, an absolutely expired, an idle-expired, an unknown and an ambiguous session, and slides last_seen_at on a live one', async () => {
  const a = await plant({ passwordHash: null });
  const sessions = new SessionService(db);

  const live = await plantSession(a.id, { expiresIn: '1 day', lastSeenAgo: '10 minutes' });
  const before = await sessionState(live.id);
  const resolved = await sessions.resolve(live.header);
  assert.equal(resolved?.id, live.id, 'the live session did not resolve');
  assert.equal(resolved?.accountId, a.id);
  assert.ok(
    (await sessionState(live.id)).lastSeen > before.lastSeen + 500,
    'last_seen_at did not slide',
  );

  const refused: readonly (readonly [string, PlantedSession])[] = [
    [
      'revoked',
      await plantSession(a.id, {
        expiresIn: '1 day',
        lastSeenAgo: '1 minute',
        revokedAt: '2026-01-02T03:04:05Z',
      }),
    ],
    [
      'absolutely expired',
      await plantSession(a.id, { expiresIn: '-1 minute', lastSeenAgo: '1 minute' }),
    ],
    [
      'idle for 31 minutes',
      await plantSession(a.id, { expiresIn: '1 day', lastSeenAgo: '31 minutes' }),
    ],
  ];
  for (const [name, planted] of refused) {
    const was = await sessionState(planted.id);
    assert.equal(await sessions.resolve(planted.header), undefined, `${name} resolved`);
    assert.deepEqual(await sessionState(planted.id), was, `${name}: the row changed`);
  }

  const other = await plantSession(a.id, { expiresIn: '1 day', lastSeenAgo: '1 minute' });
  const headers: readonly (readonly [string, string | undefined])[] = [
    ['no header', undefined],
    ['an unknown value', `__Host-kv_session=${randomBytes(32).toString('base64url')}`],
    ['two live sessions', `${live.header}; ${other.header}`],
    ['a malformed value', '__Host-kv_session=short'],
    ['the live value under another name', `kv_session=${live.cookieValue}`],
  ];
  for (const [name, header] of headers) {
    assert.equal(await sessions.resolve(header), undefined, `${name} resolved`);
  }
});

test('logout revokes only a live session and never moves or clears revoked_at: a planted revoked session keeps its revoked_at, and a second logout changes nothing', async () => {
  const a = await plant({ passwordHash: null });
  const sessions = new SessionService(db);

  const revoked = await plantSession(a.id, {
    expiresIn: '1 day',
    lastSeenAgo: '1 minute',
    revokedAt: '2026-01-02T03:04:05Z',
  });
  const revokedBefore = await sessionState(revoked.id);
  assert.notEqual(revokedBefore.revokedAt, null, 'premise: the planted session is revoked');
  assert.equal(await sessions.logout(revoked.header), 0);
  assert.deepEqual(await sessionState(revoked.id), revokedBefore);

  const live = await plantSession(a.id, { expiresIn: '1 day', lastSeenAgo: '1 minute' });
  assert.equal(await sessions.logout(live.header), 1);
  const first = await sessionState(live.id);
  assert.notEqual(first.revokedAt, null);
  assert.equal(first.revokedReason, 'logout');
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  assert.equal(await sessions.logout(live.header), 0);
  assert.deepEqual(await sessionState(live.id), first, 'a second logout moved the revoked session');
  assert.equal(await sessions.resolve(live.header), undefined, 'a revoked session resolved');
});
