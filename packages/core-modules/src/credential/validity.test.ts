/**
 * The validity models (T-061), table-driven per model, without a database.
 *
 * EXPECTED DATES ARE NOT COMPUTED HERE OR BY THE CODE UNDER TEST. Every month-arithmetic expectation
 * is a literal printed by PostgreSQL 18.6's `date + make_interval(months => n)` on the ticket's own
 * database (`app/.cache/T-061/anchors.sql` → `anchors-pg.txt`, state/EP-5/T-061.md § Evidence E1).
 * The host's `date` (uutils coreutils 0.10.0) disagrees on the leap day — it prints `2029-03-01` for
 * `2028-02-29 +12 months` — and the database is the anchor because the I-1 derivation and any SQL
 * reconciler compute in it (E1). The model names and the "present, unreferenced" value are written
 * from SA §DA-4r 1254–1258 / SD 2083–2088, not imported.
 */
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { InvalidInputError, toProblem } from '@kinvara/domain-types';
import {
  MandatoryRulesUnreadableError,
  VALIDITY_MODELS,
  VALIDITY_NOT_COMPUTED,
  VALIDITY_SCHEME_UNUSABLE,
  validityDatesForDecision,
  ValidityNotComputedError,
  ValiditySchemeUnusableError,
  type ValidityScheme,
} from './index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const problem = (e: unknown) => toProblem(e, 'https://errors.kinvara.test/');
const V1 = { v: 1, mandatory: 'all_tiers' };
const NONE = {
  expiresOn: null,
  expiryProvenance: null,
  nextRecertificationDueAt: null,
  lastAttestationAt: null,
  nextAttestationDueAt: null,
};

/** The fields of the White seed row that this computation reads (T-251 § Published contract §2). */
function scheme(over: Partial<Record<keyof ValidityScheme, unknown>> = {}): ValidityScheme {
  return {
    validityModel: 'point_in_time_annual_reissue',
    defaultValidityMonths: 12,
    mandatoryRules: { ...V1 },
    ...over,
  } as ValidityScheme;
}

function facts(issuedOn: unknown, documentExpiresOn: unknown = null) {
  return { issuedOn, documentExpiresOn } as { issuedOn: string; documentExpiresOn: string | null };
}

const savedTz = process.env['TZ'];
afterEach(() => {
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
});

// ── point_in_time_annual_reissue ─────────────────────────────────────────────────────────────────

/** [issued_on, months, PostgreSQL's issued_on + months] — each row copied from anchors-pg.txt. */
const ANNUAL: ReadonlyArray<readonly [string, number, string]> = [
  ['2026-10-14', 12, '2027-10-14'],
  ['2028-02-29', 12, '2029-02-28'],
  ['2027-02-28', 12, '2028-02-28'],
  ['2024-02-29', 12, '2025-02-28'],
  ['2028-02-29', 48, '2032-02-29'],
  ['2026-01-31', 1, '2026-02-28'],
  ['2028-01-31', 1, '2028-02-29'],
  ['2026-08-31', 6, '2027-02-28'],
  ['2027-08-31', 6, '2028-02-29'],
  ['2026-12-31', 12, '2027-12-31'],
  ['2026-12-31', 2, '2027-02-28'],
  ['2026-03-31', 1, '2026-04-30'],
  ['2026-10-25', 12, '2027-10-25'],
  ['2026-03-29', 12, '2027-03-29'],
  ['1999-12-31', 12, '2000-12-31'],
  ['2026-11-30', 3, '2027-02-28'],
  ['2026-05-31', 24, '2028-05-31'],
  ['2026-07-14', 3, '2026-10-14'],
  ['9998-12-31', 12, '9999-12-31'],
  ['2026-01-01', 1200, '2126-01-01'],
];

test('point_in_time_annual_reissue: next_recertification_due_at is issued_on + default_validity_months, as PostgreSQL computes it (20 rows)', () => {
  for (const [issuedOn, months, expected] of ANNUAL) {
    const got = validityDatesForDecision(
      scheme({ defaultValidityMonths: months }),
      facts(issuedOn),
    );
    assert.deepEqual(
      got,
      { ...NONE, nextRecertificationDueAt: expected },
      `${issuedOn} + ${months}`,
    );
  }
});

