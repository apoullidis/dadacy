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
# OD-27, first half: `bad` used to count HARNESS ERRORS AND MISBEHAVING CASES,
# while `ran` counted only cases run_case reached — two populations in one
# ratio, which is how this footer printed `!! 24 of 4 CASE(S) MISBEHAVED`.
# They are counted apart now and both are reported; the exit status is still
# their sum, because either one means this suite proved nothing.
harness=0
mut() { node scripts/negative-tests/mutate.mjs "$@" || { echo "   HARNESS ERROR"; harness=$((harness+1)); return 1; }; }
# OD-27, second half, and it is not cosmetic. The verdict was
# `[[ $code -eq 0 ]] && PASS || FAIL`, so ANY non-zero exit read as FAIL and a
# case whose expectation IS FAIL passed on a CRASH: case 21 was observed
# counted as behaving-as-expected on a 127 (bare `node` off the toolbox). An
# uncaught exception in app-images.ts also exits 1, and would be
# indistinguishable from a refusal — which matters most for the cases added
# below, since a suite that cannot tell a refusal from a crash cannot evidence
# a fix. So a verdict now requires the exit status AND the gate's own banner
# (PROTOCOL §5.1: assert the exit status, not just the bytes). Anything else is
# CRASH, which equals no expectation and therefore always misbehaves.
run_case() {
  local label="$1" expect="$2" out code
  out="$(node scripts/gates/app-images.ts 2>&1)"; code=$?
  local verdict
  if [[ $code -eq 0 && "$out" == *"GATE PASS  gate:app-images"* ]]; then verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"GATE FAIL  gate:app-images"* ]]; then verdict=FAIL
  else verdict="CRASH"; fi
  ran=$((ran+1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad+1)); }
  printf '%s %-52s exit=%d  %-5s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-150 | sed 's/^/       /'
  [[ "$verdict" == CRASH ]] && printf '%s\n' "$out" | tail -3 | sed 's/^/       /'
  restore
}

CORE_BUILD="  core:
    build:
      context: ..
      dockerfile: docker/app.Dockerfile"

run_case "00 unmodified tree" PASS

echo; echo "=== case 01: a ports: key in compose.verify.yml (OD-4). SCOPE of this check is UNDER MEASUREMENT — T-036 (OD-22); do not read a PASS as coverage ==="
mut "$VERIFY" "$CORE_BUILD" "  core:
    ports: ['3000:3000']
    build:
      context: ..
      dockerfile: docker/app.Dockerfile" && run_case "01 a ports: key on a verify service" FAIL

echo; echo "=== cases 02-03: a mem_limit raise in compose.verify.yml (DOCKER.md §3). SCOPE UNDER MEASUREMENT — T-036 (OD-24) ==="
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

echo; echo "=== cases 04-06: the Node pin planted in the Dockerfile, the overlay and scripts/svc. SCOPE UNDER MEASUREMENT — T-036 (OD-21, OD-23, OD-25) ==="
mut "$DF" '
ARG NODE_VERSION
' '
ARG NODE_VERSION=24.20.0
' && run_case "04 ARG NODE_VERSION given a default" FAIL
mut "$VERIFY" '        APP: core' '        NODE_VERSION_PINNED: 24.20.0
        APP: core' && run_case "05 the literal node pin copied into the overlay" FAIL
mut scripts/svc 'KINVARA_NODE_VERSION="$(toolbox_require_pin nodejs)"' 'KINVARA_NODE_VERSION="24.20.0" #' \
  && run_case "06 scripts/svc hard-codes the version instead" FAIL

echo; echo "=== cases 07-08: a labelled service whose build:/APP arg is missing from compose.verify.yml. SCOPE UNDER MEASUREMENT — T-036 ==="
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

echo; echo "=== cases 18-20: the image-contract checks read a service's own Dockerfile (§2a). SCOPE UNDER MEASUREMENT — T-036 (OD-25: §1's pin checks do NOT) ==="
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

echo; echo "=== case 20a: the T-018 KNOWN GAP, CLOSED BY T-035 — a new target inheriting nothing ==="
# This case was an expected PASS through all of T-018 and T-034: §6 of that
# contract tells the Next.js tickets to add a TARGET to this Dockerfile, QA did
# exactly that, and the gate passed a root-running, healthcheck-less image with
# a shell PID 1. The guard check WAS already stage-aware, so the first attempt
# went red and pushed you to add the guard — and once you did, the other three
# went silent. That sequence made the gap more misleading than uniform
# stage-blindness would have been: you were taught that the gate covers your
# stage, by the gate, at the exact moment it stopped.
#
# THE EXPECTATION IS NOW FAIL. `next-runtime` here is `FROM node:...-alpine`,
# so it inherits nothing from `runtime`, and nothing in its own ancestry sets
# USER, HEALTHCHECK or ENTRYPOINT. Compare case 28, which is the same shape
# with a real parent and must stay GREEN — that pair is what distinguishes an
# ancestry walk from a stage-local regex.
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
run_case "20a next-runtime inheriting NOTHING: no USER/HC/ENTRYPOINT" FAIL

echo; echo "=== cases 21-22: apps/<name>/src present with no start script. SCOPE UNDER MEASUREMENT — T-036 ==="
mkdir -p apps/core/src && echo 'export const x = 1;' > apps/core/src/index.ts
run_case "21 apps/core has src/ but declares no start script" FAIL
mkdir -p apps/core/src && echo 'export const x = 1;' > apps/core/src/index.ts
node scripts/negative-tests/mutate.mjs apps/core/package.json '"type": "module",' '"type": "module",
  "scripts": { "start": "node dist/main.js" },' && run_case "22 the same, once it declares start" PASS

