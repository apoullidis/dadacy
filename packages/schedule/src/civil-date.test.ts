/**
 * The zone-free calendar arithmetic, checked against `Date.UTC` (a different implementation) over
 * a wide range, plus hand-written cases.
 */
import { describe, expect, test } from 'vitest';
import {
  addCalendarMonths,
  daysInMonth,
  formatCivilDate,
  fromDayNumber,
  parseCivilDate,
  toDayNumber,
  weekdayMonday0,
} from './civil-date.ts';

const DAY = 86_400_000;

describe('civil dates', () => {
  test('day numbers agree with Date.UTC for every day from 1899-01-01 to 2101-12-31', () => {
    const start = Date.UTC(1899, 0, 1) / DAY;
    const end = Date.UTC(2101, 11, 31) / DAY;
    for (let n = start; n <= end; n++) {
      const iso = new Date(n * DAY).toISOString().slice(0, 10);
      const d = parseCivilDate(iso);
      expect(d && toDayNumber(d)).toBe(n);
      expect(formatCivilDate(fromDayNumber(n))).toBe(iso);
      expect(weekdayMonday0(fromDayNumber(n))).toBe((new Date(n * DAY).getUTCDay() + 6) % 7);
    }
  });

  test('parse refuses shapes and non-days, including 1900-02-29 and 2026-02-29; accepts 2000-02-29', () => {
    for (const bad of [
      '1900-02-29',
      '2026-02-29',
      '2026-04-31',
      '2026-00-01',
      '2026-01-00',
      '26-01-01',
      'x',
    ]) {
      expect(parseCivilDate(bad)).toBeUndefined();
    }
    expect(parseCivilDate('2000-02-29')).toEqual({ year: 2000, month: 2, day: 29 });
    expect([
      daysInMonth(2028, 2),
      daysInMonth(2027, 2),
      daysInMonth(2027, 4),
      daysInMonth(2027, 12),
    ]).toEqual([29, 28, 30, 31]);
  });

  test('addCalendarMonths: 18 months, year rollover, and undefined for a day the target month lacks', () => {
    const add = (s: string, m: number) => {
      const r = addCalendarMonths(parseCivilDate(s) ?? { year: 0, month: 0, day: 0 }, m);
      return r && formatCivilDate(r);
    };
    expect(add('2026-10-01', 18)).toBe('2028-04-01');
    expect(add('2026-06-01', 18)).toBe('2027-12-01');
    expect(add('2026-08-29', 18)).toBe('2028-02-29');
    expect(add('2026-08-31', 18)).toBeUndefined();
    expect(add('2027-08-29', 18)).toBeUndefined();
    expect(add('2026-12-31', 1)).toBe('2027-01-31');
  });
});
