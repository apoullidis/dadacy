/**
 * The policy surface — SA §TS-7 layer 1, SD §BE-10.
 *
 * SA §TS-7: "The requirement is not RBAC. 'A sitter may read this child's
 * allergy data because she holds a *confirmed* booking with this family, and
 * only from acceptance until completion + 30 days' is relationship-and-time
 * scoped (ReBAC)." So a decision is a function of four things — actor, action,
 * resource and time — and of nothing else. There is no I/O in this package:
 * every fact a decision needs is passed in.
 *
 * `Decision`'s two string sets are CLOSED and are transcribed verbatim from
 * SD §BE-10's `Decision` type. They are not ours to extend: `basis` is written
 * to the audit log on every allowed sensitive read, and `reason` is logged but
 * NEVER returned in the 403 body (SD §BE-10; SD §BE-2 — "never leak the policy
 * reason to an attacker, log it"). `PolicyDeniedError` in @kinvara/domain-types
 * carries the basis for exactly that reason.
 *
 * OPEN (RR-1, OE-18): when an actor holds two roles that BOTH allow, `can()`
 * returns the first allowing role's decision, so the `basis` written to the
 * audit log follows the order of `actor.roles`. The allow/deny verdict does
 * not. Which basis is authoritative is a question SD §BE-10 does not answer and
 * is deferred to the stakeholder with OE-17 / OD-63 — it is not this package's
 * to decide. Pinned by can.test.ts 'LIMITATION (RR-1): …'.
 */
import type { AccountId } from '@kinvara/domain-types';

/**
 * SA §TS-7's role model, and SD §BE-10's matrix columns. The two agree on
 * these ten and this package implements exactly them.
 *
 * NOT modelled, and deliberately so: `deputy_dsl` and `referee`. SA §TS-7
 * names `dsl` / `deputy_dsl` as one row and SD §BE-3 names `referee` as a
 * capability-token holder, but SD §BE-10's matrix — which is the authority for
 * what each role may do — gives neither a column. Inventing their cells is the
 * one thing an authorisation table must not do, so they are reported rather
 * than guessed (T-024 evidence, § What I did not do).
 */
export type Role =
  | 'parent'
  | 'sitter'
  | 'trusted_contact'
  | 'support'
  | 'ts_operator'
  | 'ts_senior'
  | 'dsl'
  | 'finance'
  | 'compliance'
  | 'engineer';

export const ROLES: readonly Role[] = [
  'parent',
  'sitter',
  'trusted_contact',
  'support',
  'ts_operator',
  'ts_senior',
  'dsl',
  'finance',
  'compliance',
  'engineer',
];

const ROLE_SET: ReadonlySet<unknown> = new Set<unknown>(ROLES);

/**
 * Does this string name a column of SD §BE-10's matrix?
 *
 * `Actor.roles` is TYPED `readonly Role[]`, but the value at run time is
 * `actor_roles[]` out of the service JWT (SD §BE-10's token model), which is an
 * array of arbitrary strings that nothing on the way in refuses (OD-60: an
 * `any` flows into every branded type at a JSON boundary). The two role names
 * the specification itself uses and the matrix does not give a column —
 * `deputy_dsl` (SA §TS-7) and `referee` (SD §BE-3), decisions.md OE-17 — are
 * therefore exactly the strings that reach here.
 *
 * `can()` uses this to decide whether a string names a column, and it is
 * exported so a caller can ask the same question at the token boundary, where
 * an unrecognised role can still be distinguished. It cannot be distinguished
 * from the `Decision`: SD §BE-10's `DenyReason` set is closed and has no member
 * for it, and this package does not extend that set.
 *
 * It is a positive Set-membership test, not an `undefined` check on the matrix
 * row, because a `Row` is an object literal on which every `Object.prototype`
 * key (`constructor`, `__proto__`, `toString`) resolves to something truthy.
 */
export function isRole(value: unknown): value is Role {
  return ROLE_SET.has(value);
}

/** Every action naming a row of SD §BE-10's matrix. */
export type Action =
  | 'read'
  | 'update'
  | 'write'
  | 'search'
  | 'create'
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'send'
  | 'check_in'
  | 'arrival'
  | 'end'
  | 'raise'
  | 'raise_concern'
  | 'submit'
  | 'remove'
  | 'record'
  | 'review'
  | 'countersign'
  | 'apply'
  | 'remove_permanently'
  | 'make'
  | 'publish'
  | 'moderate'
  | 'issue'
  | 'approve'
  | 'request'
  | 'execute'
  | 'toggle';

/**
 * Every resource naming a row of SD §BE-10's matrix.
 *
 * Where the matrix narrows a cell to a sub-view rather than denying it —
 * "metadata only" for `support` on messages and on the payout ledger — the
 * sub-view is a resource of its own rather than a flag, because the narrowing
 * changes WHAT may be read and a boolean on one decision cannot express that.
 */
