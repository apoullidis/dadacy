/**
 * T-255's gate: the `sitter_credential` repository against real Postgres (`0026`, T-252's RLS and
 * grants). `scripts/svc up <ticket> db`, `scripts/svc run <ticket> -- pnpm db:migrate up`, then
 * `scripts/svc run <ticket> -- pnpm --filter @kinvara/core-modules test:integration`.
 *
 * PRINCIPALS. The repository's calls run as `app_rw` through `Database.withActor` (T-254). The
 * superuser pool (`DATABASE_URL`'s login, the bootstrap superuser, OD-116; it bypasses RLS) writes the
 * fixtures and reads EXPECTED values with plain SQL, so the repository is compared with the table,
 * not with itself.
 *
 * REFUSALS FROM THE DATABASE. Where the gate asks that a refusal come from the database, the case
 * sends the statement the repository builds (`../src/credential/queries.ts`, package-internal) on a
 * sitter's `withActor` transaction, so RLS (not the repository's own state check) is what answers:
 * another sitter's row reads and updates 0 rows; a sitter's write to `valid` is `42501`.
 *
 * FIXTURES. Every run makes fresh sitters (random ULIDs), so the file re-runs on the same database.
 * A private test jurisdiction `XT` holds one scheme with a non-NULL `reference_format_regex`, written
 * and re-written here and never read by any other file (`credential-scheme.spec.ts` reads `CY` and
 * the unseeded `GR` only), because the CY seed's regexes are NULL and other files run in parallel.
 * The EXPLAIN cases need volume: 3000 sitters × 2 CY schemes (ids prefixed `01T255V…`), inserted once
 * with ON CONFLICT DO NOTHING, then `ANALYZE`.
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import pg from 'pg';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import {
  dueForAttestation,
  dueForExpiry,
  dueForRecertification,
  ensureOnboardingCredentials,
  listOwnCredentials,
  ReferenceNumberOutOfBoundsError,
  ReferenceNumberRefusedError,
  ReferencePatternUnusableError,
  SitterCredentialRefusedError,
  sitterActor,
  submitCertificate,
  SweepActorRefusedError,
  type SitterActor,
} from '@kinvara/core-modules/credential';
import {
  bindSystemActor,
  Database,
  type SystemActorDatabase,
  type Tx,
} from '@kinvara/core-modules/runtime';
import {
  NotFoundError,
  StateTransitionInvalidError,
  InvalidInputError,
} from '@kinvara/domain-types';
import { newSitterCredentialId } from '../src/credential/ids.ts';
import {
  q2SelectById,
  q2SelectBySitter,
  q4Update,
  q5Due,
  type SweepKind,
} from '../src/credential/queries.ts';
import { mapRefusal } from '../src/credential/repository.ts';

const ART22 = 'Certificate under Art. 22(6), Law 91(I)/2014';
const WHITE = 'White Criminal Record Certificate';
const XT_SCHEME = 'T-255 test scheme (XT, twelve digits)';
const CANARY = 'CANARY-T255-INTEG-61873';
const AS_OF = '2026-01-20';
const AS_OF_INSTANT = new Date('2026-01-20T00:00:00Z');

function databaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (value === undefined || value === '') {
    throw new TypeError(
      'DATABASE_URL is not set: run under `scripts/svc run <ticket> --` on a project with `db` up',
    );
  }
  return value;
}

let su: Pool;
let db: Database;
let sweeper: SystemActorDatabase;
let white: number;
let art22: number;
let xt: number;
const log: string[] = [];
const logLine = (l: string): void => {
  log.push(l);
};

/** A fresh sitter: account + sitter_profile, by the superuser. */
async function newSitter(): Promise<string> {
  const id = newSitterCredentialId();
  await su.query(
    `INSERT INTO public.account (id, pseudonym, tos_version) VALUES ($1, $2, 't255')`,
    [id, newSitterCredentialId()],
  );
  await su.query(`INSERT INTO public.sitter_profile (id) VALUES ($1)`, [id]);
  return id;
}

/** Every column of one row as the superuser reads it, dates and instants as text. */
async function rawRow(id: string): Promise<Record<string, unknown> | undefined> {
  return (
    await su.query(
      `SELECT id, sitter_id, scheme_id, status, reference_number, issued_on::text AS issued_on,
              expires_on::text AS expires_on, expiry_provenance,
              next_recertification_due_at::text AS next_recertification_due_at,
              last_attestation_at::text AS last_attestation_at,
              next_attestation_due_at::text AS next_attestation_due_at,
              attestation_template_version, attestation_locale, decision, decided_by,
              decided_at::text AS decided_at, decision_reason_code, provider, provider_ref,
              created_at::text AS created_at
         FROM public.sitter_credential WHERE id = $1`,
      [id],
    )
  ).rows[0];
}

