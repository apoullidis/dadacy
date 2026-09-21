#!/usr/bin/env bash
# T-008 negative tests: gate:otel-contract demonstrated REFUSING each thing it
# exists to refuse, then passing again once reverted (PROTOCOL §5.1).
#
# Run it in the toolbox — node exists nowhere else (DOCKER.md §0.1):
#
#   cd /home/alex/projects/nanny/app
#   ./scripts/dev bash scripts/negative-tests/otel-contract.sh
#
# A verdict requires the EXIT STATUS *and* the gate's own banner *and*, where a
# case names one, the REASON SUBSTRING. `CRASH` is its own verdict, so an
# uncaught exception can never be counted as a refusal (OD-27; the fourth
# member of that family is named in PROTOCOL §5.1).
#
# THAT DISTINCTION IS LOAD-BEARING FOR THIS PARTICULAR GATE. `routes.ts` calls
# `assertRegistry()` at module load, so a malformed registry makes any static
# importer THROW. The gate imports it dynamically inside a `try` for exactly
# that reason, and cases R2a-R2c are what prove the banner is printed rather
# than the process dying.
#
# THIS SUITE MUTATES SEVEN TRACKED FILES AND DELETES NONE (OD-119, T-156). Each
# is copied to a temp directory before anything runs and restored by an EXIT /
# INT / TERM trap (OD-160, T-168), so an interrupt leaves the tree as it found
# it. It also REFUSES A DIRTY TREE at startup, because a mutation restored from
# a backup would silently overwrite an edit made before the run.
set -uo pipefail
cd "$(dirname "$0")/../.."

GATE_IMPL="${KINVARA_GATE_IMPL:-scripts/gates/otel-contract.ts}"

ROUTES=packages/observability/src/routes.ts
CONTRACT=packages/observability/src/contract.ts
COLLECTOR=docker/otel-collector.yaml
DASH_TS=infra/observability/dashboards/ts-golden-signals.json
DASH_SLO=infra/observability/dashboards/engineering-slo.json
SERVER=apps/core/src/server.ts
INSTALL=apps/core/src/observability/install.ts
ENDPOINTS=packages/contracts/src/endpoints.ts

TRACKED=("$ROUTES" "$CONTRACT" "$COLLECTOR" "$DASH_TS" "$DASH_SLO" "$SERVER" "$INSTALL" "$ENDPOINTS")
PLANTED=infra/observability/dashboards/zz-planted.json

if [[ -n "$(git status --porcelain -- "${TRACKED[@]}" 2>/dev/null)" ]]; then
  echo "HARNESS ERROR: the working tree is not clean for the files this suite mutates."
  echo "It restores them from a backup taken at startup, so an uncommitted edit would be lost."
  git status --porcelain -- "${TRACKED[@]}"
  exit 2
fi

BK="$(mktemp -d)"
for f in "${TRACKED[@]}"; do
  cp "$f" "$BK/$(echo "$f" | tr '/' '_')"
done

restore() {
  for f in "${TRACKED[@]}"; do
    cp "$BK/$(echo "$f" | tr '/' '_')" "$f"
  done
  rm -f "$PLANTED"
  return 0
}
cleanup() { restore; rm -rf "$BK"; }
trap 'cleanup' EXIT
trap 'cleanup; echo; echo "INTERRUPTED — tree restored"; exit 130' INT
trap 'cleanup; echo; echo "TERMINATED — tree restored"; exit 143' TERM

bad=0
ran=0
harness=0

mut() {
  node scripts/negative-tests/mutate.mjs "$@" || {
    echo "   HARNESS ERROR (anchor not found)"
    harness=$((harness + 1))
    return 1
  }
}

landed() {
  local what="$1"; shift
  if "$@"; then
    return 0
  fi
  echo "   HARNESS ERROR (mutation did not land: $what)"
  harness=$((harness + 1))
  return 1
}

