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
#
# T-168: EXIT/INT/TERM traps call restore(), so an INTERRUPTED run puts the two tracked files C3K
# and C87 delete back too — see the block beside the traps.
#
# T-227 adds three sections: R-PROTECTED-TABLE (CX*), R-PROTECTED-EXTENSION (CE*) and U&"…" decoding
# (CU*); CNA is re-classed from a CONTROL to R-PROTECTED-TABLE.
#
# T-167 adds one section (CV*): R-VENDOR-SQL, the reviewed `-- @vendor-sql` marker (OD-150).
#
# T-241 adds one section (CQ*): R-RESTORE-PUBLIC, the reviewed `-- @restore-public` marker that lets a
# down file restore exactly what its up file revoked from PUBLIC (OE-76, OD-275), and `checkwhy`, which
# also asserts the REASON the gate gives (a PASS case asserts the admission record).
#
# T-031 adds four sections: R-ROLE-SWITCH (CR*), R-RUN-AS (CM*), runner-read marker lines in a
# merged migration under R-MERGED (C8F-C8I, OD-86), and R-TRAILER (CT*). The R-TRAILER cases
# COMMIT in a second detached worktree under /tmp (git identity t031-negative-test, never merged),
# run that tree's gate with --base=<this tree's HEAD>, and remove the worktree at the end. The
# commits stay in the object store as unreachable objects until git gc.
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
  # T-138 (OD-80 cases) plants db/schema.ts; restore it when it is tracked at HEAD.
  if git cat-file -e HEAD:db/schema.ts 2>/dev/null; then git checkout -q -- db/schema.ts; fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "ABORT: the tree did not restore cleanly"
    git status --porcelain
    exit 2
  fi
}

# T-168 (OD-161/OD-162). Every case calls restore() explicitly, so a COMPLETE run already put the
# tree back. These traps close the interrupt window: two cases delete a TRACKED file and leave it
# deleted until the next restore() — `rm -f db/schema.ts` at C3K, and the bare `rm "$DOWN1"` at C87,
# which removes db/migrations/0001_extensions_and_roles.down.sql, a MERGED migration. Until this
# ticket a Ctrl-C in either window left the file gone.
#
# The restoring instrument is restore() itself — `git checkout -q -- "$M"` plus the conditional
# checkout of db/schema.ts — not a delete-list: these are files git already has, so git is the
# backup. restore() exits 2 when the tree does not come back clean, so "restored", "could not
# restore" and "was never touched" stay three distinguishable outcomes from inside a trap too.
#
# BOUND, stated rather than assumed: restore() is a working-tree instrument. It does not remove a
# detached worktree that C99 or a CT* case registered under the container's /tmp; an interrupt there
# still leaves a stale entry in .git/worktrees, which `git status --porcelain` never showed and this
# ticket does not change. `git worktree prune` clears it.
trap 'restore; rm -f "$OUT"' EXIT
trap 'echo; echo "INTERRUPTED (SIGINT) — restoring the working tree"; restore; rm -f "$OUT"; trap - EXIT; exit 130' INT
trap 'echo; echo "TERMINATED (SIGTERM) — restoring the working tree"; restore; rm -f "$OUT"; trap - EXIT; exit 143' TERM

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
  # T-241: a case may also name the REASON it expects (WHY, set by checkwhy). The gate's output must
  # contain it verbatim, so a refusal for some other reason, or a PASS that admitted nothing, is BAD.
  if [ "$verdict" = ok ] && [ -n "$WHY" ] && ! grep -qF -- "$WHY" "$OUT"; then verdict=BAD; fi
  [ "$verdict" = ok ] || bad=$((bad + 1))
  printf '%-4s %s  %s\n       exit %s; expected %s; reported %s\n' "$verdict" "$id" "$desc" "$code" "$expect" "${got:-none}"
  if [ -n "$WHY" ]; then printf '       expected in the output: %s\n' "$WHY"; fi
  grep -E '^  - \[' "$OUT" | cut -c1-240 | sed 's/^/       /'
}

WHY=
# checkwhy <id> <description> <expect> <reason>: check, and the gate's output must contain <reason> (T-241).
checkwhy() {
  WHY=$4
  check "$1" "$2" "$3"
  WHY=
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
pair expand "REASSIGN OWNED BY app_ddl TO app_rw;"
check C1I "QA X7 (QA-F3): REASSIGN OWNED BY app_ddl TO app_rw, which transfers audit_log unnamed" R-APPEND-ONLY
pair expand "REASSIGN OWNED BY app_admin_rw TO app_rw;"
check C1J "REASSIGN OWNED in any form (the gate cannot see what a role owns)" R-APPEND-ONLY
pair expand "CREATE ROLE t021_login_principal NOLOGIN IN ROLE app_ddl;"
check C1K "CREATE ROLE … IN ROLE app_ddl (membership in the owner of every table, without a GRANT)" R-APPEND-ONLY
pair expand "ALTER GROUP app_ddl ADD USER app_rw;"
check C1L "ALTER GROUP app_ddl ADD USER (membership in the owner of every table, without a GRANT)" R-APPEND-ONLY
# T-021 rework 2 (OE-24, QR-F1/OD-77): QA's three spellings, verbatim from RR3 Z1-Z3. Each made
# app_rw the owner of audit_log with UPDATE and DELETE at the database (QA RR4 D2-D4, superuser).
pair expand "ALTER TABLE public.audit_log ADD COLUMN note text, OWNER TO app_rw;"
check C1M "QA Z1 (QR-F1): OWNER TO as the second action of a multi-action ALTER TABLE" R-APPEND-ONLY
pair expand "ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY, OWNER TO app_rw;"
check C1N "QA Z2 (QR-F1): OWNER TO second, after a non-expand action" R-APPEND-ONLY
pair expand "ALTER TABLE public.audit_log * OWNER TO app_rw;"
check C1O "QA Z3 (QR-F1): OWNER TO with the inheritance marker *" R-APPEND-ONLY
pair expand "ALTER TABLE public.t021_thing ADD COLUMN note text, OWNER TO app_ddl;"
check C1P "CONTROL: a multi-action OWNER TO on a table that is not append-only" PASS
pair expand "ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.t021_thing OWNER TO app_ddl;"
check C1Q "CONTROL: OWNER TO in the NEXT statement, on a table that is not append-only (per statement, not per file)" PASS
# T-021 rework 2: the rule attacked with spellings for the same effect (evidence § Rework 2 — ATTACK,
# A1-AC). Those marked (db) were measured transferring ownership at the database (§ Rework 2 — DB).
pair expand "alter table audit_log
  add column note text,
  owner to app_rw;"
check C1R "A1: lower case, one action per line, OWNER TO last" R-APPEND-ONLY
pair expand 'ALTER TABLE "public"."audit_log" ADD COLUMN note text, OWNER TO app_rw;'
check C1S "A2: quoted, schema-qualified name, multi-action" R-APPEND-ONLY
pair expand "ALTER TABLE public.audit_log* OWNER TO app_rw;"
check C1T "A3 (db): the * marker with no space" R-APPEND-ONLY
pair expand "ALTER TABLE IF EXISTS ONLY public.audit_log ENABLE ROW LEVEL SECURITY, OWNER TO app_rw;"
check C1U "A4 (db): IF EXISTS ONLY, OWNER TO second" R-APPEND-ONLY
pair expand "ALTER TABLE ONLY (public.audit_log) OWNER TO app_rw;"
check C1V "A5 (db): ONLY ( name )" R-APPEND-ONLY
pair expand "ALTER TABLE audit_log_p20260901 * OWNER TO app_rw;"
check C1W "A6 (db, as a named partition): a partition, with *" R-APPEND-ONLY
pair expand "ALTER TABLE case_note ADD COLUMN note text, /* hand over */ OWNER TO app_rw;"
check C1X "A7: case_note, a block comment between the actions" R-APPEND-ONLY
pair expand "DO \$\$ BEGIN EXECUTE 'ALTER TABLE decision_record ADD COLUMN note text, OWNER TO app_rw'; END \$\$;"
check C1Y "A8: decision_record, multi-action inside an EXECUTE string" R-APPEND-ONLY
pair expand "ALTER TABLE public.audit_log ADD COLUMN note text, OWNER TO CURRENT_USER;"
check C1Z "A9 (db; succeeds for a login in app_ddl only): OWNER TO CURRENT_USER, second" R-APPEND-ONLY
pair expand "ALTER TABLE public.audit_log OWNER TO app_rw, ADD COLUMN note text;"
check C1ZA "AA (db): OWNER TO first, another action after it" R-APPEND-ONLY
pair expand "ALTER TABLE public.audit_log -- hand over
  OWNER TO app_rw;"
check C1ZB "AB: a line comment between the name and OWNER TO" R-APPEND-ONLY
pair expand "SELECT 1;"
plant "$DOWN" "ALTER TABLE public.audit_log ADD COLUMN note text, OWNER TO app_rw;"
check C1ZC "AC: in a DOWN file, multi-action" R-APPEND-ONLY
pair expand "ALTER TABLE public.audit_log ADD COLUMN note text DEFAULT 'OWNER TO app_rw';"
check C1ZD "CONTROL (O1): OWNER TO inside a string DEFAULT on audit_log" PASS
pair expand "ALTER TABLE public.audit_log ADD COLUMN owner_to text;"
check C1ZE "CONTROL (O3): a column named owner_to on audit_log" PASS
pair expand "ALTER TABLE public.t021_thing ADD COLUMN log_id bigint REFERENCES public.audit_log (id), OWNER TO app_ddl;"
check C1ZF "CONTROL (O5): a table referencing audit_log changes owner (audit_log is not in the name position)" PASS

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

echo "== R-CONTRACT-ALONE and the regenerated db/schema.ts (OD-80, T-138)"
git cat-file -e HEAD:db/schema.ts 2>/dev/null || {
  echo "ABORT: db/schema.ts is not committed at HEAD; the OD-80 cases need it"
  exit 2
}
# regen_schema: rewrite db/schema.ts as the generator would after a schema change (a changed
# body under a recomputed header); assert it differs from HEAD and its header verifies.
regen_schema() {
  node --input-type=module -e '
    import fs from "node:fs";
    import { renderSchemaFile, verifySchemaFile } from "./scripts/gates/lib/schema-digest.ts";
    const lines = fs.readFileSync("db/schema.ts", "utf8").split("\n");
    const version = /drizzle-kit (\S+) sha256/.exec(lines[2] ?? "")?.[1] ?? "unknown";
    const body = lines.slice(3).join("\n") + "export const t138Regenerated = 1;\n";
    fs.writeFileSync("db/schema.ts", renderSchemaFile(body, version));
    if (!verifySchemaFile(fs.readFileSync("db/schema.ts", "utf8")).ok) process.exit(3);
  ' || {
    echo "ABORT: regen_schema did not produce a verifying db/schema.ts"
    exit 2
  }
  if git diff --quiet -- db/schema.ts; then
    echo "ABORT: regen_schema did not change db/schema.ts"
    exit 2
  fi
}
# hand_edit_schema: append a line without touching the header; assert it landed.
hand_edit_schema() {
  printf '%s\n' 'export const handWritten = 1;' >>db/schema.ts
  if git diff --quiet -- db/schema.ts; then
    echo "ABORT: the hand edit did not change db/schema.ts"
    exit 2
  fi
}
pair contract "ALTER TABLE public.booking DROP COLUMN legacy_note;"
regen_schema
check C3H "CONTROL (OD-80): a contract migration with db/schema.ts regenerated beside it" PASS
pair contract "ALTER TABLE public.booking DROP COLUMN legacy_note;"
hand_edit_schema
check C3I "(OD-80) a contract migration with db/schema.ts edited by hand" R-CONTRACT-ALONE
pair contract "ALTER TABLE public.booking DROP COLUMN legacy_note;"
regen_schema
plant "$APP" "application code that stopped reading legacy_note"
check C3J "(OD-80) a contract migration, a regenerated db/schema.ts AND application code" R-CONTRACT-ALONE
pair contract "ALTER TABLE public.booking DROP COLUMN legacy_note;"
rm -f db/schema.ts
if [ -e db/schema.ts ]; then
  echo "ABORT: db/schema.ts still exists"
  exit 2
