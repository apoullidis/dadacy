/**
 * Exception input rules (U-5 (1a)/(2), U-22) and `availableNowBodies` (SD 1104, U-5 (3a)). Expected
 * wall times from the host (`TZ=Europe/Nicosia date -d <instant>`), pasted in § Implementation › U1.
 * The DST cases of available-now (rework 1, QA Q-1): every expected wall time and instant is a
 * literal printed on the host by `TZ=Europe/Nicosia date -d <instant>`, `TZ=UTC date -d
 * 'TZ="Europe/Nicosia" <local>'` and `zdump -v Europe/Nicosia` (`app/.cache/T-089/host-anchors-r1.txt`,
 * pasted in `state/EP-9/T-089.md` § Rework 1), never computed by the code under test.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ianaZone, type Ulid } from '@kinvara/domain-types';
import type { JobEnqueuer } from '../jobs/index.ts';
import type { Tx } from '../runtime/index.ts';
import { addAvailableNow, availableNowBodies, ExceptionInput } from './exception.ts';
import { materialise, type ExceptionRow } from './materialise.ts';

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

// ---------- available-now across a DST change (rework 1, QA Q-1; E.3 U-16 (a), U-5 (3a)) ----------
// zdump: 2026-03-29 01:00:00Z is 04:00 EEST (02:59:59 EET a second before: 03:00-03:59 does not
// exist); 2026-10-25 01:00:00Z is 03:00 EET (03:59:59 EEST a second before: 03:00-03:59 happens
// twice, first EEST = 00:00Z-00:59Z, then EET = 01:00Z-01:59Z).

/** The bodies available-now builds, materialised as ADD rows (no template), as ISO pairs. */
function availableNowSlots(nowIso: string, hours: number, today: string): string[][] {
  const exceptions: ExceptionRow[] = availableNowBodies(new Date(nowIso), hours, Z).map((b, i) => ({
    id: `01J${String(i).padStart(23, '0')}`,
    onDate: b.date,
    kind: b.kind,
    startLocal: b.startLocal ?? null,
    endLocal: b.endLocal ?? null,
    tz: b.tz,
    createdAt: new Date(nowIso),
  }));
  return materialise({ bookable: true, today, templates: [], exceptions }).map((s) => [
    s.startsAt.toISOString(),
    s.endsAt.toISOString(),
  ]);
}

function wall(nowIso: string, hours: number): string[] {
  return availableNowBodies(new Date(nowIso), hours, Z).map(
    (b) => `${b.date} ${String(b.startLocal)}-${String(b.endLocal)}`,
  );
}

test('available-now across the spring gap is exactly [now, now + N h): 1 h from 2026-03-29T00:59Z (02:59 EET) is 02:59-04:59 = 00:59Z..01:59Z; 2 h from 00:30Z (02:30 EET) is 02:30-05:30 = 00:30Z..02:30Z', () => {
  assert.deepEqual(wall('2026-03-29T00:59:00Z', 1), ['2026-03-29 02:59-04:59']);
  assert.deepEqual(availableNowSlots('2026-03-29T00:59:00Z', 1, '2026-03-28'), [
    ['2026-03-29T00:59:00.000Z', '2026-03-29T01:59:00.000Z'],
  ]);
  assert.deepEqual(wall('2026-03-29T00:30:00Z', 2), ['2026-03-29 02:30-05:30']);
  assert.deepEqual(availableNowSlots('2026-03-29T00:30:00Z', 2, '2026-03-28'), [
    ['2026-03-29T00:30:00.000Z', '2026-03-29T02:30:00.000Z'],
  ]);
});

test('available-now on the fall-back Sunday is exactly [now, now + N h) when neither now nor the end lies in the SECOND 03:00-03:59 (EET): 2 h from 00:00Z, 00:30Z, 00:59Z (EEST); 1 h from 02:00Z (04:00 EET); 1 h from 2026-10-24T23:00Z (02:00 EEST) ending at the FIRST 03:00', () => {
  const cases: [string, number, string, string[]][] = [
    [
      '2026-10-25T00:00:00Z',
      2,
      '2026-10-25 03:00-04:00',
      ['2026-10-25T00:00:00.000Z', '2026-10-25T02:00:00.000Z'],
    ],
    [
      '2026-10-25T00:30:00Z',
      2,
      '2026-10-25 03:30-04:30',
      ['2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00.000Z'],
    ],
    [
      '2026-10-25T00:59:00Z',
      2,
      '2026-10-25 03:59-04:59',
      ['2026-10-25T00:59:00.000Z', '2026-10-25T02:59:00.000Z'],
    ],
    [
      '2026-10-25T02:00:00Z',
      1,
      '2026-10-25 04:00-05:00',
      ['2026-10-25T02:00:00.000Z', '2026-10-25T03:00:00.000Z'],
    ],
    [
      '2026-10-24T23:00:00Z',
      1,
      '2026-10-25 02:00-03:00',
      ['2026-10-24T23:00:00.000Z', '2026-10-25T00:00:00.000Z'],
    ],
  ];
  for (const [now, hours, rows, slot] of cases) {
    assert.deepEqual(wall(now, hours), [rows], `${now} +${String(hours)} h: the row`);
    assert.deepEqual(
      availableNowSlots(now, hours, '2026-10-24'),
      [slot],
      `${now} +${String(hours)} h: the slot`,
    );
  }
});

