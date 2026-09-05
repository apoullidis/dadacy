# syntax=docker/dockerfile:1
#
# docker/app.Dockerfile — the image every Kinvara application service is built
# from (T-018). ONE file, parameterised by `ARG APP`, for core / worker /
# safety-gw / web / admin.
#
# =============================================================================
# WHY ONE FILE AND NOT FIVE
# =============================================================================
# T-016's placeholder suggested `docker/<service>.Dockerfile`. Five files would
# today be five byte-identical copies distinguished only by a name, and OD-1 is
# precisely the cost of writing one fact down in several places: the pin loop
# enumerated four tools by hand, `.tool-versions` grew two more, and an agent
# ran a stale binary while believing the pin. Five Dockerfiles would drift the
# same way and the drift would show up as "the image on my machine is
# different", months later.
#
# The stages below are also all five apps genuinely have in common today —
# apps/* are T-001 topology placeholders with no src/, no dependencies and no
# scripts. WHEN THAT CHANGES: a Next.js app that needs a `standalone` runtime
# adds a TARGET here (`--target next-runtime`) and compose.verify.yml names it
# for that service. Splitting the file is also fine. What is not fine is
# copying it and letting the copies drift.
#
# =============================================================================
# THE NODE VERSION IS NOT WRITTEN DOWN HERE
# =============================================================================
# `ARG NODE_VERSION` has NO DEFAULT, so a build that does not supply it fails
# at the FROM line rather than quietly picking one. `scripts/svc up --verify`
# derives it from .tool-versions (the single source of truth, DOCKER.md §4.2)
# and passes it through compose. `gate:app-images` asserts all three halves:
# no default here, a build arg in compose.verify.yml, and the value coming from
# .tool-versions.
#
# It matters more than it looks. The toolbox typechecks and tests against one
# Node; if the image ran a different one, every "it passed in the toolbox"
# result would be about a runtime nobody ships.
#
# =============================================================================
# NON-ROOT, AND WHY THE UID IS 10001 RATHER THAN THE IMAGE'S OWN `node` USER
# =============================================================================
# The official node images ship a `node` user at uid 1000 — the same uid the
# toolbox runs as, and the same uid the repository is owned by on this host.
# Reusing it would make "the app runs as a non-root user" and "the bind mount
# happens to be owned by that uid" indistinguishable, and a permission defect
# would be invisible locally and appear only in ECS. A distinct uid keeps the
# two facts separate. Nothing in the image is owned by 1000.
#
# =============================================================================
# SIGNALS
# =============================================================================
# ENTRYPOINT is exec form, so node is PID 1 and receives SIGTERM directly. A
# shell-form CMD would put /bin/sh at PID 1, and sh does not forward signals to
# its child: `docker stop` would then wait out the whole stop_grace_period and
# SIGKILL the app mid-request. That is exactly the class of failure DOCKER.md
# §5 exists to catch, so it is not left to chance — the entrypoint installs the
# handlers and `gate:app-images` asserts the exec form.

ARG NODE_VERSION

# -----------------------------------------------------------------------------
# base — the runtime floor. Alpine: the app images are not the place the Greek
# ICU/snowball argument applies (that is the DATABASE, docker/postgres.Dockerfile
# — see T-016 contract §4). Node ships its own ICU, and `--icu-data-dir` is not
# in play because the full-icu build is the default for the official images.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    # pnpm 11 refuses to purge a modules directory without a TTY unless CI is
    # set: `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY]`. The `prod-deps`
    # stage does exactly that — it strips devDependencies out of the install
    # `deps` made — and a Docker build never has a TTY. Measured, not guessed.
    CI=true
WORKDIR /srv/kinvara

# -----------------------------------------------------------------------------
# deps — the FULL workspace install, shared by all five images through the
# BuildKit stage cache. Devtools live here and never reach the runtime stage.
# -----------------------------------------------------------------------------
FROM base AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
# Manifests only, so a source edit does not invalidate the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps apps
COPY packages packages
RUN --mount=type=cache,id=kinvara-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store --location project \
 && pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# build — build the app IF IT DECLARES A BUILD. Derived from its package.json,
# never from a list here: an app that grows a `build` script gets built with no
# edit to this file, and `gate:app-images` fails if an app has src/ and does not
# declare one, so "silently still a placeholder" cannot survive a gate run.
# -----------------------------------------------------------------------------
FROM deps AS build
ARG APP
RUN test -n "${APP}" || { echo "app.Dockerfile: --build-arg APP is required" >&2; exit 1; }
RUN node -e "const p=require('./apps/${APP}/package.json'); process.exit(p.scripts&&p.scripts.build?0:1)" \
      && pnpm --filter "@kinvara/${APP}" build \
      || echo "app.Dockerfile: apps/${APP} declares no build script — nothing to build"

# -----------------------------------------------------------------------------
# prod-deps — the RUNTIME dependency closure only. Separate from `deps` so no
# devDependency reaches the shipped image: it is both weight and Trivy surface.
# -----------------------------------------------------------------------------
FROM deps AS prod-deps
ARG APP
RUN --mount=type=cache,id=kinvara-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm --filter "@kinvara/${APP}..." install --frozen-lockfile --prod --ignore-scripts

# -----------------------------------------------------------------------------
# runtime — what actually ships. No pnpm, no corepack, no devDependencies, no
# build toolchain, no source of any other app.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ARG APP_KIND=http
ARG APP_PORT=3000

LABEL io.kinvara.app="${APP}" \
      io.kinvara.built-by="T-018" \
      org.opencontainers.image.source="https://example.invalid/kinvara" \
      org.opencontainers.image.title="kinvara/${APP}"

# A dedicated non-root identity. See the header for why not uid 1000.
RUN addgroup -g 10001 -S kinvara && adduser -u 10001 -S -G kinvara -h /srv/kinvara kinvara

WORKDIR /srv/kinvara
ENV NODE_ENV=production \
    KINVARA_APP=${APP} \
    KINVARA_APP_KIND=${APP_KIND} \
    KINVARA_APP_DIR=/srv/kinvara/apps/${APP} \
    KINVARA_HEARTBEAT=/tmp/kinvara-heartbeat \
    PORT=${APP_PORT} \
    NODE_OPTIONS=--enable-source-maps

COPY --from=prod-deps --chown=10001:10001 /srv/kinvara/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /srv/kinvara/packages ./packages
COPY --from=build --chown=10001:10001 /srv/kinvara/apps/${APP} ./apps/${APP}
COPY --chown=10001:10001 docker/app-runtime/ ./app-runtime/

USER 10001:10001

EXPOSE ${APP_PORT}

# In the image, not in compose: the healthcheck must travel with what ships
# (T-003's ECS task definition reads it from here too).
# start-period covers a cold Node boot on a loaded 4-core host; the interval is
# deliberately short so `svc up --wait` does not sit on a stale unhealthy state.
HEALTHCHECK --interval=5s --timeout=4s --start-period=15s --retries=6 \
  CMD ["node", "/srv/kinvara/app-runtime/healthcheck.mjs"]

# EXEC FORM. node is PID 1 and gets SIGTERM directly — see the header.
ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]