test('point_in_time_annual_reissue: the leap day clamps to 28 February, never rolls into March (2028-02-29 + 12 → 2029-02-28)', () => {
  const got = validityDatesForDecision(scheme(), facts('2028-02-29'));
  assert.equal(got.nextRecertificationDueAt, '2029-02-28');
  assert.notEqual(got.nextRecertificationDueAt, '2029-03-01');
});

test('point_in_time_annual_reissue: only next_recertification_due_at is set; expires_on, its provenance and both attestation columns are NULL', () => {
  const got = validityDatesForDecision(scheme(), facts('2026-10-14'));
  assert.deepEqual(Object.keys(got).sort(), [
    'expiresOn',
    'expiryProvenance',
    'lastAttestationAt',
    'nextAttestationDueAt',
    'nextRecertificationDueAt',
  ]);
  assert.equal(got.expiresOn, null);
  assert.equal(got.expiryProvenance, null);
  assert.equal(got.lastAttestationAt, null);
  assert.equal(got.nextAttestationDueAt, null);
});

test('point_in_time_annual_reissue: the month count is the scheme parameter, not a constant 12', () => {
  assert.equal(
    validityDatesForDecision(scheme({ defaultValidityMonths: 6 }), facts('2026-10-14'))
      .nextRecertificationDueAt,
    '2027-04-14',
  );
  assert.equal(
    validityDatesForDecision(scheme({ defaultValidityMonths: 24 }), facts('2026-05-31'))
      .nextRecertificationDueAt,
    '2028-05-31',
  );
});

test('point_in_time_annual_reissue: a document expiry is not read by this model', () => {
  for (const stated of ['2027-01-01', 'garbage', 42, undefined]) {
    const got = validityDatesForDecision(scheme(), facts('2026-10-14', stated));
    assert.deepEqual(got, { ...NONE, nextRecertificationDueAt: '2027-10-14' });
  }
});

test('point_in_time_annual_reissue: a default_validity_months that is not a positive integer refuses the scheme, naming the field only', () => {
  for (const months of [null, undefined, 0, -12, 1.5, '12', Number.NaN, Infinity, 2 ** 53]) {
    assert.throws(
      () =>
        validityDatesForDecision(scheme({ defaultValidityMonths: months }), facts('2026-10-14')),
      (e: unknown) =>
        e instanceof ValiditySchemeUnusableError &&
        e.message === VALIDITY_SCHEME_UNUSABLE &&
        JSON.stringify(e.fields) === '["defaultValidityMonths"]',
      String(months),
    );
  }
});

test('point_in_time_annual_reissue: a due date past 9999-12-31 refuses the scheme rather than printing a five-digit year', () => {
  assert.throws(
    () => validityDatesForDecision(scheme(), facts('9999-06-01')),
    (e: unknown) => e instanceof ValiditySchemeUnusableError,
  );
});

test('point_in_time_annual_reissue: an issued_on that is not a real YYYY-MM-DD is InvalidInputError (400, field issuedOn) and the value is not echoed', () => {
  const bad = [
    null,
    undefined,
    '',
    '2026-02-29',
    '2026-02-30',
    '2027-02-29',
    '2100-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-1-01',
    '26-10-14',
    '2026-10-14T00:00:00Z',
    ' 2026-10-14',
    '2026-10-14\n',
    '0000-01-01',
    '２０２６-10-14',
    20261014,
    new Date('2026-10-14'),
  ];
  for (const value of bad) {
    let caught: unknown;
    try {
      validityDatesForDecision(scheme(), facts(value));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof InvalidInputError, String(value));
    const body = problem(caught);
    assert.equal(body.status, 400);
    assert.match(JSON.stringify(body), /issuedOn/);
    if (typeof value === 'string' && value.length > 0) {
      assert.ok(!JSON.stringify(body).includes(value.trim()), `echoed ${value}`);
      assert.ok(!caught.message.includes(value.trim()), `echoed ${value}`);
    }
  }
});