export type Resource =
  | 'account'
  | 'sitter.public_profile'
  | 'sitter.contact_details'
  | 'child.health'
  | 'certificate_outcome_metadata'
  | 'certificate_outcome'
  | 'idv_result'
  | 'sitter_search'
  | 'booking'
  | 'message.content'
  | 'message.metadata'
  | 'message'
  | 'session'
  | 'sos'
  | 'sit_summary'
  | 'review'
  | 'verification_decision'
  | 'non_clear_outcome'
  | 'four_eyes'
  | 'account_suspension'
  | 'pairing_block'
  | 'safeguarding_referral'
  | 'staffed_hours_version'
  | 'rota_shift'
  | 'content_moderation'
  | 'refund'
  | 'payout_ledger'
  | 'payout_ledger.metadata'
  | 'audit_log'
  | 'retention_run'
  | 'dsar'
  | 'feature_flag'
  | 'feature_flag.compliance'
  | 'production_data';

/**
 * SD §DB-2's `account_status` enum, verbatim (migration `0005`). Only
 * `'active'` satisfies four-eyes (`decisions.md` OE-45, `T-186`).
 */
export type AccountStatus = 'pending' | 'active' | 'suspended' | 'removed' | 'erased';

/** SD §BE-17 / SA §INT-1r.4's D14 branch. */
export type Art10Model = 'platform_sights' | 'sitter_held';

/** The booking states SD §BE-10's `window` grant reads. */
export type BookingState =
  'requested' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'declined';

/**
 * The relationship the `window` grant is scoped by (SA §TS-7): a confirmed
 * booking between this sitter and this family, from confirmation until
 * completion + 30 days.
 *
 * **Read by `windowDecision()` again since `T-134` restored the grant** (under
 * OE-20 no field on this interface reached a decision). Every field here is
 * caller-supplied and none of them is trusted: the two ids are compared only
 * through `sameId` (identity.ts), `state` is matched against literals, and
 * `completedAt` must be an actual `Date`.
 */
export interface BookingWindow {
  readonly state: BookingState;
  readonly sitterAccountId: AccountId;
  /**
   * The family end of the relationship.
   *
   * TL-F1 added a comparison of this to the resource's `ownerAccountId`, and
   * QA3-F1 measured what that comparison was: `===` between TWO
   * CALLER-SUPPLIED fields, with absence recognised only as `undefined`. So
   * `null` — what a Postgres driver yields for a NULL column — `''`, `0` and
   * one shared object each made the two ends "agree", and twelve allows on
   * child health followed. `T-134` compares it through `sameId`, which
   * requires BOTH ends to be well-formed ids before it will call them equal,
   * so absence in any spelling now refuses instead of agreeing.
   */
  readonly parentAccountId: AccountId;
  /** Set once the booking reaches `completed`; starts the 30-day tail. */
  readonly completedAt?: Date | undefined;
}

/** SEC-9 break-glass: time-boxed, with a declared purpose, fully audited. */
export interface BreakGlass {
  readonly purpose: string;
  readonly expiresAt: Date;
}

/**
 * SD §BE-3's capability tokens (trusted contact; referee is not modelled).
 *
 * **Not consulted by `can()` today (TL-F2, OE-19).** The `capability` grant
 * fails closed, so this field reaches no decision. It carries only `expiresAt`,
 * and an expiry is not a scope: SD §BE-10 line 1238 and SD §TM-4 both scope the
 * trusted contact's token to ONE session ("single purpose", "session end + 3
 * h"), but no line states the shape that scope takes as an input to `can()`,
 * and `ResourceRef` carries no record identity to compare it against. Inventing
 * one is refused under PROTOCOL §2 and reported instead — the question is
 * `decisions.md` **OD-64**, parked with the stakeholder.
 *
 * **`T-134` checked OD-64 and it is STILL UNRULED**, so this grant stays
 * closed and `trusted_contact` still has no `session#read` and no
 * `sos#raise_concern`. `T-134` restored the `window` grant beside it and
 * deliberately did not touch this one: what is missing here is a
 * specification answer, not an evaluator. Do not add the field without the
 * ruling (PROTOCOL §2).
 */
export interface Capability {
  readonly expiresAt: Date;
}

export interface Actor {
  readonly accountId: AccountId;
  readonly roles: readonly Role[];
  /** SD §BE-10: `step_up_until` within 10 minutes of now. */
  readonly stepUpUntil?: Date | undefined;
  readonly breakGlass?: BreakGlass | undefined;
  /** SD §UC-8: validated `operator_language` set at level >= working. */
  readonly operatorLocales?: readonly string[] | undefined;
  readonly capability?: Capability | undefined;
}