fi
check C3K "(OD-80) a contract migration with db/schema.ts deleted" R-CONTRACT-ALONE
hand_edit_schema
check C3L "CONTROL (bound): db/schema.ts edited by hand, no contract migration; this lint does not read it" PASS
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
pair contract "ALTER TABLE public.booking ADD COLUMN note text;
UPDATE public.booking SET note = legacy_note;
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C3C "QA X1 (QA-F1): an expand and a contract in ONE file declared contract" R-CONTRACT-PURE
plant "$UP" "-- @phase: contract
CREATE TABLE public.booking_note (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text);
GRANT SELECT, INSERT ON public.booking_note TO app_rw;
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C3D "QA X2 (QA-F1): CREATE TABLE + GRANT in a contract file with no down file (loses the down-file exemption)" "R-CONTRACT-PURE R-STRUCT"
pair contract "GRANT SELECT ON public.booking TO app_rw;
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C3E "a GRANT alone in a contract file" R-CONTRACT-PURE
pair contract "DO \$do\$ BEGIN EXECUTE 'CREATE INDEX booking_note_idx ON public.booking (note)'; END \$do\$;
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C3F "CREATE INDEX as an EXECUTE string in a contract file" R-CONTRACT-PURE
plant "$UP" "-- @phase: contract
REVOKE CREATE ON SCHEMA public FROM app_rw;
DROP INDEX IF EXISTS public.booking_legacy_note_idx;
COMMENT ON TABLE public.booking IS 'legacy_note removed';
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check C3G "CONTROL: a contract file of REVOKE CREATE, DROP INDEX, COMMENT ON and DROP COLUMN, no down file" PASS

echo "== R-PROTECTED (SD §DB-13 rule 7, §UC-4 part 1; T-020 contract §6; OD-73)"
pair expand "DROP TRIGGER trg_booking_sitter_bookable ON booking;"
check C40 "DROP TRIGGER trg_booking_sitter_bookable" R-PROTECTED
pair expand "CREATE OR REPLACE TRIGGER trg_booking_sitter_bookable
  BEFORE INSERT OR UPDATE OF sitter_id, status ON booking
  FOR EACH ROW WHEN (NEW.status IN ('confirmed'))
  EXECUTE FUNCTION assert_sitter_bookable();"
check C41 "its WHEN clause narrowed by CREATE OR REPLACE TRIGGER" R-PROTECTED
pair expand "ALTER TABLE booking DISABLE TRIGGER trg_booking_staffed_hours;"
check C42 "DISABLE TRIGGER trg_booking_staffed_hours (T-186: also R-TRIGGER-BYPASS, a protected trigger switched off by name)" "R-PROTECTED R-TRIGGER-BYPASS"
pair expand "CREATE OR REPLACE FUNCTION assert_within_staffed_hours() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;"
check C43 "assert_within_staffed_hours() replaced with a no-op" R-PROTECTED
pair expand "DROP FUNCTION public.trg_assert_answering_service_write_only() CASCADE;"
check C44 "OD-73 A5: DROP the guard event trigger's function CASCADE" "R-PROTECTED R-CASCADE"
pair expand "DROP FUNCTION public.assert_answering_service_write_only();
CREATE FUNCTION public.assert_answering_service_write_only() RETURNS void LANGUAGE sql AS 'SELECT';"
check C45 "OD-73 A4: DROP the guard function and install a no-op" R-PROTECTED
pair expand "ALTER EVENT TRIGGER trg_int10_answering_service DISABLE;"
check C46 "ALTER EVENT TRIGGER trg_int10_answering_service DISABLE (T-186: also R-TRIGGER-BYPASS)" "R-PROTECTED R-TRIGGER-BYPASS"
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
# T-186 (OD-217, T-030 QA-A2 L1/L3): the I-5 objects, and 0008's OE-47 objects, are protected.
pair expand "DROP TRIGGER trg_approval_four_eyes ON public.approval;"
check C4F "T-186 (QA L1): DROP TRIGGER trg_approval_four_eyes" R-PROTECTED
pair expand "CREATE OR REPLACE FUNCTION public.assert_second_actor_differs() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS \$fn\$ BEGIN RETURN NULL; END \$fn\$;"
check C4G "T-186 (QA L3): assert_second_actor_differs() replaced with a no-op" R-PROTECTED
pair expand "DROP TRIGGER trg_account_role_ts_senior_admin_only ON public.account_role;"
check C4H "T-186: DROP TRIGGER trg_account_role_ts_senior_admin_only (OE-47)" R-PROTECTED
pair expand "CREATE OR REPLACE FUNCTION public.assert_ts_senior_written_by_admin() RETURNS trigger LANGUAGE plpgsql AS \$fn\$ BEGIN RETURN NEW; END \$fn\$;"
check C4I "T-186: assert_ts_senior_written_by_admin() replaced with a no-op (OE-47)" R-PROTECTED
pair expand "-- @compliance-review: assert_second_actor_differs — T-186, OE-45
CREATE OR REPLACE FUNCTION public.assert_second_actor_differs() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS \$fn\$ BEGIN RETURN NULL; END \$fn\$;"
check C4J "CONTROL: the same replacement with a marker citing a ticket and a decision" PASS

echo "== R-TRIGGER-BYPASS"
pair expand "ALTER TABLE booking DISABLE TRIGGER ALL;"
check C50 "DISABLE TRIGGER ALL" R-TRIGGER-BYPASS
pair expand "ALTER TABLE booking DISABLE TRIGGER USER;"
check C51 "DISABLE TRIGGER USER" R-TRIGGER-BYPASS
pair expand "SET session_replication_role = replica;"
check C52 "SET session_replication_role" R-TRIGGER-BYPASS
pair expand "SELECT set_config('session_replication_role', 'replica', true);"
check C53 "set_config('session_replication_role', …)" R-TRIGGER-BYPASS
# T-186 (OD-217, T-030 QA-A2 L2): a protected trigger switched off BY NAME. No marker permits it.
pair expand "ALTER TABLE public.approval DISABLE TRIGGER trg_approval_four_eyes;"
check C5A "T-186 (QA L2): DISABLE TRIGGER trg_approval_four_eyes, no marker" "R-PROTECTED R-TRIGGER-BYPASS"
pair expand "-- @compliance-review: trg_approval_four_eyes — T-186, OD-217
ALTER TABLE public.approval DISABLE TRIGGER trg_approval_four_eyes;"
check C5B "the same DISABLE with a marker: the marker does not permit it" R-TRIGGER-BYPASS
pair expand "-- @compliance-review: trg_approval_four_eyes — T-186, OD-217
ALTER TABLE public.approval ENABLE REPLICA TRIGGER trg_approval_four_eyes;"
check C5C "ENABLE REPLICA TRIGGER trg_approval_four_eyes (fires only under replica), with a marker" R-TRIGGER-BYPASS
pair expand '-- @compliance-review: trg_approval_four_eyes — T-186, OD-217
alter table public.approval
  disable trigger "trg_approval_four_eyes";'
check C5D "lower case, a quoted name, across two lines, with a marker" R-TRIGGER-BYPASS
pair expand "-- @compliance-review: trg_account_role_ts_senior_admin_only — T-186, OE-47
ALTER TABLE public.account_role DISABLE TRIGGER trg_account_role_ts_senior_admin_only;"
check C5E "DISABLE TRIGGER trg_account_role_ts_senior_admin_only (OE-47), with a marker" R-TRIGGER-BYPASS
pair expand "-- @compliance-review: trg_int10_answering_service — T-186, OD-217
ALTER EVENT TRIGGER trg_int10_answering_service ENABLE REPLICA;"
check C5F "ALTER EVENT TRIGGER trg_int10_answering_service ENABLE REPLICA, with a marker" R-TRIGGER-BYPASS
pair expand "DO \$do\$ BEGIN EXECUTE 'ALTER TABLE public.approval DISABLE TRIGGER trg_approval_four_eyes'; END \$do\$;
-- @compliance-review: trg_approval_four_eyes — T-186, OD-217"
check C5G "inside a DO block, as an EXECUTE string, with a marker" R-TRIGGER-BYPASS
pair expand "ALTER TABLE public.approval DISABLE TRIGGER t186_scratch_trigger;"
check C5H "CONTROL: DISABLE TRIGGER naming a trigger that is not protected" PASS
pair expand "-- @compliance-review: trg_approval_four_eyes — T-186, OD-217
ALTER TABLE public.approval ENABLE ALWAYS TRIGGER trg_approval_four_eyes;"
check C5I "CONTROL: ENABLE ALWAYS TRIGGER (fires in every mode), with a marker" PASS
pair expand "ALTER TABLE public.approval DISABLE TRIGGER trg_approval_four_eyes_audit;"
check C5J "CONTROL: DISABLE TRIGGER naming a longer identifier that contains a protected name" PASS

# T-192 (OE-48, OD-224 A4): 0011's three objects are protected too.
pair expand "DROP TRIGGER trg_account_ts_senior_status_admin_only ON public.account;"
check CP1 "T-192: DROP TRIGGER trg_account_ts_senior_status_admin_only (OE-48)" R-PROTECTED
pair expand "CREATE OR REPLACE FUNCTION public.assert_ts_senior_account_written_by_admin() RETURNS trigger LANGUAGE plpgsql AS \$fn\$ BEGIN RETURN NEW; END \$fn\$;"
check CP2 "T-192: assert_ts_senior_account_written_by_admin() replaced with a no-op (OE-48)" R-PROTECTED
pair expand "-- @compliance-review: trg_account_ts_senior_status_admin_only — T-192, OE-48
ALTER TABLE public.account DISABLE TRIGGER trg_account_ts_senior_status_admin_only;"
check CP3 "T-192: DISABLE TRIGGER trg_account_ts_senior_status_admin_only, with a marker" R-TRIGGER-BYPASS
pair expand "DROP TRIGGER trg_account_role_ts_senior_no_truncate ON public.account_role;"
check CP4 "T-192: DROP TRIGGER trg_account_role_ts_senior_no_truncate (OD-224 A4)" R-PROTECTED
pair expand "-- @compliance-review: trg_account_role_ts_senior_no_truncate — T-192, OD-224
ALTER TABLE public.account_role DISABLE TRIGGER trg_account_role_ts_senior_no_truncate;"
check CP5 "T-192: DISABLE TRIGGER trg_account_role_ts_senior_no_truncate, with a marker" R-TRIGGER-BYPASS

