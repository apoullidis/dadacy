/**
 * COMPILE-TIME REFUSALS for the queue payload base — T-147, SD §BE-14.
 * This file is never executed; it exists to be compiled.
 *
 * Each line under a `// @ts-expect-error TSnnnn …` directive is a misuse the
 * compiler must refuse. `pnpm -w typecheck` — which IS in `gate:pr` — fails
 * with TS2578 if any of them stops being an error, because an unused
 * `@ts-expect-error` is itself an error.
 *
 * THE IDENTIFIERS ARE SHORT ON PURPOSE. A `@ts-expect-error` applies to the
 * NEXT LINE, so every misuse below must fit on one line at Prettier's
 * `printWidth: 100`. The first draft of this file used longer names, Prettier
 * wrapped each call, the directives landed on `enqueueNotify({` and the
 * diagnostics landed on the property lines inside — four directives became
 * TS2578 "unused" and `pnpm -w typecheck` went RED (measured; see
 * state/EP-2/T-147.md § Evidence 5). Do not lengthen these names without
 * re-running it.
 *
 * THE BOUND, identical to `type-tests/refusals.ts` and to T-023's equivalent,
 * and restated rather than assumed: **typecheck accepts ANY error on a
 * directive line.** It proves the line errors; it does not prove it errors for
 * the reason named in the directive. `packages/contracts` has no test that
 * strips the directives and requires the named diagnostic (T-022 § Published
 * contract §7), so the codes below are checked by review — they were each read
 * off a real `tsc` run, recorded in § Evidence 5.
 *
 * Lines marked CONTROL must compile: they bound what is NOT refused.
 */
import { ulid } from '@kinvara/domain-types';
import { assertLocale } from '@kinvara/i18n';
import type { NotifyJobBaseInput } from '../src/jobs.ts';

declare function enq(payload: NotifyJobBaseInput): void;
declare const raw: string;

const id = ulid('01J9ZC8QW1K2Y3M4N5P6R7S8T9', 'recipientAccountId');
const loc = assertLocale('en');
const at = '2026-09-19T20:40:00Z';

// SD §BE-14 line 1497: "There is no default." A payload TYPE that lacks
// `recipientLocale` does not compile, so the value cannot be omitted and
// filled in later from ambient context (SE-8).
// @ts-expect-error TS2345 recipientLocale is missing
enq({ recipientAccountId: id, enqueuedAt: at });

// A RAW string is not a `Locale`: only `assertLocale` produces the brand, so a
// caller cannot pass a locale it read from a header or a query parameter
// without validating it against the registry first.
// @ts-expect-error TS2322 'string' is not assignable to 'Locale'
enq({ recipientAccountId: id, recipientLocale: raw, enqueuedAt: at });

// Nor is a literal. `'en'` today is a registry row, not a type.
// @ts-expect-error TS2322 'string' is not assignable to 'Locale'
enq({ recipientAccountId: id, recipientLocale: 'en', enqueuedAt: at });

// A raw string is not a `Ulid` either — T-023's constructor is the only route.
// @ts-expect-error TS2322 'string' is not assignable to 'Ulid'
enq({ recipientAccountId: raw, recipientLocale: loc, enqueuedAt: at });

// `strictObject` is a RUN-TIME refusal of an unknown key; the excess-property
// check is the COMPILE-time one, and it fires only on an object literal.
// @ts-expect-error TS2353 object literal may only specify known properties
enq({ recipientAccountId: id, recipientLocale: loc, enqueuedAt: at, extra: 1 });

// CONTROL: the payload built from the two branded constructors compiles.
enq({ recipientAccountId: id, recipientLocale: loc, enqueuedAt: at });

// CONTROL, and it is the BOUND on every refusal above — the same route
// `type-tests/refusals.ts` records for money (OD-60, owed by T-005): `any` —
// which is what `JSON.parse` yields — flows into both brands with no compile
// error, so a payload assembled from parsed JSON COMPILES and is refused only
// once `NotifyJobBase.parse` runs. If this line ever stops compiling, the
// sentence "the compile refusal does not close the `any` route" in
// state/EP-2/T-147.md § Published contract has become false and must be
// narrowed. When OD-60's type-aware `no-unsafe-*` rules land this line turns
// `gate:lint` red, which is the intended signal.
const parsed = JSON.parse(raw);
enq({ recipientAccountId: parsed, recipientLocale: parsed, enqueuedAt: parsed });

// CONTROL: an unknown key smuggled through a VARIABLE is not refused at
// compile time — the excess-property check does not survive a widening
// assignment. `strictObject` is what refuses it, and only at run time. This
// bounds the TS2353 directive above to object literals.
const widened = { recipientAccountId: id, recipientLocale: loc, enqueuedAt: at, extra: 1 };
enq(widened);

export { widened };
