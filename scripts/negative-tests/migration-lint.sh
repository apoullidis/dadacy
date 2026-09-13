#!/usr/bin/env bash
# T-021 — negative tests for gate:migration-lint (scripts/gates/migration-lint.ts).
#
# Each case plants one violation and ASSERTS THE PLANT LANDED. It then runs the gate and
# judges the result by three readings, which a gate that did nothing could not all produce:
#   1. the exit status;
#   2. the GATE PASS / GATE FAIL banner;
#   3. the SET of rule tags on the reported problems, which must EQUAL the expected set.
# Reading 3 means a FAIL case cannot go green because some other rule happened to fire, and
# a PASS case cannot go green while a problem is still reported. Afterwards the tree is
# restored and asserted clean.
#
# The gate runs with --base=HEAD, so the change set is exactly the plant. For the same
# reason the suite refuses a dirty tree.
#
#   cd /home/alex/projects/nanny/app && ./scripts/dev bash scripts/negative-tests/migration-lint.sh
#
# Runs inside the toolbox: needs node, git, grep, sed, sort. Writes only under db/migrations/
# and one file under scripts/, and removes both. Case C99 also creates a detached git
# worktree under the container's /tmp and removes it.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: the tree is not clean. Commit first; uncommitted work would join every case's change set."
  git status --porcelain
  exit 2
fi

M=db/migrations
UP=$M/9001_t021_plant.up.sql
DOWN=$M/9001_t021_plant.down.sql
UP2=$M/9002_t021_plant.up.sql
UP1=$M/0001_extensions_and_roles.up.sql
DOWN1=$M/0001_extensions_and_roles.down.sql
APP=scripts/t021-plant-application-code.txt
OUT=$(mktemp)
total=0
bad=0

restore() {
  rm -f "$M"/9001_t021_plant.* "$M"/9002_t021_plant.* "$M"/0001_t021_plant.* \
    "$M"/0000_t021_plant.* "$M"/t021_badname.sql "$APP"
  git checkout -q -- "$M"
  if [ -n "$(git status --porcelain)" ]; then
    echo "ABORT: the tree did not restore cleanly"
    git status --porcelain
    exit 2
  fi
}

# plant <file> <content>: write, then assert the bytes on disk are the bytes intended.
plant() {
  printf '%s\n' "$2" >"$1"
  if [ "$(cat "$1")" != "$2" ]; then
    echo "ABORT: the plant did not land in $1"
    exit 2
  fi
}

# pair <phase> <sql>: a new migration 9001 with a trivial down file.
pair() {
  plant "$UP" "-- @phase: $1
$2"
  plant "$DOWN" "-- the down file of a planted migration"
}

# mutate <file> <from> <to>: mutate.mjs exits non-zero if the anchor is absent, and the file
# must differ from HEAD afterwards.
mutate() {
  node scripts/negative-tests/mutate.mjs "$1" "$2" "$3" || {
    echo "ABORT: mutation anchor missing in $1"
    exit 2
  }
  if git diff --quiet -- "$1"; then
    echo "ABORT: the mutation did not change $1"
    exit 2
  fi
}

# judge <id> <description> <expect> <exit code>: expect is PASS, or rule tags separated by spaces.
judge() {
  local id=$1 desc=$2 expect=$3 code=$4 got want verdict=BAD
  total=$((total + 1))
  got=$(grep -oE '^  - \[R-[A-Z-]+\]' "$OUT" | sed -E 's/^  - \[(.*)\]$/\1/' | sort -u | tr '\n' ' ' | sed 's/ $//')
  if [ "$expect" = PASS ]; then
    if [ "$code" -eq 0 ] && grep -qx 'GATE PASS  gate:migration-lint' "$OUT" && [ -z "$got" ]; then verdict=ok; fi
  else
    # shellcheck disable=SC2086
    want=$(printf '%s\n' $expect | sort -u | tr '\n' ' ' | sed 's/ $//')
    if [ "$code" -eq 1 ] && grep -q '^GATE FAIL  gate:migration-lint — ' "$OUT" && [ "$got" = "$want" ]; then verdict=ok; fi
  fi
  [ "$verdict" = ok ] || bad=$((bad + 1))
  printf '%-4s %s  %s\n       exit %s; expected %s; reported %s\n' "$verdict" "$id" "$desc" "$code" "$expect" "${got:-none}"
  grep -E '^  - \[' "$OUT" | cut -c1-240 | sed 's/^/       /'
}

