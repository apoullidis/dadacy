#!/usr/bin/env bash
#
# scripts/verify/sigterm-drain.sh <ticket> [service] [options]
#
# "<service> shuts down cleanly on SIGTERM with no dropped in-flight request" —
# T-018's headline gate, as a command anyone can re-run rather than a paste in
# an evidence file.
#
#   scripts/svc up T-151 api --verify --build
#   scripts/verify/sigterm-drain.sh T-151 core \
#       --method POST --path /v1/auth/login --body '{}' \
#       --expect-status 400 --expect-body-contains invalid_input
#
# WHY IT TAKES TWO PROCESSES. The assertion needs a request to be IN FLIGHT at
# the moment the signal lands. The client must therefore be on the ticket's
# internal network (`svc run`, addressing `core:3000` by service name), and the
# signal must come from the host — a process under `svc run` has no Docker
# socket, by T-018's own OD-16 ruling. They hand off through marker files in the
# bind-mounted repository.
#
# FOUR ASSERTIONS, two from each side. "It exited 0" alone would be satisfied by
# a process that dropped the request and then exited tidily, which is the defect
# this exists to catch.
#
# =============================================================================
# THE IN-FLIGHT REQUEST IS A PARAMETER (T-151, decisions.md OD-101)
# =============================================================================
# It used to be hard-coded as `GET /__placeholder/slow?ms=6000`, which only
# `docker/app-runtime/entrypoint.mjs`'s PLACEHOLDER serves — so this script
# could not judge a real application at all. Two shapes are available now:
#
#   (no --body)  the SERVER is slow and the client waits. The placeholder's
#                `/__placeholder/slow?ms=` route. This is the default, and it is
#                still what a placeholder-mode service is judged with.
#   (--body)     the CLIENT is slow: headers and a Content-Length go out, then
#                one byte, and the rest of the body is withheld until after
#                SIGTERM. The server is mid-request across the signal without
#                the application needing a slow route of its own. `--hold` does
#                not apply to this shape — see usage() below.
#
# AND IT REFUSES RATHER THAN REPORTING A FALSE FAIL: given no --path against a
# service whose /healthz says `mode: real`, the probe exits 2 and this script
# prints SIGTERM DRAIN REFUSED and never sends a signal. Refused, failed and
# crashed are three distinguishable outcomes (PROTOCOL §5.1).
set -uo pipefail
cd "$(dirname "$0")/../.."

usage() {
  cat >&2 <<'USAGE'
usage: scripts/verify/sigterm-drain.sh <ticket> [service] [options]

  --method M                HTTP method for the in-flight request
                            (default GET, or POST when --body is given)
  --path P                  request path. Supplying it is what tells this
                            script you know which request holds THIS app open
  --body S                  request body; its presence selects the `slow-body`
                            shape, which withholds the body until after SIGTERM
  --content-type T          default application/json, with --body
  --expect-status N         status the completed response must carry (default 200)
  --expect-body-contains S  substring the completed body must contain
  --hold MS                 server-slow shape ONLY: how long the SERVER is asked
                            to hold the request (default 6000). It is the `ms=`
                            of the placeholder's slow route and the floor
                            assertion A checks the elapsed time against. IT IS
                            NOT USED IN THE slow-body SHAPE (--body): there the
                            request is held until SIGTERM arrives and then for a
                            further fixed 1200 ms, whatever --hold says
                            (T-151 rework 1, QA-F3)
  --host H / --port N       default: the service name, and 3000
  -h, --help                this text
USAGE
}

