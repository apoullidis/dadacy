#!/usr/bin/env bash
# T-244 negative tests: gate:deps REFUSING an app -> app import, a package -> app
# import, and a manifest naming an app package (OD-292a), each by RULE NAME, then
# passing again once reverted (PROTOCOL §5.1).
#
# Run it in the toolbox — node and depcruise exist nowhere else (DOCKER.md §0.1):
#
#   cd /home/alex/projects/nanny/app
#   ./scripts/dev bash scripts/negative-tests/deps-cross-app.sh
#
# gate:negative-suites runs it on every PR (rostered as `deps-cross-app`).
#
# HOW A CASE IS JUDGED. Never by a non-zero exit alone: a crash and a refusal are
# different outcomes (PROTOCOL §5.1, OD-27). A FAIL verdict needs exit 1 AND the
# `GATE FAIL  gate:deps` banner AND, where the case names them, every REQUIRED
# line — the exact `error <rule>: <from> → <to>` edge the plant creates — AND none
# of the FORBIDDEN substrings. Anything else is FAIL-OTHER or CRASH, and misbehaves.
# Every plant is asserted LANDED before its effect is judged (T-039's no-op probe).
#
# TREE SAFETY (T-156, T-168). The suite refuses a dirty tree, never deletes a
# tracked path, restores the files it edits from byte copies, and removes only the
# untracked paths it planted (symlinks with `rm -f`, no trailing slash, so a link is
# never followed). An EXIT/INT/TERM trap restores on interruption. Case 99 asserts
# `git status --porcelain` is empty and every edited file is byte-identical.
set -uo pipefail
cd "$(dirname "$0")/../.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSED: the working tree is not clean; this suite plants into it. Commit first."
  git status --porcelain
  exit 2
fi

GATE=scripts/gates/deps.ts
CFG=.dependency-cruiser.cjs
WPKG=apps/worker/package.json
WTSC=apps/worker/tsconfig.json
CPKG=packages/contracts/package.json
RTSC=tsconfig.json
EDITED=("$CFG" "$GATE" "$WPKG" "$WTSC" "$CPKG" "$RTSC")

W=apps/worker/src
NMK=apps/worker/node_modules/@kinvara
PLANTS=(
  "$W/qa-t244-r1.ts" "$W/qa-t244-r2.ts" "$W/qa-t244-r3.ts" "$W/qa-t244-r4.ts"
  apps/core/src/qa-t244-r5.ts packages/contracts/src/qa-t244-r6.ts "$W/qa-t244-r7.ts"
  apps/worker/test/qa-t244-r8.test.ts "$W/qa-t244-r9.ts" "$W/qa-t244-r10.ts"
  "$W/qa-t244-corelink" "$W/qa-t244-dblink.ts" "$W/qa-t244-c1.ts" apps/core/src/qa-t244-c2.ts
  "$NMK/core" "$NMK/contracts"
)

BK="$(mktemp -d)"
for f in "${EDITED[@]}"; do cp -p "$f" "$BK/$(echo "$f" | tr / _)"; done
for p in "${PLANTS[@]}"; do
  if [[ -e "$p" || -L "$p" ]]; then
    echo "REFUSED: $p already exists; this suite plants it and would remove it afterwards."
    exit 2
  fi
done
NMK_CREATED=0
[[ -d "$NMK" ]] || NMK_CREATED=1

restore() {
  for f in "${EDITED[@]}"; do cp -p "$BK/$(echo "$f" | tr / _)" "$f"; done
  for p in "${PLANTS[@]}"; do rm -f "$p"; done
  if [[ $NMK_CREATED -eq 1 && -d "$NMK" ]]; then rmdir "$NMK" 2>/dev/null; fi
  return 0
}
trap 'restore; rm -rf "$BK"' EXIT
trap 'restore; rm -rf "$BK"; echo "INTERRUPTED (tree restored)"; exit 130' INT
trap 'restore; rm -rf "$BK"; echo "TERMINATED (tree restored)"; exit 143' TERM

bad=0
ran=0
harness=0

