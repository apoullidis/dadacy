/**
 * `errorClass` (moved from apps/core by T-245): the fixed vocabulary, by `instanceof` and `typeof`
 * only. Expected classes are written here as literals, not read from the function.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { InvalidInputError } from '@kinvara/domain-types';
import { errorClass } from './index.ts';

test('each kind of thrown value maps to its fixed class name, most specific first', () => {
  const cases: [unknown, string][] = [
    [new InvalidInputError(), 'DomainError'],
    [new ForbiddenException(), 'HttpException'],
    [new TypeError('x'), 'TypeError'],
    [new RangeError('x'), 'RangeError'],
    [new SyntaxError('x'), 'SyntaxError'],
    [new Error('x'), 'Error'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'object'],
    ['a string', 'string'],
    [1, 'number'],
    [1n, 'bigint'],
    [true, 'boolean'],
    [Symbol('s'), 'symbol'],
    [() => 0, 'function'],
  ];
  assert.deepEqual(
    cases.map(([value]) => errorClass(value)),
    cases.map(([, expected]) => expected),
  );
});

test('a value whose prototype lookup throws is unclassifiable, and nothing of it is read', () => {
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('SENTINEL-T245-proxy');
      },
    },
  );
  assert.equal(errorClass(hostile), 'unclassifiable');
});
