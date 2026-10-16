#!/usr/bin/env bash
# T-262 — gate:toolbox's espeak-ng probe, attacked (PROTOCOL §5.1).
#
#   cd /home/alex/projects/nanny/app
#   bash scripts/negative-tests/toolbox-espeak.sh
#
# THIS SUITE RUNS ON THE HOST, NOT IN THE TOOLBOX, and that is structural. Two
# of its attacks are on the IMAGE — a voice's data deleted from it, the binary
# deleted from it, a pin the image was not built at — so it must build an image
# and start containers, which needs the Docker daemon. The toolbox gets the
# socket only through `scripts/dev --docker` (DOCKER.md §7), and gate:toolbox
# §6 deliberately goes RED when a gate run can see the socket. So this suite
# drives `docker` from the host itself and runs node, pnpm and espeak-ng only
# inside containers. It needs bash, git, sha256sum and docker on the host and
# nothing else; it installs nothing.
#
# CONSEQUENCE, stated where it applies: it is NOT a member of
# gate:negative-suites, which runs inside the toolbox without the socket, and
# so `gate:pr` does not run it. It is run by hand, and its output is pasted in
# tasks/state/EP-1/T-262.md. (gate:negative-suites' roster is a hand list
# anyway — OD-170.)
#
# Needs a clean, committed tree, and the toolbox image for the COMMITTED pins
# already built (`scripts/dev true` builds it if missing).
#
# HOW A CASE IS JUDGED — the same three readings as pr-gates.sh, because a gate
# that did nothing could not produce all three:
#   1. the exit status;
#   2. exactly one `GATE PASS  ` / `GATE FAIL  ` banner line — none, or two, is
#      a CRASH, never a verdict (OD-27);
#   3. every expected REASON substring present in the output.
# Every mutation is ASSERTED LANDED before its effect is judged: a file edit by
# reading the file back, an image edit by `test` run inside the derived image
# (and the opposite `test` in the real image, so the assertion is not vacuous).
# A mutation that did not land is a HARNESS ERROR, never a verdict.
#
# Containers this suite starts are all `docker run --rm --network none`,
# labelled io.kinvara.negative-suite=T-262. Images it builds are tagged
# kinvara-t262-neg:<case> with the same label and are removed by name on exit
# (never by prune). Case E1b builds through `scripts/dev`, which is the
# documented path and has egress (DOCKER.md §4.2); the build it starts is
# EXPECTED TO BE REFUSED, so no image results — and if one does, it is removed
# by its exact tag and the case is MISBEHAVED.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
REPO="$(pwd -P)"

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: the tree is not clean. Commit first."
  git status --porcelain
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "HARNESS ERROR: docker is not on PATH"; exit 2; }

# shellcheck source=scripts/lib/toolbox.sh
. scripts/lib/toolbox.sh
toolbox_load_pins .tool-versions || exit 2
IMAGE="$(toolbox_image_tag .tool-versions toolbox)" || exit 2
PIN="$(toolbox_pin espeak-ng)" || { echo "HARNESS ERROR: .tool-versions has no espeak-ng pin"; exit 2; }
BUMPED="${PIN}.99"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "HARNESS ERROR: $IMAGE (the toolbox for the committed pins) is not built."
  echo "               Run: scripts/dev true"
  exit 2
fi
# The differential harness (T-036's shape). The default is the committed gate.
# Set KINVARA_GATE_IMPL to a repo-relative path to judge the IDENTICAL mutated
# images with another version of the gate — the only way to show a case
# attacks a direction an older gate accepted. This suite runs on the host and
# passes the path in argv, so OD-62's env-forwarding trap does not apply. The
# file must live inside the repo (it is bind-mounted) and must import
# lib/run.ts by a path that resolves from where it sits.
GATE_IMPL="${KINVARA_GATE_IMPL:-scripts/gates/toolbox.ts}"
[ -f "$GATE_IMPL" ] || { echo "HARNESS ERROR: no gate at $GATE_IMPL"; exit 2; }
NEG=kinvara-t262-neg
LABEL=io.kinvara.negative-suite=T-262

