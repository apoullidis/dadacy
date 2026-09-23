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
# T-179: the stop-grace rule (§7) reads GROUP_DRAIN_MS out of the shipping entrypoint, so cases 148-151 mutate it.
ENTRY=docker/app-runtime/entrypoint.mjs
cp "$ENTRY" "$BK/entry"

# T-156 (decisions.md OD-119) — WHAT THIS SUITE MAY DELETE, AND THE PROOF THAT
# IT MAY.
#
# restore() used to end in a hard-coded `rm -rf apps/core/src apps/qa-newapp
# docker/next.Dockerfile docker/rogue.Dockerfile` (plus two more lines like it).
# That list was written when `apps/core` was a placeholder and cases 21-22
# planted a `src/` into it. `T-135` then COMMITTED `apps/core/src/**`, and from
# that day every exit of this suite deleted 23 tracked files, 2044 lines of
# `core`, and any `git add -A` afterwards committed the deletion. The deletion
# was silent: nothing in the suite ever looked at the tree it had just edited.
#
# THE MECHANISM, and why this one:
#   * tracked files a case MUTATES are still restored from the $BK temp copy
#     above — unchanged, and it was never the broken half;
#   * files a case CREATES are enumerated in PLANTED below, and restore() removes
#     those and nothing else;
#   * PLANTED is checked against git ONCE, before the first case runs, and the
#     suite REFUSES TO START if any entry is tracked. That is the structural
#     part: OD-119 is precisely a PLANTED path becoming tracked, so the failure
#     mode now stops the suite instead of being executed by it;
#   * run_case re-reads `git status --porcelain` after every restore and names
#     the case that leaked, and the footer judges the whole run against the
#     tree as it was at startup — for any path git REPORTS. It is not a
#     backstop for a path git ignores; see the bound on the PLANTED rule below.
#
# Why not `git stash`: it would sweep up the uncommitted work of whoever is
# running the suite and put it back through an index this script does not own —
# a worse version of the same hazard — and it cannot be done per case (136
# stashes). Why not a worktree: the gate reads `node_modules` and the real
# compose/Dockerfile set, so a second worktree needs its own install and the
# suite would then judge a tree that is not the one on disk, which is the one
# thing a negative suite must not do. A temp copy plus an enumerated plant list
# leaves the suite reading the real working tree, costs one `git ls-files` at
# startup, and is the only variant in which "restore exactly what was planted"
# is written down rather than inferred.
#
# IF YOU ADD A CASE THAT CREATES A FILE, add its path here. If the suite then
# refuses to start because the path is tracked, your case is planting over
# committed source — fix the case, never this list.
#
# AND THE BOUND ON THAT RULE — READ IT BEFORE YOU DECIDE A PATH IS TOO BORING TO
# LIST (T-156 rework 1; decisions.md OD-159, found by qa-verification by planting
# one). THE TREE CHECK BELOW DOES NOT BACK THIS LIST UP OVER THE WHOLE
# NAMESPACE. It is `git status --porcelain`, so it is blind to exactly what git
# is blind to: a path matched by .gitignore, and an empty directory. Measured —
# a case planting `apps/core/dist/qa-leak.txt` (.gitignore line 9, `dist/`) and
# an empty `apps/qa-empty-dir` left the suite printing WORKING TREE UNCHANGED
# and ALL 136 CASES BEHAVED AS EXPECTED, exit 0, with both still on disk.
# So for a path git IGNORES, PLANTED is the ONLY instrument, and leaving one out
# leaks SILENTLY: no case is named, nothing is printed, the exit status does not
# move. These are the directories where that bites, and they are the ones a
# Docker-shaped suite is likeliest to write into:
#
#     node_modules/   dist/   build/   out/   .next/   .turbo/
#     coverage/       .cache/  .pnpm-store/   .env*
#
# A path git REPORTS is still backstopped: create one outside PLANTED and the
# tree check names your case and exits non-zero. And the DELETION half is
# unaffected either way — a TRACKED file that is deleted, truncated or modified
# always appears in porcelain whatever .gitignore says, which is why OD-119
# itself stays covered. Do not reach for `git status --ignored` to close this:
# it would pull node_modules/ and the Trivy cache into 136 per-case comparisons.
PLANTED=(
  apps/qa-newapp
  apps/qa-attack
  apps/qa-x
  apps/safety-gw/package.json.t037
  docker/next.Dockerfile
  docker/rogue.Dockerfile
  docker/rogue-single.Dockerfile
  docker/rogue-two-stage.Dockerfile
  docker/compose.extra.yml
  docker/chaos-extra.yml
  docker/zz-thing.yaml
  docker/compose.yml.t130
  docker/compose.yml.t131
  infra/compose.rogue.yml
  docker/app-runtime/pid1.mjs
  docker/app-runtime/pid1.tar
  docker/qa-pid1.cfg
)
command -v git >/dev/null 2>&1 || {
  echo "HARNESS ERROR: git is not on PATH. This suite refuses to delete anything"
  echo "               it cannot first prove untracked (OD-119)."
  exit 2
}
_tracked=""
for _p in "${PLANTED[@]}"; do
  git ls-files --error-unmatch -- "$_p" >/dev/null 2>&1 && _tracked="$_tracked  - $_p
"
done
if [[ -n "$_tracked" ]]; then
  echo "HARNESS ERROR: these PLANTED paths are TRACKED, and this suite will not delete them:"
  printf '%s' "$_tracked"
  echo "               A case plants a path; if git tracks it, that case is planting over"
  echo "               committed source. That is OD-119. Fix the case, not this list."
  exit 2
fi
# The tree as it was before the first case. TREE0 is the verdict's anchor and is
# never reassigned; TREE_PREV rolls forward so each leak is attributed to the
# case that caused it rather than re-reported by every case after it.
TREE0="$(git status --porcelain)"
TREE_PREV="$TREE0"
leaks=0

restore() {
  cp "$BK/verify" "$VERIFY"; cp "$BK/chaos" "$CHAOS"; cp "$BK/base" "$BASE"; cp "$BK/dev" "$DEV"; cp "$BK/df" "$DF"; cp "$BK/pgdf" "$PGDF"; cp "$BK/svc" scripts/svc; cp "$BK/corepkg" apps/core/package.json; cp "$BK/entry" "$ENTRY"
  rm -rf -- "${PLANTED[@]}"
  [[ -f "$BK/sgwpkg" ]] && cp "$BK/sgwpkg" apps/safety-gw/package.json
  return 0
}
# `tree_check` is the per-case half of the OD-119 fix: "did nothing", "restored"
# and "left something behind" are three distinguishable outcomes, and the third
# names the case (PROTOCOL §5.1). Its blind spot is git's: a plant under an
# ignored path, or an empty directory, reads here as "restored" (OD-159 — the
# bound on the PLANTED rule above).
tree_check() {
  local now; now="$(git status --porcelain)"
  [[ "$now" == "$TREE_PREV" ]] && return 0
  leaks=$((leaks + 1))
  echo "   !! WORKING TREE NOT RESTORED by: $1"
  diff <(printf '%s\n' "$TREE_PREV") <(printf '%s\n' "$now") | head -20 | sed 's/^/      /'
  TREE_PREV="$now"
  return 1
}
trap 'restore; rm -rf "$BK"' EXIT
# An interrupt must leave the tree as it found it too, and MEASURED (T-156 § H):
# on this bash the EXIT trap above ALREADY runs when the shell dies of SIGINT or
# SIGTERM, so with these two lines deleted the tree still comes back clean. What
# these add is therefore NOT the restore — it is that an interrupted run SAYS it
# was interrupted instead of ending in silence three lines into a case, and that
# the restore does not depend on bash's EXIT-on-signal behaviour staying what it
# is. The bound, also measured: SIGKILL restores nothing (H4 leaves
# apps/core/package.json mutated), and no trap can change that.
trap 'echo; echo "INTERRUPTED (SIGINT) — restoring the working tree"; restore; rm -rf "$BK"; trap - EXIT; exit 130' INT
trap 'echo; echo "TERMINATED (SIGTERM) — restoring the working tree"; restore; rm -rf "$BK"; trap - EXIT; exit 143' TERM

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
  tree_check "$label"
  return 0
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

