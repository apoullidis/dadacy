/**
 * THE PURE MATERIALISER (T-089; SD §DB-5 line 2268, SA §DA-3; rulings `OE-30-34-rulings.md` E.3 and
 * Part F, OD-335). From a sitter's template rows and exception rows it computes the free set over
 * the horizon, as sorted, half-open, pairwise disjoint and NON-TOUCHING spans. It reads nothing
 * and writes nothing: `persist.ts` feeds it the rows and writes what it returns.
 *
 * THE ORDER, exactly as amended E.3 U-14 states it (OD-335 triage, 2026-10-13T08:58:41Z):
 *   1. templates: every block occurrence on every local date the row is live on;
 *   2. then the exceptions, sorted by (`on_date`, `created_at`, `id`): each one, in turn, ADDs its
 *      window (union) or REMOVEs it (difference) — so on one local date a later exception
 *      overrides earlier ones over the window it covers, and a mistaken `REMOVE` is undone by a
 *      later `ADD` (B.3 OE-32 U-6 (a) stays true). Exceptions on different local dates of one
 *      zone cover disjoint windows, so sorting by `on_date` first changes no result;
 *   3. then C11 / U-8's subtractions — NOT IN THIS TICKET: both need bookings, and this
 *      materialiser never reads `booking` (role row T-089 as amended; OD-136). `T-162` adds them
 *      between step 2 and step 4;
 *   4. then U-14 (a): coalesce into maximal disjoint spans — overlapping or touching spans
 *      (`[a,b)`, `[b,c)`) become one, across local midnight and between a block and an ADD.
 * Finally the set is clipped to the horizon and emptied unless the sitter is `bookable`.
 *
 * LIVENESS OF A TEMPLATE ROW ON A DATE (E.3 U-2): `effective_from <= d` and (`effective_to IS
 * NULL` or `effective_to >= d`). A voided row (`effective_to < effective_from`) is live on no date.
 *
 * WALL TIME → INSTANT (E.3 U-16 (a)): each occurrence is resolved from (local date, local time,
 * the row's `tz`) every time, by `resolveLocal`: a nonexistent wall time resolves to the
 * transition instant, an ambiguous one to the first (pre-transition) instant. An occurrence whose
 * resolved end is not after its resolved start is dropped. No note is written.
 *
 * WEEKDAYS (C9 (b)): 0 = Monday … 6 = Sunday.
 *
 * HORIZON (C10 (a), Part F; brief addendum F): from local today 00:00 in the horizon zone to local
 * (today + 56 days) 00:00, half-open. The horizon zone is `HORIZON_ZONE` (see its comment).
 *
 * BOOKABLE (E.3 U-12 (a)): unless `bookable`, the result is empty.
 *
 * Never clipped to Staffed Hours (`T-089.md` U-17; SD 3268), and nothing here compares a time of
 * day with a schedule: every comparison is between instants.
 */
import { ianaZone, InvalidInputError, type IanaZone } from '@kinvara/domain-types';
import { addDays, dayNumber, localInstant, minutesOfTime, weekdayMonday0 } from './civil.ts';

/**
 * The zone "local today" is read in for the horizon (C10 (a): "local today 00:00 in the sitter's
 * `tz`"). `sitter_profile` has no `tz` column (`0025`); the only zone SD names is the
 * `tz text NOT NULL DEFAULT 'Europe/Nicosia'` of the two rule tables (SD 2242, 2251), and the
 * service area is the Republic of Cyprus alone. Each template and exception row is still
 * resolved in its OWN `tz`; this zone only fixes where the horizon starts and ends.
 */
export const HORIZON_ZONE: IanaZone = ianaZone('Europe/Nicosia', 'tz');

/** C10 (a): +56 local days. */
export const HORIZON_DAYS = 56;

