/**
 * `@kinvara/core-modules/jobs` — the transactional enqueue (T-149, EV-30). Loaded by `apps/core` and
 * by `apps/worker` (a worker handler enqueues its follow-on job in its own transaction), so it lives
 * here rather than in either app (`state/EP-2/CUT-OD-292.md` §4.1). Import it by package name only.
 */
export {
  defineJob,
  JOB_QUEUE_REFUSED,
  JobEnqueuer,
  JobPayloadRefusedError,
  type EnqueueOptions,
  type JobDefinition,
  type JobSender,
  type PayloadIssue,
} from './enqueue.ts';