run_case() {
  local label="$1" expect="$2" reason="${3:-}"
  local out code verdict
  out="$(node "$GATE_IMPL" 2>&1)"; code=$?
  if [[ $code -eq 0 && "$out" == *"GATE PASS  gate:otel-contract"* ]]; then
    verdict=PASS
  elif [[ $code -eq 1 && "$out" == *"GATE FAIL  gate:otel-contract"* ]]; then
    verdict=FAIL
    [[ -n "$reason" && "$out" != *"$reason"* ]] && verdict=FAIL-OTHER
  else
    verdict=CRASH
  fi
  ran=$((ran + 1))
  local mark="  "; [[ "$verdict" == "$expect" ]] || { mark="!!"; bad=$((bad + 1)); }
  printf '%s %-62s exit=%d  %-10s (expected %s)\n' "$mark" "$label" "$code" "$verdict" "$expect"
  [[ "$verdict" == FAIL* ]] && printf '%s\n' "$out" | grep -E '^  - ' | head -1 | cut -c1-160 | sed 's/^/       /'
  [[ "$verdict" == CRASH ]] && printf '%s\n' "$out" | tail -3 | sed 's/^/       /'
  restore
}

echo "=== baseline ==="
run_case "00 unmodified tree" PASS

echo
echo "=== R1 — an operation with no route registry entry ==="

mut "$ROUTES" "  'POST /v1/auth/login': {" "  'POST /v1/auth/login_DISABLED': {" \
  && run_case "R1a a served operation loses its registry entry" FAIL "has NO ROUTE_REGISTRY entry"

mut "$ROUTES" "  'GET /v1/meta/platform-fee': {" "  'GET /v1/meta/platform-fee?x=1': {" \
  && run_case "R1b a registry key that is a concrete URL is refused at import" FAIL 'is not "<METHOD> /template"'

echo
echo "=== R2 — the registry refused AT IMPORT must still BANNER, not crash ==="

mut "$ROUTES" "    data_class: 'C2',
    because: 'SA §SEC-3 C2 — the request carries an e-mail address and a password.',
  },
  'POST /v1/auth/logout'" "    data_class: 'C5',
    because: 'SA §SEC-3 C2 — the request carries an e-mail address and a password.',
  },
  'POST /v1/auth/logout'" \
  && run_case "R2a a fifth data class -> GATE FAIL, not an uncaught throw" FAIL "would not load"

mut "$ROUTES" "    module: 'identity',
    data_class: 'C2',
    because: 'SA §SEC-3 C2 — the request carries an e-mail address and a password.',
  },
  'POST /v1/auth/login'" "    module: 'billing',
    data_class: 'C2',
    because: 'SA §SEC-3 C2 — the request carries an e-mail address and a password.',
  },
  'POST /v1/auth/login'" \
  && run_case "R2b a module outside SA SA-2 -> GATE FAIL with the banner" FAIL "would not load"

mut "$ROUTES" "assertRegistry();" "// assertRegistry();" \
  && run_case "R2c the import-time assertion DELETED, registry still sound" PASS

echo
echo "=== R3 — the collector allowlist ==="

mut "$COLLECTOR" "    allow_all_keys: false" "    allow_all_keys: true" \
  && run_case "R3a allow_all_keys: true turns the allowlist into nothing" FAIL "must be false"

mut "$COLLECTOR" "      - data_class
" "" \
  && run_case "R3b a contract field dropped from allowed_keys" FAIL "is NOT in the collector's allowed_keys"

mut "$COLLECTOR" "      processors: [redaction, batch]
      exporters: [otlp/jaeger, spanmetrics]" "      processors: [batch]
      exporters: [otlp/jaeger, spanmetrics]" \
  && run_case "R3c the traces pipeline stops running redaction" FAIL "does not run the redaction processor"

mut "$COLLECTOR" "      - service.name
" "" \
  && run_case "R3d service.name dropped -> the trace is unfindable, not clean" FAIL "service.name is not in allowed_keys"

mut "$COLLECTOR" "      - name: route" "      - name: http.url" \
  && run_case "R3e a spanmetrics dimension the allowlist does not pass" FAIL "which the redaction allowlist does not pass"

echo
echo "=== R4 — the dashboards ==="

mut "$DASH_TS" '"expr": "sum by (route) (rate(kinvara_calls_total{module=\"session\"}[5m]))"' \
               '"expr": "sum by (route) (rate(http_requests_total{module=\"session\"}[5m]))"' \
  && run_case "R4a a metric this pipeline does not produce" FAIL "which this pipeline does not produce"

mut "$DASH_SLO" '"expr": "sum by (actor_role) (rate(kinvara_calls_total[5m]))"' \
                '"expr": "sum by (user_email) (rate(kinvara_calls_total[5m]))"' \
  && run_case "R4b a board grouping by a label that is not a dimension" FAIL "groups by \`user_email\`"

