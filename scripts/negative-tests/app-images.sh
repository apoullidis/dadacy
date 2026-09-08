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
# T-036: compose.yml is now in the backup set because the no-ports rule reads it
# (OD-22 — it used to be checked in the overlay and nowhere else).
BASE=docker/compose.yml
DEV=docker/compose.dev.yml
DF=docker/app.Dockerfile
BK="$(mktemp -d)"
PGDF=docker/postgres.Dockerfile
cp "$VERIFY" "$BK/verify"; cp "$CHAOS" "$BK/chaos"; cp "$BASE" "$BK/base"; cp "$DEV" "$BK/dev"; cp "$DF" "$BK/df"; cp "$PGDF" "$BK/pgdf"; cp scripts/svc "$BK/svc"; cp apps/core/package.json "$BK/corepkg"
restore() {
  cp "$BK/verify" "$VERIFY"; cp "$BK/chaos" "$CHAOS"; cp "$BK/base" "$BASE"; cp "$BK/dev" "$DEV"; cp "$BK/df" "$DF"; cp "$BK/pgdf" "$PGDF"; cp "$BK/svc" scripts/svc; cp "$BK/corepkg" apps/core/package.json
  rm -rf apps/core/src apps/qa-newapp docker/next.Dockerfile docker/rogue.Dockerfile
}
trap 'restore; rm -rf "$BK"' EXIT

# THE DIFFERENTIAL HARNESS (T-036). Which implementation of the gate to judge
# each case with. The default is the committed gate and nothing in this repo
# ever sets it; it exists so a case can be judged by the gate AS AT another
# commit, on the IDENTICAL mutated file, which is the only way to show that a
# new case attacks a direction the old gate accepted rather than a direction
# nobody had written a case for:
#
#   git show main:scripts/gates/app-images.ts > scripts/gates/.main-app-images.ts
#   KINVARA_GATE_IMPL=scripts/gates/.main-app-images.ts bash scripts/negative-tests/app-images.sh
#
# The banner the verdict matches is the gate's own name, which does not change
# between implementations, so the two runs are directly comparable.
GATE_IMPL="${KINVARA_GATE_IMPL:-scripts/gates/app-images.ts}"

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
  out="$(node "$GATE_IMPL" 2>&1)"; code=$?
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

echo; echo "=== case 01: a ports: key in compose.verify.yml (OD-4). The base-file and chaos directions are cases 35-36 (OD-22) ==="
mut "$VERIFY" "$CORE_BUILD" "  core:
    ports: ['3000:3000']
    build:
      context: ..
      dockerfile: docker/app.Dockerfile" && run_case "01 a ports: key on a verify service" FAIL

echo; echo "=== cases 02-03: a mem_limit raise in compose.verify.yml (DOCKER.md §3). The chaos and ADDITION directions are cases 39-42 (OD-24) ==="
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

echo; echo "=== cases 04-06: the Node pin planted in the Dockerfile, the overlay and scripts/svc. The pnpm, per-service, second-Dockerfile and comment directions are cases 32-34, 37-38, 43-45, 49 (OD-21, OD-23, OD-25, OD-28) ==="
mut "$DF" '
ARG NODE_VERSION
' '
ARG NODE_VERSION=24.20.0
' && run_case "04 ARG NODE_VERSION given a default" FAIL
mut "$VERIFY" '        APP: core' '        NODE_VERSION_PINNED: 24.20.0
        APP: core' && run_case "05 the literal node pin copied into the overlay" FAIL
mut scripts/svc 'KINVARA_NODE_VERSION="$(toolbox_require_pin nodejs)"' 'KINVARA_NODE_VERSION="24.20.0" #' \
  && run_case "06 scripts/svc hard-codes the version instead" FAIL

echo; echo "=== cases 07-08: a labelled service whose build:/APP arg is missing from compose.verify.yml ==="
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

