/**
 * T-026 against the CONTAINERISED core. The setup is:
 *   1. `scripts/svc up T-026 db api --verify --build`;
 *   2. `scripts/svc run T-026 -- pnpm run db:migrate up`;
 *   3. `scripts/svc run T-026 -- pnpm --filter @kinvara/core test:integration`.
 * `svc run` injects `CORE_BASE_URL` and `DATABASE_URL`. Without them every test here FAILS; none
 * skips. Nothing in this file needs `hibp-fake`: accounts with a password are planted with SQL as
 * the bootstrap superuser, and the one registration is passwordless, which makes no HIBP request
 * (T-141 LIVE §2).
 *
 * THE EXPECTATIONS ARE ANCHORED OUTSIDE core's code (PROTOCOL §5.1):
 *   - planted hashes are made here with `@node-rs/argon2` at SA §SEC-5 line 2203's parameters,
 *     written here (m=64 MiB = 65536 KiB, t=3, p=1), not with `src/`'s `hashPassword`;
 *   - the refusal bodies are compared with EACH OTHER as raw bytes, and with a literal written from
 *     SD §BE-4 line 1021's code and T-023 § contract §6's body members;
 *   - the 250 ms floor is SD §SEC-I7 line 3976's figure, written here and measured by this process;
 *   - the cookie attributes are SD line 1235's, the TTLs SA §SEC-5 line 2209's;
 *   - the stored digest is recomputed here with `node:crypto`;
 *   - the 200 body is validated against the committed `openapi.json` by `json-schema-check`.
 *
 * WHAT THIS FILE CANNOT SEE: how many argon2id verifies the container ran. That is counted from
 * core's own log lines outside Vitest (state/EP-2/T-026.md) and in-process by a counting verifier
 * (`test/login.inprocess.test.ts`).
 */
import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { validateAgainstDocument, type SchemaRoot } from '@kinvara/contracts';

/** SA §SEC-5 line 2203. */
const SA_SEC5 = { memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 } as const;
/** `Algorithm.Argon2id` in `@node-rs/argon2`'s `index.d.ts`, an ambient const enum. */
const ARGON2ID = 2 as Algorithm;
/** SD §SEC-I7 line 3976. */
const FLOOR_MS = 250;
/** SA §SEC-5 line 2209 / SD line 1235. */
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const EIGHT_HOURS_SECONDS = 8 * 60 * 60;
const TYPE_BASE = 'https://errors.kinvara.cy/';
const PASSWORD = 'kinvara-T026-container-correct-3b9e';
const SENTINEL = 'KINVARA-T026-SENTINEL-container-e41f';

const INVALID_CREDENTIALS = {
  type: `${TYPE_BASE}invalid_credentials`,
  title: 'Invalid credentials',
  status: 401,
  code: 'invalid_credentials',
  retryable: false,
};
const INVALID_PASSWORD = {
  type: `${TYPE_BASE}invalid_input`,
  title: 'Invalid input',
  status: 400,
  code: 'invalid_input',
  field: 'password',
  retryable: false,
};
const CLEARED_COOKIE = '__Host-kv_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

const DOCUMENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'contracts',
  'openapi.json',
);

interface Document extends SchemaRoot {
  readonly paths: Record<string, Record<string, { readonly operationId?: string }>>;
  readonly components: { readonly schemas: Record<string, unknown> };
}

const doc = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8')) as Document;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TypeError(`${name} is not set: run under \`scripts/svc run <ticket> --\``);
  }
  return value;
}

/** A POST operation's path, read from the committed document, not from core. */
function postPath(operationId: string): string {
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (methods['post']?.operationId === operationId) return path;
  }
  throw new TypeError(`the committed document declares no POST ${operationId}`);
}

let pool: InstanceType<typeof pg.Pool> | undefined;
function database(): InstanceType<typeof pg.Pool> {
  pool ??= new pg.Pool({ connectionString: env('DATABASE_URL'), max: 2 });
  return pool;
}
afterAll(async () => {
  await pool?.end();
});

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly setCookie: readonly string[];
  readonly cacheControl: string | null;
  readonly text: string;
  /** From sending the request to reading the whole body, measured here. */
  readonly ms: number;
}

