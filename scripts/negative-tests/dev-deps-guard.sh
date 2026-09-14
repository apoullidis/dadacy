#!/usr/bin/env bash
# scripts/negative-tests/dev-deps-guard.sh — the RULE of
# docker/app-runtime/assert-no-dev-deps.mjs, attacked on synthetic workspaces
# (T-154, decisions.md OD-117, OD-122). No Docker, no services:
#
#   ./scripts/dev bash scripts/negative-tests/dev-deps-guard.sh
#
# DEV_DEPS_GUARD=<path> runs the same cases against another copy of the guard
# (for example main's, extracted with `git show`), to see which cases depend on
# the guard under test.
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

GUARD="${DEV_DEPS_GUARD:-docker/app-runtime/assert-no-dev-deps.mjs}"
W="$(mktemp -d)"
I="$(mktemp -d)"
trap 'rm -rf "$W" "$I"' EXIT
bad=0; harness=0; ran=0

put() { mkdir -p "$(dirname "$W/$1")"; printf '%s\n' "$2" > "$W/$1"; }
store() { mkdir -p "$W/node_modules/.pnpm/$1"; }

# The baseline: the shape OD-117 was measured on. The root declares pg and
# drizzle-orm as devDependencies for its own scripts; app1 declares them as
# runtime dependencies; lib (in app1's closure) calls typescript and vitest dev;
# `other` (outside the closure) calls zod dev. pnpm-lock.yaml lists the four
# projects as importers, in both of pnpm's spellings (a block, and `{}`).
reset() {
  rm -rf "${W:?}"/* "$W"/.[!.]* "${I:?}"/* "$I"/.[!.]* 2>/dev/null
  put package.json '{"name":"kinvara","devDependencies":{"typescript":"6.0.3","drizzle-kit":"0.31.10","drizzle-orm":"0.45.2","pg":"8.23.0"}}'
  put apps/app1/package.json '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*","drizzle-orm":"0.45.2","pg":"8.23.0"},"devDependencies":{"vitest":"5.0.0"}}'
  put packages/lib/package.json '{"name":"@kinvara/lib","dependencies":{},"devDependencies":{"typescript":"6.0.3","vitest":"5.0.0"}}'
  put apps/other/package.json '{"name":"@kinvara/other","devDependencies":{"zod":"4.5.4"}}'
  put pnpm-lock.yaml "lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      pg:
        specifier: 8.23.0
  apps/app1:
    dependencies:
      pg:
        specifier: 8.23.0
  apps/other: {}
  packages/lib:
    devDependencies:
      typescript:
        specifier: 6.0.3

packages:

  pg@8.23.0:
    resolution: {integrity: sha512-x}"
  store pg@8.23.0
  store drizzle-orm@0.45.2_pg@8.23.0
}

# image_of_runtime: build $I the way app.Dockerfile's runtime stage is built
# from $W: the root manifest, packages/, apps/app1 only, and node_modules. No
# lockfile, no other app.
image_of_runtime() {
  rm -rf "${I:?}"/* "$I"/.[!.]* 2>/dev/null
  cp "$W/package.json" "$I/package.json"
  cp -a "$W/packages" "$I/packages"
  mkdir -p "$I/apps" && cp -a "$W/apps/app1" "$I/apps/app1"
  cp -a "$W/node_modules" "$I/node_modules"
}

# landed <file> <string>: the planted change is in the tree, or the case does not run
landed() { grep -qF -- "$2" "$W/$1" || { echo "   HARNESS ERROR: '$2' not in $1"; harness=$((harness+1)); return 1; }; }
landed_store() { [[ -d "$W/node_modules/.pnpm/$1" ]] || { echo "   HARNESS ERROR: store dir $1 absent"; harness=$((harness+1)); return 1; }; }
# in_image / not_in <tree> <rel>: a path is (is not) present in $I or $W
in_image() { [[ -e "$I/$1" ]] || { echo "   HARNESS ERROR: $1 absent from the image tree"; harness=$((harness+1)); return 1; }; }
not_in() { [[ ! -e "$1/$2" ]] || { echo "   HARNESS ERROR: $2 still present under $1"; harness=$((harness+1)); return 1; }; }

# run_case <label> <OK|REFUSED|CRASH> <text the output must contain> [app] [guard path] [image tree]
# The workspace tree is $W unless WS=<tree> is set for the call.
run_case() {
  local label="$1" expect="$2" needle="$3" app="${4-app1}" guard="${5-$GUARD}" image="${6-}" ws="${WS:-$W}" out code verdict
  ran=$((ran+1))
  out="$(node "$guard" "$ws" ${app:+"$app"} ${image:+"$image"} 2>&1)"; code=$?
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

echo; echo "=== the stage that ships holds only apps/<APP>: names come from the WORKSPACE tree, the store from the IMAGE tree (OD-122) ==="

reset; image_of_runtime
in_image apps/app1/package.json && not_in "$I" apps/other/package.json && not_in "$I" pnpm-lock.yaml \
  && run_case "D8 CONTROL: image tree without apps/other or the lockfile, nothing planted" OK \
       'image: 3 manifest(s), each byte-identical to the workspace' app1 "$GUARD" "$I"

reset; store esbuild@0.28.2
put apps/other/package.json '{"name":"@kinvara/other","devDependencies":{"esbuild":"0.28.2"}}'
image_of_runtime
landed apps/other/package.json '"esbuild":"0.28.2"' && in_image node_modules/.pnpm/esbuild@0.28.2 && not_in "$I" apps/other/package.json \
  && run_case "D9 QA-K11: esbuild dev ONLY in apps/other (absent from the image), in the image store" REFUSED \
       'esbuild  (virtual store: esbuild@0.28.2; declared in apps/other/package.json)' app1 "$GUARD" "$I"

reset; store esbuild@0.28.2
put packages/lib/package.json '{"name":"@kinvara/lib","dependencies":{},"devDependencies":{"typescript":"6.0.3","vitest":"5.0.0","esbuild":"0.28.2"}}'
image_of_runtime
landed packages/lib/package.json '"esbuild":"0.28.2"' && in_image node_modules/.pnpm/esbuild@0.28.2 && in_image packages/lib/package.json \
  && run_case "D10 QA-K11c: esbuild dev ONLY in packages/lib (present in the image), in the image store" REFUSED \
       'esbuild  (virtual store: esbuild@0.28.2; declared in packages/lib/package.json)' app1 "$GUARD" "$I"

reset; store esbuild@0.28.2
put apps/other/package.json '{"name":"@kinvara/other","devDependencies":{"esbuild":"0.28.2"}}'
image_of_runtime
landed apps/other/package.json '"esbuild":"0.28.2"' && not_in "$I" pnpm-lock.yaml && not_in "$I" apps/other/package.json \
  && WS="$I" run_case "D11 the K11 image tree judged ALONE (the pre-rework runtime invocation)" REFUSED \
       'has no pnpm-lock.yaml, so it is not a whole workspace' app1

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

reset; rm -f "$W/pnpm-lock.yaml"
not_in "$W" pnpm-lock.yaml \
  && run_case "F5 the workspace tree has no pnpm-lock.yaml" REFUSED 'has no pnpm-lock.yaml, so it is not a whole workspace'

reset; rm -rf "$W/apps/other"
not_in "$W" apps/other/package.json && landed pnpm-lock.yaml '  apps/other: {}' \
  && run_case "F6 a lockfile importer (apps/other) whose package.json is not in the workspace tree" REFUSED \
       'whose package.json is not under'

reset; put pnpm-lock.yaml "lockfileVersion: '9.0'

packages:

  pg@8.23.0:
    resolution: {integrity: sha512-x}"
landed pnpm-lock.yaml 'lockfileVersion' && ! grep -q '^importers:' "$W/pnpm-lock.yaml" \
  && run_case "F7 a lockfile with no importers: section" REFUSED 'lists no importers'

reset; image_of_runtime
printf '%s\n' '{"name":"@kinvara/app1","dependencies":{"@kinvara/lib":"workspace:*","drizzle-orm":"0.45.2","pg":"8.23.0","zod":"4.5.4"},"devDependencies":{"vitest":"5.0.0"}}' > "$I/apps/app1/package.json"
grep -qF '"zod":"4.5.4"' "$I/apps/app1/package.json" && ! grep -qF '"zod"' "$W/apps/app1/package.json" \
  && run_case "F8 the image's apps/app1/package.json differs from the workspace's" REFUSED \
       'differs from' app1 "$GUARD" "$I"

reset; image_of_runtime
mkdir -p "$I/packages/extra" && printf '%s\n' '{"name":"@kinvara/extra"}' > "$I/packages/extra/package.json"
in_image packages/extra/package.json && not_in "$W" packages/extra/package.json \
  && run_case "F9 a package.json in the image with no counterpart in the workspace" REFUSED \
       'is in the image but not in the workspace' app1 "$GUARD" "$I"

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
