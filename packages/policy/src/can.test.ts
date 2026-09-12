/**
 * `can()` over every (actor, action, resource, time) combination the matrix
 * defines — SD §QD-1's Policy row, which is the reason this package has a
 * 100%-branch gate rather than a coverage target.
 *
 * The sweep is driven by `MATRIX`, and what each cell MEANS is anchored in
 * `matrix.test.ts` against an independent transcription of SD §BE-10. So the
 * two files together are the two readings PROTOCOL §5.1 asks for: this one
 * proves the evaluator honours the table, that one proves the table is the
 * specification's.
 *
 * Every test title here is a string literal and every `test(` call starts its
 * own line, so T-132 § Published contract (rework 2) §4 A, B and B' have no
 * member in this file: no title is generated, and no `test(` sits inside a
 * loop or a looped `describe`. The loops are INSIDE test bodies.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { accountId } from '@kinvara/domain-types';
import { can, STEP_UP_MAX_AGE_MS, WINDOW_TAIL_MS } from './can.ts';
import { MATRIX } from './matrix.ts';
import { ROLES, isRole } from './types.ts';
import type {
  Action,
  Actor,
  AllowBasis,
  Decision,
  DenyReason,
  Grant,
  GrantKind,
  PolicyContext,
  Resource,
  ResourceRef,
  Role,
  Row,
} from './types.ts';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const CTX: PolicyContext = { now: NOW };
const SELF = accountId('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'actorId');
const OTHER = accountId('01BX5ZZKBKACTAV9WEVGEMMVRZ', 'otherId');
const FAMILY = accountId('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'parentId');
/** A SECOND family. The fixture no window test had before TL-F1 (OE-19). */
const FAM_B = accountId('01CY0000000000000000000000', 'otherParentId');

const at = (deltaMs: number): Date => new Date(NOW.getTime() + deltaMs);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A step-up that happened inside SD §BE-10's ten-minute window. */
const FRESH_STEP_UP = at(5 * MINUTE);

/**
 * The basis each grant kind produces WHEN IT ALLOWS.
 *
 * BOTH conditional grants are absent, and their absence is the point (OE-20):
 * `capability` fails closed (TL-F2) and `window` now does too, so no cell can
 * produce `capability_token` or `confirmed_booking_window` at this commit. The
 * sweeps consult `NEVER_ALLOWS`; the two assertions that turn red if either
 * route reopens are at the end of the TL-F2 test and in the C1-C5 test.
 */
const BASIS_OF: Record<Exclude<GrantKind, 'deny' | 'capability' | 'window'>, AllowBasis> = {
  allow: 'role_grant',
  own: 'own_record',
  break_glass: 'break_glass',
  four_eyes: 'role_grant',
  art10: 'role_grant',
  locale: 'role_grant',
};

/** Grant kinds that cannot produce an allow here: `deny`, `capability`, `window`. */
const NEVER_ALLOWS: ReadonlySet<GrantKind> = new Set<GrantKind>(['deny', 'capability', 'window']);

const REASON_OF: Record<Exclude<GrantKind, 'allow'>, DenyReason> = {
  deny: 'role_missing',
  own: 'role_missing',
  // Was `booking_not_confirmed`. The withdrawn grant (OE-20) refuses with the
  // same closed-set reason it already gave for a sitter-end mismatch.
  window: 'role_missing',
  break_glass: 'role_missing',
  capability: 'role_missing',
  four_eyes: 'four_eyes_required',
  art10: 'art10_model_prohibits_outcome_recording',
  locale: 'operator_does_not_cover_locale',
};

interface Probe {
  readonly actor: Actor;
  readonly resource: ResourceRef;
}

/** An actor and resource that SATISFY the grant, so the cell must allow. */
function satisfying(grant: Grant, role: Role, type: Resource): Probe {
  const actor: {
    accountId: typeof SELF;
    roles: Role[];
    stepUpUntil?: Date;
    breakGlass?: { purpose: string; expiresAt: Date };
    capability?: { expiresAt: Date };
    operatorLocales?: string[];
  } = { accountId: SELF, roles: [role] };
  const resource: {
    type: Resource;
    ownerAccountId?: typeof SELF;
    booking?: {
      state: 'confirmed';
      sitterAccountId: typeof SELF;
      parentAccountId: typeof FAMILY;
    };
    art10Model?: 'platform_sights';
    locale?: string;
    countersignedBy?: typeof OTHER;
  } = { type };
  if (grant.stepUp === true) actor.stepUpUntil = FRESH_STEP_UP;
  if (grant.kind === 'own') resource.ownerAccountId = SELF;
  if (grant.kind === 'window') {
    // BOTH ends of the relationship, agreeing: the booking's family is the
    // record's owner (TL-F1). Before OE-19 this fixture named no owner at all,
    // which is precisely why no sweep could see C2.
    //
    // It is kept at full strength although the grant now denies (OE-20): this
    // is the MOST favourable fixture the grant could be handed, so the sweeps
    // that consult NEVER_ALLOWS are asserting that even a perfectly formed
    // relationship is refused — not that a weak fixture happened to fail.
    resource.ownerAccountId = FAMILY;
    resource.booking = {
      state: 'confirmed',
      sitterAccountId: SELF,
      parentAccountId: FAMILY,
    };
  }
  if (grant.kind === 'break_glass') {
    actor.breakGlass = { purpose: 'safeguarding case 42', expiresAt: at(HOUR) };
  }
  if (grant.kind === 'capability') actor.capability = { expiresAt: at(HOUR) };
  if (grant.kind === 'four_eyes') resource.countersignedBy = OTHER;
  if (grant.kind === 'art10') resource.art10Model = 'platform_sights';
  if (grant.kind === 'locale') {
    actor.operatorLocales = ['el'];
    resource.locale = 'el';
  }
  return { actor, resource };
}