async function post(
  operationId: string,
  body: string | undefined,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const init: RequestInit =
    body === undefined
      ? { method: 'POST', headers }
      : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body };
  const started = performance.now();
  const res = await fetch(new URL(postPath(operationId), env('CORE_BASE_URL')), init);
  const text = await res.text();
  const ms = performance.now() - started;
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    setCookie: res.headers.getSetCookie(),
    cacheControl: res.headers.get('cache-control'),
    text,
    ms,
  };
}

function login(email: string, password: string): Promise<Answer> {
  return post('login', JSON.stringify({ email, password }));
}

function sessionCookie(maxAgeSeconds: number): RegExp {
  return new RegExp(
    `^__Host-kv_session=([A-Za-z0-9_-]{43}); Path=/; HttpOnly; Secure; SameSite=Lax; ` +
      `Max-Age=${String(maxAgeSeconds)}$`,
  );
}

/** The one session cookie value an answer sets, with SD line 1235's attributes. */
function cookieValueOf(answer: Answer, maxAgeSeconds: number = THIRTY_DAYS_SECONDS): string {
  assert.equal(answer.setCookie.length, 1, `Set-Cookie: ${answer.setCookie.join(' | ')}`);
  const value = sessionCookie(maxAgeSeconds).exec(answer.setCookie[0] ?? '')?.[1];
  assert.ok(value, `Set-Cookie is not the session cookie: ${answer.setCookie.join(' | ')}`);
  return value;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A ULID-shaped id: first character 0, then 25 Crockford base32 characters. */
function ulidText(): string {
  let out = '0';
  for (const byte of randomBytes(25)) out += CROCKFORD.charAt(byte % 32);
  return out;
}

function uniqueEmail(tag: string): string {
  return `t026-${tag}-${randomBytes(6).toString('hex')}@example.cy`;
}

function argon2id(password: string): Promise<string> {
  return hash(password, { ...SA_SEC5, algorithm: ARGON2ID });
}

let correct: Promise<string> | undefined;
/** One SA §SEC-5 hash of PASSWORD, shared. */
function correctHash(): Promise<string> {
  correct ??= argon2id(PASSWORD);
  return correct;
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
}): Promise<Planted> {
  const id = ulidText();
  const email = options.email ?? uniqueEmail('planted');
  const status = options.status ?? 'pending';
  await database().query(
    'INSERT INTO public.account (id, pseudonym, email_ci, password_hash, tos_version, status, dob_verified_18) ' +
      'VALUES ($1, $2, $3, $4, $5, $6::public.account_status, $7)',
    [id, ulidText(), email, options.passwordHash, 'tos-t026', status, status === 'active'],
  );
  for (const role of options.roles ?? ['parent']) {
    await database().query('INSERT INTO public.account_role (account_id, role) VALUES ($1, $2)', [
      id,
      role,
    ]);
  }
  return { id, email };
}

interface SessionRow {
  readonly digest: Buffer;
  readonly authMethod: string;
  readonly ttlSeconds: number;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly whole: string;
}

