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
 *   THE PROTECTED-OBJECT RULES (R-PROTECTED, R-TRIGGER-BYPASS, R-PROTECTED-RENAME, R-PROTECTED-TABLE,
 *   R-PROTECTED-EXTENSION) READ POSTGRESQL'S OWN PARSE OF EACH STATEMENT since T-229 (OD-240), not
 *   the normalised text the other rules read, to a nesting depth of 8; deeper fails closed (R-PARSE):
 *   see "HOW THE SQL IS READ" and lib/sql-ast.ts. A name is
 *   compared as PostgreSQL resolves its spelling (quotes, `U&"…"` with or without `UESCAPE`, comments
 *   anywhere, whitespace around a `.`), case-insensitively (a false FAIL, never a false PASS).
 *   [R-PROTECTED]        a migration that names a protected object carries
 *                        `-- @compliance-review: <object> — <reference>`, where the reference
 *                        cites a ticket or a decision. SD §DB-13 rule 7 and §UC-4 part 1
 *                        protect the booking triggers; `T-020` contract §6 adds the INT-10
 *                        guard. "Names" is: an identifier in any parsed statement equal to the
 *                        object's name, or the name as a word inside any string in the parse (a
 *                        constant, so a `format()` argument or a concatenated piece counts; a
 *                        `COMMENT ON` text). THIS GATE CANNOT
 *                        VERIFY THAT A REVIEW HAPPENED. The marker makes the change declared, and
 *                        PROTOCOL §3's two-approval review of `db/migrations` is the control.
 *   [R-TRIGGER-BYPASS]   no `ALTER TABLE … DISABLE TRIGGER ALL|USER`, no `session_replication_role`
 *                        named anywhere in the parse (`SET`, `RESET`, a role's, database's or
 *                        function's `SET`, any string: `set_config('session_replication_role', …)`,
 *                        `U&'…'` decoded). Both switch
 *                        protected triggers off without naming them. (T-186, OD-217) Also no
 *                        `ALTER TABLE … DISABLE TRIGGER <name>` or `ENABLE REPLICA TRIGGER <name>`
 *                        (fires only under session_replication_role = replica, i.e. never in normal
 *                        operation), and no `ALTER EVENT TRIGGER <name> DISABLE | ENABLE REPLICA`, for
 *                        every PROTECTED entry marked `trigger`. No marker permits any of these: a
 *                        reviewed change may replace a protected trigger, never switch it off.
 *   [R-PROTECTED-RENAME] (T-192, OD-224 A2) no RENAME statement (`ALTER TRIGGER|FUNCTION|ROUTINE|
 *                        PROCEDURE|EVENT TRIGGER|TABLE|… RENAME [COLUMN|CONSTRAINT] … TO`) names a
 *                        protected object, as the old name or the new. A protected trigger or function
 *                        renamed away can then be disabled or no-op-replaced under a name no rule
 *                        protects, in the same marked file or a later unmarked one (T-186 QA X5, X6 →
 *                        X8, X9). R-PROTECTED's marker does not permit it.
 *   [R-ADMIN-MEMBERSHIP] (T-192, OD-224 A3) no migration confers membership in app_admin_rw: the role
 *                        granted to anyone (`GRANT app_admin_rw TO …`), `CREATE ROLE|USER|GROUP`
 *                        naming it (`IN ROLE app_admin_rw`, `ADMIN app_admin_rw`), or `ALTER
 *                        ROLE|USER|GROUP app_admin_rw` (`ADD USER` included). OE-47 and OE-48 (as
 *                        narrowed by OE-57 and OE-58) admit only app_admin_rw's privileges to write a
 *                        ts_senior row or to change a ts_senior holder's account other than towards
 *                        less eligibility (activation and lifting a suspension included), so `GRANT app_admin_rw TO app_rw`
 *                        would admit every app_rw login (T-186 QA X10, X11, P10); since 0011 the
 *                        database refuses such a writer acting as itself (it also holds app_rw's
 *                        privileges), but not after `SET ROLE app_admin_rw` (T-192 QA-A1, P10f),
 *                        and this rule refuses the migration that would try. Login principals are created outside migrations
 *                        (T-020 § contract §3). Privileges granted TO app_admin_rw are not read here.
 *   [R-PROTECTED-TABLE]  (T-227, OD-237 TL-2; T-229, QA-C4) the three tables I-5's protected functions
 *                        read by name — `account`, `account_role`, `approval`, unqualified or in `public`
 *                        — are never renamed away (a RENAME of a relation, whatever kind the statement
 *                        says: `ALTER TABLE|INDEX|SEQUENCE|VIEW|MATERIALIZED VIEW|FOREIGN TABLE <name>
 *                        RENAME TO`, since PostgreSQL renames a TABLE through `ALTER INDEX`), moved
 *                        out of `public` (`… SET SCHEMA`, any kind), or replaced by a relation renamed
 *                        or created under the name: no relation is renamed TO one of those
 *                        names, the schema `public` is not renamed, and no migration but the one that
 *                        created it (`0005`, `0007`) creates a relation of that name (`CREATE TABLE`,
 *                        `… AS`, `… PARTITION OF`, `CREATE [MATERIALIZED] VIEW`, `CREATE FOREIGN TABLE`,
 *                        `SELECT … INTO`), temporary or not. Renamed away, the protected triggers stay on
 *                        the old table while `assert_second_actor_differs()` reads a replacement under
 *                        the old name (T-192 tech-lead RT2: an app_rw countersignature by a no-role
 *                        account was stored). No marker permits it. A RENAME of a column, constraint or
 *                        trigger ON those tables is not this rule's. `DROP TABLE` of one is not refused
 *                        (T-186 QA X2/X3, disclosed): it removes the table with its triggers. NOT READ
 *                        (T-229 tech-lead review TL-2): a relation of one of the names moved INTO
 *                        `public` from another schema (`ALTER TABLE <s>.account_role SET SCHEMA public`,
 *                        after that DROP) is refused by no rule (CZ4N pins it as PASS); an app_ddl login
 *                        cannot stage it, since `public` is the only schema it may create in (T-229
 *                        TL-DB2), so it needs a `-- @run-as` migration, which two-approval review reads.
 *   [R-PROTECTED-EXTENSION] (T-227, OD-235) no protected object is made removable by DROP EXTENSION:
 *                        `… DEPENDS ON EXTENSION` (not `NO DEPENDS`) whose object is a protected object
 *                        or one of the three tables, and `ALTER EXTENSION … ADD` of a protected object or
 *                        one of the three tables. Step 2, `DROP EXTENSION`, names nothing protected
 *                        (T-192 QA N17/N18r, DEP1: the two removed trg_approval_four_eyes). `ADD SCHEMA
 *                        public` and `ADD TYPE` are not refused (T-227 QA E9: PostgreSQL refuses the
 *                        first; E10: the later DROP EXTENSION fails closed). No marker permits it.
 *   [R-PARSE]            (T-229) a migration file, a DO body or a `sql`/`plpgsql` function body that
 *                        PostgreSQL's parser (libpg_query 18.1.5) refuses. PostgreSQL would refuse it
 *                        too (T-229 block DB2), and the protected-object rules cannot read what does
 *                        not parse, so it fails closed. psql meta-commands are blanked first (psql
 *                        consumes them; R-ROLE-SWITCH refuses every one). A string constant that does
 *                        not parse is not SQL, not a failure. And (T-229 rework 1, tech-lead TL-1;
 *                        rework 2, QA delta QD-3) any text nested deeper than 8 (MAX_DEPTH: each
 *                        DO/function body, PL/pgSQL expression and string constant is a level, so the
 *                        constant EXECUTEd inside a third nested DO/EXECUTE is at 9): a body, a
 *                        statement, a PL/pgSQL expression, or a string constant with or without a
 *                        letter, past 8 is not read and fails closed, with the reason "this gate reads
 *                        PostgreSQL's parse to a nesting depth of 8" (CZ40-CZ43, CZ47, CZ49, CZ4C-CZ4E,
 *                        CZ4G, CZ4I); at exactly 8 it is read (CZ45, CZ46, CZ48, CZ4A, CZ4F, CZ4H). The
 *                        summary counts these apart from parse failures (CZ4K, CZ4L).
 *   [R-CASCADE]          no `DROP … CASCADE` and no `DROP OWNED`. Both remove objects the statement does not
 *                        name, and no rule that reads names can see what it removed:
 *                        `DROP FUNCTION assert_sitter_bookable() CASCADE` takes
 *                        `trg_booking_sitter_bookable` with it, and OD-73's A5 removed the INT-10
 *                        event trigger that way. Write each drop out. No marker permits it.
 *   [R-RULE]             (T-237, T-234 tech-lead TL-5 (c)) no `CREATE [OR REPLACE] RULE`, at any depth (a
 *                        `DO` or function body, an `EXECUTE` string) and in a down file too. A rewrite rule
 *                        changes what a write does without a trigger, a grant or a constraint, so a refusal
 *                        test sees it only if it swallows that test's own write (T-196 QA2-F1). No marker
 *                        permits it. The database-side half is db-testkit's `rewrite-rules` suite, which
 *                        refuses any rule in the application schemas after every migration has run. A view's
 *                        own `_RETURN` rule comes from `CREATE VIEW` and is not this rule's; `DROP RULE` and
 *                        `ALTER RULE … RENAME` are not refused. An escape string (`E'CREATE\\nRULE …'`,
 *                        `\\x52`, octal, `\\u0052`) is decoded before it is read (rework 1, QA-F3). Like every
 *                        rule here, a statement assembled from pieces at run time (`format()` with the
 *                        keyword as an argument, concatenation) is not read as one, and a `U&'…'` string
 *                        constant is not decoded. Any text that spells `CREATE RULE`, a `COMMENT ON`
 *                        string included, is refused: a false refusal, never a false pass (QA-O2).
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
 *                        ONE exception, and only for PUBLIC: R-RESTORE-PUBLIC below (T-241).
 *   [R-RESTORE-PUBLIC]   (T-241, OE-76, OD-275) a `-- @restore-public: <reference>` marker is a `--`
 *                        comment in the HEADER of a DOWN file `NNNN_slug.down.sql` whose paired
 *                        `NNNN_slug.up.sql` exists, at most one per file, citing a ticket or decision.
 *                        It admits, in that down file only, a plain top-level statement
 *                        `GRANT <privileges> ON FUNCTION|PROCEDURE|ROUTINE <signature>[, …] TO PUBLIC`
 *                        (no WITH GRANT OPTION, no GRANTED BY, no other grantee) when EVERY (object,
 *                        privilege) pair in it NAMES a pair revoked FROM PUBLIC by a plain top-level REVOKE in
 *                        the paired up file (not `REVOKE GRANT OPTION FOR`). Names are compared as PostgreSQL
 *                        resolves them: unquoted folded to lower case (ASCII only), quoted exact, `U&"…"`
 *                        decoded, comments separating tokens; the object kind, the schema qualification,
 *                        the argument types and the privilege are compared as spelled, and every routine in
 *                        the GRANT must be schema-qualified (search_path, A1). The comparison is of NAMES,
 *                        not objects, so (rework 1, QA F1) a name is kept pointing at the revoked routine:
 *                        the marked down file holds nothing but GRANT and REVOKE statements, and its up
 *                        file holds no RENAME, SET SCHEMA, CREATE|DROP FUNCTION|PROCEDURE|ROUTINE|SCHEMA|
 *                        EXTENSION, ALTER SCHEMA|EXTENSION or search_path (dynamic SQL read). Anything else that
 *                        grants to PUBLIC is refused by R-ANSWERING-SERVICE exactly as before, with the
 *                        marker's reason appended. It never admits a grant to answering_service. THIS GATE
 *                        CANNOT SEE whether PUBLIC held the privilege before the up file ran: a down file
 *                        that "restores" a privilege PUBLIC never had is admitted, a built-in PUBLIC never
 *                        held included, given a no-op REVOKE in the up (QA O2). Argument types are compared
 *                        as tokens, unresolved: a quoted keyword type `"bigint"` compares equal to `bigint`,
 *                        which PostgreSQL resolves differently (QA O1). The review behind the
 *                        reference, and PROTOCOL §3's two approvals, are that control. Every accepted marker
 *                        is printed with what it admitted.
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
 * as raw text, because it may be dynamic SQL passed to EXECUTE; an `E'…'` escape string is first
 * decoded as PostgreSQL decodes it (T-237 rework 1, QA-F3, `decodeEscapeString`). Errors in either direction
 * produce a false FAIL, never a false PASS.
 *
 * (T-227, OD-235; T-229, QA-C3) A Unicode-escaped identifier, `U&"…"` with an optional `UESCAPE '<c>'`,
 * is decoded for the other rules' text as PostgreSQL decodes it (`\XXXX`, `\+XXXXXX`, a doubled escape
 * character), at the top level, in a dollar body and inside a string literal, with comments and
 * whitespace allowed on either side of UESCAPE (in a string literal, a nested block comment there is not
 * matched). A malformed escape is left as written; PostgreSQL refuses it at apply time.
 *
 * (T-229, OD-240) THE PROTECTED-OBJECT RULES read PostgreSQL's parse instead (lib/sql-ast.ts, libpg_query
 * 18.1.5, PostgreSQL 18's grammar compiled to WebAssembly): every statement of the file; every statement
 * of a DO body and of a `plpgsql` or `sql` function body, nested within one another; every expression of
 * a PL/pgSQL body (`EXECUTE`'s argument, an assignment, a `DECLARE` default, `PERFORM`, a condition); and
 * every string constant in those (`'…'`, `E'…'`, `U&'…'`, `$q$…$q$`) that parses as SQL; all of it to a
 * nesting depth of 8; deeper fails closed (R-PARSE). Each DO/function body, PL/pgSQL expression and string
 * constant is a level (MAX_DEPTH), so the constant EXECUTEd inside a third nested DO/EXECUTE is past it
 * (T-229 tech-lead review TL-1: until rework 1 such a constant was skipped silently). Comments are blanked
 * with PostgreSQL's own scanner before each parse, because libpg_query's scanner, unlike the server's,
 * hands a comment to the grammar's lookahead and so refuses `U&"…" /* c *\/ UESCAPE '!'` (T-229 probe2).
 * The rules are entries of AST_RULES (and R-PROTECTED's marker check); measured over the 387 cases this
 * suite had and 128 QA plants of OD-217/224/235/240, this reading refuses everything the text reading did
 * (T-229 § Evidence, the measurement), over those corpora; the tech-lead review's D3/D3n/D4b/D3rc, outside
 * them, were refused by the text reading and passed until rework 1 made nesting deeper than 8 fail closed.
 *
 * WHAT THIS GATE DOES NOT SEE. SQL assembled at run time from pieces (`format('GRANT %s ON %I', …)`,
 * `EXECUTE 'DROP TRIGGER ' || name`) is not read as the statement it becomes, by the parser or the text
 * rules: each constant is parsed on its own and a fragment is not a statement (cases CZ26, CZ27 pin it).
 * R-PROTECTED still requires the marker when the protected name is one of the constants. A body in a
 * language other than `plpgsql` or `sql` is not read. Names are resolved as spelt, never against a
 * catalogue or a search_path. R-PROTECTED-TABLE names three tables and no others: `booking`, whose
 * triggers SD §DB-13 rule 7 protects, does not exist yet and is not on its list. R-PROTECTED-TABLE does
 * not refuse a relation of a protected name moved INTO `public` by `SET SCHEMA` (T-229 TL-2; CZ4N). For
 * the rules that are not protected-object rules a `U&'…'` STRING constant is still not decoded. It is a
 * static check over source text and it proves nothing about a database. The database-side refusals are
 * `0001`'s guard and the constraint suites.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, capture, finish } from './lib/run.ts';
import { SCHEMA_REL, verifySchemaFile } from './lib/schema-digest.ts';
import {
  type AstStmt,
  MAX_DEPTH,
  allStrings,
  identifiers,
  isObj,
  nameList,
  rangeVar,
  readSqlAst,
  str,
  walkStmt,
} from './lib/sql-ast.ts';

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
    why: 'decisions.md OE-47, the function trg_account_role_ts_senior_admin_only and trg_account_role_ts_senior_no_truncate call (T-186, T-192)',
  },
  {
    id: 'trg_account_role_ts_senior_no_truncate',
    why: 'decisions.md OD-224 A4: TRUNCATE account_role refused while it holds a ts_senior row (T-192)',
    trigger: true,
  },
  {
    id: 'trg_account_ts_senior_status_admin_only',
    why: "SA §SA-4 I-5 / decisions.md OE-48, OE-57, OE-58: app_rw may only move a ts_senior holder towards less eligibility; activation, lifting a suspension, dob_verified_18 to true and id are app_admin_rw's (T-192)",
    trigger: true,
  },
  {
    id: 'assert_ts_senior_account_written_by_admin',
    why: 'decisions.md OE-48, the function trg_account_ts_senior_status_admin_only calls (T-192)',
  },
];

