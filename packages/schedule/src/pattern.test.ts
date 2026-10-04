/**
 * `StaffedPatternV1` (Part E.2 U-14): the four refusals E.2 U-14 names (an unknown key,
 * `end <= start` without `endsNextDay`, overlapping blocks, a duplicate `startsOn`), the rest of
 * its stated rules, and a CONTROL beside each.
 */
import { describe, expect, test } from 'vitest';
import { StaffedPatternV1, parseStaffedPatternV1 } from './index.ts';
import { LAUNCH, SPANNING, block } from './fixtures.test-support.ts';

const accepts = (p: unknown): boolean => StaffedPatternV1.safeParse(p).success;
const withSeason = (blocks: unknown[], startsOn = '01-01') => ({
  schema: 1,
  zone: 'Europe/Nicosia',
  seasons: [{ key: 'all', startsOn, blocks }],
});
const pathsOf = (p: unknown): string[] => {
  const r = parseStaffedPatternV1(p);
  return r.success ? [] : r.issues.map((i) => i.path.join('.'));
};

describe('StaffedPatternV1 accepts', () => {
  test('the launch encoding and the synthetic spanning pattern', () => {
    expect(accepts(LAUNCH)).toBe(true);
    expect(accepts(SPANNING)).toBe(true);
    const r = parseStaffedPatternV1(LAUNCH);
    expect(r.success && r.data.seasons.map((s) => s.key)).toEqual(['standard', 'summer']);
  });

  test('contiguous blocks, a 24 h block (end == start with endsNextDay), and a season with no blocks', () => {
    expect(
      accepts(withSeason([block(0, '10:00', '12:00', false), block(0, '12:00', '14:00', false)])),
    ).toBe(true);
    expect(
      accepts(withSeason([block(0, '10:00', '10:00', true), block(1, '10:00', '11:00', false)])),
    ).toBe(true);
    expect(accepts(withSeason([]))).toBe(true);
  });

  test('a Sunday tail ending exactly where Monday begins (the week wraps)', () => {
    expect(
      accepts(withSeason([block(6, '22:00', '02:00', true), block(0, '02:00', '03:00', false)])),
    ).toBe(true);
  });

  test('12 seasons, 02-29 as a startsOn, zone UTC', () => {
    const seasons = Array.from({ length: 12 }, (_, m) => ({
      key: `m_${'abcdefghijkl'[m] ?? ''}`,
      startsOn: `${String(m + 1).padStart(2, '0')}-01`,
      blocks: [],
    }));
    expect(accepts({ schema: 1, zone: 'Europe/Nicosia', seasons })).toBe(true);
    expect(accepts(withSeason([], '02-29'))).toBe(true);
    expect(accepts({ ...withSeason([]), zone: 'UTC' })).toBe(true);
  });
});

describe('StaffedPatternV1 refuses', () => {
  test('an unknown key at every level (every object is strict)', () => {
    expect(accepts({ ...LAUNCH, extra: 1 })).toBe(false);
    expect(accepts({ ...LAUNCH, seasons: [{ ...LAUNCH.seasons[0], colour: 'red' }] })).toBe(false);
    expect(accepts(withSeason([{ ...block(0, '10:00', '11:00', false), note: 'x' }]))).toBe(false);
  });

  test('end <= start without endsNextDay, and endsNextDay with end > start', () => {
    expect(pathsOf(withSeason([block(0, '14:00', '14:00', false)]))).toEqual([
      'seasons.0.blocks.0.end',
    ]);
    expect(accepts(withSeason([block(0, '14:00', '02:00', false)]))).toBe(false);
    expect(accepts(withSeason([block(0, '14:00', '15:00', true)]))).toBe(false);
  });

  test('overlapping blocks: same day, a next-day tail into the next day, and a Sunday tail into Monday', () => {
    expect(
      pathsOf(withSeason([block(0, '10:00', '12:00', false), block(0, '11:59', '13:00', false)])),
    ).toEqual(['seasons.0.blocks.1']);
    expect(
      accepts(withSeason([block(4, '14:00', '02:00', true), block(5, '01:59', '03:00', false)])),
    ).toBe(false);
    expect(
      accepts(withSeason([block(6, '22:00', '02:00', true), block(0, '01:00', '03:00', false)])),
    ).toBe(false);
  });

  test('a duplicate startsOn', () => {
    const p = {
      ...LAUNCH,
      seasons: [LAUNCH.seasons[0], { ...LAUNCH.seasons[1], startsOn: '10-01' }],
    };
    expect(pathsOf(p)).toEqual(['seasons.1.startsOn']);
  });

  test('schema other than 1, zero or 13 seasons', () => {
    expect(accepts({ ...LAUNCH, schema: 2 })).toBe(false);
    expect(accepts({ ...LAUNCH, seasons: [] })).toBe(false);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      key: 'k',
      startsOn: `01-${String(i + 1).padStart(2, '0')}`,
      blocks: [],
    }));
    expect(accepts({ ...LAUNCH, seasons: thirteen })).toBe(false);
  });

  test('a weekday outside 0..6 or not an integer', () => {
    for (const w of [-1, 7, 1.5])
      expect(accepts(withSeason([block(w, '10:00', '11:00', false)]))).toBe(false);
  });

  test('a time outside HH 00-23 / MM 00-59, or not HH:MM', () => {
    for (const t of ['24:00', '10:60', '9:00', '10:00:00']) {
      expect(accepts(withSeason([block(0, t, '23:59', false)]))).toBe(false);
    }
  });

  test('a startsOn that is not a calendar day, or not MM-DD', () => {
    for (const s of ['02-30', '13-01', '00-10', '4-01', '04-1'])
      expect(accepts(withSeason([], s))).toBe(false);
  });

  test('a season key outside [a-z_]{1,32}', () => {
    for (const key of ['', 'Summer', 'a'.repeat(33), 'summer-1']) {
      expect(
        accepts({ ...withSeason([]), seasons: [{ key, startsOn: '01-01', blocks: [] }] }),
      ).toBe(false);
    }
  });

  test('a zone that is not an IANA Area/Location name (offsets and legacy names included)', () => {
    for (const zone of ['EET', '+02:00', 'Europe/Nowhere', '', 7]) {
      expect(accepts({ ...withSeason([]), zone })).toBe(false);
    }
  });
});
