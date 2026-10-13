/**
 * PUBLIC AVAILABILITY (SD 1100 `GET /v1/sitters/{id}/availability?from&to` — "materialised slots
 * (public, coarse)"; B.3 OE-32 U-13 as accepted under OE-50 and brief addendum F: "public
 * availability in whole-hour spans, rounded inward").
 *
 * `wholeHourSpans` rounds each span INWARD to whole hours of `zone`'s wall clock: the start up to
 * the next local hour boundary (unchanged when already on one), the end down to the previous one;
 * a span with nothing left is dropped. So a published span never shows time the sitter has not
 * declared. A local hour boundary is found from the instant's own wall-clock reading (minutes and
 * seconds into the local hour), so it holds for a zone whose offset is not a whole number of hours.
 *
 * `readPublicAvailability` is the read: slots overlapping `[from, to)`, clipped to it, then
 * rounded. The HTTP route is not built (see `state/EP-9/T-089.md` § Implementation › What I did
 * not do).
 */
import { sql } from 'drizzle-orm';
import { instantToLocal, type IanaZone, type Ulid } from '@kinvara/domain-types';
import type { Tx } from '../runtime/index.ts';
import { HORIZON_ZONE, type Span } from './materialise.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Milliseconds past the local whole hour at `ms` in `zone`. */
function pastLocalHour(ms: number, zone: IanaZone): number {
  const minutes = Number(instantToLocal(new Date(ms), zone).time.slice(3, 5));
  return minutes * MINUTE + (((ms % MINUTE) + MINUTE) % MINUTE);
}

export function wholeHourSpans(spans: readonly Span[], zone: IanaZone = HORIZON_ZONE): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const s = span.startsAt.getTime();
    const e = span.endsAt.getTime();
    const sPast = pastLocalHour(s, zone);
    const start = sPast === 0 ? s : s - sPast + HOUR;
    const end = e - pastLocalHour(e, zone);
    if (end > start) out.push({ startsAt: new Date(start), endsAt: new Date(end) });
  }
  return out;
}

interface SlotRow extends Record<string, unknown> {
  readonly s: Date | string;
  readonly e: Date | string;
}

function asDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

export async function readPublicAvailability(
  tx: Tx,
  sitterId: Ulid,
  from: Date,
  to: Date,
): Promise<Span[]> {
  const rows = (
    await tx.execute<SlotRow>(
      sql`SELECT greatest(lower(span), ${from.toISOString()}::timestamptz) AS s,
                 least(upper(span), ${to.toISOString()}::timestamptz) AS e
            FROM public.availability_slot
           WHERE sitter_id = ${sitterId}
             AND span && tstzrange(${from.toISOString()}::timestamptz,
                                   ${to.toISOString()}::timestamptz, '[)')
           ORDER BY lower(span)`,
    )
  ).rows;
  return wholeHourSpans(rows.map((r) => ({ startsAt: asDate(r.s), endsAt: asDate(r.e) })));
}