async function sessionsOf(owner: string): Promise<SessionRow[]> {
  const { rows } = await database().query<{
    token_hash: Buffer;
    auth_method: string;
    ttl_seconds: number;
    revoked_at: string | null;
    revoked_reason: string | null;
    whole: string;
  }>(
    'SELECT token_hash, auth_method, extract(epoch FROM absolute_expires_at - created_at)::float8 AS ttl_seconds, ' +
      'revoked_at::text AS revoked_at, revoked_reason, row_to_json(s)::text AS whole ' +
      'FROM public.app_session s WHERE account_id = $1 ORDER BY created_at, id',
    [owner],
  );
  return rows.map((row) => ({
    digest: row.token_hash,
    authMethod: row.auth_method,
    ttlSeconds: row.ttl_seconds,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    whole: row.whole,
  }));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * QR-A1: the same PHC string with its salt's last base64 character replaced by `B`, whose two low
 * bits are non-zero, so the base64 is non-canonical. It keeps `isStoredPasswordHash`'s form.
 */
function nonCanonicalSalt(phc: string): string {
  const parts = phc.split('$');
  const salt = parts[4] ?? '';
  assert.match(salt, /^[A-Za-z0-9+/]{21}[AQgw]$/, 'premise: a canonical 22-character salt');
  parts[4] = `${salt.slice(0, 21)}B`;
  return parts.join('$');
}

/**
 * QR-F1 (OD-132): log in, then log out sending `body` as `contentType`. Logout must still answer 204,
 * clear the cookie with no-store, and revoke the session server-side.
 */
async function assertLogoutRevokesWith(
  name: string,
  contentType: string,
  body: string,
): Promise<void> {
  const a = await plant({ passwordHash: await correctHash() });
  const cookieValue = cookieValueOf(await login(a.email, PASSWORD));
  const out = await post('logout', body, {
    cookie: `__Host-kv_session=${cookieValue}`,
    'content-type': contentType,
  });
  assert.equal(out.status, 204, `${name}: ${String(out.status)} ${out.text}`);
  assert.equal(out.text, '', name);
  assert.deepEqual(out.setCookie, [CLEARED_COOKIE], `${name}: the cookie was not cleared`);
  assert.equal(out.cacheControl, 'private, no-store', name);
  const rows = await sessionsOf(a.id);
  assert.equal(rows.length, 1, name);
  assert.notEqual(rows[0]?.revokedAt, null, `${name}: the session survived logout`);
  assert.equal(rows[0]?.revokedReason, 'logout', name);
}

function assertRefused(answer: Answer, name: string): void {
  assert.equal(answer.status, 401, `${name}: ${String(answer.status)} ${answer.text}`);
  assert.match(answer.contentType, /^application\/problem\+json\b/, name);
  assert.deepEqual(JSON.parse(answer.text), INVALID_CREDENTIALS, name);
  assert.deepEqual(answer.setCookie, [], `${name}: a refusal set a cookie`);
}

test('login 200: {account, roles, stepUpRequired} is valid against the committed openapi.json, with one __Host-kv_session cookie, Cache-Control private, no-store, and a password session storing only the SHA-256 digest', async () => {
  const a = await plant({ passwordHash: await correctHash() });
  const answer = await login(a.email, PASSWORD);
  assert.equal(answer.status, 200, answer.text);
  assert.match(answer.contentType, /^application\/json\b/);
  const schema = doc.components.schemas['LoginResponse'];
  assert.notEqual(schema, undefined, 'the document names a LoginResponse schema');
  const body: unknown = JSON.parse(answer.text);
  assert.deepEqual(validateAgainstDocument(body, schema, doc), []);
  // The validator can refuse: a role outside SD's set.
  assert.notDeepEqual(
    validateAgainstDocument(
      { account: { id: a.id }, roles: ['admin'], stepUpRequired: true },
      schema,
      doc,
    ),
    [],
  );
  assert.deepEqual(body, { account: { id: a.id }, roles: ['parent'], stepUpRequired: true });
  const cookieValue = cookieValueOf(answer);
  assert.equal(
    answer.cacheControl,
    'private, no-store',
    'the 200 that sets the session is cacheable',
  );
  assert.equal(answer.text.includes(cookieValue), false, 'the cookie value is in the body');

  const rows = await sessionsOf(a.id);
  assert.equal(rows.length, 1, 'exactly one session for the account');
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.digest.length, 32);
  assert.ok(
    row.digest.equals(sha256(cookieValue)),
    'token_hash is not SHA-256 of the cookie value',
  );
  assert.equal(row.whole.includes(cookieValue), false, 'the cookie value is stored in app_session');
  assert.equal(row.authMethod, 'password');
  assert.ok(Math.abs(row.ttlSeconds - THIRTY_DAYS_SECONDS) < 60, `TTL ${String(row.ttlSeconds)} s`);
  assert.equal(row.revokedAt, null);
});

test('a wrong password and an absent account answer byte-identical 401 invalid_credentials bodies, and set no cookie and write no session', async () => {
  const a = await plant({ passwordHash: await correctHash() });
  const wrong = await login(a.email, `${PASSWORD}-wrong`);
  const absent = await login(uniqueEmail('absent'), PASSWORD);
  assertRefused(wrong, 'wrong password');
  assertRefused(absent, 'absent account');
  assert.equal(
    Buffer.compare(Buffer.from(wrong.text, 'utf8'), Buffer.from(absent.text, 'utf8')),
    0,
    `the bodies differ: ${wrong.text} | ${absent.text}`,
  );
  assert.equal(wrong.contentType, absent.contentType);
  assert.equal((await sessionsOf(a.id)).length, 0, 'a refusal wrote a session');
});

