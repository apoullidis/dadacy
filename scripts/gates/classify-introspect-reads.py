#!/usr/bin/env python3
"""db-introspect.sh's read-classifier: an exhaustive, mechanical list of every place the suite READS
db/schema.ts or a generated artefact, or hands an expectation to a judging helper, each classified by
rule. Written for T-232 rework 2 (OD-246, QA-F1, QA-R-F1); committed and tightened by T-234 (QA-S-F1,
NS1); run on every `gate:negative-suites` by the suite's roster entry in scripts/gates/negative-suites.ts.

    python3 scripts/gates/classify-introspect-reads.py scripts/negative-tests/db-introspect.sh

Exit 0: every taken line is classified, and every whole-file read of db/schema.ts is justified.
Exit 1: at least one row is FLAGGED (its category ends in -UNJUSTIFIED or -UNSUBTRACTED, or is
UNCLASSIFIED), or a WHOLE_FILE_OK / EXACT_LINES entry no longer matches the lines it was written for.
Exit 2: usage.

WHAT IT IS MEASURED TO CATCH is exactly scripts/gates/classify-introspect-reads.fixture: every line marked
`# attack:` there is flagged and every `# control:` line is not, and gate:negative-suites checks that on
every run. That is QA-S1's four shapes (T-232), T-234's fifteen, and QA's 52 attack shapes (T-234 § QA-1,
R01-R52 except R42, which is a control). Nothing wider is claimed; the bounds are listed at the end.

SELECTION (mechanical, not by reading). A non-comment line is taken if it
  (a) mentions db/schema.ts in a spelling this reader recognises ($SCHEMA, any ${SCHEMA...} expansion,
      the literal path, a glob under db/), `HEAD:`, `git show`/`git cat-file`, "$OUT" or $OUT.<suffix>
      (the generator's output and derived files), or
  (b) calls a judging helper (check, check_facts, part_check, policy_check, write_judge, partlocal_case,
      system_case, shape_case, judge, fact, facts_into, block_count, head_count), or
  (c) continues such a call (the previous taken line ends with a backslash), or
  (d) assigns an expectation variable used by those calls (PART_*, K*_RE, K*_COUNTS, ADMITTED_T, KM_*, K06_*).

THE RULES:
  1. A READ of db/schema.ts. Every recognised spelling is rewritten to one token, and each occurrence is
     judged by its position:
       - inside a quoted argument of echo, printf, abort or a judging helper (PROSE_CMDS): prose, because
         those commands print it, or look for it as a regex in $OUT;
       - in one of the closed HARNESS_CTX contexts (restore, git diff, cmp/cp with $OUT.s1, rm, >>,
         mutate, the definition): harness;
       - after `git show <rev>:` / `git cat-file`: a read of the COMMITTED file (rule 3);
       - on a line whose whole text is an EXACT_LINES entry, inside its scope function, within its
         count (rule 4);
       - ANYWHERE ELSE, quoted or not ("./$SCHEMA", "$PWD/db/schema.ts", node -e '...db/schema.ts...',
         an assignment's value, a function argument, cat |, <, a glob such as db/sch*.ts): a whole-file
         read, which needs a counted WHOLE_FILE_OK entry or the run exits 1.
     T-232's rule needed `grep|awk ... "$SCHEMA"` in that order (QA-S1 A1-A3). T-234's first version
     treated every double-quoted word as prose (QA-F1 R47/R51).
  2. The content rules that let a line PASS (PLANT-LITERAL, COMMITTED-OBJECT, GENERIC-REFUSAL,
     PSQL/BASE, BLOCK) never read a helper's description argument, only the code after it (QA-S1 A1-A3).
  3. A read of the COMMITTED file is MINUS-HEAD only as the right operand of a subtraction inside
     $(( ... )) whose left operand is the SAME command over the working file. Otherwise it is
     HEAD-UNSUBTRACTED (QA-S1 A6).
  4. Exemptions are SCOPED and COUNTED, never granted by text alone:
       - WHOLE_FILE_OK keys and EXACT_LINES texts each match exactly their count of lines, and an
         EXACT_LINES text holds only inside its scope function (block_count's body, head_count, rehash's
         node body). A copy borrows nothing (QA-F1 R34/R35/R37);
       - HELPER-DEF's loop and `local` shapes hold only inside a HELPER_FUNCS body (QA-F1 R26/R33);
       - an abort makes a line HARNESS only in the closed HARNESS_ABORT shapes (QA-F1 R41/R48);
       - block_count's block name must be plant-named or one of BLOCK_VARS (QA-F1 R36).

BOUNDS (not claimed):
  - Spellings it does not recognise as the file: a path assembled from pieces ($'db/sch\x65ma.ts', a
    backslash continuation, `cd db && ... schema.ts`, `grep -r ... db --include=...`, `git grep ...
    'db/*.ts'`), an alias through another name (QF=..., declare -n, ${!v}, a copy such as $OUT.s1), and a
    read assembled at run time (eval, a command held in a variable). The line holding such a read is not
    flagged. Each such shape in the fixture is caught only because the line that JUDGES its result
    matches no rule (UNCLASSIFIED). A future line that judges such a result in a shape some rule does
    classify would pass.
  - A quoted argument of a PROSE_CMDS command is prose even if it spells the file: a helper or abort
    handed the path in quotes is not treated as reading it (none of them reads its arguments as files).
  - A BLOCK_VARS name (`"$b"`, `"${spec%%|*}"`) rebound to a committed declaration is filed BLOCK.
  - It reads one physical line at a time.
  - A regex over $OUT that contains a plant name is filed PLANT-LITERAL (T-232 § Rework 2's residual
    route for regexes over generator output).
"""
import re
import sys

