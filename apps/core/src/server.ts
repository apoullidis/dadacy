/**
 * Bootstrap and lifecycle. `main.ts` calls `startServer` with the root module;
 * `test/fixtures/fault-server.ts` calls it with a module that adds throwing
 * routes, so the filter and the drain under test are this code, not a copy.
 *
 * THE LIFECYCLE CONTRACT (`docker/app-runtime/entrypoint.mjs`, T-034 § contract
 * §6): on SIGTERM stop accepting new connections, let in-flight requests
 * finish, exit 0 inside the 30 s `stop_grace_period`; a second signal exits 1.
 *
 * Nest's own `enableShutdownHooks()` is deliberately NOT used: after closing,
 * it re-raises the signal against its own process, so the process dies BY
 * SIGTERM (143) and the entrypoint reports 143, where the contract says 0.
 *
 * `/healthz` is the image HEALTHCHECK's route (`docker/app-runtime/
 * healthcheck.mjs` requires a 200 there), registered on the Fastify instance
 * rather than as a Nest controller: it is a runtime-contract route, not part
 * of the API document, and it can never reach the filter.
 */
import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { errorClass } from './problem-json/error-class.ts';
import { ProblemJsonFilter } from './problem-json/problem-json.filter.ts';

export interface ServerOptions {
  readonly module: Type;
  readonly port: number;
  readonly host: string;
}

const say = (line: string): void => {
  process.stderr.write(`[core] ${line}\n`);
};

export async function createApp(module: Type): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(module, new FastifyAdapter(), {
    abortOnError: false,
  });
  app.useGlobalFilters(new ProblemJsonFilter());
  app
    .getHttpAdapter()
    .getInstance()
    .get('/healthz', async () => ({
      status: 'ok',
      app: 'core',
      mode: 'real',
      pid: process.pid,
      uid: process.getuid?.() ?? null,
      node: process.version,
    }));
  return app;
}

/**
 * Must be called BEFORE `listen`: it adds a Fastify hook.
 *
 * Why the hook (measured, T-135 evidence): Fastify's `close()` closes IDLE
 * keep-alive sockets once, when it starts. A socket that is busy at that moment
 * becomes idle only after its response, and then stays open for Fastify's
 * 72 s keep-alive — so the in-flight request completed, a new connection was
 * refused, and the process was still alive 12 s later. Once draining, every
 * response carries `Connection: close`, so Node ends that socket after the
 * response and `close()` resolves.
 */
export function installDrain(app: NestFastifyApplication): void {
  let draining = false;
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (_request, reply, payload) => {
      if (draining) void reply.header('connection', 'close');
      return payload;
    });
  const onSignal = (signal: NodeJS.Signals): void => {
    if (draining) {
      say(`second ${signal}: abandoning the drain, exiting 1`);
      process.exit(1);
    }
    draining = true;
    say(`${signal}: refusing new connections, draining in-flight requests`);
    app.close().then(
      () => {
        say('drained, exiting 0');
        process.exit(0);
      },
      (thrown: unknown) => {
        say(`drain failed class=${errorClass(thrown)}, exiting 1`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

export async function startServer(options: ServerOptions): Promise<NestFastifyApplication> {
  const app = await createApp(options.module);
  installDrain(app);
  await app.listen(options.port, options.host);
  const address: unknown = app.getHttpServer().address();
  const port =
    typeof address === 'object' && address !== null && 'port' in address
      ? String(address.port)
      : String(options.port);
  say(`listening on ${options.host}:${port}`);
  return app;
}
