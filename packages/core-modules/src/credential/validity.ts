/**
 * The validity models (T-061; SA §DA-4r 1287–1297, SA B3): the credential dates a `system`
 * transition writes when it moves a `sitter_credential` row to `valid` or records an attestation,
 * computed from the scheme's `validity_model` and parameters and from the facts the transition
 * established.
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
 *   - `periodic_attestation`: `last_attestation_at` = the attestation instant;
 *     `next_attestation_due_at` = that instant + `attestation_interval_days` CALENDAR DAYS IN
 *     `Europe/Nicosia`, keeping the local wall-clock time (OD-346, ruled 2026-10-14T14:30:00Z: never
 *     N × 24 h, never a UTC-session SQL `+ interval`). The other three are NULL. Reads `attestedAt`.
 *     `attestationGraceEndsAt` gives the lapse instant, the same instant + interval + grace days.
 *   - `expiring`: `expires_on` = the expiry the document states, `expiry_provenance = 'from_document'`
 *     (SA 1293). Reads `documentExpiresOn`. **With no stated expiry it refuses**: the platform-default
 *     branch is not built, because its source is unruled (OD-347).
 *   - `point_in_time`: all five NULL ("no recheck", SA 1294). Reads nothing.
 *   - every other model is refused with `ValidityNotComputedError`: the model SA 1283 retains with no
 *     Cyprus row, which this file deliberately never names (the T-061 gate: present in
 *     `VALIDITY_MODELS`, unreferenced here).
 *
 * "+N days" ON AN INSTANT (OD-346): the instant's wall-clock reading in `Europe/Nicosia` comes from
 * `time.ts` `instantToLocal`, N is added to its local DATE here, and the new local date and the same
 * wall time go back through `time.ts` `resolveLocal` (SD §DB-6 rules 3–4: a nonexistent local time
 * resolves to the transition instant, an ambiguous one to the first, pre-transition instant). The
 * seconds and microseconds of the instant are carried over unchanged (Nicosia's offsets since 1970
 * are whole hours), except when the wall time falls in a spring-forward gap: the result is then the
 * transition instant itself, rule 3's "first valid instant". PostgreSQL resolves both of those cases
 * differently (state/EP-5/T-061.md § Evidence E6), so no SQL may recompute this column.
 *
 * Calendar-date arithmetic (months, days) is done here in integers: no `Date`, no host time zone.
 * SD §DB-6 rule 7 routes date arithmetic through `@kinvara/domain-types` `time.ts`, which converts
 * between local and instant but has no calendar-date operation (OD-281, open; the availability and
 * schedule modules made the same choice). The zone conversions go through `time.ts`.
 *
 * TWO-APPROVAL PATH (PROTOCOL §3, EV-30). Contract: state/EP-5/T-061.md § Published contract — LIVE.
 */
import {
  ianaZone,
  instantToLocal,
  InvalidInputError,
  resolveLocal,
  type IanaZone,
} from '@kinvara/domain-types';
import { parseMandatoryRules, VALIDITY_MODELS, type ValidityModel } from './scheme.ts';

/** `sitter_credential_expiry_provenance_check`'s two values (T-252 §1). */
export type ExpiryProvenance = 'from_document' | 'platform_default';

/**
 * The market zone in which "+N days" on an attestation instant is counted (OD-346; SD 613). CY is
 * the only jurisdiction at MVP; a scheme of another market would need its market's zone here.
 */
export const ATTESTATION_ZONE: IanaZone = ianaZone('Europe/Nicosia', 'zone');

/**
 * The five date columns a transition writes, camel-cased. Dates are `YYYY-MM-DD`; the two
 * attestation instants are `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, six fractional digits: the shape
 * `T-255`'s Q-2 reads `timestamptz` columns back in).
 */
export interface ValidityDates {
  readonly expiresOn: string | null;
  readonly expiryProvenance: ExpiryProvenance | null;
  readonly nextRecertificationDueAt: string | null;
  readonly lastAttestationAt: string | null;
  readonly nextAttestationDueAt: string | null;
}

/**
 * What the transition established: for a certificate, from the document the reviewer sighted; for an
 * attestation, the instant it was made. Never from a sitter's write (T-252 §4 row 2). Each model
 * reads only the facts listed for it above; a fact a model does not read is not validated and does
 * not change the result.
 */
