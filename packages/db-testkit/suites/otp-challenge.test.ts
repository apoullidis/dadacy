/**
 * T-194 — `public.otp_challenge` (migration 0013): SD §DB-2 lines 1830–1835 plus the accepted
 * OE-30 / OE-50 rulings (tasks/state/EP-2/OE-30-34-rulings.md Part A.1, Part B.2, Part F). These
 * are the database-layer refusals TK-1 lists.
 *
 * Every refusal asserts psql's exit status AND its `ERROR:  <SQLSTATE>: <message>` line AND, where
 * PostgreSQL gives one, the `CONSTRAINT NAME:` or `COLUMN NAME:` field, so a crash, a syntax error
 * or a refusal for another reason cannot read as this one. Each constraint refusal has a CONTROL
 * beside it: the same statement with the violating value changed is accepted.
 *
 * Every UPDATE refusal and control first reads its target row in the same psql session and asserts
 * that reading, so an UPDATE that matched no row can pass for neither a refusal nor a control.
 *
 * Privilege refusals, and the single-use trigger's refusals, run over REAL LOGIN principals, each a
 * member of exactly one role (T-020 Evidence §4). Constraint refusals run as the superuser, so no
 * privilege is what refuses them.
 *
 * The tests share one cluster in file order. Fixture rows are written in `beforeAll`; every other
 * write runs inside a transaction that is never committed (`inTransaction`).
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  PROBE_PASSWORD,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'otp-challenge';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't194_app_rw_probe',
  app_admin_rw: 't194_app_admin_rw_probe',
  app_safety_rw: 't194_app_safety_rw_probe',
  answering_service: 't194_answering_service_probe',
} as const;

/** Fixture ids, each exactly `char(26)` wide. */
const LIVE = '01K4T194OTPLIVE00000000001';
const CONSUMED = '01K4T194OTPCONSUMED0000001';
const EXHAUSTED = '01K4T194OTPEXHAUSTED000001';
const SCRATCH = '01K4T194OTPSCRATCH00000001';
const SCRATCH_2 = '01K4T194OTPSCRATCH00000002';
for (const id of [LIVE, CONSUMED, EXHAUSTED, SCRATCH, SCRATCH_2]) {
  assert.equal(id.length, 26, `fixture id ${id} is not char(26) wide`);
}

/** A 32-byte digest stand-in; `hmac(…, 'sha256')` is used where the HMAC shape matters. */
const H32 = `decode(repeat('ab', 32), 'hex')`;

/** An INSERT naming `extra` columns beyond the five O1 writes; `values` must match `extra`. */
const insert = (
  id: string,
  opts: { phone?: string; hash?: string; expires?: string; extra?: string; values?: string } = {},
): string =>
  `INSERT INTO public.otp_challenge (id, phone_e164, code_hash, expires_at, created_ip_prefix${
    opts.extra === undefined ? '' : ', ' + opts.extra
  }) VALUES (${id === 'NULL' ? 'NULL' : `'${id}'`}, ${opts.phone ?? `'+35799000001'`}, ${
    opts.hash ?? H32
  }, ${opts.expires ?? `now() + interval '5 minutes'`}, '192.0.2.0/24'${
    opts.values === undefined ? '' : ', ' + opts.values
  })`;

/** One row's attempts and consumed state, read in the session that then writes it. */
const readRow = (id: string): string =>
  `SELECT 'row ' || count(*) || ' attempts=' || coalesce(string_agg(attempts::text, ','), '-') ||
          ' consumed=' || coalesce(string_agg((consumed_at IS NOT NULL)::text, ','), '-')
     FROM public.otp_challenge WHERE id = '${id}'`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      insert(LIVE),
      // A consumed challenge: two wrong attempts, then the right code (T-027 O3, O4).
      insert(CONSUMED, { phone: `'+35799000002'` }),
      `UPDATE public.otp_challenge SET attempts = 2 WHERE id = '${CONSUMED}'`,
      `UPDATE public.otp_challenge SET consumed_at = now() WHERE id = '${CONSUMED}'`,
      // An exhausted challenge: three wrong attempts.
      insert(EXHAUSTED, { phone: `'+35799000003'` }),
      `UPDATE public.otp_challenge SET attempts = 3 WHERE id = '${EXHAUSTED}'`,
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/**
 * Every invocation runs inside one transaction that is never committed: BEGIN is prepended unless
 * the caller opened one, and psql's session end rolls it back. So nothing a test writes outlives it,
 * even when a mutated constraint accepts a statement the test expected to be refused.
 */
