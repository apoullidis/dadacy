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
cp "$VERIFY" "$BK/verify"; cp "$CHAOS" "$BK/chaos"; cp "$BASE" "$BK/base"; cp "$DEV" "$BK/dev"; cp "$DF" "$BK/df"; cp "$PGDF" "$BK/pgdf"; cp scripts/svc "$BK/svc"; cp apps/core/package.json "$BK/corepkg"; cp apps/safety-gw/package.json "$BK/sgwpkg"
restore() {
  cp "$BK/verify" "$VERIFY"; cp "$BK/chaos" "$CHAOS"; cp "$BK/base" "$BASE"; cp "$BK/dev" "$DEV"; cp "$BK/df" "$DF"; cp "$BK/pgdf" "$PGDF"; cp "$BK/svc" scripts/svc; cp "$BK/corepkg" apps/core/package.json
  rm -rf apps/core/src apps/qa-newapp docker/next.Dockerfile docker/rogue.Dockerfile
  # T-037: the OD-36 / OD-37 / OD-38 cases. `chaos-extra.yml` is named
  # deliberately — it is the file `tech-lead` cited to reject a
  # `docker/compose*.yml` glob as the fix for OD-37.
  rm -rf docker/rogue-single.Dockerfile docker/rogue-two-stage.Dockerfile \
         docker/compose.extra.yml docker/chaos-extra.yml
  # T-037 rework (OD-39) and the folded-in attack round.
  rm -rf apps/qa-attack apps/qa-x apps/safety-gw/package.json.t037 docker/zz-thing.yaml
  [[ -f "$BK/sgwpkg" ]] && cp "$BK/sgwpkg" apps/safety-gw/package.json
  return 0
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
#
# T-130 (d1): an optional THIRD argument names the REASON a FAIL case exists
# for — a substring the gate's failure list must contain. A refusal for some
# other reason is then `FAIL-OTHER`, which equals no expectation, so a case
# cannot be satisfied by an unrelated failure its mutation happened to cause.
# "Refused", "refused for the reason cited", "crashed" and "did nothing" are
# four distinguishable outcomes; the last is `mut`'s HARNESS ERROR.
run_case() {
  local label="$1" expect="$2" reason="${3:-}" out code
  out="$(node "$GATE_IMPL" 2>&1)"; code=$?
  local verdict
  if [[ $code -eq 0 && "$out" == *"GATE PASS  gate:app-images"* ]]; then verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"GATE FAIL  gate:app-images"* ]]; then
    verdict=FAIL
    [[ -n "$reason" && "$out" != *"$reason"* ]] && verdict=FAIL-OTHER
  else verdict="CRASH"; fi
  ran=$((ran+1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad+1)); }
  printf '%s %-52s exit=%d  %-5s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL* ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-150 | sed 's/^/       /'
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
# This is A route to a root safety-gw image that survived T-035 — not THE route.
# [CORRECTED BY T-037, per its brief item (e). The original sentence read "the
# route", the definite article OE-10 WITHDREW rather than restated: it is an
# absence claim over an unenumerated space, and three reviewers found three
# different routes (OD-32, OD-33, OD-36). The orchestrator withdrew it in
# platform-infrastructure.md and in T-036's contract but may not edit app/
# (PROTOCOL §10), so the live copy was named in T-037's brief and is corrected
# here.] Delete ONE
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

echo; echo "=== case 58 (T-036 rework): PIN_ARGS is a second enumeration of .tool-versions ==="
# Found by the scope audit, not by a report. PIN_ARGS lists two pins under the
# sentence "the toolchain pins that reach an image build" — true today, and
# checked against nothing, which is OD-1's shape. If .tool-versions grew a pin
# an application Dockerfile consumed, every §1 rule would skip it in silence.
mut "$DF" 'ARG PNPM_VERSION' 'ARG TERRAFORM_VERSION
ARG PNPM_VERSION' && run_case "58 an app Dockerfile takes a pin PIN_ARGS omits" FAIL


