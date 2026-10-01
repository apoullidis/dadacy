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
# T-153 — K50–K57 (OD-107): bigint and PostGIS geometry. K50 is the control: a bigint plant (identity PK,
# FK, NOT NULL, nullable, DEFAULT 0, bigint[] with a default above 2^53, int8, a view) is written in
# drizzle's bigint mode, read and written exactly through pg/drizzle, re-checked after ANALYZE, and an
# importer is refused a number with exactly TS2322. K51 deletes the rewrite (the text guard refuses), K52
# the rewrite and its guard (the per-column catalogue match refuses; rework 1 replaced the count), K53 the whole mapping (RED BEFORE: number
# mode, 9007199254740993 read as ...992, the importer's refusals inverted). K54 makes the column-type query
# unreadable. K55 is the geometry control (scalar Point with and without SRID, read and written); K56/K56w
# plant every other geometry shape and a Point[] (I-MAP, check and write mode); K57 deletes the rule (RED
# BEFORE: the plant passes and a polygon select throws).
#
# T-153 rework 1 — K58-K62 (OD-147, OD-148): the per-relation COUNT is replaced by a PER-COLUMN match
# against the catalogue, over the rendering parsed as TypeScript. K58/K59 plant a VIEW and a
# MATERIALIZED VIEW over a bigint[] column, which drizzle-kit renders with no `.array()`; K60 is the
# RED BEFORE with the count restored (they pass, and drizzle's read of each throws). The loss is NOT
# specific to bigint: drizzle-kit 0.31.10 renders EVERY array column of a view or materialized view with
# no .array() (text[], numeric[], timestamptz[] too; OD-149). K60 asserts it for the text[] column of the
# same view, from db/schema.ts. The per-column match holds int8 only, so a non-int8 view array column
# passes the gate typed as a scalar; that general case is T-187's (OE-35 (A)). K61/K62 are the
# false refusals the old text-shaped mechanisms produced on drizzle-kit's own output — a text DEFAULT
# holding a bigint-mode call, and one equal to the hint sentence - each with its own RED BEFORE.
#
# T-165 — K150–K164 (OD-84): drizzle-kit lists relations with relkind IN ('r','v','m'), so a PARTITIONED
# table is never rendered and each of its PARTITIONS is rendered as a plain table. The generator now
# renders every partitioned table in public under its own name, from the first of its partitions in
# public, with every constraint and index name mapped to the parent's by the catalogue and the
# parent's policies added from pg_policy; the partitions leave the rendering and are on neither side
# of I-VACUOUS (scripts/gates/lib/schema-partition.ts, [I-PART]). K150 is the control fixture
# (db-introspect-partitioned.sql, whose `-- expect:`/`-- absent:` lines are written from the SQL),
# K151–K154 are determinism and a partition attached after the file was written, K155–K161 the drifts and
# shapes it refuses, K162–K163 the rule deleted two ways (I-VACUOUS, as before this ticket), K164 the
# catalogue read.
# T-165 — K165–K167 (OD-145): a relation in information_schema, pg_catalog or a pg_toast* schema reached
# no check at all and the run passed. The catalogue read now also takes every relation of kind
# r/p/v/m/f in those schemas whose oid is >= 16384, so it is I-SCOPE. Each case plants one as the
# superuser (two need allow_system_table_mods) and is then re-run with main's schema filter restored.
# T-165 rework 1 — K150a, K172–K180 (OD-155, OD-156): every partition's own constraints, indexes,
# triggers and policies are read, not only the template's; each `m` variant restores the old reading.
# T-165 rework 2 (OE-37 (A)) — K181–K189. K181/K182a/K182b (OD-157): the mirror — every constraint and
# index the PARENT owns needs a counterpart on EVERY partition, including after an attach that changes
# the template; each `m` variant restores the template-only mirror. K183–K186 (OD-158): a RULE, an
# extended statistics object and a non-default REPLICA IDENTITY on a partition are read (never cloned
# by PostgreSQL, so always the partition's own); each `m` variant removes that branch of the read.
# K187 is the control (the same three on the PARENT), K188 a stated bound (a partition disabling its
# cloned trigger is NOT read). K189: the merge with T-153 — step 5a's partition exclusion removed.
# (T-165's cases were K50–K80 until rework 2 renumbered them by +100 past T-153's K50–K62r.)
# T-232 (OD-246): no case assumes what the committed migration set contains. Every count a case pins
# (int8 and geometry columns, policies, partitioned tables and partitions, relations) is BASE + the
# plant's own share, BASE read once from the catalogue at HIGHEST and held against the generator's
# reading of the committed tree; K162 compares both I-VACUOUS lists whole instead of pinning the last
# name. T-232 rework 1/2 (QA-F1, QA-R-F1): a fact about the plant's rendering is counted inside the plant's
# own declaration in db/schema.ts (block_count), or as the plant's share (lines now minus lines in the
# committed file), or against a psql-derived name set. T-234 (QA-S-F1): seven whole-file searches of
# db/schema.ts remain, each justified in scripts/gates/classify-introspect-reads.py's WHOLE_FILE_OK:
#   - for a literal that names a plant object: K04's landed-assert (`pgTable("t138_plant"`); policy_check's
#     fixture `-- expect:` lines, each naming its own policy (K26a-c, K27); part_expectations' t165_part* /
#     t165Part* lines, `-- expect:` and `-- absent:` (K150-K154, two lines); K22's t152_* key lists;
#   - for a name set read from psql: K36's rendered relation names that only schema pgboss has;
#   - for a literal that names NO plant object: K11w, `! grep -q 'unknown(' "$SCHEMA"`, sound only because
#     the same condition requires git diff to find the file equal to the committed one, and a committed
#     file holding `unknown(` fails K00's parity first (the generator never writes it, T-150).
# rehash() also reads and rewrites the whole file: that is the tamper itself, and nothing is judged from it.
# gate:negative-suites runs that classifier over this file on every run, with no database. It goes red
# on: an unjustified whole-file read in a spelling the classifier recognises ($SCHEMA, ${SCHEMA...}, the
# literal path, a glob under db/, quoted or not, outside a message); a read of the committed file not
# subtracted from the same read of the working file; a copied or out-of-scope exemption; or an
# unclassifiable line. What it is measured to catch is exactly its fixture
# (scripts/gates/classify-introspect-reads.fixture). It does NOT see a path assembled from pieces, an
# alias through another name or a copy, eval, a command held in a variable, or a read split across a
# backslash continuation: those are caught only when the line judging the result is unclassifiable
# (bounds in the classifier's docstring and tasks/state/EP-2/T-234.md). See the BASE block below.
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
#
# T-168: EXIT/INT/TERM traps call restore_tree(), so an INTERRUPTED run puts db/schema.ts (deleted
# by K05) back too — see the block beside the traps, including what they deliberately do NOT do.
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
PARTITION=scripts/gates/lib/schema-partition.ts
QA_POLICIES=scripts/negative-tests/db-introspect-policies-qa.sql
SHAPE_POLICIES=scripts/negative-tests/db-introspect-policies-shapes.sql
PART_FIXTURE=scripts/negative-tests/db-introspect-partitioned.sql
OUT=$(mktemp)
total=0
bad=0
echo "highest committed migration $HIGHEST; plants are numbered $NEXT"

record() {
  psql -X -A -t -q -c "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()"
}

# T-232: NOT relispartition — the generator's owned set (step 3) leaves partitions out, so a committed
# partitioned table's partitions must not be counted here either (identical while public has none).
owned_in_public() {
  psql -X -A -t -q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = 'public' AND NOT c.relispartition AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')"
}

# T-165 rework 1 (QR-A4): an abort must leave no debris. A plant left in db/migrations, a written
# db/schema.ts or a database at $NEXT is measured by whatever runs next — qa-verification's gate:pr
# failed on this ticket's leftovers rather than on the commit. The database is brought back FIRST,
# while the plant's down file still exists, then the files go.
cleanup_after_abort() {
  echo "   abort cleanup: bringing the database back to $HIGHEST and restoring the tree"
  if [ "$(record)" != "kinvara-migrate version=$HIGHEST" ]; then
    node scripts/db-migrate.ts down --to "$HIGHEST" >"$OUT.abort" 2>&1 || cat "$OUT.abort"
  fi
  rm -f "$M/${NEXT}_t138_plant.up.sql" "$M/${NEXT}_t138_plant.down.sql" "${T153_BITE:-}"
  git checkout -q -- "$SCHEMA" "$SCRIPT" "$RENDER" "$ORDER" "$POLICY" "$PARTITION"
  echo "   abort cleanup: record now '$(record)'; git status --porcelain:"
  git status --porcelain
}

