#!/usr/bin/env python3
"""T-232 rework 2: an exhaustive, mechanical list of every place db-introspect.sh READS db/schema.ts or a
generated artefact, or hands an expectation to a judging helper — each classified by rule.

Selection (mechanical, not by reading): a non-comment line is taken if it
  (a) mentions $SCHEMA, `HEAD:`, "$OUT" or $OUT.<suffix> (the generator's output and derived files), or
  (b) calls a judging helper (check, check_facts, part_check, policy_check, write_judge, partlocal_case,
      system_case, shape_case, judge, fact, facts_into, block_count, head_count), or
  (c) continues such a call (the previous taken line ends with a backslash), or
  (d) assigns an expectation variable used by those calls (PART_*, K*_RE, K*_COUNTS, ADMITTED_T, KM_*, K06_*).
Every taken line gets exactly one category from the FIRST rule below that matches; a line no rule
matches is printed UNCLASSIFIED and the script exits 1.
"""
import re
import sys

path = sys.argv[1]
lines = open(path, encoding='utf-8').read().split('\n')

HELPERS = r'(check|check_facts|part_check|policy_check|write_judge|partlocal_case|system_case|shape_case|judge|fact|facts_into|block_count|head_count)'
sel_a = re.compile(r'\$SCHEMA|HEAD:|"\$OUT"|\$OUT\.|\$OUT\b')
sel_b = re.compile(r'^\s*(?:if\s+)?' + HELPERS + r'\b|\$\((block_count|head_count)\b')
sel_d = re.compile(r'^\s*(PART_[A-Z]+|K[0-9]+[A-Z_]*_(RE|COUNTS|RESTORED|WROTE|CAT)|ADMITTED_T|KM_[A-Z_]+|K06_[A-Z_]+)=')

PLANT = r"(t1[3-9][0-9]_|t165\\\\_part|t165\\_part|t1[3-9][0-9][A-Z]|t165Part|t153[A-Z]|t152[A-Z]|qa_secure|\bt138\b|t145_|t165_|PGBOSS_RELS|\$PART_FIXTURE|\$QA_POLICIES|\$SHAPE_POLICIES|\$T153_BITE|pg_boss|pgboss_x|PgBoss|kinvara_guard\"\\\.\"t145|t165_other|t165_sys|t145_t)"

# (category, description, predicate on the stripped line) — first match wins
# Every whole-file SEARCH of db/schema.ts (grep/awk over "$SCHEMA" that is not block_count's own body, a
# HEAD: comparison, or a git diff of the tree) is SCHEMA-WHOLE-FILE and must be justified here, keyed by a
# substring of the line. A whole-file search with no entry makes the script fail: this is the class OD-246
# and QA-F1/QA-R-F1 found, so no rule may classify it implicitly.
WHOLE_FILE_OK = {
    'policy as pg_policy has it': 'policy_check: each searched line is a fixture `-- expect:` line naming its own policy (qa_secure_alpha/zulu, t152_ledger_*, t152_single_both); presence of a plant-named policy',
    'if case "$line" in *t165_part*': 'part_expectations: only lines that contain t165_part/t165Part are searched whole-file; every other line goes to block_count t165Part',
    'grep -q \'pgTable("t138_plant"\'': 'K04 landed-assert: names the plant table t138_plant',
    '! grep -q \'unknown(\' "$SCHEMA"': 'K11w: `unknown(` absent in a file git diff says is the committed file; the generator never writes `unknown(` (T-150), so a committed file holding it fails K00 parity first',
    'named as a relation only schema pgboss has': 'K36 (rework 1/2): the searched names come from psql at the case, pgboss relation names that NO public relation has (NOT IN public), and only rendered relation names are compared; so a committed public relation cannot match, and the expectation 0 encodes nothing about the committed set',
    'block_count t152Child "$line"': 'K22: whole-file only for the three lines that name t152_parent/t152_child objects (the FK `columns:` line is block_count t152Child)',
}
# A LITERAL count in front of one of the generator's count words, in an expectation (not computed by $((...))):
# the shape of every constant OD-246 was about. Overrides any other category unless justified here.
COUNT_WORDS = r"(checked against pg_policy|partition\\?\(s\\?\)|partitioned table|partition declaration|of the catalogue|column\\?\(s\\?\) rewritten|int8 column|point column|policy entr|expression\\?\(s\\?\) drizzle|entr\\?\(ies\\?\) rewritten|relation\\?\(s\\?\) (owned|introspected|in schema))"
COUNT_LITERAL = re.compile(r"(?<![0-9$(+])\b[0-9]+ " + COUNT_WORDS)
COUNT_OK = {
    "out of scope: 0 relation": 'K39a: the pgboss rule deleted (OUT_OF_SCOPE_SCHEMAS emptied), so the generator admits 0; the count is the mutation\'s, not the committed set\'s',
    "VACUOUS: 0 relations introspected": "K07's BOUND branch, taken only when OWNED (psql) is 0",
    'relation "t153_counttext": the catalogue has 1 int8 column': "K61r: a PER-RELATION count in the generator's message for the plant's own relation t153_counttext (1 int8 column, from the plant's SQL); no committed relation is in it",
}
SCHEMA_SEARCH = re.compile(r"\b(grep|awk)\b.*\"\$SCHEMA\"")

