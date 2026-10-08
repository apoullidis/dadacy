#!/usr/bin/env bash
#
# apps/worker/tools/refusals.sh <ticket> [image] — T-148 refusals (i) and (ii), OUTSIDE compose.
#
#   scripts/svc up <ticket> db worker --verify --build      (on a migrated database)
#   apps/worker/tools/refusals.sh <ticket>                   (image default: kinvara/worker:dev)
#
# WHY OUTSIDE COMPOSE (OD-90 cut G9, bound in T-148's brief): compose's `worker` logs in as the
# bootstrap superuser `app` (docker/compose.yml DATABASE_URL default; the app_rw login is
# T-155's). Refusal (ii) needs a different LOGIN, so each case runs the worker IMAGE with
# `docker run` on the ticket's internal network, with its own DATABASE_URL. Every such container
# is labelled io.kinvara.probe=T-148, named t148-refusal-<case>, and removed here (DOCKER.md §6,
# OD-19: it is invisible to `svc ps`).
#
# EACH CASE judges the SHAPE (PROTOCOL §5.1), not "non-zero":
#   the container EXITED (not still running), with ExitCode 2 (the worker's REFUSED_EXIT, not the
#   1 of a crash), its log carries `WORKER REFUSED (<reason>)` and the case's own fragment, it was
#   never `healthy`, and schema pgboss's catalogue (pgboss-catalogue.sql) is byte-identical
#   before and after.
#   C0  CONTROL — a LOGIN that is a member of app_rw, nothing planted: the worker must NOT refuse;
#       it becomes healthy, and stops with 0 on SIGTERM. Without it, a harness that saw every
#       worker exit 2 for an unrelated reason would read as four refusals.
#   I1  pgboss.version planted to 36 (older): refused, reason schema-version, names [36].
#   I2  pgboss.version planted to 38 (newer): refused, reason schema-version, names [38]. With
#       pg-boss's default `migrate: true` this one would START: contractor.start() migrates only
#       when its version is ABOVE the database's.
#   I1s, I2s  the same two plants under the COMPOSE principal — login `app`, the bootstrap
#       superuser (G9) — which is where pg-boss's default `migrate: true` would meet no privilege
#       wall (T-146 TL-A3). The startup role keeps the session app_rw, so the refusal is the same.
#   II-a0 a LOGIN with no membership at all: refused, reason database — `0001` gives CONNECT to
#       the five roles and not to PUBLIC, so the session is refused before any role is set.
#   II-a a LOGIN in app_admin_rw (CONNECT, and no pgboss grant: T-146 § contract §4 grants that
#       role nothing there): refused, reason database, `permission denied to set role "app_rw"`.
#   II-b a LOGIN in app_rw, with app_rw's USAGE on schema pgboss revoked for the case: refused,
#       reason privilege. The grant is restored and the catalogue (which includes the schema ACL)
#       compared.
#   II-c a LOGIN in app_rw, with CREATE on schema pgboss GRANTED to app_rw for the case: refused,
#       reason privilege, `can CREATE in schema pgboss` (T-146 § contract §3: that privilege is
#       what pg-boss's self-migration and partitioned queues need). Rework 1, QA-F1(a).
#   II-d a LOGIN in app_rw, with DELETE on pgboss.job_common revoked: refused, reason privilege,
#       naming that grant — one TABLE grant of T-146 § contract §2. Rework 1, QA-F1(b).
#   II-e a LOGIN in app_rw, with EXECUTE on pgboss.create_queue(text,jsonb) revoked: refused,
#       reason privilege, naming that grant — one FUNCTION grant. Rework 1, QA-F1(b).
#   Every plant is ASSERTED LANDED (a has_*_privilege / version reading that must be true after
#   it) before the worker runs; a plant that did not land fails the case, never passes it.
#   LIST the worker's REQUIRED_PRIVILEGES, read from the IMAGE (src/preflight.ts), equals the set
#       of privileges app_rw actually holds in schema pgboss (aclexplode over the catalogue, i.e.
#       what 0006 granted) — exactly, both directions. II-b/II-d/II-e hold one plant per object
#       kind; LIST is what ties the worker's list to the grants, read outside the worker's source.
# Verdict: REFUSALS PASS (exit 0) only if every case holds; else REFUSALS FAIL (exit 1).
set -uo pipefail
cd "$(dirname "$0")/../../.."