/** An actor and resource that FAIL the grant's own condition. */
function failing(grant: Grant, role: Role, type: Resource): Probe {
  const actor: {
    accountId: typeof SELF;
    roles: Role[];
    stepUpUntil?: Date;
    operatorLocales?: string[];
  } = { accountId: SELF, roles: [role] };
  const resource: {
    type: Resource;
    ownerAccountId?: typeof OTHER;
    art10Model?: 'sitter_held';
    locale?: string;
  } = { type };
  if (grant.stepUp === true) actor.stepUpUntil = FRESH_STEP_UP;
  if (grant.kind === 'own') resource.ownerAccountId = OTHER;
  if (grant.kind === 'art10') resource.art10Model = 'sitter_held';
  if (grant.kind === 'locale') {
    actor.operatorLocales = ['en'];
    resource.locale = 'el';
  }
  return { actor, resource };
}

function actionOf(key: string): Action {
  return (key.split('#')[1] ?? '') as Action;
}
function resourceOf(key: string): Resource {
  return (key.split('#')[0] ?? '') as Resource;
}

function expectAllow(d: Decision, basis: AllowBasis, where: string): void {
  assert.deepEqual(d, { allow: true, basis }, where);
}
function expectDeny(d: Decision, reason: DenyReason, where: string): void {
  assert.deepEqual(d, { allow: false, reason }, where);
}

test('every cell that grants something allows it, with the basis SD §BE-10 assigns', () => {
  let checked = 0;
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      const grant = (row as Row)[role];
      if (NEVER_ALLOWS.has(grant.kind)) continue;
      const { actor, resource } = satisfying(grant, role, resourceOf(key));
      expectAllow(
        can(actor, actionOf(key), resource, CTX),
        BASIS_OF[grant.kind as Exclude<GrantKind, 'deny' | 'capability' | 'window'>],
        `${key} / ${role}`,
      );
      checked++;
    }
  }
  assert.equal(checked > 0, true);
});

test('every cell that grants nothing denies with role_missing, for every action', () => {
  let checked = 0;
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      const grant = (row as Row)[role];
      if (grant.kind !== 'deny') continue;
      const { actor, resource } = failing(grant, role, resourceOf(key));
      expectDeny(can(actor, actionOf(key), resource, CTX), 'role_missing', `${key} / ${role}`);
      checked++;
    }
  }
  assert.equal(checked > 0, true);
});

test('every conditional grant denies with its own reason when its condition is unmet', () => {
  let checked = 0;
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      const grant = (row as Row)[role];
      if (grant.kind === 'allow') continue;
      const { actor, resource } = failing(grant, role, resourceOf(key));
      expectDeny(
        can(actor, actionOf(key), resource, CTX),
        REASON_OF[grant.kind],
        `${key} / ${role}`,
      );
      checked++;
    }
  }
  assert.equal(checked > 0, true);
});

test('every step-up cell refuses with step_up_required when the actor has not stepped up', () => {
  let checked = 0;
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      const grant = (row as Row)[role];
      if (grant.stepUp !== true) continue;
      const { actor, resource } = satisfying(grant, role, resourceOf(key));
      const withoutStepUp: Actor = { accountId: actor.accountId, roles: actor.roles };
      const full: Actor = {
        ...withoutStepUp,
        ...(actor.breakGlass === undefined ? {} : { breakGlass: actor.breakGlass }),
        ...(actor.capability === undefined ? {} : { capability: actor.capability }),
        ...(actor.operatorLocales === undefined ? {} : { operatorLocales: actor.operatorLocales }),
      };
      expectDeny(can(full, actionOf(key), resource, CTX), 'step_up_required', `${key} / ${role}`);
      checked++;
    }
  }
  assert.equal(checked > 0, true);
});

test('the sweep covered all 460 (role, resource, action) combinations exactly once', () => {
  const seen = new Set<string>();
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      const id = `${key}/${role}`;
      assert.equal(seen.has(id), false, id);
      seen.add(id);
      assert.notEqual((row as Row)[role], undefined, id);
    }
  }
  assert.equal(seen.size, 460);
});

test('a (resource, action) pair the matrix does not name fails closed with role_missing', () => {
  const decision = can(
    { accountId: SELF, roles: ['dsl'] },
    'toggle',
    { type: 'child.health' },
    CTX,
  );
  expectDeny(decision, 'role_missing', 'unknown pair');
});

test('a blocked pairing suppresses a decision the actor would otherwise hold over own records', () => {
  const owned: ResourceRef = { type: 'message.content', ownerAccountId: SELF };
  expectAllow(can({ accountId: SELF, roles: ['parent'] }, 'read', owned, CTX), 'own_record', 'a');
  expectDeny(
    can({ accountId: SELF, roles: ['parent'] }, 'read', { ...owned, pairingBlocked: true }, CTX),
    'pairing_blocked',
    'b',
  );
});

