#!/usr/bin/env bash
# T-006 — the heavy gate set, attacked. Every refusal `pnpm gate:heavy` and its
# two new sub-gates make, demonstrated REFUSING the thing it exists to refuse
# (PROTOCOL §5.1: "Running your gate proves it executes. ATTACKING it proves
# what it covers ... I had run the check; I had not tried to get past it.").
#
#   cd /home/alex/projects/nanny/app
#   ./scripts/dev bash scripts/negative-tests/heavy-gates.sh
#
# NO SERVICES, and that is deliberate rather than a limitation to apologise for.
# A full heavy run needs a Docker socket for one sub-gate and a compose database
# for two others, in two invocations that cannot be merged (DOCKER.md §7 rule b).
# If this suite needed either it could not be a member of `gate:negative-suites`,
# and a committed suite that no gate runs is OD-152 — the exact defect that let
# a red suite sit unnoticed. So every case here attacks the HARNESS: the roster,
# the class judgement, the evidence anchors, the receipts and the workflow
# mirror. WHAT IT DOES NOT COVER is stated at the end of the run, out loud.
#
# HOW A CASE IS JUDGED. Three readings, which a gate that did nothing could not
# all produce:
#   1. the exit status;
#   2. the gate's own GATE PASS / GATE FAIL banner (exactly one);
#   3. every expected REASON substring present in the output.
# A program that dies with an uncaught exception exits non-zero and prints no
# banner, and this harness calls that CRASH, not FAIL (OD-27). A mutation whose
# anchor is missing is a HARNESS ERROR and never a verdict. `run_raw` is for the
# two sub-gates that deliberately print a banner that is NOT PASS/FAIL —
# `GATE NEEDS A SERVICE` — and it says so in its own ok line.
#
# THE TREE. Every tracked file a case touches is backed up from the WORKING TREE
# and restored after the case (T-156's mechanism, for T-156's reason: OD-119 —
# a suite that deletes tracked source). `.cache/gate-heavy/` is gitignored, so
# the receipts a case writes never make the tree dirty; the REAL receipts of a
# real heavy run are moved aside before the first case and put back by the same
# trap that restores the tracked files. EXIT/INT/TERM all restore (OD-160).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: the tree is not clean. Commit first."
  git status --porcelain
  exit 2
fi

BK="$(mktemp -d)"
TMP="$(mktemp -d)"

BACKED=(
  scripts/gates/lib/heavy-roster.ts
  scripts/gates/lib/roster.ts
  .github/workflows/heavy.yml
  package.json
)
for f in "${BACKED[@]}"; do
  d="$BK/$(printf '%s' "$f" | tr / _)"
  cp "$f" "$d" || { echo "HARNESS ERROR: cannot back up $f"; exit 2; }
done

# The receipt directory is gitignored, so `restore` cannot rely on git to put it
# back. A real heavy run's receipts are moved aside whole and restored whole.
RCPT=.cache/gate-heavy
RCPT_BK="$BK/__receipts"
if [ -d "$RCPT" ]; then cp -a "$RCPT" "$RCPT_BK"; fi

restore() {
  local f d
  for f in "${BACKED[@]}"; do
    d="$BK/$(printf '%s' "$f" | tr / _)"
    cp "$d" "$f"
  done
  rm -rf "$RCPT"
  if [ -d "$RCPT_BK" ]; then mkdir -p "$(dirname "$RCPT")"; cp -a "$RCPT_BK" "$RCPT"; fi
  return 0
}
trap 'echo; echo "INTERRUPTED — restoring the working tree"; restore; rm -rf "$BK" "$TMP"; exit 130' INT TERM
trap 'restore; rm -rf "$BK" "$TMP"' EXIT

TREE0="$(git status --porcelain)"
ran=0; bad=0; harness=0; leaks=0

HEAVY=scripts/gates/heavy.ts
HROSTER=scripts/gates/lib/heavy-roster.ts
WF=.github/workflows/heavy.yml

mut() {
  node scripts/negative-tests/mutate.mjs "$1" "$2" "$3" || {
    printf '!! %-62s %s\n' "$CASE" "HARNESS ERROR: mutation anchor missing in $1"
    harness=$((harness + 1)); return 1
  }
  if git diff --quiet -- "$1" 2>/dev/null && git ls-files --error-unmatch "$1" >/dev/null 2>&1; then
    printf '!! %-62s %s\n' "$CASE" "HARNESS ERROR: the mutation did not change $1"
    harness=$((harness + 1)); return 1
  fi
  return 0
}

