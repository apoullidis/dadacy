/**
 * The validity models (T-061; SA §DA-4r 1287–1297, SA B3): the credential dates a `system`
 * transition writes when it moves a `sitter_credential` row to `valid`, computed from the scheme's
 * `validity_model` and parameters and from the facts the decision established.
 *
 * COMPUTES, NEVER WRITES (OD-345, signed 2026-10-14). Nothing here opens a transaction or touches a
 * table. The transition that sets the dates (`T-070`'s `in_review → valid` decision; `T-063`'s
 * attestation) calls this and persists the result through a `system` function in `T-255`'s
 * repository, writing ALL FIVE columns from the result, so no sitter-written value is carried into
 * `valid` (T-252 § Published contract — LIVE §4 row 2).
 *
 * FAILS CLOSED. The scheme is re-read field by field: its `mandatory_rules` through
 * `parseMandatoryRules` (CUT-T-060 R-3; `MandatoryRulesUnreadableError` passes through unchanged and
 * means NOT BOOKABLE), its `validity_model` against `VALIDITY_MODELS`, and the parameter the model
 * needs. A `CredentialScheme` from `readCredentialSchemes` already satisfies all of this; the
 * re-read is for a structurally typed literal, which TypeScript would accept (T-060 §5's hole).
 *
 * WHAT EACH MODEL COMPUTES (the five columns: `expires_on`, `expiry_provenance`,
 * `next_recertification_due_at`, `last_attestation_at`, `next_attestation_due_at`):
 *   - `point_in_time_annual_reissue`: `next_recertification_due_at = issued_on + default_validity_months`
 *     calendar months (SA 1291), the day clamped to the target month's last day, as PostgreSQL's
 *     `date + interval 'N months'` does (2028-02-29 + 12 months = 2029-02-28). The other four are
 *     NULL: SD 2133's column comment gives this model that column and no other. Reads `issuedOn`.
 *   - `expiring`: `expires_on` = the expiry the document states, `expiry_provenance = 'from_document'`
 *     (SA 1293). Reads `documentExpiresOn`. **With no stated expiry it refuses**: the platform-default
 *     branch is not built, because its source is unruled (OD-347).
 *   - `point_in_time`: all five NULL ("no recheck", SA 1294). Reads nothing.
 *   - every other model is refused with `ValidityNotComputedError`: `periodic_attestation` (its
 *     "+90 days" on an instant is unruled across DST, OD-346) and the model SA 1283 retains with no
 *     Cyprus row, which this file deliberately never names (the T-061 gate: present in
 *     `VALIDITY_MODELS`, unreferenced here).
 *
 * Date arithmetic is on whole calendar dates (`YYYY-MM-DD`) in integers: no `Date`, no host time
 * zone, nothing that `TZ` can change. SD §DB-6 rule 7 routes date arithmetic through
 * `@kinvara/domain-types` `time.ts`, which has no calendar-date operation (it converts between local
 * and instant); the availability and schedule modules made the same choice (`availability/civil.ts`).
 *
 * TWO-APPROVAL PATH (PROTOCOL §3, EV-30). Contract: state/EP-5/T-061.md § Published contract — LIVE.
 */
import { InvalidInputError } from '@kinvara/domain-types';
import { parseMandatoryRules, VALIDITY_MODELS, type ValidityModel } from './scheme.ts';

/** `sitter_credential_expiry_provenance_check`'s two values (T-252 §1). */
export type ExpiryProvenance = 'from_document' | 'platform_default';

/**
 * The five date columns a move to `valid` writes, camel-cased. Dates are `YYYY-MM-DD`. The two
 * attestation columns are typed `null`: no model computed here sets them (OD-346).
 */
export interface ValidityDates {
  readonly expiresOn: string | null;
  readonly expiryProvenance: ExpiryProvenance | null;
  readonly nextRecertificationDueAt: string | null;
  readonly lastAttestationAt: null;
  readonly nextAttestationDueAt: null;
}

/**
 * What the decision established, from the document the reviewer sighted, never from a sitter's
 * write (T-252 §4 row 2). Each model reads only the facts listed for it above; a fact a model does
 * not read is not validated and does not change the result.
 */
export interface ValidityFacts {
  /** `YYYY-MM-DD`, the certificate's issue date. */
  readonly issuedOn: string | null;
  /** `YYYY-MM-DD`, the expiry the document states, or `null` if it states none. */
  readonly documentExpiresOn: string | null;
}

/** The scheme fields this file reads. A `CredentialScheme` (T-060) is one. */
export interface ValidityScheme {
  readonly validityModel: ValidityModel;
  readonly defaultValidityMonths: number | null;
  readonly mandatoryRules: unknown;
}

/** Fixed text: names no value. */
export const VALIDITY_NOT_COMPUTED =
  'credential: no validity dates are computed for this validity_model (state/EP-5/T-061.md)';

