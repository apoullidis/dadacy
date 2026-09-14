/**
 * NestJS's decorators, applied as FUNCTION CALLS instead of `@` syntax.
 *
 * WHY, measured on this repository (T-135 evidence, M1–M4), not preferred:
 *   - The repo has ONE typecheck program (`tsconfig.base.json`, T-001), and it
 *     uses STANDARD decorators. Nest 11's decorators are typed for the legacy
 *     `experimentalDecorators` form, so `@Get()` on a method is TS1241/TS1270.
 *   - `core` runs as TypeScript source under Node 24's type stripping, exactly
 *     as every workspace package does. Node cannot execute `@` syntax at all
 *     (`SyntaxError: Invalid or unexpected token`).
 *   - The alternative is a repo-wide compiler-semantics change to the shared
 *     base config PLUS a second compiler for emit, whose output nothing
 *     typechecks. Calling the decorator is the same function Nest's `@` form
 *     calls, with the same arguments, and it typechecks as written.
 *
 * HOW A MODULE USES IT — the whole idiom, next to the class it decorates:
 *
 *   export class SlotController {
 *     constructor(service: SlotService) { … }
 *     list(): SlotList { … }
 *   }
 *   decorateClass(SlotController, Controller());
 *   decorateMethod(SlotController, 'list', Get('/v1/slots'));
 *   injectParams(SlotController, [SlotService]);   // by position, explicitly
 *
 * ORDER. Stacked syntax `@A() @B() method` applies B first, then A. These
 * helpers apply their decorator list LAST-TO-FIRST, so the list reads in the
 * order the stacked form would be written.
 *
 * INJECTION IS EXPLICIT. `emitDecoratorMetadata` does not exist without a
 * compiler, so Nest has no `design:paramtypes` to read. Every constructor
 * dependency is named by `injectParams`, in parameter order. A class whose
 * constructor takes a dependency and has no `injectParams` call receives
 * `undefined` for it — Nest does not refuse that by itself.
 */
import 'reflect-metadata';
import { Inject, type InjectionToken } from '@nestjs/common';

type AnyClass = abstract new (...args: never[]) => unknown;

export function decorateClass(target: AnyClass, ...decorators: readonly ClassDecorator[]): void {
  for (const decorator of [...decorators].reverse()) {
    const replacement = decorator(target);
    if (replacement !== undefined && replacement !== target) {
      // `@` syntax would install a returned class; a function call cannot.
      throw new TypeError(
        `decorateClass: a decorator on ${target.name} returned a replacement class, ` +
          'which function-call application cannot install',
      );
    }
  }
}

export function decorateMethod<T extends object>(
  target: abstract new (...args: never[]) => T,
  method: keyof T & string,
  ...decorators: readonly MethodDecorator[]
): void {
  const prototype = target.prototype as object;
  for (const decorator of [...decorators].reverse()) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      throw new TypeError(`decorateMethod: ${target.name}.${method} is not an own method`);
    }
    const result = decorator(prototype, method, descriptor);
    if (result !== undefined) Object.defineProperty(prototype, method, result);
  }
}

export function injectParams(target: AnyClass, tokens: readonly InjectionToken[]): void {
  tokens.forEach((token, index) => {
    Inject(token)(target, undefined, index);
  });
}
