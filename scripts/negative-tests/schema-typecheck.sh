#!/usr/bin/env bash
# T-150 — does the generated db/schema.ts typecheck when a module imports it, and do the
# alternatives T-150 rejected fail the properties they were rejected for? (OD-93, OD-97)
#
#   cd /home/alex/projects/nanny/app && ./scripts/dev bash scripts/negative-tests/schema-typecheck.sh
#
# No service. Needs a clean, committed tree. Every case plants one thing, ASSERTS THE PLANT LANDED,
# runs the root program (`tsc --noEmit -p tsconfig.json`, which is `pnpm -w typecheck`), and judges
# it by the exit status AND the EXACT set of `<file>:<line> TS<code>` errors, so a crash, a no-op
# and a refusal are three different outcomes. After each case the tree is restored and asserted
# clean. The P cases call scripts/gates/lib/schema-render.ts directly (no database, no tsc run).
#
# T-168: EXIT/INT/TERM traps call restore(), so an INTERRUPTED run puts the tracked files back too —
# see the block beside them. T-168 also repaired S09, which was BAD on a clean tree (OD-161a).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: the tree is not clean. Commit first."
  git status --porcelain
  exit 2
fi

TSC=node_modules/.bin/tsc
SCHEMA=db/schema.ts
BASE=tsconfig.base.json
RENDER=scripts/gates/lib/schema-render.ts
TT=packages/db-testkit/type-tests
VALUE=$TT/schema-import-value.ts
TYPE=$TT/schema-import-type.ts
BITE=$TT/t150-bite.ts
C1=$TT/t150-c1.ts
PRIV=$TT/t150-private.ts
# T-168 (OD-161a). S09's fixture: real drizzle-kit output, planted at its own path under db/, which
# the root tsconfig does not `include` — so like db/schema.ts it enters the root program only when
# something imports it. Untracked, and removed by restore() below.
C1RENDER=db/t150-c1-schema.ts
MAIN_RENDERING=9f7ed68 # main before T-150: db/schema.ts with unknown(...) and an unpruned (table)
EMPTY_RENDERING=18b24c0 # T-138: drizzle-kit output for 0003, two imports and nothing using them
OUT=$(mktemp)
total=0
bad=0

abort() {
  echo "ABORT: $1"
  exit 2
}

restore() {
  rm -f "$BITE" "$C1" "$PRIV" "$C1RENDER"
  git checkout -q -- "$SCHEMA" "$BASE" "$VALUE" "$TYPE" "$RENDER"
  if [ -n "$(git status --porcelain)" ]; then
    git status --porcelain
    abort "the tree did not restore cleanly"
  fi
}

# T-168 (OD-160/OD-161). Every case above calls restore() explicitly, so a COMPLETE run already put
# the tree back. These traps close the interrupt window: between a case's first write and the next
# restore(), FIVE tracked paths are deleted, overwritten or rewritten in place — the two type-test
# importers, db/schema.ts, tsconfig.base.json and scripts/gates/lib/schema-render.ts, by `rm -f`,
# `sed -i`, `git show … >` and mutate.mjs across SIXTEEN sites on FIFTEEN lines (T-168 § Published
# contract §3 lists them at main c27c354: L108, L113, L136, L144, L164, L170, L171, L175, L176,
# L186, L188, L189, L208, L209, L239 — those are MAIN's numbers, and this block shifts them; L189
# is two sites because `rm -f "$VALUE" "$TYPE"` names two tracked paths on one line). Until this
# ticket a Ctrl-C left them that way.
# The count was "eleven sites" until T-168 rework 1: eleven is the number of ITEMS in the list
# above once L164-L176 is written as a range, not the number of sites. Sites are NOT deduplicated
# — one line writing two paths is two sites — which is the lesson of T-156's signed annotation and
# the third time this class of count has been understated here.
#
# The restoring instrument is restore() itself — `git checkout` over tracked paths plus `rm -f` over
# the planted ones. It is NOT app-images.sh's PLANTED delete-list: this suite removes and overwrites
# files git already has, so git is the backup.
#
# restore() aborts (exit 2) when the tree does not come back clean, so "restored", "could not
# restore" and "was never touched" stay three distinguishable outcomes even from inside a trap.
#
# What the INT/TERM lines add over the EXIT line alone is NOT measured here (T-156 § H measured, for
# app-images.sh on this bash, that the EXIT trap already runs when the shell dies of SIGINT/SIGTERM).
# What IS measured for this suite (T-168 § C) is the pair as delivered: the run announces the
# interrupt instead of dying silently mid-case, exits 130/143 rather than bash's default, and leaves
# `git status --porcelain` empty. SIGKILL restores nothing and no trap can change that.
trap 'restore; rm -f "$OUT" "$OUT.eslint"' EXIT
trap 'echo; echo "INTERRUPTED (SIGINT) — restoring the working tree"; restore; rm -f "$OUT" "$OUT.eslint"; trap - EXIT; exit 130' INT
trap 'echo; echo "TERMINATED (SIGTERM) — restoring the working tree"; restore; rm -f "$OUT" "$OUT.eslint"; trap - EXIT; exit 143' TERM