test('a passwordless account (registered with no password, so password_hash is NULL) answers the same 401 body as a wrong password, and its email stays unverified', async () => {
  const email = uniqueEmail('passwordless');
  const registered = await post(
    'registerAccount',
    JSON.stringify({
      email,
      role: 'parent',
      tosVersion: 'tos-t026',
      turnstileToken: 'turnstile-t026',
    }),
  );
  assert.equal(registered.status, 201, `premise: ${registered.text}`);
  const { accountId } = JSON.parse(registered.text) as { accountId: string };
  const premise = await database().query<{ hash_is_null: boolean; unverified: boolean }>(
    'SELECT password_hash IS NULL AS hash_is_null, email_verified_at IS NULL AS unverified FROM public.account WHERE id = $1',
    [accountId],
  );
  assert.deepEqual(premise.rows, [{ hash_is_null: true, unverified: true }], 'premise');

  const control = await plant({ passwordHash: await correctHash() });
  const wrong = await login(control.email, `${PASSWORD}-wrong`);
  const refused = await login(email, PASSWORD);
  assertRefused(refused, 'passwordless account');
  assert.equal(refused.text, wrong.text, 'the passwordless refusal differs from a wrong password');

  const sessions = await sessionsOf(accountId);
  assert.deepEqual(
    sessions.map((s) => [s.authMethod, s.revokedAt]),
    [['magic_link', null]],
    'only the registration session exists',
  );
  const after = await database().query<{ unverified: boolean }>(
    'SELECT email_verified_at IS NULL AS unverified FROM public.account WHERE id = $1',
    [accountId],
  );
  assert.deepEqual(
    after.rows,
    [{ unverified: true }],
    'a magic_link session was read as email proof',
  );
});

test('a suspended, a removed and an erased-status account answer the same 401 body as a wrong password, even with the right password; pending and active log in', async () => {
  const control = await plant({ passwordHash: await correctHash() });
  const wrong = await login(control.email, `${PASSWORD}-wrong`);
  assertRefused(wrong, 'wrong password');
  for (const status of ['suspended', 'removed', 'erased']) {
    const a = await plant({ passwordHash: await correctHash(), status });
    const answer = await login(a.email, PASSWORD);
    assertRefused(answer, status);
    assert.equal(answer.text, wrong.text, `${status}: the body differs from a wrong password`);
    assert.equal((await sessionsOf(a.id)).length, 0, `${status}: a session was written`);
  }
  for (const status of ['pending', 'active']) {
    const a = await plant({ passwordHash: await correctHash(), status });
    const answer = await login(a.email, PASSWORD);
    assert.equal(answer.status, 200, `${status}: ${answer.text}`);
  }
});

test('every login path takes at least 250 ms, success and each refusal alike, and each time is printed', async () => {
  const ok = await plant({ passwordHash: await correctHash() });
  const passwordless = await plant({ passwordHash: null });
  const suspended = await plant({ passwordHash: await correctHash(), status: 'suspended' });
  const paths: readonly (readonly [string, string, string, number])[] = [
    ['success', ok.email, PASSWORD, 200],
    ['wrong password', ok.email, `${PASSWORD}-wrong`, 401],
    ['absent account', uniqueEmail('absent-timing'), PASSWORD, 401],
    ['passwordless account', passwordless.email, PASSWORD, 401],
    ['suspended account', suspended.email, PASSWORD, 401],
  ];
  for (let round = 1; round <= 3; round++) {
    for (const [name, email, password, status] of paths) {
      const answer = await login(email, password);
      console.log(
        `T026-MEASURE container round ${String(round)} ${name}: ${answer.ms.toFixed(1)} ms (status ${String(answer.status)})`,
      );
      assert.equal(answer.status, status, `${name}: ${answer.text}`);
      assert.ok(answer.ms >= FLOOR_MS, `${name} answered after ${answer.ms.toFixed(1)} ms`);
    }
  }
});

