/**
 * Password hashing: SA §SEC-5 (line 2203), "argon2id (m=64MB, t=3, p=1)".
 *
 * THE LIBRARY is `@node-rs/argon2` (docs/adr/0002-password-hashing-library.md). It is a binding to
 * an existing argon2 implementation, so no cryptographic primitive is implemented here (SA §TS-7,
 * line 816).
 *
 * UNITS. SA writes "m=64MB". argon2's `m` is in KiB, and this module reads 64MB as 64 MiB =
 * 65536 KiB, the unit the PHC string's `m=` carries. The reading is recorded in the ADR.
 *
 * WHERE THIS LIVES. SD §DH-1 (line 4318) gives `packages/crypto` exactly `sealFor`/`openFor` and
 * the KMS boundary. Password hashing belongs to the identity module, and this file is in it.
 */
import { hash, type Algorithm } from '@node-rs/argon2';

export const ARGON2ID_PARAMETERS = Object.freeze({
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});

/**
 * `Algorithm.Argon2id` is `2` in the package's `index.d.ts`. It is an ambient `const enum`, which
 * `isolatedModules` does not let this file reference, so the number is written here. The output's
 * PHC prefix is checked below, which refuses the hash if `2` ever meant another variant.
 */
const ARGON2ID = 2 as Algorithm;

/** PHC: `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`. */
const EXPECTED_PREFIX =
  `$argon2id$v=19$m=${String(ARGON2ID_PARAMETERS.memoryCost)},` +
  `t=${String(ARGON2ID_PARAMETERS.timeCost)},p=${String(ARGON2ID_PARAMETERS.parallelism)}$`;

/** Fixed text: a refusal never carries the password or the hash. */
export const HASH_REFUSED =
  'identity: the password hash is not argon2id at SA SEC-5 parameters, so it is not stored';

export async function hashPassword(password: string): Promise<string> {
  const encoded = await hash(password, { ...ARGON2ID_PARAMETERS, algorithm: ARGON2ID });
  if (!encoded.startsWith(EXPECTED_PREFIX)) throw new TypeError(HASH_REFUSED);
  return encoded;
}
