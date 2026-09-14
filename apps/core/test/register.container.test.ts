/**
 * T-141 against the CONTAINERISED core. The setup is:
 *   1. `scripts/svc up T-141 db api hibp --verify --build`;
 *   2. `scripts/svc run T-141 -- pnpm run db:migrate up`;
 *   3. `scripts/svc run T-141 -- pnpm --filter @kinvara/core test:integration`.
 * `svc run` injects `CORE_BASE_URL` and `DATABASE_URL`. Without them every test here FAILS; none
 * skips. `hibp-fake` must be running.
 *
 * THE EXPECTATIONS ARE ANCHORED OUTSIDE core's code (PROTOCOL §5.1):
 *   - the argon2id parameters are written here from SA §SEC-5, line 2203 ("m=64MB, t=3, p=1", read
 *     as 64 MiB = 65536 KiB), and the PHC string is parsed by the regular expression below, not
 *     compared with `src/`'s constants;
 *   - the cookie's attributes come from SD line 1235, and its 30-day `Max-Age` from SA §SEC-5
 *     line 2209;
 *   - the stored digest is recomputed here with `node:crypto` from the cookie the response carried;
 *   - the problem bodies are literals: T-023 § contract §6's titles and statuses, and the two codes
 *     T-141 adds;
 *   - the breached and clean passwords are T-139 § contract (rework 1) §3's seeded corpus;
 *   - the 201 body is validated against the committed `openapi.json` by `json-schema-check`, not by
 *     Zod.
 */
import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { verify } from '@node-rs/argon2';
import { validateAgainstDocument, type SchemaRoot } from '@kinvara/contracts';

/** SA §SEC-5 line 2203. */
const SA_SEC5 = { memoryKiB: 64 * 1024, timeCost: 3, parallelism: 1 } as const;
/** SA §SEC-5 line 2209: "30-day absolute TTL for consumers". */
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
/** T-139 § contract (rework 1) §3. */
const T139 = {
  breached01: 'kinvara-T139-synthetic-breached-01',
  clean01: 'kinvara-T139-synthetic-clean-01',
  cleanSibling: 'kinvara-T139-synthetic-clean-sibling-66358',
} as const;
const TYPE_BASE = 'https://errors.kinvara.cy/';
const SENTINEL = 'KINVARA-T141-SENTINEL-container-5d1c';

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

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TypeError(`${name} is not set: run under \`scripts/svc run <ticket> --\``);
  }
  return value;
}

const doc = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8')) as Document;

/** The register path, read from the committed document, not from core. */
function registerPath(): string {
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (methods['post']?.operationId === 'registerAccount') return path;
  }
  throw new TypeError('the committed document declares no POST registerAccount');
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
}

async function post(body: string, contentType = 'application/json'): Promise<Answer> {
  const res = await fetch(new URL(registerPath(), env('CORE_BASE_URL')), {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    setCookie: res.headers.getSetCookie(),
    cacheControl: res.headers.get('cache-control'),
    text: await res.text(),
  };
}

function registration(email: string, password: string): Record<string, string> {
  return {
    email,
    password,
    role: 'parent',
    tosVersion: 'tos-t141',
    turnstileToken: 'turnstile-t141',
  };
}

function uniqueEmail(tag: string): string {
  return `t141-${tag}-${randomBytes(6).toString('hex')}@example.cy`;
}

async function accountsHolding(email: string): Promise<number> {
  const { rows } = await database().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.account WHERE email_ci = $1::citext',
    [email],
  );
  return rows[0]?.n ?? -1;
}

function problem(code: string, title: string, status: number, field?: string): object {
  return field === undefined
    ? { type: `${TYPE_BASE}${code}`, title, status, code, retryable: false }
    : { type: `${TYPE_BASE}${code}`, title, status, code, field, retryable: false };
}

const COOKIE = new RegExp(
  `^__Host-kv_session=([A-Za-z0-9_-]{43}); Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${String(THIRTY_DAYS_SECONDS)}$`,
);