echo; echo "=== cases 21-22 (T-156, OD-120): apps/<name>/src present with no start script ==="
# These two used to PLANT `apps/core/src/index.ts` and then, in 22, insert a
# second `"scripts"` key into apps/core/package.json. Both halves stopped being
# the state they name the day T-135 committed apps/core/src/** AND a `start`
# script: case 21's plant added a file to a directory that already had source,
# to an app that already declared `start`, so the app satisfied the rule and the
# case reported `exit=0 PASS (expected FAIL)` on a clean main — this suite has
# been red on main ever since (decisions.md OD-120). Case 22's insert was worse
# than useless: JSON.parse keeps the LAST duplicate key, so the real `"scripts"`
# won and the mutation changed nothing the gate read.
#
# The state that actually lacks a start script is core's own manifest with the
# entry REMOVED. apps/core/package.json is already in the $BK backup set, so this
# is an anchored mutation of a restored file and plants nothing; the anchor makes
# a future rename of the script a HARNESS ERROR rather than a silent pass.
# Case 22 keeps a `start` and changes only its VALUE, so the pair isolates the
# key's presence: same src/, same file touched, opposite verdicts.
mut apps/core/package.json '    "start": "node src/main.ts",
' '' && run_case "21 apps/core has src/ but declares no start script" FAIL "declares no 'start' script"
mut apps/core/package.json '"start": "node src/main.ts"' '"start": "node dist/main.js"' \
  && run_case "22 the same, once it declares start" PASS

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
# T-180: all THREE plants below gained `WORKDIR` + `COPY docker/app-runtime/` and
# an ENTRYPOINT at the copied entrypoint.mjs. §7 now reads GROUP_DRAIN_MS from
# the file each application stage's ENTRYPOINT runs, and REFUSES a PID 1 it
# cannot map to a repository file, so the old `/x.mjs` (which nothing COPYs)
# turned case 45 red for a reason that has nothing to do with pins. The edit is
# the same in all three because 43/44/45 are one differential: 45 is the
# control for 43-44 only while the three differ by the pins alone. Names,
# classes and expected reasons are unchanged; against the gate as at 36a41d1
# the three verdicts are unchanged (T-180 § Evidence); the unedited plant is
# kept as case 165, expecting §7's refusal (T-179 QA-4's four conditions).
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0
FROM node:24.20.0-alpine AS runtime
USER 10001:10001
WORKDIR /srv/kinvara
COPY docker/app-runtime/ ./app-runtime/
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]
DF
repoint_web docker/next.Dockerfile && run_case "43 a 2nd Dockerfile with literal pins (OD-25 verbatim)" FAIL
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION
ARG PNPM_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
ENV KINVARA_PNPM_HINT=11.25.0
USER 10001:10001
WORKDIR /srv/kinvara
COPY docker/app-runtime/ ./app-runtime/
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]
DF
repoint_web docker/next.Dockerfile && run_case "44 a 2nd Dockerfile, PNPM literal only" FAIL
# The control: the same second Dockerfile with nothing written down must PASS,
# or cases 43-44 would only be evidence that the gate dislikes new files.
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION
ARG PNPM_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
USER 10001:10001
WORKDIR /srv/kinvara
COPY docker/app-runtime/ ./app-runtime/
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]
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
# keys MODELLED, a 1.1-vs-1.2 SCHEMA disagreement A3 finds (value by value and
# by kind since T-131, so a 1.1 Date counts — OD-46, case 128; key order is not
# compared, OD-48) and each unmodelled compose feature MEASURED so far
# FAIL CLOSED. (T-130 rework 1: this read "every other YAML 1.1/1.2
# disagreement", which was false — both readings share one lexer, `yaml`'s,
# which targets YAML 1.2 and departs from it on a lone CR (OD-45, refused since
# T-131, cases 130 and 132), so a SYNTAX
# difference is read identically twice; OD-43 was one. The list is not
# exhaustive; the reader's header says which members exist and which are open.)
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
#     whose 1.1- and 1.2-SCHEMA readings A3 finds different is refused (value
#     by value and by kind since T-131, so a 1.1 Date against a 1.2 string
#     counts — OD-46, case 128; value resolution only —
#     both readings share one lexer; the SYNTAX difference OD-43 found is cases
#     124-127, T-130 rework 1), because no reading of it can then be trusted to
#     be compose's. `on` is a boolean in 1.1 and the string "on" in 1.2, which
#     differ in kind. The repair is to quote it.
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
#     T-179: the plant now carries `stop_grace_period: 30s`. It is an application
#     service added by this overlay, so §7 requires the grace in this file, and
#     without it this control went red for a reason unrelated to what it is
#     about (measured: `!! 87 … FAIL (expected PASS)`). Case 147 is this plant
#     WITHOUT the line, expected FAIL. Name, class and expectation unchanged.
mk_qa_x && mut "$VERIFY" 'services:' 'services:
  qa-x:
    image: kinvara/qa-x:dev
    networks: [kinvara-int]
    mem_limit: 128m
    cpus: 0.25
    stop_grace_period: 30s
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
# characters to YAML 1.2 and to `yaml`'s lexer, which BOTH of this gate's
# readings use (it targets 1.2; a lone CR, OD-45, is cases 130-132, 141-143). So text
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

echo; echo "=== cases 128-140 (T-131): the parse RESIDUE — OD-46, OD-45, OD-44, OD-48 ==="
# decisions.md OD-44, OD-45, OD-46, OD-48, owned by T-131. Every FAIL case below
# was exit 0 GATE PASS against the gate as at main 7dff12c on the identical
# file (T-131 § Evidence), and asserts the reason its refusal prints. Every
# control must stay green. The anchor for what compose does with each file is
# `docker compose config` on scratch copies (T-131 § Evidence 1), never this
# gate. Values are planted beside the first `NODE_ENV:` line, an environment:
# mapping in compose.yml, as case 117 does.
ENV_LINE='      NODE_ENV: ${NODE_ENV:-development}'
CR=$'\r'
# landed CMD... — asserts a mutation this suite made WITHOUT mut (so mut's own
# anchor check does not cover it) actually landed; a no-op is a HARNESS ERROR.
landed() { "$@" || { echo "   HARNESS ERROR (mutation did not land: $*)"; harness=$((harness+1)); return 1; }; }
first_bytes() { head -c "$2" "$1" | od -An -tx1 | tr -d ' \n'; }
# 128. OD-46. A timestamp in exactly Date.toJSON() form: YAML 1.1 reads a Date,
#      1.2 a string, and the two printed alike as JSON text, which is all A3
#      compared at main; compose reads a TIME (2026-09-11 00:00:00 +0000 UTC).
#      The other spellings (…00Z, …00.5Z, +00:00, date-only) were refused at
#      main already (OD-47), so this is the spelling that is red there.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      QA_T131_STAMP: 2026-09-11T00:00:00.000Z" \
  && run_case "128 OD-46: an unquoted toISOString() timestamp" FAIL "YAML 1.1 reads a Date"
# 129. THE CONTROL: the same timestamp quoted is a string to both readings and
#      to compose.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      QA_T131_STAMP: '2026-09-11T00:00:00.000Z'" \
  && run_case "129 the same timestamp QUOTED (must stay green)" PASS
