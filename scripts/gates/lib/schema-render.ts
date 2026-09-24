/**
 * The rendering `db:introspect` applies to drizzle-kit's `schema.ts` before it writes or compares
 * `db/schema.ts` — T-150 (tech-lead), for OD-93 and OD-97.
 *
 * Why it exists. `db/schema.ts` is outside the root typecheck program until something imports it,
 * and the moment anything under apps/, packages/ or scripts/ does (a value import or `import type`
 * alike), `tsc` checks the whole file under the root `tsconfig.json`. drizzle-kit 0.31.10's raw
 * output fails that in two independent ways, both measured (T-144 and T-140 second approvals):
 *   - OD-93: unused identifiers (`(table) => [` with `table` unread; an `import { sql }` nothing
 *     reads) trip `noUnusedParameters` / `noUnusedLocals` (TS6133).
 *   - OD-97: a column type drizzle-kit cannot parse is written as `unknown("col")` behind a
 *     `// TODO: failed to parse database type '<t>'` line. `unknown` is a type keyword, so that is
 *     TS2693, and at an importer the column accepts a `number`.
 *
 * Two steps, both pure functions of drizzle-kit's text and the root tsconfig, so `--write` and
 * `--check` produce the same bytes and the parity check compares against this rendering:
 *   1. mapColumnTypes: each TODO + `unknown("col")` pair whose type is in COLUMN_TYPES (a CLOSED
 *      map, matched on the exact type string) becomes `<type>("col")`, and a `customType`
 *      definition is emitted for each type actually used. ANY other TODO type, or any `unknown(`
 *      left over, is a problem: the generator never writes `unknown(...)`.
 *      T-153 (OD-107): first, mapBigintColumns puts every int8 column in drizzle's bigint mode. The
 *      caller then holds the rendering against the catalogue with checkCatalogueColumns.
 *      T-153 rework 1 (OD-147, OD-148): that hold is a PER-COLUMN match, keyed by relation and
 *      column name, over the rendering PARSED AS TYPESCRIPT (parseRendering, the same compiler API
 *      the I-TSC step uses) — never a per-relation count and never a regex over the text. A count
 *      cannot see that a view's int8[] column was rendered without `.array()` (OD-147), and a regex
 *      over the text counts a `bigint(` that is only the content of a string literal (OD-148).
 *   2. pruneUnused: TypeScript's own `unusedIdentifier_delete` and `unusedIdentifier_deleteImports`
 *      combined fixes, repeated until a pass makes no edit, over a virtual file at db/schema.ts's
 *      real path, with the compiler options read from the root tsconfig.json (not a copy). Then
 *      every syntactic and semantic diagnostic still in the file is returned: the caller refuses
 *      to write or accept a rendering `tsc` would refuse.
 */
import path from 'node:path';
import ts from 'typescript';

/**
 * The closed map: database type (exact, as drizzle-kit prints it in its TODO line) -> the
 * customType definition. The data types are T-140's second approver's measurement (TL-A7): pg
 * 8.23.0 returns citext as a string and bytea as a Buffer. `citext[]`, `bytea[]` and every other
 * type are NOT in the map and fail the run.
 */
export const COLUMN_TYPES: ReadonlyMap<string, string> = new Map([
  [
    'citext',
    'customType<{ data: string; driverData: string }>({ dataType() { return "citext"; } })',
  ],
  ['bytea', 'customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return "bytea"; } })'],
]);

const TODO_COLUMN =
  /^[ \t]*\/\/ TODO: failed to parse database type '([^'\n]*)'\n([ \t]*[^\n]*?): unknown\("([^"\n]*)"/gm;
const PG_CORE_IMPORT = /^import \{ ([^}\n]*) \} from "drizzle-orm\/pg-core"$/m;

