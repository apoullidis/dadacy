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
 *                        marker that permits either. (T-186, OD-217) Also no statement that
 *                        switches off a protected trigger BY NAME: `DISABLE TRIGGER <name>` and
 *                        `ENABLE REPLICA TRIGGER <name>` (which fires it only under
 *                        session_replication_role = replica, i.e. never in normal operation), and
 *                        `ALTER EVENT TRIGGER <name> DISABLE | ENABLE REPLICA`, for every PROTECTED
 *                        entry marked `trigger`. R-PROTECTED's marker does not permit it either:
 *                        a reviewed change may replace a protected trigger, never switch it off.
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
 *   [R-VENDOR-SQL]       (T-167, OD-150) a `-- @vendor-sql: <body> — <reference>` marker is a `--`
 *                        comment in the HEADER of an up file, names a body that up file defines
 *                        exactly once, and cites a ticket or decision. It exempts THAT BODY, and
 *                        nothing else, from R-PHASE's contract-statement list and R-TABLE-GRANT,
 *                        because a migration that installs a vendor's plpgsql executes none of the
 *                        DDL inside it. It exempts no other rule, no other body and nothing at file
 *                        level, and it does not stop the gate READING bodies (T-031 § contract §4,
 *                        case A09). LIKE R-PROTECTED, THIS GATE CANNOT VERIFY THAT A REVIEW
 *                        HAPPENED: PROTOCOL §3's two-approval review of `db/migrations` is the
 *                        control, and every accepted marker is printed with the count of problems
 *                        it suppressed so that one suppressing nothing is visible.
 *   [R-TABLE-GRANT]      every CREATE TABLE in an up file is followed in the same file by a
 *                        GRANT on that table. There are no default privileges, so a table with
 *                        no grant is a table nobody can use (`T-020` contract §4/§6).
 *   [R-ROLE-SWITCH]      (T-031) no statement moves the migration off the role the runner set:
 *                        `SET [SESSION|LOCAL] ROLE`, `RESET ROLE`, `[RE]SET [SESSION|LOCAL]
 *                        SESSION AUTHORIZATION`, `session_authorization`, `DISCARD ALL`,
 *                        `set_config('role'|'session_authorization', …)`, read in `DO` and
 *                        function bodies and `EXECUTE` strings too; and no psql meta-command
 *                        (`\connect`, `\i`, `\gexec`, …), since the runner applies a file with
 *                        psql. `UPDATE … SET role =` assigns a column and is not read as one.
 *                        T-136 § contract §6: a file that leaves `SET ROLE app_ddl` continues as
 *                        the session user, the bootstrap superuser.
 *   [R-RUN-AS]           (T-031) every line the runner reads as `-- @run-as` (T-136 § contract
 *                        §7 reads LINES, not SQL) is a `--` comment in the header of an up file,
 *                        before the first statement, of the form `-- @run-as: bootstrap-superuser
 *                        — <reference>` citing a ticket or decision on that line; at most one per
 *                        file. A comment beginning `@run-as` that the runner does not read is
 *                        refused as well.
 *   [R-TRAILER]          (T-031, PROTOCOL §3) every commit in `merge-base..HEAD` that changes a
 *                        path under `db/migrations/` relative to its first parent (a merge commit
 *                        included) carries exactly one `Ticket: T-NNN` trailer, read with git's
 *                        trailer parser, `git log -1 --format='%(trailers:key=Ticket,valueonly)'`,
 *                        never by line position. Uncommitted files and commits already on the
 *                        base are not commits in that range and are not read.
 *   [R-MERGED]           a migration that exists at the base is never deleted and changes
 *                        ONLY IN ITS COMMENTS (PROTOCOL §3, OD-13). The comparison lexes the
 *                        SQL, so a `--` inside a dollar-quoted function body is part of the
 *                        body, not a comment. That body is stored in `pg_proc.prosrc` (OD-72).
 *                        (T-031, OD-86) A comment line the runner reads (`-- @run-as`,
 *                        `-- @no-transaction`, `-- @phase`) is not a null comment: the lines
 *                        matching the runner's pattern must be identical at the base and now.
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
  /** A trigger or event trigger: R-TRIGGER-BYPASS also refuses switching it off by name (T-186). */
  readonly trigger?: true;
}

