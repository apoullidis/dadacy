/**
 * `POST /v1/auth/login` and `POST /v1/auth/logout`: SD §BE-4 lines 1021 and 1029 (T-026).
 *
 * THE PATHS are read from `OPERATIONS` in `packages/contracts` (T-135 § contract §2's idiom), so the
 * served routes cannot drift from the published document by an edit to this file.
 *
 * VALIDATION (CONTRACTS.md carried row `T-135` item 1, OD-105). No Fastify route schema is declared.
 * The login body is validated here with the contract's Zod schema, `LoginRequest`, and a failure
 * throws `InvalidInputError` (400), so nothing reaches Fastify's `FST_ERR_VALIDATION` → 500 route.
 * A 400 depends on the body alone, never on whether an account exists, and it is not padded.
 *
 * `field` is set only to `email` or `password`. A key or a value the client chose never reaches it.
 *
 * THE COOKIE is set only after everything that can throw has run, so no error response carries a
 * session. Nothing here writes a response head itself (T-135 QR-A5). `Cache-Control: private,
 * no-store` travels with every response that sets or clears the cookie (SD line 4037; T-141 LIVE §4).
 *
 * LOGOUT answers 204 whether or not a live session was named, and clears the cookie with the
 * attributes it was set with, whatever body or content type arrives: `IdentityModule` applies
 * `ignoreRequestBody` to it, so no body reaches Fastify's parser (rework 1, QR-F1, OD-132). SD line
 * 1029's "purges SW cache via response header" is NOT built: no
 * header is named anywhere in SD or SA (decisions.md OD-129).
 *
 * DECORATORS are function calls (OE-27; `src/nest-decorate.ts`).
 */
import { Body, Controller, Headers as RequestHeader, HttpCode, Post, Res } from '@nestjs/common';
import {
  LoginRequest,
  LoginResponse,
  OPERATIONS,
  type LoginResponseBody,
} from '@kinvara/contracts';
import { InvalidInputError } from '@kinvara/domain-types';
import { decorateClass, decorateMethod, injectParams } from '../nest-decorate.ts';
import { LoginService } from './login.service.ts';
import { SessionService } from './session.service.ts';
import { sessionClearCookie, sessionSetCookie } from './session-token.ts';

function postPath(operationId: string): string {
  const operation = OPERATIONS.find((o) => o.operationId === operationId);
  if (operation === undefined || operation.method !== 'post') {
    throw new TypeError(
      `auth.controller: packages/contracts declares no POST ${operationId} operation`,
    );
  }
  return operation.path;
}

const LOGIN_PATH = postPath('login');
/** Exported for `IdentityModule`, which applies `ignoreRequestBody` to this route (QR-F1). */
export const LOGOUT_PATH = postPath('logout');

const FIELD_NAMES: ReadonlySet<string> = new Set(['email', 'password']);

const NO_STORE = 'private, no-store';

/** The part of Fastify's reply this controller uses. */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AuthController {
  readonly #login: LoginService;
  readonly #sessions: SessionService;

  constructor(login: LoginService, sessions: SessionService) {
    this.#login = login;
    this.#sessions = sessions;
  }

  async login(body: unknown, reply: HeaderReply): Promise<LoginResponseBody> {
    const parsed = LoginRequest.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.path[0];
      throw new InvalidInputError(
        typeof first === 'string' && FIELD_NAMES.has(first) ? { field: first } : {},
      );
    }
    const loggedIn = await this.#login.login(parsed.data.email, parsed.data.password);
    const answer = LoginResponse.parse({
      account: { id: loggedIn.accountId },
      roles: loggedIn.roles,
      stepUpRequired: loggedIn.stepUpRequired,
    });
    reply.header('cache-control', NO_STORE);
    reply.header('set-cookie', sessionSetCookie(loggedIn.session, loggedIn.maxAgeSeconds));
    return answer;
  }

  async logout(cookie: string | undefined, reply: HeaderReply): Promise<void> {
    await this.#sessions.logout(cookie);
    reply.header('cache-control', NO_STORE);
    reply.header('set-cookie', sessionClearCookie());
  }
}
decorateClass(AuthController, Controller());
decorateMethod(AuthController, 'login', Post(LOGIN_PATH), HttpCode(200));
Body()(AuthController.prototype, 'login', 0);
Res({ passthrough: true })(AuthController.prototype, 'login', 1);
decorateMethod(AuthController, 'logout', Post(LOGOUT_PATH), HttpCode(204));
RequestHeader('cookie')(AuthController.prototype, 'logout', 0);
Res({ passthrough: true })(AuthController.prototype, 'logout', 1);
injectParams(AuthController, [LoginService, SessionService]);