test('an explicitly unblocked pairing is treated exactly as an absent one', () => {
  const owned: ResourceRef = { type: 'message.content', ownerAccountId: SELF };
  expectAllow(
    can({ accountId: SELF, roles: ['parent'] }, 'read', { ...owned, pairingBlocked: false }, CTX),
    'own_record',
    'unblocked',
  );
});

/**
 * TL-A1 (OE-19). The one member of the unvalidated-input family that failed
 * OPEN, on the rule whose whole purpose is to override a permission the actor
 * otherwise holds. `pairingBlocked` is typed `boolean | undefined`, but its
 * runtime value arrives with the caller's resource and nothing refuses a
 * non-boolean there (OD-60), so `=== true` let every other truthy spelling
 * through. It is now "not absent and not explicitly false".
 */
test('TL-A1: a pairing block that is not exactly false still suppresses the decision', () => {
  const owned: ResourceRef = { type: 'message.content', ownerAccountId: SELF };
  const parent: Actor = { accountId: SELF, roles: ['parent'] };
  for (const value of ['true', 'yes', 1, 0, '', {}]) {
    expectDeny(
      can(parent, 'read', { ...owned, pairingBlocked: value as unknown as boolean }, CTX),
      'pairing_blocked',
      `pairingBlocked=${JSON.stringify(value)}`,
    );
  }
  // The control: the two spellings that are NOT a block still allow.
  expectAllow(can(parent, 'read', owned, CTX), 'own_record', 'absent is not a block');
  expectAllow(
    can(parent, 'read', { ...owned, pairingBlocked: false }, CTX),
    'own_record',
    'false is not a block',
  );
});

test('an actor holding no role at all is denied with role_missing', () => {
  expectDeny(
    can({ accountId: SELF, roles: [] }, 'read', { type: 'session', ownerAccountId: SELF }, CTX),
    'role_missing',
    'no roles',
  );
});

test('a role is a grant and not a restriction: any one role allowing is enough', () => {
  const actor: Actor = { accountId: SELF, roles: ['finance', 'parent'] };
  expectAllow(
    can(actor, 'read', { type: 'child.health', ownerAccountId: SELF }, CTX),
    'own_record',
    'parent wins',
  );
});

test('when every role refuses, the most specific refusal is the one reported', () => {
  const actor: Actor = {
    accountId: SELF,
    roles: ['ts_operator', 'ts_senior'],
    stepUpUntil: FRESH_STEP_UP,
  };
  expectDeny(
    can(actor, 'remove_permanently', { type: 'account' }, CTX),
    'four_eyes_required',
    'ts_operator denies role_missing, ts_senior denies four_eyes_required',
  );
});

/*
 * THE WITHDRAWAL (OE-20) — the `window` grant, re-asserted as the refusal it
 * now is. Nine tests carry it, from here to the C1-C5 and QA3-F1 cases below.
 *
 * The stakeholder ruled that this ticket lands its verified matrix and fails
 * BOTH conditional grants closed, giving the evaluators to `T-134`. The
 * evaluator had failed three consecutive reviews: it checked one end of a
 * two-ended relationship (TL-F1), and the end that was then added compared two
 * caller-supplied fields with `===`, so `null`/`null` allowed (QA3-F1).
 *
 * EVERY FIXTURE BELOW IS KEPT. Not one is deleted and not one of the facts
 * they encode is lost — the booking states, the thirty-day tail, the
 * millisecond boundary, the disagreeing family, the absent owner. What changed
 * is the expected answer, because `can()` no longer reads a booking at all.
 * That is what makes the withdrawal visible rather than silent: the day
 * `T-134` restores the grant, every one of these turns RED, and the contract
 * sentence each of them holds must be rewritten in the same change.
 *
 * Four were ALLOW cases before this commit — the worked example, the
 * in-progress session, the two inside-the-tail boundaries — and C1 was a
 * fifth. Their titles are RENAMED rather than their assertions quietly
 * flipped, so nobody reading the report can mistake a withdrawal for a pass.
 * Every rename is listed in § Final (OE-20) — evidence.
 */
test('WITHDRAWN (OE-20): the SA §TS-7 worked example is refused — a sitter gets no window-based read', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const resource: ResourceRef = {
    type: 'child.health',
    ownerAccountId: FAMILY,
    booking: { state: 'confirmed', sitterAccountId: SELF, parentAccountId: FAMILY },
  };
  // SA §TS-7's own example, with BOTH ends of the relationship agreeing: the
  // strongest case the grant could be handed. It is refused.
  expectDeny(can(actor, 'read', resource, CTX), 'role_missing', 'confirmed, both ends agreeing');
});

test('WITHDRAWN (OE-20): an in-progress session opens no window either', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const resource: ResourceRef = {
    type: 'child.health',
    ownerAccountId: FAMILY,
    booking: { state: 'in_progress', sitterAccountId: SELF, parentAccountId: FAMILY },
  };
  expectDeny(can(actor, 'read', resource, CTX), 'role_missing', 'in_progress');
});

test('WITHDRAWN (OE-20): every pre-confirmation booking state denies with role_missing, not booking_not_confirmed', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  for (const state of ['requested', 'cancelled', 'declined'] as const) {
    const resource: ResourceRef = {
      type: 'child.health',
      ownerAccountId: FAMILY,
      booking: { state, sitterAccountId: SELF, parentAccountId: FAMILY },
    };
    // The reason moves because the grant no longer reaches the booking's
    // state. `booking_not_confirmed` is still a member of SD §BE-10's closed
    // set and no cell can now produce it — see REASON_PRECEDENCE in can.ts.
    expectDeny(can(actor, 'read', resource, CTX), 'role_missing', state);
  }
});

