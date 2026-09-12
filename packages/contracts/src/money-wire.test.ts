/**
 * The `MinorUnits` wire format (PROTOCOL §9.6). See `money-wire.ts`'s header
 * for the format and for which test holds which claim.
 *
 * OD-57: no gate runs this file.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { InvalidInputError, minorUnits, parseMinorUnits } from '@kinvara/domain-types';
import {
  MINOR_UNITS_PATTERN,
  MinorUnitsWire,
  Money,
  decodeMinorUnits,
  encodeMinorUnits,
} from './money-wire.ts';

/** Above 2^53: a JSON number cannot carry it, a decimal string can. */
const BEYOND_DOUBLE = 9007199254740993n;

test('JSON.stringify of a MinorUnits THROWS, which is the whole reason this module exists', () => {
  const amount = minorUnits(5042n, 'amountMinor');
  // Measured, not assumed — this is the behaviour carried to T-022 in CONTRACTS.md.
  assert.throws(
    () => JSON.stringify({ amountMinor: amount }),
    (e: unknown) => e instanceof TypeError && /BigInt/i.test(e.message),
  );
  // And the encoder is what makes the value serialisable at all.
  assert.equal(JSON.stringify({ amountMinor: encodeMinorUnits(amount) }), '{"amountMinor":"5042"}');
});

test('the wire schema refuses a number, a float, and a decimal string: only a decimal-integer STRING is money on the wire', () => {
  const refused: unknown[] = [
    5042, // a bare number — the shape PROTOCOL §9.6 exists to prevent
    50.42, // a float
    -0.01,
    '50.42', // a decimal string
    '5e3',
    '0.0',
    '007',
    '+1',
    ' 1',
    '1 ',
    '',
    '-0',
    'NaN',
    Number.NaN,
    5042n, // the unencoded bigint: it never reaches JSON anyway (test above)
    null,
    undefined,
    { amountMinor: '5042' },
  ];
  for (const bad of refused) {
    assert.equal(MinorUnitsWire.safeParse(bad).success, false, `accepted ${String(bad)}`);
  }
  for (const good of ['0', '1', '5042', '-250', '9007199254740993']) {
    assert.equal(MinorUnitsWire.safeParse(good).success, true, `refused ${good}`);
  }
  // Non-vacuity: a schema that refused everything would pass the first loop.
  assert.equal(MinorUnitsWire.safeParse('5042').success, true);
});

test('the wire schema and T-023 parseMinorUnits accept and refuse exactly the same strings', () => {
  // Two independently written readings of "a decimal integer": the regex here
  // and T-023's in packages/domain-types. The int64 range is the one place
  // they part company, and it has its own test below.
  const corpus = [
    '0',
    '1',
    '5042',
    '-250',
    '9007199254740993',
    '9223372036854775807',
    '007',
    '-0',
    '',
    '+1',
    ' 1',
    '1 ',
    '50.42',
    '5e3',
    '0x10',
    'abc',
    '٤٢',
    '१२',
  ];
  for (const s of corpus) {
    const bySchema = MinorUnitsWire.safeParse(s).success;
    let byDecoder = true;
    try {
      parseMinorUnits(s, 'amountMinor');
    } catch {
      byDecoder = false;
    }
    assert.equal(bySchema, byDecoder, `disagreement on ${JSON.stringify(s)}`);
  }
  // Non-vacuity: the corpus must contain cases of both verdicts.
  const accepted = corpus.filter((s) => MinorUnitsWire.safeParse(s).success);
  assert.ok(accepted.length >= 6 && accepted.length < corpus.length, String(accepted.length));
});

test('the wire pattern accepts a value the decoder refuses: the int64 range is the decoders, not the documents', () => {
  // 2^63, one past the Postgres bigint ceiling. JSON Schema cannot express an
  // integer range over a string, so `openapi.json` accepts this and the
  // decoder is the only thing that refuses it. This test goes red the day the
  // document gains the constraint, which is the signal to narrow the sentence
  // in money-wire.ts's header.
  const overflow = '9223372036854775808';
  assert.equal(MINOR_UNITS_PATTERN.test(overflow), true);
  assert.equal(MinorUnitsWire.safeParse(overflow).success, true);
  assert.throws(() => decodeMinorUnits(overflow, 'amountMinor'), InvalidInputError);
  // The ceiling itself is accepted by both.
  assert.equal(decodeMinorUnits('9223372036854775807', 'amountMinor'), 9223372036854775807n);
});

test('Money round-trips exactly at magnitudes a JSON number would corrupt', () => {
  const amount = minorUnits(BEYOND_DOUBLE, 'amountMinor');
  const wire = encodeMinorUnits(amount);
  assert.equal(wire, '9007199254740993');
  assert.equal(decodeMinorUnits(wire, 'amountMinor'), amount);
  // The same value through a JSON number does NOT survive. This is the
  // measurement behind "a string, not a number".
  assert.notEqual(String(Number(wire)), wire);
  assert.equal(String(Number(wire)), '9007199254740992');

  assert.equal(Money.safeParse({ currency: 'EUR', amountMinor: wire }).success, true);
  assert.equal(Money.safeParse({ currency: 'USD', amountMinor: wire }).success, false);
  assert.equal(Money.safeParse({ currency: 'EUR', amountMinor: 5042 }).success, false);
  assert.equal(Money.safeParse({ currency: 'EUR', amountMinor: 50.42 }).success, false);
});

test('decodeMinorUnits refuses a float, naming the field and never echoing the value', () => {
  // PROTOCOL §9.2 / SD §BE-2: the refusal carries the field NAME, not the input.
  let caught: unknown;
  try {
    decodeMinorUnits('50.42', 'amountMinor');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof InvalidInputError);
  assert.equal(caught.field, 'amountMinor');
  assert.equal(caught.message, 'invalid_input');
  assert.equal(String(caught.message).includes('50.42'), false);
  assert.equal(String(caught.stack).includes('50.42'), false);
});
