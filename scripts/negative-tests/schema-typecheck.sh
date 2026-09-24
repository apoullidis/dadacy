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
# T-153 (OD-107): P05 maps drizzle-kit's real bigint rendering into drizzle's bigint mode (idempotently),
# and P06 shows the hint the rewrite could not consume refused — and a text DEFAULT equal to that
# sentence NOT refused (QR-A2).
# T-153 rework 1 (OD-147, OD-148): P07/P08/P09 call the PER-COLUMN catalogue match directly, on the
# three families qa-verification got past the old count and the old line-local regex: the four
# number-mode formatting shapes (P07), a lossy column beside a spurious bigint-mode column that cancels
# under a count (P08), and its C10 construction, a lossy column beside a text DEFAULT holding the text
# of a bigint-mode call (P09). P07m/P08m/P09m are the same three with the old regex and the old count
# put back by a mutation asserted landed: each then gets through.
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

# (T-153 merge of main 3385ede: T-153's OD-146 fix of S09 — a program of C1 alone, through a planted
# tsconfig.t153-s09-c1.json — is superseded by main's T-168 fix of the same case (OD-161a, $C1RENDER
# above), and is removed. undo() below removes $C1RENDER, so abort() puts it back too.)

# undo: put every file a case may have planted or mutated back. Called by restore() AND by abort(),
# because every case mutates the working tree and an abort is an exit path like any other.
undo() {
  rm -f "$BITE" "$C1" "$PRIV" "$C1RENDER"
  git checkout -q -- "$SCHEMA" "$BASE" "$VALUE" "$TYPE" "$RENDER"
}

# T-153 rework 1 (QR-A5): abort() RESTORES THE WORKING TREE before exiting. It used to exit straight
# out, so an abort reached inside a mutated case — S09's own `$C1RENDER is not in the root program`
# among them — left db/schema.ts, tsconfig.base.json and the committed importers mutated for whatever
# ran next. The guard stops the recursion when restore()'s own assertion is what aborted.
ABORTING=0
abort() {
  echo "ABORT: $1"
  if [ "$ABORTING" -eq 0 ]; then
    ABORTING=1
    undo
    echo "ABORT: working tree restored; git status --porcelain follows ($(git status --porcelain | grep -c .) line(s)):"
    git status --porcelain
  fi
  exit 2
}

