/**
 * The pure materialiser, without a database (T-089). EXPECTED INSTANTS ARE ANCHORED OUTSIDE THE
 * CODE: each was printed on the host by `TZ=UTC date -d 'TZ="Europe/Nicosia" <local>' +%FT%TZ`
 * (tzdata as installed, 2026-10-13) and by `zdump -v Europe/Nicosia`, pasted in
 * `state/EP-9/T-089.md` § Implementation › U1, and copied here as literals. Weekdays were read
 * with `date -d <date> +%A`. None is computed by `materialise()` or by `resolveLocal`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  compareExceptions,
  horizonOf,
  materialise,
  subtractInterval,
  unionInterval,
  type ExceptionRow,
  type Span,
  type TemplateRow,
} from './materialise.ts';

const Z = 'Europe/Nicosia';

function block(
  weekday: number,
  startLocal: string,
  endLocal: string,
  extra: Partial<TemplateRow> = {},
): TemplateRow {
  return {
    weekday,
    startLocal,
    endLocal,
    tz: Z,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    ...extra,
  };
}

let seq = 0;
function ex(
  onDate: string,
  kind: 'ADD' | 'REMOVE',
  startLocal: string | null,
  endLocal: string | null,
  createdAt: string,
  id?: string,
): ExceptionRow {
  seq += 1;
  return {
    id: id ?? `01J00000000000000000000${String(seq).padStart(3, '0')}`,
    onDate,
    kind,
    startLocal,
    endLocal,
    tz: Z,
    createdAt: new Date(createdAt),
  };
}

function iso(spans: readonly Span[]): string[][] {
  return spans.map((s) => [s.startsAt.toISOString(), s.endsAt.toISOString()]);
}

function on(spans: readonly Span[], fromIso: string, toIso: string): string[][] {
  const lo = Date.parse(fromIso);
  const hi = Date.parse(toIso);
  return iso(spans.filter((s) => s.startsAt.getTime() < hi && s.endsAt.getTime() > lo));
}

test('U-14 (a) / C7 (a): Fri 19:00-24:00 + Sat 00:00-01:00 is ONE slot, Fri 19:00 -> Sat 01:00 local (host: 2026-10-23T16:00Z -> 22:00Z)', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    exceptions: [],
    templates: [block(4, '19:00', '24:00:00'), block(5, '00:00:00', '01:00:00')],
  });
  assert.deepEqual(on(spans, '2026-10-23T00:00:00Z', '2026-10-24T12:00:00Z'), [
    ['2026-10-23T16:00:00.000Z', '2026-10-23T22:00:00.000Z'],
  ]);
});

test('U-14 (a) property: no two emitted slots overlap or touch; output sorted', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: [
      block(0, '09:00', '12:00'),
      block(0, '12:00', '14:00'),
      block(0, '11:00', '13:00'),
      block(4, '19:00', '24:00'),
      block(5, '00:00', '01:00'),
      block(2, '08:00', '09:00'),
    ],
    exceptions: [
      ex('2026-10-28', 'ADD', '09:00', '10:00', '2026-10-01T00:00:00Z'),
      ex('2026-11-02', 'REMOVE', '10:00', '11:00', '2026-10-01T00:00:00Z'),
    ],
  });
  assert.ok(spans.length > 10, 'the fixture produces many slots');
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1] as Span;
    const cur = spans[i] as Span;
    assert.ok(
      prev.endsAt.getTime() < cur.startsAt.getTime(),
      `slot ${String(i)} neither overlaps nor touches the previous one`,
    );
  }
  for (const s of spans)
    assert.ok(s.endsAt.getTime() > s.startsAt.getTime(), 'every slot is non-empty');
});

test('U-3: overlapping and touching blocks are unioned (Mon 09-12, 12-14, 11-13 -> 09-14 local; host 2026-10-26 is a Monday, EET from 25 Oct)', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    exceptions: [],
    templates: [block(0, '09:00', '12:00'), block(0, '12:00', '14:00'), block(0, '11:00', '13:00')],
  });
  // 2026-10-26 09:00 EET = 07:00Z, 14:00 EET = 12:00Z (EET = UTC+2 after 2026-10-25 01:00Z, zdump)
  assert.deepEqual(on(spans, '2026-10-26T00:00:00Z', '2026-10-27T00:00:00Z'), [
    ['2026-10-26T07:00:00.000Z', '2026-10-26T12:00:00.000Z'],
  ]);
});

test('C9 (b): weekday 0 is Monday (host: 2026-10-26 Monday 16:00-20:00 local = 14:00Z-18:00Z)', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    exceptions: [],
    templates: [block(0, '16:00', '20:00')],
  });
  assert.deepEqual(iso(spans)[0], ['2026-10-26T14:00:00.000Z', '2026-10-26T18:00:00.000Z']);
  assert.equal(spans.length, 8, '56 days from Tue 2026-10-20 contain eight Mondays');
});

test('horizon C10 (a): local today 00:00 to today+56 00:00 (host: 2026-10-20 00:00 = 2026-10-19T21:00Z; 2026-12-15 00:00 = 2026-12-14T22:00Z)', () => {
  const [s, e] = horizonOf('2026-10-20');
  assert.equal(new Date(s).toISOString(), '2026-10-19T21:00:00.000Z');
  assert.equal(new Date(e).toISOString(), '2026-12-14T22:00:00.000Z');
  // An every-day all-day template is clipped to exactly the horizon, as ONE coalesced slot.
  const all = [0, 1, 2, 3, 4, 5, 6].map((w) => block(w, '00:00', '24:00'));
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    exceptions: [],
    templates: all,
  });
  assert.deepEqual(iso(spans), [['2026-10-19T21:00:00.000Z', '2026-12-14T22:00:00.000Z']]);
});

test('E.3 U-12 (a): a sitter who is not bookable gets zero slots', () => {
  const spans = materialise({
    bookable: false,
    today: '2026-10-20',
    exceptions: [],
    templates: [block(0, '16:00', '20:00')],
  });
  assert.deepEqual(spans, []);
});

test('E.3 U-2 liveness: effective_from/effective_to bound the dates; a voided row (effective_to < effective_from) is live on no date', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    exceptions: [],
    templates: [
      block(0, '16:00', '20:00', { effectiveFrom: '2026-11-02', effectiveTo: '2026-11-09' }),
      block(1, '10:00', '11:00', { effectiveFrom: '2026-11-15', effectiveTo: '2026-11-14' }),
    ],
  });
  // Mondays 2026-11-02 and 2026-11-09 only; 16:00 EET = 14:00Z
  assert.deepEqual(iso(spans), [
    ['2026-11-02T14:00:00.000Z', '2026-11-02T18:00:00.000Z'],
    ['2026-11-09T14:00:00.000Z', '2026-11-09T18:00:00.000Z'],
  ]);
});

test('OD-335 case 1: whole-day REMOVE then ADD 09:00-17:00 on one date gives a 09:00-17:00 slot (host: 2026-10-30 09:00 = 07:00Z, 17:00 = 15:00Z)', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: [block(4, '08:00', '20:00')],
    exceptions: [
      ex('2026-10-30', 'REMOVE', null, null, '2026-10-21T10:00:00Z'),
      ex('2026-10-30', 'ADD', '09:00', '17:00', '2026-10-21T10:05:00Z'),
    ],
  });
  assert.deepEqual(on(spans, '2026-10-29T22:00:00Z', '2026-10-30T22:00:00Z'), [
    ['2026-10-30T07:00:00.000Z', '2026-10-30T15:00:00.000Z'],
  ]);
});

test('OD-335 case 2: the reverse order (ADD 09:00-17:00, then whole-day REMOVE) gives none', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: [block(4, '08:00', '20:00')],
    exceptions: [
      ex('2026-10-30', 'ADD', '09:00', '17:00', '2026-10-21T10:00:00Z'),
      ex('2026-10-30', 'REMOVE', null, null, '2026-10-21T10:05:00Z'),
    ],
  });
  assert.deepEqual(on(spans, '2026-10-29T22:00:00Z', '2026-10-30T22:00:00Z'), []);
});

test('OD-335 case 3: two exceptions sharing created_at (one transaction) order by id', () => {
  const t = '2026-10-21T10:00:00Z';
  const remove = ex('2026-10-30', 'REMOVE', null, null, t, '01J0000000000000000000000A');
  const add = ex('2026-10-30', 'ADD', '09:00', '17:00', t, '01J0000000000000000000000B');
  const later = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: [],
    exceptions: [add, remove],
  });
  assert.deepEqual(
    on(later, '2026-10-29T22:00:00Z', '2026-10-30T22:00:00Z'),
    [['2026-10-30T07:00:00.000Z', '2026-10-30T15:00:00.000Z']],
    'the higher id (the ADD) applies last, whatever the array order',
  );
  const swapped = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: [],
    exceptions: [
      { ...add, id: '01J0000000000000000000000A' },
      { ...remove, id: '01J0000000000000000000000B' },
    ],
  });
  assert.deepEqual(
    on(swapped, '2026-10-29T22:00:00Z', '2026-10-30T22:00:00Z'),
    [],
    'with the ids swapped, the REMOVE applies last',
  );
  assert.ok(compareExceptions(remove, add) < 0);
});

test('OD-335 case 4: created_at decides before id — the earlier created_at carries the LARGER id (two writers) and still applies first', () => {
  // ids are monotonic only within one process (`ids.ts`); two `core` tasks can write a later
  // exception under a smaller id. Contract §2: (`on_date`, `created_at`, `id`).
  const big = '01J0000000000000000000000Z';
  const small = '01J00000000000000000000001';
  assert.ok(small < big, 'the fixture: the later row carries the smaller id');
  const remove = ex('2026-10-30', 'REMOVE', null, null, '2026-10-21T10:00:00Z', big);
  const add = ex('2026-10-30', 'ADD', '09:00', '17:00', '2026-10-21T10:05:00Z', small);
  for (const exceptions of [
    [remove, add],
    [add, remove],
  ]) {
    assert.deepEqual(
      on(
        materialise({ bookable: true, today: '2026-10-20', templates: [], exceptions }),
        '2026-10-29T22:00:00Z',
        '2026-10-30T22:00:00Z',
      ),
      [['2026-10-30T07:00:00.000Z', '2026-10-30T15:00:00.000Z']],
      'REMOVE (earlier created_at, larger id) then ADD: the ADD applies last',
    );
  }
  const addFirst = ex('2026-10-30', 'ADD', '09:00', '17:00', '2026-10-21T10:00:00Z', big);
  const removeLater = ex('2026-10-30', 'REMOVE', null, null, '2026-10-21T10:05:00Z', small);
  assert.deepEqual(
    on(
      materialise({
        bookable: true,
        today: '2026-10-20',
        templates: [],
        exceptions: [removeLater, addFirst],
      }),
      '2026-10-29T22:00:00Z',
      '2026-10-30T22:00:00Z',
    ),
    [],
    'the mirror: ADD (earlier, larger id) then REMOVE (later, smaller id) gives none',
  );
  assert.ok(compareExceptions(remove, add) < 0);
  assert.ok(compareExceptions(removeLater, addFirst) > 0);
});

test('a later exception overrides an earlier one only over the window it covers', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: [block(4, '08:00', '20:00')],
    exceptions: [
      ex('2026-10-30', 'REMOVE', null, null, '2026-10-21T10:00:00Z'),
      ex('2026-10-30', 'ADD', '09:00', '10:00', '2026-10-21T10:01:00Z'),
      ex('2026-10-30', 'REMOVE', '09:30', '12:00', '2026-10-21T10:02:00Z'),
    ],
  });
  // 09:00-09:30 local survives (09:00 EET = 07:00Z)
  assert.deepEqual(on(spans, '2026-10-29T22:00:00Z', '2026-10-30T22:00:00Z'), [
    ['2026-10-30T07:00:00.000Z', '2026-10-30T07:30:00.000Z'],
  ]);
});

test('an ADD touching a template block coalesces with it (U-14 (a), block + ADD)', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: [block(4, '16:00', '20:00')],
    exceptions: [ex('2026-10-30', 'ADD', '20:00', '22:00', '2026-10-21T10:00:00Z')],
  });
  assert.deepEqual(on(spans, '2026-10-29T22:00:00Z', '2026-10-30T22:00:00Z'), [
    ['2026-10-30T14:00:00.000Z', '2026-10-30T20:00:00.000Z'],
  ]);
});

test('E.3 U-16 (a): 03:00-04:00 on 29 Mar 2026 (spring gap) resolves empty and is dropped; 02:30-04:30 is one hour (host: 00:30Z -> 01:30Z)', () => {
  const gap = materialise({
    bookable: true,
    today: '2026-03-20',
    exceptions: [],
    templates: [block(6, '03:00', '04:00')],
  });
  assert.deepEqual(on(gap, '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z'), []);
  const around = materialise({
    bookable: true,
    today: '2026-03-20',
    exceptions: [],
    templates: [block(6, '02:30', '04:30')],
  });
  assert.deepEqual(on(around, '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z'), [
    ['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z'],
  ]);
});

test('E.3 U-16 (a): 03:00-04:00 on 25 Oct 2026 (autumn ambiguity) starts at the FIRST 03:00 (EEST, 00:00Z) and ends 04:00 EET (02:00Z): two hours', () => {
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    exceptions: [],
    templates: [block(6, '03:00', '04:00')],
  });
  assert.deepEqual(on(spans, '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z'), [
    ['2026-10-25T00:00:00.000Z', '2026-10-25T02:00:00.000Z'],
  ]);
});

test('E.3 U-16 (a): the same on 28 Mar 2027 (dropped) and 31 Oct 2027 (00:00Z -> 02:00Z)', () => {
  const spring = materialise({
    bookable: true,
    today: '2027-03-20',
    exceptions: [],
    templates: [block(6, '03:00', '04:00')],
  });
  assert.deepEqual(on(spring, '2027-03-27T12:00:00Z', '2027-03-28T12:00:00Z'), []);
  const autumn = materialise({
    bookable: true,
    today: '2027-10-25',
    exceptions: [],
    templates: [block(6, '03:00', '04:00')],
  });
  assert.deepEqual(on(autumn, '2027-10-30T12:00:00Z', '2027-10-31T12:00:00Z'), [
    ['2027-10-31T00:00:00.000Z', '2027-10-31T02:00:00.000Z'],
  ]);
});

test('a whole-day REMOVE on the autumn DST Sunday removes the 25-hour local day exactly (host: 2026-10-24T21:00Z -> 2026-10-25T22:00Z)', () => {
  const all = [0, 1, 2, 3, 4, 5, 6].map((w) => block(w, '00:00', '24:00'));
  const spans = materialise({
    bookable: true,
    today: '2026-10-20',
    templates: all,
    exceptions: [ex('2026-10-25', 'REMOVE', null, null, '2026-10-21T00:00:00Z')],
  });
  assert.deepEqual(on(spans, '2026-10-24T00:00:00Z', '2026-10-26T12:00:00Z'), [
    ['2026-10-19T21:00:00.000Z', '2026-10-24T21:00:00.000Z'],
    ['2026-10-25T22:00:00.000Z', '2026-12-14T22:00:00.000Z'],
  ]);
});

test('a malformed row is refused, not guessed: an ADD with no times, one NULL time, a time with seconds, weekday 7', () => {
  const base = { bookable: true, today: '2026-10-20', templates: [] as TemplateRow[] };
  assert.throws(
    () =>
      materialise({
        ...base,
        exceptions: [ex('2026-10-30', 'ADD', null, null, '2026-10-21T00:00:00Z')],
      }),
    { name: 'InvalidInputError' },
  );
  assert.throws(
    () =>
      materialise({
        ...base,
        exceptions: [ex('2026-10-30', 'REMOVE', '10:00', null, '2026-10-21T00:00:00Z')],
      }),
    { name: 'InvalidInputError' },
  );
  assert.throws(
    () => materialise({ ...base, exceptions: [], templates: [block(1, '10:00:30', '11:00')] }),
    { name: 'InvalidInputError' },
  );
  assert.throws(
    () => materialise({ ...base, exceptions: [], templates: [block(7, '10:00', '11:00')] }),
    { name: 'InvalidInputError' },
  );
});

test('interval algebra: union merges touching and overlapping; subtract splits', () => {
  assert.deepEqual(
    unionInterval(
      [
        [0, 10],
        [20, 30],
      ],
      [10, 20],
    ),
    [[0, 30]],
  );
  assert.deepEqual(
    unionInterval(
      [
        [0, 10],
        [20, 30],
      ],
      [12, 15],
    ),
    [
      [0, 10],
      [12, 15],
      [20, 30],
    ],
  );
  assert.deepEqual(unionInterval([[5, 6]], [0, 1]), [
    [0, 1],
    [5, 6],
  ]);
  assert.deepEqual(unionInterval([[0, 1]], [3, 3]), [[0, 1]]);
  assert.deepEqual(subtractInterval([[0, 30]], [10, 20]), [
    [0, 10],
    [20, 30],
  ]);
  assert.deepEqual(
    subtractInterval(
      [
        [0, 10],
        [20, 30],
      ],
      [5, 25],
    ),
    [
      [0, 5],
      [25, 30],
    ],
  );
  assert.deepEqual(subtractInterval([[0, 10]], [10, 20]), [[0, 10]]);
});