# The data directory, as the image's own espeak-ng reports it — not typed here.
DATA="$(docker run --rm --network none --label "$LABEL" "$IMAGE" espeak-ng --version |
  sed -n 's/.*Data at: //p')"
if [ -z "$DATA" ]; then
  echo "HARNESS ERROR: could not read espeak-ng's data directory from $IMAGE"
  exit 2
fi

PINS=.tool-versions
PINS_HEAD_SHA="$(git show "HEAD:$PINS" | sha256sum | cut -d' ' -f1)"
BK="$(mktemp -d)"
cp "$PINS" "$BK/pins" || { echo "HARNESS ERROR: cannot back up $PINS"; exit 2; }

E1B_TAG=""
restore() { cp "$BK/pins" "$PINS"; }
cleanup() {
  restore
  local t
  for t in el-dict el-voice no-binary; do
    docker image rm -f "$NEG:$t" >/dev/null 2>&1
  done
  if [ -n "$E1B_TAG" ]; then docker image rm -f "$E1B_TAG" >/dev/null 2>&1; fi
  rm -rf "$BK"
}
trap 'echo; echo "INTERRUPTED — restoring"; cleanup; exit 130' INT TERM
trap cleanup EXIT

TREE0="$(git status --porcelain)"
ran=0; bad=0; harness=0; leaks=0

harness_error() {
  printf '!! %-58s %s\n' "$CASE" "HARNESS ERROR: $1"
  harness=$((harness + 1))
}

# After every case: the pins file is restored to HEAD's bytes, checked by
# sha256 against `git show HEAD:` — an instrument outside the case.
check_restored() {
  restore
  local now sha
  sha="$(sha256sum "$PINS" | cut -d' ' -f1)"
  if [ "$sha" != "$PINS_HEAD_SHA" ]; then
    leaks=$((leaks + 1))
    printf '!! %-58s %s\n' "$CASE" "$PINS NOT RESTORED (sha256 $sha, HEAD $PINS_HEAD_SHA)"
  fi
  now="$(git status --porcelain)"
  if [ "$now" != "$TREE0" ]; then
    leaks=$((leaks + 1))
    printf '!! %-58s %s\n' "$CASE" "WORKING TREE NOT RESTORED"
  fi
}

# gate_in <image> — gate:toolbox inside <image>, shaped as scripts/dev runs it
# (same uid:gid, repo at its real path, same four env values) but with
# --network none and NO socket. Called directly with docker rather than via
# scripts/dev, because scripts/dev re-derives the image from .tool-versions and
# would rebuild instead of running the image under attack.
gate_in() {
  docker run --rm --network none \
    --user "$(id -u):$(id -g)" \
    --volume "$REPO:$REPO" --workdir "$REPO" \
    --env HOME=/home/toolbox --env CI=1 --env TZ=UTC --env LANG=C.UTF-8 \
    --label io.kinvara.toolbox=1 --label "$LABEL" \
    "$1" node "$GATE_IMPL"
}

# derive <suffix> <shell> — an image FROM the real toolbox with one RUN applied.
derive() {
  printf 'FROM %s\nRUN %s\n' "$IMAGE" "$2" |
    docker build --quiet --network none --label "$LABEL" -t "$NEG:$1" - >/dev/null 2>&1
}

# in_image <image> <argv...> — exit status of a command in the image.
in_image() {
  local img="$1"; shift
  docker run --rm --network none --label "$LABEL" "$img" "$@" >/dev/null 2>&1
}