echo "== R-PROTECTED-RENAME (T-192, OD-224 A2): a protected trigger or function is never renamed; no marker permits it"
pair contract "-- @compliance-review: trg_approval_four_eyes — T-192, OD-224
ALTER TRIGGER trg_approval_four_eyes ON public.approval RENAME TO t192_off;
ALTER TABLE public.approval DISABLE TRIGGER t192_off;"
check CN1 "T-186 QA X5: ONE contract file WITH a marker renames trg_approval_four_eyes, then disables it under the new name" R-PROTECTED-RENAME
pair contract "ALTER TRIGGER trg_approval_four_eyes ON public.approval RENAME TO t192_off;"
check CN2 "T-186 QA X4: the rename alone, NO marker" "R-PROTECTED R-PROTECTED-RENAME"
pair contract "-- @compliance-review: assert_second_actor_differs — T-192, OD-224
ALTER FUNCTION public.assert_second_actor_differs() RENAME TO t192_fn;"
check CN3 "T-186 QA X6: ALTER FUNCTION assert_second_actor_differs() RENAME, with a marker" R-PROTECTED-RENAME
pair contract "-- @compliance-review: assert_second_actor_differs — T-192, OD-224
ALTER FUNCTION public.assert_second_actor_differs() RENAME TO t192_fn;
CREATE OR REPLACE FUNCTION public.t192_fn() RETURNS trigger LANGUAGE plpgsql AS \$fn\$ BEGIN RETURN NULL; END \$fn\$;"
check CN4 "T-186 QA X7: rename the function, then no-op-replace it under the new name, with a marker (the CREATE is an expand)" "R-CONTRACT-PURE R-PROTECTED-RENAME"
pair contract "-- @compliance-review: trg_int10_answering_service — T-192, OD-224
ALTER EVENT TRIGGER trg_int10_answering_service RENAME TO t192_evt;"
check CN5 "ALTER EVENT TRIGGER trg_int10_answering_service RENAME, with a marker" R-PROTECTED-RENAME
pair contract '-- @compliance-review: trg_account_role_ts_senior_admin_only — T-192, OD-224
DO $do$ BEGIN EXECUTE '"'"'alter trigger "trg_account_role_ts_senior_admin_only"
  on public.account_role rename to t192_off'"'"'; END $do$;'
check CN6 "lower case, a quoted name, across two lines, as an EXECUTE string in a DO block, with a marker" R-PROTECTED-RENAME
pair contract "-- @compliance-review: trg_account_ts_senior_status_admin_only — T-192, OE-48
ALTER TRIGGER trg_account_ts_senior_status_admin_only ON public.account RENAME TO t192_off;"
check CN7 "T-192: 0011's OE-48 trigger renamed, with a marker" R-PROTECTED-RENAME
pair contract "-- @compliance-review: assert_second_actor_differs — T-192, OD-224
ALTER FUNCTION public.t192_noop() RENAME TO assert_second_actor_differs;"
check CN8 "a function renamed TO a protected name (a shadow), with a marker" R-PROTECTED-RENAME
pair contract "ALTER TRIGGER t192_scratch_trigger ON public.approval RENAME TO t192_scratch_two;"
check CN9 "CONTROL: renaming a trigger that is not protected" PASS
pair contract "ALTER TABLE public.approval RENAME TO approval_t192;"
check CNA "renaming the table that holds a protected trigger (a CONTROL until T-227; re-classed: R-PROTECTED-TABLE, OD-237 TL-2)" R-PROTECTED-TABLE
pair contract "ALTER TRIGGER trg_approval_four_eyes_audit ON public.approval RENAME TO t192_audit;"
check CNB "CONTROL: renaming a longer identifier that contains a protected name" PASS

echo "== R-ADMIN-MEMBERSHIP (T-192, OD-224 A3): no migration makes anyone a holder of app_admin_rw's privileges"
pair expand "GRANT app_admin_rw TO app_rw;"
check CA1 "T-186 QA X10: GRANT app_admin_rw TO app_rw" R-ADMIN-MEMBERSHIP
pair expand "ALTER GROUP app_admin_rw ADD USER app_rw;"
check CA2 "T-186 QA X11: ALTER GROUP app_admin_rw ADD USER app_rw" R-ADMIN-MEMBERSHIP
pair expand "CREATE ROLE t192_login LOGIN IN ROLE app_admin_rw;"
check CA3 "CREATE ROLE … IN ROLE app_admin_rw" R-ADMIN-MEMBERSHIP
pair expand 'grant app_rw, "app_admin_rw"
  to t192_login with inherit true;'
check CA4 "lower case, a quoted name second in the role list, across two lines, WITH INHERIT" R-ADMIN-MEMBERSHIP
pair expand "DO \$do\$ BEGIN EXECUTE 'GRANT app_admin_rw TO app_rw'; END \$do\$;"
check CA5 "inside a DO block, as an EXECUTE string" R-ADMIN-MEMBERSHIP
pair expand "ALTER USER app_admin_rw WITH BYPASSRLS;"
check CA6 "ALTER USER app_admin_rw (the role itself altered)" R-ADMIN-MEMBERSHIP
pair expand "GRANT SELECT (id) ON public.account TO app_admin_rw;"
check CA7 "CONTROL: a privilege granted TO app_admin_rw" PASS
pair expand "REVOKE app_admin_rw FROM app_rw;"
check CA8 "CONTROL: REVOKE app_admin_rw FROM app_rw" PASS
pair expand "COMMENT ON ROLE app_admin_rw IS 'the back-office role';"
check CA9 "CONTROL: COMMENT ON ROLE app_admin_rw" PASS
pair expand "GRANT app_rw TO t192_login;"
check CAA "CONTROL: membership in another role (app_rw) is not this rule's" PASS

echo "== R-PROTECTED-TABLE (T-227, OD-237 TL-2): account, account_role and approval are never renamed, moved or replaced; no marker permits it"
pair contract "ALTER TABLE public.account_role RENAME TO account_role_v1;"
check CX1 "T-192 tech-lead RN-TABLE-1: account_role renamed away" R-PROTECTED-TABLE
pair expand "CREATE TABLE public.account_role (account_id char(26), role text, revoked_at timestamptz);
GRANT SELECT, INSERT, UPDATE ON public.account_role TO app_rw;"
check CX2 "T-192 tech-lead RN-TABLE-2: a replacement account_role created (with its grant)" R-PROTECTED-TABLE
pair contract 'alter table if exists only
  "account" rename to account_v1;'
check CX3 "account renamed away: lower case, IF EXISTS ONLY, a quoted name, across two lines" R-PROTECTED-TABLE
pair expand "ALTER TABLE public.approval SET SCHEMA archive;"
check CX4 "approval moved to another schema (SET SCHEMA), which leaves the name free" R-PROTECTED-TABLE
pair contract "ALTER TABLE public.account_role_v2 RENAME TO account_role;"
check CX5 "another table renamed TO account_role" R-PROTECTED-TABLE
pair expand "CREATE VIEW public.approval AS SELECT * FROM public.approval_v1;"
check CX6 "a VIEW created under the name approval" R-PROTECTED-TABLE
pair expand "DO \$do\$ BEGIN EXECUTE 'create table \"account_role\" (account_id char(26), role text)'; END \$do\$;"
check CX7 "a replacement created by an EXECUTE string in a DO block, quoted" R-PROTECTED-TABLE
pair contract "ALTER TABLE public.account RENAME COLUMN locale TO locale_code;"
check CX8 "CONTROL: a column of account renamed (not the table)" PASS
pair contract "ALTER TRIGGER t227_scratch ON public.account_role RENAME TO t227_scratch_two;"
check CX9 "CONTROL: an unprotected trigger ON account_role renamed" PASS
pair expand "CREATE TABLE public.account_role_history (account_id char(26), role text);
GRANT SELECT ON public.account_role_history TO app_rw;"
check CXA "CONTROL: a table whose name starts with account_role" PASS
pair contract "ALTER TABLE public.t227_scratch RENAME TO t227_scratch_two;"
check CXB "CONTROL: an unrelated table renamed" PASS
pair expand "CREATE TABLE reporting.account (id char(26));
GRANT SELECT ON reporting.account TO app_rw;"
check CXC "CONTROL: a table named account in ANOTHER schema" PASS

echo "== R-PROTECTED-EXTENSION (T-227, OD-235): no protected object is made removable by DROP EXTENSION; no marker permits it"
pair expand "-- @compliance-review: trg_approval_four_eyes — T-227, OD-235
ALTER TRIGGER trg_approval_four_eyes ON public.approval DEPENDS ON EXTENSION pg_trgm;"
check CE1 "T-192 QA N17: ALTER TRIGGER trg_approval_four_eyes … DEPENDS ON EXTENSION, with a marker" R-PROTECTED-EXTENSION
pair expand "-- @compliance-review: assert_second_actor_differs — T-227, OD-235
ALTER FUNCTION public.assert_second_actor_differs() DEPENDS ON EXTENSION pg_trgm;"
check CE2 "ALTER FUNCTION <protected> DEPENDS ON EXTENSION, with a marker" R-PROTECTED-EXTENSION
pair expand "-- @compliance-review: assert_ts_senior_written_by_admin — T-227, OD-235
ALTER EXTENSION pg_trgm ADD FUNCTION public.assert_ts_senior_written_by_admin();"
check CE3 "ALTER EXTENSION … ADD FUNCTION <protected>, with a marker" R-PROTECTED-EXTENSION
pair expand "ALTER EXTENSION pg_trgm ADD TABLE public.approval;"
check CE4 "ALTER EXTENSION … ADD TABLE approval (names no protected object; the table's triggers go with it)" R-PROTECTED-EXTENSION
pair expand "-- @compliance-review: trg_account_ts_senior_status_admin_only — T-227, OD-235
DO \$do\$ BEGIN EXECUTE 'alter trigger trg_account_ts_senior_status_admin_only on public.account depends on extension pg_trgm'; END \$do\$;"
check CE5 "lower case, as an EXECUTE string in a DO block, with a marker" R-PROTECTED-EXTENSION
pair expand "ALTER FUNCTION public.t227_helper() DEPENDS ON EXTENSION pg_trgm;"
check CE6 "CONTROL: an unprotected function DEPENDS ON EXTENSION" PASS
pair expand "-- @compliance-review: trg_approval_four_eyes — T-227, OD-235
ALTER TRIGGER trg_approval_four_eyes ON public.approval NO DEPENDS ON EXTENSION pg_trgm;"
check CE7 "CONTROL: NO DEPENDS ON EXTENSION (removes the dependency), with a marker" PASS
pair expand "DROP EXTENSION pg_trgm;"
check CE8 "CONTROL, and the bound: DROP EXTENSION alone names nothing protected (T-192 QA N18r); step 1 is what is refused" PASS

