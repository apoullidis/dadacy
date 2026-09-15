/**
 * Logout ignores its request body (T-026 rework 1; QR-F1, decisions.md OD-132). SD §BE-4 line 1029
 * gives `POST /v1/auth/logout` no request body, and logout must revoke and clear whatever arrives.
 *
 * WITHOUT THIS, Fastify's content-type parsing answered `400` before the handler ran, and the session
 * stayed live, for `Content-Type: application/json` with an empty or malformed body, for a media
 * type with no parser (`application/xml`), and for a body over the 1 MiB `bodyLimit` (QA Q2f S3d).
 *
 * THE MECHANISM, read from the installed code (Fastify 5.11.3, @nestjs/platform-fastify 11.2.3):
 *   - Nest runs a module's middleware through its bundled middie on Fastify's `onRequest` hook
 *     (`adapters/middie/fastify-middie.js`: `options.hook || 'onRequest'`), which runs before body
 *     parsing;
 *   - Fastify's `request.headers` returns the raw `IncomingMessage` headers object
 *     (`lib/request.js`);
 *   - `handleRequest` (`lib/handle-request.js`) calls the handler without parsing when a POST has
 *     no `content-type`, no `transfer-encoding` and no non-zero `content-length` (`isEmptyBody`).
 * So this middleware deletes those three request headers. `IdentityModule` applies it to
 * `POST /v1/auth/logout` alone. The cookie header is untouched.
 *
 * Held by the four `test/login.container.test.ts` cases *logout with … still revokes …*, each red
 * with this middleware not applied. What becomes of the unread body is Node's HTTP server's (it is
 * discarded after the response): a reading, not measured beyond the 2 MiB case.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function ignoreRequestBody(
  request: IncomingMessage,
  _response: ServerResponse,
  next: () => void,
): void {
  delete request.headers['content-type'];
  delete request.headers['content-length'];
  delete request.headers['transfer-encoding'];
  next();
}