echo; echo "=== cases 59-63 (T-037, OD-36): a labelled service DEMOTED out of the application set, in EACH composed file ==="
# THE DIRECTION THAT WAS MISSED. T-036 closed two routes to a root,
# healthcheck-less safety-gw image by enumerating them (OD-32: a build with no
# target:; OD-33: a build in a file the list omitted). tech-lead then found a
# third on T-036's own branch: point compose.yml's safety-gw at a SINGLE-STAGE,
# NON-APPLICATION Dockerfile and three checks decline it in sequence, each
# correctly by its own rule — the target rule exempts a single-stage file,
# isApplicationBuild is false so the image contract skips it, and row L is
# satisfied by the untouched overlay. Built: User=[root], a shell at PID 1,
# Healthcheck=null, gate:pr 9/9 exit 0 (OD-36).
#
# Enumerating a fourth route would have been the same mistake a fourth time, so
# T-037 inverts it: NO COMPOSED FILE MAY DECLARE A NON-APPLICATION BUILD FOR A
# SERVICE IN THE APPLICATION SET. These cases are that universal, instantiated
# once per composed file, which is what a universal has to be evidenced by.
mk_single() {   # the demoted build's Dockerfile; restore() removes it after each case
  cat > docker/rogue-single.Dockerfile <<'DF'
FROM node:24-alpine
RUN echo "no workspace install, no APP arg — nothing here says application image"
ENTRYPOINT docker-entrypoint.sh
DF
}
DEMOTED_BUILD='    build:
      context: ..
      dockerfile: docker/rogue-single.Dockerfile'
# 59. compose.yml — OD-36 verbatim, tech-lead's own edit.
mk_single && mut "$BASE" "$SAFETY_BASE" "  safety-gw:
    image: kinvara/safety-gw:dev
$DEMOTED_BUILD" && run_case "59 safety-gw demoted in compose.yml (OD-36 verbatim)" FAIL
# 60. compose.verify.yml. Recorded as expected FAIL and explicitly NOT claimed
#     as a differential: row L already demanded an APP build arg of every
#     labelled service in THIS file, and an APP arg is itself one of the two
#     things that make a build an application build — so a demotion here was
#     exit 1 at main too, for a different reason. It is here because a
#     universal has to hold in every composed file, and a case that is red for
#     one reason at main and two here is still the case that says so.
mk_single && mut "$VERIFY" '  safety-gw:
    build:
      context: ..
      dockerfile: docker/app.Dockerfile
      target: runtime' "  safety-gw:
$DEMOTED_BUILD
    x-unused:" && run_case "60 safety-gw demoted in compose.verify.yml" FAIL
# 61. compose.chaos.yml — T-126's file, empty today.
mk_single && mut "$CHAOS" 'services: {}' "services:
  safety-gw:
$DEMOTED_BUILD" && run_case "61 safety-gw demoted in compose.chaos.yml" FAIL
# 62. compose.dev.yml — the shared stack. Exempt from the no-ports rule and
#     from nothing else.
mk_single && mut "$DEV" '  safety-gw:
    networks: [kinvara-int, kinvara-pub]' "  safety-gw:
$DEMOTED_BUILD
    networks: [kinvara-int, kinvara-pub]" && run_case "62 safety-gw demoted in compose.dev.yml" FAIL
# 63. THE CONTROL THAT MAKES 59-62 MEAN SOMETHING. The identical single-stage
#     non-application build, on a service that is NOT in the application set,
#     must stay green — otherwise these cases would only show that the gate
#     dislikes a small Dockerfile. This is also why postgres and fake-telephony
#     keep their target-less non-application builds without being named
#     anywhere: the rule is keyed on the SERVICE SET, not on the build.
mk_single && mut "$BASE" '  valkey:
    image:' "  qa-sidecar:
    image: alpine:3.20
    profiles: [cache]
    networks: [kinvara-int]
    mem_limit: 64m
    cpus: 0.25
$DEMOTED_BUILD
  valkey:
    image:" && run_case "63 the SAME build on an unlabelled service (must stay green)" PASS

echo; echo "=== cases 64-65 (T-037, OD-38): the anchor the universal keys on, removed by the same edit that exploits it ==="
# tech-lead, measured on 93969b3 while confirming T-037's brief: declaredByLabel
# is read out of docker/compose.yml — THE SAME FILE AN ATTACKER EDITS — and its
# only self-check fired when the set was EMPTY. Delete safety-gw's two
# io.kinvara.built-by lines and nothing else: the gate printed
# `services labelled built-by T-018  4: core worker web admin` and exited 0.
# Then, with the label still gone, delete safety-gw's ENTIRE build: stanza from
# compose.verify.yml: still exit 0 — where case 07, the same deletion for core
# with its label intact, is exit 1. Row L's own trigger was defeated by first
# removing the label, and row L, the placeholder rule and the new universal
# went silent for that service together. PROTOCOL §5.1: a check must not be
# derived from the same reading as the thing it checks. Membership is now
# asserted against apps/*/package.json.
LABEL_LINES="    labels:
      io.kinvara.built-by: 'T-018'
      io.kinvara.built-by-title: 'the application Dockerfiles + the verify overlay'
    networks: [kinvara-int]
    expose:
      - '3010'"