test('WITHDRAWN (OE-20): a sitter with no booking at all denies with role_missing', () => {
  expectDeny(
    can(
      { accountId: SELF, roles: ['sitter'] },
      'read',
      { type: 'child.health', ownerAccountId: FAMILY },
      CTX,
    ),
    'role_missing',
    'no booking',
  );
});

test('another sitter’s booking gives this sitter nothing', () => {
  const resource: ResourceRef = {
    type: 'child.health',
    ownerAccountId: FAMILY,
    booking: { state: 'confirmed', sitterAccountId: OTHER, parentAccountId: FAMILY },
  };
  expectDeny(
    can({ accountId: SELF, roles: ['sitter'] }, 'read', resource, CTX),
    'role_missing',
    'not my booking',
  );
});

test('WITHDRAWN (OE-20): the thirty-day completed tail opens no window, inside it or outside it', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const completed = (completedAt: Date): ResourceRef => ({
    type: 'child.health',
    ownerAccountId: FAMILY,
    booking: {
      state: 'completed',
      sitterAccountId: SELF,
      parentAccountId: FAMILY,
      completedAt,
    },
  });
  // Inside the tail by a minute: an ALLOW before this commit.
  expectDeny(
    can(actor, 'read', completed(at(-WINDOW_TAIL_MS + MINUTE)), CTX),
    'role_missing',
    'one minute inside',
  );
  // Outside it by a minute: refused before as `window_expired`, refused now as
  // `role_missing` — there is no clock left for the tail to expire against.
  expectDeny(
    can(actor, 'read', completed(at(-WINDOW_TAIL_MS - MINUTE)), CTX),
    'role_missing',
    'one minute outside',
  );
});

test('WITHDRAWN (OE-20): the thirtieth-day boundary decides nothing, to the millisecond', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const boundary = (offset: number): ResourceRef => ({
    type: 'child.health',
    ownerAccountId: FAMILY,
    booking: {
      state: 'completed',
      sitterAccountId: SELF,
      parentAccountId: FAMILY,
      completedAt: at(-WINDOW_TAIL_MS + offset),
    },
  });
  // Both sides of the boundary now answer the same way, which is the sharpest
  // statement of the withdrawal: the tail is not merely shut, it is not read.
  expectDeny(can(actor, 'read', boundary(0), CTX), 'role_missing', 'exactly 30d');
  expectDeny(can(actor, 'read', boundary(-1), CTX), 'role_missing', 'one ms past 30d');
});

test('WITHDRAWN (OE-20): a completed booking with no completion timestamp denies with role_missing', () => {
  const resource: ResourceRef = {
    type: 'child.health',
    ownerAccountId: FAMILY,
    booking: { state: 'completed', sitterAccountId: SELF, parentAccountId: FAMILY },
  };
  expectDeny(
    can({ accountId: SELF, roles: ['sitter'] }, 'read', resource, CTX),
    'role_missing',
    'completed with no completedAt',
  );
});

/**
 * TL-F1 (OE-19), now WITHDRAWN (OE-20). `tech-lead`'s C1-C5, committed as the
 * reviewer wrote them, with C1's expected answer moved to a deny.
 *
 * SD §BE-10's legend (line 1244) calls `window` a "relationship-and-time
 * scope", and SA §TS-7 names both ends of the relationship: "a *confirmed*
 * booking WITH THIS FAMILY". The evaluator checked the sitter end and never the
 * family end, so a sitter holding a confirmed booking with one family could
 * read another family's child health record — an allow §BE-10 does not grant,
 * with `basis: 'confirmed_booking_window'` going to the audit log (line 1309)
 * for a relationship nothing had checked.
 *
 * No committed test could see it: every window fixture named a booking and no
 * owner, so the booking's family and the record's owner could never disagree.
 * C2 is that fixture.
 *
 * The family end was then added and QA3-F1 measured WHAT was added: `===`
 * between `booking.parentAccountId` and `resource.ownerAccountId`, two
 * caller-supplied fields, with absence recognised only as `undefined`. So
 * C2 and C3 denied while `null`/`null` allowed. The stakeholder withdrew the
 * grant rather than attempt the evaluator a fourth time, so ALL FIVE now deny
 * and the last assertion here is what makes restoring it visible.
 */
