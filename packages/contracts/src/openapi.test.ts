/**
 * THE CONFORMANCE SUITE — the part of this package that is not Zod checking
 * Zod (PROTOCOL §5.1).
 *
 * `openapi.json` is generated FROM the Zod schemas. So a test that validated
 * payloads with Zod and then declared the document correct would be asking one
 * implementation whether it agrees with itself, and a generator that
 * mistranslated a schema would sail through. Every test below reads the
 * DOCUMENT from disk and validates against it with `json-schema-check.ts`,
 * which shares no code with Zod.
 *
 * WHAT WOULD STILL FOOL BOTH: a corpus with no case that distinguishes them.
 * Agreement is exactly as wide as the payloads below, which are written by
 * hand. The corpus asserts its own size and that it contains verdicts in both
 * directions, so it cannot silently shrink — but "the corpus covers
 * everything that matters" is NOT claimed.
 *
 * OD-57: no gate runs this file. `gate:contract-drift` proves the committed
 * artefacts match a fresh generation; it does NOT prove the generation is
 * right, and these tests are what speak to that.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from './error-codes.ts';
import { COMPONENT_SCHEMAS, OPERATIONS } from './endpoints.ts';
import { TYPE_BASE, isWireProblem } from './problem.ts';
import { validate, type SchemaRoot } from './json-schema-check.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = readFileSync(join(PKG, 'openapi.json'), 'utf8');
const DOC = JSON.parse(RAW) as SchemaRoot & Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The document's verdict on a payload, reached without Zod. */
function documentAccepts(payload: unknown, schemaName: string): boolean {
  return validate(payload, { $ref: `#/components/schemas/${schemaName}` }, DOC).length === 0;
}

const VALID_PROBLEM = {
  type: `${TYPE_BASE}not_found`,
  title: 'Not found',
  status: 404,
  code: 'not_found',
  retryable: false,
};

/** T-141. SD §BE-4's register body, well formed. */
const VALID_REGISTER = {
  email: 'parent@example.cy',
  password: 'correct-horse-battery',
  role: 'parent',
  tosVersion: 'tos-2026-09',
  turnstileToken: 'turnstile-test-token',
};
/** One code point outside the Basic Multilingual Plane: two UTF-16 units, one character. */
const ASTRAL = '\u{1F600}';

/**
 * Every case: a payload, the component it is checked against, and the verdict
 * BOTH readings must reach. The expected column is written by hand, so a case
 * on which Zod and the document agree but are both wrong is still caught.
 */
