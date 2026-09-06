#!/usr/bin/env bash
# T-018: gate:app-images demonstrated REFUSING each thing it exists to refuse
# (PROTOCOL §5.1 — a gate that has only ever been seen green is not wired to
# anything).
#
# Mutations go through scripts/negative-tests/mutate.mjs, which exits non-zero
# when its anchor is missing, so a stale anchor is a HARNESS ERROR and never a
# silent pass.
set -uo pipefail
cd "$(dirname "$0")/../.."
VERIFY=docker/compose.verify.yml
CHAOS=docker/compose.chaos.yml
DF=docker/app.Dockerfile
BK="$(mktemp -d)"
cp "$VERIFY" "$BK/verify"; cp "$CHAOS" "$BK/chaos"; cp "$DF" "$BK/df"; cp scripts/svc "$BK/svc"; cp apps/core/package.json "$BK/corepkg"
restore() {
  cp "$BK/verify" "$VERIFY"; cp "$BK/chaos" "$CHAOS"; cp "$BK/df" "$DF"; cp "$BK/svc" scripts/svc; cp "$BK/corepkg" apps/core/package.json
  rm -rf apps/core/src docker/next.Dockerfile docker/rogue.Dockerfile
}
trap 'restore; rm -rf "$BK"' EXIT

bad=0
# The number of cases actually RUN, kept by run_case. The footer prints this
# counter, not a literal: app-images.sh claimed "ALL 25 CASES" while running 24,
# and that 25 reached the stakeholder report. A literal also keeps asserting the
# old number when a case is deleted, which is the same defect pointed the other
# way. A mutation that fails to apply skips run_case, so a drop here is visible.
ran=0
mut() { node scripts/negative-tests/mutate.mjs "$@" || { echo "   HARNESS ERROR"; bad=$((bad+1)); return 1; }; }
run_case() {
  local label="$1" expect="$2" out code
  out="$(node scripts/gates/app-images.ts 2>&1)"; code=$?
  local verdict; [[ $code -eq 0 ]] && verdict=PASS || verdict=FAIL
  ran=$((ran+1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad+1)); }
  printf '%s %-52s exit=%d  %-4s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-150 | sed 's/^/       /'
  restore
}

CORE_BUILD="  core:
    build:
      context: ..
      dockerfile: docker/app.Dockerfile"

run_case "00 unmodified tree" PASS

echo; echo "=== no host ports IN THE --verify OVERLAY (OD-4; a ports: key on a compose.yml service is checked by nothing — OD-22, T-036) ==="
mut "$VERIFY" "$CORE_BUILD" "  core:
    ports: ['3000:3000']
    build:
      context: ..
      dockerfile: docker/app.Dockerfile" && run_case "01 a ports: key on a verify service" FAIL

echo; echo "=== an overlay may not escape the DOCKER.md §3 budget ==="
mut "$VERIFY" "$CORE_BUILD" "  core:
    mem_limit: 2g
    build:
      context: ..
      dockerfile: docker/app.Dockerfile" && run_case "02 mem_limit raised above compose.yml's 768m" FAIL
mut "$VERIFY" "$CORE_BUILD" "  core:
    mem_limit: 512m
    build:
      context: ..
      dockerfile: docker/app.Dockerfile" && run_case "03 mem_limit LOWERED (allowed)" PASS

echo; echo "=== the Node pin is derived from .tool-versions, not written down ==="
mut "$DF" '
ARG NODE_VERSION
' '
ARG NODE_VERSION=24.20.0
' && run_case "04 ARG NODE_VERSION given a default" FAIL
mut "$VERIFY" '        APP: core' '        NODE_VERSION_PINNED: 24.20.0
        APP: core' && run_case "05 the literal node pin copied into the overlay" FAIL
mut scripts/svc 'KINVARA_NODE_VERSION="$(toolbox_require_pin nodejs)"' 'KINVARA_NODE_VERSION="24.20.0" #' \
  && run_case "06 scripts/svc hard-codes the version instead" FAIL

