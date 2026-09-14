/**
 * The root module. A module's controllers and providers are added here (or in
 * a feature module imported here). No policy and no audit yet; those are later
 * tickets. `IdentityModule` (T-141) brings the first database access.
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module.ts';
import { MetaController } from './meta/meta.controller.ts';
import { PLATFORM_FEE_SOURCE, SCAFFOLD_PLATFORM_FEE_SOURCE } from './meta/platform-fee.source.ts';
import { decorateClass } from './nest-decorate.ts';

export class AppModule {}
decorateClass(
  AppModule,
  Module({
    imports: [IdentityModule],
    controllers: [MetaController],
    providers: [{ provide: PLATFORM_FEE_SOURCE, useValue: SCAFFOLD_PLATFORM_FEE_SOURCE }],
  }),
);