restore() {
  undo
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
import { mapColumnTypes, checkCatalogueColumns, parseRendering, pruneUnused, readRootCompilerOptions } from "./scripts/gates/lib/schema-render.ts";
const SCHEMA_PATH = path.resolve("db/schema.ts");
const { options, errors } = readRootCompilerOptions(path.resolve("tsconfig.json"));
if (errors.length) { console.log("tsconfig errors", errors); process.exit(3); }
const bodyOf = (text) => text.split("\n").slice(3).join("\n");
// one COLUMN_TYPES_SQL row, as db-introspect.ts reads it from the catalogue.
const col = (relation, column, type, dims) => ({ relation, column, type, attndims: dims, dims, kind: "int8" });
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

# T-153 (OD-107): drizzle-kit 0.31.10's bigint rendering, lines verbatim from a real pull (T-153 § Evidence,
# phase M, plant A): an identity PK, DEFAULT 0, a sql default, a bigint[] default above 2^53, a bigserial,
# and a view whose first column follows `{` on the hint's own line. <TAB> stands for the tab drizzle-kit writes.
T153_RAW=$(
  cat <<'EOF'
import { pgTable, bigint, bigserial, pgView } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const t153Parent = pgTable("t153_parent", {
<TAB>// You can use { mode: "bigint" } if numbers are exceeding js number limitations
<TAB>id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "t153_parent_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
<TAB>note: text(),
});

export const t153Money = pgTable("t153_money", {
<TAB>// You can use { mode: "bigint" } if numbers are exceeding js number limitations
<TAB>zeroMinor: bigint("zero_minor", { mode: "number" }).default(0).notNull(),
<TAB>// You can use { mode: "bigint" } if numbers are exceeding js number limitations
<TAB>negDefault: bigint("neg_default", { mode: "number" }).default(sql`'-5'`),
<TAB>// You can use { mode: "bigint" } if numbers are exceeding js number limitations
<TAB>listDefault: bigint("list_default", { mode: "number" }).array().default([1, 9007199254740993]).notNull(),
<TAB>serialId: bigserial("serial_id", { mode: "bigint" }).notNull(),
});
export const t153MoneyV = pgView("t153_money_v", {<TAB>// You can use { mode: "bigint" } if numbers are exceeding js number limitations
<TAB>id: bigint({ mode: "number" }),
<TAB>// You can use { mode: "bigint" } if numbers are exceeding js number limitations
<TAB>amountMinor: bigint("amount_minor", { mode: "number" }),
}).as(sql`SELECT id, amount_minor FROM t153_money`);
EOF
)
# The lines the rewrite must produce (as T-153 § Evidence phase A's written db/schema.ts has them).
T153_WANT=$(
  cat <<'EOF'
<TAB>id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity({ name: "t153_parent_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
<TAB>zeroMinor: bigint("zero_minor", { mode: "bigint" }).default(0n).notNull(),
<TAB>negDefault: bigint("neg_default", { mode: "bigint" }).default(sql`'-5'`),
<TAB>listDefault: bigint("list_default", { mode: "bigint" }).array().default([1n, 9007199254740993n]).notNull(),
<TAB>serialId: bigserial("serial_id", { mode: "bigint" }).notNull(),
export const t153MoneyV = pgView("t153_money_v", {
<TAB>id: bigint({ mode: "bigint" }),
<TAB>amountMinor: bigint("amount_minor", { mode: "bigint" }),
EOF
)
export T153_RAW T153_WANT
pure P05 "(T-153) drizzle-kit's real bigint rendering: 6 number-mode columns in bigint mode, integer defaults as bigint literals, every hint gone (the view's inline one too), bigserial untouched; mapping again changes nothing" "$PRELUDE
const tab = (s) => s.replaceAll('<TAB>', '\t');
const m = mapColumnTypes(tab(process.env.T153_RAW));
if (!m.ok) { console.log('refused', JSON.stringify(m.problems)); process.exit(4); }
const lines = m.body.split('\n');
const missing = tab(process.env.T153_WANT).split('\n').filter((w) => w !== '' && !lines.includes(w));
const left = lines.filter((l) => l.includes('mode: \"number\"') || l.includes('You can use'));
const again = mapColumnTypes(m.body);
console.log('bigints', m.bigints, 'missing', JSON.stringify(missing), 'left', JSON.stringify(left), 'again identical', again.ok && again.body === m.body, 'again bigints', again.ok ? again.bigints : 'refused');
console.log(m.bigints === 6 && missing.length === 0 && left.length === 0 && again.ok && again.body === m.body && again.bigints === 0 ? 'RESULT ok' : 'RESULT bad');"
pure P06 "(T-153 r1) a bigint the rewrite does not recognise: the hint it could not consume is refused by mapColumnTypes (and only OUTSIDE a string literal, so a text DEFAULT equal to the hint sentence is NOT refused — QR-A2)" "$PRELUDE
const tab = (s) => s.replaceAll('<TAB>', '\t');
const head = 'import { pgTable, bigint, text } from \"drizzle-orm/pg-core\"\n\nexport const t = pgTable(\"t\", {\n';
const hint = '<TAB>// You can use { mode: \"bigint\" } if numbers are exceeding js number limitations\n';
const refuse = {
  extraOption: hint + '<TAB>b: bigint(\"b\", { mode: \"number\", unsigned: true }),\n',
  hintAlone: hint + '<TAB>c: text(\"c\"),\n',
};
const admit = {
  hintAsATextDefault: '<TAB>n: text().default(\"// You can use { mode: \\\\\"bigint\\\\\" } if numbers are exceeding js number limitations\"),\n',
};
let ok = 0;
for (const [name, c] of Object.entries(refuse)) {
  const m = mapColumnTypes(tab(head + c + '});\n'));
  const good = !m.ok && m.problems.length === 1 && m.problems[0].includes(\"still carries drizzle-kit's bigint hint comment\");
  console.log(name, good ? 'refused' : 'NOT refused', JSON.stringify(m.ok ? m.body : m.problems));
  if (good) ok += 1;
}
for (const [name, c] of Object.entries(admit)) {
  const m = mapColumnTypes(tab(head + c + '});\n'));
  console.log(name, m.ok ? 'admitted (the hint is only a string literal)' : 'REFUSED', JSON.stringify(m.ok ? m.body : m.problems));
  if (m.ok) ok += 1;
}
console.log(ok === 3 ? 'RESULT ok' : 'RESULT bad');"

# T-153 rework 1 (OD-148, QR-F2): four bigint-in-number-mode shapes drizzle-kit 0.31.10 does not write,
# which qa-verification measured passing the old line-local text guard (PURE.out). The per-column
# catalogue match reads the PARSED TypeScript, so none of them is a shape at all — each is a bigint
# column in "number" mode and each is refused by name.
T153_SHAPES=$(
  cat <<'EOF'
{
  "optionsObjectSplitOverTwoLines": "import { pgTable, bigint } from \"drizzle-orm/pg-core\"\n\nexport const t = pgTable(\"t\", {\n\ta: bigint(\"a\", {\n\t\tmode: \"number\"\n\t}),\n});\n",
  "callSplitBeforeItsOptions":     "import { pgTable, bigint } from \"drizzle-orm/pg-core\"\n\nexport const t = pgTable(\"t\", {\n\ta: bigint(\n\t\t\"a\",\n\t\t{ mode: \"number\" },\n\t),\n});\n",
  "singleQuotedMode":              "import { pgTable, bigint } from \"drizzle-orm/pg-core\"\n\nexport const t = pgTable(\"t\", {\n\ta: bigint(\"a\", { mode: 'number' }),\n});\n",
  "noSpaceAfterTheColon":          "import { pgTable, bigint } from \"drizzle-orm/pg-core\"\n\nexport const t = pgTable(\"t\", {\n\ta: bigint(\"a\", {mode:\"number\"}),\n});\n"
}
EOF
)
# One relation, one catalogue int8 column `a`, rendered lossy beside a spurious bigint-mode column the
# catalogue does not list as int8: under a COUNT the two cancel (1 rendered against 1 int8).
T153_CANCEL='import { pgTable, bigint } from "drizzle-orm/pg-core"

export const t = pgTable("t", {
	a: bigint("a", { mode: "number" }),
	b: bigint("b", { mode: "bigint" }),
});
'
# qa-verification's C10 construction: a lossy bigint beside a TEXT column whose DEFAULT is the text of a
# bigint-mode call. Under a regex COUNT over the relation's text the literal is counted as a column.
T153_TEXTDEFAULT='import { pgTable, bigint, text } from "drizzle-orm/pg-core"

export const t = pgTable("t", {
	amount: bigint({mode:"number"}),
	note: text().default('"'"'bigint("q", { mode: "bigint" })'"'"'),
});
'
export T153_SHAPES T153_CANCEL T153_TEXTDEFAULT

# MUTATION 1, "restore the regex": the mode judgement becomes the old LINE-LOCAL NUMBER_MODE_CALL test
# over the column's own source line, which is what qa-verification got past.
T153_REGEX_MUTATION=$(
  cat <<'EOF'
    const T153_NUMBER_MODE_CALL = /\bbig(?:int|serial)\((?:"[^"\n]*", )?\{[^}\n]*\bmode: "number"/;
    if (got.mode !== 'bigint' && T153_NUMBER_MODE_CALL.test(body.split('\n')[got.line - 1] ?? '')) {
EOF
)
# MUTATION 2, "restore the count": the per-column match becomes the original per-relation COUNT of
# bigint-mode calls in the relation's rendering TEXT (T-153 cycle 0, OD-147/OD-148).
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
SHAPES_JS="$PRELUDE
const shapes = JSON.parse(process.env.T153_SHAPES);
const cat = [col('t', 'a', 'bigint', 0)];
let refused = 0;
for (const [name, text] of Object.entries(shapes)) {
  const r = checkCatalogueColumns(text, cat);
  const mode = parseRendering(text).relations.get('t').columns.get('a').mode;
  const good = r.problems.length === 1 && r.problems[0].includes('int8 column \"t\".\"a\"') && r.problems[0].includes('mode, so it would reach importers as a JS number');
  console.log(name, 'parsed mode', JSON.stringify(mode), good ? 'REFUSED' : 'NOT refused', JSON.stringify(r.problems));
  if (good) refused += 1;
}
console.log('refused', refused, 'of', Object.keys(shapes).length);"
pure P07 "(T-153 r1) the four number-mode shapes drizzle-kit does not write (options over two lines, the call split before its options, single quotes, no space after the colon): each parsed as mode \"number\" and refused per column" "$SHAPES_JS
console.log(refused === 4 ? 'RESULT ok' : 'RESULT bad');"
mutate "$RENDER" "    if (got.mode !== 'bigint') {" "$T153_REGEX_MUTATION"
git diff -U0 -- "$RENDER" | grep -E '^[-+][^-+]' | sed 's/^/       mutation:   /'
pure P07m "(T-153 r1) RED BEFORE: with the old line-local number-mode REGEX restored, all four shapes get past the guard again" "$SHAPES_JS
console.log(refused === 0 ? 'RESULT ok' : 'RESULT bad');"
restore

CANCEL_JS="$PRELUDE
const cat = [col('t', 'a', 'bigint', 0)];
const r = checkCatalogueColumns(process.env.T153_CANCEL, cat);
console.log('problems', JSON.stringify(r.problems));
const lossy = r.problems.some((p) => p.includes('int8 column \"t\".\"a\"') && p.includes('\"number\" mode'));
const spurious = r.problems.some((p) => p.includes('builds column \"b\"') && p.includes('the catalogue does not list that column as int8'));
console.log('lossy column named', lossy, 'spurious bigint column named', spurious, 'problems', r.problems.length);"
pure P08 "(T-153 r1) a lossy int8 column beside a spurious bigint-mode column the catalogue does not list as int8 — the pair that CANCELS under a count: both named, per column" "$CANCEL_JS
console.log(lossy && spurious && r.problems.length === 2 ? 'RESULT ok' : 'RESULT bad');"
TEXTDEFAULT_JS="$PRELUDE
const cat = [col('t', 'amount', 'bigint', 0)];
const r = checkCatalogueColumns(process.env.T153_TEXTDEFAULT, cat);
console.log('problems', JSON.stringify(r.problems));
const named = r.problems.some((p) => p.includes('int8 column \"t\".\"amount\"') && p.includes('\"number\" mode'));
console.log('the lossy column is named', named, 'problems', r.problems.length);"
pure P09 "(T-153 r1) qa-verification's C10: a lossy bigint beside a TEXT column whose DEFAULT is the text of a bigint-mode call — the text default no longer affects the judgement" "$TEXTDEFAULT_JS
console.log(named && r.problems.length === 1 ? 'RESULT ok' : 'RESULT bad');"
mutate "$RENDER" "  const int8 = matchInt8Columns(body, columns);" "$T153_COUNT_MUTATION"
grep -qF 'const BIGINT_MODE_CALL = /\bbig(?:int|serial)\(' "$RENDER" || abort "the count mutation did not land in $RENDER"
git diff --numstat -- "$RENDER" | sed 's/^/       mutation landed, numstat (added removed file): /'
pure P08m "(T-153 r1) RED BEFORE: with the per-relation COUNT restored, the lossy column and the spurious bigint-mode column cancel and nothing is reported" "$CANCEL_JS
console.log(r.problems.length === 0 ? 'RESULT ok' : 'RESULT bad');"
pure P09m "(T-153 r1) RED BEFORE: with the per-relation COUNT restored, the text DEFAULT is counted as a bigint column and the lossy one is not reported" "$TEXTDEFAULT_JS
console.log(r.problems.length === 0 ? 'RESULT ok' : 'RESULT bad');"
restore

echo
if [ "$bad" -eq 0 ]; then
  echo "ALL $total CASES BEHAVED AS EXPECTED"
  exit 0
fi
echo "!! $bad of $total cases misbehaved"
exit 1
