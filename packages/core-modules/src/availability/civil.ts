/**
 * Zone-free calendar dates (`YYYY-MM-DD`) and wall times for the availability materialiser.
 *
 * WHY THESE ARE HERE. SD §DB-6 rule 7 puts zone-aware arithmetic in `@kinvara/domain-types`'
 * `time.ts`, and every local→instant step below goes through its `resolveLocal` (SD 2400–2402:
 * a nonexistent wall time resolves to the transition instant, an ambiguous one to the first,
 * pre-transition instant). `time.ts` has nothing for whole calendar dates, and the materialiser
 * walks local DATES (SD 2400 rule 2: never add 24 h to an instant). The date steps here use
 * `Date.UTC` as a day counter only: no host time zone is read, so nothing depends on `TZ`.
 * `packages/schedule/src/civil-date.ts` (T-080) made the same choice for the same reason.
 */
import {
  InvalidInputError,
  resolveLocal,
  type IanaZone,
  type LocalResolution,
} from '@kinvara/domain-types';

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
/** A `time` as Postgres prints it (`HH:MM:SS`, `24:00:00` included) or as the API writes it (`HH:MM`). */
const TIME = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a valid `YYYY-MM-DD`; throws `InvalidInputError` otherwise. */
export function dayNumber(date: string, field = 'date'): number {
  const m = DATE.exec(date);
  if (m === null) throw new InvalidInputError({ field });
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new InvalidInputError({ field });
  }
  return ms / DAY_MS;
}

export function dateOfDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateOfDayNumber(dayNumber(date) + days);
}

/** 0 = Monday … 6 = Sunday (Part F C9 (b); `0029`'s table comment). 1970-01-01 was a Thursday (3). */
export function weekdayMonday0(date: string): number {
  return (((dayNumber(date) + 3) % 7) + 7) % 7;
}

/**
 * A wall time as minutes after local midnight, 0…1440. `24:00` (and Postgres's `24:00:00`) is
 * 1440: C7 (a) stores a block ending at midnight as ending at `24:00` (`0029` accepts it, T-163
 * contract §3). Seconds must be zero: the materialiser resolves whole minutes, and a non-zero
 * second is refused rather than silently truncated.
 */
export function minutesOfTime(time: string, field = 'time'): number {
  const m = TIME.exec(time);
  if (m === null) throw new InvalidInputError({ field });
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] === undefined ? 0 : Number(m[3]);
  if (ss !== 0 || mm > 59) throw new InvalidInputError({ field });
  const total = hh * 60 + mm;
  if (total > 1440) throw new InvalidInputError({ field });
  return total;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The instant at which local `date` + `minutes` (0…1440) falls in `zone`, by `resolveLocal`
 * (E.3 U-16 (a), SD 2401–2402). 1440 is the next local date's 00:00 — resolved from that date,
 * never by adding 24 h.
 */
export function localInstant(date: string, minutes: number, zone: IanaZone): number {
  const on = minutes === 1440 ? addDays(date, 1) : date;
  const at = minutes === 1440 ? 0 : minutes;
  const resolved: LocalResolution = resolveLocal({ date: on, time: hhmm(at) }, zone);
  return resolved.instant.getTime();
}
