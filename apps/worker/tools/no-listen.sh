#!/usr/bin/env bash
#
# apps/worker/tools/no-listen.sh <ticket> [container] — T-242: nothing in the running worker
# container listens for a connection (T-034: a worker has no port; OE-79: a NestJS application
# context, no HTTP adapter).
#
#   scripts/svc up <ticket> db worker --verify --build      (on a migrated database)
#   apps/worker/tools/no-listen.sh <ticket>                  (container: <project>-worker-1)
#
# WHAT IT READS, all INSIDE the container (`docker exec`, as the image's user 10001, the same uid
# the worker runs as): /proc/net/tcp and /proc/net/tcp6 — every TCP socket in the container's
# network namespace, with its state and inode — and /proc/<pid>/fd/* — which socket inodes the
# container's processes hold. State 0A is TCP_LISTEN.
#
# WHY NOT "NO 0A AT ALL" (measured, state/EP-2/T-242.md progress log 17:36Z): on a user-defined
# network Docker plants its embedded DNS resolver in every container's namespace — a LISTEN on
# 127.0.0.11, uid 0, held by no process in the container (`postgres` has one too, and both
# containers' resolv.conf name 127.0.0.11). No container on kinvara-int can pass "no 0A at all",
# so that check would only ever be red. The two checks below are what "the worker opens no port"
# means, and the unheld loopback LISTEN is PRINTED (with its uid) for a reviewer, not judged.
#
# THE CHECKS, so that "read nothing" cannot pass as "nothing listens" (PROTOCOL §5.1):
#   R   both tcp files were read and each starts with its `sl  local_address` header;
#   E   the socket reading SEES the worker's own sockets: >= 1 ESTABLISHED (01) to remote :5432;
#   H   the fd reading SEES a held socket: >= 1 of those ESTABLISHED inodes is found in a process's
#       fds (so an empty L2 below is not an fd reader that finds nothing);
#   L1  no LISTEN socket on a NON-LOOPBACK local address (one another container could reach);
#   L2  no LISTEN socket, on any address, whose inode a process in the container holds;
#   K   CONTROL: the same socket reader on the project's `postgres` container reports a LISTEN on
#       0.0.0.0:5432 — it can see a reachable listening socket when one exists.
# OUTCOMES: NO-LISTEN PASS (exit 0) — every check held; NO-LISTEN FAIL (exit 1) — any did not;
# exit 2 with no verdict — a container is missing or not running, nothing judged.
set -uo pipefail

TICKET="${1:?usage: apps/worker/tools/no-listen.sh <ticket> [container]}"
PROJECT="kinvara-$(printf '%s' "${TICKET}" | tr '[:upper:]' '[:lower:]')"
CONTAINER="${2:-${PROJECT}-worker-1}"
CONTROL="${PROJECT}-postgres-1"

for c in "${CONTAINER}" "${CONTROL}"; do
  [[ "$(docker inspect "${c}" --format '{{.State.Status}}' 2>/dev/null)" == running ]] \
    || { echo "${c} is not running; nothing judged" >&2; exit 2; }
done

# read_sockets <container>: "<file> <state> <local_ip_hex>:<port_dec> <remote_ip_hex>:<port_dec>
# <inode> <uid>" per socket, and "HEADER <file> ok|MISSING" per file.
read_sockets() {
  local c="$1" f
  for f in tcp tcp6; do
    docker exec "$c" cat "/proc/net/$f" 2>/dev/null | awk -v f="$f" '
      NR == 1 { print "HEADER " f " " ($1 == "sl" && $2 == "local_address" ? "ok" : "MISSING"); next }
      { split($2, l, ":"); split($3, r, ":");
        printf "%s %s %s:%d %s:%d %s %s\n", f, $4, l[1], strtonum("0x" l[2]), r[1], strtonum("0x" r[2]), $10, $8 }
      END { if (NR == 0) print "HEADER " f " MISSING" }'
  done
}
# loopback: 127.0.0.0/8 (tcp, little-endian hex: last byte 7F) or ::1 / ::ffff:127.x (tcp6)
is_loopback='($1 == "tcp" && $3 ~ /^......7F:/) || ($1 == "tcp6" && ($3 ~ /^00000000000000000000000001000000:/ || $3 ~ /^0000000000000000FFFF0000......7F:/))'

fails=0
mark() { if [[ "$1" == 0 ]]; then printf 'PASS'; else printf 'FAIL'; fails=$((fails + 1)); fi; }

