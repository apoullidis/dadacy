/**
 * THE `sitter_credential` REPOSITORY (T-255; `T-060`'s second code half, CUT-T-060 R-1). Q-2…Q-5 of
 * state/EP-5/T-060.md § What the code does, coded against `T-252` § Published contract — LIVE (the
 * table, its RLS and grants), `T-254` § Published contract — LIVE (the actor transaction) and
 * `T-060` § Published contract — LIVE (the scheme read and the reference validator).
 *
 * WHO EACH QUERY RUNS AS (T-254; BOARD T-255 brief):
 *   - Q-2, Q-3, Q-4 run inside `db.withActor(personActor(accountId, 'sitter'), …)`. The functions
 *     take a `SitterActor` and open that transaction themselves; there is no signature without an
 *     actor and none that takes a `Tx`, so an actorless call does not compile
 *     (`type-tests/credential-repository-refusals.ts`). The actor is re-read once at run time and
 *     re-built with `personActor(<its account id>, 'sitter')`, so a forged or non-sitter actor is
 *     refused before any SQL and the id bound to `app.actor_id` is the id used as `sitter_id`.
 *   - The Q-5 sweeps run inside a worker's `bindSystemActor(db, '<job>')` scope, and FIRST READ BACK
 *     the transaction's actor: a sweep whose transaction is not a `system` actor's is refused, never
 *     answered with the 0 rows RLS would give it (a sweep that silently sees nothing is a missed
 *     expiry).
 *   - A HELD sitter's fresh certificate (row in `review_hold`, which the sitter policy will not let
 *     the sitter update, OD-326) is written as the `system` actor `credential.held_resubmission`,
 *     after the repository has read the row as the sitter and found it theirs and held (T-252 §6).
 *     That write does not touch `status`: the row stays `review_hold`, which it leaves only to
 *     `valid` by SD 1436's four-eyes decision or to `failed` (SD 1433), neither of which is here.
 *   - Nothing here hands its `Tx` to other code: the only callees given a `Tx` are
 *     `readCredentialSchemes` (T-060) and this file's own statements, none of which sets a GUC,
 *     sends `RESET ROLE` or `COMMIT` (T-254 §5, A4–A6).
 *
 * TRANSITIONS ARE THE REPOSITORY'S (T-252 §4 row 1). The only sitter edge offered is SD 1432's
 * `not_started → submitted`. Every other current status is refused `StateTransitionInvalidError`
 * (409) before any write, `valid` included (no sitter-caused edge out of `valid`, SD 1436, SA I-8).
 * The write itself is compare-and-set (`WHERE id = $ AND status = 'not_started'`), so a row that
 * changed between the read and the write is refused too, never a silent no-op.
 *
 * REFERENCES (T-060 §5–§6). Inside the write transaction: `readCredentialSchemes(tx, jurisdiction)`
 * (never the 60 s cache), the scheme whose `id` is the row's `scheme_id` is passed to
 * `validateReference`, and its `referenceNumber` is written unchanged. `ReferenceNumberRefusedError`
 * and `ReferencePatternUnusableError` pass through unchanged. The reference is never logged here.
 *
 * DATABASE REFUSALS ARE MAPPED BY SQLSTATE AND CONSTRAINT NAME, NEVER FORWARDED (T-252 §6, T-060 §6).
 * A refused statement reaches this file as drizzle's `DrizzleQueryError`, whose MESSAGE carries the
 * statement's bind parameters (the reference among them) and whose `cause` is pg's error, whose
 * `detail` prints the failing row. Neither leaves: `sitter_credential_reference_number_bounds` becomes
 * `ReferenceNumberOutOfBoundsError` (400, field `referenceNumber`), every other refusal becomes
 * `SitterCredentialRefusedError` carrying only `sqlstate` and `constraint`, and neither has a `cause`.
 *
 * NO DELETE PATH: no statement here deletes (T-252 §3: no role holds `DELETE`).
 */
