#!/usr/bin/env bash
# T-147 — every refusal `packages/contracts/src/jobs.ts` claims, shown RED with
# its mechanism DELETED (PROTOCOL §5.1: "a gate that has only ever been seen
# green has not been shown to be wired to anything").
#
# WHAT THIS HARNESS REFUSES TO DO SILENTLY, because the four defects PROTOCOL
# §5.1 names were all harness no-ops:
#
#   1. A mutation that does not land is a HARNESS ERROR, never a pass.
#      scripts/negative-tests/mutate.mjs exits non-zero when its anchor is
#      missing, AND this script independently asserts afterwards that the file
#      changed (`git diff --quiet` must FAIL) and that the anchor text is gone.
#   2. A case does not read "non-zero == refused". It compares the SET of
#      failing test titles against the set the case declares. A mutation that
#      reddens MORE than it should, or a different test than it should, fails
#      the case — so a crash, an import error or an over-broad mutation is
#      distinguishable from the refusal being measured.
#   3. Every case restores the file and asserts it is byte-identical to HEAD
#      before the next case starts, so no case can inherit another's mutation.
#
# Run it through the toolbox — there is no node on the host (DOCKER.md §0.1):
#   scripts/dev bash scripts/negative-tests/jobs-contract.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

JOBS=packages/contracts/src/jobs.ts
PKG=packages/contracts
MUT=scripts/negative-tests/mutate.mjs
TMP="$(mktemp -d)"
trap 'git checkout -- "$JOBS" 2>/dev/null; rm -rf "$TMP"' EXIT

pass=0
fail=0

# Print the leaf titles of the failing tests in src/jobs.test.ts, one per line.
run_jobs_suite() {
  local report="$TMP/report.json"
  rm -f "$report"
  ( cd "$PKG" && NO_COLOR=1 ./node_modules/.bin/vitest run src/jobs.test.ts \
      --reporter=json "--outputFile.json=$report" ) >"$TMP/out" 2>&1
  if [ ! -f "$report" ]; then
    echo "HARNESS ERROR: vitest wrote no JSON report" >&2
    sed -n '1,40p' "$TMP/out" >&2
    return 2
  fi
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const failed = r.testResults.flatMap((f) => f.assertionResults)
      .filter((a) => a.status !== "passed").map((a) => a.title);
    if (r.numTotalTests === 0) { console.error("HARNESS ERROR: 0 tests ran"); process.exit(2); }
    console.error(`(${r.numTotalTests} tests ran, ${failed.length} failed)`);
    for (const t of failed.sort()) console.log(t);
  ' "$report"
}

# assert_mutation_landed <anchor-that-must-be-gone>
assert_mutation_landed() {
  if git diff --quiet -- "$JOBS"; then
    echo "  HARNESS ERROR: $JOBS is unchanged after the mutation" >&2
    return 1
  fi
  if grep -qF -- "$1" "$JOBS"; then
    echo "  HARNESS ERROR: the deleted mechanism is still present in $JOBS" >&2
    return 1
  fi
  echo "  mutation landed: $(git diff --numstat -- "$JOBS" | awk '{print $1" insertion(s), "$2" deletion(s)"}')"
  return 0
}

restore() {
  git checkout -- "$JOBS"
  if ! git diff --quiet -- "$JOBS"; then
    echo "  HARNESS ERROR: $JOBS did not restore" >&2
    exit 2
  fi
}

# case <id> <description> <anchor> <replacement> <expected failing titles...>
case_run() {
  local id="$1" desc="$2" from="$3" to="$4"
  shift 4
  local expected
  expected="$(printf '%s\n' "$@" | sort)"

  echo
  echo "=============================================================================="
  echo "$id — $desc"
  echo "=============================================================================="

  # 0. the control: before the mutation, nothing in this file fails.
  local before
  before="$(run_jobs_suite)" || { echo "  FAIL $id: control run errored"; fail=$((fail + 1)); return; }
  if [ -n "$before" ]; then
    echo "  HARNESS ERROR: the suite is already red before the mutation:"
    echo "$before"
    fail=$((fail + 1))
    return
  fi

  node "$MUT" "$JOBS" "$from" "$to" || {
    echo "  FAIL $id: mutation did not apply"
    fail=$((fail + 1))
    restore
    return
  }
  assert_mutation_landed "$from" || { echo "  FAIL $id"; fail=$((fail + 1)); restore; return; }

  local actual
  actual="$(run_jobs_suite)"
  local rc=$?
  if [ "$rc" = "2" ]; then
    echo "  FAIL $id: harness error during the mutated run"
    fail=$((fail + 1))
    restore
    return
  fi
  echo "  RED:"
  echo "$actual" | sed 's/^/    - /'

  if [ "$actual" = "$expected" ]; then
    echo "  PASS $id — exactly the declared cases went red"
    pass=$((pass + 1))
  else
    echo "  FAIL $id — expected exactly:"
    echo "$expected" | sed 's/^/    - /'
    fail=$((fail + 1))
  fi
  restore
}