# 130. OD-45 (1). Case 124 with every separator a LONE CR: a line break to YAML
#      1.2 itself, to compose and to PyYAML, and not to yaml@2.8.1. Measured at
#      main: exit 0 GATE PASS while compose resolves the build.
mk_single && mut "$BASE" "$SAFETY_BASE" "$SAFETY_BASE
    # T-131 OD-45 probe${CR}    build:${CR}      context: ..${CR}      dockerfile: docker/rogue-single.Dockerfile" \
  && sep_landed "$BASE" "$CR" \
  && run_case "130 OD-45: a lone CR hides a build: behind a comment" FAIL "a LONE CR"
# 131. THE CONTROL: CRLF line endings on every line of compose.yml. A CR that a
#      LF follows is not a lone CR, and compose reads the file (T-131 § Evidence 1).
landed sed -i 's/$/\r/' "$BASE" \
  && landed test "$(grep -c "${CR}\$" "$BASE")" -eq "$(wc -l < "$BASE")" \
  && run_case "131 compose.yml with CRLF line endings (must stay green)" PASS
# 132. OD-45 (1) at the OTHER entry point, composeShape: a straggler whose
#      services: sits behind lone CRs. To yaml@2.8.1 the whole file was one
#      comment, so the scan called it "not compose".
printf '# T-131 OD-45 straggler\rservices:\r  rogue:\r    image: kinvara/rogue:dev\r    ports:\r      - "53999:3000"\n' > docker/chaos-extra.yml
sep_landed docker/chaos-extra.yml "$CR" \
  && run_case "132 OD-45: a straggler's services: behind lone CRs" FAIL "a LONE CR"
rm -f docker/chaos-extra.yml
# 133. OD-45 (2). Case 68's straggler saved as UTF-16LE with a BOM. Compose
#      reads UTF-16 (measured); this scan decoded it as UTF-8 and called it
#      "not compose", where its UTF-8 twin (case 68) is reported.
node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from("\ufeff" + process.argv[2], "utf16le"))' \
  docker/chaos-extra.yml "services:
  rogue:
    image: kinvara/rogue:dev
    ports:
      - '53999:3000'
"
landed test "$(first_bytes docker/chaos-extra.yml 2)" = fffe \
  && run_case "133 OD-45: a UTF-16 straggler" FAIL "not UTF-8 text"
rm -f docker/chaos-extra.yml
# 134. THE CONTROL for A12: a UTF-8 BOM in front of compose.yml. U+FEFF is
#      neither U+0000 nor U+FFFD, and compose reads the file (T-131 § Evidence 1).
{ printf '\xef\xbb\xbf'; cat "$BASE"; } > "$BASE.t131" && mv "$BASE.t131" "$BASE"
landed test "$(first_bytes "$BASE" 3)" = efbbbf \
  && run_case "134 a UTF-8 BOM on compose.yml (must stay green)" PASS
# 135. OD-44. The \/ escape, which compose REFUSES ("found unknown escape
#      character", measured). The reader read it as '/', so safety-gw's image
#      was unchanged and the gate was green at main. The safe direction —
#      compose loads nothing — refused so that the gate and compose agree.
mut "$BASE" "$SAFETY_BASE" '  safety-gw:
    image: "kinvara\/safety-gw:dev"' \
  && run_case "135 OD-44: the \\/ escape in safety-gw's image" FAIL "escape inside a double-quoted scalar"
# 136. THE CONTROL: an escaped backslash then a slash ("a\\/b") is not the \/
#      escape. The refusal reads escapes in order, it does not grep for \/.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      QA_T131_PATH: \"a\\\\/b\"" \
  && run_case "136 \"a\\\\/b\", an escaped backslash (must stay green)" PASS
# 137-139. OD-48. Two SCALAR keys that name the SAME property (an ALIAS key is
#      not modelled and not refused: T-131 QA-F1). yaml's own duplicate
#      check compared key values with ===, and toJS() names each property
#      String(key), so the pair became one property with no diagnostic, and
#      both readings could agree while dropping a value. Compose refuses all
#      three files (measured).
# 137. (1) The key-ORDER shape: 1.2 reads -017 as -17, 1.1 as -15. No value
#      differed between the readings, only the order.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      -017: a
      \"-17\": b
      \"-15\": c" \
  && run_case "137 OD-48: -017 / \"-17\" / \"-15\" (key order only)" FAIL "name the SAME property"
# 138. (2) The COLLAPSING shape: 017 alone is refused by A3; beside "15" and "17"
#      its value was dropped by both readings, which then agreed.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      017: a
      \"15\": b
      \"17\": c" \
  && run_case "138 OD-48: 017 / \"15\" / \"17\" (a key masked)" FAIL "name the SAME property"
# 139. The sibling compose itself names a duplicate ('mapping key "1" already
#      defined'): 1: and "1": — no 1.1/1.2 difference involved at all.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      1: a
      \"1\": b" \
  && run_case "139 OD-48: 1: and \"1\": in one mapping" FAIL "name the SAME property"
# 140. THE CONTROL: "15" and "17" alone are two distinct keys.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      \"15\": b
      \"17\": c" \
  && run_case "140 \"15\" and \"17\" alone (must stay green)" PASS

echo; echo "=== cases 141-143 (T-131 rework 1): OD-45 (1), a lone CR, in the three OTHER composed files ==="
# qa-verification QA-3 / QA-3a, verifying T-131: text hidden behind lone CRs
# was a live route in compose.verify.yml, compose.dev.yml and compose.chaos.yml
# at main 7dff12c (exit 0 GATE PASS on both gates, while `docker compose config`
# read the hidden text), and A11 already refused it. Nothing re-executed that,
# so these cases do. They add no refusal. Each probe line is valid YAML without
# what follows its lone CRs, so at main the hidden text was a comment and the
# rest of the file still read. 130 and 132 are the compose.yml and straggler
# members.
# 141. compose.verify.yml: host ports on safety-gw (T-036 § contract 4's rule).
mut "$VERIFY" "      APP_PORT: '3010'
    pull_policy: build" "      APP_PORT: '3010'
    pull_policy: build
    # T-131 rework probe${CR}    ports: ['53999:3010']" \
  && sep_landed "$VERIFY" "$CR" \
  && run_case "141 OD-45: a lone CR hides ports: in compose.verify.yml" FAIL "a LONE CR"
# 142. compose.dev.yml: a single-stage non-application build: for safety-gw.
mk_single && mut "$DEV" '  safety-gw:
    networks: [kinvara-int, kinvara-pub]' "  safety-gw:
    networks: [kinvara-int, kinvara-pub]
    # T-131 rework probe${CR}    build:${CR}      context: ..${CR}      dockerfile: docker/rogue-single.Dockerfile" \
  && sep_landed "$DEV" "$CR" \
  && run_case "142 OD-45: a lone CR hides a build: in compose.dev.yml" FAIL "a LONE CR"
# 143. compose.chaos.yml (T-126's file): the same build, behind a benign core
#      label override, so that the file still has a services: mapping at main.
mk_single && mut "$CHAOS" 'services: {}' "services:
  core:
    labels:
      io.kinvara.qa: probe # T-131 rework probe${CR}  safety-gw:${CR}    build:${CR}      context: ..${CR}      dockerfile: docker/rogue-single.Dockerfile" \
  && sep_landed "$CHAOS" "$CR" \
  && run_case "143 OD-45: a lone CR hides a build: in compose.chaos.yml" FAIL "a LONE CR"

