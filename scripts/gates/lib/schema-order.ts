/**
 * The canonical order `db:introspect` gives drizzle-kit's `schema.ts` before it prunes, writes or
 * compares `db/schema.ts` — T-152 (tech-lead), for OD-106 and OD-108.
 *
 * Why it exists. drizzle-kit 0.31.10's pull reads several catalogue queries that have no ORDER BY
 * (node_modules/drizzle-kit/bin.cjs: the table list at line 17559, constraint rows at 17734, checks
 * at 17742, foreign keys at 17769, sequences at 17599) and renders objects in the order the rows
 * arrive. That order follows the query plan, not the schema. Measured (T-152 E-M1): planner
 * statistics decide the constraint rows, so a composite primary key's columns flip after ANALYZE;
 * heap position decides the table list, so an up/down/up of a migration reorders the tables and the
 * import list even after ANALYZE.
 *
 * What it does, to the text drizzle-kit wrote (after T-150's type map, before pruning):
 *   1. Key column lists. Every `primaryKey({ columns: [...] })`, `foreignKey({ columns: [...],
 *      foreignColumns: [...] })` and `unique("name").on(...)` list is put in the constraint's own
 *      column order (pg_constraint.conkey / confkey), which the caller reads from the catalogue. The
 *      rendered list must name exactly the catalogue's columns, or it is a problem.
 *   2. Each table's extra-config array. Entries are sorted by drizzle-kit's own kind order (indexes,
 *      foreign keys, primary key, uniques, policies, checks), then by name, then by their text.
 *   3. Top-level declarations. Within each contiguous run of one kind (pgEnum, pgSequence, pgTable,
 *      pgView, pgMaterializedView), statements are sorted by the object's name.
 *   4. The `drizzle-orm/pg-core` import specifiers, sorted by name.
 * Every sort compares UTF-16 code units, never a locale. Elements are permuted into the slots the
 * input already had, so the text between elements stays where it was and the step is idempotent.
 * A shape it does not recognise, or text other than separators between elements, is a problem: it
 * never passes text through unordered.
 */
import ts from 'typescript';

/** One PRIMARY KEY, UNIQUE or FOREIGN KEY constraint in `public`, as the catalogue orders its columns. */
export interface ConstraintKey {
  readonly table: string;
  readonly name: string;
  readonly type: 'p' | 'u' | 'f';
  readonly columns: readonly string[];
  readonly foreignTable: string | null;
  readonly foreignColumns: readonly string[];
}

export type OrderResult =
  | {
      readonly ok: true;
      readonly body: string;
      /** declarations in sorted runs, table entries, key column lists checked against the catalogue */
      readonly declarations: number;
      readonly entries: number;
      readonly keyLists: number;
      /** elements that were not already where the canonical order puts them */
      readonly moved: number;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The catalogue query the caller runs. One JSON array; column names are JSON strings, so no name
 * can be confused with a separator.
 */
export const CONSTRAINT_KEYS_SQL = `
  SELECT coalesce(json_agg(json_build_object(
           'table', cl.relname,
           'name', con.conname,
           'type', con.contype::text,
           'columns', (SELECT json_agg(a.attname ORDER BY k.ord)
                         FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
           'foreignTable', fcl.relname,
           'foreignColumns', (SELECT json_agg(a.attname ORDER BY k.ord)
                                FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum))
         ORDER BY cl.relname, con.conname), '[]'::json)
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    LEFT JOIN pg_class fcl ON fcl.oid = con.confrelid
   WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f')`;

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** Parse and shape-check the output of CONSTRAINT_KEYS_SQL. */
export function parseConstraintKeys(
  json: string,
):
  | { readonly ok: true; readonly keys: readonly ConstraintKey[] }
  | { readonly ok: false; readonly problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, problem: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(data)) return { ok: false, problem: 'not a JSON array' };
  const keys: ConstraintKey[] = [];
  for (const row of data) {
    const r: unknown = row;
    if (typeof r !== 'object' || r === null)
      return { ok: false, problem: 'a row is not an object' };
    const table: unknown = Reflect.get(r, 'table');
    const name: unknown = Reflect.get(r, 'name');
    const type: unknown = Reflect.get(r, 'type');
    const columns: unknown = Reflect.get(r, 'columns');
    const foreignTable: unknown = Reflect.get(r, 'foreignTable');
    const foreignColumns: unknown = Reflect.get(r, 'foreignColumns');
    if (
      typeof table !== 'string' ||
      typeof name !== 'string' ||
      (type !== 'p' && type !== 'u' && type !== 'f') ||
      !isStrings(columns) ||
      !(foreignTable === null || typeof foreignTable === 'string') ||
      !(foreignColumns === null || isStrings(foreignColumns))
    ) {
      return {
        ok: false,
        problem: `row ${JSON.stringify(r).slice(0, 200)} does not have the expected shape`,
      };
    }
    keys.push({ table, name, type, columns, foreignTable, foreignColumns: foreignColumns ?? [] });
  }
  return { ok: true, keys };
}

const DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'pgEnum',
  'pgSequence',
  'pgTable',
  'pgView',
  'pgMaterializedView',
]);

/** drizzle-kit's own emission order for a table's extra config (bin.cjs 85420-85438). */
const ENTRY_RANK: ReadonlyMap<string, number> = new Map([
  ['index', 0],
  ['uniqueIndex', 0],
  ['foreignKey', 1],
  ['primaryKey', 2],
  ['unique', 3],
  ['pgPolicy', 4],
  ['check', 5],
]);

const LIST_GAP = /^\s*,\s*$/;
const DECLARATION_GAP = /^\s*$/;
const PG_CORE = 'drizzle-orm/pg-core';

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Item {
  readonly node: ts.Node;
  readonly key: string;
}

interface TableModel {
  readonly constName: string;
  readonly dbName: string;
  /** property key in the columns object -> database column name */
  readonly keyToDb: ReadonlyMap<string, string>;
  readonly call: ts.CallExpression;
}

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('schema.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function snippet(sf: ts.SourceFile, node: ts.Node): string {
  return JSON.stringify(node.getText(sf).replace(/\s+/g, ' ').slice(0, 100));
}

/** The innermost call of a chain such as `index("n").using(...).where(...)`. */
function rootCall(node: ts.Expression): ts.CallExpression | undefined {
  let n: ts.Expression = node;
  while (ts.isCallExpression(n)) {
    if (ts.isIdentifier(n.expression)) return n;
    if (!ts.isPropertyAccessExpression(n.expression)) return undefined;
    n = n.expression.expression;
  }
  return undefined;
}

function calleeName(call: ts.CallExpression | undefined): string | undefined {
  return call !== undefined && ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

function stringArg(call: ts.CallExpression, i: number): string | undefined {
  const a = call.arguments[i];
  return a !== undefined && ts.isStringLiteral(a) ? a.text : undefined;
}

function objectProperty(obj: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (obj === undefined || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
      return p.initializer;
    }
  }
  return undefined;
}

/**
 * Put `items` into the order of their keys by moving each element's text into an existing slot, so
 * the text between slots stays where it was. That text must match `gap`.
 */
function permute(
  sf: ts.SourceFile,
  items: readonly Item[],
  gap: RegExp,
  where: string,
  problems: string[],
): { readonly edits: readonly Edit[]; readonly moved: number } {
  for (let i = 1; i < items.length; i += 1) {
    const a = items[i - 1];
    const b = items[i];
    if (a === undefined || b === undefined) continue;
    const between = sf.text.slice(a.node.getEnd(), b.node.getStart(sf));
    if (!gap.test(between)) {
      problems.push(
        `${where}: unexpected text ${JSON.stringify(between.slice(0, 80))} after ${snippet(sf, a.node)}; only separators may lie between the elements this step orders`,
      );
      return { edits: [], moved: 0 };
    }
  }
  const sorted = [...items].sort((x, y) => byCodeUnit(x.key, y.key));
  const edits: Edit[] = [];
  let moved = 0;
  items.forEach((slot, i) => {
    const into = sorted[i];
    if (into === undefined || into.node.getText(sf) === slot.node.getText(sf)) return;
    moved += 1;
    edits.push({
      start: slot.node.getStart(sf),
      end: slot.node.getEnd(),
      text: into.node.getText(sf),
    });
  });
  return { edits, moved };
}