/**
 * (T-227, OD-237 TL-2) The tables I-5's protected functions read by name, and the migration that
 * created each (R-PROTECTED-TABLE). `assert_second_actor_differs()` reads `public.account_role` and
 * `public.account`; the four-eyes trigger sits on `public.approval`.
 */
const PROTECTED_TABLES: readonly { readonly name: string; readonly createdBy: string }[] = [
  { name: 'ACCOUNT', createdBy: '0005' },
  { name: 'ACCOUNT_ROLE', createdBy: '0005' },
  { name: 'APPROVAL', createdBy: '0007' },
];
// ---------------------------------------------------------------------------
// The protected-object rules, read through PostgreSQL's parser (T-229, OD-240)
// ---------------------------------------------------------------------------

const lc = (s: string): string => s.toLowerCase();
const PROTECTED_IDS: ReadonlySet<string> = new Set(PROTECTED.map((p) => p.id));
const PROTECTED_TRIGGER_IDS: ReadonlySet<string> = new Set(
  PROTECTED.filter((p) => p.trigger === true).map((p) => p.id),
);
/** Relation kinds a RENAME, SET SCHEMA or DEPENDS ON EXTENSION can name: PostgreSQL renames whatever relation `ALTER INDEX|SEQUENCE|VIEW … RENAME` names (QA-C4). */
const RELATION_OBJECTS: ReadonlySet<string> = new Set([
  'OBJECT_TABLE',
  'OBJECT_INDEX',
  'OBJECT_SEQUENCE',
  'OBJECT_VIEW',
  'OBJECT_MATVIEW',
  'OBJECT_FOREIGN_TABLE',
]);
/** Protected ids among names (compared case-insensitively: a false FAIL, never a false PASS). */
const protectedAmong = (names: Iterable<string>): string[] =>
  [...new Set([...names].map(lc))].filter((n) => PROTECTED_IDS.has(n)).sort();
