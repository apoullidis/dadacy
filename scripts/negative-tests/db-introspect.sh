#!/usr/bin/env bash
# T-138 — negative tests for db:introspect:check (scripts/db-introspect.ts).
# T-150 — K11–K17: the closed column-type map (I-MAP), pruning under the root tsconfig (I-TSC),
# an unpruned file refused, and write-mode idempotence.
#
# T-152 — K18–K25: the rendering is a function of the schema alone (OD-106, OD-108). NO case runs
# ANALYZE as a precondition: T-150's declared precondition is removed, because the generator now puts
# drizzle-kit's output in a canonical order (scripts/gates/lib/schema-order.ts). K18 attacks catalogue
# history (a down/up that is asserted to have moved drizzle-kit's own table-list order), K19 and K20
# attack statistics (ANALYZE and VACUUM ANALYZE, each asserted to have landed on pg_class), K21
# deletes the canonical order and must go red, K22 plants composite keys whose column order only the
# catalogue knows, and K23–K25 are the step's own I-ORDER refusals.
#
# T-152 rework 1 — K26–K35: row-level security policies (OD-109, QA-F1). drizzle-kit keeps a policy's
# using/withCheck only for the first pg_policies row of each table, so the generator renders every
# pgPolicy from pg_policy (scripts/gates/lib/schema-policy.ts, I-POLICY). K26 is qa-verification's
# two-policy table (db-introspect-policies-qa.sql) and K27 the attribute shapes
# (db-introspect-policies-shapes.sql); each fixture's `-- expect:` lines must be in db/schema.ts. K26
# runs FIRST, so on a fresh project its first write sees a catalogue nobody has ANALYZEd, and it is
# then checked after ANALYZE and after a down/up. K28–K35 are the step's refusals.
#
# T-145 — K36–K41: schema `pgboss` (pg-boss's job schema, SD §DB-1 line 1751) is admitted as
# deliberately out of scope, by exact name (QA-A4, OD-90). K36 is the control: a job-schema-shaped set
# (an enum, a sequence, a plain table, a partitioned table with a partition, a view) planted in
# `pgboss` gives GATE PASS, is absent from db/schema.ts in check AND write mode, and is not counted by
# I-VACUOUS, each compared against the catalogue in the same run. K37a–c plant the same set in the
# near-miss schemas `pgboss_x`, `pg_boss` and `"PgBoss"` (I-SCOPE); K38 a relation in `kinvara_guard`
# (I-SCOPE); K39a/b delete the rule two ways (the list emptied; the exclusion clause removed from the
# refusal) and the K36 plant goes I-SCOPE; K40 a public table beside the pgboss set with no
# regeneration (I-DIFF only); K41 pgboss beside pgboss_x (I-SCOPE names pgboss_x only).
#
# T-145 rework 1 — K42–K49 (QR-F1, QR-A1, OD-140): the catalogue is read as one JSON array and names are
# printed JSON-quoted with non-printable-ASCII escaped. Each case plants a schema main's trim/split text
# read re-parsed: a leading space, NBSP, BOM, tab or newline before `pgboss`, `"pgboss|x"`,
# `"pgboss|x|true"` and `"zz_other|x|true"`. The plant's nspname bytes are asserted against printf-derived
# hex, the check must be exactly {I-SCOPE} naming it unambiguously, and then K42m–K49m restore main's
# read (asserted landed) and show the same plant getting past I-SCOPE.
#
#   cd /home/alex/projects/nanny/app && ./scripts/svc run <ticket> -- bash scripts/negative-tests/db-introspect.sh
#
# Needs the ticket's `db` project and a clean, committed tree. The check itself migrates the
# database up, so the database may start fresh or already at the highest committed migration.
#
# Each case plants one thing and ASSERTS THE PLANT LANDED, runs `node scripts/db-introspect.ts
# --check`, and judges the run by three readings that a check doing nothing could not all produce:
#   1. the exit status (0 PASS, 1 FAIL, 70 CRASH);
#   2. exactly one `GATE PASS|FAIL|CRASH  db:introspect:check` banner, of the expected kind;
#   3. the SET of `[I-TAG]` problem tags, which must EQUAL the expected set.
# Some cases also require one line in the output, proving the planted state was reached, for
# example that the planted migration was applied. After each case the database is brought back to
# the highest committed migration and its record is asserted, the tree is restored, and
# `git status` is asserted clean.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: the tree is not clean. Commit first."
  git status --porcelain
  exit 2
fi

