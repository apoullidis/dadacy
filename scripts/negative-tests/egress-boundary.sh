#!/usr/bin/env bash
# T-018 negative tests: every new rule demonstrated REFUSING the thing it
# exists to refuse, then passing again once reverted (PROTOCOL §5.1).
#
# Each mutation is applied by scripts/negative-tests/mutate.mjs, which EXITS NON-ZERO if its
# anchor is not present. A case whose mutation did not apply is reported as a
# harness error, never as a gate result — the first version of this file used
# python3 (not in the toolbox) and fourteen cases reported PASS against a tree
# nothing had touched.
set -uo pipefail
cd "$(dirname "$0")/../.."
VERIFY=docker/compose.verify.yml
CHAOS=docker/compose.chaos.yml
BK="$(mktemp -d)"

cp "$VERIFY" "$BK/compose.verify.yml"
cp "$CHAOS" "$BK/compose.chaos.yml"
# T-130: the base file and compose.dev.yml are mutated by the parse-layer cases
# below, so they are in the backup set too. Before T-130 no case in this suite
# edited either, and restore() did not know they existed.
BASE=docker/compose.yml
DEV=docker/compose.dev.yml
cp "$BASE" "$BK/base"
cp "$DEV" "$BK/devfile"
cp scripts/dev "$BK/dev"
cp scripts/svc "$BK/svc"
cp scripts/lib/toolbox.sh "$BK/toolbox.sh"
restore() {
  cp "$BK/compose.verify.yml" "$VERIFY"; cp "$BK/compose.chaos.yml" "$CHAOS"
  cp "$BK/base" "$BASE"; cp "$BK/devfile" "$DEV"
  cp "$BK/dev" scripts/dev; cp "$BK/svc" scripts/svc; cp "$BK/toolbox.sh" scripts/lib/toolbox.sh
  # T-037, OD-37: this gate's file set is derived from scripts/svc's own -f
  # assembly, so the cases below add and remove compose files.
  rm -f docker/compose.extra.yml docker/chaos-extra.yml
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
#   git show main:scripts/gates/egress-boundary.ts > scripts/gates/.main-egress-boundary.ts
#   KINVARA_GATE_IMPL=scripts/gates/.main-egress-boundary.ts bash scripts/negative-tests/egress-boundary.sh
#
# The banner the verdict matches is the gate's own name, which does not change
# between implementations, so the two runs are directly comparable.
GATE_IMPL="${KINVARA_GATE_IMPL:-scripts/gates/egress-boundary.ts}"

bad=0
# The number of cases actually RUN, kept by run_case. The footer prints this
# counter, not a literal: app-images.sh claimed "ALL 25 CASES" while running 24,
# and that 25 reached the stakeholder report. A literal also keeps asserting the
# old number when a case is deleted, which is the same defect pointed the other
# way. A mutation that fails to apply skips run_case, so a drop here is visible.
ran=0
# OD-27, first half — the copy of the defect T-035 fixed in app-images.sh and
# left here, because this is the other gate's suite. `bad` used to count
# HARNESS ERRORS AND MISBEHAVING CASES while `ran` counted only cases run_case
# reached: two populations in one ratio, which is how the footer printed
# `!! 24 of 4 CASE(S) MISBEHAVED`. They are counted apart now and both are
# reported; the exit status is still their sum, because either one means this
# suite proved nothing.
harness=0
mut() { node scripts/negative-tests/mutate.mjs "$@" || { echo "   HARNESS ERROR"; harness=$((harness+1)); return 1; }; }

# OD-27, second half, and it is not cosmetic. The verdict was
# `[[ $code -eq 0 ]] && PASS || FAIL`, so ANY non-zero exit read as FAIL and a
# case whose expectation IS FAIL passed on a CRASH — observed on the host,
# where `node` does not exist and every case exited 127. An uncaught exception
# in egress-boundary.ts also exits 1 and would be indistinguishable from a
# refusal. That matters most for the comment-direction cases below (20-22),
# whose whole point is that a check now REFUSES something it used to accept: a
# suite that cannot tell a refusal from a crash cannot evidence any of them.
# So a verdict requires the exit status AND the gate's own banner
# (PROTOCOL §5.1: assert the exit status, not just the bytes). Anything else is
# CRASH, which equals no expectation and therefore always misbehaves.
#
# T-130 (d1): an optional THIRD argument names the REASON a FAIL case exists
# for — a substring the gate's failure list must contain. A refusal for some
# other reason is then `FAIL-OTHER`, which equals no expectation, so a case
# cannot be satisfied by an unrelated failure its mutation happened to cause.
run_case() {
  local label="$1" expect="$2" reason="${3:-}"
  local out code
  out="$(node "$GATE_IMPL" 2>&1)"; code=$?
  local verdict
  if [[ $code -eq 0 && "$out" == *"GATE PASS  gate:egress-boundary"* ]]; then verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"GATE FAIL  gate:egress-boundary"* ]]; then
    verdict=FAIL
    [[ -n "$reason" && "$out" != *"$reason"* ]] && verdict=FAIL-OTHER
  else verdict="CRASH"; fi
  ran=$((ran+1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad+1)); }
  printf '%s %-52s exit=%d  %-5s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL* ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-160 | sed 's/^/       /'
  [[ "$verdict" == CRASH ]] && printf '%s\n' "$out" | tail -3 | sed 's/^/       /'
  restore
}