/**
 * T-153 (OD-107): bigint in drizzle's `bigint` mode. drizzle-kit 0.31.10 renders EVERY int8 column,
 * array or not, as `// You can use { mode: "bigint" } if numbers are exceeding js number limitations`
 * followed by `<key>: bigint(["<col>", ]{ mode: "number" })…`, so the importer type is `number` and
 * pg/drizzle read 9007199254740993 back as 9007199254740992 (measured, T-153 phase M). Each such pair
 * becomes `<key>: bigint(["<col>", ]{ mode: "bigint" })…`, the hint is dropped, and an integer default
 * drizzle-kit wrote as a number literal on that line (`.default(0)`, `.default([1, 9007199254740993])`)
 * gets bigint literals (`0n`), whose digits are drizzle-kit's text of the catalogue default, never a JS
 * number. `bigserial` is already rendered in bigint mode and is left alone.
 *
 * T-153 rework 1 (OD-148): this is a REWRITE of drizzle-kit 0.31.10's exact spelling, and nothing
 * else. It is NOT the safeguard — a bigint column in any other shape, any other spelling, any other
 * formatting, is caught by the per-column catalogue match below (checkCatalogueColumns), which reads
 * the parsed TypeScript and not this text. The only thing this step judges is its own completeness:
 * a copy of drizzle-kit's hint comment it did not consume, OUTSIDE any string literal (so a text
 * column whose DEFAULT is that sentence is no longer falsely refused — QR-A2).
 */
const BIGINT_HINT =
  '// You can use { mode: "bigint" } if numbers are exceeding js number limitations';
