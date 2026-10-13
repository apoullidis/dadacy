/**
 * Exception input rules (U-5 (1a)/(2), U-22) and `availableNowBodies` (SD 1104, U-5 (3a)). Expected
 * wall times from the host (`TZ=Europe/Nicosia date -d <instant>`), pasted in § Implementation › U1.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ianaZone } from '@kinvara/domain-types';
import { availableNowBodies, ExceptionInput } from './exception.ts';

const Z = ianaZone('Europe/Nicosia', 'tz');

test('available-now inside one local day is one ADD row (2026-10-30T07:00Z = 09:00 EET; +3 h = 12:00)', () => {
  assert.deepEqual(availableNowBodies(new Date('2026-10-30T07:00:30Z'), 3, Z), [
    {
      date: '2026-10-30',
      kind: 'ADD',
      startLocal: '09:00',
      endLocal: '12:00',
      tz: 'Europe/Nicosia',
    },
  ]);
});

test('available-now past local midnight is two ADD rows, start-24:00 on D and 00:00-end on D+1 (21:50Z = 23:50 EET; +1 h = 00:50 next day)', () => {
  assert.deepEqual(availableNowBodies(new Date('2026-10-30T21:50:00Z'), 1, Z), [
    {
      date: '2026-10-30',
      kind: 'ADD',
      startLocal: '23:50',
      endLocal: '24:00',
      tz: 'Europe/Nicosia',
    },
    {
      date: '2026-10-31',
      kind: 'ADD',
      startLocal: '00:00',
      endLocal: '00:50',
      tz: 'Europe/Nicosia',
    },
  ]);
});

test('available-now hours outside 1..8 are refused naming the field', () => {
  for (const hours of [0, 9, 1.5])
    assert.throws(() => availableNowBodies(new Date(), hours, Z), {
      name: 'InvalidInputError',
      field: 'hours',
    } as object);
});

test('ExceptionInput: whole-day REMOVE accepted; whole-day ADD, one NULL time, end <= start, reason > 200 refused', () => {
  const ok = {
    date: '2026-10-30',
    kind: 'REMOVE',
    startLocal: null,
    endLocal: null,
    tz: 'Europe/Nicosia',
  };
  assert.equal(ExceptionInput.safeParse(ok).success, true);
  assert.equal(ExceptionInput.safeParse({ ...ok, kind: 'ADD' }).success, false);
  assert.equal(ExceptionInput.safeParse({ ...ok, startLocal: '10:00' }).success, false);
  assert.equal(
    ExceptionInput.safeParse({ ...ok, kind: 'ADD', startLocal: '20:00', endLocal: '02:00' })
      .success,
    false,
  );
  assert.equal(
    ExceptionInput.safeParse({ ...ok, kind: 'ADD', startLocal: '20:00', endLocal: '24:00' })
      .success,
    true,
  );
  assert.equal(ExceptionInput.safeParse({ ...ok, reason: 'x'.repeat(200) }).success, true);
  assert.equal(ExceptionInput.safeParse({ ...ok, reason: 'x'.repeat(201) }).success, false);
  assert.equal(ExceptionInput.safeParse({ ...ok, kind: 'add' }).success, false);
  assert.equal(
    ExceptionInput.safeParse({ ...ok, createdAt: '2026-10-01T00:00:00Z' }).success,
    false,
    'created_at is never accepted from a caller (strict object)',
  );
});
