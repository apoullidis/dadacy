/**
 * The published surface, exercised through the barrel.
 *
 * `src/index.ts` is what `core`, `admin` and `safety-gw` import (SD §FE-3), and
 * it is a pure re-export file: 0 statements and 0 branches, so coverage cannot
 * speak for it either way. This file is what proves it is wired, by reaching
 * the evaluator through the barrel and requiring the same decision the module
 * gives directly.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { accountId } from '@kinvara/domain-types';
import * as policy from './index.ts';
import { can as canDirect } from './can.ts';
import { MATRIX as matrixDirect } from './matrix.ts';
import type { Actor, PolicyContext, ResourceRef } from './types.ts';

const ID = accountId('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'actorId');
const CTX: PolicyContext = { now: new Date('2026-09-12T12:00:00.000Z') };

test('the barrel exports the surface SA §TS-7 and SD §BE-10 name', () => {
  assert.equal(typeof policy.can, 'function');
  assert.equal(typeof policy.cell, 'function');
  assert.equal(policy.MATRIX instanceof Map, true);
  assert.equal(Array.isArray(policy.ROLES), true);
  assert.equal(policy.ROLES.length, 10);
});

test('the barrel exports isRole, so a caller can test a JWT role string before deciding', () => {
  assert.equal(typeof policy.isRole, 'function');
  assert.equal(policy.isRole('dsl'), true);
  assert.equal(policy.isRole('deputy_dsl'), false);
  assert.equal(policy.isRole('referee'), false);
});

test('the barrel exports the two spec constants at their SD and SA values', () => {
  assert.equal(policy.WINDOW_TAIL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(policy.STEP_UP_MAX_AGE_MS, 10 * 60 * 1000);
});

test('cell() composes the matrix key the evaluator looks a decision up by', () => {
  assert.equal(policy.cell('child.health', 'read'), 'child.health#read');
  assert.equal(policy.MATRIX.has(policy.cell('child.health', 'read')), true);
});

test('the barrel re-exports the matrix itself, not a copy, and it has all 46 rows', () => {
  assert.equal(policy.MATRIX, matrixDirect);
  assert.equal(policy.MATRIX.size, 46);
});

test('can() reached through the barrel decides identically to the module itself', () => {
  const actor: Actor = { accountId: ID, roles: ['parent'] };
  const resource: ResourceRef = { type: 'account', ownerAccountId: ID };
  const throughBarrel = policy.can(actor, 'read', resource, CTX);
  assert.deepEqual(throughBarrel, canDirect(actor, 'read', resource, CTX));
  assert.deepEqual(throughBarrel, { allow: true, basis: 'own_record' });
});

test('a refusal reached through the barrel carries a reason and never a basis', () => {
  const actor: Actor = { accountId: ID, roles: ['support'] };
  const decision = policy.can(actor, 'read', { type: 'child.health' }, CTX);
  assert.deepEqual(decision, { allow: false, reason: 'role_missing' });
  assert.equal('basis' in decision, false);
});
