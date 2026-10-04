/**
 * Civil (zone-free) calendar dates as `YYYY-MM-DD`: validation, day stepping, ISO weekday, and
 * month addition. Proleptic Gregorian, integer arithmetic only. No `Date` and no time zone is
 * involved, so nothing here can depend on the host's TZ.
 *
 * WHY THIS IS HERE AND NOT IN `packages/domain-types/time.ts`. SD §DB-6 rule 7 puts server-side
 * date arithmetic in `time.ts`. That module exports zone-aware instant resolution (`resolveLocal`)
 * and nothing for whole calendar dates, and the generator walks local DATES (SD 2400 rule 2: never
 * add 24 h to an instant). Everything zone-dependent goes through `resolveLocal`; only these
 * zone-free date steps are local to this package. Recorded in `state/EP-8b/T-080.md` (build pass,
 * deviations) as a request to `time.ts`'s owner.
 *
 * The day-number conversion is Howard Hinnant's `days_from_civil` / `civil_from_days`.
 */

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The parts of a real calendar date, or `undefined` (shape or calendar invalid). */
export function parseCivilDate(text: string): CivilDate | undefined {
  const m = DATE.exec(text);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatCivilDate(d: CivilDate): string {
  return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
}

/** Days since 1970-01-01 (negative before it). */
export function toDayNumber(d: CivilDate): number {
  const y = d.month <= 2 ? d.year - 1 : d.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (d.month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(n: number): CivilDate {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/**
 * The weekday with 0 = Monday … 6 = Sunday (Part F C9 (b): ISO 8601's weekday minus one).
 * 1970-01-01 was a Thursday, which is 3 on this numbering.
 */
export function weekdayMonday0(d: CivilDate): number {
  return (((toDayNumber(d) + 3) % 7) + 7) % 7;
}

/**
 * `d` plus `months` calendar months. When that day does not exist in the target month, it CLAMPS to
 * the month's last day (OE-78 (2): 31 Aug 2026 + 18 months = 29 Feb 2028; 31 Aug 2027 + 18 months =
 * 28 Feb 2029), the same convention as PostgreSQL's `date + interval 'N months'`.
 */
export function addCalendarMonths(d: CivilDate, months: number): CivilDate {
  const index = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}