# A plant must prove it LANDED before its effect is judged (PROTOCOL §5.1, T-039).
# A plant that did not land is that case misbehaving: it is COUNTED (ran and bad), so
# the footer keeps the full case count and gate:negative-suites reports a red suite
# rather than a shrunken one.
landed() {
  local what="$1"; shift
  if "$@"; then return 0; fi
  echo "!! HARNESS ERROR (mutation did not land: $what)"
  harness=$((harness + 1))
  ran=$((ran + 1))
  bad=$((bad + 1))
  restore
  return 1
}
has_line() { grep -qF -- "$2" "$1"; }
is_link_to() { [[ -L "$1" && "$(readlink "$1")" == "$2" ]]; }
json_has() { node -e 'const [f, s, k] = process.argv.slice(1); const m = JSON.parse(require("fs").readFileSync(f, "utf8")); process.exit(m[s] && Object.hasOwn(m[s], k) ? 0 : 1)' "$1" "$2" "$3"; }
cfg_lacks_rule() { node -e 'const c = require(require("path").resolve(process.argv[1])); process.exit(c.forbidden.some((r) => r.name === process.argv[2]) ? 1 : 0)' "$CFG" "$1"; }
differs() { ! cmp -s "$1" "$BK/$(echo "$1" | tr / _)"; }
# Write a manifest key, as `pnpm add` would (JSON rewritten, 2-space indent).
set_dep() {
  node -e 'const [f, s, k, v] = process.argv.slice(1); const fs = require("fs"); const m = JSON.parse(fs.readFileSync(f, "utf8")); m[s] = { ...(m[s] ?? {}), [k]: v }; fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n")' "$@"
}
# A pnpm workspace link exactly as `pnpm install` writes it (apps/core/node_modules/@kinvara/contracts
# is `-> ../../../../packages/contracts`, measured): a symlink to the package directory.
link_pkg() { mkdir -p "$NMK" && ln -s "$2" "$NMK/$1"; }

REQ=()
FORBID=()
run_case() {
  local label="$1" expect="$2"
  local out code verdict missing=""
  out="$(node "$GATE" 2>&1)"; code=$?
  if [[ $code -eq 0 && "$out" == *"GATE PASS  gate:deps"* ]]; then
    verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"GATE FAIL  gate:deps"* ]]; then
    verdict=FAIL
  else
    verdict=CRASH
  fi
  if [[ $verdict != CRASH ]]; then
    for r in "${REQ[@]+"${REQ[@]}"}"; do
      [[ "$out" == *"$r"* ]] || { verdict="$verdict-OTHER"; missing="missing: $r"; break; }
    done
    for f in "${FORBID[@]+"${FORBID[@]}"}"; do
      [[ "$out" != *"$f"* ]] || { verdict="${verdict%-OTHER}-OTHER"; missing="present: $f"; break; }
    done
  fi
  ran=$((ran + 1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad + 1)); }
  printf '%s %-62s exit=%d  %-10s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  for r in "${REQ[@]+"${REQ[@]}"}"; do
    [[ "$out" == *"$r"* ]] && printf '       %s\n' "$(printf '%s\n' "$out" | grep -F -- "$r" | head -1 | cut -c1-160)"
  done
  [[ -n "$missing" ]] && printf '       %s\n' "$missing"
  [[ "$verdict" == CRASH* ]] && printf '%s\n' "$out" | tail -4 | sed 's/^/       /'
  REQ=()
  FORBID=()
  restore
}

E1='error no-cross-app-import:'
E2='error no-package-to-app-import:'
E3='error no-app-package-dependency:'
EU='error not-to-unresolvable:'
DB=apps/core/src/identity/database.ts

echo "=== baseline and anti-vacuity ==="
run_case "00 unmodified tree" PASS

