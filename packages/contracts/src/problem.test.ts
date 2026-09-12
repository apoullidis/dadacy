/**
 * OE-15, the stakeholder ruling of 2026-09-11, checked against the artefact
 * that ships: the generated document.
 *
 * OD-57: no gate runs this file.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InvalidInputError,
  NotFoundError,
  PolicyDeniedError,
  RateLimitedError,
  UpstreamUnavailableError,
  toProblem,
  type DomainError,
} from '@kinvara/domain-types';
import { FORBIDDEN_MEMBERS, TYPE_BASE, hasNoForbiddenMembers, isWireProblem } from './problem.ts';
import { validate, type SchemaRoot } from './json-schema-check.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = JSON.parse(readFileSync(join(PKG, 'openapi.json'), 'utf8')) as SchemaRoot;
const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };
const CANARY = 'T022-CANARY-cert-CY-0042-99199123456';

test('OE-15: the generated Problem schema FORBIDS detail and instance, and a body carrying either is refused', () => {
  const base = {
    type: `${TYPE_BASE}not_found`,
    title: 'Not found',
    status: 404,
    code: 'not_found',
    retryable: false,
  };
  // The premise, asserted: without them the body is valid, so the refusals
  // below are caused by the member and not by something else in the body.
  assert.deepEqual(validate(base, PROBLEM_REF, DOC), []);

  for (const member of FORBIDDEN_MEMBERS) {
    const problems = validate({ ...base, [member]: CANARY }, PROBLEM_REF, DOC);
    assert.notDeepEqual(problems, [], `the document accepted a body carrying ${member}`);
    assert.equal(isWireProblem({ ...base, [member]: CANARY }), false, member);
  }
  // Both members are covered, and there are exactly the two OE-15 names.
  assert.deepEqual([...FORBIDDEN_MEMBERS], ['detail', 'instance']);
});

test('every problem body toProblem produces validates against the generated Problem schema, and a body with detail added does not', () => {
  const errors: DomainError[] = [
    new InvalidInputError({ field: 'startsAt' }),
    new NotFoundError(),
    new PolicyDeniedError({ basis: CANARY }),
    new RateLimitedError(),
    new UpstreamUnavailableError(),
  ];
  for (const error of errors) {
    const { body } = toProblem(error, TYPE_BASE);
    assert.deepEqual(
      validate(body, PROBLEM_REF, DOC),
      [],
      `${error.name}: ${JSON.stringify(body)}`,
    );
    assert.ok(hasNoForbiddenMembers(body as unknown as Record<string, unknown>), error.name);
    // PROTOCOL §9.2: nothing the caller supplied reaches the wire.
    assert.equal(JSON.stringify(body).includes(CANARY), false, error.name);

    // THE FALSIFIER. Without this half the test above would pass against a
    // schema that forbade nothing at all.
    const tampered = { ...(body as unknown as Record<string, unknown>), detail: CANARY };
    assert.notDeepEqual(validate(tampered, PROBLEM_REF, DOC), [], error.name);
  }
  assert.equal(errors.length, 5);
});

test('OE-15: the superseded errors.kinvara.co host appears nowhere in this package', () => {
  // SD §BE-2's `.co` spelling is superseded by §BE-15's `.cy`. A stray `.co`
  // would produce a `type` URI no client could resolve, and the schema's
  // startsWith check would refuse it at run time — but only if it were never
  // written in the first place, so this reads the source.
  assert.equal(TYPE_BASE, 'https://errors.kinvara.cy/');

  // SHIPPED SOURCE AND THE DOCUMENT, not the tests. `*.test.ts` is excluded
  // deliberately and the exclusion is the interesting part: two test files
  // carry `errors.kinvara.co` ON PURPOSE, as the payload a refusal case feeds
  // in (openapi.test.ts's corpus, and this file). Scanning them would make
  // this test fail for doing its job. The cost, stated: a `.co` written into
  // a test fixture and then relied on as though it were valid is NOT caught
  // here — the run-time `startsWith(TYPE_BASE)` check is what catches that.
  const files = [
    'openapi.json',
    join('src', 'generated', 'client.ts'),
    ...readdirSync(join(PKG, 'src'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join('src', f)),
  ];
  const offenders: string[] = [];
  for (const rel of files) {
    const text = readFileSync(join(PKG, rel), 'utf8');
    if (text.includes('errors.kinvara.co/') || text.includes('errors.kinvara.co"')) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
  // Non-vacuity: the reader must actually have read the shipped surface.
  assert.ok(files.length >= 7, `only ${String(files.length)} files read`);
  // And it must be capable of finding one: the same reader over a planted string.
  assert.equal('const t = "https://errors.kinvara.co/x";'.includes('errors.kinvara.co/'), true);
});

test('LIMITATION carried from T-023 QA-F6: a nested detail or instance inside an extension is still emitted, and this check does not see it', () => {
  // The strip and this check both go by exact TOP-LEVEL key name. A `detail`
  // one level down is emitted, and neither the document's `not` clause nor
  // `hasNoForbiddenMembers` refuses it. Review is the control for extensions.
  const nested = {
    type: `${TYPE_BASE}not_found`,
    title: 'Not found',
    status: 404,
    code: 'not_found',
    retryable: false,
    context: { detail: CANARY, instance: CANARY },
  };
  assert.equal(hasNoForbiddenMembers(nested), true);
  assert.deepEqual(validate(nested, PROBLEM_REF, DOC), []);
  assert.equal(isWireProblem(nested), true);
});