# check <id> <description> <expect> [gate args...]: run the gate on the planted tree, judge, restore.
check() {
  local id=$1 desc=$2 expect=$3
  shift 3
  if [ "$#" -eq 0 ]; then set -- --base=HEAD; fi
  node scripts/gates/migration-lint.ts "$@" >"$OUT" 2>&1
  judge "$id" "$desc" "$expect" "$?"
  restore
}

echo "== controls"
check C00 "CONTROL: the committed tree, nothing planted" PASS
pair expand "CREATE TABLE public.t021_thing (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
GRANT SELECT, INSERT ON public.t021_thing TO app_rw;"
check C01 "CONTROL: an expand migration that creates a table and grants on it" PASS

echo "== R-APPEND-ONLY (SA §SEC-8)"
pair expand "GRANT UPDATE ON audit_log TO app_rw;"
check C10 "UPDATE on audit_log" R-APPEND-ONLY
pair expand "GRANT DELETE ON TABLE public.decision_record TO app_admin_rw;"
check C11 "DELETE on TABLE public.decision_record" R-APPEND-ONLY
pair expand 'GRANT SELECT, INSERT, UPDATE, DELETE ON "case_note" TO app_rw;'
check C12 "full DML on a quoted \"case_note\"" R-APPEND-ONLY
pair expand "GRANT ALL PRIVILEGES ON audit_log TO app_rw;"
check C13 "ALL PRIVILEGES on audit_log" R-APPEND-ONLY
pair expand "GRANT UPDATE (reason_code) ON audit_log TO app_rw;"
check C14 "column-level UPDATE on audit_log" R-APPEND-ONLY
pair expand "GRANT UPDATE ON ALL TABLES IN SCHEMA public TO app_rw;"
check C15 "UPDATE on ALL TABLES IN SCHEMA public" R-APPEND-ONLY
pair expand "grant
  update
    on audit_log
  to app_rw;"
check C16 "lower case, one keyword per line" R-APPEND-ONLY
pair expand "DO \$do\$ BEGIN EXECUTE 'GRANT DELETE ON audit_log TO app_rw'; END \$do\$;"
check C17 "inside a DO block, as an EXECUTE string" R-APPEND-ONLY
pair expand "GRANT TRUNCATE ON audit_log_p20260901 TO app_rw;"
check C18 "TRUNCATE on a partition named after audit_log" R-APPEND-ONLY
pair expand "GRANT UPDATE ON audit_log TO app_ddl;"
check C19 "UPDATE to app_ddl (refused for every grantee)" R-APPEND-ONLY
pair expand "SELECT 1;"
plant "$DOWN" "GRANT DELETE ON case_note TO app_rw;"
check C1A "in a DOWN file" R-APPEND-ONLY
pair expand "GRANT INSERT ON audit_log TO app_rw, app_admin_rw;"
check C1B "CONTROL: INSERT on audit_log to app_rw, app_admin_rw" PASS
pair expand "-- GRANT UPDATE ON audit_log TO app_rw;
/* GRANT DELETE ON case_note TO app_rw; */
SELECT 1;"
check C1C "CONTROL: the same grants inside comments" PASS
pair expand "REVOKE UPDATE, DELETE ON audit_log FROM app_rw;"
check C1D "CONTROL: REVOKE UPDATE, DELETE" PASS
pair expand "ALTER TABLE public.audit_log OWNER TO app_rw;"
check C1E "ownership of audit_log transferred (an owner holds every privilege)" R-APPEND-ONLY
pair expand "GRANT app_ddl TO app_rw;"
check C1F "the role app_ddl, which owns every table, granted to app_rw" R-APPEND-ONLY
pair expand "ALTER TABLE public.t021_thing OWNER TO app_ddl;"
check C1G "CONTROL: ownership of a table that is not append-only" PASS
pair expand "GRANT app_rw TO t021_login_principal;"
check C1H "CONTROL: an ordinary role granted to a login principal" PASS