if len(sys.argv) != 2:
    print('usage: classify-introspect-reads.py <suite.sh>', file=sys.stderr)
    sys.exit(2)
path = sys.argv[1]
lines = open(path, encoding='utf-8').read().split('\n')

HELPERS = r'(check|check_facts|part_check|policy_check|write_judge|partlocal_case|system_case|shape_case|judge|fact|facts_into|block_count|head_count)'
# Every spelling of the file this reader recognises: $SCHEMA, any ${SCHEMA...} expansion (${SCHEMA:-},
# ${SCHEMA%.ts}...), the literal path with or without ./, and any GLOB under db/ (db/sch*.ts, db/*.ts,
# db/schema.t[s]), which can name the file.
SCHEMA_ANY = r'(?:\$\{SCHEMA(?:[^A-Za-z0-9_}][^}]*)?\}|\$SCHEMA(?![A-Za-z0-9_])|(?:\./)?db/schema\.ts\b|(?:\./)?db/[A-Za-z0-9_.-]*[*?\[][A-Za-z0-9_.*?\[\]-]*)'
sel_a = re.compile(SCHEMA_ANY + r'|HEAD:|git (?:show|cat-file)|"\$OUT"|\$OUT\.|\$OUT\b')
sel_b = re.compile(r'^\s*(?:if\s+)?' + HELPERS + r'\b|\$\((block_count|head_count)\b')
sel_d = re.compile(r'^\s*(PART_[A-Z]+|K[0-9]+[A-Z_]*_(RE|COUNTS|RESTORED|WROTE|CAT)|ADMITTED_T|KM_[A-Z_]+|K06_[A-Z_]+)=')

PLANT = r"(t1[3-9][0-9]_|t165\\\\_part|t165\\_part|t1[3-9][0-9][A-Z]|t165Part|t153[A-Z]|t152[A-Z]|qa_secure|\bt138\b|t145_|t165_|PGBOSS_RELS|\$PART_FIXTURE|\$QA_POLICIES|\$SHAPE_POLICIES|\$T153_BITE|pg_boss|pgboss_x|PgBoss|kinvara_guard\"\\\.\"t145|t165_other|t165_sys|t145_t)"

# --------------------------------------------------------------------------- the views of a line
TOK = '@SCHEMA@'
DESC = re.compile(r'^((?:if\s+)?fact) "(?:[^"\\]|\\.)*"|^((?:if\s+)?(?:check|check_facts|part_check|policy_check|write_judge|partlocal_case|system_case|shape_case|judge) +\S+) "(?:[^"\\]|\\.)*"')


def strip_desc(l):
    """A helper's description argument is prose, never an expectation: replaced before any content rule."""
    return DESC.sub(lambda m: (m.group(1) or m.group(2)) + ' "<description>"', l, count=1)


def normalise(l):
    """Every spelling of db/schema.ts becomes one token, quotes included when the quoted word is only it."""
    s = re.sub(r'"\$\{SCHEMA\}"|"\$SCHEMA"|"(?:\./)?db/schema\.ts"|\'(?:\./)?db/schema\.ts\'', TOK, l)
    return re.sub(SCHEMA_ANY, TOK, s)


# Commands whose quoted arguments are PROSE (a message, a printf format, a helper's description or a
# regex the helper looks for in $OUT): a spelling of the file inside one of their quoted arguments names
# the file, it does not read it. A quoted word owned by ANY other command (grep, cat, awk, node, sh, an
# assignment, a function call...) is an operand, and the file in it is read (T-234 rework 1, QA-F1 R47).
PROSE_CMDS = {'echo', 'printf', 'abort', 'fact', 'check', 'check_facts', 'part_check', 'policy_check',
              'write_judge', 'partlocal_case', 'system_case', 'shape_case', 'judge'}
