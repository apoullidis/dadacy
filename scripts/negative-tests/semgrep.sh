#!/usr/bin/env bash
# T-133 negative tests: gate:semgrep demonstrated REFUSING each thing it exists
# to refuse, then passing again once reverted (PROTOCOL §5.1).
#
# Run it in the toolbox — semgrep and node exist nowhere else (DOCKER.md §0.1):
#
#   cd /home/alex/projects/nanny/app
#   ./scripts/dev bash scripts/negative-tests/semgrep.sh
#
# A verdict requires the EXIT STATUS *and* the gate's own banner *and*, where a
# case names one, the REASON TAG. That is not ceremony: rework 1 was opened
# because `printf '  -\n' >> .semgrep.yml` exited 1 with an uncaught TypeError
# and ZERO `GATE (PASS|FAIL)` lines, so "crashed" and "refused" were the same
# observation (case 01 below). A suite that reads any non-zero as a refusal
# cannot evidence a single one of these cases (OD-27, PROTOCOL §5.1).
set -uo pipefail
cd "$(dirname "$0")/../.."

RULES=.semgrep.yml
IGNORE=.semgrepignore
PINS=.tool-versions
PLANTED=packages/policy/src/planted.ts
BK="$(mktemp -d)"

cp "$RULES" "$BK/rules"
cp "$IGNORE" "$BK/ignore"
cp "$PINS" "$BK/pins"

restore() {
  chmod 0644 "$RULES" 2>/dev/null
  rm -rf "$RULES"            # a case replaces it with a DIRECTORY
  cp "$BK/rules" "$RULES"
  cp "$BK/ignore" "$IGNORE"
  cp "$BK/pins" "$PINS"
  rm -f "$PLANTED"
  rmdir packages/policy/src 2>/dev/null
  return 0
}
trap 'restore; rm -rf "$BK"' EXIT

# The differential harness (T-036). The default is the committed gate; set this
# to judge the IDENTICAL mutated tree with the gate as at another commit, which
# is the only way to show a case attacks a direction the old gate accepted:
#
#   git show 2a99dad:scripts/gates/semgrep.ts > scripts/gates/.old-semgrep.ts
#   KINVARA_GATE_IMPL=scripts/gates/.old-semgrep.ts \
#     ./scripts/dev bash scripts/negative-tests/semgrep.sh
GATE_IMPL="${KINVARA_GATE_IMPL:-scripts/gates/semgrep.ts}"

bad=0
ran=0
harness=0

mut() {
  node scripts/negative-tests/mutate.mjs "$@" || {
    echo "   HARNESS ERROR (anchor not found)"
    harness=$((harness + 1))
    return 1
  }
}

# A shell mutation must prove it LANDED before its effect is judged — a probe
# whose mutation silently did nothing reported GATE PASS on an unmutated tree
# in T-039, and PROTOCOL §5.1 names that shape.
landed() {
  local what="$1"; shift
  if "$@"; then
    return 0
  fi
  echo "   HARNESS ERROR (mutation did not land: $what)"
  harness=$((harness + 1))
  return 1
}

run_case() {
  local label="$1" expect="$2" reason="${3:-}"
  local out code verdict
  out="$(node "$GATE_IMPL" 2>&1)"; code=$?
  if [[ $code -eq 0 && "$out" == *"GATE PASS  gate:semgrep"* ]]; then
    verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"GATE FAIL  gate:semgrep"* ]]; then
    verdict=FAIL
    [[ -n "$reason" && "$out" != *"$reason"* ]] && verdict=FAIL-OTHER
  else
    verdict=CRASH
  fi
  ran=$((ran + 1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad + 1)); }
  printf '%s %-56s exit=%d  %-10s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL* ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-150 | sed 's/^/       /'
  [[ "$verdict" == CRASH ]] && printf '%s\n' "$out" | tail -3 | sed 's/^/       /'
  restore
}

echo "=== baseline ==="
run_case "00 unmodified tree" PASS

echo
echo "=== QA-F1 — the malformed-rule-file CLASS. Every member must be REFUSED"
echo "===          with the banner, never an uncaught throw (rework 1) ==="

# 01 is qa-verification's reproduction, verbatim: one empty YAML list item.
printf '  -\n' >> "$RULES"
landed "empty list item appended" grep -qE '^  -$' "$RULES" \
  && run_case "01 QA-F1 VERBATIM: printf '  -\\n' >> .semgrep.yml" FAIL "is not a mapping"

printf '  - a bare string\n' >> "$RULES"
landed "scalar list item" grep -q 'a bare string' "$RULES" \
  && run_case "02 a rule entry that is a STRING" FAIL "is not a mapping"

printf '  - [nested, list]\n' >> "$RULES"
landed "nested list item" grep -q 'nested, list' "$RULES" \
  && run_case "03 a rule entry that is a LIST" FAIL "is not a mapping"

printf '  - languages: [typescript]\n    message: no id here\n    severity: ERROR\n' >> "$RULES"
landed "id-less rule" grep -q 'no id here' "$RULES" \
  && run_case "04 a rule with NO id" FAIL "has no id"

