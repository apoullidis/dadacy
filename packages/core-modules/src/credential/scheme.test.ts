/**
 * The closed `credential_scheme` read schema and R-3's `mandatory_rules` grammar, without a
 * database (T-060). The expected value sets are written here from SD §DB-4 2076–2088 and `T-251`
 * § Published contract — LIVE §1, NOT imported from `scheme.ts`, so a constant edited in the source
 * turns these red rather than agreeing with itself (PROTOCOL §5.1).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CHECK_TYPES,
  CredentialSchemeReadError,
  isMandatoryForEverySitter,
  MANDATORY_RULES_UNREADABLE,
  MandatoryRulesUnreadableError,
  parseMandatoryRules,
  SCHEME_READ_REFUSED,
  VALIDITY_MODELS,
} from './index.ts';
import { parseSchemeRow } from './scheme.ts';

const V1 = { v: 1, mandatory: 'all_tiers' };

/** A Q-1 row as `pg` returns the White seed row (T-251 §2). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 2,
    jurisdiction: 'CY',
    check_type: 'criminal_record',
    scheme_name: 'White Criminal Record Certificate',
    scheme_name_i18n: { en: 'White Criminal Record Certificate', el: 'x' },
    issuing_body: 'Cyprus Police',
    validity_model: 'point_in_time_annual_reissue',
    default_validity_months: 12,
    max_age_at_submission_months: 3,
    attestation_interval_days: null,
    attestation_grace_days: null,
    reference_format_regex: null,
    mandatory_rules: { ...V1 },
    ...over,
  };
}

test('the five validity models are exactly the database CHECK set', () => {
  assert.deepEqual([...VALIDITY_MODELS].sort(), [
    'continuously_monitored',
    'expiring',
    'periodic_attestation',
    'point_in_time',
    'point_in_time_annual_reissue',
  ]);
});

test('the eight check types are exactly the database CHECK set', () => {
  assert.deepEqual([...CHECK_TYPES].sort(), [
    'attestation',
    'child_protection_register',
    'criminal_record',
    'identity',
    'insurance',
    'qualification',
    'right_to_work',
    'training',
  ]);
});

test('v1 parses, with keys in either order, and is mandatory for every sitter', () => {
  assert.deepEqual(parseMandatoryRules({ v: 1, mandatory: 'all_tiers' }), V1);
  assert.deepEqual(parseMandatoryRules({ mandatory: 'all_tiers', v: 1 }), V1);
  assert.equal(isMandatoryForEverySitter(parseMandatoryRules(V1)), true);
});

test('every mandatory_rules value outside v1 is an error, never optional', () => {
  const outside: unknown[] = [
    {},
    null,
    undefined,
    'all_tiers',
    1,
    [],
    [V1],
    { v: 1 },
    { mandatory: 'all_tiers' },
    { v: 1, mandatory: 'none' },
    { v: 1, mandatory: 'optional' },
    { v: 1, mandatory: 'ALL_TIERS' },
    { v: '1', mandatory: 'all_tiers' },
    { v: 2, mandatory: 'all_tiers' },
    { v: 1, mandatory: 'all_tiers', tiers: ['gold'] },
    { v: 1, mandatory: null },
  ];
  for (const value of outside) {
    assert.throws(
      () => parseMandatoryRules(value),
      (e: unknown) =>
        e instanceof MandatoryRulesUnreadableError && e.message === MANDATORY_RULES_UNREADABLE,
      JSON.stringify(value) ?? 'undefined',
    );
  }
});

test('a well-formed row parses to the published shape, deeply frozen', () => {
  const s = parseSchemeRow(row());
  assert.deepEqual(s, {
    id: 2,
    jurisdiction: 'CY',
    checkType: 'criminal_record',
    schemeName: 'White Criminal Record Certificate',
    schemeNameI18n: { en: 'White Criminal Record Certificate', el: 'x' },
    issuingBody: 'Cyprus Police',
    validityModel: 'point_in_time_annual_reissue',
    defaultValidityMonths: 12,
    maxAgeAtSubmissionMonths: 3,
    attestationIntervalDays: null,
    attestationGraceDays: null,
    referenceFormatRegex: null,
    mandatoryRules: V1,
  });
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.schemeNameI18n));
  assert.ok(Object.isFrozen(s.mandatoryRules));
});

test('continuously_monitored parses: the retained model is accepted, not refused', () => {
  assert.equal(
    parseSchemeRow(row({ validity_model: 'continuously_monitored' })).validityModel,
    'continuously_monitored',
  );
});

test('a row whose mandatory_rules is outside v1 refuses the read and names only the column', () => {
  for (const value of [{}, { v: 1, mandatory: 'none' }, null]) {
    assert.throws(
      () => parseSchemeRow(row({ mandatory_rules: value })),
      (e: unknown) =>
        e instanceof CredentialSchemeReadError &&
        e.message === SCHEME_READ_REFUSED &&
        JSON.stringify(e.fields) === '["mandatory_rules"]',
    );
  }
});

test('a row outside the closed schema refuses the read, naming each failing column', () => {
  const cases: [Record<string, unknown>, string[]][] = [
    [{ validity_model: 'monitored' }, ['validity_model']],
    [{ check_type: 'barred_list' }, ['check_type']],
    [{ jurisdiction: 'cy' }, ['jurisdiction']],
    [{ scheme_name_i18n: ['en'] }, ['scheme_name_i18n']],
    [{ scheme_name_i18n: null }, ['scheme_name_i18n']],
    [{ reference_format_regex: 7 }, ['reference_format_regex']],
    [{ default_validity_months: '12' }, ['default_validity_months']],
    [{ id: 0 }, ['id']],
    [{ notes: 'free text' }, ['(row)']],
    [{ validity_model: 'monitored', mandatory_rules: {} }, ['mandatory_rules', 'validity_model']],
  ];
  for (const [over, fields] of cases) {
    assert.throws(
      () => parseSchemeRow(row(over)),
      (e: unknown) =>
        e instanceof CredentialSchemeReadError &&
        JSON.stringify(e.fields) === JSON.stringify(fields),
      JSON.stringify(over),
    );
  }
});

test('the read error carries no column value: a canary in a refused row reaches neither message nor fields', () => {
  const CANARY = 'CANARY-T060-SCHEME-7731';
  try {
    parseSchemeRow(row({ validity_model: CANARY, mandatory_rules: { v: CANARY } }));
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(e instanceof CredentialSchemeReadError);
    const seen = [e.message, String(e.stack), JSON.stringify(e), JSON.stringify(e.fields)].join(
      '|',
    );
    assert.ok(!seen.includes(CANARY));
  }
});