async function rowsOf(sitterId: string): Promise<Record<string, unknown>[]> {
  const ids = (
    await su.query<{ id: string }>(
      `SELECT id FROM public.sitter_credential WHERE sitter_id = $1 ORDER BY scheme_id`,
      [sitterId],
    )
  ).rows;
  const out: Record<string, unknown>[] = [];
  for (const { id } of ids) {
    const r = await rawRow(id);
    if (r !== undefined) out.push(r);
  }
  return out;
}

async function rowId(sitterId: string, schemeId: number): Promise<string> {
  const r = await su.query<{ id: string }>(
    `SELECT id FROM public.sitter_credential WHERE sitter_id = $1 AND scheme_id = $2`,
    [sitterId, schemeId],
  );
  const id = r.rows[0]?.id;
  assert.ok(id !== undefined, 'fixture row missing');
  return id;
}

/** A sitter with both CY rows, onboarded through the repository. */
async function onboardedSitter(): Promise<{ id: string; actor: SitterActor }> {
  const id = await newSitter();
  const actor = sitterActor(id);
  const r = await ensureOnboardingCredentials(db, actor, 'CY');
  assert.equal(r.inserted, 2);
  return { id, actor };
}

/** Run `statement` on a sitter's own withActor transaction; return the rows, or the error. */
async function asSitter(
  actor: SitterActor,
  statement: ReturnType<typeof q2SelectById>,
): Promise<{ rows: Record<string, unknown>[] } | { error: unknown }> {
  try {
    return {
      rows: await db.withActor(actor, async (tx: Tx) => (await tx.execute(statement)).rows),
    };
  } catch (error) {
    return { error };
  }
}

/** Every text an error exposes. */
function exposed(e: unknown): string {
  const parts: string[] = [String(e), inspect(e, { depth: 5 })];
  if (e instanceof Error) {
    parts.push(e.message, String(e.stack), String(e.cause));
    for (const k of Object.getOwnPropertyNames(e)) {
      parts.push(k, String((e as unknown as Record<string, unknown>)[k]));
    }
    parts.push(JSON.stringify(e));
  }
  return parts.join('|');
}

