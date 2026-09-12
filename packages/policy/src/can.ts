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
  Decision,
  DenyReason,
  Grant,
  PolicyContext,
  ResourceRef,
  Role,
} from './types.ts';
import { MATRIX, cell } from './matrix.ts';
import { isRole } from './types.ts';

/** SA §TS-7: "from acceptance until completion + 30 days". */
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

function owns(actor: Actor, resource: ResourceRef): boolean {
  if (resource.ownerAccountId === undefined) return false;
  return resource.ownerAccountId === actor.accountId;
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

/** SA §SA-4 I-5: the second actor must differ from the first. */
function countersigned(actor: Actor, resource: ResourceRef): boolean {
  if (resource.countersignedBy === undefined) return false;
  return resource.countersignedBy !== actor.accountId;
}

/** SD §UC-8: an operator is eligible only if their languages COVER the locale. */
function coversLocale(actor: Actor, resource: ResourceRef): boolean {
  const locale = resource.locale;
  if (locale === undefined) return false;
  const languages = actor.operatorLocales;
  if (languages === undefined) return false;
  return languages.includes(locale);
}

/**
 * The `window` grant: SA §TS-7's worked example, and the only cell in the
 * matrix whose decision depends on `ctx.now`.
 *
 * SD §BE-10's legend (line 1244) defines `window` as "only within a
 * relationship-and-time scope", and SA §TS-7 states the relationship in full:
 * "A sitter may read this child's allergy data because she holds a *confirmed*
 * booking WITH THIS FAMILY, and only from acceptance until completion + 30
 * days". A relationship has TWO ends, and until TL-F1 (OE-19) this function
 * checked only the sitter's: a sitter holding a confirmed booking with one
 * family could read another family's child.health record, with
 * `basis: 'confirmed_booking_window'` written to the audit log (§BE-10 line
 * 1309) for a relationship nothing had checked.
 *
 * So the family end is now compared too: `booking.parentAccountId` must equal
 * `resource.ownerAccountId`, and BOTH must be present. An absent owner is
 * refused rather than waved through, which is what the `own` grant already does
 * ('ownership needs a named owner: a resource with none is refused') — two
 * relationship grants in one file must not treat a missing owner oppositely.
 *
 * The refusal is `role_missing` on all three relationship failures. That is a
 * reading of SD §BE-10's CLOSED `DenyReason` set (lines 1295-1298), not a
 * choice: no member of it names a relationship mismatch, and `role_missing` is
 * already what the sitter-end refusal (C4) and the `own` grant's absent or
 * mismatched owner both return. `booking_not_confirmed` is kept for the two
 * cases that are genuinely about the booking's STATE rather than its parties.
 *
 * Held by can.test.ts 'TL-F1: the window grant checks the family end of the
 * relationship, not only the sitter end' (C1-C5).
 */
function windowDecision(actor: Actor, resource: ResourceRef, ctx: PolicyContext): Decision {
  const booking = resource.booking;
  if (booking === undefined) return deny('booking_not_confirmed');
  if (booking.sitterAccountId !== actor.accountId) return deny('role_missing');
  // The family end (TL-F1). Absent on either side is a refusal, not a pass.
  const owner = resource.ownerAccountId;
  if (owner === undefined) return deny('role_missing');
  if (booking.parentAccountId !== owner) return deny('role_missing');
  if (booking.state === 'confirmed' || booking.state === 'in_progress') {
    return allow('confirmed_booking_window');
  }
  if (booking.state !== 'completed') return deny('booking_not_confirmed');
  const completedAt = booking.completedAt;
  if (completedAt === undefined) return deny('booking_not_confirmed');
  if (ctx.now.getTime() > completedAt.getTime() + WINDOW_TAIL_MS) return deny('window_expired');
  return allow('confirmed_booking_window');
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
