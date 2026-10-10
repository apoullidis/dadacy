/**
 * PostgreSQL's own grammar, for gate:migration-lint (T-229, OD-240).
 *
 * `libpg-query` 18.1.5 is PostgreSQL 18's `gram.y`/`scan.l` (libpg_query) compiled to WebAssembly,
 * pinned as a root devDependency. This module turns a migration's text into the statements PostgreSQL
 * would parse from it, at every depth the gate reads, and leaves the rules to the gate:
 *
 *   - the file's own statements;
 *   - a `DO` block's body and a `CREATE FUNCTION|PROCEDURE` body, in `plpgsql` (through libpg_query's
 *     PL/pgSQL parser) or `sql` (a quoted body parsed as SQL; a `BEGIN ATOMIC` body is already in the
 *     tree), at any nesting;
 *   - inside a PL/pgSQL body, every SQL statement and every expression it evaluates (`EXECUTE`'s
 *     argument, an assignment, `PERFORM`, a condition);
 *   - every string constant anywhere in any of the above (`'…'`, `E'…'`, `U&'…'`, `$q$…$q$`), parsed as
 *     SQL when it parses: dynamic SQL passed to `EXECUTE`, or held in a variable that is.
 *
 * Every text has its comments blanked before it is parsed: PostgreSQL's own scanner (`scanSync`) finds
 * them, and each byte of a comment that is not a newline becomes a space, so offsets and lines do not
 * move. The server's scanner skips comments; libpg_query's instead hands a comment token to the
 * grammar's one-token lookahead, so it refuses `U&"…" /* c *\/ UESCAPE '!'` as a syntax error where the
 * server accepts it (T-229 § Progress log, probe2; QA-C3). With the comments blanked the two agree.
 *
 * A text that does not parse is reported in `errors` when it is the file itself or a function / DO body,
 * because PostgreSQL would refuse to run it too and the gate cannot say what it does: the gate fails
 * closed on it. A string constant that does not parse is not an error: most constants are not SQL.
 *
 * WHAT THIS DOES NOT SEE: SQL assembled at run time. `EXECUTE format('… %I …', 'name')` and
 * `EXECUTE 'DROP TRIGGER ' || 'name' || …` reach PostgreSQL as one statement only when they run; here
 * each constant is parsed on its own, and a fragment such as `'ALTER TRIGGER %I ON t RENAME TO x'` or
 * `'DROP TRIGGER trg_'` is not a statement. A body in a language other than `plpgsql` or `sql` is not
 * read. Nothing here knows the database: a name is resolved as the grammar spells it (case folded,
 * quotes and escapes decoded, schema as written), never against the catalogue or a search_path.
 */
/** The four calls this module makes into libpg-query. */
interface PgQuery {
  loadModule(): Promise<void>;
  parseSync(query: string): unknown;
  parsePlPgSQLSync(query: string): unknown;
  scanSync(query: string): unknown;
}

/**
 * Loaded here, guarded, rather than by a static import: a tree without the package (a detached git
 * worktree with no node_modules) must make the gate report that it cannot parse, with its own GATE FAIL
 * banner, not crash before its first line runs (PROTOCOL §5.1: "refused" and "crashed" stay distinct).
 */
let pg: PgQuery | null = null;
let pgUnavailable = '';
try {
  const mod: PgQuery = await import('libpg-query');
  await mod.loadModule();
  pg = mod;
} catch (e) {
  pgUnavailable = e instanceof Error ? e.message : String(e);
}

/** One parsed statement, wherever it was found. */
export interface AstStmt {
  /** The node type, e.g. `RenameStmt`, `AlterTableStmt`, `DoStmt`. */
  readonly kind: string;
  /** The node's fields, as libpg_query emits them (JSON). */
  readonly node: Readonly<Record<string, unknown>>;
  /** The statement's text, comments stripped, whitespace collapsed (for messages). */
  readonly text: string;
  /** Line in the FILE of the top-level statement this one was found in. */
  readonly line: number;
  /** Where it was found, outermost first: `[]` at top level, then e.g. `DO body`, `EXECUTE string`. */
  readonly via: readonly string[];
}

export interface AstError {
  readonly line: number;
  readonly via: readonly string[];
  readonly message: string;
}

export interface AstRead {
  readonly stmts: readonly AstStmt[];
  readonly errors: readonly AstError[];
}

const MAX_DEPTH = 8;

export const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** A node `{ Kind: { …fields } }` as `[Kind, fields]`, or null. */
export function asNode(x: unknown): [string, Record<string, unknown>] | null {
  if (!isObj(x)) return null;
  const keys = Object.keys(x);
  if (keys.length !== 1) return null;
  const k = keys[0] ?? '';
  const v = x[k];
  if (!/^[A-Z]/.test(k) || !isObj(v)) return null;
  return [k, v];
}