/** Protected ids written as a word inside any string value of the parse (a constant, a COMMENT ON text): the reading the gate gives every literal. */
const protectedInConstants = (node: unknown): string[] => {
  const consts = allStrings(node);
  return PROTECTED.filter((p) =>
    consts.some((c) => new RegExp(`(^|[^A-Za-z0-9_$])${p.id}([^A-Za-z0-9_$]|$)`, 'i').test(c)),
  ).map((p) => p.id);
};
/** The protected table a relation names: `account`, `account_role` or `approval`, unqualified or in `public`. */
const protectedTable = (x: unknown): string | null => {
  const r = rangeVar(x);
  if (r === null || (r.schema !== null && lc(r.schema) !== 'public')) return null;
  const n = lc(r.name);
  return PROTECTED_TABLES.some((t) => lc(t.name) === n) ? n : null;
};
/** A qualified name list (`[schema,] name`) that is a protected table. */
const protectedTableList = (x: unknown): string | null => {
  const parts = nameList(x).map(lc);
  const n = parts[parts.length - 1] ?? '';
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'public')) return null;
  return PROTECTED_TABLES.some((t) => lc(t.name) === n) ? n : null;
};

/**
 * One rule over parsed statements. `check` returns one message per violation in `s`, a statement
 * of migration `m` at any depth the reader goes to (top level, a DO or function body, an EXECUTE string
 * or any other string constant that parses), to a nesting depth of 8; deeper fails closed (R-PARSE)
 * and reaches no rule, whether it is a statement of a body, a PL/pgSQL expression or a string constant
 * (QA delta QD-3: until rework 2 an expression at 9 reached every rule; CZ4G, CZ4I). A later R-tag that
 * reads statements plugs in by adding an entry to AST_RULES (T-229 § Published contract §4).
 * A statement parsed out of a string constant reaches every rule whether or not that string is ever
 * executed (T-229 tech-lead review TL-4): `SELECT '<statement>'` hands `check` the statement, with
 * `s.via` ending in `string constant` (CZ4J: a DISABLE TRIGGER ALL that is only a SELECTed string is
 * refused). For the protected-object rules that is the safe side, a false FAIL. A rule over column
 * types (T-173, T-253) must read `s.via`, or it will false-FAIL on a string that is only data.
 */
interface AstRule {
  readonly tag: string;
  readonly check: (s: AstStmt, m: Migration) => readonly string[];
}

