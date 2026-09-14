#!/usr/bin/env bash
# scripts/negative-tests/dev-deps-guard.sh — the RULE of
# docker/app-runtime/assert-no-dev-deps.mjs, attacked on synthetic workspaces
# (T-154, decisions.md OD-117). No Docker, no services:
#
#   ./scripts/dev bash scripts/negative-tests/dev-deps-guard.sh
#
# The image builds prove the guard RUNS in the stage that ships. This suite
# proves what the rule DECIDES, including the one route it lets through (D3),
# which is recorded as an expected OK so the bound is visible in the output.
#
# Every case asserts the exit status AND the guard's own line:
#   OK       exit 0 and "OK — none of the checked names is present"
#   REFUSED  exit 1 and either "DEVDEPENDENCIES ARE IN THE RUNTIME DEPENDENCY
#            TREE." or "refusing to pass"
#   CRASH    anything else
# and a case whose planted change is not in the tree is a HARNESS ERROR, never
# a verdict (PROTOCOL.md §5.1).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 99

GUARD="docker/app-runtime/assert-no-dev-deps.mjs"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
bad=0; harness=0; ran=0

put() { mkdir -p "$(dirname "$W/$1")"; printf '%s\n' "$2" > "$W/$1"; }
store() { mkdir -p "$W/node_modules/.pnpm/$1"; }

