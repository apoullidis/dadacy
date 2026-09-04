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
# A pin with no matching ARG in the Dockerfile makes BuildKit warn about an
# unconsumed build-arg. That warning is the correct outcome: the tag changed,
# the image was rebuilt, and you are being told the Dockerfile has not caught
# up. It is loud, and it is not silence.
#
# Sets: KINVARA_BUILD_ARGS (array of "--build-arg" "NAME=value" pairs)
toolbox_build_args() {
    local i key name
    KINVARA_BUILD_ARGS=()
    for i in "${!KINVARA_PIN_KEYS[@]}"; do
        key="${KINVARA_PIN_KEYS[$i]}"
        if [[ "${key}" == "nodejs" ]]; then
            name="NODE_VERSION"
        else
            name="$(printf '%s' "${key}" | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')_VERSION"
        fi
        KINVARA_BUILD_ARGS+=(--build-arg "${name}=${KINVARA_PIN_VALUES[$i]}")
    done
}

# --- building ---------------------------------------------------------------
#
# toolbox_ensure_image <image> <target> <dockerfile> <context> <force:0|1>
toolbox_ensure_image() {
    local image="$1" target="$2" dockerfile="$3" context="$4" force="$5"

    if [[ "${force}" -ne 1 ]] && docker image inspect "${image}" >/dev/null 2>&1; then
        return 0
    fi

    toolbox_build_args
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