abort() {
  echo "ABORT: $1"
  cleanup_after_abort
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

# T-153: the importer K50/K53 plant into the root program; restore_tree() removes it.
T153_BITE=packages/db-testkit/type-tests/t153-bite.ts

# T-168 (OD-161). restore_tree is the working-tree half of restore(), split out UNCHANGED so the
# traps below can call it on its own. It needs no database, which is the whole point: the tracked
# path this suite deletes (K05 removes db/schema.ts outright) must come back even when the database
# is unreachable — and it is reached through `git checkout`, because git already has these files.
# The halves cannot be reordered: rolling the planted migration back needs its down file, which
# restore_tree deletes.
# (T-153 merge of main 3385ede: T-153's `rm -f "$T153_BITE"` is a working-tree action, so it moved
# from the top of restore() into this half, where the traps reach it too.)
restore_tree() {
  rm -f "$T153_BITE"
  rm -f "$M/${NEXT}_t138_plant.up.sql" "$M/${NEXT}_t138_plant.down.sql"
  git checkout -q -- "$SCHEMA" "$SCRIPT" "$RENDER" "$ORDER" "$POLICY" "$PARTITION"
  if [ -n "$(git status --porcelain)" ]; then
    git status --porcelain
    abort "the tree did not restore cleanly"
  fi
}

restore() {
  if [ "$(record)" != "kinvara-migrate version=$HIGHEST" ]; then
    node scripts/db-migrate.ts down --to "$HIGHEST" >"$OUT.down" 2>&1
    grep -q '^MIGRATE OK  down: ' "$OUT.down" || { cat "$OUT.down"; abort "could not bring the database back to $HIGHEST"; }
  fi
  [ "$(record)" = "kinvara-migrate version=$HIGHEST" ] || abort "the record reads '$(record)', not $HIGHEST"
  restore_tree
}

# Every case calls restore() explicitly, so a COMPLETE run already put the tree back. These traps
# close the interrupt window: between `rm -f "$SCHEMA"` (K05) and the next restore(), the TRACKED
# db/schema.ts is deleted, and until this ticket a Ctrl-C there left it deleted.
#
# The traps restore the TREE, not the database, and that is deliberate rather than an omission. The
# database is this ticket's own ephemeral compose project; a tracked file is not. Calling the full
# restore() from a trap would put the database half first, and an unreachable database would then
# abort BEFORE db/schema.ts was ever checked out — the trap would fail in exactly the direction it
# exists to prevent.
#
# What that costs, stated plainly because it is a CONSEQUENCE ACCEPTED and not a non-effect (T-168
# rework 1, QR-F1; measured by QA on both sides with a real database). An interrupt after the plant
# has been applied leaves the database ADVANCED PAST WHAT THIS DIRECTORY CAN REVERT: the record
# still reads $NEXT, and restore_tree has already deleted ${NEXT}_t138_plant.down.sql, which is the
# one file `node scripts/db-migrate.ts down` would need. That command then answers
#   MIGRATE REFUSED  the database records version <NEXT>, but the directory's highest migration is
#                    <HIGHEST>: a recorded migration has no file          (exit 2)
# and this suite cannot start again on that database at all — its own first act is `db:migrate up`,
# which is refused the same way, so the run ends at `ABORT: db:migrate up failed before the first
# case`. The remedy is to DISPOSE OF THE DATABASE, which `scripts/svc down <ticket>` does (it is
# `docker compose down --volumes`, scripts/svc:580); the volume goes and the next `svc up` starts
# from nothing. Without the traps — i.e. on main c27c354 — the down file survives and `db:migrate
# down --to <HIGHEST>` still returns `MIGRATE OK`, so this is a real regression in the DATABASE
# half, deliberately taken: the tree half is the one that protects COMMITTED SOURCE, the database
# is this ticket's own ephemeral compose project, and a tracked file is not.
#
# restore_tree aborts (exit 2) when the tree does not come back clean, so "restored", "could not
# restore" and "was never touched" stay three distinguishable outcomes from inside a trap too.
trap 'restore_tree; rm -f "$OUT" "$OUT".*' EXIT
trap 'echo; echo "INTERRUPTED (SIGINT) — restoring the working tree"; restore_tree; trap - EXIT; exit 130' INT
trap 'echo; echo "TERMINATED (SIGTERM) — restoring the working tree"; restore_tree; trap - EXIT; exit 143' TERM

# plant <file> <content>: write, then assert the bytes on disk are the bytes intended.
plant() {
  printf '%s\n' "$2" >"$1"
  [ "$(cat "$1")" = "$2" ] || abort "the plant did not land in $1"
}

# T-232 rework 1 (QA-F1): block_count [-x] <export> <text>: lines of db/schema.ts INSIDE the plant's own
# declaration (from `export const <export> = ` to the next `export const`) containing (-x: equal to)
# <text>. A fact about the plant's rendering is counted there, never over the whole file, because a
# committed relation renders the same lines (a bigint identity `id`, an `amount_minor bigint`, a
# `bigint[]`), and a whole-file count then encodes "the committed set renders no such line".
# block_count prints -1 when the declaration is absent, so no expectation (0 included) passes on a
# block that is not there.
block_count() {
  local x=
  if [ "$1" = -x ]; then x=x; shift; fi
  grep -q "^export const $1 = " "$SCHEMA" || { echo -1; return; }
  awk -v n="export const $1 = " 'index($0, "export const ") == 1 { p = (index($0, n) == 1) } p' "$SCHEMA" | grep -c${x}F -- "$2"
}
# head_count <text>: the same text's lines in the COMMITTED db/schema.ts (HEAD), for a fact about a token
# that has no plant declaration to be scoped to: the plant's share is the count now minus this.
head_count() { git show HEAD:"$SCHEMA" | grep -cF -- "$1"; }

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

check() {
  local id=$1 desc=$2 expect=$3 require=${4:-}
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  judge "$id" "$desc" "$expect" "$?" "$require"
  restore
}

# (T-232: moved up from the T-145 block, unchanged, so K06/K07 can use it.)
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

# T-165 rework 1 (QR-A4): a forced abort, to show that the abort path leaves no debris. It plants,
# writes db/schema.ts and migrates to $NEXT first, so the abort happens at the dirtiest moment there
# is. Not reached in a normal run.
if [ "${T165_ABORT_DEMO:-}" = 1 ]; then
  plant "$M/${NEXT}_t138_plant.up.sql" "-- @phase: expand
CREATE TABLE public.t165_abort (id bigint PRIMARY KEY);
GRANT SELECT ON public.t165_abort TO app_rw;"
  plant "$M/${NEXT}_t138_plant.down.sql" "DROP TABLE public.t165_abort;"
  node scripts/db-introspect.ts --write >"$OUT.demo" 2>&1
  echo "   forced abort demo: write exit $?, record '$(record)', tree:"
  git status --porcelain
  abort "T165_ABORT_DEMO=1: a forced abort with db/schema.ts written, both plant files present and the database at $NEXT"
fi

# T-165 rework 1 (QR-A3): the partitioned-table control block runs FIRST, so that its first write
# sees a catalogue nobody has ANALYZEd — K26b runs an ANALYZE, and until this rework K150 ran after
# it. Neither this block nor the policy block that follows analyses anything, so both still meet an
# un-analysed catalogue on a fresh project. OWNED is read here because this block needs it.
# T-232 (OD-246): THE COMMITTED MIGRATION SET'S OWN SHARE OF EVERY COUNT A CASE ASSERTS. Until this
# ticket K50, K58-K62, K150-K154, K26, K27, K55 and K56 pinned counts that were true only while `public`
# held no int8 column, no geometry column, no row-level security policy and no partitioned table of its
# own, and K162 pinned `t165_part_q2` as the LAST name in drizzle-kit's list. 0016 (T-196) added the
# first int8 column and a table sorting after t165_*, and seven cases went BAD with nothing wrong in
# the mechanism (OD-246; K18 was the same class, OD-218/T-188). Each such count is now BASE + what the
# case's own plant adds: the plant's share is written from the plant's SQL, as before; BASE is read
# here, ONCE, at $HIGHEST before any plant, from the catalogue by psql, never from the generator's
# output. Then the generator's own reading of the committed tree is taken and every BASE psql can
# count must equal it, or the run ABORTs naming the one that differs: the psql reading and the
# generator's are two readings of one catalogue, so neither is taken on the other's word. Only the two
# policy tallies that depend on what drizzle-kit dropped (`restored`, `rewritten`) come from that run,
# bounded by psql's policy count (0 policies => both 0). At BASE 0 (main a6e64b3) every expectation
# below is the constant it replaced.
ext_free="NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')"
int8_cols="SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid JOIN pg_type et ON et.oid = CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE t.oid END WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND et.oid = 'pg_catalog.int8'::regtype AND $ext_free"
# int8 columns the per-column match holds: relkind r/p/v/m/f, partitions held through their parent (step 5a).
BASE_INT8=$(psql -X -A -t -q -c "$int8_cols AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition")
# int8 columns drizzle-kit pulls and step 4a rewrites: its own relation list is relkind r/v/m, so a
# partition is pulled as a table and a partitioned parent is not.
BASE_INT8_PULLED=$(psql -X -A -t -q -c "$int8_cols AND c.relkind IN ('r','v','m')")
BASE_POINTS=$(psql -X -A -t -q -c "SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) ~ '^geometry\(Point(,[0-9]+)?\)$' AND $ext_free")
BASE_POLICIES=$(psql -X -A -t -q -c "SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT c.relispartition AND $ext_free")
BASE_PARENTS=$(psql -X -A -t -q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'p' AND NOT c.relispartition AND $ext_free")
BASE_PARENT_POLICIES=$(psql -X -A -t -q -c "SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'p' AND NOT c.relispartition AND $ext_free")
BASE_PARTITION_NAMES=$(psql -X -A -t -q -c "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relispartition AND c.relkind IN ('r','p','v','m','f') AND $ext_free ORDER BY c.relname")
BASE_PARTITIONS=$(printf '%s' "$BASE_PARTITION_NAMES" | grep -c .)
BASE_PARENT_NAMES=$(psql -X -A -t -q -c "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'p' AND NOT c.relispartition AND $ext_free ORDER BY c.relname")
# The names on each side of I-VACUOUS: drizzle-kit's pull (r/v/m, partitions included) and the
# catalogue's owned set (r/p/v/m/f, partitions excluded). K162 compares both lists whole.
BASE_PULLED_NAMES=$(psql -X -A -t -q -c "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m') AND $ext_free")
BASE_OWNED_NAMES=$(psql -X -A -t -q -c "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND $ext_free")
BASE_OWNED=$(printf '%s' "$BASE_OWNED_NAMES" | grep -c .)
for v in BASE_INT8 BASE_INT8_PULLED BASE_POINTS BASE_POLICIES BASE_PARENTS BASE_PARENT_POLICIES BASE_OWNED; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || abort "the catalogue read for $v returned '${!v}', not a count"
done

# c_list <name>...: names -> C-sorted (the catalogue's `name` collation and JS's code-unit sort agree on
# these), joined ", " exactly as the generator joins them.
c_list() { printf '%s\n' "$@" | grep -v '^$' | LC_ALL=C sort | paste -sd, - | sed 's/,/, /g'; }
# json_list <name>...: the same, each JSON-quoted, as the generator's catalogue line prints partitions.
json_list() { printf '%s\n' "$@" | grep -v '^$' | LC_ALL=C sort | sed 's/.*/"&"/' | paste -sd, - | sed 's/,/, /g'; }
# ere <text>: <text> as an ERE matching itself (names here are [a-z0-9_]; brackets, parens, dots and quotes escaped).
ere() { printf '%s' "$1" | sed -E 's/[][().*+?^$|\\{}]/\\&/g'; }

node scripts/db-introspect.ts --check >"$OUT.base" 2>&1 || { cat "$OUT.base"; abort "the committed tree does not pass db:introspect:check at $HIGHEST, so no count below can be derived"; }
b_line() { grep -E "^  $1: " "$OUT.base" | head -1; }
b_num() { printf '%s\n' "$1" | sed -nE "s/.*$2.*/\\1/p"; }
L_BIG=$(b_line bigint)
L_POL=$(b_line policies)
L_PART=$(b_line partitions)
L_CAT=$(b_line catalogue)
GEN_REWRITTEN=$(b_num "$L_BIG" '  bigint: ([0-9]+) column\(s\) rewritten')
GEN_MATCHED=$(b_num "$L_BIG" '; ([0-9]+) of the catalogue.s [0-9]+ int8')
GEN_INT8=$(b_num "$L_BIG" "of the catalogue.s ([0-9]+) int8")
GEN_POINTS=$(b_num "$L_BIG" 'geometry: ([0-9]+) point column')
GEN_POLICIES=$(b_num "$L_POL" '  policies: ([0-9]+) checked')
BASE_RESTORED=$(b_num "$L_POL" '; ([0-9]+) expression\(s\) drizzle-kit dropped restored')
BASE_REWRITTEN=$(b_num "$L_POL" '; ([0-9]+) entr\(ies\) rewritten from the catalogue')
GEN_PARENTS=$(b_num "$L_PART" '  partitions: ([0-9]+) partitioned table')
BASE_REMOVED=$(b_num "$L_PART" '; ([0-9]+) partition declaration\(s\) removed')
GEN_PARENT_POLICIES=$(b_num "$L_PART" '; ([0-9]+) policy entr\(ies\) added from pg_policy')
GEN_PARTITIONS=$(b_num "$L_CAT" '; ([0-9]+) partition\(s\) in public excluded')
GEN_PARTITION_LIST=$(b_num "$L_CAT" 'partition\(s\) in public excluded \[(.*)\]; [0-9]+ relation')
GEN_OWNED=$(b_num "$L_CAT" '; ([0-9]+) relation\(s\) owned by no extension in public')
# name psql's value : generator's value (both from the committed tree at $HIGHEST)
for pair in "int8 columns the match holds:$BASE_INT8:$GEN_INT8" "int8 columns matched:$BASE_INT8:$GEN_MATCHED" \
  "int8 columns drizzle-kit pulls, rewritten:$BASE_INT8_PULLED:$GEN_REWRITTEN" "geometry point columns:$BASE_POINTS:$GEN_POINTS" \
  "policies checked:$BASE_POLICIES:$GEN_POLICIES" "partitioned tables rendered:$BASE_PARENTS:$GEN_PARENTS" \
  "policy entries added to parents:$BASE_PARENT_POLICIES:$GEN_PARENT_POLICIES" "partitions excluded:$BASE_PARTITIONS:$GEN_PARTITIONS" \
  "partition declarations removed (partitions - parents):$((BASE_PARTITIONS - BASE_PARENTS)):$BASE_REMOVED" \
  "partition list:$(json_list $BASE_PARTITION_NAMES):$GEN_PARTITION_LIST" "relations owned in public:$BASE_OWNED:$GEN_OWNED"; do
  IFS=: read -r what want got <<<"$pair"
  [ "$want" = "$got" ] || abort "BASE: $what: psql reads [$want] from the catalogue but the generator reported [$got] on the committed tree ($L_BIG | $L_POL | $L_PART | $L_CAT)"
done
[[ "$BASE_RESTORED" =~ ^[0-9]+$ && "$BASE_REWRITTEN" =~ ^[0-9]+$ ]] || abort "BASE: the generator's policies line has no restored/rewritten counts: [$L_POL]"
{ [ "$BASE_RESTORED" -le $((2 * BASE_POLICIES)) ] && [ "$BASE_REWRITTEN" -le "$BASE_POLICIES" ]; } || abort "BASE: $BASE_RESTORED expression(s) restored and $BASE_REWRITTEN entr(ies) rewritten, but psql counts $BASE_POLICIES polic(ies) (at most 2 expressions each)"
[ "$(printf '%s' "$BASE_PARENT_NAMES" | grep -c .)" = "$BASE_PARENTS" ] || abort "BASE: the partitioned-table names and count disagree"
echo "   T-232 BASE at $HIGHEST, before any plant (psql; each equal to the generator's reading of the committed tree): int8 matched $BASE_INT8, int8 pulled $BASE_INT8_PULLED, geometry points $BASE_POINTS, policies $BASE_POLICIES (restored $BASE_RESTORED, rewritten $BASE_REWRITTEN), partitioned tables $BASE_PARENTS (policies $BASE_PARENT_POLICIES), partitions $BASE_PARTITIONS [$(c_list $BASE_PARTITION_NAMES)], owned $BASE_OWNED"

OWNED=$(owned_in_public)
echo "   relations in public owned by no extension at $HIGHEST, before any plant: $OWNED"
[ "$OWNED" = "$BASE_OWNED" ] || abort "owned_in_public reads $OWNED but the BASE read counts $BASE_OWNED names"
echo "== T-165 (OD-84): a partitioned table is rendered under its own name; its partitions are not"

# part_expectations: every `-- expect:` line of the fixture must be in db/schema.ts (grep -F) and no
# `-- absent:` line may appear anywhere in it. One fact line each, into $OUT.f; adds to $miss.
part_expectations() {
  local line
  PART_N=0
  # T-232 rework 1: a line that names a plant object (t165_part*, t165Part*) is searched in the whole file,
  # since no committed relation can render it; any other line (e.g. `amount: bigint(…).notNull(),`) is
  # searched only inside the parent's own declaration, t165Part, where the fixture put it.
  while IFS= read -r line; do
    PART_N=$((PART_N + 1))
    if case "$line" in *t165_part* | *t165Part*) grep -qF -- "$line" "$SCHEMA" ;; *) [ "$(block_count t165Part "$line")" -ge 1 ] ;; esac; then
      echo "fact ok (db/schema.ts has it): $line" >>"$OUT.f"
    else
      echo "fact MISMATCH (db/schema.ts lacks it): $line" >>"$OUT.f"
      miss=$((miss + 1))
    fi
  done < <(sed -nE 's/^-- expect: //p' "$PART_FIXTURE")
  while IFS= read -r line; do
    PART_N=$((PART_N + 1))
    if case "$line" in *t165_part* | *t165Part*) grep -qF -- "$line" "$SCHEMA" ;; *) [ "$(block_count t165Part "$line")" -ne 0 ] ;; esac; then
      echo "fact MISMATCH (db/schema.ts names it): $line" >>"$OUT.f"
      miss=$((miss + 1))
    else
      echo "fact ok (db/schema.ts does not name it): $line" >>"$OUT.f"
    fi
  done < <(sed -nE 's/^-- absent: //p' "$PART_FIXTURE")
  [ "$PART_N" -gt 0 ] || abort "$PART_FIXTURE has no -- expect:/-- absent: line"
}

# part_check <id> <description> <regex fact>...: the check must PASS, every fixture expectation must
# hold against the committed db/schema.ts, and every regex must match the check's output.
part_check() {
  local id=$1 desc=$2 code n
  shift 2
  n=$#
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  : >"$OUT.f"
  facts_into "$@"
  part_expectations
  [ "$miss" -eq 0 ] && echo "ALL $((n + PART_N)) PARTITION FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "$id" "$desc" PASS "$code" '^ALL [0-9]+ PARTITION FACTS HOLD$'
  grep -E '^fact |^  partitions: |^  catalogue: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
}

# T-232: the fixture adds 1 partitioned table with 2 policies and 2 partitions (named from its SQL); BASE adds the committed set's.
PART_RENDERED="^  partitions: $((BASE_PARENTS + 1)) partitioned table\(s\) rendered from a partition; [0-9]+ partition declaration\(s\) removed; [0-9]+ name\(s\) mapped to the parent's; $((BASE_PARENT_POLICIES + 2)) policy entr\(ies\) added from pg_policy; [0-9]+ export name\(s\) checked"
PART_COUNTS="^  catalogue: .*; $((BASE_PARTITIONS + 2)) partition\(s\) in public excluded \[$(ere "$(json_list $BASE_PARTITION_NAMES t165_part_q1 t165_part_q2)")\]; $((OWNED + 1)) relation\(s\) owned by no extension in public\$"
PART_INTRO="^  drizzle-kit [^:]+: $((OWNED + 1)) relation\(s\) introspected from public\$"

policy_fixture "$PART_FIXTURE"
sed 's/^/   plant up:   /' "$UP" | head -30
PART_MARK=$(stats_mark)
case "$PART_MARK" in
  never*) echo "   pg_class last analyze / vacuum before the first write: '$PART_MARK' -- NEVER ANALYSED" ;;
  *) echo "   pg_class last analyze / vacuum before the first write: '$PART_MARK' -- ALREADY ANALYSED: run this suite on a FRESH project" ;;
esac
write_schema
# QR-A3: a case of its own, so that "K150-K154 ran against a never-ANALYZEd catalogue" is judged and
# not merely printed. It is BAD on a project something has already analysed — run this suite fresh.
total=$((total + 1))
if [ "${PART_MARK#never}" != "$PART_MARK" ]; then v=ok; else
  v=BAD
  bad=$((bad + 1))
fi
printf '%-4s %s  %s\n       pg_class last analyze / vacuum at the first write of this suite: %s (expected it to begin "never")\n' "$v" K150a "(T-165 r1, QR-A3) the partitioned-table block runs before any ANALYZE in this suite" "$PART_MARK"
part_check K150 "(T-165) CONTROL: a PARTITION BY RANGE parent with two partitions, regenerated, never ANALYZEd: the parent is rendered under its own name with the parent's key, index, check and policies; neither partition is in the file" \
  "$PART_RENDERED" "$PART_COUNTS" "$PART_INTRO" 'byte-identical to a fresh introspection' "^  policies: $((BASE_POLICIES + 2)) checked against pg_policy"

m0=$(stats_mark)
psql -X -q -v ON_ERROR_STOP=1 -c ANALYZE >/dev/null || abort "ANALYZE failed"
m1=$(stats_mark)
{ [ "$m1" != "$m0" ] && [ "${m1%% / *}" != never ]; } || abort "ANALYZE did not land on pg_class (last analyze / vacuum '$m0' -> '$m1')"
echo "   statistics attack landed: pg_class last analyze / vacuum '$m0' -> '$m1'"
part_check K151 "(T-165) the same file after ANALYZE (asserted above): byte-identical" "$PART_RENDERED" 'byte-identical to a fresh introspection'

m0=$(stats_mark)
psql -X -q -v ON_ERROR_STOP=1 -c "VACUUM ANALYZE" >/dev/null || abort "VACUUM ANALYZE failed"
m1=$(stats_mark)
{ [ "${m1#* / }" != "${m0#* / }" ] && [ "${m1#* / }" != never ]; } || abort "VACUUM ANALYZE did not land on pg_class (last analyze / vacuum '$m0' -> '$m1')"
echo "   statistics attack landed: pg_class last analyze / vacuum '$m0' -> '$m1'"
part_check K152 "(T-165) the same file after VACUUM ANALYZE (asserted above): byte-identical" "$PART_RENDERED" 'byte-identical to a fresh introspection'

{ node scripts/db-migrate.ts down --to "$HIGHEST" >"$OUT.p" 2>&1 && grep -q "^MIGRATE OK  down: $NEXT -> $HIGHEST" "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate down --to $HIGHEST failed"; }
{ node scripts/db-migrate.ts up >"$OUT.p" 2>&1 && grep -q "^MIGRATE OK  up: $HIGHEST -> $NEXT" "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate up to $NEXT failed"; }
echo "   history attack landed: down --to $HIGHEST, up to $NEXT"
part_check K153 "(T-165) the same file after the partition migration's down/up: byte-identical" "$PART_RENDERED" 'byte-identical to a fresh introspection'

