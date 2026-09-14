/**
 * TEST-ONLY throwing routes, mounted by `fault-server.ts` on top of the real
 * `AppModule`, with the real filter and the real drain (`src/server.ts`).
 * Nothing under `test/` is imported by `src/`, so none of this is SERVED by the
 * image. The files are nonetheless COPIED into it (QA-F3 / OD-104, deferred to
 * T-151). The sentinel is read from `KINVARA_T135_SENTINEL`, set by the test.
 */
import {
  BadGatewayException,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Module,
  Post,
  PreconditionFailedException,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConflictError, NotFoundError, type ProblemExtensions } from '@kinvara/domain-types';
import { AppModule } from '../../src/app.module.ts';
import { decorateClass, decorateMethod } from '../../src/nest-decorate.ts';

/** (i) A real DomainError whose extensions try every carve-out with the input. */
export class SlotTakenProbe extends ConflictError {
  readonly #input: string;
  constructor(input: string) {
    super('slot_taken', 'Slot taken', {});
    this.#input = input;
  }
  override problemExtensions(): ProblemExtensions {
    return {
      detail: this.#input,
      instance: this.#input,
      value: this.#input,
      nested: { value: this.#input },
    };
  }
}

/** (ii) T-023 G15: `problemExtensions()` throws, so `toProblem` throws with the input. */
export class ExtensionsThrowProbe extends ConflictError {
  readonly #input: string;
  constructor(input: string) {
    super('slot_taken', 'Slot taken', {});
    this.#input = input;
  }
  override problemExtensions(): ProblemExtensions {
    throw new Error(this.#input);
  }
}

/** (ii) T-023 D4a: every `code` read returns the input, which breaks the Proxy invariant. */
export function d4aProxy(input: string): NotFoundError {
  return new Proxy(new NotFoundError(), {
    get: (target, key, receiver) => (key === 'code' ? input : Reflect.get(target, key, receiver)),
  });
}

function sentinel(): string {
  const value = process.env['KINVARA_T135_SENTINEL'];
  if (value === undefined || value === '') {
    throw new TypeError('fault-server: KINVARA_T135_SENTINEL is not set');
  }
  return value;
}

export const SLOW_MS = 1500;

/** QA-A2: what Nest throws for any guard answering `false` is `ForbiddenException`. */
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/** QA-F2 / OD-103: on Fastify, Nest runs this with the RAW Node request and response. */
function throwingMiddleware(): void {
  throw new Error(sentinel());
}

/** QA-F2's control: the same error handed to `next`, which QA measured answered. */
function nextErrorMiddleware(_req: unknown, _res: unknown, next: (error?: unknown) => void): void {
  next(new Error(sentinel()));
}

export class FaultController {
  domain(): never {
    throw new SlotTakenProbe(sentinel());
  }
  proxy(): never {
    throw d4aProxy(sentinel());
  }
  extensions(): never {
    throw new ExtensionsThrowProbe(sentinel());
  }
  plain(): never {
    throw new Error(sentinel());
  }
  nonError(): never {
    throw { message: sentinel() };
  }
  echo(): { ok: true } {
    return { ok: true };
  }
  async slow(): Promise<{ slept: number }> {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return { slept: SLOW_MS };
  }
  // QA-A2: framework exceptions a guard, an auth layer or a limiter plausibly throws,
  // each carrying the input in its message.
  http401(): never {
    throw new UnauthorizedException(sentinel());
  }
  guarded(): { ok: true } {
    return { ok: true };
  }
  http412(): never {
    throw new PreconditionFailedException(sentinel());
  }
  http429(): never {
    throw new HttpException(sentinel(), 429);
  }
  http503(): never {
    throw new ServiceUnavailableException(sentinel());
  }
  http409(): never {
    throw new ConflictException(sentinel());
  }
  http502(): never {
    throw new BadGatewayException(sentinel());
  }
  // QA-F2: never reached; the middleware bound to these paths answers first.
  mwThrow(): { ok: true } {
    return { ok: true };
  }
  mwNext(): { ok: true } {
    return { ok: true };
  }
  // QA-A1: a fire-and-forget rejection, and a throw outside any request.
  unhandled(): { ok: true } {
    void Promise.reject(new Error(sentinel()));
    return { ok: true };
  }
  uncaught(): { ok: true } {
    setTimeout(() => {
      throw new Error(sentinel());
    }, 50);
    return { ok: true };
  }
}
decorateClass(FaultController, Controller('fault'));
decorateMethod(FaultController, 'domain', Get('domain'));
decorateMethod(FaultController, 'proxy', Get('proxy'));
decorateMethod(FaultController, 'extensions', Get('extensions'));
decorateMethod(FaultController, 'plain', Get('plain'));
decorateMethod(FaultController, 'nonError', Get('non-error'));
decorateMethod(FaultController, 'echo', Post('echo'));
decorateMethod(FaultController, 'slow', Get('slow'));
decorateMethod(FaultController, 'http401', Get('http401'));
decorateMethod(FaultController, 'guarded', Get('guarded'), UseGuards(new DenyGuard()));
decorateMethod(FaultController, 'http412', Get('http412'));
decorateMethod(FaultController, 'http429', Get('http429'));
decorateMethod(FaultController, 'http503', Get('http503'));
decorateMethod(FaultController, 'http409', Get('http409'));
decorateMethod(FaultController, 'http502', Get('http502'));
decorateMethod(FaultController, 'mwThrow', Get('mw-throw'));
decorateMethod(FaultController, 'mwNext', Get('mw-next'));
decorateMethod(FaultController, 'unhandled', Get('unhandled'));
decorateMethod(FaultController, 'uncaught', Get('uncaught'));

export class FaultModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(throwingMiddleware).forRoutes('fault/mw-throw');
    consumer.apply(nextErrorMiddleware).forRoutes('fault/mw-next');
  }
}
decorateClass(FaultModule, Module({ imports: [AppModule], controllers: [FaultController] }));
