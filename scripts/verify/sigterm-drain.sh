#!/usr/bin/env bash
#
# scripts/verify/sigterm-drain.sh <ticket> [service]
#
# "`core` shuts down cleanly on SIGTERM with no dropped in-flight request" —
# T-018's headline gate, as a command anyone can re-run rather than a paste in
# an evidence file.
#
#   scripts/svc up T-018 db api worker safety --verify --build
#   scripts/verify/sigterm-drain.sh T-018 core
#
# WHY IT TAKES TWO PROCESSES. The assertion needs a request to be IN FLIGHT at
# the moment the signal lands. The client must therefore be on the ticket's
# internal network (`svc run`, addressing `core:3000` by service name), and the
# signal must come from the host — a process under `svc run` has no Docker
# socket, by this ticket's own OD-16 ruling. They hand off through marker files
# in the bind-mounted repository.
#
# FOUR ASSERTIONS, two from each side. "It exited 0" alone would be satisfied
# by a process that dropped the request and then exited tidily, which is the
# defect this exists to catch.
set -uo pipefail
cd "$(dirname "$0")/../.."

TICKET="${1:?usage: scripts/verify/sigterm-drain.sh <ticket> [service]}"
SERVICE="${2:-core}"
PROJECT="kinvara-$(printf '%s' "${TICKET}" | tr '[:upper:]' '[:lower:]')"
CONTAINER="${PROJECT}-${SERVICE}-1"
DIR=".sigterm-drain"

command -v docker >/dev/null 2>&1 || { echo "docker is not installed" >&2; exit 1; }
docker inspect "${CONTAINER}" >/dev/null 2>&1 || {
  echo "no container ${CONTAINER}. Run: scripts/svc up ${TICKET} <profiles> --verify --build" >&2; exit 1; }

GRACE="$(docker inspect "${CONTAINER}" --format '{{.Config.StopTimeout}}')"
[[ "${GRACE}" == "<no value>" || -z "${GRACE}" ]] && GRACE=10

rm -rf "${DIR}"; mkdir -p "${DIR}"
trap 'rm -rf "${DIR}"' EXIT

echo "== ${CONTAINER}: stop_grace_period=${GRACE}s =="
( ./scripts/svc run "${TICKET}" -- node scripts/verify/sigterm-drain-probe.mjs \
    > "${DIR}/probe.log" 2>&1; echo "PROBE_EXIT=$?" >> "${DIR}/probe.log" ) &
probe_pid=$!

for _ in $(seq 1 300); do [[ -f "${DIR}/inflight" ]] && break; sleep 0.1; done
if [[ ! -f "${DIR}/inflight" ]]; then
  echo "the probe never reported a request in flight:" >&2; cat "${DIR}/probe.log" >&2
  kill "${probe_pid}" 2>/dev/null; exit 1
fi

start="$(date +%s.%N)"
docker kill -s TERM "${CONTAINER}" >/dev/null
date +%s.%N > "${DIR}/sigterm-sent"
echo "SIGTERM sent to ${CONTAINER}"

for _ in $(seq 1 900); do
  [[ "$(docker inspect "${CONTAINER}" --format '{{.State.Status}}')" == "exited" ]] && break
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
printf 'C  the container exited 0 (not 137/143 — not SIGKILLed)          '; [[ "${code}" == 0 ]]; mark $?; printf '  (exit=%s oom=%s)\n' "${code}" "${oom}"
printf 'D  it exited well inside stop_grace_period=%ss, not on the axe   ' "${GRACE}"; awk -v e="${elapsed}" -v g="${GRACE}" 'BEGIN{exit !(e < g-1)}'; mark $?; printf '  (%ss)\n' "${elapsed}"
[[ "${probe_exit}" != "0" ]] && fails=$((fails+1))

echo
if [[ "${fails}" -eq 0 ]]; then echo "SIGTERM DRAIN PASS  ${CONTAINER}"; exit 0; fi
echo "SIGTERM DRAIN FAIL  ${CONTAINER} — ${fails} assertion(s)"; exit 1
