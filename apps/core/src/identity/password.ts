/**
 * Password hashing and verification: SA §SEC-5 (line 2203), "argon2id (m=64MB, t=3, p=1)".
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
 *
 * VERIFYING (T-026). Login verifies through `createPasswordVerifier`, the only argon2id verify in
 * `core`. It writes one fixed log line per verify, carrying the `m`, `t` and `p` read from the PHC
 * string being verified and nothing else, so the count and the parameters can be read from the
 * containerised process (OE-22 G4/G5). `isStoredPasswordHash` admits only the PHC form
 * `hashPassword` writes, so every string login verifies costs SA §SEC-5's parameters.
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import type { LogLine } from './database.ts';

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

// ---- T-026: verification ------------------------------------------------------------------------

/**
 * Exactly what `hashPassword` stores: the SA §SEC-5 prefix, a 22-character salt and a 43-character
 * hash (ADR 0002 § Consequences measured both lengths in the image).
 */
const STORED_PHC = new RegExp(
  `^${EXPECTED_PREFIX.replace(/[$]/g, '\\$')}[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$`,
);

/** True only for a string of the form `hashPassword` writes. Anything else is never verified. */
export function isStoredPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && STORED_PHC.test(value);
}

/**
 * THE DUMMY HASH (OE-22 G4/G5). An argon2id PHC string at SA §SEC-5's parameters, of 32 random bytes
 * generated once in the toolbox and printed nowhere (state/EP-2/T-026.md, progress log). Login
 * verifies the submitted password against it whenever there is no stored hash to verify, so that
 * path costs one argon2id run at the same parameters as any other. Nobody knows a password that
 * verifies against it, and login refuses the dummy path whatever `verify` returns.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$V1RCx8InZy6+NMw8NJBVZA$UX0onV3XpgkKwTAG5B/a6Mdd6yN6oTnoyMh1PPlexKU';

if (!isStoredPasswordHash(DUMMY_PASSWORD_HASH)) {
  throw new TypeError('identity: DUMMY_PASSWORD_HASH is not argon2id at SA SEC-5 parameters');
}

/** `(encoded, password) → verified`. Injected by tests; `createPasswordVerifier` in `core`. */
export type PasswordVerifier = (encoded: string, password: string) => Promise<boolean>;

/** Each verify logs `<VERIFY_LOG> m=<m>,t=<t>,p=<p>`, read from the PHC string it verifies. */
export const VERIFY_LOG = 'identity: login argon2id verify';

const PHC_PARAMETERS = /^\$argon2id\$v=\d+\$(m=\d+,t=\d+,p=\d+)\$/;

const toStderr: LogLine = (line) => {
  process.stderr.write(`[core] ${line}\n`);
};

/**
 * The argon2id verify login uses. The log line is written AFTER the verify resolves, so one line is
 * one completed verify, and a verify that throws writes none (T-026 rework 1, QR-A1). It carries no
 * password, hash, salt, email or account id.
 */
export function createPasswordVerifier(log: LogLine = toStderr): PasswordVerifier {
  return async (encoded, password) => {
    const parameters = PHC_PARAMETERS.exec(encoded)?.[1] ?? 'unparsed';
    const verified = await verify(encoded, password);
    log(`${VERIFY_LOG} ${parameters}`);
    return verified;
  };
}