import {
  InvalidInputError,
  isUlid,
  NotFoundError,
  StateTransitionInvalidError,
} from '@kinvara/domain-types';
import { DrizzleQueryError, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  ActorRefusedError,
  personActor,
  systemActor,
  type Database,
  type LogLine,
  type PersonActor,
  type SystemActorDatabase,
  type Tx,
} from '../runtime/index.ts';
import { newSitterCredentialId } from './ids.ts';
import {
  q2SelectById,
  q2SelectBySitter,
  q3InsertNotStarted,
  q4HeldResubmission,
  q4Update,
  q5Due,
  READ_ACTOR,
  type SweepKind,
} from './queries.ts';
import { readCredentialSchemes } from './read.ts';
import { validateReference } from './reference.ts';
import type { CredentialScheme } from './scheme.ts';

// ── Types ──────────────────────────────────────────────────────────────────────────────────────

/** SD 2124–2125 (`sitter_credential_status_check`). */
export const CREDENTIAL_STATUSES = [
  'not_started',
  'submitted',
  'in_review',
  'valid',
  'expired',
  'failed',
  'review_hold',
  'withdrawn',
] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/**
 * A person actor in the `sitter` role. Built by `sitterActor`; a `PersonActor` in any other role is
 * not assignable to it, and an object literal lacks T-254's brand.
 */
export type SitterActor = PersonActor & { readonly role: 'sitter' };

/** `personActor(accountId, 'sitter')`, typed as a `SitterActor`. Throws `ActorRefusedError`. */
export function sitterActor(accountId: unknown): SitterActor {
  return personActor(accountId, 'sitter') as SitterActor;
}

/** The job identity a held sitter's fresh certificate is written under (T-252 §6). */
export const HELD_RESUBMISSION_JOB = 'credential.held_resubmission';

/** One `sitter_credential` row, all twenty columns, camel-cased. Dates `YYYY-MM-DD`; instants UTC ISO. */
export interface SitterCredential {
  readonly id: string;
  readonly sitterId: string;
  readonly schemeId: number;
  readonly status: CredentialStatus;
  readonly referenceNumber: string | null;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly expiryProvenance: 'from_document' | 'platform_default' | null;
  readonly nextRecertificationDueAt: string | null;
  readonly lastAttestationAt: string | null;
  readonly nextAttestationDueAt: string | null;
  readonly attestationTemplateVersion: string | null;
  readonly attestationLocale: string | null;
  readonly decision: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReasonCode: string | null;
  readonly provider: string | null;
  readonly providerRef: string | null;
  readonly createdAt: string;
}

export interface CertificateSubmission {
  /** The `sitter_credential.id` (a ULID the server generated at onboarding). */
  readonly credentialId: string;
  /** The jurisdiction whose schemes are read in the write transaction (`CY`). */
  readonly jurisdiction: string;
  /** Judged by `validateReference` against the row's scheme; written as it returns it. */
  readonly referenceNumber: unknown;
  /** `YYYY-MM-DD`, or null. */
  readonly issuedOn: string | null;
}

export type SubmissionOutcome =
  /** `not_started → submitted`, written as the sitter. */
  | { readonly status: 'submitted'; readonly credentialId: string }
  /** The row is held: reference and issue date written as `system`; status unchanged. */
  | { readonly status: 'review_hold'; readonly credentialId: string };

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────

/** Fixed text: names no value. */
export const SITTER_CREDENTIAL_REFUSED =
  'credential: the database refused the sitter_credential statement';

/**
 * A statement the database refused, other than the reference bound. Carries the SQLSTATE and the
 * constraint NAME (pg's `constraint` field; `undefined` for a privilege or RLS refusal), never the
 * message, `detail` or parameters, and has no `cause`. A server fault (extends `Error`): the
 * repository should not send a statement the database refuses.
 */
export class SitterCredentialRefusedError extends Error {
  override readonly name = 'SitterCredentialRefusedError';
  readonly sqlstate: string;
  readonly constraint: string | undefined;
  constructor(sqlstate: string, constraint: string | undefined) {
    super(SITTER_CREDENTIAL_REFUSED);
    this.sqlstate = sqlstate;
    this.constraint = constraint;
  }
}

/** The database's capacity bound on the reference (S-1 (b)(ii): 1–64 characters, no control). */
export const REFERENCE_BOUNDS_CONSTRAINT = 'sitter_credential_reference_number_bounds';

/** `23514 sitter_credential_reference_number_bounds`: `invalid_input`, field `referenceNumber`. */
export class ReferenceNumberOutOfBoundsError extends InvalidInputError {
  constructor() {
    super({ field: 'referenceNumber' });
  }
}