echo; echo "=== every service compose.yml says T-018 builds is built here ==="
mut "$VERIFY" "$CORE_BUILD" "  core:
    build_disabled:
      context: ..
      dockerfile: docker/app.Dockerfile" && run_case "07 core's build: removed from the overlay" FAIL
mut "$VERIFY" '        APP: worker' '        APP_MISSING: worker' && run_case "08 a service passes no APP build arg" FAIL

echo; echo "=== the image contract ==="
mut "$DF" 'USER 10001:10001' 'USER node' && run_case "09 USER node (uid 1000 — the toolbox's own)" FAIL
mut "$DF" 'USER 10001:10001' 'USER root' && run_case "10 USER root" FAIL
mut "$DF" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
          'ENTRYPOINT node /srv/kinvara/app-runtime/entrypoint.mjs' \
  && run_case "11 shell-form ENTRYPOINT (sh at PID 1 eats SIGTERM)" FAIL
mut "$DF" 'HEALTHCHECK --interval' '# HEALTHCHECK --interval' && run_case "12 HEALTHCHECK removed from the image" FAIL

echo; echo "=== the devDependency guard must RUN, IN THE STAGE THAT SHIPS ==="
mut "$DF" 'RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara' 'RUN true # ' \
  && run_case "13 the guard removed from the runtime stage" FAIL
mut "$DF" 'RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara' \
          'RUN echo skipping assert-no-dev-deps.mjs' \
  && run_case "14 a MENTION of it instead of a run" FAIL
# Not sabotage — an ordinary refactor. The guard is still in the file, still on
# a RUN, and never executes for the target compose builds. A line-based check
# passes this; that is why the check parses stages.
mut "$DF" 'RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara' \
          '# moved to an orphan stage below' \
  && node scripts/negative-tests/mutate.mjs "$DF" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
       'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]

FROM runtime AS orphan-nobody-builds
RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara' \
  && run_case "15 the guard moved to a stage the target does not use" FAIL
# What QA actually built: one COPY after the guard puts anything it likes into
# the image, unchecked.
mut "$DF" 'RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara' \
          'RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara
COPY --from=deps --chown=10001:10001 /srv/kinvara/node_modules ./node_modules' \
  && run_case "16 a COPY added AFTER the guard in the runtime stage" FAIL
mut "$DF" 'FROM base AS prod-deps' 'FROM deps AS prod-deps' \
  && run_case "17 prod-deps back to FROM deps (static gate cannot see it)" PASS
# QA: the previous condition matched three literals, so `pnpm i` — the shorter
# and commoner spelling of the same command — skipped the guard entirely. Two
# Dockerfiles differing by one word, one guarded and one not, and the alias that
# skipped it was the one people type.
cat > docker/rogue.Dockerfile <<'DF'
ARG NODE_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
RUN pnpm i --frozen-lockfile --prod
USER 10001:10001
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/x.mjs"]
DF
mut "$VERIFY" 'services:' 'services:
  qa-pnpm-i:
    image: kinvara/qa-pnpm-i:dev
    networks: [kinvara-int]
    build:
      context: ..
      dockerfile: docker/rogue.Dockerfile
      target: runtime
    pull_policy: build' \
  && run_case "17a a Dockerfile using 'pnpm i' and no guard" FAIL
rm -f docker/rogue.Dockerfile

echo; echo "=== the image contract follows the SERVICE, not one hard-coded path ==="
# QA's escape, reproduced. T-018's own contract §6 tells the Next.js tickets to
# split the Dockerfile, and the first version of this gate pinned its
# image-contract checks to docker/app.Dockerfile — so it stopped checking at
# exactly the moment someone followed that instruction.
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
USER root
ENTRYPOINT node /srv/kinvara/app-runtime/entrypoint.mjs
DF
mut "$VERIFY" '      dockerfile: docker/app.Dockerfile
      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: web' '      dockerfile: docker/next.Dockerfile
      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: web' \
  && run_case "18 web repointed at a 2nd Dockerfile: root, shell ENTRYPOINT, no HEALTHCHECK" FAIL
