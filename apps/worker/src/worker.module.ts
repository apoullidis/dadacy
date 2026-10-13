/**
 * The worker's root module (T-242, OE-79). src/main.ts boots it with
 * `NestFactory.createApplicationContext` — an application context, NOT an application: no HTTP
 * adapter is created, so nothing listens (`T-034`: a worker has no port). A queue's ticket adds
 * its module to `imports` (src/selftest.handler.ts states the pattern).
 */
import { Module } from '@nestjs/common';
import { AvailabilityModule } from './availability.handler.ts';
import { WorkerRuntimeModule } from './runtime.module.ts';
import { SelftestModule } from './selftest.handler.ts';

export class WorkerModule {}
Module({
  imports: [WorkerRuntimeModule, SelftestModule, AvailabilityModule],
})(WorkerModule);