test('available-now bound (i), U-16 (a): a start in the SECOND 03:00-03:59 (EET) on 25 Oct 2026 resolves to the FIRST (EEST), so the slot starts one hour BEFORE now: 1 h from 01:00Z, 01:30Z, 01:59Z is 00:00Z..02:00Z, 00:30Z..02:30Z, 00:59Z..02:59Z', () => {
  const cases: [string, string, string[]][] = [
    [
      '2026-10-25T01:00:00Z',
      '2026-10-25 03:00-04:00',
      ['2026-10-25T00:00:00.000Z', '2026-10-25T02:00:00.000Z'],
    ],
    [
      '2026-10-25T01:30:00Z',
      '2026-10-25 03:30-04:30',
      ['2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00.000Z'],
    ],
    [
      '2026-10-25T01:59:00Z',
      '2026-10-25 03:59-04:59',
      ['2026-10-25T00:59:00.000Z', '2026-10-25T02:59:00.000Z'],
    ],
  ];
  for (const [now, rows, slot] of cases) {
    assert.deepEqual(wall(now, 1), [rows], `${now}: the row`);
    assert.deepEqual(
      availableNowSlots(now, 1, '2026-10-24'),
      [slot],
      `${now}: widened by the hour before now`,
    );
  }
});

test('available-now bound (ii), U-16 (a): an end in the SECOND 03:00-03:59 (EET) resolves to the FIRST, so the slot ends one hour EARLY: 2 h from 2026-10-24T23:00Z (02:00 EEST) is 02:00-03:00 = 23:00Z..00:00Z; 2 h from 23:30Z (02:30 EEST) is 02:30-03:30 = 23:30Z..00:30Z', () => {
  const cases: [string, string, string[]][] = [
    [
      '2026-10-24T23:00:00Z',
      '2026-10-25 02:00-03:00',
      ['2026-10-24T23:00:00.000Z', '2026-10-25T00:00:00.000Z'],
    ],
    [
      '2026-10-24T23:30:00Z',
      '2026-10-25 02:30-03:30',
      ['2026-10-24T23:30:00.000Z', '2026-10-25T00:30:00.000Z'],
    ],
  ];
  for (const [now, rows, slot] of cases) {
    assert.deepEqual(wall(now, 2), [rows], `${now}: the row`);
    assert.deepEqual(
      availableNowSlots(now, 2, '2026-10-24'),
      [slot],
      `${now}: narrowed by one hour`,
    );
  }
});

test('available-now bound (iii): 1 h from a start in the FIRST 03:00-03:59 (EEST) on 25 Oct 2026 builds equal wall times and is REFUSED: ExceptionInput issue on endLocal; addAvailableNow throws InvalidInputError field endLocal before any statement or enqueue', async () => {
  for (const [now, same] of [
    ['2026-10-25T00:00:00Z', '03:00'],
    ['2026-10-25T00:30:00Z', '03:30'],
    ['2026-10-25T00:59:00Z', '03:59'],
  ] as const) {
    const bodies = availableNowBodies(new Date(now), 1, Z);
    assert.deepEqual(bodies, [
      { date: '2026-10-25', kind: 'ADD', startLocal: same, endLocal: same, tz: 'Europe/Nicosia' },
    ]);
    const parsed = ExceptionInput.safeParse(bodies[0]);
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error?.issues.map((i) => i.path[0]),
      ['endLocal'],
    );
    let calls = 0;
    const tx = {
      execute: () => {
        calls += 1;
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Tx;
    const enqueuer = {
      enqueue: () => {
        calls += 1;
        return Promise.resolve();
      },
    } as unknown as JobEnqueuer;
    await assert.rejects(
      addAvailableNow(
        tx,
        enqueuer,
        '01J00000000000000000000000' as Ulid,
        1,
        'Europe/Nicosia',
        new Date(now),
      ),
      { name: 'InvalidInputError', field: 'endLocal' } as object,
    );
    assert.equal(calls, 0, 'nothing written, nothing enqueued');
  }
});