function declarationOf(stmt: ts.Statement):
  | {
      readonly constName: string;
      readonly kind: string;
      readonly name: string | undefined;
      readonly call: ts.CallExpression;
    }
  | undefined {
  if (!ts.isVariableStatement(stmt)) return undefined;
  const decls = stmt.declarationList.declarations;
  const decl = decls[0];
  if (
    decls.length !== 1 ||
    decl === undefined ||
    !ts.isIdentifier(decl.name) ||
    decl.initializer === undefined
  ) {
    return undefined;
  }
  const call = rootCall(decl.initializer);
  const kind = calleeName(call);
  if (call === undefined || kind === undefined || !DECLARATION_KINDS.has(kind)) return undefined;
  return { constName: decl.name.text, kind, name: stringArg(call, 0), call };
}

function tableModels(sf: ts.SourceFile, problems: string[]): Map<string, TableModel> {
  const out = new Map<string, TableModel>();
  for (const stmt of sf.statements) {
    const d = declarationOf(stmt);
    if (d === undefined || d.kind !== 'pgTable' || d.name === undefined) continue;
    const cols = d.call.arguments[1];
    if (cols === undefined || !ts.isObjectLiteralExpression(cols)) {
      problems.push(`table "${d.name}": its second argument is not an object literal of columns`);
      continue;
    }
    const keyToDb = new Map<string, string>();
    for (const p of cols.properties) {
      const key =
        ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
          ? p.name.text
          : undefined;
      const call =
        key !== undefined && ts.isPropertyAssignment(p) ? rootCall(p.initializer) : undefined;
      if (key === undefined || call === undefined) {
        problems.push(
          `table "${d.name}": column ${snippet(sf, p)} is not in a shape this step recognises`,
        );
        continue;
      }
      keyToDb.set(key, stringArg(call, 0) ?? key);
    }
    out.set(d.constName, { constName: d.constName, dbName: d.name, keyToDb, call: d.call });
  }
  return out;
}

/** A table's `(table) => [ ... ]` extra config, if it has one. */
function extrasOf(
  sf: ts.SourceFile,
  t: TableModel,
  problems: string[],
): { readonly param: string | undefined; readonly array: ts.ArrayLiteralExpression } | undefined {
  const fn = t.call.arguments[2];
  if (fn === undefined) return undefined;
  if (
    !ts.isArrowFunction(fn) ||
    !ts.isArrayLiteralExpression(fn.body) ||
    t.call.arguments.length > 3
  ) {
    problems.push(
      `table "${t.dbName}": its extra config ${snippet(sf, fn)} is not \`(table) => [ ... ]\``,
    );
    return undefined;
  }
  const p = fn.parameters[0];
  return {
    param: p !== undefined && ts.isIdentifier(p.name) ? p.name.text : undefined,
    array: fn.body,
  };
}

/** Order one rendered column list by the catalogue's key order, after checking it names exactly those columns. */
function orderList(
  sf: ts.SourceFile,
  elements: readonly ts.Expression[],
  wantTable: string,
  want: readonly string[],
  resolve: (e: ts.Expression) => { readonly table: string; readonly column: string } | undefined,
  where: string,
  problems: string[],
): { readonly edits: readonly Edit[]; readonly moved: number } {
  const got = elements.map(resolve);
  const cols: string[] = [];
  for (const [i, r] of got.entries()) {
    const el = elements[i];
    if (r === undefined || r.table !== wantTable) {
      problems.push(
        `${where}: ${el === undefined ? 'an element' : snippet(sf, el)} is not a column of table "${wantTable}" in this rendering`,
      );
      return { edits: [], moved: 0 };
    }
    cols.push(r.column);
  }
  const same =
    cols.length === want.length &&
    [...cols].sort(byCodeUnit).join(' ') === [...want].sort(byCodeUnit).join(' ');
  if (!same) {
    problems.push(
      `${where}: the rendering lists columns [${cols.join(', ')}] but the catalogue's key is [${want.join(', ')}]`,
    );
    return { edits: [], moved: 0 };
  }
  const items = elements.map((node, i) => ({
    node,
    key: String(want.indexOf(cols[i] ?? '')).padStart(6, '0'),
  }));
  return permute(sf, items, LIST_GAP, where, problems);
}