interface Created {
  readonly email: string;
  readonly password: string;
  readonly accountId: string;
  readonly cookieValue: string;
  readonly answer: Answer;
}
let created: Promise<Created> | undefined;
/** One registration, shared by the first three tests. */
function createdOnce(): Promise<Created> {
  created ??= (async () => {
    const email = uniqueEmail('created');
    const answer = await post(JSON.stringify(registration(email, T139.clean01)));
    assert.equal(answer.status, 201, `register answered ${String(answer.status)}: ${answer.text}`);
    const body = JSON.parse(answer.text) as { accountId: string };
    const match = COOKIE.exec(answer.setCookie[0] ?? '');
    assert.ok(
      match?.[1],
      `Set-Cookie is not the SD 1235 session cookie: ${answer.setCookie.join(' | ')}`,
    );
    return {
      email,
      password: T139.clean01,
      accountId: body.accountId,
      cookieValue: match[1],
      answer,
    };
  })();
  return created;
}

test('register 201: a new parent gets {accountId}, valid against the committed openapi.json, and one __Host-kv_session cookie', async () => {
  const { answer, cookieValue } = await createdOnce();
  assert.equal(answer.status, 201);
  assert.match(answer.contentType, /^application\/json\b/);
  const schema = doc.components.schemas['RegisterResponse'];
  assert.notEqual(schema, undefined, 'the document names a RegisterResponse schema');
  assert.deepEqual(validateAgainstDocument(JSON.parse(answer.text), schema, doc), []);
  // The validator can refuse: a lower-case id and an extra key.
  assert.notDeepEqual(validateAgainstDocument({ accountId: 'x' }, schema, doc), []);
  assert.equal(answer.setCookie.length, 1, 'exactly one Set-Cookie');
  assert.equal(answer.text.includes(cookieValue), false, 'the cookie value is in the body');
  // SD line 4037: no authenticated response is ever cacheable (T-141 rework 1, QR-A8).
  assert.equal(
    answer.cacheControl,
    'private, no-store',
    'the 201 that sets the session is cacheable',
  );
});

test('the stored password_hash parses as argon2id at SA SEC-5 m=64 MiB t=3 p=1, is not the input, and verifies the input only', async () => {
  const { accountId, password } = await createdOnce();
  const { rows } = await database().query<{ password_hash: string }>(
    'SELECT password_hash FROM public.account WHERE id = $1',
    [accountId],
  );
  assert.equal(rows.length, 1);
  const stored = rows[0]?.password_hash ?? '';
  const phc =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  assert.ok(phc, `the stored hash is not an argon2id PHC string (length ${String(stored.length)})`);
  assert.deepEqual(
    [Number(phc[1]), Number(phc[2]), Number(phc[3])],
    [SA_SEC5.memoryKiB, SA_SEC5.timeCost, SA_SEC5.parallelism],
  );
  assert.notEqual(stored, password);
  assert.equal(stored.includes(password), false, 'the password is inside the stored hash');
  assert.equal(
    await verify(stored, password),
    true,
    'the stored hash does not verify its password',
  );
  assert.equal(
    await verify(stored, `${password}x`),
    false,
    'the stored hash verifies another password',
  );
});