M=db/migrations
HIGHEST=$(ls "$M" | sed -nE 's/^([0-9]{4})_[a-z0-9_]+\.up\.sql$/\1/p' | sort | tail -1)
NEXT=$(printf '%04d' $((10#$HIGHEST + 1)))
UP=$M/${NEXT}_t138_plant.up.sql
DOWN=$M/${NEXT}_t138_plant.down.sql
SCHEMA=db/schema.ts
SCRIPT=scripts/db-introspect.ts
RENDER=scripts/gates/lib/schema-render.ts
ORDER=scripts/gates/lib/schema-order.ts
POLICY=scripts/gates/lib/schema-policy.ts
QA_POLICIES=scripts/negative-tests/db-introspect-policies-qa.sql
SHAPE_POLICIES=scripts/negative-tests/db-introspect-policies-shapes.sql
OUT=$(mktemp)
total=0
bad=0
echo "highest committed migration $HIGHEST; plants are numbered $NEXT"

record() {
  psql -X -A -t -q -c "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()"
}

owned_in_public() {
  psql -X -A -t -q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')"
}

abort() {
  echo "ABORT: $1"
  exit 2
}

# write_schema: regenerate db/schema.ts once. No ANALYZE (T-152).
write_schema() {
  node scripts/db-introspect.ts --write >"$OUT.w" 2>&1 || { cat "$OUT.w"; abort "regeneration failed"; }
}

# drizzle-kit 0.31.10's own table-list query (bin.cjs 17559-17575, schemaFilter public), names in the
# order the server returns them. K18 uses it to assert that its history attack landed.
table_list_order() {
  psql -X -A -t -q -c "SELECT n.nspname AS table_schema, c.relname AS table_name, CASE WHEN c.relkind = 'r' THEN 'table' WHEN c.relkind = 'v' THEN 'view' WHEN c.relkind = 'm' THEN 'materialized_view' END AS type, c.relrowsecurity AS rls_enabled FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'v', 'm') AND n.nspname = 'public'" | cut -d'|' -f2 | tr '\n' ' '
}

# pg_class's last ANALYZE and last VACUUM, as the statistics collector reports them.
stats_mark() {
  psql -X -A -t -q -c "SELECT coalesce(last_analyze::text, 'never') || ' / ' || coalesce(last_vacuum::text, 'never') FROM pg_stat_all_tables WHERE relid = 'pg_class'::regclass"
}

restore() {
  if [ "$(record)" != "kinvara-migrate version=$HIGHEST" ]; then
    node scripts/db-migrate.ts down --to "$HIGHEST" >"$OUT.down" 2>&1
    grep -q '^MIGRATE OK  down: ' "$OUT.down" || { cat "$OUT.down"; abort "could not bring the database back to $HIGHEST"; }
  fi
  [ "$(record)" = "kinvara-migrate version=$HIGHEST" ] || abort "the record reads '$(record)', not $HIGHEST"
  rm -f "$M/${NEXT}_t138_plant.up.sql" "$M/${NEXT}_t138_plant.down.sql"
  git checkout -q -- "$SCHEMA" "$SCRIPT" "$RENDER" "$ORDER" "$POLICY"
  if [ -n "$(git status --porcelain)" ]; then
    git status --porcelain
    abort "the tree did not restore cleanly"
  fi
}

# plant <file> <content>: write, then assert the bytes on disk are the bytes intended.
plant() {
  printf '%s\n' "$2" >"$1"
  [ "$(cat "$1")" = "$2" ] || abort "the plant did not land in $1"
}

# a migration NEXT that creates one table in public, with a grant and a down file.
plant_table() {
  plant "$UP" "-- @phase: expand
CREATE TABLE public.t138_plant (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text NOT NULL);
GRANT SELECT, INSERT ON public.t138_plant TO app_rw;"
  plant "$DOWN" "DROP TABLE public.t138_plant;"
}

# mutate <file> <from> <to>: mutate.mjs exits non-zero if the anchor is absent; the file must differ from HEAD.
mutate() {
  node scripts/negative-tests/mutate.mjs "$1" "$2" "$3" || abort "mutation anchor missing in $1"
  if git diff --quiet -- "$1"; then abort "the mutation did not change $1"; fi
}

# append a line to db/schema.ts by hand; the file must differ from HEAD.
hand_edit() {
  printf '%s\n' "$1" >>"$SCHEMA"
  if git diff --quiet -- "$SCHEMA"; then abort "the hand edit did not change $SCHEMA"; fi
}

# recompute db/schema.ts's header over its current body, as an editor covering their tracks would.
rehash() {
  node --input-type=module -e '
    import fs from "node:fs";
    import { renderSchemaFile, verifySchemaFile } from "./scripts/gates/lib/schema-digest.ts";
    const lines = fs.readFileSync("db/schema.ts", "utf8").split("\n");
    const version = /drizzle-kit (\S+) sha256/.exec(lines[2] ?? "")?.[1] ?? "unknown";
    fs.writeFileSync("db/schema.ts", renderSchemaFile(lines.slice(3).join("\n"), version));
    if (!verifySchemaFile(fs.readFileSync("db/schema.ts", "utf8")).ok) process.exit(3);
  ' || abort "rehash did not produce a verifying header"
}

# judge <id> <description> <expect> <exit code> [required output regex]
# expect: PASS, CRASH, or I-TAGs separated by spaces.
judge() {
  local id=$1 desc=$2 expect=$3 code=$4 require=${5:-} got want banners verdict=BAD
  total=$((total + 1))
  banners=$(grep -cE '^GATE (PASS|FAIL|CRASH)  db:introspect:check($| — |: )' "$OUT")
  got=$(grep -oE '^  - \[I-[A-Z]+\]' "$OUT" | sed -E 's/^  - \[(.*)\]$/\1/' | sort -u | tr '\n' ' ' | sed 's/ $//')
  case "$expect" in
    PASS)
      if [ "$code" -eq 0 ] && [ "$banners" -eq 1 ] && grep -qx 'GATE PASS  db:introspect:check' "$OUT" && [ -z "$got" ]; then verdict=ok; fi
      ;;
    CRASH)
      if [ "$code" -eq 70 ] && [ "$banners" -eq 1 ] && grep -q '^GATE CRASH  db:introspect:check: ' "$OUT" && [ -z "$got" ]; then verdict=ok; fi
      ;;
    *)
      # shellcheck disable=SC2086
      want=$(printf '%s\n' $expect | sort -u | tr '\n' ' ' | sed 's/ $//')
      if [ "$code" -eq 1 ] && [ "$banners" -eq 1 ] && grep -q '^GATE FAIL  db:introspect:check — ' "$OUT" && [ "$got" = "$want" ]; then verdict=ok; fi
      ;;
  esac
  if [ -n "$require" ] && ! grep -qE -- "$require" "$OUT"; then
    verdict=BAD
    require="$require  <- NOT FOUND"
  fi
  [ "$verdict" = ok ] || bad=$((bad + 1))
  printf '%-4s %s  %s\n       exit %s; banners %s; expected %s; reported %s\n' "$verdict" "$id" "$desc" "$code" "$banners" "$expect" "${got:-none}"
  [ -z "$require" ] || printf '       required: %s\n' "$require"
  grep -E '^  - \[|^GATE |VACUOUS:|byte-identical|db:migrate up:' "$OUT" | cut -c1-240 | sed 's/^/       /'
}

check() {
  local id=$1 desc=$2 expect=$3 require=${4:-}
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  judge "$id" "$desc" "$expect" "$?" "$require"
  restore
}

# policy_fixture <fixture>: plant a committed policy fixture as migration NEXT. The whole file is the
# up file; its `-- down:` lines are the down file. plant() asserts both landed.
policy_fixture() {
  plant "$UP" "$(cat "$1")"
  plant "$DOWN" "$(sed -nE 's/^-- down: //p' "$1")"
  [ -s "$DOWN" ] && grep -q . "$DOWN" || abort "$1 has no -- down: line"
}

# policy_check <id> <description> <fixture> <counts regex>: run the check; the case is ok only if it
# is a PASS, every `-- expect:` line of the fixture is in db/schema.ts, and the generator's policies
# line matches <counts regex> (so a step that checked nothing, or restored nothing, is not ok).
policy_check() {
  local id=$1 desc=$2 fixture=$3 counts=$4 code n=0 miss=0 line
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  while IFS= read -r line; do
    n=$((n + 1))
    if grep -qF -- "$line" "$SCHEMA"; then echo "policy as pg_policy has it: $line" >>"$OUT"; else echo "policy MISSING or different: $line" >>"$OUT"; miss=$((miss + 1)); fi
  done < <(sed -nE 's/^-- expect: //p' "$fixture")
  [ "$n" -gt 0 ] || abort "$fixture has no -- expect: line"
  if [ "$miss" -eq 0 ] && grep -qE -- "^  policies: $counts" "$OUT"; then echo "ALL $n POLICIES AS PG_POLICY HAS THEM, COUNTS AS EXPECTED" >>"$OUT"; fi
  judge "$id" "$desc" PASS "$code" '^ALL [0-9]+ POLICIES AS PG_POLICY HAS THEM, COUNTS AS EXPECTED$'
  printf '       counts required: %s\n' "$counts"
  grep -E '^  policies: |^policy ' "$OUT" | cut -c1-240 | sed 's/^/       /'
}

