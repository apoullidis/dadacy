/**
 * gate:migration-lint — T-021 (tech-lead).
 *
 * Spec: SD §DB-13 (rules 1–3 and the last bullet of rule 7), SD §QD-4 (Migrations row),
 * SD §UC-4 part 1, SA §SEC-8, PROTOCOL §3 (the OD-13 ruling), and `T-020` § Published
 * contract §4–§6. OD-72 and OD-73 (`decisions.md`) are why two of the rules look the way
 * they do.
 *
 * STATIC. No database, no services and no Docker socket are involved:
 * `scripts/dev pnpm run gate:migration-lint`. The gate reads the SQL under `db/migrations/`,
 * and it reads git for the rules about a change set.
 *
 * THE CHANGE SET. There is no remote and no pull request (PROTOCOL §3), so "a PR" is
 * everything that differs between `git merge-base <base> HEAD` and the working tree:
 * committed, staged and unstaged changes, plus untracked files git does not ignore. The
 * base is `main` unless `--base=<ref>` names another. Leaving work uncommitted does not
 * shrink the change set. If the base cannot be resolved, the gate FAILS rather than
 * assuming the change set is empty.
 *
 * Every problem carries a rule tag, so a negative test can assert WHY the gate failed and
 * not only THAT it failed (PROTOCOL §5.1):
 *
 *   [R-LEX]              a migration this gate cannot lex (unterminated string, dollar quote,
 *                        quoted identifier or block comment). Fails closed.
 *   [R-BASE]             the change set cannot be computed. Fails closed.
 *   [R-STRUCT]           names follow `NNNN_slug.(up|down).sql`; one slug per number; every
 *                        up has a down unless it is a contract (SD §DB-13 rule 3); every down
 *                        has an up; a migration ADDED in the change set is numbered above
 *                        every migration at the base.
 *   [R-PHASE]            every up file except the 0001 baseline declares
 *                        `-- @phase: expand|contract|data` exactly once, in a comment. A file
 *                        not declared `contract` contains no contract statement (see
 *                        CONTRACT_STATEMENTS).
 *   [R-CONTRACT-ALONE]   a change set that ADDS a contract migration contains nothing else:
 *                        no other migration and no file outside those migrations. That covers
 *                        the expand it contracts and any application code. SD §DB-13 rules
 *                        1–2 require an expand, a deploy and a later release before the
 *                        contract. This rule is stricter than "its own expand": naming the
 *                        expand would need a parse of object names, and a reading that misses
 *                        a quoted or schema-qualified name would pass the case this rule
 *                        exists for. One exception (OD-80, T-138): `db/schema.ts`, which SD
 *                        §DB-1 requires regenerated beside any schema change, is accepted when
 *                        it is not deleted and its generated header verifies
 *                        (lib/schema-digest.ts). A hand-edited or deleted one is still refused.
 *   [R-CONTRACT-PURE]    an up file declared `contract` contains no expand statement: no
 *                        `CREATE …` (other than `CREATE` as a privilege name), no
 *                        `ALTER … ADD …`, no `GRANT … TO`. Such a file also loses the
 *                        contract exemption from the down-file rule (T-021 rework 1, QA-F1).
 *   [R-PROTECTED]        a migration that names a protected object carries
 *                        `-- @compliance-review: <object> — <reference>`, where the reference
 *                        cites a ticket or a decision. SD §DB-13 rule 7 and §UC-4 part 1
 *                        protect the booking triggers; `T-020` contract §6 adds the INT-10
 *                        guard. THIS GATE CANNOT VERIFY THAT A REVIEW HAPPENED. The marker makes
 *                        the change declared, and PROTOCOL §3's two-approval review of
 *                        `db/migrations` is the control.
 *   [R-TRIGGER-BYPASS]   no `DISABLE TRIGGER ALL|USER` and no `session_replication_role`. Both
 *                        switch protected triggers off without naming them. There is no
 *                        marker that permits either.
 *   [R-CASCADE]          no `DROP … CASCADE` and no `DROP OWNED`. Both remove objects the statement does not
 *                        name, and no rule that reads names can see what it removed:
 *                        `DROP FUNCTION assert_sitter_bookable() CASCADE` takes
 *                        `trg_booking_sitter_bookable` with it, and OD-73's A5 removed the INT-10
 *                        event trigger that way. Write each drop out. No marker permits it.
 *   [R-APPEND-ONLY]      no UPDATE, DELETE, TRUNCATE or ALL is granted on `audit_log`,
 *                        `case_note` or `decision_record`, on a table named after one with an
 *                        underscore suffix (a partition), or on `ALL TABLES IN SCHEMA`
 *                        (SA §SEC-8). Column-level grants count. The grantee does not matter.
 *                        Also refused: an `ALTER TABLE` naming one of them with `OWNER TO`
 *                        ANYWHERE in the statement (a later action of a multi-action list, after
 *                        the `*` marker, `ONLY ( name )`; rework 2, QR-F1), because an owner
 *                        holds every privilege; granting the role `app_ddl` to anyone,
 *                        because `app_ddl` owns every table, and likewise `CREATE ROLE|USER|GROUP`
 *                        naming `app_ddl` or `ALTER ROLE|USER|GROUP app_ddl` (membership without
 *                        a GRANT, measured in rework 1 M11/M12); and `REASSIGN OWNED` in any
 *                        form, because this gate cannot see what the named role owns (QA-F3).
 *                        `ALTER VIEW|MATERIALIZED VIEW|FOREIGN TABLE|SEQUENCE <table> OWNER TO`
 *                        is not matched: PostgreSQL refuses each on a table (rework 1, M2).
 *   [R-DEFAULT-PRIVILEGES] no `ALTER DEFAULT PRIVILEGES` (`T-020` contract §4).
 *   [R-ANSWERING-SERVICE] the only GRANT naming `answering_service` is exactly INSERT on
 *                        `out_of_hours_report`, to it alone, with no `WITH GRANT OPTION` or
 *                        `GRANTED BY`; no role is granted to it and it is granted to no one;
 *                        nothing is granted to PUBLIC, because PUBLIC includes it (`T-020`
 *                        contract §6). Also refused (QA-F2): `CREATE ROLE|USER|GROUP` naming
 *                        it, `ALTER ROLE|USER|GROUP answering_service`, `OWNER TO
 *                        answering_service`, and `REASSIGN OWNED … TO answering_service`.
 *   [R-TABLE-GRANT]      every CREATE TABLE in an up file is followed in the same file by a
 *                        GRANT on that table. There are no default privileges, so a table with
 *                        no grant is a table nobody can use (`T-020` contract §4/§6).
 *   [R-MERGED]           a migration that exists at the base is never deleted and changes
 *                        ONLY IN ITS COMMENTS (PROTOCOL §3, OD-13). The comparison lexes the
 *                        SQL, so a `--` inside a dollar-quoted function body is part of the
 *                        body, not a comment. That body is stored in `pg_proc.prosrc` (OD-72).
 *   [R-BASELINE]         the executable content of `0001` hashes to the value pinned in
 *                        BASELINE. This anchor does not come from git. It catches a change
 *                        to `0001` that was committed onto the base itself, which R-MERGED
 *                        cannot see.
 *
 * HOW THE SQL IS READ. `lex()` follows PostgreSQL's lexer (with standard_conforming_strings
 * on) for the six constructs that decide what is a comment and what is a literal: `--`
 * comments, nested block comments, `'…'` strings (with a backslash escape only after an `E`
 * prefix), `"…"` identifiers and `$tag$…$tag$` bodies. A dollar body is lexed again as SQL
 * for the content rules, because a function body is SQL. A single-quoted string is scanned
 * as raw text, because it may be dynamic SQL passed to EXECUTE. Errors in either direction
 * produce a false FAIL, never a false PASS.
 *
 * WHAT THIS GATE DOES NOT SEE. SQL assembled at run time from pieces (`format('GRANT %s ON
 * %I', …)`, concatenation) is not read as the statement it becomes. It is a static check
 * over source text and it proves nothing about a database. The database-side refusals are
 * `0001`'s guard and the constraint suites.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, capture, finish } from './lib/run.ts';
import { SCHEMA_REL, verifySchemaFile } from './lib/schema-digest.ts';

const GATE = 'gate:migration-lint';
const MIGRATIONS_REL = 'db/migrations';
const MIGRATIONS_DIR = path.join(REPO_ROOT, MIGRATIONS_REL);
const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.(up|down)\.sql$/;

/**
 * The `0001` baseline predates every content rule. For example, its own event-trigger tag
 * list holds the literal 'ALTER DEFAULT PRIVILEGES', and it grants CONNECT and schema USAGE
 * to answering_service. So the content rules do not read `0001`. It is held by R-MERGED and
 * R-BASELINE instead. Each hash is the SHA-256 of `executableLines(file).join('\n')`, taken
 * from `main` at `b8f294d`. A change to a comment leaves the hash alone; any other change
 * moves it.
 */
