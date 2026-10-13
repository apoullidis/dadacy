/**
 * U-13 as accepted (B.3 OE-32, OE-50; brief addendum F): public availability in whole-hour spans,
 * rounded INWARD. Expected instants from the host (`TZ=UTC date -d 'TZ="<zone>" <local>'`),
 * pasted in `state/EP-9/T-089.md` § Implementation › U1.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ianaZone } from '@kinvara/domain-types';
import { wholeHourSpans } from './public.ts';

const span = (s: string, e: string) => ({ startsAt: new Date(s), endsAt: new Date(e) });
const iso = (xs: { startsAt: Date; endsAt: Date }[]) =>
  xs.map((x) => [x.startsAt.toISOString(), x.endsAt.toISOString()]);

test('rounded inward: start up, end down, to whole local hours (Europe/Nicosia)', () => {
  assert.deepEqual(iso(wholeHourSpans([span('2026-10-30T07:20:00Z', '2026-10-30T15:40:00Z')])), [
    ['2026-10-30T08:00:00.000Z', '2026-10-30T15:00:00.000Z'],
  ]);
});

test('already whole hours are unchanged; a span shorter than one whole hour after rounding is dropped', () => {
  assert.deepEqual(
    iso(
      wholeHourSpans([
        span('2026-10-30T07:00:00Z', '2026-10-30T09:00:00Z'),
        span('2026-10-30T10:10:00Z', '2026-10-30T11:05:00Z'),
        span('2026-10-30T12:30:00Z', '2026-10-30T12:59:59Z'),
      ]),
    ),
    [['2026-10-30T07:00:00.000Z', '2026-10-30T09:00:00.000Z']],
  );
});

test('a zone whose offset is not whole hours rounds to ITS local hours (Asia/Kolkata: 10:00 IST = 04:30Z, 12:00 IST = 06:30Z)', () => {
  const kolkata = ianaZone('Asia/Kolkata', 'tz');
  assert.deepEqual(
    iso(wholeHourSpans([span('2026-10-30T04:10:00Z', '2026-10-30T06:50:00Z')], kolkata)),
    [['2026-10-30T04:30:00.000Z', '2026-10-30T06:30:00.000Z']],
  );
});

test('seconds and milliseconds count as past the hour', () => {
  assert.deepEqual(
    iso(wholeHourSpans([span('2026-10-30T07:00:00.001Z', '2026-10-30T10:00:00.000Z')])),
    [['2026-10-30T08:00:00.000Z', '2026-10-30T10:00:00.000Z']],
  );
});