_judge_tree() {
  local label="$1" now
  now="$(git status --porcelain)"
  if [ "$now" != "$TREE0" ]; then
    leaks=$((leaks + 1))
    printf '!! %-62s %s\n' "$label" "WORKING TREE NOT RESTORED"
    diff <(printf '%s\n' "$TREE0") <(printf '%s\n' "$now") | sed 's/^/       /'
  fi
}

# run_case <id+label> <PASS|FAIL> <reason substring>... -- <cmd...>
run_case() {
  local label="$1" expect="$2"; shift 2
  local reasons=()
  while [ "$1" != "--" ]; do reasons+=("$1"); shift; done
  shift
  local out code banner problems=() npass nfail r
  out="$("$@" 2>&1)"; code=$?
  ran=$((ran + 1))
  npass=$(printf '%s\n' "$out" | grep -c '^GATE PASS  ' || true)
  nfail=$(printf '%s\n' "$out" | grep -c '^GATE FAIL  ' || true)
  if [ "$((npass + nfail))" -ne 1 ]; then banner="CRASH"
  elif [ "$npass" -eq 1 ]; then banner="PASS"
  else banner="FAIL"; fi
  [ "$banner" = "$expect" ] || problems+=("banner=$banner expected=$expect")
  if [ "$expect" = "PASS" ]; then
    [ "$code" -eq 0 ] || problems+=("exit=$code expected 0")
  else
    [ "$code" -ne 0 ] || problems+=("exit=0 expected non-zero")
  fi
  for r in ${reasons+"${reasons[@]}"}; do
    printf '%s' "$out" | grep -qF -- "$r" || problems+=("missing reason: $r")
  done
  if [ ${#problems[@]} -eq 0 ]; then
    printf '   %-62s %s\n' "$label" "ok  (exit=$code banner=$banner)"
  else
    bad=$((bad + 1))
    printf '!! %-62s %s\n' "$label" "MISBEHAVED"
    printf '       %s\n' "${problems[@]}"
    printf '%s\n' "$out" | tail -14 | sed 's/^/       | /'
  fi
  restore
  _judge_tree "$label"
}

# run_raw: for the two sub-gates whose refusal banner is deliberately NEITHER
# `GATE PASS` nor `GATE FAIL` — `GATE NEEDS A SERVICE` is a third outcome, and
# collapsing it into one of the other two is the defect these cases exist to
# prevent. Judged on exit status and reasons, and the ok line says so.
# run_raw <label> <ZERO|NONZERO> <reason...> -- <cmd...>
run_raw() {
  local label="$1" expect="$2"; shift 2
  local reasons=()
  while [ "$1" != "--" ]; do reasons+=("$1"); shift; done
  shift
  local out code problems=() r
  out="$("$@" 2>&1)"; code=$?
  ran=$((ran + 1))
  if [ "$expect" = "ZERO" ]; then
    [ "$code" -eq 0 ] || problems+=("exit=$code expected 0")
  else
    [ "$code" -ne 0 ] || problems+=("exit=0 expected non-zero")
  fi
  for r in ${reasons+"${reasons[@]}"}; do
    printf '%s' "$out" | grep -qF -- "$r" || problems+=("missing reason: $r")
  done
  if [ ${#problems[@]} -eq 0 ]; then
    printf '   %-62s %s\n' "$label" "ok  (exit=$code, banner judged by reason, not by PASS/FAIL)"
  else
    bad=$((bad + 1))
    printf '!! %-62s %s\n' "$label" "MISBEHAVED"
    printf '       %s\n' "${problems[@]}"
    printf '%s\n' "$out" | tail -14 | sed 's/^/       | /'
  fi
  restore
  _judge_tree "$label"
}

echo "=== H. gate:heavy — the roster held against SD §QD-4's \"PR (heavy)\" row ==="
CASE="H0"
run_case "H0 CONTROL: the committed heavy roster" PASS \
  'GATE PASS' 'SD §QD-4 "PR (heavy)" row items: 4' -- node "$HEAVY" --roster-only

CASE="H1"
mut "$HROSTER" "    spec: '\`axe-core\` on all core flows in all three locales'," "    spec: PROGRAMME," &&
  run_case "H1 a SD heavy-row item with no roster entry" FAIL \
    'has NO roster entry — silently absent' 'axe-core' -- node "$HEAVY" --roster-only

CASE="H2"
mut "$HROSTER" "    spec: 'Testcontainers constraint suite'," "    spec: 'Testcontainers constraint suit'," &&
  run_case "H2 an entry claiming a heavy-row item SD does not have" FAIL \
    'which is not in SPEC_HEAVY_ROW' -- node "$HEAVY" --roster-only

CASE="H3"
mut "$HROSTER" "
    owner: 'T-051" "
    xwner: 'T-051" &&
  run_case "H3 a non-BLOCKING entry with no owner" FAIL \
    'with no owner — a class with no owner is a silent skip' -- node "$HEAVY" --roster-only

CASE="H4"
mut "$HROSTER" "
    unblocks: \`T-051" "
    xnblocks: \`T-051" &&
  run_case "H4 a non-BLOCKING entry with no unblock condition" FAIL \
    'with no unblock condition — that is an open-ended allowance' -- node "$HEAVY" --roster-only

CASE="H5"
mut "$HROSTER" "    name: 'gate:axe'," "    name: 'gate:lighthouse'," &&
  run_case "H5 a duplicated heavy roster entry" FAIL \
    'duplicate heavy roster entry: gate:lighthouse' -- node "$HEAVY" --roster-only

# The RATCHET. A demotion to PENDING is a legal roster edit that leaves every
# spec check green — it is exactly how a heavy gate stops running without
# anyone deleting anything. Measured in the OTHER direction (floor 1, the same
# mutated tree, GATE PASS) in tasks/state/EP-1/T-006.md § Evidence 5.
CASE="H6"
mut "$HROSTER" "    segment: 'socket',
    why:" "    segment: 'socket',
    owner: 'nobody',
    unblocks: 'never',
    why:" &&
  mut "$HROSTER" "    cls: 'BLOCKING',
    segment: 'socket'," "    cls: 'PENDING',
    segment: 'socket'," &&
  run_case "H6 one BLOCKING sub-gate demoted: the floor bites" FAIL \
    'the floor is 3' 'A sub-gate was demoted or deleted' -- node "$HEAVY" --roster-only

CASE="H7"
mut "$HROSTER" "    anchors: [
      {
        label: 'the run registered tests" "    xnchors: [
      {
        label: 'the run registered tests" &&
  run_case "H7 a BLOCKING sub-gate with no evidence anchor" FAIL \
    'is BLOCKING with no evidence anchor' 'a sub-gate that did nothing' -- node "$HEAVY" --roster-only

# THE BLOCKED FIXTURE (T-190, OD-220). Until T-190 the BLOCKED class had one
# real entry, gate:db-introspect-suite, and H8/C1/C8/C9/C10 used it as their
# vehicle. T-190 promoted it to BLOCKING, so the committed roster now has NO
# BLOCKED entry — and a class nothing exercises is a class whose judgement can
# rot unseen. So the cases that need one PLANT one: a synthetic entry appended
# to HEAVY_ROSTER by `mut` (anchor asserted present, file asserted changed),
# removed again by `restore` like every other mutation. It is an ADDITIONAL
# entry, not a demotion of a real one, so MIN_HEAVY_BLOCKING (3) is untouched
# and no case below is red for the floor instead of for its own reason. It has
# no pnpm script: it is only ever judged on the CARRIED path, from a receipt.
# plant_blocked <pinned|unpinned>
FIX=gate:fixture-blocked
FIX_PIN='!! 25 of 141 cases misbehaved'
# planted_fp: the fingerprint of the tree AS IT IS NOW. A planted fixture is a
# working-tree change, and gate:heavy's fingerprint covers `git diff HEAD`, so a
# receipt written with the clean-tree $FP would be refused as STALE.
# planted_fp sets FPM, or is a HARNESS ERROR that also puts the tree back, so a
# fixture can never leak into the next case and a case can never be skipped
# silently.
planted_fp() {
  FPM="$(node "$HEAVY" --roster-only 2>&1 | sed -n 's/.*fingerprint \([0-9a-f]*\).*/\1/p' | head -1)"
  if [ -z "$FPM" ] || [ "$FPM" = "$FP" ]; then
    printf '!! %-62s %s\n' "$CASE" "HARNESS ERROR: no fingerprint for the planted tree (got '$FPM')"
    harness=$((harness + 1)); restore; return 1
  fi
  return 0
}
plant_blocked() {
  local pin=""
  [ "$1" = pinned ] && pin="
    pinnedFailure: '$FIX_PIN',"
  mut "$HROSTER" "
  },
];

/**
 * The problems in the roster itself" "
  },
  {
    name: '$FIX',
    spec: PROGRAMME,
    cls: 'BLOCKED',
    segment: 'service',
    why: 'FIXTURE planted by heavy-gates.sh: the committed roster has no BLOCKED entry since T-190',
    owner: 'heavy-gates.sh (fixture, one case only)',
    unblocks: 'never: restore() removes it after the case',$pin
  },
];

/**
 * The problems in the roster itself"
}

CASE="H8"
plant_blocked unpinned &&
  run_case "H8 a BLOCKED sub-gate with no pinned expected failure" FAIL \
    'gate:fixture-blocked is BLOCKED with no pinned expected failure' -- node "$HEAVY" --roster-only

echo
echo "=== X. the cross-file anchor — a SERVICE gate that runs in NO stage ==="
# T-005's SERVICE class named T-006 in PROSE and nothing checked it. These three
# are that prose becoming a check, anchored OUTSIDE this file: heavyRosterProblems()
# reads scripts/gates/lib/roster.ts.
CASE="X1"
mut "$HROSTER" "    name: 'gate:drizzle-parity'," "    name: 'gate:drizzle-parity-x'," &&
  run_case "X1 a PR-stage SERVICE gate the heavy stage does not execute" FAIL \
    'is SERVICE in the PR roster' 'has NO entry here' 'runs NOWHERE' \
    -- node "$HEAVY" --roster-only

CASE="X2"
mut "$HROSTER" "    prSpec: 'Drizzle introspection parity',
    cls: 'BLOCKING'," "    prSpec: 'Drizzle introspection parity',
    owner: 'nobody',
    unblocks: 'never',
    cls: 'PENDING'," &&
  run_case "X2 the heavy entry demoted to PENDING while the PR stage says SERVICE" FAIL \
    'is executed for real in neither stage' -- node "$HEAVY" --roster-only

CASE="X3"
mut "$HROSTER" "    prSpec: 'Drizzle introspection parity'," "    prSpec: 'gitleaks'," &&
  run_case "X3 the two stages disagree about which SD item it answers" FAIL \
    'the two stages disagree about what it is for' -- node "$HEAVY" --roster-only

echo
echo "=== C. COVERAGE — a segment that did not run is NOT a segment that passed ==="
# THE CASE THIS WHOLE TICKET IS FOR. Ask PROTOCOL §5.1's question of gate:heavy
# itself: if it checked nothing, would it say so?
FP="$(node "$HEAVY" --roster-only 2>&1 | sed -n 's/.*fingerprint \([0-9a-f]*\).*/\1/p' | head -1)"
if [ -z "$FP" ]; then
  echo "HARNESS ERROR: could not read the tree fingerprint from gate:heavy's own output"
  harness=$((harness + 1))
fi
echo "   (tree fingerprint as gate:heavy prints it: $FP)"

# receipt <segment> <json-observations-array>
receipt() {
  mkdir -p "$RCPT"
  printf '{"segment":"%s","fingerprint":"%s","head":"x","project":"fake","takenAt":"2026-01-01T00:00:00.000Z","observations":%s}\n' \
    "$1" "$2" "$3" > "$RCPT/$1.json"
}
OK_SOCKET='[{"name":"gate:constraint-suite","code":0,"banners":["GATE PASS  gate:constraint-suite"],"anchorLines":["tests 171 / passed 171 / failed 0 / skipped 0 / todo 0 / files 12 of 12"],"seconds":60}]'
# The service segment's observations, one JSON object per entry, so a case can
# compose exactly the receipt it needs. Since T-190 the suite is BLOCKING and
# green, so its green observation carries the exact pass banner and the footer
# its anchor floors at 141.
OBS_DRIZZLE='{"name":"gate:drizzle-parity","code":0,"banners":["GATE PASS  gate:drizzle-parity"],"anchorLines":["MIGRATE OK  up: 0000 -> 0006","drizzle-kit 0.31.10: 4 relation(s) introspected from public","db/schema.ts: byte-identical to a fresh introspection"],"seconds":7}'
OBS_SUITE='{"name":"gate:db-introspect-suite","code":0,"banners":["GATE PASS  gate:db-introspect-suite"],"anchorLines":["ALL 141 CASES BEHAVED AS EXPECTED"],"seconds":206}'
OBS_FIX_PINNED='{"name":"gate:fixture-blocked","code":1,"banners":["GATE FAIL  gate:fixture-blocked — !! 25 of 141 cases misbehaved"],"anchorLines":[],"seconds":1}'
OK_SERVICE="[$OBS_DRIZZLE,$OBS_SUITE]"

CASE="C0"
rm -rf "$RCPT"
run_case "C0 no receipts at all: NOT RUN is not PASSED" FAIL \
  'NOT RUN is not PASSED' 'there is no receipt at .cache/gate-heavy/socket.json' \
  './scripts/dev --docker pnpm -w gate:heavy' \
  './scripts/svc run <ticket> -- pnpm -w gate:heavy' \
  'accounted for 3 of 6 rostered sub-gate(s)' -- node "$HEAVY"

CASE="C1"
receipt socket "$FP" "$OK_SOCKET"; receipt service "$FP" "$OK_SERVICE"
run_case "C1 CONTROL: both receipts at THIS tree state, green" PASS \
  'GATE PASS  gate:heavy' 'the socket segment was carried by a receipt' \
  '3 BLOCKING, 0 BLOCKED, 0 SERVICE, 3 PENDING' \
  'PASS (206s)              gate:db-introspect-suite   [BLOCKING]' \
  '3/3 sub-gate(s) whose outcome must match their class, matched' \
  '3 rostered sub-gate(s) are NOT GREEN' -- node "$HEAVY"

# The BLOCKED class's own CONTROL. Without it, C8 and C9 would still pass
# against a judge that refused EVERY BLOCKED observation — the class's
# acceptance path would be tested by nothing (T-190).
CASE="C1b"
plant_blocked pinned && planted_fp &&
  receipt socket "$FPM" "$OK_SOCKET" &&
  receipt service "$FPM" "[$OBS_DRIZZLE,$OBS_SUITE,$OBS_FIX_PINNED]" &&
  run_case "C1b CONTROL: a BLOCKED fixture red exactly as pinned is accepted" PASS \
    'GATE PASS  gate:heavy' '3 BLOCKING, 1 BLOCKED, 0 SERVICE, 3 PENDING' \
    'RED AS PINNED (1s)       gate:fixture-blocked       [BLOCKED]' \
    '4/4 sub-gate(s) whose outcome must match their class, matched' \
    '4 rostered sub-gate(s) are NOT GREEN' -- node "$HEAVY"

CASE="C2"
receipt socket "deadbeefdeadbeef" "$OK_SOCKET"; receipt service "$FP" "$OK_SERVICE"
run_case "C2 a STALE receipt — taken at a different tree — is refused" FAIL \
  'it is STALE and says nothing about the code in front of you' -- node "$HEAVY"

CASE="C3"
receipt socket "$FP" '[]'; receipt service "$FP" "$OK_SERVICE"
run_case "C3 a fresh receipt that carries no observation for the entry" FAIL \
  'carries no observation for gate:constraint-suite' -- node "$HEAVY"

CASE="C4"
receipt socket "$FP" '[{"name":"gate:constraint-suite","code":0,"banners":[],"anchorLines":[""],"seconds":0}]'
receipt service "$FP" "$OK_SERVICE"
run_case "C4 exit 0 with NO banner is a crash, not a pass" FAIL \
  'exited 0 but printed no `GATE PASS  gate:constraint-suite` banner' \
  'must not look the same' -- node "$HEAVY"

# THE ANTI-VACUITY HALF. A green banner over a run that registered zero tests is
# exactly the shape this ticket exists to refuse, one level down: a sub-gate
# that scanned nothing and said it passed.
CASE="C5"
receipt socket "$FP" '[{"name":"gate:constraint-suite","code":0,"banners":["GATE PASS  gate:constraint-suite"],"anchorLines":["tests 0 / passed 0 / failed 0 / skipped 0 / todo 0 / files 0 of 0"],"seconds":1}]'
receipt service "$FP" "$OK_SERVICE"
run_case "C5 a GREEN sub-gate that registered ZERO tests" FAIL \
  'evidence anchor' 'a pass over an empty set' -- node "$HEAVY"

CASE="C6"
receipt socket "$FP" '[{"name":"gate:constraint-suite","code":0,"banners":["GATE PASS  gate:constraint-suite"],"anchorLines":["tests 171 / passed 171 / failed 0 / skipped 0 / todo 0 / files 3 of 12"],"seconds":60}]'
receipt service "$FP" "$OK_SERVICE"
run_case "C6 a GREEN sub-gate that ran 3 of its 12 files" FAIL \
  'evidence anchor' '!= capture 7' -- node "$HEAVY"

CASE="C7"
receipt socket "$FP" "$OK_SOCKET"
receipt service "$FP" '[{"name":"gate:drizzle-parity","code":0,"banners":["GATE PASS  gate:drizzle-parity"],"anchorLines":["MIGRATE OK  up: 0000 -> 0006","drizzle-kit 0.31.10: 0 relation(s) introspected from public","db/schema.ts: byte-identical to a fresh introspection"],"seconds":7},'"$OBS_SUITE"']'
run_case "C7 Drizzle parity green over ZERO relations (T-138 K07's bound)" FAIL \
  'evidence anchor' 'a pass over an empty set' 'gate:heavy — 1 problem(s)' -- node "$HEAVY"

# C8/C9 run on the BLOCKED FIXTURE since T-190 (see plant_blocked). What each
# tests is unchanged; only the vehicle is. C9's red count differs from the pin
# in the MISBEHAVED count alone, as QR-F1 (T-188) required: a comparator that
# ignored that count would pass `!! 31 of 141` against `!! 25 of 141`.
CASE="C8"
plant_blocked pinned && planted_fp &&
  receipt socket "$FPM" "$OK_SOCKET" &&
  receipt service "$FPM" "[$OBS_DRIZZLE,$OBS_SUITE,"'{"name":"gate:fixture-blocked","code":0,"banners":["GATE PASS  gate:fixture-blocked"],"anchorLines":[],"seconds":1}]' &&
  run_case "C8 the BLOCKED suite goes GREEN: an allowance that outlives its reason" FAIL \
    'gate:fixture-blocked is rostered BLOCKED against a pinned failure and is GREEN' \
    'an allowance that outlives its reason' 'gate:heavy — 1 problem(s)' -- node "$HEAVY"

CASE="C9"
plant_blocked pinned && planted_fp &&
  receipt socket "$FPM" "$OK_SOCKET" &&
  receipt service "$FPM" "[$OBS_DRIZZLE,$OBS_SUITE,"'{"name":"gate:fixture-blocked","code":1,"banners":["GATE FAIL  gate:fixture-blocked — !! 31 of 141 cases misbehaved"],"anchorLines":[],"seconds":1}]' &&
  run_case "C9 the BLOCKED suite red on a DIFFERENT count than the pin" FAIL \
    'gate:fixture-blocked is RED IN A WAY THAT IS NOT THE PINNED ONE' \
    'the pin is "!! 25 of 141 cases misbehaved"' 'gate:heavy — 1 problem(s)' -- node "$HEAVY"

# Since T-190: one failing BLOCKING entry beside a GREEN BLOCKING suite and the
# BLOCKED fixture red as pinned, so every result kind the summary can print is
# on the page at once and none may be masked by the failure.
CASE="C10"
plant_blocked pinned && planted_fp &&
  receipt socket "$FPM" "$OK_SOCKET" &&
  receipt service "$FPM" '[{"name":"gate:drizzle-parity","code":1,"banners":["GATE FAIL  gate:drizzle-parity"],"anchorLines":["","",""],"seconds":7},'"$OBS_SUITE,$OBS_FIX_PINNED"']' &&
  run_case "C10 ONE failing sub-gate does not mask the others' results" FAIL \
    'gate:drizzle-parity FAILED (exit 1)' \
    'gate:constraint-suite      [BLOCKING]' \
    'PASS (206s)              gate:db-introspect-suite   [BLOCKING]' \
    'RED AS PINNED (1s)       gate:fixture-blocked       [BLOCKED]' \
    '3/4 sub-gate(s) whose outcome must match their class, matched' \
    'gate:heavy — 1 problem(s)' -- node "$HEAVY"

# THE PROMOTION ITSELF (T-190, OD-220). A BLOCKING suite is judged on its exit
# status and its anchor, with no pin to absorb anything: ONE misbehaving case
# is a FAIL. (The same attack against a real database, a planted case in a
# scratch worktree, is tasks/state/EP-1/T-190.md § Evidence; this is its
# carried-path guard.)
CASE="C11"
receipt socket "$FP" "$OK_SOCKET"
receipt service "$FP" "[$OBS_DRIZZLE,"'{"name":"gate:db-introspect-suite","code":1,"banners":["GATE FAIL  gate:db-introspect-suite — !! 1 of 142 cases misbehaved  (exit 1, 600.0s)"],"anchorLines":[""],"seconds":600}]'
run_case "C11 the promoted suite with ONE misbehaving case fails gate:heavy" FAIL \
  'gate:db-introspect-suite FAILED (exit 1)' 'gate:heavy — 1 problem(s)' -- node "$HEAVY"

# The anchor's ratchet: a green footer over fewer cases than the suite was
# promoted at (141) is refused, the way C5 refuses a green run over zero tests.
CASE="C12"
receipt socket "$FP" "$OK_SOCKET"
receipt service "$FP" "[$OBS_DRIZZLE,"'{"name":"gate:db-introspect-suite","code":0,"banners":["GATE PASS  gate:db-introspect-suite"],"anchorLines":["ALL 140 CASES BEHAVED AS EXPECTED"],"seconds":600}]'
run_case "C12 the promoted suite GREEN over 140 cases, below its floor of 141" FAIL \
  'evidence anchor' 'capture 1 is 140, and the floor is 141' 'gate:heavy — 1 problem(s)' -- node "$HEAVY"

echo
echo "=== S. the SERVICE class is a RESULT, not a label (gate:pr, T-005 §2) ==="
PR=scripts/gates/pr.ts
CASE="S0"
run_raw "S0 CONTROL: gate:drizzle-parity with no database refuses, and says why" NONZERO \
  'GATE NEEDS A SERVICE  gate:drizzle-parity' 'THE COMMAND IS LIVE AND THIS IS NOT A STUB' \
  -- node scripts/gates/drizzle-parity.ts

CASE="S1"
run_case "S1 CONTROL: gate:pr accepts the NEEDS A SERVICE banner from a SERVICE gate" PASS \
  'GATE PASS  gate:pr' 'NEEDS A SERVICE' -- node "$PR" --only=gate:drizzle-parity

# THE BOTH-DIRECTIONS HALF of T-006's change to scripts/gates/pr.ts. Before it,
# a SERVICE gate was judged on PENDING's banner, so leaving the not-yet-supplied
# hook in place after the implementation landed was INVISIBLE.
CASE="S2"
mut package.json '"gate:drizzle-parity": "node scripts/gates/drizzle-parity.ts"' \
  '"gate:drizzle-parity": "node scripts/gates/not-yet-supplied.ts gate:drizzle-parity"' &&
  run_case "S2 the old not-yet-supplied hook left behind a supplied gate" FAIL \
    'WITHOUT the "GATE NEEDS A SERVICE" banner' 'its content IS supplied and the hook was left behind' \
    -- node "$PR" --only=gate:drizzle-parity

CASE="S3"
mut package.json '"gate:drizzle-parity": "node scripts/gates/drizzle-parity.ts"' \
  '"gate:drizzle-parity": "node -e \"process.exit(0)\""' &&
  run_case "S3 a SERVICE gate that EXITS 0 in a stage that declares svc: none" FAIL \
    'is rostered SERVICE but EXITED 0' -- node "$PR" --only=gate:drizzle-parity

CASE="S4"
mut package.json '"gate:drizzle-parity": "node scripts/gates/drizzle-parity.ts"' \
  '"gate:drizzle-parity": "node -e \"process.exit(3)\""' &&
  run_case "S4 a SERVICE gate that CRASHES is not a gate needing a service" FAIL \
    'WITHOUT the "GATE NEEDS A SERVICE" banner' -- node "$PR" --only=gate:drizzle-parity

CASE="S5"
run_raw "S5 gate:db-introspect-suite with no database refuses by the same rule" NONZERO \
  'GATE NEEDS A SERVICE  gate:db-introspect-suite' 'is committed and is not a stub' \
  -- node scripts/gates/db-introspect-suite.ts

echo
echo "=== W. gate:workflow W8 — the heavy stage's mirrored, never-executed YAML ==="
wf() { node scripts/gates/workflow.ts; }
CASE="W0"
run_case "W0 CONTROL: heavy.yml is structurally valid and mirrors the heavy roster" PASS \
  'GATE PASS' 'heavy.yml: heavy blocking gates: 3 gate(s), identical to the roster' \
  'heavy.yml: heavy not-yet-supplied gates: 3 gate(s), identical to the roster' \
  'W7: 36 concrete' -- wf

CASE="W1"
mut "$WF" "          - gate:axe
" "" &&
  run_case "W1 a heavy gate in the roster and NOT in heavy.yml" FAIL \
    'W8 heavy not-yet-supplied gates: in the roster but NOT in' 'gate:axe' -- wf

CASE="W2"
mut "$WF" "          - gate:constraint-suite" "          - gate:constraint-suite
          - gate:nobody-declared-this" &&
  run_case "W2 a heavy gate in heavy.yml and NOT in the roster" FAIL \
    'but NOT in the roster: gate:nobody-declared-this' -- wf

CASE="W3"
mut "$WF" "    name: heavy gate (not yet supplied)
    runs-on: ubuntu-latest
    continue-on-error: true" "    name: heavy gate (not yet supplied)
    runs-on: ubuntu-latest" &&
  run_case "W3 the heavy advisory job made blocking: the class mirror" FAIL \
    'does not carry `continue-on-error: true`' 'heavy.yml' -- wf

CASE="W4"
rm -f "$WF" &&
  run_case "W4 heavy.yml deleted: SD's heavy row is mirrored nowhere" FAIL \
    'W8 .github/workflows/heavy.yml is missing or unparseable' -- wf

CASE="W5"
mut "$WF" "          - gate:db-introspect-suite" "          - gate:db-introspect-suite
          - gate:lighthouse" &&
  run_case "W5 a PENDING hook smuggled into the heavy BLOCKING matrix" FAIL \
    'W8 heavy blocking gates: in .github/workflows/heavy.yml job `blocking` but NOT in the roster: gate:lighthouse' \
    -- wf

echo
run_case "99 the tree is restored" PASS 'GATE PASS' -- node "$HEAVY" --roster-only

echo
cat <<'BOUNDS'
WHAT THIS SUITE DOES NOT COVER, stated rather than left to be discovered:
  * No case runs gate:constraint-suite, gate:drizzle-parity or
    gate:db-introspect-suite FOR REAL. They need a Docker socket or a compose
    database, and this suite is a member of gate:negative-suites, which runs in
    the PR stage under `scripts/dev` with neither. The live runs are
    tasks/state/EP-1/T-006.md § Evidence 2, 3 and 4; the cases above attack the
    JUDGEMENT of those runs, from receipts, not the runs themselves.
  * Nothing here attacks the LIVE path of gate:heavy — the branch that executes
    a sub-gate because the segment is present. Every C case exercises the
    carried path. The two are judged by ONE function (`judge`), which is why the
    carried path is worth attacking, but that is an argument, not a test.
  * A receipt is not a security boundary. .cache/gate-heavy/ is gitignored and
    a person can write one by hand — these cases do exactly that. It defends
    against FORGETTING a segment, not against FAKING one.
  * Since T-190 the committed heavy roster has NO BLOCKED entry. H8, C1b, C8,
    C9 and C10 exercise the BLOCKED class on a FIXTURE (gate:fixture-blocked)
    planted into heavy-roster.ts inside the case and removed by restore. It
    has no command, so it is judged on the CARRIED path only: the LIVE
    BLOCKED path is exercised by nothing until a real entry is BLOCKED again.
  * MIN_HEAVY_BLOCKING is attacked in one direction here (H6, at the committed
    floor). The other direction — the same mutated tree at a floor one lower,
    GATE PASS, the refusal silently lost — is measured in
    tasks/state/EP-1/T-006.md § Evidence 5, because a case cannot hold two
    mutations and still say which one it is testing.
BOUNDS

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