const BASELINE: ReadonlyMap<string, string> = new Map([
  [
    '0001_extensions_and_roles.up.sql',
    '22fb62a7a067536e972e1a911cf21c5636a3f9dc15ebafd5da61f16088491624',
  ],
  [
    '0001_extensions_and_roles.down.sql',
    '60cc89f8fad82cf89e2ad483cac5a0016730c1019fd1af23e7f984e9182a4d21',
  ],
]);

/**
 * Statements that make a migration contract-phase: they remove or reshape something the
 * previous release's code may still use (SD §DB-13 rules 1 and 5). Matched against
 * normalised fragments (upper case, single spaces, identifiers unquoted).
 */
const CONTRACT_STATEMENTS: readonly (readonly [RegExp, string])[] = [
  [/\bDROP COLUMN\b/, 'DROP COLUMN'],
  [
    /\bALTER TABLE\b.*?[ ,]DROP (?!COLUMN\b|CONSTRAINT\b|DEFAULT\b|NOT NULL\b|IDENTITY\b|EXPRESSION\b)/,
    'ALTER TABLE … DROP <column> (COLUMN omitted)',
  ],
  [/\bDROP TABLE\b/, 'DROP TABLE'],
  [/\bDROP (?:MATERIALIZED )?VIEW\b/, 'DROP VIEW'],
  [/\bDROP TYPE\b/, 'DROP TYPE'],
  [/\bRENAME\b/, 'RENAME'],
  [/\bALTER (?:COLUMN )?\S+ (?:SET DATA )?TYPE\b/, 'ALTER COLUMN … TYPE'],
  [/\bSET NOT NULL\b/, 'SET NOT NULL'],
];

interface Protected {
  readonly id: string;
  readonly why: string;
}

const PROTECTED: readonly Protected[] = [
  {
    id: 'trg_booking_sitter_bookable',
    why: 'I-1; its WHEN clause fires only on transitions INTO confirmed/in_progress, so a live session is never re-evaluated (SD §UC-4 part 1, §DB-13 rule 7)',
  },
  { id: 'trg_booking_staffed_hours', why: 'SD §DB-13 rule 7' },
  { id: 'assert_within_staffed_hours', why: 'SD §DB-13 rule 7' },
  {
    id: 'trg_int10_answering_service',
    why: 'the SA §INT-10 guard event trigger (T-020 contract §6)',
  },
  {
    id: 'assert_answering_service_write_only',
    why: 'the SA §INT-10 guard; a schema owner can drop it and install a no-op (OD-73)',
  },
  {
    id: 'trg_assert_answering_service_write_only',
    why: "the guard event trigger's function; DROP … CASCADE on it drops the event trigger (OD-73)",
  },
];

