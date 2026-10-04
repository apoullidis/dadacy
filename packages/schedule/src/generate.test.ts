/**
 * SD §DB-15 3270's generator test set, built against Part E.2 U-7/U-11, Part F C4 (a), C9 (b) and
 * OE-31 U-9 (a) (`tasks/state/EP-2/OE-30-34-rulings.md`).
 *
 * EVERY expected instant below was written by hand from the rule (EET = UTC+2, EEST = UTC+3,
 * summer time from the last Sunday of March 01:00Z to the last Sunday of October 01:00Z), never
 * from this package's output, and then checked against the host's tzdata with `date` and `zdump`
 * (86 local→UTC vectors, 0 disagreements: `app/.cache/t080/VECTORS.out`, recorded in
 * `state/EP-8b/T-080.md`). Expected counts are `date` arithmetic from the same capture.
 *
 * The whole-horizon checks use a second oracle that shares no code with the generator or with
 * Luxon: `nicosiaOffsetHours` below, the EU rule computed with `Date.UTC`.
 */
import { describe, expect, test } from 'vitest';
import {
  HORIZON_MONTHS,
  StaffedGenerationError,
  assertDisjoint,
  generateStaffedIntervals,
  intervalArrays,
  newIntervalId,
  type StaffedInterval,
} from './index.ts';
import { LAUNCH, SPANNING, block, everyDayPattern, sundayOnly } from './fixtures.test-support.ts';

const HOUR = 3_600_000;
const iso = (d: Date): string => d.toISOString().replace('.000Z', 'Z');
const span = (i: StaffedInterval): [string, string] => [iso(i.startsAt), iso(i.endsAt)];
const hours = (i: StaffedInterval): number => (i.endsAt.getTime() - i.startsAt.getTime()) / HOUR;

/** The intervals only, for the tests that do not look at adjustments. */
const gen = (...args: Parameters<typeof generateStaffedIntervals>): readonly StaffedInterval[] =>
  generateStaffedIntervals(...args).intervals;

function on(intervals: readonly StaffedInterval[], localDate: string): StaffedInterval[] {
  return intervals.filter((i) => i.localDate === localDate);
}
function only(intervals: readonly StaffedInterval[], localDate: string): StaffedInterval {
  const found = on(intervals, localDate);
  expect(found, `exactly one interval on ${localDate}`).toHaveLength(1);
  return found[0] as StaffedInterval;
}
function thrown(fn: () => unknown): StaffedGenerationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StaffedGenerationError);
    return e as StaffedGenerationError;
  }
  throw new Error('expected a StaffedGenerationError; nothing was thrown');
}

/** Last Sunday of `month` (1-based) in `year`, as a UTC day start in ms. Independent oracle. */
function lastSunday(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0));
  return Date.UTC(year, month - 1, lastDay.getUTCDate() - lastDay.getUTCDay());
}
/** The EU rule for Europe/Nicosia at an instant: +3 from last-Sun-Mar 01:00Z to last-Sun-Oct 01:00Z. */
function nicosiaOffsetHours(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const from = lastSunday(y, 3) + HOUR;
  const to = lastSunday(y, 10) + HOUR;
  return ms >= from && ms < to ? 3 : 2;
}
/** Local wall clock → instant by the oracle (only for wall times away from a transition). */
function oracle(localDate: string, hhmm: string): number {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const candidates = [2, 3]
    .map((o) => wall - o * HOUR)
    .filter((i) => nicosiaOffsetHours(i) * HOUR === wall - i);
  expect(candidates, `oracle: ${localDate} ${hhmm} has exactly one instant`).toHaveLength(1);
  return candidates[0] as number;
}
const isoWeekdayMonday0 = (localDate: string): number =>
  (new Date(`${localDate}T00:00:00Z`).getUTCDay() + 6) % 7;
