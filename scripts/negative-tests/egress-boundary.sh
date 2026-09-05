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
cp scripts/dev "$BK/dev"
cp scripts/svc "$BK/svc"
cp scripts/lib/toolbox.sh "$BK/toolbox.sh"
restore() {
  cp "$BK/compose.verify.yml" "$VERIFY"; cp "$BK/compose.chaos.yml" "$CHAOS"
  cp "$BK/dev" scripts/dev; cp "$BK/svc" scripts/svc; cp "$BK/toolbox.sh" scripts/lib/toolbox.sh
}
trap 'restore; rm -rf "$BK"' EXIT

bad=0
mut() { node scripts/negative-tests/mutate.mjs "$@" || { echo "   HARNESS ERROR"; bad=$((bad+1)); return 1; }; }

run_case() {
  local label="$1" expect="$2"
  local out code
  out="$(node scripts/gates/egress-boundary.ts 2>&1)"; code=$?
  local verdict; [[ $code -eq 0 ]] && verdict=PASS || verdict=FAIL
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad+1)); }
  printf '%s %-48s exit=%d  %-4s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-160 | sed 's/^/       /'
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

echo; echo "=== fail-closed: the gate cannot locate what it must check ==="
mut scripts/lib/toolbox.sh '
toolbox_mount_args() {' '
toolbox_mount_args_renamed() {' && run_case "17 toolbox_mount_args renamed" FAIL

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 ]]; then echo "ALL 19 CASES BEHAVED AS EXPECTED"; else echo "!! $bad CASE(S) MISBEHAVED"; fi
exit $bad