TICKET="${1:?usage: apps/worker/tools/refusals.sh <ticket> [image]}"
IMAGE="${2:-kinvara/worker:dev}"
PROJECT="kinvara-$(printf '%s' "${TICKET}" | tr '[:upper:]' '[:lower:]')"
NETWORK="${PROJECT}_kinvara-int"
PW='t148_local_only'   # a local throwaway, like 0001's own principals; no vendor credential
CAT_SQL="apps/worker/tools/pgboss-catalogue.sql"

psql_su() { ./scripts/svc exec "${TICKET}" postgres psql -U app -d kinvara -X -At -v ON_ERROR_STOP=1 "$@"; }
catalogue() { psql_su -f - < "${CAT_SQL}"; }

cleanup() {
  docker ps -aq --filter label=io.kinvara.probe=T-148 --filter name=t148-refusal- | xargs -r docker rm -f >/dev/null
  psql_su -c "UPDATE pgboss.version SET version = 37 WHERE version <> 37" >/dev/null
  psql_su -c "GRANT USAGE ON SCHEMA pgboss TO app_rw" >/dev/null
  psql_su -c "REVOKE CREATE ON SCHEMA pgboss FROM app_rw" >/dev/null
  psql_su -c "GRANT DELETE ON pgboss.job_common TO app_rw" >/dev/null
  psql_su -c "GRANT EXECUTE ON FUNCTION pgboss.create_queue(text, jsonb) TO app_rw" >/dev/null
  psql_su -c "DROP ROLE IF EXISTS t148_nomember" -c "DROP ROLE IF EXISTS t148_rwmember" -c "DROP ROLE IF EXISTS t148_adminmember" >/dev/null
}
trap cleanup EXIT

docker network inspect "${NETWORK}" >/dev/null 2>&1 || { echo "no network ${NETWORK}" >&2; exit 1; }
docker image inspect "${IMAGE}" >/dev/null 2>&1 || { echo "no image ${IMAGE}" >&2; exit 1; }
echo "== image ${IMAGE} ($(docker image inspect "${IMAGE}" --format '{{.Id}}' | cut -c1-19)), network ${NETWORK} =="

psql_su -c "DROP ROLE IF EXISTS t148_nomember" -c "DROP ROLE IF EXISTS t148_rwmember" -c "DROP ROLE IF EXISTS t148_adminmember" \
  -c "CREATE ROLE t148_nomember LOGIN PASSWORD '${PW}'" \
  -c "CREATE ROLE t148_adminmember LOGIN PASSWORD '${PW}' IN ROLE app_admin_rw" \
  -c "CREATE ROLE t148_rwmember LOGIN PASSWORD '${PW}' IN ROLE app_rw" >/dev/null || exit 1
psql_su -c "SELECT r.rolname, r.rolsuper, coalesce((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '-') FROM pg_roles r WHERE r.rolname IN ('t148_nomember','t148_rwmember','t148_adminmember') ORDER BY 1"

# `app` is the compose worker's own login (docker/compose.yml's DATABASE_URL default, a local
# throwaway); every other login is this script's.
url() {
  if [[ "$1" == app ]]; then printf 'postgres://app:app_local_dev_only@postgres:5432/kinvara'
  else printf 'postgres://%s:%s@postgres:5432/kinvara' "$1" "${PW}"; fi
}