test('WITHDRAWN (OE-20): the C1-C5 fixtures all deny, C1 included — no identity comparison is reachable', () => {
  const sitter: Actor = { accountId: SELF, roles: ['sitter'] };
  const confirmed = {
    state: 'confirmed',
    sitterAccountId: SELF,
    parentAccountId: FAMILY,
  } as const;

  // C1 — the booking's family IS the record's owner. It allowed at `100b2c8`
  // and is refused now: this is the case the withdrawal costs (SA §TS-7).
  expectDeny(
    can(sitter, 'read', { type: 'child.health', ownerAccountId: FAMILY, booking: confirmed }, CTX),
    'role_missing',
    'C1 booking with FAM_A, record owned by FAM_A',
  );

  // C2 — THE FALSIFICATION. Booking with FAM_A, record owned by FAM_B.
  expectDeny(
    can(sitter, 'read', { type: 'child.health', ownerAccountId: FAM_B, booking: confirmed }, CTX),
    'role_missing',
    'C2 booking with FAM_A, record owned by FAM_B',
  );

  // C3 — no owner named at all, which the `own` grant already refuses.
  expectDeny(
    can(sitter, 'read', { type: 'child.health', booking: confirmed }, CTX),
    'role_missing',
    'C3 no owner on the record',
  );

  // C4 — the sitter end still refuses. This is not a blanket denial.
  expectDeny(
    can(
      sitter,
      'read',
      {
        type: 'child.health',
        ownerAccountId: FAMILY,
        booking: { state: 'confirmed', sitterAccountId: OTHER, parentAccountId: FAMILY },
      },
      CTX,
    ),
    'role_missing',
    'C4 another sitter’s booking',
  );

  // C5 — and it holds through the 30-day completed tail, where the sitter has
  // least reason to hold the record at all.
  expectDeny(
    can(
      sitter,
      'read',
      {
        type: 'child.health',
        ownerAccountId: FAM_B,
        booking: {
          state: 'completed',
          sitterAccountId: SELF,
          parentAccountId: FAMILY,
          completedAt: at(-29 * 24 * HOUR),
        },
      },
      CTX,
    ),
    'role_missing',
    'C5 completed 29 days ago, record owned by FAM_B',
  );

  // THE PIN, the same instrument the TL-F2 test uses. No cell in the matrix
  // can produce `confirmed_booking_window` at this commit. It turns RED the
  // day `T-134` restores the grant — the signal to rewrite § 4's `window` row,
  // not a failure. It asserts the W cell EXISTS first, so it cannot pass
  // vacuously, and that the cell is the one SD §BE-10 line 1251 names.
  let wCells = 0;
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      if ((row as Row)[role].kind !== 'window') continue;
      assert.equal(`${key} / ${role}`, 'child.health#read / sitter', 'the one W cell');
      const decision = can(
        { accountId: SELF, roles: [role] },
        actionOf(key),
        {
          type: resourceOf(key),
          ownerAccountId: FAMILY,
          booking: { state: 'confirmed', sitterAccountId: SELF, parentAccountId: FAMILY },
        },
        CTX,
      );
      assert.equal(decision.allow, false, `${key} / ${role} must not allow`);
      wCells++;
    }
  }
  assert.equal(wCells, 1, 'SD §BE-10 has exactly one window cell');
});

/**
 * QA3-F1, committed as the probe the reviewer measured it with.
 *
 * The withdrawn comparison recognised absence only as `undefined`, so every
 * other spelling of "no family here" made the two caller-supplied ends equal
 * to each other and allowed: twelve measured allows on child health, with
 * `basis: 'confirmed_booking_window'` written to the audit log. `null` is what
 * a Postgres driver yields for a NULL column and one missed join produces it
 * on both sides at once — a Tuesday, not a construction (PROTOCOL §5.1).
 *
 * All of them deny now, including QA3-F2's both-absent case, which was the one
 * the absent-owner guard uniquely prevented and which no committed case held.
 * `T-134` must keep every one of these denying when it restores the grant:
 * that is the point of committing them here rather than in a review section.
 */
test('WITHDRAWN (OE-20): QA3-F1’s null, empty-string, zero and shared-object spellings all deny, and so does both-absent', () => {
  const sitter: Actor = { accountId: SELF, roles: ['sitter'] };
  const shared = { id: 'one object, equal only to itself' };
  const spellings: readonly (readonly [string, unknown, unknown])[] = [
    ['both null — what a driver yields for a NULL column', null, null],
    ['both the empty string', '', ''],
    ['both zero', 0, 0],
    ['both the SAME object', shared, shared],
    ['both absent (QA3-F2)', undefined, undefined],
    ['owner absent, family named', undefined, FAMILY],
    ['owner named, family absent', FAMILY, undefined],
    ['both naming the same REAL family', FAMILY, FAMILY],
  ];
  for (const [label, owner, family] of spellings) {
    for (const state of ['confirmed', 'in_progress'] as const) {
      const resource = {
        type: 'child.health',
        ownerAccountId: owner,
        booking: { state, sitterAccountId: SELF, parentAccountId: family },
      } as unknown as ResourceRef;
      expectDeny(can(sitter, 'read', resource, CTX), 'role_missing', `${label} / ${state}`);
    }
    const inTail = {
      type: 'child.health',
      ownerAccountId: owner,
      booking: {
        state: 'completed',
        sitterAccountId: SELF,
        parentAccountId: family,
        completedAt: at(-29 * 24 * HOUR),
      },
    } as unknown as ResourceRef;
    expectDeny(can(sitter, 'read', inTail, CTX), 'role_missing', `${label} / inside the tail`);
  }
});

test('ownership needs a named owner: a resource with none is refused', () => {
  expectDeny(
    can({ accountId: SELF, roles: ['parent'] }, 'read', { type: 'account' }, CTX),
    'role_missing',
    'no ownerAccountId',
  );
});

