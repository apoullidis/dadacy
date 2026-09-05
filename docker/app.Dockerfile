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

# Strip every node_modules from this stage, so what it hands to `runtime` is
# SOURCE AND BUILD OUTPUT AND NOTHING ELSE. Without it the per-project trees
# come across — `packages/i18n/node_modules` did, measured — and they are dev
# links, which is the same leak by a second route. After this, `build` cannot
# reintroduce a dependency of any kind and the runtime stage's dependency
# layout comes from `prod-deps` alone.
RUN find /srv/kinvara -name node_modules -type d -prune -exec rm -rf {} +

# -----------------------------------------------------------------------------
# prod-deps — the RUNTIME dependency closure ONLY.
#
# `FROM base`, NOT `FROM deps`, and the difference is a shipped defect this
# ticket got wrong once. The first version was `FROM deps` plus
# `pnpm --filter … --prod install`, on the reasoning that the second install
# would strip what the first had put there. IT DOES NOT. pnpm re-links the
# FILTERED PROJECTS — the top-level symlinks under node_modules/ do go away —
# but it never purges the inherited workspace-root VIRTUAL STORE, so
# `node_modules/.pnpm` kept the entire dev install and the runtime stage copied
# it. Measured in kinvara/core:dev: 112.2 MB of 270 MB, and the whole top ten
# by size was devDependencies — @turbo/linux-64 43 MB, typescript 23.6 MB,
# prettier 9.7 MB, eslint 3.9 MB, dependency-cruiser 1.8 MB. Found by QA.
#
# A stage that starts from `base` has nothing to purge, which is why it is the
# fix rather than a bigger prune command: the property is now "this stage never
# saw a devDependency", not "this stage removed the ones it saw".
#
# The install is still cheap — it shares the pnpm store cache mount with `deps`
# and, with no production dependency anywhere in the workspace today, resolves
# to almost nothing.
# -----------------------------------------------------------------------------
FROM base AS prod-deps
ARG APP
ARG PNPM_VERSION
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps apps
COPY packages packages
RUN --mount=type=cache,id=kinvara-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store --location project \
 && pnpm --filter "@kinvara/${APP}..." install --frozen-lockfile --prod --ignore-scripts

# The guard. `gate:app-images` cannot see inside an image, and this property is
# invisible from the outside until someone measures the layer — which is
# exactly how it shipped. So the assertion runs IN THE BUILD, and a regression
# fails `svc up --verify --build` instead of producing a working image nobody
# looks inside.
#
# It is DERIVED: every package.json in the workspace is read and every name in
# its `devDependencies` must be absent from node_modules, both as a top-level
# entry and as a virtual-store directory. There is no list here to keep in step
# with package.json.
#
# What it catches: the regression above, immediately — reinstating `FROM deps`
# puts turbo and typescript back and this fails. What it does NOT catch: a
# package that is ONLY a transitive dependency of a devDependency and is named
# in no package.json. Naming the direct ones is what makes their trees absent,
# so in practice the two travel together, but the claim is the narrow one.
COPY docker/app-runtime/assert-no-dev-deps.mjs /tmp/assert-no-dev-deps.mjs
RUN node /tmp/assert-no-dev-deps.mjs /srv/kinvara && rm /tmp/assert-no-dev-deps.mjs

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

# ORDER MATTERS, and it is the whole of the dependency hygiene.
#
# prod-deps FIRST: it establishes the dependency layout — the root virtual
# store and the per-project node_modules symlinks that pnpm's isolated linker
# needs. Its `apps`/`packages` are unbuilt source.
#
# build SECOND, overlaying the same paths: identical source bytes plus whatever
# the build produced (dist/, .next/). A COPY of a directory MERGES, so the
# node_modules laid down by prod-deps survive it — and `build` has none of its
# own to reintroduce, because the stage strips them.
#
# Only ${APP}'s own directory is copied. The other four apps' source is not in
# this image.
COPY --from=prod-deps --chown=10001:10001 /srv/kinvara/node_modules ./node_modules
COPY --from=prod-deps --chown=10001:10001 /srv/kinvara/package.json ./package.json
COPY --from=prod-deps --chown=10001:10001 /srv/kinvara/packages ./packages
COPY --from=prod-deps --chown=10001:10001 /srv/kinvara/apps/${APP} ./apps/${APP}
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
