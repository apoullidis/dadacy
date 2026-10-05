#!/usr/bin/env bash
#
# apps/worker/tools/drain-check.sh <ticket> — T-148 acceptance (d), on the containerised worker:
# SIGTERM with a job in flight -> the job completes and the worker exits 0 inside its grace.
#
#   scripts/svc up <ticket> db worker --verify --build      (on a migrated database)
#   apps/worker/tools/drain-check.sh <ticket>
#
# The shape of scripts/verify/sigterm-drain.sh (T-151 § contract §4) with a JOB as the in-flight
# unit, because the worker has no port for that script's HTTP request (it REFUSES `worker`, exit 2).
# The probe (drain-probe.ts) runs under `svc run` on the project's network and judges A and B; the
# host sends the signal and judges C and D; marker files in the bind mount hand off between them.
# It also prints, from the host, what only the host can see: the process tree in the container just
# before the signal (OD-196: is anything else in PID 1's process group?), the container's own log
# (the entrypoint's boot line and path; the placeholder banner asserted ABSENT — acceptance (c)),
# ExitCode, OOMKilled and the wall time.
#
# Verdicts: DRAIN PASS (exit 0), DRAIN FAIL (exit 1). Nothing else exits 0.
set -uo pipefail
cd "$(dirname "$0")/../../.."

TICKET="${1:?usage: apps/worker/tools/drain-check.sh <ticket>}"
PROJECT="kinvara-$(printf '%s' "${TICKET}" | tr '[:upper:]' '[:lower:]')"
CONTAINER="${PROJECT}-worker-1"
DIR=".cache/worker-drain"

docker inspect "${CONTAINER}" >/dev/null 2>&1 \
  || { echo "no container ${CONTAINER}. Run: scripts/svc up ${TICKET} db worker --verify --build" >&2; exit 1; }
[[ "$(docker inspect "${CONTAINER}" --format '{{.State.Status}}')" == running ]] \
  || { echo "${CONTAINER} is not running" >&2; exit 1; }
GRACE="$(docker inspect "${CONTAINER}" --format '{{.Config.StopTimeout}}')"
[[ "${GRACE}" == "<no value>" || -z "${GRACE}" ]] && GRACE=10

rm -rf "${DIR}"; mkdir -p "${DIR}"
trap 'rm -rf "${DIR}"' EXIT

echo "== ${CONTAINER}: stop_grace_period=${GRACE}s =="
( ./scripts/svc run "${TICKET}" -- node apps/worker/tools/drain-probe.ts > "${DIR}/probe.log" 2>&1
  echo "PROBE_EXIT=$?" >> "${DIR}/probe.log" ) &
probe_pid=$!

for _ in $(seq 1 400); do [[ -f "${DIR}/inflight" ]] && break; sleep 0.1; done
if [[ ! -f "${DIR}/inflight" ]]; then
  echo "the probe never reported a job in flight:" >&2; cat "${DIR}/probe.log" >&2
  kill "${probe_pid}" 2>/dev/null; exit 1
fi

echo "== process tree in ${CONTAINER} just before the signal (pid ppid pgid stat args) =="
docker exec "${CONTAINER}" ps -o pid,ppid,pgid,stat,args

start="$(date +%s.%N)"
docker kill -s TERM "${CONTAINER}" >/dev/null
printf '%s\n' "${start}" > "${DIR}/sigterm-sent"
echo "SIGTERM sent to ${CONTAINER}"

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
touch "${DIR}/exited"
wait "${probe_pid}"

echo; echo "== docker logs ${CONTAINER} =="; docker logs "${CONTAINER}" 2>&1
echo; cat "${DIR}/probe.log"; echo
probe_exit="$(sed -n 's/^PROBE_EXIT=//p' "${DIR}/probe.log")"

fails=0
mark() { if [[ "$1" == 0 ]]; then printf 'PASS'; else printf 'FAIL'; fails=$((fails+1)); fi; }
logs="$(docker logs "${CONTAINER}" 2>&1)"
printf 'L  boot line: argv path, real mode; placeholder banner ABSENT   '
{ grep -qF 'mode=real  running start (node src/main.ts) as a direct child' <<<"${logs}" \
  && ! grep -qF 'PLACEHOLDER RUNTIME' <<<"${logs}"; }; mark $?; printf '\n'
printf 'C  the container EXITED, and exited 0 (not 137/143)             '; [[ "${status}" == "exited" && "${code}" == 0 ]]; mark $?; printf '  (status=%s exit=%s oom=%s)\n' "${status}" "${code}" "${oom}"
printf 'D  it exited well inside stop_grace_period=%ss                  ' "${GRACE}"; { [[ "${status}" == "exited" ]] && awk -v e="${elapsed}" -v g="${GRACE}" 'BEGIN{exit !(e < g-1)}'; }; mark $?; printf '  (%ss)\n' "${elapsed}"
[[ "${probe_exit}" != "0" ]] && fails=$((fails+1))

echo
if [[ "${fails}" -eq 0 ]]; then echo "DRAIN PASS  ${CONTAINER}"; exit 0; fi
echo "DRAIN FAIL  ${CONTAINER} — ${fails} assertion(s)"; exit 1