export const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/** Every node in a subtree, depth first, with its kind: `visit(kind, fields)`. */
export function walkNodes(
  x: unknown,
  visit: (kind: string, fields: Record<string, unknown>) => void,
): void {
  if (Array.isArray(x)) {
    for (const y of x) walkNodes(y, visit);
    return;
  }
  if (!isObj(x)) return;
  const n = asNode(x);
  if (n !== null) visit(n[0], n[1]);
  for (const v of Object.values(n === null ? x : n[1])) walkNodes(v, visit);
}

/**
 * Every node of a statement, THE STATEMENT ITSELF FIRST (`visit(s.kind, s.node)`), then its subtree.
 * `walkNodes(s.node, …)` would skip the statement's own node: `s.node` is its fields, not `{ Kind: … }`.
 */
export function walkStmt(
  s: AstStmt,
  visit: (kind: string, fields: Record<string, unknown>) => void,
): void {
  walkNodes({ [s.kind]: s.node }, visit);
}

/** The `sval`s of a list of `String` nodes (a qualified name), e.g. `['public', 'account']`. */
export function nameList(x: unknown): string[] {
  const items = Array.isArray(x) ? x : isObj(x) && isObj(x['List']) ? x['List']['items'] : null;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    const n = asNode(it);
    if (n !== null && n[0] === 'String') out.push(str(n[1]['sval']) ?? '');
  }
  return out;
}

/** A `RangeVar` (a relation as written): schema (or null when unqualified), name, persistence. */
export interface Rel {
  readonly schema: string | null;
  readonly name: string;
  readonly persistence: string;
}
export function rangeVar(x: unknown): Rel | null {
  const n =
    isObj(x) && isObj(x['RangeVar']) ? x['RangeVar'] : isObj(x) && 'relname' in x ? x : null;
  if (n === null) return null;
  const name = str(n['relname']);
  if (name === null) return null;
  return { schema: str(n['schemaname']), name, persistence: str(n['relpersistence']) ?? 'p' };
}

/** The string constants in a subtree (`A_Const` with `sval`), decoded by the parser. */
export function stringConstants(x: unknown): string[] {
  const out: string[] = [];
  walkNodes(x, (kind, f) => {
    if (kind !== 'A_Const' || !isObj(f['sval'])) return;
    const s = str(f['sval']['sval']);
    if (s !== null) out.push(s);
  });
  return out;
}

/**
 * Every identifier the statement names, as PostgreSQL resolves its spelling: every `String` node
 * (the parts of a qualified name, a function name, an object list) and every field that holds a name
 * directly (`relname`, `schemaname`, `trigname`, `newname`, `subname`, `name`, `extname`, `rolename`,
 * `conname`, `idxname`, `defname` excluded). String CONSTANTS are not identifiers and are not here.
 */
const NAME_FIELDS = new Set([
  'relname',
  'schemaname',
  'trigname',
  'newname',
  'subname',
  'name',
  'extname',
  'rolename',
  'conname',
  'idxname',
  'colname',
  'policy_name',
]);
export function identifiers(x: unknown): Set<string> {
  const out = new Set<string>();
  const go = (y: unknown, inConst: boolean): void => {
    if (Array.isArray(y)) {
      for (const z of y) go(z, inConst);
      return;
    }
    if (!isObj(y)) return;
    const n = asNode(y);
    if (n !== null) {
      const [kind, f] = n;
      if (kind === 'A_Const') return;
      if (kind === 'String' && !inConst) {
        const s = str(f['sval']);
        if (s !== null) out.add(s);
        return;
      }
      for (const [k, v] of Object.entries(f)) {
        if (NAME_FIELDS.has(k) && typeof v === 'string') out.add(v);
        else go(v, inConst);
      }
      return;
    }
    for (const [k, v] of Object.entries(y)) {
      if (NAME_FIELDS.has(k) && typeof v === 'string') out.add(v);
      else go(v, inConst);
    }
  };
  go(x, false);
  return out;
}

// ---------------------------------------------------------------------------