const addDay = (localDate: string): string =>
  new Date(Date.parse(`${localDate}T00:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);

describe('launch pattern, effective 2026-10-01 (the 18-month horizon)', () => {
  const out = gen(LAUNCH, '2026-10-01');

  test('548 intervals, one per local date 2026-10-01..2028-03-31, none outside it (E.2 U-7, U-11)', () => {
    expect(HORIZON_MONTHS).toBe(18);
    expect(out).toHaveLength(548);
    const dates = out.map((i) => i.localDate);
    expect(new Set(dates).size).toBe(548);
    expect(dates[0]).toBe('2026-10-01');
    expect(dates[547]).toBe('2028-03-31');
    let d = '2026-10-01';
    for (const got of dates) {
      expect(got).toBe(d);
      d = addDay(d);
    }
    expect(d).toBe('2028-04-01');
  });

  test('season counts: standard 243 + summer 122 + standard 183, by the local start date', () => {
    const count = (key: string, from: string, to: string) =>
      out.filter((i) => i.season === key && i.localDate >= from && i.localDate < to).length;
    expect(count('standard', '2026-10-01', '2027-06-01')).toBe(243);
    expect(count('summer', '2027-06-01', '2027-10-01')).toBe(122);
    expect(count('standard', '2027-10-01', '2028-04-01')).toBe(183);
  });

  test('sorted, half-open, pairwise disjoint: endsAt[i] <= startsAt[i+1] (the relation V1 enforces)', () => {
    for (let i = 0; i < out.length; i++) {
      const cur = out[i] as StaffedInterval;
      expect(cur.endsAt.getTime()).toBeGreaterThan(cur.startsAt.getTime());
      if (i > 0)
        expect((out[i - 1] as StaffedInterval).endsAt.getTime()).toBeLessThanOrEqual(
          cur.startsAt.getTime(),
        );
    }
  });

  test('every interval matches its weekday and season, against the independent EU-rule oracle', () => {
    for (const i of out) {
      const wd = isoWeekdayMonday0(i.localDate);
      expect(i.weekday).toBe(wd);
      const md = i.localDate.slice(5);
      const summer = md >= '06-01' && md < '10-01';
      expect(i.season).toBe(summer ? 'summer' : 'standard');
      const [start, end, next] = summer
        ? ['10:00', '02:00', true]
        : wd <= 3
          ? ['14:00', '23:00', false]
          : wd <= 5
            ? ['14:00', '02:00', true]
            : ['10:00', '22:00', false];
      expect(i.startsAt.getTime(), `${i.localDate} start`).toBe(
        oracle(i.localDate, start as string),
      );
      expect(i.endsAt.getTime(), `${i.localDate} end`).toBe(
        oracle(next ? addDay(i.localDate) : i.localDate, end as string),
      );
    }
  });

  test('first and last: Thu 2026-10-01 and Fri 2028-03-31, which ends on 1 April local', () => {
    expect(span(out[0] as StaffedInterval)).toEqual([
      '2026-10-01T11:00:00Z',
      '2026-10-01T20:00:00Z',
    ]);
    expect(span(out[547] as StaffedInterval)).toEqual([
      '2028-03-31T11:00:00Z',
      '2028-03-31T23:00:00Z',
    ]);
  });

  test('year boundaries: Thu 2026-12-31, Fri 2027-01-01, Fri 2027-12-31 into 2028, Sat 2028-01-01', () => {
    expect(span(only(out, '2026-12-31'))).toEqual(['2026-12-31T12:00:00Z', '2026-12-31T21:00:00Z']);
    expect(span(only(out, '2027-01-01'))).toEqual(['2027-01-01T12:00:00Z', '2027-01-02T00:00:00Z']);
    expect(span(only(out, '2027-12-31'))).toEqual(['2027-12-31T12:00:00Z', '2028-01-01T00:00:00Z']);
    expect(span(only(out, '2028-01-01'))).toEqual(['2028-01-01T12:00:00Z', '2028-01-02T00:00:00Z']);
    expect(only(out, '2027-12-31').season).toBe('standard');
    expect(only(out, '2028-01-01').season).toBe('standard');
  });

  test('leap day 2028-02-29 (Tue) and the March 2028 transition weekend, 12 h each', () => {
    expect(span(only(out, '2028-02-29'))).toEqual(['2028-02-29T12:00:00Z', '2028-02-29T21:00:00Z']);
    expect(span(only(out, '2028-03-25'))).toEqual(['2028-03-25T12:00:00Z', '2028-03-26T00:00:00Z']);
    expect(span(only(out, '2028-03-26'))).toEqual(['2028-03-26T07:00:00Z', '2028-03-26T19:00:00Z']);
    expect(hours(only(out, '2028-03-25'))).toBe(12);
    expect(hours(only(out, '2028-03-26'))).toBe(12);
  });

  test('SD 1591 anchors: Thu 2026-11-12 is weekday 3, 14:00-23:00; Fri 13 Nov ends 02:00 Saturday', () => {
    const thu = only(out, '2026-11-12');
    expect(thu.weekday).toBe(3);
    expect(span(thu)).toEqual(['2026-11-12T12:00:00Z', '2026-11-12T21:00:00Z']);
    const fri = only(out, '2026-11-13');
    expect(fri.weekday).toBe(4);
    expect(span(fri)).toEqual(['2026-11-13T12:00:00Z', '2026-11-14T00:00:00Z']);
  });

  test('a crossing-midnight 23:30-01:30 local booking is inside the Friday interval (plain containment)', () => {
    const fri = only(out, '2026-11-13');
    const bookingStart = Date.parse('2026-11-13T21:30:00Z'); // Fri 23:30 EET
    const bookingEnd = Date.parse('2026-11-13T23:30:00Z'); // Sat 01:30 EET
    expect(fri.startsAt.getTime() <= bookingStart && bookingEnd <= fri.endsAt.getTime()).toBe(true);
  });

  test('October 2026 transition weekend (launch): Fri, Sat and Sun all 12 h; the offset changes between Sat and Sun', () => {
    expect(span(only(out, '2026-10-02'))).toEqual(['2026-10-02T11:00:00Z', '2026-10-02T23:00:00Z']);
    expect(span(only(out, '2026-10-24'))).toEqual(['2026-10-24T11:00:00Z', '2026-10-24T23:00:00Z']);
    expect(span(only(out, '2026-10-25'))).toEqual(['2026-10-25T08:00:00Z', '2026-10-25T20:00:00Z']);
    expect(hours(only(out, '2026-10-24'))).toBe(12);
    expect(hours(only(out, '2026-10-25'))).toBe(12);
  });

  test('October 2027 transition weekend (launch): Sat 30 and Sun 31 Oct, 12 h each', () => {
    expect(span(only(out, '2027-10-30'))).toEqual(['2027-10-30T11:00:00Z', '2027-10-30T23:00:00Z']);
    expect(span(only(out, '2027-10-31'))).toEqual(['2027-10-31T08:00:00Z', '2027-10-31T20:00:00Z']);
    expect(hours(only(out, '2027-10-30'))).toBe(12);
    expect(hours(only(out, '2027-10-31'))).toBe(12);
  });

  test('March 2027 transition weekend (launch): Sat 27 and Sun 28 Mar, 12 h each', () => {
    expect(span(only(out, '2027-03-27'))).toEqual(['2027-03-27T12:00:00Z', '2027-03-28T00:00:00Z']);
    expect(span(only(out, '2027-03-28'))).toEqual(['2027-03-28T07:00:00Z', '2027-03-28T19:00:00Z']);
    expect(hours(only(out, '2027-03-27'))).toBe(12);
    expect(hours(only(out, '2027-03-28'))).toBe(12);
  });

  test('1 June 2027 boundary: Mon 31 May standard 14:00-23:00, Tue 1 Jun summer 10:00-02:00', () => {
    const may = only(out, '2027-05-31');
    expect([may.season, ...span(may)]).toEqual([
      'standard',
      '2027-05-31T11:00:00Z',
      '2027-05-31T20:00:00Z',
    ]);
    const jun = only(out, '2027-06-01');
    expect([jun.season, ...span(jun)]).toEqual([
      'summer',
      '2027-06-01T07:00:00Z',
      '2027-06-01T23:00:00Z',
    ]);
  });

  test('1 October 2027 boundary: Thu 30 Sep is summer to 02:00 Fri (U-9 (a)); Fri 1 Oct standard to 02:00 Sat', () => {
    const sep = only(out, '2027-09-30');
    expect([sep.season, ...span(sep)]).toEqual([
      'summer',
      '2027-09-30T07:00:00Z',
      '2027-09-30T23:00:00Z',
    ]);
    const oct = only(out, '2027-10-01');
    expect([oct.season, ...span(oct)]).toEqual([
      'standard',
      '2027-10-01T11:00:00Z',
      '2027-10-01T23:00:00Z',
    ]);
  });
});

describe('launch pattern, effective 2026-01-01 and 2026-06-01 (the 2026 boundaries and March 2026)', () => {
  const jan = gen(LAUNCH, '2026-01-01');
  const jun = gen(LAUNCH, '2026-06-01');

  test('counts: 546 from 2026-01-01 (to 2027-07-01), 548 from 2026-06-01 (to 2027-12-01)', () => {
    expect(jan).toHaveLength(546);
    expect([jan[0]?.localDate, jan[545]?.localDate]).toEqual(['2026-01-01', '2027-06-30']);
    expect(span(jan[0] as StaffedInterval)).toEqual([
      '2026-01-01T12:00:00Z',
      '2026-01-01T21:00:00Z',
    ]);
    expect(span(jan[545] as StaffedInterval)).toEqual([
      '2027-06-30T07:00:00Z',
      '2027-06-30T23:00:00Z',
    ]);
    expect(jun).toHaveLength(548);
    expect([jun[0]?.localDate, jun[547]?.localDate]).toEqual(['2026-06-01', '2027-11-30']);
    expect(span(jun[547] as StaffedInterval)).toEqual([
      '2027-11-30T12:00:00Z',
      '2027-11-30T21:00:00Z',
    ]);
  });

  test('March 2026 transition weekend (launch): Fri 27, Sat 28 and Sun 29 Mar 12 h; Mon 30 Mar on EEST', () => {
    expect(span(only(jan, '2026-03-27'))).toEqual(['2026-03-27T12:00:00Z', '2026-03-28T00:00:00Z']);
    expect(span(only(jan, '2026-03-28'))).toEqual(['2026-03-28T12:00:00Z', '2026-03-29T00:00:00Z']);
    expect(span(only(jan, '2026-03-29'))).toEqual(['2026-03-29T07:00:00Z', '2026-03-29T19:00:00Z']);
    expect(span(only(jan, '2026-03-30'))).toEqual(['2026-03-30T11:00:00Z', '2026-03-30T20:00:00Z']);
    for (const d of ['2026-03-27', '2026-03-28', '2026-03-29'])
      expect(hours(only(jan, d))).toBe(12);
  });

  test('1 June 2026 boundary: Sun 31 May standard 10:00-22:00, Mon 1 Jun summer 10:00-02:00', () => {
    const may = only(jan, '2026-05-31');
    expect([may.season, may.weekday, ...span(may)]).toEqual([
      'standard',
      6,
      '2026-05-31T07:00:00Z',
      '2026-05-31T19:00:00Z',
    ]);
    const june = only(jan, '2026-06-01');
    expect([june.season, june.weekday, ...span(june)]).toEqual([
      'summer',
      0,
      '2026-06-01T07:00:00Z',
      '2026-06-01T23:00:00Z',
    ]);
    expect(span(only(jun, '2026-06-01'))).toEqual(span(june));
  });

  test('1 October 2026 boundary: Wed 30 Sep summer ends 02:00 Thu 1 Oct (U-9 (a)); Thu 1 Oct standard', () => {
    const sep = only(jun, '2026-09-30');
    expect([sep.season, ...span(sep)]).toEqual([
      'summer',
      '2026-09-30T07:00:00Z',
      '2026-09-30T23:00:00Z',
    ]);
    const oct = only(jun, '2026-10-01');
    expect([oct.season, ...span(oct)]).toEqual([
      'standard',
      '2026-10-01T11:00:00Z',
      '2026-10-01T20:00:00Z',
    ]);
    expect(on(jun, '2026-10-01')).toHaveLength(1);
  });
});

describe('Part F C4 (a): a synthetic window spanning 03:00-04:00 local (22:00 to 10:00 every night)', () => {
  const jan = gen(SPANNING, '2026-01-01');
  const jun = gen(SPANNING, '2026-06-01');

  test('March 2026: Sat 28 night is 11 h; Fri 27 and Sun 29 nights are 12 h', () => {
    expect(span(only(jan, '2026-03-27'))).toEqual(['2026-03-27T20:00:00Z', '2026-03-28T08:00:00Z']);
    expect(span(only(jan, '2026-03-28'))).toEqual(['2026-03-28T20:00:00Z', '2026-03-29T07:00:00Z']);
    expect(span(only(jan, '2026-03-29'))).toEqual(['2026-03-29T19:00:00Z', '2026-03-30T07:00:00Z']);
    expect([27, 28, 29].map((d) => hours(only(jan, `2026-03-${String(d)}`)))).toEqual([12, 11, 12]);
  });

  test('October 2026: Sat 24 night is 13 h; Fri 23 and Sun 25 nights are 12 h', () => {
    expect(span(only(jan, '2026-10-23'))).toEqual(['2026-10-23T19:00:00Z', '2026-10-24T07:00:00Z']);
    expect(span(only(jan, '2026-10-24'))).toEqual(['2026-10-24T19:00:00Z', '2026-10-25T08:00:00Z']);
    expect(span(only(jan, '2026-10-25'))).toEqual(['2026-10-25T20:00:00Z', '2026-10-26T08:00:00Z']);
    expect([23, 24, 25].map((d) => hours(only(jan, `2026-10-${String(d)}`)))).toEqual([12, 13, 12]);
  });

  test('2027: Sat 27 Mar night 11 h, Sat 30 Oct night 13 h', () => {
    expect(span(only(jan, '2027-03-27'))).toEqual(['2027-03-27T20:00:00Z', '2027-03-28T07:00:00Z']);
    expect(hours(only(jan, '2027-03-27'))).toBe(11);
    expect(span(only(jun, '2027-10-30'))).toEqual(['2027-10-30T19:00:00Z', '2027-10-31T08:00:00Z']);
    expect(hours(only(jun, '2027-10-30'))).toBe(13);
  });

  test('contiguous nights stay disjoint and every other night of the horizon is 12 h', () => {
    const odd = jan.filter((i) => hours(i) !== 12).map((i) => `${i.localDate}=${String(hours(i))}`);
    expect(odd).toEqual(['2026-03-28=11', '2026-10-24=13', '2027-03-27=11']);
    for (let i = 1; i < jan.length; i++) {
      expect((jan[i - 1] as StaffedInterval).endsAt.getTime()).toBeLessThanOrEqual(
        (jan[i] as StaffedInterval).startsAt.getTime(),
      );
    }
  });
});

describe('SD §DB-6 rules 3-4: a block edge inside the 03:00-04:00 gap or overlap', () => {
  test('start in the spring gap (Sun 03:30-05:00) resolves forward to the transition, 01:00Z', () => {
    const out = gen(sundayOnly('03:30', '05:00'), '2026-01-01');
    expect(span(only(out, '2026-03-29'))).toEqual(['2026-03-29T01:00:00Z', '2026-03-29T02:00:00Z']);
    expect(span(only(out, '2026-03-22'))).toEqual(['2026-03-22T01:30:00Z', '2026-03-22T03:00:00Z']);
  });

  test('start in the autumn overlap (Sun 03:30-05:00) takes the first (EEST) instant: 2.5 h', () => {
    const out = gen(sundayOnly('03:30', '05:00'), '2026-01-01');
    expect(span(only(out, '2026-10-25'))).toEqual(['2026-10-25T00:30:00Z', '2026-10-25T03:00:00Z']);
    expect(hours(only(out, '2026-10-25'))).toBe(2.5);
  });

  test('end in the spring gap (Sun 01:00-03:30) resolves forward to 01:00Z: 2 h', () => {
    const out = gen(sundayOnly('01:00', '03:30'), '2026-01-01');
    expect(span(only(out, '2026-03-29'))).toEqual(['2026-03-28T23:00:00Z', '2026-03-29T01:00:00Z']);
  });

  test('end in the autumn overlap (Sun 01:00-03:30) takes the first instant, 00:30Z: 2.5 h', () => {
    const out = gen(sundayOnly('01:00', '03:30'), '2026-01-01');
    expect(span(only(out, '2026-10-25'))).toEqual(['2026-10-24T22:00:00Z', '2026-10-25T00:30:00Z']);
  });

  test('a literal Saturday 03:00-04:00 block on the October 2026 weekend is 1 h (no transition on a Saturday)', () => {
    const pattern = {
      schema: 1,
      zone: 'Europe/Nicosia',
      seasons: [{ key: 'all', startsOn: '01-01', blocks: [block(5, '03:00', '04:00', false)] }],
    };
    const out = gen(pattern, '2026-06-01');
    expect(span(only(out, '2026-10-24'))).toEqual(['2026-10-24T00:00:00Z', '2026-10-24T01:00:00Z']);
  });
});

describe('OE-78: spring-gap skips and shifts are reported, the horizon end clamps', () => {
  test('OE-78 (1): a Sunday 03:00-04:00 block is skipped and flagged on both spring Sundays, not refused', () => {
    const r = generateStaffedIntervals(sundayOnly('03:00', '04:00'), '2026-10-01');
    // 78 Sundays in 2026-10-01..2028-03-31; the spring Sundays 2027-03-28 and 2028-03-26 are empty.
    expect(r.intervals).toHaveLength(76);
    expect(on(r.intervals, '2027-03-28')).toHaveLength(0);
    expect(on(r.intervals, '2028-03-26')).toHaveLength(0);
    expect(
      r.adjustments.map((a) =>
        a.reason === 'spring_gap_empty'
          ? [a.reason, a.localDate, a.season, a.weekday, a.localStart, a.localEnd, iso(a.utcUsed)]
          : [a.reason],
      ),
    ).toEqual([
      [
        'spring_gap_empty',
        '2027-03-28',
        'all',
        6,
        { date: '2027-03-28', time: '03:00' },
        { date: '2027-03-28', time: '04:00' },
        '2027-03-28T01:00:00Z',
      ],
      [
        'spring_gap_empty',
        '2028-03-26',
        'all',
        6,
        { date: '2028-03-26', time: '03:00' },
        { date: '2028-03-26', time: '04:00' },
        '2028-03-26T01:00:00Z',
      ],
    ]);
    // The autumn Sundays keep their interval: 03:00 takes its first (EEST) instant, 04:00 is EET.
    expect(span(only(r.intervals, '2026-10-25'))).toEqual([
      '2026-10-25T00:00:00Z',
      '2026-10-25T02:00:00Z',
    ]);
    expect(span(only(r.intervals, '2027-10-31'))).toEqual([
      '2027-10-31T00:00:00Z',
      '2027-10-31T02:00:00Z',
    ]);
  });

  test('OE-78 (1): Sunday 03:30-04:00 (end at the gap end) and 03:00-03:30 are empty too; 03:30-04:30 is not', () => {
    for (const [start, end] of [
      ['03:30', '04:00'],
      ['03:00', '03:30'],
    ] as const) {
      const r = generateStaffedIntervals(sundayOnly(start, end), '2026-01-01');
      expect(r.adjustments.map((a) => [a.reason, iso(a.utcUsed)])).toEqual([
        ['spring_gap_empty', '2026-03-29T01:00:00Z'],
        ['spring_gap_empty', '2027-03-28T01:00:00Z'],
      ]);
      expect(r.intervals).toHaveLength(76);
    }
    // CONTROL: 03:30-04:30 is not empty: [01:00Z, 01:30Z) on each spring Sunday, its start shifted.
    const c = generateStaffedIntervals(sundayOnly('03:30', '04:30'), '2026-01-01');
    expect(span(only(c.intervals, '2026-03-29'))).toEqual([
      '2026-03-29T01:00:00Z',
      '2026-03-29T01:30:00Z',
    ]);
    expect(c.adjustments.map((a) => a.reason)).toEqual(['spring_gap_shift', 'spring_gap_shift']);
  });

  test('OE-78 (4): a start in the gap (Sun 03:30-05:00) is one lower shift per spring Sunday, naming the interval', () => {
    const r = generateStaffedIntervals(sundayOnly('03:30', '05:00'), '2026-01-01');
    expect(r.intervals).toHaveLength(78);
    const ids = [only(r.intervals, '2026-03-29').id, only(r.intervals, '2027-03-28').id];
    expect(
      r.adjustments.map((a) =>
        a.reason === 'spring_gap_shift'
          ? [a.id, a.bound, a.localRequested, iso(a.utcUsed)]
          : [a.reason],
      ),
    ).toEqual([
      [ids[0], 'lower', { date: '2026-03-29', time: '03:30' }, '2026-03-29T01:00:00Z'],
      [ids[1], 'lower', { date: '2027-03-28', time: '03:30' }, '2027-03-28T01:00:00Z'],
    ]);
  });

  test('OE-78 (4): an end in the gap is an upper shift, dated on the day the end falls (Sat 22:00 -> Sun 03:30)', () => {
    const pattern = {
      schema: 1,
      zone: 'Europe/Nicosia',
      seasons: [{ key: 'all', startsOn: '01-01', blocks: [block(5, '22:00', '03:30', true)] }],
    };
    const r = generateStaffedIntervals(pattern, '2026-01-01');
    const sat = only(r.intervals, '2026-03-28');
    expect(span(sat)).toEqual(['2026-03-28T20:00:00Z', '2026-03-29T01:00:00Z']);
    expect(r.adjustments).toEqual([
      {
        reason: 'spring_gap_shift',
        id: sat.id,
        bound: 'upper',
        localRequested: { date: '2026-03-29', time: '03:30' },
        utcUsed: new Date('2026-03-29T01:00:00Z'),
      },
      expect.objectContaining({
        bound: 'upper',
        localRequested: { date: '2027-03-28', time: '03:30' },
      }),
    ]);
  });

  test('OE-78 (4): no adjustment for the launch pattern, the synthetic window, or an autumn-overlap bound', () => {
    expect(generateStaffedIntervals(LAUNCH, '2026-10-01').adjustments).toEqual([]);
    expect(generateStaffedIntervals(SPANNING, '2026-01-01').adjustments).toEqual([]);
    expect(
      generateStaffedIntervals(sundayOnly('01:00', '03:30'), '2026-06-01').adjustments.map((a) =>
        a.reason === 'spring_gap_shift' ? a.localRequested : a.reason,
      ),
    ).toEqual([{ date: '2027-03-28', time: '03:30' }]);
  });

  test('OE-78 (2): effective_from + 18 months clamps to the month end (31 Aug 2026 -> 29 Feb 2028)', () => {
    const last = (from: string) => {
      const r = gen(LAUNCH, from);
      return [r.length, r[0]?.localDate, r[r.length - 1]?.localDate];
    };
    expect(last('2026-08-31')).toEqual([547, '2026-08-31', '2028-02-28']);
    expect(last('2027-08-31')).toEqual([547, '2027-08-31', '2029-02-27']);
    expect(last('2027-08-29')).toEqual([549, '2027-08-29', '2029-02-27']);
    // CONTROL: a day that exists is not moved: 2026-08-29 + 18 months is 2028-02-29.
    expect(last('2026-08-29')).toEqual([549, '2026-08-29', '2028-02-28']);
  });

  test('an effective_from that is not a calendar date is effective_from_invalid', () => {
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '2026-10-01T00:00', '']) {
      expect(thrown(() => gen(LAUNCH, bad)).reason).toBe('effective_from_invalid');
    }
  });

  test('a pattern the schema refuses is pattern_invalid, including a cross-season overlap (OE-78 (3))', () => {
    expect(thrown(() => gen({ ...LAUNCH, schema: 2 }, '2026-10-01')).reason).toBe(
      'pattern_invalid',
    );
    expect(thrown(() => gen(null, '2026-10-01')).reason).toBe('pattern_invalid');
    const crossing = {
      schema: 1,
      zone: 'Europe/Nicosia',
      seasons: [
        { key: 'a', startsOn: '01-01', blocks: [block(1, '20:00', '04:00', true)] },
        { key: 'b', startsOn: '07-01', blocks: [block(2, '02:00', '03:00', false)] },
      ],
    };
    expect(thrown(() => gen(crossing, '2026-01-01')).reason).toBe('pattern_invalid');
  });

  test('assertDisjoint, the backstop no accepted pattern reaches, refuses an overlap and names its date', () => {
    const at = (s: string, e: string, d: string) => ({
      startsAt: new Date(s),
      endsAt: new Date(e),
      localDate: d,
    });
    const e = thrown(() =>
      assertDisjoint([
        at('2026-06-30T17:00:00Z', '2026-07-01T01:00:00Z', '2026-06-30'),
        at('2026-06-30T23:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01'),
      ]),
    );
    expect([e.reason, e.localDate, e.message]).toEqual([
      'intervals_overlap',
      '2026-07-01',
      'intervals_overlap',
    ]);
    // CONTROL: contiguous spans are disjoint.
    expect(() =>
      assertDisjoint([
        at('2026-06-30T17:00:00Z', '2026-06-30T23:00:00Z', '2026-06-30'),
        at('2026-06-30T23:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01'),
      ]),
    ).not.toThrow();
  });
});

describe('weekday numbering (Part F C9 (b): 0 = Monday ... 6 = Sunday)', () => {
  test('a weekday-0 block lands on Mondays only, starting Mon 2026-10-05', () => {
    const pattern = {
      schema: 1,
      zone: 'Europe/Nicosia',
      seasons: [{ key: 'all', startsOn: '01-01', blocks: [block(0, '12:00', '13:00', false)] }],
    };
    const out = gen(pattern, '2026-10-01');
    expect(out[0]?.localDate).toBe('2026-10-05');
    expect(out.every((i) => isoWeekdayMonday0(i.localDate) === 0 && i.weekday === 0)).toBe(true);
    expect(out).toHaveLength(78);
  });

  test('a weekday-6 block lands on Sundays only, starting Sun 2026-10-04', () => {
    const out = gen(sundayOnly('12:00', '13:00'), '2026-10-01');
    expect(out[0]?.localDate).toBe('2026-10-04');
    expect(span(out[0] as StaffedInterval)).toEqual([
      '2026-10-04T09:00:00Z',
      '2026-10-04T10:00:00Z',
    ]);
    expect(out.every((i) => new Date(`${i.localDate}T00:00:00Z`).getUTCDay() === 0)).toBe(true);
  });
});

describe('seasons: wrap and a 02-29 boundary', () => {
  test('a season starting 02-29 begins on 03-01 in a common year and on 02-29 in a leap year', () => {
    const pattern = {
      schema: 1,
      zone: 'Europe/Nicosia',
      seasons: [
        {
          key: 'base',
          startsOn: '10-01',
          blocks: everyDayPattern('12:00', '13:00', false).seasons[0]?.blocks ?? [],
        },
        {
          key: 'leap',
          startsOn: '02-29',
          blocks: everyDayPattern('14:00', '15:00', false).seasons[0]?.blocks ?? [],
        },
      ],
    };
    const out = gen(pattern, '2026-10-01');
    expect(
      ['2027-02-28', '2027-03-01', '2028-02-28', '2028-02-29'].map((d) => only(out, d).season),
    ).toEqual(['base', 'leap', 'base', 'leap']);
    expect(only(out, '2027-01-15').season).toBe('base');
  });
});

describe('season list order', () => {
  test('blocks of one weekday listed later-first still come out sorted by startsAt (QA-F1)', () => {
    // Mon 14:00-15:00 is listed BEFORE Mon 10:00-11:00. Mon 2026-10-05 is EEST (+3).
    const pattern = {
      schema: 1,
      zone: 'Europe/Nicosia',
      seasons: [
        {
          key: 'all',
          startsOn: '01-01',
          blocks: [block(0, '14:00', '15:00', false), block(0, '10:00', '11:00', false)],
        },
      ],
    };
    const out = gen(pattern, '2026-10-01');
    expect(out.slice(0, 2).map(span)).toEqual([
      ['2026-10-05T07:00:00Z', '2026-10-05T08:00:00Z'],
      ['2026-10-05T11:00:00Z', '2026-10-05T12:00:00Z'],
    ]);
    expect(out).toHaveLength(156);
    for (let i = 1; i < out.length; i++) {
      expect((out[i - 1] as StaffedInterval).startsAt.getTime()).toBeLessThan(
        (out[i] as StaffedInterval).startsAt.getTime(),
      );
    }
  });

  test('listing the launch seasons in the other order generates the same spans and seasons', () => {
    const reversed = { ...LAUNCH, seasons: [...LAUNCH.seasons].reverse() };
    expect(reversed.seasons.map((x) => x.startsOn)).toEqual(['06-01', '10-01']);
    const key = (i: StaffedInterval) => [...span(i), i.season];
    expect(gen(reversed, '2026-10-01').map(key)).toEqual(gen(LAUNCH, '2026-10-01').map(key));
  });
});

describe('ids (A.2 U-1) and the Q2 bind arrays', () => {
  test('one fresh, distinct ULID per interval by default', () => {
    const out = gen(LAUNCH, '2026-10-01');
    expect(out.every((i) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(i.id))).toBe(true);
    expect(new Set(out.map((i) => i.id)).size).toBe(548);
    expect(newIntervalId()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  test('an injected id source is used, and a non-ULID from it is refused', () => {
    let n = 0;
    const fixed = () => `01J080TEST${String(n++).padStart(16, '0')}`;
    const out = gen(LAUNCH, '2026-10-01', { newId: fixed });
    expect([out[0]?.id, out[547]?.id]).toEqual([
      '01J080TEST0000000000000000',
      '01J080TEST0000000000000547',
    ]);
    expect(() => gen(LAUNCH, '2026-10-01', { newId: () => 'not-a-ulid' })).toThrow('invalid_input');
  });

  test('intervalArrays: parallel ids, starts and ends as UTC ISO instants with Z', () => {
    const out = gen(LAUNCH, '2026-10-01');
    const a = intervalArrays(out);
    expect([a.ids.length, a.startsAt.length, a.endsAt.length]).toEqual([548, 548, 548]);
    expect([a.ids[0], a.startsAt[0], a.endsAt[0]]).toEqual([
      out[0]?.id,
      '2026-10-01T11:00:00.000Z',
      '2026-10-01T20:00:00.000Z',
    ]);
  });
});

describe('determinism: the host time zone plays no part', () => {
  test('identical spans under TZ=UTC and TZ=Asia/Tokyo, with the TZ change asserted to have landed', () => {
    const saved = process.env['TZ'];
    try {
      process.env['TZ'] = 'UTC';
      expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(0);
      const utc = [LAUNCH, SPANNING].map((p) => gen(p, '2026-01-01').map(span));
      process.env['TZ'] = 'Asia/Tokyo';
      expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-540);
      const tokyo = [LAUNCH, SPANNING].map((p) => gen(p, '2026-01-01').map(span));
      expect(tokyo).toEqual(utc);
      expect(utc[0]).toHaveLength(546);
    } finally {
      if (saved === undefined) delete process.env['TZ'];
      else process.env['TZ'] = saved;
    }
  });
});