const inTransaction = (commands: string[]): string[] =>
  commands[0] === 'BEGIN' ? commands : ['BEGIN', ...commands];

/** Statements as the bootstrap superuser, SQLSTATE in the message, stopping at the first error. */
function asSuperuser(...commands: string[]): Promise<PsqlResult> {
  return db.psql({ commands: inTransaction(commands), verbose: true, stopOnError: true });
}

/** Statements over a real login, SQLSTATE in the message, stopping at the first error. */
function asLogin(login: string, ...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands: inTransaction(commands),
    verbose: true,
    stopOnError: true,
  });
}

/** Refused with exactly this ERROR line, and psql named the object that refused it. */
function assertRefusedBy(what: string, r: PsqlResult, errorLine: string, field: string): void {
  assertRefused(what, r, { message: errorLine });
  assert.ok(
    r.output.includes(field),
    `${what}: expected ${JSON.stringify(field)} in the output.\n${r.output}`,
  );
  assert.equal(
    (r.output.match(/ERROR: {2}[0-9A-Z]{5}:/g) ?? []).length,
    1,
    `${what}: expected exactly one ERROR line.\n${r.output}`,
  );
}

/** The session read the row it then wrote, and found it in the stated state. */
function assertRead(what: string, r: PsqlResult, state: string): void {
  assert.ok(
    r.output.includes(state),
    `${what}: expected the precondition ${JSON.stringify(state)}.\n${r.output}`,
  );
}

const CHECK_23514 = (c: string): string =>
  `ERROR:  23514: new row for relation "otp_challenge" violates check constraint "${c}"`;

describe('0013 — the table, its owner, its columns and its ACL', () => {
  test("SD's seven columns in SD's order, then created_at; owner app_ddl; ACL: app_rw SELECT, INSERT, and UPDATE on attempts and consumed_at only", async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' ||
                                   CASE WHEN attnotnull THEN 'nn' ELSE 'null' END || ':' ||
                                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' ORDER BY attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.otp_challenge'::regclass AND attnum > 0 AND NOT attisdropped)
                || '|' || pg_get_userbyid(c.relowner) || '|' || c.relacl::text || '|' ||
                (SELECT string_agg(attname || '=' || attacl::text, ',' ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = c.oid AND attacl IS NOT NULL)
           FROM pg_class c WHERE c.oid = 'public.otp_challenge'::regclass`,
      ),
      'id:character(26):nn:-,phone_e164:text:nn:-,code_hash:bytea:nn:-,attempts:smallint:nn:0,' +
        'expires_at:timestamp with time zone:nn:-,consumed_at:timestamp with time zone:null:-,' +
        'created_ip_prefix:inet:null:-,created_at:timestamp with time zone:nn:now()' +
        '|app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl}' +
        '|attempts={app_rw=w/app_ddl},consumed_at={app_rw=w/app_ddl}',
    );
  });

  test('the CHECK constraints are exactly attempts, code_hash length and TTL, by these definitions', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'public.otp_challenge'::regclass AND contype = 'c'`,
      ),
      'otp_challenge_attempts_check=CHECK (((attempts >= 0) AND (attempts <= 3))) ; ' +
        'otp_challenge_code_hash_length_check=CHECK ((octet_length(code_hash) = 32)) ; ' +
        "otp_challenge_ttl_check=CHECK (((expires_at > created_at) AND ((expires_at - created_at) <= '00:05:00'::interval)))",
    );
  });
});