# The cruiser read the worker's source at all: a non-zero count, printed by the gate.
out="$(node "$GATE" 2>&1)"
n="$(printf '%s\n' "$out" | sed -n 's|^  modules cruised under apps/worker/src/: \([0-9]*\) .*|\1|p')"
cov="$(printf '%s\n' "$out" | sed -n 's|^coverage: \([0-9]*\) tracked source file(s) under apps/ and packages/, \([0-9]*\) of them cruised$|\1 \2|p')"
ran=$((ran + 1))
if [[ -n "$n" && "$n" -gt 0 && -n "$cov" && "${cov% *}" -gt 0 && "${cov% *}" == "${cov#* }" ]]; then
  printf '   %-62s ok (apps/worker/src: %s module(s); tracked/cruised: %s)\n' "A1 modules cruised under apps/worker/src > 0; coverage full" "$n" "$cov"
else
  printf '!! %-62s MISBEHAVED (apps/worker/src: %s; coverage: %s)\n' "A1 modules cruised under apps/worker/src > 0; coverage full" "${n:-none}" "${cov:-none}"
  bad=$((bad + 1))
fi

echo
echo "=== rule (1) no-cross-app-import — every import form, both directions, tests too ==="

# R1 is T-242 § QA Q10's probe file, verbatim.
printf "import { Database } from '../../core/src/identity/database.ts';\nexport const qaProbe = Database;\n" > "$W/qa-t244-r1.ts"
landed "R1 plant" has_line "$W/qa-t244-r1.ts" "from '../../core/src/identity/database.ts'" && {
  REQ=("$E1 $W/qa-t244-r1.ts → $DB")
  run_case "R1 T-242 Q10 verbatim: static import worker -> core" FAIL; }

printf "import type { Database } from '../../core/src/identity/database.ts';\nexport type R2 = Database;\n" > "$W/qa-t244-r2.ts"
landed "R2 plant" has_line "$W/qa-t244-r2.ts" "import type { Database }" && {
  REQ=("$E1 $W/qa-t244-r2.ts → $DB")
  run_case "R2 import type, same path" FAIL; }

printf "export { Database } from '../../core/src/identity/database.ts';\n" > "$W/qa-t244-r3.ts"
landed "R3 plant" has_line "$W/qa-t244-r3.ts" "export { Database } from" && {
  REQ=("$E1 $W/qa-t244-r3.ts → $DB")
  run_case "R3 export { … } from '../../core/src/…'" FAIL; }

printf "const m = await import('../../core/src/identity/database.ts');\nexport const r4 = m.Database;\n" > "$W/qa-t244-r4.ts"
landed "R4 plant" has_line "$W/qa-t244-r4.ts" "await import('../../core/src/identity/database.ts')" && {
  REQ=("$E1 $W/qa-t244-r4.ts → $DB")
  run_case "R4 await import('../../core/src/…'), literal specifier" FAIL; }

printf "import { PGBOSS_SCHEMA } from '../../worker/src/config.ts';\nexport const r5 = PGBOSS_SCHEMA;\n" > apps/core/src/qa-t244-r5.ts
landed "R5 plant" has_line apps/core/src/qa-t244-r5.ts "from '../../worker/src/config.ts'" && {
  REQ=("$E1 apps/core/src/qa-t244-r5.ts → apps/worker/src/config.ts")
  run_case "R5 core -> worker (the other direction)" FAIL; }

printf "import { Database } from '../../core/src/identity/database.ts';\nexport const r8 = Database;\n" > apps/worker/test/qa-t244-r8.test.ts
landed "R8 plant" has_line apps/worker/test/qa-t244-r8.test.ts "from '../../core/src/identity/database.ts'" && {
  REQ=("$E1 apps/worker/test/qa-t244-r8.test.ts → $DB")
  run_case "R8 a worker TEST file importing core (tests in scope)" FAIL; }

echo
echo "=== rule (2) no-package-to-app-import — laundering through a package ==="
printf "import { Database } from '../../../apps/core/src/identity/database.ts';\nexport const r6 = Database;\n" > packages/contracts/src/qa-t244-r6.ts
landed "R6 plant" has_line packages/contracts/src/qa-t244-r6.ts "from '../../../apps/core/src/identity/database.ts'" && {
  REQ=("$E2 packages/contracts/src/qa-t244-r6.ts → $DB")
  run_case "R6 packages/contracts/src -> apps/core/src" FAIL; }

echo
echo "=== rule (3) no-app-package-dependency — the manifest, every section ==="