psql -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE public.t165_part_a0 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2025-01-01Z') TO (TIMESTAMPTZ '2026-01-01Z')" >/dev/null || abort "attaching a third partition failed"
attached=$(psql -X -A -t -q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relispartition AND c.relkind IN ('r','p') AND c.relname LIKE 't165\_part\_%'")
[ "$attached" = 3 ] || abort "the third partition did not land (partitions in public: $attached)"
echo "   attach attack landed: t165_part_a0 sorts BEFORE t165_part_q1, so it is now the template; partitions in public: $attached"
part_check K154 "(T-165) a third partition attached after db/schema.ts was written, sorting first so the template changes: the file is unchanged and the check still passes" \
  "^  partitions: $((BASE_PARENTS + 1)) partitioned table\(s\) rendered from a partition; $((BASE_REMOVED + 2)) partition declaration\(s\) removed" 'byte-identical to a fresh introspection' '"t165_part_a0"'
restore

# T-232: QA's table adds 2 policies, 1 dropped expression restored and 1 entry rewritten; BASE adds the committed set's.
K26_COUNTS="$((BASE_POLICIES + 2)) checked against pg_policy; $((BASE_RESTORED + 1)) expression\(s\) drizzle-kit dropped restored; $((BASE_REWRITTEN + 1)) entr\(ies\) rewritten from the catalogue\$"
# K27's fixture: t152_single's one policy is its table's first row (never dropped); t152_ledger has 3 policies
# and 4 expressions, and drizzle-kit drops the expressions of all but the first row it reads, so the plant
# restores 2 or 3 (3 if update, 2 expressions, is not first). Before T-232 it pinned "at least 1";
# T-232 had BASE+1..BASE+6; rework 1 (QA N2): BASE+2..BASE+3. The range rests on that derivation: the
# plant's share measured 2 in every run so far (T-232 rework 2, NR2); a share of 3 has not been observed.
K27_RESTORED=$(seq -s '|' $((BASE_RESTORED + 2)) $((BASE_RESTORED + 3)))
echo "== T-152 rework 1: row-level security policies (OD-109). First among the policy cases and still before any ANALYZE in this suite: T-165 rework 1 moved K150-K154 ahead of it (QR-A3) and neither block analyses anything"
policy_fixture "$QA_POLICIES"
echo "   pg_class last analyze / vacuum before the first write: '$(stats_mark)'"
write_schema
grep -E '^  policies: ' "$OUT.w" | sed 's/^/   first write: /'
policy_check K26a "(T-152 r1) QA's two-policy table, written and checked with no ANALYZE: both expressions present" "$QA_POLICIES" "$K26_COUNTS"
m0=$(stats_mark)
psql -X -q -v ON_ERROR_STOP=1 -c ANALYZE >/dev/null || abort "ANALYZE failed"
m1=$(stats_mark)
{ [ "$m1" != "$m0" ] && [ "${m1%% / *}" != never ]; } || abort "ANALYZE did not land on pg_class (last analyze / vacuum '$m0' -> '$m1')"
echo "   statistics attack landed: pg_class last analyze / vacuum '$m0' -> '$m1'"
policy_check K26b "(T-152 r1) the same file after ANALYZE (asserted above): parity holds, both expressions present" "$QA_POLICIES" "$K26_COUNTS"
{ node scripts/db-migrate.ts down --to "$HIGHEST" >"$OUT.p" 2>&1 && grep -q "^MIGRATE OK  down: $NEXT -> $HIGHEST" "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate down --to $HIGHEST failed"; }
{ node scripts/db-migrate.ts up >"$OUT.p" 2>&1 && grep -q "^MIGRATE OK  up: $HIGHEST -> $NEXT" "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate up to $NEXT failed"; }
echo "   history attack landed: down --to $HIGHEST, up to $NEXT"
policy_check K26c "(T-152 r1) the same file after the policy migration's down/up: parity holds, both expressions present" "$QA_POLICIES" "$K26_COUNTS"
restore

policy_fixture "$SHAPE_POLICIES"
write_schema
policy_check K27 "(T-152 r1) restrictive, FOR ALL TO PUBLIC, FOR DELETE, FOR UPDATE with both expressions and two roles: each as pg_policy has it" "$SHAPE_POLICIES" "$((BASE_POLICIES + 4)) checked against pg_policy; ($K27_RESTORED) expression\(s\) drizzle-kit dropped restored; "
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
# T-232 (measured on a scratch migration set with a committed partitioned table, T-232 § Evidence F): the
# partition step (4b) runs before anti-vacuity (5), so while `public` holds a committed partitioned table
# the empty pull is refused there first, as I-PART naming that committed parent, and I-VACUOUS is never
# reached. Which tag refuses it is derived from BASE; that the empty pull is REFUSED is what both prove.
# While a partitioned table is committed, I-VACUOUS's own reach is proven by K162/K163, not here.
K06_PART_RE="^  - \[I-PART\] partitioned table \"($(printf '%s\n' $BASE_PARENT_NAMES | paste -sd'|' -))\": drizzle-kit did not render partition"
if [ "$BASE_PARENTS" -eq 0 ]; then
  check K06 "(iv) introspection mutated to read no schema, while the catalogue holds a table" I-VACUOUS "MIGRATE OK  up: $HIGHEST -> $NEXT"
else
  check_facts K06 "(iv) introspection mutated to read no schema, while the catalogue holds a table: refused by the partition step first (BASE holds $BASE_PARENTS partitioned table(s))" I-PART "MIGRATE OK  up: $HIGHEST -> $NEXT" "$K06_PART_RE"
fi
mutate "$SCRIPT" "schemaFilter: [INTROSPECTED_SCHEMA]," "schemaFilter: ['t138_no_such_schema'],"
if [ "$OWNED" -eq 0 ]; then
  check K07 "BOUND (iv): the same mutation, no table planted, catalogue holds 0 un-owned relations -> NOT detected" PASS 'VACUOUS: 0 relations introspected'
elif [ "$BASE_PARENTS" -gt 0 ]; then
  check_facts K07 "(iv) the same mutation against the committed relations: refused by the partition step first (BASE holds $BASE_PARENTS partitioned table(s))" I-PART "$K06_PART_RE"
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
# T-188 (OD-218): the walk-back targets are DERIVED from the committed migration set, not fixed at
# HIGHEST-1 and HIGHEST-2. Which step moves drizzle-kit's `public` order is a property of the migration
# set: with 0007 highest, 0007 re-creates only `approval` (already last) and 0006 touches only schema
# `pgboss`, so neither of the two nearest steps can move it and the old walk ABORTed here on every head
# containing 0007. So: every committed number below HIGHEST, nearest first, stopping at the FIRST whose
# down/up moves the order. What K18 proves is unchanged: the move is still asserted BEFORE parity is
# judged, and if no step down to the lowest committed migration moves it, the run still ABORTs.
WALK=$(ls "$M" | sed -nE 's/^([0-9]{4})_[a-z0-9_]+\.up\.sql$/\1/p' | sort -r | awk -v h="$HIGHEST" '$1 + 0 < h + 0')
[ -n "$WALK" ] || abort "no committed migration below $HIGHEST to walk back to: the history attack cannot be made"
before=$(table_list_order)
after=$before
perturbed=
tried=
for to in $WALK; do
  tried="$tried $to"
  { node scripts/db-migrate.ts down --to "$to" >"$OUT.p" 2>&1 && grep -q '^MIGRATE OK  down: ' "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate down --to $to failed"; }
  { node scripts/db-migrate.ts up >"$OUT.p" 2>&1 && grep -q '^MIGRATE OK  up: ' "$OUT.p"; } || { cat "$OUT.p"; abort "db:migrate up after down --to $to failed"; }
  [ "$(record)" = "kinvara-migrate version=$HIGHEST" ] || abort "the record reads '$(record)' after down --to $to and up, not $HIGHEST"
  after=$(table_list_order)
  if [ "$after" != "$before" ]; then
    perturbed=$to
    break
  fi
done
[ -n "$perturbed" ] || abort "no walk-back moved drizzle-kit's table-list order [$before] (down --to each of:$tried, then up): the history attack did not land"
echo "   history attack landed: down --to $perturbed, up (walk-back tried:$tried); drizzle-kit's table list was [$before], is now [$after]"
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
  # T-232 rework 1: counted inside the child's own declaration (the FK's `columns:` names no plant object).
  if [ "$(block_count t152Child "$line")" -ge 1 ] || { [ "$line" != 'columns: [table.c2, table.c1],' ] && grep -qF -- "$line" "$SCHEMA"; }; then echo "key order as the catalogue: $line" >>"$OUT"; else echo "key order NOT as the catalogue, missing: $line" >>"$OUT"; missing=$((missing + 1)); fi
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
# T-165 rework 2 (merge): the rendered list is drizzle-kit's RAW order, which T-152 measured to depend
# on planner statistics for exactly this key (OD-106). With 0007 highest, K18's derived walk can land at
# 0006 in this suite's order, so account_role is not recreated and keeps the statistics K151/K152 gave it:
# measured [role, account_id] (rework 2, S1). What K25 proves is the catalogue side, so either order is admitted.
check K25 "(T-152) the catalogue's key columns differ from the rendered list: refused" I-ORDER "account_role_pkey columns: the rendering lists columns \[(account_id, role|role, account_id)\] but the catalogue's key is \[account_id_t152, role_t152\]"

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
# T-232 rework 2: the message is required for one of the FIXTURE's two UPDATE policies (t152_ledger_update,
# t152_single_both), as K29/K30 name t152_ledger; unnamed, a committed UPDATE policy's refusal satisfied it.
check K31 "(T-152 r1) command: the catalogue's UPDATE read as INSERT, refused" I-POLICY 'table "t152_(ledger|single)": pgPolicy .*: for "update" but pg_policy has "insert"'

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
PGBOSS_RELS='t145_job t145_job_p t145_version t145_view'

# plant_jobschema <schema as SQL> [extra up SQL] [extra down SQL]: migration NEXT creating, in that
# schema, an enum, a sequence, a plain table, a partitioned table with one partition, and a view. The
# extra SQL is appended to the up file and put first in the down file. plant() asserts both landed.
# Schema `pgboss` exists on main (0006), so it is neither created nor dropped for that one name.
plant_jobschema() {
  local s=$1 xup=${2:-} xdown=${3:-} mk rm
  mk="CREATE SCHEMA $s;
"
  rm="
DROP SCHEMA $s;"
  if [ "$s" = pgboss ]; then
    mk=''
    rm=''
  fi
  plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-145
${mk}CREATE TYPE $s.t145_job_state AS ENUM ('created', 'completed');
CREATE SEQUENCE $s.t145_seq;
CREATE TABLE $s.t145_version (version integer PRIMARY KEY);
CREATE TABLE $s.t145_job (id uuid NOT NULL, name text NOT NULL, state $s.t145_job_state NOT NULL) PARTITION BY LIST (name);
CREATE TABLE $s.t145_job_p PARTITION OF $s.t145_job FOR VALUES IN ('t145');
CREATE VIEW $s.t145_view AS SELECT name FROM $s.t145_job;${xup:+
$xup}"
  plant "$DOWN" "${xdown:+$xdown
}DROP VIEW $s.t145_view;
DROP TABLE $s.t145_job;
DROP TABLE $s.t145_version;
DROP SEQUENCE $s.t145_seq;
DROP TYPE $s.t145_job_state;${rm}"
  sed 's/^/   plant up:   /' "$UP"
}

# scope_refused <schema name as the catalogue has it>: one regex per planted relation, each an I-SCOPE line.
scope_refused() {
  local r
  for r in $PGBOSS_RELS; do printf '%s\n' "^  - \\[I-SCOPE\\] relation \"$1\"\\.\"$r\" is owned by no extension and is outside schema public"; done
}

# sorted_words: newline- or comma-separated words -> one line, C-sorted, space-separated.
sorted_words() {
  tr ',' '\n' | sed -E 's/^ +//; s/ +$//' | grep -v '^$' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'
}

# T-165 (OD-154): T-146's 0006 now CREATEs schema pgboss with twelve relations of its own, so these
# plants ADD to it instead of creating it, under names 0006 does not use, and every admitted count
# below is the catalogue's own count before the plant plus what the plant adds. Read here, once,
# from psql — never from the generator's output.
ADMITTED_BASE_LIST=$(psql -X -A -t -q -c "SELECT '\"' || n.nspname || '\".\"' || c.relname || '\"' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = 'pgboss'" | sorted_words)
ADMITTED_BASE=$(psql -X -A -t -q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = 'pgboss'")
echo "   schema pgboss holds $ADMITTED_BASE relation(s) before any plant (0006, T-146): [$ADMITTED_BASE_LIST]"

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
want_admitted=$({ for r in $PGBOSS_RELS; do echo "\"pgboss\".\"$r\""; done; printf '%s\n' $ADMITTED_BASE_LIST; } | sorted_words)
cat_admitted=$(psql -X -A -t -q -c "SELECT '\"' || n.nspname || '\".\"' || c.relname || '\"' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = 'pgboss'" | sorted_words)
gen_admitted=$(sed -nE 's/^  out of scope: [0-9]+ relation\(s\) in schema\(s\) "pgboss" admitted, not introspected and not counted \[(.*)\]$/\1/p' "$OUT" | sorted_words)
gen_owned=$(sed -nE 's/^  catalogue: .*; ([0-9]+) relation\(s\) owned by no extension in public$/\1/p' "$OUT")
gen_intro=$(sed -nE 's/^  drizzle-kit [^:]+: ([0-9]+) relation\(s\) introspected from public$/\1/p' "$OUT")
fact "the catalogue's relations in schema pgboss (psql, this run), as the plant names them" "$cat_admitted" "$want_admitted"
fact "the generator's out-of-scope list, as the catalogue" "$gen_admitted" "$cat_admitted"
fact "I-VACUOUS's catalogue side (owned by no extension in public), as psql counts public now" "$gen_owned" "$(owned_in_public)"
fact "I-VACUOUS's catalogue side, as K00 counted before any pgboss plant" "$gen_owned" "$OWNED"
fact "I-VACUOUS's rendering side (relations drizzle-kit introspected), as K00 counted" "$gen_intro" "$OWNED"
node scripts/db-introspect.ts --write >"$OUT.w" 2>&1
fact "write mode, pgboss set planted: exit" "$?" 0
# T-232 rework 2 (QA-R-F1): both facts about db/schema.ts read the file this write produced, with the pgboss
# set planted. The first counts the PLANT'S SHARE of lines naming pgboss or a planted name: lines now minus
# lines in the committed file. Until rework 2 it was a whole-file count = 0, which an ordinary committed
# column such as `pgboss_job_id uuid` (rendered `pgbossJobId: uuid("pgboss_job_id")`) turned BAD (QA-R4).
# The second: no rendered relation carries a name that exists only in schema pgboss (psql, now). Until
# rework 1 it grepped the whole file for `"version"` and `"job"`, two of 0006's pgboss relation names,
# which a committed public relation of either name would match.
fact "db/schema.ts after the write: the plant's share (now minus committed) of lines naming pgboss or a planted name (job_state, t145*)" "$(($(grep -cE 'pgboss|job_state|t145' "$SCHEMA") - $(git show HEAD:"$SCHEMA" | grep -cE 'pgboss|job_state|t145')))" 0
pgboss_only=$(psql -X -A -t -q -c "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss' AND c.relkind IN ('r','p','v','m','f') AND c.relname NOT IN (SELECT c2.relname FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace WHERE n2.nspname = 'public')")
fact "db/schema.ts after the write: rendered relations (pgTable/pgView/pgMaterializedView) named as a relation only schema pgboss has [$(c_list $pgboss_only)]" "$(grep -oE '= pg(Table|View|MaterializedView)\("[^"]+"' "$SCHEMA" | sed -E 's/.*\("(.*)"$/\1/' | grep -cxF -f <(printf '%s\n' $pgboss_only))" 0
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
  check_facts "$kid" "(T-145) (i) the same set in near-miss schema $ssql: every relation I-SCOPE, none admitted" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}" "^  out of scope: $ADMITTED_BASE relation\(s\)"
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
check_facts K37b "(T-145) (i) pg_boss, planted only as a superuser with allow_system_table_mods (a migration cannot create it, K37b0): the name comparison does not take pg_boss for pgboss, every relation I-SCOPE" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}" "^  out of scope: $ADMITTED_BASE relation\(s\)"

plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-145
CREATE TABLE kinvara_guard.t145_plant (id bigint PRIMARY KEY);"
plant "$DOWN" "DROP TABLE kinvara_guard.t145_plant;"
sed 's/^/   plant up:   /' "$UP"
check_facts K38 "(T-145) (ii) a relation in kinvara_guard: still I-SCOPE" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" '^  - \[I-SCOPE\] relation "kinvara_guard"\."t145_plant" is owned by no extension' "^  out of scope: $ADMITTED_BASE relation\(s\)"

plant_jobschema pgboss
mapfile -t refused < <(scope_refused pgboss)
mutate "$SCRIPT" "const OUT_OF_SCOPE_SCHEMAS: readonly string[] = ['pgboss'];" "const OUT_OF_SCOPE_SCHEMAS: readonly string[] = [];"
git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check_facts K39a "(T-145) (iii) the rule deleted (OUT_OF_SCOPE_SCHEMAS emptied): the K36 control plant goes red, and 0006's own pgboss relations with it" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}" '^  out of scope: 0 relation\(s\)' '^  - \[I-SCOPE\] relation "pgboss"\."job_common"'

