/**
 * `@kinvara/policy` — SA §TS-7 layer 1.
 *
 * Shared by `core`, `admin` and `safety-gw` (SD §DH-1), so that the admin UI
 * can hide what the API would refuse and never the reverse (SD §FE-3).
 */
export { can, WINDOW_TAIL_MS, STEP_UP_MAX_AGE_MS } from './can.ts';
export { MATRIX, cell } from './matrix.ts';
export { ROLES } from './types.ts';
export type {
  Action,
  Actor,
  AllowBasis,
  Art10Model,
  BookingState,
  BookingWindow,
  BreakGlass,
  Capability,
  Cell,
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
