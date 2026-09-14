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
 * T-022 SHIPPED ONE TRIVIAL ENDPOINT, on purpose (it is the pipeline, not the
 * API): `GET /v1/meta/platform-fee`. It takes no parameters, touches no
 * database and needs no service. It carries a `MinorUnits` value, so the money
 * wire format is exercised end to end, and it declares a `Problem` response, so
 * the error contract is in the document from the first endpoint.
 *
 * T-141 ADDED `POST /v1/auth/register`, the first operation with a REQUEST
 * BODY. An operation names its body's component in `request`; the generator
 * emits it as a required `application/json` `requestBody`, and the client
 * method takes it as its one argument.
 *
 * ADDING AN ENDPOINT — the whole procedure:
 *   1. Write its Zod schemas here and add them to `COMPONENT_SCHEMAS` under
 *      the name they should have in `components/schemas`.
 *   2. Add an entry to `OPERATIONS` (with `request` if it takes a body).
 *   3. `pnpm --filter @kinvara/contracts run generate`.
 *   4. Commit the regenerated `openapi.json` and `src/generated/client.ts`
 *      WITH your schema change. `pnpm gate:contract-drift` is red until you
 *      do, and that is the only thing that keeps the three artefacts in step.
 *   5. Add your payloads to the conformance corpus in `src/openapi.test.ts`,
 *      so the document's reading of your schema is checked by something that
 *      is not Zod.
 */
import * as z from 'zod';
import { Money } from './money-wire.ts';
import { Problem } from './problem.ts';

/**
 * Re-exported under its component name so the generated client can import
 * every `components/schemas` entry from one module. The generator emits
 * `schemas.<ComponentName>.parse(...)`, so a component whose name is not
 * exported here fails `pnpm -w typecheck` rather than at run time.
 */
export { Problem };

/**
 * The platform fee, as the server prices it. PROTOCOL §9.6: money never
 * crosses the wire FROM the client — this is server -> client only, and no
 * request body in this document carries money.
 */
export const PlatformFee = Money;

/**
 * SA §SEC-5 (line 2203): "minimum 12 characters, no composition rules".
 *
 * A CHARACTER is a Unicode code point. The pattern carries the `u` flag, so
 * `[\s\S]` matches one code point: an emoji outside the Basic Multilingual Plane
 * is one character, not two UTF-16 units. It is a `pattern` rather than
 * `.min(12)` on purpose. `.min` counts UTF-16 units and would accept six such
 * emoji, and a `.refine` never reaches the document (measured, T-141 progress
 * log). JSON Schema's `pattern` is ECMA-262 with Unicode semantics, so the
 * document and Zod count the same thing. Held by the `openapi.test.ts` corpus
 * cases *register: a 6-emoji password …* and *register: 11 ASCII + 1 astral
 * character …*.
 *
 * No maximum length: SA and SD state none. Fastify's default 1 MiB `bodyLimit`
 * is the only bound on a password's length.
 */
export const PASSWORD_MIN_CHARACTERS = 12;
const PASSWORD_PATTERN = new RegExp(`^[\\s\\S]{${String(PASSWORD_MIN_CHARACTERS)},}$`, 'u');

/** `@kinvara/domain-types`' ULID shape (`src/ids.ts`): 26 Crockford base32, upper case, first 0–7. */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * SD §BE-4 `POST /v1/auth/register`. Strict: an unknown key is refused.
 *
 * DEVIATION from SD §BE-4 (`state/EP-2/T-141.md` § Deviations): `password` is
 * REQUIRED. SD writes `password?` for a passwordless account; that flow, and the
 * `app_session.auth_method` it would carry, belong with the magic-link factor
 * (`T-027`).
 *
 * `turnstileToken` is required by shape and is NOT VERIFIED by any code (no
 * Turnstile adapter or stand-in exists at T-141). It is not a control yet.
 *
 * `email` is Zod 4.5.4's `z.email()`, an ASCII-only pattern: an internationalised
 * address is refused (corpus *register: an internationalised address*). Its
 * case is kept as sent; `account.email_ci` is `citext`.
 */
export const RegisterRequest = z.strictObject({
  email: z.email(),
  password: z.string().regex(PASSWORD_PATTERN),
  role: z.enum(['parent', 'sitter']),
  tosVersion: z.string().min(1),
  turnstileToken: z.string().min(1),
});

/** SD §BE-4: `201 {accountId}`. The session cookie travels in `Set-Cookie`, never in the body. */
export const RegisterResponse = z.strictObject({
  accountId: z.string().regex(ULID_PATTERN),
});

/**
 * Everything that becomes a `components/schemas` entry, by the name it gets
 * there. The generator emits these and nothing else, so a schema that is not
 * in this record is not in the document.
 */
export const COMPONENT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  Problem,
  PlatformFee,
  RegisterRequest,
  RegisterResponse,
};

export interface OperationResponse {
  readonly status: number;
  /** A key of COMPONENT_SCHEMAS. */
  readonly schema: string;
  readonly description: string;
}

export interface Operation {
  readonly operationId: string;
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly summary: string;
  /**
   * A key of COMPONENT_SCHEMAS: the operation's required `application/json`
   * request body. Absent when the operation takes no body.
   */
  readonly request?: string;
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
  {
    operationId: 'registerAccount',
    method: 'post',
    path: '/v1/auth/register',
    summary:
      'Create a parent or sitter account with a password and start its session (SD §BE-4). ' +
      'The session cookie `__Host-kv_session` is set on 201.',
    request: 'RegisterRequest',
    responses: [
      {
        status: 201,
        schema: 'RegisterResponse',
        description: 'Created, with `Set-Cookie: __Host-kv_session=…`.',
      },
      {
        status: 400,
        schema: 'Problem',
        description: '`invalid_input`: a malformed body, or a password under 12 characters.',
      },
      {
        status: 409,
        schema: 'Problem',
        description: '`email_in_use`. NOT enumeration-resistant (decisions.md OE-22 G1).',
      },
      {
        status: 422,
        schema: 'Problem',
        description:
          '`password_breached`: the HIBP range check found the password. ' +
          'HIBP unavailable fails OPEN (201), never 5xx (OE-22 G2).',
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