# R7: what `pnpm add @kinvara/core --workspace` + `pnpm install` would leave: the manifest
# entry, the node_modules link, and an import by package name. It must be refused by a
# T-244 rule, NOT merely as unresolvable (CUT-OD-292 §3.2).
set_dep "$WPKG" dependencies @kinvara/core 'workspace:*'
link_pkg core ../../../core
printf "import { Database } from '@kinvara/core/src/identity/database.ts';\nexport const r7 = Database;\n" > "$W/qa-t244-r7.ts"
landed "R7 manifest+link+import" json_has "$WPKG" dependencies @kinvara/core \
  && landed "R7 link" is_link_to "$NMK/core" ../../../core \
  && landed "R7 file" has_line "$W/qa-t244-r7.ts" "from '@kinvara/core/src/identity/database.ts'" && {
  REQ=("$E3 $WPKG dependencies \"@kinvara/core\" → apps/core" "$E1 $W/qa-t244-r7.ts → $DB")
  FORBID=("$EU")
  run_case "R7 \"@kinvara/core\": workspace:* + link + import by name" FAIL; }

set_dep "$WPKG" dependencies @kinvara/core 'workspace:*'
landed "R7b manifest" json_has "$WPKG" dependencies @kinvara/core && {
  REQ=("$E3 $WPKG dependencies \"@kinvara/core\" → apps/core")
  FORBID=("$EU" "$E1")
  run_case "R7b the manifest entry alone, no import" FAIL; }

set_dep "$WPKG" devDependencies @kinvara/core 'workspace:*'
landed "R7c manifest" json_has "$WPKG" devDependencies @kinvara/core && {
  REQ=("$E3 $WPKG devDependencies \"@kinvara/core\" → apps/core")
  run_case "R7c devDependencies (any section)" FAIL; }

set_dep "$WPKG" dependencies core-alias 'workspace:@kinvara/core@*'
landed "R7d manifest" json_has "$WPKG" dependencies core-alias && {
  REQ=("$E3 $WPKG dependencies \"core-alias\": \"workspace:@kinvara/core@*\" → apps/core")
  run_case "R7d an alias: \"core-alias\": \"workspace:@kinvara/core@*\"" FAIL; }

set_dep "$WPKG" optionalDependencies core-link 'link:../core'
landed "R7e manifest" json_has "$WPKG" optionalDependencies core-link && {
  REQ=("$E3 $WPKG optionalDependencies \"core-link\": \"link:../core\" → apps/core")
  run_case "R7e a link: value into another app's directory" FAIL; }

set_dep "$CPKG" peerDependencies @kinvara/worker 'workspace:*'
landed "R7f manifest" json_has "$CPKG" peerDependencies @kinvara/worker && {
  REQ=("$E3 $CPKG peerDependencies \"@kinvara/worker\" → apps/worker")
  run_case "R7f a PACKAGE manifest naming an app" FAIL; }

set_dep "$WPKG" dependencies core-npm 'npm:@kinvara/core'
landed "R7g manifest" json_has "$WPKG" dependencies core-npm && {
  REQ=("$E3 $WPKG dependencies \"core-npm\": \"npm:@kinvara/core\" → apps/core")
  run_case "R7g an alias ending in the app name: \"npm:@kinvara/core\"" FAIL; }

echo
echo "=== measured, not assumed: R9 (tsconfig paths) and R10 (committed symlinks) ==="

# R9: an alias in the WORKER's tsconfig. depcruise reads the ROOT tsconfig.json only, so the
# specifier resolves nowhere: refused, but by T-001's not-to-unresolvable, NOT by a T-244 rule.
# This case pins that: if it ever starts resolving, it must be refused by rule (1) instead.
node scripts/negative-tests/mutate.mjs "$WTSC" '"extends": "../../tsconfig.base.json",' '"extends": "../../tsconfig.base.json",
  "compilerOptions": { "paths": { "@core/*": ["../core/src/*"] } },'
