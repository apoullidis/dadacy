/**
 * `StaffedPatternV1` — the authored weekly Staffed-Hours pattern with its seasonal boundaries, as
 * stored verbatim in `staffed_schedule_version.pattern` (SD 3167–3169). T-080's published contract.
 *
 * The shape and every rule below are Part E.2 U-14 of `tasks/state/EP-2/OE-30-34-rulings.md`
 * (binding under OE-49): `{ schema: 1, zone, seasons }`, `Season = { key, startsOn: 'MM-DD',
 * blocks }`, `Block = { weekday 0..6, start: 'HH:MM', end: 'HH:MM', endsNextDay }`; every object
 * strict; 1–12 seasons with unique `startsOn`; `endsNextDay: false` requires `end > start`,
 * `endsNextDay: true` requires `end <= start`; within a season no two blocks overlap once laid on
 * the local week, next-day tails counted. Weekday numbering is Part F C9 (b): 0 = Monday.
 *
 * OE-78 (3) adds one rule: across each season boundary, a block of the season that ends with a
 * next-day tail must not overlap a block of the next season on its first day. The boundary date
 * falls on a different weekday each year, so the rule is checked for EVERY weekday: season S's
 * blocks on weekday w (tails only) against season N's blocks on weekday w + 1 (mod 7), on the
 * day-axis [0, 1440) of N's first day. Seasons are taken in calendar order of `startsOn`, the
 * last one wrapping onto the first; a single season has no boundary.
 *
 * Which windows a version contains is the publisher's content decision, not this schema's.
 */
import { z } from 'zod';
import { ianaZone, type IanaZone } from '@kinvara/domain-types';
import { parseCivilDate } from './civil-date.ts';

const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const MMDD = /^[0-9]{2}-[0-9]{2}$/;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** `HH:MM` → minutes after local midnight. Only called on strings `HHMM` accepted. */
export function minutesOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

const Block = z
  .strictObject({
    weekday: z.int().min(0).max(6),
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
    endsNextDay: z.boolean(),
  })
  .refine((b) => (b.endsNextDay ? b.end <= b.start : b.end > b.start), {
    message: 'endsNextDay must be true exactly when end <= start',
    path: ['end'],
  });

const Season = z.strictObject({
  key: z.string().regex(/^[a-z_]{1,32}$/),
  // A day that exists in a leap year: 02-29 is accepted. In a common year no date equals it, so
  // that season begins on 03-01 (the season rule compares MM-DD in calendar order).
  startsOn: z
    .string()
    .regex(MMDD)
    .refine((md) => parseCivilDate(`2000-${md}`) !== undefined, { message: 'not a calendar day' }),
  blocks: z.array(Block),
});

/** A block laid on the local week: [from, to) in minutes after Monday 00:00, to may pass 10080. */
function weekSpan(b: z.infer<typeof Block>): readonly [number, number] {
  const from = b.weekday * MINUTES_PER_DAY + minutesOfDay(b.start);
  const to =
    b.weekday * MINUTES_PER_DAY + minutesOfDay(b.end) + (b.endsNextDay ? MINUTES_PER_DAY : 0);
  return [from, to];
}

/** Half-open overlap on the week circle: a Sunday tail wraps onto Monday. */
function overlapsOnWeek(a: readonly [number, number], b: readonly [number, number]): boolean {
  for (const shift of [-MINUTES_PER_WEEK, 0, MINUTES_PER_WEEK]) {
    if (a[0] < b[1] + shift && b[0] + shift < a[1]) return true;
  }
  return false;
}

/**
 * Cross-season overlap (OE-78 (3)): the next-day tails of `prev`'s blocks against `next`'s blocks
 * that start on the following weekday, half-open, on one day's minutes. Returns `[i, j]` pairs.
 */