const CORPUS: {
  name: string;
  schema: 'PlatformFee' | 'Problem' | 'RegisterRequest' | 'RegisterResponse';
  payload: unknown;
  valid: boolean;
}[] = [
  {
    name: 'a well-formed fee',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: '5042' },
    valid: true,
  },
  {
    name: 'zero',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: '0' },
    valid: true,
  },
  {
    name: 'a negative amount',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: '-250' },
    valid: true,
  },
  {
    name: 'beyond 2^53, as a string',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: '9007199254740993' },
    valid: true,
  },
  {
    name: 'a bare number amount',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: 5042 },
    valid: false,
  },
  {
    name: 'a float amount',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: 50.42 },
    valid: false,
  },
  {
    name: 'a decimal string amount',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: '50.42' },
    valid: false,
  },
  {
    name: 'a leading zero',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: '007' },
    valid: false,
  },
  {
    name: 'the wrong currency',
    schema: 'PlatformFee',
    payload: { currency: 'USD', amountMinor: '5042' },
    valid: false,
  },
  { name: 'a missing amount', schema: 'PlatformFee', payload: { currency: 'EUR' }, valid: false },
  {
    name: 'an extra key',
    schema: 'PlatformFee',
    payload: { currency: 'EUR', amountMinor: '5042', note: 'x' },
    valid: false,
  },
  { name: 'not an object', schema: 'PlatformFee', payload: '5042', valid: false },

  { name: 'a well-formed problem', schema: 'Problem', payload: VALID_PROBLEM, valid: true },
  {
    name: 'a problem with a field',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, field: 'address.postalCode' },
    valid: true,
  },
  {
    name: 'a problem with a BE-15 extension',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, tailMinutes: 60 },
    valid: true,
  },
  {
    name: 'a problem carrying detail',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, detail: 'anything' },
    valid: false,
  },
  {
    name: 'a problem carrying instance',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, instance: '/x' },
    valid: false,
  },
  {
    name: 'a code outside the enum',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, code: 'papadopoulou' },
    valid: false,
  },
  {
    name: 'a 200 status',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, status: 200 },
    valid: false,
  },
  {
    name: 'the superseded .co host',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, type: 'https://errors.kinvara.co/not_found' },
    valid: false,
  },
  {
    name: 'a value where the field name belongs',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, field: 'two words' },
    valid: false,
  },
  {
    name: 'an empty title',
    schema: 'Problem',
    payload: { ...VALID_PROBLEM, title: '' },
    valid: false,
  },
  {
    name: 'a missing retryable',
    schema: 'Problem',
    payload: { type: VALID_PROBLEM.type, title: 'x', status: 404, code: 'not_found' },
    valid: false,
  },

  // T-141: SD §BE-4 register. The verdicts are written by hand from SA §SEC-5 ("minimum 12
  // characters, no composition rules") and SD §BE-4's shape.
  {
    name: 'register: a well-formed parent',
    schema: 'RegisterRequest',
    payload: VALID_REGISTER,
    valid: true,
  },
  {
    name: 'register: a sitter',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, role: 'sitter' },
    valid: true,
  },
  {
    name: 'register: exactly 12 ASCII characters, no composition rule',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, password: 'aaaaaaaaaaaa' },
    valid: true,
  },
  {
    name: 'register: 11 ASCII characters',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, password: 'abcdefghijk' },
    valid: false,
  },
  {
    name: 'register: 12 Greek characters',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, password: 'αβγδεζηθικλμ' },
    valid: true,
  },
  {
    name: 'register: 11 ASCII + 1 astral character is 12 characters',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, password: `abcdefghijk${ASTRAL}` },
    valid: true,
  },
  {
    name: 'register: a 6-emoji password is 12 UTF-16 units but 6 characters',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, password: ASTRAL.repeat(6) },
    valid: false,
  },
  {
    name: 'register: a numeric password',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, password: 123456789012 },
    valid: false,
  },
  {
    name: 'register: role admin',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, role: 'admin' },
    valid: false,
  },
  {
    name: 'register: no turnstileToken',
    schema: 'RegisterRequest',
    payload: {
      email: VALID_REGISTER.email,
      password: VALID_REGISTER.password,
      role: VALID_REGISTER.role,
      tosVersion: VALID_REGISTER.tosVersion,
    },
    valid: false,
  },
  {
    name: 'register: an extra key',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, locale: 'el' },
    valid: false,
  },
  {
    name: 'register: an address with no @',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, email: 'parent.example.cy' },
    valid: false,
  },
  {
    name: 'register: an internationalised address',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, email: 'μαρία@παράδειγμα.cy' },
    valid: false,
  },
  {
    name: 'register: an empty tosVersion',
    schema: 'RegisterRequest',
    payload: { ...VALID_REGISTER, tosVersion: '' },
    valid: false,
  },
  {
    name: 'register response: a ULID account id',
    schema: 'RegisterResponse',
    payload: { accountId: '01J9ZQ6Y3M8K2V5T7R4N0P1B2C' },
    valid: true,
  },
  {
    name: 'register response: a lower-case account id',
    schema: 'RegisterResponse',
    payload: { accountId: '01j9zq6y3m8k2v5t7r4n0p1b2c' },
    valid: false,
  },
  {
    name: 'register response: an extra key',
    schema: 'RegisterResponse',
    payload: { accountId: '01J9ZQ6Y3M8K2V5T7R4N0P1B2C', email: 'parent@example.cy' },
    valid: false,
  },
];

/** The Zod-side verdict, like for like with the document's. */
function zodAccepts(payload: unknown, schemaName: string): boolean {
  if (schemaName === 'Problem') return isWireProblem(payload);
  const schema = COMPONENT_SCHEMAS[schemaName];
  if (schema === undefined) throw new TypeError(`the corpus names no component ${schemaName}`);
  return schema.safeParse(payload).success;
}

test('Zod and the generated document agree, payload by payload, on every case in the corpus', () => {
  const disagreements: string[] = [];
  for (const c of CORPUS) {
    const byZod = zodAccepts(c.payload, c.schema);
    const byDocument = documentAccepts(c.payload, c.schema);
    if (byZod !== c.valid || byDocument !== c.valid) {
      disagreements.push(
        `${c.schema}/${c.name}: expected ${String(c.valid)}, zod ${String(byZod)}, document ${String(byDocument)}`,
      );
    }
  }
  assert.deepEqual(disagreements, []);

  // Non-vacuity: a corpus that shrank, or that held only one verdict, would
  // make the loop above pass while proving nothing.
  assert.ok(CORPUS.length >= 20, `the corpus is down to ${String(CORPUS.length)} cases`);
  assert.ok(
    CORPUS.some((c) => c.valid),
    'no accepting case',
  );
  assert.ok(CORPUS.filter((c) => !c.valid).length >= 10, 'too few refusing cases');
});

test('every money field in the generated document is a pattern-constrained STRING, never a number or an integer', () => {
  // Walks the DOCUMENT, not the Zod. A generator that emitted `type: number`
  // for a MinorUnits field would be caught here and nowhere else.
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => {
        walk(n, `${path}[${String(i)}]`);
      });
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'amountMinor' && isRecord(child)) {
        found.push(`${path}.${key}`);
        assert.equal(child['type'], 'string', `${path}.${key} is ${String(child['type'])}`);
        assert.equal(typeof child['pattern'], 'string', `${path}.${key} has no pattern`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(DOC, '$');
  assert.ok(found.length >= 1, 'the document declares no money field at all');
});