/** Pass 1: key column lists from the catalogue. */
function keyListPass(
  sf: ts.SourceFile,
  keys: readonly ConstraintKey[],
  problems: string[],
): { readonly edits: readonly Edit[]; readonly moved: number; readonly lists: number } {
  const models = tableModels(sf, problems);
  const edits: Edit[] = [];
  let moved = 0;
  let lists = 0;
  const find = (table: string, name: string | undefined, type: ConstraintKey['type']) =>
    keys.find((k) => k.table === table && k.name === name && k.type === type);
  for (const t of models.values()) {
    const x = extrasOf(sf, t, problems);
    if (x === undefined) continue;
    const resolve = (e: ts.Expression): { table: string; column: string } | undefined => {
      if (
        !ts.isPropertyAccessExpression(e) ||
        !ts.isIdentifier(e.expression) ||
        !ts.isIdentifier(e.name)
      ) {
        return undefined;
      }
      const owner = e.expression.text === x.param ? t : models.get(e.expression.text);
      const column = owner?.keyToDb.get(e.name.text);
      return owner === undefined || column === undefined
        ? undefined
        : { table: owner.dbName, column };
    };
    const add = (r: { readonly edits: readonly Edit[]; readonly moved: number }): void => {
      edits.push(...r.edits);
      moved += r.moved;
      lists += 1;
    };
    for (const el of x.array.elements) {
      const rc = rootCall(el);
      const kind = calleeName(rc);
      if (rc === undefined) continue;
      if (kind === 'primaryKey' || kind === 'foreignKey') {
        const obj = rc.arguments[0];
        const nameNode = objectProperty(obj, 'name');
        const name =
          nameNode !== undefined && ts.isStringLiteral(nameNode) ? nameNode.text : undefined;
        const key = find(t.dbName, name, kind === 'primaryKey' ? 'p' : 'f');
        const columns = objectProperty(obj, 'columns');
        if (key === undefined || columns === undefined || !ts.isArrayLiteralExpression(columns)) {
          problems.push(
            `table "${t.dbName}": ${kind} ${JSON.stringify(name ?? '(no name)')} has no matching ${kind === 'primaryKey' ? 'PRIMARY KEY' : 'FOREIGN KEY'} constraint of that table in the catalogue, or no \`columns: [ ... ]\``,
          );
          continue;
        }
        add(
          orderList(
            sf,
            columns.elements,
            t.dbName,
            key.columns,
            resolve,
            `${t.dbName}.${key.name} columns`,
            problems,
          ),
        );
        if (kind === 'foreignKey') {
          const foreign = objectProperty(obj, 'foreignColumns');
          if (
            foreign === undefined ||
            !ts.isArrayLiteralExpression(foreign) ||
            key.foreignTable === null
          ) {
            problems.push(
              `table "${t.dbName}": foreignKey "${key.name}" has no \`foreignColumns: [ ... ]\` or no referenced table`,
            );
            continue;
          }
          add(
            orderList(
              sf,
              foreign.elements,
              key.foreignTable,
              key.foreignColumns,
              resolve,
              `${t.dbName}.${key.name} foreignColumns`,
              problems,
            ),
          );
        }
      } else if (kind === 'unique') {
        const name = stringArg(rc, 0);
        const key = find(t.dbName, name, 'u');
        let on: ts.CallExpression | undefined;
        for (
          let n: ts.Expression = el;
          ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression);
          n = n.expression.expression
        ) {
          if (n.expression.name.text === 'on' && n.expression.expression === rc) on = n;
        }
        if (key === undefined || on === undefined) {
          problems.push(
            `table "${t.dbName}": unique ${JSON.stringify(name ?? '(no name)')} has no matching UNIQUE constraint of that table in the catalogue, or no \`.on( ... )\``,
          );
          continue;
        }
        add(
          orderList(
            sf,
            on.arguments,
            t.dbName,
            key.columns,
            resolve,
            `${t.dbName}.${key.name} columns`,
            problems,
          ),
        );
      }
    }
  }
  return { edits, moved, lists };
}