KEYWORDS = {'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'fi', 'done'}


def contexts(s):
    """For each TOK occurrence in s: (position, innermost context, owning command). The context is 'top',
    'cs' ($( )), 'paren', 'dq' or 'sq'; the owning command is the first word of the simple command the
    occurrence (or the quoted word holding it) belongs to, None for an assignment's value or unknown."""
    out, i = [], 0
    stack = [{'k': 'top', 'cmd': None, 'want': True}]

    def cmdframe():
        for f in reversed(stack):
            if f['k'] in ('top', 'cs', 'paren'):
                return f
        return stack[0]

    while i < len(s):
        f = stack[-1]
        k = f['k']
        if s.startswith(TOK, i):
            cf = cmdframe()
            owner = f.get('owner') if k in ('dq', 'sq') else cf['cmd']
            out.append((i, k, owner))
            if k not in ('dq', 'sq') and cf['want']:
                cf['cmd'], cf['want'] = '<schema>', False
            i += len(TOK)
            continue
        c = s[i]
        if k == 'sq':
            if c == "'":
                stack.pop()
            i += 1
            continue
        if k == 'dq':
            if c == '\\':
                i += 2
                continue
            if c == '"':
                stack.pop()
            elif s.startswith('$(', i):
                stack.append({'k': 'cs', 'cmd': None, 'want': True})
                i += 2
                continue
            i += 1
            continue
        # a command frame
        if c in ' \t':
            i += 1
            continue
        if c in ';|&\n':
            f['cmd'], f['want'] = None, True
            i += 1
            continue
        if c == '\\':
            i += 2
            continue
        if c == "'":
            if f['want']:
                f['cmd'], f['want'] = '?', False
            stack.append({'k': 'sq', 'owner': f['cmd']})
            i += 1
            continue
        if c == '"':
            if f['want']:
                f['cmd'], f['want'] = '?', False
            stack.append({'k': 'dq', 'owner': f['cmd']})
            i += 1
            continue
        if s.startswith('$(', i):
            if f['want']:
                f['cmd'], f['want'] = '?', False
            stack.append({'k': 'cs', 'cmd': None, 'want': True})
            i += 2
            continue
        if c == '(':
            stack.append({'k': 'paren', 'cmd': None, 'want': True})
            i += 1
            continue
        if c == ')':
            if len(stack) > 1:
                stack.pop()
            i += 1
            continue
        m = re.match(r'[^\s;|&()\'"$]+', s[i:])
        if m is None:  # a lone $ (a $VAR or ${...}): part of a word
            if f['want']:
                f['cmd'], f['want'] = '?', False
            i += 1
            continue
        w = m.group(0)
        if f['want']:
            if w in KEYWORDS or w == '[[':
                pass
            elif re.match(r'^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=', w):
                pass  # an assignment prefix: the command word, if any, comes after it
            else:
                f['cmd'], f['want'] = w, False
        i += len(w)
    return out


# Harness contexts: the file is restored, compared with the committed file or a second write, written,
# mutated, deleted, or defined. Each is a fixed text around the token; nothing here SEARCHES the file.
HARNESS_CTX = [
    r'git checkout -q -- ' + TOK,
    r'git diff (?:--quiet|-U0|--numstat) -- ' + TOK,
    r'cmp -s ' + TOK + r' "\$OUT\.s1"',
    r'cp ' + TOK + r' "\$OUT\.s1"',
    r'rm -f ' + TOK,
    r'\[ ! -e ' + TOK + r' \]',
    r'>>' + TOK,
    r'^mutate ' + TOK + ' ',
    r'^SCHEMA=' + TOK + '$',
]
# EXACT LINES: exemptions by the line's whole normalised text. Each holds for exactly COUNT lines and,
# where SCOPE names a function, only inside that function's body: a copy elsewhere, or one copy too many,
# borrows nothing and is flagged EXEMPT-LINE-UNJUSTIFIED (T-234 rework 1, QA-F1 R34/R35).
# text -> (count, scope function or None, category, why)
EXACT_LINES = {
    'grep -q "^export const $1 = " ' + TOK + ' || { echo -1; return; }':
        (1, 'block_count', 'BLOCK', "block_count's presence test: is there a declaration named $1 (its caller passes a plant name or a BLOCK_VARS variable)"),
    'awk -v n="export const $1 = " \'index($0, "export const ") == 1 { p = (index($0, n) == 1) } p\' ' + TOK + ' | grep -c${x}F -- "$2"':
        (1, 'block_count', 'BLOCK', "block_count's count, scoped to the one `export const $1` declaration"),
    'head_count() { git show HEAD:' + TOK + ' | grep -cF -- "$1"; }':
        (1, 'head_count', 'HELPER-DEF', 'head_count: a read of the COMMITTED file; every call must be subtracted (rule 3)'),
    'const lines = fs.readFileSync(' + TOK + ', "utf8").split("\\n");':
        (1, 'rehash', 'HARNESS', 'rehash(): the tamper helper reads the body to re-render its header; nothing is judged from it'),
    'fs.writeFileSync(' + TOK + ', renderSchemaFile(lines.slice(3).join("\\n"), version));':
        (1, 'rehash', 'HARNESS', 'rehash(): writes the re-rendered file (the tamper itself)'),
    'if (!verifySchemaFile(fs.readFileSync(' + TOK + ', "utf8")).ok) process.exit(3);':
        (1, 'rehash', 'HARNESS', 'rehash(): asserts its own write verifies; the exit is an abort, never a case verdict'),
    'T153_BITE_TEXT="import type { t153Money } from \'../../.' + TOK + '\';':
        (1, None, 'BOUND-TSC', "the bite file's source text: a type-only import of the plant declaration t153Money, read by tsc (BOUND-TSC)"),
}
# The variables block_count may take as its block name: each is bound by a loop over plant names in the
# suite (K59's spec list, K60's block list). Any other variable is BLOCK-UNJUSTIFIED (QA-F1 R36).
BLOCK_VARS = {'"${spec%%|*}"', '"$b"'}


def block_ok(a):
    return bool(re.match(PLANT, a)) or a in BLOCK_VARS


# Judging helpers whose internal loop lines HELPER-DEF may classify, and only inside their own bodies.
HELPER_FUNCS = {'judge', 'facts_into', 'check', 'check_facts', 'policy_check', 'part_expectations', 'part_check',
                'fact', 'shape_case', 'system_case', 'write_judge', 'partlocal_case', 'block_count', 'head_count'}
# The only lines an `abort` makes HARNESS (T-234 rework 1, QA-F1 R41/R48): a bare abort, or a generator /
# migrator run or a landed-assert over $OUT that aborts with that output printed.
HARNESS_ABORT = re.compile(r'abort "[^"]*"|(?:node scripts/db-(?:migrate|introspect)\.ts [^|;&]*|\{ node scripts/db-migrate\.ts .*; \}|grep -q \'[^\']*\' "\$OUT\.[a-z0-9]+") \|\| \{ cat "\$OUT\.[a-z0-9]+"; abort "[^"]*"; \}')
CUR_FN = None
# A driver probe importing ONLY plant declarations (t153Money, t153Geo, ...) from db/schema.ts: its
# assertions are on $OUT.rt (PLANT-READ). An import naming any other export is a whole-file read.
PLANT_IMPORT = re.compile(r'import \{([^}]*)\} from ' + re.escape(TOK) + ';')
COMMITTED_READ = re.compile(r'git (?:show|cat-file(?: -p| blob)?) +\S*:' + re.escape(TOK) + r'|\$\(head_count\b')
# The plant's share: $(( $(CMD <schema>) - $(git show HEAD:<schema> | CMD) )), the same CMD both sides,
# or $(( $(grep -cF -- ARG <schema>) - $(head_count ARG) )).
SUBTRACTED = [
    re.compile(r'\$\(\(\s*\$\((?P<a>(?:grep|awk) .*?) ' + re.escape(TOK) + r'\)\s*-\s*\$\(git show HEAD:' + re.escape(TOK) + r' \| (?P<b>(?:grep|awk) .*?)\)\s*\)\)'),
    re.compile(r'\$\(\(\s*\$\(grep -cF -- (?P<a>"\$\w+"|\'[^\']*\') ' + re.escape(TOK) + r'\)\s*-\s*\$\(head_count (?P<b>"\$\w+"|\'[^\']*\')\)\s*\)\)'),
]


def schema_reads(norm):
    """(whole-file read occurrences, committed-read verdict) for one normalised, description-stripped line."""
    if norm.strip() in EXACT_LINES:
        return [], None  # validated (count, scope) in the main loop
    imp = PLANT_IMPORT.fullmatch(norm.strip())
    if imp and all(re.fullmatch(PLANT + r'\w*', n.strip()) for n in imp.group(1).split(',')):
        return [], None
    covered = set()
    for pat in HARNESS_CTX:
        for m in re.finditer(pat, norm):
            covered.add(m.start() + m.group(0).index(TOK)) if TOK in m.group(0) else None
    head = None
    if COMMITTED_READ.search(norm):
        head = 'UNSUBTRACTED'
        for rx in SUBTRACTED:
            for m in rx.finditer(norm):
                if m.group('a') == m.group('b'):
                    head = 'SUBTRACTED'
                    # both sides are the plant's share, not a whole-file expectation
                    for j in range(m.start(), m.end()):
                        if norm.startswith(TOK, j):
                            covered.add(j)
        if head == 'UNSUBTRACTED':
            for m in re.finditer(r'\S*:' + re.escape(TOK), norm):
                covered.add(m.end() - len(TOK))
    reads = []
    for pos, ctx, owner in contexts(norm):
        if pos in covered:
            continue
        if ctx in ('dq', 'sq') and owner in PROSE_CMDS:
            # a quoted argument of echo/printf/abort or of a judging helper: a message, a format, or a
            # regex over $OUT. Quoted anywhere else ("./$SCHEMA", "$PWD/db/schema.ts", node -e '...'),
            # it is an operand: a read.
            continue
        reads.append(pos)
    return reads, head


# Every whole-file read of db/schema.ts must be justified here: key -> (number of taken lines the key
# must match, why). Keys are matched against the NORMALISED line with descriptions stripped, so a
# description cannot borrow a justification; a key that matches a different number of lines than it
# was written for flags every line it matches, and a key matching none is STALE (exit 1).
WHOLE_FILE_OK = {
    'grep -qF -- "$line" ' + TOK + '; then echo "policy as pg_policy has it: $line"': (1, 'policy_check: each searched line is a fixture `-- expect:` line naming its own policy (qa_secure_alpha/zulu, t152_ledger_*, t152_single_both); presence of a plant-named policy'),
    'if case "$line" in *t165_part* | *t165Part*) grep -qF -- "$line" ' + TOK + ' ;;': (2, 'part_expectations (K150 and its absent-line twin): only lines that contain t165_part/t165Part are searched whole-file; every other line goes to block_count t165Part'),
    'grep -q \'pgTable("t138_plant"\' ' + TOK + ' || abort': (1, 'K04 landed-assert: names the plant table t138_plant'),
    '! grep -q \'unknown(\' ' + TOK: (1, 'K11w: `unknown(` absent in a file git diff says is the committed file; the generator never writes `unknown(` (T-150), so a committed file holding it fails K00 parity first. The one whole-file search for a literal that names no plant object'),
    '"$(grep -oE \'= pg(Table|View|MaterializedView)\\("[^"]+"\' ' + TOK + ' | sed -E': (1, 'K36 (rework 1/2): the searched names come from psql at the case, pgboss relation names that NO public relation has (NOT IN public), and only rendered relation names are compared; so a committed public relation cannot match, and the expectation 0 encodes nothing about the committed set'),
    '&& grep -qF -- "$line" ' + TOK + '; }; then echo "key order as the catalogue: $line"': (1, 'K22: whole-file only for the three lines that name t152_parent/t152_child objects (the FK `columns:` line is block_count t152Child)'),
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

# (category, description, predicate(code, full)) — first match wins. `code` is the line with any helper
# description replaced by "<description>"; `full` is the raw line. Only DISPLAY, HARNESS, VERDICT and
# PLANT-READ look at `full` (they decide nothing about db/schema.ts's content).
RULES = [
    ('DISPLAY', 'printed for the reader only; judges nothing', lambda c, l: l.startswith("sed 's/^/driver: /'") or re.search(r"\| cut -c1-2[0-9]0 \| sed 's/\^/ +/'|sed 's/\^/   (plant up|first write|mutation|abort cleanup)", l) or re.match(r'^(grep|sed) .*\| sed .s/\^/', l) or l.startswith('sed \'s/^/   plant up:') or re.match(r"^printf '%-4s %s  %s\\n", l) or re.match(r'^echo "== [^"$`]*"$', l)),
    ('MINUS-HEAD', 'the plant\'s share against the COMMITTED file: $(( $(CMD file) - $(git show HEAD:file | CMD) )) with the same CMD (rule 3), or `git diff --quiet` / `cmp` of a write against the committed file or a second write (plant\'s share = 0); includes write_judge\'s token arguments, which it counts that way', lambda c, l: re.match(r"^[0-9]+ none '", c) or schema_reads(normalise(c))[1] == 'SUBTRACTED' or ('git diff --quiet -- "$SCHEMA"' in c and ('v=ok' in c or 'fact ' in c or c.strip() == 'git diff --quiet -- "$SCHEMA"')) or c.startswith('cmp -s "$SCHEMA"')),
    ('HARNESS', 'the run\'s own plumbing: write/restore/abort paths, migrate record, trap, plant/mutation landed-asserts, rehash()\'s node body (EXACT_LINES); an abort only in the closed HARNESS_ABORT shapes', lambda c, l: re.search(r'^(mutate |PART_N=|PART_MARK=|PART_FIXTURE=|QA_POLICIES=|SHAPE_POLICIES=|SCHEMA=db/schema\.ts$|node scripts/db-(migrate|introspect)\.ts|trap |git checkout|rm -f|\[ ! -e "\$SCHEMA" \]|cp "\$SCHEMA"|printf .%s\\n. "\$1" >>|: >"\$OUT\.f"|cat "\$OUT\.f" >>|\{ node scripts/db-migrate|node --input-type=module)', l) or HARNESS_ABORT.fullmatch(l) or re.search(r'git diff (--quiet|-U0|--numstat) -- "\$SCHEMA"', l) and 'fact ' not in l),
    ('VERDICT', 'the generator\'s verdict for THIS run: exit, banner count, exact tag set, `ALL n … HOLD`, printed `byte-identical`, `MIGRATE OK up: $HIGHEST -> $NEXT`', lambda c, l: re.search(r"'\^ALL [A-Z0-9 \[\]+-]+ (HOLD|ORDER|EXPECTED)\$'|banners=|got=\$\(grep -oE|w_tags=|tags=\$\(grep -oE|w_banners=|GATE PASS  db:introspect|GATE CRASH  db:introspect|GATE FAIL  db:introspect|\^ALL \[0-9\]\+|echo \"ALL |byte-identical to a fresh introspection|MIGRATE OK  up: \$HIGHEST -> \$NEXT|grep -qE -- \"\$require\"|grep -qE -- \"\$\{re#!\}\"|grep -qE -- \"\$re\"|\bjudge \"\$id\"|\bjudge \"\$\{id\}m\"|p1=\$\(grep -c 'pruned with typescript'|pruned with typescript|echo \"fact (ok|MISMATCH)", c)),
    ('BLOCK', 'counted inside the plant\'s own `export const` declaration (block_count over a plant-named block or a BLOCK_VARS variable)', lambda c, l: 'block_count' in c and 'grep -qF -- "$line" "$SCHEMA"' not in c and all(block_ok(a) for a in re.findall(r'block_count (?:-x )?(\S+)', c))),
    ('PLANT-READ', 'the output of a probe that queries only the plant\'s own tables through pg/drizzle ($OUT.rt), that probe\'s exit, or its import of plant declarations only from db/schema.ts', lambda c, l: '"$OUT.rt"' in c or PLANT_IMPORT.fullmatch(normalise(c).strip()) or re.search(r'^fact "(after ANALYZE .*exit|write mode, pgboss set planted: exit|write with [^"]*: exit)" "\$(\?|wcode)" 0', l)),
    ('BOUND-TSC', 'the whole root program\'s TypeScript errors compared with the expected set at the bite file: BOUND, assumes the rest of the program typechecks (gate:pr enforces it)', lambda c, l: '$OUT.tsc' in c),
    ('PSQL/BASE', 'expectation derived from the catalogue by psql (BASE_*, OWNED, ADMITTED_BASE, pgboss_only, owned_in_public) or from the generator\'s committed-tree reading held against psql', lambda c, l: re.search(r'\$\(\(BASE_|\$BASE_|BASE_[A-Z_]+ \+|\$OWNED|OWNED \+|\$ADMITTED_BASE|ADMITTED_BASE \+|pgboss_only|owned_in_public|\$K06_PART_RE|\$KM_VACUOUS_RE|\$KM_EXPECT|^KM_EXPECT=|\$K162_RE|\$K26_COUNTS|\$K27_RESTORED|\$PART_(RENDERED|COUNTS|INTRO)|cat_admitted|gen_(admitted|owned|intro)|want_admitted|b_line|GEN_[A-Z]', c)),
    ('PLANT-LITERAL', 'a literal that names a plant object (t1NN_*, the fixtures\' qa_secure_*), in the code, never in a description: no committed relation can produce it', lambda c, l: re.search(PLANT, c)),
    ('COMMITTED-OBJECT', 'names a COMMITTED object (app_session.token_hash, account_role(_pkey), job_common, a `(table) => [` callback): bound, contract ¶4 — only a contract migration that drops/renames it breaks the case', lambda c, l: re.search(r'token_hash|account_role|accountRole|job_common|\(table\) => \[|TS6133|\}, \(\) => \[', c)),
    ('GENERIC-REFUSAL', 'a refusal message required in $OUT of one run. The committed tree passes the check (the BASE run aborts otherwise), so with no mutation only the plant can cause it; under a mutation the committed set can add instances of the same message but not remove the plant\'s, and the tag set is exact', lambda c, l: re.search(r"differs from a fresh introspection|does not have the parent|is itself partitioned|is not in schema public|has no partition, so|has an identity column|is not named as|has database type '(tsvector|citext)|cannot read (row-level security|column types|the partitioned)|canonical order: 0 declaration|is not a kind this step orders|rendering line \[0-9\]\+ still carries|this step does not know|cannot be written inside sql|VACUOUS: 0 relations introspected|I-VACUOUS\]? drizzle-kit wrote|MIGRATE OK  up:|'!\\\[I-SCOPE\\\]'|'\^  out of scope: 0 relation", c)),
    ('ARG', 'a positional argument of partlocal_case/system_case/shape_case/check_facts: an empty extra-SQL slot, or the expected value of the plant-landed psql read on the line above (which names the plant\'s object)', lambda c, l: re.fullmatch(r'("[0-9]*"|\'\'|""|"\$[a-z]+"|[0-9]+ (none|I-[A-Z]+) [\w\']+( no-[a-z-]+)?)\s*\\?', c)),
    ('PLANT-CASE', 'a case whose plant (schema or table name) and every expectation inside its helper are plant-named or BASE-derived (the helper body is classified separately)', lambda c, l: re.match(r'^(system_case|shape_case) K', c)),
    ('HELPER-DEF', 'a helper\'s definition, or a line of its internal loop INSIDE one of HELPER_FUNCS (T-234 rework 1: scoped by function, never by text alone) (the expectation is its caller\'s, classified at the call)', lambda c, l: re.search(r'^(block_count|head_count|facts_into|check_facts|check|judge|part_check|policy_check|write_judge|partlocal_case|system_case|shape_case|fact)\(\) \{', c) or CUR_FN in HELPER_FUNCS and (re.fullmatch(r'("\$[a-z]+"|\$\?|"\$\?"|I-[A-Z]+|\s)+', c) or re.match(r'^(judge "\$(id|\{id\}m)"|facts_into "\$@")', c) or re.fullmatch(r'local( [A-Za-z_][A-Za-z0-9_]*(=(\$[0-9]|"\$[0-9@]"|\'\'|""|[A-Za-z0-9_-]*))?)+', c) or re.search(r'^if \[ "\$1" = -x|while IFS= read|done < <\(sed|^\s*if case "\$line"|^for re in|elif grep|^n=\$\(\(\$\(grep -c -- "\$absent"|grep -qF -- "\$line" "\$SCHEMA"|grep -oE .\^\[\^\(: \]|miss=\$\(\(miss|if \[ "\$miss" -eq 0 \] && grep -qE -- "\^  policies', c))),
]
FLAG = ('-UNJUSTIFIED', '-UNSUBTRACTED', 'UNCLASSIFIED')

# The function each line belongs to: a `name() {` line opens a body that a column-0 `}` closes; a
# one-line `name() { ...; }` covers only itself.
fn_of = {}
cur = None
for i, raw in enumerate(lines, 1):
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\(\) *\{(.*)$', raw)
    if m and cur is None:
        fn_of[i] = m.group(1)
        if not m.group(2).rstrip().endswith('}'):
            cur = m.group(1)
        continue
    fn_of[i] = cur
    if cur is not None and raw.rstrip() == '}':
        cur = None

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
key_hits = {k: [] for k in WHOLE_FILE_OK}
exact_hits = {k: [] for k in EXACT_LINES}
rows = []
for i, l in taken:
    CUR_FN = fn_of.get(i)
    code = strip_desc(l)
    norm = normalise(code)
    reads, head = schema_reads(norm)
    cat = None
    extra = []
    blocks = re.findall(r'block_count (?:-x )?(\S+)', code)
    if norm.strip() in EXACT_LINES:
        n, scope, ecat, _ = EXACT_LINES[norm.strip()]
        exact_hits[norm.strip()].append(i)
        cat = ecat if scope is None or CUR_FN == scope else 'EXEMPT-LINE-UNJUSTIFIED'
    elif head == 'UNSUBTRACTED':
        cat = 'HEAD-UNSUBTRACTED'
    elif any(not block_ok(a) for a in blocks):
        cat = 'BLOCK-UNJUSTIFIED'  # block_count over a declaration no plant owns counts the committed set
    elif reads:
        keys = [k for k in WHOLE_FILE_OK if k in norm]
        for k in keys:
            key_hits[k].append(i)
        cat = 'SCHEMA-WHOLE-FILE' if len(keys) == 1 else 'SCHEMA-WHOLE-FILE-UNJUSTIFIED'
    m = CALL.match(l)
    probe = code
    if cat is None and m:
        rest = m.group(3).strip()
        # the expectation is everything after the description: exact tags only -> VERDICT
        if rest == '' or re.fullmatch(r'((PASS|CRASH|I-[A-Z]+|"I-[A-Z]+( I-[A-Z]+)*"|"\$[A-Za-z_{}]+"|\$\?|[0-9]+|none|"\$code")\s*)*\\?', rest):
            cat = 'VERDICT'
        else:
            probe = rest
    hits = [name for name, _, pred in RULES if pred(probe, l)]
    if cat is None and hits:
        cat = hits[0]
    if cat is not None:
        extra = [h for h in hits if h != cat and h not in ('DISPLAY', 'HARNESS', 'HELPER-DEF', 'ARG')]
    scan = re.sub(r'^fact "(?:[^"\\]|\\.)*"', 'fact <description>', l)  # a fact's description is prose, not an expectation
    lit = [mm for mm in COUNT_LITERAL.finditer(scan) if not re.search(r'\$\(\([^)]*$', scan[:mm.start()])]
    if lit and not any(k in l for k in COUNT_OK) and not l.startswith('echo ') and not l.startswith('printf ') and cat not in ('DISPLAY', 'HARNESS', 'HELPER-DEF'):
        cat = 'COUNT-LITERAL-UNJUSTIFIED'
    if cat is None:
        cat = 'UNCLASSIFIED'
    rows.append([i, cat, extra, l])

# A justification is for the lines it was written for: a key matching more or fewer lines than declared
# flags every line it matches (a copied read borrows nothing), and a key matching none is stale.
stale = []
for k, (n, _) in WHOLE_FILE_OK.items():
    if len(key_hits[k]) != n:
        if not key_hits[k]:
            stale.append(k)
        for row in rows:
            if row[0] in key_hits[k] and row[1] == 'SCHEMA-WHOLE-FILE':
                row[1] = 'SCHEMA-WHOLE-FILE-UNJUSTIFIED'

for k, hit in exact_hits.items():
    if not hit:
        stale.append(k)
    elif len(hit) != EXACT_LINES[k][0]:
        for row in rows:
            if row[0] in hit:
                row[1] = 'EXEMPT-LINE-UNJUSTIFIED'

out = []
for i, cat, extra, l in rows:
    out.append((i, cat + (' (+' + ', '.join(extra) + ')' if extra else ''), l))
flagged = [i for i, c, _ in out if any(f in c.split(' (+')[0] for f in FLAG)]

counts = {}
for _, c, _ in out:
    counts[c] = counts.get(c, 0) + 1
print(f'{len(out)} line(s) taken from {path}; ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
print('  SCHEMA-WHOLE-FILE: a whole-file read of db/schema.ts in a recognised spelling, quoted or not, outside prose and harness contexts (rule 1), justified line by line in WHOLE_FILE_OK (printed below the table)')
print('  BLOCK-UNJUSTIFIED: block_count over a block name that is neither plant-named nor one of BLOCK_VARS')
print('  EXEMPT-LINE-UNJUSTIFIED: an EXACT_LINES text outside its scope function, or matched by more lines than its count')
print('  HEAD-UNSUBTRACTED: a read of the COMMITTED db/schema.ts that is not subtracted from the same read of the working file (rule 3)')
for name, desc, _ in RULES:
    print(f'  {name}: {desc}')
print()
print('Whole-file reads of db/schema.ts, and why each is not an encoding of the committed set (key: lines it must match):')
for k, (n, v) in WHOLE_FILE_OK.items():
    print(f'  - `{k}` ({n}): {v}')
print('Exact-line exemptions (EXACT_LINES; text: count, scope function, category, why):')
for k, (n, scope, ecat, v) in EXACT_LINES.items():
    print(f'  - `{k}`: {n}, {scope or "(top level)"}, {ecat}: {v}')
print()
print('| line | category | text (first 150 chars) |')
print('|---|---|---|')
for i, c, l in out:
    t = l[:150].replace('|', '\\|').replace('`', "'")
    print(f'| {i} | {c} | `{t}` |')
print()
for k in stale:
    print(f'STALE JUSTIFICATION: a WHOLE_FILE_OK key or EXACT_LINES entry matches no taken line: `{k}`')
print(f'FLAGGED {len(flagged)} line(s): {", ".join(str(i) for i in flagged) or "none"}')
sys.exit(1 if flagged or stale else 0)
