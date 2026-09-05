#!/usr/bin/env bash
#
# scripts/lib/toolbox.sh — the pinned-toolchain machinery, shared by
# `scripts/dev` (egress, NO services) and `scripts/svc run` (services, NO
# egress). Sourced, never executed.
#
# It lives in one file for one reason: OD-1. The pin loop and the image tag
# used to be written out by hand in scripts/dev and enumerated FOUR of the
# tool pins. T-001 then added `gitleaks` and `trivy` to .tool-versions, and
# bumping either changed nothing the tag could see — the cached image was
# silently reused and an agent could run a stale binary against a new pin,
# believing the pin. Two copies of that loop would have re-opened the hole the
# first time the two drifted, so there is one copy and both entry points use it.
#
# Everything here is derived from .tool-versions. NOTHING is enumerated by
# hand. Adding a line to that file is all it takes to change the image.

# --- pins -------------------------------------------------------------------
#
# Reads .tool-versions into two parallel arrays. asdf format: "<tool> <version>"
# per line, '#' comments and blank lines ignored.
#
# Sets: KINVARA_PIN_KEYS, KINVARA_PIN_VALUES
toolbox_load_pins() {
    local file="$1" key value
    [[ -f "${file}" ]] || { printf 'toolbox: missing %s\n' "${file}" >&2; return 1; }

    KINVARA_PIN_KEYS=()
    KINVARA_PIN_VALUES=()

    while read -r key value; do
        KINVARA_PIN_KEYS+=("${key}")
        KINVARA_PIN_VALUES+=("${value}")
    done < <(awk '!/^[[:space:]]*#/ && NF >= 2 { print $1, $2 }' "${file}")

    if [[ ${#KINVARA_PIN_KEYS[@]} -eq 0 ]]; then
        printf 'toolbox: %s declares no pins\n' "${file}" >&2
        return 1
    fi
}

# toolbox_pin <key> — the version for one tool, or empty.
toolbox_pin() {
    local want="$1" i
    for i in "${!KINVARA_PIN_KEYS[@]}"; do
        if [[ "${KINVARA_PIN_KEYS[$i]}" == "${want}" ]]; then
            printf '%s' "${KINVARA_PIN_VALUES[$i]}"
            return 0
        fi
    done
    return 1
}

# toolbox_require_pin <key> — the version, or die.
toolbox_require_pin() {
    local v
    if ! v="$(toolbox_pin "$1")" || [[ -z "${v}" ]]; then
        printf 'toolbox: no pin for '\''%s'\'' in .tool-versions\n' "$1" >&2
        return 1
    fi
    printf '%s' "${v}"
}

# --- the fingerprint --------------------------------------------------------
#
# A stable digest of EVERY pin in the file, not a chosen few. This is the whole
# of the OD-1 fix: it is what the image tag carries, so any change to any line
# — including a line for a tool that did not exist when this was written —
# produces a tag the daemon has never seen, and the image is rebuilt.
#
# Reproduce it by hand, exactly:
#
#   awk '!/^[[:space:]]*#/ && NF >= 2 { print $1, $2 }' app/.tool-versions \
#     | LC_ALL=C sort | sha256sum | cut -c1-12
#
# Comments and ordering deliberately do NOT affect it: re-wording a comment
# must not invalidate a 1 GB image, and moving two lines is not a version
# change.
toolbox_pin_fingerprint() {
    local file="$1"
    awk '!/^[[:space:]]*#/ && NF >= 2 { print $1, $2 }' "${file}" \
        | LC_ALL=C sort \
        | sha256sum \
        | cut -c1-12
}

# --- the image tag ----------------------------------------------------------
#
# toolbox_image_tag <tool-versions-file> <target>
#
# The leading node/pnpm/tf/pw segments are for a human reading `docker images`.
# The trailing fingerprint is what makes the tag CORRECT: it covers every pin,
# so the readable part can never be the only thing distinguishing two images.
toolbox_image_tag() {
    local file="$1" target="$2" tag
    tag="kinvara-toolbox:node$(toolbox_require_pin nodejs)"
    tag="${tag}-pnpm$(toolbox_require_pin pnpm)"
    tag="${tag}-tf$(toolbox_require_pin terraform)"
    if [[ "${target}" == "toolbox-playwright" ]]; then
        tag="${tag}-pw$(toolbox_require_pin playwright)"
    fi
    printf '%s-x%s' "${tag}" "$(toolbox_pin_fingerprint "${file}")"
}

# --- build args -------------------------------------------------------------
#
# Every pin becomes a --build-arg. The name is the key upper-cased with
# non-alphanumerics folded to '_', suffixed _VERSION, with ONE alias:
#
#   nodejs -> NODE_VERSION      (the Dockerfile's arg predates .tool-versions)
#
# ...AND EVERY PIN MUST HAVE A MATCHING `ARG` IN THE DOCKERFILE. That is
# checked here, by this function, and a missing one is a hard failure.
#
# QA-F6, measured on Docker 29.7.1: this used to say that BuildKit warns about
# an unconsumed build-arg, and that the warning was the safety net behind the
# OD-1 fix. IT DOES NOT WARN. Adding `shellcheck 0.10.0` to .tool-versions with
# no `ARG SHELLCHECK_VERSION` in the Dockerfile produced a changed tag, a
# rebuilt image, exit 0, and NO diagnostic of any kind — and the tool was
# simply absent from the image. That is OD-1's own shape one level down: the
# pin moved, the image was rebuilt, and an agent still did not get the tool it
# had pinned.
#
# So the net is a real check rather than a hoped-for warning. `.tool-versions`
# is the single source of truth; the Dockerfile must keep up with it, and this
# is what says so.
#
# toolbox_build_args <dockerfile>
# Sets: KINVARA_BUILD_ARGS (array of "--build-arg" "NAME=value" pairs)
toolbox_build_args() {
    local dockerfile="$1" i key name
    local -a missing=()
    KINVARA_BUILD_ARGS=()
    for i in "${!KINVARA_PIN_KEYS[@]}"; do
        key="${KINVARA_PIN_KEYS[$i]}"
        if [[ "${key}" == "nodejs" ]]; then
            name="NODE_VERSION"
        else
            name="$(printf '%s' "${key}" | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')_VERSION"
        fi
        if ! grep -qE "^[[:space:]]*ARG[[:space:]]+${name}([[:space:]]|=|\$)" "${dockerfile}"; then
            missing+=("  .tool-versions pins '${key}' but ${dockerfile##*/} declares no 'ARG ${name}'")
        fi
        KINVARA_BUILD_ARGS+=(--build-arg "${name}=${KINVARA_PIN_VALUES[$i]}")
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        {
            printf 'toolbox: .tool-versions and the Dockerfile disagree.\n\n'
            printf '%s\n' "${missing[@]}"
            printf '\nA pin with no ARG is silently dropped: the image tag changes, the image is\n'
            printf 'rebuilt, and the tool is simply not in it. Docker does not warn (QA-F6).\n\n'
            printf 'Add the ARG to docker/toolbox.Dockerfile AND use it, or remove the pin.\n'
        } >&2
        return 1
    fi
}

# --- building ---------------------------------------------------------------
#
# toolbox_ensure_image <image> <target> <dockerfile> <context> <force:0|1>
toolbox_ensure_image() {
    local image="$1" target="$2" dockerfile="$3" context="$4" force="$5"

    if [[ "${force}" -ne 1 ]] && docker image inspect "${image}" >/dev/null 2>&1; then
        return 0
    fi

    toolbox_build_args "${dockerfile}" || return 1
    printf 'toolbox: building %s (target %s)\n' "${image}" "${target}" >&2
    DOCKER_BUILDKIT=1 docker build \
        --file "${dockerfile}" \
        --target "${target}" \
        --tag "${image}" \
        "${KINVARA_BUILD_ARGS[@]}" \
        "${context}" >&2
}

# --- mounts -----------------------------------------------------------------
#
# toolbox_mount_args <repo-root>
#
# The repository is bind-mounted at its REAL host path, so a path printed
# inside the container means the same thing outside it.
#
# DOCKER.md §9.1b, the caveat that blocks `git worktree` concurrency: in a
# LINKED worktree, `.git` is a FILE containing "gitdir: <main repo>/.git/
# worktrees/<name>". Mount only the worktree and every git command inside the
# container fails — the path that file points at does not exist there. So when
# we detect a linked worktree we mount the main repository's `.git` directory
# too, at its own real path, and git resolves exactly as it does on the host.
#
# It costs one extra --volume and it is the whole of the caveat. `git` is on
# the host (2.43.0), so the detection is free.
#
# Sets: KINVARA_MOUNT_ARGS
toolbox_mount_args() {
    local repo_root="$1" common_dir
    KINVARA_MOUNT_ARGS=(--volume "${repo_root}:${repo_root}")

    # A regular checkout has .git as a directory and is already covered.
    if [[ -f "${repo_root}/.git" ]]; then
        if common_dir="$(git -C "${repo_root}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
           && [[ -n "${common_dir}" && -d "${common_dir}" ]] \
           && [[ "${common_dir}" != "${repo_root}/"* ]]; then
            KINVARA_MOUNT_ARGS+=(--volume "${common_dir}:${common_dir}")
        fi
    fi
}

# --- the Docker socket (OD-16 / OD-18) --------------------------------------
#
# WHERE THE SOCKET IS ALLOWED, AND WHY IT IS NOT ALLOWED IN `svc run`.
#
# Testcontainers (DOCKER.md §1) is the mandated mechanism for every constraint
# and invariant suite, and it runs from inside the toolbox, so it needs a route
# to the daemon. There is exactly one place that route may exist:
#
#     scripts/dev --docker      <- the socket, explicitly asked for
#     scripts/dev               <- no socket
#     scripts/svc run           <- no socket, EVER
#
# `svc run` is excluded because a Docker socket is a general-purpose escape
# from the property `svc run` exists to provide. A process there has no egress
# BY CONSTRUCTION — kinvara-int is `internal: true`, so the packet cannot leave
# (DOCKER.md §7). Hand that process a socket and it can POST /containers/create
# with `NetworkMode: bridge` and reach the internet from the sibling; it can
# also bind-mount `/` and read the host as root. The `internal: true`
# guarantee would stop being structural and become a convention, and
# `gate:egress-boundary` — which reads compose files and the `--network`
# argument of each entry point — models none of that and would stay green.
#
# `scripts/dev` is the defensible place because it ALREADY has egress: the
# socket adds no reachability there that kinvara-build did not already give.
# It does add host-root to whatever the toolbox runs, which is a real widening
# and is exactly why it is behind an explicit flag rather than always-on: the
# set of invocations running with host-root is then small, greppable, and
# visible in the evidence file of whoever used it.
#
# FOUR THINGS, NOT ONE. OD-16 measured the first two; OD-18 measured that they
# are not sufficient, because `GET /version` never leaves the daemon and a
# Testcontainers run does:
#
#   1. --volume <sock>:<sock>          without it: ENOENT
#   2. --group-add <gid of the sock>   without it: EACCES (the socket is
#                                      root:docker 0660 and the toolbox is
#                                      1000:1000). DERIVED with stat, never
#                                      hard-coded — 987 is this host's number.
#   3. --add-host host.docker.internal:host-gateway
#                                      without it: the sibling container's
#                                      PUBLISHED HOST PORT is unreachable —
#                                      ERR ENOTFOUND. `localhost` inside the
#                                      toolbox is the toolbox.
#   4. TESTCONTAINERS_HOST_OVERRIDE    so Testcontainers' getHost() returns
#                                      that name instead of 'localhost'.
#
# THE CHEAPEST WRONG REPAIR IS `--user 0:0`, and it is wrong. The EACCES in (2)
# reads as a broken harness, and running the toolbox as root makes it go away
# while silently undoing T-000's measured property that a file the toolbox
# writes is owned by the invoking host user. `toolbox_refuse_root` below and
# `gate:toolbox` §4 (which stats a file the toolbox actually wrote) are the two
# independent checks that stop it.
#
# Sets: KINVARA_DOCKER_ARGS
toolbox_docker_socket_args() {
    local sock gid
    sock="${1:-}"

    if [[ -z "${sock}" ]]; then
        # Honour an explicit unix:// DOCKER_HOST; otherwise the default path.
        if [[ "${DOCKER_HOST:-}" == unix://* ]]; then
            sock="${DOCKER_HOST#unix://}"
        else
            sock="/var/run/docker.sock"
        fi
    fi

    if [[ ! -S "${sock}" ]]; then
        {
            printf 'toolbox: --docker asked for the Docker socket, but %s is not a socket.\n\n' "${sock}"
            printf 'Only a unix socket is supported here. If your daemon is remote, that is a\n'
            printf 'finding, not something to work around: say so and tell the orchestrator.\n'
        } >&2
        return 1
    fi

    if ! gid="$(stat -c '%g' "${sock}" 2>/dev/null)" || [[ -z "${gid}" ]]; then
        printf 'toolbox: cannot stat %s to derive its group id\n' "${sock}" >&2
        return 1
    fi

    KINVARA_DOCKER_ARGS=(
        --volume "${sock}:${sock}"
        --group-add "${gid}"
        --add-host "host.docker.internal:host-gateway"
        --env "DOCKER_HOST=unix://${sock}"
        --env "TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal"
        --env "TESTCONTAINERS_RYUK_DISABLED=true"
        --env "KINVARA_DOCKER_SOCKET=1"
    )
}

# --- the root refusal (OD-16) -----------------------------------------------
#
# T-000 measured, and gate:toolbox §4 re-asserts, that a file the toolbox
# writes into the bind mount is owned by the INVOKING HOST USER. That property
# only holds because both entry points pass `--user "$(id -u):$(id -g)"`, and
# the whole of it is lost if the invoking user is root: every file the toolbox
# writes into the repository would then be root-owned, and the next agent's
# first `pnpm install` fails with EACCES on a tree it cannot repair without
# sudo.
#
# This refuses at the door rather than leaving the damage to be discovered.
# gate:egress-boundary asserts statically that neither entry point can be
# edited into passing a root uid; this is the runtime half.
toolbox_refuse_root() {
    local who="$1"
    if [[ "$(id -u)" -eq 0 ]]; then
        {
            printf '%s: refusing to run the toolbox as root.\n\n' "${who}"
            printf 'The container runs as the INVOKING uid:gid, so as root every file it\n'
            printf 'writes into the bind-mounted repository lands root-owned and the next\n'
            printf 'agent cannot repair the tree without sudo. That is the property T-000\n'
            printf 'measured and gate:toolbox re-asserts; it is not a warning to override.\n\n'
            printf 'Run as your normal user. If a permission error sent you here, the fix is\n'
            printf 'the permission, never the uid (OD-16).\n'
        } >&2
        return 1
    fi
}
