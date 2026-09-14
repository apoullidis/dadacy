/**
 * Bootstrap and lifecycle. `main.ts` calls `startServer` with the root module;
 * `test/fixtures/fault-server.ts` calls it with a module that adds throwing
 * routes, so the filter, the process handlers and the drain under test are
 * this code, not a copy.
 *
 * THE LIFECYCLE CONTRACT (`docker/app-runtime/entrypoint.mjs`, T-034 § contract
 * §6): on SIGTERM stop accepting new connections, let in-flight requests
 * finish, exit 0 inside the 30 s `stop_grace_period`; a second signal exits 1.
 *
 * Nest's own `enableShutdownHooks()` is deliberately NOT used. A READING, not a
 * measurement: `@nestjs/core` 11.2.3 `nest-application-context.js:213` calls
 * `process.kill(process.pid, signal)` after closing, i.e. re-raises the signal
 * against its own process, where the contract asks for exit 0.
 *
 * IN THE IMAGE THIS DRAIN DOES NOT RUN TODAY (decisions.md OD-100, measured in
 * T-135 § E10/E11): `entrypoint.mjs` forwards SIGTERM to `node --run start`,
 * which exits 143 without forwarding it, so this process is never signalled.
 * The drain is proven in-process only (`test/filter.test.ts`). OD-100 is T-151's.
 *
 * `/healthz` is the image HEALTHCHECK's route (`docker/app-runtime/
 * healthcheck.mjs` requires a 200 there), registered on the Fastify instance
 * rather than as a Nest controller: it is a runtime-contract route, not part
 * of the API document, and its handler does not throw.
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

/** Each process-level line is `[core] <marker> class=<errorClass>`, and nothing else. */
export const PROCESS_MARKERS = Object.freeze({
  unhandledRejection: 'process: an unhandled promise rejection; the process continues',
  uncaughtException: 'process: an uncaught exception; exiting 1',
});

let processHandlersInstalled = false;

/**
 * QA-A1. Without these, Node prints a rejection's or an exception's message and
 * stack to stderr — a request input, when a module rejects with one — and exits 1.
 * Both handlers log a fixed marker and `errorClass()` only (PROTOCOL §9.2).
 *
 * THE EXIT CHOICE:
 *   - an unhandled REJECTION does not exit: the promise is detached from any
 *     request, and exiting would drop every in-flight request on the process
 *     for a fire-and-forget bug (and in the image nothing drains, OD-100);
 *   - an uncaught EXCEPTION exits 1 at once, without draining: after one,
 *     Node's own guidance is that process state is undefined, so no further
 *     request is served on it.
 */
export function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason: unknown) => {
    say(`${PROCESS_MARKERS.unhandledRejection} class=${errorClass(reason)}`);
  });
  process.on('uncaughtException', (thrown: unknown) => {
    say(`${PROCESS_MARKERS.uncaughtException} class=${errorClass(thrown)}`);
    process.exit(1);
  });
}

export async function createApp(module: Type): Promise<NestFastifyApplication> {
  const filter = new ProblemJsonFilter();
  // OD-102: without `frameworkErrors`, Fastify's router answers a path it cannot
  // decode ITSELF, with the raw path in its body, before Nest or any filter runs.
  // The parameters are `unknown`: the adapter's constructor type is a union, so they
  // are not contextually typed, and `fastify` is not a direct dependency of this app.
  const adapter = new FastifyAdapter({
    frameworkErrors: (error: unknown, _request: unknown, reply: unknown) => {
      filter.answerFrameworkError(error, reply);
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, {
    abortOnError: false,
  });
  app.useGlobalFilters(filter);
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
  installProcessHandlers();
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