# run_worker <case> <login> <seconds>: start the image, wait for exit (or <seconds>), report.
run_worker() {
  local name="t148-refusal-$1" login="$2" wait_s="$3"
  docker rm -f "${name}" >/dev/null 2>&1
  docker run -d --name "${name}" --label io.kinvara.probe=T-148 --network "${NETWORK}" \
    --stop-timeout 30 -e "DATABASE_URL=$(url "${login}")" "${IMAGE}" >/dev/null || return 1
  local healthy=no s status
  for ((s = 0; s < wait_s * 10; s++)); do
    status="$(docker inspect "${name}" --format '{{.State.Status}}')"
    [[ "$(docker inspect "${name}" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}')" == healthy ]] && healthy=yes
    [[ "${status}" == exited ]] && break
    sleep 0.1
  done
  RUN_STATUS="$(docker inspect "${name}" --format '{{.State.Status}}')"
  RUN_CODE="$(docker inspect "${name}" --format '{{.State.ExitCode}}')"
  RUN_HEALTHY="${healthy}"
  RUN_LOG="$(docker logs "${name}" 2>&1)"
}

fails=0
verdict() { # verdict <case> <ok 0|1> <detail>
  if [[ "$2" == 0 ]]; then printf '%-5s PASS  %s\n' "$1" "$3"; else printf '%-5s FAIL  %s\n' "$1" "$3"; fails=$((fails + 1)); fi
}

# refusal_case <case> <login> <reason> <fragment> <plant-sql> <restore-sql> [<landed-sql>]
#   <landed-sql> is a boolean SELECT expression that must read `t` after the plant, or the case
#   FAILS without running the worker (PROTOCOL §5.1: assert the mutation landed).
refusal_case() {
  local case="$1" login="$2" reason="$3" fragment="$4" plant="$5" restore="$6" landed="${7:-}"
  echo; echo "== ${case}: login ${login}; plant: ${plant:-none}"
  [[ -n "${plant}" ]] && { psql_su -c "${plant}" >/dev/null || { verdict "${case}" 1 "the plant did not apply"; return; }; }
  if [[ -n "${landed}" ]]; then
    local got; got="$(psql_su -c "SELECT (${landed})::text")"
    echo "   planted, landed? ${landed} -> ${got}"
    [[ "${got}" == true ]] || { [[ -n "${restore}" ]] && psql_su -c "${restore}" >/dev/null; verdict "${case}" 1 "the plant did not land"; return; }
  fi
  [[ -n "${plant}" ]] && echo "   state: $(psql_su -c "SELECT 'pgboss.version=' || (SELECT string_agg(version::text, ',') FROM pgboss.version) || ' usage=' || has_schema_privilege('app_rw', 'pgboss', 'USAGE') || ' create=' || has_schema_privilege('app_rw', 'pgboss', 'CREATE') || ' delete_job_common=' || has_table_privilege('app_rw', 'pgboss.job_common', 'DELETE') || ' execute_create_queue=' || has_function_privilege('app_rw', 'pgboss.create_queue(text, jsonb)', 'EXECUTE')")"
  local before after
  before="$(catalogue)"
  run_worker "${case}" "${login}" 40
  after="$(catalogue)"
  [[ -n "${restore}" ]] && psql_su -c "${restore}" >/dev/null
  printf '%s\n' "${RUN_LOG}" | sed 's/^/   | /'
  local b a
  b="$(printf '%s\n' "${before}" | sha256sum | cut -c1-16)"; a="$(printf '%s\n' "${after}" | sha256sum | cut -c1-16)"
  echo "   catalogue before ${b} ($(printf '%s\n' "${before}" | wc -l) lines)  after ${a} ($(printf '%s\n' "${after}" | wc -l) lines)"
  [[ "${before}" != "${after}" ]] && diff <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") | head -40 | sed 's/^/   diff| /'
  local ok=1
  [[ "${RUN_STATUS}" == exited && "${RUN_CODE}" == 2 && "${RUN_HEALTHY}" == no ]] \
    && grep -qF "WORKER REFUSED (${reason})" <<<"${RUN_LOG}" \
    && grep -qF -- "${fragment}" <<<"${RUN_LOG}" \
    && [[ "${before}" == "${after}" && -n "${before}" ]] && ok=0
  verdict "${case}" "${ok}" "status=${RUN_STATUS} exit=${RUN_CODE} ever_healthy=${RUN_HEALTHY} reason=${reason} catalogue_unchanged=$([[ "${before}" == "${after}" ]] && echo yes || echo NO)"
}

