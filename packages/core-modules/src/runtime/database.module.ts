/**
 * `DatabaseModule` — how an app binds the package's `Database` to ITS OWN connection source
 * (T-245, OD-292a). The package never reads the environment; the app's factory does:
 *
 *   apps/core    DatabaseModule.forRoot({
 *                  useFactory: () => ({ source: { connectionString: process.env['DATABASE_URL'],
 *                                                 application_name: 'kinvara-core' }, log }),
 *                })
 *   apps/worker  DatabaseModule.forRoot({
 *                  imports: [WorkerRuntimeModule],
 *                  inject: [CONNECTION_SETTINGS, WORKER_LOG],
 *                  useFactory: (settings, log) => ({ source: { ...settings, max: 2 }, log }),
 *                })
 *
 * `forRoot` returns a dynamic module that provides and exports `Database`. An app calls it ONCE,
 * in one module of its own, and every other module that needs `Database` imports that module
 * (`apps/core`: `IdentityModule`; `apps/worker`: `WorkerDatabaseModule`). Two calls make two
 * `Database`s, i.e. two pools.
 *
 * Providers are factories with an explicit `inject` list, as everywhere in this repository: under
 * Node's type stripping there is no `design:paramtypes` (./nest-decorate.ts). A token named in
 * `inject` that no module in `imports` provides is refused by Nest at boot.
 *
 * `Database.onApplicationShutdown` ends the pool when the app's context closes.
 */
import { Module, type DynamicModule, type InjectionToken, type ModuleMetadata } from '@nestjs/common';
import { Database, type DatabaseSource, type LogLine } from './database.ts';

/** What an app's factory returns: where to connect, and where `Database` writes its log lines. */
export interface DatabaseBinding {
  readonly source: DatabaseSource;
  readonly log: LogLine;
}

export interface DatabaseModuleOptions {
  /** Modules exporting the tokens `inject` names. */
  readonly imports?: NonNullable<ModuleMetadata['imports']>;
  readonly inject?: readonly InjectionToken[];
  /**
   * Called with what `inject` resolves to, in order. Nest cannot type that link; `never[]` accepts
   * a factory of any parameter list without `any`.
   */
  readonly useFactory: (...injected: never[]) => DatabaseBinding;
}

/** The token of the app's binding inside the dynamic module; not exported from the package. */
const DATABASE_BINDING = Symbol('kinvara.core-modules.database-binding');

export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: DATABASE_BINDING,
          useFactory: options.useFactory,
          inject: [...(options.inject ?? [])],
        },
        {
          provide: Database,
          useFactory: (binding: DatabaseBinding) => new Database(binding.source, binding.log),
          inject: [DATABASE_BINDING],
        },
      ],
      exports: [Database],
    };
  }
}
Module({})(DatabaseModule);