/** UTF-8 byte offsets (libpg_query's locations) to text. */
class Bytes {
  private readonly buf: Buffer;
  constructor(text: string) {
    this.buf = Buffer.from(text, 'utf8');
  }
  slice(from: number, to: number): string {
    return this.buf.subarray(from, to).toString('utf8');
  }
  lineAt(at: number): number {
    let n = 0;
    const end = Math.min(at, this.buf.length);
    for (let i = 0; i < end; i += 1) if (this.buf[i] === 0x0a) n += 1;
    return n;
  }
  get length(): number {
    return this.buf.length;
  }
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `sql` with every comment blanked (non-newline bytes -> spaces), using PostgreSQL's scanner; `null`
 * when the scanner refuses the text (an unterminated literal or comment).
 */
const fail = (): never => {
  throw new Error(`libpg-query is not loaded: ${pgUnavailable}`);
};

export function blankComments(sql: string): string | null {
  let scanned: unknown;
  try {
    scanned = (pg ?? fail()).scanSync(sql);
  } catch {
    return null;
  }
  const list = isObj(scanned) && Array.isArray(scanned['tokens']) ? scanned['tokens'] : [];
  const buf = Buffer.from(sql, 'utf8');
  let touched = false;
  for (const t of list) {
    if (!isObj(t)) continue;
    const name = str(t['tokenName']);
    if (name !== 'C_COMMENT' && name !== 'SQL_COMMENT') continue;
    const from = typeof t['start'] === 'number' ? t['start'] : -1;
    const to = typeof t['end'] === 'number' ? t['end'] : -1;
    if (from < 0 || to < from) return null;
    for (let i = from; i < to && i < buf.length; i += 1) if (buf[i] !== 0x0a) buf[i] = 0x20;
    touched = true;
  }
  return touched ? buf.toString('utf8') : sql;
}

interface Ctx {
  readonly pg: PgQuery;
  readonly stmts: AstStmt[];
  readonly errors: AstError[];
  /** Constants already parsed, so a literal repeated N times is read once per site depth. */
  readonly seen: Set<string>;
}

/**
 * Parses `sql` as a list of statements and reads each one, recursively. `required`: a parse failure is
 * an error (the file, a body); otherwise it is silently not SQL (a string constant).
 */
function readText(
  ctx: Ctx,
  sql: string,
  line: number,
  via: readonly string[],
  required: boolean,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    if (required)
      ctx.errors.push({ line, via, message: `nested deeper than ${String(MAX_DEPTH)}` });
    return;
  }
  const clean = blankComments(sql);
  if (clean === null) {
    if (required) ctx.errors.push({ line, via, message: 'does not lex' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = ctx.pg.parseSync(clean);
  } catch (e) {
    if (required) ctx.errors.push({ line, via, message: errMessage(e) });
    return;
  }
  const raws = isObj(parsed) && Array.isArray(parsed['stmts']) ? parsed['stmts'] : [];
  const bytes = new Bytes(clean);
  for (const raw of raws) {
    if (!isObj(raw)) continue;
    const n = asNode(raw['stmt']);
    if (n === null) continue;
    const loc = typeof raw['stmt_location'] === 'number' ? raw['stmt_location'] : 0;
    const len =
      typeof raw['stmt_len'] === 'number' && raw['stmt_len'] > 0
        ? raw['stmt_len']
        : bytes.length - loc;
    const text = bytes.slice(loc, loc + len);
    const at = via.length === 0 ? line + bytes.lineAt(loc) : line;
    readStmt(ctx, n[0], n[1], text, at, via, depth);
  }
}

function readStmt(
  ctx: Ctx,
  kind: string,
  node: Record<string, unknown>,
  text: string,
  line: number,
  via: readonly string[],
  depth: number,
): void {
  ctx.stmts.push({ kind, node, text: squash(text), line, via });

  // Bodies: DO, and CREATE FUNCTION|PROCEDURE with a quoted body.
  const body = bodyOf(kind, node);
  if (body !== null) {
    const where = [...via, body.label];
    if (body.language === 'plpgsql') readPlpgsql(ctx, text, line, where, depth + 1);
    else if (body.language === 'sql') readText(ctx, body.source, line, where, true, depth + 1);
  }

  // Every string constant in the statement, read as SQL where it parses (dynamic SQL).
  for (const s of stringConstants(node)) readConstant(ctx, s, line, via, depth);
}

function readConstant(
  ctx: Ctx,
  s: string,
  line: number,
  via: readonly string[],
  depth: number,
): void {
  if (!/[A-Za-z]/.test(s)) return;
  const key = `${String(depth)}\u0000${s}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  readText(ctx, s, line, [...via, 'string constant'], false, depth + 1);
}

interface Body {
  readonly label: string;
  readonly language: string;
  readonly source: string;
}

/** The body a DO or CREATE FUNCTION|PROCEDURE statement carries as a string, and its language. */
function bodyOf(kind: string, node: Record<string, unknown>): Body | null {
  if (kind !== 'DoStmt' && kind !== 'CreateFunctionStmt') return null;
  const opts = Array.isArray(node['args'])
    ? node['args']
    : Array.isArray(node['options'])
      ? node['options']
      : [];
  let language = kind === 'DoStmt' ? 'plpgsql' : 'sql';
  let source: string | null = null;
  for (const o of opts) {
    const d = asNode(o);
    if (d === null || d[0] !== 'DefElem') continue;
    const name = str(d[1]['defname']);
    const arg = d[1]['arg'];
    if (name === 'language') {
      const l = asNode(arg);
      if (l !== null && l[0] === 'String') language = (str(l[1]['sval']) ?? '').toLowerCase();
    } else if (name === 'as') {
      const l = asNode(arg);
      if (l !== null && l[0] === 'String') source = str(l[1]['sval']);
      else {
        const parts = nameList(arg);
        if (parts.length > 0) source = parts[0] ?? null;
      }
    }
  }
  if (source === null) return null; // BEGIN ATOMIC: its statements are already in the tree
  const fname = kind === 'CreateFunctionStmt' ? nameList(node['funcname']).join('.') : '';
  return {
    label: kind === 'DoStmt' ? `DO body (${language})` : `body of ${fname} (${language})`,
    language,
    source,
  };
}

/**
 * A PL/pgSQL DO block or function: parsed by libpg_query's PL/pgSQL parser from the statement's own
 * text (so a function's parameters and NEW/OLD are declared), then every expression in it read.
 */
function readPlpgsql(
  ctx: Ctx,
  stmtText: string,
  line: number,
  via: readonly string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    ctx.errors.push({ line, via, message: `nested deeper than ${String(MAX_DEPTH)}` });
    return;
  }
  const clean = blankComments(stmtText);
  if (clean === null) {
    ctx.errors.push({ line, via, message: 'does not lex' });
    return;
  }
  let tree: unknown;
  try {
    tree = ctx.pg.parsePlPgSQLSync(clean);
  } catch (e) {
    ctx.errors.push({ line, via, message: errMessage(e) });
    return;
  }
  const exprs: { query: string; mode: number }[] = [];
  walkNodes(tree, (kind, f) => {
    if (kind !== 'PLpgSQL_expr') return;
    const q = str(f['query']);
    if (q !== null)
      exprs.push({ query: q, mode: typeof f['parseMode'] === 'number' ? f['parseMode'] : 0 });
  });
  for (const e of exprs) {
    if (e.mode === 0) {
      readText(ctx, e.query, line, via, true, depth + 1);
      continue;
    }
    // An expression (mode 2) or an assignment `target := expr` (modes 3-5): read it as SELECT expr.
    const expr = e.mode === 2 ? e.query : afterAssignment(e.query);
    if (expr === null) {
      ctx.errors.push({
        line,
        via,
        message: `an assignment this gate cannot split: ${squash(e.query)}`,
      });
      continue;
    }
    readExpression(ctx, expr, line, via, depth + 1);
  }
}

/** `SELECT <expr>`: its string constants are what can carry SQL. */
function readExpression(
  ctx: Ctx,
  expr: string,
  line: number,
  via: readonly string[],
  depth: number,
): void {
  const clean = blankComments(expr);
  if (clean === null) {
    ctx.errors.push({ line, via, message: 'an expression does not lex' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = ctx.pg.parseSync(`SELECT ${clean}`);
  } catch (e) {
    ctx.errors.push({ line, via, message: `an expression does not parse: ${errMessage(e)}` });
    return;
  }
  for (const s of stringConstants(parsed)) readConstant(ctx, s, line, via, depth);
  // A FuncCall such as set_config(…) inside an expression is a statement's worth of effect too.
  const raws = isObj(parsed) && Array.isArray(parsed['stmts']) ? parsed['stmts'] : [];
  for (const raw of raws) {
    if (!isObj(raw)) continue;
    const n = asNode(raw['stmt']);
    if (n !== null)
      ctx.stmts.push({ kind: n[0], node: n[1], text: squash(`SELECT ${clean}`), line, via });
  }
}

/** The right-hand side of a PL/pgSQL assignment `target := expr` / `target = expr`, via the scanner. */
function afterAssignment(q: string): string | null {
  let tokens: unknown;
  try {
    tokens = (pg ?? fail()).scanSync(q);
  } catch {
    return null;
  }
  const list = isObj(tokens) && Array.isArray(tokens['tokens']) ? tokens['tokens'] : [];
  const bytes = new Bytes(q);
  for (const t of list) {
    if (!isObj(t)) continue;
    const name = str(t['tokenName']);
    const text = str(t['text']);
    if (name === 'COLON_EQUALS' || text === '=' || text === ':=') {
      const end = typeof t['end'] === 'number' ? t['end'] : -1;
      if (end < 0) return null;
      return bytes.slice(end, bytes.length);
    }
  }
  return null;
}

/** Reads a migration file: every statement at every depth, and what could not be parsed. */
export function readSqlAst(sql: string): AstRead {
  if (pg === null) {
    return {
      stmts: [],
      errors: [{ line: 1, via: [], message: `libpg-query could not be loaded (${pgUnavailable})` }],
    };
  }
  const ctx: Ctx = { pg, stmts: [], errors: [], seen: new Set() };
  readText(ctx, sql, 1, [], true, 0);
  return { stmts: ctx.stmts, errors: ctx.errors };
}