function boundaryOverlaps(
  prev: readonly z.infer<typeof Block>[],
  next: readonly z.infer<typeof Block>[],
): [number, number][] {
  const found: [number, number][] = [];
  prev.forEach((a, i) => {
    if (!a.endsNextDay) return;
    const tailEnd = minutesOfDay(a.end);
    next.forEach((b, j) => {
      if (b.weekday !== (a.weekday + 1) % 7) return;
      // The tail is [0, tailEnd) of that day; b starts at a minute >= 0 and is non-empty, so they
      // overlap exactly when b starts before the tail ends.
      if (minutesOfDay(b.start) < tailEnd) found.push([i, j]);
    });
  });
  return found;
}

export const StaffedPatternV1 = z
  .strictObject({
    schema: z.literal(1),
    zone: z.string().refine(
      (zone) => {
        try {
          ianaZone(zone, 'zone');
          return true;
        } catch {
          return false;
        }
      },
      { message: 'not an IANA zone name' },
    ),
    seasons: z.array(Season).min(1).max(12),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.seasons.forEach((season, s) => {
      if (seen.has(season.startsOn)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate startsOn',
          path: ['seasons', s, 'startsOn'],
        });
      }
      seen.add(season.startsOn);
      const spans = season.blocks.map(weekSpan);
      for (let i = 0; i < spans.length; i++) {
        for (let j = i + 1; j < spans.length; j++) {
          const a = spans[i];
          const b = spans[j];
          if (a !== undefined && b !== undefined && overlapsOnWeek(a, b)) {
            ctx.addIssue({
              code: 'custom',
              message: `blocks ${String(i)} and ${String(j)} overlap on the local week`,
              path: ['seasons', s, 'blocks', j],
            });
          }
        }
      }
    });
    if (p.seasons.length < 2) return;
    const order = p.seasons
      .map((season, index) => ({ season, index }))
      .sort((a, b) => (a.season.startsOn < b.season.startsOn ? -1 : 1));
    // Each season's predecessor in calendar order. A season starting 02-29 directly followed by one
    // starting 03-01 has no day in a common year, so the season before it also precedes the 03-01
    // season: both pairs are checked.
    const pairs: [(typeof order)[number], (typeof order)[number]][] = [];
    order.forEach((next, k) => {
      const prev = order[(k + order.length - 1) % order.length] as (typeof order)[number];
      pairs.push([prev, next]);
      const prevPrev = order[(k + order.length - 2) % order.length] as (typeof order)[number];
      if (
        prev.season.startsOn === '02-29' &&
        next.season.startsOn === '03-01' &&
        order.length > 2
      ) {
        pairs.push([prevPrev, next]);
      }
    });
    for (const [prev, { season: next, index: n }] of pairs) {
      for (const [i, j] of boundaryOverlaps(prev.season.blocks, next.blocks)) {
        ctx.addIssue({
          code: 'custom',
          message: `block ${String(j)} of season ${next.key} overlaps block ${String(i)} of season ${prev.season.key}, whose next-day tail runs into the boundary day ${next.startsOn}`,
          path: ['seasons', n, 'blocks', j],
        });
      }
    }
  });

export type StaffedPatternV1 = z.infer<typeof StaffedPatternV1> & { readonly zone: IanaZone };
export type StaffedSeason = StaffedPatternV1['seasons'][number];
export type StaffedBlock = StaffedSeason['blocks'][number];

/**
 * Parse and validate; `success: false` carries Zod's issues. For the values `pattern.test.ts` plants (a
 * zone string, a weekday number, a time string) the issues do not echo them; an unrecognised KEY's
 * name IS named. That is a test of these cases, not a Zod guarantee.
 */
export function parseStaffedPatternV1(
  input: unknown,
): { success: true; data: StaffedPatternV1 } | { success: false; issues: z.core.$ZodIssue[] } {
  const r = StaffedPatternV1.safeParse(input);
  if (!r.success) return { success: false, issues: r.error.issues };
  return { success: true, data: r.data as StaffedPatternV1 };
}