/** Fixed text: names the failing columns only. */
export const CREDENTIAL_ROW_UNREADABLE = 'credential: a sitter_credential row is outside the read schema';

/** A row outside the closed read schema. `fields` names the columns, never a value. */
export class SitterCredentialReadError extends Error {
  override readonly name = 'SitterCredentialReadError';
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(CREDENTIAL_ROW_UNREADABLE);
    this.fields = Object.freeze([...fields]);
  }
}

/** Fixed text. */
export const SWEEP_ACTOR_REFUSED =
  "credential: a Q-5 sweep must run in a 'system' actor's transaction; this one is not";

/** A sweep's transaction did not carry a `system` actor (read back inside it). */
export class SweepActorRefusedError extends Error {
  override readonly name = 'SweepActorRefusedError';
  constructor() {
    super(SWEEP_ACTOR_REFUSED);
  }
}

// ── Input checks (before any SQL) ──────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function snapshotSitter(actor: unknown): { readonly actor: PersonActor; readonly sitterId: string } {
  if (typeof actor !== 'object' || actor === null) throw new ActorRefusedError('actor_missing');
  const a = actor as { kind?: unknown; accountId?: unknown; role?: unknown };
  // One read per field (T-254 A7's lesson): validate the snapshot, bind the snapshot.
  const kind = a.kind;
  const accountId = a.accountId;
  const role = a.role;
  if (kind !== 'person') throw new ActorRefusedError('actor_kind');
  if (role !== 'sitter') throw new ActorRefusedError('role');
  const bound = personActor(accountId, 'sitter');
  return { actor: bound, sitterId: accountId as string };
}

// ── Refusal mapping ────────────────────────────────────────────────────────────────────────────

interface PgErrorFields {
  readonly code: string;
  readonly constraint: string | undefined;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function pgFields(value: unknown): PgErrorFields | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as { code?: unknown; severity?: unknown; constraint?: unknown };
  if (typeof v.code !== 'string' || !SQLSTATE.test(v.code) || typeof v.severity !== 'string') {
    return undefined;
  }
  return { code: v.code, constraint: typeof v.constraint === 'string' ? v.constraint : undefined };
}

/**
 * Re-throw `thrown` with no database text in it. A pg error (bare, or as a `DrizzleQueryError`'s
 * `cause`) is mapped by SQLSTATE and constraint name. A `DrizzleQueryError` without one (a connection
 * fault) is replaced by its cause when that is an `Error`, since its own message lists the
 * parameters. Anything else (this module's and the validator's errors) passes through unchanged.
 */
export function mapRefusal(thrown: unknown): never {
  const isDrizzle = thrown instanceof DrizzleQueryError;
  const pgError = pgFields(isDrizzle ? thrown.cause : thrown);
  if (pgError !== undefined) {
    if (pgError.code === '23514' && pgError.constraint === REFERENCE_BOUNDS_CONSTRAINT) {
      throw new ReferenceNumberOutOfBoundsError();
    }
    throw new SitterCredentialRefusedError(pgError.code, pgError.constraint);
  }
  if (isDrizzle) {
    throw thrown.cause instanceof Error ? thrown.cause : new SitterCredentialRefusedError('XX000', undefined);
  }
  throw thrown;
}

async function run<R>(tx: Tx, statement: SQL): Promise<R[]> {
  try {
    return (await tx.execute<Record<string, unknown>>(statement)).rows as R[];
  } catch (thrown) {
    return mapRefusal(thrown);
  }
}

// ── Row parse ──────────────────────────────────────────────────────────────────────────────────

const text = z.string();
const nullableText = z.string().nullable();
const isoDate = z.string().refine(isIsoDate).nullable();
const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .nullable();
const ulidText = z.string().refine((v) => isUlid(v));

const CredentialRow = z.strictObject({
  id: ulidText,
  sitter_id: ulidText,
  scheme_id: z.number().int().positive(),
  status: z.enum(CREDENTIAL_STATUSES),
  reference_number: nullableText,
  issued_on: isoDate,
  expires_on: isoDate,
  expiry_provenance: z.enum(['from_document', 'platform_default']).nullable(),
  next_recertification_due_at: isoDate,
  last_attestation_at: isoInstant,
  next_attestation_due_at: isoInstant,
  attestation_template_version: nullableText,
  attestation_locale: nullableText,
  decision: nullableText,
  decided_by: nullableText,
  decided_at: isoInstant,
  decision_reason_code: nullableText,
  provider: nullableText,
  provider_ref: nullableText,
  created_at: text.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
});