RULES = [
    ('SCHEMA-WHOLE-FILE', 'a whole-file search of db/schema.ts, justified line by line in WHOLE_FILE_OK (printed below the table)', lambda l: SCHEMA_SEARCH.search(l) and not l.startswith('awk -v n="export const') and not l.startswith('grep -q "^export const $1 = "') and 'HEAD:' not in l),
    ('DISPLAY', 'printed for the reader only; judges nothing', lambda l: l.startswith("sed 's/^/driver: /'") or re.search(r"\| cut -c1-2[0-9]0 \| sed 's/\^/ +/'|sed 's/\^/   (plant up|first write|mutation|abort cleanup)", l) or re.match(r'^(grep|sed) .*\| sed .s/\^/', l) or l.startswith('sed \'s/^/   plant up:')),
    ('MINUS-HEAD', 'the plant\'s share against the COMMITTED file: lines now minus lines at git show HEAD:, or `git diff --quiet` / `cmp` of a write against the committed file or a second write (plant\'s share = 0); includes write_judge\'s token arguments, which it counts that way', lambda l: re.match(r"^[0-9]+ none '", l) or 'HEAD:' in l or ('git diff --quiet -- "$SCHEMA"' in l and ('v=ok' in l or 'fact ' in l or l.strip() == 'git diff --quiet -- "$SCHEMA"')) or l.startswith('cmp -s "$SCHEMA"')),
    ('HARNESS', 'the run\'s own plumbing: write/restore/abort paths, migrate record, trap, plant/mutation landed-asserts', lambda l: re.search(r'^(mutate |PART_N=|PART_MARK=|PART_FIXTURE=|QA_POLICIES=|SHAPE_POLICIES=|node scripts/db-(migrate|introspect)\.ts|trap |git checkout|rm -f|cp "\$SCHEMA"|printf .%s\\n. "\$1" >>|: >"\$OUT\.f"|cat "\$OUT\.f" >>|\{ node scripts/db-migrate|node --input-type=module)', l) or re.search(r'\|\| \{ cat "\$OUT\.|\|\| cat "\$OUT\.|abort "', l) and not re.search(HELPERS + r' ', l.split('||')[0]) or re.search(r'git diff (--quiet|-U0|--numstat) -- "\$SCHEMA"', l) and 'fact ' not in l),
    ('VERDICT', 'the generator\'s verdict for THIS run: exit, banner count, exact tag set, `ALL n … HOLD`, printed `byte-identical`, `MIGRATE OK up: $HIGHEST -> $NEXT`', lambda l: re.search(r"'\^ALL [A-Z0-9 \[\]+-]+ (HOLD|ORDER|EXPECTED)\$'|banners=|got=\$\(grep -oE|w_tags=|tags=\$\(grep -oE|w_banners=|GATE PASS  db:introspect|GATE CRASH  db:introspect|GATE FAIL  db:introspect|\^ALL \[0-9\]\+|echo \"ALL |byte-identical to a fresh introspection|MIGRATE OK  up: \$HIGHEST -> \$NEXT|grep -qE -- \"\$require\"|grep -qE -- \"\$\{re#!\}\"|grep -qE -- \"\$re\"|\bjudge \"\$id\"|\bjudge \"\$\{id\}m\"|p1=\$\(grep -c 'pruned with typescript'|pruned with typescript|echo \"fact (ok|MISMATCH)", l)),
    ('BLOCK', 'counted inside the plant\'s own `export const` declaration (block_count)', lambda l: 'block_count' in l and 'grep -qF -- "$line" "$SCHEMA"' not in l or l.startswith('awk -v n="export const') or l.startswith('grep -q "^export const $1 = "')),
    ('PLANT-READ', 'the output of a probe that queries only the plant\'s own tables through pg/drizzle ($OUT.rt), or that probe\'s exit', lambda l: '"$OUT.rt"' in l or re.search(r'^fact "(after ANALYZE .*exit|write mode, pgboss set planted: exit|write with [^"]*: exit)" "\$(\?|wcode)" 0', l)),
    ('BOUND-TSC', 'the whole root program\'s TypeScript errors compared with the expected set at the bite file: BOUND, assumes the rest of the program typechecks (gate:pr enforces it)', lambda l: '$OUT.tsc' in l),
    ('PSQL/BASE', 'expectation derived from the catalogue by psql (BASE_*, OWNED, ADMITTED_BASE, pgboss_only, owned_in_public) or from the generator\'s committed-tree reading held against psql', lambda l: re.search(r'\$\(\(BASE_|\$BASE_|BASE_[A-Z_]+ \+|\$OWNED|OWNED \+|\$ADMITTED_BASE|ADMITTED_BASE \+|pgboss_only|owned_in_public|\$K06_PART_RE|\$KM_VACUOUS_RE|\$KM_EXPECT|^KM_EXPECT=|\$K162_RE|\$K26_COUNTS|\$K27_RESTORED|\$PART_(RENDERED|COUNTS|INTRO)|cat_admitted|gen_(admitted|owned|intro)|want_admitted|b_line|GEN_[A-Z]', l)),
    ('PLANT-LITERAL', 'a literal that names a plant object (t1NN_*, the fixtures\' qa_secure_*): no committed relation can produce it', lambda l: re.search(PLANT, l)),
    ('COMMITTED-OBJECT', 'names a COMMITTED object (app_session.token_hash, account_role(_pkey), job_common, a `(table) => [` callback): bound, contract ¶4 — only a contract migration that drops/renames it breaks the case', lambda l: re.search(r'token_hash|account_role|accountRole|job_common|\(table\) => \[|TS6133|\}, \(\) => \[', l)),
    ('GENERIC-REFUSAL', 'a refusal message required in $OUT of one run. The committed tree passes the check (the BASE run aborts otherwise), so with no mutation only the plant can cause it; under a mutation the committed set can add instances of the same message but not remove the plant\'s, and the tag set is exact', lambda l: re.search(r"differs from a fresh introspection|does not have the parent|is itself partitioned|is not in schema public|has no partition, so|has an identity column|is not named as|has database type '(tsvector|citext)|cannot read (row-level security|column types|the partitioned)|canonical order: 0 declaration|is not a kind this step orders|rendering line \[0-9\]\+ still carries|this step does not know|cannot be written inside sql|VACUOUS: 0 relations introspected|I-VACUOUS\]? drizzle-kit wrote|MIGRATE OK  up:|'!\\\[I-SCOPE\\\]'|'\^  out of scope: 0 relation", l)),
    ('ARG', 'a positional argument of partlocal_case/system_case/shape_case/check_facts: an empty extra-SQL slot, or the expected value of the plant-landed psql read on the line above (which names the plant\'s object)', lambda l: re.fullmatch(r'("[0-9]*"|\'\'|""|"\$[a-z]+"|[0-9]+ (none|I-[A-Z]+) [\w\']+( no-[a-z-]+)?)\s*\\?', l)),
    ('PLANT-CASE', 'a case whose plant (schema or table name) and every expectation inside its helper are plant-named or BASE-derived (the helper body is classified separately)', lambda l: re.match(r'^(system_case|shape_case) K', l)),
    ('HELPER-DEF', 'a helper\'s definition or its internal loop (the expectation is its caller\'s, classified at the call)', lambda l: re.fullmatch(r'("\$[a-z]+"|\$\?|"\$\?"|I-[A-Z]+|\s)+', l) or re.match(r'^(judge "\$(id|\{id\}m)"|facts_into "\$@")', l) or re.search(r'^(block_count|head_count|facts_into|check_facts|check|judge|part_check|policy_check|write_judge|partlocal_case|system_case|shape_case|fact)\(\) \{|^local |^if \[ "\$1" = -x|while IFS= read|done < <\(sed|^\s*if case "\$line"|^for re in|elif grep|^n=\$\(\(\$\(grep -c -- "\$absent"|grep -qF -- "\$line" "\$SCHEMA"|grep -oE .\^\[\^\(: \]|miss=\$\(\(miss|if \[ "\$miss" -eq 0 \] && grep -qE -- "\^  policies', l)),
]