node scripts/db-migrate.ts up >"$OUT.m" 2>&1 || { cat "$OUT.m"; abort "db:migrate up failed before the first case"; }
[ "$(record)" = "kinvara-migrate version=$HIGHEST" ] || abort "the record reads '$(record)' after db:migrate up, not $HIGHEST"

echo "== T-152 rework 1: row-level security policies (OD-109). First, so that on a fresh project the first write sees a catalogue nobody has ANALYZEd"
policy_fixture "$QA_POLICIES"
echo "   pg_class last analyze / vacuum before the first write: '$(stats_mark)'"
write_schema
grep -E '^  policies: ' "$OUT.w" | sed 's/^/   first write: /'
policy_check K26a "(T-152 r1) QA's two-policy table, written and checked with no ANALYZE: both expressions present" "$QA_POLICIES" '2 checked against pg_policy; 1 expression\(s\) drizzle-kit dropped restored; 1 entr\(ies\) rewritten from the catalogue$'
m0=$(stats_mark)
psql -X -q -v ON_ERROR_STOP=1 -c ANALYZE >/dev/null || abort "ANALYZE failed"
m1=$(stats_mark)
{ [ "$m1" != "$m0" ] && [ "${m1%% / *}" != never ]; } || abort "ANALYZE did not land on pg_class (last analyze / vacuum '$m0' -> '$m1')"
echo "   statistics attack landed: pg_class last analyze / vacuum '$m0' -> '$m1'"
policy_check K26b "(T-152 r1) the same file after ANALYZE (asserted above): parity holds, both expressions present" "$QA_POLICIES" '2 checked against pg_policy; 1 expression\(s\) drizzle-kit dropped restored; 1 entr\(ies\) rewritten from the catalogue$'
{ node scripts/db-migrate.ts down --to "$HIGHEST" >"$OUT.p" 2>&1 && grep -q "^MIGRATE OK  down: $NEXT -> $HIGHEST" "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate down --to $HIGHEST failed"; }
{ node scripts/db-migrate.ts up >"$OUT.p" 2>&1 && grep -q "^MIGRATE OK  up: $HIGHEST -> $NEXT" "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate up to $NEXT failed"; }
echo "   history attack landed: down --to $HIGHEST, up to $NEXT"
policy_check K26c "(T-152 r1) the same file after the policy migration's down/up: parity holds, both expressions present" "$QA_POLICIES" '2 checked against pg_policy; 1 expression\(s\) drizzle-kit dropped restored; 1 entr\(ies\) rewritten from the catalogue$'
restore

policy_fixture "$SHAPE_POLICIES"
write_schema
policy_check K27 "(T-152 r1) restrictive, FOR ALL TO PUBLIC, FOR DELETE, FOR UPDATE with both expressions and two roles: each as pg_policy has it" "$SHAPE_POLICIES" '4 checked against pg_policy; [1-9][0-9]* expression\(s\) drizzle-kit dropped restored; '
restore

echo "== control"
check K00 "CONTROL: the committed tree, nothing planted" PASS 'byte-identical to a fresh introspection'
OWNED=$(owned_in_public)
echo "   relations in public owned by no extension at $HIGHEST: $OWNED"

echo "== (i) a hand edit to db/schema.ts"
hand_edit 'export const handWritten = 1;'
check K01 "(i) a line added by hand, header untouched" "I-DIGEST I-DIFF"
hand_edit 'export const handWritten = 1;'
rehash
check K02 "(i) a line added by hand AND the header digest recomputed: parity still refuses it" I-DIFF

echo "== (ii) a migration adding a table, with and without regeneration"
plant_table
check K03 "(ii) a migration adding a table, db/schema.ts not regenerated" I-DIFF "MIGRATE OK  up: $HIGHEST -> $NEXT"
plant_table
write_schema
grep -q 'pgTable("t138_plant"' "$SCHEMA" || abort "regeneration did not add t138_plant to $SCHEMA"
check K04 "CONTROL (ii): the same migration with db/schema.ts regenerated" PASS 'byte-identical to a fresh introspection'

echo "== (iii) db/schema.ts deleted"
rm -f "$SCHEMA"
[ ! -e "$SCHEMA" ] || abort "$SCHEMA still exists"
check K05 "(iii) db/schema.ts deleted: a failure, not nothing to compare" I-MISSING

echo "== (iv) anti-vacuity, anchored on the catalogue"
plant_table
mutate "$SCRIPT" "schemaFilter: [INTROSPECTED_SCHEMA]," "schemaFilter: ['t138_no_such_schema'],"
check K06 "(iv) introspection mutated to read no schema, while the catalogue holds a table" I-VACUOUS "MIGRATE OK  up: $HIGHEST -> $NEXT"
mutate "$SCRIPT" "schemaFilter: [INTROSPECTED_SCHEMA]," "schemaFilter: ['t138_no_such_schema'],"
if [ "$OWNED" -eq 0 ]; then
  check K07 "BOUND (iv): the same mutation, no table planted, catalogue holds 0 un-owned relations -> NOT detected" PASS 'VACUOUS: 0 relations introspected'
else
  check K07 "(iv) the same mutation against the committed relations" I-VACUOUS
fi

echo "== scope, migration failure, crash"
plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-138
CREATE SCHEMA t138_other;
CREATE TABLE t138_other.t138_plant (id bigint PRIMARY KEY);"
plant "$DOWN" "DROP TABLE t138_other.t138_plant;
DROP SCHEMA t138_other;"
check K08 "a table owned by no extension outside public" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT"
plant "$UP" "-- @phase: expand
SELECT 1/0;"
plant "$DOWN" "-- the down file of a planted migration"
check K09 "a migration that fails to apply" I-MIGRATE
mutate "$SCRIPT" "  // 1. migrations" "  throw new Error('t138 planted crash');
  // 1. migrations"
check K10 "the script throws: a crash, told apart from a refusal" CRASH

