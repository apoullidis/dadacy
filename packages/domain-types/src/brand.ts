/**
 * Nominal ("branded") types — SD §DH-2: "Passing a `BookingId` where a
 * `SessionId` is expected must not compile. Where this is merely a convention
 * rather than a compile error, it will be violated."
 *
 * TypeScript is structural, so two `string` aliases are interchangeable. A
 * brand adds a phantom property keyed by a `unique symbol` that is declared
 * here and never exported: no code outside this module can name the key, so
 * no object literal can forge it. The only ways to obtain a branded value are
 * the validating constructors in this package, or an explicit `as` cast —
 * which the compiler permits from the underlying type and which is therefore
 * NOT refused (type-tests/refusals.ts, CONTROL lines).
 *
 * The key's value is a record of tags rather than one string, so brands stack:
 * `Brand<Brand<string, 'Ulid'>, 'AccountId'>` carries both tags, is assignable
 * to `Ulid`, and is not assignable to `Brand<Ulid, 'BookingId'>`, whose tag
 * record requires `BookingId`. With a single string-valued tag the two tags
 * would intersect to `never` and the type would collapse.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: { readonly [K in B]: true } };
