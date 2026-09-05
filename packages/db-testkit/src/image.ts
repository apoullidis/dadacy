/**
 * THE pinned Postgres image for every Testcontainers constraint suite.
 *
 * `DOCKER.md` §1: "Pin the same Postgres image tag in all of them.
 * `platform-infrastructure` publishes it once (`T-016`); nothing else declares
 * it." This constant is not a second declaration — it is a *consumer* of that
 * one, and `pnpm gate:constraint-suite` fails if it has drifted from
 * `docker/compose.yml`'s `postgres` service. The check parses the YAML; this
 * file is TypeScript. Two readings, two files: the check cannot agree with the
 * thing it checks by sharing a mistake with it (PROTOCOL §5.1).
 *
 * OD-10: this is `kinvara/postgres:18-3.6-kinvara1`, NOT `postgis/postgis:18-3.6`.
 * `T-017` § Published contract §2 supersedes `T-016` §4 on this point. The
 * stock image provisions a **libc** database with an empty
 * `shared_preload_libraries` and four undeclared extensions, and `0001`'s
 * §Section 0 preflight correctly refuses it — so a suite pinned to the stock
 * tag would run against the exact database the schema will not install into.
 */

/** The tag, verbatim. Compared against `docker/compose.yml` by the gate. */
export const POSTGRES_IMAGE = 'kinvara/postgres:18-3.6-kinvara1';

/**
 * The base image and digest the pinned image is built `FROM`
 * (`docker/postgres.Dockerfile`, `T-017` § Published contract §2). Recorded
 * here so a reader of this package can see the provenance without opening
 * three other files; the gate asserts it against the Dockerfile's `FROM`.
 */
export const POSTGRES_BASE_IMAGE =
  'postgis/postgis:18-3.6@sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677';

/**
 * The tag family a constraint suite must NOT be pinned to. Derived from OD-10
 * rather than from either artefact, so it stays true even if `compose.yml` and
 * this file drift together — the failure mode PROTOCOL §5.1 calls "a check
 * derived from the same reading as the thing it checks".
 */
export const FORBIDDEN_IMAGE_PREFIX = 'postgis/postgis:';

/**
 * Postgres 18 images keep the cluster in a major-version subdirectory so that
 * `pg_upgrade --link` does not cross a mount boundary
 * (docker-library/postgres#1259). Mounting the pre-18 path makes the container
 * **exit 1**. Measured by `T-016`; carried to `T-115` in `CONTRACTS.md`.
 */
export const PGDATA_MOUNTPOINT = '/var/lib/postgresql';

/** `mem_limit`/`cpus` for a harness cluster — the `db` profile's budget, `DOCKER.md` §3. */
export const CLUSTER_MEMORY_BYTES = 512 * 1024 * 1024;
export const CLUSTER_NANO_CPUS = 1_000_000_000;
