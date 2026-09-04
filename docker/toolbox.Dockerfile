# syntax=docker/dockerfile:1.7
#
# Kinvara toolbox — the ONLY place node, pnpm, tsc, terraform and Playwright
# exist in this programme (DOCKER.md §0.1, §4.2). Nothing is installed on the
# host and nothing may be.
#
# Every version below is supplied as a --build-arg by scripts/dev, read from
# app/.tool-versions. The defaults here mirror that file so a bare
# `docker build` is not silently unpinned; if the two ever disagree,
# .tool-versions wins and scripts/dev is what enforces it.
#
# Build targets:
#   toolbox             (default) node + pnpm + terraform. Used by scripts/dev
#                       and, from T-016, by scripts/svc run.
#   toolbox-playwright  the same toolchain on top of the pinned Playwright
#                       browser image. Used only by the heavy gates (T-006).
#
# Deliberate properties:
#   - Runs as an arbitrary uid:gid (the invoking host user), so every writable
#     path is world-writable and nothing depends on a baked-in user existing.
#   - CHECKPOINT_DISABLE=1 so `terraform version` never appends an upgrade
#     notice; without it the same command run twice is not byte-identical.
#   - No shell as CMD. The entrypoint refuses an empty command.

ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0
ARG TERRAFORM_VERSION=1.16.1
ARG PLAYWRIGHT_VERSION=1.62.0

# Added by T-001 for the no-app-code gates (gate:secrets, gate:trivy).
# scripts/dev (T-000, unmodified) passes only the four args above, so these two
# are NOT overridden at build time: the defaults below ARE the pin, and they
# must be kept identical to app/.tool-versions in the same commit. `gate:toolbox`
# compares the installed binaries against .tool-versions and fails if they drift,
# which is what makes that convention enforced rather than remembered.
ARG GITLEAKS_VERSION=8.30.1
ARG TRIVY_VERSION=0.74.0

# ---------------------------------------------------------------------------
# Stage 1 — fetch and checksum-verify Terraform. HashiCorp publish no image,
# so the binary is downloaded and verified against their signed SHA256SUMS.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS terraform-fetch
ARG TERRAFORM_VERSION
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    cd /tmp; \
    zip="terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip"; \
    sums="terraform_${TERRAFORM_VERSION}_SHA256SUMS"; \
    base="https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}"; \
    curl -fsSL -o "${zip}"  "${base}/${zip}"; \
    curl -fsSL -o "${sums}" "${base}/${sums}"; \
    grep " ${zip}\$" "${sums}" | sha256sum -c -; \
    mkdir -p /out; \
    unzip -o "${zip}" -d /out; \
    chmod 0755 /out/terraform; \
    /out/terraform version

# ---------------------------------------------------------------------------
# Stage 1b (T-001) — fetch and checksum-verify gitleaks and Trivy.
#
# Both are single static Go binaries published on GitHub with a signed
# checksums file. Neither is an npm package, so neither can live in the
# workspace: they have to be in the image (platform-infrastructure.md
# non-negotiable 8 — "if a command is missing, the answer is to add it to the
# toolbox image, never apt install").
#
# dependency-cruiser is deliberately NOT here: it IS an npm package, it must
# resolve the workspace's own tsconfig.json and node_modules to follow a TS
# import graph at all, and a copy installed globally in the image could not.
# It is pinned in the root package.json devDependencies and the lockfile.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS secops-fetch
ARG GITLEAKS_VERSION
ARG TRIVY_VERSION
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    mkdir -p /out; \
    cd /tmp; \
    case "${TARGETARCH}" in \
      amd64) gl_arch=x64;   tv_arch=64bit ;; \
      arm64) gl_arch=arm64; tv_arch=ARM64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    \
    gl_tar="gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz"; \
    gl_sums="gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    gl_base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"; \
    curl -fsSL -o "${gl_tar}"  "${gl_base}/${gl_tar}"; \
    curl -fsSL -o "${gl_sums}" "${gl_base}/${gl_sums}"; \
    grep "  ${gl_tar}\$" "${gl_sums}" | sha256sum -c -; \
    tar -xzf "${gl_tar}" gitleaks; \
    install -m 0755 gitleaks /out/gitleaks; \
    \
    tv_tar="trivy_${TRIVY_VERSION}_Linux-${tv_arch}.tar.gz"; \
    tv_sums="trivy_${TRIVY_VERSION}_checksums.txt"; \
    tv_base="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}"; \
    curl -fsSL -o "${tv_tar}"  "${tv_base}/${tv_tar}"; \
    curl -fsSL -o "${tv_sums}" "${tv_base}/${tv_sums}"; \
    grep "  ${tv_tar}\$" "${tv_sums}" | sha256sum -c -; \
    tar -xzf "${tv_tar}" trivy; \
    install -m 0755 trivy /out/trivy; \
    \
    /out/gitleaks version; \
    /out/trivy --version