const PROTECTED: readonly Protected[] = [
  {
    id: 'trg_booking_sitter_bookable',
    why: 'I-1; its WHEN clause fires only on transitions INTO confirmed/in_progress, so a live session is never re-evaluated (SD §UC-4 part 1, §DB-13 rule 7)',
    trigger: true,
  },
  { id: 'trg_booking_staffed_hours', why: 'SD §DB-13 rule 7', trigger: true },
  { id: 'assert_within_staffed_hours', why: 'SD §DB-13 rule 7' },
  {
    id: 'trg_int10_answering_service',
    why: 'the SA §INT-10 guard event trigger (T-020 contract §6)',
    trigger: true,
  },
  {
    id: 'assert_answering_service_write_only',
    why: 'the SA §INT-10 guard; a schema owner can drop it and install a no-op (OD-73)',
  },
  {
    id: 'trg_assert_answering_service_write_only',
    why: "the guard event trigger's function; DROP … CASCADE on it drops the event trigger (OD-73)",
  },
  {
    id: 'trg_approval_four_eyes',
    why: 'SA §SA-4 I-5, the four-eyes trigger on approval (T-030; OD-217, T-186)',
    trigger: true,
  },
  {
    id: 'assert_second_actor_differs',
    why: 'SA §SA-4 I-5 clauses (a) and (b), the function trg_approval_four_eyes calls; a no-op replacement silences it (T-030; OD-217, T-186)',
  },
  {
    id: 'trg_account_role_ts_senior_admin_only',
    why: 'SA §SA-4 I-5 / decisions.md OE-47: only app_admin_rw may write a ts_senior row (T-186)',
    trigger: true,
  },
  {
    id: 'assert_ts_senior_written_by_admin',
    why: 'decisions.md OE-47, the function trg_account_role_ts_senior_admin_only calls (T-186)',
  },
];

/** The protected triggers, upper-cased as the fragments are (R-TRIGGER-BYPASS, T-186). */
const PROTECTED_TRIGGERS: readonly string[] = PROTECTED.filter((p) => p.trigger === true).map((p) =>
  p.id.toUpperCase(),
);

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

/**
 * The marker lines `scripts/db-migrate.ts` acts on (T-136 § contract §7): whole lines matching
 * this pattern, read line by line and NOT through a SQL lexer, so such a line inside a string, a
 * dollar-quoted body or a block comment is read as a marker too (QA-A1).
 */
const RUNNER_MARKER_LINE = /^[ \t]*--[ \t]*@(?:run-as|no-transaction|phase)\b/;
const RUN_AS_LINE = /^[ \t]*--[ \t]*@run-as\b/;
const RUN_AS_FORM = /^[ \t]*--[ \t]*@run-as:[ \t]*bootstrap-superuser(?![A-Za-z0-9_-])(.*)$/;

/**
 * The reviewed vendor-SQL marker (R-VENDOR-SQL, T-167, OD-150).
 *
 * `-- @vendor-sql: <body> — <reference>` in the HEADER of an up file exempts the body it names,
 * AND NOTHING ELSE, from R-PHASE's contract-statement list and from R-TABLE-GRANT. It exists
 * because a migration that installs a vendor's plpgsql performs no DDL by installing it: the
 * `DROP TABLE` and `CREATE TABLE` the gate reads are `format()` format strings inside function
 * bodies, which the gate reads deliberately (T-031 § contract §4, case A09) and which this
 * marker does not stop it reading — it stops those two rules ACTING on what they read, inside
 * one named body.
 *
 * The marker line is read LINE BY LINE over the file text, like `-- @run-as`, not through the
 * lexer, so a line that looks like a marker inside a string or a body is read as one and
 * refused for its placement rather than quietly ignored.
 */
const VENDOR_SQL_LINE = /^[ \t]*--[ \t]*@vendor-sql\b/;
const VENDOR_SQL_FORM = /^[ \t]*--[ \t]*@vendor-sql:[ \t]*([^\s—]+)[ \t]*(.*)$/;

/**
 * Statements that move a migration off the role the runner set (R-ROLE-SWITCH, T-031). The
 * runner applies a file under `SET ROLE app_ddl`; a file that leaves it continues as the session
 * user, the bootstrap superuser (T-136 § contract §6, C6-BOUND). Matched against normalised
 * fragments, so `DO` bodies, function bodies and `EXECUTE` strings are read too.
 */
