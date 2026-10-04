/**
 * The Staffed-Hours generator (SD §DB-15 3236–3242; SA §DA-14, D11): an authored
 * `StaffedPatternV1` and an `effective_from` date → the absolute UTC intervals a schedule version
 * holds in `staffed_interval` (T-206's table).
 *
 * The rules it implements, each from a binding source:
 *   - Horizon (Part E.2 U-7): every local date d with effective_from <= d < effective_from + 18
 *     calendar months. An interval is attributed to the local date it STARTS on, so the last one
 *     may end after the horizon's last date.
 *   - Season (OE-31 U-9 (a)): an interval takes the season of the local date it starts on. A
 *     season runs from its startsOn (inclusive) to the next season's startsOn in calendar order,
 *     wrapping the year (E.2 U-14).
 *   - Weekday (Part F C9 (b)): 0 = Monday … 6 = Sunday.
 *   - Horizon end (OE-78 (2)): effective_from + 18 calendar months, CLAMPED to the target month's
 *     last day when that day does not exist (31 Aug 2026 → 29 Feb 2028, so the last date is 28 Feb).
 *   - Each instant is computed from (local date, local time, zone) by `resolveLocal`, never by
 *     adding hours to another instant (SD §DB-6 rule 2). A block ending next day ends on d + 1.
 *     A local time in a spring-forward gap resolves forward to the transition instant, and an
 *     ambiguous one to the first (pre-transition) instant (SD §DB-6 rules 3–4, as `time.ts`
 *     implements them).
 *   - Every bound moved forward out of a spring gap is REPORTED, not stored (OE-78 (4)): one
 *     `spring_gap_shift` adjustment naming the interval id and the bound.
 *   - A block that resolves to an empty span on a date (its start in the gap, its end in the gap or
 *     at the gap's end) is SKIPPED for that date and REPORTED as `spring_gap_empty`, with no id
 *     (OE-78 (1)). It is not an error.
 *   - Durations are whatever those instants give: a window spanning 03:00–04:00 local is an hour
 *     shorter in March and longer in October (Part F C4 (a), EV-29).
 *   - Every interval is half-open [startsAt, endsAt) with finite bounds (T-206 EV-28 / OE-77).
 *   - Each interval carries its own ULID (A.2 U-1, EV-27).
 *
 * Refusals: `pattern_invalid` (the schema, which since OE-78 (3) also refuses blocks of two
 * seasons that overlap across a season boundary), `effective_from_invalid`, and `intervals_overlap`
 * — a defensive backstop that no pattern the schema accepts reaches (see `assertDisjoint`).
 */
import { randomBytes } from 'node:crypto';
import { resolveLocal, ulid, type Ulid } from '@kinvara/domain-types';
import {
  addCalendarMonths,
  formatCivilDate,
  fromDayNumber,
  parseCivilDate,
  toDayNumber,
  weekdayMonday0,
} from './civil-date.ts';
import { StaffedPatternV1, type StaffedSeason } from './pattern.ts';

/** Part E.2 U-7 / SD 3174: each version covers 18 calendar months from effective_from. */
export const HORIZON_MONTHS = 18;

export type GenerationFailure = 'pattern_invalid' | 'effective_from_invalid' | 'intervals_overlap';

/**
 * Thrown by `generateStaffedIntervals`. `reason` says which rule refused; `localDate` names the
 * local date concerned where there is one. Carries no pattern content.
 */
export class StaffedGenerationError extends Error {
  readonly reason: GenerationFailure;
  readonly localDate: string | undefined;
  constructor(reason: GenerationFailure, localDate?: string) {
    super(reason);
    this.name = 'StaffedGenerationError';
    this.reason = reason;
    this.localDate = localDate;
  }
}

export interface StaffedInterval {
  /** The `staffed_interval.id` ULID (A.2 U-1). */
  readonly id: Ulid;
  /** Inclusive lower bound, an absolute instant. */
  readonly startsAt: Date;
  /** Exclusive upper bound, an absolute instant; always later than `startsAt`. */
  readonly endsAt: Date;
  /** The local date (in the pattern's zone) the interval starts on and is attributed to. */
  readonly localDate: string;
  /** The `key` of the season that date falls in. */
  readonly season: string;
  /** 0 = Monday … 6 = Sunday, of `localDate`. */
  readonly weekday: number;
}

/** A local wall-clock reading in the pattern's zone. */
export interface LocalTime {
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** `HH:MM` */
  readonly time: string;
}

/**
 * What the publisher's preview shows (OE-78 (1), (4)). Nothing here is stored.
 *   - `spring_gap_shift`: interval `id`'s `bound` was authored at `localRequested`, a wall-clock time
 *     that does not exist (spring-forward gap); `utcUsed` is the instant used instead (the
 *     transition, SD §DB-6 rule 3).
 *   - `spring_gap_empty`: the block authored `localStart`–`localEnd` for `localDate` resolved to
 *     the single instant `utcUsed`, so no interval exists for it on that date.
 */
export type StaffedAdjustment =
  | {
      readonly reason: 'spring_gap_shift';
      readonly id: Ulid;
      readonly bound: 'lower' | 'upper';
      readonly localRequested: LocalTime;
      readonly utcUsed: Date;
    }
  | {
      readonly reason: 'spring_gap_empty';
      readonly localDate: string;
      readonly season: string;
      readonly weekday: number;
      readonly localStart: LocalTime;
      readonly localEnd: LocalTime;
      readonly utcUsed: Date;
    };

