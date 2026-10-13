/**
 * T-060's gate, against `T-251`'s seeded schema (`0024`): `scripts/svc up <ticket> db`, then
 * `scripts/svc run <ticket> -- pnpm db:migrate up`, then
 * `scripts/svc run <ticket> -- pnpm --filter @kinvara/core-modules test:integration`.
 *
 * Every read under test runs as `app_rw` inside `Database.withAppRw` (`SET LOCAL ROLE app_rw`).
 *
 * PLANTS. Two properties cannot be shown on the seed as it stands, because the seed is NULL-regex
 * and the database refuses every `mandatory_rules` value but v1 (`T-251` §3). Each is therefore
 * PLANTED INSIDE A TEST TRANSACTION and rolled back: in the case's own `withAppRw`, `RESET ROLE`
 * returns the session to the `svc run` login (the bootstrap superuser, OD-116), the plant is
 * written (an `UPDATE` of `reference_format_regex`; for `mandatory_rules`, `ALTER TABLE … DROP
 * CONSTRAINT credential_scheme_mandatory_rules_v1` and then an `UPDATE`), the plant is READ BACK and
 * asserted landed, `SET LOCAL ROLE app_rw` restores the read's principal (asserted), Q-1 runs on the
 * same transaction, and the case throws `Rollback`. A superuser read on another connection then
 * asserts the seed and the constraint are as before.
 *
 * EXPECTED VALUES are read from the database by the superuser pool with plain SQL, never through
 * `parseSchemeRow`, so the parse is compared with the rows, not with itself (PROTOCOL §5.1).
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import {
  CredentialSchemeCache,
  CredentialSchemeReadError,
  readCredentialSchemes,
  REFERENCE_REFUSED_LOG,
  ReferenceNumberRefusedError,
  ReferencePatternUnusableError,
  schemeDisplayName,
  validateReference,
  type CredentialScheme,
} from '@kinvara/core-modules/credential';
import { Database, type Tx } from '@kinvara/core-modules/runtime';

const ART22 = 'Certificate under Art. 22(6), Law 91(I)/2014';
const WHITE = 'White Criminal Record Certificate';
const CANARY = 'CANARY-T060-INTEG-90417';
const PLANTED = '^[0-9]{12}$';

class Rollback extends Error {}

function databaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (value === undefined || value === '') {
    throw new TypeError(
      'DATABASE_URL is not set: run under `scripts/svc run <ticket> --` on a project with `db` up',
    );
  }
  return value;
}

let pool: Pool;
let db: Database;
const dbLog: string[] = [];

beforeAll(() => {
  pool = new pg.Pool({ connectionString: databaseUrl(), application_name: 'kinvara-t060-test' });
  db = new Database(
    { connectionString: databaseUrl(), application_name: 'kinvara-t060-test' },
    (l) => dbLog.push(l),
  );
});

afterAll(async () => {
  await db.onApplicationShutdown();
  await pool.end();
});

interface RawRow {
  id: number;
  check_type: string;
  scheme_name: string;
  scheme_name_i18n: Record<string, unknown>;
  issuing_body: string;
  validity_model: string;
  default_validity_months: number | null;
  max_age_at_submission_months: number | null;
  attestation_interval_days: number | null;
  attestation_grace_days: number | null;
  reference_format_regex: string | null;
  mandatory_rules: unknown;
}

/** The CY rows as the superuser sees them, by plain SQL. */
async function rawCy(): Promise<RawRow[]> {
  return (
    await pool.query<RawRow>(
      `SELECT * FROM public.credential_scheme WHERE jurisdiction = 'CY' ORDER BY id`,
    )
  ).rows;
}

function named(schemes: readonly CredentialScheme[], name: string): CredentialScheme {
  const s = schemes.find((x) => x.schemeName === name);
  assert.ok(s !== undefined, `no scheme named ${name}`);
  return s;
}

