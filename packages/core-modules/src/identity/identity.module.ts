/**
 * `IdentitySharedModule` — identity's providers that more than one deployable loads (T-246,
 * EV-30), with NO controllers. Each app imports it through `forRoot`, naming the module that
 * provides ITS `Database` (the package never binds a connection; T-245 `DatabaseModule`):
 *
 *   apps/core    IdentityModule imports IdentitySharedModule.forRoot({ database: CORE_DATABASE })
 *                and adds its controllers and the `ignoreRequestBody` middleware itself;
 *   apps/worker  a handler's module imports IdentitySharedModule.forRoot({ database: WorkerDatabaseModule })
 *
 * It provides and exports `AccountContacts` (./contact.ts). It adds no `Database` of its own:
 * `database` is imported, not created, so an app keeps exactly the one pool its own `forRoot` call
 * makes. `register`, `login`, `password` and `hibp` stay in `apps/core` (they load `@node-rs/argon2`
 * and the HIBP caller, which the worker image must not carry).
 *
 * Providers are factories with an explicit `inject` list (no `design:paramtypes` under type
 * stripping; ../runtime/nest-decorate.ts).
 */
import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { Database } from '../runtime/index.ts';
import { AccountContacts } from './contact.ts';

type ModuleImport = NonNullable<ModuleMetadata['imports']>[number];

export interface IdentitySharedModuleOptions {
  /** The app's module that provides and exports `Database`. */
  readonly database: ModuleImport;
}

export class IdentitySharedModule {
  static forRoot(options: IdentitySharedModuleOptions): DynamicModule {
    return {
      module: IdentitySharedModule,
      imports: [options.database],
      providers: [
        {
          provide: AccountContacts,
          useFactory: (db: Database) => new AccountContacts(db),
          inject: [Database],
        },
      ],
      exports: [AccountContacts],
    };
  }
}
Module({})(IdentitySharedModule);
