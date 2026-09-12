/**
 * THE PUBLISHED ERROR-CODE ENUM — SD §BE-2's "single enum in
 * `packages/contracts`". Every module that raises, maps or consumes an API
 * error codes against THIS module.
 *
 * It is a RE-EXPORT, not a copy. The declaration lives in
 * `@kinvara/domain-types`' `src/error-codes.ts`, because the check that has to
 * refuse a non-member is `DomainError`'s constructor, in that package, and
 * `packages/contracts` already imports `packages/domain-types` for
 * `MinorUnits` — so declaring it here would be an import cycle, which
 * `gate:deps`' `no-circular` rule refuses. There is still exactly ONE set.
 *
 * That "exactly one" is not a promise, it is asserted: `error-codes.test.ts` ›
 * *the contracts enum IS the domain-types declaration, not a copy of it*
 * compares the two arrays by reference identity, so a second list cannot be
 * introduced here without turning it red.
 *
 * HOW A MODULE ADDS A CODE. One edit, then one command:
 *   1. Add the string to `ERROR_CODES` in
 *      `packages/domain-types/src/error-codes.ts`, in status order.
 *   2. `pnpm --filter @kinvara/contracts run generate`, which rewrites
 *      `openapi.json` and `src/generated/client.ts`. Skipping this step is
 *      exactly what `pnpm gate:contract-drift` refuses — see T-022
 *      § Published contract §5.
 *   3. Subclass the abstract category with the right status
 *      (`ConflictError` 409, `DomainRuleViolationError` 422, `LockedError`
 *      423), passing the new code as a LITERAL. A non-member does not compile
 *      (`ErrorIdentity.code` is typed `ErrorCode`) and does not construct (the
 *      runtime membership check).
 * Nothing else needs editing: the OpenAPI `Problem.code` enum and the client's
 * `ErrorCode` union are both generated from this one array.
 */
export { ERROR_CODES, ERROR_CODE_SHAPE, isErrorCode, type ErrorCode } from '@kinvara/domain-types';