/** Capture everything written to stdout and stderr while `work` runs. */
async function capturingStdio<T>(work: () => Promise<T>): Promise<{ out: string; result: T }> {
  const chunks: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const grab = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  try {
    const result = await work();
    return { out: chunks.join(''), result };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

async function setXtRegex(pattern: string | null): Promise<void> {
  await su.query(`UPDATE public.credential_scheme SET reference_format_regex = $1 WHERE id = $2`, [
    pattern,
    xt,
  ]);
  const back = await su.query<{ r: string | null }>(
    `SELECT reference_format_regex AS r FROM public.credential_scheme WHERE id = $1`,
    [xt],
  );
  assert.equal(back.rows[0]?.r, pattern, 'the XT plant did not land');
}

beforeAll(async () => {
  su = new pg.Pool({ connectionString: databaseUrl(), application_name: 'kinvara-t255-test' });
  db = new Database(
    { connectionString: databaseUrl(), application_name: 'kinvara-t255-test' },
    logLine,
  );
  sweeper = bindSystemActor(db, 'credential.sweep_test');
  const schemes = await su.query<{ id: number; scheme_name: string }>(
    `SELECT id, scheme_name FROM public.credential_scheme WHERE jurisdiction = 'CY'`,
  );
  const byName = new Map(schemes.rows.map((r) => [r.scheme_name, r.id]));
  white = byName.get(WHITE) ?? 0;
  art22 = byName.get(ART22) ?? 0;
  assert.ok(white > 0 && art22 > 0, 'the CY seed is missing');
  const x = await su.query<{ id: number }>(
    `INSERT INTO public.credential_scheme
       (jurisdiction, check_type, scheme_name, scheme_name_i18n, issuing_body, validity_model,
        reference_format_regex, mandatory_rules)
     SELECT 'XT', check_type, $1, scheme_name_i18n, issuing_body, validity_model, '^[0-9]{12}$',
            mandatory_rules
       FROM public.credential_scheme WHERE id = $2
     ON CONFLICT (jurisdiction, scheme_name) DO UPDATE SET reference_format_regex = '^[0-9]{12}$'
     RETURNING id`,
    [XT_SCHEME, white],
  );
  xt = x.rows[0]?.id ?? 0;
  assert.ok(xt > 0);
  // Volume for the EXPLAIN cases: 3000 sitters, both CY schemes, 10% valid, due dates spread.
  await su.query(
    `INSERT INTO public.account (id, pseudonym, tos_version)
     SELECT '01T255V' || lpad(g::text, 19, '0'), '01T255P' || lpad(g::text, 19, '0'), 't255'
       FROM generate_series(1, 3000) g ON CONFLICT DO NOTHING`,
  );
  await su.query(
    `INSERT INTO public.sitter_profile (id)
     SELECT '01T255V' || lpad(g::text, 19, '0') FROM generate_series(1, 3000) g ON CONFLICT DO NOTHING`,
  );
  await su.query(
    `INSERT INTO public.sitter_credential
       (id, sitter_id, scheme_id, status, next_recertification_due_at, next_attestation_due_at, expires_on)
     SELECT '01T255C' || lpad(s.id::text, 2, '0') || lpad(g::text, 17, '0'),
            '01T255V' || lpad(g::text, 19, '0'), s.id,
            CASE WHEN g % 10 = 0 THEN 'valid' ELSE 'not_started' END,
            date '2026-01-01' + (g % 3650),
            timestamptz '2026-01-01 00:00Z' + make_interval(days => g % 3650),
            CASE WHEN g % 20 = 0 THEN NULL ELSE date '2026-01-01' + (g % 3650) END
       FROM generate_series(1, 3000) g CROSS JOIN (VALUES ($1::int), ($2::int)) AS s(id)
     ON CONFLICT DO NOTHING`,
    [white, art22],
  );
  await su.query(`ANALYZE public.sitter_credential`);
}, 120_000);

afterAll(async () => {
  await db.onApplicationShutdown();
  await su.end();
});

// ── Q-3 ────────────────────────────────────────────────────────────────────────────────────────

test('Q-3 as a sitter inserts one not_started row per CY scheme with server-generated ULIDs; a second call inserts 0 and changes nothing (ON CONFLICT DO NOTHING is idempotent)', async () => {
  const id = await newSitter();
  const actor = sitterActor(id);
  const first = await ensureOnboardingCredentials(db, actor, 'CY');
  assert.equal(first.inserted, 2);
  const before = await rowsOf(id);
  assert.deepEqual(
    before.map((r) => [r['scheme_id'], r['status'], r['sitter_id']]),
    [
      [Math.min(white, art22), 'not_started', id],
      [Math.max(white, art22), 'not_started', id],
    ],
  );
  for (const r of before) assert.match(String(r['id']), /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.deepEqual(
    first.credentials.map((c) => c.id),
    before.map((r) => r['id']),
  );
  const second = await ensureOnboardingCredentials(db, actor, 'CY');
  assert.equal(second.inserted, 0);
  assert.deepEqual(await rowsOf(id), before, 'the second call changed a row');
  assert.deepEqual(
    second.credentials.map((c) => c.id),
    before.map((r) => r['id']),
  );
});

// ── Q-2 ────────────────────────────────────────────────────────────────────────────────────────

test("Q-2 as a sitter returns exactly their own rows, all twenty columns equal to the superuser's plain read", async () => {
  const a = await onboardedSitter();
  await onboardedSitter();
  const issued = '2026-03-04';
  await submitCertificate(
    db,
    a.actor,
    {
      credentialId: await rowId(a.id, white),
      jurisdiction: 'CY',
      referenceNumber: 'ΑΒΓ-123',
      issuedOn: issued,
    },
    logLine,
  );
  const mine = await listOwnCredentials(db, a.actor);
  const raw = await rowsOf(a.id);
  assert.equal(mine.length, 2);
  assert.ok(Object.isFrozen(mine) && mine.every((c) => Object.isFrozen(c)));
  for (const [i, c] of mine.entries()) {
    const r = raw[i] ?? {};
    assert.equal(c.sitterId, a.id);
    assert.deepEqual(
      [
        c.id,
        c.sitterId,
        c.schemeId,
        c.status,
        c.referenceNumber,
        c.issuedOn,
        c.expiresOn,
        c.expiryProvenance,
        c.nextRecertificationDueAt,
        c.attestationTemplateVersion,
        c.attestationLocale,
        c.decision,
        c.decidedBy,
        c.decisionReasonCode,
        c.provider,
        c.providerRef,
      ],
      [
        r['id'],
        r['sitter_id'],
        r['scheme_id'],
        r['status'],
        r['reference_number'],
        r['issued_on'],
        r['expires_on'],
        r['expiry_provenance'],
        r['next_recertification_due_at'],
        r['attestation_template_version'],
        r['attestation_locale'],
        r['decision'],
        r['decided_by'],
        r['decision_reason_code'],
        r['provider'],
        r['provider_ref'],
      ],
    );
    // Instants: the same moment (the superuser's text is in the session zone).
    for (const [mineAt, rawAt] of [
      [c.createdAt, r['created_at']],
      [c.lastAttestationAt, r['last_attestation_at']],
      [c.nextAttestationDueAt, r['next_attestation_due_at']],
      [c.decidedAt, r['decided_at']],
    ] as const) {
      if (rawAt === null) assert.equal(mineAt, null);
      else assert.equal(Date.parse(String(mineAt)), Date.parse(String(rawAt)));
    }
  }
  const w = mine.find((c) => c.schemeId === white);
  assert.equal(w?.referenceNumber, 'ΑΒΓ-123');
  assert.equal(w?.issuedOn, issued);
  assert.equal(w?.status, 'submitted');
});

test("a sitter reading another sitter's rows gets 0 rows from the database (Q-2 by sitter_id and by id, sent as sitter A for sitter B)", async () => {
  const a = await onboardedSitter();
  const b = await onboardedSitter();
  const bRow = await rowId(b.id, white);
  const bySitter = await asSitter(a.actor, q2SelectBySitter(b.id));
  const byId = await asSitter(a.actor, q2SelectById(bRow));
  assert.ok('rows' in bySitter && 'rows' in byId);
  assert.equal(bySitter.rows.length, 0);
  assert.equal(byId.rows.length, 0);
  // CONTROLS: B's rows exist (superuser), and B reads them through the same statements.
  assert.equal((await rowsOf(b.id)).length, 2);
  const own = await asSitter(b.actor, q2SelectBySitter(b.id));
  assert.ok('rows' in own);
  assert.equal(own.rows.length, 2);
  assert.equal(
    (await listOwnCredentials(db, a.actor)).every((c) => c.sitterId === a.id),
    true,
  );
});

// ── Q-4 ────────────────────────────────────────────────────────────────────────────────────────

test("a sitter updating another sitter's row gets 0 rows from the database, and the row is unchanged; through the repository it is NotFoundError", async () => {
  const a = await onboardedSitter();
  const b = await onboardedSitter();
  const bRow = await rowId(b.id, white);
  const before = await rawRow(bRow);
  const r = await asSitter(
    a.actor,
    q4Update({
      id: bRow,
      fromStatus: 'not_started',
      toStatus: 'submitted',
      referenceNumber: CANARY,
      issuedOn: null,
    }),
  );
  assert.ok('rows' in r, `the update errored: ${'error' in r ? String(r.error) : ''}`);
  assert.equal(r.rows.length, 0);
  assert.deepEqual(await rawRow(bRow), before);
  await assert.rejects(
    submitCertificate(
      db,
      a.actor,
      { credentialId: bRow, jurisdiction: 'CY', referenceNumber: CANARY, issuedOn: null },
      logLine,
    ),
    NotFoundError,
  );
  assert.deepEqual(await rawRow(bRow), before);
  // CONTROL: the same statement as B on B's row updates 1.
  const own = await asSitter(
    b.actor,
    q4Update({
      id: bRow,
      fromStatus: 'not_started',
      toStatus: 'submitted',
      referenceNumber: '0',
      issuedOn: null,
    }),
  );
  assert.ok('rows' in own);
  assert.equal(own.rows.length, 1);
});

test("a sitter's write to valid is refused by the database (42501), mapped by SQLSTATE with no detail, parameters or cause, and the row is unchanged", async () => {
  const a = await onboardedSitter();
  const row = await rowId(a.id, white);
  const before = await rawRow(row);
  const r = await asSitter(
    a.actor,
    q4Update({
      id: row,
      fromStatus: 'not_started',
      toStatus: 'valid',
      referenceNumber: CANARY,
      issuedOn: null,
    }),
  );
  assert.ok('error' in r, 'the database accepted a sitter write to valid');
  const pgError = (r.error as { cause?: { code?: string; message?: string } }).cause;
  assert.equal(pgError?.code, '42501');
  assert.match(
    String(pgError?.message),
    /new row violates row-level security policy for table "sitter_credential"/,
  );
  assert.throws(
    () => mapRefusal(r.error),
    (e: unknown) => {
      assert.ok(e instanceof SitterCredentialRefusedError);
      assert.equal(e.sqlstate, '42501');
      assert.equal(e.constraint, undefined);
      assert.equal(e.cause, undefined);
      assert.ok(!exposed(e).includes(CANARY), 'a parameter reached the mapped error');
      return true;
    },
  );
  assert.ok(
    exposed(r.error).includes(CANARY),
    "CONTROL: drizzle's own error does carry the parameter",
  );
  assert.deepEqual(await rawRow(row), before);
});

test('Q-4 moves not_started to submitted, writing the validator referenceNumber unchanged (0, Greek, 20 digits; both schemes) and issued_on', async () => {
  for (const [ref, scheme] of [
    ['0', white],
    ['ΑΒΓ-123', art22],
    ['12345678901234567890', white],
    ['   ', art22],
  ] as const) {
    const a = await onboardedSitter();
    const row = await rowId(a.id, scheme);
    const out = await submitCertificate(
      db,
      a.actor,
      { credentialId: row, jurisdiction: 'CY', referenceNumber: ref, issuedOn: '2025-12-31' },
      logLine,
    );
    assert.deepEqual(out, { status: 'submitted', credentialId: row });
    const r = await rawRow(row);
    assert.equal(r?.['status'], 'submitted');
    assert.equal(r?.['reference_number'], ref);
    assert.equal(r?.['issued_on'], '2025-12-31');
    assert.equal(r?.['expires_on'], null);
    assert.equal(r?.['next_recertification_due_at'], null);
  }
});

test('Q-4 refuses submitted, in_review, valid, expired, failed and withdrawn with StateTransitionInvalidError (the edges OE-88 grants are T-267s), and writes nothing', async () => {
  const a = await onboardedSitter();
  const row = await rowId(a.id, white);
  for (const status of ['submitted', 'in_review', 'valid', 'expired', 'failed', 'withdrawn']) {
    await su.query(`UPDATE public.sitter_credential SET status = $1 WHERE id = $2`, [status, row]);
    const before = await rawRow(row);
    assert.equal(before?.['status'], status);
    await assert.rejects(
      submitCertificate(
        db,
        a.actor,
        { credentialId: row, jurisdiction: 'CY', referenceNumber: CANARY, issuedOn: '2026-01-01' },
        logLine,
      ),
      StateTransitionInvalidError,
      status,
    );
    assert.deepEqual(await rawRow(row), before, status);
  }
});

test('OE-88: a sitter submitting against their own review_hold row is refused StateTransitionInvalidError (409) and the row, all twenty columns, is byte-identical; there is no write as system on their behalf', async () => {
  const a = await onboardedSitter();
  const row = await rowId(a.id, art22);
  // Every column the database lets carry a value populated (sixteen; `decision`,
  // `decision_reason_code`, `provider`, `provider_ref` are NULL-only by S-1's CHECKs), so a write
  // to any of them shows.
  await su.query(
    `UPDATE public.sitter_credential SET status = 'review_hold', reference_number = 'OLD-1',
            issued_on = '2025-01-01', expires_on = '2026-01-01', expiry_provenance = 'from_document',
            next_recertification_due_at = '2026-06-01', last_attestation_at = '2025-10-01T00:00Z',
            next_attestation_due_at = '2026-01-01T00:00Z', attestation_template_version = 'v1',
            attestation_locale = 'el', decided_by = $2, decided_at = '2025-11-01T00:00Z'
      WHERE id = $1`,
    [row, newSitterCredentialId()],
  );
  const before = await rawRow(row);
  assert.equal(before?.['status'], 'review_hold');
  assert.equal(
    Object.values(before ?? {}).filter((v) => v === null).length,
    4,
    'only the four NULL-only columns are NULL',
  );
  for (const issuedOn of ['2026-02-02', null]) {
    await assert.rejects(
      submitCertificate(
        db,
        a.actor,
        { credentialId: row, jurisdiction: 'CY', referenceNumber: CANARY, issuedOn },
        logLine,
      ),
      (e: unknown) => {
        assert.ok(e instanceof StateTransitionInvalidError, String(e));
        assert.equal(e.status, 409);
        assert.ok(!exposed(e).includes(CANARY));
        return true;
      },
    );
    assert.deepEqual(await rawRow(row), before, `issuedOn=${String(issuedOn)}`);
  }
  assert.ok(!log.join('\n').includes(CANARY), 'the refused reference reached the log');
  // CONTROL (OD-326): the database too refuses the sitter's own update of a held row (0 rows).
  const direct = await asSitter(
    a.actor,
    q4Update({
      id: row,
      fromStatus: 'review_hold',
      toStatus: 'submitted',
      referenceNumber: 'X',
      issuedOn: null,
    }),
  );
  assert.ok('rows' in direct);
  assert.equal(direct.rows.length, 0, 'OD-326: the sitter policy does not update a held row');
  assert.deepEqual(await rawRow(row), before);
});

test('Q-4 compare-and-set: a not_started row moved to submitted by another transaction between the sitter read and the sitter write lands 0 rows, StateTransitionInvalidError, and nothing is written', async () => {
  const a = await onboardedSitter();
  const row = await rowId(a.id, white);
  const locker = await su.connect();
  let committed: Record<string, unknown> | undefined;
  try {
    await locker.query('BEGIN');
    await locker.query(
      `UPDATE public.sitter_credential SET status = 'submitted', reference_number = 'FIRST',
              issued_on = '2025-05-05' WHERE id = $1`,
      [row],
    );
    // The sitter's read sees the committed `not_started` (not blocked); its UPDATE then waits on
    // the row lock the uncommitted write holds: the read and the write are interleaved for certain.
    const pending = submitCertificate(
      db,
      a.actor,
      { credentialId: row, jurisdiction: 'CY', referenceNumber: 'SECOND', issuedOn: '2026-03-03' },
      logLine,
    ).then(
      (v) => ({ ok: v as unknown }),
      (e: unknown) => ({ err: e }),
    );
    let waiting = 0;
    for (let i = 0; i < 200 && waiting === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
      waiting =
        (
          await su.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND application_name = 'kinvara-t255-test'
              AND query LIKE 'UPDATE public.sitter_credential%'`,
          )
        ).rows[0]?.n ?? 0;
    }
    console.log(`MEASURED Q-4 compare-and-set blocked-sitter-writers=${String(waiting)}`);
    assert.equal(waiting, 1, 'the sitter write never blocked on the other transaction');
    await locker.query('COMMIT');
    committed = await rawRow(row);
    const out = await pending;
    assert.ok(
      'err' in out && out.err instanceof StateTransitionInvalidError,
      `outcome: ${inspect(out)}`,
    );
  } finally {
    locker.release();
  }
  assert.equal(committed?.['reference_number'], 'FIRST');
  assert.deepEqual(await rawRow(row), committed, 'the sitter write landed over the other');
});

test('Q-4 under concurrency (adopted QA-A1): eight concurrent submissions on one not_started row, exactly one is submitted, the rest StateTransitionInvalidError, the stored reference is the winner', async () => {
  const a = await onboardedSitter();
  const row = await rowId(a.id, white);
  const refs = Array.from({ length: 8 }, (_, i) => `REF-${String(i)}`);
  const settled = await Promise.allSettled(
    refs.map((r) =>
      submitCertificate(
        db,
        a.actor,
        { credentialId: row, jurisdiction: 'CY', referenceNumber: r, issuedOn: null },
        logLine,
      ),
    ),
  );
  const won = settled.flatMap((x, i) => (x.status === 'fulfilled' ? [refs[i]] : []));
  const lost = settled.flatMap((x) => (x.status === 'rejected' ? [x.reason as unknown] : []));
  console.log(
    `MEASURED Q-4 concurrent fulfilled=${String(won.length)} rejected=${String(lost.length)}`,
  );
  assert.equal(won.length, 1);
  for (const l of lost) assert.ok(l instanceof StateTransitionInvalidError, String(l));
  const r = await rawRow(row);
  assert.equal(r?.['status'], 'submitted');
  assert.equal(r?.['reference_number'], won[0]);
});

test('Q-3 under concurrency (adopted QA-A2): eight concurrent onboardings of one sitter raise no error, leave two rows, and their inserted counts sum to two', async () => {
  const id = await newSitter();
  const actor = sitterActor(id);
  const settled = await Promise.allSettled(
    Array.from({ length: 8 }, () => ensureOnboardingCredentials(db, actor, 'CY')),
  );
  const rejected = settled.flatMap((x) => (x.status === 'rejected' ? [String(x.reason)] : []));
  assert.deepEqual(rejected, []);
  const sum = settled.reduce((n, x) => n + (x.status === 'fulfilled' ? x.value.inserted : 0), 0);
  assert.equal(sum, 2);
  assert.equal((await rowsOf(id)).length, 2);
});

test('the reference bound is counted in characters (adopted QA-A7): 64 Greek letters and 64 ASCII accepted, 65 Greek and a U+0085 refused ReferenceNumberOutOfBoundsError with no echo, nothing written', async () => {
  for (const [ref, accept] of [
    ['Α'.repeat(64), true],
    ['Α'.repeat(65), false],
    [`${CANARY}\u0085`, false],
    ['x'.repeat(64), true],
  ] as const) {
    const a = await onboardedSitter();
    const row = await rowId(a.id, white);
    const before = await rawRow(row);
    const res = await submitCertificate(
      db,
      a.actor,
      { credentialId: row, jurisdiction: 'CY', referenceNumber: ref, issuedOn: null },
      logLine,
    ).catch((x: unknown) => x);
    if (accept) {
      assert.deepEqual(res, { status: 'submitted', credentialId: row });
      assert.equal((await rawRow(row))?.['reference_number'], ref);
    } else {
      assert.ok(
        res instanceof ReferenceNumberOutOfBoundsError,
        `${String(ref.length)}: ${String(res)}`,
      );
      assert.ok(!exposed(res).includes(CANARY));
      assert.deepEqual(await rawRow(row), before);
    }
  }
});

test('a real 23503 through the repository (adopted QA-A8): onboarding an account with no sitter_profile maps to SitterCredentialRefusedError with the constraint name, no cause, the id not echoed', async () => {
  const id = newSitterCredentialId();
  await su.query(
    `INSERT INTO public.account (id, pseudonym, tos_version) VALUES ($1, $2, 't255')`,
    [id, newSitterCredentialId()],
  );
  const e = await ensureOnboardingCredentials(db, sitterActor(id), 'CY').catch((x: unknown) => x);
  assert.ok(e instanceof SitterCredentialRefusedError, String(e));
  assert.equal(e.sqlstate, '23503');
  assert.equal(e.constraint, 'sitter_credential_sitter_id_fkey');
  assert.equal(e.cause, undefined);
  assert.ok(!exposed(e).includes(id), 'the sitter id reached the mapped error');
});

test('a reference over the database bound is refused 23514 sitter_credential_reference_number_bounds as ReferenceNumberOutOfBoundsError; the canary is absent from the error, the log and stdio; nothing is written', async () => {
  for (const ref of [`${CANARY}${'x'.repeat(64)}`, `${CANARY}\t1`, '']) {
    const a = await onboardedSitter();
    const row = await rowId(a.id, white);
    const before = await rawRow(row);
    log.length = 0;
    const { out, result } = await capturingStdio(async () => {
      try {
        await submitCertificate(
          db,
          a.actor,
          { credentialId: row, jurisdiction: 'CY', referenceNumber: ref, issuedOn: null },
          logLine,
        );
        return undefined;
      } catch (e) {
        return e;
      }
    });
    assert.ok(result instanceof ReferenceNumberOutOfBoundsError, `not mapped: ${String(result)}`);
    assert.equal(result.field, 'referenceNumber');
    assert.equal(result.status, 400);
    if (ref !== '') {
      assert.ok(!exposed(result).includes(CANARY), 'the reference reached the error');
      assert.ok(!out.includes(CANARY), 'the reference reached stdio');
      assert.ok(!log.join('\n').includes(CANARY), 'the reference reached the log');
    }
    assert.deepEqual(await rawRow(row), before);
  }
});

test('the scheme is read inside the write transaction (not a cache): a non-NULL regex refuses with ReferenceNumberRefusedError unchanged, a matching reference is written, and a changed regex applies on the next call', async () => {
  await setXtRegex('^[0-9]{12}$');
  const id = await newSitter();
  const actor = sitterActor(id);
  const onboard = await ensureOnboardingCredentials(db, actor, 'XT');
  assert.equal(onboard.inserted, 1);
  const row = await rowId(id, xt);
  log.length = 0;
  await assert.rejects(
    submitCertificate(
      db,
      actor,
      { credentialId: row, jurisdiction: 'XT', referenceNumber: CANARY, issuedOn: null },
      logLine,
    ),
    (e: unknown) => {
      assert.ok(e instanceof ReferenceNumberRefusedError);
      assert.equal(e.reason, 'format_mismatch');
      assert.equal(e.schemeId, xt);
      assert.ok(!exposed(e).includes(CANARY));
      return true;
    },
  );
  assert.deepEqual(log, [
    `credential: reference refused scheme_id=${String(xt)} reason=format_mismatch`,
  ]);
  assert.equal((await rawRow(row))?.['status'], 'not_started');
  // The row's scheme is not a CY scheme: the jurisdiction is refused, nothing written.
  await assert.rejects(
    submitCertificate(
      db,
      actor,
      { credentialId: row, jurisdiction: 'CY', referenceNumber: '123456789012', issuedOn: null },
      logLine,
    ),
    (e: unknown) => e instanceof InvalidInputError && e.field === 'jurisdiction',
  );
  // The pattern changes (committed); the very next call applies it.
  await setXtRegex('^[A-Z]{3}$');
  await assert.rejects(
    submitCertificate(
      db,
      actor,
      { credentialId: row, jurisdiction: 'XT', referenceNumber: '123456789012', issuedOn: null },
      logLine,
    ),
    ReferenceNumberRefusedError,
  );
  await setXtRegex('[[:digit:]]{8}');
  await assert.rejects(
    submitCertificate(
      db,
      actor,
      { credentialId: row, jurisdiction: 'XT', referenceNumber: '12345678', issuedOn: null },
      logLine,
    ),
    ReferencePatternUnusableError,
  );
  await setXtRegex('^[0-9]{12}$');
  const ok = await submitCertificate(
    db,
    actor,
    { credentialId: row, jurisdiction: 'XT', referenceNumber: '123456789012', issuedOn: null },
    logLine,
  );
  assert.equal(ok.status, 'submitted');
  assert.equal((await rawRow(row))?.['reference_number'], '123456789012');
});

// ── Q-5 ────────────────────────────────────────────────────────────────────────────────────────

/** Superuser count of due rows across the whole table: the sweep must return this many. */
async function allDue(kind: SweepKind): Promise<string[]> {
  const column = {
    recertification: 'next_recertification_due_at',
    attestation: 'next_attestation_due_at',
    expiry: 'expires_on',
  }[kind];
  const asOf = kind === 'attestation' ? AS_OF_INSTANT.toISOString() : AS_OF;
  return (
    await su.query<{ id: string }>(
      `SELECT id FROM public.sitter_credential WHERE status = 'valid' AND ${column} <= $1 ORDER BY id`,
      [asOf],
    )
  ).rows.map((r) => r.id);
}

test('Q-5 as system sees every due row: each sweep returns every valid row due at asOf across all sitters, and none that is not valid or not due', async () => {
  const d = await onboardedSitter();
  const e = await onboardedSitter();
  const dW = await rowId(d.id, white);
  const dA = await rowId(d.id, art22);
  const eW = await rowId(e.id, white);
  const eA = await rowId(e.id, art22);
  const set = async (
    id: string,
    status: string,
    recert: string | null,
    attest: string | null,
    expires: string | null,
  ) =>
    su.query(
      `UPDATE public.sitter_credential SET status = $2, next_recertification_due_at = $3,
              next_attestation_due_at = $4, expires_on = $5 WHERE id = $1`,
      [id, status, recert, attest, expires],
    );
  await set(dW, 'valid', '2025-06-01', '2025-06-01T00:00:00Z', '2025-06-01');
  await set(dA, 'valid', '2099-01-01', '2099-01-01T00:00:00Z', null);
  await set(eW, 'expired', '2025-06-01', '2025-06-01T00:00:00Z', '2025-06-01');
  await set(eA, 'valid', null, '2026-01-19T23:59:59Z', '2099-01-01');
  const fixture = new Set([dW, dA, eW, eA]);
  const expected: Record<SweepKind, string[]> = {
    recertification: [dW],
    attestation: [dW, eA].sort(),
    expiry: [dW],
  };
  const got: Record<SweepKind, readonly string[]> = {
    recertification: await dueForRecertification(sweeper, AS_OF),
    attestation: await dueForAttestation(sweeper, AS_OF_INSTANT),
    expiry: await dueForExpiry(sweeper, AS_OF),
  };
  for (const kind of ['recertification', 'attestation', 'expiry'] as const) {
    assert.deepEqual(
      got[kind].filter((id) => fixture.has(id)),
      expected[kind],
      kind,
    );
    const total = await allDue(kind);
    assert.deepEqual([...got[kind]], total, `${kind}: the sweep does not see every due row`);
    assert.ok(
      total.length > expected[kind].length,
      `${kind}: the volume fixture contributes due rows of other sitters`,
    );
    console.log(
      `MEASURED Q-5 ${kind} asOf=${kind === 'attestation' ? AS_OF_INSTANT.toISOString() : AS_OF}: sweep=${String(got[kind].length)} superuser=${String(total.length)} fixture=${String(expected[kind].length)}`,
    );
  }
  // Boundary: a row due exactly at asOf is due (<=).
  await set(dA, 'valid', AS_OF, AS_OF_INSTANT.toISOString(), AS_OF);
  assert.ok((await dueForRecertification(sweeper, AS_OF)).includes(dA));
  assert.ok((await dueForAttestation(sweeper, AS_OF_INSTANT)).includes(dA));
  assert.ok((await dueForExpiry(sweeper, AS_OF)).includes(dA));
});

test('a Q-5 sweep whose transaction is not a system actor (actorless, a sitter, a sitter under break-glass) is refused SweepActorRefusedError, never answered with the 0 rows RLS gives it', async () => {
  const a = await onboardedSitter();
  const actorless = {
    actor: bindSystemActor(db, 'credential.sweep_test').actor,
    withActor: <T>(work: (tx: Tx) => Promise<T>) => db.withAppRw(work),
  } as unknown as SystemActorDatabase;
  const asPerson = {
    actor: bindSystemActor(db, 'credential.sweep_test').actor,
    withActor: <T>(work: (tx: Tx) => Promise<T>) => db.withActor(a.actor, work),
  } as unknown as SystemActorDatabase;
  // Adopted QA-A9: a sitter's break-glass transaction is not a system actor either.
  const breakGlassSitter = {
    actor: bindSystemActor(db, 'credential.sweep_test').actor,
    withActor: <T>(work: (tx: Tx) => Promise<T>) =>
      db.withActor(a.actor, work, { breakGlass: true }),
  } as unknown as SystemActorDatabase;
  for (const forged of [actorless, asPerson, breakGlassSitter]) {
    await assert.rejects(dueForRecertification(forged, AS_OF), SweepActorRefusedError);
    await assert.rejects(dueForAttestation(forged, AS_OF_INSTANT), SweepActorRefusedError);
    await assert.rejects(dueForExpiry(forged, AS_OF), SweepActorRefusedError);
  }
  // CONTROL: the same Q-5 statement under no actor really does read 0 rows (what the check prevents).
  const silent = await db.withAppRw(
    async (tx) => (await tx.execute(q5Due('recertification', AS_OF))).rows,
  );
  assert.equal(silent.length, 0);
  assert.ok((await allDue('recertification')).length > 0);
});

const INDEX: Record<SweepKind, string> = {
  recertification: 'idx_sitter_credential_recert_due',
  attestation: 'idx_sitter_credential_attestation_due',
  expiry: 'idx_sitter_credential_expires',
};

test('each Q-5 sweep is served by its partial index: EXPLAIN of the repository statement, as the system actor, names the index (plans printed)', async () => {
  for (const kind of ['recertification', 'attestation', 'expiry'] as const) {
    const asOf = kind === 'attestation' ? AS_OF_INSTANT.toISOString() : AS_OF;
    const plan = await sweeper.withActor(async (tx) =>
      (await tx.execute<{ 'QUERY PLAN': string }>(sql`EXPLAIN ${q5Due(kind, asOf)}`)).rows.map(
        (r) => r['QUERY PLAN'],
      ),
    );
    console.log(`EXPLAIN Q-5 ${kind} (as system, asOf=${asOf}):\n  ${plan.join('\n  ')}`);
    const scan = plan.find((l) => l.includes(INDEX[kind]));
    assert.ok(scan !== undefined, `${kind}: the plan does not use ${INDEX[kind]}`);
    assert.match(scan, /Index (Only )?Scan using|Bitmap Index Scan on/);
    assert.ok(
      !plan.some((l) => /Seq Scan on sitter_credential/.test(l)),
      `${kind}: a sequential scan`,
    );
  }
});
