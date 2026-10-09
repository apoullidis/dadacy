/**
 * The contact read path's refusal, without a database (T-246). The read against the real
 * `account` table is held in the containerised worker (`apps/worker` test `(T-246)`).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { accountId, isErrorCode, NotFoundError } from '@kinvara/domain-types';
import { AccountNotFoundError, contactFromRows } from './index.ts';

const ID = accountId('01K0T2460000000000000000AB', 'accountId');

test('an absent account id is the named refusal AccountNotFoundError, never undefined, and it carries no identifier', () => {
  assert.throws(
    () => contactFromRows(ID, []),
    (e: unknown) => {
      assert.ok(e instanceof AccountNotFoundError);
      assert.ok(e instanceof NotFoundError);
      assert.equal(e.name, 'AccountNotFoundError');
      assert.equal(e.code, 'not_found');
      assert.equal(e.status, 404);
      assert.equal(e.retryable, false);
      assert.ok(isErrorCode(e.code));
      assert.equal(e.message, 'not_found');
      assert.ok(!e.message.includes(ID) && !String(e.stack).includes(ID));
      return true;
    },
  );
});

test('a present account returns its stored email and phone, NULLs as null', () => {
  assert.deepEqual(contactFromRows(ID, [{ email: 'a@example.test', phoneE164: '+35799000001' }]), {
    accountId: ID,
    email: 'a@example.test',
    phoneE164: '+35799000001',
  });
  assert.deepEqual(contactFromRows(ID, [{ email: null, phoneE164: null }]), {
    accountId: ID,
    email: null,
    phoneE164: null,
  });
});