echo; echo "=== cases 144-155 (T-179, TL-1 on T-151): every APPLICATION service's stop_grace_period covers PID 1's group wait, READ from entrypoint.mjs (§7) ==="
# At main 39f01f2 `web` and `admin` declared no stop_grace_period, took compose's
# 10 s default, and entrypoint.mjs may wait GROUP_DRAIN_MS = 25 s for the app's
# process group after SIGTERM — so a clean drain on the shell path would be
# SIGKILLed and report 143, with this gate green. The rule is a RELATIONSHIP
# (grace >= GROUP_DRAIN_MS + 5 s), the wait is read from the shipping file, and
# which services are "application services" is derived, never listed. These
# cases attack each of those three separately; the controls prove each plant is
# otherwise clean, so a red is the grace rule and nothing else.
GRACE_LINES="    # PID 1 may wait GROUP_DRAIN_MS for the app's process group after SIGTERM;
    # gate:app-images §7 holds this above that wait, read from entrypoint.mjs (T-179).
    stop_grace_period: 30s
"
WEB_TAIL="      - '3001'
    environment:
      NODE_ENV: \${NODE_ENV:-development}
      CORE_BASE_URL: \${CORE_BASE_URL:-http://core:3000}
    mem_limit: 768m
    cpus: 1.5
"
DRAIN_LINE='const GROUP_DRAIN_MS = 25_000;'
SGW_HEAD='  safety-gw:
    image: kinvara/safety-gw:dev'
REPLICA='  worker-2:
    image: kinvara/worker:dev
    profiles: [worker]
    networks: [kinvara-int]
    mem_limit: 512m
    cpus: 1.0
'
WEB_VERIFY="        APP: web
        APP_KIND: http
        APP_PORT: '3001'
    pull_policy: build"
# 144. TL-1 itself: web's line removed.
mut "$BASE" "$WEB_TAIL$GRACE_LINES" "$WEB_TAIL" \
  && run_case "144 web's stop_grace_period removed (TL-1)" FAIL "'web' (contract-set+app-build+runs kinvara/web:dev) declares no stop_grace_period"
# 145. A SIXTH application service no hand list would name: a second worker
#      container running kinvara/worker:dev — no label, no build, no apps/ dir.
#      It runs the same PID 1 and the same wait. Caught by derivation (c).
mut "$BASE" "$SGW_HEAD" "$REPLICA$SGW_HEAD" \
  && run_case "145 a SIXTH service running kinvara/worker:dev, no grace" FAIL "'worker-2' (runs kinvara/worker:dev) declares no stop_grace_period"
# 146. THE CONTROL for 145: the same plant with the grace declared is green, so
#      145's red is the grace rule and not some other rule the replica trips.
mut "$BASE" "$SGW_HEAD" "$REPLICA    stop_grace_period: 30s
$SGW_HEAD" \
  && run_case "146 the same sixth service WITH 30s (must stay green)" PASS
# 147. A SIXTH application, declared only by a --verify build (case 87's plant,
#      minus the grace). The base file never names it, so the file that adds it
#      must declare the grace itself. Caught by derivations (a) and (b).
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
    pull_policy: build' \
  && run_case "147 a SIXTH app added by the verify overlay, no grace" FAIL "docker/compose.verify.yml: application service 'qa-x'"
# 148. The wait RAISED past the declared grace. A literal 30s checked against a
#      literal 30s would stay green here; the floor is read from this file.
mut "$ENTRY" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 35_000;' \
  && run_case "148 GROUP_DRAIN_MS raised to 35_000" FAIL "declares stop_grace_period 30s, BELOW the floor of 40000 ms"
# 149. The boundary: one millisecond more wait eats into the 5 s exit margin.
mut "$ENTRY" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 25_001;' \
  && run_case "149 GROUP_DRAIN_MS 25_001 (the margin is a floor)" FAIL "BELOW the floor of 30001 ms"
# 150. THE CONTROL: a SHORTER wait needs no change to any grace.
mut "$ENTRY" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 20_000;' \
  && run_case "150 GROUP_DRAIN_MS lowered to 20_000 (must stay green)" PASS
# 151. The wait spelled as an expression: REFUSED, not evaluated and not
#      skipped — a reader that silently found no number would check nothing.
mut "$ENTRY" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 25 * 1000;' \
  && run_case "151 GROUP_DRAIN_MS as an expression" FAIL "is not a single numeric literal"
# 152. An OVERLAY lowering it: --verify gives web 10s. The base is fine; the
#      project that applies the overlay is not.
mut "$VERIFY" "$WEB_VERIFY" "$WEB_VERIFY
    stop_grace_period: 10s" \
  && run_case "152 the verify overlay lowers web to 10s" FAIL "docker/compose.verify.yml: application service 'web'"
# 153. THE CONTROL: an overlay RAISING it is allowed.
mut "$VERIFY" "$WEB_VERIFY" "$WEB_VERIFY
    stop_grace_period: 1m" \
  && run_case "153 the verify overlay raises web to 1m (must stay green)" PASS
# 154. A unit-less value. `docker compose config` refuses it ("missing unit in
#      duration", measured in T-179 § Evidence); the gate refuses rather than
#      reading 30 as seconds.
mut "$BASE" "$WEB_TAIL$GRACE_LINES" "$WEB_TAIL    stop_grace_period: '30'
" \
  && run_case "154 web's grace written '30' (no unit)" FAIL "not a non-negative compose duration"
# 155. ANTI-VACUITY (PROTOCOL §5.1): if the derivation matched ZERO application
#      services, the rule would pass while asserting nothing. Every composed file
#      stripped of every application service: the rule must SAY it judged none.
#      (Other rules fail here too; the reason asserts THIS one's message.)
printf 'services:\n  qa-nonapp:\n    image: busybox:1\n    networks: [kinvara-int]\n    mem_limit: 64m\n    cpus: 0.25\nnetworks:\n  kinvara-int:\n    internal: true\n' > "$BASE" \
  && printf 'services: {}\n' > "$VERIFY" && printf 'services: {}\n' > "$DEV" \
  && landed grep -q qa-nonapp "$BASE" \
  && run_case "155 zero application services composed anywhere" FAIL "judged ZERO application services"

# --- T-180: §7 HOLDS THE ONE USE OF GROUP_DRAIN_MS, AND FINDS THE ENTRYPOINT
#     FROM §6 ----------------------------------------------------------------
# Until T-180, §7 read the constant's declaration at a FIXED path and nothing
# else. qa-verification (T-179 QA-2, `g02`/`g03`/`g12`) changed the REAL wait
# three ways with the gate green: a multiplier at the use site, an environment
# override there, and app.Dockerfile's ENTRYPOINT pointed at a copy. T-180 fixes
# the deadline at the first forwarded signal in ONE statement, and §7 holds
# that statement's shape (by syntax tree, so a comment or a string is not a
# use) and reads the file the resolved ENTRYPOINT actually runs.
echo; echo "=== cases 156-168 (T-180, QA-7 on T-179): §7 holds GROUP_DRAIN_MS's ONE use and reads the file the resolved ENTRYPOINT runs ==="
USE_LINE='deadline = signalledAt + GROUP_DRAIN_MS;'
EP_LINE='ENTRYPOINT ["node", "/srv/kinvara/app-runtime/entrypoint.mjs"]'
PID1=docker/app-runtime/pid1.mjs
# 156. g02: a multiplier where the constant is used.
mut "$ENTRY" "$USE_LINE" 'deadline = signalledAt + GROUP_DRAIN_MS * 2;' \
  && run_case "156 g02: GROUP_DRAIN_MS * 2 at the use site" FAIL "the one use of GROUP_DRAIN_MS is"
# 157. g03: an environment override where the constant is used.
mut "$ENTRY" "$USE_LINE" 'deadline = signalledAt + Number(process.env.KINVARA_GROUP_DRAIN_MS ?? GROUP_DRAIN_MS);' \
  && run_case "157 g03: an env override at the use site" FAIL "the one use of GROUP_DRAIN_MS is"
# 158. A SECOND read — the shape the code had before T-180, where the timeout
#      log line read the constant too.
mut "$ENTRY" 'the first forwarded signal (the deadline), exiting anyway`,' 'the first forwarded signal (the deadline, ${String(GROUP_DRAIN_MS)}ms), exiting anyway`,' \
  && run_case "158 GROUP_DRAIN_MS read a second time (a log line)" FAIL "is used in code at 2 place(s)"
# 159. The ORIGIN moved back: the deadline counted from "now" at the use site,
#      not from the first signal. (Not modelled: the SAME statement moved to
#      child.on('exit') — see T-180 § Published contract.)
mut "$ENTRY" "$USE_LINE" 'deadline = Date.now() + GROUP_DRAIN_MS;' \
  && run_case "159 the deadline counted from Date.now() again" FAIL "the one use of GROUP_DRAIN_MS is"
# 160. THE CONTROL for 156-159: a mention in a COMMENT and in a STRING is not a
#      use. A text count would red this; the syntax-tree count must not.
mut "$ENTRY" "$DRAIN_LINE" "$DRAIN_LINE // GROUP_DRAIN_MS, mentioned
const GROUP_DRAIN_NOTE = 'GROUP_DRAIN_MS is read once';" \
  && run_case "160 GROUP_DRAIN_MS in a comment and a string (stay green)" PASS
# 161. g12: ENTRYPOINT pointed at a COPY whose wait is 60 s. Before T-180 §7
#      read the fixed path and stayed green.
cp "$ENTRY" "$PID1" && mut "$PID1" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 60_000;' \
  && mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/pid1.mjs"]' \
  && run_case "161 g12: ENTRYPOINT repointed at a 60 s copy" FAIL "BELOW the floor of 65000 ms"
# 162. THE CONTROL for 161: the same repoint to an IDENTICAL copy is green, so
#      161's red is the wait read from the copy, not a fixed-path check.
cp "$ENTRY" "$PID1" && mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "/srv/kinvara/app-runtime/pid1.mjs"]' \
  && run_case "162 ENTRYPOINT repointed at an identical copy (stay green)" PASS