mutate() {
  node scripts/negative-tests/mutate.mjs "$1" "$2" "$3" || abort "mutation anchor missing in $1"
  if git diff --quiet -- "$1"; then abort "the mutation did not change $1"; fi
}

plant() {
  printf '%s\n' "$2" >"$1"
  [ "$(cat "$1")" = "$2" ] || abort "the plant did not land in $1"
}

# line_of <file> <fixed string>: the line number of the single line containing it.
line_of() {
  local n
  n=$(grep -nF -- "$2" "$1" | cut -d: -f1)
  [ "$(printf '%s\n' "$n" | grep -c .)" -eq 1 ] || abort "expected exactly one line containing '$2' in $1, got '$n'"
  printf '%s' "$n"
}

# errors: the set of `<file>:<line> TS<code>` tsc printed, one per line, sorted.
errors() {
  grep -oE '^[^(: ]+\([0-9]+,[0-9]+\): error TS[0-9]+' "$OUT" |
    sed -E 's/^([^(]+)\(([0-9]+),[0-9]+\): error (TS[0-9]+)$/\1:\2 \3/' | sort -u
}

# judge <id> <description> <expected exit> <expected error set, newline-separated, or empty>
judge() {
  local id=$1 desc=$2 want_code=$3 want=$4 code=$5 got verdict=BAD
  total=$((total + 1))
  got=$(errors)
  want=$(printf '%s' "$want" | grep . | sort -u)
  if [ "$code" -eq "$want_code" ] && [ "$got" = "$want" ]; then verdict=ok; fi
  [ "$verdict" = ok ] || bad=$((bad + 1))
  printf '%-4s %s  %s\n       exit %s (expected %s)\n' "$verdict" "$id" "$desc" "$code" "$want_code"
  printf '       expected errors: %s\n' "$(printf '%s' "${want:-none}" | tr '\n' ';')"
  printf '       reported errors: %s\n' "$(printf '%s' "${got:-none}" | tr '\n' ';')"
  if [ "$verdict" != ok ]; then grep -E 'error TS' "$OUT" | cut -c1-240 | sed 's/^/       ! /'; fi
}

typecheck() {
  "$TSC" --noEmit -p tsconfig.json >"$OUT" 2>&1
  echo $?
}

in_program() {
  "$TSC" --listFilesOnly -p tsconfig.json 2>/dev/null | grep -c "/$SCHEMA\$"
}

echo "typescript $("$TSC" --version); HEAD $(git rev-parse --short HEAD)"

echo "== control"
grep -qF "import { account, appSession, localeRegistry } from '../../../db/schema.ts';" "$VALUE" || abort "$VALUE does not value-import db/schema.ts"
grep -qF "import type { account, appSession } from '../../../db/schema.ts';" "$TYPE" || abort "$TYPE does not type-import db/schema.ts"
[ "$(in_program)" -eq 1 ] || abort "db/schema.ts is not in the root program"
judge S00 "CONTROL: the committed tree, both importers present, db/schema.ts in the root program" 0 "" "$(typecheck)"
restore

echo "== each import form alone"
rm -f "$VALUE"
[ ! -e "$VALUE" ] || abort "$VALUE still exists"
[ "$(in_program)" -eq 1 ] || abort "db/schema.ts left the program with only the import type importer"
judge S01 "import type alone pulls db/schema.ts into the program, and it typechecks" 0 "" "$(typecheck)"
restore
rm -f "$TYPE"
[ ! -e "$TYPE" ] || abort "$TYPE still exists"
[ "$(in_program)" -eq 1 ] || abort "db/schema.ts left the program with only the value importer"
judge S02 "the value import alone typechecks" 0 "" "$(typecheck)"
restore