const BIGINT_NUMBER_COLUMN =
  /([ \t]*)\/\/ You can use \{ mode: "bigint" \} if numbers are exceeding js number limitations\n([ \t]*)([^\n]*?): bigint\(((?:"[^"\n]*", )?)\{ mode: "number" \}\)([^\n]*)/g;

export type BigintResult =
  | { readonly ok: true; readonly body: string; readonly columns: number }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The character ranges of every string and template literal in `text`, as TypeScript parses it. */
function literalRanges(text: string): ReadonlyArray<readonly [number, number]> {
  const sf = ts.createSourceFile(
    'rendering.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ranges: Array<readonly [number, number]> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      ranges.push([n.getStart(sf), n.getEnd()]);
      return;
    }
    n.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return ranges;
}

export function mapBigintColumns(body: string): BigintResult {
  let columns = 0;
  const out = body.replace(
    BIGINT_NUMBER_COLUMN,
    (
      _whole: string,
      _indent: string,
      lead: string,
      key: string,
      name: string,
      rest: string,
      offset: number,
      all: string,
    ) => {
      columns += 1;
      const atLineStart = offset === 0 || all[offset - 1] === '\n';
      const bigRest = rest.replace(/\.default\((-?[0-9]+)\)/g, '.default($1n)').replace(
        /\.default\(\[(-?[0-9]+(?:, -?[0-9]+)*)\]\)/g,
        (_m: string, list: string) =>
          `.default([${list
            .split(', ')
            .map((v) => `${v}n`)
            .join(', ')}])`,
      );
      return `${atLineStart ? '' : '\n'}${lead}${key}: bigint(${name}{ mode: "bigint" })${bigRest}`;
    },
  );
  const ranges = literalRanges(out);
  const problems: string[] = [];
  for (let i = out.indexOf(BIGINT_HINT); i !== -1; i = out.indexOf(BIGINT_HINT, i + 1)) {
    if (ranges.some(([a, b]) => i >= a && i < b)) continue;
    const line = out.slice(0, i).split('\n').length;
    problems.push(
      `rendering line ${String(line)} still carries drizzle-kit's bigint hint comment after the bigint-mode rewrite, so the rewrite did not recognise the column it belongs to (T-153): ${JSON.stringify(
        (out.split('\n')[line - 1] ?? '').trim().slice(0, 120),
      )}`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, body: out, columns };
}

/**
 * T-153 (OD-107): the catalogue side. Every column in `public` (relations of kind r, p, v, m, f owned by
 * no extension) whose type, or whose array element type, is int8 or PostGIS's geometry, with
 * `format_type`. Read by db-introspect.ts outside drizzle-kit, so neither rule below trusts
 * drizzle-kit's text.
 *
 * T-153 rework 1 (OD-147): also the column's ARRAY DIMENSIONS, because the per-column match compares
 * them with the rendered `.array()` depth. `pg_attribute.attndims` alone is not enough: it is 0 for a
 * VIEW column of an array type (measured, T-153 rework 1), which is exactly the case OD-147 is about.
 * So array-ness is decided by the type's own `typcategory = 'A'` and attndims only supplies the
 * dimension, floored at 1. Both are reported, so a disagreement is visible rather than assumed.
 */
export const COLUMN_TYPES_SQL = `
    SELECT coalesce(json_agg(json_build_object(
             'relation', c.relname,
             'column', a.attname,
             'type', format_type(a.atttypid, a.atttypmod),
             'attndims', a.attndims,
             'dims', CASE WHEN t.typcategory = 'A' THEN greatest(a.attndims, 1) ELSE 0 END,
             'kind', CASE WHEN et.oid = 'pg_catalog.int8'::regtype THEN 'int8' ELSE 'geometry' END)
             ORDER BY c.relname, a.attnum), '[]'::json)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_type et ON et.oid = CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE t.oid END
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND (et.oid = 'pg_catalog.int8'::regtype
            OR (et.typname = 'geometry' AND EXISTS (
                  SELECT 1 FROM pg_depend d JOIN pg_extension x ON x.oid = d.refobjid
                   WHERE d.classid = 'pg_type'::regclass AND d.objid = et.oid AND d.deptype = 'e'
                     AND x.extname = 'postgis')))`;

export interface CatalogueColumn {
  readonly relation: string;
  readonly column: string;
  readonly type: string;
  /** pg_attribute.attndims, as the catalogue holds it (0 on a view column of an array type). */
  readonly attndims: number;
  /** Array dimensions the rendering must express with `.array()`: 0 for a scalar. */
  readonly dims: number;
  readonly kind: 'int8' | 'geometry';
}

export function parseCatalogueColumns(
  out: string,
): { ok: true; columns: CatalogueColumn[] } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch (e) {
    return { ok: false, problem: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(value)) return { ok: false, problem: 'not a JSON array' };
  const columns: CatalogueColumn[] = [];
  for (const v of value as unknown[]) {
    const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    const { relation, column, type, attndims, dims, kind } = r;
    if (
      typeof relation !== 'string' ||
      typeof column !== 'string' ||
      typeof type !== 'string' ||
      typeof attndims !== 'number' ||
      typeof dims !== 'number' ||
      (kind !== 'int8' && kind !== 'geometry')
    ) {
      return {
        ok: false,
        problem: `a row is not {relation, column, type, attndims, dims, kind}: ${JSON.stringify(v)}`,
      };
    }
    columns.push({ relation, column, type, attndims, dims, kind });
  }
  return { ok: true, columns };
}

/**
 * Geometry admitted: a scalar 2D point, with or without an SRID. drizzle-orm 0.45.2's geometry reader
 * (`parseEWKB`) returns `[x, y]` for a point and throws `Unsupported geometry type` for every other
 * geometry; a PointZ row is read as `[x, y]`, losing Z (measured, T-153 phase M). An ARRAY of points
 * reads, but drizzle writes it as a malformed array literal that PostgreSQL refuses (measured, T-153
 * phase A), so it does not round-trip and is refused too. Matched exactly as `format_type` prints it.
 */
export const GEOMETRY_ADMITTED = /^geometry\(Point(?:,[0-9]+)?\)$/;

/**
 * T-153 rework 1 (OD-147, OD-148): the rendering, PARSED. One rendered column builder call, as the
 * TypeScript parser sees it — never as text, so no line break, quoting or spacing changes what it is,
 * and the content of a string literal is never mistaken for a call.
 */
export interface RenderedColumn {
  /** The object-literal key drizzle-kit wrote (its camelCase name). */
  readonly key: string;
  /** The DATABASE column name: the builder's first string argument, or the key when it has none. */
  readonly name: string;
  /** The identifier the call chain bottoms out in: `bigint`, `bigserial`, `text`, `geometry`, … */
  readonly builder: string;
  /** The `mode` option's string value, if the builder was given one. */
  readonly mode: string | undefined;
  /** How many `.array()` calls the chain carries. */
  readonly arrayDepth: number;
  readonly line: number;
  readonly text: string;
}

export interface RenderedRelation {
  readonly name: string;
  readonly kind: string;
  readonly columns: ReadonlyMap<string, RenderedColumn>;
  /** Entries in the column object this parse could not read as `<key>: <builder>(…)…`. */
  readonly unparsed: readonly string[];
}

const RELATION_BUILDERS: ReadonlySet<string> = new Set(['pgTable', 'pgView', 'pgMaterializedView']);

/** The innermost call whose callee is a plain identifier, and the method names on top of it. */
function unwrapChain(expr: ts.Node): { base: ts.CallExpression | undefined; methods: string[] } {
  const methods: string[] = [];
  let e: ts.Node = expr;
  for (;;) {
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression)) return { base: e, methods };
      if (ts.isPropertyAccessExpression(e.expression)) {
        methods.push(e.expression.name.text);
        e = e.expression.expression;
        continue;
      }
      return { base: undefined, methods };
    }
    if (ts.isPropertyAccessExpression(e) || ts.isParenthesizedExpression(e)) {
      e = e.expression;
      continue;
    }
    return { base: undefined, methods };
  }
}