const ROLE_SWITCHES: readonly (readonly [RegExp, string])[] = [
  [/\bRESET (?:ROLE|SESSION AUTHORIZATION)\b/, 'RESET ROLE / RESET SESSION AUTHORIZATION'],
  [
    /\bSET (?:SESSION |LOCAL )?(?:ROLE|SESSION AUTHORIZATION)\b/,
    'SET ROLE / SET SESSION AUTHORIZATION',
  ],
  [/\bSESSION_AUTHORIZATION\b/, 'the session_authorization parameter'],
  [/\bDISCARD ALL\b/, 'DISCARD ALL, which runs SET SESSION AUTHORIZATION DEFAULT'],
];

/**
 * `SET role =` that assigns a COLUMN named role, which is not a role switch: `UPDATE t [*] [[AS] a]
 * SET role`, and `UPDATE SET role` in `ON CONFLICT … DO UPDATE` and `MERGE`. A fragment is one
 * statement, so this cannot exempt a `SET ROLE` in the next statement (CR0I).
 */
const UPDATE_SET_ROLE =
  /\bUPDATE (?:(?:ONLY )?[A-Z0-9_$.]+(?: ?\*)?(?: (?:AS )?[A-Z0-9_$]+)? )?SET ROLE\b/g;

const TICKET_ID = /^T-\d{3}$/;

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
export interface FragmentRead {
  /** The normalised statement fragments, exactly as every content rule reads them. */
  readonly texts: string[];
  /**
   * Parallel to `texts`: for each fragment, the designators of the vendor bodies enclosing it,
   * outermost first, or `[]` at the top level of the file. R-VENDOR-SQL is the only reader.
   */
  readonly bodies: string[][];
  /** Every body designator in the file, in source order. A repeat is an overload (T-167). */
  readonly bodyList: string[];
}

/**
 * A body's designator (T-167), taken from the statement text that precedes it:
 *   - `CREATE [OR REPLACE] FUNCTION|PROCEDURE <name>` -> `<name>` exactly as the file spells it,
 *     normalised (upper case, quotes dropped by the lexer, whitespace collapsed);
 *   - an anonymous `DO` block -> `DO#<n>`, the nth body of a `DO` in the file, counted in source
 *     order at any depth from 1. An anonymous block has no name, and the ordinal is the only
 *     handle that survives a comment edit and stops surviving when a `DO` is added or removed —
 *     which is exactly when the review the marker records has to happen again.
 */
const FUNCTION_BODY_HEAD = /\bCREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE) ([A-Z0-9_$.]+)/;
const DO_BODY_HEAD = /(?:^|\s)DO(?: LANGUAGE [A-Z0-9_$]+)?$/;

interface BodyCtx {
  doCount: number;
  readonly bodyList: string[];
}

export function readFragments(
  segments: readonly Segment[],
  chain: readonly string[] = [],
  ctx: BodyCtx = { doCount: 0, bodyList: [] },
  depth = 0,
): FragmentRead {
  const texts: string[] = [];
  const bodies: string[][] = [];
  let cur = '';
  const emit = (t: string, c: readonly string[]): void => {
    if (t === '') return;
    texts.push(t);
    bodies.push([...c]);
  };
  const push = (): void => {
    emit(norm(cur), chain);
    cur = '';
  };
  const raw = (s: string, c: readonly string[]): void => {
    for (const part of s.split(';')) emit(norm(part), c);
  };
  /** The chain for a body about to be descended into: `chain`, plus this body if it has a name. */
  const descend = (): readonly string[] => {
    const t = norm(cur);
    const fn = FUNCTION_BODY_HEAD.exec(t);
    let id: string | null = null;
    if (fn !== null) id = fn[1] ?? null;
    else if (DO_BODY_HEAD.test(t)) {
      ctx.doCount += 1;
      id = `DO#${String(ctx.doCount)}`;
    }
    if (id === null || id === '') return chain;
    ctx.bodyList.push(id);
    return [...chain, id];
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
      const inside = descend();
      cur += ' ';
      raw(s.body.replace(/''/g, "'"), inside);
    } else {
      const inside = descend();
      cur += ' ';
      const inner = depth < 8 ? lex(s.body) : null;
      if (inner !== null && inner.error === null) {
        const r = readFragments(inner.segments, inside, ctx, depth + 1);
        texts.push(...r.texts);
        bodies.push(...r.bodies);
      } else raw(s.body, inside);
    }
  }
  push();
  return { texts, bodies, bodyList: ctx.bodyList };
}

