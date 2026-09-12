/**
 * Compile-time refusals for the money wire format. This file is never
 * executed; it exists to be compiled.
 *
 * Each line under a `// @ts-expect-error TSnnnn 'A' 'B'` directive is a misuse
 * the compiler must refuse. `pnpm -w typecheck` — which IS in `gate:pr` —
 * fails with TS2578 if any of them stops being an error, because an unused
 * `@ts-expect-error` is itself an error.
 *
 * THE BOUND, and it is the same one T-023's equivalent file states: typecheck
 * accepts ANY error on a directive line. It proves the line errors; it does
 * not prove it errors for the reason named in the directive. T-023 closes
 * that gap for `packages/domain-types` with `src/compile-refusals.test.ts`,
 * which strips the directives and requires exactly the named diagnostic.
 * **This package has no such test** — the directives here are pinned by
 * typecheck alone, and the names in them are checked by review. Recorded in
 * T-022 § Published contract §7 rather than left for a reader to assume.
 *
 * Lines marked CONTROL must compile: they bound what is NOT refused.
 */
import { minorUnits, type MinorUnits } from '@kinvara/domain-types';
import { decodeMinorUnits, encodeMinorUnits } from '../src/money-wire.ts';

declare const rawString: string;
declare const rawBigint: bigint;
declare const rawNumber: number;

const amount: MinorUnits = minorUnits(5042n, 'amountMinor');

// PROTOCOL §9.6: money is never a float and never a bare number. The encoder
// is the only supported route to the wire, and it takes a branded bigint, so
// neither a number literal nor a float can be handed to it.
// @ts-expect-error TS2345 'number' 'MinorUnits'
encodeMinorUnits(5042);
// @ts-expect-error TS2345 'number' 'MinorUnits'
encodeMinorUnits(50.42);
// @ts-expect-error TS2345 'number' 'MinorUnits'
encodeMinorUnits(rawNumber);
// An UNBRANDED bigint is refused too: the value must have been through a
// constructor, so a raw database or JSON value cannot be emitted as money.
// @ts-expect-error TS2345 'bigint' 'MinorUnits'
encodeMinorUnits(rawBigint);
// A wire string is not a MinorUnits either — that is what the decoder is for.
// @ts-expect-error TS2345 'string' 'MinorUnits'
encodeMinorUnits('5042');

// CONTROL: the branded value encodes, and the decoder returns the brand.
encodeMinorUnits(amount);
const decoded: MinorUnits = decodeMinorUnits(rawString, 'amountMinor');

export { decoded };