plant_jobschema pgboss
mutate "$SCRIPT" "    (r) => !r.extensionMember && r.schema !== INTROSPECTED_SCHEMA && !admitted(r)," "    (r) => !r.extensionMember && r.schema !== INTROSPECTED_SCHEMA,"
git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check_facts K39b "(T-145) (iii) the rule deleted (the exclusion clause removed from the I-SCOPE refusal): the K36 control plant goes red" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" "${refused[@]}"

plant_jobschema pgboss "CREATE TABLE public.t145_plant (id bigint PRIMARY KEY);
GRANT SELECT ON public.t145_plant TO app_rw;" "DROP TABLE public.t145_plant;"
check_facts K40 "(T-145) (iv) a public table beside the pgboss set, db/schema.ts not regenerated: still I-DIFF, and only I-DIFF" I-DIFF "MIGRATE OK  up: $HIGHEST -> $NEXT" "^  out of scope: $((ADMITTED_BASE + 4)) relation\(s\) in schema\(s\) \"pgboss\" admitted" "^  catalogue: .*; $((OWNED + 1)) relation\\(s\\) owned by no extension in public\$" '!\[I-SCOPE\]'

plant_jobschema pgboss "CREATE SCHEMA pgboss_x;
CREATE TABLE pgboss_x.job (id bigint PRIMARY KEY);" "DROP TABLE pgboss_x.job;
DROP SCHEMA pgboss_x;"
check_facts K41 "(T-145) pgboss beside pgboss_x: admission is per relation, by schema name; I-SCOPE names pgboss_x.job and no pgboss relation" I-SCOPE "MIGRATE OK  up: $HIGHEST -> $NEXT" '^  - \[I-SCOPE\] relation "pgboss_x"\."job" is owned by no extension' '!^  - \[I-SCOPE\] relation "pgboss"\.' "^  out of scope: $((ADMITTED_BASE + 4)) relation\(s\) in schema\(s\) \"pgboss\" admitted"

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
  facts_into "MIGRATE OK  up: $HIGHEST -> $NEXT" "^  - \\[I-SCOPE\\] relation $shown\\.\"t145_t\" is owned by no extension and is outside schema public" "^  out of scope: $ADMITTED_BASE relation\(s\)"
  landed_fact "$want"
  [ "$miss" -eq 0 ] && echo "ALL SHAPE FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "$id" "(T-145 r1) schema $ident, bytes $want: I-SCOPE, named $shown, not admitted" I-SCOPE "$code" '^ALL SHAPE FACTS HOLD$'
  grep -E '^fact ' "$OUT" | cut -c1-240 | sed 's/^/       /'
  restore_text_read
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  : >"$OUT.f"
  if [ "$BASE_PARTITIONS" -eq 0 ]; then facts_into "$@"; else facts_into "$@" "$KM_VACUOUS_RE"; fi
  landed_fact "$want"
  [ "$miss" -eq 0 ] && echo "ALL RESTORED-READ FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "${id}m" "(T-145 r1) RED BEFORE: main's trim/split read restored (asserted above), the same plant gets past I-SCOPE" "$KM_EXPECT" "$code" '^ALL RESTORED-READ FACTS HOLD$'
  grep -E '^fact |^  out of scope: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
  restore
}

# T-232 (measured, § Evidence F): the text read restored above predates T-165 and has no partition flag,
# so while `public` holds committed partitions it counts them as owned and the run is I-VACUOUS at step 5
# on those alone (exactly the lists below, from BASE). Step 5 is reached only after step 3's I-SCOPE
# passed, so "the plant gets past I-SCOPE" is proven either way; the facts are the same.
KM_EXPECT=PASS
KM_VACUOUS_RE="^  - \\[I-VACUOUS\\] drizzle-kit wrote $BASE_OWNED relation\\(s\\) \\[$(ere "$(c_list $BASE_OWNED_NAMES)")\\] but the catalogue lists $((BASE_OWNED + BASE_PARTITIONS)) owned by no extension in public \\[$(ere "$(c_list $BASE_OWNED_NAMES $BASE_PARTITION_NAMES)")\\]\$"
[ "$BASE_PARTITIONS" -eq 0 ] || KM_EXPECT=I-VACUOUS
ADMITTED_T="^  out of scope: $((ADMITTED_BASE + 1)) relation\(s\) in schema\(s\) \"pgboss\" admitted, not introspected and not counted \[.*\"pgboss\"\.\"t145_t\".*\]$"
shape_case K42 '" pgboss"' ' pgboss' '" pgboss"' "$ADMITTED_T"
shape_case K43 'U&"\00A0pgboss"' '\xc2\xa0pgboss' '"\\u00a0pgboss"' "$ADMITTED_T"
shape_case K44 'U&"\FEFFpgboss"' '\xef\xbb\xbfpgboss' '"\\ufeffpgboss"' "$ADMITTED_T"
shape_case K45 'U&"\0009pgboss"' '\tpgboss' '"\\tpgboss"' "$ADMITTED_T"
shape_case K46 'U&"\000Apgboss"' '\npgboss' '"\\npgboss"' "$ADMITTED_T"
shape_case K47 '"pgboss|x"' 'pgboss|x' '"pgboss\|x"' "^  out of scope: $((ADMITTED_BASE + 1)) relation\(s\) in schema\(s\) \"pgboss\" admitted, not introspected and not counted \[.*\"pgboss\"\.\"x\".*\]$"
# QR-A1 (main's own defect): with the text read, "<any>|x|true" parses as an extension member, so the
# relation is on no list at all: GATE PASS, only 0006's own pgboss relations admitted, and its name
# nowhere in the output.
shape_case K48 '"pgboss|x|true"' 'pgboss|x|true' '"pgboss\|x\|true"' "^  out of scope: $ADMITTED_BASE relation\(s\)" '!t145_t'
shape_case K49 '"zz_other|x|true"' 'zz_other|x|true' '"zz_other\|x\|true"' "^  out of scope: $ADMITTED_BASE relation\(s\)" '!t145_t'


policy_fixture "$PART_FIXTURE"
write_schema
psql -X -q -v ON_ERROR_STOP=1 -c "ALTER TABLE public.t165_part ADD COLUMN drifted text" >/dev/null || abort "the parent drift failed"
psql -X -A -t -q -c "SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.t165_part_q1'::regclass AND attname = 'drifted'" | grep -qx 1 || abort "the parent's new column did not reach its partition"
check K155 "(T-165) the parent gains a column, which every partition gains too, and db/schema.ts is not regenerated: I-DIFF" I-DIFF 'db/schema.ts differs from a fresh introspection'

policy_fixture "$PART_FIXTURE"
write_schema
psql -X -q -v ON_ERROR_STOP=1 -c "CREATE INDEX t165_part_q1_own_idx ON public.t165_part_q1 (note)" >/dev/null || abort "the partition-only index failed"
check K156 "(T-165) an index created on a partition alone, which the parent does not have: refused, never rendered as the parent's" I-PART 'partition "t165_part_q1" has its own index "t165_part_q1_own_idx", which the parent has no counterpart for'

plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 (at timestamptz NOT NULL, id bigint NOT NULL);
ALTER TABLE public.t165_part ATTACH PARTITION public.t165_part_q1 FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');"
plant "$DOWN" "DROP TABLE public.t165_part;"
check K157 "(T-165) a partition ATTACHed with the parent's columns in another order: its rendering is not the parent's, refused" I-PART 'does not have the parent.s columns in the parent.s order'

plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL, k text NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at, k)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z') PARTITION BY LIST (k);
CREATE TABLE public.t165_part_q1_k PARTITION OF public.t165_part_q1 FOR VALUES IN ('k1');"
plant "$DOWN" "DROP TABLE public.t165_part;"
check K158 "(T-165) a sub-partitioned table (a partition that is itself partitioned): refused" I-PART 'is itself partitioned: a sub-partitioned table is not represented'

plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-165
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');
CREATE TABLE pgboss.t165_part_pb PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-04-01Z') TO (TIMESTAMPTZ '2026-07-01Z');"
plant "$DOWN" "DROP TABLE public.t165_part;"
check K159 "(T-165) a partition of a public partitioned table planted in ADMITTED schema pgboss beside a public one (T-145 LIVE contract §4's route, which OD-84 would otherwise open): refused" I-PART 'is not in schema public, and a partition of a table in public is part of that table'

plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);"
plant "$DOWN" "DROP TABLE public.t165_part;"
check K159b "(T-165) a partitioned table with no partition at all, which drizzle-kit renders nothing for: refused" I-PART 'has no partition, so drizzle-kit renders nothing'

plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-165
CREATE SCHEMA t165_other;
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');
CREATE TABLE t165_other.t165_part_ot PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-04-01Z') TO (TIMESTAMPTZ '2026-07-01Z');"
plant "$DOWN" "DROP TABLE public.t165_part;
DROP SCHEMA t165_other;"
check K159c "(T-165) the same partition in a schema nothing admits: the scope rule reaches it first" I-SCOPE '^  - \[I-SCOPE\] relation "t165_other"\."t165_part_ot" is owned by no extension'

plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_part (id bigint GENERATED ALWAYS AS IDENTITY, at timestamptz NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');"
plant "$DOWN" "DROP TABLE public.t165_part;"
check K160 "(T-165) a partitioned table with an identity column, which drizzle-kit renders on a partition as name: \"null\", startWith: null: refused" I-PART 'has an identity column'

policy_fixture "$PART_FIXTURE"
write_schema
psql -X -q -v ON_ERROR_STOP=1 -c "CREATE INDEX t165_part_only_idx ON ONLY public.t165_part (note)" >/dev/null || abort "the ON ONLY index failed"
psql -X -A -t -q -c "SELECT count(*) FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid WHERE ci.relname = 't165_part_only_idx'" | grep -qx 1 || abort "the ON ONLY index did not land"
check K171 "(T-165) an index the PARENT has that no partition has (CREATE INDEX ... ON ONLY), which would otherwise be silently absent from the rendering: refused" I-PART 'it owns "t165_part_only_idx", which partition "t165_part_q1" has no counterpart for'

plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');
CREATE TABLE public.t165_ref (id bigint PRIMARY KEY, r_id bigint NOT NULL, r_at timestamptz NOT NULL,
  CONSTRAINT t165_ref_fkey FOREIGN KEY (r_id, r_at) REFERENCES public.t165_part (id, at));"
plant "$DOWN" "DROP TABLE public.t165_ref;
DROP TABLE public.t165_part;"
check K161 "(T-165) a foreign key from a public table INTO the partitioned table, which PostgreSQL clones once per partition: refused" I-PART "renders \"t165_ref_fkey_1\", PostgreSQL's per-partition clone"

policy_fixture "$PART_FIXTURE"
write_schema
mutate "$PARTITION" "  const decls = declarations(sf);" "  const decls = declarations(sf);
  if (source !== '')
    return { ok: true, body: source, parents: 0, removed: 0, mapped: 0, policies: 0, names: 0 };"
git diff -U0 -- "$PARTITION" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
# T-232 (OD-246): until T-232 this regex required t165_part_q2 and t165_part to END their lists, i.e. that no
# committed relation sorts after t165_* (0016's webauthn_credential does). Both lists are now derived whole:
# drizzle-kit's side is every relation it pulls from public at BASE plus the two partitions it now writes;
# the catalogue's side is BASE's owned set plus the parent. Exact lists and counts, nothing positional.
K162_WROTE=$(c_list $BASE_PULLED_NAMES t165_part_q1 t165_part_q2)
K162_CAT=$(c_list $BASE_OWNED_NAMES t165_part)
K162_RE="^  - \[I-VACUOUS\] drizzle-kit wrote $(printf '%s\n' $BASE_PULLED_NAMES t165_part_q1 t165_part_q2 | grep -c .) relation\(s\) \[$(ere "$K162_WROTE")\] but the catalogue lists $((BASE_OWNED + 1)) owned by no extension in public \[$(ere "$K162_CAT")\]\$"
check K162 "(T-165) the rule deleted (the step made a pass-through): the regenerated file is refused and the parent is unrendered, as before this ticket" I-VACUOUS "$K162_RE"

policy_fixture "$PART_FIXTURE"
write_schema
mutate "$SCRIPT" "    .filter((r) => !r.extensionMember && r.schema === INTROSPECTED_SCHEMA && !r.partition)" "    .filter((r) => !r.extensionMember && r.schema === INTROSPECTED_SCHEMA)"
git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check K163 "(T-165) the other half deleted (partitions counted by I-VACUOUS again): the regenerated file is refused" I-VACUOUS 'but the catalogue lists .*t165_part_q1, t165_part_q2'

mutate "$PARTITION" "      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace" "      FROM pg_class_t165 c JOIN pg_namespace n ON n.oid = c.relnamespace"
check K164 "(T-165) the partitioned-table query unreadable, committed tree: refused, never treated as no partitioned table" I-PART 'cannot read the partitioned tables from the catalogue'

policy_fixture "$PART_FIXTURE"
write_schema
mutate "$PARTITION" "    const mine = policies" "    const mine = ([] as typeof policies)"
git diff -U0 -- "$PARTITION" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check K168 "(T-165) the parent's policies not added (the partition carries none of them): T-152's pg_policy step now SEES the partitioned table and refuses it" I-POLICY 'table "t165_part": pg_policy has policy "t165_part_(zulu|omega)", which the rendering does not contain'

# Measured (T-165 § Evidence M6): drizzle-kit spells `t165_x2y` as `t165X2Y`, because the `camelcase`
# package it uses breaks a word at a digit-to-letter boundary, where this step would spell it
# `t165X2y`. A PARENT of that shape is refused by name (K169) rather than exported under a guess; K170
# deletes the agreement itself and shows the check that holds it.
plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_x2y (id bigint NOT NULL, at timestamptz NOT NULL,
  CONSTRAINT t165_x2y_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_x2y_q1 PARTITION OF public.t165_x2y FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');"
plant "$DOWN" "DROP TABLE public.t165_x2y;"
check K169 "(T-165) a partitioned table whose name has a digit-to-letter boundary, which drizzle-kit and this step spell differently: refused, never exported under a guess" I-PART 'is not named as .<letters><digits>'

policy_fixture "$PART_FIXTURE"
write_schema
mutate "$PARTITION" "  const parts = relname.split('_');" "  const parts = \`\${relname}_t165\`.split('_');"
git diff -U0 -- "$PARTITION" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check K170 "(T-165) the export-name derivation changed: it is held against the names drizzle-kit itself wrote in the same rendering, so it is refused" I-PART 'drizzle-kit exports relation "account_role" as .accountRole., which this step would spell .accountRoleT165.'

echo "== T-165 (OD-145): a relation in information_schema, pg_catalog or a pg_toast* schema"
# Before this ticket the catalogue read excluded those schemas outright, so such a relation was on no
# list at all: GATE PASS, no I-SCOPE, absent from db/schema.ts. system_case plants one, requires
# I-SCOPE naming it, then restores main's schema filter (asserted landed) and requires GATE PASS with
# the relation named nowhere in the output.
SCHEMA_FILTER_NEW=$(
  cat <<'EOF'
       AND ((n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND n.nspname NOT LIKE 'pg\\_toast%'
             AND n.nspname NOT LIKE 'pg\\_temp\\_%')
         OR (c.oid >= 16384
             AND n.nspname NOT LIKE 'pg\\_temp\\_%'
             AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'))`;
EOF
)
SCHEMA_FILTER_OLD=$(
  cat <<'EOF'
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;
EOF
)

# system_case <id> <schema> <extra SQL before the CREATE TABLE> <extra down SQL>
system_case() {
  local id=$1 schema=$2 pre=$3 post=$4 code oid
  plant "$UP" "-- @phase: expand
-- @run-as: bootstrap-superuser — T-165
${pre}CREATE TABLE $schema.t165_sys (id bigint PRIMARY KEY);"
  plant "$DOWN" "DROP TABLE $schema.t165_sys;${post:+
$post}"
  sed 's/^/   plant up:   /' "$UP"
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  : >"$OUT.f"
  facts_into "MIGRATE OK  up: $HIGHEST -> $NEXT" "^  - \\[I-SCOPE\\] relation \"$schema\"\\.\"t165_sys\" is owned by no extension and is outside schema public"
  oid=$(psql -X -A -t -q -c "SELECT c.oid || ' ' || (c.oid >= 16384)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '$schema' AND c.relname = 't165_sys'")
  if [ "${oid##* }" = true ]; then echo "fact ok: the plant landed in $schema as a user relation, pg_class.oid $oid" >>"$OUT.f"; else echo "fact MISMATCH: pg_class says [$oid] for $schema.t165_sys" >>"$OUT.f"; miss=$((miss + 1)); fi
  [ "$miss" -eq 0 ] && echo "ALL SYSTEM-SCHEMA FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "$id" "(T-165 OD-145) a table in $schema: I-SCOPE, named" I-SCOPE "$code" '^ALL SYSTEM-SCHEMA FACTS HOLD$'
  grep -E '^fact ' "$OUT" | cut -c1-240 | sed 's/^/       /'
  mutate "$SCRIPT" "$SCHEMA_FILTER_NEW" "$SCHEMA_FILTER_OLD"
  grep -qF "AND n.nspname NOT LIKE 'pg\\\\_toast%'" "$SCRIPT" || abort "main's schema filter did not land in $SCRIPT"
  grep -qF "AND n.nspname NOT LIKE 'pg\\\\_toast\\\\_temp\\\\_%'))" "$SCRIPT" && abort "the widened catalogue read is still in $SCRIPT"
  git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  code=$?
  : >"$OUT.f"
  facts_into '!t165_sys' "^  out of scope: $ADMITTED_BASE relation\\(s\\)" 'byte-identical to a fresh introspection'
  [ "$miss" -eq 0 ] && echo "ALL RESTORED-FILTER FACTS HOLD" >>"$OUT.f"
  cat "$OUT.f" >>"$OUT"
  judge "${id}m" "(T-165 OD-145) RED BEFORE: main's schema filter restored (asserted above), the same plant reaches no check at all" PASS "$code" '^ALL RESTORED-FILTER FACTS HOLD$'
  grep -E '^fact ' "$OUT" | cut -c1-240 | sed 's/^/       /'
  restore
}

system_case K165 information_schema '' ''
system_case K166 pg_catalog 'SET allow_system_table_mods = on;
' ''
system_case K167 pg_toastq 'SET allow_system_table_mods = on;
CREATE SCHEMA pg_toastq;
' 'DROP SCHEMA pg_toastq;'

echo "== T-165 rework 1 (OD-155, OD-156): EVERY partition's own objects are read, not only the template's"
# T-232: every plant-landed read of pg_policy below is limited to the plant's own t165_part* relations, so
# a committed policy elsewhere in public is not taken for a plant that did not land (measured, § Evidence F).
# Before this rework the step consulted the names map for the TEMPLATE only and deleted every other
# partition's declaration whole, so anything a non-template partition alone carried was read by
# nothing: qa-verification's A17 (a policy) and DRIFT 2 (an index) both gave GATE PASS. Each case
# below plants one such object on the NON-template partition (t165_part_q2; the template is the
# byte-first, t165_part_q1), asserts it landed by reading the catalogue, and requires [I-PART]. Each
# is then re-run with TEMPLATE-ONLY checking restored, which is the defect, in WRITE mode: the write
# succeeds and the object's name is nowhere in db/schema.ts — OD-155's and OD-156's exact finding.
TEMPLATE_ONLY_FROM="    for (const p of local) {
      for (const n of p.names) {"
TEMPLATE_ONLY_TO="    for (const p of local.filter((q) => q.name === template.name)) {
      for (const n of p.names) {"
# The second mutation: the partition read stops reading pg_policy at all, which is what the step did
# before this rework. It is used for the TEMPLATE policy case, where template-only checking would
# still catch the offender — there the pre-rework answer was the incidental [I-POLICY], and showing
# it is what proves the two shapes did NOT answer alike before.
NO_POLICY_READ_FROM="                              FROM pg_policy pol
                             WHERE pol.polrelid = ch.oid"
NO_POLICY_READ_TO="                              FROM pg_policy pol
                             WHERE false AND pol.polrelid = ch.oid"

# write_judge <id> <desc> <expected exit> <expected tag set or 'none'> <name> [times it must be in db/schema.ts, default 0]
write_judge() {
  local id=$1 desc=$2 want_code=$3 want_tags=$4 absent=$5 want_n=${6:-0} code banners tags n v
  node scripts/db-introspect.ts --write >"$OUT" 2>&1
  code=$?
  total=$((total + 1))
  banners=$(grep -cE '^GATE (PASS|FAIL|CRASH)  db:introspect($| — |: )' "$OUT")
  tags=$(grep -oE '^  - \[I-[A-Z]+\]' "$OUT" | sed -E 's/^  - \[(.*)\]$/\1/' | sort -u | tr '\n' ' ' | sed 's/ $//')
  # T-232 rework 1: the plant's share of <name> — its lines now minus those in the committed file, since
  # two of the names ('REPLICA IDENTITY', 'DISABLE') name no plant object and a committed file could hold them.
  n=$(($(grep -c -- "$absent" "$SCHEMA") - $(git show HEAD:"$SCHEMA" | grep -c -- "$absent")))
  if [ "$code" -eq "$want_code" ] && [ "$banners" -eq 1 ] && [ "${tags:-none}" = "$want_tags" ] && [ "$n" -eq "$want_n" ]; then
    v=ok
  else
    v=BAD
    bad=$((bad + 1))
  fi
  printf '%-4s %s  %s\n       write exit %s (expected %s); banners %s; tags %s (expected %s); "%s" in db/schema.ts: %s (expected %s)\n' "$v" "$id" "$desc" "$code" "$want_code" "$banners" "${tags:-none}" "$want_tags" "$absent" "$n" "$want_n"
  grep -E '^  - \[|^GATE |^  partitions: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
}

# plant_two_partitions <extra up SQL> <extra down SQL>: the parent with t165_part_q1 (the template,
# byte-first) and t165_part_q2, plus whatever the case adds.
plant_two_partitions() {
  plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL, note text NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');
CREATE TABLE public.t165_part_q2 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-04-01Z') TO (TIMESTAMPTZ '2026-07-01Z');
GRANT SELECT, INSERT ON public.t165_part TO app_rw;
$1"
  plant "$DOWN" "DROP TABLE public.t165_part;${2:+
$2}"
}

# partlocal_case <id> <desc> <extra up> <extra down> <assert SQL> <expected> <I-PART regex> <mutated exit> <mutated tags> <absent name>
partlocal_case() {
  local id=$1 desc=$2 xup=$3 xdown=$4 asql=$5 awant=$6 re=$7 mcode=$8 mtags=$9 absent=${10} got
  local mkind=${11:-template-only}
  plant_two_partitions "$xup" "$xdown"
  sed 's/^/   plant up:   /' "$UP"
  node scripts/db-migrate.ts up >"$OUT.p" 2>&1 || { cat "$OUT.p"; abort "$id: the plant did not apply"; }
  got=$(psql -X -A -t -q -c "$asql")
  [ "$got" = "$awant" ] || abort "$id: the plant did not land: [$got] but expected [$awant]"
  echo "   plant landed, read from the catalogue: [$got]"
  node scripts/db-introspect.ts --check >"$OUT" 2>&1
  judge "$id" "$desc" I-PART "$?" "$re"
  case "$mkind" in
    no-policy-read) mutate "$PARTITION" "$NO_POLICY_READ_FROM" "$NO_POLICY_READ_TO" ;;
    no-rule-read) mutate "$PARTITION" "$NO_RULE_READ_FROM" "$NO_RULE_READ_TO" ;;
    no-statistics-read) mutate "$PARTITION" "$NO_STATS_READ_FROM" "$NO_STATS_READ_TO" ;;
    no-replica-identity-read) mutate "$PARTITION" "$NO_REPLIDENT_READ_FROM" "$NO_REPLIDENT_READ_TO" ;;
    *) mutate "$PARTITION" "$TEMPLATE_ONLY_FROM" "$TEMPLATE_ONLY_TO" ;;
  esac
  git diff -U0 -- "$PARTITION" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
  write_judge "${id}m" "(T-165) RED BEFORE: the $mkind reading restored (asserted above), which is what the step did before the rework that added the case" "$mcode" "$mtags" "$absent"
  restore
}

partlocal_case K172 "(T-165 r1, OD-155) a row-level security POLICY on the non-template partition (QA's A8b/A17 stage 1): refused, and the partition that owns it is named" \
  "ALTER TABLE public.t165_part_q2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY t165_part_q2_only ON public.t165_part_q2 FOR SELECT TO app_rw USING (note <> 'x');" \
  "" \
  "SELECT c.relname || '/' || pol.polname FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relname LIKE 't165\_part%'" \
  "t165_part_q2/t165_part_q2_only" \
  'partition "t165_part_q2" has its own policy "t165_part_q2_only", which the parent has no counterpart for' \
  0 none t165_part_q2_only

partlocal_case K173 "(T-165 r1, OD-155) the SAME policy on the TEMPLATE partition: the same answer, [I-PART], not the incidental [I-POLICY] it used to be" \
  "ALTER TABLE public.t165_part_q1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY t165_part_q1_only ON public.t165_part_q1 FOR SELECT TO app_rw USING (note <> 'x');" \
  "" \
  "SELECT c.relname || '/' || pol.polname FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relname LIKE 't165\_part%'" \
  "t165_part_q1/t165_part_q1_only" \
  'partition "t165_part_q1" has its own policy "t165_part_q1_only", which the parent has no counterpart for' \
  1 I-POLICY t165_part_q1_only no-policy-read

partlocal_case K174 "(T-165 r1, OD-156) an INDEX on the non-template partition (QA's DRIFT 2): refused" \
  "CREATE INDEX t165_part_q2_local_idx ON public.t165_part_q2 (note);" \
  "" \
  "SELECT count(*)::text FROM pg_class WHERE relname = 't165_part_q2_local_idx'" \
  "1" \
  'partition "t165_part_q2" has its own index "t165_part_q2_local_idx", which the parent has no counterpart for' \
  0 none t165_part_q2_local_idx

partlocal_case K175 "(T-165 r1, OD-156) a CHECK constraint on the non-template partition alone: refused" \
  "ALTER TABLE public.t165_part_q2 ADD CONSTRAINT t165_part_q2_note_ck CHECK (note <> 'q2');" \
  "" \
  "SELECT count(*)::text FROM pg_constraint WHERE conname = 't165_part_q2_note_ck'" \
  "1" \
  'partition "t165_part_q2" has its own constraint "t165_part_q2_note_ck", which the parent has no counterpart for' \
  0 none t165_part_q2_note_ck

partlocal_case K176 "(T-165 r1, OD-156) a UNIQUE constraint on the non-template partition alone: refused" \
  "ALTER TABLE public.t165_part_q2 ADD CONSTRAINT t165_part_q2_note_key UNIQUE (note);" \
  "" \
  "SELECT count(*)::text FROM pg_constraint WHERE conname = 't165_part_q2_note_key'" \
  "1" \
  'partition "t165_part_q2" has its own (constraint|index) "t165_part_q2_note_key", which the parent has no counterpart for' \
  0 none t165_part_q2_note_key

partlocal_case K177 "(T-165 r1, OD-156) a FOREIGN KEY from the non-template partition alone: refused" \
  "CREATE TABLE public.t165_ref (note text PRIMARY KEY);
GRANT SELECT ON public.t165_ref TO app_rw;
ALTER TABLE public.t165_part_q2 ADD CONSTRAINT t165_part_q2_note_fkey FOREIGN KEY (note) REFERENCES public.t165_ref (note);" \
  "DROP TABLE public.t165_ref;" \
  "SELECT count(*)::text FROM pg_constraint WHERE conname = 't165_part_q2_note_fkey'" \
  "1" \
  'partition "t165_part_q2" has its own constraint "t165_part_q2_note_fkey", which the parent has no counterpart for' \
  0 none t165_part_q2_note_fkey

partlocal_case K178 "(T-165 r1, OD-156) a TRIGGER on the non-template partition alone, which PostgreSQL's own FK triggers (tgisinternal) are told apart from: refused" \
  "CREATE FUNCTION public.t165_noop() RETURNS trigger LANGUAGE plpgsql AS \$fn\$ BEGIN RETURN NEW; END \$fn\$;
CREATE TRIGGER t165_part_q2_local_trg BEFORE INSERT ON public.t165_part_q2 FOR EACH ROW EXECUTE FUNCTION public.t165_noop();" \
  "DROP FUNCTION public.t165_noop();" \
  "SELECT count(*)::text FROM pg_trigger WHERE tgname = 't165_part_q2_local_trg' AND NOT tgisinternal" \
  "1" \
  'partition "t165_part_q2" has its own trigger "t165_part_q2_local_trg", which the parent has no counterpart for' \
  0 none t165_part_q2_local_trg