# ---------------------------------------------------------------------------
# Stage 2 — the toolbox proper.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS toolbox
ARG NODE_VERSION
ARG PNPM_VERSION
ARG TERRAFORM_VERSION
ARG PLAYWRIGHT_VERSION
ARG GITLEAKS_VERSION
ARG TRIVY_VERSION

LABEL org.opencontainers.image.title="kinvara-toolbox" \
      org.opencontainers.image.description="Kinvara pinned toolchain (DOCKER.md §4.2)" \
      io.kinvara.node="${NODE_VERSION}" \
      io.kinvara.pnpm="${PNPM_VERSION}" \
      io.kinvara.terraform="${TERRAFORM_VERSION}" \
      io.kinvara.playwright="${PLAYWRIGHT_VERSION}" \
      io.kinvara.gitleaks="${GITLEAKS_VERSION}" \
      io.kinvara.trivy="${TRIVY_VERSION}"

# git: pnpm resolves git-hosted deps and the gates shell out to it.
# ca-certificates: the toolbox is the one container with egress (DOCKER.md §7).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git; \
    rm -rf /var/lib/apt/lists/*

COPY --from=terraform-fetch /out/terraform /usr/local/bin/terraform

# T-001: the two no-app-code security gates (SD §QD-4 PR row: gitleaks,
# "pnpm audit + Trivy"). Verified by gate:toolbox against .tool-versions.
COPY --from=secops-fetch /out/gitleaks /usr/local/bin/gitleaks
COPY --from=secops-fetch /out/trivy    /usr/local/bin/trivy

# Terraform phones home on `version` unless this is set. That upgrade notice is
# exactly what breaks the "same command twice is byte-identical" gate.
ENV CHECKPOINT_DISABLE=1 \
    TF_IN_AUTOMATION=1 \
    CI=1

# Corepack cache must be readable by whatever uid runs the container.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN set -eux; \
    mkdir -p "${COREPACK_HOME}"; \
    corepack enable; \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    chmod -R a+rX "${COREPACK_HOME}" /usr/local/bin; \
    pnpm --version

# HOME and the pnpm/npm caches must be writable by an arbitrary uid.
# /pnpm-store exists in the image so that Docker initialises the named volume
# mounted there with these permissions rather than root-owned 0755.
ENV HOME=/home/toolbox \
    npm_config_cache=/home/toolbox/.npm \
    npm_config_update_notifier=false
RUN set -eux; \
    mkdir -p /home/toolbox/.npm /home/toolbox/.cache /home/toolbox/.config/pnpm /pnpm-store; \
    chmod 1777 /home/toolbox /home/toolbox/.npm /home/toolbox/.cache /pnpm-store
# Pointing pnpm at the named volume. Measured against pnpm 11.25.0, because
# three of the five plausible mechanisms silently do nothing:
#   npm_config_store_dir=  env      IGNORED  -> falls back to <repo>/.pnpm-store
#   PNPM_STORE_PATH=       env      IGNORED  -> same
#   store-dir=  in ~/.npmrc         IGNORED  -> same (pnpm 11 no longer reads
#                                               pnpm settings from npmrc)
#   store-dir=  in the pnpm rc      IGNORED  -> same
#   pnpm_config_store_dir= env      HONOURED -> /pnpm-store/v11   <-- this one
# The silent fallback is the danger: the store lands INSIDE the bind-mounted
# working tree, so it is not cached between invocations and it pollutes the
# repo T-001 is about to `git init`. pnpm-workspace.yaml `storeDir:` also works
# but that file belongs to T-001, and the toolbox must be correct on its own.
ENV pnpm_config_store_dir=/pnpm-store \
    PNPM_HOME=/home/toolbox/.local/share/pnpm
ENV PATH="/home/toolbox/.local/share/pnpm:${PATH}"
RUN set -eux; \
    mkdir -p /home/toolbox/.local/share/pnpm; \
    chmod -R 1777 /home/toolbox/.local

COPY --chmod=0755 <<'ENTRYPOINT' /usr/local/bin/toolbox-entrypoint
#!/bin/sh
# The toolbox runs one command and exits. It is not an interactive shell:
# a shell here would let an agent build evidence from an unrecorded session.
if [ "$#" -eq 0 ]; then
    echo "toolbox: refusing to start with no command." >&2
    echo "         Run one toolchain command, e.g. scripts/dev pnpm -w typecheck" >&2
    exit 2
fi
exec "$@"
ENTRYPOINT

ENTRYPOINT ["/usr/local/bin/toolbox-entrypoint"]

# ---------------------------------------------------------------------------
# Stage 3 — the Playwright variant. Same pinned node/pnpm/terraform, laid on
# top of the pinned Playwright browser image so the browsers and the
# @playwright/test package can never drift apart. Heavy gates only (T-006);
# scripts/dev builds it on demand with --playwright.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS toolbox-playwright
ARG NODE_VERSION
ARG PNPM_VERSION
ARG TERRAFORM_VERSION
ARG PLAYWRIGHT_VERSION

LABEL org.opencontainers.image.title="kinvara-toolbox-playwright" \
      io.kinvara.node="${NODE_VERSION}" \
      io.kinvara.pnpm="${PNPM_VERSION}" \
      io.kinvara.terraform="${TERRAFORM_VERSION}" \
      io.kinvara.playwright="${PLAYWRIGHT_VERSION}"

# Replace the base image's own Node with the pinned one, so `node --version`
# means the same thing in both toolbox variants.
COPY --from=toolbox /usr/local/bin/node /usr/local/bin/node
COPY --from=toolbox /usr/local/include/node /usr/local/include/node
COPY --from=toolbox /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=toolbox /usr/local/bin/terraform /usr/local/bin/terraform
# T-001: keep the two security gates present in BOTH variants, so
# `scripts/dev --playwright pnpm gate:toolbox` asserts the same pin contract
# rather than reporting two missing binaries.
COPY --from=toolbox /usr/local/bin/gitleaks /usr/local/bin/gitleaks
COPY --from=toolbox /usr/local/bin/trivy    /usr/local/bin/trivy
COPY --from=toolbox /opt/corepack /opt/corepack
COPY --from=toolbox /usr/local/bin/toolbox-entrypoint /usr/local/bin/toolbox-entrypoint

ENV CHECKPOINT_DISABLE=1 \
    TF_IN_AUTOMATION=1 \
    CI=1 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HOME=/home/toolbox \
    npm_config_cache=/home/toolbox/.npm \
    npm_config_update_notifier=false \
    pnpm_config_store_dir=/pnpm-store \
    PNPM_HOME=/home/toolbox/.local/share/pnpm

RUN set -eux; \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js  /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js  /usr/local/bin/npx; \
    ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    chmod -R a+rX /opt/corepack; \
    corepack enable; \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    mkdir -p /home/toolbox/.npm /home/toolbox/.cache /home/toolbox/.config/pnpm /pnpm-store; \
    chmod 1777 /home/toolbox /home/toolbox/.npm /home/toolbox/.cache /pnpm-store; \
    mkdir -p /home/toolbox/.local/share/pnpm; \
    chmod -R 1777 /home/toolbox/.local; \
    node --version; pnpm --version; terraform version; pnpm store path

ENTRYPOINT ["/usr/local/bin/toolbox-entrypoint"]