/**
 * Statements that make a migration expand-phase, which a file declared `contract` may not
 * contain (R-CONTRACT-PURE, T-021 rework 1, QA-F1). SD §DB-13's table lists `0082` as
 * "expand + contract" and `0077` as "expand ×3": a Kind cell names a SEQUENCE of migrations,
 * and rule 3 needs a down file for the expand half. `CREATE` used as a privilege name
 * (`REVOKE CREATE ON …`) is not an expand. A `GRANT … TO` is matched by `grantsIn()`.
 */
const EXPAND_STATEMENTS: readonly (readonly [RegExp, string])[] = [
  [/\bCREATE (?!ON\b)/, 'CREATE'],
  [/\bALTER\b.*[ ,]ADD\b/, 'ALTER … ADD'],
];

const APPEND_ONLY = /^(?:AUDIT_LOG|CASE_NOTE|DECISION_RECORD)(?:_[A-Z0-9_$]+)?$/;
const REFERENCE = /\b(?:T-\d{3}|OE-\d+|OD-\d+|EV-\d+|SQ-\d+)\b/;

// ---------------------------------------------------------------------------
// 1. The lexer
// ---------------------------------------------------------------------------

type SegmentKind = 'code' | 'line-comment' | 'block-comment' | 'string' | 'dollar' | 'ident';

interface Segment {
  readonly kind: SegmentKind;
  /** Source text, delimiters included. */
  readonly text: string;
  /** Content without delimiters. For a quoted identifier, with `""` unescaped. */
  readonly body: string;
  readonly line: number;
}

interface Lexed {
  readonly segments: readonly Segment[];
  readonly error: string | null;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

function newlines(s: string): number {
  return s.split('\n').length - 1;
}

export function lex(sql: string): Lexed {
  const segments: Segment[] = [];
  const n = sql.length;
  let i = 0;
  let line = 1;
  let code = '';
  let codeLine = 1;

  const flush = (): void => {
    if (code !== '') segments.push({ kind: 'code', text: code, body: code, line: codeLine });
    code = '';
  };
  const unterminated = (what: string, at: number): Lexed => ({
    segments,
    error: `unterminated ${what} starting at line ${String(at)}`,
  });

  while (i < n) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    const prev = i > 0 ? sql.charAt(i - 1) : '';

    if (c === '-' && next === '-') {
      flush();
      let j = sql.indexOf('\n', i);
      if (j === -1) j = n;
      const text = sql.slice(i, j);
      segments.push({ kind: 'line-comment', text, body: text.slice(2), line });
      i = j;
      continue;
    }

    if (c === '/' && next === '*') {
      flush();
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql.charAt(j) === '/' && sql.charAt(j + 1) === '*') {
          depth += 1;
          j += 2;
        } else if (sql.charAt(j) === '*' && sql.charAt(j + 1) === '/') {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      if (depth !== 0) return unterminated('block comment', line);
      const text = sql.slice(i, j);
      segments.push({ kind: 'block-comment', text, body: text.slice(2, -2), line });
      line += newlines(text);
      i = j;
      continue;
    }

    if (c === "'") {
      flush();
      const beforePrefix = i > 1 ? sql.charAt(i - 2) : ' ';
      const escapes = (prev === 'E' || prev === 'e') && !IDENT_CHAR.test(beforePrefix);
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = sql.charAt(j);
        if (escapes && d === '\\') {
          j += 2;
          continue;
        }
        if (d === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return unterminated('string literal', line);
      const text = sql.slice(i, j + 1);
      segments.push({ kind: 'string', text, body: text.slice(1, -1), line });
      line += newlines(text);
      i = j + 1;
      continue;
    }

    if (c === '"') {
      flush();
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql.charAt(j) === '"') {
          if (sql.charAt(j + 1) === '"') {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return unterminated('quoted identifier', line);
      const text = sql.slice(i, j + 1);
      segments.push({ kind: 'ident', text, body: text.slice(1, -1).replace(/""/g, '"'), line });
      line += newlines(text);
      i = j + 1;
      continue;
    }

    if (c === '$' && !IDENT_CHAR.test(prev)) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m !== null) {
        flush();
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) return unterminated(`dollar quote ${tag}`, line);
        const text = sql.slice(i, close + tag.length);
        segments.push({ kind: 'dollar', text, body: sql.slice(i + tag.length, close), line });
        line += newlines(text);
        i = close + tag.length;
        continue;
      }
    }

    if (code === '') codeLine = line;
    code += c;
    if (c === '\n') line += 1;
    i += 1;
  }
  flush();
  return { segments, error: null };
}

/**
 * The file with its comments removed, as lines. This is what R-MERGED compares.
 *
 * A `--` comment is deleted. A block comment becomes the newlines it contained, or a single
 * space if it had none, because PostgreSQL treats a comment as whitespace. A line is dropped
 * when it holds only whitespace that sits outside every literal and its line break is also
 * outside a literal. Whitespace at the end of a line is trimmed only where it sits outside a
 * literal. Everything else stays byte for byte, so these all change the result: indentation,
 * any character in a string, dollar body or quoted identifier (a `--` inside a function body
 * included), and a blank line inside a literal.
 */
