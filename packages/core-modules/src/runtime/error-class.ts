/**
 * The ONLY description of a caught value an app writes to a log (moved from `apps/core` by T-245;
 * `core` and `worker` both load it from `@kinvara/core-modules/runtime`).
 *
 * `HttpException` is matched against the ONE `@nestjs/common` an app loads: the package and the
 * app resolve the same physical copy (T-245 evidence), so an exception thrown by the app's Nest is
 * an instance of the class imported here.
 *
 * A caught error's `message`, `stack`, `code`, `title`, `field` and `cause` can
 * each carry a request input (T-023 § contract §6 and §8, QR-R6: a Proxy that
 * breaks `code`'s invariant makes `toProblem` throw a TypeError whose message
 * IS the input). So nothing here reads any property of the value: the answer
 * is chosen from a fixed vocabulary by `instanceof` against constructors this
 * process owns, and `typeof`. A value that makes `instanceof` itself throw (a
 * Proxy's `getPrototypeOf` trap, T-023 G14) is `unclassifiable`.
 */
import { HttpException } from '@nestjs/common';
import { DomainError } from '@kinvara/domain-types';

export type ErrorClass =
  | 'DomainError'
  | 'HttpException'
  | 'TypeError'
  | 'RangeError'
  | 'SyntaxError'
  | 'Error'
  | 'null'
  | 'undefined'
  | 'object'
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'symbol'
  | 'function'
  | 'unclassifiable';

export function errorClass(value: unknown): ErrorClass {
  try {
    if (value instanceof DomainError) return 'DomainError';
    if (value instanceof HttpException) return 'HttpException';
    if (value instanceof TypeError) return 'TypeError';
    if (value instanceof RangeError) return 'RangeError';
    if (value instanceof SyntaxError) return 'SyntaxError';
    if (value instanceof Error) return 'Error';
    return value === null ? 'null' : typeof value;
  } catch {
    return 'unclassifiable';
  }
}
