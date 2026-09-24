/**
 * `can(actor, action, resource, ctx)` — SA §TS-7 layer 1, SD §BE-10.
 *
 * Every branch in this package is in this file, on purpose (see matrix.ts).
 * SD §QD-1 makes 100% branch coverage a gate rather than a target for exactly
 * this code: "This is the authorisation layer; partial coverage is not
 * acceptable." A branch nobody exercises is a permission nobody has checked.
 *
 * Pure: no I/O, no clock of its own, no ambient state. `ctx.now` is the only
 * time this function knows, which is what makes the relationship-and-time
 * scope testable at all.
 */
import type {
  Action,
  Actor,
  AllowBasis,
  BookingWindow,
  Decision,
  DenyReason,
  Grant,
  PolicyContext,
  ResourceRef,
  Role,
} from './types.ts';
import { MATRIX, cell } from './matrix.ts';
import { isRole } from './types.ts';
import { differentId, sameId } from './identity.ts';

/**
 * SA §TS-7: "from acceptance until completion + 30 days".
 *
 * Read by `windowDecision()` again since `T-134` restored the grant (under
 * OE-20 it was consulted by nothing). Held by index.test.ts 'the barrel
 * exports the two spec constants at their SD and SA values', and its value is
 * exercised to the millisecond by 'the thirtieth day is the last one inside
 * the window, to the millisecond'.
 */
export const WINDOW_TAIL_MS = 30 * 24 * 60 * 60 * 1000;

/** SD §BE-10: "Step-up (`step_up_until` within 10 minutes)". */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

const allow = (basis: AllowBasis): Decision => ({ allow: true, basis });
const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

/**
 * Which refusal an actor with several roles is told about. A multi-role actor
 * collects one refusal per role, and the most specific one is the useful one:
 * "you need a second approver" tells an operator what to do next, where
 * "you do not hold the role" does not. `role_missing` is therefore last.
 *
 * This never widens a permission — it is only consulted once EVERY role has
 * refused — and the string is logged, never returned in the 403 body
 * (SD §BE-2, SD §BE-10).
 *
 * `booking_not_confirmed` and `window_expired` are REACHABLE again since
 * `T-134` restored the `window` grant, which is their only source (under
 * OE-20 no cell could produce either). Held by 'a booking that is not yet
 * confirmed is booking_not_confirmed, in every pre-confirmation state' and by
 * 'a completed booking keeps the window open for thirty days and shuts it
 * after'.
 */
const REASON_PRECEDENCE: readonly DenyReason[] = [
  'pairing_blocked',
  'art10_model_prohibits_outcome_recording',
  'operator_does_not_cover_locale',
  'four_eyes_required',
  'step_up_required',
  'window_expired',
  'booking_not_confirmed',
  'role_missing',
];

function mostSpecific(reasons: readonly DenyReason[]): DenyReason {
  for (const candidate of REASON_PRECEDENCE) {
    if (reasons.includes(candidate)) return candidate;
  }
  return 'role_missing';
}

/** SD §BE-10: step-up is valid only if it happened within the last 10 minutes. */
function steppedUp(actor: Actor, ctx: PolicyContext): boolean {
  if (actor.stepUpUntil === undefined) return false;
  const remaining = actor.stepUpUntil.getTime() - ctx.now.getTime();
  return remaining > 0 && remaining <= STEP_UP_MAX_AGE_MS;
}

/**
 * Ownership: the record's owner IS the actor.
 *
 * `T-134`: this was `ownerAccountId === undefined` and then a bare `===`, and
 * it was believed safe on the grounds that it "compares the owner to the
 * ACTOR's own id, which junk cannot match". That is false — `actor.accountId`
 * is caller-supplied too (the JWT's `actor_id`), so when BOTH sides were the
 * same junk the grant allowed: `null`/`null`, `''`/`''`, `0`/`0` and one shared
 * object each produced `{allow: true, basis: 'own_record'}` over all 37 `own`
 * cells. Measured in § Evidence A3. `sameId` refuses every one of them.
 */
function owns(actor: Actor, resource: ResourceRef): boolean {
  return sameId(resource.ownerAccountId, actor.accountId);
}

