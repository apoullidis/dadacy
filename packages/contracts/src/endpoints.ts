/**
 * THE HTTP SURFACE — the Zod half, and the SOURCE OF TRUTH for everything
 * `pnpm --filter @kinvara/contracts run generate` writes.
 *
 * THE DIRECTION OF DERIVATION, because `gate:contract-drift` compares two
 * artefacts and PROTOCOL §5.1 requires it to be said which one leads:
 *
 *     src/endpoints.ts  (Zod, hand-written — THE SOURCE OF TRUTH)
 *              |  tools/generate.ts, using z.toJSONSchema
 *              v
 *     openapi.json      (generated, committed)
 *              |  tools/generate.ts, reading the DOCUMENT, not the Zod
 *              v
 *     src/generated/client.ts  (generated, committed)
 *
 * The second leg reads `openapi.json`, not the Zod schemas. That is
 * deliberate: it makes the client a consumer of the published document, the
 * same artefact an external client would be handed, rather than a second
 * thing derived from Zod that could agree with Zod while the document was
 * wrong. T-022 § Published contract §5 states what this does and does not
 * buy.
 *
 * ONE TRIVIAL ENDPOINT, on purpose (T-022 is the pipeline, not the API):
 * `GET /v1/meta/platform-fee`. It takes no parameters, touches no database and
 * needs no service, which is why this ticket declares `svc: none`. It is not a
 * placeholder for the sake of one: it carries a `MinorUnits` value, so the
 * money wire format is exercised end to end by a real operation rather than
 * only by a unit test, and it declares a `Problem` response, so the error
 * contract is in the document from the first endpoint.
 *
 * ADDING AN ENDPOINT — the whole procedure:
 *   1. Write its Zod schemas here and add them to `COMPONENT_SCHEMAS` under
 *      the name they should have in `components/schemas`.
 *   2. Add an entry to `OPERATIONS`.
 *   3. `pnpm --filter @kinvara/contracts run generate`.
 *   4. Commit the regenerated `openapi.json` and `src/generated/client.ts`
 *      WITH your schema change. `pnpm gate:contract-drift` is red until you
 *      do, and that is the only thing that keeps the three artefacts in step.
 *   5. Add your payloads to the conformance corpus in `src/openapi.test.ts`,
 *      so the document's reading of your schema is checked by something that
 *      is not Zod.
 */
import { Money } from './money-wire.ts';
import { Problem } from './problem.ts';
import type { ZodType } from 'zod';

/**
 * Re-exported under its component name so the generated client can import
 * every `components/schemas` entry from one module. The generator emits
 * `schemas.<ComponentName>.parse(...)`, so a component whose name is not
 * exported here fails `pnpm -w typecheck` rather than at run time.
 */
export { Problem };

/**
 * The platform fee, as the server prices it. PROTOCOL §9.6: money never
 * crosses the wire FROM the client — this is server -> client only, and there
 * is no request body anywhere in this document.
 */
export const PlatformFee = Money;

/**
 * Everything that becomes a `components/schemas` entry, by the name it gets
 * there. The generator emits these and nothing else, so a schema that is not
 * in this record is not in the document.
 */
export const COMPONENT_SCHEMAS: Readonly<Record<string, ZodType>> = {
  Problem,
  PlatformFee,
};

export interface OperationResponse {
  readonly status: number;
  /** A key of COMPONENT_SCHEMAS. */
  readonly schema: string;
  readonly description: string;
}

export interface Operation {
  readonly operationId: string;
  readonly method: 'get';
  readonly path: string;
  readonly summary: string;
  readonly responses: readonly OperationResponse[];
}

/**
 * The operation table. `operationId` becomes the client's method name, so it
 * is camelCase and unique — asserted by `openapi.test.ts` ›
 * *every operationId is unique and camelCase, and every response names a
 * schema that exists*.
 */
export const OPERATIONS: readonly Operation[] = [
  {
    operationId: 'getPlatformFee',
    method: 'get',
    path: '/v1/meta/platform-fee',
    summary: 'The platform fee, in EUR minor units, as a decimal-integer string.',
    responses: [
      { status: 200, schema: 'PlatformFee', description: 'The current platform fee.' },
      {
        status: 429,
        schema: 'Problem',
        description: 'Rate limited. `retryable` is true.',
      },
      {
        status: 500,
        schema: 'Problem',
        description: 'Internal error. Carries nothing from the request.',
      },
    ],
  },
];

/** SA §TS-5: the API is versioned in the path, and `/v1` is the only version. */
export const API_TITLE = 'Kinvara API';
export const API_VERSION = '0.1.0';