test('break-glass must be live and must carry a declared purpose (SEC-9)', () => {
  const resource: ResourceRef = { type: 'production_data' };
  const base = { accountId: SELF, roles: ['engineer'] as Role[] };
  expectAllow(
    can(
      { ...base, breakGlass: { purpose: 'incident 9', expiresAt: at(HOUR) } },
      'read',
      resource,
      CTX,
    ),
    'break_glass',
    'live',
  );
  expectDeny(
    can(
      { ...base, breakGlass: { purpose: 'incident 9', expiresAt: at(-MINUTE) } },
      'read',
      resource,
      CTX,
    ),
    'role_missing',
    'expired',
  );
  expectDeny(
    can({ ...base, breakGlass: { purpose: '   ', expiresAt: at(HOUR) } }, 'read', resource, CTX),
    'role_missing',
    'no declared purpose',
  );
  expectDeny(can(base, 'read', resource, CTX), 'role_missing', 'absent');
});

/**
 * TL-F2 (OE-19). `tech-lead`'s D1/D2, committed as the reviewer wrote them.
 *
 * The grant was `expiresAt > now` and nothing else, so ONE live token admitted
 * a trusted contact to ANY session — including one owned by somebody else (D1)
 * and one naming no owner (D2) — where SD §BE-10 line 1238 and SD §TM-4 scope
 * the token to a single session ("single purpose", "session end + 3 h").
 *
 * It now fails CLOSED, because the scope's SHAPE is not statable from the
 * specification: §BE-10's own signature (line 1291) gives `can()` a `ctx` of
 * `{ now: Date }`, and `ResourceRef` carries no record identity, so there is no
 * argument by which "this session" could be named. Inventing one is refused
 * under PROTOCOL §2 and reported instead.
 *
 * The consequence is disclosed and is a real one: a trusted contact is refused
 * a session view the product intends them to have. That is the safe direction,
 * and the last assertion here is what makes closing it visible.
 */
test('TL-F2: the capability grant fails closed until Capability carries a scope SD §BE-10 does not state', () => {
  const base = { accountId: SELF, roles: ['trusted_contact'] as Role[] };
  const live = { ...base, capability: { expiresAt: at(HOUR) } };

  // D1 — a live token against a session the holder owns: refused.
  expectDeny(
    can(live, 'read', { type: 'session', ownerAccountId: SELF }, CTX),
    'role_missing',
    'D1 live token, session owned by SELF',
  );

  // D2 — a live token against a session naming no owner: refused.
  expectDeny(
    can(live, 'read', { type: 'session' }, CTX),
    'role_missing',
    'D2 live token, no owner',
  );

  // D3 — the other CAP cell answers the same way.
  expectDeny(
    can(live, 'raise_concern', { type: 'sos', ownerAccountId: SELF }, CTX),
    'role_missing',
    'D3 live token, sos#raise_concern',
  );

  // D4 — an expired token was refused before and still is.
  expectDeny(
    can({ ...base, capability: { expiresAt: at(-MINUTE) } }, 'read', { type: 'session' }, CTX),
    'role_missing',
    'D4 expired token',
  );

  // THE PIN. No cell in the matrix can produce `capability_token` at this
  // commit. This turns RED the day a successor gives `Capability` a scope and
  // the grant allows again — which is the signal to update the contract, not a
  // failure. It asserts the cells exist first, so it cannot pass vacuously.
  let capCells = 0;
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      if ((row as Row)[role].kind !== 'capability') continue;
      const holder: Actor = {
        accountId: SELF,
        roles: [role],
        capability: { expiresAt: at(HOUR) },
      };
      const decision = can(
        holder,
        actionOf(key),
        { type: resourceOf(key), ownerAccountId: SELF },
        CTX,
      );
      assert.equal(decision.allow, false, `${key} / ${role} must not allow`);
      capCells++;
    }
  }
  assert.equal(capCells, 2, 'the two CAP cells are session#read and sos#raise_concern');
});

test('SA §SA-4 I-5: the countersigner must be a different actor from the one acting', () => {
  const actor: Actor = {
    accountId: SELF,
    roles: ['ts_senior'],
    stepUpUntil: FRESH_STEP_UP,
  };
  expectAllow(
    can(actor, 'remove_permanently', { type: 'account', countersignedBy: OTHER }, CTX),
    'role_grant',
    'a second actor',
  );
  expectDeny(
    can(actor, 'remove_permanently', { type: 'account', countersignedBy: SELF }, CTX),
    'four_eyes_required',
    'the same actor cannot supply both',
  );
  expectDeny(
    can(actor, 'remove_permanently', { type: 'account' }, CTX),
    'four_eyes_required',
    'nobody countersigned',
  );
});

test('SD §BE-17 item 4: an outcome may be recorded under Model A and never under Model B', () => {
  const actor: Actor = {
    accountId: SELF,
    roles: ['ts_operator'],
    stepUpUntil: FRESH_STEP_UP,
  };
  expectAllow(
    can(actor, 'record', { type: 'certificate_outcome', art10Model: 'platform_sights' }, CTX),
    'role_grant',
    'Model A',
  );
  expectDeny(
    can(actor, 'record', { type: 'certificate_outcome', art10Model: 'sitter_held' }, CTX),
    'art10_model_prohibits_outcome_recording',
    'Model B',
  );
  expectDeny(
    can(actor, 'record', { type: 'certificate_outcome' }, CTX),
    'art10_model_prohibits_outcome_recording',
    'no model declared fails closed to Model B',
  );
});

