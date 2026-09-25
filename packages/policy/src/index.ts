/**
 * `@kinvara/policy` — SA §TS-7 layer 1.
 *
 * Shared by `core`, `admin` and `safety-gw` (SD §DH-1), so that the admin UI
 * can hide what the API would refuse and never the reverse (SD §FE-3).
 */
export { can, WINDOW_TAIL_MS, STEP_UP_MAX_AGE_MS } from './can.ts';
export { MATRIX, cell } from './matrix.ts';
export { ROLES, isRole } from './types.ts';
/**
 * The input contract (`T-134`). Exported for the same reason `isRole` is: a
 * caller can ask at its own boundary whether the identity it is about to pass
 * is well-formed, which the `Decision` cannot tell it (SD §BE-10's
 * `DenyReason` set is closed, so a junk id denies with `role_missing` exactly
 * as a real id holding no permission does).
 */
export { knownId } from './identity.ts';
export type {
  AccountStatus,
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