echo "T-147 negative suite — jobs.ts refusals, each with its mechanism deleted"
echo "HEAD = $(git rev-parse --short HEAD)"

case_run K1 \
  "recipientLocale REQUIRED (SD 1497 'There is no default') — the field is made .optional()" \
  '  recipientLocale: LocaleSchema,' \
  '  recipientLocale: LocaleSchema.optional(),' \
  'a payload with NO recipientLocale is refused, with the issue at that path' \
  'an extension of NotifyJobBase still requires recipientLocale'

case_run K2 \
  "the registry check (SD 1507 LocaleSchema) — the predicate is replaced by one that accepts everything" \
  'z.custom<Locale>(isRegisteredLocale, {' \
  'z.custom<Locale>(() => true, {' \
  'LocaleSchema and assertLocale return the same verdict for every candidate' \
  'recipientLocale null is refused at that path' \
  'recipientLocale the empty string is refused at that path' \
  'every code assertLocale refuses is refused at that path, by the registry' \
  'the refusal names the rule and never echoes the rejected value' \
  'a value whose String() throws is refused cleanly, not by throwing out of safeParse' \
  'an extension of NotifyJobBase still refuses an unregistered recipientLocale'

case_run K3 \
  "the ULID check (SD 1506, T-023's constructor) — the predicate is replaced by one that accepts everything" \
  'z.custom<Ulid>(isUlidValue, { message: ULID_REFUSED })' \
  'z.custom<Ulid>(() => true, { message: ULID_REFUSED })' \
  'a recipientAccountId that is not a ULID is refused at that path' \
  'the ULID schema verdict is the domain-types constructor verdict, value for value' \
  'the ULID refusal never echoes the rejected identifier'

case_run K4 \
  "enqueuedAt is an ISO datetime (SD 1510) — .datetime() is deleted" \
  '  enqueuedAt: z.string().datetime(),' \
  '  enqueuedAt: z.string(),' \
  'enqueuedAt that is not an ISO datetime is refused at that path' \
  'enqueuedAt accepts only a Z-terminated ISO datetime'

case_run K5 \
  "unknown keys are REFUSED, and an extension keeps that (SD 1504) — strictObject becomes object" \
  'export const NotifyJobBase = z.strictObject({' \
  'export const NotifyJobBase = z.object({' \
  'an unknown key is REFUSED, not stripped' \
  'an extension of NotifyJobBase still refuses an unknown key'

case_run K6 \
  "the citation check — a title jobs.ts cites is altered so it names no test" \
  '*enqueuedAt accepts only a Z-terminated ISO datetime*' \
  '*enqueuedAt accepts only an ISO datetime*' \
  'every test jobs.ts cites by title exists in this file, and there are at least six'

# --------------------------------------------------------------------------
# K7 is the COMPILE refusal, so its reading is `pnpm -w typecheck`, not vitest.
# Same mutation as K1: if `recipientLocale` may be omitted, the
# `@ts-expect-error` on the payload that omits it becomes UNUSED, which is
# TS2578 — the directive stops being a refusal and typecheck says so.
# --------------------------------------------------------------------------
echo
echo "=============================================================================="
echo "K7 — the COMPILE refusal: a payload type lacking recipientLocale must not compile"
echo "=============================================================================="
if pnpm -w --silent typecheck >"$TMP/tc-before" 2>&1; then
  node "$MUT" "$JOBS" '  recipientLocale: LocaleSchema,' '  recipientLocale: LocaleSchema.optional(),'
  if assert_mutation_landed '  recipientLocale: LocaleSchema,'; then
    if pnpm -w --silent typecheck >"$TMP/tc-after" 2>&1; then
      echo "  FAIL K7 — typecheck still passed with the field optional"
      fail=$((fail + 1))
    else
      echo "  RED:"
      grep -E 'jobs-refusals\.ts|TS2578' "$TMP/tc-after" | sed 's/^/    /'
      if grep -q 'TS2578' "$TMP/tc-after" && grep -q 'jobs-refusals.ts' "$TMP/tc-after"; then
        echo "  PASS K7 — TS2578 in type-tests/jobs-refusals.ts: the directive is no longer a refusal"
        pass=$((pass + 1))
      else
        echo "  FAIL K7 — typecheck failed, but not with TS2578 in jobs-refusals.ts"
        fail=$((fail + 1))
      fi
    fi
  else
    echo "  FAIL K7"
    fail=$((fail + 1))
  fi
  restore
else
  echo "  HARNESS ERROR: typecheck is not green before the mutation"
  sed -n '1,20p' "$TMP/tc-before"
  fail=$((fail + 1))
fi

echo
echo "=============================================================================="
echo "SUMMARY  $pass passed, $fail failed, of $((pass + fail)) cases"
echo "tree after the suite: $(git status --porcelain -- "$JOBS" | wc -l) modification(s) to $JOBS"
echo "=============================================================================="
[ "$fail" -eq 0 ] || exit 1
