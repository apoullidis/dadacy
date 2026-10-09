/**
 * The decorator helpers (moved from apps/core by T-245). What each refuses, the order it applies a
 * list in, and that `injectParams` writes the metadata Nest's own `@Inject` writes.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Inject } from '@nestjs/common';
import { decorateClass, decorateMethod, injectParams } from './index.ts';

test('decorateClass applies its list last-to-first, as stacked @ syntax would', () => {
  const order: string[] = [];
  class Target {}
  const mark =
    (name: string): ClassDecorator =>
    () => {
      order.push(name);
    };
  decorateClass(Target, mark('A'), mark('B'));
  assert.deepEqual(order, ['B', 'A']);
});

test('decorateClass refuses a decorator that returns a replacement class', () => {
  class Target {}
  const replace: ClassDecorator = () => class Replacement {} as never;
  assert.throws(() => decorateClass(Target, replace), /returned a replacement class/);
});

test('decorateMethod applies its list last-to-first and installs a returned descriptor', () => {
  const order: string[] = [];
  class Target {
    run(): string {
      return 'original';
    }
  }
  const mark =
    (name: string): MethodDecorator =>
    () => {
      order.push(name);
    };
  const swap = ((_t: object, _k: string | symbol, d: PropertyDescriptor) => ({
    ...d,
    value: () => 'swapped',
  })) as MethodDecorator;
  decorateMethod(Target, 'run', mark('A'), swap, mark('C'));
  assert.deepEqual(order, ['C', 'A']);
  assert.equal(new Target().run(), 'swapped');
});

test('decorateMethod refuses a name that is not an own method', () => {
  class Base {
    inherited(): void {}
  }
  class Target extends Base {
    field = 1;
  }
  // The check runs per decorator applied, so each call passes one.
  const noop: MethodDecorator = () => undefined;
  assert.throws(() => decorateMethod(Target, 'inherited', noop), /is not an own method/);
  assert.throws(() => decorateMethod(Target, 'field', noop), /is not an own method/);
});

test('injectParams writes the same constructor metadata as Nest @Inject, by position', () => {
  const A = Symbol('A');
  const B = Symbol('B');
  class ByHelper {}
  class ByNest {}
  injectParams(ByHelper, [A, B]);
  Inject(A)(ByNest, undefined, 0);
  Inject(B)(ByNest, undefined, 1);
  const keys = Reflect.getMetadataKeys(ByNest);
  assert.ok(keys.length > 0, 'Nest @Inject wrote metadata');
  for (const key of keys) {
    assert.deepEqual(Reflect.getMetadata(key, ByHelper), Reflect.getMetadata(key, ByNest));
  }
});