echo "== U&\"…\" identifiers are decoded before every rule reads them (T-227, OD-235)"
pair contract 'ALTER TRIGGER U&"trg\005fapproval_four_eyes" ON public.approval RENAME TO t227_off;'
check CU1 "T-192 QA N15: U&\"trg\\005fapproval_four_eyes\" renamed, no marker" "R-PROTECTED R-PROTECTED-RENAME"
pair expand "DROP TRIGGER U&\"trg!005faccount!005frole_ts_senior_admin_only\" UESCAPE '!' ON public.account_role;"
check CU2 "UESCAPE '!': a protected trigger dropped, no marker" R-PROTECTED
pair expand '-- @compliance-review: trg_approval_four_eyes — T-227, OD-235
ALTER TABLE public.approval DISABLE TRIGGER u&"trg\+00005fapproval_four_eyes";'
check CU3 "the six-digit escape, lower-case u&, with a marker: DISABLE by name" R-TRIGGER-BYPASS
pair expand "DO \$do\$ BEGIN EXECUTE 'DROP TRIGGER U&\"trg\\005fapproval_four_eyes\" ON public.approval'; END \$do\$;"
check CU4 "inside an EXECUTE string in a DO block, no marker" R-PROTECTED
pair contract 'ALTER TABLE U&"approval" RENAME TO approval_v1;'
check CU5 "a protected table named with U& and no escape" R-PROTECTED-TABLE
pair contract 'ALTER TRIGGER U&"t227\005fscratch" ON public.approval RENAME TO t227_other;'
check CU6 "CONTROL: a U& name that decodes to an unprotected trigger" PASS
pair contract 'ALTER TRIGGER U&"trg\\005fapproval_four_eyes" ON public.approval RENAME TO t227_other;'
check CU7 "CONTROL: a doubled escape decodes to a literal backslash, so the name is not the protected one" PASS

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
pair expand "DROP OWNED BY app_rw;"
check C58 "DROP OWNED BY, which removes every object the role owns without naming one" R-CASCADE

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
pair expand "GRANT answering_service TO app_rw;"
check C68 "QA X4 (QA-F2): the role answering_service granted TO app_rw" R-ANSWERING-SERVICE
pair expand "GRANT INSERT ON out_of_hours_report TO answering_service WITH GRANT OPTION;"
check C69 "QA X5 (QA-F2): the permitted grant WITH GRANT OPTION" R-ANSWERING-SERVICE
pair expand "GRANT INSERT ON out_of_hours_report TO answering_service GRANTED BY app_ddl;"
check C6A "the permitted grant with GRANTED BY" R-ANSWERING-SERVICE
pair expand "GRANT INSERT ON out_of_hours_report TO answering_service, app_rw;"
check C6B "the permitted grant with a second grantee" R-ANSWERING-SERVICE
pair expand "CREATE ROLE t021_login_principal NOLOGIN IN ROLE answering_service;"
check C6C "CREATE ROLE … IN ROLE answering_service (membership without a GRANT)" R-ANSWERING-SERVICE
pair expand "CREATE ROLE t021_login_principal NOLOGIN ROLE answering_service;"
check C6H "CREATE ROLE … ROLE answering_service (the vendor becomes a member of the new role)" R-ANSWERING-SERVICE
pair expand "ALTER GROUP answering_service ADD USER app_rw;"
check C6D "ALTER GROUP answering_service ADD USER (membership without a GRANT)" R-ANSWERING-SERVICE
pair expand "ALTER TABLE public.out_of_hours_report OWNER TO answering_service;"
check C6E "ownership of a table transferred to answering_service" R-ANSWERING-SERVICE
pair expand "GRANT app_admin_rw, answering_service TO t021_login_principal;"
# Re-classed by T-192: the first role in the list is app_admin_rw, which R-ADMIN-MEMBERSHIP refuses too.
check C6F "answering_service second in a granted role list" "R-ADMIN-MEMBERSHIP R-ANSWERING-SERVICE"
pair expand "CREATE TABLE public.out_of_hours_report (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);
GRANT INSERT ON TABLE public.out_of_hours_report TO answering_service;"
check C6G "CONTROL: the permitted grant spelled ON TABLE public.out_of_hours_report" PASS
pair expand "REVOKE GRANT OPTION FOR INSERT ON out_of_hours_report FROM answering_service;"
check C6I "CONTROL: REVOKE GRANT OPTION FOR … FROM answering_service is not read as a grant" PASS

echo "== R-TABLE-GRANT (T-020 contract §4/§6)"
pair expand "CREATE TABLE public.t021_thing (id int);"
check C70 "CREATE TABLE with no GRANT" R-TABLE-GRANT
pair expand 'CREATE TABLE IF NOT EXISTS "t021_thing" (id int);
GRANT SELECT ON public.t021_other TO app_rw;'
check C71 "CREATE TABLE with a GRANT on a different table" R-TABLE-GRANT

echo "== R-VENDOR-SQL (T-167, OD-150): a reviewed marker admits vendor SQL inside ONE named body"
# The shape OD-150 found: a vendor's plpgsql whose format() format strings hold DDL the migration
# never executes. VFN is that shape; the gate reads it (T-031 § contract §4, case A09) and this
# section shows the marker stopping R-PHASE and R-TABLE-GRANT ACTING on what it reads, in the named
# body and nowhere else. `pair` puts `-- @phase: <p>` on line 1, so a marker written first in the
# SQL argument is still in the file header.
VFN='CREATE FUNCTION public.t167_vendor(tbl text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('"'"'DROP TABLE IF EXISTS public.%I'"'"', tbl);
END;
$fn$;'
VFN2='CREATE FUNCTION public.t167_other(tbl text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('"'"'CREATE TABLE public.%I (id int)'"'"', tbl);
END;
$fn$;'

echo "-- the marker works"
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN"
check CV00 "CONTROL: a DROP TABLE format string in the body the marker names" PASS
pair expand "-- @vendor-sql: public.t167_other — OD-150; T-167
$VFN2"
check CV01 "CONTROL: a CREATE TABLE format string in the body the marker names" PASS
pair expand "-- @vendor-sql: DO#1 — OD-150; T-167
DO \$d\$ BEGIN EXECUTE format('CREATE TABLE public.%I (id int)', 'x'); END \$d\$;"
check CV02 "CONTROL: an anonymous DO block, named DO#1" PASS
pair expand "-- @vendor-sql: DO#2 — OD-150; T-167
DO \$d\$ BEGIN PERFORM 1; END \$d\$;
DO \$d\$ BEGIN EXECUTE format('CREATE TABLE public.%I (id int)', 'x'); END \$d\$;"
check CV03 "CONTROL: the SECOND DO block, named DO#2" PASS
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
-- @vendor-sql: public.t167_other — OD-150; T-167
$VFN
$VFN2"
check CV04 "CONTROL: two markers, two bodies, one file" PASS
pair expand "-- @vendor-sql: public.t167_clean — OD-150; T-167
CREATE FUNCTION public.t167_clean() RETURNS int LANGUAGE sql AS \$fn\$ SELECT 1 \$fn\$;"
check CV05 "CONTROL: a marker that suppresses nothing (the gate prints 'suppressed nothing')" PASS

echo "-- the body is refused WITHOUT the marker: A09's reading is untouched"
pair expand "$VFN"
check CV10 "no marker: the DROP TABLE format string in the body is still R-PHASE" R-PHASE
pair expand "$VFN2"
check CV11 "no marker: the CREATE TABLE format string in the body is still R-TABLE-GRANT" R-TABLE-GRANT
pair expand "-- @vendor-sql: public.t167_other — OD-150; T-167
$VFN
$VFN2"
check CV12 "the marker names t167_other; the statement in t167_vendor's body is still refused" R-PHASE
pair expand "-- @vendor-sql: DO#1 — OD-150; T-167
DO \$d\$ BEGIN PERFORM 1; END \$d\$;
DO \$d\$ BEGIN EXECUTE format('CREATE TABLE public.%I (id int)', 'x'); END \$d\$;"
check CV13 "the marker names DO#1; the statement in DO#2 is still refused" R-TABLE-GRANT

echo "-- the marker exempts the body, never the file"
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN
DROP TABLE public.t167_real;"
check CV14 "a real top-level DROP TABLE beside a marked body" R-PHASE
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN
CREATE TABLE public.t167_real (id int);"
check CV15 "a real top-level CREATE TABLE with no grant beside a marked body" R-TABLE-GRANT

plant "$UP" "-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN"
plant "$DOWN" "-- the down file of a planted migration"
check CV16 "R-PHASE's own marker clause: a correct @vendor-sql marker does not stand in for -- @phase" R-PHASE

echo "-- the marker reaches no other rule"
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
CREATE FUNCTION public.t167_vendor() RETURNS void LANGUAGE plpgsql AS \$fn\$
BEGIN
  EXECUTE format('DROP TRIGGER trg_booking_sitter_bookable ON public.booking');
END;
\$fn\$;"
check CV20 "R-PROTECTED: a protected object named inside the marked body" R-PROTECTED
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
CREATE FUNCTION public.t167_vendor() RETURNS void LANGUAGE plpgsql AS \$fn\$
BEGIN
  EXECUTE format('GRANT UPDATE ON public.audit_log TO app_rw');
END;
\$fn\$;"
check CV21 "R-APPEND-ONLY: an UPDATE grant on audit_log inside the marked body" R-APPEND-ONLY
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
CREATE FUNCTION public.t167_vendor() RETURNS void LANGUAGE plpgsql AS \$fn\$
BEGIN
  SET ROLE app;
END;
\$fn\$;"
check CV22 "R-ROLE-SWITCH: a SET ROLE inside the marked body" R-ROLE-SWITCH
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN"
plant "$UP2" "-- @phase: contract
ALTER TABLE public.booking DROP COLUMN legacy_note;"
check CV23 "R-CONTRACT-ALONE: a contract migration in the same change set as the marked expand" R-CONTRACT-ALONE
pair contract "-- @vendor-sql: public.t167_vendor — OD-150; T-167
CREATE FUNCTION public.t167_vendor(tbl text) RETURNS void LANGUAGE plpgsql AS \$fn\$
BEGIN
  EXECUTE format('CREATE TABLE public.%I (id int)', tbl);
END;
\$fn\$;"
check CV24 "R-CONTRACT-PURE: the marked body's CREATE is still an expand statement in a contract file" R-CONTRACT-PURE
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
CREATE FUNCTION public.t167_vendor() RETURNS void LANGUAGE plpgsql AS \$fn\$
BEGIN
  EXECUTE format('DROP FUNCTION public.t167_gone() CASCADE');
