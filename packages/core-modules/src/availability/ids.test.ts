/** `newAvailabilityId` is a canonical ULID and monotonic in-process, including within one ms (OD-335's id tie-break). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isUlid } from '@kinvara/domain-types';
import { newAvailabilityId } from './ids.ts';

test('1000 ids generated in ONE millisecond are canonical ULIDs and strictly increasing', () => {
  const fixed = () => 1_800_000_000_000;
  const ids = Array.from({ length: 1000 }, () => newAvailabilityId(fixed));
  for (const id of ids) assert.ok(isUlid(id), id);
  for (let i = 1; i < ids.length; i++)
    assert.ok(
      (ids[i - 1] as string) < (ids[i] as string),
      `id ${String(i)} sorts after id ${String(i - 1)}`,
    );
});

test('a clock that steps BACK still yields increasing ids', () => {
  const a = newAvailabilityId(() => 1_900_000_000_000);
  const b = newAvailabilityId(() => 1_899_999_999_000);
  assert.ok(a < b);
});

test('a later millisecond restarts the random part and still sorts after', () => {
  const a = newAvailabilityId(() => 1_950_000_000_000);
  const b = newAvailabilityId(() => 1_950_000_000_001);
  assert.ok(a < b);
  assert.equal(b.slice(0, 10) > a.slice(0, 10), true);
});