function parseRow(row: unknown): SitterCredential {
  const parsed = CredentialRow.safeParse(row);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((i) => (i.path.length > 0 ? String(i.path[0]) : '(row)'))),
    ].sort();
    throw new SitterCredentialReadError(fields);
  }
  const r = parsed.data;
  return Object.freeze({
    id: r.id,
    sitterId: r.sitter_id,
    schemeId: r.scheme_id,
    status: r.status,
    referenceNumber: r.reference_number,
    issuedOn: r.issued_on,
    expiresOn: r.expires_on,
    expiryProvenance: r.expiry_provenance,
    nextRecertificationDueAt: r.next_recertification_due_at,
    lastAttestationAt: r.last_attestation_at,
    nextAttestationDueAt: r.next_attestation_due_at,
    attestationTemplateVersion: r.attestation_template_version,
    attestationLocale: r.attestation_locale,
    decision: r.decision,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionReasonCode: r.decision_reason_code,
    provider: r.provider,
    providerRef: r.provider_ref,
    createdAt: r.created_at,
  });
}

// ── Q-2 ────────────────────────────────────────────────────────────────────────────────────────

async function selectOwn(tx: Tx, sitterId: string): Promise<readonly SitterCredential[]> {
  const rows = await run<unknown>(tx, q2SelectBySitter(sitterId));
  return Object.freeze(rows.map(parseRow));
}

/** Q-2: the sitter's own credential rows, ascending `scheme_id`, deeply frozen. */
export async function listOwnCredentials(
  db: Database,
  actor: SitterActor,
): Promise<readonly SitterCredential[]> {
  const s = snapshotSitter(actor);
  return db.withActor(s.actor, (tx) => selectOwn(tx, s.sitterId));
}

// ── Q-3 ────────────────────────────────────────────────────────────────────────────────────────

export interface OnboardingResult {
  /** Rows this call inserted (0 when every scheme already had one: idempotent). */
  readonly inserted: number;
  /** The sitter's rows after the inserts, read in the same transaction (Q-2). */
  readonly credentials: readonly SitterCredential[];
}

/**
 * Q-3, once per scheme of `jurisdiction` (read with `readCredentialSchemes` in this transaction):
 * a `not_started` row with a server-generated id, `ON CONFLICT (sitter_id, scheme_id) DO NOTHING`.
 * Every scheme the read returns gets a row (each parsed `mandatory_rules` is v1, "all tiers"; a
 * scheme the read cannot parse refuses the whole read, T-060 §2, and so the whole onboarding).
 */
export async function ensureOnboardingCredentials(
  db: Database,
  actor: SitterActor,
  jurisdiction: string,
): Promise<OnboardingResult> {
  const s = snapshotSitter(actor);
  return db.withActor(s.actor, async (tx) => {
    const schemes = await readCredentialSchemes(tx, jurisdiction);
    let inserted = 0;
    for (const scheme of schemes) {
      const rows = await run<{ id: string }>(
        tx,
        q3InsertNotStarted(newSitterCredentialId(), s.sitterId, scheme.id),
      );
      inserted += rows.length;
    }
    return Object.freeze({ inserted, credentials: await selectOwn(tx, s.sitterId) });
  });
}

// ── Q-4 ────────────────────────────────────────────────────────────────────────────────────────

function schemeOf(schemes: readonly CredentialScheme[], schemeId: number): CredentialScheme {
  const scheme = schemes.find((x) => x.id === schemeId);
  // The row's scheme is not one of this jurisdiction's: the caller named the wrong jurisdiction.
  if (scheme === undefined) throw new InvalidInputError({ field: 'jurisdiction' });
  return scheme;
}

/**
 * Q-4, the sitter's submission of a certificate's reference and issue date.
 *   - `not_started`: validated and written as the sitter, `→ submitted`, compare-and-set.
 *   - `review_hold`: validated and written as the `system` actor, status unchanged (T-252 §6).
 *   - any other status, `valid` included: `StateTransitionInvalidError`, nothing written.
 *   - a row the sitter cannot see (another sitter's, or none): `NotFoundError`, nothing written.
 * Refused before any SQL: a malformed `credentialId` (field `credentialId`) or `issuedOn` (field
 * `issuedOn`), a non-sitter or forged actor (`ActorRefusedError`), a malformed jurisdiction
 * (`TypeError`, T-060 §2). `log` is handed to `validateReference` only.
 */