async function currentUser(tx: Tx): Promise<string> {
  const r = await tx.execute<{ u: string }>(sql`SELECT current_user::text AS u`);
  return r.rows[0]?.u ?? '';
}

/** Run `work` in a withAppRw transaction that is always rolled back. */
async function inRolledBackTx(work: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(
    db.withAppRw(async (tx) => {
      await work(tx);
      throw new Rollback();
    }),
    Rollback,
  );
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

/** Every text an error exposes. */
function exposed(e: unknown): string {
  const parts: string[] = [String(e)];
  if (e instanceof Error) {
    parts.push(e.message, String(e.stack), JSON.stringify(e));
    for (const k of Object.getOwnPropertyNames(e)) {
      parts.push(k, String((e as unknown as Record<string, unknown>)[k]));
    }
  }
  return parts.join('|');
}

test('Q-1 as app_rw reads both CY schemes, each equal to the row the superuser reads', async () => {
  const raw = await rawCy();
  assert.equal(raw.length, 2);
  const schemes = await db.withAppRw(async (tx) => {
    assert.equal(await currentUser(tx), 'app_rw');
    return readCredentialSchemes(tx, 'CY');
  });
  assert.equal(schemes.length, 2);
  assert.ok(Object.isFrozen(schemes));
  for (const r of raw) {
    const s = named(schemes, r.scheme_name);
    assert.deepEqual(
      {
        id: s.id,
        checkType: s.checkType,
        schemeNameI18n: s.schemeNameI18n,
        issuingBody: s.issuingBody,
        validityModel: s.validityModel,
        defaultValidityMonths: s.defaultValidityMonths,
        maxAgeAtSubmissionMonths: s.maxAgeAtSubmissionMonths,
        attestationIntervalDays: s.attestationIntervalDays,
        attestationGraceDays: s.attestationGraceDays,
        referenceFormatRegex: s.referenceFormatRegex,
        mandatoryRules: s.mandatoryRules,
      },
      {
        id: r.id,
        checkType: r.check_type,
        schemeNameI18n: r.scheme_name_i18n,
        issuingBody: r.issuing_body,
        validityModel: r.validity_model,
        defaultValidityMonths: r.default_validity_months,
        maxAgeAtSubmissionMonths: r.max_age_at_submission_months,
        attestationIntervalDays: r.attestation_interval_days,
        attestationGraceDays: r.attestation_grace_days,
        referenceFormatRegex: r.reference_format_regex,
        mandatoryRules: r.mandatory_rules,
      },
    );
  }
  // the two schemes T-251 §2 seeds, looked up by name, never by a literal id (R-4)
  assert.equal(named(schemes, ART22).checkType, 'child_protection_register');
  assert.equal(named(schemes, WHITE).checkType, 'criminal_record');
  for (const s of schemes) {
    assert.equal(s.validityModel, 'point_in_time_annual_reissue');
    assert.equal(s.referenceFormatRegex, null);
    assert.deepEqual(s.mandatoryRules, { v: 1, mandatory: 'all_tiers' });
  }
});

test('the cache over the Database serves the same frozen array inside 60 s and reads again after', async () => {
  let t = 5_000_000;
  const lines: string[] = [];
  const cache = new CredentialSchemeCache(db, (l) => lines.push(l), { now: () => t });
  const a = await cache.forJurisdiction('CY');
  assert.equal(a.length, 2);
  t += 59_999;
  assert.equal(await cache.forJurisdiction('CY'), a);
  t += 1;
  const b = await cache.forJurisdiction('CY');
  assert.notEqual(b, a);
  assert.deepEqual(
    b.map((s) => s.schemeName),
    a.map((s) => s.schemeName),
  );
  assert.equal((await cache.byId('CY', named(b, WHITE).id))?.schemeName, WHITE);
  assert.deepEqual(lines, []);
});

test('a NULL regex records 0, a Greek reference and a 20-digit string verbatim on both seeded schemes', async () => {
  const schemes = await db.withAppRw((tx) => readCredentialSchemes(tx, 'CY'));
  const lines: string[] = [];
  for (const s of [named(schemes, ART22), named(schemes, WHITE)]) {
    assert.equal(s.referenceFormatRegex, null);
    for (const ref of ['0', 'ΑΒΓ-123', '12345678901234567890']) {
      const out = validateReference(s, ref, (l) => lines.push(l));
      assert.deepEqual(out, { status: 'recorded_verbatim', referenceNumber: ref });
    }
  }
  assert.deepEqual(lines, []);
});

test('with a non-NULL regex planted in a test transaction, a non-matching reference is refused and the canary is absent from the error and the captured log', async () => {
  const lines: string[] = [];
  const dbLogBefore = dbLog.length;
  let refused: unknown;
  const { out } = await capturingStdio(() =>
    inRolledBackTx(async (tx) => {
      await tx.execute(sql`RESET ROLE`);
      await tx.execute(
        sql`UPDATE public.credential_scheme SET reference_format_regex = ${PLANTED}
             WHERE jurisdiction = 'CY' AND scheme_name = ${WHITE}`,
      );
      await tx.execute(sql`SET LOCAL ROLE app_rw`);
      assert.equal(await currentUser(tx), 'app_rw');
      const schemes = await readCredentialSchemes(tx, 'CY');
      const white = named(schemes, WHITE);
      // the plant landed, read back through Q-1 itself
      assert.equal(white.referenceFormatRegex, PLANTED);
      assert.equal(named(schemes, ART22).referenceFormatRegex, null);
      // a matching reference passes under the planted pattern
      assert.equal(
        validateReference(white, '123456789012', (l) => lines.push(l)).status,
        'format_matched',
      );
      try {
        validateReference(white, CANARY, (l) => lines.push(l));
      } catch (e) {
        refused = e;
      }
      // the other scheme, still NULL, records the canary verbatim (the check is per scheme)
      assert.equal(
        validateReference(named(schemes, ART22), CANARY, (l) => lines.push(l)).status,
        'recorded_verbatim',
      );
    }),
  );
  assert.ok(refused instanceof ReferenceNumberRefusedError);
  assert.equal(refused.reason, 'format_mismatch');
  assert.equal(refused.field, 'referenceNumber');
  const whiteId = (await rawCy()).find((r) => r.scheme_name === WHITE)?.id;
  // the refusal WAS logged, so the absence below is not the absence of a log
  assert.deepEqual(lines, [
    `${REFERENCE_REFUSED_LOG} scheme_id=${String(whiteId)} reason=format_mismatch`,
  ]);
  const captured = [lines.join('\n'), dbLog.slice(dbLogBefore).join('\n'), out].join('\n');
  assert.ok(!exposed(refused).includes(CANARY), 'canary in the error');
  assert.ok(!captured.includes(CANARY), 'canary in the captured log');
  // rolled back: the seed is NULL again
  for (const r of await rawCy()) assert.equal(r.reference_format_regex, null);
});

test('an uncompilable pattern planted on a real row fails closed: the reference is refused, not validated', async () => {
  const lines: string[] = [];
  let refused: unknown;
  await inRolledBackTx(async (tx) => {
    await tx.execute(sql`RESET ROLE`);
    // PostgreSQL ARE: it does not compile as ECMAScript with u
    await tx.execute(
      sql`UPDATE public.credential_scheme SET reference_format_regex = '^[[:digit:]]{8}$'
           WHERE jurisdiction = 'CY' AND scheme_name = ${WHITE}`,
    );
    await tx.execute(sql`SET LOCAL ROLE app_rw`);
    const white = named(await readCredentialSchemes(tx, 'CY'), WHITE);
    assert.equal(white.referenceFormatRegex, '^[[:digit:]]{8}$');
    for (const ref of [CANARY, '12345678']) {
      try {
        validateReference(white, ref, (l) => lines.push(l));
        assert.fail('an uncompilable pattern must not validate anything');
      } catch (e) {
        refused = e;
        assert.ok(e instanceof ReferencePatternUnusableError);
      }
    }
  });
  assert.ok(refused instanceof ReferencePatternUnusableError);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.endsWith('reason=pattern_uncompilable')));
  assert.ok(!lines.join('\n').includes(CANARY));
  assert.ok(!exposed(refused).includes(CANARY));
  for (const r of await rawCy()) assert.equal(r.reference_format_regex, null);
});