/** SEC-9: time-boxed, and a declared purpose is what makes it auditable. */
function breakGlassActive(actor: Actor, ctx: PolicyContext): boolean {
  const bg = actor.breakGlass;
  if (bg === undefined) return false;
  if (bg.purpose.trim() === '') return false;
  return bg.expiresAt.getTime() > ctx.now.getTime();
}

/*
 * There is deliberately no `capabilityValid()` any more. See the `capability`
 * case in `evaluate()`: the grant fails closed, so there is nothing to validate.
 */

/**
 * `decisions.md` OE-21 (`T-030`): the ONLY role whose countersignature
 * satisfies SA §SA-4 I-5, whoever performed the action.
 */
const COUNTERSIGNING_ROLE: Role = 'ts_senior';

/**
 * SA §SA-4 I-5: the second actor must differ from the first — clause (a) —
 * AND hold `ts_senior` — clause (b), `T-030`, OE-21.
 *
 * `T-134`: this was `countersignedBy === undefined` and then a bare `!==`, and
 * it was the worst member of the family because it needed only ONE junk field,
 * not two. `null` is what an un-countersigned row's `countersigned_by` column
 * holds, and `null !== <a real actor id>` is TRUE — so a NULL countersigner
 * SATISFIED four-eyes against a perfectly ordinary actor, on all 9 `F4` cells
 * including `safeguarding_referral#make` and `retention_run#approve`. Six
 * spellings allowed; measured in § Evidence B2. `differentId` requires both
 * ends to be well-formed before it will call them different.
 *
 * `T-030`: until then this read no role, so any well-formed second account —
 * a parent's, a sitter's — satisfied four-eyes on all nine `F4` cells (OD-66).
 * The role list is caller-supplied, so it is read as `unknown` and must be an
 * actual array holding exactly `'ts_senior'`: a string `'ts_senior'` (whose
 * `.includes` would match), `['TS_SENIOR']`, an array-like object, `null` and
 * absence all deny. This is DETECTIVE: the database trigger on `approval`
 * (migration `0007`) is the invariant, and it reads `account_role` itself.
 */
function countersigned(actor: Actor, resource: ResourceRef): boolean {
  if (!differentId(resource.countersignedBy, actor.accountId)) return false;
  const roles: unknown = resource.countersignerRoles;
  if (!Array.isArray(roles)) return false;
  return (roles as readonly unknown[]).includes(COUNTERSIGNING_ROLE);
}

/**
 * SD §UC-8: an operator is eligible only if their languages COVER the locale.
 *
 * `T-134`: not an identity comparison, but the same shape and it failed the
 * same way — two caller-supplied values tested with `=== undefined` and then
 * compared. A language list of `[null]` against a locale of `null` matched,
 * and so did `['']`/`''`, `[0]`/`0`, `[NaN]`/`NaN` and one shared object:
 * five allows, measured in § Evidence C. A locale must now be a NON-EMPTY
 * STRING and the list an actual array, so no pair of junk values can cover
 * each other. A tag is still matched exactly (TL-A2 — `el` does not cover
 * `el-CY`), which fails closed and is unchanged.
 */
function coversLocale(actor: Actor, resource: ResourceRef): boolean {
  const locale = resource.locale;
  if (typeof locale !== 'string' || locale === '') return false;
  const languages: unknown = actor.operatorLocales;
  if (!Array.isArray(languages)) return false;
  return (languages as readonly unknown[]).includes(locale);
}

/**
 * The `window` grant — RESTORED by `T-134`; it denied unconditionally under
 * OE-20.
 *
 * SD §BE-10's legend (line 1244) calls `window` "only within a
 * relationship-and-time scope", and SA §TS-7 line 825 states the relationship
 * in full: a sitter may read this child's health data "because she holds a
 * *confirmed* booking WITH THIS FAMILY, and only from acceptance until
 * completion + 30 days". That is TWO ends and a clock, and all three are here:
 *
 *   - the SITTER end — the booking's sitter IS the actor;
 *   - the FAMILY end — the booking's family IS the record's owner;
 *   - the TIME scope — confirmed or in progress, or completed within 30 days.
 *
 * TL-F1 found the family end missing entirely. QA3-F1 then found that the
 * family end as first added was a bare `===` between two caller-supplied
 * fields with absence tested as `=== undefined`, so `null`/`null` agreed and
 * allowed. BOTH comparisons here go through `sameId`, which requires each side
 * to be a well-formed id before it will call them equal (identity.ts), so
 * there is no value a caller can put on both sides to manufacture agreement.
 *
 * THE ORDER IS DELIBERATE: the relationship is established BEFORE the clock is
 * read. A caller who cannot show the relationship never reaches `ctx.now`.
 */
