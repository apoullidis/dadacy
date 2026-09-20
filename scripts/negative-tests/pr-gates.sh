#!/usr/bin/env bash
# T-005 — the PR gate set, attacked. Every refusal the new gates make,
# demonstrated REFUSING the thing it exists to refuse (PROTOCOL §5.1).
#
#   cd /home/alex/projects/nanny/app
#   ./scripts/dev bash scripts/negative-tests/pr-gates.sh
#
# No services. Needs a clean, committed tree.
#
# WHY THIS FILE EXISTS IN THIS SHAPE. PROTOCOL §5.1: "Running your gate proves
# it executes. ATTACKING it proves what it covers ... I had run the check; I had
# not tried to get past it." A full `pnpm gate:pr` is slow:
#
#   9:59.38 total, at 8c35307, measured with
#   `{ time ./scripts/dev pnpm run --silent gate:pr ; }` -- zsh's builtin
#   `time`, the `total` column, on this host. The run is pasted in
#   tasks/state/EP-1/T-005.md.
#
# So the 71 cases below would be most of a working day if each paid for a full
# run. Three of the gates therefore take a cheap entry point — `pr.ts --roster-only` / `--only=`, `unit-tests.ts --dry-run`, and
# `KINVARA_NEG_SUITES_TABLE` — each of which PRINTS what it did IN ITS OWN
# BANNER LINE, so a run through one can never be pasted as a full run. For
# `pr.ts` that placement is rework 1's and cases A10/A11 assert it: before then
# both flags ended in a banner byte-identical to a full run's, with the
# disclosure five lines up in the summary block (QR-A2).
#
# THE SHAPE OF THAT FIGURE IS PROTOCOL §5.3 R1's, AND THIS LINE IS THE WORKED
# EXAMPLE THE RULE WAS WRITTEN FROM. It was `6m22s` -- a real measurement of a
# real run, with NO COMMIT BESIDE IT, and it went stale the moment
# `gate:pr-gate-suite` joined the roster. It was then an "about" glued to two
# attributed points, which is better but still asks a reader to decide what
# "about" tolerates. It is now ONE MEASUREMENT ATTRIBUTED TO THE COMMIT IT WAS
# TAKEN AT, with the instrument and its parameters stated. A second measurement
# is a SECOND LINE HERE, never a widened range and never a superlative over the
# set of measurements -- that form was falsified twice in one day by the routine
# act of re-measuring (T-005 QR2-F3). Re-run the command; never edit the
# number (PROTOCOL §5.2).
#
# HOW A CASE IS JUDGED. Three readings, which a gate that did nothing could not
# all produce:
#   1. the exit status;
#   2. the gate's own GATE PASS / GATE FAIL banner (exactly one);
#   3. every expected REASON substring present in the output.
# Reading 2 is why a crash is not a refusal: a program that dies with an
# uncaught exception exits non-zero and prints no banner, and this harness calls
# that CRASH, not PASS (OD-27). A mutation whose anchor is missing is a HARNESS
# ERROR and never a verdict.
#
# THE TREE. Every tracked file a case touches is backed up from the WORKING TREE
# (not from HEAD) and restored after the case; every path a case CREATES is in
# PLANTED, which is checked against `git ls-files` BEFORE case 00 and refuses to
# start if any entry is tracked — T-156's mechanism, for T-156's reason (OD-119:
# a PLANTED path becoming tracked is how a suite deletes committed source). The
# footer compares `git status --porcelain` against the reading taken before the
# first case and folds the verdict into the exit status.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: the tree is not clean. Commit first."
  git status --porcelain
  exit 2
fi

BK="$(mktemp -d)"
TMP="$(mktemp -d)"   # outside the repo on purpose: fake suites and override
                     # tables must never make the tree dirty, because the gate
                     # under test refuses a dirty tree.

# Tracked files a case mutates, backed up from the working tree.
BACKED=(
  scripts/gates/lib/roster.ts
  scripts/gates/no-unsafe-any.baseline.json
  scripts/gates/semgrep-rules.json
  .semgrep.yml
  pnpm-workspace.yaml
  .github/workflows/pr.yml
  eslint.config.mjs
  eslint.config.typed.mjs
  package.json
  packages/policy/package.json
  packages/contracts/package.json
  packages/domain-types/package.json
  packages/i18n/package.json
  packages/integration-kit/package.json
)
# Paths a case CREATES. If any is tracked the suite refuses to start.
PLANTED=(
  packages/qa-t005-probe
  scripts/gates/qa-t005-unsafe.ts
  packages/policy/src/qa-t005-untracked.test.ts
  apps/core/.cache/qa-t005
  .cache/negative-suites.lock
)

for f in "${BACKED[@]}"; do
  d="$BK/$(printf '%s' "$f" | tr / _)"
  cp "$f" "$d" || { echo "HARNESS ERROR: cannot back up $f"; exit 2; }
done

if ! command -v git >/dev/null 2>&1; then
  echo "HARNESS ERROR: git is not on PATH; the tracked-path guard cannot run"
  exit 2
fi
tracked_planted=()
for p in "${PLANTED[@]}"; do
  if git ls-files --error-unmatch "$p" >/dev/null 2>&1; then tracked_planted+=("$p"); fi
