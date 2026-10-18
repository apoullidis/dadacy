#!/usr/bin/env bash
# T-208 negative tests: the three ruled rows of packages/policy's matrix
# (`staffed_hours_version#read`, `cluster#read`, `cluster#write`) demonstrated
# HELD by committed cases — every cell, every role, and the step-up flag —
# by mutating each in turn and requiring the policy test run to go RED in the
# case anchored to the ruling, then green again once reverted (PROTOCOL §5.1).
#
# Run it in the toolbox — node exists nowhere else (DOCKER.md §0.1):
#
#   cd /home/alex/projects/nanny/app
#   ./scripts/dev bash scripts/negative-tests/policy-admin-caps.sh
#
# WHAT A VERDICT REQUIRES. The exit status AND the runner's own banner
# (`TEST PASS  @kinvara/policy` / `TEST FAIL  @kinvara/policy`) AND, for a FAIL,
# the name of the failing case: every mutation must turn red a case in
# `src/can.test.ts` whose title starts `T-208:`. Those cases name the ruled
# roles as literals, so they are the reading that is NOT computed from
# matrix.ts. A mutation that only `matrix.test.ts`'s RULED_GRID notices is
# reported FAIL-OTHER and counted as misbehaving, because RULED_GRID and
# matrix.ts have one author. Anything else — no banner, another exit — is CRASH.
#
# THE MUTATION IS ASSERTED LANDED BEFORE THE VERDICT IS READ: the anchor must
# be present (mutate.mjs refuses a no-op), the replacement text must then be
# in the file, and the file must differ from its backup.
#
# WHY THERE IS NO "DELETE A BRANCH" CASE. These rows are data: matrix.ts holds
# no `if`, loop or call (its header says why), so T-208 adds no branch to
# can.ts — the coverage gate reads 81/81 before and after. The decisions these
# rows add are cells, so the cells are what is deleted and flipped here: each
# of the 30 cells is inverted (an allow becomes `D`, a deny becomes `A`), each
# row is deleted, and the step-up flag is dropped from the write and added to
# each read.
#
# THIS SUITE MUTATES ONE TRACKED FILE, packages/policy/src/matrix.ts, AND
# DELETES NONE. It is copied to a temp directory first and restored after every
# case and by an EXIT / INT / TERM trap. A dirty matrix.ts is refused at
# startup, because the restore would overwrite the edit.
#
# NOT IN gate:negative-suites' SUITES roster (that list is hand-maintained;
# T-208 did not add to it). It is run by hand, and its output is pasted in
# tasks/state/EP-2/T-208.md.
set -uo pipefail
cd "$(dirname "$0")/../.."

MATRIX_TS=packages/policy/src/matrix.ts
TRACKED=("$MATRIX_TS")

if [[ -n "$(git status --porcelain -- "${TRACKED[@]}" 2>/dev/null)" ]]; then
  echo "HARNESS ERROR: the working tree is not clean for the file this suite mutates."
  git status --porcelain -- "${TRACKED[@]}"
  exit 2
fi

BK="$(mktemp -d)"
cp "$MATRIX_TS" "$BK/matrix.ts"
echo "backed up ${#TRACKED[@]} tracked file(s) to a temp dir; none is deleted by any case"

restore() { cp "$BK/matrix.ts" "$MATRIX_TS"; return 0; }
cleanup() {
  [[ -d "$BK" ]] || return 0
  restore
  rm -rf "$BK"
}
trap 'cleanup' EXIT
trap 'cleanup; echo; echo "INTERRUPTED — tree restored"; exit 130' INT
trap 'cleanup; echo; echo "TERMINATED — tree restored"; exit 143' TERM

ran=0; bad=0; harness=0

# mut <from> <to>: plant, then assert it landed.
mut() {
  local from="$1" to="$2"
  node scripts/negative-tests/mutate.mjs "$MATRIX_TS" "$from" "$to" || {
    echo "   HARNESS ERROR (anchor not found)"; harness=$((harness + 1)); return 1; }
  if [[ -n "$to" ]] && ! grep -qF -- "$to" "$MATRIX_TS"; then
    echo "   HARNESS ERROR (mutation did not land: replacement absent)"; harness=$((harness + 1)); restore; return 1
  fi
  if cmp -s "$MATRIX_TS" "$BK/matrix.ts"; then
    echo "   HARNESS ERROR (mutation did not land: file unchanged)"; harness=$((harness + 1)); restore; return 1
  fi
  return 0
}

ANCHOR='× src/can.test.ts > T-208:'