# compose.verify.yml is populated now (T-018), so the anchor is the
# `services:` key itself and each planted service is inserted as the first
# entry under it. mutate.mjs exits non-zero if the anchor is absent, so a
# stale anchor is a HARNESS ERROR and never a silent pass — which is exactly
# what happened when this file was populated and these anchors still said
# `services: {}`.
ANCHOR='
services:
'
echo "=== baseline ==="
run_case "00 unmodified tree" PASS

echo; echo "=== QA-F5 — an ADDITION in an overlay must declare networks: ==="
mut "$VERIFY" "$ANCHOR" "
services:
  qa-f5-addition:
    image: alpine:3.20
    command: ['sleep', '30']
" && run_case "01 verify-only service, NO networks:" FAIL
mut "$VERIFY" "$ANCHOR" "
services:
  qa-f5-addition:
    image: alpine:3.20
    networks: [kinvara-int]
" && run_case "02 verify-only service, networks: [kinvara-int]" PASS
mut "$VERIFY" "$ANCHOR" "
services:
  qa-f5-addition:
    image: alpine:3.20
    networks: []
" && run_case "03 verify-only service, EMPTY networks: []" FAIL
mut "$VERIFY" "$ANCHOR" "
services:
  qa-f5-addition:
    networks: [kinvara-int]
    command: ['sleep', '30']
" && run_case "04 verify-only service, no image: and no build:" FAIL
mut "$VERIFY" "$ANCHOR" "
services:
  qa-f5-addition: { image: alpine:3.20, command: ['sleep','30'] }
" && run_case "05 the same, as a FLOW MAPPING (the QA-F2 shape)" FAIL
mut "$VERIFY" "$ANCHOR" "
services:
  qa-f5-addition:
    image: alpine:3.20
    networks: [kinvara-int, kinvara-pub]
" && run_case "06 addition on kinvara-pub (only compose.dev.yml may)" FAIL
mut "$CHAOS" 'services: {}' "services:
  qa-f5-chaos-addition:
    image: alpine:3.20