echo "== ${CONTAINER}: /proc/net/tcp, /proc/net/tcp6 (file state local remote inode uid; 0A = LISTEN, 01 = ESTABLISHED) =="
target="$(read_sockets "${CONTAINER}")"
printf '%s\n' "${target}" | sed 's/^/   /'
echo "== ${CONTAINER}: socket inodes held by the container's processes (/proc/<pid>/fd) =="
held="$(docker exec "${CONTAINER}" sh -c 'for p in /proc/[0-9]*; do for fd in "$p"/fd/*; do l=$(readlink "$fd" 2>/dev/null) || continue; case "$l" in socket:*) echo "${p#/proc/} $(cat "$p/comm" 2>/dev/null) ${l#socket:}";; esac; done; done' | tr -d '[]')"
printf '%s\n' "${held}" | sed 's/^/   pid comm inode: /'
echo "== ${CONTAINER}: /proc/net/udp, /proc/net/udp6, listening unix sockets (printed, not judged) =="
docker exec "${CONTAINER}" sh -c 'tail -n +2 /proc/net/udp; tail -n +2 /proc/net/udp6; awk "NR > 1 && \$4 == \"00010000\"" /proc/net/unix' | sed 's/^/   /'
echo "   (end)  resolv.conf: $(docker exec "${CONTAINER}" grep -h '^nameserver' /etc/resolv.conf | tr '\n' ' ')"

held_inodes="$(awk '{print $3}' <<<"${held}" | sort -u)"
printf 'R   both tcp files read, each with its header                   '
[[ "$(grep -c '^HEADER tcp6\? ok$' <<<"${target}")" == 2 ]]; mark $?; printf '\n'
est="$(awk '$1 != "HEADER" && $2 == "01" && $4 ~ /:5432$/ {print $5}' <<<"${target}")"
printf 'E   the socket reading sees the worker'"'"'s connections to :5432      '
[[ -n "${est}" ]]; mark $?; printf '  (%s ESTABLISHED)\n' "$(grep -c . <<<"${est}")"
est_held="$(comm -12 <(sort -u <<<"${est}") <(printf '%s\n' "${held_inodes}"))"
printf 'H   the fd reading finds those sockets held by a process            '
[[ -n "${est_held}" ]]; mark $?; printf '  (%s of them)\n' "$(grep -c . <<<"${est_held}")"
listen_all="$(awk '$1 != "HEADER" && $2 == "0A"' <<<"${target}")"
listen_ext="$(awk "\$1 != \"HEADER\" && \$2 == \"0A\" && !(${is_loopback})" <<<"${target}")"
printf 'L1  no LISTEN on a non-loopback address                             '
[[ -z "${listen_ext}" ]]; mark $?; printf '  (%s)\n' "$(grep -c . <<<"${listen_ext}")"
[[ -n "${listen_ext}" ]] && printf '%s\n' "${listen_ext}" | sed 's/^/    LISTEN (reachable): /'
listen_held="$(awk 'NR == FNR { h[$1] = 1; next } $1 != "HEADER" && $2 == "0A" && ($5 in h)' <(printf '%s\n' "${held_inodes}") <(printf '%s\n' "${target}"))"
printf 'L2  no LISTEN socket held by a process in the container             '
[[ -z "${listen_held}" ]]; mark $?; printf '  (%s)\n' "$(grep -c . <<<"${listen_held}")"
[[ -n "${listen_held}" ]] && printf '%s\n' "${listen_held}" | sed 's/^/    LISTEN (held): /'
unjudged="$(awk 'NR == FNR { h[$1] = 1; next } $1 != "HEADER" && $2 == "0A" && !($5 in h)' <(printf '%s\n' "${held_inodes}") <(printf '%s\n' "${listen_all}"))"
[[ -n "${unjudged}" ]] && printf '%s\n' "${unjudged}" | sed 's/^/    not judged — loopback LISTEN held by no process in the container: /'

control="$(read_sockets "${CONTROL}")"
clisten="$(awk '$1 != "HEADER" && $2 == "0A" && $3 ~ /^0+:5432$/' <<<"${control}")"
printf 'K   control: the reader sees %s LISTEN on 0.0.0.0:5432  ' "${CONTROL}"
[[ -n "${clisten}" ]]; mark $?; printf '\n'
printf '%s\n' "${clisten}" | sed 's/^/    control LISTEN: /'

echo
if [[ "${fails}" -eq 0 ]]; then echo "NO-LISTEN PASS  ${CONTAINER}"; exit 0; fi
echo "NO-LISTEN FAIL  ${CONTAINER} — ${fails} check(s)"; exit 1
