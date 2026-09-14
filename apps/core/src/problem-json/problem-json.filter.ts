/**
 * THE SINGLE problem+json EXCEPTION FILTER — SD §DH-2 ("domain errors are typed
 * classes mapped to problem+json by a single exception filter"), SD §BE-2
 * ("problem+json never echoes input"), OE-15 (host `errors.kinvara.cy`, no
 * `detail`/`instance`).
 *
 * It is registered once, globally, in `server.ts`, and it catches EVERYTHING
 * (`Catch()` with no argument). The routes into it, each a case in
 * `test/filter.test.ts` (T-135 evidence and rework 1):
 *   - a throw from a route handler, a guard, a pipe, or a Fastify hook;
 *   - an unmatched route: Nest throws `NotFoundException("Cannot GET <url>")`,
 *     whose MESSAGE IS THE REQUEST PATH;
 *   - a Fastify-level error (e.g. a malformed JSON body): Nest rethrows it as
 *     `HttpException(err.message, err.statusCode)`, whose message can quote
 *     the body;
 *   - a throw inside a Nest MIDDLEWARE: on Fastify, Nest hands this filter the
 *     RAW Node `ServerResponse`, not a Fastify reply (OD-103), so `#write`
 *     answers on either;
 *   - a request Fastify's ROUTER refuses before Nest sees it (an undecodable
 *     path, OD-102): `server.ts` passes Fastify's `frameworkErrors` option,
 *     which calls `answerFrameworkError` here.
 *
 * THE MAPPING, which is this module's contract:
 *   1. A `DomainError` goes to T-023's `toProblem(error, TYPE_BASE)`.
 *   2. An `HttpException` is framework-originated (modules throw DomainErrors,
 *      SD §DH-2), and its message is never read. Its STATUS picks a domain
 *      error from `FRAMEWORK_STATUS` where the closed set (T-022
 *      `ERROR_CODES`) has a code for that status; any other 4xx becomes
 *      `InvalidInputError` (400); anything else goes to `toProblem` as a
 *      non-domain value (500).
 *   3. Anything else goes to `toProblem`, which answers the 500
 *      `internal_error` body carrying nothing from the value.
 *
 * THE CARRIED OBLIGATION (CONTRACTS.md, "WHOEVER BUILDS THE NestJS problem+json
 * EXCEPTION FILTER"; T-023 §8 QR-R6; T-022 §8), discharged here:
 *   (1) the call to `toProblem` is WRAPPED — it can throw (a throwing
 *       `problemExtensions()`, a Proxy that breaks `code`'s invariant, a Proxy
 *       whose `instanceof` throws), and the thrown error's message and stack
 *       carry the input;
 *   (2) when it throws, the response is the FIXED 500 body below;
 *   (3) the caught error's message and stack are NEVER logged — only a fixed
 *       marker and `errorClass()`, which reads no property of the value.
 * Named tests, at the width they were measured (T-135 evidence N3, N3b):
 * `test/filter.test.ts` › *(ii) …* holds (2), and *the captured process output …*
 * holds (3) and detects (1)'s removal — by its marker counts ONLY. With the wrap
 * removed, the (ii) responses are STILL the fixed-500 body and the sentinel is
 * STILL absent from the log: Nest hands a filter's own throw to Fastify's error
 * handler, which runs this filter again on the thrown TypeError, a non-domain
 * value `toProblem` answers without throwing. So on this stack the wrap is
 * defence in depth; what it changes observably is the marker (`toProblemThrew`
 * instead of `internalError`).
 *
 * THE MARKERS say what the MAPPING chose, not that a response was delivered:
 * each is logged before `#write` runs (QA-A3). A failed write logs `writeFailed`
 * as well.
 *
 * ONE MORE BACKSTOP, beyond the obligation: `toProblem` emits a forged or
 * redefined error's `status`, `retryable` and `field` unvalidated (T-023 §6
 * OPEN (b), (d)). The body is checked with `isWireProblem` from
 * `packages/contracts` before it is written, and a body that is not a wire
 * Problem — or whose `status` disagrees with the response status — is replaced
 * by the fixed 500. That check does not see a forged `title` (the wire schema
 * accepts any non-empty string there); T-023 OPEN (d) stands for `title`.
 * This backstop is NOT planted in any test (no forged or redefined error is
 * thrown through the filter); it is a reading of the code above, nothing more.
 */
import { ServerResponse } from 'node:http';
import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { TYPE_BASE, isWireProblem } from '@kinvara/contracts';
import {
  InvalidInputError,
  NotFoundError,
  PolicyDeniedError,
  PreconditionFailedError,
  RateLimitedError,
  UnauthenticatedError,
  UpstreamUnavailableError,
  toProblem,
} from '@kinvara/domain-types';
import { decorateClass } from '../nest-decorate.ts';
import { errorClass } from './error-class.ts';

/** The response when anything goes wrong while building the response. Carries nothing. */
export const FIXED_500_BODY = Object.freeze({
  type: `${TYPE_BASE}internal_error`,
  title: 'Internal error',
  status: 500,
  code: 'internal_error',
  retryable: false,
});
const FIXED_500_JSON = JSON.stringify(FIXED_500_BODY);