function propertyName(n: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isStringLiteralLike(n)) return n.text;
  return undefined;
}

export function parseRendering(body: string): {
  relations: ReadonlyMap<string, RenderedRelation>;
  problems: readonly string[];
} {
  const sf = ts.createSourceFile(
    'rendering.ts',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const relations = new Map<string, RenderedRelation>();
  const problems: string[] = [];
  const lineOf = (n: ts.Node): number =>
    ts.getLineAndCharacterOfPosition(sf, n.getStart(sf)).line + 1;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (d.initializer === undefined) continue;
      const { base } = unwrapChain(d.initializer);
      if (base === undefined || !ts.isIdentifier(base.expression)) continue;
      const kind = base.expression.text;
      if (!RELATION_BUILDERS.has(kind)) continue;
      const nameArg = base.arguments[0];
      const colsArg = base.arguments[1];
      if (nameArg === undefined || !ts.isStringLiteralLike(nameArg)) {
        problems.push(
          `the rendering has a ${kind}(…) on line ${String(lineOf(base))} whose first argument is not a string relation name, so its columns cannot be held against the catalogue (T-153)`,
        );
        continue;
      }
      if (colsArg === undefined || !ts.isObjectLiteralExpression(colsArg)) {
        problems.push(
          `the rendering's ${kind}(${JSON.stringify(nameArg.text)}, …) on line ${String(lineOf(base))} has no column object literal, so its columns cannot be held against the catalogue (T-153)`,
        );
        continue;
      }
      const columns = new Map<string, RenderedColumn>();
      const unparsed: string[] = [];
      for (const p of colsArg.properties) {
        if (!ts.isPropertyAssignment(p)) {
          unparsed.push(p.getText(sf).trim().slice(0, 120));
          continue;
        }
        const key = propertyName(p.name);
        const { base: cb, methods } = unwrapChain(p.initializer);
        if (key === undefined || cb === undefined || !ts.isIdentifier(cb.expression)) {
          unparsed.push(p.getText(sf).trim().slice(0, 120));
          continue;
        }
        const first = cb.arguments[0];
        const name = first !== undefined && ts.isStringLiteralLike(first) ? first.text : key;
        let mode: string | undefined;
        for (const a of cb.arguments) {
          if (!ts.isObjectLiteralExpression(a)) continue;
          for (const op of a.properties) {
            if (!ts.isPropertyAssignment(op)) continue;
            if (propertyName(op.name) !== 'mode') continue;
            if (ts.isStringLiteralLike(op.initializer)) mode = op.initializer.text;
          }
        }
        const col: RenderedColumn = {
          key,
          name,
          builder: cb.expression.text,
          mode,
          arrayDepth: methods.filter((m) => m === 'array').length,
          line: lineOf(p),
          text: p.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 160),
        };
        if (columns.has(name)) {
          problems.push(
            `the rendering of ${JSON.stringify(nameArg.text)} has two columns for database column ${JSON.stringify(name)} (lines ${String(columns.get(name)?.line ?? 0)} and ${String(col.line)}) (T-153)`,
          );
        }
        columns.set(name, col);
      }
      if (relations.has(nameArg.text)) {
        problems.push(
          `the rendering declares relation ${JSON.stringify(nameArg.text)} twice (T-153)`,
        );
      }
      relations.set(nameArg.text, { name: nameArg.text, kind, columns, unparsed });
    }
  }
  return { relations, problems };
}

export interface CatalogueCheck {
  readonly problems: readonly string[];
  /** Catalogue int8 columns in `public`. */
  readonly int8: number;
  /** Of those, how many matched a rendered column exactly. */
  readonly matched: number;
  readonly relations: number;
  readonly points: number;
}

const BIGINT_BUILDERS: ReadonlySet<string> = new Set(['bigint', 'bigserial']);
const WANT = 'bigint({ mode: "bigint" })';