export interface ResourceRef {
  readonly type: Resource;
  /**
   * The account owning the record, where ownership is meaningful.
   *
   * Read by the `own` grant and, since `T-134`, by the `window` grant's family
   * end again. Both comparisons go through `sameId`.
   *
   * The claim this comment used to carry — that `owns()` "compares this to the
   * **actor's** own id, a comparison junk cannot satisfy" — was FALSE, and
   * `T-134` measured it falsifying: `actor.accountId` is caller-supplied too,
   * so when both sides held the same junk the `own` grant ALLOWED, over all 37
   * `own` cells (§ Evidence A3).
   */
  readonly ownerAccountId?: AccountId | undefined;
  /**
   * Read by the `window` grant again since `T-134`. It is validated as an
   * object before any field on it is touched, so a `null` here denies rather
   * than throwing.
   */
  readonly booking?: BookingWindow | undefined;
  /** D14: the market's Article 10 model (SD §BE-17). */
  readonly art10Model?: Art10Model | undefined;
  /** SD §UC-8: the locale of the content being moderated. */
  readonly locale?: string | undefined;
  /** SA §SA-4 I-5: the second, different actor who has countersigned. */
  readonly countersignedBy?: AccountId | undefined;
  /**
   * SA §SA-4 I-5, clause (b), as `decisions.md` OE-21 ruled it (`T-030`): the
   * roles the COUNTERSIGNER holds, as the caller read them from
   * `account_role` (unrevoked rows). `four_eyes` requires
   * `Array.isArray(x) && x.includes('ts_senior')`. Against DATA-SHAPED input
   * (plain arrays, strings, sets, array-likes, JSON) that means an actual
   * array containing exactly `'ts_senior'`; absent, junk or any other role set
   * denies with `four_eyes_required`. It is NOT a guard against a hostile
   * caller's objects: an array carrying its own `includes()`, an `Array`
   * subclass overriding it, a `Proxy` lying on an index, or a polluted
   * `Array.prototype` can all pass (`T-030` QA-A1; the LIMITATION case in
   * `can.test.ts`).
   *
   * This is the DETECTIVE half. It checks what the caller says the
   * countersigner holds, and a caller can say anything. The database trigger
   * `trg_approval_four_eyes` on `approval` (migrations `0007`, `0008`) reads
   * `account_role` joined to `account` as the countersigning transaction sees
   * them and refuses a countersignature without an unrevoked `ts_senior`
   * (KV052) or on an account that is not active (KV054). Since `0008`
   * (`T-186`, `decisions.md` OE-47) `app_rw` cannot write a `ts_senior` row
   * (KV053), so QA-F1's B2/B3/B4 are refused at the database; since `0011`
   * (`T-192`, `decisions.md` OE-48) it cannot change the `status` or
   * `dob_verified_18` of an account holding a live `ts_senior` either
   * (KV055; OD-222 closed). PROTOCOL §9.1.
   */
  readonly countersignerRoles?: readonly Role[] | undefined;
  /**
   * SA §SA-4 I-5 as `decisions.md` OE-45 ruled it (`T-186`): the COUNTERSIGNER's
   * `account.status`, as the caller read it. `four_eyes` requires it to be
   * exactly the string `'active'`; absence, any other status, and any other
   * spelling or shape (`'ACTIVE'`, `' active'`, a boxed `String`, an array)
   * deny with `four_eyes_required`. Detective, like `countersignerRoles`: the
   * database trigger is what refuses (KV054).
   */
  readonly countersignerStatus?: AccountStatus | undefined;
  /**
   * A block between the two parties suppresses every decision on the pair.
   *
   * Read as "not absent and not explicitly `false`" (TL-A1), so a truthy
   * non-boolean that reaches this field through a JSON boundary suppresses too
   * rather than failing open. `false` behaves exactly as absent.
   */
  readonly pairingBlocked?: boolean | undefined;
}

export interface PolicyContext {
  readonly now: Date;
}

/** SD §BE-10, verbatim. Written to the audit log on every allowed sensitive read. */
export type AllowBasis =
  'own_record' | 'confirmed_booking_window' | 'role_grant' | 'break_glass' | 'capability_token';

/** SD §BE-10, verbatim. Logged, and never returned in the 403 body. */
export type DenyReason =
  | 'booking_not_confirmed'
  | 'window_expired'
  | 'role_missing'
  | 'four_eyes_required'
  | 'step_up_required'
  | 'pairing_blocked'
  | 'art10_model_prohibits_outcome_recording'
  | 'operator_does_not_cover_locale';

export type Decision =
  | { readonly allow: true; readonly basis: AllowBasis }
  | { readonly allow: false; readonly reason: DenyReason };

/**
 * What one cell of the matrix says. `kind` is the shape of the grant; the
 * evaluator in `can.ts` turns it into a `Decision` against the actor, the
 * resource and the clock.
 */
export type GrantKind =
  | 'deny'
  | 'allow'
  | 'own'
  | 'window'
  | 'break_glass'
  | 'capability'
  | 'four_eyes'
  | 'art10'
  | 'locale';

export interface Grant {
  readonly kind: GrantKind;
  /**
   * SD §BE-10: step-up "within 10 minutes" is required for payout-account,
   * address, email/phone and credential changes, DSAR download, and **every
   * admin action beyond read**. It is a property of the cell, not of the grant
   * kind, so any kind may carry it.
   */
  readonly stepUp?: boolean | undefined;
}

/** One matrix row: a total map from every role to its grant. */
export type Row = { readonly [R in Role]: Grant };

/** A matrix key. `can()` looks a decision up by exactly this pair. */
export type Cell = `${Resource}#${Action}`;