test('SD §UC-8: an operator may moderate only a locale their validated languages cover', () => {
  const base = { accountId: SELF, roles: ['ts_operator'] as Role[], stepUpUntil: FRESH_STEP_UP };
  expectAllow(
    can(
      { ...base, operatorLocales: ['el', 'en'] },
      'moderate',
      { type: 'content_moderation', locale: 'el' },
      CTX,
    ),
    'role_grant',
    'covered',
  );
  expectDeny(
    can(
      { ...base, operatorLocales: ['en'] },
      'moderate',
      { type: 'content_moderation', locale: 'ru' },
      CTX,
    ),
    'operator_does_not_cover_locale',
    'not covered',
  );
  expectDeny(
    can({ ...base, operatorLocales: ['en'] }, 'moderate', { type: 'content_moderation' }, CTX),
    'operator_does_not_cover_locale',
    'no locale on the item fails closed',
  );
  expectDeny(
    can(base, 'moderate', { type: 'content_moderation', locale: 'el' }, CTX),
    'operator_does_not_cover_locale',
    'no validated languages at all',
  );
});

test('a step-up older than ten minutes, or dated in the far future, does not count', () => {
  const resource: ResourceRef = { type: 'account', ownerAccountId: SELF };
  const base = { accountId: SELF, roles: ['parent'] as Role[] };
  expectAllow(
    can({ ...base, stepUpUntil: FRESH_STEP_UP }, 'update', resource, CTX),
    'own_record',
    'inside the window',
  );
  expectDeny(
    can({ ...base, stepUpUntil: at(-MINUTE) }, 'update', resource, CTX),
    'step_up_required',
    'already elapsed',
  );
  expectDeny(
    can({ ...base, stepUpUntil: at(STEP_UP_MAX_AGE_MS + MINUTE) }, 'update', resource, CTX),
    'step_up_required',
    'further out than ten minutes',
  );
  expectDeny(can(base, 'update', resource, CTX), 'step_up_required', 'never stepped up');
});

test('the ten-minute step-up boundary is inclusive at ten minutes and closed at zero', () => {
  const resource: ResourceRef = { type: 'account', ownerAccountId: SELF };
  const base = { accountId: SELF, roles: ['parent'] as Role[] };
  expectAllow(
    can({ ...base, stepUpUntil: at(STEP_UP_MAX_AGE_MS) }, 'update', resource, CTX),
    'own_record',
    'exactly ten minutes',
  );
  expectDeny(
    can({ ...base, stepUpUntil: NOW }, 'update', resource, CTX),
    'step_up_required',
    'expiring exactly now',
  );
});

test('reading own account needs no step-up but updating it does (SD §BE-10)', () => {
  const resource: ResourceRef = { type: 'account', ownerAccountId: SELF };
  const actor: Actor = { accountId: SELF, roles: ['parent'] };
  expectAllow(can(actor, 'read', resource, CTX), 'own_record', 'read');
  expectDeny(can(actor, 'update', resource, CTX), 'step_up_required', 'update');
});

/**
 * Role strings with no column in SD §BE-10. `Actor.roles` is typed, but the
 * runtime value is JWT-supplied (SD §BE-10's token model), so the cast is what
 * the call site actually looks like — not a construction.
 */
const unrecognised = (...names: readonly string[]): readonly Role[] =>
  names as unknown as readonly Role[];

test('isRole is the positive membership test, and a caller uses it at the token boundary', () => {
  for (const role of ROLES) assert.equal(isRole(role), true, role);
  for (const name of [
    'deputy_dsl',
    'referee',
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '',
    'Parent',
    'dsl ',
  ]) {
    assert.equal(isRole(name), false, name);
  }
  assert.equal(isRole(undefined), false);
  assert.equal(isRole(null), false);
  assert.equal(isRole(5), false);
  assert.equal(isRole({}), false);
});

test('QR-1: an unrecognised role contributes nothing, and the two orders give the same Decision', () => {
  const owned: ResourceRef = { type: 'account', ownerAccountId: SELF };
  const deputyFirst = can(
    { accountId: SELF, roles: unrecognised('deputy_dsl', 'parent') },
    'read',
    owned,
    CTX,
  );
  const parentFirst = can(
    { accountId: SELF, roles: unrecognised('parent', 'deputy_dsl') },
    'read',
    owned,
    CTX,
  );
  expectAllow(deputyFirst, 'own_record', 'deputy_dsl first');
  expectAllow(parentFirst, 'own_record', 'parent first');
  assert.deepEqual(
    deputyFirst,
    parentFirst,
    'an unrecognised role cannot change the decision, whichever end of the array it sits at',
  );
});

/**
 * RR-1 (OE-18). Two RECOGNISED roles that both allow, which is a different case
 * from the one above and is NOT covered by it: `can()` returns on the FIRST
 * role that allows, so the verdict is the same either way round while the
 * `basis` is that of whichever allowing role sat earlier in the array.
 *
 * This is a LIMITATION case, not a refusal. `basis` is audit-log content
 * (SD §BE-10), so for a multi-role actor the recorded justification follows
 * array order. Which `basis` is authoritative when two roles allow is a
 * question SD §BE-10 does not answer: it is deferred to the stakeholder with
 * OE-17 / OD-63, and no agent may invent a precedence rule. The day anyone
 * makes `basis` deterministic this case turns red, which is why it is pinned.
 */