START_CATALOGUE="$(catalogue)"

# --- C0: the control ---------------------------------------------------------
echo; echo "== C0 (control): login t148_rwmember, nothing planted"
before="$(catalogue)"
run_worker C0 t148_rwmember 25
c0_running="${RUN_STATUS}"; c0_healthy="${RUN_HEALTHY}"
docker stop t148-refusal-C0 >/dev/null 2>&1
c0_code="$(docker inspect t148-refusal-C0 --format '{{.State.ExitCode}}')"
c0_log="$(docker logs t148-refusal-C0 2>&1)"
after="$(catalogue)"
printf '%s\n' "${c0_log}" | grep -v 'selftest job' | sed 's/^/   | /'
ok=1
[[ "${c0_running}" == running && "${c0_healthy}" == yes && "${c0_code}" == 0 && "${before}" == "${after}" ]] \
  && grep -qF 'login t148_rwmember (superuser=false), running as app_rw' <<<"${c0_log}" && ok=0
verdict C0 "${ok}" "running_after_25s=${c0_running} healthy=${c0_healthy} exit_after_SIGTERM=${c0_code} catalogue_unchanged=$([[ "${before}" == "${after}" ]] && echo yes || echo NO)"

V36="(SELECT array_agg(version) FROM pgboss.version) = ARRAY[36]"
V38="(SELECT array_agg(version) FROM pgboss.version) = ARRAY[38]"
refusal_case I1 t148_rwmember schema-version 'pgboss.version holds [36]' \
  "UPDATE pgboss.version SET version = 36" "UPDATE pgboss.version SET version = 37" "${V36}"
refusal_case I2 t148_rwmember schema-version 'pgboss.version holds [38]' \
  "UPDATE pgboss.version SET version = 38" "UPDATE pgboss.version SET version = 37" "${V38}"
refusal_case I1s app schema-version 'pgboss.version holds [36]' \
  "UPDATE pgboss.version SET version = 36" "UPDATE pgboss.version SET version = 37" "${V36}"
refusal_case I2s app schema-version 'pgboss.version holds [38]' \
  "UPDATE pgboss.version SET version = 38" "UPDATE pgboss.version SET version = 37" "${V38}"
refusal_case II-a0 t148_nomember database 'permission denied for database "kinvara"' "" ""
refusal_case II-a t148_adminmember database 'permission denied to set role "app_rw"' "" ""
refusal_case II-b t148_rwmember privilege 'USAGE on schema pgboss' \
  "REVOKE USAGE ON SCHEMA pgboss FROM app_rw" "GRANT USAGE ON SCHEMA pgboss TO app_rw" \
  "NOT has_schema_privilege('app_rw', 'pgboss', 'USAGE')"
refusal_case II-c t148_rwmember privilege 'can CREATE in schema pgboss' \
  "GRANT CREATE ON SCHEMA pgboss TO app_rw" "REVOKE CREATE ON SCHEMA pgboss FROM app_rw" \
  "has_schema_privilege('app_rw', 'pgboss', 'CREATE')"
refusal_case II-d t148_rwmember privilege 'lacks 1 privilege(s) the worker needs (T-146 § contract §2): DELETE on table pgboss.job_common' \
  "REVOKE DELETE ON pgboss.job_common FROM app_rw" "GRANT DELETE ON pgboss.job_common TO app_rw" \
  "NOT has_table_privilege('app_rw', 'pgboss.job_common', 'DELETE') AND has_schema_privilege('app_rw', 'pgboss', 'USAGE')"
