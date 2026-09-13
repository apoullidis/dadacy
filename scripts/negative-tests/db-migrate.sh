#!/usr/bin/env bash
# T-136 — negative tests for db:migrate (scripts/db-migrate.ts).
#
#   cd /home/alex/projects/nanny/app
#   ./scripts/svc up  <ticket> db            # a FRESH project: the suite refuses anything else
#   ./scripts/svc run <ticket> -- bash scripts/negative-tests/db-migrate.sh
#
# Every plant is made in a scratch copy of db/migrations under the container's /tmp, never in
# db/migrations itself, and the suite ASSERTS EACH PLANT LANDED before judging the runner.
# Each case is judged by readings that a runner which did nothing could not all produce:
#   1. the exit status;
#   2. exactly ONE outcome banner (MIGRATE OK|FAIL|REFUSED|ERROR|CRASH), and it is the expected one;
#   3. a message substring naming the planted file or number;
#   4. the CATALOGUE: a snapshot of roles, extensions, schemas, relations (with owners and ACLs),
#      functions (with body hashes), event triggers, the database ACL and the record — compared
#      with the snapshot before the case. The snapshot is shown to CHANGE when a migration applies
#      (anti-vacuity), so "unchanged" means something.
# A failure to take a snapshot, or a plant that did not land, ABORTS the suite (exit 2): it is
# never counted as a case behaving. Cases named *-BOUND-* measure a limit of the runner; they
# pass when the limit behaves as the contract states it, not when something is refused.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

REAL=db/migrations
WORK=$(mktemp -d)
OUT=$WORK/out.txt
CASE_ENV=""
total=0
bad=0

abort() {
  echo "ABORT: $*"
  exit 2
}

q() { psql -X -A -t -q -v ON_ERROR_STOP=1 -c "$1"; }