echo "== R-DEFAULT-PRIVILEGES (T-020 contract §4)"
pair expand "ALTER DEFAULT PRIVILEGES FOR ROLE app_ddl IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;"
check C20 "ALTER DEFAULT PRIVILEGES" R-DEFAULT-PRIVILEGES

echo "== R-CONTRACT-ALONE and R-PHASE (SD §DB-13 rules 1-3)"
pair expand "ALTER TABLE public.booking ADD COLUMN note_authored_locale text;"
plant "$UP2" "-- @phase: contract
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C30 "a contract migration in the same change set as an expand" R-CONTRACT-ALONE
pair contract "ALTER TABLE public.booking DROP COLUMN legacy_note;"
plant "$APP" "application code that stopped reading legacy_note"
check C31 "a contract migration in the same change set as application code" R-CONTRACT-ALONE
pair contract "ALTER TABLE public.booking DROP COLUMN legacy_note;"
mutate "$UP1" "-- rotate every 30 days (SA §SEC-10)." "-- rotate every thirty days (SA §SEC-10)."
check C32 "a contract migration alongside a comment-only edit to a merged migration" R-CONTRACT-ALONE
plant "$UP" "-- @phase: contract
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C33 "CONTROL: a contract migration alone, with no down file" PASS
pair expand "ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C34 "DROP COLUMN declared expand" R-PHASE
pair data "ALTER TABLE public.booking DROP legacy_note;"
check C35 "DROP <column> with COLUMN omitted, declared data" R-PHASE
pair expand "ALTER TABLE public.booking RENAME COLUMN legacy_note TO note;"
check C36 "RENAME declared expand" R-PHASE
pair expand "ALTER TABLE public.booking ALTER COLUMN status SET NOT NULL;"
check C37 "SET NOT NULL declared expand" R-PHASE
pair expand "ALTER TABLE public.booking ALTER status TYPE text;"
check C38 "ALTER <column> TYPE declared expand" R-PHASE
pair expand "DO \$do\$ BEGIN EXECUTE 'ALTER TABLE public.booking DROP COLUMN legacy_note'; END \$do\$;"
check C39 "DROP COLUMN as an EXECUTE string, declared expand" R-PHASE
plant "$UP" "ALTER TABLE public.booking ADD COLUMN note_authored_locale text;"
plant "$DOWN" "-- down"
check C3A "no @phase marker" R-PHASE
plant "$UP" "SELECT '-- @phase: expand';"
plant "$DOWN" "-- down"
check C3B "the @phase marker inside a string, not a comment" R-PHASE

echo "== R-PROTECTED (SD §DB-13 rule 7, §UC-4 part 1; T-020 contract §6; OD-73)"
pair expand "DROP TRIGGER trg_booking_sitter_bookable ON booking;"
check C40 "DROP TRIGGER trg_booking_sitter_bookable" R-PROTECTED
pair expand "CREATE OR REPLACE TRIGGER trg_booking_sitter_bookable
  BEFORE INSERT OR UPDATE OF sitter_id, status ON booking
  FOR EACH ROW WHEN (NEW.status IN ('confirmed'))
  EXECUTE FUNCTION assert_sitter_bookable();"