test('LIMITATION (RR-1): two allowing roles agree on the verdict, and the basis follows array order', () => {
  const owned: ResourceRef = { type: 'session', ownerAccountId: SELF };
  const parentFirst = can({ accountId: SELF, roles: ['parent', 'support'] }, 'read', owned, CTX);
  const supportFirst = can({ accountId: SELF, roles: ['support', 'parent'] }, 'read', owned, CTX);

  // The VERDICT does not depend on the order: both orders allow.
  assert.equal(parentFirst.allow, true, 'parent first allows');
  assert.equal(supportFirst.allow, true, 'support first allows');

  // The BASIS does: it is the first allowing role's, and the two differ.
  expectAllow(parentFirst, 'own_record', 'parent first reports own_record');
  expectAllow(supportFirst, 'role_grant', 'support first reports role_grant');
  assert.notDeepEqual(
    parentFirst,
    supportFirst,
    'the basis follows array order today; making it deterministic must turn this red',
  );
});

test('QR-1: an actor whose every role has no column in the matrix is denied, never thrown at', () => {
  expectDeny(
    can(
      { accountId: SELF, roles: unrecognised('deputy_dsl') },
      'read',
      { type: 'child.health' },
      CTX,
    ),
    'role_missing',
    'deputy_dsl alone',
  );
  expectDeny(
    can({ accountId: SELF, roles: unrecognised('referee') }, 'read', { type: 'session' }, CTX),
    'role_missing',
    'referee alone',
  );
});

test('QR-3: a prototype-shaped role name is not a role, and reaches no decision either way round', () => {
  const owned: ResourceRef = { type: 'account', ownerAccountId: SELF };
  for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    expectDeny(
      can({ accountId: SELF, roles: unrecognised(name) }, 'read', { type: 'session' }, CTX),
      'role_missing',
      name,
    );
    expectAllow(
      can({ accountId: SELF, roles: unrecognised(name, 'parent') }, 'read', owned, CTX),
      'own_record',
      `${name} before parent`,
    );
    expectAllow(
      can({ accountId: SELF, roles: unrecognised('parent', name) }, 'read', owned, CTX),
      'own_record',
      `${name} after parent`,
    );
  }
});

test('QR-1: when every role refuses, the reported refusal does not depend on the order either', () => {
  const resource: ResourceRef = { type: 'account' };
  const forward: Actor = {
    accountId: SELF,
    roles: unrecognised('ts_operator', 'deputy_dsl', 'ts_senior'),
    stepUpUntil: FRESH_STEP_UP,
  };
  const reverse: Actor = {
    accountId: SELF,
    roles: unrecognised('ts_senior', 'deputy_dsl', 'ts_operator'),
    stepUpUntil: FRESH_STEP_UP,
  };
  expectDeny(can(forward, 'remove_permanently', resource, CTX), 'four_eyes_required', 'forward');
  assert.deepEqual(
    can(reverse, 'remove_permanently', resource, CTX),
    can(forward, 'remove_permanently', resource, CTX),
  );
});

test('LIMITATION (QR-4): ctx is not validated, so a malformed one allows, denies or throws by cell', () => {
  const noCtx = {} as unknown as PolicyContext;
  const support: Actor = { accountId: SELF, roles: ['support'] };
  // (a) a plain grant never reads the clock, so a caller who forgot `now` is ALLOWED.
  expectAllow(
    can(support, 'read', { type: 'sitter.public_profile' }, CTX),
    'role_grant',
    'control: a well-formed ctx',
  );
  expectAllow(
    can(support, 'read', { type: 'sitter.public_profile' }, noCtx),
    'role_grant',
    'plain grant with no now: ALLOWED',
  );
  // (b) a step-up cell refuses before the clock is reached.
  expectDeny(
    can(support, 'cancel', { type: 'booking' }, noCtx),
    'step_up_required',
    'step-up cell',
  );
  // (c) WITHDRAWN (OE-20): the window cell used to THROW here, being the other
  // cell that read the clock. It no longer reads one, so a malformed `ctx`
  // reaches no `getTime()` and the cell simply denies. One of the two throwing
  // cells is therefore gone — the remaining one is break-glass, below — and
  // the three outcomes this case pins are still all present.
  expectDeny(
    can(
      { accountId: SELF, roles: ['sitter'] },
      'read',
      {
        type: 'child.health',
        ownerAccountId: FAMILY,
        booking: {
          state: 'completed',
          sitterAccountId: SELF,
          parentAccountId: FAMILY,
          completedAt: NOW,
        },
      },
      noCtx,
    ),
    'role_missing',
    'window cell with no now: denies rather than throwing',
  );
  // (d) a time-dependent cell that survives the withdrawal still throws.
  assert.throws(
    () =>
      can(
        {
          accountId: SELF,
          roles: ['engineer'],
          breakGlass: { purpose: 'incident 9', expiresAt: NOW },
        },
        'read',
        { type: 'production_data' },
        noCtx,
      ),
    TypeError,
    'break-glass cell with no now',
  );
});

test('no decision ever carries both an allow basis and a deny reason', () => {
  for (const [key, row] of MATRIX) {
    for (const role of ROLES) {
      const grant = (row as Row)[role];
      const { actor, resource } = satisfying(grant, role, resourceOf(key));
      const d = can(actor, actionOf(key), resource, CTX);
      const keys = Object.keys(d).sort().join(',');
      assert.equal(keys === 'allow,basis' || keys === 'allow,reason', true, `${key}/${role}`);
    }
  }
});
