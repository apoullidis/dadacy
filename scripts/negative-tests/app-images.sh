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
DF=docker/app.Dockerfile
BK="$(mktemp -d)"
cp "$VERIFY" "$BK/verify"; cp "$DF" "$BK/df"; cp scripts/svc "$BK/svc"; cp apps/core/package.json "$BK/corepkg"
restore() {
  cp "$BK/verify" "$VERIFY"; cp "$BK/df" "$DF"; cp "$BK/svc" scripts/svc; cp "$BK/corepkg" apps/core/package.json
  rm -rf apps/core/src
}
trap 'restore; rm -rf "$BK"' EXIT

bad=0
mut() { node scripts/negative-tests/mutate.mjs "$@" || { echo "   HARNESS ERROR"; bad=$((bad+1)); return 1; }; }
run_case() {
  local label="$1" expect="$2" out code
  out="$(node scripts/gates/app-images.ts 2>&1)"; code=$?
  local verdict; [[ $code -eq 0 ]] && verdict=PASS || verdict=FAIL
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

echo; echo "=== no host ports on a ticket project (OD-4) ==="
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

echo; echo "=== a placeholder may not outlive real source ==="
mkdir -p apps/core/src && echo 'export const x = 1;' > apps/core/src/index.ts
run_case "13 apps/core has src/ but declares no start script" FAIL
mkdir -p apps/core/src && echo 'export const x = 1;' > apps/core/src/index.ts
node scripts/negative-tests/mutate.mjs apps/core/package.json '"type": "module",' '"type": "module",
  "scripts": { "start": "node dist/main.js" },' && run_case "14 the same, once it declares start" PASS

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 ]]; then echo "ALL 17 CASES BEHAVED AS EXPECTED"; else echo "!! $bad CASE(S) MISBEHAVED"; fi
exit $bad