describe('0013 — attempts: CHECK (attempts BETWEEN 0 AND 3) (U-O2)', () => {
  test('attempts = 4 on INSERT is REFUSED by otp_challenge_attempts_check (23514)', async () => {
    assertRefusedBy(
      'attempts 4',
      await asSuperuser(insert(SCRATCH, { extra: 'attempts', values: '4' })),
      CHECK_23514('otp_challenge_attempts_check'),
      'CONSTRAINT NAME:  otp_challenge_attempts_check',
    );
  });

  test('attempts 0 -> 4 on UPDATE is REFUSED by otp_challenge_attempts_check (23514)', async () => {
    const r = await asSuperuser(
      readRow(LIVE),
      `UPDATE public.otp_challenge SET attempts = 4 WHERE id = '${LIVE}'`,
    );
    assertRead('attempts 4 by UPDATE', r, 'row 1 attempts=0 consumed=false');
    assertRefusedBy(
      'attempts 4 by UPDATE',
      r,
      CHECK_23514('otp_challenge_attempts_check'),
      'CONSTRAINT NAME:  otp_challenge_attempts_check',
    );
  });

  test('attempts = -1 is REFUSED by otp_challenge_attempts_check (23514)', async () => {
    assertRefusedBy(
      'attempts -1',
      await asSuperuser(insert(SCRATCH, { extra: 'attempts', values: '-1' })),
      CHECK_23514('otp_challenge_attempts_check'),
      'CONSTRAINT NAME:  otp_challenge_attempts_check',
    );
  });

  test('CONTROL — attempts = 3 is accepted', async () => {
    assertPermitted(
      'attempts 3',
      await asSuperuser('BEGIN', insert(SCRATCH, { extra: 'attempts', values: '3' }), 'ROLLBACK'),
    );
  });
});

describe('0013 — the 5-minute TTL: CHECK against created_at (Q-D1)', () => {
  const at = (ts: string): string => `timestamptz '2026-09-26 ${ts}+00'`;
  const ttl = (expires: string): string =>
    insert(SCRATCH, { expires: at(expires), extra: 'created_at', values: at('10:00:00') });

  for (const [label, expires] of [
    ['5 minutes and 1 microsecond after created_at', '10:05:00.000001'],
    ['equal to created_at', '10:00:00'],
    ['before created_at', '09:59:59'],
  ] as const) {
    test(`expires_at ${label} is REFUSED by otp_challenge_ttl_check (23514)`, async () => {
      assertRefusedBy(
        `expires_at ${label}`,
        await asSuperuser(ttl(expires)),
        CHECK_23514('otp_challenge_ttl_check'),
        'CONSTRAINT NAME:  otp_challenge_ttl_check',
      );
    });
  }

  test('an UPDATE moving expires_at past created_at + 5 minutes is REFUSED by otp_challenge_ttl_check (23514)', async () => {
    const r = await asSuperuser(
      readRow(LIVE),
      `UPDATE public.otp_challenge SET expires_at = created_at + interval '6 minutes' WHERE id = '${LIVE}'`,
    );
    assertRead('expires_at extended', r, 'row 1 attempts=0 consumed=false');
    assertRefusedBy(
      'expires_at extended',
      r,
      CHECK_23514('otp_challenge_ttl_check'),
      'CONSTRAINT NAME:  otp_challenge_ttl_check',
    );
  });

  test("CONTROL — exactly 5 minutes, and T-027 O1's now() + interval '5 minutes' with the default created_at, are accepted", async () => {
    assertPermitted(
      'expires_at at the bound, and O1',
      await asSuperuser('BEGIN', ttl('10:05:00'), insert(SCRATCH_2), 'ROLLBACK'),
    );
  });

  test('expires_at has no DEFAULT (U-O4): an INSERT omitting it is REFUSED 23502 naming expires_at', async () => {
    assertRefusedBy(
      'expires_at omitted',
      await asSuperuser(
        `INSERT INTO public.otp_challenge (id, phone_e164, code_hash) VALUES ('${SCRATCH}', '+35799000009', ${H32})`,
      ),
      'ERROR:  23502: null value in column "expires_at" of relation "otp_challenge" violates not-null constraint',
      'COLUMN NAME:  expires_at',
    );
  });
});