/**
 * The scheme's model has no computation here. `validityModel` is one of `VALIDITY_MODELS` (checked
 * before this is thrown), so carrying it echoes no input that was not already a closed enum value.
 * A server fault (500 through `toProblem`): the caller asked for a date this module does not make.
 */
export class ValidityNotComputedError extends Error {
  override readonly name = 'ValidityNotComputedError';
  readonly validityModel: ValidityModel;
  constructor(validityModel: ValidityModel) {
    super(VALIDITY_NOT_COMPUTED);
    this.validityModel = validityModel;
  }
}

/** Fixed text: names no value. */
export const VALIDITY_SCHEME_UNUSABLE =
  'credential: the scheme cannot be used to compute validity dates; read as not bookable';

/**
 * The scheme is outside what the computation accepts: `fields` names the failing scheme FIELDS
 * (sorted), never a value. A server fault: schemes are reference data written by migration.
 */
export class ValiditySchemeUnusableError extends Error {
  override readonly name = 'ValiditySchemeUnusableError';
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(VALIDITY_SCHEME_UNUSABLE);
    this.fields = Object.freeze([...fields].sort());
  }
}

/**
 * The dates a move to `valid` writes for a credential under `scheme`, given the decision's `facts`.
 * Throws, before computing anything: `MandatoryRulesUnreadableError` (unchanged from
 * `parseMandatoryRules`), `ValiditySchemeUnusableError`, `ValidityNotComputedError`, or
 * `InvalidInputError` with `field` `issuedOn` / `documentExpiresOn` (the value is not echoed).
 * The result is frozen.
 */
export function validityDatesForDecision(
  scheme: ValidityScheme,
  facts: ValidityFacts,
): ValidityDates {
  // One read per field (T-254 A7): validate the snapshot, compute from the snapshot.
  const model: unknown = scheme.validityModel;
  const months: unknown = scheme.defaultValidityMonths;
  const rules: unknown = scheme.mandatoryRules;

  parseMandatoryRules(rules);
  if (!isValidityModel(model)) throw new ValiditySchemeUnusableError(['validityModel']);
  if (!Object.hasOwn(MODELS, model)) throw new ValidityNotComputedError(model);
  const compute = MODELS[model as ComputedModel];
  return Object.freeze(compute({ months }, facts));
}

type ComputedModel = 'point_in_time_annual_reissue' | 'expiring' | 'point_in_time';
type Compute = (scheme: { readonly months: unknown }, facts: ValidityFacts) => ValidityDates;

const NONE: ValidityDates = {
  expiresOn: null,
  expiryProvenance: null,
  nextRecertificationDueAt: null,
  lastAttestationAt: null,
  nextAttestationDueAt: null,
};

/**
 * The models computed here, by name. A model absent from this table is refused by the lookup in
 * `validityDatesForDecision`; nothing branches on a model's name anywhere else in this file.
 */
const MODELS: Readonly<Record<ComputedModel, Compute>> = Object.freeze({
  point_in_time_annual_reissue: (scheme, facts) => {
    const months = scheme.months;
    if (typeof months !== 'number' || !Number.isSafeInteger(months) || months < 1) {
      throw new ValiditySchemeUnusableError(['defaultValidityMonths']);
    }
    const issuedOn = civilDate(facts.issuedOn, 'issuedOn');
    const due = addMonthsClamped(issuedOn, months);
    if (due === null) throw new ValiditySchemeUnusableError(['defaultValidityMonths']);
    return { ...NONE, nextRecertificationDueAt: due };
  },
  expiring: (_scheme, facts) => {
    // OD-347: with no stated expiry there is no ruled source for a platform default; refuse.
    const expiresOn = format(civilDate(facts.documentExpiresOn, 'documentExpiresOn'));
    return { ...NONE, expiresOn, expiryProvenance: 'from_document' };
  },
  point_in_time: () => ({ ...NONE }),
} satisfies Record<ComputedModel, Compute>);

function isValidityModel(value: unknown): value is ValidityModel {
  return typeof value === 'string' && (VALIDITY_MODELS as readonly string[]).includes(value);
}

interface Civil {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A real proleptic-Gregorian date `0001-01-01`…`9999-12-31`, or `InvalidInputError({ field })`. */
function civilDate(value: unknown, field: string): Civil {
  if (typeof value !== 'string') throw new InvalidInputError({ field });
  const match = ISO_DATE.exec(value);
  if (match === null) throw new InvalidInputError({ field });
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new InvalidInputError({ field });
  }
  return { y, m, d };
}

function format({ y, m, d }: Civil): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * `date + n` calendar months with the day clamped to the target month's length — PostgreSQL's
 * `date + interval 'n months'` (measured in `.cache/T-061/anchors-pg.txt`). `null` past 9999-12-31.
 */
function addMonthsClamped(from: Civil, n: number): string | null {
  const index = from.y * 12 + (from.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  if (y > 9999) return null;
  return format({ y, m, d: Math.min(from.d, daysInMonth(y, m)) });
}