export async function submitCertificate(
  db: Database,
  actor: SitterActor,
  submission: CertificateSubmission,
  log: LogLine,
): Promise<SubmissionOutcome> {
  const s = snapshotSitter(actor);
  const credentialId = submission.credentialId;
  const jurisdiction = submission.jurisdiction;
  const referenceNumber = submission.referenceNumber;
  const issuedOn = submission.issuedOn;
  if (!isUlid(credentialId)) throw new InvalidInputError({ field: 'credentialId' });
  if (issuedOn !== null && !isIsoDate(issuedOn)) throw new InvalidInputError({ field: 'issuedOn' });

  const asSitter = await db.withActor(s.actor, async (tx) => {
    const [row] = (await run<unknown>(tx, q2SelectById(credentialId))).map(parseRow);
    if (row === undefined) throw new NotFoundError();
    if (row.status === 'review_hold') return { held: true as const, schemeId: row.schemeId };
    if (row.status !== 'not_started') throw new StateTransitionInvalidError();
    const scheme = schemeOf(await readCredentialSchemes(tx, jurisdiction), row.schemeId);
    const outcome = validateReference(scheme, referenceNumber, log);
    const written = await run<{ id: string }>(
      tx,
      q4Update({
        id: credentialId,
        fromStatus: 'not_started',
        toStatus: 'submitted',
        referenceNumber: outcome.referenceNumber,
        issuedOn,
      }),
    );
    if (written.length !== 1) throw new StateTransitionInvalidError();
    return { held: false as const };
  });
  if (!asSitter.held) return Object.freeze({ status: 'submitted', credentialId });

  await db.withActor(systemActor(HELD_RESUBMISSION_JOB), async (tx) => {
    const scheme = schemeOf(await readCredentialSchemes(tx, jurisdiction), asSitter.schemeId);
    const outcome = validateReference(scheme, referenceNumber, log);
    const written = await run<{ id: string }>(
      tx,
      q4HeldResubmission({
        id: credentialId,
        sitterId: s.sitterId,
        schemeId: scheme.id,
        referenceNumber: outcome.referenceNumber,
        issuedOn,
      }),
    );
    if (written.length !== 1) throw new StateTransitionInvalidError();
  });
  return Object.freeze({ status: 'review_hold', credentialId });
}

// ── Q-5 ────────────────────────────────────────────────────────────────────────────────────────

async function sweep(sys: SystemActorDatabase, kind: SweepKind, asOf: string): Promise<readonly string[]> {
  return sys.withActor(async (tx) => {
    const [who] = await run<{ actor_role: string | null; actor_id: string | null }>(tx, READ_ACTOR);
    if (who?.actor_role !== 'system' || who.actor_id === null) throw new SweepActorRefusedError();
    const rows = await run<{ id: string }>(tx, q5Due(kind, asOf));
    return Object.freeze(rows.map((r) => r.id));
  });
}

/** Q-5: ids of `valid` rows with `next_recertification_due_at <= asOf` (`YYYY-MM-DD`), ascending. */
export async function dueForRecertification(
  sys: SystemActorDatabase,
  asOf: string,
): Promise<readonly string[]> {
  if (!isIsoDate(asOf)) throw new InvalidInputError({ field: 'asOf' });
  return sweep(sys, 'recertification', asOf);
}

/** Q-5: ids of `valid` rows with `next_attestation_due_at <= asOf` (a valid `Date`), ascending. */
export async function dueForAttestation(
  sys: SystemActorDatabase,
  asOf: Date,
): Promise<readonly string[]> {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new InvalidInputError({ field: 'asOf' });
  }
  return sweep(sys, 'attestation', asOf.toISOString());
}

/** Q-5: ids of `valid` rows with `expires_on <= asOf` (`YYYY-MM-DD`), ascending. */
export async function dueForExpiry(sys: SystemActorDatabase, asOf: string): Promise<readonly string[]> {
  if (!isIsoDate(asOf)) throw new InvalidInputError({ field: 'asOf' });
  return sweep(sys, 'expiry', asOf);
}