# 163. An ENTRYPOINT that is not `node <script>`: §7 cannot tell which file is
#      PID 1, and refuses rather than falling back to a path.
mut "$DF" "$EP_LINE" 'ENTRYPOINT ["/srv/kinvara/app-runtime/entrypoint.mjs"]' \
  && run_case "163 ENTRYPOINT without node: no script to read" FAIL "is not \`node <script>\`"
# 164. A script no COPY from the build context puts in the image.
mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "/usr/local/lib/pid1.mjs"]' \
  && run_case "164 ENTRYPOINT at a path no COPY provides" FAIL "cannot map it to a repository file"

# 165. Case 45's plant as it was before T-180: a second application Dockerfile
#      whose ENTRYPOINT runs /x.mjs, which no COPY provides. §7 cannot read the
#      wait of a PID 1 it cannot find, and refuses (T-179 QA-4 condition iii).
cat > docker/next.Dockerfile <<'DF'
ARG NODE_VERSION
ARG PNPM_VERSION
FROM node:${NODE_VERSION}-alpine AS runtime
USER 10001:10001
HEALTHCHECK CMD ["node", "/x.mjs"]
ENTRYPOINT ["node", "/x.mjs"]
DF
repoint_web docker/next.Dockerfile && run_case "165 case 45's pre-T-180 plant: PID 1 /x.mjs, never COPY'd" FAIL "cannot map it to a repository file"

# 166-168. T-180 rework 1 (QA-F4): a same-named binding in runReal SHADOWS the
#      constant, and the held statement then reads the shadow. The `const` line
#      regex sees only a line that STARTS `const GROUP_DRAIN_MS`, and the use
#      count dropped every declaration name, so all three were green at 86be68a.
#      §7 now requires exactly ONE declaration of the name in the syntax tree.
SHADOW_AT='  let signalledAt = null;'
mut "$ENTRY" "$SHADOW_AT" '  let GROUP_DRAIN_MS = 60_000;
  let signalledAt = null;' \
  && run_case "166 a same-named let in runReal shadows the constant" FAIL "GROUP_DRAIN_MS is declared 2 time(s)"
mut "$ENTRY" "$SHADOW_AT" '  var GROUP_DRAIN_MS = 60_000;
  let signalledAt = null;' \
  && run_case "167 a same-named var in runReal shadows the constant" FAIL "GROUP_DRAIN_MS is declared 2 time(s)"
mut "$ENTRY" "$SHADOW_AT" '  const shadowPad = 0, GROUP_DRAIN_MS = 60_000;
  let signalledAt = null;' \
  && run_case "168 a multi-declarator const shadows the constant" FAIL "GROUP_DRAIN_MS is declared 2 time(s)"

# T-182 helpers. Both plant UNTRACKED files listed in PLANTED above: a tar
# docker would extract over the script, and a file a compose `configs:` entry
# mounts over it. Each is a COPY of the shipping entrypoint with a 60 s wait, so
# the hazard each case names is real rather than symbolic.
mk_pid1_tar() {
  rm -rf "$BK/tarsrc" && mkdir -p "$BK/tarsrc/app-runtime" \
    && cp "$ENTRY" "$BK/tarsrc/app-runtime/entrypoint.mjs" \
    && node scripts/negative-tests/mutate.mjs "$BK/tarsrc/app-runtime/entrypoint.mjs" \
         "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 60_000;' \
    && tar -cf docker/app-runtime/pid1.tar -C "$BK/tarsrc" app-runtime
}
mk_pid1_cfg() {
  cp "$ENTRY" docker/qa-pid1.cfg \
    && node scripts/negative-tests/mutate.mjs docker/qa-pid1.cfg "$DRAIN_LINE" \
         'const GROUP_DRAIN_MS = 60_000;'
}

# --- T-182: §7 RESOLVES WHAT PID 1 ACTUALLY RUNS, PER APPLICATION SERVICE ---
# Until T-182 §7 read the IMAGE ENTRYPOINT of each application stage and called
# it PID 1. qa-verification measured seven ways to decide PID 1 that the stage's
# ENTRYPOINT does not mention, and each was GATE PASS at 2b5d833 (T-180 § QA
# verification §3b E1/E3 and rework 1 §4 F5/F6/F7/X1). §7 now RESOLVES the
# process from every input that can change what it executes, and refuses what it
# cannot resolve — so these cases are one reading attacked from nine directions,
# not nine rules. Every FAIL case here is exit=0 GATE PASS under the 2b5d833
# gate (the KINVARA_GATE_IMPL differential, state/EP-1/T-182.md § Evidence).
echo; echo "=== cases 169-192 (T-182): §7 resolves PID 1 per SERVICE — compose entrypoint:/command:, init:, stop_signal:, NODE_OPTIONS, mounts, working_dir, a rewriting RUN, an ADDed archive ==="
CORE_HEAD='  core:
    image: kinvara/core:dev
'
CORE_ENV='      HIBP_API_BASE: ${HIBP_API_BASE:-http://hibp-fake:4100}'
COPY_RUNTIME='COPY --chown=10001:10001 docker/app-runtime/ ./app-runtime/'
SM_HEAD='  stripe-mock:
    image: stripe/stripe-mock:v0.194.0