# run_case <label> <PASS|FAIL> <reason substring...> -- <cmd...>
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
  if [ "$((npass + nfail))" -ne 1 ]; then banner=CRASH
  elif [ "$npass" -eq 1 ]; then banner=PASS
  else banner=FAIL; fi
  [ "$banner" = "$expect" ] || problems+=("banner=$banner expected=$expect")
  if [ "$expect" = PASS ]; then
    [ "$code" -eq 0 ] || problems+=("exit=$code expected 0")
  else
    [ "$code" -ne 0 ] || problems+=("exit=0 expected non-zero")
  fi
  for r in ${reasons+"${reasons[@]}"}; do
    printf '%s' "$out" | grep -qF -- "$r" || problems+=("missing reason: $r")
  done
  if [ ${#problems[@]} -eq 0 ]; then
    printf '   %-58s %s\n' "$label" "ok  (exit=$code banner=$banner)"
    # The gate's own reasons, so the record shows WHY it refused, not only
    # that it did.
    [ "$banner" = FAIL ] && printf '%s\n' "$out" | grep '^  - ' | sed 's/^/       | /'
  else
    bad=$((bad + 1))
    printf '!! %-58s %s\n' "$label" "MISBEHAVED"
    printf '       %s\n' "${problems[@]}"
    printf '%s\n' "$out" | tail -16 | sed 's/^/       | /'
  fi
  check_restored
}

# run_raw <label> <ZERO|NONZERO> <reason...> -- <cmd...> — for a program that is
# not a gate (a build) and prints no banner. Judged on exit status and reasons,
# and it says so.
run_raw() {
  local label="$1" expect="$2"; shift 2
  local reasons=()
  while [ "$1" != "--" ]; do reasons+=("$1"); shift; done
  shift
  local out code problems=() r
  out="$("$@" 2>&1)"; code=$?
  ran=$((ran + 1))
  if [ "$expect" = ZERO ]; then
    [ "$code" -eq 0 ] || problems+=("exit=$code expected 0")
  else
    [ "$code" -ne 0 ] || problems+=("exit=0 expected non-zero")
  fi
  for r in ${reasons+"${reasons[@]}"}; do
    printf '%s' "$out" | grep -qF -- "$r" || problems+=("missing reason: $r")
  done
  if [ ${#problems[@]} -eq 0 ]; then
    printf '   %-58s %s\n' "$label" "ok  (exit=$code, no banner: not a gate)"
  else
    bad=$((bad + 1))
    printf '!! %-58s %s\n' "$label" "MISBEHAVED"
    printf '       %s\n' "${problems[@]}"
    printf '%s\n' "$out" | tail -16 | sed 's/^/       | /'
  fi
  check_restored
}

echo "image under attack: $IMAGE"
echo "gate implementation: $GATE_IMPL"
echo "espeak-ng pin: $PIN   data: $DATA"
echo

echo "=== E. gate:toolbox — the espeak-ng pin and its en/el/ru voices (T-262) ==="

CASE="E0"
run_case "E0 CONTROL: the real image, the committed pins" PASS \
  "ok espeak-ng  $PIN" 'ok en  listed (gmw/en)' 'ok el  listed (grk/el)' \
  'ok ru  listed (zle/ru)' 'GATE PASS  gate:toolbox' -- gate_in "$IMAGE"

# E1 — the pin bumped with no matching install: the image is the one built at
# the committed pin, .tool-versions now says otherwise. This is exactly the
# state the gate exists for — a toolchain that does not match its pin.
CASE="E1"
sed -i "s/^espeak-ng ${PIN//./\\.}\$/espeak-ng ${BUMPED}/" "$PINS"
if grep -qx "espeak-ng ${BUMPED}" "$PINS" && ! grep -qx "espeak-ng ${PIN}" "$PINS"; then
  run_case "E1 pin bumped, image not rebuilt (no matching install)" FAIL \
    "espeak-ng: reports '${PIN}', .tool-versions pins '${BUMPED}'" \
    "X  espeak-ng  ${PIN} != pinned ${BUMPED}" -- gate_in "$IMAGE"
else
  harness_error "the pin bump did not land in $PINS"; check_restored
fi

# E1b — the same bump through the documented path: scripts/dev derives a new
# tag from the bumped pins and builds it, and the Dockerfile REFUSES, because
# bookworm's espeak-ng is not the bumped version. No image may result.
CASE="E1b"
sed -i "s/^espeak-ng ${PIN//./\\.}\$/espeak-ng ${BUMPED}/" "$PINS"
if grep -qx "espeak-ng ${BUMPED}" "$PINS" && ! grep -qx "espeak-ng ${PIN}" "$PINS"; then
  toolbox_load_pins "$PINS"
  E1B_TAG="$(toolbox_image_tag "$PINS" toolbox)"
  toolbox_load_pins "$BK/pins"
  if [ "$E1B_TAG" = "$IMAGE" ]; then
    harness_error "the bumped pins produced the SAME tag — the fingerprint did not move"
    check_restored
  else
    run_raw "E1b the same bump via scripts/dev: the BUILD refuses" NONZERO \
      "not the pinned upstream ${BUMPED} (.tool-versions)" -- scripts/dev true
    if docker image inspect "$E1B_TAG" >/dev/null 2>&1; then
      bad=$((bad + 1))
      printf '!! %-58s %s\n' "E1b" "an image WAS produced at $E1B_TAG — the refusal did not hold"
    fi
  fi
else
  harness_error "the pin bump did not land in $PINS"; check_restored
fi

# E2 — the el DICTIONARY deleted from the image. The voice is still LISTED
# (its definition file is intact), so only SPEAKS can catch this.
CASE="E2"
if derive el-dict "rm $DATA/el_dict" &&
  in_image "$NEG:el-dict" test ! -e "$DATA/el_dict" &&
  in_image "$IMAGE" test -e "$DATA/el_dict"; then
  run_case "E2 el dictionary deleted in the image" FAIL \
    'espeak-ng voice el:' 'ok en  listed (gmw/en)' 'ok ru  listed (zle/ru)' \
    -- gate_in "$NEG:el-dict"
else
  harness_error "could not build an image with $DATA/el_dict removed, or it was not removed"
  check_restored
fi

# E3 — the el VOICE DEFINITION deleted from the image (dictionary intact).
CASE="E3"
if derive el-voice "rm $DATA/lang/grk/el" &&
  in_image "$NEG:el-voice" test ! -e "$DATA/lang/grk/el" &&
  in_image "$IMAGE" test -e "$DATA/lang/grk/el"; then
  run_case "E3 el voice definition deleted in the image" FAIL \
    'does not list the voice file grk/el' 'ok en  listed (gmw/en)' 'ok ru  listed (zle/ru)' \
    -- gate_in "$NEG:el-voice"
else
  harness_error "could not build an image with $DATA/lang/grk/el removed, or it was not removed"
  check_restored
fi

# E4 — the binary deleted from the image: the pin is present, the tool is not.
CASE="E4"
if derive no-binary "rm /usr/bin/espeak-ng" &&
  ! in_image "$NEG:no-binary" sh -c 'command -v espeak-ng' &&
  in_image "$IMAGE" sh -c 'command -v espeak-ng'; then
  run_case "E4 espeak-ng binary absent from the image" FAIL \
    "espeak-ng: 'espeak-ng --version' exited" 'espeak-ng voice en:' \
    -- gate_in "$NEG:no-binary"
else
  harness_error "could not build an image without /usr/bin/espeak-ng, or it is still there"
  check_restored
fi

echo
tree_final="$(git status --porcelain)"
if [ "$tree_final" = "$TREE0" ]; then
  tree_bad=0
  echo "WORKING TREE UNCHANGED: git status --porcelain identical before and after; $PINS sha256 = HEAD's"
else
  tree_bad=1
  echo "!! WORKING TREE CHANGED: this suite did not restore what it planted"
fi

echo
if [ "$bad" -eq 0 ] && [ "$harness" -eq 0 ] && [ "$leaks" -eq 0 ] && [ "$tree_bad" -eq 0 ]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S); $leaks TREE LEAK(S)"
fi
exit $((bad + harness + leaks + tree_bad))
