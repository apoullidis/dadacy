# Kinvara — the pinned Postgres image.
#
# Built by `scripts/svc up <ticket> db` (compose builds it automatically when it
# is missing). Ticket: T-017. Owner: platform-infrastructure.
#
# ===========================================================================
# WHY THIS FILE EXISTS AT ALL
# ===========================================================================
#
# T-016 pinned `postgis/postgis:18-3.6` and used it directly. Four defects were
# then found against it by `tech-lead` and `qa-verification` while landing
# T-020's `0001` migration (decisions.md OD-5, OD-6, OD-7, OD-8). Three of the
# four are PROVISIONING defects — they cannot be repaired after the database
# exists — and the fourth is a missing binary that cannot be fetched at run
# time, because every service sits on `kinvara-int`, `internal: true`, and has
# no route off this host. All four therefore have to be fixed in an image.
#
# They are fixed TOGETHER on purpose. `0001` refuses a database that fails any
# one of them, so fixing three of four leaves the `db` profile exactly as
# unusable as fixing none — which is the state that forced T-020 and both of
# its reviewers to hand-provision.
#
#   OD-5  the collation. `--locale=C.UTF-8` alone selects the *libc* provider;
#         SD §DB-16 requires the ICU provider with the root locale `und`,
#         deterministic. `ALTER DATABASE` cannot change `datlocprovider`,
#         `datlocale` or `encoding` — DROP and CREATE is the only remedy — so
#         this is set at `initdb` time, below, and never afterwards.
#         It is the reason SA §DV-13 bans `ILIKE` outright: the Greek final
#         sigma INVERTS between the libc and ICU providers, and every English
#         test passes either way.
#
#   OD-6  `pg_partman` is not in the base image; `postgresql-18-partman` is a
#         separate PGDG package. SD §DH-1 first-ticket #3 names it among the
#         seven extensions `0001` installs.
#
#   OD-7  `shared_preload_libraries` was empty, so `CREATE EXTENSION
#         pg_stat_statements` SUCCEEDED and every read of the view then raised.
#         SD §DB-12's weekly review of statements over 50 ms on the request
#         path was dead, with nothing anywhere red.
#
#   OD-8  the base image's own `10_postgis.sh` auto-created four extensions
#         nobody declared in `POSTGRES_DB`, leaving 13 `PUBLIC`-readable
#         relations — ten of them in `tiger`/`topology`, which `0001` never
#         names and therefore never revokes. `0001`'s SA §INT-10 guard refused
#         the database over them, correctly.
#
# ===========================================================================
# BUILD-TIME EGRESS IS NOT RUN-TIME EGRESS
# ===========================================================================
#
# `apt-get` below runs during `docker build`, on the daemon's own default
# network — the same hole `docker/toolbox.Dockerfile` uses, and the same one
# `scripts/svc up` uses when it pulls images BEFORE attaching the internal
# network (DOCKER.md §7, last line). Nothing here gives the RUNNING container
# egress: it is attached to `kinvara-int` by compose.yml and to nothing else.
# That distinction is why OD-6 could not be fixed at run time and had to be
# fixed in a layer.

FROM postgis/postgis:18-3.6@sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677

# Pinned by exact Debian version, not by name. An unpinned `apt-get install`
# would silently change what every agent's evidence was produced against the
# next time this layer is rebuilt; a pin that goes missing from PGDG fails the
# build loudly, which is the direction this programme errs in.
ARG PARTMAN_DEB_VERSION=5.5.0-1.pgdg13+1

# --- OD-6 — pg_partman ------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "postgresql-18-partman=${PARTMAN_DEB_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    # Assert the two files that matter are actually here. `apt-get` exiting 0
    # is not evidence that the extension is loadable, and a missing control
    # file would not surface until a migration ran, weeks from now.
    test -f /usr/share/postgresql/18/extension/pg_partman.control; \
    test -f /usr/lib/postgresql/18/lib/pg_partman_bgw.so

# --- OD-5 — the ICU `und` deterministic collation, at initdb time -----------
#
# Baked into the IMAGE rather than into compose.yml on purpose. This value is
# unrepairable after first start, and T-115's Testcontainers harness starts
# this image without compose.yml anywhere in the picture. Setting it here means
# every consumer gets it, including one that has not read a contract.
# `--locale=C.UTF-8` still sets LC_CTYPE/LC_MESSAGES; the ICU pair sets the
# collation. Both are required together (T-020 § Published contract §1).
ENV POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale-provider=icu --icu-locale=und --locale=C.UTF-8"

# --- OD-7 — shared_preload_libraries ---------------------------------------
#
# Appended to the sample config that `initdb` copies, NOT set as a `command:`
# override in compose.yml. A `-c` flag on the command line is lost the moment
# anybody passes their own command; a line in postgresql.conf survives that,
# and it is also the form that maps one-to-one onto the RDS parameter group
# T-003/T-019 must declare, so compose and Terraform can be compared.
#
# `pg_partman` IS NOT A LIBRARY NAME AND NEVER WAS. The extension ships exactly
# one shared object, `pg_partman_bgw.so` (the background maintenance worker),
# and that is what the name in this list has to be. Naming the extension
# instead makes the server refuse to start — measured, in T-017's evidence,
# rather than assumed.
RUN set -eux; \
    printf '\n# Kinvara (T-017, OD-7). See docker/postgres.Dockerfile.\n' \
        >> /usr/share/postgresql/postgresql.conf.sample; \
    printf "shared_preload_libraries = 'pg_stat_statements,pg_partman_bgw'\n" \
        >> /usr/share/postgresql/postgresql.conf.sample; \
    grep -q "^shared_preload_libraries = 'pg_stat_statements,pg_partman_bgw'$" \
        /usr/share/postgresql/postgresql.conf.sample

# --- OD-8 — this image creates NOTHING at first start -----------------------
#
# A RULE, NOT A LIST. The base image ships `10_postgis.sh`, which creates
# `template_postgis` and four extensions in `POSTGRES_DB`. Deleting that one
# file by name would leave the next base-image revision free to add a second
# script and quietly reintroduce exactly this defect. So the directory is
# emptied wholesale and the emptiness is ASSERTED in the same layer: a base
# image that starts shipping another hook fails this build instead of silently
# provisioning objects `0001` never declared and therefore never revokes.
#
# The invariant this encodes: EVERYTHING IN THE DATABASE IS CREATED BY A FILE
# IN db/migrations. The PostGIS extension files are still installed — `0001`
# runs `CREATE EXTENSION postgis` itself — they are simply no longer created
# behind the migration's back.
RUN set -eux; \
    rm -rf /docker-entrypoint-initdb.d; \
    mkdir -p /docker-entrypoint-initdb.d; \
    test -z "$(ls -A /docker-entrypoint-initdb.d)"

LABEL io.kinvara.image="postgres" \
      io.kinvara.built-by="T-017" \
      io.kinvara.base="postgis/postgis:18-3.6" \
      io.kinvara.fixes="OD-5,OD-6,OD-7,OD-8"