const AST_RULES: readonly AstRule[] = [
  {
    tag: 'R-TRIGGER-BYPASS',
    check: (s) => {
      const out: string[] = [];
      walkStmt(s, (kind, f) => {
        if (kind === 'AlterTableCmd') {
          const sub = str(f['subtype']);
          const name = lc(str(f['name']) ?? '');
          if (sub === 'AT_DisableTrigAll' || sub === 'AT_DisableTrigUser') {
            out.push(
              `switches off triggers without naming them (DISABLE TRIGGER ${sub === 'AT_DisableTrigAll' ? 'ALL' : 'USER'}), protected ones included`,
            );
          } else if (
            (sub === 'AT_DisableTrig' || sub === 'AT_EnableReplicaTrig') &&
            PROTECTED_TRIGGER_IDS.has(name)
          ) {
            out.push(
              `switches off the protected trigger ${name} by name (${sub === 'AT_DisableTrig' ? 'DISABLE' : 'ENABLE REPLICA'} TRIGGER); a reviewed migration may replace a protected trigger (R-PROTECTED's marker), never switch it off`,
            );
          }
        } else if (
          kind === 'AlterEventTrigStmt' &&
          PROTECTED_TRIGGER_IDS.has(lc(str(f['trigname']) ?? '')) &&
          (f['tgenabled'] === 'D' || f['tgenabled'] === 'R')
        ) {
          out.push(
            `switches off the protected event trigger ${lc(str(f['trigname']) ?? '')} by name (ALTER EVENT TRIGGER … ${f['tgenabled'] === 'D' ? 'DISABLE' : 'ENABLE REPLICA'})`,
          );
        }
      });
      // The setting named anywhere: SET, RESET, SHOW, and the bare `setstmt` of ALTER ROLE|DATABASE … SET
      // and of a function's SET clause, which a match on the VariableSetStmt kind would miss (T-229 probe5).
      if ([...identifiers(s.node)].some((n) => lc(n) === 'session_replication_role')) {
        out.push(
          'names the setting session_replication_role (SET, RESET, or a role, database or function SET clause), which switches off triggers without naming them',
        );
      }
      if (
        allStrings(s.node).some((c) =>
          /(^|[^a-z0-9_$])session_replication_role([^a-z0-9_$]|$)/i.test(c),
        )
      ) {
        out.push(
          'names session_replication_role in a string constant (set_config, dynamic SQL), which switches off triggers without naming them',
        );
      }
      return out;
    },
  },
  {
    tag: 'R-PROTECTED-RENAME',
    check: (s) =>
      s.kind !== 'RenameStmt'
        ? []
        : protectedAmong(identifiers(s.node)).map(
            (id) =>
              `a RENAME that names the protected object ${id}; renamed away, it can be disabled or no-op-replaced under a name no rule protects (T-186 QA X5, X8), so no marker permits it`,
          ),
  },
  {
    tag: 'R-PROTECTED-TABLE',
    check: (s, m) => {
      const out: string[] = [];
      const why = (t: string): string =>
        `public.${t} is read by name by I-5's protected functions, and a table renamed or moved away keeps its protected triggers while a replacement under the old name has none (T-192 tech-lead RT2; OD-237 TL-2), so no marker permits it`;
      const n = s.node;
      if (s.kind === 'RenameStmt') {
        const type = str(n['renameType']) ?? '';
        if (RELATION_OBJECTS.has(type)) {
          const away = protectedTable(n['relation']);
          if (away !== null)
            out.push(`renames it away (${type.slice(7)} … RENAME TO): ${why(away)}`);
          const r = rangeVar(n['relation']);
          const to = lc(str(n['newname']) ?? '');
          if (
            (r === null || r.schema === null || lc(r.schema) === 'public') &&
            PROTECTED_TABLES.some((t) => lc(t.name) === to)
          )
            out.push(`renames another relation TO its name: ${why(to)}`);
        } else if (type === 'OBJECT_SCHEMA' && lc(str(n['subname']) ?? '') === 'public') {
          out.push(
            `renames the schema public, which holds account, account_role and approval: ${why('account_role')}`,
          );
        }
      }
      if (s.kind === 'AlterObjectSchemaStmt') {
        const t = protectedTable(n['relation']);
        if (t !== null) out.push(`moves it to another schema (SET SCHEMA): ${why(t)}`);
      }
      walkStmt(s, (kind, f) => {
        let rel: unknown = null;
        if (kind === 'CreateStmt') rel = f['relation'];
        else if (kind === 'ViewStmt') rel = f['view'];
        // `SELECT … INTO` and `CREATE TABLE|MATERIALIZED VIEW … AS` carry a bare IntoClause field.
        else if (kind === 'SelectStmt' && isObj(f['intoClause'])) rel = f['intoClause']['rel'];
        else if (kind === 'CreateTableAsStmt' && isObj(f['into'])) rel = f['into']['rel'];
        // `CREATE FOREIGN TABLE` carries its CreateStmt as a bare `base` field.
        else if (kind === 'CreateForeignTableStmt' && isObj(f['base'])) rel = f['base']['relation'];
        const t = protectedTable(rel);
        if (t === null) return;
        const owner = PROTECTED_TABLES.find((x) => lc(x.name) === t);
        if (owner !== undefined && m.dir === 'up' && m.num === owner.createdBy) return;
        out.push(
          `creates a relation of its name (${kind === 'SelectStmt' ? 'SELECT … INTO' : kind === 'CreateTableAsStmt' ? 'CREATE TABLE … AS' : kind === 'ViewStmt' ? 'CREATE VIEW' : 'CREATE TABLE'}; only ${owner?.createdBy ?? '?'} creates it): ${why(t)}`,
        );
      });
      return out;
    },
  },
  {
    tag: 'R-PROTECTED-EXTENSION',
    check: (s) => {
      const out: string[] = [];
      const n = s.node;
      const say = (what: string, name: string): string =>
        `${what} names ${name}: a later DROP EXTENSION, which names nothing protected, would then remove it (T-192 QA N17/N18r, DEP1; OD-235), so no marker permits it`;
      if (s.kind === 'AlterObjectDependsStmt' && n['remove'] !== true) {
        for (const id of protectedAmong(identifiers(n['object'])))
          out.push(say('DEPENDS ON EXTENSION', id));
        const t = RELATION_OBJECTS.has(str(n['objectType']) ?? '')
          ? protectedTable(n['relation'])
          : null;
        if (t !== null) out.push(say('DEPENDS ON EXTENSION', `public.${t}`));
      }
      if (s.kind === 'AlterExtensionContentsStmt' && n['action'] === 1) {
        for (const id of protectedAmong(identifiers(n['object'])))
          out.push(say('ALTER EXTENSION … ADD', id));
        const t = RELATION_OBJECTS.has(str(n['objtype']) ?? '')
          ? protectedTableList(n['object'])
          : null;
        if (t !== null) out.push(say('ALTER EXTENSION … ADD', `public.${t}`));
      }
      return out;
    },
  },
];

/**
 * (T-227, OD-235) PostgreSQL's Unicode-escape identifier, `U&"…"` [UESCAPE '<c>']: `<c>XXXX` (4 hex
 * digits), `<c>+XXXXXX` (6), and `<c><c>` for the escape character itself. A malformed escape is
 * returned as written (PostgreSQL refuses the file at apply time, so that errs towards a false FAIL
 * elsewhere, never a false PASS here).
 */
export function decodeUnicodeIdent(body: string, esc = '\\'): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charAt(i);
    if (c !== esc) {
      out += c;
      continue;
    }
    if (body.charAt(i + 1) === esc) {
      out += esc;
      i += 1;
      continue;
    }
    const six = /^\+([0-9A-Fa-f]{6})/.exec(body.slice(i + 1));
    const four = /^([0-9A-Fa-f]{4})/.exec(body.slice(i + 1));
    if (six !== null) {
      out += String.fromCodePoint(parseInt(six[1] ?? '0', 16));
      i += 7;
    } else if (four !== null) {
      out += String.fromCodePoint(parseInt(four[1] ?? '0', 16));
      i += 4;
    } else {
      return body;
    }
  }
  return out;
}
/** `U&"…"` identifiers inside raw text (a string literal read as dynamic SQL), decoded in place. */
function decodeUnicodeIdentsInText(text: string): string {
  return text.replace(
    // (T-229, QA-C3) comments may sit on either side of UESCAPE, as PostgreSQL's scanner skips them.
    /(^|[^A-Za-z0-9_$])[Uu]&"((?:[^"]|"")*)"((?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n)*[Uu][Ee][Ss][Cc][Aa][Pp][Ee](?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n)*'(.)')?/g,
    (_m, pre: string, body: string, _u: string | undefined, esc: string | undefined) =>
      `${pre}"${decodeUnicodeIdent(body.replace(/""/g, '"'), esc ?? '\\').replace(/"/g, '""')}"`,
  );
}

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
/** (T-241) The reviewed restore-PUBLIC marker (R-RESTORE-PUBLIC), read line by line like the two above. */
const RESTORE_PUBLIC_LINE = /^[ \t]*--[ \t]*@restore-public\b/;
const RESTORE_PUBLIC_FORM = /^[ \t]*--[ \t]*@restore-public:[ \t]*(.*)$/;
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

/**
 * T-237 rework 1 (QA-F3). PostgreSQL's escape-string decoding (`E'…'`, standard_conforming_strings on):
 * `\\b \\f \\n \\r \\t`, `\\o`, `\\oo`, `\\ooo` (octal), `\\xh`, `\\xhh` (hex), `\\uXXXX`,
 * `\\UXXXXXXXX`, and any other `\\c` as `c`. A malformed Unicode escape is left as written (PostgreSQL
 * refuses it at apply time). `''` is left for the reader to fold, as in a standard string.
 */
