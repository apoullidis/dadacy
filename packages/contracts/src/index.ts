/**
 * `@kinvara/contracts` — the single source of truth for the HTTP surface
 * (SD §DH-1, SA §TS-5). T-022.
 *
 * `import { … } from '@kinvara/contracts'`. Three groups:
 *   - THE ERROR-CODE ENUM (`ERROR_CODES`, `isErrorCode`, `ErrorCode`), which
 *     is SD §BE-2's "single enum in packages/contracts". See `error-codes.ts`
 *     for how a module adds a code.
 *   - THE WIRE TYPES, as Zod schemas: `Problem`, `Money`, `PlatformFee`,
 *     `MinorUnitsWire`, plus `encodeMinorUnits` / `decodeMinorUnits`, which
 *     are the only supported way to put money in a payload.
 *   - THE GENERATED CLIENT: `createClient`, and the response interfaces the
 *     OpenAPI document declares.
 *
 * NAMING. A Zod schema and the TypeScript interface generated for it cannot
 * both be called `Problem`, so the schemas keep the plain name and the
 * generated interfaces are re-exported with a `Body` suffix
 * (`ProblemBody`, `PlatformFeeBody`). Inside the package the generated file is
 * the one that carries the document's reading; the Zod schema is the source
 * of truth. They are required to agree by the `satisfies` clauses at the foot
 * of `src/generated/client.ts`, which `pnpm -w typecheck` enforces.
 */
export { ERROR_CODES, ERROR_CODE_SHAPE, isErrorCode, type ErrorCode } from './error-codes.ts';

export {
  MINOR_UNITS_PATTERN,
  MinorUnitsWire,
  Money,
  encodeMinorUnits,
  decodeMinorUnits,
} from './money-wire.ts';

export {
  TYPE_BASE,
  FORBIDDEN_MEMBERS,
  FIELD_NAME_PATTERN,
  Problem,
  hasNoForbiddenMembers,
  isWireProblem,
} from './problem.ts';

export {
  API_TITLE,
  API_VERSION,
  COMPONENT_SCHEMAS,
  OPERATIONS,
  PlatformFee,
  type Operation,
  type OperationResponse,
} from './endpoints.ts';

export {
  createClient,
  ProblemResponseError,
  type ClientOptions,
  type KinvaraClient,
  type Problem as ProblemBody,
  type PlatformFee as PlatformFeeBody,
} from './generated/client.ts';

/**
 * The document validator. Exported because a consumer verifying a payload
 * against the PUBLISHED document — rather than against Zod — is exactly the
 * independent reading this package uses in its own tests (PROTOCOL §5.1).
 */
export { validate as validateAgainstDocument, type SchemaRoot } from './json-schema-check.ts';