END;
\$fn\$;"
check CV25 "R-CASCADE: a DROP … CASCADE inside the marked body" R-CASCADE

echo "-- the marker's own form and placement"
pair expand "-- @vendor-sql: public.t167_vendor
$VFN"
check CV30 "the marker cites no ticket or decision" "R-VENDOR-SQL R-PHASE"
pair expand "-- @vendor-sql: public.t167_missing — OD-150; T-167
$VFN"
check CV31 "the marker names a function this file does not define" "R-VENDOR-SQL R-PHASE"
pair expand "-- @vendor-sql public.t167_vendor — OD-150; T-167
$VFN"
check CV32 "the marker has no colon" "R-VENDOR-SQL R-PHASE"
pair expand "-- @vendor-sql:
$VFN"
check CV33 "the marker names nothing" "R-VENDOR-SQL R-PHASE"
pair expand "SELECT 1;
-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN"
check CV34 "the marker as a -- line after the first statement" "R-VENDOR-SQL R-PHASE"
pair expand "SELECT '
-- @vendor-sql: public.t167_vendor — OD-150; T-167
';
$VFN"
check CV35 "the marker on a line inside a string literal" "R-VENDOR-SQL R-PHASE"
pair expand "CREATE FUNCTION public.t167_vendor(tbl text) RETURNS void LANGUAGE plpgsql AS \$fn\$
BEGIN
-- @vendor-sql: public.t167_vendor — OD-150; T-167
  EXECUTE format('DROP TABLE IF EXISTS public.%I', tbl);
END;
\$fn\$;"
check CV36 "the marker inside the very body it names" "R-VENDOR-SQL R-PHASE"
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN"
check CV37 "two markers naming the same body" R-VENDOR-SQL
pair expand "-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN
CREATE FUNCTION public.t167_vendor(tbl int) RETURNS void LANGUAGE plpgsql AS \$fn2\$
BEGIN
  EXECUTE format('DROP TABLE IF EXISTS public.%I', tbl);
END;
\$fn2\$;"
check CV38 "the marker names an overloaded function; the gate does not read argument types" "R-VENDOR-SQL R-PHASE"
pair expand "SELECT 1; -- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN"
check CV39 "a @vendor-sql comment trailing a statement, which is not a whole -- line" "R-VENDOR-SQL R-PHASE"
pair expand "/* @vendor-sql: public.t167_vendor — OD-150; T-167 */
$VFN"
check CV3A "a @vendor-sql block comment" "R-VENDOR-SQL R-PHASE"
plant "$UP" "-- @phase: expand
-- @vendor-sql: public.t167_vendor — OD-150; T-167
$VFN"
plant "$DOWN" "-- @vendor-sql: public.t167_vendor — OD-150; T-167
DROP FUNCTION public.t167_vendor(text);"
check CV3B "a marker in a down file, which R-PHASE and R-TABLE-GRANT never read" R-VENDOR-SQL
mutate "$UP1" "-- 0001_extensions_and_roles.up.sql" $'-- @vendor-sql: public.t167_vendor — OD-150; T-167\n-- 0001_extensions_and_roles.up.sql'
check CV3C "a marker prepended to the pinned 0001 baseline, whose content rules are not read" R-VENDOR-SQL

echo "== R-RESTORE-PUBLIC (T-241, OE-76, OD-275): a marked DOWN file may restore exactly what its UP file revoked from PUBLIC"
# T-240's shape: an up file revokes EXECUTE on pg_catalog routines FROM PUBLIC, so its down file must
# GRANT … TO PUBLIC to be reversible, which R-ANSWERING-SERVICE refuses everywhere but 0001. The marker
# `-- @restore-public: <reference>` in the down file's header admits a plain top-level
# `GRANT <privileges> ON FUNCTION|PROCEDURE|ROUTINE <signatures> TO PUBLIC` when every (routine, privilege)
# pair it NAMES is a pair a plain top-level REVOKE in the paired up file revoked FROM PUBLIC, names
# compared as PostgreSQL resolves them (unquoted folded to lower case, ASCII only; quoted exact; U&"…"
# decoded; comments are separators), AND both of these hold, because the gate compares NAMES, not objects
# (rework 1, QA F1): (a) the marked down file holds nothing but GRANT and REVOKE statements; (b) its up
# file holds no statement that can change what a name designates (CQ90-CQ9F).
# Every PASS case asserts the gate's admission record, so a PASS that admitted
# nothing is BAD; every refusal asserts the reason. `rp` writes 9001's up file under `-- @phase: expand`.
rp() {
  plant "$UP" "-- @phase: expand
$1"
  plant "$DOWN" "$2"
}
R3='REVOKE EXECUTE ON FUNCTION
  pg_catalog.pg_advisory_lock(bigint),
  pg_catalog.pg_try_advisory_lock(integer, integer),
  pg_catalog.pg_advisory_unlock_all()
FROM PUBLIC;'
MK='-- @restore-public: OE-76; T-241'
ADMIT='restore-public: db/migrations/9001_t021_plant.down.sql:1 admits'
NOTADMIT='-- @restore-public (line 1) does not admit it:'
NOTREV='was not revoked from PUBLIC by db/migrations/9001_t021_plant.up.sql'
G1='GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC;'

echo "-- admitted: the marker restores what the up file revoked"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint), pg_catalog.pg_try_advisory_lock(integer, integer), pg_catalog.pg_advisory_unlock_all() TO PUBLIC;"
checkwhy CQ00 "CONTROL: all three routines the up file revoked, in one GRANT" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 3 routine(s)"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_all() TO PUBLIC;"
checkwhy CQ01 "CONTROL: a subset of what the up file revoked" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 1 routine(s)"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock(integer, integer) TO PUBLIC;
$G1"
checkwhy CQ02 "CONTROL: two GRANT statements, in another order than the REVOKE list" PASS "$ADMIT 2 GRANT … TO PUBLIC statement(s) on 2 routine(s)"
rp "$R3" "$MK
grant execute on function
  \"pg_catalog\".\"pg_advisory_lock\"( /* the bigint form */ BIGINT ),
  PG_CATALOG.PG_TRY_ADVISORY_LOCK(integer,integer)   -- the int4 pair
to public;"
checkwhy CQ03 "CONTROL: the same routines spelled differently (case, quotes that match the folded name, comments, spacing)" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 2 routine(s)"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.U&\"pg\\005fadvisory\\005flock\"(bigint), pg_catalog.u&\"pg!005ftry!005fadvisory!005flock\" UESCAPE '!'(integer, integer) TO PUBLIC;"
checkwhy CQ04 "CONTROL: U&\"…\" spellings (one with UESCAPE) that decode to the revoked names" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 2 routine(s)"
rp "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM app_rw, PUBLIC;" "$MK
$G1"
checkwhy CQ05 "CONTROL: the up file revoked FROM app_rw, PUBLIC (PUBLIC among other grantees)" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 1 routine(s)"
rp "$R3" "$MK
SELECT 1;"
checkwhy CQ06 "CONTROL: a marker with nothing to admit is printed as admitting 0" PASS "$ADMIT 0 GRANT … TO PUBLIC statement(s) on 0 routine(s)"
rp "REVOKE ALL PRIVILEGES ON FUNCTION public.t241_fn(text) FROM PUBLIC;" "$MK
GRANT ALL ON FUNCTION public.t241_fn(text) TO PUBLIC;"
checkwhy CQ07 "CONTROL: ALL PRIVILEGES revoked, ALL restored (one privilege, two spellings)" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 1 routine(s)"
rp "REVOKE EXECUTE ON PROCEDURE public.t241_proc() FROM PUBLIC;" "$MK
GRANT EXECUTE ON PROCEDURE public.t241_proc() TO PUBLIC;"
checkwhy CQ08 "CONTROL: a PROCEDURE" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 1 routine(s)"

echo "-- unchanged without a usable marker"
rp "$R3" "$G1"
checkwhy CQ10 "no marker: the down file's GRANT TO PUBLIC is refused exactly as before T-241" R-ANSWERING-SERVICE "grants to PUBLIC, and PUBLIC includes answering_service (T-020 contract §6): \"GRANT EXECUTE ON FUNCTION PG_CATALOG.PG_ADVISORY_LOCK(BIGINT) TO PUBLIC\""
rp "$MK
$R3" "$G1"
checkwhy CQ11 "the marker in the UP file and the GRANT in the down file" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "in an up file"

echo "-- the marker's own form and placement"
rp "$MK
$R3
$G1" "-- the down file of a planted migration"
checkwhy CQ20 "the marker in an UP file that grants to PUBLIC: the marker is refused, the grant still is" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "in an up file"
rp "$MK
$R3" "-- the down file of a planted migration"
checkwhy CQ21 "the marker in an UP file that grants nothing" R-RESTORE-PUBLIC "in an up file"
rp "$R3" "-- @restore-public:
$G1"
checkwhy CQ22 "the marker with no reference" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "cites no ticket or decision"
rp "$R3" "-- @restore-public: reviewed by the tech lead
$G1"
checkwhy CQ23 "the marker with words but no ticket or decision" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "cites no ticket or decision"
rp "$R3" "-- @restore-public OE-76; T-241
$G1"
checkwhy CQ24 "the marker without its colon" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "not of the form"
rp "$R3" "SELECT 1;
$MK
$G1"
checkwhy CQ25 "the marker after the first statement" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "not a -- comment in the file header"
rp "$R3" "/* @restore-public: OE-76; T-241 */
$G1"
checkwhy CQ26 "the marker in a block comment" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "a comment beginning @restore-public that this gate does not read"
rp "$R3" "SELECT '
$MK
';
$G1"
checkwhy CQ27 "a marker line inside a string literal" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "not a -- comment in the file header"
rp "$R3" "$MK
$MK
$G1"
checkwhy CQ28 "two markers in one file" "R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "a second -- @restore-public marker"
plant "$DOWN" "$MK
$G1"
checkwhy CQ29 "a marked down file with no paired up file" "R-STRUCT R-RESTORE-PUBLIC R-ANSWERING-SERVICE" "no paired up file"
mutate "$DOWN1" "-- 0001_extensions_and_roles.down.sql" $'-- @restore-public: OE-76; T-241\n-- 0001_extensions_and_roles.down.sql'
checkwhy CQ2A "the marker prepended to the pinned 0001 baseline down file" R-RESTORE-PUBLIC "baseline"

