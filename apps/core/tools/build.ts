/**
 * `pnpm --filter @kinvara/core build`.
 *
 * THERE IS NO EMIT STEP. `core` runs as TypeScript source under Node's type
 * stripping (see `src/nest-decorate.ts` for why, measured). So `build` does the
 * part of a build that can fail here: it loads the module graph under THIS
 * Node, applies every decorator, and has Nest resolve the dependency-injection
 * graph (controllers included), then closes. A non-erasable construct, an
 * unresolvable import or a missing provider fails it with exit 1.
 *
 * It runs in the image's `build` stage (`docker/app.Dockerfile`) as well as in
 * the toolbox. It proves nothing about the `runtime` stage's dependency closure,
 * which is `prod-deps`' and is observed only by the running container.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.ts';

const context = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
  abortOnError: false,
});
await context.close();
console.log('build: apps/core has no emit step; module graph loaded, DI graph resolved');
