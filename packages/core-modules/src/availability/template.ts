/**
 * THE TEMPLATE: read and replace (SD 1101–1102; `T-089.md` Q1/Q2; E.3 U-2, U-3, U-11; C7 (a); C9 (b)).
 *
 * `replaceTemplate` is E.3 U-2's `PUT`, step for step, in the caller's ONE transaction:
 *   (1) E.3 U-11's per-sitter lock;
 *   (2) read the CURRENT SET: rows with `effective_to IS NULL OR effective_to >= <local today>`,
 *       and not voided (`effective_to IS NULL OR effective_to >= effective_from`). U-2 says a voided
 *       row is one "Q1's and Q6's predicates never select", but its own current-set predicate
 *       alone DOES select a voided row whose `effective_to` is today or later (a block voided
 *       before it began). The second conjunct makes U-2's stated intent hold; OD row and decision
 *       in `state/EP-9/T-089.md` § Implementation (held by the worker suite's *voided row* case);
 *   (3) its ETag (`templateEtag`); a missing or different `If-Match` → `TemplatePreconditionFailedError`
 *       (412), carrying the current representation (SD 1410);
 *   (4) an `effectiveFrom` before local today → `InvalidInputError` field `effectiveFrom` (400);
 *   (5) rows with `effective_from < effectiveFrom` still live on `effectiveFrom` get
 *       `effective_to = effectiveFrom − 1 day`; live rows with `effective_from >= effectiveFrom`
 *       are VOIDED (`effective_to = effective_from − 1 day`); every retired or voided row gets
 *       `version = version + 1`. No `DELETE` (`app_rw` holds none, `0029`);
 *   (6) insert the new blocks with `version = 1`;
 *   (7) enqueue `search.slot_materialise {sitterId}` on the same `Tx` (SD 1102, 1313).
 * It returns the new current set and its ETag.
 *
 * "Local today" is read in `HORIZON_ZONE` (materialise.ts says why: `sitter_profile` has no zone).
 * Overlapping or touching blocks are stored as authored (U-3); the materialiser unions them.
 * A block crossing midnight is two blocks, `…–24:00` and `00:00–…` on the next weekday (C7 (a)).
 *
 * THE ETAG (E.3 U-2 (3)): `"` + lowercase hex SHA-256 of the current set's `id:version` lines,
 * sorted by `id`, joined by `\n`, + `"`. The empty set hashes the empty string.
 *
 * ONLY THE SERVICE. The HTTP route (`PUT /v1/availability/template`) is not built by this ticket:
 * see `state/EP-9/T-089.md` § Implementation › What I did not do (no SD §BE-10 row authorises it).
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  ianaZone,
  InvalidInputError,
  PreconditionFailedError,
  type Ulid,
} from '@kinvara/domain-types';
import type { JobEnqueuer } from '../jobs/index.ts';
import type { Tx } from '../runtime/index.ts';
import { addDays, dayNumber, minutesOfTime } from './civil.ts';
import { newAvailabilityId } from './ids.ts';
import { SLOT_MATERIALISE_JOB } from './jobs.ts';
import { lockSitterAvailability } from './lock.ts';
import { localToday } from './persist.ts';

const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/;

/** One block as the API writes it (SD 1102): weekday 0 = Monday … 6 = Sunday (C9 (b)). */
export const TemplateBlockInput = z
  .strictObject({
    weekday: z.number().int().min(0).max(6),
    startLocal: z.string().regex(HHMM),
    endLocal: z.string().regex(HHMM),
  })
  .refine((b) => minutesOfTime(b.endLocal) > minutesOfTime(b.startLocal), {
    message: 'endLocal must be after startLocal on the same local day (C7 (a): use 24:00)',
    path: ['endLocal'],
  });

export const TemplateReplaceInput = z.strictObject({
  blocks: z.array(TemplateBlockInput).max(70),
  effectiveFrom: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  tz: z.string(),
});
export type TemplateReplaceBody = z.input<typeof TemplateReplaceInput>;

export interface TemplateRowView {
  readonly id: string;
  readonly weekday: number;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly tz: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly version: number;
}

export interface TemplateRepresentation {
  readonly etag: string;
  readonly rows: readonly TemplateRowView[];
}

/** 412 on `If-Match` (SD 1410), carrying the current representation for the response body. */
export class TemplatePreconditionFailedError extends PreconditionFailedError {
  readonly current: TemplateRepresentation;
  constructor(current: TemplateRepresentation) {
    super({ field: 'If-Match' });
    this.current = current;
  }
}

