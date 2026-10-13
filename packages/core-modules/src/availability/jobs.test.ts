/** The queue names, options and payload schemas (SD 1352 "3 attempts"; C10 (a)). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SLOT_MATERIALISE_JOB,
  SLOT_MATERIALISE_NIGHTLY_JOB,
  SLOT_MATERIALISE_QUEUE_OPTIONS,
} from './jobs.ts';

test('search.slot_materialise: three attempts (retryLimit 2); payload { sitterId } strict, ULID only', () => {
  assert.equal(SLOT_MATERIALISE_JOB.queue, 'search.slot_materialise');
  assert.equal(SLOT_MATERIALISE_QUEUE_OPTIONS.retryLimit, 2);
  assert.equal(
    SLOT_MATERIALISE_JOB.payload.safeParse({ sitterId: '01J0000000000000000000000A' }).success,
    true,
  );
  assert.equal(SLOT_MATERIALISE_JOB.payload.safeParse({ sitterId: 'not-a-ulid' }).success, false);
  assert.equal(
    SLOT_MATERIALISE_JOB.payload.safeParse({ sitterId: '01J0000000000000000000000A', extra: 1 })
      .success,
    false,
  );
  assert.equal(SLOT_MATERIALISE_JOB.payload.safeParse({}).success, false);
});

test('search.slot_materialise_nightly: an empty strict payload', () => {
  assert.equal(SLOT_MATERIALISE_NIGHTLY_JOB.queue, 'search.slot_materialise_nightly');
  assert.equal(SLOT_MATERIALISE_NIGHTLY_JOB.payload.safeParse({}).success, true);
  assert.equal(
    SLOT_MATERIALISE_NIGHTLY_JOB.payload.safeParse({ sitterId: '01J0000000000000000000000A' })
      .success,
    false,
  );
});