test('the app_session row holds the SHA-256 digest of the cookie value, 32 bytes, and never the cookie value itself', async () => {
  const { accountId, cookieValue } = await createdOnce();
  const sessions = await database().query<{
    token_hash: Buffer;
    auth_method: string;
    ttl_seconds: number;
    revoked: boolean;
    whole: string;
  }>(
    'SELECT token_hash, auth_method, ' +
      'extract(epoch FROM absolute_expires_at - created_at)::float8 AS ttl_seconds, ' +
      'revoked_at IS NOT NULL AS revoked, row_to_json(s)::text AS whole ' +
      'FROM public.app_session s WHERE account_id = $1',
    [accountId],
  );
  assert.equal(sessions.rows.length, 1, 'exactly one session for the new account');
  const row = sessions.rows[0];
  assert.ok(row);
  const digest = createHash('sha256').update(cookieValue, 'utf8').digest();
  assert.equal(row.token_hash.length, 32);
  assert.ok(row.token_hash.equals(digest), 'token_hash is not SHA-256 of the cookie value');
  assert.equal(row.token_hash.equals(Buffer.from(cookieValue, 'utf8')), false);
  const cookieHex = Buffer.from(cookieValue, 'utf8').toString('hex');
  assert.equal(row.whole.includes(cookieValue), false, 'the cookie value is stored in app_session');
  assert.equal(row.whole.includes(cookieHex), false, 'the cookie bytes are stored in app_session');
  assert.equal(row.auth_method, 'password');
  assert.ok(
    Math.abs(row.ttl_seconds - THIRTY_DAYS_SECONDS) < 60,
    `TTL ${String(row.ttl_seconds)} s`,
  );
  assert.equal(row.revoked, false);

  const account = await database().query<{ whole: string }>(
    'SELECT row_to_json(a)::text AS whole FROM public.account a WHERE id = $1',
    [accountId],
  );
  assert.equal(
    account.rows[0]?.whole.includes(cookieValue),
    false,
    'the cookie value is in account',
  );
  const roles = await database().query<{ role: string; revoked: boolean }>(
    'SELECT role, revoked_at IS NOT NULL AS revoked FROM public.account_role WHERE account_id = $1',
    [accountId],
  );
  assert.deepEqual(roles.rows, [{ role: 'parent', revoked: false }]);
});

test('too short: an 11-character password and a 6-emoji password (12 UTF-16 units) answer 400 invalid_input on password and create nothing; 12 characters is accepted', async () => {
  for (const password of ['abcdefghijk', '\u{1F600}'.repeat(6)]) {
    const email = uniqueEmail('short');
    const answer = await post(JSON.stringify(registration(email, password)));
    assert.equal(
      answer.status,
      400,
      `a ${String([...password].length)}-character password: ${answer.text}`,
    );
    assert.deepEqual(
      JSON.parse(answer.text),
      problem('invalid_input', 'Invalid input', 400, 'password'),
    );
    assert.equal(answer.text.includes(password), false);
    assert.deepEqual(answer.setCookie, []);
    assert.equal(await accountsHolding(email), 0);
  }
  // Control: 11 ASCII characters plus one astral character is 12 characters.
  const email = uniqueEmail('twelve');
  const answer = await post(JSON.stringify(registration(email, `t141twelve!\u{1F600}`)));
  assert.equal(answer.status, 201, answer.text);
  assert.equal(await accountsHolding(email), 1);
});

test('the seeded breached password kinvara-T139-synthetic-breached-01 answers 422 password_breached and creates no account', async () => {
  const email = uniqueEmail('breached');
  const answer = await post(JSON.stringify(registration(email, T139.breached01)));
  assert.equal(answer.status, 422, answer.text);
  assert.match(answer.contentType, /^application\/problem\+json\b/);
  assert.deepEqual(
    JSON.parse(answer.text),
    problem('password_breached', 'Password breached', 422, 'password'),
  );
  assert.deepEqual(answer.setCookie, []);
  assert.equal(await accountsHolding(email), 0);
});

test('the clean sibling sharing prefix C8DBF with a breached password is accepted: the check compares suffixes, not prefixes', async () => {
  const sha1 = (s: string): string =>
    createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
  assert.equal(sha1(T139.cleanSibling).slice(0, 5), sha1(T139.breached01).slice(0, 5), 'premise');
  const email = uniqueEmail('sibling');
  const answer = await post(JSON.stringify(registration(email, T139.cleanSibling)));
  assert.equal(answer.status, 201, answer.text);
  assert.equal(await accountsHolding(email), 1);
});