export function templateEtag(
  rows: readonly { readonly id: string; readonly version: number }[],
): string {
  const lines = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => `${r.id}:${String(r.version)}`)
    .join('\n');
  return `"${createHash('sha256').update(lines, 'utf8').digest('hex')}"`;
}

interface TemplateDbRow extends Record<string, unknown> {
  readonly id: string;
  readonly weekday: number;
  readonly start_local: string;
  readonly end_local: string;
  readonly tz: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly version: number;
}

/** Postgres prints `time` as `HH:MM:SS`; the API speaks `HH:MM` (`24:00:00` → `24:00`). */
function hhmm(text: string): string {
  return text.slice(0, 5);
}

/** The current set (E.3 U-2 (2)) and its ETag: Q1. */
export async function readTemplate(
  tx: Tx,
  sitterId: Ulid,
  now: Date = new Date(),
): Promise<TemplateRepresentation> {
  const today = localToday(now);
  const rows = (
    await tx.execute<TemplateDbRow>(
      sql`SELECT id::text AS id, weekday, start_local::text AS start_local,
                 end_local::text AS end_local, tz, effective_from::text AS effective_from,
                 effective_to::text AS effective_to, version
            FROM public.availability_template
           WHERE sitter_id = ${sitterId}
             AND (effective_to IS NULL OR effective_to >= ${today}::date)
             AND (effective_to IS NULL OR effective_to >= effective_from)
           ORDER BY weekday, start_local, id`,
    )
  ).rows.map((r) => ({
    id: r.id,
    weekday: Number(r.weekday),
    startLocal: hhmm(r.start_local),
    endLocal: hhmm(r.end_local),
    tz: r.tz,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    version: Number(r.version),
  }));
  return { etag: templateEtag(rows), rows };
}

export interface ReplaceTemplateRequest {
  readonly sitterId: Ulid;
  /** The `If-Match` header as received; `undefined` when absent. */
  readonly ifMatch: string | undefined;
  readonly body: unknown;
  readonly now?: Date;
}

export async function replaceTemplate(
  tx: Tx,
  enqueuer: JobEnqueuer,
  request: ReplaceTemplateRequest,
): Promise<TemplateRepresentation> {
  const parsed = TemplateReplaceInput.safeParse(request.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.path[0];
    throw new InvalidInputError(
      typeof first === 'string' && ['blocks', 'effectiveFrom', 'tz'].includes(first)
        ? { field: first }
        : {},
    );
  }
  const body = parsed.data;
  const tz = ianaZone(body.tz, 'tz');
  dayNumber(body.effectiveFrom, 'effectiveFrom');
  const now = request.now ?? new Date();
  const { sitterId } = request;

  // (1)
  await lockSitterAvailability(tx, sitterId);
  // (2), (3)
  const current = await readTemplate(tx, sitterId, now);
  if (request.ifMatch !== current.etag) throw new TemplatePreconditionFailedError(current);
  // (4)
  const today = localToday(now);
  if (body.effectiveFrom < today) throw new InvalidInputError({ field: 'effectiveFrom' });
  const dayBefore = addDays(body.effectiveFrom, -1);
  // (5) retire rows still live on effectiveFrom that began before it
  await tx.execute(
    sql`UPDATE public.availability_template
           SET effective_to = ${dayBefore}::date, version = version + 1
         WHERE sitter_id = ${sitterId}
           AND effective_from < ${body.effectiveFrom}::date
           AND (effective_to IS NULL OR effective_to >= ${body.effectiveFrom}::date)`,
  );
  //     void live rows that begin on or after it (never selected again by Q1 or Q6)
  await tx.execute(
    sql`UPDATE public.availability_template
           SET effective_to = effective_from - 1, version = version + 1
         WHERE sitter_id = ${sitterId}
           AND effective_from >= ${body.effectiveFrom}::date
           AND (effective_to IS NULL OR effective_to >= effective_from)`,
  );
  // (6)
  for (const block of body.blocks) {
    await tx.execute(
      sql`INSERT INTO public.availability_template
            (id, sitter_id, weekday, start_local, end_local, tz, effective_from, version)
          VALUES (${newAvailabilityId()}, ${sitterId}, ${block.weekday}, ${block.startLocal}::time,
                  ${block.endLocal}::time, ${tz}, ${body.effectiveFrom}::date, 1)`,
    );
  }
  // (7)
  await enqueuer.enqueue(tx, SLOT_MATERIALISE_JOB, { sitterId });
  return readTemplate(tx, sitterId, now);
}