done
if [ ${#tracked_planted[@]} -ne 0 ]; then
  echo "HARNESS ERROR: these PLANTED paths are TRACKED and would be deleted by restore():"
  printf '   %s\n' "${tracked_planted[@]}"
  exit 2
fi

restore() {
  for f in "${BACKED[@]}"; do
    d="$BK/$(printf '%s' "$f" | tr / _)"
    cp "$d" "$f"
  done
  git rm --cached -r -q --ignore-unmatch packages/qa-t005-probe \
    scripts/gates/qa-t005-unsafe.ts packages/policy/src/qa-t005-untracked.test.ts \
    apps/core/.cache/qa-t005 >/dev/null 2>&1
  rm -rf packages/qa-t005-probe apps/core/.cache/qa-t005
  rm -f scripts/gates/qa-t005-unsafe.ts packages/policy/src/qa-t005-untracked.test.ts
  rm -f .cache/negative-suites.lock
  return 0
}
trap 'echo; echo "INTERRUPTED — restoring the working tree"; restore; rm -rf "$BK" "$TMP"; exit 130' INT TERM
trap 'restore; rm -rf "$BK" "$TMP"' EXIT

TREE0="$(git status --porcelain)"
ran=0; bad=0; harness=0; leaks=0

mut() {
  node scripts/negative-tests/mutate.mjs "$1" "$2" "$3" || {
    printf '!! %-58s %s\n' "$CASE" "HARNESS ERROR: mutation anchor missing in $1"
    harness=$((harness + 1)); return 1
  }
  if git diff --quiet -- "$1" 2>/dev/null && git ls-files --error-unmatch "$1" >/dev/null 2>&1; then
    printf '!! %-58s %s\n' "$CASE" "HARNESS ERROR: the mutation did not change $1"
    harness=$((harness + 1)); return 1
  fi
  return 0
}

# run_case <id+label> <PASS|FAIL> <reason substring> [more substrings...] -- <cmd...>
run_case() {
  local label="$1" expect="$2"; shift 2
  local reasons=()
  while [ "$1" != "--" ]; do reasons+=("$1"); shift; done
  shift
  local out code banner problems=()
  out="$("$@" 2>&1)"; code=$?
  ran=$((ran + 1))

  local npass nfail
  npass=$(printf '%s\n' "$out" | grep -c '^GATE PASS  ' || true)
  nfail=$(printf '%s\n' "$out" | grep -c '^GATE FAIL  ' || true)
  if [ "$((npass + nfail))" -ne 1 ]; then
    banner="CRASH"
  elif [ "$npass" -eq 1 ]; then
    banner="PASS"
  else
    banner="FAIL"
  fi

  [ "$banner" = "$expect" ] || problems+=("banner=$banner expected=$expect")
  if [ "$expect" = "PASS" ]; then
    [ "$code" -eq 0 ] || problems+=("exit=$code expected 0")
  else
    [ "$code" -ne 0 ] || problems+=("exit=0 expected non-zero")
  fi
  local r
  for r in ${reasons+"${reasons[@]}"}; do
    printf '%s' "$out" | grep -qF -- "$r" || problems+=("missing reason: $r")
  done

  if [ ${#problems[@]} -eq 0 ]; then
    printf '   %-58s %s\n' "$label" "ok  (exit=$code banner=$banner)"
  else
    bad=$((bad + 1))
    printf '!! %-58s %s\n' "$label" "MISBEHAVED"
    printf '       %s\n' "${problems[@]}"
    printf '%s\n' "$out" | tail -14 | sed 's/^/       | /'
  fi
  restore
  local now
  now="$(git status --porcelain)"
  if [ "$now" != "$TREE0" ]; then
    leaks=$((leaks + 1))
    printf '!! %-58s %s\n' "$label" "WORKING TREE NOT RESTORED"
    diff <(printf '%s\n' "$TREE0") <(printf '%s\n' "$now") | sed 's/^/       /'
  fi
}

# run_raw: for a program that is NOT a gate and prints no GATE banner (the
# turbo fan-out). Judged on exit status and reasons only, and it says so.
# run_raw <label> <ZERO|NONZERO> <reason...> -- <cmd...>
run_raw() {
  local label="$1" expect="$2"; shift 2
  local reasons=()
  while [ "$1" != "--" ]; do reasons+=("$1"); shift; done
  shift
  local out code problems=()
  out="$("$@" 2>&1)"; code=$?
  ran=$((ran + 1))
  if [ "$expect" = "ZERO" ]; then
    [ "$code" -eq 0 ] || problems+=("exit=$code expected 0")
  else
    [ "$code" -ne 0 ] || problems+=("exit=0 expected non-zero")
  fi
  local r
  for r in ${reasons+"${reasons[@]}"}; do
    printf '%s' "$out" | grep -qF -- "$r" || problems+=("missing reason: $r")
  done
  if [ ${#problems[@]} -eq 0 ]; then
    printf '   %-58s %s\n' "$label" "ok  (exit=$code, no banner: not a gate)"
  else
    bad=$((bad + 1))
    printf '!! %-58s %s\n' "$label" "MISBEHAVED"
    printf '       %s\n' "${problems[@]}"
    printf '%s\n' "$out" | tail -10 | sed 's/^/       | /'
  fi
  restore
}

PR=scripts/gates/pr.ts
ROSTER=scripts/gates/lib/roster.ts

echo "=== A. gate:pr — the roster held against SD §QD-4's PR row ==="
CASE="A0"
run_case "A0 CONTROL: the committed roster" PASS "GATE PASS" -- node "$PR" --roster-only

CASE="A1"
mut "$ROSTER" "    spec: 'unit tests'," "    spec: PROGRAMME," &&
  run_case "A1 a SD §QD-4 PR-row item with no roster entry" FAIL \
    'has NO roster entry — silently absent' '"unit tests"' -- node "$PR" --roster-only

CASE="A2"
mut "$ROSTER" "
    owner: 'T-006 (gate:heavy)" "
    xwner: 'T-006 (gate:heavy)" &&
  run_case "A2 a non-BLOCKING entry with no owner" FAIL \
    'with no owner — a class with no owner is a silent skip' -- node "$PR" --roster-only

CASE="A3"
mut "$ROSTER" "
    unblocks:" "
    xnblocks:" &&
  run_case "A3 a non-BLOCKING entry with no unblock condition" FAIL \
    'with no unblock condition — that is an open-ended allowance' -- node "$PR" --roster-only

CASE="A4"
mut "$ROSTER" "    spec: 'gitleaks'," "    spec: 'gitleeks'," &&
  run_case "A4 an entry claiming a spec item SD does not have" FAIL \
    'which is not in SPEC_PR_ROW' -- node "$PR" --roster-only

CASE="A5"
mut "$ROSTER" "    name: 'gate:secrets'," "    name: 'gate:trivy'," &&
  run_case "A5 a duplicated roster entry" FAIL \
    'duplicate roster entry: gate:trivy' -- node "$PR" --roster-only

CASE="A6"
mut "$ROSTER" "    cls: 'BLOCKING'," "    cls: 'PENDING',
    owner: 'nobody',
    unblocks: 'never'," &&
  run_case "A6 one BLOCKING gate demoted: the floor bites" FAIL \
    'the floor is 22' 'A gate was demoted or deleted' -- node "$PR" --roster-only

echo
echo "=== A(bis). the CLASS assertion — a hook cannot pass, or fail wrongly ==="
CASE="A7"
run_case "A7 CONTROL: a PENDING hook failing with its banner is expected" PASS \
  'NOT YET SUPPLIED' -- node "$PR" --only=gate:pii-canary

CASE="A8"
mut package.json '"gate:pii-canary": "node scripts/gates/not-yet-supplied.ts gate:pii-canary"' \
  '"gate:pii-canary": "node -e \"process.exit(0)\""' &&
  run_case "A8 a PENDING hook that starts EXITING 0 is not silently promoted" FAIL \
    'rostered PENDING but EXITED 0' 'nobody promoted it' -- node "$PR" --only=gate:pii-canary

CASE="A9"
mut package.json '"gate:pii-canary": "node scripts/gates/not-yet-supplied.ts gate:pii-canary"' \
  '"gate:pii-canary": "node -e \"process.exit(3)\""' &&
  run_case "A9 a PENDING hook that CRASHES is not a not-yet-supplied hook" FAIL \
    'WITHOUT the "GATE NOT YET SUPPLIED" banner' -- node "$PR" --only=gate:pii-canary

# QR-A2. `GATE PASS  gate:pr` is the line every ticket pastes as its Definition
# of Done, so the marker for a partial run belongs in THAT line and nowhere
# else. These two cases read the banner itself: the substring they require
# begins with `GATE PASS  gate:pr  [`, which a disclosure printed five lines up
# in the summary block would not satisfy.
CASE="A10"
run_case "A10 --roster-only says so IN the GATE PASS banner" PASS \
  'GATE PASS  gate:pr  [--roster-only: NO GATE EXECUTED' -- node "$PR" --roster-only

CASE="A11"
run_case "A11 --only= says so IN the GATE PASS banner, with the count" PASS \
  'GATE PASS  gate:pr  [--only=gate:pii-canary: 1 of' 'rostered gate(s) executed — NOT a full' \
  -- node "$PR" --only=gate:pii-canary

echo
echo "=== B. gate:negative-suites — how a suite's verdict is judged ==="
# The fake suites live outside the repo. Each is a three-line script whose whole
# job is to print a footer and exit, so that the JUDGING can be attacked without
# paying for the real suites: 290.4s at 8c35307, which is the six
# per-suite figures gate:negative-suites PRINTS on every run, summed. That gate
# is the instrument; this line points at it rather than keeping a second copy.
mkfake() { # mkfake <name> <exit> <line...>
  local n="$1" x="$2"; shift 2
  { echo '#!/usr/bin/env bash'; for l in "$@"; do printf 'echo %q\n' "$l"; done; echo "exit $x"; } > "$TMP/$n"
  chmod +x "$TMP/$n"
  [ -x "$TMP/$n" ] || { echo "HARNESS ERROR: fake suite $n not created"; exit 2; }
}
table() { printf '%s\n' "$1" > "$TMP/table.json"; grep -q '"id"' "$TMP/table.json" || { echo "HARNESS ERROR: table"; exit 2; }; echo "$TMP/table.json"; }
runneg() { bash -c 'KINVARA_NEG_SUITES_TABLE="$1" node scripts/gates/negative-suites.ts' _ "$TMP/table.json"; }

mkfake green0 0 'ALL 3 CASES BEHAVED AS EXPECTED'
mkfake zero 0 'ALL 0 CASES BEHAVED AS EXPECTED'
mkfake silent0 0 'nothing to see here'
mkfake silent1 1 'boom: an uncaught exception'
mkfake red 1 '!! 2 of 3 CASE(S) MISBEHAVED; 0 HARNESS ERROR(S)'
mkfake greenbut1 1 'ALL 3 CASES BEHAVED AS EXPECTED'
mkfake pinred 1 'BAD  S09  the recorded cause is here' '!! 1 of 3 cases misbehaved'
mkfake pinred_nocause 1 'BAD  S09  something else entirely' '!! 1 of 3 cases misbehaved'
mkfake pinred_other 1 'BAD  S11  a different case' '!! 1 of 3 cases misbehaved'

G='{"id":"fake","file":"TMPDIR/green0","cases":3,"state":"GREEN","why":"a fake"}'
mkg() { printf '[%s]' "${1//TMPDIR/$TMP}"; }

CASE="B0"; table "$(mkg "$G")" >/dev/null
run_case "B0 CONTROL: a green footer at the pinned count" PASS \
  'ALL 3 CASES BEHAVED AS EXPECTED' 'OVERRIDE TABLE' -- runneg

CASE="B1"; table "$(mkg '{"id":"fake","file":"TMPDIR/zero","cases":3,"state":"GREEN","why":"a fake"}')" >/dev/null
run_case "B1 THE VACUITY CASE: a suite gutted to 0 cases" FAIL \
  'the footer reports 0 case(s); the pin is 3' 'A pass over a shrinking suite' -- runneg

CASE="B2"; table "$(mkg '{"id":"fake","file":"TMPDIR/silent0","cases":3,"state":"GREEN","why":"a fake"}')" >/dev/null
run_case "B2 exit 0 and NO footer is a crash, not a pass" FAIL \
  'NO FOOTER' -- runneg

CASE="B3"; table "$(mkg '{"id":"fake","file":"TMPDIR/silent1","cases":3,"state":"GREEN","why":"a fake"}')" >/dev/null
run_case "B3 exit 1 and NO footer is a crash, not a refusal" FAIL \
  'NO FOOTER' -- runneg

CASE="B4"; table "$(mkg '{"id":"fake","file":"TMPDIR/red","cases":3,"state":"GREEN","why":"a fake"}')" >/dev/null
run_case "B4 a GREEN-classed suite that goes red" FAIL \
  'RED.' -- runneg

CASE="B5"; table "$(mkg '{"id":"fake","file":"TMPDIR/greenbut1","cases":3,"state":"GREEN","why":"a fake"}')" >/dev/null
run_case "B5 a green footer with a non-zero exit: the two disagree" FAIL \
  'the two disagree' -- runneg

PIN='"pinnedFailure":{"misbehaved":1,"caseIds":["S09"],"causeSubstring":"the recorded cause"},"owner":"T-168","unblocks":"when T-168 lands"'
CASE="B6"; table "$(mkg "{\"id\":\"fake\",\"file\":\"TMPDIR/pinred\",\"cases\":3,\"state\":\"BLOCKED\",\"why\":\"a fake\",$PIN}")" >/dev/null
run_case "B6 CONTROL: a BLOCKED suite red exactly as pinned" PASS \
  'BLOCKED as pinned' 'owed by: T-168' -- runneg

CASE="B7"; table "$(mkg "{\"id\":\"fake\",\"file\":\"TMPDIR/green0\",\"cases\":3,\"state\":\"BLOCKED\",\"why\":\"a fake\",$PIN}")" >/dev/null
run_case "B7 a BLOCKED suite that went GREEN: promote it or stay red" FAIL \
  'is GREEN' 'an allowance that outlives its reason' -- runneg

CASE="B8"; table "$(mkg "{\"id\":\"fake\",\"file\":\"TMPDIR/pinred_other\",\"cases\":3,\"state\":\"BLOCKED\",\"why\":\"a fake\",$PIN}")" >/dev/null
run_case "B8 a BLOCKED suite red on a DIFFERENT case" FAIL \
  'RED IN A WAY THAT IS NOT THE PINNED ONE' -- runneg

CASE="B9"; table "$(mkg "{\"id\":\"fake\",\"file\":\"TMPDIR/pinred_nocause\",\"cases\":3,\"state\":\"BLOCKED\",\"why\":\"a fake\",$PIN}")" >/dev/null
run_case "B9 the pinned case red for a DIFFERENT reason" FAIL \
  'NOT for the recorded cause' -- runneg

CASE="B10"; table '[{"id":"fake","file":"scripts/negative-tests/nope.sh","cases":3,"state":"GREEN","why":"a fake"}]' >/dev/null
run_case "B10 a rostered suite file that does not exist" FAIL \
  'does not exist — a rostered suite was deleted' -- runneg

# THE DIGEST PIN, ON THE REAL FILE. This is the only anchor db-introspect.sh
# has, because gate:pr cannot run it (no `db`). The case holds the REAL file
# against a wrong digest; the real pin is proven correct by the gate passing in
# the full run.
#
# THE EXPECTED SUBSTRING IS DERIVED, NOT TYPED (2026-09-20). It used to spell
# `sha256 e373e536` — the digest of db-introspect.sh at the commit the case was
# written at. T-168 then edited that suite, and the literal became a case that
# could only fail: a number in a case, copied from a file the case does not
# own, is the same staleness OD-152 is about, one layer down. sha256sum is the
# instrument and the case reads it at run time, so the assertion cannot go
# stale and it still fires for the right reason.
DBI_SHA="$(sha256sum scripts/negative-tests/db-introspect.sh | cut -d' ' -f1)"
CASE="B11"; table '[{"id":"db-introspect","file":"scripts/negative-tests/db-introspect.sh","cases":65,"state":"NEEDS-SERVICE","why":"the real file","owner":"T-165","unblocks":"OE-37","digest":"0000000000000000000000000000000000000000000000000000000000000000"}]' >/dev/null
run_case "B11 the NEEDS-SERVICE digest pin moves on the real file" FAIL \
  "scripts/negative-tests/db-introspect.sh has changed (sha256 ${DBI_SHA}" \
  'Re-measure it' -- runneg

CASE="B12"; table "[{\"id\":\"x\",\"file\":\"scripts/negative-tests/db-introspect.sh\",\"cases\":65,\"state\":\"NEEDS-SERVICE\",\"why\":\"no owner\",\"digest\":\"${DBI_SHA}\"}]" >/dev/null
run_case "B12 a NEEDS-SERVICE entry with no owner or unblock condition" FAIL \
  'NEEDS-SERVICE with no owner' -- runneg

CASE="B13"; table "$(mkg "$G")" >/dev/null
mkdir -p .cache && : > .cache/negative-suites.lock
run_case "B13 OD-55: a second concurrent run is REFUSED, not interleaved" FAIL \
  'another run holds' 'REFUSED rather than interleaved' -- runneg

CASE="B14"; table "$(mkg "$G")" >/dev/null
printf 'x\n' > packages/policy/src/qa-t005-untracked.test.ts
run_case "B14 a dirty tree is refused BEFORE any suite plants anything" FAIL \
  'the working tree is not clean' -- runneg

echo
echo "=== C. gate:unit-tests — OD-57 and OD-3 ==="
UT=scripts/gates/unit-tests.ts
dry() { node "$UT" --dry-run; }

CASE="C0"
run_case "C0 CONTROL: the committed workspace" PASS 'GATE PASS' -- dry

CASE="C1"
mut packages/policy/package.json '"test": "node tools/run-tests.ts"' '"tset": "node tools/run-tests.ts"' &&
  run_case "C1 a package with tests and no test task (OD-3's shape)" FAIL \
    'UNRUN-TESTS packages/policy' '3 tracked test file(s)' -- dry

CASE="C2"
mkdir -p packages/qa-t005-probe/src &&
  printf '{"name":"@kinvara/qa-t005-probe","version":"0.0.0","private":true,"type":"module"}\n' > packages/qa-t005-probe/package.json &&
  printf 'export const x = 1;\n' > packages/qa-t005-probe/src/x.ts &&
  git add -N packages/qa-t005-probe/src/x.ts packages/qa-t005-probe/package.json &&
  run_case "C2 a package shipping source with no test task at all" FAIL \
    'UNTESTED-PACKAGE packages/qa-t005-probe' -- dry

CASE="C3"
mkdir -p packages/qa-t005-probe/src &&
  printf '{"name":"@kinvara/qa-t005-probe","version":"0.0.0","private":true,"type":"module","scripts":{"test":"true"}}\n' > packages/qa-t005-probe/package.json &&
  git add -N packages/qa-t005-probe/package.json &&
  run_case "C3 a package declaring \`test\` with zero test files" FAIL \
    'VACUOUS-PACKAGE packages/qa-t005-probe' 'cannot have run anything' -- dry

CASE="C4"
for p in policy contracts domain-types i18n integration-kit; do
  node scripts/negative-tests/mutate.mjs "packages/$p/package.json" '"test":' '"tset":' || true
done
run_case "C4 THE ZERO-PACKAGE CASE: no package declares \`test\`" FAIL \
  'NO-TEST-PACKAGES' 'A test stage with nothing in it' -- dry

CASE="C5"
printf "import { expect, test } from 'vitest';\ntest('a test file git does not track', () => {\n  expect(1).toBe(1);\n});\n" > packages/policy/src/qa-t005-untracked.test.ts
run_case "C5 V5: a test file the runner sees and git does not" FAIL \
  'FILE-SET-DRIFT @kinvara/policy' 'different instruments on purpose' -- node "$UT"

CASE="C6"
run_raw "C6 OD-3 at source: \`pnpm -w <task>\` with no implementer" NONZERO \
  'TASK VACUOUS' 'not a passing test suite' -- node scripts/gates/turbo-task.ts qa-t005-nosuchtask

echo
echo "=== D. gate:no-unsafe-any — OD-60 ==="
BL=scripts/gates/no-unsafe-any.baseline.json
CASE="D0"
run_case "D0 CONTROL: the recorded sites, as the register has them" PASS 'GATE PASS' -- node scripts/gates/no-unsafe-any.ts

CASE="D1"
printf 'const raw: unknown = JSON.parse("{}");\nconst v = raw as never as { a: string };\nexport const out: string = (JSON.parse("{}") as never as { a: string }).a;\nexport const bad: string = JSON.parse("{}").a;\nexport const keep = v;\n' > scripts/gates/qa-t005-unsafe.ts &&
  run_case "D1 ONE MORE site: a new any value reaching typed code" FAIL \
    'NEW scripts/gates/qa-t005-unsafe.ts' -- node scripts/gates/no-unsafe-any.ts

CASE="D2"
mut "$BL" '"@typescript-eslint/no-unsafe-argument": 2' '"@typescript-eslint/no-unsafe-argument": 1' &&
  run_case "D2 one more occurrence than the baseline records" FAIL \
    'INCREASED packages/domain-types/type-tests/refusals.ts' -- node scripts/gates/no-unsafe-any.ts

CASE="D3"
mut "$BL" '"@typescript-eslint/no-unsafe-argument": 2' '"@typescript-eslint/no-unsafe-argument": 3' &&
  run_case "D3 a debt entry that outlived its debt" FAIL \
    'STALE packages/domain-types/type-tests/refusals.ts' 'open-ended allowance this baseline is not allowed to become' \
    -- node scripts/gates/no-unsafe-any.ts

CASE="D4"
mut "$BL" '"owner": "packages/contracts — T-022",' '"owner": "",' &&
  run_case "D4 a baseline entry with no owner" FAIL \
    'UNOWNED packages/contracts/type-tests/refusals.ts' -- node scripts/gates/no-unsafe-any.ts

CASE="D5"
mut eslint.config.mjs "      'db/schema.ts'," "      'db/schema.ts',
      'packages/domain-types/type-tests/**'," &&
  run_case "D5 ANTI-VACUITY: a file quietly excluded from the lint" FAIL \
    'UNCOVERED' 'A lint gate that stopped looking at a file reports clean' \
    -- node scripts/gates/no-unsafe-any.ts

# QR-F1 / QR-F2, rework 1. D0-D5 hold OCCURRENCE COUNTS; these three hold the
# RULE SET and the FILE SET the counts are computed over. Every one of them was
# `GATE PASS` before check C2 existed — QA measured all three.
TYPED=eslint.config.typed.mjs
PLANT='const raw: unknown = JSON.parse("{}");\nconst v = raw as never as { a: string };\nexport const out: string = (JSON.parse("{}") as never as { a: string }).a;\nexport const bad: string = JSON.parse("{}").a;\nexport const keep = v;\n'

CASE="D6"
mut "$TYPED" "    '@typescript-eslint/no-unsafe-call': 'error',
" "" &&
  run_case "D6 QR-F1: one rule of the five deleted from the overlay" FAIL \
    'RULES-NOT-IN-FORCE' '@typescript-eslint/no-unsafe-call' \
    'a rule that is not enabled' -- node scripts/gates/no-unsafe-any.ts

# D7/D8 NOW ASSERT THE COUNT, not only the two substrings (QR2-F1, 2026-09-20).
# § Published contract cites D7 as the test that `RULES-NOT-IN-FORCE <n> of <m>`
# is what a narrowed glob produces, and the case asserted neither number — so a
# wrong count could be written into the contract and D7 would stay green, which
# is exactly what happened (`36 of 195`, a number no run has ever printed).
#
# THE TWO NUMBERS ARE DERIVED HERE FROM git, NOT TYPED. `n` is the tracked
# TypeScript under scripts/ — the files the dropped glob stops selecting — and
# `m` is the tracked TypeScript under all three roots. The gate computes `m`
# from git too, but `n` it computes from ESLint's own per-file config
# RESOLUTION, so this case holds one instrument against the other rather than
# against itself (PROTOCOL §5.1). And it cannot go stale: both recompute on
# every run, which is the whole reason the literal was wrong in the first place.
TS_SCRIPTS="$(git ls-files | grep -cE '^scripts/.*\.tsx?$')"
TS_ALL="$(git ls-files | grep -cE '^(apps|packages|scripts)/.*\.tsx?$')"

CASE="D7"
mut "$TYPED" "    'scripts/**/*.ts',
" "" &&
  run_case "D7 QR-F2: the overlay's files: glob narrowed" FAIL \
    "RULES-NOT-IN-FORCE ${TS_SCRIPTS} of ${TS_ALL} tracked" \
    'a file the overlay no longer selects' \
    -- node scripts/gates/no-unsafe-any.ts

# D8 is QA's own construction (QRF-4) and D1 is its control: D1 shows the
# committed overlay refusing this exact file with two NEW findings, and D8
# shows that narrowing the glob no longer hides it — the gate is red on the
# RULE-SET reading (C2, RULES-NOT-IN-FORCE), which is the reading left once the
# rules do not apply to the file. It is NOT the coverage reading: C1 is green
# there, because the base config still reports on the file. That word was wrong
# in this comment and in § OD-60's table until 2026-09-20 (QR2-A6).
#
# The plant is `git add -N`ed, so it joins BOTH derived counts above — one more
# tracked file under scripts/ and one more overall.
CASE="D8"
mut "$TYPED" "    'scripts/**/*.ts',
" "" &&
  printf "$PLANT" > scripts/gates/qa-t005-unsafe.ts &&
  git add -N scripts/gates/qa-t005-unsafe.ts &&
  run_case "D8 QR-F2: narrowed glob AND a real any-value site inside it" FAIL \
    "RULES-NOT-IN-FORCE $((TS_SCRIPTS + 1)) of $((TS_ALL + 1)) tracked" \
    'a file the overlay no longer selects' \
    -- node scripts/gates/no-unsafe-any.ts

# D9/D10 — THE FATAL READING IS SCOPED TO THE TRACKED SET, both directions.
# Found by rebasing onto main 6582596: T-147 left eight scratch .ts files in
# the GITIGNORED apps/core/.cache/t147r1/bundle/, ESLint linted them,
# `projectService` could not place them in a tsconfig, and gate:no-unsafe-any
# was GATE FAIL with eight FATALs on files that are not in the repository.
# D9 is the false red that must not happen; D10 is the true red that must still
# happen on the byte-identical file once git tracks it. Without D10 this pair
# would only prove the gate got quieter.
FATALPLANT='apps/core/.cache/qa-t005/unparsed.ts'
CASE="D9"
mkdir -p apps/core/.cache/qa-t005 &&
  printf 'export const x: number = 1;\n' > "$FATALPLANT" &&
  run_case "D9 a GITIGNORED .ts eslint cannot place in a tsconfig is not this gate's" PASS \
    'GATE PASS' -- node scripts/gates/no-unsafe-any.ts

CASE="D10"
mkdir -p apps/core/.cache/qa-t005 &&
  printf 'export const x: number = 1;\n' > "$FATALPLANT" &&
  git add -f -N "$FATALPLANT" &&
  run_case "D10 CONTROL: the same file TRACKED is still FATAL" FAIL \
    "FATAL ${FATALPLANT}" 'An unparsed file is an unchecked file' \
    -- node scripts/gates/no-unsafe-any.ts

echo
echo "=== E. gate:supply-chain — OD-51 ==="
sc() { node scripts/gates/supply-chain.ts; }
CASE="E0"
run_case "E0 CONTROL: minimumReleaseAgeStrict: true, no exemptions" PASS 'GATE PASS' -- sc

CASE="E1"
mut pnpm-workspace.yaml $'\nminimumReleaseAgeStrict: true' $'\n# minimumReleaseAgeStrict removed' &&
  run_case "E1 the strict setting deleted" FAIL \
    'S1 pnpm-workspace.yaml has no top-level' -- sc

CASE="E2"
mut pnpm-workspace.yaml $'\nminimumReleaseAgeStrict: true' $'\nminimumReleaseAgeStrict: false' &&
  run_case "E2 the strict setting turned off" FAIL \
    'is "false", not `true`' -- sc

CASE="E3"
mut pnpm-workspace.yaml $'\nminimumReleaseAgeStrict: true' $'\nminimumReleaseAgeExclude:\n  - some-package\nminimumReleaseAgeStrict: true' &&
  run_case "E3 the exemption pnpm writes for you (OD-51)" FAIL \
    'S2 pnpm-workspace.yaml carries 1' 'some-package' 'PIN A RELEASE OLDER THAN THE WINDOW' -- sc

echo
echo "=== F. gate:workflow — the mirrored, never-executed YAML ==="
WF=.github/workflows/pr.yml
wf() { node scripts/gates/workflow.ts; }
# The `W7: 29 concrete` reason is not decoration: 29 is 22 blocking + 7 advisory
# matrix values, so it is the assertion that BOTH `pnpm run ${{ matrix.gate }}`
# steps were expanded and every value checked. Before rework 1 this number would
# have been 0 — W7's pattern excluded `$`, `{` and `}` and skipped both lines.
# Like MIN_BLOCKING and CASES, it is a pin: raise it when the roster grows.
CASE="F0"
run_case "F0 CONTROL: pr.yml is structurally valid and mirrors the roster" PASS \
  'GATE PASS' 'W7: 29 concrete' -- wf

CASE="F1"
mut "$WF" '          - gate:unit-tests
' '' &&
  run_case "F1 a gate in the roster and not in the workflow" FAIL \
    'in the roster but NOT in .github/workflows/pr.yml' 'gate:unit-tests' -- wf

CASE="F2"
mut "$WF" '          - gate:unit-tests' '          - gate:unit-tests
          - gate:invented-by-nobody' &&
  run_case "F2 a gate in the workflow and not in the roster" FAIL \
    'but NOT in the roster: gate:invented-by-nobody' -- wf

CASE="F3"
mut "$WF" '        with:
          fetch-depth: 0' '        with:
          fetch-depth: 1' &&
  run_case "F3 a shallow checkout breaks R-TRAILER (T-031)" FAIL \
    'W6' 'fetch-depth: 0' -- wf

CASE="F4"
mut "$WF" '    continue-on-error: true
' '' &&
  run_case "F4 the class mirror: advisory made blocking" FAIL \
    'does not carry `continue-on-error: true`' -- wf

CASE="F5"
mut "$WF" 'jobs:' 'jobs:
  broken: [this is not a job' &&
  run_case "F5 the file stops being YAML" FAIL 'does not parse as YAML' -- wf

CASE="F6"
mut "$WF" '      - run: pnpm install --frozen-lockfile' '      - run: pnpm gate:does-not-exist' &&
  run_case "F6 a job running a pnpm script nobody declared" FAIL \
    'package.json declares no script' -- wf

# QR-H1, rework 1. F6 holds a LITERAL `run:` line; these two hold the only two
# run: lines in pr.yml that do any work, both of which are
# `pnpm run ${{ matrix.gate }}` and both of which W7 skipped silently until the
# expansion landed. F7 is the refusal half, F8 the resolution half.
CASE="F7"
mut "$WF" 'pnpm run ${{ matrix.gate }}' 'pnpm run ${{ matrix.nosuch }}' &&
  run_case "F7 a matrix-driven run: naming a key the matrix does not have" FAIL \
    'job blocking step 4' 'this gate cannot resolve it' 'refused here rather than skipped' -- wf

CASE="F8"
mut package.json '    "gate:unit-tests": "node scripts/gates/unit-tests.ts",
' '' &&
  run_case "F8 a matrix value resolving to a script nobody declares" FAIL \
    'runs `pnpm run gate:unit-tests` (from `pnpm run ${{ matrix.gate }}`)' \
    'declares no script' -- wf

echo
echo "=== G. gate:semgrep-rules — OD-61 ==="
sr() { node scripts/gates/semgrep-rules.ts; }
CASE="G0"
run_case "G0 CONTROL: thirteen rules, one installed, twelve owned" PASS \
  '1 of 13 installed' -- sr

CASE="G1"
mut scripts/gates/semgrep-rules.json '    {
      "subject": "OFFSET in a query",' '    {
      "subject": "DELETED",
      "ruleId": null,
      "owner": "x",
      "installingTicket": null
    },
    {
      "subject": "OFFSET in a query",' &&
  run_case "G1 a fourteenth entry: SD §QD-1 names thirteen" FAIL \
    'E4' 'SD §QD-1 lists 13' -- sr

CASE="G2"
mut scripts/gates/semgrep-rules.json '"owner": "tech-lead — the search and listing queries (SD §PERF: keyset, not offset)"' '"owner": ""' &&
  run_case "G2 an uninstalled rule with no owner" FAIL \
    'names no owner' -- sr

CASE="G3"
mut .semgrep.yml '  - id: no-any' '  - id: no-any-RENAMED' &&
  run_case "G3 the one shipped rule silently deleted" FAIL \
    'records `no-any` as installed, but .semgrep.yml does not declare it' \
    'ships rule `no-any-RENAMED`' -- sr

CASE="G4"
mut .semgrep.yml 'rules:
  - id: no-any' 'rules:
  - id: invented-rule
    languages: [typescript]
    severity: ERROR
    message: x
    patterns:
      - pattern-regex: zzz
  - id: no-any' &&
  run_case "G4 a rule that blocks a PR with no catalogue entry" FAIL \
    'ships rule `invented-rule`' -- sr

echo
echo "=== H. gate:audit — pnpm audit, and the zero-dependency defect ==="
# A pnpm shim on PATH, so the gate's own refusals can be provoked without
# faking the registry. The shim is asserted to be the pnpm that resolves.
SHIM="$TMP/shim"; mkdir -p "$SHIM"
shim() { printf '#!/usr/bin/env bash\ncat <<%s\n%s\n%s\nexit %s\n' 'JSONEOF' "$1" 'JSONEOF' "${2:-1}" > "$SHIM/pnpm"; chmod +x "$SHIM/pnpm"; }
audit_with_shim() { PATH="$SHIM:$PATH" bash -c 'command -v pnpm | grep -q "^'"$SHIM"'/pnpm$" || { echo "GATE FAIL  harness: the shim is not the pnpm on PATH"; exit 9; }; node scripts/gates/audit.ts'; }

CASE="H0"
run_case "H0 CONTROL: the real audit over the real lockfile" PASS \
  'Blocking threshold: HIGH + CRITICAL' -- node scripts/gates/audit.ts

CASE="H1"
shim 'this is not json'
run_case "H1 an unreachable registry is NOT a clean audit" FAIL \
  'A1 pnpm audit did not produce a parseable report' -- audit_with_shim

CASE="H2"
shim '{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0},"totalDependencies":0}}' 0
run_case "H2 THE ZERO-DEPENDENCY CASE: an audit over nothing" FAIL \
  'A2 pnpm audit examined 0 dependencies' 'looks exactly like a clean one' -- audit_with_shim

CASE="H3"
shim '{"advisories":{"1":{"title":"planted","module_name":"planted-pkg","severity":"critical","vulnerable_versions":"*","patched_versions":"none","url":"http://example.test","findings":[{"paths":["a>b"]}]}},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":1},"totalDependencies":408}}'
run_case "H3 a CRITICAL advisory blocks" FAIL \
  'CRITICAL planted-pkg' -- audit_with_shim

CASE="H4"
shim '{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"apocalyptic":7},"totalDependencies":408}}' 0
run_case "H4 a severity class this gate does not read" FAIL \
  'A3 pnpm reported a severity bucket this gate does not read' -- audit_with_shim

echo
echo "=== I. gate:policy-coverage — 100% of nothing is not 100% ==="
pc() { node scripts/gates/policy-coverage.ts; }
CASE="I0"
run_case "I0 CONTROL: 75/75 branches over 5 tracked source files" PASS \
  'branches 75/75 (100%)' -- pc

CASE="I1"
mut packages/policy/package.json '"test": "node tools/run-tests.ts"' '"tset": "node tools/run-tests.ts"' &&
  run_case "I1 the package stops declaring a test script" FAIL \
    'declares no `test` script' -- pc

echo
run_case "99 the tree is restored" PASS 'GATE PASS' -- node "$PR" --roster-only

echo
tree_final="$(git status --porcelain)"
if [ "$tree_final" = "$TREE0" ]; then
  tree_bad=0
  echo "WORKING TREE UNCHANGED: git status --porcelain identical before and after ($(printf '%s' "$TREE0" | grep -c . || true) line(s))"
else
  tree_bad=1
  echo "!! WORKING TREE CHANGED: this suite did not restore what it planted"
  diff <(printf '%s\n' "$TREE0") <(printf '%s\n' "$tree_final") | sed 's/^/   /'
fi

echo
if [ "$bad" -eq 0 ] && [ "$harness" -eq 0 ] && [ "$leaks" -eq 0 ] && [ "$tree_bad" -eq 0 ]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S); $leaks TREE LEAK(S)"
fi
exit $((bad + harness + leaks + tree_bad))
