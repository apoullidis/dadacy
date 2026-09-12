/**
 * GENERATED FILE — do not edit.
 *
 * Written by packages/contracts/tools/generate.ts from openapi.json, which is
 * itself generated from the Zod schemas in src/endpoints.ts. Edit the Zod, then
 * run `pnpm --filter @kinvara/contracts run generate`. `pnpm gate:contract-drift`
 * refuses a hand edit to this file and a Zod edit that was not regenerated.
 *
 * THE TYPES BELOW COME FROM THE DOCUMENT; the runtime parse below comes from the
 * Zod schema. They are two derivations of one contract, and `tsc` has to accept
 * the assignment between them — see the `satisfies` clauses at the end. That is a
 * cross-check `pnpm -w typecheck` enforces, and typecheck IS in gate:pr, unlike
 * this package's tests (OD-57).
 */
import * as schemas from '../endpoints.ts';

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: "invalid_input" | "unauthenticated" | "policy_denied" | "not_found" | "state_transition_invalid" | "idempotency_key_reuse" | "slot_taken" | "precondition_failed" | "rate_below_floor" | "outside_staffed_hours" | "sitter_review_hold" | "rate_limited" | "upstream_unavailable" | "internal_error";
  readonly field?: string;
  readonly retryable: boolean;
  readonly [extension: string]: unknown;
}

export interface PlatformFee {
  readonly currency: "EUR";
  readonly amountMinor: string;
}

export interface ClientOptions {
  /** Origin the API is served from, with no trailing slash. */
  readonly baseUrl: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Thrown when the server answers a problem+json body. */
export class ProblemResponseError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    // The MESSAGE is the code, never the body: a logged stack must not carry a
    // field name or an extension value (PROTOCOL §9.2).
    super(problem.code);
    this.name = 'ProblemResponseError';
    this.problem = problem;
  }
}

export interface KinvaraClient {
  readonly getPlatformFee: () => Promise<PlatformFee>;
}

export function createClient(options: ClientOptions): KinvaraClient {
  const doFetch = async (path: string, method: string): Promise<Response> => {
    const impl = options.fetch ?? globalThis.fetch;
    const response = await impl(`${options.baseUrl}${path}`, {
      method,
      headers: { accept: 'application/json, application/problem+json' },
    });
    if (!response.ok) {
      throw new ProblemResponseError(schemas.Problem.parse(await response.json()) as Problem);
    }
    return response;
  };
  return {
    getPlatformFee: async () => {
      const response = await doFetch('/v1/meta/platform-fee', 'GET');
      return schemas.PlatformFee.parse(await response.json()) as PlatformFee;
    },
  };
}

// The cross-check named in the header: what the Zod schema parses must be
// assignable to the type the DOCUMENT declares. A generator that mistranslated a
// schema fails here, under `pnpm -w typecheck`.
type _getPlatformFeeParsed = ReturnType<typeof schemas.PlatformFee.parse> extends infer P ? P : never;
const _getPlatformFeeCheck = null as unknown as _getPlatformFeeParsed satisfies PlatformFee;
void _getPlatformFeeCheck;