export function decodeEscapeString(body: string): string {
  const simple: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  return body.replace(
    /\\(?:([bfnrt])|([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([\s\S]))/g,
    (_m, s1?: string, oct?: string, hex?: string, u4?: string, u8?: string, other?: string) => {
      if (s1 !== undefined) return simple[s1] ?? s1;
      if (oct !== undefined) return String.fromCodePoint(parseInt(oct, 8) & 0xff);
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      const cp = u4 ?? u8;
      if (cp !== undefined) {
        const n = parseInt(cp, 16);
        return n <= 0x10ffff ? String.fromCodePoint(n) : _m;
      }
      return other ?? '';
    },
  );
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
      // T-237 rework 1 (QA-F3): an escape string's body is DECODED as PostgreSQL decodes it, so dynamic
      // SQL spelled with escapes (`EXECUTE E'CREATE\\nRULE …'`) is read as the statement it becomes.
      const raw = text.slice(1, -1);
      segments.push({ kind: 'string', text, body: escapes ? decodeEscapeString(raw) : raw, line });
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
  /**
   * (T-241) Parallel to `texts`: for a fragment that is a whole TOP-LEVEL statement of the file (split
   * on `;` outside every literal, at depth 0), the segments of that statement in source order, with the
   * code split at the `;`; `null` for every other fragment (a string literal's or a dollar body's
   * content). R-RESTORE-PUBLIC is the only reader: it re-reads the statement with identifier case and
   * quoting intact, which `texts` has normalised away.
   */
  readonly stmts: (readonly Segment[] | null)[];
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
  const stmts: (readonly Segment[] | null)[] = [];
  let cur = '';
  /** (T-241) The segments of the statement being read, for `stmts`. */
  let stmtSegs: Segment[] = [];
  const emit = (t: string, c: readonly string[], st: readonly Segment[] | null = null): void => {
    if (t === '') return;
    texts.push(t);
    bodies.push([...c]);
    stmts.push(st);
  };
  const push = (): void => {
    emit(norm(cur), chain, depth === 0 ? stmtSegs : null);
    cur = '';
    stmtSegs = [];
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
  for (let k = 0; k < segments.length; k += 1) {
    const s = segments[k];
    if (s === undefined) continue;
    if (s.kind === 'code') {
      let piece = '';
      for (const ch of s.text) {
        if (ch === ';') {
          if (piece !== '') stmtSegs.push({ kind: 'code', text: piece, body: piece, line: s.line });
          piece = '';
          push();
        } else {
          cur += ch;
          piece += ch;
        }
      }
      if (piece !== '') stmtSegs.push({ kind: 'code', text: piece, body: piece, line: s.line });
    } else if (s.kind === 'ident') {
      stmtSegs.push(s);
      // (T-227, OD-235) `U&"…"` [UESCAPE '<c>']: the `U&` is the tail of the code before it.
      const uPrefix = /(^|[^A-Za-z0-9_$])[Uu]&$/.exec(cur);
      if (uPrefix === null) {
        cur += s.body;
        continue;
      }
      cur = cur.slice(0, cur.length - 2);
      let esc = '\\';
      // (T-229, QA-C3) PostgreSQL's scanner skips comments, so `U&"…" /* c */ UESCAPE -- c
      // '!'` still applies the escape: step over comments and whitespace on both sides of UESCAPE.
      const j1 = nextSolid(segments, k + 1);
      const n1 = segments[j1];
      const j2 = nextSolid(segments, j1 + 1);
      const n2 = segments[j2];
      if (
        n1?.kind === 'code' &&
        /^\s*UESCAPE\s*$/i.test(n1.text) &&
        n2?.kind === 'string' &&
        n2.body.length === 1
      ) {
        esc = n2.body;
        cur += ' ';
        for (let q = k + 1; q <= j2; q += 1) {
          const sq = segments[q];
          if (sq !== undefined) stmtSegs.push(sq);
        }
        k = j2;
      }
      cur += decodeUnicodeIdent(s.body, esc);
    } else if (s.kind === 'line-comment' || s.kind === 'block-comment') {
      stmtSegs.push(s);
      cur += ' ';
    } else if (s.kind === 'string') {
      stmtSegs.push(s);
      const inside = descend();
      cur += ' ';
      raw(decodeUnicodeIdentsInText(s.body.replace(/''/g, "'")), inside);
    } else {
      stmtSegs.push(s);
      const inside = descend();
      cur += ' ';
      const inner = depth < 8 ? lex(s.body) : null;
      if (inner !== null && inner.error === null) {
        const r = readFragments(inner.segments, inside, ctx, depth + 1);
        texts.push(...r.texts);
        bodies.push(...r.bodies);
        stmts.push(...r.texts.map(() => null));
      } else raw(s.body, inside);
    }
  }
  push();
  return { texts, bodies, bodyList: ctx.bodyList, stmts };
}

/**
 * The file as PostgreSQL receives it from psql, for the parser: each psql meta-command (a backslash in
 * code, to the end of its line) blanked to spaces, so offsets and lines do not move. R-ROLE-SWITCH
 * refuses every meta-command; this only stops the parser failing on text that is psql's, not SQL.
 * COUPLING (T-229 tech-lead review TL-3): blanking to the end of the line also hides any SQL after psql's
 * `\\` separator on that line (`\echo x \\ ALTER TABLE …`), which psql would send to the server. That
 * is safe ONLY while R-ROLE-SWITCH refuses every backslash in code (CZ4M: such a line is refused by
 * R-ROLE-SWITCH alone, its ALTER unread). Do not relax R-ROLE-SWITCH's refusal of backslashes without
 * first making this function keep what follows `\\`.
 */
function withoutPsqlMeta(segments: readonly Segment[]): string {
  return segments
    .map((s) =>
      s.kind === 'code' ? s.text.replace(/\\[^\n]*/g, (x) => ' '.repeat(x.length)) : s.text,
    )
    .join('');
}

/** The index of the first segment at or after `from` that is neither a comment nor whitespace-only code. */
function nextSolid(segments: readonly Segment[], from: number): number {
  let j = from;
  for (;;) {
    const t = segments[j];
    if (t === undefined) return j;
    if (t.kind === 'line-comment' || t.kind === 'block-comment') j += 1;
    else if (t.kind === 'code' && t.text.trim() === '') j += 1;
    else return j;
  }
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

// ---------------------------------------------------------------------------
// 2a. (T-241) R-RESTORE-PUBLIC: a top-level statement re-read with identifier case intact
// ---------------------------------------------------------------------------

/**
 * A token of one top-level statement. `w` is an unquoted word as written, `q` a quoted identifier's
 * name (a `U&"…"` one decoded), `p` one punctuation character. Comments are separators and produce no
 * token, so `pg_advisory/* x *\/_lock` is two words, as PostgreSQL reads it.
 */
interface Tok {
  readonly k: 'w' | 'q' | 'p';
  readonly v: string;
}

/** PostgreSQL folds an unquoted identifier to lower case in ASCII only (downcase_identifier). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const WORD_RE = /[A-Za-z0-9_$\u0080-￿]+/y;
const U_AMP_TAIL = /(?:^|[^A-Za-z0-9_$\u0080-￿])[Uu]&$/;

/** The tokens of a top-level statement; `plain` is false when it holds a string or dollar literal. */
function stmtTokens(segs: readonly Segment[]): { toks: Tok[]; plain: boolean } {
  const toks: Tok[] = [];
  let plain = true;
  for (let k = 0; k < segs.length; k += 1) {
    const s = segs[k];
    if (s === undefined || s.kind === 'line-comment' || s.kind === 'block-comment') continue;
    if (s.kind === 'string' || s.kind === 'dollar') {
      plain = false;
      continue;
    }
    if (s.kind === 'ident') {
      const prev = segs[k - 1];
      let name = s.body;
      if (prev?.kind === 'code' && U_AMP_TAIL.test(prev.text)) {
        toks.splice(toks.length - 2, 2); // the `U` and `&` just read from `prev`
        let esc = '\\';
        // (T-229, QA-C3) comments and whitespace may sit on either side of UESCAPE (case CZ35).
        const j1 = nextSolid(segs, k + 1);
        const n1 = segs[j1];
        const j2 = nextSolid(segs, j1 + 1);
        const n2 = segs[j2];
        if (
          n1?.kind === 'code' &&
          /^\s*UESCAPE\s*$/i.test(n1.text) &&
          n2?.kind === 'string' &&
          n2.body.length === 1
        ) {
          esc = n2.body;
          k = j2;
        }
        name = decodeUnicodeIdent(s.body, esc);
      }
      toks.push({ k: 'q', v: name });
      continue;
    }
    const t = s.text;
    let i = 0;
    while (i < t.length) {
      const c = t.charAt(i);
      if (/\s/.test(c)) {
        i += 1;
        continue;
      }
      WORD_RE.lastIndex = i;
      const w = WORD_RE.exec(t);
      if (w !== null) {
        toks.push({ k: 'w', v: w[0] });
        i += w[0].length;
      } else {
        toks.push({ k: 'p', v: c });
        i += 1;
      }
    }
  }
  return { toks, plain };
}

const isWord = (t: Tok | undefined, w: string): boolean => t?.k === 'w' && asciiLower(t.v) === w;
/** An identifier's resolved name: unquoted folded (ASCII), quoted exact; null for punctuation. */
const identName = (t: Tok | undefined): string | null =>
  t === undefined || t.k === 'p' ? null : t.k === 'w' ? asciiLower(t.v) : t.v;

/** Index of the first word in `words` at parenthesis depth 0, at or after `from`; -1 if none. */
function findTop(toks: readonly Tok[], from: number, words: readonly string[]): number {
  let depth = 0;
  for (let i = from; i < toks.length; i += 1) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.k === 'p' && t.v === '(') depth += 1;
    else if (t.k === 'p' && t.v === ')') depth -= 1;
    else if (depth === 0 && t.k === 'w' && words.includes(asciiLower(t.v))) return i;
  }
  return -1;
}

/** Split on commas at parenthesis depth 0. */
function splitTop(toks: readonly Tok[]): Tok[][] {
  const out: Tok[][] = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.k === 'p' && t.v === '(') depth += 1;
    if (t.k === 'p' && t.v === ')') depth -= 1;
    if (depth === 0 && t.k === 'p' && t.v === ',') out.push([]);
    else out[out.length - 1]?.push(t);
  }
  return out;
}

