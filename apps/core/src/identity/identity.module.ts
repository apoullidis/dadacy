/**
 * The identity module (`tech-lead`): account creation (T-141), login and logout (T-026).
 *
 * Providers are factories, so nothing reads the environment or connects when the module loads.
 * `Database` is `@kinvara/core-modules/runtime`'s (T-245): this module binds it to `core`'s source,
 * `DATABASE_URL` with `application_name = 'kinvara-core'`, through `DatabaseModule.forRoot`, and
 * exports it for any other `core` module. `Database` opens its pool on first use. `HibpChecker` reads `HIBP_API_BASE` once, here, and
 * refuses to check a password without it. The one HIBP breaker is `HIBP_BREAKER`, shared by every
 * caller in the process (T-142 § contract (rework 1) §8). `LoginService` takes the default argon2id
 * verifier, which logs one line per verify (`password.ts`). `configure` applies `ignoreRequestBody`
 * to `POST /v1/auth/logout` alone, so no request body can stop a logout (rework 1, QR-F1, OD-132).
 */
import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { createUpstreamCaller } from '@kinvara/integration-kit';
import { Database, DatabaseModule, decorateClass, type LogLine } from '@kinvara/core-modules/runtime';
import { AuthController, LOGOUT_PATH } from './auth.controller.ts';
import { HIBP_BREAKER, HibpChecker } from './hibp.ts';
import { LoginService } from './login.service.ts';
import { ignoreRequestBody } from './logout-body.middleware.ts';
import { RegisterController } from './register.controller.ts';
import { RegisterService } from './register.service.ts';
import { SessionService } from './session.service.ts';

/** `core`'s database principal and log sink. The source is read when Nest builds the provider. */
export const CORE_APPLICATION_NAME = 'kinvara-core';
const toStderr: LogLine = (line) => {
  process.stderr.write(`[core] ${line}\n`);
};
export const CORE_DATABASE = DatabaseModule.forRoot({
  useFactory: () => ({
    source: {
      connectionString: process.env['DATABASE_URL'],
      application_name: CORE_APPLICATION_NAME,
    },
    log: toStderr,
  }),
});

export class IdentityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ignoreRequestBody).forRoutes({ path: LOGOUT_PATH, method: RequestMethod.POST });
  }
}
decorateClass(
  IdentityModule,
  Module({
    imports: [CORE_DATABASE],
    controllers: [RegisterController, AuthController],
    providers: [
      {
        provide: HibpChecker,
        useFactory: () =>
          new HibpChecker({
            base: process.env['HIBP_API_BASE'],
            caller: createUpstreamCaller({ breaker: HIBP_BREAKER }),
          }),
      },
      {
        provide: RegisterService,
        useFactory: (db: Database, hibp: HibpChecker) => new RegisterService(db, hibp),
        inject: [Database, HibpChecker],
      },
      {
        provide: LoginService,
        useFactory: (db: Database) => new LoginService(db),
        inject: [Database],
      },
      {
        provide: SessionService,
        useFactory: (db: Database) => new SessionService(db),
        inject: [Database],
      },
    ],
    exports: [CORE_DATABASE],
  }),
);
