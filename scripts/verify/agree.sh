#!/usr/bin/env bash
#
# scripts/verify/agree.sh <ticket> [app]
#
# T-018's third gate clause: "a toolbox-only run and a `--verify` container run
# of the same gate agree."
#
# DOCKER.md §5 splits the dev loop from the evidence run precisely because
# container-specific failures — signals, DNS, paths, env resolution, non-root
# permissions, NODE_ENV — are invisible outside the image. This command is what
# turns that from an argument into a measurement: it runs THE SAME contract
# probe twice,
#
#   A. against the app started INSIDE THE TOOLBOX (scripts/dev; no services,
#      loopback), and
#   B. against the app running AS ITS CONTAINER under --verify, reached by
#      compose service name from `scripts/svc run`,
#
# and requires the two to be byte-identical AND both to exit 0. Both halves:
# two runs that fail identically are also byte-identical, and this host's shell
# is zsh (PROTOCOL §5.1).
set -uo pipefail
cd "$(dirname "$0")/../.."

TICKET="${1:?usage: scripts/verify/agree.sh <ticket> [app]}"
APP="${2:-core}"
PORT=3000
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT

echo "== A. toolbox-only (scripts/dev, no services) =="
./scripts/dev bash -c "
  set -u
  export KINVARA_APP=${APP} KINVARA_APP_KIND=http PORT=${PORT} \
         KINVARA_APP_DIR=\$PWD/apps/${APP}
  node docker/app-runtime/entrypoint.mjs &
  app=\$!
  for _ in \$(seq 1 100); do
    node -e 'fetch(\"http://127.0.0.1:${PORT}/healthz\").then(()=>process.exit(0),()=>process.exit(1))' 2>/dev/null && break
    sleep 0.1
  done
  node scripts/verify/runtime-contract.mjs http://127.0.0.1:${PORT}
  rc=\$?
  kill \$app 2>/dev/null
  wait \$app 2>/dev/null
  exit \$rc
" > "${OUT}/toolbox.txt" 2>"${OUT}/toolbox.err"
a=$?
cat "${OUT}/toolbox.txt"; sed 's/^/  /' "${OUT}/toolbox.err"
echo "  exit=${a}"

echo
echo "== B. the --verify container (svc run, on kinvara-int, by service name) =="
./scripts/svc run "${TICKET}" -- node scripts/verify/runtime-contract.mjs "http://${APP}:${PORT}" \
  > "${OUT}/container.txt" 2>"${OUT}/container.err"
b=$?
cat "${OUT}/container.txt"; sed 's/^/  /' "${OUT}/container.err"
echo "  exit=${b}"

echo
echo "== agreement =="
fails=0
if [[ "${a}" -ne 0 || "${b}" -ne 0 ]]; then
  echo "  FAIL  exit statuses: toolbox=${a} container=${b} — both must be 0"
  fails=$((fails+1))
else
  echo "  ok    both runs exited 0"
fi
if diff -u "${OUT}/toolbox.txt" "${OUT}/container.txt" > "${OUT}/diff"; then
  echo "  ok    byte-identical contract output ($(wc -c < "${OUT}/toolbox.txt") bytes)"
else
  echo "  FAIL  the two runs disagree:"
  sed 's/^/        /' "${OUT}/diff"
  fails=$((fails+1))
fi
echo "  note  env lines (pid/uid) go to stderr and are NOT compared:"
printf "        toolbox   %s\n" "$(grep "^env:" "${OUT}/toolbox.err")"
printf "        container %s\n" "$(grep "^env:" "${OUT}/container.err")"

echo
[[ "${fails}" -eq 0 ]] && { echo "AGREE PASS  toolbox-only and --verify agree on the runtime contract"; exit 0; }
echo "AGREE FAIL  ${fails} problem(s)"; exit 1