check C41 "its WHEN clause narrowed by CREATE OR REPLACE TRIGGER" R-PROTECTED
pair expand "ALTER TABLE booking DISABLE TRIGGER trg_booking_staffed_hours;"
check C42 "DISABLE TRIGGER trg_booking_staffed_hours" R-PROTECTED
pair expand "CREATE OR REPLACE FUNCTION assert_within_staffed_hours() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;"
check C43 "assert_within_staffed_hours() replaced with a no-op" R-PROTECTED
pair expand "DROP FUNCTION public.trg_assert_answering_service_write_only() CASCADE;"
check C44 "OD-73 A5: DROP the guard event trigger's function CASCADE" "R-PROTECTED R-CASCADE"
pair expand "DROP FUNCTION public.assert_answering_service_write_only();
CREATE FUNCTION public.assert_answering_service_write_only() RETURNS void LANGUAGE sql AS 'SELECT';"
check C45 "OD-73 A4: DROP the guard function and install a no-op" R-PROTECTED
pair expand "ALTER EVENT TRIGGER trg_int10_answering_service DISABLE;"
check C46 "ALTER EVENT TRIGGER trg_int10_answering_service DISABLE" R-PROTECTED
pair expand 'DROP TRIGGER "trg_booking_sitter_bookable" ON booking;'
check C47 "a quoted identifier" R-PROTECTED
pair expand "DO \$do\$ BEGIN EXECUTE 'DROP TRIGGER trg_booking_sitter_bookable ON booking'; END \$do\$;"
check C48 "inside a DO block, as an EXECUTE string" R-PROTECTED
pair expand "-- @compliance-review: trg_booking_sitter_bookable — T-028, SQ-3 DSL sign-off
DROP TRIGGER trg_booking_sitter_bookable ON booking;"
check C49 "CONTROL: the same DROP with a marker citing a ticket and a decision" PASS
pair expand "-- @compliance-review: trg_booking_sitter_bookable — reviewed
DROP TRIGGER trg_booking_sitter_bookable ON booking;"
check C4A "a marker that cites no ticket or decision" R-PROTECTED
pair expand "-- @compliance-review: trg_booking_staffed_hours — T-028
DROP TRIGGER trg_booking_sitter_bookable ON booking;"
check C4B "a marker for a different protected object" R-PROTECTED
pair expand "SELECT '@compliance-review: trg_booking_sitter_bookable — T-028';
DROP TRIGGER trg_booking_sitter_bookable ON booking;"
check C4C "a marker inside a string, not a comment" R-PROTECTED
pair expand "-- dropping trg_booking_sitter_bookable would be wrong (UC-4)
SELECT 1;"
check C4D "CONTROL: the name in a comment only" PASS
pair expand "CREATE TABLE public.trg_booking_sitter_bookable_audit (id int);
GRANT SELECT ON public.trg_booking_sitter_bookable_audit TO app_rw;"
check C4E "CONTROL: a longer identifier that contains a protected name" PASS

echo "== R-TRIGGER-BYPASS"
pair expand "ALTER TABLE booking DISABLE TRIGGER ALL;"
check C50 "DISABLE TRIGGER ALL" R-TRIGGER-BYPASS
pair expand "ALTER TABLE booking DISABLE TRIGGER USER;"
check C51 "DISABLE TRIGGER USER" R-TRIGGER-BYPASS
pair expand "SET session_replication_role = replica;"
check C52 "SET session_replication_role" R-TRIGGER-BYPASS
pair expand "SELECT set_config('session_replication_role', 'replica', true);"
check C53 "set_config('session_replication_role', …)" R-TRIGGER-BYPASS

echo "== R-CASCADE"
pair expand "DROP FUNCTION assert_sitter_bookable() CASCADE;"
check C54 "DROP FUNCTION <a protected trigger's function> CASCADE, which names no protected object" R-CASCADE
pair contract "DROP TABLE public.booking CASCADE;"
check C55 "DROP TABLE … CASCADE in a contract migration" R-CASCADE
pair expand "drop schema t021_scratch
  cascade;"
check C56 "lower case, across two lines" R-CASCADE
pair expand "DROP FUNCTION IF EXISTS public.t021_helper(integer) RESTRICT;"
check C57 "CONTROL: DROP … RESTRICT" PASS