echo "== the mapped columns refuse wrong values at an importer (exact code and line)"
BITE_TEXT="import type { account, appSession } from '../../../db/schema.ts';
export const b1: (typeof account.\$inferSelect)['emailCi'] = 12345;
export const b2: (typeof account.\$inferInsert)['emailCi'] = 12345;
export const b3: (typeof appSession.\$inferSelect)['tokenHash'] = 12345;
export const b4: (typeof appSession.\$inferInsert)['tokenHash'] = 'deadbeef';
export const b5: (typeof account.\$inferSelect)['phoneE164'] = 12345;"
plant "$BITE" "$BITE_TEXT"
judge S03 "citext refuses a number (select, insert); bytea refuses a number and a hex string; the text control refuses a number" 2 "$BITE:2 TS2322
$BITE:3 TS2322
$BITE:4 TS2322
$BITE:5 TS2322
$BITE:6 TS2322" "$(typecheck)"
restore
L1=$(line_of "$VALUE" "export const emailNumber")
L2=$(line_of "$VALUE" "export const digestNumber")
L3=$(line_of "$VALUE" "export const digestHex")
sed -i '/^\/\/ @ts-expect-error TS2322 /d' "$VALUE"
[ "$(git diff --numstat -- "$VALUE" | cut -f2)" = 3 ] || abort "expected exactly 3 directive lines removed from $VALUE"
judge S04 "the committed importer's three @ts-expect-error lines, directives stripped: exactly TS2322 on each, nothing else" 2 "$VALUE:$((L1 - 1)) TS2322
$VALUE:$((L2 - 2)) TS2322
$VALUE:$((L3 - 3)) TS2322" "$(typecheck)"
restore

echo "== red before: the same importers against main's rendering ($MAIN_RENDERING)"
git show "$MAIN_RENDERING:$SCHEMA" >"$SCHEMA"
grep -q 'unknown("email_ci")' "$SCHEMA" || abort "the $MAIN_RENDERING rendering did not land"
plant "$BITE" "$BITE_TEXT"
S_TABLE=$(line_of "$SCHEMA" 'export const localeRegistry = pgTable("locale_registry", {')
S_TABLE=$((S_TABLE + 7)) # its `}, (table) => [` line: the callback parameter nothing reads
S_EMAIL=$(line_of "$SCHEMA" 'emailCi: unknown("email_ci")')
S_TOKEN=$(line_of "$SCHEMA" 'tokenHash: unknown("token_hash")')
D1=$(line_of "$VALUE" "@ts-expect-error TS2322 citext column refuses a number")
D2=$(line_of "$VALUE" "@ts-expect-error TS2322 bytea column refuses a number")
D3=$(line_of "$VALUE" "@ts-expect-error TS2322 bytea column refuses a hex string")
judge S05 "RED BEFORE: TS6133 + 2x TS2693 in db/schema.ts; the four column bites are SILENT (only the control bites); the three directives go unused" 2 "$SCHEMA:$S_TABLE TS6133
$SCHEMA:$S_EMAIL TS2693
$SCHEMA:$S_TOKEN TS2693
$BITE:6 TS2322
$VALUE:$D1 TS2578
$VALUE:$D2 TS2578
$VALUE:$D3 TS2578" "$(typecheck)"
restore

echo "== a real type error in the generated body is still caught"
mutate "$SCHEMA" "role: text().notNull()," "role: text().notNul(),"
B_LINE=$(line_of "$SCHEMA" "role: text().notNul(),")
judge S06 "a drizzle API misuse planted in the body (account_role.role .notNul()) fails the root program" 2 "$SCHEMA:$B_LINE TS2551" "$(typecheck)"
restore