test('point_in_time_annual_reissue: 2000-02-29 is a real date and 2100-02-29 is not (400-year rule); the result is the same under any host TZ', () => {
  assert.equal(
    validityDatesForDecision(scheme(), facts('2000-02-29')).nextRecertificationDueAt,
    '2001-02-28',
  );
  assert.throws(() => validityDatesForDecision(scheme(), facts('2100-02-29')), InvalidInputError);
  for (const tz of ['UTC', 'Europe/Nicosia', 'Pacific/Kiritimati', 'America/Adak']) {
    process.env['TZ'] = tz;
    for (const [issuedOn, months, expected] of ANNUAL) {
      assert.equal(
        validityDatesForDecision(scheme({ defaultValidityMonths: months }), facts(issuedOn))
          .nextRecertificationDueAt,
        expected,
        `${tz} ${issuedOn}`,
      );
    }
  }
});

// ── expiring ────────────────────────────────────────────────────────────────────────────────────

test('expiring: expires_on is the expiry the document states, with expiry_provenance from_document; nothing else is set', () => {
  const rows: ReadonlyArray<readonly [string | null, string]> = [
    ['2023-05-01', '2026-05-01'],
    [null, '2029-02-28'],
    ['2026-10-14', '2026-10-14'],
  ];
  for (const [issuedOn, stated] of rows) {
    const got = validityDatesForDecision(
      scheme({ validityModel: 'expiring', defaultValidityMonths: 36 }),
      facts(issuedOn, stated),
    );
    assert.deepEqual(got, { ...NONE, expiresOn: stated, expiryProvenance: 'from_document' });
  }
});

test('expiring: with no stated expiry it refuses (InvalidInputError, field documentExpiresOn) and never invents a platform default (OD-347)', () => {
  for (const months of [36, null]) {
    for (const stated of [null, undefined, '', '2026-02-29', '2026-10-14T00:00:00Z']) {
      assert.throws(
        () =>
          validityDatesForDecision(
            scheme({ validityModel: 'expiring', defaultValidityMonths: months }),
            facts('2026-10-14', stated),
          ),
        (e: unknown) =>
          e instanceof InvalidInputError &&
          JSON.stringify(problem(e)).includes('documentExpiresOn'),
        `${months} ${String(stated)}`,
      );
    }
  }
});

test('expiring: the issue date and default_validity_months are not read by this model', () => {
  for (const [issuedOn, months] of [
    ['garbage', 'x'],
    [undefined, -1],
  ] as const) {
    const got = validityDatesForDecision(
      scheme({ validityModel: 'expiring', defaultValidityMonths: months }),
      facts(issuedOn, '2030-01-31'),
    );
    assert.deepEqual(got, { ...NONE, expiresOn: '2030-01-31', expiryProvenance: 'from_document' });
  }
});

// ── point_in_time ───────────────────────────────────────────────────────────────────────────────

test('point_in_time: every date column is NULL, whatever the facts and parameters', () => {
  for (const [issuedOn, stated, months] of [
    ['2026-10-14', null, null],
    ['garbage', 'garbage', 'x'],
    [null, '2027-01-01', 12],
  ] as const) {
    const got = validityDatesForDecision(
      scheme({ validityModel: 'point_in_time', defaultValidityMonths: months }),
      facts(issuedOn, stated),
    );
    assert.deepEqual(got, NONE);
  }
});

// ── periodic_attestation (OD-346) ───────────────────────────────────────────────────────────────

