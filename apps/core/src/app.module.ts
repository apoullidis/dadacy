/**
 * The root module. A module's controllers and providers are added here (or in
 * a feature module imported here). No database, no policy, no audit — those
 * are later tickets (T-135 § Out).
 */
import { Module } from '@nestjs/common';
import { MetaController } from './meta/meta.controller.ts';
import { PLATFORM_FEE_SOURCE, SCAFFOLD_PLATFORM_FEE_SOURCE } from './meta/platform-fee.source.ts';
import { decorateClass } from './nest-decorate.ts';

export class AppModule {}
decorateClass(
  AppModule,
  Module({
    controllers: [MetaController],
    providers: [{ provide: PLATFORM_FEE_SOURCE, useValue: SCAFFOLD_PLATFORM_FEE_SOURCE }],
  }),
);