mut "$RULES" '  - id: no-any' '  - id: no-any
    languages: [typescript]
    severity: ERROR
    message: a duplicate id
    pattern-regex: zzz
  - id: no-any' \
  && run_case "05 two rules sharing one id" FAIL "duplicate rule id"

printf 'this: [is not: valid yaml\n' >> "$RULES"
landed "broken yaml" grep -q 'is not: valid' "$RULES" \
  && run_case "06 unparseable YAML" FAIL "not valid YAML"

# T-130 / OD-41's shape, in this file's own reader: a SECOND YAML document.
# `parse()` throws on it rather than silently reading document 1, which is the
# fail-closed direction. Nothing asserted that here before.
printf -- '---\nrules:\n  - id: smuggled\n    languages: [typescript]\n    message: m\n    pattern-regex: zzz\n' >> "$RULES"
landed "second document" grep -qE '^---$' "$RULES" \
  && run_case "07 a SECOND YAML document in the rule file" FAIL "not valid YAML"

mut "$RULES" 'rules:' 'rules: {a: mapping, not: a list}
unused:' \
  && run_case "08 rules: is a MAPPING, not a list" FAIL "declares no rules"

rm -f "$RULES" && mkdir -p "$RULES"
landed "rule file replaced by a directory" test -d "$RULES" \
  && run_case "09 the rule file is a DIRECTORY" FAIL "is a DIRECTORY"

chmod 000 "$RULES"
landed "rule file made unreadable" test ! -r "$RULES" \
  && run_case "10 the rule file is UNREADABLE" FAIL "cannot be READ"

rm -f "$RULES"
landed "rule file removed" test ! -e "$RULES" \
  && run_case "11 the rule file is MISSING" FAIL "does not exist"

: > "$RULES"
landed "rule file emptied" test ! -s "$RULES" \
  && run_case "12 the rule file is EMPTY" FAIL "is empty"

echo
echo "=== the rule still has to WORK — not merely parse ==="

mut "$RULES" "pattern-regex: '(?<![\\w\$.])any(?![\\w\$(]|\\s*\\??:)'" \
             "pattern-regex: 'zzz_this_matches_nothing'" \
  && run_case "13 the rule PARSES but matches NOTHING" FAIL "did NOT match"

mkdir -p packages/policy/src
printf 'export const planted: any = 1;\n' > "$PLANTED"
landed "any planted under packages/policy" test -s "$PLANTED" \
  && run_case "14 a planted \`any\` under packages/policy" FAIL "FINDING: no-any"

echo
echo "=== QA-F4 — the gate's own pin check must not no-op ==="

mut "$PINS" 'semgrep 1.176.1' '# semgrep pin deleted by case 15' \
  && run_case "15 .tool-versions declares NO semgrep pin" FAIL "declares no \`semgrep\` pin"

# .tool-versions absent entirely: toolVersions() throws ENOENT. Before rework 1
# that left the process exiting 1 with no banner; it must now be reported AS a
# gate harness error — a fourth outcome, distinct from a refusal.
rm -f "$PINS"
landed ".tool-versions removed" test ! -e "$PINS" \
  && run_case "16 .tool-versions is MISSING (the gate itself throws)" FAIL "HARNESS"

echo
echo "=== .semgrepignore — contract §7's own falsifying tests ==="

rm -f "$IGNORE"
landed ".semgrepignore removed" test ! -e "$IGNORE" \
  && run_case "17 .semgrepignore is MISSING" FAIL ".semgrepignore is missing"

printf 'packages/policy/\n' >> "$IGNORE"
landed "packages/policy/ ignored" grep -q 'packages/policy/' "$IGNORE" \
  && run_case "18 .semgrepignore exempts packages/policy/" FAIL "exempts source paths"

echo
echo "=== LIMITATION cases (QA-F3) — these PASS, and that is the open defect."
echo "===   The guard tests entry TEXT for packages/apps, which is derived from"
echo "===   the same reading as the thing it checks (PROTOCOL §5.1). An entry"
echo "===   naming the same tree another way hides it at exit 0. The closing"
echo "===   check is anti-vacuity and belongs to T-024, which lands the first"
echo "===   packages/policy source; today it would be red on a clean tree."
echo "===   THESE CASES GO RED WHEN T-024 CLOSES IT — that is their purpose. ==="

mkdir -p packages/policy/src
printf 'export const planted: any = 1;\n' > "$PLANTED"
printf 'policy/\n' >> "$IGNORE"
landed "policy/ ignored with an any planted" grep -q '^policy/$' "$IGNORE" \
  && run_case "19 LIMITATION: 'policy/' hides a planted any" PASS

mkdir -p packages/policy/src
printf 'export const planted: any = 1;\n' > "$PLANTED"
printf '*.ts\n' >> "$IGNORE"
landed "*.ts ignored with an any planted" grep -q '^\*\.ts$' "$IGNORE" \
  && run_case "20 LIMITATION: '*.ts' hides a planted any" PASS

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