/** One `availability_template` row, as read (times as Postgres prints them, or `HH:MM`). */
export interface TemplateRow {
  readonly weekday: number;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly tz: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** One `availability_exception` row, as read. */
export interface ExceptionRow {
  readonly id: string;
  readonly onDate: string;
  readonly kind: 'ADD' | 'REMOVE';
  readonly startLocal: string | null;
  readonly endLocal: string | null;
  readonly tz: string;
  readonly createdAt: Date;
}

export interface MaterialiseInput {
  readonly bookable: boolean;
  readonly templates: readonly TemplateRow[];
  readonly exceptions: readonly ExceptionRow[];
  /** Local today (`YYYY-MM-DD`) in `HORIZON_ZONE`: the caller reads it from the clock once. */
  readonly today: string;
}

/** A half-open span `[startsAt, endsAt)`. */
export interface Span {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** Half-open `[s, e)` in epoch milliseconds. */
type Interval = readonly [number, number];

/**
 * Union of a sorted, disjoint, non-touching set with one interval. Touching intervals merge:
 * U-14 (a) is applied at every step, so the set is always coalesced.
 */
export function unionInterval(set: readonly Interval[], add: Interval): Interval[] {
  const [s, e] = add;
  if (e <= s) return [...set];
  const out: Interval[] = [];
  let lo = s;
  let hi = e;
  let placed = false;
  for (const [a, b] of set) {
    if (b < lo) {
      out.push([a, b]);
    } else if (a > hi) {
      if (!placed) {
        out.push([lo, hi]);
        placed = true;
      }
      out.push([a, b]);
    } else {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
  }
  if (!placed) out.push([lo, hi]);
  return out;
}

/** Difference of a sorted, disjoint set and one interval. */
export function subtractInterval(set: readonly Interval[], cut: Interval): Interval[] {
  const [s, e] = cut;
  if (e <= s) return [...set];
  const out: Interval[] = [];
  for (const [a, b] of set) {
    if (b <= s || a >= e) {
      out.push([a, b]);
      continue;
    }
    if (a < s) out.push([a, s]);
    if (b > e) out.push([e, b]);
  }
  return out;
}

function zoneOf(tz: string): IanaZone {
  return ianaZone(tz, 'tz');
}

/** The resolved interval of one block occurrence on `date`, or undefined when it resolves empty. */
function occurrence(
  date: string,
  start: number,
  end: number,
  zone: IanaZone,
): Interval | undefined {
  const s = localInstant(date, start, zone);
  const e = localInstant(date, end, zone);
  return e > s ? [s, e] : undefined;
}

/** Sort key for the exception order (amended E.3 U-14, OD-335): `on_date`, `created_at`, `id`. */
export function compareExceptions(x: ExceptionRow, y: ExceptionRow): number {
  if (x.onDate !== y.onDate) return x.onDate < y.onDate ? -1 : 1;
  const dt = x.createdAt.getTime() - y.createdAt.getTime();
  if (dt !== 0) return dt;
  if (x.id === y.id) return 0;
  return x.id < y.id ? -1 : 1;
}

/** The horizon `[start, end)` in epoch ms for local `today` in `HORIZON_ZONE`. */
export function horizonOf(today: string): Interval {
  return [
    localInstant(today, 0, HORIZON_ZONE),
    localInstant(addDays(today, HORIZON_DAYS), 0, HORIZON_ZONE),
  ];
}

export function materialise(input: MaterialiseInput): Span[] {
  if (!input.bookable) return [];
  const [hStart, hEnd] = horizonOf(input.today);
  const first = dayNumber(input.today, 'today');
  let free: Interval[] = [];

  // 1. Templates. A row in another zone than HORIZON_ZONE can put a local date's block up to a day
  //    either side of the horizon, so one extra date is walked at each end and the clip below
  //    trims it.
  for (const row of input.templates) {
    if (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6) {
      throw new InvalidInputError({ field: 'weekday' });
    }
    const zone = zoneOf(row.tz);
    const start = minutesOfTime(row.startLocal, 'startLocal');
    const end = minutesOfTime(row.endLocal, 'endLocal');
    const from = dayNumber(row.effectiveFrom, 'effectiveFrom');
    const to = row.effectiveTo === null ? Infinity : dayNumber(row.effectiveTo, 'effectiveTo');
    for (let n = first - 1; n <= first + HORIZON_DAYS; n++) {
      if (n < from || n > to) continue;
      const date = addDays(input.today, n - first);
      if (weekdayMonday0(date) !== row.weekday) continue;
      const hit = occurrence(date, start, end, zone);
      if (hit !== undefined) free = unionInterval(free, hit);
    }
  }

  // 2. Exceptions, in (on_date, created_at, id) order; each later one overrides earlier ones over
  //    the window it covers.
  for (const ex of [...input.exceptions].sort(compareExceptions)) {
    const zone = zoneOf(ex.tz);
    let window: Interval | undefined;
    if (ex.startLocal === null && ex.endLocal === null) {
      // U-5 (1a): both NULL is the whole local day, REMOVE only (`0029` refuses an ADD with no
      // times). The day is [d 00:00, d+1 00:00) in the row's zone, each end resolved.
      if (ex.kind !== 'REMOVE') throw new InvalidInputError({ field: 'kind' });
      window = occurrence(ex.onDate, 0, 1440, zone);
    } else if (ex.startLocal !== null && ex.endLocal !== null) {
      window = occurrence(
        ex.onDate,
        minutesOfTime(ex.startLocal, 'startLocal'),
        minutesOfTime(ex.endLocal, 'endLocal'),
        zone,
      );
    } else {
      // `availability_exception_times_paired` refuses this row; refuse it here too.
      throw new InvalidInputError({ field: 'endLocal' });
    }
    if (window === undefined) continue;
    free = ex.kind === 'ADD' ? unionInterval(free, window) : subtractInterval(free, window);
  }

  // 3. (T-162: bookings plus buffers, and U-8's limits, are subtracted here.)

  // 4. Clip to the horizon. The set is already coalesced (every union merges touching spans).
  free = subtractInterval(subtractInterval(free, [-Infinity, hStart]), [hEnd, Infinity]);
  return free.map(([s, e]) => ({ startsAt: new Date(s), endsAt: new Date(e) }));
}
