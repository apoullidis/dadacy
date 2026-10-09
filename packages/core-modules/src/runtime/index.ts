/**
 * `@kinvara/core-modules/runtime` — the shared NestJS runtime both `apps/core` and `apps/worker`
 * declare (T-245, OD-292a, EV-30). This file is the subpath's whole public surface: the package's
 * `exports` map names it, and nothing else under `src/runtime/`, so a deep import BY PACKAGE NAME
 * (`@kinvara/core-modules/src/…`) is refused by Node (`ERR_PACKAGE_PATH_NOT_EXPORTED`). A RELATIVE
 * path into this directory (`../../../packages/core-modules/src/runtime/…` from an app) bypasses
 * the `exports` map: it passes typecheck and `gate:deps` and loads in the image (T-245 QA-9). Do
 * not write one; nothing refuses it today.
 */
export {
  Database,
  DATABASE_LOG,
  DATABASE_SHUT_DOWN,
  DATABASE_URL_REFUSED,
  DatabaseShutDownError,
  type DatabaseSource,
  type LogLine,
  type Tx,
} from './database.ts';
export {
  DatabaseModule,
  type DatabaseBinding,
  type DatabaseModuleOptions,
} from './database.module.ts';
export { errorClass, type ErrorClass } from './error-class.ts';
export { decorateClass, decorateMethod, injectParams } from './nest-decorate.ts';
