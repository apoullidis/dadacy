/**
 * THE `MinorUnits` WIRE FORMAT — PROTOCOL §9.6 / SD §SE-5: "Money is `bigint`
 * minor units (EUR cents), never a float, and never crosses the wire from the
 * client."
 *
 * WHY THIS MODULE EXISTS, measured rather than assumed: `MinorUnits` is a
 * branded `bigint`, and **`JSON.stringify` of a `bigint` THROWS**
 * (`TypeError: Do not know how to serialize a BigInt`) — measured by
 * `qa-verification` verifying T-023, and re-measured in T-022's evidence
 * block M1. So a `MinorUnits` cannot reach the wire at all unless something
 * converts it, and the obvious conversions are the two that lose money:
 * `Number(amount)` (a float, which silently rounds past 2^53) and a bare
 * `number` in the schema.
 *
 * THE FORMAT: **a JSON string holding the decimal integer number of minor
 * units**, e.g. `"5042"` for €50.42, `"-250"` for a refund line. Signed,
 * no leading zeros, no decimal point, no exponent, no thousands separator.
 * A string, not a number, because JSON numbers are IEEE-754 doubles and the
 * column is a Postgres `bigint`: `9007199254740993` does not survive a
 * round trip through a JSON number, and it does survive as a string.
 *
 * THE TESTS THAT FAIL IF A FLOAT OR A BARE `number` EVER REACHES THE WIRE —
 * three, at three layers, because one of them is not enough:
 *   - RUNTIME, the schema: `money-wire.test.ts` ›
 *     *the wire schema refuses a number, a float, and a decimal string: only a
 *     decimal-integer STRING is money on the wire*. It plants `5042` (a bare
 *     number), `50.42` (a float), `'50.42'`, `'5e3'`, `'0.0'`, `'007'`,
 *     `'+1'`, `' 1'` and `NaN`, and requires each to be refused.
 *   - COMPILE TIME: `type-tests/refusals.ts` ›
 *     `encodeMinorUnits(5042)` is TS2345 `'number'` → `'MinorUnits'`, so a
 *     `number` cannot even be handed to the encoder. Pinned by
 *     `pnpm -w typecheck` (which is in `gate:pr`) — see the bound in
 *     T-022 § Published contract §7: typecheck accepts ANY error on a
 *     directive line, so it proves the line errors, not why.
 *   - THE DOCUMENT: `openapi.test.ts` ›
 *     *every money field in the generated document is a pattern-constrained
 *     STRING, never a number or an integer*, which walks `openapi.json` itself
 *     rather than the Zod schema, so a generator that emitted
 *     `"type": "number"` would be caught by a reading that is not Zod's.
 *
 * WHAT IS NOT CONSTRAINED BY THE DOCUMENT, stated because it is a real gap:
 * the int64 RANGE is enforced by `decodeMinorUnits` (through T-023's
 * `parseMinorUnits`), NOT by the pattern, and JSON Schema cannot express it
 * over a string. So `openapi.json` accepts `"9223372036854775808"`, which the
 * decoder refuses. Pinned by `money-wire.test.ts` ›
 * *the wire pattern accepts a value the decoder refuses: the int64 range is
 * the decoder's, not the document's*, which goes red the day the document
 * gains the constraint.
 */
import { parseMinorUnits, type MinorUnits } from '@kinvara/domain-types';
import * as z from 'zod';

/**
 * A decimal integer: no sign on zero, no leading zeros, no point, no exponent.
 * Deliberately the same language T-023's `parseMinorUnits` accepts. That the
 * two agree is asserted, not assumed, over a shared corpus:
 * `money-wire.test.ts` › *the wire schema and T-023's parseMinorUnits accept
 * and refuse exactly the same strings*.
 */
export const MINOR_UNITS_PATTERN = /^(?:0|-?[1-9][0-9]*)$/;

/** The wire type of a money amount: a decimal-integer string of minor units. */
export const MinorUnitsWire = z.string().regex(MINOR_UNITS_PATTERN);

/**
 * SD §BE-2 carries the currency alongside the amount; it is not part of
 * `MinorUnits`.
 *
 * `strictObject`, not `object`, and the reason is a divergence the conformance
 * corpus found rather than one anybody predicted: a plain `z.object` STRIPS an
 * unknown key at run time and succeeds, while `z.toJSONSchema` emits
 * `additionalProperties: false` for it, which REFUSES the same payload. Zod
 * and the published document would then disagree about a body carrying an
 * extra field — the document being the stricter of the two, so a client that
 * validated against the document would reject what our own schema accepted.
 * `strictObject` makes the runtime match the document it generates.
 * Held by `openapi.test.ts` › *Zod and the generated document agree, payload
 * by payload, on every case in the corpus*, whose corpus includes an
 * extra-key payload for exactly this reason.
 *
 * CONSEQUENCE, stated because it is a real trade: this response type is
 * CLOSED. Adding a field to a response is a breaking change for any client
 * that validates with this schema, so it goes with a version bump rather than
 * being added quietly. That is the intended posture for a contract package;
 * it is not a forward-compatible envelope.
 */
export const Money = z.strictObject({
  currency: z.literal('EUR'),
  amountMinor: MinorUnitsWire,
});

/**
 * `MinorUnits` -> wire. The ONLY supported way to put money in a payload.
 * `bigint.toString()` is exact at every magnitude; `Number(amount)` is not,
 * and `JSON.stringify` of the raw value throws.
 */
export function encodeMinorUnits(amount: MinorUnits): string {
  return amount.toString();
}

/**
 * Wire -> `MinorUnits`. Delegates to T-023's `parseMinorUnits`, which refuses
 * a non-string, a non-decimal-integer, and anything outside int64, and throws
 * `InvalidInputError` naming `field` and never carrying the value.
 */
export function decodeMinorUnits(value: unknown, field: string): MinorUnits {
  return parseMinorUnits(value, field);
}