# The baseline: the shape OD-117 was measured on. The root declares pg and
# drizzle-orm as devDependencies for its own scripts; app1 declares them as
# runtime dependencies; lib (in app1's closure) calls typescript and vitest dev;
# `other` (outside the closure) calls zod dev.
reset() {
  rm -rf "${W:?}"/* "$W"/.[!.]* 2>/dev/null
  put package.json '{"name":"kinvara","devDependencies":{"typescript":"6.0.3","drizzle-kit":"0.31.10","drizzle-orm":"0.45.2","pg":"8.23.0"}}'
  put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*","drizzle-orm":"0.45.2","pg":"8.23.0"},"devDependencies":{"vitest":"5.0.0"}}'
  put packages/lib/package.json '{"name":"@kinvara/lib","dependencies":{},"devDependencies":{"typescript":"6.0.3","vitest":"5.0.0"}}'
  put apps/other/package.json '{"name":"@kinvara/other","devDependencies":{"zod":"4.5.4"}}'
  store pg@8.23.0
  store drizzle-orm@0.45.2_pg@8.23.0
}

# landed <file> <string>: the planted change is in the tree, or the case does not run
landed() { grep -qF -- "$2" "$W/$1" || { echo "   HARNESS ERROR: '$2' not in $1"; harness=$((harness+1)); return 1; }; }
landed_store() { [[ -d "$W/node_modules/.pnpm/$1" ]] || { echo "   HARNESS ERROR: store dir $1 absent"; harness=$((harness+1)); return 1; }; }

# run_case <label> <OK|REFUSED|CRASH> <text the output must contain> [app] [guard path]
run_case() {
  local label="$1" expect="$2" needle="$3" app="${4-app1}" guard="${5-$GUARD}" out code verdict
  ran=$((ran+1))
  out="$(node "$guard" "$W" ${app:+"$app"} 2>&1)"; code=$?
  if [[ $code -eq 0 && "$out" == *"OK — none of the checked names is present"* ]]; then verdict=OK
  elif [[ $code -eq 1 && ( "$out" == *"DEVDEPENDENCIES ARE IN THE RUNTIME DEPENDENCY TREE."* || "$out" == *"refusing to pass"* ) ]]; then verdict=REFUSED
  else verdict=CRASH
  fi
  if [[ "$verdict" == "$expect" && "$out" == *"$needle"* ]]; then
    printf '  ok   %-70s exit=%d %s\n' "$label" "$code" "$verdict"
  else
    printf '  BAD  %-70s exit=%d %s (expected %s, containing %q)\n' "$label" "$code" "$verdict" "$expect" "$needle"
    printf '%s\n' "$out" | sed 's/^/       | /'
    bad=$((bad+1))
  fi
}

echo "=== the rule: exempt only if NO closure manifest calls it dev AND a closure manifest declares it runtime ==="

reset
landed apps/app1/package.json '"pg":"8.23.0"' && landed_store pg@8.23.0 \
  && run_case "D0 CONTROL: pg + drizzle-orm, dev only at the root, runtime in app1" OK \
       'drizzle-orm (devDependency of package.json; runtime dependency of apps/app1/package.json)'

reset; store typescript@6.0.3
landed_store typescript@6.0.3 \
  && run_case "D1 typescript in the store (dev at root and in lib)" REFUSED 'typescript  (virtual store: typescript@6.0.3'

reset; store vitest@5.0.0
put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*","drizzle-orm":"0.45.2","pg":"8.23.0","vitest":"5.0.0"}}'
landed apps/app1/package.json '"vitest":"5.0.0"}}' && landed_store vitest@5.0.0 \
  && run_case "D2 vitest MOVED to app1 dependencies; lib (in the closure) still calls it dev" REFUSED 'vitest  (virtual store: vitest@5.0.0'

reset; store drizzle-kit@0.31.10
put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*","drizzle-kit":"0.31.10","drizzle-orm":"0.45.2","pg":"8.23.0"}}'
landed apps/app1/package.json '"drizzle-kit":"0.31.10"' && landed_store drizzle-kit@0.31.10 \
  && run_case "D3 THE BOUND: root-only devtool declared as app1 runtime dep SHIPS" OK 'drizzle-kit (devDependency of package.json; runtime dependency of apps/app1/package.json)'

reset
put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*"}}'
landed apps/app1/package.json '"@kinvara/lib":"workspace:*"}}' && landed_store pg@8.23.0 \
  && run_case "D4 pg in the store, app1 does NOT declare it: refused as before T-154" REFUSED 'pg  (virtual store: pg@8.23.0; declared in package.json)'

reset
put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*"}}'
put packages/lib/package.json '{"name":"@kinvara/lib","dependencies":{"drizzle-orm":"0.45.2","pg":"8.23.0"},"devDependencies":{"typescript":"6.0.3","vitest":"5.0.0"}}'
landed packages/lib/package.json '"dependencies":{"drizzle-orm"' \
  && run_case "D5 pg declared runtime by lib, reached through workspace:* (transitive closure)" OK \
       'pg (devDependency of package.json; runtime dependency of packages/lib/package.json)'

reset; store zod@4.5.4
landed_store zod@4.5.4 \
  && run_case "D6 zod dev in apps/other (outside the closure), undeclared by app1" REFUSED 'zod  (virtual store: zod@4.5.4; declared in apps/other/package.json)'

reset; mkdir -p "$W/node_modules/typescript"
[[ -d "$W/node_modules/typescript" ]] \
  && run_case "D7 typescript as a TOP-LEVEL node_modules entry" REFUSED 'typescript  (top-level node_modules/typescript'

echo; echo "=== fail closed ==="
reset
run_case "F1 no APP argument" REFUSED 'no APP argument' ''
run_case "F2 APP names no apps/<APP>/package.json" REFUSED "APP 'nope' has no apps/nope/package.json" nope
put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/missing":"workspace:*"}}'
landed apps/app1/package.json '@kinvara/missing' \
  && run_case "F3 a workspace: spec naming no workspace manifest" REFUSED 'no workspace manifest is named @kinvara/missing'
reset
put package.json '{"name":"kinvara","devDependencies":{"pg":"8.23.0"}}'
put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*","pg":"8.23.0"}}'
put packages/lib/package.json '{"name":"@kinvara/lib"}'
put apps/other/package.json '{"name":"@kinvara/other"}'
landed package.json '{"name":"kinvara","devDependencies":{"pg":"8.23.0"}}' \
  && run_case "F4 every devDependency name exempt: asserts nothing" REFUSED 'every devDependency name is exempt'

echo; echo "=== the harness can tell a crash from a refusal ==="
reset
run_case "H1 CONTROL: the guard path does not exist (node exits 1, no banner)" CRASH 'Cannot find module' app1 docker/app-runtime/no-such-guard.mjs

echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL ${ran} CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! ${bad} of ${ran} CASE(S) MISBEHAVED; ${harness} HARNESS ERROR(S)"
exit $((bad + harness))
