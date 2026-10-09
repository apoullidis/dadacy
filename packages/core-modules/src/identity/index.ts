/**
 * `@kinvara/core-modules/identity` — identity's code that SD §BE-1 loads in more than one
 * deployable (T-246, EV-30; SD §BE-1 line 923: identity is "jobs only" in `worker`). This file is
 * the subpath's whole public surface. Import it BY PACKAGE NAME only: a deep import by name
 * (`@kinvara/core-modules/src/identity/…`) is refused by Node (`ERR_PACKAGE_PATH_NOT_EXPORTED`), but
 * a RELATIVE path into this directory from an app bypasses the `exports` map and nothing refuses it
 * (T-245 RW1-C §1 row 2, §5).
 */
export {
  AccountContacts,
  contactFromRows,
  findAccountContact,
  type AccountContact,
} from './contact.ts';
export {
  AccountNotFoundError,
  EmailInUseError,
  InvalidCredentialsError,
  PasswordBreachedError,
} from './errors.ts';
export { IdentitySharedModule, type IdentitySharedModuleOptions } from './identity.module.ts';