" && run_case "07 chaos-only service, NO networks: (T-126's file)" FAIL

echo; echo "=== QA-F5 — an OVERRIDE keeps the exemption ==="
# `mailpit`, not `core`: compose.verify.yml already overrides core, and a
# second `core:` key in the same mapping is a duplicate-key document whose
# behaviour would be the thing under test rather than the rule.
mut "$VERIFY" "$ANCHOR" "
services:
  mailpit:
    environment:
      MP_MAX_MESSAGES: '500'
" && run_case "08 override of compose.yml 'mailpit', no networks:" PASS
mut "$VERIFY" "$ANCHOR" "
services:
  mailpit:
    networks: [kinvara-int, some-other-net]
" && run_case "09 override that ADDS a second network" FAIL

echo; echo "=== OD-16 — the Docker socket may not reach 'svc run' ==="
mut scripts/svc '        --volume "${PNPM_STORE_VOLUME}:/pnpm-store" \' '        --volume /var/run/docker.sock:/var/run/docker.sock \
        --volume "${PNPM_STORE_VOLUME}:/pnpm-store" \' && run_case "10 socket mounted directly in scripts/svc" FAIL
mut scripts/lib/toolbox.sh '    KINVARA_MOUNT_ARGS=(--volume "${repo_root}:${repo_root}")' '    KINVARA_MOUNT_ARGS=(--volume "${repo_root}:${repo_root}" --volume /var/run/docker.sock:/var/run/docker.sock)' && run_case "11 socket smuggled into the SHARED mount helper" FAIL
mut scripts/svc '            --docker)     die' '            --nope)       die' && run_case "12 svc run's '--docker) die' refusal removed" FAIL

echo; echo "=== OD-16 — the cheapest wrong repair: running the toolbox as root ==="
mut scripts/dev '    --user "$(id -u):$(id -g)" \' '    --user 0:0 \' && run_case "13 scripts/dev --user 0:0" FAIL
mut scripts/svc '        --user "$(id -u):$(id -g)" \' '        --user 0:0 \' && run_case "14 scripts/svc --user 0:0" FAIL
mut scripts/dev 'toolbox_refuse_root "scripts/dev" || exit 1' ': # removed' && run_case "15 scripts/dev's runtime root refusal deleted" FAIL
mut scripts/dev '    --user "$(id -u):$(id -g)" \' '    --privileged \
    --user "$(id -u):$(id -g)" \' && run_case "16 scripts/dev --privileged" FAIL

echo; echo "=== OD-16 — the socket's group id must be DERIVED, not written down ==="
mut scripts/lib/toolbox.sh '        --group-add "${gid}"' '        --group-add "987"' \
  && run_case "18 --group-add given the literal 987" FAIL
mut scripts/lib/toolbox.sh "gid=\"\$(stat -c '%g' \"\${sock}\" 2>/dev/null)\"" 'gid="987"' \
  && run_case "19 the stat-based derivation replaced" FAIL

echo; echo "=== fail-closed: the gate cannot locate what it must check ==="
mut scripts/lib/toolbox.sh '
toolbox_mount_args() {' '
toolbox_mount_args_renamed() {' && run_case "17 toolbox_mount_args renamed" FAIL

echo; echo "=== OD-26/OD-28 — THE COMMENT DIRECTION, which is the direction that was missed ==="
# Cases 12, 15 and the pair above probe DELETION and RENAMING. Those are the
# directions a raw-text presence test is strongest in, so the suite confirmed
# the misreading instead of attacking it — PROTOCOL §5.1's own defect, inside a
# negative-test suite, for the second time in this component.
#
# Commenting a line out is an ordinary thing to commit (bisecting, a temporary
# local disable that gets pushed). Each case below left gate:egress-boundary at
# GATE PASS exit 0 and `pnpm gate:pr` at 9/9 before T-036, with the behaviour
# gone in every case. The DELETION control for each is the case named beside it.
mut scripts/svc '            --docker)     die' '            #--docker)     die' \
  && run_case "20 svc's '--docker) die' arm COMMENTED OUT (cf. 12)" FAIL
mut scripts/svc '        || die "refusing to attach' '        #|| die "refusing to attach' \
  && run_case "21 svc's kinvara-build refusal COMMENTED OUT" FAIL
mut scripts/dev 'toolbox_refuse_root "scripts/dev" || exit 1' '# toolbox_refuse_root "scripts/dev" || exit 1' \
  && run_case "22 dev's runtime root refusal COMMENTED OUT (cf. 15)" FAIL
mut scripts/svc 'toolbox_refuse_root "scripts/svc run" || exit 1' '# toolbox_refuse_root "scripts/svc run" || exit 1' \
  && run_case "23 svc's runtime root refusal COMMENTED OUT" FAIL


echo; echo "=== cases 24-27 (T-037, OD-37): this gate's file set is DERIVED from scripts/svc, not listed ==="
# The constant this replaces was justified by a sentence with a direction it
# had no behaviour in: T-036 § Evidence 9a/10 said a fifth compose file "fails
# closed". `does not exist` fires on a LISTED file MISSING, never on one
# APPEARING, so a fifth file was read by NOTHING here — including the OD-12
# rule that is the whole point of this gate: a service with `networks:
# [default]` lands on an ordinary bridge WITH EGRESS, comes up healthy, and
# completes a TCP connection to 1.1.1.1:443 (measured by QA on T-017).
CHAOS_F_LINE='    [[ "${USE_CHAOS:-0}" -eq 1 ]] && COMPOSE_FILES+=(-f "${CHAOS_FILE}")'
write_extra_overlay() {   # $1 = the compose file body; wires it in behind a flag
  printf '%s\n' "$1" > docker/compose.extra.yml
  mut scripts/svc "$CHAOS_F_LINE" "$CHAOS_F_LINE
    [[ \"\${USE_EXTRA:-0}\" -eq 1 ]] && COMPOSE_FILES+=(-f \"\${DOCKER_DIR}/compose.extra.yml\")"
}
write_extra_overlay "services:
  rogue:
    image: kinvara/rogue:dev
    profiles: [api]
    networks: [default]
    mem_limit: 128m
    cpus: 0.25" && run_case "24 a FIFTH compose file puts a service on the default bridge" FAIL
write_extra_overlay "services:
  rogue:
    image: kinvara/rogue:dev
    profiles: [api]
    networks: [kinvara-int, kinvara-build]
    mem_limit: 128m
    cpus: 0.25" && run_case "25 a FIFTH compose file attaches a service to kinvara-build" FAIL
# The control: the same fifth file, well-formed, must stay green — or 24-25
# would only show that the gate dislikes a fifth file.
write_extra_overlay "services:
  rogue:
    image: kinvara/rogue:dev
    profiles: [api]
    networks: [kinvara-int]
    mem_limit: 128m
    cpus: 0.25" && run_case "26 the same fifth file, well-formed (must stay green)" PASS
rm -f docker/compose.extra.yml
# The other direction: a compose file that exists and is composed by nothing.
# Named chaos-extra.yml on purpose — a docker/compose*.yml glob would not match
# it, which is why the glob was rejected as the fix for OD-37.
cat > docker/chaos-extra.yml <<'YML'
services:
  rogue:
    image: kinvara/rogue:dev
    networks: [default]
YML
run_case "27 a compose file svc composes from nothing" FAIL
rm -f docker/chaos-extra.yml


echo; echo "=== cases 28-32 (T-037 rework, OD-39): this gate's parser differed from compose's, and T-017 §R3 knew ==="
# T-017 §R3 measured the YAML 1.1/1.2 merge-key divergence in THIS FILE on
# 2026-09-05 and found it fails closed — but only through an invariant derived
# from outside the parse: every service declares image: or build:. OD-39 is the
# shape that SATISFIES that invariant while still being misread, and case 28 is
# the direction §R3's cases did not reach: an OVERRIDE (a name that IS in
# compose.yml) is exempt from the networks: requirement when it declares no
# networks: key, so a merge key that supplies a BAD network to an override was
# invisible. `networks: [default]` and not [kinvara-build], deliberately: rule 1
# scans the whole document text for kinvara-build and would catch the anchor
# itself, which would make the case pass for a reason that is not this one.
mut "$VERIFY" 'services:' "x-t037-net: &t037_net
  networks: [default]

services:" \
  && mut "$VERIFY" '  core:
    build:' '  core:
    <<: *t037_net
    build:' \
  && run_case "28 a bad network MERGED into an override (OD-39)" FAIL "is attached to 'default'"
# 29. THE CONTROL: merge keys are MODELLED, not refused. A fragment that
#     violates nothing must stay green, or 28 would pass for the wrong reason
#     and a documented Compose Spec feature would be unusable.
mut "$VERIFY" 'services:' "x-t037-ok: &t037_ok
  stop_grace_period: 30s

services:" \
  && mut "$VERIFY" '  core:
    build:' '  core:
    <<: *t037_ok
    build:' \
  && run_case "29 a harmless <<: merge (must stay green)" PASS
# 30-32. The rest of the enumerated divergence class, shared with
#        gate:app-images through lib/compose-parse.ts: a scalar the two YAML
#        versions read differently, a tag no reader resolves, and the two
#        compose features nothing models. (T-130: each now asserts its REASON.)
mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: ${NODE_ENV:-development}
      QA_T037_FLAG: on' && run_case "30 a scalar YAML 1.1 and 1.2 read differently" FAIL "DIFFERENT under YAML 1.1 and YAML 1.2"
mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: !reset ${NODE_ENV:-development}' \
  && run_case "31 an unresolvable !reset tag (fail closed)" FAIL "could not resolve a construct"
mut "$BASE" 'services:' 'include:
  - docker/compose.verify.yml

services:' && run_case "32 a top-level include: (fail closed)" FAIL "top-level 'include:'"

echo; echo "=== case 33 (T-130 a0, TL-F2): a MULTI-DOCUMENT composed file FAILS CLOSED — T-039 § contract 0 row A, as a guard ==="
# The property OE-11 made the condition of landing T-039, and until this case
# nothing in the repository asserted it. decisions.md OD-41: T-037 cycle 1's
# parseDocument() read the FIRST document only, `docker compose` merges EVERY
# document, and a second document carrying a host port on safety-gw plus a
# service on the DEFAULT bridge (full egress — OD-12) with mem_limit: 8g was
# exit 0 here while compose resolved all three. Committed BEFORE T-130 touched
# the reader. The REASON is asserted too: a red for another cause is not this.
append_doc() {   # $1 = file, $2 = body of a SECOND YAML document; asserts it landed
  local before after
  before="$(grep -c '^---$' "$1")"
  printf -- '---\n%s\n' "$2" >> "$1"
  after="$(grep -c '^---$' "$1")"
  [[ "$after" -eq $((before + 1)) ]] \
    || { echo "   HARNESS ERROR (no document appended to $1)"; harness=$((harness+1)); return 1; }
}
append_doc "$BASE" "services:
  safety-gw:
    ports: ['53999:3010']
  qa-rogue:
    image: alpine:3.20
    networks: [default]
    mem_limit: 8g" \
  && run_case "33 OD-41: 2nd document, default bridge + port + 8g" FAIL "multiple documents"

echo; echo "=== cases 34-49 (T-130, OD-41): a SECOND DOCUMENT in EACH composed file, carrying each thing it could hide ==="
# Case 33 is one file and one shape. OD-41 is not a compose.yml defect: every
# composed file goes through the same reader, and compose merges every document
# of every one of them. So: every composed file x every rule a second document
# could hide from — a demoted build (T-039 § contract 1), a host port (T-036
# § contract 4), a service on the DEFAULT bridge (OD-12, this gate's own rule)
# and a raised budget (T-036 § contract 5). Each must be refused FOR THE
# DOCUMENT COUNT — while a second document is refused outright, no content
# rule ever sees it, so the reason is what these cases test. Judged by the
# gate as at 8b4ef80 they are NOT a differential (parse() threw there too);
# judged by T-037 cycle 1's reader they are the regression.
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
n=34
for f in "$BASE" "$DEV" "$VERIFY" "$CHAOS"; do
  for v in BUILD PORTS BRIDGE BUDGET; do
    body="V_$v"
    append_doc "$f" "${!body}" \
      && run_case "$n 2nd document in ${f#docker/}: $v" FAIL "multiple documents"
    n=$((n + 1))
  done
done

echo; echo "=== cases 50-57 (T-130): the rest of the parse-layer class, each in the direction that was missed ==="
prepend() {   # $1 = file, $2 = text to put before line 1; asserts it landed
  local first="${2%%$'\n'*}"
  { printf '%s\n' "$2"; cat "$1"; } > "$1.t130" && mv "$1.t130" "$1"
  [[ "$(head -1 "$1")" == "$first" ]] \
    || { echo "   HARNESS ERROR (nothing prepended to $1)"; harness=$((harness+1)); return 1; }
}
# 50. THE CONTROL for 33-49: the '---' TOKEN is not the property. One document
#     that happens to START with '---' must stay green; a rule keyed on the
#     marker rather than on the document count would red it.
prepend "$BASE" '---' && run_case "50 ONE document with a leading --- (must stay green)" PASS
# 51. A5, found by T-130 attacking cycle 1's "never picks a version" claim: a
#     %YAML directive overrides the reader's version option, so BOTH readings
#     become that version and the 1.1/1.2 comparison compares a reading with
#     itself. Planted WITH a scalar the two versions read differently, so the
#     case shows the comparison being bypassed, not merely a directive present.
prepend "$BASE" '%YAML 1.1
---' && mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: ${NODE_ENV:-development}
      QA_T130_FLAG: on' \
  && run_case "51 %YAML 1.1 + a 1.1/1.2-divergent scalar" FAIL "%YAML directive"
# 52. A8, T-039 QA8 isolated by T-130: a self-referential alias. parse() built a
#     CIRCULAR object and this gate's JSON.stringify threw — exit 1 with NO
#     banner, which an exit-status-only harness scores as a refusal.
mut "$BASE" 'services:' 'services:
  x-t130-self: &t130_self
    image: alpine:3.20
    networks: [kinvara-int]
    self: *t130_self' && run_case "52 a self-referential alias (was a TypeError)" FAIL "refers to itself"
# 53. A9: the same through a MERGE key makes toJS() itself throw. Any exception
#     inside the read is a reported problem now, never a crash.
mut "$BASE" 'services:' 'services:
  x-t130-selfm: &t130_selfm
    image: alpine:3.20
    networks: [kinvara-int]
    self:
      <<: *t130_selfm' && run_case "53 a self-referential MERGE (toJS throws)" FAIL "could not read it"
# 54-56. OD-42, the straggler scan, both directions. It caught parse()'s throw
#        and `continue`d, so a TWO-document compose file svc composes from
#        nothing was silent where the same services in ONE document are
#        reported (case 27).
cat > docker/chaos-extra.yml <<'YML'
x-note: a straggler whose services are in its SECOND document
---
services:
  rogue:
    image: kinvara/rogue:dev
    networks: [default]
YML
run_case "54 OD-42: a TWO-document straggler" FAIL "composes it from nothing"
rm -f docker/chaos-extra.yml
# 55. THE CONTROL: multi-document YAML under docker/ with no services: mapping
#     in ANY document is not a compose file, and must stay green.
cat > docker/chaos-extra.yml <<'YML'
a: 1
---
b: 2
YML
run_case "55 a multi-document NON-compose YAML (must stay green)" PASS
rm -f docker/chaos-extra.yml
# 56. The decision OD-42 forced: an UNREADABLE file under docker/ is a failure,
#     not a skip — this gate cannot tell whether it is a compose file.
cat > docker/chaos-extra.yml <<'YML'
services: [unclosed
YML
run_case "56 an UNREADABLE straggler (skipped before T-130)" FAIL "cannot read it"
rm -f docker/chaos-extra.yml
# 57. B1 in this gate. NOT a differential — this gate always refused extends:
#     (T-017 §R5) — but the refusal moved into the shared reader, so this is the
#     case that goes red if the move ever loses it from the gate that ruled it.
mut "$BASE" '  safety-gw:
    image: kinvara/safety-gw:dev' '  safety-gw:
    image: kinvara/safety-gw:dev
    extends:
      service: core' && run_case "57 extends: on a base service" FAIL "uses 'extends'"

echo; echo "=== cases 58-61 (T-130 rework 1, OD-43): a 1.1/1.2 SYNTAX difference — the three YAML 1.1 line breaks ==="
# decisions.md OD-43 and TL-F1: U+2028, U+2029 and U+0085 are LINE BREAKS to
# YAML 1.1 and to Docker Compose, and ordinary characters to YAML 1.2 and to
# `yaml`'s lexer, which BOTH of this gate's readings use (it targets 1.2; a lone
# CR, OD-45, is cases 64 and 66). So a whole service can sit after one
# on a comment line: a comment to every rule here, a service to compose. This
# gate's shape is its own rule's: `qa-rogue` on the DEFAULT bridge (OD-12, full
# egress). Measured with `docker compose config` on scratch files: qa-rogue
# resolves on `default` for all three characters (T-130 § Rework 1 evidence).
sep_landed() {   # $1 = file, $2 = the separator character
  grep -q -- "$2" "$1" \
    || { echo "   HARNESS ERROR (no separator landed in $1)"; harness=$((harness+1)); return 1; }
}
od43_bridge() {   # $1 = case number, $2 = label, $3 = the separator character
  local c="$3"
  mut "$BASE" 'services:' "services:
  # T-130 OD-43 probe${c}  qa-rogue:${c}    image: alpine:3.20${c}    networks: [default]" \
    && sep_landed "$BASE" "$c" \
    && run_case "$1 OD-43: $2 hides a default-bridge service" FAIL "treats as a LINE BREAK"
}
od43_bridge 58 U+2028 $'\xe2\x80\xa8'
od43_bridge 59 U+2029 $'\xe2\x80\xa9'
od43_bridge 60 U+0085 $'\xc2\x85'
# 61. The OTHER entry point (composeShape, the straggler scan): a file whose
#     services: mapping exists only on the far side of a U+2028. To YAML 1.2 the
#     whole file is one comment, so it was "not compose" and skipped.
printf '# T-130 OD-43 straggler%sservices:%s  rogue:%s    image: kinvara/rogue:dev%s    networks: [default]\n' \
  $'\xe2\x80\xa8' $'\xe2\x80\xa8' $'\xe2\x80\xa8' $'\xe2\x80\xa8' > docker/chaos-extra.yml
sep_landed docker/chaos-extra.yml $'\xe2\x80\xa8' \
  && run_case "61 OD-43: a straggler's services: behind U+2028" FAIL "treats as a LINE BREAK"
rm -f docker/chaos-extra.yml

echo; echo "=== cases 62-74 (T-131): the parse RESIDUE — OD-46, OD-45, OD-44, OD-48 ==="
# decisions.md OD-44, OD-45, OD-46, OD-48, owned by T-131. The reader is shared
# with gate:app-images, and these are that suite's cases 128-140 in this gate's
# shapes. Every FAIL case was exit 0 GATE PASS against the gate as at main
# 7dff12c on the identical file (T-131 § Evidence); every control stays green.
ENV_LINE='      NODE_ENV: ${NODE_ENV:-development}'
CR=$'\r'
landed() { "$@" || { echo "   HARNESS ERROR (mutation did not land: $*)"; harness=$((harness+1)); return 1; }; }
first_bytes() { head -c "$2" "$1" | od -An -tx1 | tr -d ' \n'; }
# 62. OD-46: an unquoted timestamp in exactly Date.toJSON() form (see app-images
#     case 128). 63: THE CONTROL, quoted.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      QA_T131_STAMP: 2026-09-11T00:00:00.000Z" \
  && run_case "62 OD-46: an unquoted toISOString() timestamp" FAIL "YAML 1.1 reads a Date"
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      QA_T131_STAMP: '2026-09-11T00:00:00.000Z'" \
  && run_case "63 the same timestamp QUOTED (must stay green)" PASS
# 64. OD-45 (1): case 58 with every separator a LONE CR — a qa-rogue service on
#     the DEFAULT bridge (OD-12, full egress). Measured at main: exit 0 on this
#     gate while compose attaches qa-rogue to 'default'.
mut "$BASE" 'services:' "services:
  # T-131 OD-45 probe${CR}  qa-rogue:${CR}    image: alpine:3.20${CR}    networks: [default]" \
  && sep_landed "$BASE" "$CR" \
  && run_case "64 OD-45: a lone CR hides a default-bridge service" FAIL "a LONE CR"
# 65. THE CONTROL: CRLF line endings on every line of compose.yml.
landed sed -i 's/$/\r/' "$BASE" \
  && landed test "$(grep -c "${CR}\$" "$BASE")" -eq "$(wc -l < "$BASE")" \
  && run_case "65 compose.yml with CRLF line endings (must stay green)" PASS
# 66. OD-45 (1) at composeShape: a straggler's services: behind lone CRs.
printf '# T-131 OD-45 straggler\rservices:\r  rogue:\r    image: kinvara/rogue:dev\r    networks: [default]\n' > docker/chaos-extra.yml
sep_landed docker/chaos-extra.yml "$CR" \
  && run_case "66 OD-45: a straggler's services: behind lone CRs" FAIL "a LONE CR"
rm -f docker/chaos-extra.yml
# 67. OD-45 (2): case 27's straggler shape saved as UTF-16LE with a BOM.
node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from("\ufeff" + process.argv[2], "utf16le"))' \
  docker/chaos-extra.yml "services:
  rogue:
    image: kinvara/rogue:dev
    networks: [default]
"
landed test "$(first_bytes docker/chaos-extra.yml 2)" = fffe \
  && run_case "67 OD-45: a UTF-16 straggler" FAIL "not UTF-8 text"
rm -f docker/chaos-extra.yml
# 68. THE CONTROL for A12: a UTF-8 BOM in front of compose.yml.
{ printf '\xef\xbb\xbf'; cat "$BASE"; } > "$BASE.t131" && mv "$BASE.t131" "$BASE"
landed test "$(first_bytes "$BASE" 3)" = efbbbf \
  && run_case "68 a UTF-8 BOM on compose.yml (must stay green)" PASS
# 69. OD-44: the \/ escape in safety-gw's image (compose refuses the file).
#     70: THE CONTROL, an escaped backslash then a slash.
mut "$BASE" '  safety-gw:
    image: kinvara/safety-gw:dev' '  safety-gw:
    image: "kinvara\/safety-gw:dev"' \
  && run_case "69 OD-44: the \\/ escape in safety-gw's image" FAIL "escape inside a double-quoted scalar"
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      QA_T131_PATH: \"a\\\\/b\"" \
  && run_case "70 \"a\\\\/b\", an escaped backslash (must stay green)" PASS
# 71-73. OD-48: two keys that name the SAME property (see app-images 137-139).
#        74: THE CONTROL.
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      -017: a
      \"-17\": b
      \"-15\": c" \
  && run_case "71 OD-48: -017 / \"-17\" / \"-15\" (key order only)" FAIL "name the SAME property"
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      017: a
      \"15\": b
      \"17\": c" \
  && run_case "72 OD-48: 017 / \"15\" / \"17\" (a key masked)" FAIL "name the SAME property"
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      1: a
      \"1\": b" \
  && run_case "73 OD-48: 1: and \"1\": in one mapping" FAIL "name the SAME property"
mut "$BASE" "$ENV_LINE" "$ENV_LINE
      \"15\": b
      \"17\": c" \
  && run_case "74 \"15\" and \"17\" alone (must stay green)" PASS

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