describe('0013 — code_hash is 32 bytes: CHECK (octet_length(code_hash) = 32) (Q-D2)', () => {
  for (const n of [0, 31, 33, 64]) {
    test(`a code_hash of ${String(n)} bytes is REFUSED by otp_challenge_code_hash_length_check (23514)`, async () => {
      assertRefusedBy(
        `${String(n)}-byte code_hash`,
        await asSuperuser(insert(SCRATCH, { hash: `decode(repeat('ab', ${String(n)}), 'hex')` })),
        CHECK_23514('otp_challenge_code_hash_length_check'),
        'CONSTRAINT NAME:  otp_challenge_code_hash_length_check',
      );
    });
  }

  test('CONTROL — an HMAC-SHA-256 output (pgcrypto hmac) is accepted (U-O1)', async () => {
    assertPermitted(
      'hmac sha256 code_hash',
      await asSuperuser(
        'BEGIN',
        insert(SCRATCH, { hash: `hmac('123456', 't194-server-secret', 'sha256')` }),
        'ROLLBACK',
      ),
    );
  });
});

describe('0013 — NOT NULL (23502, naming the column)', () => {
  for (const column of [
    'id',
    'phone_e164',
    'code_hash',
    'attempts',
    'expires_at',
    'created_at',
  ] as const) {
    test(`${column} NULL is REFUSED (23502)`, async () => {
      const sql =
        column === 'id'
          ? insert('NULL')
          : column === 'phone_e164'
            ? insert(SCRATCH, { phone: 'NULL' })
            : column === 'code_hash'
              ? insert(SCRATCH, { hash: 'NULL' })
              : column === 'expires_at'
                ? insert(SCRATCH, { expires: 'NULL' })
                : insert(SCRATCH, { extra: column, values: 'NULL' });
      assertRefusedBy(
        `${column} NULL`,
        await asSuperuser(sql),
        `ERROR:  23502: null value in column "${column}" of relation "otp_challenge" violates not-null constraint`,
        `COLUMN NAME:  ${column}`,
      );
    });
  }

  test('CONTROL — consumed_at and created_ip_prefix NULL are accepted', async () => {
    assertPermitted(
      'nullable columns NULL',
      await asSuperuser(
        'BEGIN',
        `INSERT INTO public.otp_challenge (id, phone_e164, code_hash, expires_at, consumed_at, created_ip_prefix)
           VALUES ('${SCRATCH}', '+35799000009', ${H32}, now() + interval '5 minutes', NULL, NULL)`,
        'ROLLBACK',
      ),
    );
  });
});