# Three partitions, the offender in the middle: neither the template (byte-first) nor the last.
plant "$UP" "-- @phase: expand
CREATE TABLE public.t165_part (id bigint NOT NULL, at timestamptz NOT NULL, note text NOT NULL,
  CONSTRAINT t165_part_pkey PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');
CREATE TABLE public.t165_part_q2 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-04-01Z') TO (TIMESTAMPTZ '2026-07-01Z');
CREATE TABLE public.t165_part_q3 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2026-07-01Z') TO (TIMESTAMPTZ '2026-10-01Z');
GRANT SELECT, INSERT ON public.t165_part TO app_rw;
ALTER TABLE public.t165_part_q2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY t165_part_q2_mid ON public.t165_part_q2 FOR SELECT TO app_rw USING (note <> 'm');"
plant "$DOWN" "DROP TABLE public.t165_part;"
sed 's/^/   plant up:   /' "$UP"
node scripts/db-migrate.ts up >"$OUT.p" 2>&1 || { cat "$OUT.p"; abort "K179: the plant did not apply"; }
got=$(psql -X -A -t -q -c "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relispartition AND c.relkind = 'r' AND c.relname LIKE 't165\_part\_%'")
[ "$got" = "t165_part_q1,t165_part_q2,t165_part_q3" ] || abort "K179: the three partitions did not land: [$got]"
echo "   plant landed: partitions in byte order [$got]; the template is t165_part_q1 and the offender is t165_part_q2, neither first nor last"
check K179 "(T-165 r1) three partitions, the offending policy on the middle one: refused, naming that partition" I-PART 'partition "t165_part_q2" has its own policy "t165_part_q2_mid"'

# QA's A17 stage 2: the attach that changed the verdict before this rework.
plant_two_partitions "ALTER TABLE public.t165_part_q2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY t165_part_q2_only ON public.t165_part_q2 FOR SELECT TO app_rw USING (note <> 'x');" ""
node scripts/db-migrate.ts up >"$OUT.p" 2>&1 || { cat "$OUT.p"; abort "K180: the plant did not apply"; }
psql -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE public.t165_part_a0 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2025-01-01Z') TO (TIMESTAMPTZ '2026-01-01Z')" >/dev/null || abort "K180: the attach failed"
got=$(psql -X -A -t -q -c "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relispartition AND c.relkind = 'r' AND c.relname LIKE 't165\_part\_%'")
[ "$got" = "t165_part_a0,t165_part_q1,t165_part_q2" ] || abort "K180: the attach did not land: [$got]"
got=$(psql -X -A -t -q -c "SELECT c.relname || '/' || pol.polname FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relname LIKE 't165\_part%'")
[ "$got" = "t165_part_q2/t165_part_q2_only" ] || abort "K180: the policy is no longer there: [$got]"
echo "   attach landed: partitions [$(psql -X -A -t -q -c "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relispartition AND c.relkind = 'r' AND c.relname LIKE 't165\_part\_%'")], the template is now t165_part_a0; pg_policy STILL [$got]"
check K180 "(T-165 r1, OD-155) QA's A17 stage 2: a partition that sorts FIRST attached, so the template changes — the policy on t165_part_q2 is refused just the same" I-PART 'partition "t165_part_q2" has its own policy "t165_part_q2_only"'

echo "== T-165 rework 2 (OE-37 (A)): the mirror is read on EVERY partition (OD-157); a partition's rule, statistics object and replica identity are read (OD-158)"
# OD-157: until rework 2 the parent -> partition mirror (every constraint and index the PARENT owns
# must have a counterpart) was built from the TEMPLATE's names alone. qa-verification measured an
# index the parent has and a NON-template partition lacks passing twice (E19), and a refusal on the
# template disappearing when a partition that sorts first was attached (T1). K181 and K182a/b are
# those two shapes; each `m` variant restores the template-only mirror and shows the defect writing.
MIRROR_TEMPLATE_ONLY_FROM="    for (const p of local) {
      const counterparts = new Set(p.names.map((n) => n.to).filter((t) => t !== null));"
MIRROR_TEMPLATE_ONLY_TO="    for (const p of local.filter((q) => q.name === template.name)) {
      const counterparts = new Set(p.names.map((n) => n.to).filter((t) => t !== null));"
# parent_index_children: the partitions whose index is attached to the parent's t165_part_tag_idx,
# and whether the parent's index is valid, read from the catalogue (pg_inherits over index relations).
parent_index_children() {
  psql -X -A -t -q -c "SELECT coalesce(string_agg(tc.relname, ',' ORDER BY tc.relname), '') || '/' || (SELECT i.indisvalid::text FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid WHERE ci.relname = 't165_part_tag_idx') FROM pg_inherits h JOIN pg_class ci ON ci.oid = h.inhparent JOIN pg_index x ON x.indexrelid = h.inhrelid JOIN pg_class tc ON tc.oid = x.indrelid WHERE ci.relname = 't165_part_tag_idx'"
}
# mirror_plant <partition that gets the child index>: the parent with q1 (the template) and q2, an
# index on the parent ONLY, and a child index created and ATTACHed on that one partition alone.
mirror_plant() {
  plant_two_partitions "CREATE INDEX t165_part_tag_idx ON ONLY public.t165_part (note);
CREATE INDEX t165_part_$1_tag_idx ON public.t165_part_$1 (note);
ALTER INDEX public.t165_part_tag_idx ATTACH PARTITION public.t165_part_$1_tag_idx;" ""
  sed 's/^/   plant up:   /' "$UP"
  node scripts/db-migrate.ts up >"$OUT.p" 2>&1 || { cat "$OUT.p"; abort "mirror_plant $1: the plant did not apply"; }
}

mirror_plant q1
got=$(parent_index_children)
[ "$got" = "t165_part_q1/false" ] || abort "K181: the plant did not land: parent index children/valid [$got], expected [t165_part_q1/false]"
echo "   plant landed, read from the catalogue: the parent's index is attached on [t165_part_q1] only, and is valid=false"
node scripts/db-introspect.ts --check >"$OUT" 2>&1
judge K181 "(T-165 r2, OD-157) QA's E19: an index the PARENT has that the NON-template partition lacks: refused, naming that partition" I-PART "$?" 'it owns "t165_part_tag_idx", which partition "t165_part_q2" has no counterpart for'
mutate "$PARTITION" "$MIRROR_TEMPLATE_ONLY_FROM" "$MIRROR_TEMPLATE_ONLY_TO"
git diff -U0 -- "$PARTITION" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
write_judge K181m "(T-165 r2) RED BEFORE: the template-only mirror restored (asserted above), which is what the step did before rework 2: the write succeeds, and the parent's index is rendered as though every partition had it" 0 none t165_part_tag_idx 1
restore

mirror_plant q2
got=$(parent_index_children)
[ "$got" = "t165_part_q2/false" ] || abort "K182a: the plant did not land: parent index children/valid [$got], expected [t165_part_q2/false]"
echo "   plant landed, read from the catalogue: the parent's index is attached on [t165_part_q2] only; the TEMPLATE t165_part_q1 lacks it"
node scripts/db-introspect.ts --check >"$OUT" 2>&1
judge K182a "(T-165 r2, OD-157) QA's T1 stage 1: the same index attached on the NON-template partition only, so the TEMPLATE lacks it: refused, naming the template" I-PART "$?" 'it owns "t165_part_tag_idx", which partition "t165_part_q1" has no counterpart for'
psql -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE public.t165_part_a0 PARTITION OF public.t165_part FOR VALUES FROM (TIMESTAMPTZ '2025-01-01Z') TO (TIMESTAMPTZ '2026-01-01Z')" >/dev/null || abort "K182b: the attach failed"
got=$(psql -X -A -t -q -c "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relispartition AND c.relkind = 'r' AND c.relname LIKE 't165\_part\_%'")
[ "$got" = "t165_part_a0,t165_part_q1,t165_part_q2" ] || abort "K182b: the attach did not land: [$got]"
got=$(parent_index_children)
[ "$got" = "t165_part_a0,t165_part_q2/false" ] || abort "K182b: after the attach the parent's index children/valid are [$got], expected [t165_part_a0,t165_part_q2/false]"
echo "   attach landed: partitions [t165_part_a0,t165_part_q1,t165_part_q2], the template is now t165_part_a0 (PostgreSQL gave it a child index); the parent's index is attached on [t165_part_a0,t165_part_q2], so t165_part_q1 STILL lacks it"
node scripts/db-introspect.ts --check >"$OUT" 2>&1
judge K182b "(T-165 r2, OD-157) QA's T1 stage 2: a partition that sorts FIRST attached, so the template changes and nothing else does: STILL refused, naming t165_part_q1" I-PART "$?" 'it owns "t165_part_tag_idx", which partition "t165_part_q1" has no counterpart for'
mutate "$PARTITION" "$MIRROR_TEMPLATE_ONLY_FROM" "$MIRROR_TEMPLATE_ONLY_TO"
git diff -U0 -- "$PARTITION" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
write_judge K182m "(T-165 r2) RED BEFORE: the template-only mirror restored (asserted above): the attach that changed the template makes the refusal disappear and the write succeeds (QA's T1)" 0 none t165_part_tag_idx 1
restore

# OD-158: a RULE, an extended statistics object and a REPLICA IDENTITY on a partition were read by
# nothing and named in no list. PostgreSQL 18 clones none of them from the parent (rework 2, M1), so
# each is always the partition's own, exactly like a policy. Each case plants one on the NON-template
# partition; each `m` variant removes that one branch of the partition read.
NO_RULE_READ_FROM="                              FROM pg_rewrite r
                             WHERE r.ev_class = ch.oid"
NO_RULE_READ_TO="                              FROM pg_rewrite r
                             WHERE false AND r.ev_class = ch.oid"
NO_STATS_READ_FROM="                              FROM pg_statistic_ext s
                             WHERE s.stxrelid = ch.oid"
NO_STATS_READ_TO="                              FROM pg_statistic_ext s
                             WHERE false AND s.stxrelid = ch.oid"
NO_REPLIDENT_READ_FROM="                             WHERE ch.relreplident <> 'd') m))"
NO_REPLIDENT_READ_TO="                             WHERE false AND ch.relreplident <> 'd') m))"

partlocal_case K183 "(T-165 r2, OD-158) a RULE on the non-template partition (QA's E3): refused" \
  "CREATE RULE t165_part_q2_rule AS ON DELETE TO public.t165_part_q2 DO INSTEAD NOTHING;" \
  "" \
  "SELECT c.relname || '/' || r.rulename FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE c.relname LIKE 't165\_part%'" \
  "t165_part_q2/t165_part_q2_rule" \
  'partition "t165_part_q2" has its own rule "t165_part_q2_rule", which the parent has no counterpart for \(PostgreSQL clones no rule to a partition' \
  0 none t165_part_q2_rule no-rule-read

partlocal_case K184 "(T-165 r2, OD-158) an extended STATISTICS object on the non-template partition (QA's E9): refused" \
  "CREATE STATISTICS public.t165_part_q2_stat ON id, note FROM public.t165_part_q2;" \
  "" \
  "SELECT c.relname || '/' || s.stxname FROM pg_statistic_ext s JOIN pg_class c ON c.oid = s.stxrelid WHERE c.relname LIKE 't165\_part%'" \
  "t165_part_q2/t165_part_q2_stat" \
  'partition "t165_part_q2" has its own statistics object "t165_part_q2_stat", which the parent has no counterpart for' \
  0 none t165_part_q2_stat no-statistics-read

partlocal_case K185 "(T-165 r2, OD-158) REPLICA IDENTITY FULL on the non-template partition (QA's E16): refused" \
  "ALTER TABLE public.t165_part_q2 REPLICA IDENTITY FULL;" \
  "" \
  "SELECT string_agg(relname || '=' || relreplident::text, ',' ORDER BY relname) FROM pg_class WHERE relname LIKE 't165\_part%' AND relkind IN ('r', 'p')" \
  "t165_part=d,t165_part_q1=d,t165_part_q2=f" \
  'partition "t165_part_q2" has its own replica identity "FULL", which the parent has no counterpart for' \
  0 none 'REPLICA IDENTITY' no-replica-identity-read

partlocal_case K186 "(T-165 r2, OD-158) REPLICA IDENTITY USING INDEX on the TEMPLATE partition, the same answer: refused" \
  "ALTER TABLE public.t165_part_q1 REPLICA IDENTITY USING INDEX t165_part_q1_pkey;" \
  "" \
  "SELECT string_agg(relname || '=' || relreplident::text, ',' ORDER BY relname) FROM pg_class WHERE relname LIKE 't165\_part%' AND relkind IN ('r', 'p')" \
  "t165_part=d,t165_part_q1=i,t165_part_q2=d" \
  'partition "t165_part_q1" has its own replica identity "USING INDEX", which the parent has no counterpart for' \
  0 none 'REPLICA IDENTITY' no-replica-identity-read

# CONTROL, and a stated bound: the same three on the PARENT reach no partition (M1), so the read of
# partitions finds nothing to refuse and the write succeeds. What it also shows: none of the three is
# described by db/schema.ts for the parent either, as for every table (T-138 § contract §6).
plant_two_partitions "ALTER TABLE public.t165_part REPLICA IDENTITY FULL;
CREATE RULE t165_part_rule AS ON DELETE TO public.t165_part DO INSTEAD NOTHING;
CREATE STATISTICS public.t165_part_stat ON id, note FROM public.t165_part;" ""
sed 's/^/   plant up:   /' "$UP"
node scripts/db-migrate.ts up >"$OUT.p" 2>&1 || { cat "$OUT.p"; abort "K187: the plant did not apply"; }
got=$(psql -X -A -t -q -c "SELECT string_agg(c.relname || '=' || c.relreplident::text || '/' || (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class = c.oid) || '/' || (SELECT count(*) FROM pg_statistic_ext s WHERE s.stxrelid = c.oid), ',' ORDER BY c.relname) FROM pg_class c WHERE c.relname LIKE 't165\_part%' AND c.relkind IN ('r', 'p')")
[ "$got" = "t165_part=f/1/1,t165_part_q1=d/0/0,t165_part_q2=d/0/0" ] || abort "K187: the plant did not land: [$got]"
echo "   plant landed, read from the catalogue (relreplident/rules/statistics): [$got]"
write_judge K187 "(T-165 r2) CONTROL: a rule, a statistics object and REPLICA IDENTITY FULL on the PARENT reach no partition, so nothing is refused; none is described by db/schema.ts" 0 none t165_part_rule
restore

# BOUND, stated in the contract's residue (R2): a partition can DISABLE the trigger it was cloned from
# its parent. pg_trigger.tgenabled is not read, so this changes what DML on that partition does and
# the check passes. Kept as a case so the residue is measured, not assumed.
plant_two_partitions "CREATE FUNCTION public.t165_noop() RETURNS trigger LANGUAGE plpgsql AS \$fn\$ BEGIN RETURN NEW; END \$fn\$;
CREATE TRIGGER t165_part_trg BEFORE INSERT ON public.t165_part FOR EACH ROW EXECUTE FUNCTION public.t165_noop();
ALTER TABLE public.t165_part_q2 DISABLE TRIGGER t165_part_trg;" "DROP FUNCTION public.t165_noop();"
sed 's/^/   plant up:   /' "$UP"
node scripts/db-migrate.ts up >"$OUT.p" 2>&1 || { cat "$OUT.p"; abort "K188: the plant did not apply"; }
got=$(psql -X -A -t -q -c "SELECT string_agg(c.relname || '=' || t.tgenabled::text, ',' ORDER BY c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 't165_part_trg'")
[ "$got" = "t165_part=O,t165_part_q1=O,t165_part_q2=D" ] || abort "K188: the plant did not land: [$got]"
echo "   plant landed, read from the catalogue (tgenabled): [$got]"
write_judge K188 "(T-165 r2) BOUND: a partition DISABLEs the trigger cloned from its parent; tgenabled is not read, so the write succeeds (R2's residue)" 0 none DISABLE
restore

echo "== T-165 rework 2: the merge with T-153 — a partition's int8 columns are held through its parent"
# T-153's per-column int8 match (step 5a) reads every relation of kind r/p/v/m/f in public, which
# includes partitions; step 4b removes them from the rendering. Measured on the merge commit 32eab2d:
# every partition int8 column was then [I-MAP] "the rendering declares no relation". K150 is the
# control (its fixture has `seq bigserial` and `amount bigint` on the parent); K189 removes the
# exclusion and the same fixture is refused exactly that way.
policy_fixture "$PART_FIXTURE"
mutate "$SCRIPT" "  const partitionNames = new Set(partitions.map((r) => r.name));" "  const partitionNames = new Set<string>();"
git diff -U0 -- "$SCRIPT" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check K189 "(T-165 r2) RED BEFORE: step 5a's partition exclusion removed, so each partition's int8 column is matched on its own: refused" I-MAP 'int8 column "t165_part_q1"."seq" but the rendering declares no relation "t165_part_q1"'

echo "== T-153 (OD-107): bigint in drizzle's bigint mode, counted against the catalogue; geometry admitted only as a scalar 2D point"
# The plant: an identity PK, an FK to an identity PK, NOT NULL, nullable, DEFAULT 0, a bigint[] with a
# default above 2^53, the int8 spelling, and a view. Its int8 columns, named from this SQL: t153_parent 1
# (id), t153_money 7 (id, parent_id, amount_minor, maybe_minor, zero_minor, minor_list, int8_spelled),
# t153_money_v 2 (id, amount_minor): 10. T-232: every count below is that share + BASE (the committed
# set's int8 columns, read before any plant); K58/K59 plant 4 (3 matched), K60 6, K61/K62 1.
plant_bigint() {
  plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_parent (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text);
CREATE TABLE public.t153_money (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  parent_id bigint NOT NULL REFERENCES public.t153_parent (id),
  amount_minor bigint NOT NULL,
  maybe_minor bigint,
  zero_minor bigint NOT NULL DEFAULT 0,
  minor_list bigint[] NOT NULL DEFAULT '{1,9007199254740993}',
  int8_spelled int8);
CREATE VIEW public.t153_money_v AS SELECT id, amount_minor FROM public.t153_money;"
  plant "$DOWN" "DROP VIEW public.t153_money_v;
DROP TABLE public.t153_money;
DROP TABLE public.t153_parent;"
}

# The driver round trip, through pg + drizzle-orm and the db/schema.ts just written. A value written
# through drizzle is a bigint or a number according to the column's own (element) mode, so the same
# script reads the defect when the mapping is reverted (K53).
T153_ROUNDTRIP=$(
  cat <<'EOF'
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { t153Money, t153MoneyV } from "./db/schema.ts";
const pool = new pg.Pool();
const db = drizzle(pool);
const show = (v) => (Array.isArray(v) ? v.map(show).join(",") : `${typeof v} ${String(v)}`);
const big = (col, s) => ((col.baseColumn ?? col).dataType === "bigint" ? BigInt(s) : Number(s));
try {
  await pool.query("INSERT INTO t153_parent (note) VALUES ('p')");
  await pool.query("INSERT INTO t153_money (parent_id, amount_minor, int8_spelled) VALUES (1, 9007199254740993, -9223372036854775808)");
  const [r] = await db.select().from(t153Money);
  console.log(`READ id ${show(r.id)}`);
  console.log(`READ amountMinor ${show(r.amountMinor)}`);
  console.log(`READ int8Spelled ${show(r.int8Spelled)}`);
  console.log(`READ minorList ${show(r.minorList)}`);
  console.log(`READ maybeMinor ${String(r.maybeMinor)}`);
  const [v] = await db.select().from(t153MoneyV);
  console.log(`READ view amountMinor ${show(v.amountMinor)}`);
  await db.insert(t153Money).values({ parentId: r.parentId, amountMinor: big(t153Money.amountMinor, "9007199254740995"), minorList: [big(t153Money.minorList, "9007199254740995"), big(t153Money.minorList, "-9223372036854775807")] });
  const back = await pool.query("SELECT amount_minor::text AS a, minor_list::text AS l FROM t153_money ORDER BY id DESC LIMIT 1");
  console.log(`WRITE database text amount_minor ${back.rows[0].a} minor_list ${back.rows[0].l}`);
} catch (e) {
  console.log(`ROUNDTRIP THREW ${e.constructor.name}: ${e.message}; cause: ${e.cause?.message}`);
}
await pool.end();
EOF
)

# The importer: lines 4-6 assign bigints, lines 7-9 numbers (select, insert, array element), line 10 null.
T153_BITE_TEXT="import type { t153Money } from '../../../db/schema.ts';
type Row = typeof t153Money.\$inferSelect;
type Ins = typeof t153Money.\$inferInsert;
export const exactSelect: Row['amountMinor'] = 9007199254740993n;
export const exactInsert: Ins['amountMinor'] = 9007199254740993n;
export const exactList: Row['minorList'] = [9007199254740993n];
export const numberSelect: Row['amountMinor'] = 5;
export const numberInsert: Ins['amountMinor'] = 5;
export const numberList: Row['minorList'] = [5];
export const absent: Row['maybeMinor'] = null;"

# tsc_errors: the root program's `<file>:<line> TS<code>` set, sorted, space-separated (the importer planted).
tsc_errors() {
  plant "$T153_BITE" "$T153_BITE_TEXT"
  node_modules/.bin/tsc --noEmit -p tsconfig.json >"$OUT.tsc" 2>&1
  grep -oE '^[^(: ]+\([0-9]+,[0-9]+\): error TS[0-9]+' "$OUT.tsc" | sed -E 's/^([^(]+)\(([0-9]+),[0-9]+\): error (TS[0-9]+)$/\1:\2 \3/' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

# bigint_facts lossless|lossy: facts about the rendering, the driver and the importer, into $OUT.f.
bigint_facts() {
  local line
  node --input-type=module -e "$T153_ROUNDTRIP" >"$OUT.rt" 2>&1
  if [ "$1" = lossless ]; then
    # T-232 rework 1 (QA-F1): each line counted inside the declaration the plant's SQL puts it in, not over
    # the whole file (a committed `id bigint … IDENTITY` or `amount_minor bigint` renders the same line).
    for spec in 't153Parent|id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(' \
      't153Money|id: bigint({ mode: "bigint" }).primaryKey().generatedByDefaultAsIdentity(' \
      't153Money|parentId: bigint("parent_id", { mode: "bigint" }).notNull(),' \
      't153Money|amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),' \
      't153Money|maybeMinor: bigint("maybe_minor", { mode: "bigint" }),' \
      't153Money|zeroMinor: bigint("zero_minor", { mode: "bigint" }).default(0n).notNull(),' \
      't153Money|minorList: bigint("minor_list", { mode: "bigint" }).array().default([1n, 9007199254740993n]).notNull(),' \
      't153Money|int8Spelled: bigint("int8_spelled", { mode: "bigint" }),' \
      't153MoneyV|id: bigint({ mode: "bigint" }),' \
      't153MoneyV|amountMinor: bigint("amount_minor", { mode: "bigint" }),'; do
      fact "db/schema.ts, inside ${spec%%|*}: lines containing [${spec#*|}]" "$(block_count "${spec%%|*}" "${spec#*|}")" 1
    done
    for b in t153Parent t153Money t153MoneyV; do
      fact "db/schema.ts, inside $b: lines in number mode or with drizzle-kit's bigint hint" "$(block_count "$b" 'mode: "number"')/$(block_count "$b" 'You can use { mode: "bigint" }')" 0/0
    done
    fact "the generator's bigint line (the plant's 10 int8 columns, from its SQL, + BASE $BASE_INT8 matched / $BASE_INT8_PULLED pulled, each matched per column)" "$(grep -cE "^  bigint: $((BASE_INT8_PULLED + 10)) column\\(s\\) rewritten to drizzle's bigint mode; $((BASE_INT8 + 10)) of the catalogue's $((BASE_INT8 + 10)) int8 column\\(s\\) matched per column against [0-9]+ parsed relation\\(s\\)" "$OUT")" 1
    for line in 'READ id bigint 1' 'READ amountMinor bigint 9007199254740993' 'READ int8Spelled bigint -9223372036854775808' \
      'READ minorList bigint 1,bigint 9007199254740993' 'READ maybeMinor null' 'READ view amountMinor bigint 9007199254740993' \
      'WRITE database text amount_minor 9007199254740995 minor_list {9007199254740995,-9223372036854775807}'; do
      fact "driver round trip prints [$line]" "$(grep -cxF -- "$line" "$OUT.rt")" 1
    done
    fact "importer: exactly TS2322 on the three number lines (7-9), the bigints and null accepted" "$(tsc_errors)" "$T153_BITE:7 TS2322 $T153_BITE:8 TS2322 $T153_BITE:9 TS2322"
  else
    fact "db/schema.ts, inside t153Money: drizzle-kit's number-mode amount_minor" "$(block_count t153Money 'amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),')" 1
    fact "driver round trip prints [READ amountMinor number 9007199254740992]" "$(grep -cxF 'READ amountMinor number 9007199254740992' "$OUT.rt")" 1
    fact "importer: TS2322 on the three bigint lines (4-6) and the three number lines (7-9) SILENT" "$(tsc_errors)" "$T153_BITE:4 TS2322 $T153_BITE:5 TS2322 $T153_BITE:6 TS2322"
  fi
  sed 's/^/driver: /' "$OUT.rt" >>"$OUT.f"
}

plant_bigint
write_schema
node scripts/db-introspect.ts --check >"$OUT" 2>&1
code=$?
: >"$OUT.f"
nf=0
nok=0
bigint_facts lossless
m0=$(stats_mark)
psql -X -q -v ON_ERROR_STOP=1 -c ANALYZE >/dev/null || abort "ANALYZE failed"
[ "$(stats_mark)" != "$m0" ] || abort "ANALYZE did not land on pg_class"
node scripts/db-introspect.ts --check >"$OUT.2" 2>&1
fact "after ANALYZE (asserted landed), the check again: exit" "$?" 0
fact "after ANALYZE, the check again: byte-identical lines" "$(grep -c 'byte-identical to a fresh introspection' "$OUT.2")" 1
[ "$nok" -eq "$nf" ] && echo "ALL $nf BIGINT FACTS HOLD" >>"$OUT.f"
cat "$OUT.f" >>"$OUT"
judge K50 "(T-153) CONTROL: bigint PK/FK/identity, NOT NULL, nullable, DEFAULT 0, bigint[] with a default above 2^53, int8, a view: bigint mode, exact through the driver both ways, a number refused at the importer" PASS "$code" '^ALL [0-9]+ BIGINT FACTS HOLD$'
grep -E '^fact |^driver: |^  bigint: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
restore

plant_bigint
mutate "$RENDER" "    BIGINT_NUMBER_COLUMN," "    /\$^()()()()()/g,"
check K51 "(T-153) the bigint-mode rewrite deleted: the hint it did not consume is refused, nothing written" I-MAP "rendering line [0-9]+ still carries drizzle-kit's bigint hint comment after the bigint-mode rewrite"

T153_NOOP="  if (body !== '') return { ok: true, body, columns: 0 };"
# T-153 rework 1: the per-column catalogue match turned off, for K53's RED BEFORE.
T153_MATCH_OFF="  const int8 = { problems: [] as string[], int8: body.length * 0, matched: 0, relations: 0 };"
plant_bigint
mutate "$RENDER" "export function mapBigintColumns(body: string): BigintResult {" "export function mapBigintColumns(body: string): BigintResult {
$T153_NOOP"
grep -qxF -- "$T153_NOOP" "$RENDER" || abort "the mapBigintColumns no-op did not land"
check K52 "(T-153 r1) the rewrite AND its leftover-hint check deleted: the per-column catalogue match still refuses the number-mode rendering, naming the column" I-MAP "int8 column \"t153_money\"\\.\"amount_minor\" \\(bigint\\) is rendered on line [0-9]+ in drizzle's \"number\" mode, so it would reach importers as a JS number"

plant_bigint
mutate "$RENDER" "export function mapBigintColumns(body: string): BigintResult {" "export function mapBigintColumns(body: string): BigintResult {
$T153_NOOP"
node scripts/negative-tests/mutate.mjs "$RENDER" "  const int8 = matchInt8Columns(body, columns);" "$T153_MATCH_OFF" || abort "mutation anchor missing in $RENDER"
{ grep -qxF -- "$T153_NOOP" "$RENDER" && grep -qxF -- "$T153_MATCH_OFF" "$RENDER"; } || abort "the T-153 mapping was not fully reverted in $RENDER"
git diff -U0 -- "$RENDER" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
node scripts/db-introspect.ts --write >"$OUT.w" 2>&1
wcode=$?
node scripts/db-introspect.ts --check >"$OUT" 2>&1
code=$?
: >"$OUT.f"
nf=0
nok=0
fact "write with the mapping reverted: exit" "$wcode" 0
bigint_facts lossy
[ "$nok" -eq "$nf" ] && echo "ALL $nf RED-BEFORE FACTS HOLD" >>"$OUT.f"
cat "$OUT.f" >>"$OUT"
judge K53 "(T-153) RED BEFORE: the whole mapping reverted (asserted above): written in number mode, 9007199254740993 read as 9007199254740992, and the importer refuses bigints while accepting numbers" PASS "$code" '^ALL [0-9]+ RED-BEFORE FACTS HOLD$'
grep -E '^fact |^driver: READ amountMinor' "$OUT" | cut -c1-240 | sed 's/^/       /'
restore

mutate "$RENDER" "      FROM pg_attribute a" "      FROM pg_attribute_t153 a"
check K54 "(T-153) the column-type query unreadable, committed tree: refused" I-MAP 'cannot read column types from the catalogue'

T153_GEO_ROUNDTRIP=$(
  cat <<'EOF'
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { t153Geo } from "./db/schema.ts";
const pool = new pg.Pool();
const db = drizzle(pool);
try {
  await pool.query("INSERT INTO t153_geo (id, g_point, g_point_nosrid) VALUES (1, ST_GeomFromText('POINT(33.25 35.5)', 4326), ST_GeomFromText('POINT(1 2)'))");
  const [r] = await db.select().from(t153Geo);
  console.log(`READ gPoint ${JSON.stringify(r.gPoint)}`);
  console.log(`READ gPointNosrid ${JSON.stringify(r.gPointNosrid)}`);
  await db.insert(t153Geo).values({ id: 2, gPoint: [33.125, 34.875], gPointNosrid: [5, -6.5] });
  const back = await pool.query("SELECT ST_AsEWKT(g_point) AS p, ST_AsEWKT(g_point_nosrid) AS n FROM t153_geo WHERE id = 2");
  console.log(`WRITE gPoint ${back.rows[0].p}`);
  console.log(`WRITE gPointNosrid ${back.rows[0].n}`);
} catch (e) {
  console.log(`ROUNDTRIP THREW ${e.constructor.name}: ${e.message}; cause: ${e.cause?.message}`);
}
await pool.end();
EOF
)
plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_geo (id integer PRIMARY KEY, g_point geometry(Point,4326), g_point_nosrid geometry(Point));"
plant "$DOWN" "DROP TABLE public.t153_geo;"
write_schema
node scripts/db-introspect.ts --check >"$OUT" 2>&1
code=$?
: >"$OUT.f"
nf=0
nok=0
fact "db/schema.ts, inside t153Geo: the Point,4326 column" "$(block_count t153Geo 'gPoint: geometry("g_point", { type: "point", srid: 4326 }),')" 1
fact "db/schema.ts, inside t153Geo: the Point column" "$(block_count t153Geo 'gPointNosrid: geometry("g_point_nosrid", { type: "point" }),')" 1
fact "the generator admits the plant's 2 point columns + BASE $BASE_POINTS" "$(grep -cE "^  bigint: .*; geometry: $((BASE_POINTS + 2)) point column\(s\) admitted\$" "$OUT")" 1
node --input-type=module -e "$T153_GEO_ROUNDTRIP" >"$OUT.rt" 2>&1
for line in 'READ gPoint [33.25,35.5]' 'READ gPointNosrid [1,2]' 'WRITE gPoint SRID=4326;POINT(33.125 34.875)' 'WRITE gPointNosrid POINT(5 -6.5)'; do
  fact "driver round trip prints [$line]" "$(grep -cxF -- "$line" "$OUT.rt")" 1
done
sed 's/^/driver: /' "$OUT.rt" >>"$OUT.f"
[ "$nok" -eq "$nf" ] && echo "ALL $nf POINT FACTS HOLD" >>"$OUT.f"
cat "$OUT.f" >>"$OUT"
judge K55 "(T-153) CONTROL: geometry(Point,4326) and geometry(Point) are admitted, and read and write through the driver" PASS "$code" '^ALL [0-9]+ POINT FACTS HOLD$'
grep -E '^fact |^driver: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
restore

plant_geometry_refused() {
  plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_geo (id integer PRIMARY KEY, g_poly geometry(Polygon,4326), g_line geometry(LineString,4326),
  g_multipoint geometry(MultiPoint,4326), g_pointz geometry(PointZ,4326), g_any geometry, g_point_arr geometry(Point,4326)[]);"
  plant "$DOWN" "DROP TABLE public.t153_geo;"
}
plant_geometry_refused
check_facts K56 "(T-153) Polygon, LineString, MultiPoint, PointZ, plain geometry and Point[]: each I-MAP with its catalogue type, nothing admitted" I-MAP \
  '^  - \[I-MAP\] column "t153_geo"\."g_poly" has database type .geometry\(Polygon,4326\).: ' \
  '^  - \[I-MAP\] column "t153_geo"\."g_line" has database type .geometry\(LineString,4326\).: ' \
  '^  - \[I-MAP\] column "t153_geo"\."g_multipoint" has database type .geometry\(MultiPoint,4326\).: ' \
  '^  - \[I-MAP\] column "t153_geo"\."g_pointz" has database type .geometry\(PointZ,4326\).: ' \
  '^  - \[I-MAP\] column "t153_geo"\."g_any" has database type .geometry.: ' \
  '^  - \[I-MAP\] column "t153_geo"\."g_point_arr" has database type .geometry\(Point,4326\)\[\].: ' \
  "^  bigint: .*; geometry: $BASE_POINTS point column\(s\) admitted\$"

plant_geometry_refused
node scripts/db-introspect.ts --write >"$OUT" 2>&1
code=$?
total=$((total + 1))
w_banners=$(grep -cE '^GATE (PASS|FAIL|CRASH)  db:introspect($| — |: )' "$OUT")
w_tags=$(grep -oE '^  - \[I-[A-Z]+\]' "$OUT" | sed -E 's/^  - \[(.*)\]$/\1/' | sort -u | tr '\n' ' ' | sed 's/ $//')
w_geo=$(grep -c '^  - \[I-MAP\] column "t153_geo"\.' "$OUT")
if [ "$code" -eq 1 ] && [ "$w_banners" -eq 1 ] && [ "$w_tags" = "I-MAP" ] && [ "$w_geo" -eq 6 ] && git diff --quiet -- "$SCHEMA"; then v=ok; else v=BAD; bad=$((bad + 1)); fi
printf '%-4s %s  %s\n       exit %s; banners %s; expected I-MAP x6 and db/schema.ts unchanged; reported %s x%s; db/schema.ts %s\n' "$v" K56w "(T-153) the same plant in WRITE mode: refused, and db/schema.ts is not written" "$code" "$w_banners" "${w_tags:-none}" "$w_geo" "$(git diff --quiet -- "$SCHEMA" && echo unchanged || echo CHANGED)"
restore

T153_GEO_DEFECT=$(
  cat <<'EOF'
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { t153Geo } from "./db/schema.ts";
const pool = new pg.Pool();
const db = drizzle(pool);
await pool.query("INSERT INTO t153_geo (id, g_poly, g_pointz) VALUES (1, ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326), ST_GeomFromText('POINT Z (33 35 7)', 4326))");
for (const key of ["gPoly", "gPointz"]) {
  try {
    const rows = await db.select({ v: t153Geo[key] }).from(t153Geo);
    console.log(`READ ${key} ${JSON.stringify(rows[0].v)}`);
  } catch (e) {
    console.log(`READ ${key} THREW ${e.message}`);
  }
}
await pool.end();
EOF
)
plant_geometry_refused
mutate "$RENDER" "    if (!GEOMETRY_ADMITTED.test(c.type)) {" "    if (c.type === 't153 rule deleted') {"
git diff -U0 -- "$RENDER" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
node scripts/db-introspect.ts --write >"$OUT.w" 2>&1
wcode=$?
node scripts/db-introspect.ts --check >"$OUT" 2>&1
code=$?
: >"$OUT.f"
nf=0
nok=0
fact "write with the geometry rule deleted: exit" "$wcode" 0
fact "db/schema.ts, inside t153Geo: the polygon column as drizzle-kit renders it" "$(block_count t153Geo 'gPoly: geometry("g_poly", { type: "polygon", srid: 4326 }),')" 1
node --input-type=module -e "$T153_GEO_DEFECT" >"$OUT.rt" 2>&1
fact "driver prints [READ gPoly THREW Unsupported geometry type]" "$(grep -cxF 'READ gPoly THREW Unsupported geometry type' "$OUT.rt")" 1
fact "driver prints [READ gPointz [33,35]] (the stored Z, 7, is lost)" "$(grep -cxF 'READ gPointz [33,35]' "$OUT.rt")" 1
sed 's/^/driver: /' "$OUT.rt" >>"$OUT.f"
[ "$nok" -eq "$nf" ] && echo "ALL $nf RED-BEFORE FACTS HOLD" >>"$OUT.f"
cat "$OUT.f" >>"$OUT"
judge K57 "(T-153) RED BEFORE: the geometry rule deleted (asserted above): the same plant passes, and a polygon select throws while PointZ loses Z" PASS "$code" '^ALL [0-9]+ RED-BEFORE FACTS HOLD$'
grep -E '^fact |^driver: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
restore

# ---------------------------------------------------------------------------------------------
# T-153 rework 1 — K58–K62 (OD-147, OD-148). The per-relation COUNT is replaced by a PER-COLUMN
# match against the catalogue, over the rendering parsed as TypeScript. K58/K59 are the route it
# closes: drizzle-kit 0.31.10 renders a VIEW's and a MATERIALIZED VIEW's int8[] column with NO
# `.array()`, which a count cannot see. K60 is the RED BEFORE for both, with the count restored by
# a mutation asserted landed: the run passes, the columns are written scalar, and drizzle's read of
# each THROWS. K61/K62 are the false refusals the count and the line-local hint scan produced on
# drizzle-kit's own output: a text DEFAULT holding a bigint-mode call, and one equal to the hint
# sentence. Each has its own RED BEFORE with the old mechanism restored.

# MUTATION: the original per-relation COUNT of bigint-mode calls in the relation's rendering TEXT.
T153_COUNT_MUTATION=$(
  cat <<'EOF'
  const int8 = ((): Int8Match => {
    const BIGINT_MODE_CALL = /\bbig(?:int|serial)\((?:"[^"\n]*", )?\{ mode: "bigint" \}\)/g;
    const out: string[] = [];
    const starts = [...body.matchAll(/^export const [\w$]+ = /gm)];
    const rendered = new Map<string, number>();
    starts.forEach((m, i) => {
      const text = body.slice(m.index, starts[i + 1]?.index ?? body.length);
      const rel = /^export const [\w$]+ = pg(?:Table|View|MaterializedView)\("([^"]+)"/.exec(text)?.[1];
      if (rel === undefined) return;
      rendered.set(rel, (rendered.get(rel) ?? 0) + [...text.matchAll(BIGINT_MODE_CALL)].length);
    });
    const cat = new Map<string, string[]>();
    for (const c of columns) {
      if (c.kind !== 'int8') continue;
      cat.set(c.relation, [...(cat.get(c.relation) ?? []), c.column]);
    }
    let n = 0;
    let g = 0;
    for (const rel of [...new Set([...rendered.keys(), ...cat.keys()])].sort()) {
      const want = cat.get(rel) ?? [];
      const have = rendered.get(rel) ?? 0;
      n += want.length;
      g += have;
      if (have !== want.length)
        out.push(`relation ${JSON.stringify(rel)}: the catalogue has ${String(want.length)} int8 column(s) [${want.join(', ')}] but the rendering has ${String(have)} bigint column(s) in drizzle's bigint mode (T-153, OD-107)`);
    }
    return { problems: out, int8: n, matched: g, relations: rendered.size };
  })();
EOF
)
count_mutation() {
  mutate "$RENDER" "  const int8 = matchInt8Columns(body, columns);" "$T153_COUNT_MUTATION"
  grep -qF 'const BIGINT_MODE_CALL = /\bbig(?:int|serial)\(' "$RENDER" || abort "the count mutation did not land in $RENDER"
  git diff --numstat -- "$RENDER" | sed 's/^/   count mutation landed (added removed file): /'
}

# The array plant: an int8[] and a text[], in a table, a view and a materialized view. The text[] is NOT a
# control for the view: drizzle-kit renders it with no .array() there too (OD-149; K60 asserts it).
# <rels> picks which of the two derived relations the plant creates.
plant_arrays() {
  local v='' d=''
  case "$1" in
    view) v="CREATE VIEW public.t153_arr_v AS SELECT id, amounts, labels FROM public.t153_arr;"; d="DROP VIEW public.t153_arr_v;" ;;
    matview) v="CREATE MATERIALIZED VIEW public.t153_arr_mv AS SELECT id, amounts, labels FROM public.t153_arr;"; d="DROP MATERIALIZED VIEW public.t153_arr_mv;" ;;
    both) v="CREATE VIEW public.t153_arr_v AS SELECT id, amounts, labels FROM public.t153_arr;
CREATE MATERIALIZED VIEW public.t153_arr_mv AS SELECT id, amounts, labels FROM public.t153_arr;"; d="DROP MATERIALIZED VIEW public.t153_arr_mv;
DROP VIEW public.t153_arr_v;" ;;
  esac
  plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_arr (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amounts bigint[] NOT NULL,
  labels text[] NOT NULL);
$v"
  plant "$DOWN" "$d
DROP TABLE public.t153_arr;"
}