test('the address is matched case-insensitively through citext: case variants of the stored address log in (OD-98)', async () => {
  const email = `T026-Case-${randomBytes(6).toString('hex')}@Example.CY`;
  const a = await plant({ email, passwordHash: await correctHash() });
  for (const variant of [email.toLowerCase(), email.toUpperCase()]) {
    assert.notEqual(variant, email, 'premise: the variant differs in case');
    const answer = await login(variant, PASSWORD);
    assert.equal(answer.status, 200, `${variant}: ${answer.text}`);
    const body = JSON.parse(answer.text) as { account: { id: string } };
    assert.equal(body.account.id, a.id);
  }
});

test('the password is verified exactly as stored, with no Unicode normalisation: its NFD spelling is refused, and 12 lone surrogates log in as 12 U+FFFD', async () => {
  const nfc = 'kinvara-T026-café-exact';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfd, nfc, 'premise: the NFD spelling differs');
  const a = await plant({ passwordHash: await argon2id(nfc) });
  const accepted = await login(a.email, nfc);
  assert.equal(accepted.status, 200, accepted.text);
  assertRefused(await login(a.email, nfd), 'the NFD spelling');

  const b = await plant({ passwordHash: await argon2id('\uD800'.repeat(12)) });
  const replaced = await login(b.email, '\uFFFD'.repeat(12));
  assert.equal(replaced.status, 200, replaced.text);
});

test('a password under 12 characters or carrying a control character answers 400 invalid_input on password for an existing and an absent account alike, and a body that is not the contract answers 400 without echoing it', async () => {
  const a = await plant({ passwordHash: await correctHash() });
  for (const password of ['abcdefghijk', '\u{1F600}'.repeat(6), `${PASSWORD}\u0000`]) {
    const answers = [
      await login(a.email, password),
      await login(uniqueEmail('absent-400'), password),
    ];
    for (const answer of answers) {
      assert.equal(
        answer.status,
        400,
        `${String([...password].length)} characters: ${answer.text}`,
      );
      assert.deepEqual(JSON.parse(answer.text), INVALID_PASSWORD);
      assert.deepEqual(answer.setCookie, []);
    }
    assert.equal(answers[0]?.text, answers[1]?.text, 'a 400 depends on whether the account exists');
  }
  const cases: readonly (readonly [string, string, string])[] = [
    [
      'an unknown key',
      JSON.stringify({ email: a.email, password: PASSWORD, [SENTINEL]: SENTINEL }),
      'application/json',
    ],
    ['malformed JSON', `{"email":"${SENTINEL}`, 'application/json'],
    ['a non-JSON content type', SENTINEL, 'text/plain'],
  ];
  for (const [name, body, contentType] of cases) {
    const answer = await post('login', body, { 'content-type': contentType });
    assert.equal(answer.status, 400, `${name}: ${String(answer.status)}`);
    assert.equal(answer.text.includes(SENTINEL), false, `${name}: the input is echoed`);
  }
  assert.equal((await sessionsOf(a.id)).length, 0);
});

test('logout 204 revokes the session server-side and clears the cookie with the same attributes, with Cache-Control private, no-store', async () => {
  const a = await plant({ passwordHash: await correctHash() });
  const cookieValue = cookieValueOf(await login(a.email, PASSWORD));
  const out = await post('logout', undefined, { cookie: `__Host-kv_session=${cookieValue}` });
  assert.equal(out.status, 204, out.text);
  assert.equal(out.text, '');
  assert.deepEqual(out.setCookie, [CLEARED_COOKIE]);
  assert.equal(out.cacheControl, 'private, no-store');
  const rows = await sessionsOf(a.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.revokedAt, null, 'logout did not revoke the session');
  assert.equal(rows[0]?.revokedReason, 'logout');
});

test('a revoked session is refused: logging out again with its cookie answers 204 and leaves revoked_at exactly as it was, never NULL, and a new login does not revive it', async () => {
  const a = await plant({ passwordHash: await correctHash() });
  const cookieValue = cookieValueOf(await login(a.email, PASSWORD));
  const header = { cookie: `__Host-kv_session=${cookieValue}` };
  assert.equal((await post('logout', undefined, header)).status, 204);
  const [revoked] = await sessionsOf(a.id);
  assert.ok(revoked?.revokedAt, 'premise: the first logout revoked the session');

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  const again = await post('logout', undefined, header);
  assert.equal(again.status, 204);
  const [after] = await sessionsOf(a.id);
  assert.equal(after?.revokedAt, revoked.revokedAt, 'the second logout moved revoked_at');
  assert.equal(after?.revokedReason, 'logout');

  const fresh = cookieValueOf(await login(a.email, PASSWORD));
  assert.notEqual(fresh, cookieValue);
  const rows = await sessionsOf(a.id);
  assert.equal(rows.length, 2);
  const old = rows.find((row) => row.digest.equals(sha256(cookieValue)));
  assert.equal(
    old?.revokedAt,
    revoked.revokedAt,
    'a new login revived or moved the revoked session',
  );
});

