/**
 * Compile-time refusals — T-023's branded-type contract, stated as code. This
 * file is never executed; it exists to be compiled.
 *
 * Each line under a `// @ts-expect-error TSnnnn 'A' 'B'` directive is a misuse
 * the compiler must refuse. Two things check it, from two directions, and ONLY
 * THE WEAKER ONE IS IN A GATE:
 *   - `pnpm -w typecheck` (in `gate:pr`) fails with TS2578 if any such line
 *     stops being an error. That alone would accept ANY error on the line.
 *   - `src/compile-refusals.test.ts` compiles this file with the directives
 *     stripped and requires, per directive, exactly one diagnostic on the next
 *     line, with that code, whose first message line names every quoted type;
 *     and no diagnostic anywhere else. It is in NO gate (OD-57). It runs only
 *     when someone runs `pnpm --filter @kinvara/domain-types test` or
 *     `pnpm -w test` by hand.
 * NEITHER sees a row DELETED, directive and line together. Typecheck stays
 * green, and the test requires only 20 directives in total (the gate case
 * once, the money case twice), so any two other rows can vanish unseen.
 * Lines marked CONTROL must compile: they bound what is NOT refused.
 */
import type { Brand } from '../src/brand.ts';
import type { AccountId, BookingId, SessionId, Ulid } from '../src/ids.ts';
import type { MinorUnits } from '../src/money.ts';
import type { E164 } from '../src/phone.ts';
import type { IanaZone } from '../src/time.ts';
import { accountId, bookingId, sessionId, ulid } from '../src/ids.ts';
import { minorUnits, parseMinorUnits } from '../src/money.ts';
import { e164 } from '../src/phone.ts';
import { ianaZone, resolveLocal } from '../src/time.ts';
import { NotFoundError, PolicyDeniedError } from '../src/errors.ts';

declare function takesSession(id: SessionId): void;
declare function takesBooking(id: BookingId): void;
declare function takesAccount(id: AccountId): void;
declare function takesUlid(id: Ulid): void;
declare function takesMoney(amount: MinorUnits): void;
declare function takesE164(phone: E164): void;
declare function takesZone(zone: IanaZone): void;
declare function takesString(s: string): void;
declare function takesBigint(n: bigint): void;

declare const booking: BookingId;
declare const session: SessionId;
declare const account: AccountId;
declare const someUlid: Ulid;
declare const money: MinorUnits;
declare const phone: E164;
declare const zone: IanaZone;
declare const raw: string;
declare const rawNumber: number;
declare const rawBigint: bigint;
declare const eitherId: Brand<Ulid, 'BookingId' | 'SessionId'>;
declare const bothIds: BookingId & SessionId;

// ── entity ids: no id is another id ─────────────────────────────────────────
// @ts-expect-error TS2345 'BookingId' 'SessionId'
takesSession(booking);
// @ts-expect-error TS2345 'SessionId' 'BookingId'
takesBooking(session);
// @ts-expect-error TS2345 'AccountId' 'BookingId'
takesBooking(account);
// @ts-expect-error TS2345 'BookingId' 'AccountId'
takesAccount(booking);
// @ts-expect-error TS2345 'AccountId' 'SessionId'
takesSession(account);
// @ts-expect-error TS2345 'SessionId' 'AccountId'
takesAccount(session);
// ── and an unqualified Ulid, or a plain string, is no id ────────────────────
// @ts-expect-error TS2345 'Ulid' 'SessionId'
takesSession(someUlid);
// @ts-expect-error TS2345 'string' 'SessionId'
takesSession(raw);
// @ts-expect-error TS2345 'string' 'Ulid'
takesUlid(raw);
// ── a cast between two sibling brands is refused … ──────────────────────────
// @ts-expect-error TS2352 'BookingId' 'SessionId'
takesSession(booking as SessionId);

// ── money: bigint minor units, never a number (PROTOCOL §9.6) ───────────────
// @ts-expect-error TS2345 'number' 'MinorUnits'
takesMoney(rawNumber);
// @ts-expect-error TS2345 'number' 'MinorUnits'
takesMoney(5042);
// @ts-expect-error TS2345 'bigint' 'MinorUnits'
takesMoney(rawBigint);
// @ts-expect-error TS2322 'bigint' 'MinorUnits'
const sum: MinorUnits = money + money;
// @ts-expect-error TS2322 'MinorUnits' 'number'
const asNumber: number = money;

// ── phone and zone: two string brands, neither a string nor each other ──────
// @ts-expect-error TS2345 'string' 'E164'
takesE164(raw);
// @ts-expect-error TS2345 'IanaZone' 'E164'
takesE164(zone);
// @ts-expect-error TS2345 'string' 'IanaZone'
takesZone(raw);
// @ts-expect-error TS2345 'E164' 'IanaZone'
takesZone(phone);
// @ts-expect-error TS2345 'string' 'IanaZone'
resolveLocal({ date: '2026-03-29', time: '03:30' }, 'Europe/Nicosia');

// ── errors: no caller prose, and a denial states its basis ──────────────────
// @ts-expect-error TS2559 '"card 12345 expired"' 'DomainErrorOptions'
throw new NotFoundError('card 12345 expired');
// @ts-expect-error TS2345 '{}' 'PolicyDeniedOptions'
throw new PolicyDeniedError({});

// ── CONTROL: what compiles, and is therefore NOT refused ───────────────────
// every entity id is a Ulid
takesUlid(account);
takesUlid(booking);
takesUlid(session);
// a brand widens to its underlying type
takesString(booking);
takesString(phone);
takesBigint(money);
// … but a cast from the underlying type is the escape hatch, and compiles
takesSession(raw as SessionId);
takesMoney(rawBigint as MinorUnits);
// the constructors return the brand
takesSession(sessionId(raw, 'sessionId'));
takesBooking(bookingId(raw, 'bookingId'));
takesAccount(accountId(raw, 'accountId'));
takesUlid(ulid(raw, 'id'));
takesMoney(minorUnits(rawBigint, 'amountMinor'));
takesMoney(parseMinorUnits(raw, 'amountMinor'));
takesMoney(minorUnits(money + money, 'total'));
takesE164(e164(raw, 'phone'));
takesZone(ianaZone(raw, 'tz'));
// an `any` flows into every brand. JSON.parse returns `any`, and neither tsc
// nor gate:lint refuses it (OD-60), a float into MinorUnits included. At a
// JSON boundary the runtime constructors are the only refusal: call them.
takesSession(JSON.parse(raw));
takesMoney(JSON.parse('{"amountMinor":50.42}').amountMinor);
// a cast through `unknown` reaches any brand, sibling to sibling included
takesSession(booking as unknown as SessionId);
// a brand whose tag is a union, or an intersection of two brands, goes to BOTH
// siblings: the tag record reads "A and B", not "A or B" (T-023 QA-F4)
takesSession(eitherId);
takesBooking(eitherId);
takesSession(bothIds);
takesBooking(bothIds);

export { sum, asNumber };