echo; echo "=== cases 18-20: the image-contract checks read a service's own Dockerfile (§2a). §1's pin checks now read the same set — cases 43-45 (OD-25) ==="
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

echo; echo "=== cases 21-22: apps/<name>/src present with no start script ==="
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

echo; echo "=== cases 32-34 (T-036, OD-21/OD-25): the PNPM pin, and the CHAOS file — the directions the literal anchor never read ==="
# OD-21, measured by QA on T-034 with a control: the anchor looped `nodePin`
# alone, so `ENV KINVARA_PNPM_HINT=11.25.0` in app.Dockerfile was exit 0 GATE
# PASS while the same shape with 24.20.0 was exit 1. `RUN corepack prepare
# pnpm@11.25.0 --activate` is the ordinary idiom, so the unguarded spelling is
# the one people write.
mut "$DF" 'ARG PNPM_VERSION' 'ARG PNPM_VERSION
ENV KINVARA_PNPM_HINT=11.25.0' && run_case "32 the literal PNPM pin in app.Dockerfile" FAIL
mut "$VERIFY" '        APP: core' '        QA_PNPM_HINT: 11.25.0
        APP: core' && run_case "33 the literal PNPM pin in compose.verify.yml" FAIL
mut "$CHAOS" 'services: {}' 'services:
  qa-chaos-literal:
    image: kinvara/qa:dev
    networks: [kinvara-int]
    mem_limit: 64m
    cpus: 0.25
    environment:
      QA_NODE_HINT: 24.20.0' && run_case "34 the literal NODE pin in compose.chaos.yml" FAIL

echo; echo "=== cases 35-36 (T-036, OD-22): a ports: key OUTSIDE compose.verify.yml ==="
# Measured before this fix: `ports: ['53999:3000']` on core in compose.yml left
# gate:app-images AND gate:egress-boundary at exit 0 and gate:pr at 9/9. Worse
# than a plain gap because OD-4 makes it silent — Docker drops publishing on an
# internal network with no error, so the line reads as working and takes effect
# the day a service gains a second network.
mut "$BASE" '  core:
    image:' "  core:
    ports: ['53999:3000']
    image:" && run_case "35 a ports: key on a BASE service (compose.yml)" FAIL
mut "$CHAOS" 'services: {}' "services:
  qa-chaos-ports:
    image: kinvara/qa:dev
    networks: [kinvara-int]
    mem_limit: 64m
    cpus: 0.25
    ports: ['53999:3000']" && run_case "36 a ports: key on a CHAOS addition" FAIL

echo; echo "=== cases 37-38 (T-036, OD-23): the \${KINVARA_*_VERSION:?} form dropped by ONE service of five ==="
# The clause was `verifyText.includes(...)` over the whole file, so it asserted
# "the file mentions the form somewhere", not "every build gets it": removing it
# from one of five services was exit 0, and only replacing all five turned it
# red. Measured in both variable directions.
SAFETY_BUILD='      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: safety-gw'
mut "$VERIFY" "$SAFETY_BUILD" '      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: safety-gw' && run_case "37 safety-gw alone drops the NODE ':?' (1 of 5)" FAIL
mut "$VERIFY" "$SAFETY_BUILD" '      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION}
        APP: safety-gw' && run_case "38 safety-gw alone drops the PNPM ':?' (1 of 5)" FAIL

echo; echo "=== cases 39-42 (T-036, OD-24): the budget, in the CHAOS file and for an ADDITION ==="
# `mem_limit: 4g` on chaos's core passed both gates where the identical key on
# compose.verify.yml's core failed — nine lines apart in the same table. A chaos
# run is when the 4-core box is under the MOST pressure.
mut "$CHAOS" 'services: {}' 'services:
  core:
    mem_limit: 4g' && run_case "39 a mem_limit raise on a CHAOS override of core" FAIL