echo "== rejected option A: // @ts-nocheck on the generated file"
mutate "$SCHEMA" "role: text().notNull()," "role: text().notNul(),"
mutate "$SCHEMA" "// GENERATED by" "// @ts-nocheck
// GENERATED by"
judge S07 "A: the same body error with @ts-nocheck is NOT reported (a body error is no longer caught)" 0 "" "$(typecheck)"
restore
mutate "$SCHEMA" "	emailCi: citext(\"email_ci\")," "	emailCi: citext(\"email_ci\").notNul(),"
mutate "$SCHEMA" "// GENERATED by" "// @ts-nocheck
// GENERATED by"
plant "$BITE" "$BITE_TEXT"
judge S08 "A: a body error on account.emailCi with @ts-nocheck: nothing reported in db/schema.ts, and emailCi silently loses its type at every importer (its two bites and the committed directive go SILENT); other columns keep theirs" 2 "$BITE:4 TS2322
$BITE:5 TS2322
$BITE:6 TS2322
$VALUE:$D1 TS2578" "$(typecheck)"
restore

echo "== rejected option C1: noUnusedParameters off alone"
# T-168 (OD-161a). What this case is about is the TEXT of real drizzle-kit output under one set of
# tsconfig flags — not db/schema.ts's path. It used to install T-138's rendering OVER db/schema.ts
# and delete the two type-test importers. That rendering exports nothing, so once T-135/T-141 gave
# apps/core a real value import (`account, accountRole, appSession` at
# apps/core/src/identity/account.repository.ts:30, committed after this case was written) the swap
# made the root program emit three TS2305s that the expectation neither lists nor is about, and the
# case went BAD on a clean tree — `!! 1 of 16`, on main at c27c354.
#
# The rendering now goes to its own path under db/, which the root tsconfig does not `include`, and
# $C1 imports it exactly as an importer pulls in db/schema.ts. db/schema.ts is left committed, so
# every real importer of it still typechecks and the only errors left in the program are the two
# this case names. The expectation is NOT widened: it is still exactly the two TS6133s, still under
# `noUnusedParameters: false`, and the case still goes BAD if either stops being reported.
# Side effect worth stating, narrowed in T-168 rework 1 (QR-F2) because the first wording said
# "S09 no longer writes to any tracked path at all" and the very next mutate line falsifies it:
# S09 no longer writes db/schema.ts — which is the point of the fix, and is asserted three lines
# down by `git diff --quiet -- "$SCHEMA"`. It DOES still write the tracked tsconfig.base.json
# (the `mutate "$BASE"` below; BASE=tsconfig.base.json), and it plants the untracked $C1RENDER and
# $C1. Interrupted inside this block, `git status --porcelain` reads ` M tsconfig.base.json`; the
# traps above are what put it back.
git show "$EMPTY_RENDERING:$SCHEMA" >"$C1RENDER"
grep -q '^import { sql } from "drizzle-orm"$' "$C1RENDER" || abort "the $EMPTY_RENDERING rendering did not land in $C1RENDER"
git diff --quiet -- "$SCHEMA" || abort "S09 must not modify $SCHEMA"
mutate "$BASE" '"noUnusedParameters": true,' '"noUnusedParameters": false,'
plant "$C1" "import '../../../db/t150-c1-schema.ts';"
# Anti-vacuity: judge nothing about a file tsc never read.
[ "$("$TSC" --listFilesOnly -p tsconfig.json 2>/dev/null | grep -c "/$C1RENDER\$")" -eq 1 ] ||
  abort "$C1RENDER is not in the root program"
E_PG=$(line_of "$C1RENDER" 'import { pgTable } from "drizzle-orm/pg-core"')
E_SQL=$(line_of "$C1RENDER" 'import { sql } from "drizzle-orm"')
judge S09 "C1: real drizzle-kit output whose sql import nothing reads still fails noUnusedLocals with noUnusedParameters off" 2 "$C1RENDER:$E_PG TS6133
$C1RENDER:$E_SQL TS6133" "$(typecheck)"
restore

echo "== rejected option C2: both unused-identifier flags off"
plant "$PRIV" "export class T150Holder {
  private secret = 1;
}"
judge S10 "CONTROL C2: under the committed flags an unused private member in hand-written code is refused" 2 "$PRIV:2 TS6133" "$(typecheck)"
node_modules/.bin/eslint --no-warn-ignored "$PRIV" >"$OUT.eslint" 2>&1
ESLINT=$?
restore
plant "$PRIV" "export class T150Holder {
  private secret = 1;
}"
mutate "$BASE" '"noUnusedLocals": true,' '"noUnusedLocals": false,'
mutate "$BASE" '"noUnusedParameters": true,' '"noUnusedParameters": false,'
judge S11 "C2: with both flags off the same unused private member is NOT reported" 0 "" "$(typecheck)"
printf '       eslint on the same file (does lint backstop it?): exit %s\n' "$ESLINT"
sed 's/^/       eslint: /' "$OUT.eslint" | grep -v '^       eslint: $' | head -8
restore

