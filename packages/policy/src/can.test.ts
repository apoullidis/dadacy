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

const at = (deltaMs: number): Date => new Date(NOW.getTime() + deltaMs);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A step-up that happened inside SD §BE-10's ten-minute window. */
const FRESH_STEP_UP = at(5 * MINUTE);

const BASIS_OF: Record<Exclude<GrantKind, 'deny'>, AllowBasis> = {
  allow: 'role_grant',
  own: 'own_record',
  window: 'confirmed_booking_window',
  break_glass: 'break_glass',
  capability: 'capability_token',
  four_eyes: 'role_grant',
  art10: 'role_grant',
  locale: 'role_grant',
};

const REASON_OF: Record<Exclude<GrantKind, 'allow'>, DenyReason> = {
  deny: 'role_missing',
  own: 'role_missing',
  window: 'booking_not_confirmed',
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
      if (grant.kind === 'deny') continue;
      const { actor, resource } = satisfying(grant, role, resourceOf(key));
      expectAllow(
        can(actor, actionOf(key), resource, CTX),
        BASIS_OF[grant.kind],
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

test('SA §TS-7 worked example: a sitter reads child health inside the confirmed booking window', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const resource: ResourceRef = {
    type: 'child.health',
    booking: { state: 'confirmed', sitterAccountId: SELF, parentAccountId: FAMILY },
  };
  expectAllow(can(actor, 'read', resource, CTX), 'confirmed_booking_window', 'confirmed');
});

test('the window is open while a session is in progress', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const resource: ResourceRef = {
    type: 'child.health',
    booking: { state: 'in_progress', sitterAccountId: SELF, parentAccountId: FAMILY },
  };
  expectAllow(can(actor, 'read', resource, CTX), 'confirmed_booking_window', 'in_progress');
});

test('a booking that is not yet confirmed is booking_not_confirmed, in every pre-confirmation state', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  for (const state of ['requested', 'cancelled', 'declined'] as const) {
    const resource: ResourceRef = {
      type: 'child.health',
      booking: { state, sitterAccountId: SELF, parentAccountId: FAMILY },
    };
    expectDeny(can(actor, 'read', resource, CTX), 'booking_not_confirmed', state);
  }
});

test('a sitter with no booking at all is booking_not_confirmed, not role_missing', () => {
  expectDeny(
    can({ accountId: SELF, roles: ['sitter'] }, 'read', { type: 'child.health' }, CTX),
    'booking_not_confirmed',
    'no booking',
  );
});

test('another sitter’s booking gives this sitter nothing', () => {
  const resource: ResourceRef = {
    type: 'child.health',
    booking: { state: 'confirmed', sitterAccountId: OTHER, parentAccountId: FAMILY },
  };
  expectDeny(
    can({ accountId: SELF, roles: ['sitter'] }, 'read', resource, CTX),
    'role_missing',
    'not my booking',
  );
});

test('a completed booking keeps the window open for thirty days and shuts it after', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const completedAt = at(-WINDOW_TAIL_MS + MINUTE);
  const inside: ResourceRef = {
    type: 'child.health',
    booking: {
      state: 'completed',
      sitterAccountId: SELF,
      parentAccountId: FAMILY,
      completedAt,
    },
  };
  expectAllow(can(actor, 'read', inside, CTX), 'confirmed_booking_window', 'one minute inside');
  const outside: ResourceRef = {
    type: 'child.health',
    booking: {
      state: 'completed',
      sitterAccountId: SELF,
      parentAccountId: FAMILY,
      completedAt: at(-WINDOW_TAIL_MS - MINUTE),
    },
  };
  expectDeny(can(actor, 'read', outside, CTX), 'window_expired', 'one minute outside');
});

test('the thirtieth day is the last one inside the window, to the millisecond', () => {
  const actor: Actor = { accountId: SELF, roles: ['sitter'] };
  const boundary = (offset: number): ResourceRef => ({
    type: 'child.health',
    booking: {
      state: 'completed',
      sitterAccountId: SELF,
      parentAccountId: FAMILY,
      completedAt: at(-WINDOW_TAIL_MS + offset),
    },
  });
  expectAllow(can(actor, 'read', boundary(0), CTX), 'confirmed_booking_window', 'exactly 30d');
  expectDeny(can(actor, 'read', boundary(-1), CTX), 'window_expired', 'one ms past 30d');
});

test('a completed booking with no completion timestamp cannot open the window', () => {
  const resource: ResourceRef = {
    type: 'child.health',
    booking: { state: 'completed', sitterAccountId: SELF, parentAccountId: FAMILY },
  };
  expectDeny(
    can({ accountId: SELF, roles: ['sitter'] }, 'read', resource, CTX),
    'booking_not_confirmed',
    'completed with no completedAt',
  );
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

test('a capability token works until it expires and not after (SD §BE-3)', () => {
  const resource: ResourceRef = { type: 'session' };
  const base = { accountId: SELF, roles: ['trusted_contact'] as Role[] };
  expectAllow(
    can({ ...base, capability: { expiresAt: at(HOUR) } }, 'read', resource, CTX),
    'capability_token',
    'live',
  );
  expectDeny(
    can({ ...base, capability: { expiresAt: at(-MINUTE) } }, 'read', resource, CTX),
    'role_missing',
    'expired',
  );
  expectDeny(can(base, 'read', resource, CTX), 'role_missing', 'absent');
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
  // (c) a time-dependent cell throws.
  assert.throws(
    () =>
      can(
        { accountId: SELF, roles: ['sitter'] },
        'read',
        {
          type: 'child.health',
          booking: {
            state: 'completed',
            sitterAccountId: SELF,
            parentAccountId: FAMILY,
            completedAt: NOW,
          },
        },
        noCtx,
      ),
    TypeError,
    'window cell with no now',
  );
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
