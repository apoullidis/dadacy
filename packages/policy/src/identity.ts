/**
 * THE INPUT CONTRACT — the root this ticket (`T-134`) exists to fix.
 *
 * `can()` is handed its facts by a caller. `actor.accountId` comes from the
 * service JWT's `actor_id` (SD §BE-10's token model) and every `ResourceRef`
 * field is built from database rows. Neither is refused by anything on the way
 * in: OD-60 measured that an `any` flows into every branded type unchallenged,
 * so a field TYPED `AccountId` can hold `null`, `''`, `0` or an object at run
 * time. `packages/domain-types`' constructors (`T-023`) do refuse a malformed
 * id, but they THROW, and an authorisation layer must answer a Decision rather
 * than crash — so `isUlid`, the non-throwing predicate from the same module, is
 * what this package validates with.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than an `=== undefined` check per grant.
 * The defect that failed `T-024` three times running was never one evaluator:
 * it was comparing two CALLER-SUPPLIED fields to each other and testing their
 * presence with `=== undefined`. `null !== null` is false, so two absent ends
 * "agreed" and the call was allowed:
 *
 *   - QA3-F1 measured 12 such allows on `child.health` through the `window`
 *     grant, with `basis: 'confirmed_booking_window'` going to the audit log
 *     (SD §BE-10 line 1309) for a relationship nothing had established.
 *   - `T-134` measured 15 more that were still live: `owns()` allows when the
 *     actor's id AND the owner are the same junk (4 spellings), `countersigned()`
 *     allows on a `null` countersigner against a perfectly real actor (a NULL
 *     column is what an un-countersigned row holds), and `coversLocale()`
 *     allows when both the language list and the locale are junk.
 *
 * So the rule is stated ONCE, as a mechanism, and every identity comparison in
 * `can.ts` goes through it:
 *
 *   TWO CALLER-SUPPLIED FIELDS ARE NEVER COMPARED TO EACH OTHER UNLESS BOTH
 *   ARE KNOWN-GOOD, AND ABSENCE IS REFUSED HOWEVER IT IS SPELLED.
 *
 * A comparison a caller can satisfy by supplying nothing is not a check.
 */
import { isUlid } from '@kinvara/domain-types';

/**
 * Is this a well-formed identifier — the only thing this package will compare?
 *
 * `isUlid` is `T-023`'s canonical form: 26 characters of Crockford base32,
 * upper case, first character 0-7. Everything else is refused, which is every
 * spelling of absence at once — `undefined`, `null`, `''`, `0`, `NaN`, an
 * object, a lower-cased id — without this file having to enumerate them.
 *
 * Exported for the same reason `isRole` is: a caller can ask the question at
 * its own boundary, where a malformed `actor_id` can still be told apart from a
 * legitimate refusal. It cannot be told apart from the `Decision` — SD §BE-10's
 * `DenyReason` set is closed and this package does not extend it, so a junk id
 * denies with `role_missing` exactly as a real id holding no permission does.
 */
export function knownId(value: unknown): value is string {
  return isUlid(value);
}

/**
 * Do these two name the SAME party, both being known-good?
 *
 * This is the predicate `owns()` and both ends of the `window` relationship
 * use. It is false whenever either side is not a well-formed id, so no pair of
 * absent, empty or junk values can ever satisfy it — which is the whole defect
 * family above, closed in one place.
 */
export function sameId(a: unknown, b: unknown): boolean {
  if (!knownId(a) || !knownId(b)) return false;
  return a === b;
}

/**
 * Do these two name DIFFERENT parties, both being known-good?
 *
 * `four_eyes` needs this rather than a bare `!==`, and the asymmetry is the
 * point: a bare `!==` is satisfied by a countersigner that does not exist, so
 * absence PASSED the four-eyes check (SA §SA-4 I-5) instead of failing it.
 * Requiring both ends to be known-good first makes "a second, different actor"
 * mean a second, different actor.
 */
export function differentId(a: unknown, b: unknown): boolean {
  if (!knownId(a) || !knownId(b)) return false;
  return a !== b;
}
