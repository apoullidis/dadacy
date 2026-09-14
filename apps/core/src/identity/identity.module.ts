/**
 * The identity module (`tech-lead`): at T-141, account creation only.
 *
 * Providers are factories, so nothing reads the environment or connects when the module loads.
 * `Database` opens its pool on first use. `HibpChecker` reads `HIBP_API_BASE` once, here, and
 * refuses to check a password without it. The one HIBP breaker is `HIBP_BREAKER`, shared by every
 * caller in the process (T-142 § contract (rework 1) §8).
 */
import { Module } from '@nestjs/common';
import { createUpstreamCaller } from '@kinvara/integration-kit';
import { decorateClass } from '../nest-decorate.ts';
import { Database } from './database.ts';
import { HIBP_BREAKER, HibpChecker } from './hibp.ts';
import { RegisterController } from './register.controller.ts';
import { RegisterService } from './register.service.ts';

export class IdentityModule {}
decorateClass(
  IdentityModule,
  Module({
    controllers: [RegisterController],
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
    ],
  }),
);