/** Written on a raw `ServerResponse`; the same value Fastify produces for a string payload. */
const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** Every line this filter logs starts with one of these, followed by ` class=<errorClass>`. */
export const LOG_MARKERS = Object.freeze({
  toProblemThrew: 'problem-json: toProblem threw; mapped to the fixed 500',
  notWireProblem: 'problem-json: the mapped body is not a wire Problem; mapped to the fixed 500',
  internalError: 'problem-json: a non-domain throw; mapped to 500 internal_error',
  writeFailed: 'problem-json: writing the response failed',
});

/**
 * `PolicyDeniedError` requires a basis (T-023 §6). A framework 403 — what Nest throws
 * for any guard answering `false` — carries no ReBAC basis, so this fixed literal
 * stands in. It is kept on the error and never serialised by `toProblem`.
 */
export const FRAMEWORK_FORBIDDEN_BASIS = 'framework_forbidden';

/**
 * A framework status → the domain error whose closed code is THE code for that status
 * (T-022 `ERROR_CODES`; T-023 § contract §6's table). Only statuses with exactly one
 * such code are here. 409, 422 and 423 have only subclass codes (`slot_taken`,
 * `rate_below_floor`, `sitter_review_hold`, …), and 405/406/408/410/413/414/415 and
 * 502/504 have none, so none is invented: they fall to rule 2's 4xx/else branches.
 */
const FRAMEWORK_STATUS: ReadonlyMap<number, () => unknown> = new Map<number, () => unknown>([
  [400, () => new InvalidInputError()],
  [401, () => new UnauthenticatedError()],
  [403, () => new PolicyDeniedError({ basis: FRAMEWORK_FORBIDDEN_BASIS })],
  [404, () => new NotFoundError()],
  [412, () => new PreconditionFailedError()],
  [429, () => new RateLimitedError()],
  [503, () => new UpstreamUnavailableError()],
]);

/** The part of Fastify's reply this filter uses. Structural, so `fastify` is not a dependency. */
interface ReplyLike {
  readonly sent: boolean;
  code(status: number): ReplyLike;
  header(name: string, value: string): ReplyLike;
  send(payload: string): unknown;
}

export type LogLine = (line: string) => void;

const logger = new Logger('ProblemJsonFilter');

function fromFramework(exception: unknown): unknown {
  if (!(exception instanceof HttpException)) return exception;
  const status = exception.getStatus();
  const mapped = FRAMEWORK_STATUS.get(status);
  if (mapped !== undefined) return mapped();
  if (status >= 400 && status < 500) return new InvalidInputError();
  return exception;
}

/** A Fastify router error's `statusCode`, or 500. Nothing else of the value is read. */
function frameworkErrorStatus(error: unknown): number {
  try {
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const status = error.statusCode;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
        return status;
      }
    }
  } catch {
    // a getter that throws: fall through to 500
  }
  return 500;
}

export class ProblemJsonFilter implements ExceptionFilter {
  readonly #log: LogLine;

  constructor(log: LogLine = (line) => logger.error(line)) {
    this.#log = log;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    let response: unknown;
    try {
      response = host.switchToHttp().getResponse();
    } catch (thrown) {
      this.#log(`${LOG_MARKERS.writeFailed} class=${errorClass(thrown)}`);
      return;
    }
    this.answer(exception, response);
  }

  /**
   * Fastify's `frameworkErrors` hook (`server.ts`): a request its router refused
   * before any Nest handler ran. Only the error's status is used; its message
   * quotes the raw path (OD-102) and is never read.
   */
  answerFrameworkError(error: unknown, reply: unknown): void {
    this.answer(new HttpException('', frameworkErrorStatus(error)), reply);
  }

  /** Map `exception` and write it to `response`: a Fastify reply or a raw `ServerResponse`. */
  answer(exception: unknown, response: unknown): void {
    let status = 500;
    let payload = FIXED_500_JSON;
    try {
      // Everything that can throw is inside this block: the framework mapping
      // (`instanceof` on a Proxy), `toProblem`, the wire check and serialisation
      // (a forged extension holding a bigint makes JSON.stringify throw).
      const problem = toProblem(fromFramework(exception), TYPE_BASE);
      if (!isWireProblem(problem.body) || problem.body.status !== problem.status) {
        this.#log(`${LOG_MARKERS.notWireProblem} class=${errorClass(exception)}`);
      } else {
        payload = JSON.stringify(problem.body);
        status = problem.status;
        if (problem.body.code === 'internal_error') {
          this.#log(`${LOG_MARKERS.internalError} class=${errorClass(exception)}`);
        }
      }
    } catch (thrown) {
      status = 500;
      payload = FIXED_500_JSON;
      this.#log(`${LOG_MARKERS.toProblemThrew} class=${errorClass(thrown)}`);
    }
    this.#write(response, status, payload);
  }

  #write(response: unknown, status: number, payload: string): void {
    try {
      if (response instanceof ServerResponse) {
        // OD-103: a Nest middleware's throw arrives with the raw Node response.
        if (response.headersSent || response.writableEnded) return;
        response.statusCode = status;
        response.setHeader('content-type', PROBLEM_CONTENT_TYPE);
        response.setHeader('content-length', String(Buffer.byteLength(payload)));
        response.end(payload);
        return;
      }
      const reply = response as ReplyLike;
      if (reply.sent) return;
      reply.code(status).header('content-type', 'application/problem+json').send(payload);
    } catch (thrown) {
      this.#log(`${LOG_MARKERS.writeFailed} class=${errorClass(thrown)}`);
    }
  }
}
decorateClass(ProblemJsonFilter, Catch());
