/**
 * `POST /v1/auth/register`: SD §BE-4 as ruled by decisions.md OE-22.
 *
 * THE PATH is read from `OPERATIONS` in `packages/contracts` (T-135 § contract §2's idiom), so the
 * served route cannot drift from the published document by an edit to this file.
 *
 * VALIDATION (CONTRACTS.md carried row `T-135` item 1, OD-105). No Fastify route schema is
 * declared. The body is validated here with the contract's own Zod schema, `RegisterRequest`, and
 * a failure throws `InvalidInputError` (400). So a schema failure never reaches Fastify's
 * `FST_ERR_VALIDATION` → 500 route. Held by `test/register.container.test.ts` › *a body that is
 * not the contract …*.
 *
 * THE PROBLEM BODY'S `field` is set only to one of the five property names below. A key or a value
 * the client chose never reaches it.
 *
 * THE COOKIE is set only after everything that can throw has run, so no error response carries a
 * session. Nothing here writes a response head itself (T-135 QR-A5).
 *
 * DECORATORS are function calls (OE-27; `src/nest-decorate.ts`). Nest's parameter decorators are
 * called with the prototype, method name and index, exactly as `@Body()` would call them.
 */
import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import {
  OPERATIONS,
  RegisterRequest,
  RegisterResponse,
  type RegisterResponseBody,
} from '@kinvara/contracts';
import { InvalidInputError } from '@kinvara/domain-types';
import { decorateClass, decorateMethod, injectParams } from '../nest-decorate.ts';
import { RegisterService } from './register.service.ts';
import { sessionSetCookie } from './session-token.ts';

const operation = OPERATIONS.find((o) => o.operationId === 'registerAccount');
if (operation === undefined || operation.method !== 'post') {
  throw new TypeError(
    'register.controller: packages/contracts declares no POST registerAccount operation',
  );
}

const FIELD_NAMES: ReadonlySet<string> = new Set([
  'email',
  'password',
  'role',
  'tosVersion',
  'turnstileToken',
]);

/** The part of Fastify's reply this controller uses. */
interface CookieReply {
  header(name: string, value: string): unknown;
}

export class RegisterController {
  readonly #service: RegisterService;

  constructor(service: RegisterService) {
    this.#service = service;
  }

  async register(body: unknown, reply: CookieReply): Promise<RegisterResponseBody> {
    const parsed = RegisterRequest.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.path[0];
      throw new InvalidInputError(
        typeof first === 'string' && FIELD_NAMES.has(first) ? { field: first } : {},
      );
    }
    const registered = await this.#service.register({
      email: parsed.data.email,
      password: parsed.data.password,
      role: parsed.data.role,
      tosVersion: parsed.data.tosVersion,
    });
    const created = RegisterResponse.parse({ accountId: registered.accountId });
    reply.header('set-cookie', sessionSetCookie(registered.session));
    return created;
  }
}
decorateClass(RegisterController, Controller());
decorateMethod(RegisterController, 'register', Post(operation.path), HttpCode(201));
Body()(RegisterController.prototype, 'register', 0);
Res({ passthrough: true })(RegisterController.prototype, 'register', 1);
injectParams(RegisterController, [RegisterService]);
