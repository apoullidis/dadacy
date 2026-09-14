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
  git checkout -q -- "$SCHEMA" "$SCRIPT" "$RENDER" "$ORDER"
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

node scripts/db-migrate.ts up >"$OUT.m" 2>&1 || { cat "$OUT.m"; abort "db:migrate up failed before the first case"; }
[ "$(record)" = "kinvara-migrate version=$HIGHEST" ] || abort "the record reads '$(record)' after db:migrate up, not $HIGHEST"

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

echo
if [ "$bad" -eq 0 ]; then
  echo "ALL $total CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $total cases misbehaved"
exit 1