test('periodic_attestation: not computed here (OD-346) — ValidityNotComputedError naming the model, fixed text, no date', () => {
  let caught: unknown;
  try {
    validityDatesForDecision(
      scheme({ validityModel: 'periodic_attestation', defaultValidityMonths: null }),
      facts('2026-10-14', null),
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ValidityNotComputedError);
  assert.equal(caught.validityModel, 'periodic_attestation');
  assert.equal(caught.message, VALIDITY_NOT_COMPUTED);
  assert.equal(problem(caught).status, 500);
});

// ── the retained, unused model (SA §DA-4r 1283, SA B3) ──────────────────────────────────────────

test('continuously_monitored is present in VALIDITY_MODELS and a scheme carrying it is refused, not given dates', () => {
  assert.ok((VALIDITY_MODELS as readonly string[]).includes('continuously_monitored'));
  let caught: unknown;
  try {
    validityDatesForDecision(
      scheme({ validityModel: 'continuously_monitored' }),
      facts('2026-10-14', '2027-10-14'),
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ValidityNotComputedError);
  assert.equal(caught.validityModel, 'continuously_monitored');
});

test('continuously_monitored is unreferenced: validity.ts never names it, and no credential source file but scheme.ts carries it as a string literal', () => {
  const sources = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.ok(sources.includes('validity.ts') && sources.includes('scheme.ts'), sources.join(','));
  const holders: string[] = [];
  for (const file of sources) {
    const text = readFileSync(join(HERE, file), 'utf8');
    const literals = text.match(/['"]continuously_monitored['"]/g) ?? [];
    if (literals.length > 0) holders.push(`${file}:${literals.length}`);
    if (file === 'validity.ts') {
      assert.equal(text.includes('continuously_monitored'), false, 'validity.ts names it');
      assert.equal(/continuously|monitored/i.test(text), false, 'validity.ts names part of it');
    }
  }
  assert.deepEqual(holders, ['scheme.ts:1']);
});

test('every one of the five models is answered: three with dates, two refused with ValidityNotComputedError', () => {
  const answered: Record<string, string> = {};
  for (const model of VALIDITY_MODELS) {
    try {
      validityDatesForDecision(scheme({ validityModel: model }), facts('2026-10-14', '2027-10-14'));
      answered[model] = 'dates';
    } catch (e) {
      answered[model] = e instanceof ValidityNotComputedError ? 'not_computed' : String(e);
    }
  }
  assert.deepEqual(answered, {
    point_in_time_annual_reissue: 'dates',
    periodic_attestation: 'not_computed',
    expiring: 'dates',
    point_in_time: 'dates',
    continuously_monitored: 'not_computed',
  });
});

// ── the scheme is read failing closed (CUT-T-060 R-3) ───────────────────────────────────────────

test('a mandatory_rules value outside v1 is MandatoryRulesUnreadableError for every model, before any date is computed', () => {
  const badRules = [
    {},
    null,
    undefined,
    'all_tiers',
    { v: 1 },
    { v: 1, mandatory: 'none' },
    { v: 1, mandatory: 'optional' },
    { v: 2, mandatory: 'all_tiers' },
    { v: '1', mandatory: 'all_tiers' },
    { v: 1, mandatory: 'all_tiers', tier: 'x' },
  ];
  for (const model of VALIDITY_MODELS) {
    for (const rules of badRules) {
      assert.throws(
        () =>
          validityDatesForDecision(
            scheme({ validityModel: model, mandatoryRules: rules }),
            facts('2026-10-14', '2027-10-14'),
          ),
        MandatoryRulesUnreadableError,
        `${model} ${JSON.stringify(rules)}`,
      );
    }
  }
});

test('a validity_model outside the five refuses the scheme (ValiditySchemeUnusableError, field validityModel)', () => {
  for (const model of [
    'monitored',
    'POINT_IN_TIME',
    'point_in_time ',
    '',
    null,
    undefined,
    'toString',
    '__proto__',
    'hasOwnProperty',
  ]) {
    assert.throws(
      () => validityDatesForDecision(scheme({ validityModel: model }), facts('2026-10-14')),
      (e: unknown) =>
        e instanceof ValiditySchemeUnusableError &&
        JSON.stringify(e.fields) === '["validityModel"]',
      String(model),
    );
  }
});

test('the scheme is read once per field: a getter that changes its answer cannot pass the check and then compute from another value', () => {
  let reads = 0;
  const tricky = {
    get validityModel() {
      reads += 1;
      return reads === 1 ? 'point_in_time_annual_reissue' : 'monitored';
    },
    defaultValidityMonths: 12,
    mandatoryRules: { ...V1 },
  } as unknown as ValidityScheme;
  const got = validityDatesForDecision(tricky, facts('2026-10-14'));
  assert.equal(reads, 1);
  assert.equal(got.nextRecertificationDueAt, '2027-10-14');
});

test('the result is frozen', () => {
  for (const s of [
    scheme(),
    scheme({ validityModel: 'expiring' }),
    scheme({ validityModel: 'point_in_time' }),
  ]) {
    const got = validityDatesForDecision(s, facts('2026-10-14', '2027-10-14'));
    assert.ok(Object.isFrozen(got));
  }
});

test('the computation writes nothing: validity.ts imports no database, repository or runtime code', () => {
  const text = readFileSync(join(HERE, 'validity.ts'), 'utf8');
  const imports = [...text.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./scheme.ts', '@kinvara/domain-types']);
});