'
# 169. THE TUESDAY (QA-F3's E1): one compose line replaces PID 1 with a copy of
#      the entrypoint that waits 60 s, and `COPY docker/app-runtime/` already
#      puts the copy in the image — no Dockerfile edit at all. §7 now reads the
#      copy, so the floor it holds the graces against is the copy's 60 s.
cp "$ENTRY" "$PID1" && mut "$PID1" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 60_000;' \
  && mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    entrypoint: ['node', '/srv/kinvara/app-runtime/pid1.mjs']
" \
  && run_case "169 a compose entrypoint: override -> a 60 s copy" FAIL "BELOW the floor of 65000 ms"
# 170. THE CONTROL for 169: the SAME key pointed at the file the image runs
#      anyway is RESOLVED, read and green. The refusal is about resolution, not
#      about the presence of an entrypoint: key.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    entrypoint: ['node', '/srv/kinvara/app-runtime/entrypoint.mjs']
" \
  && run_case "170 a compose entrypoint: -> the real entrypoint (stay green)" PASS
# 171. The same key as a STRING. Compose reads that as SHELL form, so /bin/sh is
#      PID 1 — the thing §6 refuses in the Dockerfile and nothing read in compose.
cp "$ENTRY" "$PID1" && mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    entrypoint: node /srv/kinvara/app-runtime/pid1.mjs
" \
  && run_case "171 a compose entrypoint: STRING (shell form)" FAIL "SHELL form"
# 172. QA's F5: a bind mount over the script. The image is untouched and the
#      file PID 1 runs is whatever the host puts there.
cp "$ENTRY" "$PID1" && mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    volumes:
      - type: bind
        source: ./app-runtime/pid1.mjs
        target: /srv/kinvara/app-runtime/entrypoint.mjs
        read_only: true
" \
  && run_case "172 a compose volumes: mount over PID 1's script" FAIL "covers PID 1's script"
# 173. THE CONTROL for 172: a mount on the same service that does NOT cover the
#      script is green — the rule is the coverage, not the key.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    volumes:
      - type: bind
        source: ./app-runtime
        target: /qa/app-runtime
        read_only: true
" \
  && run_case "173 a compose volumes: mount elsewhere (stay green)" PASS
# 174. QA's F6: a NODE_OPTIONS preload. QA MEASURED it running INSIDE PID 1 of
#      kinvara/core:dev, so this is code PID 1 runs from a file §7 never read.
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      NODE_OPTIONS: --enable-source-maps --import /srv/kinvara/app-runtime/pre.mjs" \
  && run_case "174 compose NODE_OPTIONS --import preload" FAIL "makes node run code from another file"
# 175. THE CONTROL for 174: the value the image already sets loads nothing.
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      NODE_OPTIONS: --enable-source-maps" \
  && run_case "175 compose NODE_OPTIONS=--enable-source-maps (stay green)" PASS
# 176. The same preload from the IMAGE's own ENV, which app.Dockerfile:232
#      already declares — so this is an edit to a line that exists.
mut "$DF" '    NODE_OPTIONS=--enable-source-maps' '    NODE_OPTIONS="--enable-source-maps --require /srv/kinvara/app-runtime/pre.cjs"' \
  && run_case "176 Dockerfile ENV NODE_OPTIONS --require preload" FAIL "makes node run code from another file"
# 177. QA's E3: a node flag whose VALUE is a separate argument. §7 used to take
#      the first non-flag argument, which is the flag's value, and read THAT.
cp "$ENTRY" "$PID1" && mut "$PID1" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 60_000;' \
  && mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "--import", "/srv/kinvara/app-runtime/entrypoint.mjs", "/srv/kinvara/app-runtime/pid1.mjs"]' \
  && run_case "177 node --import <real> <60 s copy>" FAIL "makes node run code from another file"
# 178. THE CONTROL for 177 and 191: an INERT flag before the script is read past.
mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "--enable-source-maps", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
  && run_case "178 node --enable-source-maps <real> (stay green)" PASS
# 179. T-180 § contract 4's third family member, declared and never planted: a
#      RUN that rewrites the script AFTER the COPY that puts it there.
mut "$DF" "$COPY_RUNTIME" "$COPY_RUNTIME
RUN sed -i 's/GROUP_DRAIN_MS = 25_000/GROUP_DRAIN_MS = 60_000/' /srv/kinvara/app-runtime/entrypoint.mjs" \
  && run_case "179 a RUN rewrites the script after its COPY" FAIL "runs AFTER the COPY that puts it there"
# 180. T-180 § contract 4's fourth member: an ADDed archive docker extracts over
#      the script. Its contents are not in the repository in a readable form.
mk_pid1_tar && mut "$DF" "$COPY_RUNTIME" "$COPY_RUNTIME
ADD docker/app-runtime/pid1.tar /srv/kinvara/" \
  && run_case "180 an ADDed tar extracted over the script" FAIL "ADDs an ARCHIVE"
# 181. QA's X1: stop_signal: SIGQUIT. PID 1 handles SIGTERM and SIGINT only, so
#      nothing is forwarded, nothing drains, and docker SIGKILLs at the grace —
#      measured ExitCode=137 at 30.13 s in a container.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    stop_signal: SIGQUIT
" \
  && run_case "181 stop_signal: SIGQUIT — nothing forwards it" FAIL "installs handlers for SIGTERM and SIGINT only"
# 182. THE CONTROL for 181: the two signals PID 1 does handle are allowed.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    stop_signal: SIGTERM
" \
  && run_case "182 stop_signal: SIGTERM (stay green)" PASS
# 183. QA's F7: init: true makes docker-init PID 1 and entrypoint.mjs its child,
#      so the process this rule reads is not PID 1 at all.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    init: true
" \
  && run_case "183 init: true — docker-init becomes PID 1" FAIL "docker-init is PID 1"
# 184. THE EIGHTH ROUTE, planted by T-182 rather than inherited: a compose
#      configs: entry whose target IS the script. A different compose key from
#      volumes:, the same effect, named by nobody in T-180's family — and it is
#      refused by the resolution's mount step without a rule of its own.
mk_pid1_cfg && mut "$BASE" '
volumes:
' '
configs:
  qa_pid1:
    file: ./qa-pid1.cfg

volumes:
' && mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    configs:
      - source: qa_pid1
        target: /srv/kinvara/app-runtime/entrypoint.mjs
" \
  && run_case "184 EIGHTH ROUTE: a configs: target over PID 1's script" FAIL "covers PID 1's script"
# 185. THE CONTROL for 172/184: the same mount on a service that is NOT an
#      application service is nothing to do with this rule.
mut "$BASE" "$SM_HEAD" "$SM_HEAD    volumes:
      - type: bind
        source: ./app-runtime
        target: /srv/kinvara/app-runtime
        read_only: true
" \
  && run_case "185 the same mount on stripe-mock (stay green)" PASS
# 186. env_file: can set NODE_OPTIONS, and this gate does not read env files.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    env_file: ['./.env.example']
" \
  && run_case "186 env_file: on an application service" FAIL "does not read env files"
# 187. working_dir: moves the WORKDIR a RELATIVE ENTRYPOINT resolves against, so
#      one compose line repoints PID 1 without touching the Dockerfile's argv.
mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "app-runtime/entrypoint.mjs"]' \
  && mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    working_dir: /srv
" \
  && run_case "187 working_dir: moves a relative ENTRYPOINT" FAIL "cannot map it to a repository file"
# 188. THE CONTROL for 187: the same relative ENTRYPOINT with no working_dir
#      resolves against the image's own WORKDIR and is green.
mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "app-runtime/entrypoint.mjs"]' \
  && run_case "188 the same relative ENTRYPOINT, no working_dir (stay green)" PASS