echo "-- the objects: identical signatures, as PostgreSQL resolves them"
rp "SELECT 1;" "$MK
$G1"
checkwhy CQ30 "the up file revoked nothing" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock_shared(bigint) TO PUBLIC;"
checkwhy CQ31 "a routine the up file did not revoke" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock_shared(bigint) $NOTREV"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(integer, integer) TO PUBLIC;"
checkwhy CQ32 "the revoked name with another signature" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(integer, integer) $NOTREV"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION public.pg_advisory_lock(bigint) TO PUBLIC;"
checkwhy CQ33 "the revoked name in another schema" R-ANSWERING-SERVICE "public.pg_advisory_lock(bigint) $NOTREV"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_advisory_lock(bigint) TO PUBLIC;"
checkwhy CQ34 "the revoked name unqualified (search_path decides what it is)" R-ANSWERING-SERVICE "FUNCTION pg_advisory_lock(bigint) is not schema-qualified"
# T-241 self-attack A1: unqualified in BOTH files matches as text, but the down file can SET search_path
# first, so the same text names another routine. Only schema-qualified names are admitted.
rp "REVOKE EXECUTE ON FUNCTION t241_fn() FROM PUBLIC;" "$MK
GRANT EXECUTE ON FUNCTION t241_fn() TO PUBLIC;"
checkwhy CQ3I "A1: unqualified in both files" R-ANSWERING-SERVICE "FUNCTION t241_fn() is not schema-qualified"
rp "REVOKE EXECUTE ON FUNCTION t241_fn() FROM PUBLIC;" "$MK
SET search_path = kinvara_guard, pg_catalog;
GRANT EXECUTE ON FUNCTION t241_fn() TO PUBLIC;"
checkwhy CQ3J "A1: the down file moves search_path, then restores the 'same' unqualified name" R-ANSWERING-SERVICE "FUNCTION t241_fn() is not schema-qualified"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint), pg_catalog.pg_advisory_lock_shared(bigint) TO PUBLIC;"
checkwhy CQ35 "one revoked and one unrelated routine in one GRANT: the statement is refused whole" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock_shared(bigint) $NOTREV"
rp "REVOKE EXECUTE ON FUNCTION public.t241_fn() FROM PUBLIC;" "$MK
GRANT EXECUTE ON FUNCTION public.\"T241_FN\"() TO PUBLIC;"
checkwhy CQ36 "a quoted upper-case name is another object than the folded one the up file revoked" R-ANSWERING-SERVICE "public.\"T241_FN\"() $NOTREV"
rp "REVOKE EXECUTE ON FUNCTION public.\"T241_Fn\"() FROM PUBLIC;" "$MK
GRANT EXECUTE ON FUNCTION public.T241_FN() TO PUBLIC;"
checkwhy CQ37 "an unquoted name folds to lower case, so it is not the quoted mixed-case one revoked" R-ANSWERING-SERVICE "public.t241_fn() $NOTREV"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.U&\"pg\\005fadvisory\\005flock\\005fshared\"(bigint) TO PUBLIC;"
checkwhy CQ38 "a U&\"…\" name that decodes to a routine the up file did not revoke" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock_shared(bigint) $NOTREV"
rp "REVOKE EXECUTE ON FUNCTION public.\"t241_é\"() FROM PUBLIC;" "$MK
GRANT EXECUTE ON FUNCTION public.T241_É() TO PUBLIC;"
checkwhy CQ39 "PostgreSQL folds ASCII only: unquoted T241_É is t241_É, not the revoked \"t241_é\"" R-ANSWERING-SERVICE "public.t241_É() $NOTREV"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory/* x */_lock(bigint) TO PUBLIC;"
checkwhy CQ3A "a comment splitting a name (a separator to PostgreSQL, not nothing)" R-ANSWERING-SERVICE "$NOTADMIT"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(big/**/int) TO PUBLIC;"
checkwhy CQ3B "a comment splitting an argument type" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(big int) $NOTREV"
rp "SELECT 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM PUBLIC';" "$MK
$G1"
checkwhy CQ3C "the up file's REVOKE is a string literal, which the migration does not execute" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "DO \$d\$ BEGIN EXECUTE 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM PUBLIC'; END \$d\$;" "$MK
$G1"
checkwhy CQ3D "the up file's REVOKE is dynamic SQL in a DO block" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "CREATE FUNCTION public.t241_later() RETURNS void LANGUAGE plpgsql AS \$fn\$ BEGIN REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM PUBLIC; END; \$fn\$;" "$MK
$G1"
checkwhy CQ3E "the up file's REVOKE is inside a function body it only defines" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "CREATE FUNCTION public.t241_later() RETURNS void LANGUAGE sql AS \$fn\$ REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM PUBLIC \$fn\$;" "$MK
$G1"
checkwhy CQ3K "the up file's REVOKE is the whole statement of a LANGUAGE sql body it only defines" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM PUBLIC;" "$MK
$G1"
checkwhy CQ3F "the up file revoked only the GRANT OPTION, not the privilege" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM app_rw;" "$MK
$G1"
checkwhy CQ3G "the up file revoked from app_rw, not from PUBLIC" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "/* $R3 */ SELECT 1;" "$MK
$G1"
checkwhy CQ3H "the up file's REVOKE is inside a comment" R-ANSWERING-SERVICE "pg_catalog.pg_advisory_lock(bigint) $NOTREV"

echo "-- the privileges: only the privilege the up file revoked, spelled as it spelled it"
rp "$R3" "$MK
GRANT ALL ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC;"
checkwhy CQ40 "EXECUTE revoked, ALL restored" R-ANSWERING-SERVICE "privilege ALL on FUNCTION pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "$R3" "$MK
GRANT EXECUTE, USAGE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC;"
checkwhy CQ41 "EXECUTE revoked, EXECUTE and USAGE restored" R-ANSWERING-SERVICE "privilege USAGE on FUNCTION pg_catalog.pg_advisory_lock(bigint) $NOTREV"
rp "REVOKE ALL ON FUNCTION public.t241_fn(text) FROM PUBLIC;" "$MK
GRANT EXECUTE ON FUNCTION public.t241_fn(text) TO PUBLIC;"
checkwhy CQ42 "ALL revoked, EXECUTE restored (the gate compares spellings; restore it as the up file wrote it)" R-ANSWERING-SERVICE "privilege EXECUTE on FUNCTION public.t241_fn(text) $NOTREV"

echo "-- the grantee and the options: exactly PUBLIC, nothing more"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC, app_admin_rw;"
checkwhy CQ50 "PUBLIC and a second grantee" R-ANSWERING-SERVICE "the grantee list is not exactly PUBLIC"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC WITH GRANT OPTION;"
checkwhy CQ51 "WITH GRANT OPTION" R-ANSWERING-SERVICE "$NOTADMIT it carries WITH GRANT OPTION"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC GRANTED BY app_ddl;"
checkwhy CQ52 "GRANTED BY" R-ANSWERING-SERVICE "$NOTADMIT it carries GRANTED BY"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO GROUP PUBLIC;"
checkwhy CQ53 "TO GROUP PUBLIC" R-ANSWERING-SERVICE "the grantee list is not exactly PUBLIC"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO \"public\";"
checkwhy CQ54 "TO \"public\" quoted (refused: only the bare keyword is admitted)" R-ANSWERING-SERVICE "the grantee list is not exactly PUBLIC"

echo "-- answering_service, in any form, is never admitted"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC, answering_service;"
checkwhy CQ60 "PUBLIC and answering_service" R-ANSWERING-SERVICE "the grantee list is not exactly PUBLIC"
rp "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM answering_service, PUBLIC;" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO answering_service;"
checkwhy CQ61 "the up file revoked from answering_service; the down file grants it back to answering_service" R-ANSWERING-SERVICE "grants answering_service something other than exactly INSERT on out_of_hours_report"
rp "$R3" "$MK
GRANT answering_service TO PUBLIC;"
checkwhy CQ62 "the role answering_service granted TO PUBLIC" R-ANSWERING-SERVICE "grants the role answering_service"
rp "$R3" "$MK
ALTER FUNCTION pg_catalog.pg_advisory_lock(bigint) OWNER TO answering_service;"
checkwhy CQ63 "ownership of a revoked routine to answering_service" R-ANSWERING-SERVICE "ownership to answering_service"

echo "-- where the GRANT sits: a plain top-level statement only"
rp "$R3" "$MK
DO \$d\$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC'; END \$d\$;"
checkwhy CQ70 "the GRANT as dynamic SQL in a DO block" R-ANSWERING-SERVICE "not a plain top-level GRANT statement"
rp "$R3" "$MK
CREATE FUNCTION public.t241_regrant() RETURNS void LANGUAGE plpgsql AS \$fn\$ BEGIN GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC; END; \$fn\$;"
checkwhy CQ71 "the GRANT inside a function body the down file defines" R-ANSWERING-SERVICE "not a plain top-level GRANT statement"
rp "$R3" "$MK
CREATE FUNCTION public.t241_regrant() RETURNS void LANGUAGE sql AS \$fn\$ GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO PUBLIC \$fn\$;"
checkwhy CQ73 "the GRANT as the whole statement of a LANGUAGE sql body the down file defines" R-ANSWERING-SERVICE "not a plain top-level GRANT statement"
rp "$R3" "$MK
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock('x' bigint) TO PUBLIC;"
checkwhy CQ72 "a top-level GRANT holding a string literal (skipping it would leave a matching signature)" R-ANSWERING-SERVICE "the statement holds a string literal"

echo "-- object classes: routines only"
rp "REVOKE SELECT ON TABLE public.t241_t FROM PUBLIC;" "$MK
GRANT SELECT ON TABLE public.t241_t TO PUBLIC;"
checkwhy CQ80 "a TABLE revoked and restored" R-ANSWERING-SERVICE "only FUNCTION, PROCEDURE and ROUTINE"
rp "REVOKE SELECT ON public.t241_t FROM PUBLIC;" "$MK
GRANT SELECT ON public.t241_t TO PUBLIC;"
checkwhy CQ81 "a table with the TABLE keyword omitted" R-ANSWERING-SERVICE "only FUNCTION, PROCEDURE and ROUTINE"
rp "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;" "$MK
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC;"
checkwhy CQ82 "ON ALL FUNCTIONS IN SCHEMA (no signature to compare)" R-ANSWERING-SERVICE "only FUNCTION, PROCEDURE and ROUTINE"
rp "$R3" "$MK
GRANT EXECUTE ON ROUTINE pg_catalog.pg_advisory_lock(bigint) TO PUBLIC;"
checkwhy CQ83 "revoked ON FUNCTION, restored ON ROUTINE (the object kind is compared too)" R-ANSWERING-SERVICE "ROUTINE pg_catalog.pg_advisory_lock(bigint) $NOTREV"