function windowDecision(actor: Actor, resource: ResourceRef, ctx: PolicyContext): Decision {
  const supplied: unknown = resource.booking;
  // Absence however it is spelled. `null` in particular: a bare
  // `=== undefined` would pass it through to a TypeError on the next line.
  if (supplied === null || typeof supplied !== 'object') return deny('booking_not_confirmed');
  const booking = supplied as Partial<BookingWindow>;

  if (!sameId(booking.sitterAccountId, actor.accountId)) return deny('role_missing');
  if (!sameId(booking.parentAccountId, resource.ownerAccountId)) return deny('role_missing');

  const state = booking.state;
  if (state === 'confirmed' || state === 'in_progress') return allow('confirmed_booking_window');
  if (state !== 'completed') return deny('booking_not_confirmed');

  const completedAt = booking.completedAt;
  // `instanceof Date`, not `!== undefined`: a string, a number or a `null`
  // would otherwise reach `.getTime()` and throw. An INVALID Date passes this
  // check and yields NaN, which fails the comparison below — so it expires the
  // window rather than opening it. Closed, not open.
  if (!(completedAt instanceof Date)) return deny('booking_not_confirmed');
  const sinceCompletion = ctx.now.getTime() - completedAt.getTime();
  return sinceCompletion <= WINDOW_TAIL_MS
    ? allow('confirmed_booking_window')
    : deny('window_expired');
}

function evaluate(grant: Grant, actor: Actor, resource: ResourceRef, ctx: PolicyContext): Decision {
  if (grant.stepUp === true && !steppedUp(actor, ctx)) return deny('step_up_required');
  switch (grant.kind) {
    case 'deny':
      return deny('role_missing');
    case 'allow':
      return allow('role_grant');
    case 'own':
      return owns(actor, resource) ? allow('own_record') : deny('role_missing');
    case 'window':
      // RESTORED by `T-134` (OE-20 had it denying). The matrix cell was never
      // edited, so the `W` cell simply starts allowing again — `MATRIX` and
      // `can()` agree on it once more. See windowDecision() above.
      return windowDecision(actor, resource, ctx);
    case 'break_glass':
      return breakGlassActive(actor, ctx) ? allow('break_glass') : deny('role_missing');
    case 'capability':
      /*
       * TL-F2 (OE-19): FAIL CLOSED, and REPORTED rather than invented.
       *
       * This grant used to be `actor.capability.expiresAt > ctx.now` and
       * nothing else, so ONE live trusted-contact token admitted its holder to
       * ANY session — including a session belonging to someone else, and one
       * naming no owner at all. The specification scopes the token far more
       * narrowly: SD §BE-10 line 1238 gives the trusted contact a "Capability
       * token in URL + `share_view` cookie" lasting "Session end + 3 h", and
       * SD §TM-4 calls it "128-bit capability, SINGLE PURPOSE, expires at
       * session end + 3 h ... whitelisted field set".
       *
       * But no line anywhere states the SHAPE that scope takes as an input to
       * `can()`, which is what checking it would require. SD §BE-10's own
       * signature (line 1291) is `can(actor, action, resource, ctx: { now:
       * Date })` — `ctx` carries the clock and nothing else — and `ResourceRef`
       * carries no record identity, so there is no argument by which "this
       * session" can be named. (SA §TS-7 sketches a fourth argument that DOES
       * carry identity, `{ childId, bookingId, now }`, but SD governs mechanism
       * and signature over SA, PROTOCOL §2.) Adding a scope field would be
       * inventing the rule, which PROTOCOL §2 forbids: it is reported instead —
       * T-024 evidence, § Rework 3 › the TL-F2 spec question.
       *
       * So the grant denies until `Capability` carries a scope and this case
       * checks it. It fails CLOSED: a trusted contact is refused a session they
       * should be able to read, rather than allowed one they should not.
       * `role_missing` is the same closed-set reason the grant already gave for
       * an absent or expired token (§BE-10 lines 1295-1298).
       *
       * Held by can.test.ts 'TL-F2: the capability grant fails closed until
       * Capability carries a scope SD §BE-10 does not state' (D1, D2), whose
       * last assertion turns RED the day any cell produces `capability_token`.
       */
      return deny('role_missing');
    case 'four_eyes':
      return countersigned(actor, resource) ? allow('role_grant') : deny('four_eyes_required');
    case 'art10':
      return resource.art10Model === 'platform_sights'
        ? allow('role_grant')
        : deny('art10_model_prohibits_outcome_recording');
    case 'locale':
      return coversLocale(actor, resource)
        ? allow('role_grant')
        : deny('operator_does_not_cover_locale');
  }
}

