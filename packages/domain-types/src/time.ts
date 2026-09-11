/**
 * time.ts — SD §FE-7: "Server-side date maths uses Luxon (IANA-aware) … the
 * choice is isolated behind `packages/domain-types/time.ts` so the swap is one
 * file." SD §DB-6 rule 7: all server-side date arithmetic goes through here.
 *
 * Luxon is imported by this file and by no other file in the package.
 *
 * The resolution rules implemented are SD §DB-6's:
 *   2. an occurrence's instant is computed from (date, local time, zone) every
 *      time — `resolveLocal` — never by adding 7×24 h to the previous instant;
 *   3. a spring-forward GAP resolves forward to the first valid instant, and
 *      the caller is told (`kind: 'gap'`) so it can write the occurrence note;
 *   4. an autumn-back AMBIGUITY resolves to the first (pre-transition)
 *      instant; the later one is returned too (`kind: 'ambiguous'`);
 *   5. a duration is the difference of two instants, never of wall clocks.
 *
 * "First valid instant" (rule 3) is read literally: the transition instant
 * itself. So 03:30 in Nicosia's 03:00–04:00 gap resolves to 04:00 local, not
 * 04:30 (Luxon's own default shifts by the gap's length).
 */
import { DateTime, IANAZone } from 'luxon';
import type { Brand } from './brand.ts';
import { InvalidInputError } from './errors.ts';

export type IanaZone = Brand<string, 'IanaZone'>;

/**
 * `UTC`, or `Area/Location[/…]`. This refuses what an IANA database would
 * accept but a booking must never carry: UTC-offset strings (`+02:00`, which
 * Node's `Intl` accepts as a time zone) and the single-segment legacy names
 * (`EET`, `CET`, `EST5EDT`).
 */
const ZONE_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** Returns the input unchanged when valid: no case or link canonicalisation. */
export function ianaZone(value: unknown, field: string): IanaZone {
  if (typeof value !== 'string' || !ZONE_SHAPE.test(value) || !IANAZone.isValidZone(value)) {
    throw new InvalidInputError({ field });
  }
  return value as IanaZone;
}

export interface LocalDateTime {
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** `HH:mm`, 00:00–23:59 */
  readonly time: string;
}

export type LocalResolution =
  | { readonly kind: 'exact'; readonly instant: Date }
  | { readonly kind: 'gap'; readonly instant: Date }
  | { readonly kind: 'ambiguous'; readonly instant: Date; readonly later: Date };

function offsetMinutesAt(ms: number, zone: IanaZone): number {
  return DateTime.fromMillis(ms, { zone }).offset;
}

/** The instant(s) at which `local` is the wall-clock time in `zone` (SD §DB-6 rules 2–4). */
export function resolveLocal(local: LocalDateTime, zone: IanaZone): LocalResolution {
  if (!DATE.test(local.date)) throw new InvalidInputError({ field: 'date' });
  if (!TIME.test(local.time)) throw new InvalidInputError({ field: 'time' });
  const wall = DateTime.fromISO(`${local.date}T${local.time}`, { zone: 'UTC' });
  if (!wall.isValid) throw new InvalidInputError({ field: 'date' });

  // `t` is the wall-clock reading as if it were UTC. An instant i is a solution
  // iff offset(i) === (t - i). Any real zone's offset changes at most once in a
  // day, so the offsets a day either side are the only candidates.
  const t = wall.toMillis();
  const before = offsetMinutesAt(t - DAY, zone);
  const after = offsetMinutesAt(t + DAY, zone);
  const solutions = [...new Set([before, offsetMinutesAt(t, zone), after])]
    .map((o) => t - o * MINUTE)
    .filter((i) => offsetMinutesAt(i, zone) * MINUTE === t - i)
    .sort((a, b) => a - b);

  const first = solutions[0];
  const last = solutions[solutions.length - 1];
  if (first !== undefined && last !== undefined) {
    return first === last
      ? { kind: 'exact', instant: new Date(first) }
      : { kind: 'ambiguous', instant: new Date(first), later: new Date(last) };
  }

  // A gap: the clock jumped from `before` to `after` (after > before). The
  // transition lies in [t - after, t - before]; find its first millisecond.
  let lo = t - after * MINUTE; // still on the old offset
  let hi = t - before * MINUTE; // already on the new offset
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMinutesAt(mid, zone) === before) lo = mid;
    else hi = mid;
  }
  return { kind: 'gap', instant: new Date(hi) };
}

/** The wall-clock reading of `instant` in `zone`. */
export function instantToLocal(
  instant: Date,
  zone: IanaZone,
): LocalDateTime & { readonly offsetMinutes: number } {
  const dt = DateTime.fromJSDate(instant, { zone });
  if (!dt.isValid) throw new InvalidInputError({ field: 'instant' });
  return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm'), offsetMinutes: dt.offset };
}

/** SD §DB-6 rule 5: from the two instants, never from the wall clocks. */
export function durationMinutes(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MINUTE;
}