echo; echo "=== cases 23-31 (T-035): STAGE AWARENESS — last-wins along the target stage's ancestry ==="
# T-018's cases 09-12 are the same REPLACE shape four times: each swaps a good
# instruction for a bad one, which is the ONE direction in which "presence
# anywhere in the file" and "last-wins along the ancestry" agree. So that suite
# confirmed the misreading instead of attacking it — PROTOCOL §5.1's own defect,
# inside a negative-test suite. The cases below are the directions that were
# missed: APPEND, compose `target:`, an inheriting stage that must stay GREEN,
# and HEALTHCHECK NONE.

# --- the APPEND direction --------------------------------------------------
# `USER root` alone, appended to the stage that ships. This is the edit a
# reasonable engineer commits on a Tuesday — switch to root for a late apk add
# or chown, forget to switch back — and OD-20 measured that BuildKit says
# nothing at all about it: the warning count stays at the file's pre-existing 2,
# build exit 0. So no part of this gate may lean on a BuildKit diagnostic.
mut "$DF" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
          'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]

USER root' \
  && run_case "23 USER root APPENDED to the shipping stage (OD-20)" FAIL

# The three-line append OE-7 was raised on, verbatim.
mut "$DF" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
          'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]

USER root
HEALTHCHECK NONE
ENTRYPOINT node /srv/kinvara/app-runtime/entrypoint.mjs' \
  && run_case "24 the three-line append: root, NONE, shell PID 1 (OE-7)" FAIL

# HEALTHCHECK NONE on its own. It matches /^HEALTHCHECK /m, so it passes a
# whole-file check AND a stage-local one; Docker records Test:["NONE"] and the
# container is never probed. This is the case that rules out the cheap fix.
mut "$DF" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
          'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]

HEALTHCHECK NONE' \
  && run_case "25 HEALTHCHECK NONE appended (matches /^HEALTHCHECK /)" FAIL

# The PRECISION control, and it is a case the OLD check got WRONG in the other
# direction: `USER root` in `build` — a stage `runtime` does not inherit from —
# never reaches the image. The old check took the FIRST /^USER (\S+)/ in the
# file, which `build` precedes, so it RED a file whose shipped image is
# non-root. A gate that reds a correct file gets edited until it stops.
mut "$DF" 'RUN find /srv/kinvara -name node_modules -type d -prune -exec rm -rf {} +' \
          'RUN find /srv/kinvara -name node_modules -type d -prune -exec rm -rf {} +
USER root' \
  && run_case "26 USER root in 'build', which runtime does NOT inherit" PASS

# --- the compose `target:` direction (OD-29) -------------------------------
# NO DOCKERFILE EDIT AT ALL. tech-lead measured this one on safety-gw: the gate
# passed at exit 0 while PRINTING the mutated target, and the image it produces
# is root, docker-entrypoint.sh at PID 1, Healthcheck=null, 286 MB against
# 168 MB, with BuildKit's warning count unmoved. An ancestry walk anchored on
# the last stage of the Dockerfile would close OE-7 and leave this open,
# because the service's stage is chosen in COMPOSE.
retarget() {   # $1 = compose service, $2 = the stage to point it at
  KINVARA_SVC="$1" KINVARA_TARGET="$2" node - <<'JS' || { echo "   HARNESS ERROR"; harness=$((harness+1)); return 1; }
import fs from 'node:fs';
const p = 'docker/compose.verify.yml';
const s = fs.readFileSync(p, 'utf8');
const i = s.indexOf(`  ${process.env.KINVARA_SVC}:`);
const j = i < 0 ? -1 : s.indexOf('target: runtime', i);
if (j < 0) { console.error('retarget: anchor missing'); process.exit(1); }
fs.writeFileSync(p, s.slice(0, j) + `target: ${process.env.KINVARA_TARGET}` + s.slice(j + 'target: runtime'.length));
JS
}
retarget safety-gw prod-deps \
  && run_case "27 safety-gw target: runtime -> prod-deps (OD-29)" FAIL

# --- an inheriting stage, in all four directions ---------------------------
# `FROM runtime AS next-runtime` is the shape T-034 § contract 6 tells the
# Next.js tickets to write. Case 28 inherits all three correctly and MUST STAY
# GREEN — a stage-local regex would red it, which is why that was the wrong
# fix. Cases 29-31 are the same stage overriding one of the three, which
# last-wins says the image ends up with.
next_stage() {   # $1 = extra instructions for the child stage
  cat >> "$DF" <<DF

FROM runtime AS next-runtime
ARG APP
COPY --chown=10001:10001 docker/app-runtime/ ./app-runtime/
RUN node /srv/kinvara/app-runtime/assert-no-dev-deps.mjs /srv/kinvara
$1
DF
  retarget web next-runtime
}
next_stage '' && run_case "28 web -> a stage that INHERITS all three (must stay green)" PASS
next_stage 'USER root' && run_case "29 the same stage, then USER root" FAIL
next_stage 'HEALTHCHECK NONE' && run_case "30 the same stage, then HEALTHCHECK NONE" FAIL
next_stage 'ENTRYPOINT node /srv/kinvara/app-runtime/entrypoint.mjs' \
  && run_case "31 the same stage, then a shell-form ENTRYPOINT" FAIL

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
