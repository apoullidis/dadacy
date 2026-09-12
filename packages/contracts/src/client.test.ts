/**
 * The generated typed client, exercised against an injected `fetch`.
 *
 * No service runs for this: `T-022` declares `svc: none`. The client's HTTP
 * behaviour is exercised with a stub `fetch` returning real `Response`
 * objects. That is deliberately NOT a claim that the endpoint works against a
 * containerised `core` — there is no `core` yet, and PROTOCOL §5.2's "HTTP
 * endpoint" row will apply to the first ticket that scaffolds one.
 *
 * OD-57: no gate runs this file.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { decodeMinorUnits } from './money-wire.ts';
import { TYPE_BASE } from './problem.ts';
import { ProblemResponseError, createClient } from './generated/client.ts';

const BASE_URL = 'https://api.kinvara.test';
const CANARY = 'T022-CANARY-cert-CY-0042-99199123456';

function stubFetch(body: unknown, status: number, contentType: string): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } }),
    );
}

test('the generated client returns a parsed PlatformFee, and the amount decodes to an exact bigint', () => {
  const client = createClient({
    baseUrl: BASE_URL,
    fetch: stubFetch({ currency: 'EUR', amountMinor: '9007199254740993' }, 200, 'application/json'),
  });
  return client.getPlatformFee().then((fee) => {
    assert.equal(fee.currency, 'EUR');
    assert.equal(fee.amountMinor, '9007199254740993');
    // The wire string survives a magnitude a JSON number would have corrupted.
    assert.equal(decodeMinorUnits(fee.amountMinor, 'amountMinor'), 9007199254740993n);
  });
});

test('a problem+json response becomes a ProblemResponseError whose message is the code and which carries no input', () => {
  const client = createClient({
    baseUrl: BASE_URL,
    fetch: stubFetch(
      {
        type: `${TYPE_BASE}rate_limited`,
        title: 'Too many requests',
        status: 429,
        code: 'rate_limited',
        retryable: true,
        // An SD §BE-15 extension carrying something sensitive. It must reach
        // `.problem` for a caller that wants it, and NOT the message or stack,
        // which are what get logged (PROTOCOL §9.2).
        offendingValue: CANARY,
      },
      429,
      'application/problem+json',
    ),
  });
  return client.getPlatformFee().then(
    () => {
      assert.fail('the client resolved on a 429');
    },
    (error: unknown) => {
      assert.ok(error instanceof ProblemResponseError);
      assert.equal(error.message, 'rate_limited');
      assert.equal(error.problem.code, 'rate_limited');
      assert.equal(error.problem.retryable, true);
      assert.equal(error.message.includes(CANARY), false);
      assert.equal(String(error.stack).includes(CANARY), false);
    },
  );
});

test('the client refuses a malformed money value from the server rather than passing it to the caller', () => {
  // The server is not trusted to honour the contract: a float where a
  // decimal-integer string belongs is refused at the boundary by the Zod
  // schema the generated client parses with.
  const client = createClient({
    baseUrl: BASE_URL,
    fetch: stubFetch({ currency: 'EUR', amountMinor: 50.42 }, 200, 'application/json'),
  });
  return client.getPlatformFee().then(
    () => {
      assert.fail('the client accepted a float amount');
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ProblemResponseError, false);
    },
  );
});

test('the client refuses an error body whose code is not a member of the closed enum', () => {
  const client = createClient({
    baseUrl: BASE_URL,
    fetch: stubFetch(
      {
        type: `${TYPE_BASE}papadopoulou`,
        title: 'Conflict',
        status: 409,
        code: 'papadopoulou',
        retryable: false,
      },
      409,
      'application/problem+json',
    ),
  });
  return client.getPlatformFee().then(
    () => {
      assert.fail('the client resolved on a 409');
    },
    (error: unknown) => {
      // Not a ProblemResponseError: the body failed the Problem schema, so the
      // client raises the parse failure rather than presenting a forged code
      // as though the server had used a real one.
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ProblemResponseError, false);
    },
  );
});