/** Pass 2: each table's extra-config entries. */
function entryPass(
  sf: ts.SourceFile,
  problems: string[],
): { readonly edits: readonly Edit[]; readonly moved: number; readonly entries: number } {
  const edits: Edit[] = [];
  let moved = 0;
  let entries = 0;
  for (const t of tableModels(sf, problems).values()) {
    const x = extrasOf(sf, t, problems);
    if (x === undefined) continue;
    const items: Item[] = [];
    for (const el of x.array.elements) {
      const rc = rootCall(el);
      const kind = calleeName(rc);
      const rank = kind === undefined ? undefined : ENTRY_RANK.get(kind);
      if (rc === undefined || rank === undefined) {
        problems.push(
          `table "${t.dbName}": extra-config entry ${snippet(sf, el)} is not a kind this step orders`,
        );
        continue;
      }
      let name: string | undefined;
      if (kind === 'primaryKey' || kind === 'foreignKey') {
        const n = objectProperty(rc.arguments[0], 'name');
        name = n !== undefined && ts.isStringLiteral(n) ? n.text : undefined;
      } else {
        name = stringArg(rc, 0) ?? (kind === 'index' || kind === 'uniqueIndex' ? '' : undefined);
      }
      if (name === undefined) {
        problems.push(`table "${t.dbName}": extra-config entry ${snippet(sf, el)} has no name`);
        continue;
      }
      items.push({ node: el, key: `${String(rank)} ${name} ${el.getText(sf)}` });
    }
    entries += items.length;
    const r = permute(sf, items, LIST_GAP, `table "${t.dbName}" extra config`, problems);
    edits.push(...r.edits);
    moved += r.moved;
  }
  return { edits, moved, entries };
}

/** Pass 3: top-level declarations, sorted within each contiguous run of one kind. */
function declarationPass(
  sf: ts.SourceFile,
  problems: string[],
): { readonly edits: readonly Edit[]; readonly moved: number; readonly declarations: number } {
  const edits: Edit[] = [];
  let moved = 0;
  let declarations = 0;
  let run: Item[] = [];
  let runKind: string | undefined;
  const flush = (): void => {
    declarations += run.length;
    const r = permute(sf, run, DECLARATION_GAP, `the ${String(runKind)} declarations`, problems);
    edits.push(...r.edits);
    moved += r.moved;
    run = [];
    runKind = undefined;
  };
  for (const stmt of sf.statements) {
    const d = declarationOf(stmt);
    if (d !== undefined && d.name === undefined) {
      problems.push(
        `declaration ${snippet(sf, stmt)} does not name its object with a string literal`,
      );
    }
    const kind = d?.name === undefined ? undefined : d.kind;
    if (kind !== runKind) flush();
    if (d !== undefined && kind !== undefined) {
      runKind = kind;
      run.push({ node: stmt, key: `${String(d.name)} ${stmt.getText(sf)}` });
    }
  }
  flush();
  return { edits, moved, declarations };
}

/** Pass 4: the drizzle-orm/pg-core import specifiers. */
function importPass(
  sf: ts.SourceFile,
  problems: string[],
): { readonly edits: readonly Edit[]; readonly moved: number } {
  const edits: Edit[] = [];
  let moved = 0;
  for (const stmt of sf.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !ts.isStringLiteral(stmt.moduleSpecifier) ||
      stmt.moduleSpecifier.text !== PG_CORE
    ) {
      continue;
    }
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      problems.push(`the ${PG_CORE} import ${snippet(sf, stmt)} has no named imports`);
      continue;
    }
    const items = bindings.elements.map((s) => ({
      node: s,
      key: `${s.name.text} ${s.getText(sf)}`,
    }));
    const r = permute(sf, items, LIST_GAP, `the ${PG_CORE} import`, problems);
    edits.push(...r.edits);
    moved += r.moved;
  }
  return { edits, moved };
}

export function canonicalOrder(source: string, keys: readonly ConstraintKey[]): OrderResult {
  const problems: string[] = [];
  let text = source;
  const lists = keyListPass(parse(text), keys, problems);
  if (problems.length > 0) return { ok: false, problems };
  text = applyEdits(text, lists.edits);
  const entries = entryPass(parse(text), problems);
  if (problems.length > 0) return { ok: false, problems };
  text = applyEdits(text, entries.edits);
  const declarations = declarationPass(parse(text), problems);
  if (problems.length > 0) return { ok: false, problems };
  text = applyEdits(text, declarations.edits);
  const imports = importPass(parse(text), problems);
  if (problems.length > 0) return { ok: false, problems };
  text = applyEdits(text, imports.edits);
  return {
    ok: true,
    body: text,
    declarations: declarations.declarations,
    entries: entries.entries,
    keyLists: lists.lists,
    moved: lists.moved + entries.moved + declarations.moved + imports.moved,
  };
}