mut "$CHAOS" 'services: {}' 'services:
  qa-chaos-fat:
    image: kinvara/qa:dev
    networks: [kinvara-int]
    mem_limit: 4g
    cpus: 0.25' && run_case "40 a CHAOS addition above the compose.yml ceiling" FAIL
mut "$CHAOS" 'services: {}' 'services:
  qa-chaos-unbounded:
    image: kinvara/qa:dev
    networks: [kinvara-int]' && run_case "41 a CHAOS addition with no mem_limit/cpus (§9.2)" FAIL
# The control that makes the three above mean something: a chaos sidecar sized
# inside the budget table is exactly what T-126 is supposed to be able to add.
mut "$CHAOS" 'services: {}' 'services:
  qa-chaos-ok:
    image: kinvara/qa:dev
    networks: [kinvara-int]
    mem_limit: 128m
    cpus: 0.25' && run_case "42 a CHAOS addition INSIDE the budget (must stay green)" PASS

echo; echo "=== cases 43-45 (T-036, OD-25): a SECOND Dockerfile, which §1's pin checks never read ==="
# QA's measurement on T-034, reproduced: docker/next.Dockerfile with a literal
# FROM tag and literal ARG defaults, pointed at by compose.verify.yml's web, was
# GATE PASS exit 0 — while the gate printed `dockerfiles checked 2` and
# `node pin (from .tool-versions) 24.20.0 — derived, not written down`.
repoint_web() {   # $1 = the dockerfile to point compose.verify.yml's web at
  mut "$VERIFY" '      dockerfile: docker/app.Dockerfile
      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: web' "      dockerfile: $1
      target: runtime
      args:
        NODE_VERSION: \${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: \${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: web"
}
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0
FROM node:24.20.0-alpine AS runtime
USER 10001:10001
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/x.mjs"]
DF
repoint_web docker/next.Dockerfile && run_case "43 a 2nd Dockerfile with literal pins (OD-25 verbatim)" FAIL
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION
ARG PNPM_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
ENV KINVARA_PNPM_HINT=11.25.0
USER 10001:10001
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/x.mjs"]
DF
repoint_web docker/next.Dockerfile && run_case "44 a 2nd Dockerfile, PNPM literal only" FAIL
# The control: the same second Dockerfile with nothing written down must PASS,
# or cases 43-44 would only be evidence that the gate dislikes new files.
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION
ARG PNPM_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
USER 10001:10001
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/x.mjs"]
DF
repoint_web docker/next.Dockerfile && run_case "45 the same 2nd Dockerfile, pins derived (must stay green)" PASS

echo; echo "=== cases 46-47 (T-036, OD-30/OD-32): a build: with NO target: — the last stage shipping unchecked ==="
# This is the route to a root safety-gw image that survived T-035. Delete ONE
# line and the service resolves to nothing; append any stage after `runtime` and
# docker builds root / docker-entrypoint.sh at PID 1 / Healthcheck=null, at gate
# exit 0 and gate:pr 9/9, with no BuildKit warning. What stopped it was that
# `runtime` HAPPENS to be last — an ordering accident nothing asserted, and
# T-034 § contract 6 instructs the very next ticket to append a stage.
NO_TARGET='      dockerfile: docker/app.Dockerfile
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: safety-gw'
mut "$VERIFY" "      dockerfile: docker/app.Dockerfile
$SAFETY_BUILD" "$NO_TARGET" && run_case "46 safety-gw's target: deleted (nothing appended)" FAIL
mut "$VERIFY" "      dockerfile: docker/app.Dockerfile
$SAFETY_BUILD" "$NO_TARGET" && cat >> "$DF" <<'DF'

FROM node:${NODE_VERSION}-alpine AS tail-stage
RUN true
DF
run_case "47 the same, plus a tail stage — the OD-32 route" FAIL

echo; echo "=== case 48 (T-036, OD-31): exec form is JSON, and only JSON ==="
# Anchored on the artefact, not on the regex: a built probe image with
# ENTRYPOINT ['/bin/sleep', '1'] reports Entrypoint=["/bin/sh","-c","['/bin/sleep', '1']"]
# — /bin/sh at PID 1, the exact thing the check exists to refuse — and
# `startsWith('[')` said yes to it.
mut "$DF" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
          "ENTRYPOINT ['node', '/srv/kinvara/app-runtime/entrypoint.mjs']" \
  && run_case "48 single-quoted ENTRYPOINT (shell form to Docker)" FAIL

echo; echo "=== case 49 (T-036, OD-28 family in THIS gate): a require-check reading raw text ==="
# Case 06 REPLACES the derivation; this comments it out, which is the direction
# a raw-text presence test is blind to. Found by the enumeration this ticket
# owns, in app-images.ts rather than in egress-boundary.ts.
mut scripts/svc '        KINVARA_NODE_VERSION="$(toolbox_require_pin nodejs)" || exit 1' \
                '        #KINVARA_NODE_VERSION="$(toolbox_require_pin nodejs)" || exit 1' \
  && run_case "49 svc's pin derivation COMMENTED OUT (cf. 06)" FAIL

echo; echo "=== cases 50-51 (T-036): two holes found by ATTACKING this ticket's own fix, not by running it ==="
# 50. Compose's SHORT FORM for build: is a string, and `if (!isRecord(build))
#     continue` skipped such a service entirely — no Dockerfile derived, no
#     image contract, no pin check. `build: ..` is a spelling compose accepts,
#     not a construction. Same family shape, one level down from OD-25.
cat > docker/rogue.Dockerfile <<'DF'
FROM alpine:3.20 AS runtime
USER root
ENTRYPOINT /nope
DF
mut "$CHAOS" 'services: {}' 'services:
  qa-chaos-shortform:
    image: kinvara/qa:dev
    networks: [kinvara-int]
    mem_limit: 64m
    cpus: 0.25
    build: ..' && run_case "50 an overlay service using compose's SHORT build: form" FAIL
rm -f docker/rogue.Dockerfile
# 51. compose.dev.yml can point a service at a Dockerfile too. It is exempt from
#     the no-ports rule (its fixed ports ARE the documented exception) and is
#     NOT exempt from the image contract — the images the dev stack runs are the
#     same images. Nothing in it declares a build: today, which is why closing
#     this direction costs nothing.
cat > docker/rogue.Dockerfile <<'DF'
ARG NODE_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
RUN echo "pnpm install" > /dev/null
USER root
ENTRYPOINT node /nope.mjs
DF
mut "$DEV" 'services:' 'services:
  qa-dev-rogue:
    image: kinvara/qa-dev-rogue:dev
    networks: [kinvara-int]
    build:
      context: ..
      dockerfile: docker/rogue.Dockerfile
      target: runtime
    pull_policy: build' && run_case "51 a build: in compose.dev.yml pointing at a rogue image" FAIL
rm -f docker/rogue.Dockerfile

echo; echo "=== case 52 (T-036): the placeholder rule read the LABEL SET, which an overlay build can sidestep ==="
# Same shape as T-034 QA round 2 found in §6: an overlay service that builds an
# image and is simply not labelled in compose.yml contributed an app nothing
# read. The rule now unions the label set with every APP a build actually
# passes, so a new app reaches it however it was declared.
mkdir -p apps/qa-newapp/src
printf '{ "name": "@kinvara/qa-newapp", "private": true, "type": "module", "version": "0.0.0" }\n' > apps/qa-newapp/package.json
printf 'export const x = 1;\n' > apps/qa-newapp/src/index.ts
# QA-F2: this addition originally declared no mem_limit and no cpus, so the
# gate red on THREE problems and the case would have been exit=1 even if the
# union claim it is cited for were false. The budget keys are here so the case
# isolates the property § contract 7 names it as the falsifying test for.
mut "$VERIFY" 'services:' 'services:
  qa-newapp:
    image: kinvara/qa-newapp:dev
    networks: [kinvara-int]
    mem_limit: 128m
    cpus: 0.25
    build:
      context: ..
      dockerfile: docker/app.Dockerfile
      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: qa-newapp
    pull_policy: build' && run_case "52 an UNLABELLED overlay build of an app with src/, no start" FAIL

echo; echo "=== cases 53-57 (T-036 rework, OD-33): a build: in docker/compose.yml — the file BUILD_FILES did not read ==="
# QA-F1. `docker/compose.yml` points two services at Dockerfiles today, so the
# first version of BUILD_FILES was false on the delivered tree — and a build:
# declared there was read by NOTHING. QA added a target-less build: to
# compose.yml's safety-gw plus an appended tail stage, got exit 0, and built the
# image: User=[], Entrypoint=["docker-entrypoint.sh"], Healthcheck=null,
# 167,508,709 B — OD-32's figure to the byte. Adding -f compose.verify.yml
# restores target: runtime, so a --verify evidence run is blind to it and every
# other route is not.
SAFETY_BASE='  safety-gw:
    image: kinvara/safety-gw:dev'
mut "$BASE" "$SAFETY_BASE" '  safety-gw:
    image: kinvara/safety-gw:dev
    build:
      context: ..
      dockerfile: docker/app.Dockerfile' \
  && run_case "53 a target-less build: on compose.yml's safety-gw (OD-33)" FAIL
mut "$BASE" "$SAFETY_BASE" '  safety-gw:
    image: kinvara/safety-gw:dev
    build:
      context: ..
      dockerfile: docker/app.Dockerfile' && cat >> "$DF" <<'DF'

FROM node:${NODE_VERSION}-alpine AS tail-stage
RUN true
DF
run_case "54 the same, plus a tail stage — QA's exact two-part edit" FAIL
# The narrow control that isolates the FILE rather than the mutation: the same
# literal string was exit=1 in compose.dev.yml (a build file) and exit=0 in
# compose.yml (the base file).
# NOT via a second `environment:` key — that made compose.yml a duplicate-key
# document and the case red on a YAML parse error instead of on the pin, which
# is QA-F2's defect in a case written to fix QA-F2. It goes INSIDE the existing
# environment block, and the failure message is checked to name the pin.
mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: ${NODE_ENV:-development}
      QA_NODE_HINT: 24.20.0' && run_case "55 a live literal NODE pin in compose.yml" FAIL
# QA's second shape, for width: a NEW app service in the base file, with every
# §1 and §6 property violated at once. Before the fix, all of them were silent.
cat > docker/rogue.Dockerfile <<'DF'
ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0
FROM node:24.20.0-alpine AS runtime
RUN pnpm i --prod
USER root
ENTRYPOINT node /nope.mjs
DF
mut "$BASE" '  core:
    image:' '  qa-base-rogue:
    image: kinvara/qa-base-rogue:dev
    profiles: [api]
    networks: [kinvara-int]
    mem_limit: 64m
    cpus: 0.25
    build:
      context: ..
      dockerfile: docker/rogue.Dockerfile
  core:
    image:' && run_case "56 a NEW app service in compose.yml, no target, literal pins" FAIL
rm -f docker/rogue.Dockerfile
# THE EXEMPTION IS SELF-CLOSING, and this is the case that proves it rather
# than asserting it. postgres.Dockerfile is one of the two legitimate
# target-less builds on this tree; it is exempt only because it has exactly ONE
# stage, so "the last stage" and "the only stage" are the same stage. Append a
# second and the ordering risk appears — and the gate reds in the same instant,
# with no rule change and no list to maintain.
cat >> "$PGDF" <<'DF'

FROM alpine:3.20 AS qa-appended
RUN true
DF
run_case "57 a 2nd stage appended to a single-stage exempt Dockerfile" FAIL

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
