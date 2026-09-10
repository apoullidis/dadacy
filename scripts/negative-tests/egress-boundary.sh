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
BASE=docker/compose.yml
cp "$BASE" "$BK/base"
cp scripts/dev "$BK/dev"
cp scripts/svc "$BK/svc"
cp scripts/lib/toolbox.sh "$BK/toolbox.sh"
restore() {
  cp "$BK/compose.verify.yml" "$VERIFY"; cp "$BK/compose.chaos.yml" "$CHAOS"
  cp "$BK/dev" scripts/dev; cp "$BK/svc" scripts/svc; cp "$BK/toolbox.sh" scripts/lib/toolbox.sh
  # T-037, OD-37: this gate's file set is derived from scripts/svc's own -f
  # assembly, so the cases below add and remove compose files.
  rm -f docker/compose.extra.yml docker/chaos-extra.yml
  cp "$BK/base" "$BASE"
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
run_case() {
  local label="$1" expect="$2"
  local out code
  out="$(node "$GATE_IMPL" 2>&1)"; code=$?
  local verdict
  if [[ $code -eq 0 && "$out" == *"GATE PASS  gate:egress-boundary"* ]]; then verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"GATE FAIL  gate:egress-boundary"* ]]; then verdict=FAIL
  else verdict="CRASH"; fi
  ran=$((ran+1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad+1)); }
  printf '%s %-52s exit=%d  %-5s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-160 | sed 's/^/       /'
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
  && run_case "28 a bad network MERGED into an override (OD-39)" FAIL
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
#        compose features nothing models.
mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: ${NODE_ENV:-development}
      QA_T037_FLAG: on' && run_case "30 a scalar YAML 1.1 and 1.2 read differently" FAIL
mut "$BASE" '      NODE_ENV: ${NODE_ENV:-development}' '      NODE_ENV: !reset ${NODE_ENV:-development}' \
  && run_case "31 an unresolvable !reset tag (fail closed)" FAIL
mut "$BASE" 'services:' 'include:
  - docker/compose.verify.yml

services:' && run_case "32 a top-level include: (fail closed)" FAIL

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