export function executableLines(segments: readonly Segment[]): string[] {
  const chars: string[] = [];
  const literal: boolean[] = [];
  const add = (s: string, isLiteral: boolean): void => {
    for (const ch of s) {
      chars.push(ch);
      literal.push(isLiteral);
    }
  };
  for (const s of segments) {
    if (s.kind === 'line-comment') continue;
    if (s.kind === 'block-comment') {
      const k = newlines(s.text);
      add(k > 0 ? '\n'.repeat(k) : ' ', false);
      continue;
    }
    add(s.text, s.kind !== 'code');
  }

  const lines: string[] = [];
  let start = 0;
  const emit = (end: number, breakIsLiteral: boolean): void => {
    let stop = end;
    while (stop > start && literal[stop - 1] === false && /\s/.test(chars[stop - 1] ?? '')) {
      stop -= 1;
    }
    if (stop === start && !breakIsLiteral) return;
    lines.push(chars.slice(start, stop).join(''));
  };
  for (let k = 0; k < chars.length; k += 1) {
    if (chars[k] === '\n') {
      emit(k, literal[k] === true);
      start = k + 1;
    }
  }
  emit(chars.length, false);
  return lines;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Normalised statement fragments, which the content rules read.
 *
 * Top-level code is split on `;`. A quoted identifier contributes its name without the
 * quotes. A comment contributes nothing. Each single-quoted string becomes fragments of its
 * own, split raw on `;`, since it may be dynamic SQL. A dollar body is lexed again as SQL,
 * which removes the comments inside a function body; if that lex fails, the body is split
 * raw instead.
 */
export function fragments(segments: readonly Segment[], depth = 0): string[] {
  const out: string[] = [];
  let cur = '';
  const push = (): void => {
    const t = norm(cur);
    if (t !== '') out.push(t);
    cur = '';
  };
  const raw = (s: string): void => {
    for (const part of s.split(';')) {
      const t = norm(part);
      if (t !== '') out.push(t);
    }
  };
  for (const s of segments) {
    if (s.kind === 'code') {
      for (const ch of s.text) {
        if (ch === ';') push();
        else cur += ch;
      }
    } else if (s.kind === 'ident') {
      cur += s.body;
    } else if (s.kind === 'line-comment' || s.kind === 'block-comment') {
      cur += ' ';
    } else if (s.kind === 'string') {
      cur += ' ';
      raw(s.body.replace(/''/g, "'"));
    } else {
      cur += ' ';
      const inner = depth < 8 ? lex(s.body) : null;
      if (inner !== null && inner.error === null) out.push(...fragments(inner.segments, depth + 1));
      else raw(s.body);
    }
  }
  push();
  return out;
}

function commentText(segments: readonly Segment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (s.kind === 'line-comment' || s.kind === 'block-comment') out.push(...s.body.split('\n'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. GRANT clauses
// ---------------------------------------------------------------------------

interface Grant {
  readonly privileges: string;
  /** null for a role grant (`GRANT role TO x`). */
  readonly targets: readonly string[] | null;
  readonly allTablesInSchema: boolean;
  readonly grantees: readonly string[];
  /** The trailing `WITH GRANT OPTION`, `WITH ADMIN|INHERIT|SET …` or `GRANTED BY …`; '' if none. */
  readonly options: string;
  readonly clause: string;
}

function bareName(s: string): string {
  return s
    .trim()
    .replace(/^TABLE /, '')
    .replace(/^PUBLIC\./, '')
    .trim();
}

function grantsIn(fragment: string): Grant[] {
  const out: Grant[] = [];
  // Split before each GRANT or REVOKE keyword, but never inside `WITH GRANT OPTION` or
  // `REVOKE GRANT OPTION FOR`: splitting there cut the grantee to `ANSWERING_SERVICE WITH`,
  // which is how `… TO answering_service WITH GRANT OPTION` passed (rework 1, C69).
  for (const piece of fragment.split(/(?=\bGRANT\b(?! OPTION\b)|\bREVOKE\b)/)) {
    const clause = piece.trim();
    if (!clause.startsWith('GRANT ')) continue;
    const onForm = /^GRANT (.+?) ON (.+?) TO (.+?)( WITH GRANT OPTION.*| GRANTED BY .*)?$/.exec(
      clause,
    );
    if (onForm !== null) {
      const target = (onForm[2] ?? '').trim();
      const allTables = /^ALL TABLES IN SCHEMA\b/.test(target);
      out.push({
        privileges: (onForm[1] ?? '').trim(),
        targets: allTables
          ? []
          : target
              .replace(/^TABLE /, '')
              .split(',')
              .map(bareName),
        allTablesInSchema: allTables,
        grantees: (onForm[3] ?? '').split(',').map((g) => g.trim().replace(/^GROUP /, '')),
        options: (onForm[4] ?? '').trim(),
        clause,
      });
      continue;
    }
    const roleForm = /^GRANT (.+?) TO (.+?)( WITH .*| GRANTED BY .*)?$/.exec(clause);
    if (roleForm !== null) {
      out.push({
        privileges: (roleForm[1] ?? '').trim(),
        targets: null,
        allTablesInSchema: false,
        grantees: (roleForm[2] ?? '').split(',').map((g) => g.trim().replace(/^GROUP /, '')),
        options: (roleForm[3] ?? '').trim(),
        clause,
      });
    }
  }
  return out;
}

function snippet(s: string): string {
  return JSON.stringify(s.length > 110 ? `${s.slice(0, 107)}...` : s);
}

// ---------------------------------------------------------------------------
// 3. git
// ---------------------------------------------------------------------------

interface Change {
  readonly status: 'A' | 'M' | 'D';
  readonly path: string;
}

function git(args: readonly string[]): { ok: boolean; out: string; err: string } {
  const r = capture('git', args);
  return { ok: r.code === 0, out: r.stdout, err: (r.stderr || r.stdout).trim() };
}

// ---------------------------------------------------------------------------
// 4. The gate
// ---------------------------------------------------------------------------

const failures: string[] = [];
const problem = (tag: string, where: string, message: string): void => {
  failures.push(`[${tag}] ${where}: ${message}`);
};

let baseRef = 'main';
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--base=') && arg.length > '--base='.length) baseRef = arg.slice(7);
  else problem('R-BASE', 'argv', `unknown argument ${snippet(arg)}; the only one is --base=<ref>`);
}

if (!fs.existsSync(MIGRATIONS_DIR)) {
  problem('R-STRUCT', MIGRATIONS_REL, 'the directory does not exist');
  finish(GATE, failures);
}

// ---- the files ------------------------------------------------------------

interface Migration {
  readonly name: string;
  readonly rel: string;
  readonly num: string;
  readonly slug: string;
  readonly dir: 'up' | 'down';
  readonly lexed: Lexed;
}

const migrations: Migration[] = [];
for (const name of fs.readdirSync(MIGRATIONS_DIR).sort()) {
  const rel = `${MIGRATIONS_REL}/${name}`;
  const m = FILE_RE.exec(name);
  if (m === null) {
    problem('R-STRUCT', rel, 'not named NNNN_slug.up.sql or NNNN_slug.down.sql');
    continue;
  }
  const lexed = lex(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  if (lexed.error !== null)
    problem('R-LEX', rel, `${lexed.error}; nothing in this file was checked`);
  migrations.push({
    name,
    rel,
    num: m[1] ?? '',
    slug: m[2] ?? '',
    dir: m[3] === 'up' ? 'up' : 'down',
    lexed,
  });
}
if (migrations.length === 0) {
  problem(
    'R-STRUCT',
    MIGRATIONS_REL,
    'zero migration files read; a lint over nothing is not a pass',
  );
  finish(GATE, failures);
}
const byName = new Map(migrations.map((m) => [m.name, m]));

// ---- the change set -------------------------------------------------------

const changes: Change[] = [];
let mergeBase = '';
let mergedNames: ReadonlySet<string> = new Set();
{
  const mb = git(['merge-base', baseRef, 'HEAD']);
  if (!mb.ok || mb.out.trim() === '') {
    problem(
      'R-BASE',
      baseRef,
      `git merge-base ${baseRef} HEAD failed (${mb.err || 'no output'}); the change set is unknown`,
    );
  } else {
    mergeBase = mb.out.trim();
    const diff = git(['diff', '--name-status', '--no-renames', '-z', mergeBase]);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
    const tree = git(['ls-tree', '--name-only', `${mergeBase}:${MIGRATIONS_REL}`]);
    if (!diff.ok || !untracked.ok) {
      problem('R-BASE', baseRef, `git diff/ls-files failed (${diff.err || untracked.err})`);
    } else {
      const parts = diff.out.split('\0').filter((p) => p !== '');
      for (let k = 0; k + 1 < parts.length; k += 2) {
        const s = (parts[k] ?? '').charAt(0);
        const p = parts[k + 1] ?? '';
        changes.push({ status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M', path: p });
      }
      for (const p of untracked.out.split('\0'))
        if (p !== '') changes.push({ status: 'A', path: p });
    }
    // An absent directory at the base is legitimate (the first migration ever); any other
    // failure is not.
    mergedNames = new Set(tree.ok ? tree.out.split('\n').filter((l) => l !== '') : []);
  }
}
const changed = new Map(changes.map((c) => [c.path, c]));

// ---- R-STRUCT -------------------------------------------------------------

{
  const slugsByNum = new Map<string, Set<string>>();
  for (const m of migrations) {
    const set = slugsByNum.get(m.num) ?? new Set<string>();
    set.add(m.slug);
    slugsByNum.set(m.num, set);
  }
  for (const [num, slugs] of slugsByNum) {
    if (slugs.size > 1)
      problem('R-STRUCT', num, `one number, ${String(slugs.size)} names: ${[...slugs].join(', ')}`);
  }
  let maxMerged = -1;
  for (const name of mergedNames) {
    const m = FILE_RE.exec(name);
    if (m !== null) maxMerged = Math.max(maxMerged, Number(m[1]));
  }
  for (const m of migrations) {
    if (
      changed.get(m.rel)?.status === 'A' &&
      !mergedNames.has(m.name) &&
      Number(m.num) <= maxMerged
    ) {
      problem(
        'R-STRUCT',
        m.rel,
        `added in this change set but numbered at or below ${String(maxMerged).padStart(4, '0')}, the highest migration at the base`,
      );
    }
  }
}

// ---- per-file rules -------------------------------------------------------

const phaseOf = new Map<string, string>();
/** Contract up files holding an expand statement; they lose the down-file exemption. */
const impureContracts = new Set<string>();
let contractsReadForExpand = 0;
let grantsRead = 0;
let tablesRead = 0;
let protectedMentions = 0;
let baselinePinned = 0;

for (const m of migrations) {
  if (m.lexed.error !== null) continue;
  const segs = m.lexed.segments;
  const comments = commentText(segs);

  // R-STRUCT pairs, and R-PHASE.
  const phases = new Set<string>();
  for (const c of comments) {
    const p = /@phase:\s*([a-z]+)/.exec(c);
    if (p !== null) phases.add(p[1] ?? '');
  }
  const pinned = BASELINE.get(m.name);
  if (m.dir === 'up' && pinned === undefined) {
    if (phases.size !== 1) {
      problem(
        'R-PHASE',
        m.rel,
        phases.size === 0
          ? 'no `-- @phase: expand|contract|data` marker'
          : `${String(phases.size)} different @phase markers`,
      );
    } else {
      const phase = [...phases][0] ?? '';
      if (phase !== 'expand' && phase !== 'contract' && phase !== 'data') {
        problem('R-PHASE', m.rel, `@phase ${snippet(phase)} is not expand, contract or data`);
      }
      phaseOf.set(m.name, phase);
    }
  }

  if (pinned !== undefined) {
    const hash = createHash('sha256').update(executableLines(segs).join('\n')).digest('hex');
    if (hash !== pinned) {
      problem(
        'R-BASELINE',
        m.rel,
        `executable content hashes to ${hash}, pinned ${pinned}; 0001's applied effect has changed (PROTOCOL §3)`,
      );
    } else {
      baselinePinned += 1;
    }
    continue; // the content rules do not read the baseline — see BASELINE
  }

  const frags = fragments(segs);

  // R-PHASE: contract statements outside a contract migration.
  if (m.dir === 'up' && phaseOf.has(m.name) && phaseOf.get(m.name) !== 'contract') {
    for (const f of frags) {
      for (const [re, label] of CONTRACT_STATEMENTS) {
        if (re.test(f)) {
          problem(
            'R-PHASE',
            m.rel,
            `declared @phase ${phaseOf.get(m.name) ?? ''} but contains a contract statement (${label}): ${snippet(f)}`,
          );
        }
      }
    }
  }

  // R-CONTRACT-PURE: expand statements inside a contract migration (QA-F1).
  if (m.dir === 'up' && phaseOf.get(m.name) === 'contract') {
    contractsReadForExpand += 1;
    for (const f of frags) {
      const hit = EXPAND_STATEMENTS.find(([re]) => re.test(f));
      const label = hit !== undefined ? hit[1] : grantsIn(f).length > 0 ? 'GRANT' : null;
      if (label === null) continue;
      impureContracts.add(m.name);
      problem(
        'R-CONTRACT-PURE',
        m.rel,
        `declared @phase contract but contains an expand statement (${label}); the expand is its own migration, a release earlier, with a down file (SD §DB-13 rules 2–3): ${snippet(f)}`,
      );
    }
  }

  // R-PROTECTED.
  for (const p of PROTECTED) {
    const re = new RegExp(`(^|[^A-Z0-9_$])${p.id.toUpperCase()}([^A-Z0-9_$]|$)`);
    const hit = frags.find((f) => re.test(f));
    if (hit === undefined) continue;
    protectedMentions += 1;
    const markers = comments
      .map((c) => new RegExp(`@compliance-review:\\s*${p.id}(?![A-Za-z0-9_$])(.*)$`).exec(c))
      .filter((x): x is RegExpExecArray => x !== null);
    if (markers.length === 0) {
      problem(
        'R-PROTECTED',
        m.rel,
        `names protected object ${p.id} (${p.why}) with no \`-- @compliance-review: ${p.id} — <reference>\` marker: ${snippet(hit)}`,
      );
    } else if (!markers.some((x) => REFERENCE.test(x[1] ?? ''))) {
      problem(
        'R-PROTECTED',
        m.rel,
        `the @compliance-review marker for ${p.id} cites no ticket or decision (T-NNN, OE-n, OD-n, EV-n, SQ-n)`,
      );
    }
  }

  // R-TRIGGER-BYPASS.
  for (const f of frags) {
    if (/\bDISABLE TRIGGER (?:ALL|USER)\b/.test(f) || /\bSESSION_REPLICATION_ROLE\b/.test(f)) {
      problem(
        'R-TRIGGER-BYPASS',
        m.rel,
        `switches off triggers without naming them, protected ones included: ${snippet(f)}`,
      );
    }
  }

  // R-CASCADE.
  for (const f of frags) {
    if (/\bDROP\b.*\bCASCADE\b/.test(f)) {
      problem(
        'R-CASCADE',
        m.rel,
        `DROP … CASCADE removes objects this statement does not name, protected ones included (OD-73 A5); drop each one explicitly: ${snippet(f)}`,
      );
    } else if (/\bDROP OWNED\b/.test(f)) {
      problem(
        'R-CASCADE',
        m.rel,
        `DROP OWNED removes every object the role owns without naming one, protected ones included; drop each one explicitly: ${snippet(f)}`,
      );
    }
  }

  // R-APPEND-ONLY, the routes that are not a privilege grant.
  for (const f of frags) {
    // OWNER TO ANYWHERE in the statement (rework 2, QR-F1/OD-77). PostgreSQL's grammar is
    // `ALTER TABLE [IF EXISTS] { name [*] | ONLY name | ONLY ( name ) } action [, …]`, and
    // OWNER TO is one action: it may follow another action or the `*` marker. A fragment is
    // one statement (split on `;`) with string literals blanked out, so the lookahead cannot
    // reach the next statement or a string's contents.
    const owner =
      /\bALTER TABLE (?:IF EXISTS )?(?:ONLY ?)?(?:\( ?)?([A-Z0-9_$.]+)(?=.*\bOWNER TO\b)/.exec(f);
    if (owner !== null && APPEND_ONLY.test(bareName(owner[1] ?? ''))) {
      problem(
        'R-APPEND-ONLY',
        m.rel,
        `transfers ownership of append-only ${bareName(owner[1] ?? '')}; an owner holds UPDATE and DELETE without any GRANT (SA §SEC-8): ${snippet(f)}`,
      );
    }
    if (/\bREASSIGN OWNED\b/.test(f)) {
      problem(
        'R-APPEND-ONLY',
        m.rel,
        `REASSIGN OWNED transfers every object a role owns without naming one, and app_ddl owns the append-only tables; this gate cannot see what a role owns, so every form is refused (SA §SEC-8, QA-F3): ${snippet(f)}`,
      );
    }
    if (
      /\bCREATE (?:ROLE|USER|GROUP)\b.*\bAPP_DDL\b/.test(f) ||
      /\bALTER (?:ROLE|USER|GROUP) APP_DDL\b/.test(f)
    ) {
      problem(
        'R-APPEND-ONLY',
        m.rel,
        `confers membership in app_ddl without a GRANT (CREATE ROLE … IN ROLE, ALTER GROUP … ADD USER), or alters app_ddl; app_ddl owns the append-only tables, so its members can UPDATE and DELETE them (SA §SEC-8): ${snippet(f)}`,
      );
    }
  }

  // R-ANSWERING-SERVICE, the routes that are not a privilege grant (QA-F2).
  for (const f of frags) {
    if (
      /\bCREATE (?:ROLE|USER|GROUP)\b.*\bANSWERING_SERVICE\b/.test(f) ||
      /\bALTER (?:ROLE|USER|GROUP) ANSWERING_SERVICE\b/.test(f) ||
      /\bOWNER TO ANSWERING_SERVICE\b/.test(f) ||
      /\bREASSIGN OWNED\b.*\bTO ANSWERING_SERVICE\b/.test(f)
    ) {
      problem(
        'R-ANSWERING-SERVICE',
        m.rel,
        `confers membership in, membership through, or ownership to answering_service without a GRANT; SA §INT-10 permits INSERT on out_of_hours_report and nothing else: ${snippet(f)}`,
      );
    }
  }

  // R-DEFAULT-PRIVILEGES.
  for (const f of frags) {
    if (/\bALTER DEFAULT PRIVILEGES\b/.test(f)) {
      problem(
        'R-DEFAULT-PRIVILEGES',
        m.rel,
        `T-020 contract §4: there are no default privileges and there must not be: ${snippet(f)}`,
      );
    }
  }

  // GRANT-reading rules.
  const grantedTables = new Set<string>();
  for (const f of frags) {
    for (const g of grantsIn(f)) {
      grantsRead += 1;
      const dangerous = /\b(?:UPDATE|DELETE|TRUNCATE|ALL)\b/.test(g.privileges);
      if (g.targets !== null) for (const t of g.targets) grantedTables.add(t);

      if (g.targets === null && g.privileges.split(',').some((r) => r.trim() === 'APP_DDL')) {
        problem(
          'R-APPEND-ONLY',
          m.rel,
          `grants the role app_ddl, which owns every table, the append-only ones included, so its members can UPDATE and DELETE them (SA §SEC-8): ${snippet(g.clause)}`,
        );
      }

      if (dangerous && g.allTablesInSchema) {
        problem(
          'R-APPEND-ONLY',
          m.rel,
          `grants ${g.privileges} on ALL TABLES IN SCHEMA, which reaches the append-only tables (SA §SEC-8): ${snippet(g.clause)}`,
        );
      }
      if (dangerous && g.targets !== null) {
        for (const t of g.targets) {
          if (APPEND_ONLY.test(t)) {
            problem(
              'R-APPEND-ONLY',
              m.rel,
              `grants ${g.privileges} on append-only ${t}; audit_log, case_note and decision_record take INSERT only, to every role (SA §SEC-8): ${snippet(g.clause)}`,
            );
          }
        }
      }

      if (
        g.targets === null &&
        g.privileges.split(',').some((r) => r.trim() === 'ANSWERING_SERVICE')
      ) {
        problem(
          'R-ANSWERING-SERVICE',
          m.rel,
          `grants the role answering_service, which makes each grantee a member of the vendor principal (QA-F2): ${snippet(g.clause)}`,
        );
      }

      const toVendor = g.grantees.includes('ANSWERING_SERVICE');
      const toPublic = g.grantees.includes('PUBLIC');
      if (toPublic) {
        problem(
          'R-ANSWERING-SERVICE',
          m.rel,
          `grants to PUBLIC, and PUBLIC includes answering_service (T-020 contract §6): ${snippet(g.clause)}`,
        );
      } else if (toVendor) {
        const permitted =
          g.targets !== null &&
          g.privileges === 'INSERT' &&
          g.targets.length === 1 &&
          g.targets[0] === 'OUT_OF_HOURS_REPORT' &&
          g.grantees.length === 1 &&
          g.options === '';
        if (!permitted) {
          problem(
            'R-ANSWERING-SERVICE',
            m.rel,
            `${g.targets === null ? 'grants a role to' : 'grants answering_service something other than exactly INSERT on out_of_hours_report, to it alone, with no WITH GRANT OPTION or GRANTED BY, to'} answering_service; SA §INT-10 permits that one grant and nothing else: ${snippet(g.clause)}`,
          );
        }
      }
    }
  }

  // R-TABLE-GRANT.
  if (m.dir === 'up') {
    for (const f of frags) {
      const c =
        /\bCREATE (?:(?:GLOBAL |LOCAL )?(?:TEMP|TEMPORARY) |UNLOGGED )?TABLE (?:IF NOT EXISTS )?([A-Z0-9_$.]+)/.exec(
          f,
        );
      if (c === null || /\bCREATE (?:GLOBAL |LOCAL )?TEMP/.test(f)) continue;
      tablesRead += 1;
      const name = bareName(c[1] ?? '');
      if (!grantedTables.has(name)) {
        problem(
          'R-TABLE-GRANT',
          m.rel,
          `CREATE TABLE ${name} with no GRANT on it in this file; there are no default privileges, so nobody can use it (T-020 contract §4)`,
        );
      }
    }
  }
}

// R-STRUCT pairs.
for (const m of migrations) {
  const other = `${m.num}_${m.slug}.${m.dir === 'up' ? 'down' : 'up'}.sql`;
  if (byName.has(other)) continue;
  if (m.dir === 'down') problem('R-STRUCT', m.rel, `a down file with no ${other}`);
  else if (phaseOf.get(m.name) !== 'contract') {
    problem(
      'R-STRUCT',
      m.rel,
      `no ${other}; only a contract migration may omit its down file (SD §DB-13 rule 3)`,
    );
  } else if (impureContracts.has(m.name)) {
    problem(
      'R-STRUCT',
      m.rel,
      `no ${other}; this contract migration holds an expand statement (R-CONTRACT-PURE), and an expand needs a down file (SD §DB-13 rule 3)`,
    );
  }
}

// ---- R-CONTRACT-ALONE -----------------------------------------------------

const addedContracts = migrations.filter(
  (m) => m.dir === 'up' && phaseOf.get(m.name) === 'contract' && changed.get(m.rel)?.status === 'A',
);
if (addedContracts.length > 0) {
  const allowed = new Set<string>();
  for (const m of addedContracts) {
    allowed.add(m.rel);
    allowed.add(`${MIGRATIONS_REL}/${m.num}_${m.slug}.down.sql`);
  }
  // OD-80 (T-138). SD §DB-1 requires `db/schema.ts` to be regenerated in the change set of any
  // migration that changes the introspected schema, a contract included. It is accepted here
  // ONLY when it is not deleted and the working-tree file verifies as the generator's untouched
  // output (scripts/gates/lib/schema-digest.ts). A hand-edited or deleted `db/schema.ts` is still
  // refused. This reads the file's own digest, so it cannot tell a regeneration from an edit
  // whose author recomputed the digest; parity with the database is `db:introspect:check`'s.
  let schemaNote = '';
  const schemaChange = changed.get(SCHEMA_REL);
  if (schemaChange !== undefined) {
    if (schemaChange.status === 'D') {
      schemaNote = `; ${SCHEMA_REL} is deleted, which is not a regeneration`;
    } else {
      const verdict = verifySchemaFile(fs.readFileSync(path.join(REPO_ROOT, SCHEMA_REL), 'utf8'));
      if (verdict.ok) allowed.add(SCHEMA_REL);
      else
        schemaNote = `; ${SCHEMA_REL} is not the generator's untouched output: ${verdict.reason}`;
    }
  }
  const others = changes.filter((c) => !allowed.has(c.path)).map((c) => c.path);
  if (others.length > 0) {
    const shown =
      others.slice(0, 6).join(', ') +
      (others.length > 6 ? `, and ${String(others.length - 6)} more` : '');
    problem(
      'R-CONTRACT-ALONE',
      addedContracts.map((m) => m.rel).join(', '),
      `a contract migration must land alone, a release after its expand and the code that stopped using what it removes (SD §DB-13 rules 1–2); this change set also carries: ${shown}${schemaNote}`,
    );
  }
}

// ---- R-MERGED -------------------------------------------------------------

let mergedCompared = 0;
for (const c of changes) {
  if (!c.path.startsWith(`${MIGRATIONS_REL}/`)) continue;
  const name = c.path.slice(MIGRATIONS_REL.length + 1);
  if (!mergedNames.has(name)) continue;
  if (c.status === 'D') {
    problem(
      'R-MERGED',
      c.path,
      'a merged migration is deleted; its applied effect is immutable (PROTOCOL §3)',
    );
    continue;
  }
  const baseText = git(['show', `${mergeBase}:${c.path}`]);
  const head = byName.get(name);
  if (!baseText.ok || head === undefined) {
    problem('R-MERGED', c.path, `cannot read both versions (${baseText.err || 'file missing'})`);
    continue;
  }
  const before = lex(baseText.out);
  if (before.error !== null || head.lexed.error !== null) continue; // R-LEX has reported it
  mergedCompared += 1;
  const a = executableLines(before.segments);
  const b = executableLines(head.lexed.segments);
  if (a.join('\n') === b.join('\n')) continue;
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k += 1;
  const was = a[k] ?? '(end of file)';
  const now = b[k] ?? '(end of file)';
  const suites = name.startsWith('0001_')
    ? " T-115's preflight suites also assert 0001's messages by substring, so rewording one turns them red."
    : '';
  problem(
    'R-MERGED',
    c.path,
    `a merged migration changed outside its comments, which changes what it does (PROTOCOL §3: a new migration, not an edit). First difference, executable line ${String(k + 1)}: was ${snippet(was)}, now ${snippet(now)}.${suites}`,
  );
}

// ---- report ---------------------------------------------------------------

const ups = migrations.filter((m) => m.dir === 'up').length;
const inDir = changes.filter((c) => c.path.startsWith(`${MIGRATIONS_REL}/`));
console.log(
  `migration-lint: ${String(migrations.length)} migration file(s) read (${String(ups)} up, ${String(migrations.length - ups)} down)`,
);
console.log(
  `  base ${baseRef} -> merge-base ${mergeBase === '' ? '(unresolved)' : mergeBase.slice(0, 12)}; change set ${String(changes.length)} path(s), ${String(inDir.length)} under ${MIGRATIONS_REL}/`,
);
console.log(
  `  baseline files pinned and matching: ${String(baselinePinned)} of ${String(BASELINE.size)}`,
);
console.log(
  `  GRANT clauses read: ${String(grantsRead)}; CREATE TABLEs read: ${String(tablesRead)}; protected-object mentions: ${String(protectedMentions)}`,
);
console.log(
  `  merged migrations changed and compared outside comments: ${String(mergedCompared)}; contract migrations added: ${String(addedContracts.length)}; contract up files read for expand statements: ${String(contractsReadForExpand)}`,
);
finish(GATE, failures);