test('an address already in use answers 409 email_in_use, and so does the same address differing only in case; one account holds it', async () => {
  const email = `T141-InUse-${randomBytes(6).toString('hex')}@Example.CY`;
  const first = await post(JSON.stringify(registration(email, T139.clean01)));
  assert.equal(first.status, 201, first.text);
  for (const again of [email, email.toLowerCase(), email.toUpperCase()]) {
    const answer = await post(JSON.stringify(registration(again, T139.clean01)));
    assert.equal(
      answer.status,
      409,
      `${again === email ? 'same' : 'case variant'}: ${answer.text}`,
    );
    assert.deepEqual(
      JSON.parse(answer.text),
      problem('email_in_use', 'Email in use', 409, 'email'),
    );
    assert.equal(
      answer.text.toLowerCase().includes(email.toLowerCase()),
      false,
      'the address is echoed',
    );
    assert.deepEqual(answer.setCookie, []);
  }
  assert.equal(await accountsHolding(email), 1);
});

test('a body that is not the contract answers 400 invalid_input, never 500, and echoes nothing', async () => {
  const email = uniqueEmail('malformed');
  const valid = registration(email, T139.clean01);
  const withoutToken: Record<string, string> = { ...valid };
  delete withoutToken['turnstileToken'];
  const cases: readonly { name: string; body: string; contentType?: string; field?: string }[] = [
    { name: 'malformed JSON', body: `{"email":"${SENTINEL}` },
    { name: 'an unknown key', body: JSON.stringify({ ...valid, [SENTINEL]: SENTINEL }) },
    { name: 'a missing field', body: JSON.stringify(withoutToken), field: 'turnstileToken' },
    {
      name: 'a role outside the set',
      body: JSON.stringify({ ...valid, role: SENTINEL }),
      field: 'role',
    },
    { name: 'a non-JSON content type', body: SENTINEL, contentType: 'text/plain' },
  ];
  for (const c of cases) {
    const answer = await post(c.body, c.contentType);
    assert.equal(answer.status, 400, `${c.name}: ${String(answer.status)}`);
    assert.match(answer.contentType, /^application\/problem\+json\b/, c.name);
    assert.equal(answer.text.includes(SENTINEL), false, `${c.name}: the input is echoed`);
    assert.deepEqual(
      JSON.parse(answer.text),
      problem('invalid_input', 'Invalid input', 400, c.field),
      c.name,
    );
  }
  assert.equal(await accountsHolding(email), 0);
});

// ---- T-141 rework 1 -------------------------------------------------------------------------

test('no password (SD BE-4 password?, SA CC-1): 201 with one session cookie and Cache-Control private, no-store, password_hash IS NULL, and a magic_link session', async () => {
  const email = uniqueEmail('passwordless');
  const answer = await post(
    JSON.stringify({
      email,
      role: 'parent',
      tosVersion: 'tos-t141',
      turnstileToken: 'turnstile-t141',
    }),
  );
  assert.equal(answer.status, 201, answer.text);
  assert.equal(answer.setCookie.length, 1, 'exactly one Set-Cookie');
  const match = COOKIE.exec(answer.setCookie[0] ?? '');
  assert.ok(
    match?.[1],
    `Set-Cookie is not the SD 1235 session cookie: ${answer.setCookie.join(' | ')}`,
  );
  assert.equal(answer.cacheControl, 'private, no-store');
  const { accountId } = JSON.parse(answer.text) as { accountId: string };
  const { rows } = await database().query<{
    hash_is_null: boolean;
    auth_method: string;
    token_hash: Buffer;
  }>(
    'SELECT a.password_hash IS NULL AS hash_is_null, s.auth_method, s.token_hash ' +
      'FROM public.account a JOIN public.app_session s ON s.account_id = a.id WHERE a.id = $1',
    [accountId],
  );
  assert.equal(rows.length, 1, 'exactly one account with one session');
  assert.equal(rows[0]?.hash_is_null, true, 'a passwordless account has a password_hash');
  assert.equal(rows[0]?.auth_method, 'magic_link');
  const digest = createHash('sha256').update(match[1], 'utf8').digest();
  assert.ok(rows[0]?.token_hash.equals(digest), 'token_hash is not SHA-256 of the cookie value');
});