NO_LABEL_LINES="    networks: [kinvara-int]
    expose:
      - '3010'"
VERIFY_SAFETY_STANZA='  safety-gw:
    build:
      context: ..
      dockerfile: docker/app.Dockerfile
      target: runtime
      args:
        NODE_VERSION: ${KINVARA_NODE_VERSION:?derived from .tool-versions by scripts/svc}
        PNPM_VERSION: ${KINVARA_PNPM_VERSION:?derived from .tool-versions by scripts/svc}
        APP: safety-gw
        APP_KIND: http
        APP_PORT: '"'"'3010'"'"'
    pull_policy: build
'
mut "$BASE" "$LABEL_LINES" "$NO_LABEL_LINES" \
  && run_case "64 safety-gw built-by labels deleted from compose.yml" FAIL
mut "$BASE" "$LABEL_LINES" "$NO_LABEL_LINES" \
  && mut "$VERIFY" "$VERIFY_SAFETY_STANZA" '' \
  && run_case "65 the same, PLUS safety-gw build: deleted from verify" FAIL
# 66. THE RESIDUE OF 64, probed rather than assumed: delete the label AND the
#     whole service from compose.yml. This is expected FAIL on the gate at main
#     as well — the overlay ADDITION rules catch it, because verify's safety-gw
#     then has no base definition to inherit a budget (here) or a network
#     (gate:egress-boundary) from. Recorded as a BOUND, not as a differential:
#     it is what stops "delete the label" from becoming "delete both".
SAFETY_BASE_HEAD="  safety-gw:
    image: kinvara/safety-gw:dev
    profiles: ['safety']"
mut "$BASE" "$LABEL_LINES" "$NO_LABEL_LINES" \
  && mut "$BASE" "$SAFETY_BASE_HEAD" "  safety-gw-removed:
    image: kinvara/safety-gw:dev
    profiles: ['safety']" \
  && run_case "66 label AND base service both removed (a bound)" FAIL