echo "-- rework 1 (QA F1): a name must still designate the revoked routine when the down file's GRANT runs"
# The gate compares NAMES. A down file that renames or re-schemas another routine (or a schema) into a
# revoked name before its GRANT, or an up file that does so after its REVOKE, would get a GRANT on a
# routine nobody revoked admitted. A marked down file therefore holds only GRANT and REVOKE statements,
# and its up file holds no statement that can change what a name designates. QA1H/I/J/K/L/M and V11 are
# QA's plants (T-241 § QA-5), verbatim in shape.
FN='REVOKE EXECUTE ON FUNCTION public.t241_fn() FROM PUBLIC;'
GFN='GRANT EXECUTE ON FUNCTION public.t241_fn() TO PUBLIC;'
DOWNONLY='a marked down file holds only GRANT and REVOKE'
UPMOVES='the paired up file holds a statement that can change what a name designates'
rp "$FN" "$MK
ALTER FUNCTION public.t241_fn() RENAME TO t241_fn_orig;
ALTER FUNCTION public.t241_other() RENAME TO t241_fn;
$GFN"
checkwhy CQ90 "QA1H: the down renames another routine INTO the revoked name, then restores it" R-ANSWERING-SERVICE "$DOWNONLY"
rp "$FN" "$MK
ALTER FUNCTION public.t241_fn() RENAME TO t241_fn_orig;
ALTER FUNCTION t241_elsewhere.t241_fn() SET SCHEMA public;
$GFN"
checkwhy CQ91 "QA1I: SET SCHEMA moves another routine into the revoked name" R-ANSWERING-SERVICE "$DOWNONLY"
rp "REVOKE EXECUTE ON FUNCTION t241_s.t241_fn() FROM PUBLIC;" "$MK
ALTER SCHEMA t241_s RENAME TO t241_s_orig;
ALTER SCHEMA t241_other RENAME TO t241_s;
GRANT EXECUTE ON FUNCTION t241_s.t241_fn() TO PUBLIC;"
checkwhy CQ92 "QA1K: ALTER SCHEMA … RENAME swaps another schema into the qualified name" R-ANSWERING-SERVICE "$DOWNONLY"
rp "REVOKE EXECUTE ON PROCEDURE public.t241_proc() FROM PUBLIC;" "$MK
ALTER PROCEDURE public.t241_proc() RENAME TO t241_proc_orig;
ALTER ROUTINE public.t241_other_proc() RENAME TO t241_proc;
GRANT EXECUTE ON PROCEDURE public.t241_proc() TO PUBLIC;"
checkwhy CQ93 "QA1L: ALTER PROCEDURE / ALTER ROUTINE … RENAME" R-ANSWERING-SERVICE "$DOWNONLY"
rp "$R3" "$MK
ALTER FUNCTION pg_catalog.pg_advisory_unlock_all() RENAME TO t241_unlock_all_orig;
ALTER FUNCTION pg_catalog.pg_reload_conf() RENAME TO pg_advisory_unlock_all;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_all() TO PUBLIC;"
checkwhy CQ94 "QA1M / V11: pg_reload_conf() renamed into pg_advisory_unlock_all()" R-ANSWERING-SERVICE "$DOWNONLY"
rp "$FN" "$MK
DROP FUNCTION public.t241_fn();
CREATE FUNCTION public.t241_fn() RETURNS void LANGUAGE sql SECURITY DEFINER AS \$fn\$ SELECT 1 \$fn\$;
$GFN"
checkwhy CQ95 "QA1J: DROP + CREATE a new SECURITY DEFINER body under the revoked name" R-ANSWERING-SERVICE "$DOWNONLY"
rp "$FN" "$MK
SET search_path = t241_elsewhere, public;
$GFN"
checkwhy CQ96 "SET search_path in a marked down, names qualified" R-ANSWERING-SERVICE "$DOWNONLY"
rp "$FN" "$MK
DO \$d\$ BEGIN EXECUTE 'ALTER FUNCTION public.t241_other() RENAME TO t241_fn'; END \$d\$;
$GFN"
checkwhy CQ97 "a DO block (dynamic RENAME) in a marked down" R-ANSWERING-SERVICE "$DOWNONLY"
rp "$FN" "$MK
ALTER FUNCTION public.t241_fn() OWNER TO app_ddl;
$GFN"
checkwhy CQ98 "any other statement, even one that moves no name (ALTER … OWNER): the down is GRANT/REVOKE only" R-ANSWERING-SERVICE "$DOWNONLY"
rp "$FN" "$MK
REVOKE EXECUTE ON FUNCTION public.t241_fn() FROM app_rw;
$GFN"
checkwhy CQ99 "CONTROL: T-240's shape, a REVOKE from a role and the restore" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 1 routine(s)"
rp "$FN
ALTER FUNCTION public.t241_fn() RENAME TO t241_fn_old;
ALTER FUNCTION public.t241_other() RENAME TO t241_fn;" "$MK
$GFN"
checkwhy CQ9A "the UP file renames another routine into the revoked name after its REVOKE (the down runs on the up's end state)" "R-PHASE R-ANSWERING-SERVICE" "$UPMOVES"
rp "$FN
ALTER FUNCTION t241_elsewhere.t241_fn() SET SCHEMA public;" "$MK
$GFN"
checkwhy CQ9B "the UP file moves a routine in by SET SCHEMA" R-ANSWERING-SERVICE "$UPMOVES"
rp "$FN
DO \$d\$ BEGIN EXECUTE 'ALTER SCHEMA t241_other RENAME TO public'; END \$d\$;" "$MK
$GFN"
checkwhy CQ9C "the UP file renames a schema in dynamic SQL" "R-PHASE R-ANSWERING-SERVICE" "$UPMOVES"
rp "$FN
CREATE OR REPLACE FUNCTION public.t241_fn() RETURNS void LANGUAGE sql AS \$fn\$ SELECT 1 \$fn\$;" "$MK
$GFN"
checkwhy CQ9D "the UP file replaces the revoked routine's body" R-ANSWERING-SERVICE "$UPMOVES"
rp "$FN
SET search_path = t241_elsewhere;" "$MK
$GFN"
checkwhy CQ9E "the UP file sets search_path" R-ANSWERING-SERVICE "$UPMOVES"
rp "$FN
DO \$assert\$ BEGIN PERFORM 1; END \$assert\$;" "$MK
$GFN"
checkwhy CQ9F "CONTROL: the up file also holds a DO assertion (0022's shape)" PASS "$ADMIT 1 GRANT … TO PUBLIC statement(s) on 1 routine(s)"

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

echo "== R-ROLE-SWITCH (T-031; T-136 § contract §6 C6-BOUND and §8, QA-A2): a migration never leaves its session role"
pair expand "RESET ROLE;
CREATE ROLE t031_escape;"
check CR01 "RESET ROLE, then a superuser-only statement (T-136 C6-BOUND's shape)" R-ROLE-SWITCH
pair expand "SET ROLE app;"
check CR02 "SET ROLE <the bootstrap superuser>" R-ROLE-SWITCH
pair expand "SET SESSION AUTHORIZATION app;"
check CR03 "SET SESSION AUTHORIZATION <named>" R-ROLE-SWITCH
pair expand "SET SESSION AUTHORIZATION DEFAULT;"
check CR04 "SET SESSION AUTHORIZATION DEFAULT" R-ROLE-SWITCH
pair expand "DO \$\$ BEGIN RESET ROLE; END \$\$;"
check CR05 "QA-A2: a DO block that runs RESET ROLE" R-ROLE-SWITCH
pair expand "set local
  role app;"
check CR06 "lower case, SET LOCAL ROLE across two lines" R-ROLE-SWITCH
pair expand "SET SESSION ROLE app;"
check CR07 "SET SESSION ROLE" R-ROLE-SWITCH
pair expand "RESET SESSION AUTHORIZATION;"
check CR08 "RESET SESSION AUTHORIZATION" R-ROLE-SWITCH
pair expand "SET /* back to the session user */ ROLE app;"
check CR09 "a block comment between SET and ROLE" R-ROLE-SWITCH
pair expand "SET \"role\" TO 'app';"
check CR0A "the parameter name as a quoted identifier" R-ROLE-SWITCH
pair expand "DO \$do\$ BEGIN EXECUTE 'SET ROLE app'; END \$do\$;"
check CR0B "SET ROLE as an EXECUTE string inside a DO block" R-ROLE-SWITCH
pair expand "SELECT set_config('role', 'app', false);"
check CR0C "set_config('role', …)" R-ROLE-SWITCH
pair expand "DO \$do\$ BEGIN EXECUTE 'SELECT pg_catalog.set_config(''role'', ''app'', false)'; END \$do\$;"
check CR0D "set_config('role', …) inside an EXECUTE string, quotes doubled" R-ROLE-SWITCH
pair expand "SET session_authorization = 'app';"
check CR0E "session_authorization spelled as a parameter name" R-ROLE-SWITCH
pair expand "SELECT 1;"
plant "$DOWN" "RESET ROLE;"
check CR0F "in a DOWN file (a down file runs as its up file does, T-136 C2e)" R-ROLE-SWITCH
pair expand "CREATE FUNCTION public.t031_f() RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN SET ROLE app; END \$f\$;"
check CR0G "inside the body of a function the migration creates" R-ROLE-SWITCH
pair expand "ALTER FUNCTION public.t031_f() SET role = app;"
check CR0H "a function-level SET role clause" R-ROLE-SWITCH
pair expand "UPDATE public.t031_thing SET note = 'x' WHERE false; SET ROLE app;"
check CR0I "SET ROLE on one line with an UPDATE (the UPDATE … SET role exemption is per statement)" R-ROLE-SWITCH
pair expand "\\connect - app
CREATE ROLE t031_escape;"
check CR0J "psql \\connect (the runner executes a migration file with psql)" R-ROLE-SWITCH
pair expand "\\i db/migrations/t031_unread.sql"
check CR0K "psql \\i, which runs SQL from a file this gate does not read" R-ROLE-SWITCH
pair expand "-- @no-transaction
DISCARD ALL;"
check CR0L "DISCARD ALL, which includes SET SESSION AUTHORIZATION DEFAULT" R-ROLE-SWITCH
pair expand "SELECT set_config(/* which */ 'role', 'app', false);"
check CR0M "set_config with a block comment before the parameter name (T-031 self-attack A11)" R-ROLE-SWITCH
pair expand "-- SET ROLE app;
/* RESET ROLE; SET SESSION AUTHORIZATION app; */
SELECT 1;"
check CRC1 "CONTROL: role switches inside comments" PASS
pair expand "CREATE FUNCTION public.t031_f() RETURNS void LANGUAGE plpgsql AS \$f\$
BEGIN
  PERFORM 1;                                    --   WITH INHERIT FALSE still permits SET ROLE.
END
\$f\$;"
check CRC2 "CONTROL (T-143 TL-A1): SET ROLE in a -- comment inside a function body, as merged 0001-0003 carry it" PASS
pair data "UPDATE public.account_role SET role = 'ts_senior' WHERE account_id = 1;"
check CRC3 "CONTROL: UPDATE … SET role = (a column named role)" PASS
pair data "UPDATE ONLY public.account_role AS ar SET role = 'parent' WHERE ar.account_id = 1;"
check CRC4 "CONTROL: UPDATE ONLY … AS alias SET role =" PASS
pair data "INSERT INTO public.account_role (account_id, role) VALUES (1, 'parent') ON CONFLICT (account_id, role) DO UPDATE SET role = EXCLUDED.role;"
check CRC5 "CONTROL: INSERT … ON CONFLICT DO UPDATE SET role =" PASS
pair expand "SET LOCAL lock_timeout = '5s';
SET search_path = public;
SELECT set_config('statement_timeout', '5s', true);"
check CRC6 "CONTROL: SET LOCAL lock_timeout, SET search_path, set_config of another parameter" PASS
pair expand "CREATE TABLE public.t031_thing (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, role text NOT NULL);
GRANT SELECT, INSERT ON public.t031_thing TO app_rw;"
check CRC7 "CONTROL: a column named role in CREATE TABLE" PASS