mut "$DASH_SLO" '"expr": "sum by (data_class) (rate(kinvara_calls_total[5m]))"' \
                '"expr": "sum by (data_class) (rate(kinvara_calls_total{route=\"GET /v1/parents/01J0\"}[5m]))"' \
  && run_case "R4c a board naming a route nobody serves" FAIL "is not in that label's closed set"

mut "$DASH_SLO" '"expr": "sum by (data_class) (rate(kinvara_calls_total[5m]))"' \
                '"expr": "sum by (data_class) (rate(kinvara_calls_total{data_class=\"C9\"}[5m]))"' \
  && run_case "R4d a board naming a class SA SEC-3 does not define" FAIL "is not in that label's closed set"

mut "$DASH_TS" '"panels": [' '"panels": [{"id": 99, "title": "no targets", "type": "timeseries", "gridPos": {"x":0,"y":0,"w":1,"h":1}, "targets": []},' \
  && run_case "R4e a panel with no targets queries nothing" FAIL "has no targets"

cp "$DASH_SLO" "$PLANTED"
landed "a fourth dashboard planted" test -f "$PLANTED" \
  && run_case "R4f a FOURTH dashboard — SD QD-5 names exactly three" FAIL "SD §QD-5 names exactly"

echo
echo "=== R5 — the wiring, and the one line that must never be written ==="

mut "$SERVER" "  installObservability(app);" "  // installObservability(app);" \
  && run_case "R5a the contract is emitted by nothing" FAIL "does not call installObservability"

mut "$INSTALL" "        method: request.method," "        method: request.url," \
  && run_case "R5b the adapter reads the raw request URL" FAIL "reads the raw request URL"

mut "$INSTALL" "      const traceparent: unknown = request.headers['traceparent'];" \
               "      const traceparent: unknown = req.url;" \
  && run_case "R5c the same leak spelled req.url" FAIL "reads the raw request URL"

echo
echo "=== R6 — the deliberate duplication of ACCOUNT_ROLES must not drift ==="

mut "$ENDPOINTS" "  'ts_operator'," "  'ts_operator2'," \
  && run_case "R6a packages/contracts adds a role and observability does not" FAIL "ACTOR_ROLES is"

mut "$CONTRACT" "  'anonymous',
  'system',
] as const;" "] as const;" \
  && run_case "R6b observability drops the two non-account principals" FAIL "ACTOR_ROLES is"

echo
echo "=== THE ANTI-VACUITY FLOORS — a check that checked nothing must SAY so ==="

mut "$ENDPOINTS" "export const OPERATIONS: readonly Operation[] = [" \
                 "export const OPERATIONS: readonly Operation[] = ([] as Operation[]).concat([]) as readonly Operation[]; const UNUSED_OPERATIONS: readonly Operation[] = [" \
  && run_case "Z1 ZERO operations — R1 would be vacuously green" FAIL "the floor is 4"

mut "$COLLECTOR" "    allowed_keys:" "    allowed_keys: []
    unused_keys:" \
  && run_case "Z2 an EMPTY allowlist strips everything, which is safe and useless" FAIL "the floor is 21"

mut "$DASH_TS" '"panels": [' '"panels": [], "unused_panels": [' \
  && run_case "Z3 a dashboard with no panels" FAIL "has no panels"

echo
echo "=== controls: each must stay GREEN, or the cases above prove nothing ==="

mut "$ROUTES" "  'GET /healthz': {" "  'GET /healthz2': {" \
  && run_case "C1 a registry entry for a route NOT in OPERATIONS is allowed" PASS

mut "$COLLECTOR" "      - service.name" "      - service.name
      - deployment.environment" \
  && run_case "C2 an EXTRA allowlist key is allowed — the floor is a floor" PASS

mut "$DASH_SLO" '"refresh": "30s"' '"refresh": "1m"' \
  && run_case "C3 a dashboard change that touches no query is allowed" PASS

echo
run_case "99 tree restored" PASS
echo
if [[ $bad -eq 0 && $harness -eq 0 ]]; then
  echo "ALL $ran CASES BEHAVED AS EXPECTED"
else
  echo "!! $bad of $ran CASE(S) MISBEHAVED; $harness HARNESS ERROR(S)"
fi
exit $((bad + harness))
