/**
 * `credential_scheme` as the application reads it (T-060, the scheme half; CUT-T-060 R-1). The
 * table is `T-251`'s migration `0024` (state/EP-5/T-251.md § Published contract — LIVE): reference
 * data written only by migrations, `app_rw` holds `SELECT` and nothing else.
 *
 * THE READ IS CLOSED AND FAILS CLOSED. Every row Q-1 returns is parsed by `SchemeRow` below, a
 * strict Zod object: an unknown column, a `validity_model` or `check_type` outside the sets the
 * database's CHECKs name, or a `mandatory_rules` value outside R-3's v1 grammar is an ERROR for the
 * whole read (`CredentialSchemeReadError`), never a default. A reader that cannot tell whether a
 * scheme is mandatory must not answer for any scheme of that jurisdiction: a partial list is a
 * sitter judged against fewer schemes than exist (R-3: "an error, read as not bookable").
 *
 * The database already refuses every `mandatory_rules` value but v1 (`credential_scheme_mandatory_rules_v1`,
 * `T-251` §3), so the parse is a second layer, not the only one. Its refusal of another value is
 * held without a database by `scheme.test.ts` and, through the real Q-1 with the CHECK dropped and
 * a value planted inside a rolled-back transaction, by `test/credential-scheme.spec.ts`.
 */
import * as z from 'zod';

/**
 * The five `validity_model` values, as `credential_scheme_validity_model_check` names them (SD §DB-4
 * 2083–2088; `T-251` § Published contract — LIVE §1). `continuously_monitored` is RETAINED with no
 * Cyprus row (SD 2088–2093, SA §DA-4r 1283): it is accepted here so that a row carrying it parses,
 * and nothing in this module branches on it. Held by `scheme.test.ts` › *the five validity models
 * are exactly the database CHECK's set*.
 */
export const VALIDITY_MODELS = [
  'point_in_time_annual_reissue',
  'periodic_attestation',
  'expiring',
  'point_in_time',
  'continuously_monitored',
] as const;
export type ValidityModel = (typeof VALIDITY_MODELS)[number];