/** How a routine signature is printed: resolved names, quoted only where PostgreSQL would need it. */
function showToks(toks: readonly Tok[]): string {
  let out = '';
  let prevName = false;
  for (const t of toks) {
    if (t.k === 'p') {
      out += t.v === ',' ? ', ' : t.v;
      prevName = false;
      continue;
    }
    const n = identName(t) ?? '';
    const shown = t.k === 'w' || /^[a-z_][a-z0-9_$]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`;
    out += (prevName ? ' ' : '') + shown;
    prevName = true;
  }
  return out;
}

/**
 * A routine signature, `<name>[.<name>][(<argument tokens>)]`, as a comparison key in which every
 * name is resolved (so `"pg_catalog"."x"` and `PG_CATALOG.X` are one key, and `"X"` and `x` are two);
 * null when the tokens are not that shape.
 */
function routineKey(toks: readonly Tok[]): string | null {
  const names: string[] = [];
  const first = identName(toks[0]);
  if (first === null) return null;
  names.push(first);
  let i = 1;
  if (toks[i]?.k === 'p' && toks[i]?.v === '.') {
    const second = identName(toks[i + 1]);
    if (second === null) return null;
    names.push(second);
    i += 2;
  }
  let args: string | null = null;
  if (i < toks.length) {
    const open = toks[i];
    const close = toks[toks.length - 1];
    if (open?.k !== 'p' || open.v !== '(' || close?.k !== 'p' || close.v !== ')') return null;
    const inner = toks.slice(i + 1, -1);
    let depth = 0;
    for (const t of inner) {
      if (t.k === 'p' && t.v === '(') depth += 1;
      if (t.k === 'p' && t.v === ')') depth -= 1;
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
    args = inner.map((t) => (t.k === 'p' ? t.v : JSON.stringify(identName(t)))).join(' ');
  }
  return JSON.stringify([names, args]);
}

const ROUTINE_KINDS: ReadonlySet<string> = new Set(['function', 'procedure', 'routine']);

interface AclStmt {
  /** Privilege names, lower case, `all privileges` read as `all`. */
  readonly privs: readonly string[];
  readonly kind: string;
  /** `qualified`: the name is `<schema>.<name>`, so search_path cannot change what it names. */
  readonly objects: readonly {
    readonly key: string;
    readonly shown: string;
    readonly qualified: boolean;
  }[];
  readonly grantees: readonly (readonly Tok[])[];
  /** `WITH …` / `GRANTED BY …` (GRANT), `GRANTED BY …` / `CASCADE` / `RESTRICT` (REVOKE). */
  readonly tail: readonly Tok[];
  /** REVOKE GRANT OPTION FOR: the privilege itself is not revoked. */
  readonly optionOnly: boolean;
}

/** A GRANT or REVOKE on routines, or the reason the statement is not one. */
function parseRoutineAcl(toks: readonly Tok[], verb: 'grant' | 'revoke'): AclStmt | string {
  if (!isWord(toks[0], verb)) return `it is not a ${verb.toUpperCase()} statement`;
  let i = 1;
  const optionOnly =
    verb === 'revoke' &&
    isWord(toks[1], 'grant') &&
    isWord(toks[2], 'option') &&
    isWord(toks[3], 'for');
  if (optionOnly) i = 4;
  const on = findTop(toks, i, ['on']);
  if (on < 0) return 'it names no object (no ON …)';
  const privs: string[] = [];
  for (const item of splitTop(toks.slice(i, on))) {
    if (item.length === 0 || item.some((t) => t.k !== 'w'))
      return 'its privilege list is not a list of privilege names';
    const p = item.map((t) => asciiLower(t.v)).join(' ');
    privs.push(p === 'all privileges' ? 'all' : p);
  }
  const kindTok = toks[on + 1];
  const kind = kindTok?.k === 'w' ? asciiLower(kindTok.v) : '';
  if (!ROUTINE_KINDS.has(kind))
    return 'only FUNCTION, PROCEDURE and ROUTINE objects are admitted, each named by its signature (not a table, a schema, ALL … IN SCHEMA or any other class)';
  const to = findTop(toks, on + 2, [verb === 'grant' ? 'to' : 'from']);
  if (to < 0) return `it has no ${verb === 'grant' ? 'TO' : 'FROM'} clause`;
  const objects: { key: string; shown: string; qualified: boolean }[] = [];
  for (const o of splitTop(toks.slice(on + 2, to))) {
    const key = routineKey(o);
    if (key === null)
      return `${showToks(o) || '(nothing)'} is not a routine signature <name>[.<name>][(<argument types>)]`;
    objects.push({
      key: `${kind} ${key}`,
      shown: `${kind.toUpperCase()} ${showToks(o)}`,
      qualified: o[1]?.k === 'p' && o[1].v === '.',
    });
  }
  const end = findTop(
    toks,
    to + 1,
    verb === 'grant' ? ['with', 'granted'] : ['granted', 'cascade', 'restrict'],
  );
  return {
    privs,
    kind,
    objects,
    grantees: splitTop(toks.slice(to + 1, end < 0 ? toks.length : end)),
    tail: end < 0 ? [] : toks.slice(end),
    optionOnly,
  };
}

const isPublic = (g: readonly Tok[]): boolean => g.length === 1 && isWord(g[0], 'public');

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
let statementsParsed = 0;
let parseFailures = 0;
/** Texts past MAX_DEPTH, not read (R-PARSE, but not parse failures: counted apart, QA delta INFO-1). */
let nestedTooDeep = 0;
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

/**
 * (T-241) R-RESTORE-PUBLIC. One entry per DOWN file holding at least one line read as the marker:
 * the first such line, and whether the marker is usable (every placement, form and pairing check
 * passed). An up file never has an entry, so nothing in an up file is ever admitted.
 */
const restoreMarkers = new Map<string, { readonly line: number; valid: boolean }>();
let restoreLinesRead = 0;
/** The review record, printed on every run: what each usable marker admitted. */
const restoreAdmits = new Map<string, { line: number; stmts: number; routines: number }>();
/** Rework 1 (QA F1): the reasons, as the negative suite asserts them. */
const DOWN_ONLY_ACL = 'a marked down file holds only GRANT and REVOKE';
const UP_MOVES_NAMES =
  'the paired up file holds a statement that can change what a name designates';
/**
 * Statements that can change which routine a schema-qualified name designates, read over EVERY
 * fragment of an up file (dynamic SQL and bodies included, since EXECUTE runs them). A deny-list,
 * because an up file legitimately holds other statements (0022's DO assertion). `ALTER … OWNER` is
 * absent on purpose: ownership does not change what a name designates.
 */
const NAME_MOVERS: readonly (readonly [RegExp, string])[] = [
  [/\bRENAME\b/, 'RENAME'],
  [/\bSET SCHEMA\b/, 'SET SCHEMA'],
  [
    /\bCREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE|SCHEMA|EXTENSION)\b/,
    'CREATE FUNCTION|PROCEDURE|SCHEMA|EXTENSION',
  ],
  [
    /\bDROP (?:FUNCTION|PROCEDURE|ROUTINE|SCHEMA|EXTENSION)\b/,
    'DROP FUNCTION|PROCEDURE|ROUTINE|SCHEMA|EXTENSION',
  ],
  [/\bALTER (?:SCHEMA|EXTENSION)\b/, 'ALTER SCHEMA|EXTENSION'],
  [/\bSEARCH_PATH\b/, 'search_path'],
];
const upMoverCache = new Map<string, string | null>();
function upNameMover(up: Migration): string | null {
  if (upMoverCache.has(up.name)) return upMoverCache.get(up.name) ?? null;
  let hit: string | null = up.lexed.error === null ? null : 'a file this gate cannot lex';
  if (hit === null) {
    for (const f of readFragments(up.lexed.segments).texts) {
      const m = NAME_MOVERS.find(([re]) => re.test(f));
      if (m !== undefined) {
        hit = `${m[1]}: ${snippet(f)}`;
        break;
      }
    }
  }
  upMoverCache.set(up.name, hit);
  return hit;
}
/**
 * The first fragment of a down file that is not a plain top-level GRANT or REVOKE, or null. An
 * allow-list: nothing that could repoint a name has to be named to be refused. A fragment with no
 * top-level statement (a literal's or a body's content) belongs to a statement that is not one.
 */
const downNonAclCache = new Map<string, string | null>();
function downNonAcl(m: Migration): string | null {
  if (downNonAclCache.has(m.name)) return downNonAclCache.get(m.name) ?? null;
  let hit: string | null = null;
  const read = readFragments(m.lexed.segments);
  read.texts.forEach((f, i) => {
    if (hit !== null) return;
    const st = read.stmts[i] ?? null;
    if (st === null) {
      hit = f;
      return;
    }
    const { toks, plain } = stmtTokens(st);
    if (!plain || !(isWord(toks[0], 'grant') || isWord(toks[0], 'revoke'))) hit = f;
  });
  downNonAclCache.set(m.name, hit);
  return hit;
}

/** The (object key -> privileges) an up file revoked FROM PUBLIC in plain top-level REVOKEs. */
const revokedCache = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
function revokedFromPublic(up: Migration): ReadonlyMap<string, ReadonlySet<string>> {
  const hit = revokedCache.get(up.name);
  if (hit !== undefined) return hit;
  const out = new Map<string, Set<string>>();
  if (up.lexed.error === null) {
    for (const st of readFragments(up.lexed.segments).stmts) {
      if (st === null) continue;
      const { toks, plain } = stmtTokens(st);
      if (!plain || !isWord(toks[0], 'revoke')) continue;
      const r = parseRoutineAcl(toks, 'revoke');
      if (typeof r === 'string' || r.optionOnly || !r.grantees.some(isPublic)) continue;
      for (const o of r.objects) {
        const set = out.get(o.key) ?? new Set<string>();
        for (const p of r.privs) set.add(p);
        out.set(o.key, set);
      }
    }
  }
  revokedCache.set(up.name, out);
  return out;
}

/**
 * Whether the marker admits one GRANT … TO PUBLIC fragment of a down file: null if it does, else
 * the reason. `st` is the fragment's top-level statement (`FragmentRead.stmts`), null when the
 * fragment is a literal's content.
 */
function restoreVerdict(
  m: Migration,
  st: readonly Segment[] | null,
): { why: string | null; routines: number } {
  const refuse = (why: string): { why: string; routines: number } => ({ why, routines: 0 });
  if (st === null) {
    return refuse(
      'it is not a plain top-level GRANT statement (it sits in a string literal or a dollar-quoted body: a DO block, a function body, an EXECUTE string)',
    );
  }
  const { toks, plain } = stmtTokens(st);
  if (!plain) {
    return refuse(
      'it is not a plain top-level GRANT statement (the statement holds a string literal or a dollar-quoted body)',
    );
  }
  const g = parseRoutineAcl(toks, 'grant');
  if (typeof g === 'string') return refuse(g);
  if (g.tail.length > 0) {
    return refuse(
      `it carries ${isWord(g.tail[0], 'with') ? 'WITH GRANT OPTION (or another WITH option)' : 'GRANTED BY'}; a restore re-creates PUBLIC's privilege and nothing else`,
    );
  }
  if (g.grantees.length !== 1 || !isPublic(g.grantees[0] ?? [])) {
    return refuse(
      'the grantee list is not exactly PUBLIC (the bare keyword, alone); the marker never admits another grantee, answering_service above all',
    );
  }
  const upName = `${m.num}_${m.slug}.up.sql`;
  const up = byName.get(upName);
  if (up === undefined) return refuse(`no paired up file ${MIGRATIONS_REL}/${upName}`);
  // Self-attack A1: an unqualified name resolves through search_path, which the down file can move
  // (`SET search_path = …;` before the GRANT), so equal text would not be the same routine.
  const unqualified = g.objects.filter((o) => !o.qualified);
  if (unqualified.length > 0) {
    return refuse(
      `${unqualified.map((o) => o.shown).join(', ')} is not schema-qualified; an unqualified name resolves through search_path, which a down file can change before its GRANT, so the marker admits only <schema>.<name>(…) (T-241 A1)`,
    );
  }
  const revoked = revokedFromPublic(up);
  const missing: string[] = [];
  for (const o of g.objects) {
    for (const p of g.privs) {
      if (revoked.get(o.key)?.has(p) !== true) {
        missing.push(
          `privilege ${p.toUpperCase()} on ${o.shown} was not revoked from PUBLIC by ${up.rel}`,
        );
      }
    }
  }
  if (missing.length > 0) return refuse(missing.join('; '));
  // Rework 1 (QA F1). The comparison above is of NAMES. A name designates the revoked routine at the
  // GRANT only if nothing between the REVOKE and the GRANT moved it: the up file after its REVOKE
  // (the down runs on the state the up left), and the down file before its GRANT.
  const downOther = downNonAcl(m);
  if (downOther !== null) {
    return refuse(
      `${DOWN_ONLY_ACL} statements, and this one holds ${snippet(downOther)}; any other statement can change which routine a name designates before the GRANT (RENAME, SET SCHEMA, DROP and CREATE, search_path) (T-241 rework 1, QA F1)`,
    );
  }
  const upMove = upNameMover(up);
  if (upMove !== null) {
    return refuse(
      `${UP_MOVES_NAMES} (${upMove}), so a name it revoked is not known to designate the routine the down file's GRANT reaches (T-241 rework 1, QA F1)`,
    );
  }
  return { why: null, routines: g.objects.length };
}

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

  // R-RESTORE-PUBLIC (T-241, OE-76), part 1: the marker lines themselves — placement, form,
  // pairing. Read for EVERY file, the baseline and the up files included, so that a marker which
  // cannot admit anything is refused rather than left standing as a claim a reviewer would read.
  {
    const lines = m.text.split('\n');
    const headerEnd = headerEndLine(segs);
    const commentLines = new Set(segs.filter((s) => s.kind === 'line-comment').map((s) => s.line));
    let read = 0;
    let firstLine = 0;
    let valid = true;
    lines.forEach((line, k) => {
      if (!RESTORE_PUBLIC_LINE.test(line)) return;
      const at = k + 1;
      read += 1;
      restoreLinesRead += 1;
      const where = `${m.rel}:${String(at)}`;
      if (read > 1) {
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          where,
          `a second -- @restore-public marker; line ${String(firstLine)} already carries one, and a file carries at most one`,
        );
        return;
      }
      firstLine = at;
      if (at >= headerEnd || !commentLines.has(at)) {
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          where,
          `a -- @restore-public marker that is not a -- comment in the file header (before the first statement, outside every string, dollar-quoted body and block comment): ${snippet(line.trim())}`,
        );
        return;
      }
      if (m.dir === 'up') {
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          where,
          "a -- @restore-public marker in an up file; it admits a GRANT … TO PUBLIC only in a DOWN file, restoring what that down file's own up file revoked from PUBLIC (OE-76)",
        );
        return;
      }
      if (BASELINE.has(m.name)) {
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          where,
          'a -- @restore-public marker in the pinned 0001 baseline, whose content rules are not read at all (R-BASELINE); the marker admits nothing',
        );
        return;
      }
      // `.` does not match `\r`, so a CRLF line is matched without it (as R-RUN-AS does).
      const form = RESTORE_PUBLIC_FORM.exec(line.replace(/\r$/, ''));
      if (form === null) {
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          where,
          `not of the form \`-- @restore-public: <reference>\`: ${snippet(line.trim())}`,
        );
        return;
      }
      if (!REFERENCE.test(form[1] ?? '')) {
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          where,
          'the -- @restore-public marker cites no ticket or decision (T-NNN, OE-n, OD-n, EV-n, SQ-n) on its own line; a restore with no reference records no review',
        );
        return;
      }
      const upName = `${m.num}_${m.slug}.up.sql`;
      if (!byName.has(upName)) {
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          where,
          `no paired up file ${MIGRATIONS_REL}/${upName}; the marker admits only what a down file's own up file revoked from PUBLIC`,
        );
      }
    });
    for (const s of segs) {
      if (s.kind !== 'line-comment' && s.kind !== 'block-comment') continue;
      s.body.split('\n').forEach((b, k) => {
        if (!/^\s*@restore-public\b/.test(b)) return;
        const at = s.line + k;
        if (s.kind === 'line-comment' && RESTORE_PUBLIC_LINE.test(lines[at - 1] ?? '')) return; // read above
        valid = false;
        problem(
          'R-RESTORE-PUBLIC',
          `${m.rel}:${String(at)}`,
          `a comment beginning @restore-public that this gate does not read as a marker (it reads only a whole -- line in the header), so it admits nothing: ${snippet(b.trim())}`,
        );
      });
    }
    if (read > 0 && m.dir === 'down' && !BASELINE.has(m.name)) {
      restoreMarkers.set(m.name, { line: firstLine, valid });
      if (valid) restoreAdmits.set(m.rel, { line: firstLine, stmts: 0, routines: 0 });
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

  // PostgreSQL's parser (T-229): every statement to a nesting depth of 8; deeper is an error (R-PARSE).
  // psql consumes its meta-commands (R-ROLE-SWITCH refuses every one); PostgreSQL never sees them.
  const ast = readSqlAst(withoutPsqlMeta(segs));
  for (const e of ast.errors) {
    const where = e.via.length === 0 ? 'this file' : e.via.join(' > ');
    problem(
      'R-PARSE',
      `${m.rel}:${String(e.line)}`,
      e.tooDeep === true
        ? `this gate reads PostgreSQL's parse to a nesting depth of ${String(MAX_DEPTH)} (lib/sql-ast.ts MAX_DEPTH; each DO/function body, PL/pgSQL expression and string constant is a level), and ${where} is deeper. It is not read, so this gate cannot say what it does and fails closed. Flatten the nesting`
        : `PostgreSQL's parser (libpg_query 18) cannot parse ${where}: ${e.message}. PostgreSQL would refuse it too, and this gate cannot say what it does, so it fails closed`,
    );
  }
  const astNamed = new Map<string, AstStmt>();
  for (const s of ast.stmts) {
    for (const id of [...protectedAmong(identifiers(s.node)), ...protectedInConstants(s.node)]) {
      if (!astNamed.has(id)) astNamed.set(id, s);
    }
  }
  statementsParsed += ast.stmts.length;
  for (const e of ast.errors) {
    if (e.tooDeep === true) nestedTooDeep += 1;
    else parseFailures += 1;
  }
  // The AST rules (R-TRIGGER-BYPASS, R-PROTECTED-RENAME, R-PROTECTED-TABLE, R-PROTECTED-EXTENSION, and
  // any later entry in AST_RULES), each over every statement the reader reached; a message repeated for
  // the same file (a constant read at two depths) is reported once.
  const astSaid = new Set<string>();
  for (const s of ast.stmts) {
    for (const rule of AST_RULES) {
      for (const msg of rule.check(s, m)) {
        const key = `${rule.tag}\u0000${msg}`;
        if (astSaid.has(key)) continue;
        astSaid.add(key);
        const where = s.via.length === 0 ? '' : `, in ${s.via.join(' > ')}`;
        problem(
          rule.tag,
          `${m.rel}:${String(s.line)}`,
          `${msg} (PostgreSQL's parser${where}): ${snippet(s.text)}`,
        );
      }
    }
  }

  // R-PROTECTED.
  for (const p of PROTECTED) {
    const hit = astNamed.get(p.id)?.text;
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

  // R-ADMIN-MEMBERSHIP (T-192, OD-224 A3), the routes that are not a GRANT.
  for (const f of frags) {
    if (
      /\bCREATE (?:ROLE|USER|GROUP)\b.*\bAPP_ADMIN_RW\b/.test(f) ||
      /\bALTER (?:ROLE|USER|GROUP) APP_ADMIN_RW\b/.test(f)
    ) {
      problem(
        'R-ADMIN-MEMBERSHIP',
        m.rel,
        `confers membership in app_admin_rw without a GRANT (CREATE ROLE … IN ROLE, ALTER GROUP … ADD USER), or alters app_admin_rw; only app_admin_rw's privileges may write a ts_senior row, or activate a ts_senior holder's account or lift its suspension (OE-47, OE-48/OE-57/OE-58): ${snippet(f)}`,
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

  // R-RULE (T-237). No marker permits it.
  for (const f of frags) {
    if (/\bCREATE (?:OR REPLACE )?RULE\b/.test(f)) {
      problem(
        'R-RULE',
        m.rel,
        `CREATE RULE installs a rewrite rule, which changes what a write does without a trigger, a grant or a constraint, so a refusal test sees it only if it swallows that test's own write (T-196 QA2-F1); no marker permits one: ${snippet(f)}`,
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
  /** (T-241) Per fragment, the R-RESTORE-PUBLIC verdict, computed once for all its clauses. */
  const restoreAt = new Map<number, string | null>();
  frags.forEach((f, fi) => {
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

      if (g.targets === null && g.privileges.split(',').some((r) => r.trim() === 'APP_ADMIN_RW')) {
        problem(
          'R-ADMIN-MEMBERSHIP',
          m.rel,
          `grants the role app_admin_rw, which makes each grantee a holder of its privileges; only app_admin_rw may write a ts_senior row, or activate a ts_senior holder's account or lift its suspension (OE-47, OE-48/OE-57/OE-58), and GRANT app_admin_rw TO app_rw would admit every app_rw login (T-186 QA P10): ${snippet(g.clause)}`,
        );
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
      // (T-241) A usable -- @restore-public marker in a down file may admit this clause; without one
      // the refusal is exactly what it was, word for word.
      const marker = m.dir === 'down' ? restoreMarkers.get(m.name) : undefined;
      let restoreNote = '';
      if (toPublic && marker !== undefined) {
        if (!marker.valid) {
          restoreNote = `; the -- @restore-public marker (line ${String(marker.line)}) is refused (R-RESTORE-PUBLIC), so it admits nothing`;
        } else {
          if (!restoreAt.has(fi)) {
            const v = restoreVerdict(m, read.stmts[fi] ?? null);
            restoreAt.set(fi, v.why);
            const rec = restoreAdmits.get(m.rel);
            if (v.why === null && rec !== undefined) {
              rec.stmts += 1;
              rec.routines += v.routines;
            }
          }
          const why = restoreAt.get(fi) ?? null;
          if (why === null) continue;
          restoreNote = `; -- @restore-public (line ${String(marker.line)}) does not admit it: ${why}`;
        }
      }
      if (toPublic) {
        problem(
          'R-ANSWERING-SERVICE',
          m.rel,
          `grants to PUBLIC, and PUBLIC includes answering_service (T-020 contract §6): ${snippet(g.clause)}${restoreNote}`,
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
  });

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
  `  statements PostgreSQL's parser read (to a nesting depth of 8, the 0001 baseline excepted): ${String(statementsParsed)}; that it could not parse: ${String(parseFailures)}; texts nested deeper than ${String(MAX_DEPTH)}, not read: ${String(nestedTooDeep)}`,
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
  `  -- @restore-public marker lines read: ${String(restoreLinesRead)}; usable markers: ${String(restoreAdmits.size)}; GRANT … TO PUBLIC statements they admitted: ${String([...restoreAdmits.values()].reduce((n, r) => n + r.stmts, 0))}`,
);
for (const [rel, r] of restoreAdmits) {
  console.log(
    `    restore-public: ${rel}:${String(r.line)} admits ${String(r.stmts)} GRANT … TO PUBLIC statement(s) on ${String(r.routines)} routine(s)`,
  );
}
console.log(
  `  commits in merge-base..HEAD: ${String(commitsRead)}; of them changing ${MIGRATIONS_REL}/, Ticket trailer read with git's parser: ${String(migrationCommits)}`,
);
finish(GATE, failures);
