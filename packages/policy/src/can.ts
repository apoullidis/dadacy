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

/**
 * SA §TS-7: "from acceptance until completion + 30 days".
 *
 * READ BY NO DECISION AT THIS COMMIT (OE-20): the `window` grant fails closed,
 * so nothing consults the tail. The constant stays exported because it is
 * published surface at its SD/SA value and `T-134` needs it unchanged when it
 * restores the grant. Held by index.test.ts 'the barrel exports the two spec
 * constants at their SD and SA values'.
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
 * `booking_not_confirmed` and `window_expired` are still listed here and are
 * still members of SD §BE-10's closed set, but NO cell can produce either at
 * this commit: the `window` grant, their only source, fails closed (OE-20).
 * They are kept because the set is the specification's and not ours to prune,
 * and because `T-134` restores their source. Held by 'WITHDRAWN (OE-20): every
 * pre-confirmation booking state denies with role_missing, not
 * booking_not_confirmed'.
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

/*
 * There is deliberately no `windowDecision()` any more either (OE-20). See the
 * `window` case in `evaluate()`: that grant fails closed too, so there is no
 * booking to read, no clock to consult and no identity to compare. `T-134`
 * restores it.
 */

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
      /*
       * OE-20: FAIL CLOSED, exactly as `capability` below already does.
       *
       * This grant had two ends of a relationship to check and checked one, so
       * a sitter holding a confirmed booking with FAMILY A read FAMILY B's
       * child health record (TL-F1). The family end was then added — and the
       * comparison it added was `===` between `booking.parentAccountId` and
       * `resource.ownerAccountId`, TWO CALLER-SUPPLIED FIELDS, with absence
       * recognised only as `undefined`. So `null` (what a Postgres driver
       * yields for a NULL column), `''`, `0` and one shared object each made
       * the two ends "agree" and allowed: twelve measured allows on child
       * health, with `basis: 'confirmed_booking_window'` going to the audit
       * log (SD §BE-10 line 1309) for a relationship nothing had established
       * (QA3-F1). `owns()` below cannot have that defect, because it compares
       * the owner to the ACTOR's own id, which junk cannot match.
       *
       * The stakeholder ruled (decisions.md OE-20) that this ticket lands its
       * verified matrix and withdraws both conditional grants rather than
       * attempt the evaluator a fourth time. So the grant denies, and NO
       * caller-supplied identity comparison remains reachable in this file:
       * `resource.booking` is now read nowhere.
       *
       * THE WITHDRAWAL, at true width: a `sitter` gets NO `window`-based read.
       * `child.health#read` is the only `W` cell in SD §BE-10, so that is the
       * whole of it — a sitter can no longer read the child health record of a
       * family they hold a confirmed booking with, which the product intends
       * them to have (SA §TS-7's worked example). It fails CLOSED: a refusal
       * the caller sees, never an unauthorised read.
       *
       * THE MATRIX CELL IS UNTOUCHED. `matrix.ts` still carries `W` for
       * `sitter` on `child.health#read`, transcribed from the grid, so the day
       * `T-134` lands a validated evaluator the cell starts allowing again
       * with NO edit to the table.
       *
       * `role_missing` is the same closed-set reason (SD §BE-10 lines
       * 1295-1298) the grant already gave for a sitter-end mismatch.
       *
       * Held by can.test.ts 'WITHDRAWN (OE-20): the C1-C5 fixtures all deny,
       * C1 included — no identity comparison is reachable' and the eight other
       * WITHDRAWN cases, every one of which turns RED when `T-134` restores
       * the grant.
       */
      return deny('role_missing');
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