TICKET="${1:-}"
[[ -z "${TICKET}" || "${TICKET}" == "-h" || "${TICKET}" == "--help" ]] && { usage; exit 1; }
shift
SERVICE="core"
if [[ $# -gt 0 && "$1" != --* ]]; then SERVICE="$1"; shift; fi

METHOD=""
REQ_PATH=""
BODY=""
HAS_BODY=0
CONTENT_TYPE="application/json"
EXPECT_STATUS=200
EXPECT_CONTAINS=""
HOLD=6000
HOST=""
PORT=3000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method) METHOD="$2"; shift 2 ;;
    --path) REQ_PATH="$2"; shift 2 ;;
    --body) BODY="$2"; HAS_BODY=1; shift 2 ;;
    --content-type) CONTENT_TYPE="$2"; shift 2 ;;
    --expect-status) EXPECT_STATUS="$2"; shift 2 ;;
    --expect-body-contains) EXPECT_CONTAINS="$2"; shift 2 ;;
    --hold) HOLD="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) usage; exit 1 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

PROJECT="kinvara-$(printf '%s' "${TICKET}" | tr '[:upper:]' '[:lower:]')"
CONTAINER="${PROJECT}-${SERVICE}-1"
DIR=".sigterm-drain"
[[ -z "${HOST}" ]] && HOST="${SERVICE}"

# DEFAULTED is what the probe uses to decide whether it may judge this service
# at all: no --path means the caller did not say which request holds this app
# open, so only a placeholder can be judged.
DEFAULTED=false
if [[ -z "${REQ_PATH}" ]]; then
  DEFAULTED=true
  REQ_PATH="/__placeholder/slow?ms=${HOLD}"
fi
if [[ -z "${METHOD}" ]]; then
  METHOD=GET
  [[ "${HAS_BODY}" == 1 ]] && METHOD=POST
fi
SHAPE=server-slow
[[ "${HAS_BODY}" == 1 ]] && SHAPE=slow-body

command -v docker >/dev/null 2>&1 || { echo "docker is not installed" >&2; exit 1; }
docker inspect "${CONTAINER}" >/dev/null 2>&1 || {
  echo "no container ${CONTAINER}. Run: scripts/svc up ${TICKET} <profiles> --verify --build" >&2; exit 1; }

GRACE="$(docker inspect "${CONTAINER}" --format '{{.Config.StopTimeout}}')"
[[ "${GRACE}" == "<no value>" || -z "${GRACE}" ]] && GRACE=10

rm -rf "${DIR}"; mkdir -p "${DIR}"
trap 'rm -rf "${DIR}"' EXIT

# The request spec, handed to the probe the same way every other fact crosses
# this boundary: a file in the bind mount. Written by python3 — the one
# interpreter this host has (DOCKER.md §0.1: node is NOT installed here, and
# hand-rolled shell JSON quoting of an arbitrary --body is a defect waiting to
# happen).
command -v python3 >/dev/null 2>&1 || { echo "python3 is not installed; it writes the request spec" >&2; exit 1; }
SHAPE="${SHAPE}" HOST="${HOST}" PORT="${PORT}" METHOD="${METHOD}" REQ_PATH="${REQ_PATH}" \
BODY="${BODY}" HAS_BODY="${HAS_BODY}" CONTENT_TYPE="${CONTENT_TYPE}" \
EXPECT_STATUS="${EXPECT_STATUS}" EXPECT_CONTAINS="${EXPECT_CONTAINS}" HOLD="${HOLD}" \
DEFAULTED="${DEFAULTED}" OUT="${DIR}/request.json" \
  python3 -c '
import json, os
e = os.environ
has_body = e["HAS_BODY"] == "1"
spec = {
    "shape": e["SHAPE"], "host": e["HOST"], "port": int(e["PORT"]),
    "method": e["METHOD"], "path": e["REQ_PATH"],
    "body": e["BODY"] if has_body else None,
    "headers": {"Content-Type": e["CONTENT_TYPE"]} if has_body else {},
    "expectStatus": int(e["EXPECT_STATUS"]),
    "expectBodyContains": e["EXPECT_CONTAINS"] or None,
    "holdMs": int(e["HOLD"]),
    "defaulted": e["DEFAULTED"] == "true",
}
open(e["OUT"], "w").write(json.dumps(spec, indent=2))
' || { echo "could not write the request spec" >&2; exit 1; }