echo "== T-150: the closed column-type map (I-MAP)"
plant "$UP" "-- @phase: expand
CREATE TABLE public.t150_plant (id bigint PRIMARY KEY, doc tsvector);"
plant "$DOWN" "DROP TABLE public.t150_plant;"
check K11 "(T-150) a column type outside the closed map (tsvector) fails; unknown(...) is never accepted" I-MAP "column \"doc\" has database type 'tsvector'"
plant "$UP" "-- @phase: expand
CREATE TABLE public.t150_plant (id bigint PRIMARY KEY, doc tsvector);"
plant "$DOWN" "DROP TABLE public.t150_plant;"
node scripts/db-introspect.ts --write >"$OUT" 2>&1
code=$?
total=$((total + 1))
w_banners=$(grep -cE '^GATE (PASS|FAIL|CRASH)  db:introspect($| — |: )' "$OUT")
w_tags=$(grep -oE '^  - \[I-[A-Z]+\]' "$OUT" | sed -E 's/^  - \[(.*)\]$/\1/' | sort -u | tr '\n' ' ' | sed 's/ $//')
if [ "$code" -eq 1 ] && [ "$w_banners" -eq 1 ] && [ "$w_tags" = "I-MAP" ] && git diff --quiet -- "$SCHEMA" && ! grep -q 'unknown(' "$SCHEMA"; then v=ok; else v=BAD; bad=$((bad + 1)); fi
printf '%-4s %s  %s\n       exit %s; banners %s; expected I-MAP and db/schema.ts unchanged; reported %s; db/schema.ts %s\n' "$v" K11w "(T-150) the same plant in WRITE mode: refused, and db/schema.ts is not written" "$code" "$w_banners" "${w_tags:-none}" "$(git diff --quiet -- "$SCHEMA" && echo unchanged || echo CHANGED)"
grep -E '^  - \[|^GATE ' "$OUT" | cut -c1-240 | sed 's/^/       /'
restore
plant "$UP" "-- @phase: expand
CREATE TABLE public.t150_plant (id bigint PRIMARY KEY, tags citext[]);"
plant "$DOWN" "DROP TABLE public.t150_plant;"
check K12 "(T-150) citext[] is not citext: the map matches the exact type, so an array of a mapped type fails" I-MAP "column \"tags\" has database type 'citext\[\]'"
mutate "$RENDER" "  ['bytea', " "  ['t150_removed_bytea', "
check K13 "(T-150) the bytea entry deleted from the map: the committed app_session.token_hash is refused" I-MAP "column \"token_hash\" has database type 'bytea'"

echo "== T-150: pruning under the root tsconfig (I-TSC), and an unpruned file"
mutate "$RENDER" "for (const fixId of FIX_IDS) {" "for (const fixId of FIX_IDS.slice(0, 0)) {"
check K14 "(T-150) pruning deleted (no fix applied): the rendering tsc would refuse is refused" I-TSC "TS6133 [0-9]+:[0-9]+ 'table' is declared but its value is never read"
mutate "$SCHEMA" "}, () => [" "}, (table) => ["
rehash
# The plant is exactly the unpruned parameter plus the recomputed digest: two lines, nothing else.
# (I-DIFF names line 3, the digest, as the first difference whatever else differs, so the message
# cannot show the parameter; K00 green on this same database is what attributes the I-DIFF here.)
[ "$(git diff --numstat -- "$SCHEMA" | cut -f1,2)" = "$(printf '2\t2')" ] || abort "the unpruned plant is not exactly two changed lines"
git diff -U0 -- "$SCHEMA" | grep -q '^+}, (table) => \[$' || abort "the unpruned parameter did not land"
check K15 "(T-150) the committed file unpruned (the parameter put back) with its digest recomputed: parity refuses it" I-DIFF

echo "== T-150: idempotence"
total=$((total + 1))
node scripts/db-introspect.ts --write >"$OUT" 2>&1
e1=$?
cp "$SCHEMA" "$OUT.s1"
node scripts/db-introspect.ts --write >"$OUT.2" 2>&1
e2=$?
cmp -s "$SCHEMA" "$OUT.s1"
c=$?
git diff --quiet -- "$SCHEMA"
g=$?
p1=$(grep -c 'pruned with typescript' "$OUT")
if [ "$e1" -eq 0 ] && [ "$e2" -eq 0 ] && [ "$c" -eq 0 ] && [ "$g" -eq 0 ] && [ "$p1" -eq 1 ] && grep -qx 'GATE PASS  db:introspect' "$OUT.2"; then v=ok; else v=BAD; bad=$((bad + 1)); fi
printf '%-4s %s  %s\n       write 1 exit %s; write 2 exit %s; cmp(write 1, write 2) exit %s; git diff --quiet vs committed exit %s\n' "$v" K16 "(T-150) --write twice: both exit 0, byte-identical to each other and to the committed file" "$e1" "$e2" "$c" "$g"
grep -E 'mapped column|pruned with|wrote|^GATE ' "$OUT" "$OUT.2" | sed 's/^/       /'
restore

echo "== control, again, after every plant and drop above"
check K17 "CONTROL: the committed tree after the whole suite's plant/drop history, no ANALYZE anywhere in the suite" PASS 'byte-identical to a fresh introspection'