echo "== R-ANSWERING-SERVICE (T-020 contract §6)"
pair expand "GRANT SELECT ON out_of_hours_report TO answering_service;"
check C60 "SELECT on out_of_hours_report" R-ANSWERING-SERVICE
pair expand "GRANT INSERT ON public.account TO answering_service;"
check C61 "INSERT on another table" R-ANSWERING-SERVICE
pair expand "GRANT app_rw TO answering_service;"
check C62 "a role granted to answering_service" R-ANSWERING-SERVICE
pair expand "GRANT USAGE ON SEQUENCE public.out_of_hours_report_id_seq TO answering_service;"
check C63 "USAGE on a sequence" R-ANSWERING-SERVICE
pair expand "GRANT EXECUTE ON FUNCTION public.pg_stat_statements(boolean) TO answering_service;"
check C64 "OD-52: EXECUTE on pg_stat_statements(boolean)" R-ANSWERING-SERVICE
pair expand "GRANT SELECT ON public.sitter_search_doc TO PUBLIC;"
check C65 "a grant to PUBLIC" R-ANSWERING-SERVICE
pair expand "GRANT INSERT, SELECT ON out_of_hours_report TO answering_service;"
check C66 "INSERT plus SELECT on out_of_hours_report" R-ANSWERING-SERVICE
pair expand "CREATE TABLE public.out_of_hours_report (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);
GRANT INSERT ON out_of_hours_report TO answering_service;"
check C67 "CONTROL: the one permitted grant, with its table" PASS

echo "== R-TABLE-GRANT (T-020 contract §4/§6)"
pair expand "CREATE TABLE public.t021_thing (id int);"
check C70 "CREATE TABLE with no GRANT" R-TABLE-GRANT
pair expand 'CREATE TABLE IF NOT EXISTS "t021_thing" (id int);
GRANT SELECT ON public.t021_other TO app_rw;'
check C71 "CREATE TABLE with a GRANT on a different table" R-TABLE-GRANT

echo "== R-MERGED (PROTOCOL §3, OD-13, OD-72) — every plant is on 0001, which is at the base"
mutate "$UP1" "-- rotate every 30 days (SA §SEC-10)." "-- rotate every thirty days (SA §SEC-10)."
check C80 "CONTROL: a top-level comment line reworded (the shape of OD-13's line-163 fix, committed as 7f46c82)" PASS
mutate "$UP1" "own staff boundary (SA §SEC-11)" "own staff boundary (SA §SEC-10)"
check C81 "OD-72: the line-627 citation, which sits inside the dollar-quoted function body" "R-MERGED R-BASELINE"
mutate "$UP1" "'Wired to event trigger trg_int10_answering_service. Ticket T-020.';" "'Wired to event trigger trg_int10_answering_service. Tickets T-020, T-021.';"
check C82 "the COMMENT ON text" "R-MERGED R-BASELINE"
mutate "$UP1" "REVOKE EXECUTE ON FUNCTION public.pg_stat_statements(boolean)," "-- REVOKE EXECUTE ON FUNCTION public.pg_stat_statements(boolean),"
mutate "$UP1" "                            public.pg_stat_statements_info() FROM PUBLIC;" "--                          public.pg_stat_statements_info() FROM PUBLIC;"
check C83 "OD-52: the QA-F11 REVOKE turned into comment lines" "R-MERGED R-BASELINE"
mutate "$UP1" "expected the root locale ''und'' (SD DB-16)'" "expected the ICU root locale ''und'' (SD DB-16)'"
check C84 "a preflight message reworded (T-115's suites assert it)" "R-MERGED R-BASELINE"
mutate "$UP1" "ALTER SCHEMA public OWNER TO app_ddl;" "  ALTER SCHEMA public OWNER TO app_ddl;"
check C85 "indentation only, on a statement line" "R-MERGED R-BASELINE"
mutate "$UP1" "'Break-glass credential checkout only (SD DB-13 rule 6). Ticket T-020.';" "'Break-glass credential checkout only (SD DB-13 rule 6).  Ticket T-020.';"
check C86 "one space added inside a string literal" "R-MERGED R-BASELINE"
rm "$DOWN1"
check C87 "a merged migration deleted" "R-MERGED R-STRUCT"
mutate "$UP1" "ALTER SCHEMA public OWNER TO app_ddl;" "ALTER SCHEMA public OWNER TO app_ddl;  -- T-021 plant"
check C88 "CONTROL: a trailing -- comment added to a statement line" PASS
mutate "$UP1" "ALTER SCHEMA public OWNER TO app_ddl;
" "ALTER SCHEMA public OWNER TO app_ddl;
/* T-021 plant:
   a block comment spanning lines, between statements */