plant_arrays view
check_facts K58 "(T-153 r1) a VIEW over a bigint[] column: drizzle-kit renders it with no .array(), and the per-column match refuses it by name (OD-147)" I-MAP \
  '^  - \[I-MAP\] int8 column "t153_arr_v"\."amounts" is an array of 1 dimension\(s\) in the catalogue \(bigint\[\], attndims 0\) but the rendering on line [0-9]+ carries 0 \.array\(\) call\(s\)' \
  '!^  - \[I-MAP\] int8 column "t153_arr"\.' \
  "^  bigint: [0-9]+ column\(s\) rewritten to drizzle.s bigint mode; $((BASE_INT8 + 3)) of the catalogue.s $((BASE_INT8 + 4)) int8 column\(s\) matched per column"

plant_arrays matview
check_facts K59 "(T-153 r1) a MATERIALIZED VIEW over a bigint[] column: the same, refused by name (OD-147)" I-MAP \
  '^  - \[I-MAP\] int8 column "t153_arr_mv"\."amounts" is an array of 1 dimension\(s\) in the catalogue \(bigint\[\], attndims 0\) but the rendering on line [0-9]+ carries 0 \.array\(\) call\(s\)' \
  '!^  - \[I-MAP\] int8 column "t153_arr"\.' \
  "^  bigint: [0-9]+ column\(s\) rewritten to drizzle.s bigint mode; $((BASE_INT8 + 3)) of the catalogue.s $((BASE_INT8 + 4)) int8 column\(s\) matched per column"

