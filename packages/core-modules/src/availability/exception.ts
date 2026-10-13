/**
 * EXCEPTIONS (SD 1103–1104; `T-089.md` Q3/Q4; B.3 OE-32 U-5 (1a)/(2)/(3a), U-6 (a), U-22; OD-335).
 *
 * `addException` inserts ONE `availability_exception` row and enqueues `search.slot_materialise`
 * on the same `Tx`. Insert-only (U-6 (a)): a mistake is corrected by an opposite exception, which
 * wins because the materialiser applies a date's exceptions in (`created_at`, `id`) order (amended
 * E.3 U-14, OD-335). So:
 *   - `created_at` is NEVER sent: the column default (`now()`) writes it, so the order is the
 *     database's clock, not a client's (BOARD brief, OD-335 triage);
 *   - `id` is a monotonic ULID (`ids.ts`), so two exceptions written in one transaction — which
 *     share `created_at` — order by write order.
 *
 * Validation (the same rules `0029`'s CHECKs hold, refused here first as a 400 with the field
 * name, never the value): `kind` is `ADD` or `REMOVE`; both times set with `endLocal > startLocal`
 * (`24:00` allowed as an end, C7 (a)), or both NULL for a whole-day `REMOVE` only (U-5 (1a));
 * `reason` at most 200 characters (U-22: a sitter-private note, never shown to parents).
 *
 * NOT HERE: the `422 conflicts_with_confirmed_booking` check on `REMOVE` (SD 1103) reads `booking`,
 * which this ticket never reads (role row T-089; OD-136) — `T-162` / `T-091`. The HTTP routes are
 * not built (see `state/EP-9/T-089.md` § Implementation › What I did not do).
 *
 * `availableNow` (SD 1104, U-5 (3a)) turns `{ hours: 1..8 }` at `now` into the ADD rows: one, or
 * two when the window passes local midnight (`start–24:00` on day D and `00:00–end` on D+1).
 */
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  ianaZone,
  instantToLocal,
  InvalidInputError,
  type IanaZone,
  type Ulid,
} from '@kinvara/domain-types';
import type { JobEnqueuer } from '../jobs/index.ts';
import type { Tx } from '../runtime/index.ts';
import { dayNumber, minutesOfTime } from './civil.ts';
import { newAvailabilityId } from './ids.ts';
import { SLOT_MATERIALISE_JOB } from './jobs.ts';

const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/;

export const REASON_MAX_CHARS = 200;

export const ExceptionInput = z
  .strictObject({
    date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    kind: z.enum(['ADD', 'REMOVE']),
    startLocal: z.string().regex(HHMM).nullable(),
    endLocal: z.string().regex(HHMM).nullable(),
    tz: z.string(),
    reason: z.string().max(REASON_MAX_CHARS).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.startLocal === null && e.endLocal === null) {
      if (e.kind !== 'REMOVE')
        ctx.addIssue({ code: 'custom', path: ['startLocal'], message: 'U-5 (1a)' });
      return;
    }
    if (e.startLocal === null || e.endLocal === null) {
      ctx.addIssue({
        code: 'custom',
        path: [e.startLocal === null ? 'startLocal' : 'endLocal'],
        message: 'U-5 (2)',
      });
      return;
    }
    if (minutesOfTime(e.endLocal) <= minutesOfTime(e.startLocal)) {
      ctx.addIssue({ code: 'custom', path: ['endLocal'], message: 'U-5 (2)' });
    }
  });
export type ExceptionBody = z.input<typeof ExceptionInput>;

const FIELDS = new Set(['date', 'kind', 'startLocal', 'endLocal', 'tz', 'reason']);

export interface AddedException {
  readonly id: Ulid;
}

export async function addException(
  tx: Tx,
  enqueuer: JobEnqueuer,
  sitterId: Ulid,
  body: unknown,
): Promise<AddedException> {
  const parsed = ExceptionInput.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.path[0];
    throw new InvalidInputError(
      typeof first === 'string' && FIELDS.has(first) ? { field: first } : {},
    );
  }
  const e = parsed.data;
  const tz = ianaZone(e.tz, 'tz');
  dayNumber(e.date, 'date');
  const id = newAvailabilityId();
  await tx.execute(
    sql`INSERT INTO public.availability_exception
          (id, sitter_id, on_date, kind, start_local, end_local, tz, reason)
        VALUES (${id}, ${sitterId}, ${e.date}::date, ${e.kind}, ${e.startLocal}::time,
                ${e.endLocal}::time, ${tz}, ${e.reason ?? null})`,
  );
  await enqueuer.enqueue(tx, SLOT_MATERIALISE_JOB, { sitterId });
  return { id };
}

export const AvailableNowInput = z.strictObject({ hours: z.number().int().min(1).max(8) });

/**
 * The ADD exception bodies for "available now" (SD 1104): from `now` (to the minute, rounded
 * DOWN) for `hours`, in `zone`. The end is the instant `now + hours`, read back as a wall time, so
 * a DST change inside the window is honoured. Past local midnight it is two rows (U-5 (3a)).
 */
export function availableNowBodies(now: Date, hours: number, zone: IanaZone): ExceptionBody[] {
  const parsed = AvailableNowInput.safeParse({ hours });
  if (!parsed.success) throw new InvalidInputError({ field: 'hours' });
  const startMs = Math.floor(now.getTime() / 60_000) * 60_000;
  const start = instantToLocal(new Date(startMs), zone);
  const end = instantToLocal(new Date(startMs + parsed.data.hours * 3_600_000), zone);
  if (end.date === start.date) {
    return [
      { date: start.date, kind: 'ADD', startLocal: start.time, endLocal: end.time, tz: zone },
    ];
  }
  const rows: ExceptionBody[] = [
    { date: start.date, kind: 'ADD', startLocal: start.time, endLocal: '24:00', tz: zone },
  ];
  if (end.time !== '00:00') {
    rows.push({ date: end.date, kind: 'ADD', startLocal: '00:00', endLocal: end.time, tz: zone });
  }
  return rows;
}

/** `available-now` as a service: the bodies, each inserted by `addException` (one job each). */
export async function addAvailableNow(
  tx: Tx,
  enqueuer: JobEnqueuer,
  sitterId: Ulid,
  hours: number,
  tz: string,
  now: Date = new Date(),
): Promise<AddedException[]> {
  const added: AddedException[] = [];
  for (const body of availableNowBodies(now, hours, ianaZone(tz, 'tz'))) {
    added.push(await addException(tx, enqueuer, sitterId, body));
  }
  return added;
}
