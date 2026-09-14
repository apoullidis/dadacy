/**
 * TEST-ONLY throwing routes, mounted by `fault-server.ts` on top of the real
 * `AppModule`, with the real filter and the real drain (`src/server.ts`).
 * Nothing under `test/` is imported by `src/`, so none of this is served by the
 * image. The sentinel is read from `KINVARA_T135_SENTINEL`, set by the test.
 */
import { Controller, Get, Module, Post } from '@nestjs/common';
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
}
decorateClass(FaultController, Controller('fault'));
decorateMethod(FaultController, 'domain', Get('domain'));
decorateMethod(FaultController, 'proxy', Get('proxy'));
decorateMethod(FaultController, 'extensions', Get('extensions'));
decorateMethod(FaultController, 'plain', Get('plain'));
decorateMethod(FaultController, 'nonError', Get('non-error'));
decorateMethod(FaultController, 'echo', Post('echo'));
decorateMethod(FaultController, 'slow', Get('slow'));

export class FaultModule {}
decorateClass(FaultModule, Module({ imports: [AppModule], controllers: [FaultController] }));