echo "== T-152: the rendering is a function of the schema alone (OD-106, OD-108)"
PREV=$(printf '%04d' $((10#$HIGHEST - 1)))
PREV2=$(printf '%04d' $((10#$HIGHEST - 2)))
before=$(table_list_order)
after=$before
perturbed=
for to in "$PREV" "$PREV2"; do
  { node scripts/db-migrate.ts down --to "$to" >"$OUT.p" 2>&1 && grep -q '^MIGRATE OK  down: ' "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate down --to $to failed"; }
  { node scripts/db-migrate.ts up >"$OUT.p" 2>&1 && grep -q '^MIGRATE OK  up: ' "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate up after down --to $to failed"; }
  after=$(table_list_order)
  if [ "$after" != "$before" ]; then
    perturbed=$to
    break
  fi
done
[ -n "$perturbed" ] || abort "neither down --to $PREV nor down --to $PREV2, then up, moved drizzle-kit's table-list order [$before]: the history attack did not land"
echo "   history attack landed: down --to $perturbed, up; drizzle-kit's table list was [$before], is now [$after]"
check K18 "(T-152) catalogue history moved drizzle-kit's own table order (asserted above), no ANALYZE: parity holds" PASS 'byte-identical to a fresh introspection'

m0=$(stats_mark)
psql -X -q -v ON_ERROR_STOP=1 -c ANALYZE >/dev/null || abort "ANALYZE failed"
m1=$(stats_mark)
{ [ "$m1" != "$m0" ] && [ "${m1%% / *}" != never ]; } || abort "ANALYZE did not land on pg_class (last analyze / vacuum '$m0' -> '$m1')"
echo "   statistics attack landed: pg_class last analyze / vacuum '$m0' -> '$m1'"
check K19 "(T-152) planner statistics changed by ANALYZE (asserted above): parity holds" PASS 'byte-identical to a fresh introspection'

m0=$(stats_mark)
psql -X -q -v ON_ERROR_STOP=1 -c "VACUUM ANALYZE" >/dev/null || abort "VACUUM ANALYZE failed"
m1=$(stats_mark)
{ [ "${m1#* / }" != "${m0#* / }" ] && [ "${m1#* / }" != never ]; } || abort "VACUUM ANALYZE did not land on pg_class (last analyze / vacuum '$m0' -> '$m1')"
echo "   statistics attack landed: pg_class last analyze / vacuum '$m0' -> '$m1'"
check K20 "(T-152) VACUUM ANALYZE (asserted above): parity holds" PASS 'byte-identical to a fresh introspection'

mutate "$ORDER" "  let text = source;" "  let text = source;
  if (text !== '') return { ok: true, body: text, declarations: 0, entries: 0, keyLists: 0, moved: 0 };"
check K21 "(T-152) the canonical order deleted (drizzle-kit's order passes through): the committed file is refused" I-DIFF 'canonical order: 0 declaration\(s\), 0 table entr\(ies\), 0 key column list\(s\)'

plant "$UP" "-- @phase: expand
CREATE TABLE public.t152_parent (k2 text NOT NULL, k1 text NOT NULL, CONSTRAINT t152_parent_pkey PRIMARY KEY (k2, k1));
CREATE TABLE public.t152_child (id bigint PRIMARY KEY, c1 text NOT NULL, c2 text NOT NULL, u_b text, u_a text,
  CONSTRAINT t152_child_u_key UNIQUE (u_b, u_a),
  CONSTRAINT t152_child_pair_fkey FOREIGN KEY (c2, c1) REFERENCES public.t152_parent (k2, k1));"
plant "$DOWN" "DROP TABLE public.t152_child;
DROP TABLE public.t152_parent;"
write_schema
node scripts/db-introspect.ts --check >"$OUT" 2>&1
code=$?
missing=0
for line in 'primaryKey({ columns: [table.k2, table.k1], name: "t152_parent_pkey"})' 'unique("t152_child_u_key").on(table.uB, table.uA)' 'columns: [table.c2, table.c1],' 'foreignColumns: [t152Parent.k2, t152Parent.k1],'; do
  if grep -qF -- "$line" "$SCHEMA"; then echo "key order as the catalogue: $line" >>"$OUT"; else echo "key order NOT as the catalogue, missing: $line" >>"$OUT"; missing=$((missing + 1)); fi
done
[ "$missing" -eq 0 ] && echo "ALL FOUR KEY LISTS IN CATALOGUE ORDER" >>"$OUT"
judge K22 "(T-152) composite PK (k2, k1), UNIQUE (u_b, u_a), FK (c2, c1) -> (k2, k1): rendered in the catalogue's column order, and parity holds" PASS "$code" '^ALL FOUR KEY LISTS IN CATALOGUE ORDER$'
grep -E '^key order' "$OUT" | sed 's/^/       /'
restore

mutate "$ORDER" "  ['check', 5]," "  ['t152_removed_check', 5],"
check K23 "(T-152) an extra-config kind the order step does not know (check removed from its table): refused, never passed through" I-ORDER 'extra-config entry .*check\(.* is not a kind this step orders'

mutate "$ORDER" "con.contype IN ('p', 'u', 'f')" "con.contype IN ('x')"
check K24 "(T-152) the catalogue returns no key for a rendered constraint: refused" I-ORDER 'primaryKey "account_role_pkey" has no matching PRIMARY KEY constraint'

mutate "$ORDER" "'columns', (SELECT json_agg(a.attname ORDER BY k.ord)" "'columns', (SELECT json_agg(a.attname || '_t152' ORDER BY k.ord)"
check K25 "(T-152) the catalogue's key columns differ from the rendered list: refused" I-ORDER "account_role_pkey columns: the rendering lists columns \[account_id, role\] but the catalogue's key is \[account_id_t152, role_t152\]"

echo "== T-152 rework 1: the policy step's refusals (I-POLICY)"
policy_fixture "$QA_POLICIES"
mutate "$POLICY" "        if (have === undefined && want !== null) {" "        if (have === undefined && want === 't152 never') {"
check K28 "(T-152 r1) restoring dropped expressions deleted: drizzle-kit's drop on QA's table is a disagreement with pg_policy, refused" I-POLICY 'table "qa_secure": pgPolicy .*: (using|withCheck) is absent but pg_policy has "\(owner_id = CURRENT_USER\)"'

policy_fixture "$SHAPE_POLICIES"
mutate "$POLICY" "'permissive', pol.polpermissive," "'permissive', NOT pol.polpermissive,"
check K29 "(T-152 r1) permissive/restrictive: the catalogue reading inverted, refused" I-POLICY 'table "t152_ledger": pgPolicy .*: as "restrictive" but pg_policy has "permissive"'

policy_fixture "$SHAPE_POLICIES"
mutate "$POLICY" "json_agg(r.rolname ORDER BY r.rolname)" "json_agg(r.rolname ORDER BY r.rolname DESC)"
check K30 "(T-152 r1) roles: the catalogue's role list in another order, refused" I-POLICY 'table "t152_ledger": pgPolicy .*: to \["app_admin_rw","app_rw"\] but pg_policy has \["app_rw","app_admin_rw"\]'

policy_fixture "$SHAPE_POLICIES"
mutate "$POLICY" "  ['w', 'update']," "  ['w', 'insert'],"
check K31 "(T-152 r1) command: the catalogue's UPDATE read as INSERT, refused" I-POLICY 'pgPolicy .*: for "update" but pg_policy has "insert"'

policy_fixture "$QA_POLICIES"
mutate "$POLICY" "'name', pol.polname," "'name', pol.polname || '_t152',"
check K32 "(T-152 r1) the catalogue's policy names differ: a rendered policy with no pg_policy row AND a pg_policy row not rendered, refused" I-POLICY 'pg_policy has policy "qa_secure_alpha_t152", which the rendering does not contain'

mutate "$POLICY" "    FROM pg_policy pol" "    FROM pg_policy_t152 pol"
check K33 "(T-152 r1) the policy query unreadable, committed tree: refused" I-POLICY 'cannot read row-level security policies from the catalogue'

plant "$UP" "-- @phase: expand
CREATE TABLE public.t152_slash (id integer PRIMARY KEY, note text NOT NULL);
ALTER TABLE public.t152_slash ENABLE ROW LEVEL SECURITY;
CREATE POLICY t152_slash_select ON public.t152_slash FOR SELECT TO app_rw USING (note <> '\\d');"
plant "$DOWN" "DROP TABLE public.t152_slash;"
grep -qF "'\\d'" "$UP" || abort "the backslash did not land in $UP"
check K34 "(T-152 r1) a policy expression containing a backslash parses but cannot be written inside sql\`…\` byte for byte: refused" I-POLICY 'the expression .* cannot be written inside sql`…` byte for byte'

# A backtick does not reach that rule: drizzle-kit writes it raw, so its sql`…` no longer parses as one
# template literal, and the entry is refused as a shape the step does not know (measured, suite run 1).
TICK='`'
plant "$UP" "-- @phase: expand
CREATE TABLE public.t152_tick (id integer PRIMARY KEY, note text NOT NULL);
ALTER TABLE public.t152_tick ENABLE ROW LEVEL SECURITY;
CREATE POLICY t152_tick_select ON public.t152_tick FOR SELECT TO app_rw USING (note <> '${TICK}');"
plant "$DOWN" "DROP TABLE public.t152_tick;"
check K35 "(T-152 r1) a policy expression containing a backtick breaks drizzle-kit's template: refused as an unknown shape, never written" I-POLICY 'table "t152_tick": pgPolicy .* this step does not know'

echo "== T-145: schema pgboss admitted as deliberately out of scope (QA-A4, OD-90); every other schema outside public still I-SCOPE"
# The relations plant_jobschema creates, named here from the plant's SQL, not read from any output.
PGBOSS_RELS='j_t145 job t145_view version'

# plant_jobschema <schema as SQL> [extra up SQL] [extra down SQL]: migration NEXT creating, in that
# schema, an enum, a sequence, a plain table, a partitioned table with one partition, and a view. The
# extra SQL is appended to the up file and put first in the down file. plant() asserts both landed.
plant_jobschema() {
  local s=$1 xup=${2:-} xdown=${3:-}
  plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-145
CREATE SCHEMA $s;
CREATE TYPE $s.job_state AS ENUM ('created', 'completed');
CREATE SEQUENCE $s.t145_seq;
CREATE TABLE $s.version (version integer PRIMARY KEY);
CREATE TABLE $s.job (id uuid NOT NULL, name text NOT NULL, state $s.job_state NOT NULL) PARTITION BY LIST (name);
CREATE TABLE $s.j_t145 PARTITION OF $s.job FOR VALUES IN ('t145');
CREATE VIEW $s.t145_view AS SELECT name FROM $s.job;${xup:+
$xup}"
  plant "$DOWN" "${xdown:+$xdown
}DROP VIEW $s.t145_view;
DROP TABLE $s.job;
DROP TABLE $s.version;
DROP SEQUENCE $s.t145_seq;
DROP TYPE $s.job_state;
DROP SCHEMA $s;"
  sed 's/^/   plant up:   /' "$UP"
}

# scope_refused <schema name as the catalogue has it>: one regex per planted relation, each an I-SCOPE line.
scope_refused() {
  local r
  for r in $PGBOSS_RELS; do printf '%s\n' "^  - \\[I-SCOPE\\] relation \"$1\"\\.\"$r\" is owned by no extension and is outside schema public"; done
}

# check_facts <id> <description> <expected tags> <regex>...: run the check; every regex must match a
# line of the check's output, and a regex prefixed with ! must match none. Fact lines are collected
# apart from the output, so no regex can match another fact's text. The case is ok only if the exit,
# the banner, the exact tag set and every fact hold.
check_facts() {
  local id=$1 desc=$2 expect=$3 code n=0 miss=0 re
  shift 3
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  : >"$OUT.f"
  for re in "$@"; do
    n=$((n + 1))
    if [ "${re#!}" != "$re" ]; then
      if grep -qE -- "${re#!}" "$OUT"; then echo "fact MISMATCH (present, must be absent): ${re#!}" >>"$OUT.f"; miss=$((miss + 1)); else echo "fact ok (absent): ${re#!}" >>"$OUT.f"; fi
    elif grep -qE -- "$re" "$OUT"; then
      echo "fact ok (present): $re" >>"$OUT.f"
    else
      echo "fact MISMATCH (absent, must be present): $re" >>"$OUT.f"
      miss=$((miss + 1))
    fi
  done
  [ "$miss" -eq 0 ] && echo "ALL $n FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "$id" "$desc" "$expect" "$code" '^ALL [0-9]+ FACTS HOLD$'
  grep -E '^fact |^  out of scope: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
  restore
}

# sorted_words: newline- or comma-separated words -> one line, C-sorted, space-separated.
sorted_words() {
  tr ',' '\n' | sed -E 's/^ +//; s/ +$//' | grep -v '^$' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'
}

plant_jobschema pgboss
node scripts/db-introspect.ts --check >"$OUT" 2>&1
code=$?
: >"$OUT.f"
nf=0
nok=0
fact() {
  nf=$((nf + 1))
  if [ "$2" = "$3" ]; then
    nok=$((nok + 1))
    echo "fact ok: $1: [$2]" >>"$OUT.f"
  else
    echo "fact MISMATCH: $1: [$2] but expected [$3]" >>"$OUT.f"
  fi
}
want_admitted=$(for r in $PGBOSS_RELS; do echo "\"pgboss\".\"$r\""; done | sorted_words)
cat_admitted=$(psql -X -A -t -q -c "SELECT '\"' || n.nspname || '\".\"' || c.relname || '\"' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = 'pgboss'" | sorted_words)
gen_admitted=$(sed -nE 's/^  out of scope: [0-9]+ relation\(s\) in schema\(s\) "pgboss" admitted, not introspected and not counted \[(.*)\]$/\1/p' "$OUT" | sorted_words)
gen_owned=$(sed -nE 's/^  catalogue: .*; ([0-9]+) relation\(s\) owned by no extension in public$/\1/p' "$OUT")
gen_intro=$(sed -nE 's/^  drizzle-kit [^:]+: ([0-9]+) relation\(s\) introspected from public$/\1/p' "$OUT")
fact "the catalogue's relations in schema pgboss (psql, this run), as the plant names them" "$cat_admitted" "$want_admitted"
fact "the generator's out-of-scope list, as the catalogue" "$gen_admitted" "$cat_admitted"
fact "I-VACUOUS's catalogue side (owned by no extension in public), as psql counts public now" "$gen_owned" "$(owned_in_public)"
fact "I-VACUOUS's catalogue side, as K00 counted before any pgboss plant" "$gen_owned" "$OWNED"
fact "I-VACUOUS's rendering side (relations drizzle-kit introspected), as K00 counted" "$gen_intro" "$OWNED"
fact "db/schema.ts lines naming pgboss or any planted object" "$(grep -cE 'pgboss|job_state|t145|"version"|"job"' "$SCHEMA")" 0
node scripts/db-introspect.ts --write >"$OUT.w" 2>&1
fact "write mode, pgboss set planted: exit" "$?" 0
fact "write mode: git diff --quiet db/schema.ts against the committed file, exit" "$(git diff --quiet -- "$SCHEMA" && echo 0 || echo 1)" 0
[ "$nok" -eq "$nf" ] && echo "ALL $nf CONTROL FACTS HOLD" >>"$OUT.f"
cat "$OUT.f" >>"$OUT"
judge K36 "(T-145) CONTROL: an enum, sequence, table, partitioned table + partition and view in schema pgboss: GATE PASS, absent from db/schema.ts (check and write), not counted by I-VACUOUS" PASS "$code" '^ALL [0-9]+ CONTROL FACTS HOLD$'
grep -E '^fact |^  out of scope: |^  catalogue: |^  drizzle-kit [^:]+: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
restore

for pair in 'K37a pgboss_x pgboss_x' 'K37c "PgBoss" PgBoss'; do
  read -r kid ssql sname <<<"$pair"
  plant_jobschema "$ssql"
  mapfile -t refused < <(scope_refused "$sname")
  check_facts "$kid" "(T-145) (i) the same set in near-miss schema $ssql: every relation I-SCOPE, none admitted" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}" '^  out of scope: 0 relation\(s\)'
done

# pg_boss: PostgreSQL itself refuses a schema whose name starts with pg_ (42939), so an ordinary
# migration cannot create one (measured, suite run 1: the unmodified plant failed I-MIGRATE). K37b0
# asserts that refusal; K37b then plants the same set with allow_system_table_mods on, so the scope
# rule is still tested against a relation in pg_boss.
total=$((total + 1))
psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "CREATE SCHEMA pg_boss" >"$OUT" 2>&1
code=$?
left=$(psql -X -A -t -q -c "SELECT count(*) FROM pg_namespace WHERE nspname = 'pg_boss'")
if [ "$code" -ne 0 ] && grep -q '42939: unacceptable schema name "pg_boss"' "$OUT" && [ "$left" = 0 ]; then v=ok; else v=BAD; bad=$((bad + 1)); fi
printf '%-4s %s  %s\n       psql exit %s; pg_namespace rows named pg_boss afterwards %s\n' "$v" K37b0 "(T-145) (i) CREATE SCHEMA pg_boss, as the superuser: the database refuses it, 42939, and nothing is created" "$code" "$left"
grep -E '^ERROR|^DETAIL' "$OUT" | sed 's/^/       /'
plant_jobschema pg_boss
{ [ "$(sed -n 3p "$UP")" = "CREATE SCHEMA pg_boss;" ] && [ "$(sed -n '$p' "$DOWN")" = "DROP SCHEMA pg_boss;" ]; } || abort "the pg_boss plant is not in the expected form"
plant "$UP" "$(sed '2a SET allow_system_table_mods = on;' "$UP")"
plant "$DOWN" "$(printf 'SET allow_system_table_mods = on;\n'; cat "$DOWN")"
grep -qx 'SET allow_system_table_mods = on;' "$UP" || abort "allow_system_table_mods did not land in $UP"
sed 's/^/   plant up:   /' "$UP"
mapfile -t refused < <(scope_refused pg_boss)
check_facts K37b "(T-145) (i) pg_boss, planted only as a superuser with allow_system_table_mods (a migration cannot create it, K37b0): the name comparison does not take pg_boss for pgboss, every relation I-SCOPE" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}" '^  out of scope: 0 relation\(s\)'

plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-145
CREATE TABLE kinvara_guard.t145_plant (id bigint PRIMARY KEY);"
plant "$DOWN" "DROP TABLE kinvara_guard.t145_plant;"
sed 's/^/   plant up:   /' "$UP"
check_facts K38 "(T-145) (ii) a relation in kinvara_guard: still I-SCOPE" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" '^  - \[I-SCOPE\] relation "kinvara_guard"\."t145_plant" is owned by no extension' '^  out of scope: 0 relation\(s\)'

plant_jobschema pgboss
mapfile -t refused < <(scope_refused pgboss)
mutate "$SCRIPT" "const OUT_OF_SCOPE_SCHEMAS: readonly string[] = ['pgboss'];" "const OUT_OF_SCOPE_SCHEMAS: readonly string[] = [];"
git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check_facts K39a "(T-145) (iii) the rule deleted (OUT_OF_SCOPE_SCHEMAS emptied): the K36 control plant goes red" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}" '^  out of scope: 0 relation\(s\)'

plant_jobschema pgboss
mutate "$SCRIPT" "    (r) => !r.extensionMember && r.schema !== INTROSPECTED_SCHEMA && !admitted(r)," "    (r) => !r.extensionMember && r.schema !== INTROSPECTED_SCHEMA,"
git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check_facts K39b "(T-145) (iii) the rule deleted (the exclusion clause removed from the I-SCOPE refusal): the K36 control plant goes red" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}"

plant_jobschema pgboss "CREATE TABLE public.t145_plant (id bigint PRIMARY KEY);
GRANT SELECT ON public.t145_plant TO app_rw;" "DROP TABLE public.t145_plant;"
check_facts K40 "(T-145) (iv) a public table beside the pgboss set, db/schema.ts not regenerated: still I-DIFF, and only I-DIFF" I-DIFF "MIGRATE OK  up: $HIGHEST -> $NEXT" '^  out of scope: 4 relation\(s\) in schema\(s\) "pgboss" admitted' "^  catalogue: .*; $((OWNED + 1)) relation\\(s\\) owned by no extension in public\$" '!\[I-SCOPE\]'

plant_jobschema pgboss "CREATE SCHEMA pgboss_x;
CREATE TABLE pgboss_x.job (id bigint PRIMARY KEY);" "DROP TABLE pgboss_x.job;
DROP SCHEMA pgboss_x;"
check_facts K41 "(T-145) pgboss beside pgboss_x: admission is per relation, by schema name; I-SCOPE names pgboss_x.job and no pgboss relation" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" '^  - \[I-SCOPE\] relation "pgboss_x"\."job" is owned by no extension' '!^  - \[I-SCOPE\] relation "pgboss"\.' '^  out of scope: 4 relation\(s\) in schema\(s\) "pgboss" admitted'

echo "== T-145 rework 1 (QR-F1, QR-A1, OD-140): schema names main's trim/split text read re-parsed. Each is I-SCOPE and named unambiguously; each gets past I-SCOPE again with that read restored"
# The committed read (psql(CATALOGUE_SQL) + parseCatalogue) and, verbatim, main 94e6896's text read and
# trim/split parse that the mutation puts back (the parse also derives schemaHex from the re-parsed field,
# which is exactly what the defect compared).
READ_NEW='  const cat = psql(CATALOGUE_SQL);'
PARSE_NEW='  const parsed = parseCatalogue(cat.out);'
READ_OLD=$(
  cat <<'EOF'
  const cat = psql(`
    SELECT n.nspname || '|' || c.relname || '|' ||
           (EXISTS (SELECT 1 FROM pg_depend d
                     WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'))::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp\\_%'
     ORDER BY 1`);
EOF
)
PARSE_OLD=$(
  cat <<'EOF'
  const parsed = {
    ok: true as const,
    rows: cat.out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map((l) => {
        const [schema = '', name = '', ext = ''] = l.split('|');
        return { schema, schemaHex: Buffer.from(schema, 'utf8').toString('hex'), name, extensionMember: ext === 'true' };
      }),
  };
EOF
)

# restore_text_read: put main's read back, and assert both halves landed and the new read is gone.
restore_text_read() {
  mutate "$SCRIPT" "$READ_NEW" "$READ_OLD"
  mutate "$SCRIPT" "$PARSE_NEW" "$PARSE_OLD"
  { ! grep -qF 'psql(CATALOGUE_SQL)' "$SCRIPT" && ! grep -qF 'parseCatalogue(cat.out)' "$SCRIPT" && grep -qF "l.split('|')" "$SCRIPT" && grep -qF ".map((l) => l.trim())" "$SCRIPT" && grep -qF "SELECT n.nspname || '|' || c.relname || '|' ||" "$SCRIPT"; } || abort "main's trim/split read did not land in $SCRIPT"
  git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
}

# facts_into <regex>...: one fact line per regex into $OUT.f (a leading ! = must NOT match $OUT); sets $miss.
facts_into() {
  local re
  miss=0
  for re in "$@"; do
    if [ "${re#!}" != "$re" ]; then
      if grep -qE -- "${re#!}" "$OUT"; then echo "fact MISMATCH (present, must be absent): ${re#!}" >>"$OUT.f"; miss=$((miss + 1)); else echo "fact ok (absent): ${re#!}" >>"$OUT.f"; fi
    elif grep -qE -- "$re" "$OUT"; then
      echo "fact ok (present): $re" >>"$OUT.f"
    else
      echo "fact MISMATCH (absent, must be present): $re" >>"$OUT.f"
      miss=$((miss + 1))
    fi
  done
}

# landed_fact <wanted hex>: the plant's nspname bytes, read from pg_namespace, must be the bytes the case
# derived with printf; adds to $miss.
landed_fact() {
  local got
  got=$(psql -X -A -t -q -c "SELECT string_agg(encode(convert_to(n.nspname, 'UTF8'), 'hex'), ',') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 't145_t'")
  if [ "$got" = "$1" ]; then echo "fact ok: plant landed, pg_namespace.nspname bytes [$got]" >>"$OUT.f"; else echo "fact MISMATCH: nspname bytes [$got], the plant intended [$1]" >>"$OUT.f"; miss=$((miss + 1)); fi
}

# shape_case <id> <schema as SQL> <schema bytes, printf %b> <the name as the check must print it, ERE>
#            <fact the restored read must produce>...
shape_case() {
  local id=$1 ident=$2 bytes=$3 shown=$4 want code
  shift 4
  want=$(printf '%b' "$bytes" | od -An -tx1 | tr -d ' \n')
  plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-145
CREATE SCHEMA $ident;
CREATE TABLE $ident.t145_t (id bigint PRIMARY KEY);"
  plant "$DOWN" "DROP TABLE $ident.t145_t;
DROP SCHEMA $ident;"
  sed 's/^/   plant up:   /' "$UP"
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  : >"$OUT.f"
  facts_into "MIGRATE OK  up: $HIGHEST -> $NEXT" "^  - \\[I-SCOPE\\] relation $shown\\.\"t145_t\" is owned by no extension and is outside schema public" '^  out of scope: 0 relation\(s\)'
  landed_fact "$want"
  [ "$miss" -eq 0 ] && echo "ALL SHAPE FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "$id" "(T-145 r1) schema $ident, bytes $want: I-SCOPE, named $shown, not admitted" I-SCOPE "$code" '^ALL SHAPE FACTS HOLD$'
  grep -E '^fact ' "$OUT" | cut -c1-240 | sed 's/^/       /'
  restore_text_read
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  : >"$OUT.f"
  facts_into "$@"
  landed_fact "$want"
  [ "$miss" -eq 0 ] && echo "ALL RESTORED-READ FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "${id}m" "(T-145 r1) RED BEFORE: main's trim/split read restored (asserted above), the same plant gets past I-SCOPE" PASS "$code" '^ALL RESTORED-READ FACTS HOLD$'
  grep -E '^fact |^  out of scope: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
  restore
}

ADMITTED_T='^  out of scope: 1 relation\(s\) in schema\(s\) "pgboss" admitted, not introspected and not counted \["pgboss"\."t145_t"\]$'
shape_case K42 '" pgboss"' ' pgboss' '" pgboss"' "$ADMITTED_T"
shape_case K43 'U&"\00A0pgboss"' '\xc2\xa0pgboss' '"\\u00a0pgboss"' "$ADMITTED_T"
shape_case K44 'U&"\FEFFpgboss"' '\xef\xbb\xbfpgboss' '"\\ufeffpgboss"' "$ADMITTED_T"
shape_case K45 'U&"\0009pgboss"' '\tpgboss' '"\\tpgboss"' "$ADMITTED_T"
shape_case K46 'U&"\000Apgboss"' '\npgboss' '"\\npgboss"' "$ADMITTED_T"
shape_case K47 '"pgboss|x"' 'pgboss|x' '"pgboss\|x"' '^  out of scope: 1 relation\(s\) in schema\(s\) "pgboss" admitted, not introspected and not counted \["pgboss"\."x"\]$'
# QR-A1 (main's own defect): with the text read, "<any>|x|true" parses as an extension member, so the
# relation is on no list at all: GATE PASS, out of scope 0, and its name nowhere in the output.
shape_case K48 '"pgboss|x|true"' 'pgboss|x|true' '"pgboss\|x\|true"' '^  out of scope: 0 relation\(s\)' '!t145_t'
shape_case K49 '"zz_other|x|true"' 'zz_other|x|true' '"zz_other\|x\|true"' '^  out of scope: 0 relation\(s\)' '!t145_t'

echo
if [ "$bad" -eq 0 ]; then
  echo "ALL $total CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $total cases misbehaved"
exit 1