/**
 * SD §BE-10's entry point.
 *
 * An actor holding several roles is allowed if ANY of them allows — a role is
 * a grant, not a restriction — and is refused with the most specific refusal
 * any of them produced otherwise.
 *
 * A role string with no column in the matrix contributes NOTHING and does not
 * stop the decision. SD §BE-10 line 1305 states its own D14 policy rule as
 * `actor.roles.some(r => r === 'ts_operator' || r === 'ts_senior')` — a
 * positive membership test that ignores every other string in the array — and
 * that is the specification's only worked statement of how a multi-role actor
 * is evaluated. So an unrecognised role is skipped, the roles that do have a
 * column decide, and the outcome cannot depend on where in the array the
 * unrecognised string sat.
 *
 * Two RECOGNISED roles that both allow are a different case, stated here at the
 * width the mechanism holds (RR-1, OE-18): this function returns on the FIRST
 * role that allows, so the allow/deny VERDICT does not depend on the order of
 * `actor.roles`, while the reported `basis` is that of the first allowing role
 * in array order. `basis` is audit-log content (SD §BE-10), so for a multi-role
 * actor the recorded justification follows array order.
 *
 * Which `basis` is authoritative when two roles allow is a question SD §BE-10
 * does not answer. It is deferred to the stakeholder with OE-17 / OD-63, so no
 * precedence rule may be invented here. Pinned by can.test.ts
 * 'LIMITATION (RR-1): two allowing roles agree on the verdict, and the basis
 * follows array order'.
 */
export function can(
  actor: Actor,
  action: Action,
  resource: ResourceRef,
  ctx: PolicyContext,
): Decision {
  const row = MATRIX.get(cell(resource.type, action));
  // An unknown (resource, action) pair is not a permission anybody holds.
  // It fails closed: a row added to SD §BE-10 but not to matrix.ts denies.
  if (row === undefined) return deny('role_missing');

  // A blocked pairing suppresses every decision about the pair, including the
  // ones an actor would otherwise hold over their own records.
  //
  // TL-A1 (OE-19): the test is "not absent and not explicitly false", not
  // `=== true`. `pairingBlocked` is TYPED `boolean | undefined`, but its
  // runtime value arrives with the rest of the caller's resource (OD-60: an
  // `any` flows unchallenged at a JSON boundary), and `=== true` made every
  // other truthy spelling — `'true'`, `1`, `{}`, `'yes'` — fail OPEN on the one
  // rule whose whole purpose is to override a permission the actor otherwise
  // holds. `false` still behaves exactly as absent, which is published and
  // tested. Held by 'TL-A1: a pairing block that is not exactly false still
  // suppresses the decision'.
  const blocked = resource.pairingBlocked;
  if (blocked !== undefined && blocked !== false) return deny('pairing_blocked');

  const refusals: DenyReason[] = [];
  // `actor.roles` is typed, but its runtime value is JWT-supplied strings, so
  // it is read as `unknown` and each entry must EARN its column (types.ts
  // isRole). A positive membership test is what makes `row[declared]` a Grant
  // rather than `undefined` — or, for a prototype-shaped name, something
  // truthy with no `kind`.
  for (const declared of actor.roles as readonly unknown[]) {
    if (!isRole(declared)) continue;
    const decision = evaluate(row[declared], actor, resource, ctx);
    // The first allowing role wins, its `basis` included (RR-1 — see above).
    if (decision.allow) return decision;
    refusals.push(decision.reason);
  }
  return deny(mostSpecific(refusals));
}

export type { Role };