test('logout with no cookie, a malformed cookie, an unknown session or the live value under another name answers 204, clears the cookie and revokes nothing', async () => {
  const a = await plant({ passwordHash: await correctHash() });
  const cookieValue = cookieValueOf(await login(a.email, PASSWORD));
  const cases: readonly (readonly [string, Record<string, string>])[] = [
    ['no cookie', {}],
    ['a malformed value', { cookie: '__Host-kv_session=not-a-session-token' }],
    [
      'an unknown session',
      { cookie: `__Host-kv_session=${randomBytes(32).toString('base64url')}` },
    ],
    ['the live value under another name', { cookie: `kv_session=${cookieValue}` }],
  ];
  for (const [name, headers] of cases) {
    const out = await post('logout', undefined, headers);
    assert.equal(out.status, 204, `${name}: ${out.text}`);
    assert.deepEqual(out.setCookie, [CLEARED_COOKIE], name);
  }
  const rows = await sessionsOf(a.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.revokedAt, null, 'a logout that named no live session revoked one');
});

test('an account holding an operator role gets the 8-hour admin session and cookie, and its roles are listed', async () => {
  const a = await plant({ passwordHash: await correctHash(), roles: ['parent', 'support'] });
  const answer = await login(a.email, PASSWORD);
  assert.equal(answer.status, 200, answer.text);
  cookieValueOf(answer, EIGHT_HOURS_SECONDS);
  assert.deepEqual(JSON.parse(answer.text), {
    account: { id: a.id },
    roles: ['parent', 'support'],
    stepUpRequired: true,
  });
  const rows = await sessionsOf(a.id);
  assert.ok(
    Math.abs((rows[0]?.ttlSeconds ?? 0) - EIGHT_HOURS_SECONDS) < 60,
    `TTL ${String(rows[0]?.ttlSeconds)} s`,
  );
});

test('logout with Content-Type application/json and an empty body still revokes the session, answers 204 and clears the cookie (QR-F1)', async () => {
  await assertLogoutRevokesWith('application/json, empty body', 'application/json', '');
});

test('logout with Content-Type application/json and a malformed JSON body still revokes the session, answers 204 and clears the cookie (QR-F1)', async () => {
  await assertLogoutRevokesWith('application/json, malformed', 'application/json', '{');
});

test('logout with Content-Type application/xml still revokes the session, answers 204 and clears the cookie (QR-F1)', async () => {
  await assertLogoutRevokesWith('application/xml', 'application/xml', '<a/>');
});

test('logout with a JSON body over 1 MiB still revokes the session, answers 204 and clears the cookie (QR-F1)', async () => {
  const body = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
  assert.ok(Buffer.byteLength(body, 'utf8') > 1024 * 1024, 'premise: the body is over 1 MiB');
  await assertLogoutRevokesWith('application/json, 2 MiB', 'application/json', body);
});

test('a stored hash of the admitted form that the library cannot verify (a non-canonical base64 salt) answers the same 401 body as a wrong password, after the floor, not 500 (QR-A1)', async () => {
  const good = await correctHash();
  const bad = nonCanonicalSalt(good);
  await assert.rejects(
    verify(bad, PASSWORD),
    'premise: @node-rs/argon2 cannot verify the planted hash',
  );
  const control = await plant({ passwordHash: good });
  const wrong = await login(control.email, `${PASSWORD}-wrong`);
  assertRefused(wrong, 'wrong password');
  const a = await plant({ passwordHash: bad });
  const answer = await login(a.email, PASSWORD);
  assertRefused(answer, 'non-canonical salt');
  assert.equal(answer.text, wrong.text, 'the body differs from a wrong password');
  assert.ok(answer.ms >= FLOOR_MS, `answered after ${answer.ms.toFixed(1)} ms`);
  assert.equal((await sessionsOf(a.id)).length, 0, 'a session was written');
});