taken = []
prev_cont = False
for i, raw in enumerate(lines, 1):
    l = raw.strip()
    if l.startswith('#') or l == '':
        prev_cont = False
        continue
    if sel_a.search(l) or sel_b.search(l) or sel_d.search(l) or prev_cont:
        taken.append((i, l))
        prev_cont = l.endswith('\\')
    else:
        prev_cont = False

CALL = re.compile(r'^(check|check_facts|part_check|policy_check|write_judge|partlocal_case|judge) +(\S+) +"(?:[^"\\]|\\.)*"(.*)$')
TAGS = re.compile(r'^\s*(PASS|CRASH|I-[A-Z]+( I-[A-Z]+)*|"I-[A-Z]+( I-[A-Z]+)*"|"\$[a-z]+"|\$\?|"\$\?"|"\$code"|\\)*\s*(\\)?$')
out = []
unclassified = 0
for i, l in taken:
    cat = None
    m = CALL.match(l)
    probe = l
    if m:
        rest = m.group(3).strip()
        # the expectation is everything after the description: exact tags only -> VERDICT
        if rest == '' or re.fullmatch(r'((PASS|CRASH|I-[A-Z]+|"I-[A-Z]+( I-[A-Z]+)*"|"\$[A-Za-z_{}]+"|\$\?|[0-9]+|none|"\$code")\s*)*\\?', rest):
            cat = 'VERDICT'
        else:
            probe = rest
    extra = []
    if cat is None:
      hits = [name for name, _, pred in RULES if pred(probe)]
      if hits:
        cat = hits[0]
        extra = [h for h in hits[1:] if h not in ('DISPLAY', 'HARNESS', 'HELPER-DEF', 'ARG')]
    scan = re.sub(r'^fact "(?:[^"\\]|\\.)*"', 'fact <description>', l)  # a fact's description is prose, not an expectation
    lit = [m for m in COUNT_LITERAL.finditer(scan) if not re.search(r'\$\(\([^)]*$', scan[:m.start()])]
    if lit and not any(k in l for k in COUNT_OK) and not l.startswith('echo ') and not l.startswith('printf ') and cat not in ('DISPLAY', 'HARNESS', 'HELPER-DEF'):
        cat = 'COUNT-LITERAL-UNJUSTIFIED'
        unclassified += 1
    if cat == 'SCHEMA-WHOLE-FILE':
        just = [v for k, v in WHOLE_FILE_OK.items() if k in l]
        if len(just) != 1:
            cat = 'SCHEMA-WHOLE-FILE-UNJUSTIFIED'
            unclassified += 1
    if cat and extra:
        cat = cat + ' (+' + ', '.join(extra) + ')'
    if cat is None:
        cat = 'UNCLASSIFIED'
        unclassified += 1
    out.append((i, cat, l))

counts = {}
for _, c, _ in out:
    counts[c] = counts.get(c, 0) + 1
print(f'{len(out)} line(s) taken from {path}; ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
for name, desc, _ in RULES:
    print(f'  {name}: {desc}')
print()
print('Whole-file searches of db/schema.ts, and why each is not an encoding of the committed set:')
for k, v in WHOLE_FILE_OK.items():
    print(f'  - `{k}`: {v}')
print()
print('| line | category | text (first 150 chars) |')
print('|---|---|---|')
for i, c, l in out:
    t = l[:150].replace('|', '\\|').replace('`', "'")
    print(f'| {i} | {c} | `{t}` |')
sys.exit(1 if unclassified else 0)