# The RED BEFORE probe: read each array column through drizzle and the db/schema.ts just written.
T153_ARR_ROUNDTRIP=$(
  cat <<'EOF'
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { t153Arr, t153ArrV, t153ArrMv } from "./db/schema.ts";
const pool = new pg.Pool();
const db = drizzle(pool);
await pool.query("INSERT INTO t153_arr (amounts, labels) VALUES ('{9007199254740993,-9223372036854775808}', '{alpha,beta}')");
await pool.query("REFRESH MATERIALIZED VIEW t153_arr_mv");
const show = (v) => (Array.isArray(v) ? `[${v.map(show).join(", ")}]` : `${typeof v} ${String(v)}`);
for (const [label, rel, key] of [["table amounts", t153Arr, "amounts"], ["view amounts", t153ArrV, "amounts"], ["matview amounts", t153ArrMv, "amounts"], ["table labels", t153Arr, "labels"], ["view labels", t153ArrV, "labels"]]) {
  try {
    const rows = await db.select({ v: rel[key] }).from(rel);
    console.log(`READ ${label} ${show(rows[0].v)}`);
  } catch (e) {
    console.log(`READ ${label} THREW ${e.constructor.name}: ${e.message}`);
  }
}
await pool.end();
EOF
)
plant_arrays both
count_mutation
node scripts/db-introspect.ts --write >"$OUT.w" 2>&1
wcode=$?
node scripts/db-introspect.ts --check >"$OUT" 2>&1
code=$?
: >"$OUT.f"
nf=0
nok=0
fact "write with the per-relation COUNT restored: exit" "$wcode" 0
fact "db/schema.ts, inside t153Arr: the TABLE's bigint[] keeps .array()" "$(block_count t153Arr 'amounts: bigint({ mode: "bigint" }).array()')" 1
fact "db/schema.ts, inside t153ArrV and t153ArrMv: the bigint[] rendered WITHOUT .array()" "$(block_count -x t153ArrV '	amounts: bigint({ mode: "bigint" }),')/$(block_count -x t153ArrMv '	amounts: bigint({ mode: "bigint" }),')" 1/1
fact "the count balances at the plant's 6 + BASE $BASE_INT8, so nothing is reported" "$(grep -cE "^  bigint: [0-9]+ column\(s\) rewritten to drizzle's bigint mode; $((BASE_INT8 + 6)) of the catalogue's $((BASE_INT8 + 6)) int8 column\(s\)" "$OUT")" 1
node --input-type=module -e "$T153_ARR_ROUNDTRIP" >"$OUT.rt" 2>&1
fact "driver: the TABLE's bigint[] reads exactly" "$(grep -cxF 'READ table amounts [bigint 9007199254740993, bigint -9223372036854775808]' "$OUT.rt")" 1
fact "driver: the VIEW's bigint[] read THREW" "$(grep -c '^READ view amounts THREW SyntaxError' "$OUT.rt")" 1
fact "driver: the MATERIALIZED VIEW's bigint[] read THREW" "$(grep -c '^READ matview amounts THREW SyntaxError' "$OUT.rt")" 1
# OE-35 (A): the lost .array() is not bigint's. Read from the RENDERING, because a driver read cannot
# tell: node-postgres parses a text[] result field into a JS array by its type OID, and drizzle's scalar
# text() reader is the identity, so a view rendered WITHOUT .array() still reads [alpha, beta] (OD-149).
fact "db/schema.ts, inside t153Arr: the TABLE's text[] keeps .array()" "$(block_count t153Arr 'labels: text().array()')" 1
fact "db/schema.ts, inside t153ArrV and t153ArrMv: the text[] rendered WITHOUT .array() too, so the loss is not bigint's (OD-149, T-187)" "$(block_count -x t153ArrV '	labels: text(),')/$(block_count -x t153ArrMv '	labels: text(),')" 1/1
fact "driver: the TABLE's text[] reads as an array" "$(grep -cxF 'READ table labels [string alpha, string beta]' "$OUT.rt")" 1
fact "driver: the VIEW's text[] reads as the same array although rendered scalar (node-postgres parses by OID; this read cannot tell .array() from none)" "$(grep -cxF 'READ view labels [string alpha, string beta]' "$OUT.rt")" 1
sed 's/^/driver: /' "$OUT.rt" >>"$OUT.f"
[ "$nok" -eq "$nf" ] && echo "ALL $nf RED-BEFORE FACTS HOLD" >>"$OUT.f"
cat "$OUT.f" >>"$OUT"
judge K60 "(T-153 r1) RED BEFORE: with the per-relation COUNT restored (asserted above), the view's and matview's bigint[] pass as scalar and drizzle's read of each THROWS (OD-147)" PASS "$code" '^ALL [0-9]+ RED-BEFORE FACTS HOLD$'
grep -E '^fact |^driver: READ |^  bigint: ' "$OUT" | cut -c1-240 | sed 's/^/       /'
restore

# K61/K62: two text DEFAULTs on drizzle-kit's own output that the OLD text-shaped mechanisms refused.
plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_counttext (
  amount bigint NOT NULL,
  note text NOT NULL DEFAULT 'bigint(\"q\", { mode: \"bigint\" })');"
plant "$DOWN" "DROP TABLE public.t153_counttext;"
write_schema
check_facts K61 "(T-153 r1) a text column whose DEFAULT is the TEXT of a bigint-mode call, beside a real bigint: the default no longer affects the judgement (OD-148)" PASS \
  "^  bigint: $((BASE_INT8_PULLED + 1)) column\(s\) rewritten to drizzle.s bigint mode; $((BASE_INT8 + 1)) of the catalogue.s $((BASE_INT8 + 1)) int8 column\(s\) matched per column"
plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_counttext (
  amount bigint NOT NULL,
  note text NOT NULL DEFAULT 'bigint(\"q\", { mode: \"bigint\" })');"
plant "$DOWN" "DROP TABLE public.t153_counttext;"
count_mutation
check K61r "(T-153 r1) RED BEFORE: with the per-relation COUNT restored (asserted above), the same text DEFAULT is counted as a bigint column and the relation is falsely refused" I-MAP \
  'relation "t153_counttext": the catalogue has 1 int8 column\(s\) \[amount\] but the rendering has 2 bigint column\(s\)'

T153_HINT='// You can use { mode: "bigint" } if numbers are exceeding js number limitations'
plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_hinttext (
  amount bigint NOT NULL,
  note text NOT NULL DEFAULT '$T153_HINT');"
plant "$DOWN" "DROP TABLE public.t153_hinttext;"
write_schema
check_facts K62 "(T-153 r1) a text column whose DEFAULT is drizzle-kit's hint sentence: admitted, because the leftover-hint scan skips string literals (QR-A2)" PASS \
  "^  bigint: $((BASE_INT8_PULLED + 1)) column\(s\) rewritten to drizzle.s bigint mode; $((BASE_INT8 + 1)) of the catalogue.s $((BASE_INT8 + 1)) int8 column\(s\) matched per column"
plant "$UP" "-- @phase: expand
CREATE TABLE public.t153_hinttext (
  amount bigint NOT NULL,
  note text NOT NULL DEFAULT '$T153_HINT');"
plant "$DOWN" "DROP TABLE public.t153_hinttext;"
mutate "$RENDER" "    if (ranges.some(([a, b]) => i >= a && i < b)) continue;" "    if (ranges.length === -1) continue;"
git diff -U0 -- "$RENDER" | grep -E '^[-+][^-+]' | sed 's/^/   mutation:   /'
check K62r "(T-153 r1) RED BEFORE: with the string-literal filter removed (asserted above), the hint sentence inside the text DEFAULT is falsely refused" I-MAP \
  "rendering line [0-9]+ still carries drizzle-kit's bigint hint comment"

echo
if [ "$bad" -eq 0 ]; then
  echo "ALL $total CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $total cases misbehaved"
exit 1