rm -f docker/next.Dockerfile

# QA round 2: the same defect one level up. §6 was then pinned to the
# `built-by: T-018` LABEL SET, so an overlay service that builds its own image
# and is simply not labelled was checked by nothing — and the gate still
# printed `dockerfiles checked 1` as though it had enumerated.
cat > docker/rogue.Dockerfile <<'DF'
ARG NODE_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
RUN echo "pnpm install" > /dev/null
USER root
ENTRYPOINT node /nope.mjs
DF
mut "$VERIFY" 'services:' 'services:
  qa-rogue:
    image: kinvara/rogue:dev
    networks: [kinvara-int]
    build:
      context: ..
      dockerfile: docker/rogue.Dockerfile
      target: runtime
    pull_policy: build' \
  && run_case "19 UNLABELLED overlay service with its own Dockerfile" FAIL
rm -f docker/rogue.Dockerfile

# compose.chaos.yml is T-126's, and T-018's contract §4 hands it to them. A
# built sidecar lands there, so it is in the derived set too.
cat > docker/rogue.Dockerfile <<'DF'
ARG NODE_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
RUN echo "pnpm install" > /dev/null
USER root
ENTRYPOINT node /nope.mjs
DF
mut "$CHAOS" 'services: {}' 'services:
  qa-chaos-sidecar:
    image: kinvara/chaos-sidecar:dev
    networks: [kinvara-int]
    build:
      context: ..
      dockerfile: docker/rogue.Dockerfile
      target: runtime
    pull_policy: build' \
  && run_case "20 the same in compose.chaos.yml (T-126's file)" FAIL
rm -f docker/rogue.Dockerfile

echo; echo "=== KNOWN GAP: USER / ENTRYPOINT / HEALTHCHECK are not stage-aware ==="
# An expected PASS, recorded so the limit is in the gate's own output rather
# than only in prose. §6 of T-018's contract tells the Next.js tickets to add a
# TARGET to this Dockerfile; QA did exactly that and the gate passed a
# root-running, healthcheck-less image with a shell PID 1. The guard check IS
# stage-aware, so the first attempt goes red and pushes you to add the guard —
# and once you do, these three go silent. That sequence makes the gap more
# misleading than a uniformly stage-blind gate would be.
cat >> "$DF" <<'DF'

FROM node:${NODE_VERSION}-alpine AS next-runtime
ARG APP
WORKDIR /srv/kinvara
COPY --from=build /srv/kinvara/apps/${APP} ./apps/${APP}
COPY docker/app-runtime/ ./app-runtime/
RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara
DF
node - <<'JS'
import fs from 'node:fs';
const p = 'docker/compose.verify.yml';
const s = fs.readFileSync(p, 'utf8');
const i = s.indexOf('  web:');
const j = s.indexOf('target: runtime', i);
fs.writeFileSync(p, s.slice(0, j) + 'target: next-runtime' + s.slice(j + 'target: runtime'.length));
JS
run_case "20a next-runtime target: no USER/HEALTHCHECK/ENTRYPOINT (KNOWN GAP)" PASS

echo; echo "=== a placeholder may not outlive real source ==="
mkdir -p apps/core/src && echo 'export const x = 1;' > apps/core/src/index.ts
run_case "21 apps/core has src/ but declares no start script" FAIL
mkdir -p apps/core/src && echo 'export const x = 1;' > apps/core/src/index.ts
node scripts/negative-tests/mutate.mjs apps/core/package.json '"type": "module",' '"type": "module",
  "scripts": { "start": "node dist/main.js" },' && run_case "22 the same, once it declares start" PASS

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 ]]; then echo "ALL $ran CASES BEHAVED AS EXPECTED"; else echo "!! $bad of $ran CASE(S) MISBEHAVED"; fi
exit $bad