echo "== P: schema-render.ts called directly"
pure() {
  local id=$1 desc=$2 script=$3 verdict=BAD
  total=$((total + 1))
  node --input-type=module -e "$script" >"$OUT" 2>&1
  local code=$?
  if [ "$code" -eq 0 ] && grep -q '^RESULT ok$' "$OUT"; then verdict=ok; else bad=$((bad + 1)); fi
  printf '%-4s %s  %s\n       exit %s\n' "$verdict" "$id" "$desc" "$code"
  sed 's/^/       /' "$OUT"
}
PRELUDE='
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { mapColumnTypes, pruneUnused, readRootCompilerOptions } from "./scripts/gates/lib/schema-render.ts";
const SCHEMA_PATH = path.resolve("db/schema.ts");
const { options, errors } = readRootCompilerOptions(path.resolve("tsconfig.json"));
if (errors.length) { console.log("tsconfig errors", errors); process.exit(3); }
const bodyOf = (text) => text.split("\n").slice(3).join("\n");
'
pure P01 "the deleteImports half: T-138's empty rendering has both imports removed and no diagnostic left" "$PRELUDE
const raw = bodyOf(execFileSync('git', ['show', '$EMPTY_RENDERING:db/schema.ts'], { encoding: 'utf8' }));
const r = pruneUnused(raw, SCHEMA_PATH, options);
const imports = r.text.split('\n').filter((l) => l.startsWith('import ')).length;
console.log('imports before', raw.split('\n').filter((l) => l.startsWith('import ')).length, 'after', imports, 'edits', r.edits, 'diagnostics', JSON.stringify(r.diagnostics));
console.log(imports === 0 && r.diagnostics.length === 0 && r.converged ? 'RESULT ok' : 'RESULT bad');"
mutate "$RENDER" "const FIX_IDS = ['unusedIdentifier_delete', 'unusedIdentifier_deleteImports'] as const;" "const FIX_IDS = ['unusedIdentifier_delete'] as const;"
pure P02 "deleteImports removed from the fix list: the same rendering keeps its unused imports and TS6133 is left (so I-TSC would refuse it)" "$PRELUDE
const raw = bodyOf(execFileSync('git', ['show', '$EMPTY_RENDERING:db/schema.ts'], { encoding: 'utf8' }));
const r = pruneUnused(raw, SCHEMA_PATH, options);
console.log('diagnostics', JSON.stringify(r.diagnostics));
console.log(r.diagnostics.length >= 1 && r.diagnostics.every((d) => d.startsWith('TS6133 ')) ? 'RESULT ok' : 'RESULT bad');"
restore
pure P03 "idempotence: mapping and pruning the committed body again changes nothing (0 edits, identical text)" "$PRELUDE
const body = bodyOf(fs.readFileSync('db/schema.ts', 'utf8'));
const m = mapColumnTypes(body);
if (!m.ok) { console.log(m.problems); process.exit(4); }
const r = pruneUnused(m.body, SCHEMA_PATH, options);
console.log('mapped', JSON.stringify(m.mapped), 'edits', r.edits, 'passes', r.passes, 'diagnostics', r.diagnostics.length, 'identical', r.text === body);
console.log(m.mapped.length === 0 && r.edits === 0 && r.text === body && r.diagnostics.length === 0 ? 'RESULT ok' : 'RESULT bad');"
pure P04 "an unknown( with no TODO line in front of it is refused, not passed through" "$PRELUDE
const raw = 'import { pgTable } from \"drizzle-orm/pg-core\"\n\nexport const t = pgTable(\"t\", {\n\tx: unknown(\"x\"),\n});\n';
const m = mapColumnTypes(raw);
console.log(JSON.stringify(m));
console.log(!m.ok && m.problems.length === 1 && m.problems[0].includes('unknown(') ? 'RESULT ok' : 'RESULT bad');"
restore

echo
if [ "$bad" -eq 0 ]; then
  echo "ALL $total CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $total cases misbehaved"
exit 1