refusal_case II-e t148_rwmember privilege 'lacks 1 privilege(s) the worker needs (T-146 § contract §2): EXECUTE on function pgboss.create_queue(text, jsonb)' \
  "REVOKE EXECUTE ON FUNCTION pgboss.create_queue(text, jsonb) FROM app_rw" "GRANT EXECUTE ON FUNCTION pgboss.create_queue(text, jsonb) TO app_rw" \
  "NOT has_function_privilege('app_rw', 'pgboss.create_queue(text, jsonb)', 'EXECUTE') AND has_schema_privilege('app_rw', 'pgboss', 'USAGE')"

# --- LIST: the worker's list of needs == the grants app_rw holds in pgboss ----
# Read from the image, not from this tree, and from the catalogue, not from the worker: two
# sources, so a list that drifted from the grants (or grants that drifted from the list) shows.
echo; echo "== LIST: REQUIRED_PRIVILEGES (image) vs app_rw's privileges in schema pgboss (catalogue)"
need_list="$(docker run --rm --network none --label io.kinvara.probe=T-148 --entrypoint node "${IMAGE}" -e \
  "import('/srv/kinvara/apps/worker/src/preflight.ts').then((m) => { for (const n of m.REQUIRED_PRIVILEGES) console.log([n.kind, n.object.replaceAll(' ', ''), n.privilege].join('|')); }, (e) => { console.error('IMPORT FAILED ' + e.message); process.exit(1); })" | sort)"
held_list="$(psql_su -c "SELECT c.kind || '|' || replace(c.obj, ' ', '') || '|' || a.privilege_type FROM (
    SELECT 'schema' AS kind, n.nspname::text AS obj, n.nspacl AS acl FROM pg_namespace n WHERE n.nspname = 'pgboss'
    UNION ALL SELECT 'table', 'pgboss.' || r.relname, r.relacl FROM pg_class r WHERE r.relnamespace = 'pgboss'::regnamespace
    UNION ALL SELECT 'function', p.oid::regprocedure::text, p.proacl FROM pg_proc p WHERE p.pronamespace = 'pgboss'::regnamespace
  ) c, aclexplode(c.acl) a WHERE a.grantee = 'app_rw'::regrole" | sort)"
echo "   worker needs $(printf '%s\n' "${need_list}" | grep -c .) privilege(s); app_rw holds $(printf '%s\n' "${held_list}" | grep -c .)"
diff <(printf '%s\n' "${need_list}") <(printf '%s\n' "${held_list}") | sed 's/^/   diff| /'
ok=1; [[ -n "${need_list}" && "${need_list}" == "${held_list}" ]] && ok=0
verdict LIST "${ok}" "needs=$(printf '%s\n' "${need_list}" | grep -c .) held=$(printf '%s\n' "${held_list}" | grep -c .) identical=$([[ "${need_list}" == "${held_list}" ]] && echo yes || echo NO)"

end_catalogue="$(catalogue)"
ok=1; [[ -n "${START_CATALOGUE}" && "${START_CATALOGUE}" == "${end_catalogue}" ]] && ok=0
verdict END "${ok}" "schema pgboss after every restore equals the catalogue before the first case ($(printf '%s\n' "${end_catalogue}" | sha256sum | cut -c1-16))"
echo; echo "== after: $(psql_su -c "SELECT 'pgboss.version=' || (SELECT string_agg(version::text, ',') FROM pgboss.version) || ' app_rw_usage_on_pgboss=' || has_schema_privilege('app_rw', 'pgboss', 'USAGE')")"
echo
if [[ "${fails}" -eq 0 ]]; then echo "REFUSALS PASS  ${IMAGE}"; exit 0; fi
echo "REFUSALS FAIL  ${IMAGE} — ${fails} case(s)"; exit 1
