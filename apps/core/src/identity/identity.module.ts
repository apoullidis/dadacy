/**
 * The identity module (`tech-lead`): account creation (T-141), login and logout (T-026).
 *
 * Providers are factories, so nothing reads the environment or connects when the module loads.
 * `Database` opens its pool on first use. `HibpChecker` reads `HIBP_API_BASE` once, here, and
 * refuses to check a password without it. The one HIBP breaker is `HIBP_BREAKER`, shared by every
 * caller in the process (T-142 § contract (rework 1) §8). `LoginService` takes the default argon2id
 * verifier, which logs one line per verify (`password.ts`). `configure` applies `ignoreRequestBody`
 * to `POST /v1/auth/logout` alone, so no request body can stop a logout (rework 1, QR-F1, OD-132).
 */
import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { createUpstreamCaller } from '@kinvara/integration-kit';
import { decorateClass } from '../nest-decorate.ts';
import { AuthController, LOGOUT_PATH } from './auth.controller.ts';
import { Database } from './database.ts';
import { HIBP_BREAKER, HibpChecker } from './hibp.ts';
import { LoginService } from './login.service.ts';
import { ignoreRequestBody } from './logout-body.middleware.ts';
import { RegisterController } from './register.controller.ts';
import { RegisterService } from './register.service.ts';
import { SessionService } from './session.service.ts';

export class IdentityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ignoreRequestBody).forRoutes({ path: LOGOUT_PATH, method: RequestMethod.POST });
  }
}
decorateClass(
  IdentityModule,
  Module({
    controllers: [RegisterController, AuthController],
    providers: [
      { provide: Database, useFactory: () => new Database(process.env['DATABASE_URL']) },
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
  }),
);