describe('0013 — single use: trg_otp_challenge_single_use (U-O5, Q-D3), as the app_rw login', () => {
  test("CONTROL — app_rw runs T-027's O1-O4 on a new challenge: insert, lock, two wrong attempts, consume", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      'BEGIN',
      insert(SCRATCH, { phone: `'+35799000008'` }),
      `SELECT id FROM public.otp_challenge WHERE phone_e164 = '+35799000008' AND consumed_at IS NULL
          AND expires_at > now() ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
      `UPDATE public.otp_challenge SET attempts = attempts + 1 WHERE id = '${SCRATCH}'`,
      `UPDATE public.otp_challenge SET attempts = attempts + 1 WHERE id = '${SCRATCH}'`,
      `UPDATE public.otp_challenge SET consumed_at = now() WHERE id = '${SCRATCH}' AND consumed_at IS NULL`,
      readRow(SCRATCH),
      'ROLLBACK',
    );
    assertPermitted('O1-O4', r);
    assertRead('O1-O4', r, 'row 1 attempts=2 consumed=true');
  });

  test('a consumed challenge returning to unconsumed (consumed_at -> NULL) is REFUSED KV060', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(CONSUMED),
      `UPDATE public.otp_challenge SET consumed_at = NULL WHERE id = '${CONSUMED}'`,
    );
    assertRead('consumed_at -> NULL', r, 'row 1 attempts=2 consumed=true');
    assertRefusedBy(
      'consumed_at -> NULL',
      r,
      'ERROR:  KV060: OTP_CHALLENGE_CONSUMED_AT_CLEARED: a consumed otp_challenge row cannot return to unconsumed',
      'CONTEXT:  PL/pgSQL function public.assert_otp_challenge_single_use()',
    );
  });

  test('the same, as the superuser, is REFUSED KV060 (the trigger is not a grant)', async () => {
    const r = await asSuperuser(
      readRow(CONSUMED),
      `UPDATE public.otp_challenge SET consumed_at = NULL WHERE id = '${CONSUMED}'`,
    );
    assertRead('consumed_at -> NULL as superuser', r, 'row 1 attempts=2 consumed=true');
    assertRefusedBy(
      'consumed_at -> NULL as superuser',
      r,
      'ERROR:  KV060: OTP_CHALLENGE_CONSUMED_AT_CLEARED:',
      'CONTEXT:  PL/pgSQL function public.assert_otp_challenge_single_use()',
    );
  });

  test('a consumed challenge given another consumed_at is REFUSED KV061', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(CONSUMED),
      `UPDATE public.otp_challenge SET consumed_at = consumed_at + interval '1 second' WHERE id = '${CONSUMED}'`,
    );
    assertRead('consumed_at rewritten', r, 'row 1 attempts=2 consumed=true');
    assertRefusedBy(
      'consumed_at rewritten',
      r,
      'ERROR:  KV061: OTP_CHALLENGE_CONSUMED_AT_REWRITTEN: a consumed otp_challenge row keeps its consumed_at',
      'CONTEXT:  PL/pgSQL function public.assert_otp_challenge_single_use()',
    );
  });

  test("CONTROL — writing a consumed row's consumed_at to its own value is accepted (no change)", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      'BEGIN',
      readRow(CONSUMED),
      `UPDATE public.otp_challenge SET consumed_at = consumed_at WHERE id = '${CONSUMED}' RETURNING 'updated ' || id`,
      'ROLLBACK',
    );
    assertPermitted('consumed_at unchanged', r);
    assertRead('consumed_at unchanged', r, `updated ${CONSUMED}`);
  });

  for (const [label, set] of [
    ['consuming it', 'consumed_at = now()'],
    ['resetting attempts to 0', 'attempts = 0'],
  ] as const) {
    test(`an exhausted challenge (attempts = 3): ${label} is REFUSED KV062`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readRow(EXHAUSTED),
        `UPDATE public.otp_challenge SET ${set} WHERE id = '${EXHAUSTED}'`,
      );
      assertRead(`exhausted: ${label}`, r, 'row 1 attempts=3 consumed=false');
      assertRefusedBy(
        `exhausted: ${label}`,
        r,
        'ERROR:  KV062: OTP_CHALLENGE_EXHAUSTED: an otp_challenge row at 3 attempts cannot change',
        'CONTEXT:  PL/pgSQL function public.assert_otp_challenge_single_use()',
      );
    });
  }

  test('CONTROL — an exhausted challenge can be locked FOR UPDATE and written with identical values', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      'BEGIN',
      `SELECT attempts FROM public.otp_challenge WHERE id = '${EXHAUSTED}' FOR UPDATE`,
      `UPDATE public.otp_challenge SET attempts = 3 WHERE id = '${EXHAUSTED}' RETURNING 'updated ' || id`,
      'ROLLBACK',
    );
    assertPermitted('exhausted, unchanged', r);
    assertRead('exhausted, unchanged', r, `updated ${EXHAUSTED}`);
  });
});

describe('0013 — OE-60: at most 3 attempts in 5 minutes', () => {
  test('app_rw holds UPDATE on attempts and consumed_at and on no other column', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || '=' || has_column_privilege('app_rw', 'public.otp_challenge', attname, 'UPDATE'),
                           ',' ORDER BY attnum)
           FROM pg_attribute WHERE attrelid = 'public.otp_challenge'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id=false,phone_e164=false,code_hash=false,attempts=true,expires_at=false,consumed_at=true,' +
        'created_ip_prefix=false,created_at=false',
    );
  });

  test('app_rw lowering attempts (2 -> 0) on a live challenge is REFUSED KV063', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(LIVE),
      `UPDATE public.otp_challenge SET attempts = 2 WHERE id = '${LIVE}'`,
      readRow(LIVE),
      `UPDATE public.otp_challenge SET attempts = 0 WHERE id = '${LIVE}'`,
    );
    assertRead('attempts 2 -> 0', r, 'row 1 attempts=2 consumed=false');
    assertRefusedBy(
      'attempts 2 -> 0',
      r,
      'ERROR:  KV063: OTP_CHALLENGE_ATTEMPTS_DECREASED: otp_challenge attempts never decrease',
      'CONTEXT:  PL/pgSQL function public.assert_otp_challenge_single_use()',
    );
  });

  test('app_rw changing attempts on a consumed challenge (2 -> 3) is REFUSED KV064', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(CONSUMED),
      `UPDATE public.otp_challenge SET attempts = 3 WHERE id = '${CONSUMED}'`,
    );
    assertRead('consumed attempts 2 -> 3', r, 'row 1 attempts=2 consumed=true');
    assertRefusedBy(
      'consumed attempts 2 -> 3',
      r,
      'ERROR:  KV064: OTP_CHALLENGE_CONSUMED_ATTEMPTS_FIXED: a consumed otp_challenge row keeps its attempts',
      'CONTEXT:  PL/pgSQL function public.assert_otp_challenge_single_use()',
    );
  });

  for (const [label, set] of [
    [
      'created_at and expires_at pushed forward together',
      "created_at = created_at + interval '1 hour', expires_at = expires_at + interval '1 hour'",
    ],
    ['expires_at moved', "expires_at = expires_at - interval '1 minute'"],
    ['code_hash replaced', `code_hash = decode(repeat('cd', 32), 'hex')`],
    ['phone_e164 replaced', "phone_e164 = '+35799000999'"],
    ['id changed', "id = '01K4T194OTPOTHERID00000001'"],
    ['created_ip_prefix changed', "created_ip_prefix = '198.51.100.0/24'"],
  ] as const) {
    test(`app_rw: ${label} is REFUSED by the column grant (42501)`, async () => {
      const r = await asLogin(
        LOGINS.app_rw,
        readRow(LIVE),
        `UPDATE public.otp_challenge SET ${set} WHERE id = '${LIVE}'`,
      );
      assertRead(`app_rw ${label}`, r, 'row 1 attempts=0 consumed=false');
      assertRefused(`app_rw ${label}`, r, {
        message: 'ERROR:  42501: permission denied for table otp_challenge',
      });
    });
  }

  for (const [label, set] of [
    [
      'created_at and expires_at pushed forward together',
      "created_at = created_at + interval '1 hour', expires_at = expires_at + interval '1 hour'",
    ],
    [
      'created_at moved alone (+1 s, inside the TTL CHECK)',
      "created_at = created_at + interval '1 second'",
    ],
    ['expires_at moved alone', "expires_at = expires_at - interval '1 minute'"],
    ['code_hash replaced', `code_hash = decode(repeat('cd', 32), 'hex')`],
    ['phone_e164 replaced', "phone_e164 = '+35799000999'"],
  ] as const) {
    test(`a writer the grant does not bind (the superuser): ${label} is REFUSED KV065`, async () => {
      const r = await asSuperuser(
        readRow(LIVE),
        `UPDATE public.otp_challenge SET ${set} WHERE id = '${LIVE}'`,
      );
      assertRead(`superuser ${label}`, r, 'row 1 attempts=0 consumed=false');
      assertRefusedBy(
        `superuser ${label}`,
        r,
        'ERROR:  KV065: OTP_CHALLENGE_FIXED_COLUMN: created_at, expires_at, code_hash and phone_e164 are fixed after insert',
        'CONTEXT:  PL/pgSQL function public.assert_otp_challenge_single_use()',
      );
    });
  }

  test('CONTROL — app_rw: an ordinary wrong-code increment (O3) and a consume (O4) still pass', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      readRow(LIVE),
      `UPDATE public.otp_challenge SET attempts = attempts + 1 WHERE id = '${LIVE}' RETURNING 'incremented to ' || attempts`,
      `UPDATE public.otp_challenge SET consumed_at = now() WHERE id = '${LIVE}' AND consumed_at IS NULL RETURNING 'consumed ' || id`,
      readRow(LIVE),
    );
    assertPermitted('O3 then O4', r);
    assertRead('O3 then O4', r, 'incremented to 1');
    assertRead('O3 then O4', r, `consumed ${LIVE}`);
    assertRead('O3 then O4', r, 'row 1 attempts=1 consumed=true');
  });

  test("CONTROL — app_rw writing a consumed row's attempts to its own value is accepted (no change)", async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      `UPDATE public.otp_challenge SET attempts = attempts WHERE id = '${CONSUMED}' RETURNING 'updated ' || id`,
    );
    assertPermitted('consumed attempts unchanged', r);
    assertRead('consumed attempts unchanged', r, `updated ${CONSUMED}`);
  });
});

describe('0013 — grants (U-O6; T-020 § contract §3), over real single-membership logins', () => {
  test('CONTROL — app_rw SELECTs, INSERTs and UPDATEs attempts on otp_challenge', async () => {
    const r = await asLogin(
      LOGINS.app_rw,
      'BEGIN',
      insert(SCRATCH),
      `UPDATE public.otp_challenge SET attempts = 1 WHERE id = '${SCRATCH}'`,
      readRow(SCRATCH),
      'ROLLBACK',
    );
    assertPermitted('app_rw SELECT/INSERT/UPDATE', r);
    assertRead('app_rw SELECT/INSERT/UPDATE', r, 'row 1 attempts=1 consumed=false');
  });

  for (const [what, sql] of [
    ['DELETE', `DELETE FROM public.otp_challenge WHERE id = '${LIVE}'`],
    ['TRUNCATE', 'TRUNCATE public.otp_challenge'],
  ] as const) {
    test(`app_rw ${what} is REFUSED (42501)`, async () => {
      assertRefused(`app_rw ${what}`, await asLogin(LOGINS.app_rw, sql), {
        message: 'ERROR:  42501: permission denied for table otp_challenge',
      });
    });
  }

  for (const role of ['app_admin_rw', 'app_safety_rw', 'answering_service'] as const) {
    test(`${role} SELECT is REFUSED (42501)`, async () => {
      assertRefused(
        `${role} SELECT`,
        await asLogin(LOGINS[role], 'SELECT count(*) FROM public.otp_challenge'),
        {
          message: 'ERROR:  42501: permission denied for table otp_challenge',
        },
      );
    });
  }

  test('the rows survive every refusal above: three fixture rows, LIVE still unconsumed at 0 attempts', async () => {
    assert.equal(
      await db.value(
        `SELECT count(*) || '|' || (SELECT attempts || ':' || (consumed_at IS NULL) FROM public.otp_challenge WHERE id = '${LIVE}')
           FROM public.otp_challenge`,
      ),
      '3|0:true',
    );
  });
});

describe('0013 — the SA §INT-10 guard', () => {
  test('GRANT SELECT ON otp_challenge TO answering_service is REFUSED by the guard (KV010) and lands nothing', async () => {
    const r = await asSuperuser('GRANT SELECT ON public.otp_challenge TO answering_service');
    assertRefused('grant SELECT to the vendor', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(
      r.output.includes('answering_service holds SELECT on public.otp_challenge'),
      `the guard's DETAIL does not name otp_challenge.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.otp_challenge', 'SELECT')::text`,
      ),
      'false',
    );
  });

  test('after up the guard, called DIRECTLY, returns clean', async () => {
    assertPermitted(
      'direct guard call',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  test('the same direct call raises on a known-bad state (a detective-only grant, rolled back)', async () => {
    const r = await asSuperuser(
      'BEGIN',
      'GRANT TEMPORARY ON DATABASE kinvara TO answering_service',
      'SELECT kinvara_guard.assert_answering_service_write_only()',
    );
    assertRefused('guard on a known-bad state', r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
    assert.ok(r.output.includes('answering_service holds TEMPORARY on database kinvara'), r.output);
    assert.equal(
      await db.value(
        `SELECT has_database_privilege('answering_service', 'kinvara', 'TEMPORARY')::text`,
      ),
      'false',
    );
  });
});