echo "== ${CONTAINER}: stop_grace_period=${GRACE}s =="
echo "== in-flight request: ${SHAPE}  ${METHOD} ${REQ_PATH}  expect ${EXPECT_STATUS} =="
( ./scripts/svc run "${TICKET}" -- node scripts/verify/sigterm-drain-probe.mjs \
    > "${DIR}/probe.log" 2>&1; echo "PROBE_EXIT=$?" >> "${DIR}/probe.log" ) &
probe_pid=$!

for _ in $(seq 1 300); do
  [[ -f "${DIR}/inflight" || -f "${DIR}/refused" ]] && break
  sleep 0.1
done

# REFUSED is not FAIL. Nothing is signalled, nothing is judged, and the reason
# is printed — the alternative is an assertion that was never about this app.
if [[ -f "${DIR}/refused" ]]; then
  wait "${probe_pid}"
  echo; cat "${DIR}/probe.log"; echo
  echo "SIGTERM DRAIN REFUSED  ${CONTAINER} — no signal was sent, nothing was judged"
  exit 2
fi

if [[ ! -f "${DIR}/inflight" ]]; then
  echo "the probe never reported a request in flight:" >&2; cat "${DIR}/probe.log" >&2
  kill "${probe_pid}" 2>/dev/null; exit 1
fi

start="$(date +%s.%N)"
docker kill -s TERM "${CONTAINER}" >/dev/null
date +%s.%N > "${DIR}/sigterm-sent"
echo "SIGTERM sent to ${CONTAINER}"

# Wait a little beyond the grace period, then stop. A process that ignores
# SIGTERM would otherwise hold this loop for as long as it is given.
limit=$(( (GRACE + 10) * 10 ))
status=running
for _ in $(seq 1 "${limit}"); do
  status="$(docker inspect "${CONTAINER}" --format '{{.State.Status}}')"
  [[ "${status}" == "exited" ]] && break
  sleep 0.1
done
elapsed="$(awk -v a="$(date +%s.%N)" -v b="${start}" 'BEGIN{printf "%.2f", a-b}')"
code="$(docker inspect "${CONTAINER}" --format '{{.State.ExitCode}}')"
oom="$(docker inspect "${CONTAINER}" --format '{{.State.OOMKilled}}')"
wait "${probe_pid}"

echo; cat "${DIR}/probe.log"; echo
probe_exit="$(sed -n 's/^PROBE_EXIT=//p' "${DIR}/probe.log")"

fails=0
mark() { if [[ "$1" == 0 ]]; then printf 'PASS'; else printf 'FAIL'; fails=$((fails+1)); fi; }
# NOTE ON C. `docker inspect .State.ExitCode` is 0 for a container that is
# STILL RUNNING, so "exit code is 0" on its own is vacuously true for a process
# that ignored the signal entirely. The status is asserted first, and this is
# not hypothetical: the negative test below caught exactly that in an earlier
# version of this script.
printf 'C  the container actually EXITED, and exited 0 (not 137/143)      '; [[ "${status}" == "exited" && "${code}" == 0 ]]; mark $?; printf '  (status=%s exit=%s oom=%s)\n' "${status}" "${code}" "${oom}"
printf 'D  it exited well inside stop_grace_period=%ss, not on the axe   ' "${GRACE}"; { [[ "${status}" == "exited" ]] && awk -v e="${elapsed}" -v g="${GRACE}" 'BEGIN{exit !(e < g-1)}'; }; mark $?; printf '  (%ss)\n' "${elapsed}"
[[ "${probe_exit}" != "0" ]] && fails=$((fails+1))

echo
if [[ "${fails}" -eq 0 ]]; then echo "SIGTERM DRAIN PASS  ${CONTAINER}"; exit 0; fi
echo "SIGTERM DRAIN FAIL  ${CONTAINER} — ${fails} assertion(s)"; exit 1