function expected(dims: number): string {
  return dims === 0 ? WANT : `${WANT}${'.array()'.repeat(dims)}`;
}

/**
 * T-153 rework 1: the two catalogue rules, both per column and both decided from the catalogue.
 *
 *  1. GEOMETRY. Every geometry column must be GEOMETRY_ADMITTED (a scalar 2D point), else a problem
 *     naming it and its `format_type`.
 *  2. INT8, MATCHED PER COLUMN (OD-147, OD-148), keyed by relation name and DATABASE column name:
 *     - every catalogue int8 column must be present in the rendering of its relation, built by
 *       `bigint`/`bigserial`, in `mode: "bigint"`, with exactly as many `.array()` calls as the
 *       catalogue's array dimensions. Absent, or any of those wrong, is a problem naming the column;
 *     - conversely, every rendered `bigint`/`bigserial` column must BE a catalogue int8 column, so a
 *       lossy column and a spurious bigint-mode column in the same relation cannot cancel out.
 *   Nothing here counts, and nothing here reads the rendering as text: `body` is parsed, so a string
 *   literal containing `bigint(` is a string literal, and a call split over lines is still the call.
 *
 * WIDTH (OE-35 (A), OD-149): rule 2 holds int8 columns ONLY. drizzle-kit 0.31.10 renders EVERY array
 * column of a view or materialized view with no `.array()`, whatever its element type (text[],
 * numeric[], timestamptz[] measured, as well as bigint[]). A view's int8[] is refused here; a view's
 * array of any OTHER type is read by nothing in this file, passes the gate typed as a scalar, and
 * reads a wrong value with no throw (numeric[] and timestamptz[] measured). That case is T-187's.
 */
export function checkCatalogueColumns(
  body: string,
  columns: readonly CatalogueColumn[],
): CatalogueCheck {
  const problems: string[] = [];
  let points = 0;
  for (const c of columns) {
    if (c.kind !== 'geometry') continue;
    if (!GEOMETRY_ADMITTED.test(c.type)) {
      problems.push(
        `column ${JSON.stringify(c.relation)}.${JSON.stringify(c.column)} has database type '${c.type}': drizzle-orm reads only a 2D point from a geometry column (any other geometry row throws "Unsupported geometry type"; a PointZ row loses Z; an array of points cannot be written), so only a scalar geometry(Point[,srid]) is admitted. Any other geometry column needs a measured mapping in scripts/gates/lib/schema-render.ts in the same change set (T-153, OD-107)`,
      );
    } else {
      points += 1;
    }
  }

  const int8 = matchInt8Columns(body, columns);
  problems.push(...int8.problems);
  return {
    problems,
    int8: int8.int8,
    matched: int8.matched,
    relations: int8.relations,
    points,
  };
}

export interface Int8Match {
  readonly problems: readonly string[];
  readonly int8: number;
  readonly matched: number;
  readonly relations: number;
}

/**
 * T-153 rework 1 (OD-147, OD-148): every catalogue int8 column matched against the PARSED rendering,
 * keyed by relation name and database column name. See checkCatalogueColumns above.
 */