printf "import { Database } from '@core/identity/database.ts';\nexport const r9 = Database;\n" > "$W/qa-t244-r9.ts"
landed "R9 alias" has_line "$WTSC" '"@core/*": ["../core/src/*"]' \
  && landed "R9 file" has_line "$W/qa-t244-r9.ts" "from '@core/identity/database.ts'" && {
  REQ=("$EU $W/qa-t244-r9.ts → @core/identity/database.ts")
  FORBID=("$E1")
  run_case "R9 paths alias in apps/worker/tsconfig.json (BOUND: by not-to-unresolvable)" FAIL; }

# R9b: the same alias where depcruise DOES read it (the root tsconfig.json) resolves into
# apps/core and is refused by rule (1).
node scripts/negative-tests/mutate.mjs "$RTSC" '"extends": "./tsconfig.base.json",' '"extends": "./tsconfig.base.json",
  "compilerOptions": { "paths": { "@core/*": ["./apps/core/src/*"] } },'
printf "import { Database } from '@core/identity/database.ts';\nexport const r9 = Database;\n" > "$W/qa-t244-r9.ts"
landed "R9b alias" has_line "$RTSC" '"@core/*": ["./apps/core/src/*"]' \
  && landed "R9b file" has_line "$W/qa-t244-r9.ts" "from '@core/identity/database.ts'" && {
  REQ=("$E1 $W/qa-t244-r9.ts → $DB")
  FORBID=("$EU")
  run_case "R9b the alias in the ROOT tsconfig.json resolves -> rule (1)" FAIL; }

ln -s ../../core/src "$W/qa-t244-corelink"
printf "import { Database } from './qa-t244-corelink/identity/database.ts';\nexport const r10 = Database;\n" > "$W/qa-t244-r10.ts"
landed "R10 link" is_link_to "$W/qa-t244-corelink" ../../core/src \
  && landed "R10 file" has_line "$W/qa-t244-r10.ts" "from './qa-t244-corelink/identity/database.ts'" && {
  REQ=("$E1 $W/qa-t244-r10.ts → $DB" "$E1 $W/qa-t244-corelink/identity/database.ts → apps/core/src/problem-json/error-class.ts")
  run_case "R10 a directory symlink apps/worker/src -> ../../core/src + import" FAIL; }

ln -s ../../core/src "$W/qa-t244-corelink"
landed "R10b link" is_link_to "$W/qa-t244-corelink" ../../core/src && {
  REQ=("$E1 $W/qa-t244-corelink/identity/database.ts → apps/core/src/problem-json/error-class.ts")
  run_case "R10b the directory symlink alone, nothing imports it" FAIL; }

ln -s ../../core/src/identity/database.ts "$W/qa-t244-dblink.ts"
printf "import { Database } from './qa-t244-dblink.ts';\nexport const r10 = Database;\n" > "$W/qa-t244-r10.ts"
landed "R10c link" is_link_to "$W/qa-t244-dblink.ts" ../../core/src/identity/database.ts \
  && landed "R10c file" has_line "$W/qa-t244-r10.ts" "from './qa-t244-dblink.ts'" && {
  REQ=("$E1 $W/qa-t244-r10.ts → $DB")
  run_case "R10c a FILE symlink to core's database.ts + import" FAIL; }

echo
echo "=== controls — must stay green ==="

# C1: worker -> @kinvara/contracts, declared and linked exactly as pnpm install would.
set_dep "$WPKG" dependencies @kinvara/contracts 'workspace:*'
link_pkg contracts ../../../../packages/contracts
printf "import { ERROR_CODES } from '@kinvara/contracts';\nexport const c1 = ERROR_CODES;\n" > "$W/qa-t244-c1.ts"
landed "C1 manifest" json_has "$WPKG" dependencies @kinvara/contracts \
  && landed "C1 link" is_link_to "$NMK/contracts" ../../../../packages/contracts \
  && landed "C1 file" has_line "$W/qa-t244-c1.ts" "from '@kinvara/contracts'" && {
  run_case "C1 worker -> @kinvara/contracts (declared + linked)" PASS; }