export interface ValidityFacts {
  /** `YYYY-MM-DD`, the certificate's issue date. */
  readonly issuedOn: string | null;
  /** `YYYY-MM-DD`, the expiry the document states, or `null` if it states none. */
  readonly documentExpiresOn: string | null;
  /** The attestation instant: a valid `Date`, or `YYYY-MM-DDTHH:MM:SS[.f{1,6}]Z`. */
  readonly attestedAt?: string | Date | null;
}

/** The scheme fields this file reads. A `CredentialScheme` (T-060) carries them. */
export interface ValidityScheme {
  readonly validityModel: ValidityModel;
  readonly defaultValidityMonths: number | null;
  readonly attestationIntervalDays?: number | null;
  readonly attestationGraceDays?: number | null;
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
 * The dates a transition writes for a credential under `scheme`, given its `facts`.
 * Throws, before computing anything: `MandatoryRulesUnreadableError` (unchanged from
 * `parseMandatoryRules`), `ValiditySchemeUnusableError`, `ValidityNotComputedError`, or
 * `InvalidInputError` with `field` `issuedOn` / `documentExpiresOn` / `attestedAt` (the value is not
 * echoed). The result is frozen.
 */
export function validityDatesForDecision(
  scheme: ValidityScheme,
  facts: ValidityFacts,
): ValidityDates {
  const snap = snapshot(scheme);
  if (!Object.hasOwn(MODELS, snap.model)) throw new ValidityNotComputedError(snap.model);
  const compute = MODELS[snap.model as ComputedModel];
  return Object.freeze(compute(snap, facts));
}

/**
 * The instant a `periodic_attestation` lapses (SD 1324, "+97d"): `attestedAt` +
 * (`attestation_interval_days` + `attestation_grace_days`) calendar days in `Europe/Nicosia`, by
 * the same rule as `next_attestation_due_at` (OD-346). Not a column: it is what `T-063` arms the
 * lapse job at. Any other model is `ValidityNotComputedError`; throws as `validityDatesForDecision`.
 */
export function attestationGraceEndsAt(scheme: ValidityScheme, attestedAt: string | Date): string {
  const snap = snapshot(scheme);
  if (!isAttestation(snap.model)) throw new ValidityNotComputedError(snap.model);
  const interval = attestationIntervalDays(snap);
  const grace = snap.graceDays;
  if (typeof grace !== 'number' || !Number.isSafeInteger(grace) || grace < 0 || grace > 3660) {
    throw new ValiditySchemeUnusableError(['attestationGraceDays']);
  }
  const at = parseInstant(attestedAt);
  return plusZoneDays(at, interval + grace, ['attestationGraceDays', 'attestationIntervalDays']);
}

type ComputedModel =
  'point_in_time_annual_reissue' | 'periodic_attestation' | 'expiring' | 'point_in_time';

interface Snapshot {
  readonly model: ValidityModel;
  readonly months: unknown;
  readonly intervalDays: unknown;
  readonly graceDays: unknown;
}
type Compute = (scheme: Snapshot, facts: ValidityFacts) => ValidityDates;

/** One read per field (T-254 A7): validate the snapshot, compute from the snapshot. */
function snapshot(scheme: ValidityScheme): Snapshot {
  const model: unknown = scheme.validityModel;
  const months: unknown = scheme.defaultValidityMonths;
  const intervalDays: unknown = scheme.attestationIntervalDays;
  const graceDays: unknown = scheme.attestationGraceDays;
  const rules: unknown = scheme.mandatoryRules;
  parseMandatoryRules(rules);
  if (!isValidityModel(model)) throw new ValiditySchemeUnusableError(['validityModel']);
  return { model, months, intervalDays, graceDays };
}

const NONE: ValidityDates = {
  expiresOn: null,
  expiryProvenance: null,
  nextRecertificationDueAt: null,
  lastAttestationAt: null,
  nextAttestationDueAt: null,
};

/**
 * The models computed here, by name. A model absent from this table is refused by the lookup in
 * `validityDatesForDecision`; nothing else in this file branches on a model's name except
 * `isAttestation`, which names `periodic_attestation` for `attestationGraceEndsAt`.
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
  periodic_attestation: (scheme, facts) => {
    const interval = attestationIntervalDays(scheme);
    const at = parseInstant(facts.attestedAt);
    return {
      ...NONE,
      lastAttestationAt: formatInstant(at.minuteMs, at.sec, at.micros),
      nextAttestationDueAt: plusZoneDays(at, interval, ['attestationIntervalDays']),
    };
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

function isAttestation(model: ValidityModel): boolean {
  return model === 'periodic_attestation';
}

/** A safe integer 1…3660 (ten years of days), or `ValiditySchemeUnusableError`. */
function attestationIntervalDays(scheme: Snapshot): number {
  const days = scheme.intervalDays;
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > 3660) {
    throw new ValiditySchemeUnusableError(['attestationIntervalDays']);
  }
  return days;
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

/** Days since 1970-01-01 of a civil date (H. Hinnant's days_from_civil, integers only). */
function dayNumber({ y, m, d }: Civil): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The civil date of a day number (civil_from_days). */
function civilOfDay(n: number): Civil {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** An instant split at the minute: the minute's epoch ms, then seconds and microseconds. */
interface Instant {
  readonly minuteMs: number;
  readonly sec: number;
  readonly micros: number;
}

const ISO_INSTANT =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?Z$/;
const MINUTE_MS = 60_000;
/** 1970-01-01T00:00Z … 9999-12-31T23:59:59.999999Z: Nicosia's offset is whole hours throughout. */
const MIN_MS = 0;
const MAX_MS = Date.UTC(9999, 11, 31, 23, 59);

/** `InvalidInputError({ field: 'attestedAt' })` for anything but a valid instant in range. */
function parseInstant(value: unknown): Instant {
  const refuse = (): never => {
    throw new InvalidInputError({ field: 'attestedAt' });
  };
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS + 59_999) return refuse();
    const minuteMs = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
    const rest = ms - minuteMs;
    return { minuteMs, sec: Math.floor(rest / 1000), micros: (rest % 1000) * 1000 };
  }
  if (typeof value !== 'string') return refuse();
  const match = ISO_INSTANT.exec(value);
  if (match === null) return refuse();
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  let day: Civil;
  try {
    day = civilDate(date, 'attestedAt');
  } catch {
    return refuse();
  }
  const hh = Number(match[4]);
  const mi = Number(match[5]);
  const sec = Number(match[6]);
  if (hh > 23 || mi > 59 || sec > 59) return refuse();
  const micros = Number((match[7] ?? '').padEnd(6, '0'));
  const minuteMs = dayNumber(day) * 86_400_000 + (hh * 60 + mi) * MINUTE_MS;
  if (minuteMs < MIN_MS || minuteMs > MAX_MS) return refuse();
  return { minuteMs, sec, micros };
}