# 189. D13 (qa-verification's second pass on T-180): the line the value used to
#      be read from, put inside a COMMENT, with the real declaration written so
#      the line match misses it. The gate reported 25 000 while PID 1 waited
#      60 s; the value now comes from the declaration the code uses.
mut "$ENTRY" "$DRAIN_LINE" '/* the wait, as a line match reads it:
const GROUP_DRAIN_MS = 25_000;
*/
const GROUP_DRAIN_MS =
  60_000;' \
  && run_case "189 D13: the matched line is a comment, the real wait is 60 s" FAIL "BELOW the floor of 65000 ms"
# 190. THE CONTROL for 189: the same declaration spread over two lines, with the
#      value unchanged, is green — 189's red is the value, not the formatting.
mut "$ENTRY" "$DRAIN_LINE" 'const GROUP_DRAIN_MS =
  25_000;' \
  && run_case "190 the declaration across two lines, 25_000 (stay green)" PASS
# 191. The one declaration must be a top-level const: a `let` is re-assignable,
#      so holding a grace against its initial value would prove nothing.
mut "$ENTRY" "$DRAIN_LINE" 'let GROUP_DRAIN_MS = 25_000;' \
  && run_case "191 GROUP_DRAIN_MS declared with let" FAIL "must be declared as a TOP-LEVEL"
# 192. QA's E4 refined: a flag with a separate value that this rule does not
#      model is refused AS A FLAG now, naming it, rather than by failing to map
#      the file that turned out to be its value.
mut "$DF" "$EP_LINE" 'ENTRYPOINT ["node", "--title", "kinvara", "/srv/kinvara/app-runtime/entrypoint.mjs"]' \
  && run_case "192 a node flag this rule does not model (--title)" FAIL "is not one this rule models"

# --- T-182 REWORK 1: THE SECOND QUESTION — WHAT PID 1 *IS* (QA-1) ------------
# Cases 169-192 above all answer "WHICH FILE does node run". qa-verification
# reached the identical hazard through keys that answer a different question —
# "what IS PID 1, and what code is loaded into it" — and all three were GATE
# PASS with §7b printing `14 of 14` pairs resolved: `pid: host` (MEASURED: the
# host's /sbin/init is PID 1, /proc/1/comm = systemd, and SIGQUIT then ends the
# container at ExitCode=131 in 2.19 s with no drain, against still running at
# 36.36 s — the same signature as the `init: true` case 183 refuses),
# `pid: service:<name>`, and `LD_PRELOAD` through compose `environment:`
# (MEASURED: five mappings of the named object inside PID 1's own address space,
# zero without it).
#
# THE KEY HALF IS AN ALLOW-LIST; THE ENVIRONMENT HALF IS A DENY-LIST (§7c/§7d).
# Rework 1 called both allow-lists and rework 2 had to correct that (OE-44), so
# read these cases for what each pins:
#   * 196 plants a compose KEY NOBODY IN THIS FAMILY HAS EVER NAMED and it is
#     refused for not being classified — that is the allow-list property, and it
#     is the case that would go green if §7c became a list of forbidden keys;
#   * 201 plants a variable nobody named INSIDE a listed namespace (`NODE_*`).
#     It pins the NAMESPACE, not an allow-list: a name outside every listed
#     namespace is admitted WITHOUT being read, which is how `OPENSSL_CONF`
#     reached GATE PASS at ae4eeea (cases 207-211, T-182 § Rework 2).
# Every FAIL case here is exit=0 GATE PASS under the gate as at e1e5bfa (the
# KINVARA_GATE_IMPL differential, state/EP-1/T-182.md § Rework 1).
echo; echo "=== cases 193-206 (T-182 rework 1, QA-1): §7c/§7d — what PID 1 IS. pid:, an unclassified key, user:, pull_policy:, LD_PRELOAD, a NODE_* nobody named, PATH ==="
# 193. QA-1's decisive plant: `pid: host`. Measured in a container above.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    pid: host
" \
  && run_case "193 pid: host — the host's init becomes PID 1" FAIL "the compose key 'pid:'"
# 194. The sibling spelling. compose resolves it (`docker compose config` with
#      both profiles, exit 0), and it is the same key, so the same refusal.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    pid: service:postgres
" \
  && run_case "194 pid: service:postgres" FAIL "the compose key 'pid:'"
# 195. THE CONTROL for 193/194, and it is the scope: the same key on a service
#      that is NOT an application service is nothing to do with this rule.
mut "$BASE" "$SM_HEAD" "$SM_HEAD    pid: host
" \
  && run_case "195 pid: host on stripe-mock (stay green)" PASS
# 196. THE ALLOW-LIST ITSELF: a compose key NOBODY in this family has named, on
#      an application service. It is refused because it is not classified — not
#      because anyone wrote a rule about capabilities. A tenth spelling is
#      IMPOSSIBLE here rather than uncaught, and this is the case that says so.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    cap_add: ['SYS_ADMIN']
" \
  && run_case "196 a compose key §7 has not classified (cap_add:)" FAIL "has not classified"
# 197. Found BY the allow-list: §5 reads USER in the Dockerfile, so a compose
#      `user:` decided the uid of PID 1 where no rule looked.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    user: '0:0'
" \
  && run_case "197 user: 0:0 on an application service" FAIL "the compose key 'user:'"
# 198. Also found by the allow-list, and MODELLED rather than neutral once read:
#      `pull_policy:` decides whether the image PID 1 comes from is built here
#      or fetched. In compose.yml no other rule requires `build` (§2's rule is
#      the verify overlay's), so this is the base file's own route.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    pull_policy: always
" \
  && run_case "198 pull_policy: always in compose.yml" FAIL "may be FETCHED"
# 199. THE CONTROL for 196-198: a key the allow-list classifies as NEUTRAL is
#      green. The rule is the classification, not the presence of a key —
#      case 170's point, one list over.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    restart: 'no'
" \
  && run_case "199 a NEUTRAL key (restart:) on core (stay green)" PASS
# 200. QA-1's second key: LD_PRELOAD through compose `environment:`. Measured in
#      PID 1's own /proc/1/maps. This is case 174's hazard by way of the dynamic
#      loader instead of node, and it is the shape a native APM agent uses.
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      LD_PRELOAD: /usr/lib/libz.so.1" \
  && run_case "200 LD_PRELOAD via compose environment:" FAIL "LOADER's own namespace"
# 201. §7d's OWN allow-list case, the sibling of 196: a variable NOBODY has
#      named, refused because NODE_* is a namespace node reads, not because
#      anyone enumerated this spelling.
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      NODE_REPL_EXTERNAL_MODULE: /srv/kinvara/app-runtime/pre.mjs" \
  && run_case "201 a NODE_* variable §7d does not admit" FAIL "LOADER's own namespace"
# 202. PATH: the image's ENTRYPOINT is ["node", ...] with no directory, so PATH
#      decides WHICH BINARY is PID 1 — measured: PATH=/nonexistent and the
#      container cannot start at all (docker run exit 127).
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      PATH: /opt/qa:/usr/local/bin:/usr/bin:/bin" \
  && run_case "202 PATH via compose environment:" FAIL "WHICH BINARY is PID 1"
# 203. THE CONTROL for 200-202: a variable in no loader's namespace is green.
#      §7d refuses a NAMESPACE, not `environment:`.
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      KINVARA_T182_PROBE: '1'" \
  && run_case "203 an env var in no loader namespace (stay green)" PASS
# 204. qa-verification's A4, caught but uncased: `command:` as a STRING under
#      the image's exec-form entrypoint. § contract 3 claimed the command: half
#      was refused too and only the entrypoint: half (171) had a case.
mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    command: node /srv/kinvara/app-runtime/pid1.mjs
" \
  && run_case "204 command: as a STRING (shell form)" FAIL "SHELL form"
