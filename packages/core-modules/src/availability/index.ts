/**
 * `@kinvara/core-modules/availability` — the `availability` module's code that SD §BE-1 loads in
 * more than one deployable (SD 926: `core` full, `worker` "jobs (slot materialisation)"; EV-30;
 * T-245 RW1-C §5 row 1). T-089. This file is the subpath's whole public surface; import it by
 * package name only (a relative path into `src/` bypasses the `exports` map and nothing refuses it,
 * T-245 RW1-C §1 row 2).
 *
 * The materialiser never reads `booking` (role row T-089 as amended, OD-136): `T-162` adds the
 * booking and buffer subtraction between the exceptions and the coalescing (materialise.ts step 3).
 */
export { AVAILABILITY_LOCK_NS, lockSitterAvailability } from './lock.ts';
export { newAvailabilityId } from './ids.ts';
export {
  HORIZON_DAYS,
  HORIZON_ZONE,
  compareExceptions,
  horizonOf,
  materialise,
  subtractInterval,
  unionInterval,
  type ExceptionRow,
  type MaterialiseInput,
  type Span,
  type TemplateRow,
} from './materialise.ts';
export {
  localToday,
  materialiseSitter,
  type MaterialiseOptions,
  type MaterialiseResult,
} from './persist.ts';
export {
  readTemplate,
  replaceTemplate,
  templateEtag,
  TemplateBlockInput,
  TemplatePreconditionFailedError,
  TemplateReplaceInput,
  type ReplaceTemplateRequest,
  type TemplateReplaceBody,
  type TemplateRepresentation,
  type TemplateRowView,
} from './template.ts';
export {
  addAvailableNow,
  addException,
  availableNowBodies,
  AvailableNowInput,
  ExceptionInput,
  REASON_MAX_CHARS,
  type AddedException,
  type ExceptionBody,
} from './exception.ts';
export { readPublicAvailability, wholeHourSpans } from './public.ts';
export {
  SLOT_MATERIALISE_JOB,
  SLOT_MATERIALISE_NIGHTLY_CRON,
  SLOT_MATERIALISE_NIGHTLY_JOB,
  SLOT_MATERIALISE_NIGHTLY_QUEUE,
  SLOT_MATERIALISE_NIGHTLY_QUEUE_OPTIONS,
  SLOT_MATERIALISE_NIGHTLY_TZ,
  SLOT_MATERIALISE_QUEUE,
  SLOT_MATERIALISE_QUEUE_OPTIONS,
  SlotMaterialiseNightlyPayload,
  SlotMaterialisePayload,
} from './jobs.ts';