/** The fragments alone. One reading: this is `readFragments().texts` and nothing else. */
export function fragments(segments: readonly Segment[]): string[] {
  return readFragments(segments).texts;
}

function commentText(segments: readonly Segment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (s.kind === 'line-comment' || s.kind === 'block-comment') out.push(...s.body.split('\n'));
  }
  return out;
}

/**
 * The line of the first thing in the file that is neither a `--` comment nor whitespace: a
 * statement, a string, a dollar quote, a quoted identifier or a block comment. Every line before
 * it is the header. Infinity when the file is only `--` comments.
 */
function headerEndLine(segments: readonly Segment[]): number {
  for (const s of segments) {
    if (s.kind === 'line-comment') continue;
    if (s.kind === 'code') {
      const lead = /^\s*/.exec(s.text)?.[0] ?? '';
      if (lead.length === s.text.length) continue;
      return s.line + newlines(lead);
    }
    return s.line;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Every code, string and dollar segment at any depth, comments skipped: a dollar body is lexed
 * again as SQL (as `fragments()` does) and visited raw only if that lex fails. `next` is the next
 * segment at the same depth that is neither a comment nor whitespace-only code: the lexer leaves
 * the whitespace after a comment as a segment of its own, so `set_config(/* c *\/ 'role', …)` would
 * otherwise hide its string from the call (T-031 self-attack A11, case CR0M).
 */
function walk(
  segments: readonly Segment[],
  visit: (s: Segment, next: Segment | undefined) => void,
  depth = 0,
): void {
  const live = segments.filter(
    (s) =>
      s.kind !== 'line-comment' &&
      s.kind !== 'block-comment' &&
      !(s.kind === 'code' && s.text.trim() === ''),
  );
  live.forEach((s, k) => {
    if (s.kind === 'dollar' && depth < 8) {
      const inner = lex(s.body);
      if (inner.error === null) {
        walk(inner.segments, visit, depth + 1);
        return;
      }
    }
    visit(s, live[k + 1]);
  });
}

/** `set_config('role' | 'session_authorization', …)`, as a call or inside a string (R-ROLE-SWITCH). */
function setConfigOfRole(segments: readonly Segment[]): string[] {
  const hits: string[] = [];
  walk(segments, (s, next) => {
    if (
      s.kind === 'code' &&
      /\bset_config\s*\(\s*$/i.test(s.text) &&
      next?.kind === 'string' &&
      /^\s*(?:role|session_authorization)\s*$/i.test(next.body)
    ) {
      hits.push(`set_config(${next.text}, …)`);
    }
    if (
      (s.kind === 'string' || s.kind === 'dollar') &&
      /\bset_config\s*\(\s*'+\s*(?:role|session_authorization)\s*'+/i.test(s.body)
    ) {
      hits.push(`set_config inside ${snippet(s.body.trim())}`);
    }
  });
  return hits;
}

/**
 * psql meta-commands: a backslash in top-level code, which PostgreSQL's own grammar never contains
 * outside a literal (R-ROLE-SWITCH). The runner applies a file with psql (T-136 § contract §1).
 */
function psqlMetaCommands(segments: readonly Segment[]): string[] {
  const hits: string[] = [];
  for (const s of segments) {
    if (s.kind !== 'code') continue;
    const at = s.text.indexOf('\\');
    if (at === -1) continue;
    const lineText = s.text.slice(at).split('\n')[0] ?? '';
    hits.push(
      `line ${String(s.line + newlines(s.text.slice(0, at)))}: ${snippet(lineText.trim())}`,
    );
  }
  return hits;
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
  /** The file as read, for the rules that read lines the way the runner does. */
  readonly text: string;
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
  const text = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  const lexed = lex(text);
  if (lexed.error !== null)
    problem('R-LEX', rel, `${lexed.error}; nothing in this file was checked`);
  migrations.push({
    name,
    rel,
    num: m[1] ?? '',
    slug: m[2] ?? '',
    dir: m[3] === 'up' ? 'up' : 'down',
    text,
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

// ---- R-TRAILER (T-031) ----------------------------------------------------

let commitsRead = 0;
let migrationCommits = 0;
if (mergeBase !== '') {
  const revs = git(['rev-list', '--reverse', `${mergeBase}..HEAD`]);
  if (!revs.ok) {
    problem(
      'R-BASE',
      baseRef,
      `git rev-list ${mergeBase.slice(0, 12)}..HEAD failed (${revs.err || 'no output'}); the commits are unknown`,
    );
  } else {
    for (const sha of revs.out.split('\n').filter((l) => l !== '')) {
      commitsRead += 1;
      const where = `commit ${sha.slice(0, 12)}`;
      const parents = git(['log', '-1', '--format=%P', sha]);
      const first = parents.out.trim().split(' ')[0] ?? '';
      const touched = !parents.ok
        ? parents
        : first === ''
          ? git([
              'diff-tree',
              '--root',
              '--no-commit-id',
              '--name-only',
              '-r',
              sha,
              '--',
              MIGRATIONS_REL,
            ])
          : git(['diff', '--name-only', '--no-renames', first, sha, '--', MIGRATIONS_REL]);
      if (!touched.ok) {
        problem(
          'R-BASE',
          where,
          `cannot list the paths it changes (${touched.err || 'no output'})`,
        );
        continue;
      }
      const paths = touched.out.split('\n').filter((l) => l !== '');
      if (paths.length === 0) continue;
      migrationCommits += 1;
      const shown =
        paths.slice(0, 3).join(', ') +
        (paths.length > 3 ? `, and ${String(paths.length - 3)} more` : '');
      const trailers = git(['log', '-1', '--format=%(trailers:key=Ticket,valueonly)', sha]);
      if (!trailers.ok) {
        problem('R-TRAILER', where, `git could not read its trailers (${trailers.err})`);
        continue;
      }
      const values = trailers.out
        .split('\n')
        .map((v) => v.trim())
        .filter((v) => v !== '');
      if (values.length === 0) {
        problem(
          'R-TRAILER',
          where,
          `changes ${shown} and git's trailer parser finds no Ticket trailer (git log -1 --format='%(trailers:key=Ticket,valueonly)'); a Ticket line counts only inside the message's final trailer block (PROTOCOL §3)`,
        );
      } else if (values.length > 1) {
        problem(
          'R-TRAILER',
          where,
          `changes ${shown} and carries ${String(values.length)} Ticket trailers (${values.join(', ')}); a migration commit names exactly one ticket`,
        );
      } else if (!TICKET_ID.test(values[0] ?? '')) {
        problem(
          'R-TRAILER',
          where,
          `changes ${shown} and its Ticket trailer ${snippet(values[0] ?? '')} is not a ticket id T-NNN`,
        );
      }
    }
  }
}

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
let runAsLinesRead = 0;
let roleSwitchFilesRead = 0;
let vendorLinesRead = 0;

/**
 * The review record (T-167). One row per ACCEPTED `-- @vendor-sql` marker, printed on every run
 * — `gate:pr` included — so that a marker which suppresses nothing is visible rather than silent
 * (PROTOCOL §5.1: if the check did nothing, it says so). No separate registry file: a registry
 * derived from the same source as the thing it records cannot disagree with it.
 */
interface VendorExemption {
  readonly rel: string;
  readonly body: string;
  readonly line: number;
  readonly suppressed: string[];
}
const vendorExemptions: VendorExemption[] = [];

for (const m of migrations) {
  if (m.lexed.error !== null) continue;
  const segs = m.lexed.segments;
  const comments = commentText(segs);
  /** Body designator -> the marker line that named it, for the markers this file declares. */
  const vendorDeclared = new Map<string, number>();

  // R-RUN-AS (T-031). Every file, the baseline included: the runner reads LINES (T-136 § contract §7).
  {
    const lines = m.text.split('\n');
    const headerEnd = headerEndLine(segs);
    const commentLines = new Set(segs.filter((s) => s.kind === 'line-comment').map((s) => s.line));
    let read = 0;
    lines.forEach((line, k) => {
      if (!RUN_AS_LINE.test(line)) return;
      const at = k + 1;
      read += 1;
      runAsLinesRead += 1;
      const where = `${m.rel}:${String(at)}`;
      if (at >= headerEnd || !commentLines.has(at)) {
        problem(
          'R-RUN-AS',
          where,
          `the runner reads this line as a -- @run-as marker and would apply the whole file as the bootstrap superuser, but it is not a -- comment in the file header (before the first statement, outside every string, dollar-quoted body and block comment): ${snippet(line.trim())}`,
        );
      } else if (m.dir === 'down') {
        problem(
          'R-RUN-AS',
          where,
          'a -- @run-as marker in a down file; a down file runs as its up file does, and the runner refuses a marker here (T-136 § contract §6)',
        );
      } else {
        // `.` does not match `\r`, so a CRLF line is matched without it (self-attack A15, CMC4).
        const form = RUN_AS_FORM.exec(line.replace(/\r$/, ''));
        if (form === null) {
          problem(
            'R-RUN-AS',
            where,
            `not of the form \`-- @run-as: bootstrap-superuser — <reference>\`: ${snippet(line.trim())}`,
          );
        } else if (!REFERENCE.test(form[1] ?? '')) {
          problem(
            'R-RUN-AS',
            where,
            'the -- @run-as marker cites no ticket or decision (T-NNN, OE-n, OD-n, EV-n, SQ-n) on its own line',
          );
        }
      }
    });
    if (read > 1) {
      problem(
        'R-RUN-AS',
        m.rel,
        `${String(read)} lines the runner reads as -- @run-as markers; a migration carries at most one`,
      );
    }
    for (const s of segs) {
      if (s.kind !== 'line-comment' && s.kind !== 'block-comment') continue;
      s.body.split('\n').forEach((b, k) => {
        if (!/^\s*@run-as\b/.test(b)) return;
        const at = s.line + k;
        if (s.kind === 'line-comment' && RUN_AS_LINE.test(lines[at - 1] ?? '')) return; // read above
        problem(
          'R-RUN-AS',
          `${m.rel}:${String(at)}`,
          `a comment beginning @run-as that the runner does not read (it reads only a whole -- line), so the file would run as app_ddl: ${snippet(b.trim())}`,
        );
      });
    }
  }

  // R-VENDOR-SQL (T-167, OD-150), part 1: the marker lines themselves — placement and form.
  // Read for EVERY file, the baseline and the down files included, so that a marker which could
  // not possibly do anything is refused rather than left standing as a claim a reviewer would
  // read. Part 2, below, resolves the names against the bodies the file actually defines.
  {
    const lines = m.text.split('\n');
    const headerEnd = headerEndLine(segs);
    const commentLines = new Set(segs.filter((s) => s.kind === 'line-comment').map((s) => s.line));
    lines.forEach((line, k) => {
      if (!VENDOR_SQL_LINE.test(line)) return;
      const at = k + 1;
      vendorLinesRead += 1;
      const where = `${m.rel}:${String(at)}`;
      if (at >= headerEnd || !commentLines.has(at)) {
        problem(
          'R-VENDOR-SQL',
          where,
          `a -- @vendor-sql marker that is not a -- comment in the file header (before the first statement, outside every string, dollar-quoted body and block comment). The marker names the body it exempts, so it may not sit inside one: a reviewer reads the whole exemption list at the top of the file, and the vendor SQL below it stays byte-identical to what the vendor emitted: ${snippet(line.trim())}`,
        );
        return;
      }
      if (m.dir === 'down') {
        problem(
          'R-VENDOR-SQL',
          where,
          'a -- @vendor-sql marker in a down file; R-PHASE and R-TABLE-GRANT read up files only, so this marker exempts nothing and states a review that nothing checks',
        );
        return;
      }
      if (BASELINE.has(m.name)) {
        problem(
          'R-VENDOR-SQL',
          where,
          'a -- @vendor-sql marker in the pinned 0001 baseline, whose content rules are not read at all (R-BASELINE); the marker exempts nothing',
        );
        return;
      }
      // `.` does not match `\r`, so a CRLF line is matched without it (as R-RUN-AS does).
      const form = VENDOR_SQL_FORM.exec(line.replace(/\r$/, ''));
      if (form === null) {
        problem(
          'R-VENDOR-SQL',
          where,
          `not of the form \`-- @vendor-sql: <function> — <reference>\`: ${snippet(line.trim())}`,
        );
        return;
      }
      const body = norm(form[1] ?? '');
      if (!REFERENCE.test(form[2] ?? '')) {
        problem(
          'R-VENDOR-SQL',
          where,
          `the -- @vendor-sql marker for ${body} cites no ticket or decision (T-NNN, OE-n, OD-n, EV-n, SQ-n) on its own line; an exemption with no reference records no review`,
        );
        return;
      }
      if (vendorDeclared.has(body)) {
        problem(
          'R-VENDOR-SQL',
          where,
          `a second -- @vendor-sql marker for ${body}; line ${String(vendorDeclared.get(body) ?? 0)} already names it, and the list of markers is the list of bodies a reviewer must read`,
        );
        return;
      }
      vendorDeclared.set(body, at);
    });
    for (const s of segs) {
      if (s.kind !== 'line-comment' && s.kind !== 'block-comment') continue;
      s.body.split('\n').forEach((b, k) => {
        if (!/^\s*@vendor-sql\b/.test(b)) return;
        const at = s.line + k;
        if (s.kind === 'line-comment' && VENDOR_SQL_LINE.test(lines[at - 1] ?? '')) return; // read above
        problem(
          'R-VENDOR-SQL',
          `${m.rel}:${String(at)}`,
          `a comment beginning @vendor-sql that this gate does not read as a marker (it reads only a whole -- line in the header), so it exempts nothing: ${snippet(b.trim())}`,
        );
      });
    }
  }

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

  const read = readFragments(segs);
  const frags = read.texts;

  // R-VENDOR-SQL (T-167, OD-150), part 2: resolve each declared marker against the bodies this
  // file defines. `exempt` is consulted at exactly two places — R-PHASE's contract-statement scan
  // and R-TABLE-GRANT — so no other rule can be reached through this marker.
  const exempt = new Set<string>();
  const suppressedBy = new Map<string, string[]>();
  for (const [body, at] of vendorDeclared) {
    const defined = read.bodyList.filter((b) => b === body).length;
    if (defined === 0) {
      problem(
        'R-VENDOR-SQL',
        `${m.rel}:${String(at)}`,
        `the -- @vendor-sql marker names ${body}, which this file does not define. The bodies it defines are: ${read.bodyList.length === 0 ? '(none)' : [...new Set(read.bodyList)].join(', ')}. Name a function exactly as its CREATE statement spells it, or an anonymous DO block as DO#<n>`,
      );
      continue;
    }
    if (defined > 1) {
      problem(
        'R-VENDOR-SQL',
        `${m.rel}:${String(at)}`,
        `the -- @vendor-sql marker names ${body}, which this file defines ${String(defined)} times; this gate does not read argument types, so it cannot tell which body was reviewed, and exempting both would exempt a body nobody named`,
      );
      continue;
    }
    exempt.add(body);
    suppressedBy.set(body, []);
  }
  /** Fragment `i` sits inside an exempted body. */
  const exemptAt = (i: number, tag: string): boolean => {
    const hit = (read.bodies[i] ?? []).find((b) => exempt.has(b));
    if (hit === undefined) return false;
    suppressedBy.get(hit)?.push(tag);
    return true;
  };
  for (const [body, at] of vendorDeclared) {
    if (exempt.has(body)) {
      vendorExemptions.push({
        rel: m.rel,
        body,
        line: at,
        suppressed: suppressedBy.get(body) ?? [],
      });
    }
  }

  // R-ROLE-SWITCH (T-031).
  roleSwitchFilesRead += 1;
  for (const f of frags) {
    const read = f.replace(UPDATE_SET_ROLE, (x) => x.replace(/SET ROLE$/, 'SET <COLUMN>'));
    const hit = ROLE_SWITCHES.find(([re]) => re.test(read));
    if (hit !== undefined) {
      problem(
        'R-ROLE-SWITCH',
        m.rel,
        `${hit[1]}: the runner applies a migration under SET ROLE app_ddl, and a file that switches role continues as the session user, the bootstrap superuser (T-136 § contract §6); a superuser migration says so with -- @run-as in its header instead: ${snippet(f)}`,
      );
    }
  }
  for (const hit of setConfigOfRole(segs)) {
    problem(
      'R-ROLE-SWITCH',
      m.rel,
      `${hit} sets the role or session user the way SET ROLE does (T-136 § contract §6)`,
    );
  }
  for (const hit of psqlMetaCommands(segs)) {
    problem(
      'R-ROLE-SWITCH',
      m.rel,
      `a psql meta-command (${hit}). The runner applies a migration with psql, so \\connect changes the session user, and \\i, \\ir and \\gexec run SQL this gate never reads; a migration holds SQL only`,
    );
  }

  // R-PHASE: contract statements outside a contract migration.
  if (m.dir === 'up' && phaseOf.has(m.name) && phaseOf.get(m.name) !== 'contract') {
    frags.forEach((f, i) => {
      for (const [re, label] of CONTRACT_STATEMENTS) {
        if (re.test(f)) {
          if (exemptAt(i, 'R-PHASE')) continue;
          problem(
            'R-PHASE',
            m.rel,
            `declared @phase ${phaseOf.get(m.name) ?? ''} but contains a contract statement (${label}): ${snippet(f)}`,
          );
        }
      }
    });
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
    // (T-186, OD-217) A protected trigger switched off by NAME. No marker permits it.
    for (const t of PROTECTED_TRIGGERS) {
      const name = `${t}(?![A-Z0-9_$])`;
      if (
        new RegExp(`\\b(?:DISABLE|ENABLE REPLICA) TRIGGER ${name}`).test(f) ||
        new RegExp(`\\bALTER EVENT TRIGGER ${name} (?:DISABLE|ENABLE REPLICA)\\b`).test(f)
      ) {
        problem(
          'R-TRIGGER-BYPASS',
          m.rel,
          `switches off the protected trigger ${t.toLowerCase()} by name; a reviewed migration may replace a protected trigger (R-PROTECTED's marker), never switch it off: ${snippet(f)}`,
        );
      }
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
    frags.forEach((f, i) => {
      const c =
        /\bCREATE (?:(?:GLOBAL |LOCAL )?(?:TEMP|TEMPORARY) |UNLOGGED )?TABLE (?:IF NOT EXISTS )?([A-Z0-9_$.]+)/.exec(
          f,
        );
      if (c === null || /\bCREATE (?:GLOBAL |LOCAL )?TEMP/.test(f)) return;
      tablesRead += 1;
      const name = bareName(c[1] ?? '');
      if (!grantedTables.has(name)) {
        if (exemptAt(i, 'R-TABLE-GRANT')) return;
        problem(
          'R-TABLE-GRANT',
          m.rel,
          `CREATE TABLE ${name} with no GRANT on it in this file; there are no default privileges, so nobody can use it (T-020 contract §4)`,
        );
      }
    });
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
  // T-031, OD-86: the runner acts on these comment lines, so changing one is not a null edit.
  const markerLines = (text: string): string =>
    text
      .split('\n')
      .filter((l) => RUNNER_MARKER_LINE.test(l))
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n');
  const markersWere = markerLines(baseText.out);
  const markersNow = markerLines(head.text);
  if (markersWere !== markersNow) {
    problem(
      'R-MERGED',
      c.path,
      `a line the migration runner reads (-- @run-as, -- @no-transaction, -- @phase; T-136 § contract §6–§7) was added, removed or changed. It is a comment to PostgreSQL and an instruction to the runner, so the edit is not null (OD-86): was ${snippet(markersWere || '(none)')}, now ${snippet(markersNow || '(none)')}`,
    );
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
console.log(
  `  files searched for role switches: ${String(roleSwitchFilesRead)}; lines the runner reads as -- @run-as: ${String(runAsLinesRead)}`,
);
console.log(
  `  -- @vendor-sql marker lines read: ${String(vendorLinesRead)}; bodies exempted: ${String(vendorExemptions.length)}; R-PHASE/R-TABLE-GRANT problems they suppressed: ${String(vendorExemptions.reduce((n, v) => n + v.suppressed.length, 0))}`,
);
for (const v of vendorExemptions) {
  const tags = v.suppressed.length === 0 ? 'nothing' : [...v.suppressed].sort().join(', ');
  console.log(
    `    vendor-sql: ${v.rel}:${String(v.line)} exempts body ${v.body} — suppressed ${tags}`,
  );
}
console.log(
  `  commits in merge-base..HEAD: ${String(commitsRead)}; of them changing ${MIGRATIONS_REL}/, Ticket trailer read with git's parser: ${String(migrationCommits)}`,
);
finish(GATE, failures);
