# ADR 0002 — The password-hashing library for account creation

- **Status:** proposed. The in-image execution this decision depends on is not yet shown (§ Consequences).
- **Date:** 2026-09-14
- **Ticket:** T-141 (tech-lead)
- **Refs:** SA §TS-7 (line 800: _"built on an audited open-source library (Better Auth or equivalent)"_; line 816: _"we implement no cryptographic primitives ourselves (argon2id, WebAuthn via `@simplewebauthn`, CSPRNG tokens from the library)"_); SA §SEC-5 (line 2203: _"argon2id (m=64MB, t=3, p=1); minimum 12 characters"_); SD §DB-2 (lines 1759–1821); SD §DH-1 (line 4318); `decisions.md` OD-51, OD-117; `state/EP-2/T-141.md`

## Context

`POST /v1/auth/register` must store an argon2id hash at SA §SEC-5's parameters. SA §TS-7 wants authentication built on an audited open-source library and no cryptographic primitive written by us. By the time T-141 started, the identity schema already existed as migration `0005` (`account`, `account_role`, `app_session`, SD §DB-2). The session model was fixed there too: a `token_hash` column holding a SHA-256 of an opaque cookie.

Two repository constraints shape the choice, and each was measured on this branch or read from a committed file:

| Constraint                                                                                                                                                                                                       | Source                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| pnpm 11 refuses an install that leaves a dependency build script undecided, and the decision lives in `pnpm-workspace.yaml` (`allowBuilds`). OD-51 asks that file to stay unchanged unless a change is justified | `app/pnpm-workspace.yaml` comment (T-138); `decisions.md` OD-51 |
| The image's `prod-deps` stage installs with `--ignore-scripts`, on Alpine (musl), while the toolbox is glibc                                                                                                     | `app/docker/app.Dockerfile` lines 68, 146                       |

## Options considered

| Option                              | What was established                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Verdict                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Better Auth** (named by SA §TS-7) | A reading, not a measurement: it is a whole authentication framework with its own user, session and account data model. Adopting it for register would mean either a second identity schema beside `0005` or an adapter mapping its model onto SD §DB-2's tables, sessions included. Neither was built or measured here                                                                                                                                                                                                                                                                                                                                | Not adopted for T-141. SA §TS-7 allows "or equivalent", and SA line 816 names the parts it wants from a library: argon2id, WebAuthn, CSPRNG tokens |
| **`argon2`** (node-argon2) 0.45.1   | `pnpm view argon2 scripts`: `"install": "cross-env ZERO_AR_DATE=1 node-gyp-build"`. An install script means an `allowBuilds` decision in `pnpm-workspace.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not adopted: it needs a workspace-file change, and `prod-deps --ignore-scripts` would skip the script                                              |
| **`@node-rs/argon2`** 2.2.1         | `pnpm view`: no install script, and the native code arrives as per-platform `optionalDependencies`, including `@node-rs/argon2-linux-x64-gnu` and `-linux-x64-musl`. Publish times: 2.2.1 at 2026-09-10T06:03:49Z, musl binary at 05:50:15Z, gnu binary at 05:49:38Z, all outside pnpm's 24 h release-age window on 2026-09-14. `scripts/dev pnpm install --no-frozen-lockfile` exited 0 with `✓ Lockfile passes supply-chain policies`, and `git diff --exit-code pnpm-workspace.yaml` exited 0. The lockfile carries both the gnu and musl binaries; the toolbox installed gnu only. Its package description reads "argon2-rust binding for Node.js" | **Adopted**                                                                                                                                        |

## Decision

1. **`@node-rs/argon2` at exactly `2.2.1`** is `apps/core`'s password hasher, called only from `apps/core/src/identity/password.ts`.
2. **Parameters:** `memoryCost: 65536` (KiB), `timeCost: 3`, `parallelism: 1`, algorithm argon2id, version 0x13. The stored PHC string reads `$argon2id$v=19$m=65536,t=3,p=1$…`, and `hashPassword` refuses any output without that prefix.
3. **"m=64MB" is read as 64 MiB = 65536 KiB,** the unit argon2's `m` and the PHC string use. The other reading, 64,000,000 bytes, would be m=62500. This is an interpretation, recorded here so a reviewer can overturn it.
4. **The remaining primitives come from `node:crypto`,** not from an authentication library: the session cookie's 256 random bits (`randomBytes`), its SHA-256 digest, and the SHA-1 prefix sent to the HIBP range API. None of them is implemented here.
5. **Where it lives:** the identity module. SD §DH-1 (line 4318) gives `packages/crypto` only `sealFor`/`openFor` and the KMS boundary, so password hashing is not a `packages/crypto` change.

## What is not established

- **"Audited" is UNVERIFIED for every option, the adopted one included.** No audit report for `@node-rs/argon2`, for the Rust argon2 implementation it binds, for `argon2` or for Better Auth was read for this ADR. SA §TS-7's third-party penetration test of the auth surface, a launch gate, remains the stated control.
- Better Auth's data model was not measured against `0005`. Its rejection rests on SA §TS-7's "or equivalent" and on `0005` existing, not on a failed integration.
- The time one hash takes at these parameters on production hardware. The ticket evidence records what the toolbox measured.

## Consequences

- **The native binding in the shipped image is not yet shown.** Alpine selects the musl binary, and T-141 requires one argon2id execution inside the built `core` image. On `main` `59a7952` that image cannot be built with any database dependency (`decisions.md` OD-117), so that check waits on OD-117's fix. Until it passes, this ADR stays **proposed**.
- A bump of `@node-rs/argon2` is a dependency change under OD-51's release-age rule, with the in-image execution re-run.
- The login ticket (`T-026`) verifies with the same library, and must keep the absent-account dummy verify at these same parameters (OE-22 G4/G5).
