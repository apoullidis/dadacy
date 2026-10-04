/**
 * Patterns used by the tests. Not exported from the package: which windows a version contains is
 * the publisher's content decision (E.2 U-14), and the launch schedule is published at runtime,
 * not seeded (OE-31 U-8 (a)).
 */

const block = (weekday: number, start: string, end: string, endsNextDay: boolean) => ({
  weekday,
  start,
  end,
  endsNextDay,
});
const everyDay = (start: string, end: string, endsNextDay: boolean) =>
  [0, 1, 2, 3, 4, 5, 6].map((w) => block(w, start, end, endsNextDay));

/**
 * PM §MVP-IS9 AC1 as E.2 U-14 encodes it: `standard` from 10-01 (Mon–Thu 14:00–23:00; Fri–Sat
 * 14:00–02:00 next day; Sun 10:00–22:00) and `summer` from 06-01 (every day 10:00–02:00 next day).
 * Weekdays are Part F C9 (b): 0 = Monday.
 */
export const LAUNCH = {
  schema: 1,
  zone: 'Europe/Nicosia',
  seasons: [
    {
      key: 'standard',
      startsOn: '10-01',
      blocks: [
        block(0, '14:00', '23:00', false),
        block(1, '14:00', '23:00', false),
        block(2, '14:00', '23:00', false),
        block(3, '14:00', '23:00', false),
        block(4, '14:00', '02:00', true),
        block(5, '14:00', '02:00', true),
        block(6, '10:00', '22:00', false),
      ],
    },
    { key: 'summer', startsOn: '06-01', blocks: everyDay('10:00', '02:00', true) },
  ],
};

/** Part F C4 (a): a synthetic window spanning 03:00–04:00 local, every night 22:00–10:00. */
export const SPANNING = {
  schema: 1,
  zone: 'Europe/Nicosia',
  seasons: [{ key: 'all', startsOn: '01-01', blocks: everyDay('22:00', '10:00', true) }],
};

/** One Sunday block, for the gap and ambiguity rules. */
export const sundayOnly = (start: string, end: string) => ({
  schema: 1,
  zone: 'Europe/Nicosia',
  seasons: [{ key: 'all', startsOn: '01-01', blocks: [block(6, start, end, false)] }],
});

export const everyDayPattern = (start: string, end: string, endsNextDay: boolean) => ({
  schema: 1,
  zone: 'Europe/Nicosia',
  seasons: [{ key: 'all', startsOn: '01-01', blocks: everyDay(start, end, endsNextDay) }],
});

export { block, everyDay };