echo; echo "=== cases 67-71 (T-037, OD-37): the composed file set is DERIVED from scripts/svc, not listed ==="
# THE SAME SHAPE ONE LEVEL UP, and the claim that justified keeping the list
# hand-written: T-036 § Evidence 9a/10 said a fifth compose file "fails
# closed". It does not — `does not exist` fires on a LISTED file MISSING, never
# on one APPEARING — so a fifth file was read by NOTHING in either gate.
# Measured by tech-lead on 93969b3 and reproduced on this branch before the fix.
# The fix derives the set from scripts/svc's own compose_files_for(), because
# that function is what decides which files reach a ticket-scoped project
# (T-016 § contract 2). NOT a docker/compose*.yml glob: that is the same
# enumeration in another spelling, which is exactly why case 68's file is
# called chaos-extra.yml.
CHAOS_F_LINE='    [[ "${USE_CHAOS:-0}" -eq 1 ]] && COMPOSE_FILES+=(-f "${CHAOS_FILE}")'
write_extra_overlay() {   # $1 = the compose file body; wires it in behind a flag
  printf '%s\n' "$1" > docker/compose.extra.yml
  mut scripts/svc "$CHAOS_F_LINE" "$CHAOS_F_LINE
    [[ \"\${USE_EXTRA:-0}\" -eq 1 ]] && COMPOSE_FILES+=(-f \"\${DOCKER_DIR}/compose.extra.yml\")"
}
cat > docker/rogue-two-stage.Dockerfile <<'DF'
ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0
FROM node:24.20.0-alpine AS builder
RUN pnpm i --prod
FROM node:24.20.0-alpine AS tail
USER root
ENTRYPOINT node /nope.mjs
DF
# 67. tech-lead's exact fifth file: a target-less two-stage application build,
#     literal pins in both directions, a host port and mem_limit: 8g. Every
#     rule T-036 added was silent in it.
write_extra_overlay "services:
  rogue:
    image: kinvara/rogue:dev
    profiles: [api]
    networks: [kinvara-int]
    ports:
      - '53999:3000'
    mem_limit: 8g
    cpus: 2.0
    build:
      context: ..
      dockerfile: docker/rogue-two-stage.Dockerfile
      args:
        NODE_VERSION: 24.20.0
        PNPM_VERSION: 11.25.0
        APP: safety-gw" && run_case "67 a FIFTH compose file, wired into svc's -f assembly" FAIL
# 68. The other direction, which a derivation from svc alone cannot see: a
#     compose file that exists and is composed by NOTHING. It reads as live and
#     is checked by nothing. Named chaos-extra.yml on purpose.
cat > docker/chaos-extra.yml <<'YML'
services:
  rogue:
    image: kinvara/rogue:dev
    ports:
      - '53999:3000'
YML
run_case "68 a compose file svc composes from nothing" FAIL
# 69. And the narrowing edit: delete one -f from the assembly and the file it
#     named stays on disk, unread by these gates and applied by no bring-up. At
#     main both gates read compose.chaos.yml from a constant, so this was
#     invisible — and it is the edit that would otherwise let someone move the
#     new derivation out from under a file they then rewrite.
mut scripts/svc "$CHAOS_F_LINE" '    : # the chaos overlay, removed from the assembly' \
  && run_case "69 an -f removed from svc, the file left on disk" FAIL
# 70. THE CONTROL FOR 67-69: a fifth compose file that is wired in AND
#     well-formed must stay green, or those cases would only show that the gate
#     dislikes a fifth file.
write_extra_overlay "services:
  qa-extra-sidecar:
    image: alpine:3.20
    profiles: [api]
    networks: [kinvara-int]
    mem_limit: 128m
    cpus: 0.25" && run_case "70 a well-formed fifth compose file, wired in (must stay green)" PASS
rm -f docker/rogue-two-stage.Dockerfile
# 71. The derivation itself must fail closed. If scripts/svc no longer states
#     what a project is composed from, this gate has no scope it can establish
#     — and an unknown scope is a FAILURE, never a smaller one. This is the
#     property that stops OD-37's fix from becoming OD-37's shape again.
mut scripts/svc 'compose_files_for() {' 'compose_files_for_renamed() {' \
  && run_case "71 svc's compose_files_for() renamed away (fail closed)" FAIL


echo; echo "=== cases 72-77 (T-037 rework, OD-39): the gate's PARSER differed from compose's, and nothing enumerated the divergences ==="
# THE FOURTH ROUTE, and the first one that is not a scope gap. All three parse
# sites were `parseYaml(text)` on yaml@2.8.1's DEFAULTS — YAML 1.2, where `<<`
# is an ORDINARY KEY. Compose resolves merge keys. So a build: reached through
# an x- fragment was invisible to every per-build rule while compose built it:
# gate:app-images exit 0, gate:pr 9/9, the summary still printing the
# clean-tree `builds read 7`, and the artefact at User=[], a shell at PID 1,
# Healthcheck=null, 167,508,709 B (tech-lead, decisions.md OD-39).
#
# The family is NOT `<<`. T-017 §R3 measured this exact divergence five days
# earlier and found gate:egress-boundary fails closed on it — but only via an
# invariant derived from outside the parse (every service has image: or
# build:). OD-39 is the shape that SATISFIES that invariant while being
# misread, and app-images.ts had no equivalent net. So the fix is one shared
# reader (lib/compose-parse.ts) that enumerates the divergence class: merge
# keys MODELLED, a 1.1-vs-1.2 SCHEMA disagreement and each unmodelled compose
# feature MEASURED so far FAIL CLOSED. (T-130 rework 1: this read "every other
# YAML 1.1/1.2 disagreement", which was false — both readings share one YAML
# 1.2 lexer, so a SYNTAX difference is read identically twice; OD-43 was one.
# The list is not exhaustive; the reader's header says which members exist.)
MERGE_BUILD_FRAGMENT="x-t037-frag: &t037_frag
  build:
    context: ..
    dockerfile: docker/rogue-single.Dockerfile
"
# 72. OD-39 verbatim: a build: merged into compose.yml's safety-gw.
mk_single && mut "$BASE" 'services:' "$MERGE_BUILD_FRAGMENT
services:" \
  && mut "$BASE" "$SAFETY_BASE" "  safety-gw:
    image: kinvara/safety-gw:dev
    <<: *t037_frag" \
  && run_case "72 a build: MERGED into compose.yml's safety-gw (OD-39)" FAIL "escapes all of them at once"
# 73. OD-39's second half, which falsifies T-036 § contract 4 row 1 as well:
#     the same key hides a base-file ports: from the no-host-port rule.
mut "$BASE" 'services:' "x-t037-expose: &t037_expose
  ports:
    - '53999:3010'

services:" \
  && mut "$BASE" "$SAFETY_BASE" "  safety-gw:
    image: kinvara/safety-gw:dev
    <<: *t037_expose" \
  && run_case "73 a ports: MERGED into a base service (OD-39, T-036 §4 row 1)" FAIL "declares ports:"
# 74. THE CONTROL for 72-73, and it is the one that says merge keys are
#     MODELLED rather than refused: a fragment merged in that violates nothing
#     must stay GREEN. Refusing `<<` outright would pass 72-73 for the wrong
#     reason and would break a documented Compose Spec feature.
mut "$BASE" 'services:' "x-t037-ok: &t037_ok
  stop_grace_period: 30s

services:" \
  && mut "$BASE" "$SAFETY_BASE" "  safety-gw:
    image: kinvara/safety-gw:dev
    <<: *t037_ok" \
  && run_case "74 a harmless <<: merge (must stay green — modelled, not refused)" PASS
# 75. CLASS A3 (T-130's numbering), derived rather than enumerated: a file
#     that means two different things under the 1.1 and 1.2 SCHEMAS is refused
#     (value resolution only — both readings share one YAML 1.2 lexer; the
#     SYNTAX difference OD-43 found is cases 124-127, T-130 rework 1), because
#     no reading of it can then be trusted to be compose's. `on` is a boolean
#     in 1.1 and the string "on" in 1.2. The repair is to quote it.
#     (T-130: 72-78 now assert their REASON as well as their verdict.)
mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: ${NODE_ENV:-development}
      QA_T037_FLAG: on' && run_case "75 a scalar YAML 1.1 and 1.2 read differently" FAIL "DIFFERENT under YAML 1.1 and YAML 1.2"
# 76. CLASS A4: a Compose Spec tag no YAML reader resolves. At 1.2 defaults it
#     was dropped to its default value with a console warning and NO gate
#     failure — a construct the gate silently did not model.
mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: !reset ${NODE_ENV:-development}' \
  && run_case "76 an unresolvable !reset tag (fail closed)" FAIL "could not resolve a construct"
# 77. CLASS B1/B2: extends: and include:. T-017 §R5 ruled extends: a hard
#     failure in gate:egress-boundary; app-images.ts never had it (T-039
#     § contract 0 row C: exit 0 here, exit 1 there, at the same commit).
#     Both readers get it now, from the shared reader.
mut "$BASE" "$SAFETY_BASE" '  safety-gw:
    image: kinvara/safety-gw:dev
    extends:
      service: core' && run_case "77 extends: on a base service (fail closed)" FAIL "uses 'extends'"
mut "$BASE" 'services:' 'include:
  - docker/compose.verify.yml

services:' && run_case "78 a top-level include: (fail closed)" FAIL "top-level 'include:'"

echo; echo "=== cases 79-84 (T-037): the attack round, folded into the suite so a reviewer can re-run it ==="
# These were an ad-hoc script in T-037 cycle 0's evidence and could not be
# re-executed by a reviewer (tech-lead had to re-derive both properties from
# its own trees). They are cases now.
# 79. The universal reaches a service demoted inside a FIFTH wired file.
mk_single && printf '%s\n' "services:
  safety-gw:
    build:
      context: ..
      dockerfile: docker/rogue-single.Dockerfile" > docker/compose.extra.yml \
  && mut scripts/svc "$CHAOS_F_LINE" "$CHAOS_F_LINE
    [[ \"\${USE_EXTRA:-0}\" -eq 1 ]] && COMPOSE_FILES+=(-f \"\${DOCKER_DIR}/compose.extra.yml\")" \
  && run_case "79 safety-gw demoted inside a fifth wired compose file" FAIL
# 80. An empty APP arg does not buy the application-build exemption.
mk_single && mut "$BASE" "$SAFETY_BASE" '  safety-gw:
    image: kinvara/safety-gw:dev
    build:
      context: ..
      dockerfile: docker/rogue-single.Dockerfile
      args:
        APP: ""' && run_case "80 demotion with an empty APP: build arg" FAIL
# 81. A NEW labelled app with a demoted build reaches the universal too.
mk_single && mkdir -p apps/qa-attack \
  && printf '{"name":"@kinvara/qa-attack","private":true,"version":"0.0.0","type":"module"}\n' > apps/qa-attack/package.json \
  && mut "$BASE" '  valkey:
    image:' "  qa-attack:
    image: kinvara/qa-attack:dev
    profiles: [cache]
    networks: [kinvara-int]
    mem_limit: 64m
    cpus: 0.25
    labels:
      io.kinvara.built-by: 'T-018'
$DEMOTED_BUILD
  valkey:
    image:" && run_case "81 a new labelled app with a demoted build" FAIL
# 82. THE DEEPEST RESIDUE OF OD-38: delete the label AND the app's
#     package.json, then demote. What refuses it is a THIRD reading —
#     compose.verify.yml still passes APP: safety-gw, and the placeholder rule
#     requires apps/<APP>/package.json to exist. A different file from the two
#     that were edited, which is what PROTOCOL §5.1 asks for.
mk_single && mut "$BASE" "$LABEL_LINES" "$NO_LABEL_LINES
$DEMOTED_BUILD" \
  && mv apps/safety-gw/package.json apps/safety-gw/package.json.t037 \
  && run_case "82 label AND apps/safety-gw/package.json gone, then demoted" FAIL
cp "$BK/sgwpkg" apps/safety-gw/package.json
# 83. A straggler with a .yaml extension and a name no compose*.yml glob matches.
cat > docker/zz-thing.yaml <<'YML'
services:
  rogue: { image: alpine:3.20 }
YML
run_case "83 docker/zz-thing.yaml, composed by nothing" FAIL
rm -f docker/zz-thing.yaml
# 84. THE STATED BOUND, recorded as an expected PASS so it is visible in the
#     gate's own output rather than only in prose: a compose file OUTSIDE
#     docker/ that scripts/svc composes from nothing is read by neither gate.
#     It reaches no ticket-scoped project — svc cannot pass a file its assembly
#     does not name — and wiring it in is case 67.
mkdir -p infra && cat > infra/compose.rogue.yml <<'YML'
services:
  rogue: { image: alpine:3.20, ports: ['53999:3000'] }
YML
run_case "84 infra/compose.rogue.yml — the stated bound (expected PASS)" PASS
rm -f infra/compose.rogue.yml; rmdir infra 2>/dev/null


echo; echo "=== cases 85-87 (T-037 rework, QA-N2): the three combinations of a half-declared new app ==="
# § contract 6 step 2 used to say "gate:app-images will tell you which of those
# you missed". QA found that missing BOTH is green; measuring all three showed
# missing the LABEL alone is green too, so the sentence was wrong in two
# directions rather than one. These cases put all three outcomes in the gate's
# own output, so the published scope is re-executable rather than asserted.
NEWAPP='{"name":"@kinvara/qa-x","private":true,"version":"0.0.0","type":"module"}'
mk_qa_x() { mkdir -p apps/qa-x && printf '%s\n' "$NEWAPP" > apps/qa-x/package.json; }
# 85. Neither half. GREEN, and correctly: an apps/ directory no composed file
#     references is a package, not a service, and nothing builds it.
mk_qa_x && run_case "85 a new apps/* declared in no compose file (green)" PASS
# 86. The label without the overlay build. RED — row L, naming the missing build.
mk_qa_x && mut "$BASE" '  valkey:
    image:' "  qa-x:
    image: kinvara/qa-x:dev
    profiles: [cache]
    networks: [kinvara-int]
    mem_limit: 64m
    cpus: 0.25
    labels:
      io.kinvara.built-by: 'T-018'
  valkey:
    image:" && run_case "86 the label without an overlay build (row L)" FAIL
# 87. The overlay build without the label. GREEN, and correctly: nothing needs
#     the label to reach this build — the image contract reads it through the
#     derived Dockerfile set and the universal reads it through apps/*.
mk_qa_x && mut "$VERIFY" 'services:' 'services:
  qa-x:
    image: kinvara/qa-x:dev
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
        APP: qa-x
    pull_policy: build' && run_case "87 an overlay build without the label (green)" PASS

echo; echo "=== case 88 (T-130 a0, TL-F2): a MULTI-DOCUMENT composed file FAILS CLOSED — T-039 § contract 0 row A, as a guard ==="
# T-039 § contract 0 row A — "a multi-document compose file fails closed" — is
# the property OE-11 made the condition of landing T-039, and until this case
# NOTHING in the repository asserted it: no committed case wrote a `---`. It
# was backed by probes and review measurements, which gate:pr never re-runs.
# The exposure is recorded, not hypothetical (decisions.md OD-41): T-037
# cycle 1 replaced parse() — which THROWS above one document — with
# parseDocument(), which reads the FIRST document only, while `docker compose`
# merges EVERY document. On that tree one appended document gave safety-gw a
# single-stage non-application build at gate:pr 9/9, and this suite was 91/91.
# This case was committed BEFORE T-130 touched the reader, so the moment the
# reader stops refusing a second document, the suite says so. The REASON is
# asserted too: a red for some other cause is not this guard.
append_doc() {   # $1 = file, $2 = body of a SECOND YAML document; asserts it landed
  local before after
  before="$(grep -c '^---$' "$1")"
  printf -- '---\n%s\n' "$2" >> "$1"
  after="$(grep -c '^---$' "$1")"
  [[ "$after" -eq $((before + 1)) ]] \
    || { echo "   HARNESS ERROR (no document appended to $1)"; harness=$((harness+1)); return 1; }
}
mk_single && append_doc "$BASE" "services:
  safety-gw:
    build:
      context: ..
      dockerfile: docker/rogue-single.Dockerfile" \
  && run_case "88 OD-41: 2nd document demotes compose.yml safety-gw" FAIL "multiple documents"

echo; echo "=== cases 100-115 (T-130, OD-41): a SECOND DOCUMENT in EACH composed file, carrying each thing it could hide ==="
# Case 88 is one file and one shape. OD-41 is not a compose.yml defect: every
# composed file goes through the same reader, and compose merges every document
# of every one of them. So: every composed file x every rule a second document
# could hide from — a demoted build (T-039 § contract 1), a host port (T-036
# § contract 4), a service on the DEFAULT bridge (OD-12) and a raised budget
# (T-036 § contract 5). Each must be refused FOR THE DOCUMENT COUNT — while a
# second document is refused outright, no content rule ever sees it, so the
# reason is what these cases test. Judged by the gate as at 8b4ef80 they are
# NOT a differential (parse() threw there too); judged by T-037 cycle 1's
# reader they are the regression.
V_BUILD="services:
  safety-gw:
    build:
      context: ..
      dockerfile: docker/rogue-single.Dockerfile"
V_PORTS="services:
  safety-gw:
    ports: ['53999:3010']"
V_BRIDGE="services:
  qa-rogue:
    image: alpine:3.20
    networks: [default]
    mem_limit: 128m
    cpus: 0.25"
V_BUDGET="services:
  core:
    mem_limit: 4g"
n=100   # 89-99 are deliberately unused: 99 is this suite's "tree restored" sentinel
for f in "$BASE" "$DEV" "$VERIFY" "$CHAOS"; do
  for v in BUILD PORTS BRIDGE BUDGET; do
    body="V_$v"
    mk_single && append_doc "$f" "${!body}" \
      && run_case "$n 2nd document in ${f#docker/}: $v" FAIL "multiple documents"
    n=$((n + 1))
  done
done

echo; echo "=== cases 116-123 (T-130): the rest of the parse-layer class, each in the direction that was missed ==="
prepend() {   # $1 = file, $2 = text to put before line 1; asserts it landed
  local first="${2%%$'\n'*}"
  { printf '%s\n' "$2"; cat "$1"; } > "$1.t130" && mv "$1.t130" "$1"
  [[ "$(head -1 "$1")" == "$first" ]] \
    || { echo "   HARNESS ERROR (nothing prepended to $1)"; harness=$((harness+1)); return 1; }
}
# 116. THE CONTROL for 88 and 100-115: the '---' TOKEN is not the property. One
#      document that happens to START with '---' must stay green; a rule keyed
#      on the marker rather than on the document count would red it.
prepend "$BASE" '---' && run_case "116 ONE document with a leading --- (must stay green)" PASS
# 117. A5, found by T-130 attacking cycle 1's "never picks a version" claim: a
#      %YAML directive overrides the reader's version option, so BOTH readings
#      become that version and the 1.1/1.2 comparison compares a reading with
#      itself. Planted WITH a scalar the two versions read differently, so the
#      case shows the comparison being bypassed, not merely a directive present.
prepend "$BASE" '%YAML 1.1
---' && mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: ${NODE_ENV:-development}
      QA_T130_FLAG: on' \
  && run_case "117 %YAML 1.1 + a 1.1/1.2-divergent scalar" FAIL "%YAML directive"
# 118. A8, T-039 QA8 isolated by T-130: a self-referential alias. This gate was
#      GATE PASS on it while gate:egress-boundary crashed with no banner — the
#      two gates disagreed on the same file.
mut "$BASE" 'services:' 'services:
  x-t130-self: &t130_self
    image: alpine:3.20
    networks: [kinvara-int]
    self: *t130_self' && run_case "118 a self-referential alias" FAIL "refers to itself"
# 119. A9: the same through a MERGE key makes toJS() itself throw. Any
#      exception inside the read is a reported problem now, never a crash.
mut "$BASE" 'services:' 'services:
  x-t130-selfm: &t130_selfm
    image: alpine:3.20
    networks: [kinvara-int]
    self:
      <<: *t130_selfm' && run_case "119 a self-referential MERGE (toJS throws)" FAIL "could not read it"
# 120-122. OD-42, the straggler scan, both directions. It caught parse()'s
#          throw and `continue`d, so a TWO-document compose file svc composes
#          from nothing was silent where the same services in ONE document
#          are reported (case 68).
cat > docker/chaos-extra.yml <<'YML'
x-note: a straggler whose services are in its SECOND document
---
services:
  rogue:
    image: kinvara/rogue:dev
    ports:
      - '53999:3000'
YML
run_case "120 OD-42: a TWO-document straggler" FAIL "composes it from nothing"
rm -f docker/chaos-extra.yml
# 121. THE CONTROL: multi-document YAML under docker/ with no services:
#      mapping in ANY document is not a compose file, and must stay green.
cat > docker/chaos-extra.yml <<'YML'
a: 1
---
b: 2
YML
run_case "121 a multi-document NON-compose YAML (must stay green)" PASS
rm -f docker/chaos-extra.yml
# 122. The decision OD-42 forced: an UNREADABLE file under docker/ is a
#      failure, not a skip — this gate cannot tell whether it is compose.
cat > docker/chaos-extra.yml <<'YML'
services: [unclosed
YML
run_case "122 an UNREADABLE straggler (skipped before T-130)" FAIL "cannot read it"
rm -f docker/chaos-extra.yml
# 123. A2 — anchors and plain aliases are MODELLED, shown in the red direction:
#      a demoted build reached through an ALIAS (not a merge key) reaches the
#      universal. Not a differential: parse() resolved plain aliases too.
mk_single && mut "$BASE" 'services:' "x-t130-build: &t130_build
  context: ..
  dockerfile: docker/rogue-single.Dockerfile

services:" && mut "$BASE" "$SAFETY_BASE" "  safety-gw:
    image: kinvara/safety-gw:dev
    build: *t130_build" \
  && run_case "123 a demoted build reached through a plain ALIAS" FAIL "escapes all of them at once"

echo; echo "=== cases 124-127 (T-130 rework 1, OD-43): a 1.1/1.2 SYNTAX difference — the three YAML 1.1 line breaks ==="
# decisions.md OD-43 (qa-verification) and TL-F1 (tech-lead): U+2028, U+2029
# and U+0085 are LINE BREAKS to YAML 1.1 and to Docker Compose, and ordinary
# characters to YAML 1.2 — the lexer BOTH of this gate's readings use. So text
# after one on a comment line is a comment to every rule here and live YAML to
# compose. Measured: this exact edit gives safety-gw a single-stage
# non-application build at gate:pr 9/9 on 8236725 AND on main 8b4ef80, while
# `docker compose config` resolves the build. (-f compose.verify.yml masks it,
# as it masked OD-33/36/39/41 — so the base file is where it bites.)
# sep_landed asserts the character is IN the file after the mutation — `mut`
# proves the anchor was found; this proves the thing under test was planted.
sep_landed() {   # $1 = file, $2 = the separator character
  grep -q -- "$2" "$1" \
    || { echo "   HARNESS ERROR (no separator landed in $1)"; harness=$((harness+1)); return 1; }
}
od43_build() {   # $1 = case number, $2 = label, $3 = the separator character
  local c="$3"
  mk_single && mut "$BASE" '  safety-gw:
    image: kinvara/safety-gw:dev' "  safety-gw:
    image: kinvara/safety-gw:dev
    # T-130 OD-43 probe${c}    build:${c}      context: ..${c}      dockerfile: docker/rogue-single.Dockerfile" \
    && sep_landed "$BASE" "$c" \
    && run_case "$1 OD-43: $2 hides a build: behind a comment" FAIL "treats as a LINE BREAK"
}
od43_build 124 U+2028 $'\xe2\x80\xa8'
od43_build 125 U+2029 $'\xe2\x80\xa9'
od43_build 126 U+0085 $'\xc2\x85'
# 127. The OTHER entry point (composeShape, the straggler scan): a file whose
#      services: mapping exists only on the far side of a U+2028. To YAML 1.2
#      the whole file is one comment, so it was "not compose" and skipped.
printf '# T-130 OD-43 straggler%sservices:%s  rogue:%s    image: kinvara/rogue:dev%s    ports:%s      - "53999:3000"\n' \
  $'\xe2\x80\xa8' $'\xe2\x80\xa8' $'\xe2\x80\xa8' $'\xe2\x80\xa8' $'\xe2\x80\xa8' > docker/chaos-extra.yml
sep_landed docker/chaos-extra.yml $'\xe2\x80\xa8' \
  && run_case "127 OD-43: a straggler's services: behind U+2028" FAIL "treats as a LINE BREAK"
rm -f docker/chaos-extra.yml

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