echo "== R-RUN-AS (T-031; T-136 § contract §6-§7, QA-A1): the superuser marker sits in the header, outside any string, citing a reference"
pair expand "SELECT '
-- @run-as: bootstrap-superuser — T-143
';
CREATE ROLE t031_escape;"
check CM01 "QA-A1: the marker on a line inside a string literal (the runner reads lines, not SQL)" R-RUN-AS
pair expand "DO \$\$ BEGIN
-- @run-as: bootstrap-superuser — T-143
PERFORM 1; END \$\$;"
check CM02 "the marker on a line inside a dollar-quoted DO body" R-RUN-AS
pair expand "SELECT 1;
-- @run-as: bootstrap-superuser — T-143
CREATE ROLE t031_escape;"
check CM03 "the marker as a -- line after the first statement" R-RUN-AS
pair expand "/*
-- @run-as: bootstrap-superuser — T-143
*/
CREATE ROLE t031_escape;"
check CM04 "the marker on a line inside a block comment" R-RUN-AS
pair expand "-- @run-as: bootstrap-superuser — needed for CREATE ROLE
CREATE ROLE t031_escape;"
check CM05 "a header marker that cites no ticket or decision" R-RUN-AS
pair expand "-- @run-as: bootstrap-superuser — T-143
-- @run-as: bootstrap-superuser — OE-23
CREATE ROLE t031_escape;"
check CM06 "two markers in the header" R-RUN-AS
pair expand "SELECT 1;"
plant "$DOWN" "-- @run-as: bootstrap-superuser — T-143
SELECT 1;"
check CM07 "a marker in a DOWN file (the runner refuses one; T-136 A6b)" R-RUN-AS
pair expand "-- @run-as: app — T-143
CREATE ROLE t031_escape;"
check CM08 "a marker naming a principal other than bootstrap-superuser" R-RUN-AS
pair expand "-- @run-as bootstrap-superuser — T-143
CREATE ROLE t031_escape;"
check CM09 "a marker with no colon" R-RUN-AS
pair expand "SELECT 1; -- @run-as: bootstrap-superuser — T-143"
check CM0A "a marker trailing a statement, which the runner does not read" R-RUN-AS
plant "$UP" "$(git show "HEAD:$M/0003_int10_guard_relocate_schema.up.sql")"
plant "$DOWN" "-- the down file of a planted migration"
check CMC1 "CONTROL (T-143 § contract §6): merged 0003's up file verbatim as a new migration (marker line, -- continuation lines, SET ROLE in comments)" PASS
pair expand "-- @run-as: bootstrap-superuser — T-031
CREATE ROLE t031_login NOLOGIN;"
check CMC2 "CONTROL: the minimal legitimate header marker" PASS
pair expand "-- This file carries no \`-- @run-as\` marker; it runs as app_ddl (the @run-as form is T-136's).
SELECT 1;"
check CMC3 "CONTROL: header prose that mentions the marker (merged 0003's down file does)" PASS
plant "$UP" $'-- @phase: expand\r\n\t-- @run-as: bootstrap-superuser \xe2\x80\x94 T-031\r\nCREATE ROLE t031_login NOLOGIN;\r'
plant "$DOWN" "-- the down file of a planted migration"
check CMC4 "CONTROL (T-031 self-attack A15): a tab-indented header marker in a CRLF file" PASS
plant "$UP" $'-- @phase: expand\r\n-- @run-as: bootstrap-superuser \xe2\x80\x94 reviewed\r\nCREATE ROLE t031_login NOLOGIN;\r'
plant "$DOWN" "-- the down file of a planted migration"
check CM0B "a CRLF header marker that cites no ticket or decision" R-RUN-AS

echo "== R-MERGED: a comment line the runner reads is not a null edit (T-031, OD-86) — plants on merged 0003"
U3=$M/0003_int10_guard_relocate_schema.up.sql
mutate "$U3" "-- @phase: expand
" "-- @phase: expand
-- @no-transaction
"
check C8F "OD-86: -- @no-transaction added to merged 0003's header, a comment-only edit" R-MERGED
mutate "$U3" "-- @run-as: bootstrap-superuser — OE-23; T-143" "-- run-as: bootstrap-superuser — OE-23; T-143"
check C8G "merged 0003's @run-as marker disabled by deleting its @" R-MERGED
mutate "$U3" "-- @run-as: bootstrap-superuser — OE-23; T-143" "-- @run-as: bootstrap-superuser — OE-23; T-143, T-031"
check C8H "merged 0003's marker line reworded (refused although only the reference changes)" R-MERGED
mutate "$U3" "superuser owns — ALTER FUNCTION SET SCHEMA" "superuser owns: ALTER FUNCTION SET SCHEMA"
check C8I "CONTROL: a -- continuation line under merged 0003's marker reworded" PASS

echo "== R-TRAILER (T-031; PROTOCOL §3): every commit touching db/migrations/ carries one Ticket trailer, read by git's trailer parser"
# Each case commits in a detached worktree under the container's /tmp and runs THAT tree's gate with
# --base=<this tree's HEAD>, so the range is exactly the planted commits. The 'parser:' lines print what
# git's own parser returns for each commit, independently of the gate. The worktree is reset and
# asserted clean after each case, and removed at the end.
BASE_SHA=$(git rev-parse HEAD)
WT2="$(mktemp -d)/wt"
git worktree add -q --detach "$WT2" HEAD || {
  echo "ABORT: git worktree add"
  exit 2
}
T_UP=$M/9001_t031_trailer.up.sql
T_DOWN=$M/9001_t031_trailer.down.sql
GITID=(-c user.name=t031-negative-test -c user.email=t031@kinvara.test)
wt_write() {
  printf '%s\n' "$2" >"$WT2/$1"
  if [ "$(cat "$WT2/$1")" != "$2" ]; then
    echo "ABORT: the plant did not land in $WT2/$1"
    exit 2
  fi
}
# wt_commit <message>: commit everything in the worktree with exactly this message; assert a new
# commit exists, carries the message byte for byte, and left the worktree clean.
wt_commit() {
  local before
  before=$(git -C "$WT2" rev-parse HEAD)
  git -C "$WT2" add -A || {
    echo "ABORT: git add"
    exit 2
  }
  printf '%s\n' "$1" | git -C "$WT2" "${GITID[@]}" commit -q -F - || {
    echo "ABORT: git commit"
    exit 2
  }
  if [ "$(git -C "$WT2" rev-parse HEAD)" = "$before" ] || [ "$(git -C "$WT2" log -1 --format=%B)" != "$1" ] || [ -n "$(git -C "$WT2" status --porcelain)" ]; then
    echo "ABORT: the commit did not land as written"
    exit 2
  fi
}
wt_migration() {
  wt_write "$T_UP" "-- @phase: expand
SELECT 1;"
  wt_write "$T_DOWN" "-- the down file of a planted migration"
}
wt_check() {
  local code
  (cd "$WT2" && node scripts/gates/migration-lint.ts --base="$BASE_SHA") >"$OUT" 2>&1
  code=$?
  judge "$1" "$2" "$3" "$code"
  git -C "$WT2" log --format='       parser: %h Ticket=[%(trailers:key=Ticket,valueonly,separator=%x2C)] %s' "$BASE_SHA..HEAD"
  git -C "$WT2" reset -q --hard "$BASE_SHA" && git -C "$WT2" clean -fdq
  if [ "$(git -C "$WT2" rev-parse HEAD)" != "$BASE_SHA" ] || [ -n "$(git -C "$WT2" status --porcelain)" ]; then
    echo "ABORT: the worktree did not reset"
    exit 2
  fi
}
SUBJECT="feat(db): plant a migration for the trailer cases"
wt_migration
wt_commit "$SUBJECT"
wt_check CT01 "a migration commit with no Ticket trailer" R-TRAILER
wt_migration
wt_commit "$SUBJECT

Ticket: T-031"
wt_check CT02 "CONTROL: a migration commit whose only trailer is Ticket" PASS
wt_migration
wt_commit "$SUBJECT

A body paragraph.

Ticket: T-031
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_t031_negative_test"
wt_check CT03 "CONTROL (the positional-parsing bug): Ticket is not the final line of the trailer block" PASS
wt_migration
wt_commit "$SUBJECT

Ticket: T-031

A paragraph after it, so the Ticket line is not in the final trailer block."
wt_check CT04 "a Ticket line in the body, followed by another paragraph" R-TRAILER
wt_migration
wt_commit "$SUBJECT

This plants a migration for the negative suite.
Ticket: T-031"
wt_check CT05 "Ticket as the LAST LINE of a prose paragraph: a last-line check reads it, git's parser does not" R-TRAILER
wt_migration
wt_commit "$SUBJECT

Ticket: TBD"
wt_check CT06 "a Ticket trailer whose value is not a ticket id" R-TRAILER
wt_migration
wt_commit "$SUBJECT

Ticket: T-031
Ticket: T-060"
wt_check CT07 "two Ticket trailers" R-TRAILER
wt_migration
wt_commit "$SUBJECT

Ticket: T-031"
wt_write "$T_DOWN" "-- the down file, amended by a second commit"
wt_commit "fix(db): amend the planted down file"
wt_check CT08 "two migration commits, only the FIRST with a trailer (every commit is read, not only the last)" R-TRAILER
wt_write "$APP" "application code in a commit with no trailer"
wt_commit "chore: a commit touching nothing under db/migrations"
wt_check CT09 "CONTROL: a commit with no trailer that touches nothing under db/migrations/" PASS
wt_migration
wt_commit "$SUBJECT

Ticket: T-031"
SIDE=$(git -C "$WT2" rev-parse HEAD)
git -C "$WT2" checkout -q --detach "$BASE_SHA" || {
  echo "ABORT: checkout"
  exit 2
}
wt_write "$APP" "a commit on the other line of history"
wt_commit "chore: the other line of history

Ticket: T-031"
git -C "$WT2" "${GITID[@]}" merge -q --no-ff --no-edit "$SIDE" || {
  echo "ABORT: merge"
  exit 2
}
if [ "$(git -C "$WT2" log -1 --format=%P | wc -w)" -ne 2 ]; then
  echo "ABORT: the merge commit did not land"
  exit 2
fi
wt_check CT0A "a non-fast-forward merge commit with git's default message, bringing the migration in on its second parent" R-TRAILER
git worktree remove --force "$WT2" && git worktree prune
restore

echo
if [ "$bad" -eq 0 ]; then
  echo "ALL $total CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $total cases misbehaved"
exit 1