export interface StaffedGeneration {
  /** Sorted by `startsAt`, pairwise disjoint. */
  readonly intervals: readonly StaffedInterval[];
  /** In generation order: local date ascending, then the season's block order; lower before upper. */
  readonly adjustments: readonly StaffedAdjustment[];
}

export interface GenerateOptions {
  /** Supplies interval ids. Default: a fresh ULID from `node:crypto`. Each value must be a ULID. */
  readonly newId?: () => string;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(value: bigint, length: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD.charAt(Number(rest % 32n)) + out;
    rest /= 32n;
  }
  return out;
}

/** 48 bits of millisecond time and 80 random bits, Crockford base32, upper case. */
export function newIntervalId(): Ulid {
  const text =
    base32(BigInt(Date.now()), 10) + base32(BigInt(`0x${randomBytes(10).toString('hex')}`), 16);
  return ulid(text, 'id');
}

/** The season `mmdd` falls in: the latest startsOn <= mmdd, else (wrapping) the latest overall. */
function seasonFor(sorted: readonly StaffedSeason[], mmdd: string): StaffedSeason {
  let found = sorted[sorted.length - 1];
  for (const s of sorted) if (s.startsOn <= mmdd) found = s;
  // `sorted` is non-empty: the schema requires 1–12 seasons.
  return found as StaffedSeason;
}

/**
 * The generator's own postcondition: `spans` sorted by start, and no two overlapping. The schema
 * refuses every within-season and cross-season wall-clock overlap (OE-78 (3)), and wall time →
 * instant is non-decreasing under `resolveLocal`'s rules (a gap time moves to the transition, an
 * ambiguous one to its first instant), so no accepted pattern reaches the throw. It stays as a
 * backstop for the table's EXCLUDE and is tested directly.
 */
export function assertDisjoint(
  spans: readonly { readonly startsAt: Date; readonly endsAt: Date; readonly localDate: string }[],
): void {
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const cur = spans[i];
    if (prev !== undefined && cur !== undefined && prev.endsAt.getTime() > cur.startsAt.getTime()) {
      throw new StaffedGenerationError('intervals_overlap', cur.localDate);
    }
  }
}

/**
 * The intervals of one schedule version and the spring-gap adjustments made generating them.
 * `pattern` is parsed here, whatever its static type.
 */
export function generateStaffedIntervals(
  pattern: unknown,
  effectiveFrom: string,
  options: GenerateOptions = {},
): StaffedGeneration {
  const parsed = StaffedPatternV1.safeParse(pattern);
  if (!parsed.success) throw new StaffedGenerationError('pattern_invalid');
  const p = parsed.data;
  const zone = p.zone as Parameters<typeof resolveLocal>[1];

  const from = parseCivilDate(effectiveFrom);
  if (from === undefined) throw new StaffedGenerationError('effective_from_invalid');
  const until = addCalendarMonths(from, HORIZON_MONTHS);

  const seasons = [...p.seasons].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  const newId = options.newId ?? newIntervalId;
  const intervals: StaffedInterval[] = [];
  const adjustments: StaffedAdjustment[] = [];

  for (let n = toDayNumber(from); n < toDayNumber(until); n++) {
    const day = fromDayNumber(n);
    const localDate = formatCivilDate(day);
    const nextDate = formatCivilDate(fromDayNumber(n + 1));
    const season = seasonFor(seasons, localDate.slice(5));
    const weekday = weekdayMonday0(day);
    for (const block of season.blocks) {
      if (block.weekday !== weekday) continue;
      const localStart = { date: localDate, time: block.start };
      const localEnd = { date: block.endsNextDay ? nextDate : localDate, time: block.end };
      const start = resolveLocal(localStart, zone);
      const end = resolveLocal(localEnd, zone);
      if (end.instant.getTime() <= start.instant.getTime()) {
        adjustments.push({
          reason: 'spring_gap_empty',
          localDate,
          season: season.key,
          weekday,
          localStart,
          localEnd,
          utcUsed: start.instant,
        });
        continue;
      }
      const id = ulid(newId(), 'id');
      for (const [bound, local, r] of [
        ['lower', localStart, start],
        ['upper', localEnd, end],
      ] as const) {
        if (r.kind === 'gap') {
          adjustments.push({
            reason: 'spring_gap_shift',
            id,
            bound,
            localRequested: local,
            utcUsed: r.instant,
          });
        }
      }
      intervals.push({
        id,
        startsAt: start.instant,
        endsAt: end.instant,
        localDate,
        season: season.key,
        weekday,
      });
    }
  }

  intervals.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  assertDisjoint(intervals);
  return { intervals, adjustments };
}

/**
 * The three parallel arrays T-080.md Q2 binds (as `pool.query` / `sql.param` values, never by
 * interpolation): ids, and each bound as a UTC ISO-8601 instant with `Z`, which PostgreSQL reads
 * as the same instant under any session TimeZone.
 */
export function intervalArrays(intervals: readonly StaffedInterval[]): {
  ids: string[];
  startsAt: string[];
  endsAt: string[];
} {
  return {
    ids: intervals.map((i) => i.id),
    startsAt: intervals.map((i) => i.startsAt.toISOString()),
    endsAt: intervals.map((i) => i.endsAt.toISOString()),
  };
}
