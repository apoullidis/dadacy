/**
 * SD §DB-6 rules 2–5 against Europe/Nicosia's 2026 transitions. Both are at
 * 01:00Z: spring forward on Sunday 29 March (03:00 EET → 04:00 EEST), autumn
 * back on Sunday 25 October (04:00 EEST → 03:00 EET). The expected instants are
 * written out by hand from those two facts, not computed by the code under test.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { durationMinutes, ianaZone, instantToLocal, resolveLocal } from './time.ts';
import { InvalidInputError } from './errors.ts';

const NICOSIA = ianaZone('Europe/Nicosia', 'tz');
const iso = (d: Date): string => d.toISOString();

test('an ordinary summer time is exact at UTC+3, and a winter one at UTC+2', () => {
  const summer = resolveLocal({ date: '2026-09-15', time: '16:00' }, NICOSIA);
  assert.equal(summer.kind, 'exact');
  assert.equal(iso(summer.instant), '2026-09-15T13:00:00.000Z');
  const winter = resolveLocal({ date: '2026-01-15', time: '16:00' }, NICOSIA);
  assert.equal(winter.kind, 'exact');
  assert.equal(iso(winter.instant), '2026-01-15T14:00:00.000Z');
});

test('rule 3: a time in the spring-forward gap resolves forward to the transition instant and says so', () => {
  for (const time of ['03:00', '03:30', '03:59']) {
    const r = resolveLocal({ date: '2026-03-29', time }, NICOSIA);
    assert.equal(r.kind, 'gap', time);
    assert.equal(iso(r.instant), '2026-03-29T01:00:00.000Z', time);
  }
});

test('rule 3: the minutes either side of the gap are exact', () => {
  const before = resolveLocal({ date: '2026-03-29', time: '02:59' }, NICOSIA);
  assert.deepEqual([before.kind, iso(before.instant)], ['exact', '2026-03-29T00:59:00.000Z']);
  const after = resolveLocal({ date: '2026-03-29', time: '04:00' }, NICOSIA);
  assert.deepEqual([after.kind, iso(after.instant)], ['exact', '2026-03-29T01:00:00.000Z']);
});

test('rule 4: a time in the autumn-back overlap resolves to the first instant and returns the later one', () => {
  const r = resolveLocal({ date: '2026-10-25', time: '03:30' }, NICOSIA);
  assert.equal(r.kind, 'ambiguous');
  assert.equal(iso(r.instant), '2026-10-25T00:30:00.000Z');
  assert.ok(r.kind === 'ambiguous');
  assert.equal(iso(r.later), '2026-10-25T01:30:00.000Z');
});

test('rule 4: the overlap is exactly 03:00 to 03:59, and 04:00 is exact', () => {
  const start = resolveLocal({ date: '2026-10-25', time: '03:00' }, NICOSIA);
  assert.equal(start.kind, 'ambiguous');
  assert.equal(iso(start.instant), '2026-10-25T00:00:00.000Z');
  const edge = resolveLocal({ date: '2026-10-25', time: '02:59' }, NICOSIA);
  assert.deepEqual([edge.kind, iso(edge.instant)], ['exact', '2026-10-24T23:59:00.000Z']);
  const end = resolveLocal({ date: '2026-10-25', time: '04:00' }, NICOSIA);
  assert.deepEqual([end.kind, iso(end.instant)], ['exact', '2026-10-25T02:00:00.000Z']);
});

test('rule 2: every Tuesday 16:00 stays 16:00 across the March change, so the instants are 167 hours apart', () => {
  const a = resolveLocal({ date: '2026-03-24', time: '16:00' }, NICOSIA).instant;
  const b = resolveLocal({ date: '2026-03-31', time: '16:00' }, NICOSIA).instant;
  assert.equal(durationMinutes(a, b), 167 * 60);
  assert.equal(instantToLocal(b, NICOSIA).time, '16:00');
});

test('rule 5: a sit from 01:00 to 04:00 local across the October change lasts 4 hours, not 3', () => {
  const start = resolveLocal({ date: '2026-10-25', time: '01:00' }, NICOSIA).instant;
  const end = resolveLocal({ date: '2026-10-25', time: '04:00' }, NICOSIA).instant;
  assert.equal(durationMinutes(start, end), 240);
});

test('instantToLocal reads the wall clock and the offset on both sides of a change', () => {
  assert.deepEqual(instantToLocal(new Date('2026-10-25T00:30:00Z'), NICOSIA), {
    date: '2026-10-25',
    time: '03:30',
    offsetMinutes: 180,
  });
  assert.deepEqual(instantToLocal(new Date('2026-10-25T01:30:00Z'), NICOSIA), {
    date: '2026-10-25',
    time: '03:30',
    offsetMinutes: 120,
  });
  assert.throws(() => instantToLocal(new Date('nope'), NICOSIA), InvalidInputError);
});

test('UTC resolves exactly with no offset', () => {
  const r = resolveLocal({ date: '2026-03-29', time: '03:30' }, ianaZone('UTC', 'tz'));
  assert.deepEqual([r.kind, iso(r.instant)], ['exact', '2026-03-29T03:30:00.000Z']);
});

test('a malformed or impossible date or time is refused, naming which', () => {
  const bad: [string, string, string][] = [
    ['2026-02-30', '10:00', 'date'],
    ['2026-9-15', '10:00', 'date'],
    ['2026-09-15T', '10:00', 'date'],
    ['2026-09-15', '24:00', 'time'],
    ['2026-09-15', '16:60', 'time'],
    ['2026-09-15', '16:00:00', 'time'],
    ['2026-09-15', '4:00', 'time'],
  ];
  for (const [date, time, field] of bad) {
    assert.throws(
      () => resolveLocal({ date, time }, NICOSIA),
      (e: unknown) => e instanceof InvalidInputError && e.field === field,
      `${date} ${time}`,
    );
  }
});

test('ianaZone accepts Area/Location names and UTC, and returns them unchanged', () => {
  for (const z of [
    'Europe/Nicosia',
    'Asia/Nicosia',
    'UTC',
    'Etc/GMT-2',
    'America/Argentina/Buenos_Aires',
  ]) {
    assert.equal(ianaZone(z, 'tz'), z);
  }
});

test('ianaZone refuses offsets, legacy single-segment names, unknown zones and non-strings', () => {
  for (const z of [
    '+02:00',
    '+0200',
    'EET',
    'CET',
    'EST5EDT',
    'Mars/Olympus',
    'Europe/',
    '',
    'Europe/Nicosia ',
    2,
  ]) {
    assert.throws(
      () => ianaZone(z, 'tz'),
      (e: unknown) => e instanceof InvalidInputError && e.field === 'tz',
      String(z),
    );
  }
});
