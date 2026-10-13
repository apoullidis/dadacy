/**
 * The availability module's queues (SD §BE-11 line 1352; C10 (a)).
 *
 *   `search.slot_materialise`          `{ sitterId }` — recompute one sitter's slots (SD 1352:
 *                                       "Enqueued in the same txn as any availability/booking
 *                                       change", "idempotent recompute", "3 attempts").
 *   `search.slot_materialise_nightly`  `{}` — C10 (a)'s nightly roll (SA 1214 "and nightly"; a
 *                                       job row SD's table omits, EV-n): its handler enqueues
 *                                       `search.slot_materialise` for every sitter profile, so a
 *                                       sitter who edits nothing keeps a full 56-day horizon.
 *
 * The payload is not notify-bearing (no recipient), so it does not extend `NotifyJobBase`.
 * `strictObject`: an unknown key is refused, not stripped (T-147 § contract §1's reasoning).
 */
import * as z from 'zod';
import { isUlid, type Ulid } from '@kinvara/domain-types';
import { defineJob } from '../jobs/index.ts';

export const SLOT_MATERIALISE_QUEUE = 'search.slot_materialise';
export const SLOT_MATERIALISE_NIGHTLY_QUEUE = 'search.slot_materialise_nightly';

/**
 * SD 1352: "3 attempts" — pg-boss counts RETRIES, so `retryLimit: 2`. pg-boss's own default is
 * also 2; it is stated so a changed default cannot change it silently.
 */
export const SLOT_MATERIALISE_QUEUE_OPTIONS = {
  retryLimit: 2,
  retryDelay: 1,
  retryBackoff: false,
  expireInSeconds: 120,
} as const;

export const SLOT_MATERIALISE_NIGHTLY_QUEUE_OPTIONS = {
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: false,
  expireInSeconds: 900,
} as const;

/**
 * The nightly roll fires at 00:15 local, just after the local date changes, so the horizon start
 * (local today 00:00) moves forward the same night. Zone `Europe/Nicosia` (HORIZON_ZONE).
 */
export const SLOT_MATERIALISE_NIGHTLY_CRON = '15 0 * * *';
export const SLOT_MATERIALISE_NIGHTLY_TZ = 'Europe/Nicosia';

/**
 * The nightly fan-out's jobs go in at priority -1, below the default 0 every edit-triggered
 * `search.slot_materialise` carries (pg-boss fetches `priority desc, created_on`), so a nightly
 * backlog waiting in the queue is fetched AFTER the job of a sitter's own edit (SD 1352: "High
 * priority, ≤5 s"). That order is pg-boss 12.26.4's fetch (`plans.js` `ORDER BY j.priority desc,
 * j.created_on, j.id`, read, not run); a nightly job already in flight is not pre-empted.
 */
export const SLOT_MATERIALISE_NIGHTLY_FANOUT_PRIORITY = -1;

const SitterUlid = z.custom<Ulid>((value) => isUlid(value), {
  message: 'sitterId must be a canonical ULID; the rejected value is not shown',
});

export const SlotMaterialisePayload = z.strictObject({ sitterId: SitterUlid });
export const SlotMaterialiseNightlyPayload = z.strictObject({});

export const SLOT_MATERIALISE_JOB = defineJob(SLOT_MATERIALISE_QUEUE, SlotMaterialisePayload);
export const SLOT_MATERIALISE_NIGHTLY_JOB = defineJob(
  SLOT_MATERIALISE_NIGHTLY_QUEUE,
  SlotMaterialiseNightlyPayload,
);