SNAP_SQL="SELECT k || ' ' || v FROM (
  SELECT 'role' AS k, rolname || ' super=' || rolsuper AS v FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%'
  UNION ALL SELECT 'ext', extname || ' ' || extversion FROM pg_extension
  UNION ALL SELECT 'nsp', nspname || ' owner=' || pg_get_userbyid(nspowner) || ' acl=' || coalesce(nspacl::text, '')
    FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
  UNION ALL SELECT 'rel', n.nspname || '.' || c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner)
      || ' acl=' || coalesce(c.relacl::text, '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  UNION ALL SELECT 'fn', p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner)
      || ' src=' || md5(coalesce(p.prosrc, '')) || ' acl=' || coalesce(p.proacl::text, '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL SELECT 'evt', evtname || ' ' || evtenabled::text FROM pg_event_trigger
  UNION ALL SELECT 'db', 'acl=' || coalesce(datacl::text, '') || ' comment=' || coalesce(shobj_description(oid, 'pg_database'), '<none>')
    FROM pg_database WHERE datname = current_database()
) s ORDER BY 1"

# snap <name>: writes $WORK/<name>.snap and sets SNAP_<name> to its md5.
snap() {
  local out rc
  out=$(q "$SNAP_SQL")
  rc=$?
  [ "$rc" -eq 0 ] && [ -n "$out" ] || abort "catalogue snapshot failed (psql exit $rc)"
  printf '%s\n' "$out" >"$WORK/$1.snap"
  printf -v "SNAP_$1" '%s' "$(md5sum <"$WORK/$1.snap" | cut -c1-32)"
}

record() { q "SELECT coalesce(shobj_description(oid, 'pg_database'), '<none>') FROM pg_database WHERE datname = current_database()"; }
RECORD_SQL="SELECT coalesce(shobj_description(oid, 'pg_database'), '<none>') FROM pg_database WHERE datname = current_database()"

# plant <dir>: a scratch copy of the real migrations directory.
plant() {
  rm -rf "${WORK:?}/$1"
  mkdir -p "$WORK/$1" && cp "$REAL"/*.sql "$WORK/$1/" || abort "cannot build plant $1"
  [ "$(find "$WORK/$1" -name '*.sql' | wc -l)" -eq "$(find "$REAL" -name '*.sql' | wc -l)" ] || abort "plant $1 copy incomplete"
}

# landed <file> <fixed string>: the plant is on disk with the content the case depends on.
landed() {
  [ -f "$1" ] && grep -qF -- "$2" "$1" || abort "plant did not land: $1 lacks '$2'"
}
absent() {
  [ ! -e "$1" ] || abort "plant did not land: $1 still exists"
}

# expect <case> <exit> <banner> <needle> -- <db:migrate args...>   ($CASE_ENV: extra VAR=value words)
expect() {
  local name=$1 want=$2 banner=$3 needle=$4
  shift 5
  total=$((total + 1))
  # shellcheck disable=SC2086
  env $CASE_ENV pnpm run --silent db:migrate "$@" >"$OUT" 2>&1
  local got=$?
  local why=""
  [ "$got" -eq "$want" ] || why="$why exit $got (wanted $want);"
  local banners
  banners=$(grep -cE '^MIGRATE (OK|FAIL|REFUSED|ERROR|CRASH)  ' "$OUT")
  [ "$banners" -eq 1 ] || why="$why $banners outcome banners (wanted 1);"
  grep -qE "^$banner  " "$OUT" || why="$why banner '$banner' absent;"
  grep -qF -- "$needle" "$OUT" || why="$why message '$needle' absent;"
  if [ -z "$why" ]; then
    printf 'ok   %-30s exit %s, %s, "%s"\n' "$name" "$got" "$banner" "$needle"
  else
    bad=$((bad + 1))
    printf 'BAD  %-30s%s\n' "$name" "$why"
    sed 's/^/     | /' "$OUT"
  fi
}

# check <case> <description> <command...>: a catalogue assertion, counted like a case.
check() {
  local name=$1 what=$2
  shift 2
  total=$((total + 1))
  if "$@"; then
    printf 'ok   %-30s %s\n' "$name" "$what"
  else
    bad=$((bad + 1))
    printf 'BAD  %-30s %s\n' "$name" "$what"
  fi
}
same() { [ "$1" = "$2" ]; }
differ() { [ "$1" != "$2" ]; }
is() { [ "$(q "$1")" = "$2" ]; }

# ---------------------------------------------------------------------------------------------
echo "== preconditions"
[ "$(q "SELECT count(*) FROM pg_roles WHERE rolname = 'app_ddl'")" = "0" ] || abort "app_ddl exists: this suite needs a fresh db project"
[ "$(record)" = "<none>" ] || abort "the database already carries a comment: this suite needs a fresh db project"
[ -z "$(git status --porcelain -- "$REAL")" ] || abort "db/migrations is not clean"
snap S0
echo "   fresh database; snapshot S0 = $SNAP_S0 ($(wc -l <"$WORK/S0.snap") lines)"

# ---------------------------------------------------------------------------------------------
echo "== A. directory and argument refusals, on the fresh database: nothing may run"

plant gap
mv "$WORK/gap/0002_int10_guard_stat_statements_execute.up.sql" "$WORK/gap/0003_int10_guard_stat_statements_execute.up.sql"
mv "$WORK/gap/0002_int10_guard_stat_statements_execute.down.sql" "$WORK/gap/0003_int10_guard_stat_statements_execute.down.sql"
absent "$WORK/gap/0002_int10_guard_stat_statements_execute.up.sql"
landed "$WORK/gap/0003_int10_guard_stat_statements_execute.up.sql" "k_stat_extensions"
expect A1-numbering-gap 2 'MIGRATE REFUSED' 'numbering gap: no migration numbered 0002' -- up --dir "$WORK/gap"
snap A1 && check A1-catalogue "catalogue unchanged (S0)" same "$SNAP_A1" "$SNAP_S0"

plant nodown
printf -- '-- @phase: expand\nCREATE TABLE public.t136_nodown (i int);\nGRANT SELECT ON public.t136_nodown TO app_rw;\n' >"$WORK/nodown/0003_t136_nodown.up.sql"
landed "$WORK/nodown/0003_t136_nodown.up.sql" "CREATE TABLE public.t136_nodown"
absent "$WORK/nodown/0003_t136_nodown.down.sql"
expect A2-missing-down-file 2 'MIGRATE REFUSED' 'missing down file 0003_t136_nodown.down.sql' -- up --dir "$WORK/nodown"
snap A2 && check A2-catalogue "catalogue unchanged (S0): refused before 0001 ran" same "$SNAP_A2" "$SNAP_S0"

plant orphan
printf 'DROP TABLE public.t136_orphan;\n' >"$WORK/orphan/0003_t136_orphan.down.sql"
landed "$WORK/orphan/0003_t136_orphan.down.sql" "t136_orphan"
absent "$WORK/orphan/0003_t136_orphan.up.sql"
expect A3-down-without-up 2 'MIGRATE REFUSED' '0003_t136_orphan.down.sql has no up file' -- up --dir "$WORK/orphan"

plant unrecognised
printf 'SELECT 1;\n' >"$WORK/unrecognised/0003_t136_bad.sql"
landed "$WORK/unrecognised/0003_t136_bad.sql" "SELECT 1"
expect A4-unrecognised-entry 2 'MIGRATE REFUSED' 'unrecognised entry 0003_t136_bad.sql' -- up --dir "$WORK/unrecognised"

plant twonames
printf -- '-- @phase: expand\nSELECT 1;\n' >"$WORK/twonames/0002_t136_other.up.sql"
printf 'SELECT 1;\n' >"$WORK/twonames/0002_t136_other.down.sql"
landed "$WORK/twonames/0002_t136_other.up.sql" "SELECT 1"
expect A5-two-names-one-number 2 'MIGRATE REFUSED' 'number 0002 has 2 names' -- up --dir "$WORK/twonames"

plant runas
printf -- '-- @phase: expand\n-- @run-as: bootstrap-superuser\nSELECT 1;\n' >"$WORK/runas/0003_t136_runas.up.sql"
printf 'SELECT 1;\n' >"$WORK/runas/0003_t136_runas.down.sql"
landed "$WORK/runas/0003_t136_runas.up.sql" "-- @run-as: bootstrap-superuser"
expect A6-run-as-no-reference 2 'MIGRATE REFUSED' '`-- @run-as: bootstrap-superuser` is refused' -- up --dir "$WORK/runas"

plant runasdown
printf -- '-- @phase: expand\nSELECT 1;\n' >"$WORK/runasdown/0003_t136_runasdown.up.sql"
printf -- '-- @run-as: bootstrap-superuser — T-136 marker in a down file\nSELECT 1;\n' >"$WORK/runasdown/0003_t136_runasdown.down.sql"
landed "$WORK/runasdown/0003_t136_runasdown.down.sql" "-- @run-as: bootstrap-superuser — T-136"
expect A6b-run-as-in-down-file 2 'MIGRATE REFUSED' '0003_t136_runasdown.down.sql carries @run-as' -- up --dir "$WORK/runasdown"

mkdir -p "$WORK/empty"
expect A7-empty-directory 2 'MIGRATE REFUSED' 'no migrations found' -- up --dir "$WORK/empty"
expect A8-down-without-target 2 'MIGRATE REFUSED' 'down needs an explicit --to' -- down
expect A9-unknown-argument 2 'MIGRATE REFUSED' 'unknown argument "--force"' -- up --force

CASE_ENV="PGHOST=t136-no-such-host"
expect A10-database-unreachable 3 'MIGRATE ERROR' 'cannot read the database state: psql exited 2' -- up
CASE_ENV=""
snap A10 && check A-catalogue-after-all "catalogue still unchanged (S0) after A1-A10" same "$SNAP_A10" "$SNAP_S0"

# ---------------------------------------------------------------------------------------------
echo "== B. the real directory, and the record"
expect B1-up-real 0 'MIGRATE OK' 'up: 0000 -> 0002 (2 step(s))' -- up
snap S2
check B1-snapshot-sensitive "the snapshot CHANGES when migrations apply (anti-vacuity)" differ "$SNAP_S2" "$SNAP_S0"
check B1-record "record reads 0002" is "$RECORD_SQL" "kinvara-migrate version=0002"

q "COMMENT ON DATABASE kinvara IS 'kinvara-migrate version=0009'" >/dev/null || abort "cannot plant record 0009"
[ "$(record)" = "kinvara-migrate version=0009" ] || abort "plant did not land: record 0009"
expect B2-record-ahead-of-files 2 'MIGRATE REFUSED' 'records version 0009' -- up
q "COMMENT ON DATABASE kinvara IS 'hello, a human comment'" >/dev/null || abort "cannot plant foreign comment"
[ "$(record)" = "hello, a human comment" ] || abort "plant did not land: foreign comment"
expect B3-foreign-db-comment 2 'MIGRATE REFUSED' 'not a db:migrate record' -- up
check B3-comment-not-overwritten "the foreign comment is still there" is "$RECORD_SQL" "hello, a human comment"
q "COMMENT ON DATABASE kinvara IS 'kinvara-migrate version=0002'" >/dev/null || abort "cannot restore record"
snap B3 && check B-catalogue-restored "catalogue back to S2" same "$SNAP_B3" "$SNAP_S2"

# ---------------------------------------------------------------------------------------------
echo "== C. a migration that fails, on the database at 0002"

plant fail
printf -- '-- @phase: expand\nCREATE TABLE public.t136_fail (i int);\nGRANT SELECT ON public.t136_fail TO app_rw;\nSELECT 1/0;\n' >"$WORK/fail/0003_t136_fail.up.sql"
printf 'DROP TABLE public.t136_fail;\n' >"$WORK/fail/0003_t136_fail.down.sql"
landed "$WORK/fail/0003_t136_fail.up.sql" "SELECT 1/0;"
landed "$WORK/fail/0003_t136_fail.up.sql" "CREATE TABLE public.t136_fail"
expect C1-failing-migration 1 'MIGRATE FAIL' '0003_t136_fail.up.sql: psql exited' -- up --dir "$WORK/fail"
check C1-error-is-the-plant "the error is the planted division by zero" grep -qF 'division by zero' "$OUT"
check C1-rolled-back-message "the runner reports a rollback" grep -qF 'the transaction was rolled back' "$OUT"
snap C1 && check C1-catalogue "catalogue unchanged (S2)" same "$SNAP_C1" "$SNAP_S2"
check C1-table-absent "t136_fail absent" is "SELECT to_regclass('public.t136_fail') IS NULL" "t"

plant pass
printf -- '-- @phase: expand\nCREATE TABLE public.t136_fail (i int);\nGRANT SELECT ON public.t136_fail TO app_rw;\n' >"$WORK/pass/0003_t136_fail.up.sql"
printf 'DROP TABLE public.t136_fail;\n' >"$WORK/pass/0003_t136_fail.down.sql"
landed "$WORK/pass/0003_t136_fail.up.sql" "CREATE TABLE public.t136_fail"
grep -qF '1/0' "$WORK/pass/0003_t136_fail.up.sql" && abort "control plant still contains the failure"
expect C1c-control-applies 0 'MIGRATE OK' 'up: 0002 -> 0003 (1 step(s))' -- up --dir "$WORK/pass"
check C1c-table-owner "t136_fail exists, owned by app_ddl (SET ROLE app_ddl)" is "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.t136_fail')" "app_ddl"
snap C1c && check C1c-catalogue-changed "catalogue changed" differ "$SNAP_C1c" "$SNAP_S2"
expect C1c-down 0 'MIGRATE OK' 'down: 0003 -> 0002 (1 step(s))' -- down --to 0002 --dir "$WORK/pass"
snap C1d && check C1c-down-catalogue "down restores S2 exactly" same "$SNAP_C1d" "$SNAP_S2"

plant role
printf -- '-- @phase: expand\nCREATE ROLE t136_probe NOLOGIN;\n' >"$WORK/role/0003_t136_role.up.sql"
printf 'DROP ROLE t136_probe;\n' >"$WORK/role/0003_t136_role.down.sql"
landed "$WORK/role/0003_t136_role.up.sql" "CREATE ROLE t136_probe"
expect C2-principal-is-app_ddl 1 'MIGRATE FAIL' '0003_t136_role.up.sql: psql exited' -- up --dir "$WORK/role"
check C2-error-is-privilege "refused for privilege (app_ddl is NOCREATEROLE)" grep -qF 'permission denied to create role' "$OUT"
snap C2 && check C2-catalogue "catalogue unchanged (S2)" same "$SNAP_C2" "$SNAP_S2"

plant rolesu
printf -- '-- @phase: expand\n-- @run-as: bootstrap-superuser — T-136 principal control\nCREATE ROLE t136_probe NOLOGIN;\n' >"$WORK/rolesu/0003_t136_role.up.sql"
printf 'DROP ROLE t136_probe;\n' >"$WORK/rolesu/0003_t136_role.down.sql"
landed "$WORK/rolesu/0003_t136_role.up.sql" "-- @run-as: bootstrap-superuser — T-136"
expect C2c-run-as-control 0 'MIGRATE OK' 'as bootstrap superuser (bootstrap-superuser — T-136 principal control)' -- up --dir "$WORK/rolesu"
check C2c-role-exists "t136_probe exists" is "SELECT count(*) FROM pg_roles WHERE rolname = 't136_probe'" "1"
expect C2c-down 0 'MIGRATE OK' 'down: 0003 -> 0002' -- down --to 0002 --dir "$WORK/rolesu"
snap C2d && check C2c-down-catalogue "down restores S2 exactly" same "$SNAP_C2d" "$SNAP_S2"

plant downrole
printf -- '-- @phase: expand\nCREATE TABLE public.t136_downrole (i int);\nGRANT SELECT ON public.t136_downrole TO app_rw;\n' >"$WORK/downrole/0003_t136_downrole.up.sql"
printf 'CREATE ROLE t136_down_probe NOLOGIN;\nDROP TABLE public.t136_downrole;\n' >"$WORK/downrole/0003_t136_downrole.down.sql"
landed "$WORK/downrole/0003_t136_downrole.down.sql" "CREATE ROLE t136_down_probe"
expect C2e-up 0 'MIGRATE OK' 'up: 0002 -> 0003 (1 step(s))' -- up --dir "$WORK/downrole"
snap C2e
expect C2e-down-runs-as-app_ddl 1 'MIGRATE FAIL' '0003_t136_downrole.down.sql: psql exited' -- down --to 0002 --dir "$WORK/downrole"
check C2e-error-is-privilege "the down file was refused for privilege: it ran as app_ddl" grep -qF 'permission denied to create role' "$OUT"
snap C2f && check C2e-catalogue "catalogue unchanged by the failed down (still 0003)" same "$SNAP_C2f" "$SNAP_C2e"
printf 'DROP TABLE public.t136_downrole;\n' >"$WORK/downrole/0003_t136_downrole.down.sql"
grep -qF 'CREATE ROLE' "$WORK/downrole/0003_t136_downrole.down.sql" && abort "downrole repair did not land"
expect C2e-down-repaired 0 'MIGRATE OK' 'down: 0003 -> 0002 (1 step(s))' -- down --to 0002 --dir "$WORK/downrole"
snap C2g && check C2e-down-catalogue "down restores S2 exactly" same "$SNAP_C2g" "$SNAP_S2"

plant txn
printf -- '-- @phase: expand\nCREATE TABLE public.t136_txn (i int);\nGRANT SELECT ON public.t136_txn TO app_rw;\nCOMMIT;\n' >"$WORK/txn/0003_t136_txn.up.sql"
printf 'DROP TABLE public.t136_txn;\n' >"$WORK/txn/0003_t136_txn.down.sql"
landed "$WORK/txn/0003_t136_txn.up.sql" "COMMIT;"
expect C3-file-ends-transaction 1 'MIGRATE FAIL' "ended the runner transaction" -- up --dir "$WORK/txn"
check C3-says-committed "the runner says the statements before the break are COMMITTED" grep -qF 'are COMMITTED' "$OUT"
check C3-record-not-advanced "record still 0002" is "$RECORD_SQL" "kinvara-migrate version=0002"
check C3-BOUND-partial-state "t136_txn EXISTS: the break committed it (the bound, measured)" is "SELECT to_regclass('public.t136_txn') IS NOT NULL" "t"
q "DROP TABLE public.t136_txn" >/dev/null || abort "cannot clean up t136_txn"
snap C3 && check C3-cleaned "after manual cleanup, catalogue back to S2" same "$SNAP_C3" "$SNAP_S2"

plant ntxmissing
printf -- '-- @phase: expand\nCREATE TABLE public.t136_nt (i int);\nGRANT SELECT ON public.t136_nt TO app_rw;\n' >"$WORK/ntxmissing/0003_t136_nt.up.sql"
printf 'DROP TABLE public.t136_nt;\n' >"$WORK/ntxmissing/0003_t136_nt.down.sql"
printf -- '-- @phase: expand\nCREATE INDEX CONCURRENTLY t136_nt_i ON public.t136_nt (i);\n' >"$WORK/ntxmissing/0004_t136_nt_index.up.sql"
printf 'DROP INDEX CONCURRENTLY public.t136_nt_i;\n' >"$WORK/ntxmissing/0004_t136_nt_index.down.sql"
landed "$WORK/ntxmissing/0004_t136_nt_index.up.sql" "CREATE INDEX CONCURRENTLY"
grep -qF '@no-transaction' "$WORK/ntxmissing/0004_t136_nt_index.up.sql" && abort "ntxmissing plant carries the marker"
expect C4-concurrently-in-txn 1 'MIGRATE FAIL' '0004_t136_nt_index.up.sql: psql exited' -- up --dir "$WORK/ntxmissing"
check C4-error-is-txn-block "refused because the runner's transaction is real" grep -qF 'cannot run inside a transaction block' "$OUT"
check C4-stopped-after-0003 "record 0003: 0003 applied, 0004 not" is "$RECORD_SQL" "kinvara-migrate version=0003"
check C4-index-absent "t136_nt_i absent" is "SELECT to_regclass('public.t136_nt_i') IS NULL" "t"
expect C4-down 0 'MIGRATE OK' 'down: 0003 -> 0002' -- down --to 0002 --dir "$WORK/ntxmissing"
snap C4 && check C4-down-catalogue "down restores S2 exactly" same "$SNAP_C4" "$SNAP_S2"

plant ntx
cp "$WORK/ntxmissing/0003_t136_nt.up.sql" "$WORK/ntxmissing/0003_t136_nt.down.sql" "$WORK/ntx/"
printf -- '-- @phase: expand\n-- @no-transaction\nCREATE INDEX CONCURRENTLY t136_nt_i ON public.t136_nt (i);\n' >"$WORK/ntx/0004_t136_nt_index.up.sql"
printf -- '-- @no-transaction\nDROP INDEX CONCURRENTLY public.t136_nt_i;\n' >"$WORK/ntx/0004_t136_nt_index.down.sql"
landed "$WORK/ntx/0004_t136_nt_index.up.sql" "-- @no-transaction"
landed "$WORK/ntx/0004_t136_nt_index.down.sql" "-- @no-transaction"
expect C4c-no-transaction-marker 0 'MIGRATE OK' 'up: 0002 -> 0004 (2 step(s))' -- up --dir "$WORK/ntx"
check C4c-index-exists "t136_nt_i exists" is "SELECT to_regclass('public.t136_nt_i') IS NOT NULL" "t"
expect C4c-down 0 'MIGRATE OK' 'down: 0004 -> 0002 (2 step(s))' -- down --to 0002 --dir "$WORK/ntx"
snap C4c && check C4c-down-catalogue "down restores S2 exactly" same "$SNAP_C4c" "$SNAP_S2"

plant resetrole
printf -- '-- @phase: expand\nRESET ROLE;\nCREATE ROLE t136_escape NOLOGIN;\n' >"$WORK/resetrole/0003_t136_resetrole.up.sql"
printf 'RESET ROLE;\nDROP ROLE t136_escape;\n' >"$WORK/resetrole/0003_t136_resetrole.down.sql"
landed "$WORK/resetrole/0003_t136_resetrole.up.sql" "RESET ROLE;"
grep -qF '@run-as' "$WORK/resetrole/0003_t136_resetrole.up.sql" && abort "resetrole plant carries @run-as"
expect C6-BOUND-reset-role-escapes 0 'MIGRATE OK' 'up: 0002 -> 0003 (1 step(s))' -- up --dir "$WORK/resetrole"
check C6-BOUND-role-created "t136_escape EXISTS: a file that RESETs ROLE runs as the session superuser" is "SELECT count(*) FROM pg_roles WHERE rolname = 't136_escape'" "1"
expect C6-down 0 'MIGRATE OK' 'down: 0003 -> 0002' -- down --to 0002 --dir "$WORK/resetrole"
snap C6 && check C6-down-catalogue "down restores S2 exactly" same "$SNAP_C6" "$SNAP_S2"

plant contract
printf -- '-- @phase: contract\nSELECT 1;\n' >"$WORK/contract/0003_t136_contract.up.sql"
landed "$WORK/contract/0003_t136_contract.up.sql" "-- @phase: contract"
absent "$WORK/contract/0003_t136_contract.down.sql"
expect C5-contract-without-down 0 'MIGRATE OK' 'up: 0002 -> 0003' -- up --dir "$WORK/contract"
snap C5
expect C5-revert-through-contract 2 'MIGRATE REFUSED' 'would revert 0003_t136_contract, which has no down file' -- down --to 0002 --dir "$WORK/contract"
snap C5r && check C5-catalogue "catalogue unchanged by the refused down" same "$SNAP_C5r" "$SNAP_C5"
q "COMMENT ON DATABASE kinvara IS 'kinvara-migrate version=0002'" >/dev/null || abort "cannot restore record"
snap C5x && check C5-restored "record reset by hand; catalogue back to S2" same "$SNAP_C5x" "$SNAP_S2"

# ---------------------------------------------------------------------------------------------
echo "== D. the real directory, all the way down"
expect D1-down-real 0 'MIGRATE OK' 'down: 0002 -> 0000 (2 step(s))' -- down --to 0000
check D1-record-gone "no database comment" is "SELECT shobj_description(oid, 'pg_database') IS NULL FROM pg_database WHERE datname = current_database()" "t"
snap D1
if [ "$SNAP_D1" = "$SNAP_S0" ]; then
  echo "   measurement: after down --to 0000 the snapshot EQUALS the fresh S0"
else
  echo "   measurement: after down --to 0000 the snapshot DIFFERS from the fresh S0:"
  diff "$WORK/S0.snap" "$WORK/D1.snap" | sed 's/^/     | /'
fi
check D-real-dir-untouched "db/migrations unchanged by the suite" test -z "$(git status --porcelain -- "$REAL")"

echo
echo "db-migrate negative tests: $total checks, $((total - bad)) ok, $bad BAD"
rm -rf "$WORK"
[ "$bad" -eq 0 ]