export function matchInt8Columns(body: string, columns: readonly CatalogueColumn[]): Int8Match {
  const problems: string[] = [];
  const parsed = parseRendering(body);
  problems.push(...parsed.problems);
  const int8Columns = columns.filter((c) => c.kind === 'int8');
  const wanted = new Set(int8Columns.map((c) => JSON.stringify([c.relation, c.column])));
  let matched = 0;
  for (const c of int8Columns) {
    const rel = parsed.relations.get(c.relation);
    const where = `${JSON.stringify(c.relation)}.${JSON.stringify(c.column)}`;
    if (rel === undefined) {
      problems.push(
        `the catalogue has int8 column ${where} but the rendering declares no relation ${JSON.stringify(c.relation)}, so that column would be absent from db/schema.ts (T-153, OD-147)`,
      );
      continue;
    }
    const got = rel.columns.get(c.column);
    if (got === undefined) {
      problems.push(
        `the catalogue has int8 column ${where} (${c.type}) but the rendering of that ${rel.kind} has no column for it [rendered: ${[...rel.columns.keys()].map((k) => JSON.stringify(k)).join(', ')}${rel.unparsed.length > 0 ? `; unparsed entries: ${rel.unparsed.map((u) => JSON.stringify(u)).join(', ')}` : ''}] (T-153, OD-147)`,
      );
      continue;
    }
    if (!BIGINT_BUILDERS.has(got.builder)) {
      problems.push(
        `int8 column ${where} (${c.type}) is rendered on line ${String(got.line)} by drizzle's ${JSON.stringify(got.builder)}, not bigint/bigserial, so it would not reach importers as a JS bigint: expected ${expected(c.dims)}, got ${JSON.stringify(got.text)} (T-153, OD-147)`,
      );
      continue;
    }
    if (got.mode !== 'bigint') {
      problems.push(
        `int8 column ${where} (${c.type}) is rendered on line ${String(got.line)} in drizzle's ${got.mode === undefined ? 'default (no mode option)' : `"${got.mode}"`} mode, so it would reach importers as a JS number, lossy above 2^53: expected ${expected(c.dims)}, got ${JSON.stringify(got.text)} (T-153, OD-107)`,
      );
      continue;
    }
    if (got.arrayDepth !== c.dims) {
      problems.push(
        `int8 column ${where} is ${c.dims === 0 ? 'a scalar' : `an array of ${String(c.dims)} dimension(s)`} in the catalogue (${c.type}, attndims ${String(c.attndims)}) but the rendering on line ${String(got.line)} carries ${String(got.arrayDepth)} .array() call(s), so drizzle would read it with the wrong reader: expected ${expected(c.dims)}, got ${JSON.stringify(got.text)} (T-153, OD-147)`,
      );
      continue;
    }
    matched += 1;
  }
  for (const rel of parsed.relations.values()) {
    for (const col of rel.columns.values()) {
      if (!BIGINT_BUILDERS.has(col.builder)) continue;
      if (wanted.has(JSON.stringify([rel.name, col.name]))) continue;
      problems.push(
        `the rendering of ${JSON.stringify(rel.name)} builds column ${JSON.stringify(col.name)} on line ${String(col.line)} with drizzle's ${JSON.stringify(col.builder)}, but the catalogue does not list that column as int8: ${JSON.stringify(col.text)} (T-153, OD-148)`,
      );
    }
  }
  return { problems, int8: int8Columns.length, matched, relations: parsed.relations.size };
}