/** The eight `check_type` values of `credential_scheme_check_type_check` (SD 2076–2077; CUT R-5). */
export const CHECK_TYPES = [
  'criminal_record',
  'child_protection_register',
  'identity',
  'right_to_work',
  'qualification',
  'insurance',
  'attestation',
  'training',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/**
 * R-3's closed v1 grammar: exactly `{"v": 1, "mandatory": "all_tiers"}`. Strict: an extra key, a
 * string `"1"`, `2`, `"none"`, `{}` and JSON `null` are refused. (`1.0` in `jsonb` reaches here as
 * the JavaScript number 1 and is accepted, as the database accepts it, `T-251` §4.)
 */
export const MandatoryRulesV1 = z.strictObject({
  v: z.literal(1),
  mandatory: z.literal('all_tiers'),
});
export type MandatoryRules = z.infer<typeof MandatoryRulesV1>;

/** Fixed text: names no value. */
export const MANDATORY_RULES_UNREADABLE =
  'credential: mandatory_rules is outside the v1 grammar (CUT-T-060 R-3); read as an error, never as optional';

/**
 * `mandatory_rules` outside v1. Carries no value: only the fixed message. A caller reads it as NOT
 * BOOKABLE (R-3), never as "this scheme is optional".
 */
export class MandatoryRulesUnreadableError extends Error {
  override readonly name = 'MandatoryRulesUnreadableError';
  constructor() {
    super(MANDATORY_RULES_UNREADABLE);
  }
}

/**
 * Parse a `mandatory_rules` value with R-3's closed grammar. For `T-061` and `T-028`, which read the
 * column through this function (R-3's binding on readers). Throws `MandatoryRulesUnreadableError`
 * for anything but v1.
 */
export function parseMandatoryRules(value: unknown): MandatoryRules {
  const parsed = MandatoryRulesV1.safeParse(value);
  if (!parsed.success) throw new MandatoryRulesUnreadableError();
  return parsed.data;
}

/**
 * Whether every sitter must hold the scheme. Under v1 the only value is `all_tiers`, so the answer
 * is always `true`; the function exists so that no caller writes its own reading of the grammar,
 * and so that a v2 (a migration widening the CHECK, R-3) changes one place.
 */
export function isMandatoryForEverySitter(rules: MandatoryRules): boolean {
  return rules.mandatory === 'all_tiers';
}

const nullableInt = z.number().int().nullable();

/**
 * One Q-1 row. Column names are the database's. `scheme_name_i18n` is an object whose VALUES are
 * not typed here: the database accepts a value of any JSON type (`T-251` §4), and a value that is
 * not a usable string is a MISSING locale at lookup (`display.ts`), not a refused read.
 */
const SchemeRow = z.strictObject({
  id: z.number().int().positive(),
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  check_type: z.enum(CHECK_TYPES),
  scheme_name: z.string(),
  scheme_name_i18n: z.record(z.string(), z.unknown()),
  issuing_body: z.string(),
  validity_model: z.enum(VALIDITY_MODELS),
  default_validity_months: nullableInt,
  max_age_at_submission_months: nullableInt,
  attestation_interval_days: nullableInt,
  attestation_grace_days: nullableInt,
  reference_format_regex: z.string().nullable(),
  mandatory_rules: z.unknown(),
});

/**
 * The published shape (T-060 § Published contract — LIVE). Deeply frozen when it comes from
 * `readCredentialSchemes`. `schemeNameI18n`'s values are `unknown` on purpose: read a display name
 * through `schemeDisplayName`, which handles a missing, null, non-string or blank value explicitly.
 * `issuingBody` is a catalogue key, not display text (S-1 (a′) (i)).
 */
export interface CredentialScheme {
  readonly id: number;
  readonly jurisdiction: string;
  readonly checkType: CheckType;
  readonly schemeName: string;
  readonly schemeNameI18n: Readonly<Record<string, unknown>>;
  readonly issuingBody: string;
  readonly validityModel: ValidityModel;
  readonly defaultValidityMonths: number | null;
  readonly maxAgeAtSubmissionMonths: number | null;
  readonly attestationIntervalDays: number | null;
  readonly attestationGraceDays: number | null;
  /** NULL means "record the reference verbatim, validate nothing" (SD 2098–2104, SQ-25). */
  readonly referenceFormatRegex: string | null;
  readonly mandatoryRules: MandatoryRules;
}

/** Fixed text: names columns, never a value. */
export const SCHEME_READ_REFUSED =
  'credential: a credential_scheme row failed the closed read; the whole read is refused (fail closed)';

/**
 * A Q-1 row outside the closed schema. `fields` names the offending COLUMNS (from Zod's issue
 * paths), never their values. The whole jurisdiction's read is refused.
 */
export class CredentialSchemeReadError extends Error {
  override readonly name = 'CredentialSchemeReadError';
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(SCHEME_READ_REFUSED);
    this.fields = Object.freeze([...fields]);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Parse one row. Throws `CredentialSchemeReadError` naming the failing columns. Exported for the
 * read path and its tests; consumers call `readCredentialSchemes` or the cache.
 */
export function parseSchemeRow(row: unknown): CredentialScheme {
  const parsed = SchemeRow.safeParse(row);
  const fields = new Set<string>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      fields.add(typeof head === 'string' ? head : '(row)');
    }
  }
  const rules = MandatoryRulesV1.safeParse(
    typeof row === 'object' && row !== null && 'mandatory_rules' in row
      ? row.mandatory_rules
      : undefined,
  );
  if (!rules.success) fields.add('mandatory_rules');
  if (!parsed.success || !rules.success) throw new CredentialSchemeReadError([...fields].sort());
  const r = parsed.data;
  return deepFreeze({
    id: r.id,
    jurisdiction: r.jurisdiction,
    checkType: r.check_type,
    schemeName: r.scheme_name,
    schemeNameI18n: { ...r.scheme_name_i18n },
    issuingBody: r.issuing_body,
    validityModel: r.validity_model,
    defaultValidityMonths: r.default_validity_months,
    maxAgeAtSubmissionMonths: r.max_age_at_submission_months,
    attestationIntervalDays: r.attestation_interval_days,
    attestationGraceDays: r.attestation_grace_days,
    referenceFormatRegex: r.reference_format_regex,
    mandatoryRules: { ...rules.data },
  });
}
