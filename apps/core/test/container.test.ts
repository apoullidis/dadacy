/**
 * Against the CONTAINERISED core — `scripts/svc up <ticket> api --verify --build`,
 * then `scripts/svc run <ticket> -- pnpm --filter @kinvara/core test:integration`,
 * which puts this process on the ticket's `kinvara-int` and injects
 * `CORE_BASE_URL=http://core:3000`. Without that variable every test here FAILS;
 * none skips.
 *
 * The expectations are anchored OUTSIDE core's own code (PROTOCOL §5.1):
 *   - the 200 body is judged by the committed `openapi.json`, read from disk and
 *     validated by `json-schema-check.ts` — not by the Zod schema core uses;
 *   - the problem body is a literal, written from OE-15 and T-023 §6's table;
 *   - "not the placeholder" is judged by a route ONLY the placeholder answers
 *     200 on (`docker/app-runtime/entrypoint.mjs`), not only by core's own
 *     /healthz claim.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClient,
  decodeMinorUnits,
  validateAgainstDocument,
  type SchemaRoot,
} from '@kinvara/contracts';

const SENTINEL = 'KINVARA-T135-SENTINEL-c0ntainer-7e2b';
const DOCUMENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'contracts',
  'openapi.json',
);

interface DocumentOperation {
  readonly operationId?: string;
  readonly responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
interface Document extends SchemaRoot {
  readonly paths: Record<string, Record<string, DocumentOperation>>;
}

function base(): string {
  const value = process.env['CORE_BASE_URL'];
  if (value === undefined || value === '') {
    throw new TypeError(
      'CORE_BASE_URL is not set: run under `scripts/svc run <ticket> --`, which injects http://core:3000',
    );
  }
  return value;
}

function readDocument(): Document {
  return JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8')) as Document;
}

function operation(doc: Document, operationId: string): { path: string; op: DocumentOperation } {
  for (const [path, methods] of Object.entries(doc.paths)) {
    const op = methods['get'];
    if (op?.operationId === operationId) return { path, op };
  }
  throw new TypeError(`the committed document declares no GET ${operationId}`);
}

test('GET platform-fee from the containerised core is 200 application/json and the body validates against the committed openapi.json', async () => {
  const doc = readDocument();
  const { path, op } = operation(doc, 'getPlatformFee');
  const schema = op.responses?.['200']?.content?.['application/json']?.schema;
  assert.notEqual(schema, undefined, 'the document names a 200 application/json schema');

  const res = await fetch(new URL(path, base()));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json\b/);
  const body: unknown = await res.json();

  assert.deepEqual(validateAgainstDocument(body, schema, doc), []);
  // The validator can refuse: the same body with a JSON number, and an empty object.
  const asNumber = { ...(body as Record<string, unknown>), amountMinor: 0 };
  assert.notDeepEqual(validateAgainstDocument(asNumber, schema, doc), []);
  assert.notDeepEqual(validateAgainstDocument({}, schema, doc), []);
});

test('the typed client generated from packages/contracts reads the same endpoint off the containerised core', async () => {
  const fee = await createClient({ baseUrl: base() }).getPlatformFee();
  assert.equal(fee.currency, 'EUR');
  assert.equal(typeof decodeMinorUnits(fee.amountMinor, 'amountMinor'), 'bigint');
});

test('the containerised core is not the runtime placeholder', async () => {
  const health = await fetch(new URL('/healthz', base()));
  assert.equal(health.status, 200);
  const payload = (await health.json()) as Record<string, unknown>;
  assert.equal(payload['app'], 'core');
  assert.equal(payload['mode'], 'real');

  // The placeholder answers 200 here; real core has no such route.
  const slow = await fetch(new URL('/__placeholder/slow?ms=1', base()));
  assert.equal(slow.status, 404);
  assert.match(slow.headers.get('content-type') ?? '', /^application\/problem\+json\b/);
});

test('refusal (i) in the container: an unmatched route throws NotFoundError and answers exactly the problem+json body, echoing nothing', async () => {
  const doc = readDocument();
  const res = await fetch(new URL(`/v1/${SENTINEL}`, base()));
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /^application\/problem\+json\b/);
  const text = await res.text();
  assert.equal(text.includes(SENTINEL), false, 'the path is not echoed');
  const body: unknown = JSON.parse(text);
  assert.deepEqual(body, {
    type: 'https://errors.kinvara.cy/not_found',
    title: 'Not found',
    status: 404,
    code: 'not_found',
    retryable: false,
  });

  const problemSchema = { $ref: '#/components/schemas/Problem' };
  assert.deepEqual(validateAgainstDocument(body, problemSchema, doc), []);
  // The document can refuse: the same body with `detail` added.
  const withDetail = { ...(body as Record<string, unknown>), detail: 'x' };
  assert.notDeepEqual(validateAgainstDocument(withDetail, problemSchema, doc), []);
});