run_case() {
  local label="$1" expect="$2"
  local out code verdict
  out="$(cd packages/policy && node tools/run-tests.ts 2>&1)"; code=$?
  if [[ $code -eq 0 && "$out" == *"TEST PASS  @kinvara/policy"* ]]; then
    verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"TEST FAIL  @kinvara/policy"* ]]; then
    verdict=FAIL
    [[ "$out" != *"$ANCHOR"* ]] && verdict=FAIL-OTHER
  else
    verdict=CRASH
  fi
  ran=$((ran + 1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad + 1)); }
  printf '%s %-66s exit=%d  %-10s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  if [[ "$verdict" == FAIL ]]; then
    printf '%s\n' "$out" | grep -F -- "$ANCHOR" | sed 's/ [0-9]*ms$//' | cut -c1-150 | sed 's/^ */       /'
  fi
  [[ "$verdict" == CRASH || "$verdict" == FAIL-OTHER ]] && printf '%s\n' "$out" | grep -E '×|TEST |Error' | head -4 | sed 's/^/       /'
  restore
}

# The three rows as committed, column order: parent sitter t_c supp ts_op ts_sen dsl fin comp eng.
ROLES=(parent sitter trusted_contact support ts_operator ts_senior dsl finance compliance engineer)
ROW_KEYS=("staffed_hours_version#read" "cluster#read" "cluster#write")
ROW_CELLS=("D D D D D A D D A D" "D D D D D A D D A D" "D D D D D D D D AS D")

line_of() { # <key> <cells...>
  local key="$1"; shift
  local joined; joined="$(printf '%s, ' "$@")"; joined="${joined%, }"
  printf "  ['%s', row(%s)]," "$key" "$joined"
}

echo "=== baseline ==="
run_case "00 unmodified tree" PASS

echo
echo "=== R — each ruled row deleted ==="
for r in 0 1 2; do
  read -r -a cells <<< "${ROW_CELLS[$r]}"
  orig="$(line_of "${ROW_KEYS[$r]}" "${cells[@]}")"
  mut "$orig"$'\n' "" && run_case "R$((r + 1)) row ${ROW_KEYS[$r]} deleted" FAIL
done

echo
echo "=== C — each of the 30 cells inverted (allow -> D, deny -> A) ==="
n=0
for r in 0 1 2; do
  for i in "${!ROLES[@]}"; do
    read -r -a cells <<< "${ROW_CELLS[$r]}"
    orig="$(line_of "${ROW_KEYS[$r]}" "${cells[@]}")"
    if [[ "${cells[$i]}" == D ]]; then cells[$i]=A; what="granted"; else cells[$i]=D; what="refused"; fi
    new="$(line_of "${ROW_KEYS[$r]}" "${cells[@]}")"
    n=$((n + 1))
    mut "$orig" "$new" && run_case "C$(printf '%02d' $n) ${ROW_KEYS[$r]} / ${ROLES[$i]} $what" FAIL
  done
done

echo
echo "=== S — the step-up condition ==="
mut "  ['cluster#write', row(D, D, D, D, D, D, D, D, AS, D)]," \
    "  ['cluster#write', row(D, D, D, D, D, D, D, D, A, D)]," \
  && run_case "S1 cluster#write / compliance step-up DROPPED (AS -> A)" FAIL
mut "  ['cluster#read', row(D, D, D, D, D, A, D, D, A, D)]," \
    "  ['cluster#read', row(D, D, D, D, D, A, D, D, AS, D)]," \
  && run_case "S2 cluster#read / compliance step-up ADDED (A -> AS)" FAIL
mut "  ['cluster#read', row(D, D, D, D, D, A, D, D, A, D)]," \
    "  ['cluster#read', row(D, D, D, D, D, AS, D, D, A, D)]," \
  && run_case "S3 cluster#read / ts_senior step-up ADDED (A -> AS)" FAIL
mut "  ['staffed_hours_version#read', row(D, D, D, D, D, A, D, D, A, D)]," \
    "  ['staffed_hours_version#read', row(D, D, D, D, D, A, D, D, AS, D)]," \
  && run_case "S4 staffed_hours_version#read / compliance step-up ADDED" FAIL
mut "  ['staffed_hours_version#read', row(D, D, D, D, D, A, D, D, A, D)]," \
    "  ['staffed_hours_version#read', row(D, D, D, D, D, AS, D, D, A, D)]," \
  && run_case "S5 staffed_hours_version#read / ts_senior step-up ADDED" FAIL

echo
echo "=== N — a mutation that changes no decision must stay green (the harness does not read 'mutated' as 'red') ==="
mut "  // ROWS SD §BE-10 DOES NOT PRINT — stakeholder rulings, \`T-208\`." \
    "  // ROWS SD §BE-10 DOES NOT PRINT — stakeholder rulings, \`T-208\` (null edit)." \
  && run_case "N1 the ruled block's comment edited, no cell changed" PASS

echo
echo "=== Z — clean re-run after every revert ==="
run_case "Z unmodified tree again" PASS

echo
if [[ $harness -gt 0 ]]; then
  echo "!! HARNESS ERRORS: $harness — a mutation did not land, so its verdict was not read"
  exit 2
fi
if [[ $bad -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $ran CASE(S) MISBEHAVED"
exit 1