test('password null or not a string answers 400 invalid_input on password and creates nothing: only an absent password is passwordless', async () => {
  const values: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['a number', 123456789012],
    ['true', true],
    ['an array', ['kinvara-T139-synthetic-clean-01']],
    ['an object', {}],
    ['an empty string', ''],
  ];
  for (const [name, password] of values) {
    const email = uniqueEmail('password-type');
    const answer = await post(JSON.stringify({ ...registration(email, T139.clean01), password }));
    assert.equal(answer.status, 400, `password ${name}: ${answer.text}`);
    assert.deepEqual(
      JSON.parse(answer.text),
      problem('invalid_input', 'Invalid input', 400, 'password'),
      name,
    );
    assert.deepEqual(answer.setCookie, [], name);
    assert.equal(await accountsHolding(email), 0, name);
  }
});

test('an email over 254 octets answers 400 invalid_input on email, never 500; 254 octets is accepted', async () => {
  const suffix = `-${randomBytes(4).toString('hex')}@example.cy`;
  for (const length of [255, 8011]) {
    const email = `${'b'.repeat(length - suffix.length)}${suffix}`;
    assert.equal(email.length, length, 'premise');
    const answer = await post(JSON.stringify(registration(email, T139.clean01)));
    assert.equal(answer.status, 400, `${String(length)} octets: ${String(answer.status)}`);
    assert.deepEqual(
      JSON.parse(answer.text),
      problem('invalid_input', 'Invalid input', 400, 'email'),
    );
    assert.deepEqual(answer.setCookie, []);
  }
  const atLimit = `${'a'.repeat(254 - suffix.length)}${suffix}`;
  assert.equal(atLimit.length, 254, 'premise');
  const answer = await post(JSON.stringify(registration(atLimit, T139.clean01)));
  assert.equal(answer.status, 201, answer.text);
  assert.equal(await accountsHolding(atLimit), 1);
});

test('a tosVersion over 64 characters answers 400 invalid_input on tosVersion; 64 characters is accepted', async () => {
  for (const length of [65, 900000]) {
    const email = uniqueEmail('tos-long');
    const answer = await post(
      JSON.stringify({ ...registration(email, T139.clean01), tosVersion: 'v'.repeat(length) }),
    );
    assert.equal(answer.status, 400, `${String(length)} characters: ${String(answer.status)}`);
    assert.deepEqual(
      JSON.parse(answer.text),
      problem('invalid_input', 'Invalid input', 400, 'tosVersion'),
    );
    assert.equal(await accountsHolding(email), 0);
  }
  const email = uniqueEmail('tos-64');
  const answer = await post(
    JSON.stringify({ ...registration(email, T139.clean01), tosVersion: 'v'.repeat(64) }),
  );
  assert.equal(answer.status, 201, answer.text);
  assert.equal(await accountsHolding(email), 1);
});

test('a control character in any string field answers 400 invalid_input on that field, never 500', async () => {
  const cases: readonly { readonly field: string; readonly patch: Record<string, string> }[] = [
    { field: 'tosVersion', patch: { tosVersion: 'tos\u0000t141' } },
    { field: 'tosVersion', patch: { tosVersion: 'tos\u0085t141' } },
    { field: 'turnstileToken', patch: { turnstileToken: 'turnstile\u001Ft141' } },
    { field: 'password', patch: { password: `${T139.clean01}\u0000` } },
    {
      field: 'email',
      patch: { email: `t141\u007Fctl-${randomBytes(4).toString('hex')}@example.cy` },
    },
  ];
  for (const c of cases) {
    const email = uniqueEmail('control');
    const body = { ...registration(email, T139.clean01), ...c.patch };
    const answer = await post(JSON.stringify(body));
    assert.equal(answer.status, 400, `${c.field}: ${String(answer.status)} ${answer.text}`);
    assert.deepEqual(
      JSON.parse(answer.text),
      problem('invalid_input', 'Invalid input', 400, c.field),
      c.field,
    );
    assert.equal(await accountsHolding(body['email'] ?? email), 0, c.field);
  }
});