function formatInstant(minuteMs: number, sec: number, micros: number): string {
  const minute = new Date(minuteMs).toISOString().slice(0, 16);
  return `${minute}:${String(sec).padStart(2, '0')}.${String(micros).padStart(6, '0')}Z`;
}

/**
 * `at` + `days` calendar days in `ATTESTATION_ZONE`, keeping the wall-clock time (OD-346): the local
 * reading by `instantToLocal`, the date stepped here, the instant back by `resolveLocal`. In a
 * spring-forward gap the result is the transition instant (rule 3); otherwise the seconds and
 * microseconds of `at` are kept. A result past 9999-12-31 refuses the scheme (`fields`).
 */
function plusZoneDays(at: Instant, days: number, fields: readonly string[]): string {
  const local = instantToLocal(new Date(at.minuteMs), ATTESTATION_ZONE);
  const target = civilOfDay(dayNumber(civilDate(local.date, 'attestedAt')) + days);
  if (target.y > 9999) throw new ValiditySchemeUnusableError(fields);
  const resolved = resolveLocal({ date: format(target), time: local.time }, ATTESTATION_ZONE);
  const ms = resolved.instant.getTime();
  if (ms > MAX_MS) throw new ValiditySchemeUnusableError(fields);
  if (resolved.kind === 'gap') return formatInstant(ms, 0, 0);
  return formatInstant(ms, at.sec, at.micros);
}
