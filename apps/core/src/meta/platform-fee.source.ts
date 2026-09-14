/**
 * Where `GET /v1/meta/platform-fee` gets its amount.
 *
 * NO SPECIFICATION GIVES THIS ENDPOINT AN AMOUNT. `T-022` defined the operation
 * as the pipeline's one trivial endpoint; the real fee lines live in
 * `market_config` (SD SQ-28, `T-032`), which needs a database connection, and
 * that is out of `T-135`'s scope. SD §QD-1's Semgrep list also bans a
 * hard-coded commission constant outside a `market_config` read.
 *
 * So the amount comes through this seam, and the scaffold binds a source that
 * answers ZERO. Zero is not a price and nothing may read it as one; it is the
 * value that makes a stale scaffold binding obvious rather than plausible.
 * The ticket that connects `market_config` replaces the binding in
 * `app.module.ts` and nothing else.
 */
import { minorUnits, type MinorUnits } from '@kinvara/domain-types';

export const PLATFORM_FEE_SOURCE = Symbol('PLATFORM_FEE_SOURCE');

export interface PlatformFeeSource {
  readonly currentMinor: () => MinorUnits;
}

export const SCAFFOLD_PLATFORM_FEE_SOURCE: PlatformFeeSource = {
  currentMinor: () => minorUnits(0n, 'amountMinor'),
};