test('a mandatory_rules value outside v1, planted with its CHECK dropped in a test transaction, is an error, not optional', async () => {
  for (const planted of [
    '{}',
    '{"v": 1, "mandatory": "none"}',
    '{"v": 2, "mandatory": "all_tiers"}',
    'null',
  ]) {
    const lines: string[] = [];
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`RESET ROLE`);
      await tx.execute(
        sql`ALTER TABLE public.credential_scheme DROP CONSTRAINT credential_scheme_mandatory_rules_v1`,
      );
      await tx.execute(
        sql`UPDATE public.credential_scheme SET mandatory_rules = ${planted}::jsonb
             WHERE jurisdiction = 'CY' AND scheme_name = ${WHITE}`,
      );
      const landed = await tx.execute<{ ok: boolean }>(
        sql`SELECT mandatory_rules = ${planted}::jsonb AS ok FROM public.credential_scheme
             WHERE jurisdiction = 'CY' AND scheme_name = ${WHITE}`,
      );
      assert.equal(landed.rows[0]?.ok, true, `plant ${planted} landed`);
      await tx.execute(sql`SET LOCAL ROLE app_rw`);
      assert.equal(await currentUser(tx), 'app_rw');
      await assert.rejects(
        readCredentialSchemes(tx, 'CY'),
        (e: unknown) =>
          e instanceof CredentialSchemeReadError &&
          JSON.stringify(e.fields) === '["mandatory_rules"]',
      );
      // and through the cache, over a loader on this transaction: refused, logged, not cached
      const cache = new CredentialSchemeCache(
        (j) => readCredentialSchemes(tx, j),
        (l) => lines.push(l),
      );
      await assert.rejects(cache.forJurisdiction('CY'), CredentialSchemeReadError);
    });
    assert.deepEqual(
      lines,
      ['credential: credential_scheme read refused jurisdiction=CY fields=mandatory_rules'],
      planted,
    );
  }
  // rolled back: the constraint and the v1 values are back
  const c = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'credential_scheme_mandatory_rules_v1'`,
  );
  assert.equal(c.rows.length, 1);
  for (const r of await rawCy())
    assert.deepEqual(r.mandatory_rules, { v: 1, mandatory: 'all_tiers' });
});

test('an unknown jurisdiction reads as an empty list, and a malformed one is refused before any query', async () => {
  const empty = await db.withAppRw((tx) => readCredentialSchemes(tx, 'GR'));
  assert.deepEqual(empty, []);
  await assert.rejects(
    db.withAppRw((tx) => readCredentialSchemes(tx, "CY' OR '1'='1")),
    TypeError,
  );
});

test('on both seeded schemes, en and el are present and ru is answered missing', async () => {
  const schemes = await db.withAppRw((tx) => readCredentialSchemes(tx, 'CY'));
  const raw = await rawCy();
  for (const s of schemes) {
    const r = raw.find((x) => x.id === s.id);
    for (const locale of ['en', 'el']) {
      assert.deepEqual(schemeDisplayName(s, locale), {
        status: 'present',
        locale,
        text: r?.scheme_name_i18n[locale],
      });
    }
    assert.deepEqual(schemeDisplayName(s, 'ru'), { status: 'missing', locale: 'ru' });
    assert.ok(!('ru' in (r?.scheme_name_i18n ?? {})));
  }
});