"
check C89 "CONTROL: a multi-line block comment between statements" PASS
mutate "$UP1" "  v        text;" "  v        text; /* T-021 plant */"
check C8A "a block comment inside the dollar-quoted function body" "R-MERGED R-BASELINE"
mutate "$UP1" "-- Belt and braces: assert the state this file itself just created." "SELECT 1; -- Belt and braces: assert the state this file itself just created."
check C8B "a comment line given a statement" "R-MERGED R-BASELINE"
mutate "$UP1" "REVOKE ALL ON SCHEMA public FROM PUBLIC;" "-- REVOKE ALL ON SCHEMA public FROM PUBLIC;"
check C8C "a statement commented out" "R-MERGED R-BASELINE"
mutate "$DOWN1" "DROP ROLE IF EXISTS app_admin_rw;
DROP ROLE IF EXISTS app_rw;" "DROP ROLE IF EXISTS app_rw;
DROP ROLE IF EXISTS app_admin_rw;"
check C8D "two statements reordered in the down file (item iii's shape)" "R-MERGED R-BASELINE"
sed -i 's/$/\r/' "$UP1"
if git diff --quiet -- "$UP1" || ! grep -q $'\r$' "$UP1"; then echo "ABORT: the CRLF conversion did not land"; exit 2; fi
check C8E "the whole of 0001 converted to CRLF line endings (an editor setting)" "R-MERGED R-BASELINE"

echo "== R-STRUCT, R-LEX, R-BASE"
plant "$UP" "-- @phase: expand
ALTER TABLE public.booking ADD COLUMN note_authored_locale text;"
check C90 "an expand up file with no down" R-STRUCT
plant "$M/t021_badname.sql" "SELECT 1;"
check C91 "a file not named NNNN_slug.(up|down).sql" R-STRUCT
plant "$M/0001_t021_plant.up.sql" "-- @phase: expand
SELECT 1;"
plant "$M/0001_t021_plant.down.sql" "-- down"
check C92 "a second migration numbered 0001" R-STRUCT
plant "$M/0000_t021_plant.up.sql" "-- @phase: expand
SELECT 1;"
plant "$M/0000_t021_plant.down.sql" "-- down"
check C93 "a new migration numbered below the highest merged one" R-STRUCT
plant "$DOWN" "-- a down file with no up"
check C94 "a down file with no up" R-STRUCT
pair expand "DO \$do\$ BEGIN PERFORM 1;"
check C95 "an unterminated dollar quote" R-LEX
pair expand "COMMENT ON TABLE booking IS 'unterminated;"
check C96 "an unterminated string" R-LEX
check C97 "a base ref that does not exist" R-BASE --base=no-such-ref-t021
check C98 "an unknown argument" R-BASE --base=HEAD --no-such-flag

echo "== R-BASELINE alone: a 0001 change committed ONTO the base, which R-MERGED cannot see"
WT="$(mktemp -d)/wt"
git worktree add -q --detach "$WT" HEAD || { echo "ABORT: git worktree add"; exit 2; }
node scripts/negative-tests/mutate.mjs "$WT/$UP1" "ALTER SCHEMA public OWNER TO app_ddl;" "ALTER SCHEMA public OWNER TO app_rw;" || { echo "ABORT: mutation"; exit 2; }
git -C "$WT" -c user.name=t021-negative-test -c user.email=t021@kinvara.test commit -q -am "T-021 C99 plant, detached worktree, never merged" || { echo "ABORT: commit"; exit 2; }
[ -z "$(git -C "$WT" status --porcelain)" ] || { echo "ABORT: worktree not committed"; exit 2; }
(cd "$WT" && node scripts/gates/migration-lint.ts --base=HEAD) >"$OUT" 2>&1
judge C99 "0001 changed and committed at HEAD, gate run with --base=HEAD in that tree" R-BASELINE "$?"
git worktree remove --force "$WT" && git worktree prune
restore

echo
if [ "$bad" -eq 0 ]; then
  echo "ALL $total CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $total cases misbehaved"
exit 1
