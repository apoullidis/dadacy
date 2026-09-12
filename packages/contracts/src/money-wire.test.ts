/**
 * The `MinorUnits` wire format (PROTOCOL §9.6). See `money-wire.ts`'s header
 * for the format and for which test holds which claim.
 *
 * OD-57: no gate runs this file.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  InvalidInputError,
  minorUnits,
  parseMinorUnits,
  type MinorUnits,
} from '@kinvara/domain-types';
import {
  ENCODE_REFUSED,
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

/**
 * T-022 rework 1 — `qa-verification` QA-F1. The encoder was a bare
 * `amount.toString()`, so a `number` cast past the compile-time check became a
 * wire-valid, silently corrupted amount. QA's three reproductions are
 * committed here verbatim.
 *
 * Each case asserts the REFUSAL — the exact `TypeError` and its exact message
 * — not merely that the call threw. PROTOCOL §5.1: "did nothing", "refused"
 * and "crashed" must be three distinguishable outcomes, and a test that
 * accepted any throw would go green on a crash.
 */
test('the encoder REFUSES a bare number at run time: QA-F1 three reproductions, each asserting the refusal and not merely a throw', () => {
  // [what QA passed, what the UNGUARDED encoder returned for it]
  //
  // The two large values are built with `Number(<string>)` rather than written
  // as numeric literals, for two reasons that point the same way. ESLint's
  // `no-loss-of-precision` (in `js.configs.recommended`, so in `gate:lint`, so
  // in `gate:pr`) refuses the literal form outright — the rule and this test
  // are making the same point. And `Number(<string>)` is the shape the value
  // actually arrives in at a JSON boundary, which is the route T-023
  // § Published contract §3 leaves open (OD-60). The corruption is asserted
  // below, so nothing here depends on how the number was spelled.
  const reproductions: [number, string][] = [
    [5042, '5042'], // a bare number: wire-accepts, doc-accepts
    [Number('9007199254740993'), '9007199254740992'], // off by ONE minor unit
    [Number('12345678901234567'), '12345678901234568'],
  ];
  for (const [value, corrupted] of reproductions) {
    // The premise, asserted first: this IS what the bare toString() produced,
    // and it IS a string the wire reading accepts. Without this the test could
    // pass against an encoder that had never been able to corrupt anything.
    assert.equal(String(value), corrupted);
    assert.equal(MinorUnitsWire.safeParse(corrupted).success, true);

    let caught: unknown;
    try {
      encodeMinorUnits(value as unknown as MinorUnits);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof TypeError, `not refused: ${String(value)}`);
    assert.equal(caught.message, ENCODE_REFUSED);
  }
  // QA's closing comparison, now in the only direction left: the true bigint
  // still encodes exactly, and the same amount arriving as a JS number no
  // longer encodes at all, so the two can no longer agree by corruption.
  assert.equal(encodeMinorUnits(minorUnits(9007199254740993n, 'amountMinor')), '9007199254740993');
});

test('the encoder refuses every non-bigint shape, and still encodes a real bigint: the guard is narrow, not a blanket refusal', () => {
  const refused: unknown[] = [
    5042, // a bare number
    50.42, // a float
    -0.01,
    Number.NaN, // encoded as "NaN" before the guard
    1e21, // encoded as "1e+21" before the guard
    Number.MAX_SAFE_INTEGER + 2,
    '5042', // the already-encoded string
    '50.42',
    '',
    null,
    undefined,
    {},
    { toString: () => '5042' }, // an object that fakes the encoding
    [5042],
    true,
    Object(5042n), // a BigInt WRAPPER object: typeof is "object", not "bigint"
  ];
  for (const bad of refused) {
    let caught: unknown;
    try {
      encodeMinorUnits(bad as MinorUnits);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof TypeError, `accepted ${String(bad)}`);
    assert.equal(caught.message, ENCODE_REFUSED, `wrong refusal for ${String(bad)}`);
  }
  // CONTROL / non-vacuity: a guard that refused everything would pass the loop
  // above. A real MinorUnits still encodes, at three magnitudes and both signs.
  assert.equal(encodeMinorUnits(minorUnits(5042n, 'amountMinor')), '5042');
  assert.equal(encodeMinorUnits(minorUnits(-250n, 'amountMinor')), '-250');
  assert.equal(encodeMinorUnits(minorUnits(0n, 'amountMinor')), '0');
});

test('the encoder refusal never echoes the rejected value, in message or stack', () => {
  // PROTOCOL §9.2 / SA I-3 layers 5-6. The rejected amount is an input, and a
  // refusal that printed it would put it in every logged stack.
  const canary = 424242424242;
  let caught: unknown;
  try {
    encodeMinorUnits(canary as unknown as MinorUnits);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof TypeError);
  assert.equal(caught.message, ENCODE_REFUSED);
  assert.equal(caught.message.includes('424242424242'), false);
  assert.equal(String(caught.stack).includes('424242424242'), false);
});

test('LIMITATION: the encoder guard is a type check, not a range check', () => {
  // 2^63, one past the Postgres bigint ceiling. `minorUnits()` refuses it, so
  // it can only arrive by a cast — and the guard, which asks only `typeof`,
  // lets it through. `decodeMinorUnits` remains the only refusal, exactly as
  // the int64-range test above states. This test goes red the day the encoder
  // gains a range check, which is the signal to widen the guard's claim.
  const outOfRange = 2n ** 63n;
  assert.throws(() => minorUnits(outOfRange, 'amountMinor'), InvalidInputError);
  const wire = encodeMinorUnits(outOfRange as MinorUnits);
  assert.equal(wire, '9223372036854775808');
  assert.equal(MinorUnitsWire.safeParse(wire).success, true);
  assert.throws(() => decodeMinorUnits(wire, 'amountMinor'), InvalidInputError);
});