# 205. qa-verification's A5, caught but uncased: the CHAOS overlay declaring an
#      application service. It is genuinely in the composed set, and the pair
#      count rises to 15 of 15 when it does.
cp "$ENTRY" "$PID1" && mut "$PID1" "$DRAIN_LINE" 'const GROUP_DRAIN_MS = 60_000;' \
  && mut "$CHAOS" 'services: {}' "services:
  core:
    entrypoint: ['node', '/srv/kinvara/app-runtime/pid1.mjs']" \
  && run_case "205 compose.chaos.yml declares core with entrypoint:" FAIL "BELOW the floor of 65000 ms"
# 206. qa-verification's V6, measured and uncased: the `secrets:` half of the
#      mount reader (app-images.ts mountTargets). The claim this pins is the
#      READER's — that a secrets: target over PID 1's script is refused the way
#      a volumes:/configs: one is; compose's own mount semantics for an absolute
#      secret target are not measured here.
mk_pid1_cfg && mut "$BASE" '
volumes:
' '
secrets:
  qa_pid1_s:
    file: ./qa-pid1.cfg

volumes:
' && mut "$BASE" "$CORE_HEAD" "$CORE_HEAD    secrets:
      - source: qa_pid1_s
        target: /srv/kinvara/app-runtime/entrypoint.mjs
" \
  && run_case "206 a secrets: target over PID 1's script" FAIL "covers PID 1's script"

# --- T-182 REWORK 2: §7d WIDENED BY MEASUREMENT (OE-44) ----------------------
# The orchestrator defeated rework 1's four-namespace environment rule with
# `OPENSSL_CONF: /srv/kinvara/evil.cnf` placed INSIDE `core`'s real
# `environment:` block: exit=0, GATE PASS, `14 of 14` pairs printed as resolved.
# Stakeholder ruling B on OE-44: widen by measurement, merge, cut `T-183` (the
# environment ALLOW-LIST, anchored to a checked per-app manifest).
#
# WHAT WAS MEASURED, in the five shipping application images (all five run the
# same node: sha256 3840e7a7…, v24.20.0, OpenSSL 3.5.7, Alpine 3.24.1/musl):
#   * the objects mapped into a real node process are node, libstdc++, libgcc_s
#     and ld-musl — so the loaders in PID 1 are musl's ld.so, node/V8, and the
#     OpenSSL 3.5.7 node links STATICALLY (no libcrypto.so in ldd);
#   * a FIFO-poison sweep over every env-name-shaped string in those four
#     objects (if the process OPENs the value, open(2) blocks and the run is
#     killed) found exactly three names OPENED: LD_PRELOAD (rework 1's hazard,
#     the positive control), NODE_EXTRA_CA_CERTS (already NODE_*), and
#     OPENSSL_CONF — at startup, before any application code;
#   * OPENSSL_CONF LOADS CODE: with the app section spelled `nodejs_conf`
#     (node's own config appname; `openssl_conf` is IGNORED), a `providers`
#     section dlopens the module it names, and with a real .so PID 1 dies in
#     node::InitializeOncePerProcessInternal — `Assertion failed:
#     ncrypto::CSPRNG(nullptr, 0)`, SIGABRT, container ExitCode=139 — against a
#     control that boots the app. OPENSSL_MODULES / OPENSSL_ENGINES /
#     OPENSSL_CONF_INCLUDE each decide WHERE that code comes from.
# So `OPENSSL_*` is a loader namespace here, and SSL_CERT_FILE/SSL_CERT_DIR/
# CTLOG_FILE are refused as exact names on the argument (the sweep did NOT reach
# them — stated in §7d rather than dressed as a measurement).
# Every FAIL case below is exit=0 GATE PASS under the gate as at ae4eeea (the
# KINVARA_GATE_IMPL differential, state/EP-1/T-182.md § Rework 2).
echo; echo "=== cases 207-211 (T-182 rework 2, OE-44): §7d widened by measurement — OPENSSL_* loads code into PID 1 ==="
# 207. OE-44's OWN CONSTRUCTION, reproduced in the valid form: the variable goes
#      INSIDE core's existing environment: block (a second `environment:` key
#      trips the pre-existing duplicate-key rule and would be a FAIL for the
#      wrong reason — the orchestrator threw that first attempt away and so do we).
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      OPENSSL_CONF: /srv/kinvara/evil.cnf" \
  && run_case "207 OPENSSL_CONF via compose environment: (OE-44)" FAIL "LOADER's own namespace"
# 208. The same name from the IMAGE's own ENV, the direction case 176 covers for
#      NODE_OPTIONS. §7d reads both sources and this is the half a Dockerfile
#      edit reaches. NOTE THE PLANT: app.Dockerfile:226-232 is ONE `ENV`
#      instruction continued over seven lines, so the new variable needs the
#      backslash — appending a bare line makes the file invalid and the gate
#      then reads no such ENV at all (my first spelling of this case was exactly
#      that mistake: exit=0 PASS for the wrong reason, T-182 § Rework 2).
mut "$DF" '    NODE_OPTIONS=--enable-source-maps' '    NODE_OPTIONS=--enable-source-maps \
    OPENSSL_CONF=/srv/kinvara/evil.cnf' \
  && run_case "208 Dockerfile ENV OPENSSL_CONF" FAIL "LOADER's own namespace"
# 209. THE NAMESPACE, not the name: `OPENSSL_ia32cap` is a spelling nobody in
#      this family has named, and its tail is lower-case — it is refused because
#      OPENSSL_ is a loader namespace, which is what this case pins (the sibling
#      of 201, one namespace over).
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      OPENSSL_ia32cap: '~0x20000000'" \
  && run_case "209 an OPENSSL_* variable nobody named" FAIL "LOADER's own namespace"
# 210. The EXACT-NAME half: an OpenSSL file input with no OPENSSL_ prefix. Its
#      refusal message says it is refused on the ARGUMENT and that the sweep did
#      not reach it, so the case pins the refusal and not a hazard measurement.
mut "$BASE" "$CORE_ENV" "$CORE_ENV
      SSL_CERT_FILE: /srv/kinvara/evil-ca.pem" \
  && run_case "210 SSL_CERT_FILE — an OpenSSL file input, no prefix" FAIL "REFUSED ON THE ARGUMENT"
# 211. THE CONTROL for 207-210, and it is the scope: the same variable on a
#      service that is not an application service is nothing to do with §7d.
mut "$BASE" '    image: stripe/stripe-mock:v0.194.0' '    image: stripe/stripe-mock:v0.194.0
    environment:
      OPENSSL_CONF: /srv/kinvara/evil.cnf' \
  && run_case "211 OPENSSL_CONF on stripe-mock (stay green)" PASS

echo
run_case "99 tree restored" PASS
echo
# T-156 (OD-119): the tracked-files check. The anchor is TREE0, read before the
# first case, so this compares the tree against itself-before rather than against
# a list written down here — a `git status` that is empty for the wrong reason
# cannot satisfy it, and a pre-existing dirty tree is not counted against the
# suite. restore() has already run (run_case's last act, and the EXIT trap's).
tree_final="$(git status --porcelain)"
if [[ "$tree_final" == "$TREE0" ]]; then
  tree_bad=0
  echo "WORKING TREE UNCHANGED: git status --porcelain identical before and after ($(printf '%s' "$TREE0" | grep -c . || true) line(s))"
else
  tree_bad=1
  echo "!! WORKING TREE CHANGED: this suite did not restore what it planted"
  diff <(printf '%s\n' "$TREE0") <(printf '%s\n' "$tree_final") | sed 's/^/   /'
fi
if [[ $bad -eq 0 && $harness -eq 0 && $leaks -eq 0 && $tree_bad -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S); $leaks TREE LEAK(S)"
fi
exit $((bad + harness + leaks + tree_bad))
