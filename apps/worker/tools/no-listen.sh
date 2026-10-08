#!/usr/bin/env bash
#
# apps/worker/tools/no-listen.sh <ticket> [container] — T-242: the running worker container has NO
# listening TCP socket (T-034: a worker has no port; OE-79: a NestJS application context, no HTTP
# adapter).
#
#   scripts/svc up <ticket> db worker --verify --build      (on a migrated database)
#   apps/worker/tools/no-listen.sh <ticket>                  (container: <project>-worker-1)
#
# WHAT IT READS: /proc/net/tcp and /proc/net/tcp6 INSIDE the container (`docker exec … cat`), i.e.
# the container's network namespace, whatever process opened the socket. A socket in state 0A
# (TCP_LISTEN) is a listening socket. UDP and unix sockets are PRINTED, not judged (the ticket's
# property is a port a client could connect to; the reading is shown so a reviewer can judge it).
#
# THREE OUTCOMES, distinguishable (PROTOCOL §5.1):
#   NO-LISTEN PASS    exit 0 — every check below held.
#   NO-LISTEN FAIL    exit 1 — the target has a LISTEN socket, or a check below failed.
#   (no verdict)      exit 2 — the container is missing or not running; nothing was judged.
# THE CHECKS, so that "read nothing" cannot pass as "nothing listens":
#   R  both files were read and each starts with its `sl  local_address` header;
#   E  the reading SEES the worker's own sockets: at least one ESTABLISHED (01) connection to
#      remote port 5432 (the worker's pools to postgres). A reading of some other namespace, or
#      of nothing, has none;
#   L  no socket in state 0A in either file;
#   K  CONTROL: the same reader, on the project's `postgres` container, DOES report a LISTEN on
#      5432 — so the reader can see a listening socket when one exists.
set -uo pipefail

TICKET="${1:?usage: apps/worker/tools/no-listen.sh <ticket> [container]}"
PROJECT="kinvara-$(printf '%s' "${TICKET}" | tr '[:upper:]' '[:lower:]')"
CONTAINER="${2:-${PROJECT}-worker-1}"
CONTROL="${PROJECT}-postgres-1"

for c in "${CONTAINER}" "${CONTROL}"; do
  [[ "$(docker inspect "${c}" --format '{{.State.Status}}' 2>/dev/null)" == running ]] \
    || { echo "${c} is not running; nothing judged" >&2; exit 2; }
done

# read_sockets <container>: prints "<file> <state> <local_ip:port(dec)> <remote_ip:port(dec)>" per
# socket, and "HEADER <file> ok|MISSING" per file.
read_sockets() {
  local c="$1" f
  for f in tcp tcp6; do
    docker exec "$c" cat "/proc/net/$f" 2>/dev/null | awk -v f="$f" '
      NR == 1 { print "HEADER " f " " ($1 == "sl" && $2 == "local_address" ? "ok" : "MISSING"); next }
      { split($2, l, ":"); split($3, r, ":");
        printf "%s %s %s:%d %s:%d\n", f, $4, l[1], strtonum("0x" l[2]), r[1], strtonum("0x" r[2]) }
      END { if (NR == 0) print "HEADER " f " MISSING" }'
  done
}

fails=0
mark() { if [[ "$1" == 0 ]]; then printf 'PASS'; else printf 'FAIL'; fails=$((fails + 1)); fi; }

echo "== ${CONTAINER}: /proc/net/tcp, /proc/net/tcp6 (file state local remote; 0A = LISTEN, 01 = ESTABLISHED) =="
target="$(read_sockets "${CONTAINER}")"
printf '%s\n' "${target}" | sed 's/^/   /'
echo "== ${CONTAINER}: /proc/net/udp, /proc/net/udp6, listening unix sockets (printed, not judged) =="
docker exec "${CONTAINER}" sh -c 'tail -n +2 /proc/net/udp; tail -n +2 /proc/net/udp6; awk "NR > 1 && \$4 == \"00010000\"" /proc/net/unix' | sed 's/^/   /'
echo "   (end)"

printf 'R  both files read, each with its header                       '
[[ "$(grep -c '^HEADER tcp6\? ok$' <<<"${target}")" == 2 ]]; mark $?; printf '\n'
est="$(awk '$1 != "HEADER" && $2 == "01" && $4 ~ /:5432$/' <<<"${target}" | wc -l)"
printf 'E  the reading sees the worker'"'"'s own connections to :5432          '
[[ "${est}" -ge 1 ]]; mark $?; printf '  (%s ESTABLISHED)\n' "${est}"
listen="$(awk '$1 != "HEADER" && $2 == "0A"' <<<"${target}")"
printf 'L  no listening TCP socket in %-34s' "${CONTAINER}"
[[ -z "${listen}" ]]; mark $?; printf '  (%s LISTEN)\n' "$(grep -c . <<<"${listen}")"
[[ -n "${listen}" ]] && printf '%s\n' "${listen}" | sed 's/^/   LISTEN: /'

control="$(read_sockets "${CONTROL}")"
clisten="$(awk '$1 != "HEADER" && $2 == "0A" && $3 ~ /:5432$/' <<<"${control}")"
printf 'K  control: the reader sees postgres LISTEN on :5432 in %-8s' "${CONTROL##*-t-}"
[[ -n "${clisten}" ]]; mark $?; printf '\n'
printf '%s\n' "${clisten}" | sed 's/^/   control LISTEN: /'

echo
if [[ "${fails}" -eq 0 ]]; then echo "NO-LISTEN PASS  ${CONTAINER}"; exit 0; fi
echo "NO-LISTEN FAIL  ${CONTAINER} — ${fails} check(s)"; exit 1