# C2: core -> its own ./identity. Green only if `$1` binds to the source's app directory.
printf "import { Database } from './identity/database.ts';\nexport const c2 = Database;\n" > apps/core/src/qa-t244-c2.ts
landed "C2 file" has_line apps/core/src/qa-t244-c2.ts "from './identity/database.ts'" && {
  run_case "C2 core -> its own ./identity/… (\$1 binds)" PASS; }

# C3: `@kinvara/core` is a PREFIX of `@kinvara/core-modules` (EV-30), which is a package, not an
# app. Neither the key nor an alias to it may be read as naming apps/core.
set_dep "$WPKG" dependencies @kinvara/core-modules 'workspace:*'
set_dep "$WPKG" dependencies modules-alias 'npm:@kinvara/core-modules@*'
landed "C3 key" json_has "$WPKG" dependencies @kinvara/core-modules \
  && landed "C3 alias" json_has "$WPKG" dependencies modules-alias && {
  FORBID=("$E3")
  run_case "C3 \"@kinvara/core-modules\" key + alias: not an app" PASS; }

echo
echo "=== anti-vacuity: each rule deleted, its red case turns green ==="

node -e 'const fs = require("fs"); const f = process.argv[1]; const s = fs.readFileSync(f, "utf8"); const t = s.replace(/\n    \{\n      name: .no-cross-app-import.,[\s\S]*?\n    \},/, ""); if (t === s) process.exit(1); fs.writeFileSync(f, t)' "$CFG"
printf "import { Database } from '../../core/src/identity/database.ts';\nexport const qaProbe = Database;\n" > "$W/qa-t244-r1.ts"
landed "M1 rule (1) deleted" cfg_lacks_rule no-cross-app-import \
  && landed "M1 config changed" differs "$CFG" \
  && landed "M1 R1 plant" has_line "$W/qa-t244-r1.ts" "from '../../core/src/identity/database.ts'" && {
  FORBID=("$E1")
  run_case "M1 rule (1) DELETED from the config: R1 now PASSES" PASS; }

node -e 'const fs = require("fs"); const f = process.argv[1]; const s = fs.readFileSync(f, "utf8"); const t = s.replace(/\n    \{\n      name: .no-package-to-app-import.,[\s\S]*?\n    \},/, ""); if (t === s) process.exit(1); fs.writeFileSync(f, t)' "$CFG"
printf "import { Database } from '../../../apps/core/src/identity/database.ts';\nexport const r6 = Database;\n" > packages/contracts/src/qa-t244-r6.ts
landed "M2 rule (2) deleted" cfg_lacks_rule no-package-to-app-import \
  && landed "M2 config changed" differs "$CFG" \
  && landed "M2 R6 plant" has_line packages/contracts/src/qa-t244-r6.ts "apps/core/src/identity/database.ts" && {
  FORBID=("$E2")
  run_case "M2 rule (2) DELETED from the config: R6 now PASSES" PASS; }

node scripts/negative-tests/mutate.mjs "$GATE" 'if (manifestHits.length > 0) {' 'if (manifestHits.length < 0) {'
set_dep "$WPKG" dependencies @kinvara/core 'workspace:*'
landed "M3 rule (3) disabled" has_line "$GATE" 'if (manifestHits.length < 0) {' \
  && landed "M3 manifest" json_has "$WPKG" dependencies @kinvara/core && {
  run_case "M3 rule (3) DISABLED in the gate: R7b now PASSES" PASS; }

echo
run_case "99 tree restored" PASS
ran=$((ran + 1))
clean=1
[[ -z "$(git status --porcelain)" ]] || clean=0
for f in "${EDITED[@]}"; do cmp -s "$f" "$BK/$(echo "$f" | tr / _)" || clean=0; done
for p in "${PLANTS[@]}"; do [[ -e "$p" || -L "$p" ]] && clean=0; done
if [[ $clean -eq 1 ]]; then
  printf '   %-62s ok\n' "99b git status clean; edited files byte-identical; plants gone"
else
  printf '!! %-62s MISBEHAVED\n' "99b git status clean; edited files byte-identical; plants gone"
  git status --porcelain | sed 's/^/       /'
  bad=$((bad + 1))
fi

echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