export type MapResult =
  | {
      readonly ok: true;
      readonly body: string;
      readonly mapped: readonly string[];
      readonly bigints: number;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

export function mapColumnTypes(raw: string): MapResult {
  const problems: string[] = [];
  const big = mapBigintColumns(raw);
  if (!big.ok) problems.push(...big.problems);
  const body = big.ok ? big.body : raw;
  const bigints = big.ok ? big.columns : 0;
  const used = new Set<string>();
  let out = body.replace(TODO_COLUMN, (whole: string, type: string, lead: string, col: string) => {
    if (!COLUMN_TYPES.has(type)) {
      problems.push(
        `column "${col}" has database type '${type}', which drizzle-kit cannot render and which is not in the closed map (${[...COLUMN_TYPES.keys()].join(', ')}). Add a measured mapping to scripts/gates/lib/schema-render.ts; the generator never writes unknown(...)`,
      );
      return whole;
    }
    used.add(type);
    return `${lead}: ${type}("${col}"`;
  });
  if (problems.length === 0) {
    const leftover = out
      .split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /\bunknown\(|\/\/ TODO: failed to parse/.test(l));
    for (const { l, n } of leftover) {
      problems.push(
        `drizzle-kit output line ${String(n)} still carries an unparsed type in a shape this rendering does not recognise: ${JSON.stringify(l.trim().slice(0, 120))}`,
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  if (used.size === 0) return { ok: true, body: out, mapped: [], bigints };

  const imp = PG_CORE_IMPORT.exec(out);
  if (imp === null) {
    return {
      ok: false,
      problems: ['no `import { … } from "drizzle-orm/pg-core"` line to add customType to'],
    };
  }
  const names = (imp[1] ?? '').split(',').map((s) => s.trim());
  if (!names.includes('customType')) {
    out = out.replace(
      PG_CORE_IMPORT,
      `import { customType, ${imp[1] ?? ''} } from "drizzle-orm/pg-core"`,
    );
  }
  const mapped = [...COLUMN_TYPES.keys()].filter((t) => used.has(t));
  const lines = out.split('\n');
  let at = 0;
  while (at < lines.length && (lines[at] ?? '').startsWith('import ')) at += 1;
  lines.splice(
    at,
    0,
    '',
    '// Column types drizzle-kit cannot render, mapped by scripts/gates/lib/schema-render.ts (T-150).',
    ...mapped.map((t) => `const ${t} = ${COLUMN_TYPES.get(t) ?? ''};`),
  );
  return { ok: true, body: lines.join('\n'), mapped, bigints };
}

export interface RootOptions {
  readonly options: ts.CompilerOptions;
  readonly errors: readonly string[];
}

/** The compiler options of the root tsconfig.json, as `tsc -p tsconfig.json` reads them. */
export function readRootCompilerOptions(tsconfigPath: string): RootOptions {
  const errors: string[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: (...a) => ts.sys.readDirectory(...a),
      fileExists: (f) => ts.sys.fileExists(f),
      readFile: (f) => ts.sys.readFile(f),
      getCurrentDirectory: () => path.dirname(tsconfigPath),
      onUnRecoverableConfigFileDiagnostic: (d) => {
        errors.push(ts.flattenDiagnosticMessageText(d.messageText, ' '));
      },
    },
  );
  if (parsed === undefined)
    return { options: {}, errors: [...errors, `cannot read ${tsconfigPath}`] };
  for (const d of parsed.errors) errors.push(ts.flattenDiagnosticMessageText(d.messageText, ' '));
  return { options: parsed.options, errors };
}

export interface PruneResult {
  readonly text: string;
  readonly passes: number;
  readonly edits: number;
  readonly converged: boolean;
  /** Every syntactic and semantic diagnostic left in the pruned text, as `TSnnnn line:col message`. */
  readonly diagnostics: readonly string[];
}

const FIX_IDS = ['unusedIdentifier_delete', 'unusedIdentifier_deleteImports'] as const;
const MAX_PASSES = 10;

/**
 * Apply TypeScript's unused-identifier fixes to `source`, compiled as though it were the file at
 * `fileName` (so imports resolve exactly as they do for db/schema.ts), until a pass edits nothing.
 */
export function pruneUnused(
  source: string,
  fileName: string,
  options: ts.CompilerOptions,
): PruneResult {
  let text = source;
  let version = 0;
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [fileName],
    getScriptVersion: (f) => (f === fileName ? String(version) : '0'),
    getScriptSnapshot: (f) => {
      if (f === fileName) return ts.ScriptSnapshot.fromString(text);
      const s = ts.sys.readFile(f);
      return s === undefined ? undefined : ts.ScriptSnapshot.fromString(s);
    },
    getCurrentDirectory: () => path.dirname(fileName),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => f === fileName || ts.sys.fileExists(f),
    readFile: (f) => (f === fileName ? text : ts.sys.readFile(f)),
    readDirectory: (...a) => ts.sys.readDirectory(...a),
    directoryExists: (d) => ts.sys.directoryExists(d),
    getDirectories: (d) => ts.sys.getDirectories(d),
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  let passes = 0;
  let edits = 0;
  let converged = false;
  while (passes < MAX_PASSES) {
    passes += 1;
    let passEdits = 0;
    for (const fixId of FIX_IDS) {
      const fix = ls.getCombinedCodeFix({ type: 'file', fileName }, fixId, {}, {});
      const changes = fix.changes
        .filter((c) => c.fileName === fileName)
        .flatMap((c) => c.textChanges)
        .sort((a, b) => b.span.start - a.span.start);
      for (const c of changes) {
        text = text.slice(0, c.span.start) + c.newText + text.slice(c.span.start + c.span.length);
      }
      if (changes.length > 0) version += 1;
      passEdits += changes.length;
    }
    edits += passEdits;
    if (passEdits === 0) {
      converged = true;
      break;
    }
  }
  const sf = ls.getProgram()?.getSourceFile(fileName);
  const diagnostics = [
    ...ls.getSyntacticDiagnostics(fileName),
    ...ls.getSemanticDiagnostics(fileName),
  ].map((d) => {
    const pos =
      sf !== undefined && d.start !== undefined
        ? ts.getLineAndCharacterOfPosition(sf, d.start)
        : { line: -1, character: -1 };
    return `TS${String(d.code)} ${String(pos.line + 1)}:${String(pos.character + 1)} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
  return { text, passes, edits, converged, diagnostics };
}

export const TYPESCRIPT_VERSION = ts.version;