test('the documents code enum is exactly the published ERROR_CODES, in order', () => {
  const schemas = DOC.components?.schemas ?? {};
  const problem: unknown = schemas['Problem'];
  assert.ok(isRecord(problem));
  const properties: unknown = problem['properties'];
  assert.ok(isRecord(properties));
  const code: unknown = properties['code'];
  assert.ok(isRecord(code));
  assert.deepEqual(code['enum'], [...ERROR_CODES]);
});

test('the document is OpenAPI 3.1 and declares exactly the operations OPERATIONS names', () => {
  assert.equal(DOC['openapi'], '3.1.1');
  const paths = DOC['paths'];
  assert.ok(isRecord(paths));
  assert.deepEqual(Object.keys(paths).sort(), [...new Set(OPERATIONS.map((o) => o.path))].sort());
  for (const op of OPERATIONS) {
    // The `: unknown` annotations are load-bearing, not decoration: without
    // them tsc reports TS7022 (a const whose inferred type is referenced by an
    // assertion predicate that narrows it is circular).
    const byMethod: unknown = paths[op.path];
    assert.ok(isRecord(byMethod), op.path);
    const operation: unknown = byMethod[op.method];
    assert.ok(isRecord(operation), `${op.path} ${op.method}`);
    assert.equal(operation['operationId'], op.operationId);
    const responses: unknown = operation['responses'];
    assert.ok(isRecord(responses));
    assert.deepEqual(
      Object.keys(responses).sort(),
      op.responses.map((r) => String(r.status)).sort(),
    );
  }
});

test('every operationId is unique and camelCase, and every response names a schema that exists', () => {
  const ids = OPERATIONS.map((o) => o.operationId);
  assert.equal(new Set(ids).size, ids.length, 'a duplicate operationId');
  const schemas = DOC.components?.schemas ?? {};
  for (const op of OPERATIONS) {
    assert.match(op.operationId, /^[a-z][A-Za-z0-9]*$/, op.operationId);
    assert.match(op.path, /^\/v1\//, op.path);
    for (const r of op.responses) {
      assert.ok(Object.hasOwn(schemas, r.schema), `${op.operationId}: no schema ${r.schema}`);
    }
  }
  assert.ok(OPERATIONS.length >= 1);
});

test('the validator refuses a schema keyword it does not model, rather than ignoring it', () => {
  // Fail closed. If a later Zod emitted `unevaluatedProperties`, this
  // validator must go red rather than quietly validating less than it thinks.
  assert.throws(
    () => validate({}, { type: 'object', unevaluatedProperties: false }, DOC),
    (e: unknown) => e instanceof TypeError && /does not model the keyword/.test(e.message),
  );
  // And the control: a schema it DOES model does not throw.
  assert.deepEqual(validate('x', { type: 'string' }, DOC), []);
});

test('an operation with a request body declares it as a required application/json $ref, and one without declares none', () => {
  const paths = DOC['paths'];
  assert.ok(isRecord(paths));
  const schemas = DOC.components?.schemas ?? {};
  let withBody = 0;
  for (const op of OPERATIONS) {
    const byMethod: unknown = paths[op.path];
    assert.ok(isRecord(byMethod), op.path);
    const operation: unknown = byMethod[op.method];
    assert.ok(isRecord(operation), `${op.path} ${op.method}`);
    const requestBody: unknown = operation['requestBody'];
    if (op.request === undefined) {
      assert.equal(requestBody, undefined, `${op.operationId} declares a body it does not take`);
      continue;
    }
    withBody++;
    assert.ok(Object.hasOwn(schemas, op.request), `${op.operationId}: no schema ${op.request}`);
    assert.deepEqual(requestBody, {
      required: true,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${op.request}` } } },
    });
  }
  assert.ok(withBody >= 1, 'no operation declares a request body');
});

test('registerAccount is SD BE-4 POST /v1/auth/register with 201 RegisterResponse and Problem on 400, 409, 422 and 500', () => {
  const op = OPERATIONS.find((o) => o.operationId === 'registerAccount');
  assert.ok(op, 'no registerAccount operation');
  assert.equal(op.method, 'post');
  assert.equal(op.path, '/v1/auth/register');
  assert.equal(op.request, 'RegisterRequest');
  assert.deepEqual(
    op.responses.map((r) => [r.status, r.schema]),
    [
      [201, 'RegisterResponse'],
      [400, 'Problem'],
      [409, 'Problem'],
      [422, 'Problem'],
      [500, 'Problem'],
    ],
  );
  // SD §BE-4's two error codes are members of the published enum the document carries.
  assert.ok(ERROR_CODES.includes('email_in_use'));
  assert.ok(ERROR_CODES.includes('password_breached'));
});
