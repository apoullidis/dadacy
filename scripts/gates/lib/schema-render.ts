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
 *      caller then holds the rendering against the catalogue with checkCatalogueColumns: bigint-mode
 *      columns per relation = int8 columns, and geometry only as a 2D point.
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
 * number. A hint or a `mode: "number"` bigint/bigserial call left in any other shape is a problem.
 * `bigserial` is already rendered in bigint mode and is left alone.
 */
const BIGINT_HINT =
  '// You can use { mode: "bigint" } if numbers are exceeding js number limitations';
const BIGINT_NUMBER_COLUMN =
  /([ \t]*)\/\/ You can use \{ mode: "bigint" \} if numbers are exceeding js number limitations\n([ \t]*)([^\n]*?): bigint\(((?:"[^"\n]*", )?)\{ mode: "number" \}\)([^\n]*)/g;
const NUMBER_MODE_CALL = /\bbig(?:int|serial)\((?:"[^"\n]*", )?\{[^}\n]*\bmode: "number"/;
/** A bigint or bigserial column call in drizzle's bigint mode, as counted against the catalogue. */
export const BIGINT_MODE_CALL = /\bbig(?:int|serial)\((?:"[^"\n]*", )?\{ mode: "bigint" \}\)/g;

export type BigintResult =
  | { readonly ok: true; readonly body: string; readonly columns: number }
  | { readonly ok: false; readonly problems: readonly string[] };

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
  const problems = out
    .split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => l.includes(BIGINT_HINT) || NUMBER_MODE_CALL.test(l))
    .map(
      ({ l, n }) =>
        `rendering line ${String(n)} has a bigint column in a shape this rendering does not recognise, so it would reach importers as a JS number, lossy above 2^53 (T-153): ${JSON.stringify(l.trim().slice(0, 120))}`,
    );
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, body: out, columns };
}

/**
 * T-153 (OD-107): the catalogue side. Every column in `public` (relations of kind r, p, v, m, f owned by
 * no extension) whose type, or whose array element type, is int8 or PostGIS's geometry, with
 * `format_type`. Read by db-introspect.ts outside drizzle-kit, so neither rule below trusts
 * drizzle-kit's text.
 */
export const COLUMN_TYPES_SQL = `
    SELECT coalesce(json_agg(json_build_object(
             'relation', c.relname,
             'column', a.attname,
             'type', format_type(a.atttypid, a.atttypmod),
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
    const { relation, column, type, kind } = r;
    if (
      typeof relation !== 'string' ||
      typeof column !== 'string' ||
      typeof type !== 'string' ||
      (kind !== 'int8' && kind !== 'geometry')
    ) {
      return {
        ok: false,
        problem: `a row is not {relation, column, type, kind}: ${JSON.stringify(v)}`,
      };
    }
    columns.push({ relation, column, type, kind });
  }
  return { ok: true, columns };
}

/**
 * Geometry admitted: a 2D point, with or without an SRID, or an array of them. drizzle-orm 0.45.2's
 * geometry reader (`parseEWKB`) returns `[x, y]` for a point and throws `Unsupported geometry type` for
 * every other geometry; a PointZ row is read as `[x, y]`, losing Z (all measured, T-153 phase M). The
 * geometry type name is matched exactly as `format_type` prints it.
 */
export const GEOMETRY_ADMITTED = /^geometry\(Point(?:,[0-9]+)?\)(?:\[\])?$/;

export interface CatalogueCheck {
  readonly problems: readonly string[];
  readonly int8: number;
  readonly bigintRendered: number;
  readonly points: number;
}

/**
 * T-153: (1) every geometry column must be GEOMETRY_ADMITTED, else a problem naming it; (2) for each
 * relation, the number of bigint/bigserial calls in drizzle's bigint mode in its rendering must equal the
 * catalogue's int8 columns in it. A relation's rendering runs from its `export const … = pgTable|pgView|
 * pgMaterializedView("<name>"` line to the next `export const`.
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
        `column ${JSON.stringify(c.relation)}.${JSON.stringify(c.column)} has database type '${c.type}': drizzle-orm reads only a 2D point from a geometry column (any other geometry row throws "Unsupported geometry type"; a PointZ row loses Z), so only geometry(Point[,srid]) and its array are admitted. A non-point geometry column needs a measured mapping in scripts/gates/lib/schema-render.ts in the same change set (T-153, OD-107)`,
      );
    } else {
      points += 1;
    }
  }
  const starts = [...body.matchAll(/^export const [\w$]+ = /gm)];
  const rendered = new Map<string, number>();
  starts.forEach((m, i) => {
    const text = body.slice(m.index, starts[i + 1]?.index ?? body.length);
    const rel = /^export const [\w$]+ = pg(?:Table|View|MaterializedView)\("([^"]+)"/.exec(
      text,
    )?.[1];
    if (rel === undefined) return;
    rendered.set(rel, (rendered.get(rel) ?? 0) + [...text.matchAll(BIGINT_MODE_CALL)].length);
  });
  const catalogue = new Map<string, string[]>();
  for (const c of columns) {
    if (c.kind !== 'int8') continue;
    catalogue.set(c.relation, [...(catalogue.get(c.relation) ?? []), c.column]);
  }
  let int8 = 0;
  let bigintRendered = 0;
  for (const rel of [...new Set([...rendered.keys(), ...catalogue.keys()])].sort()) {
    const want = catalogue.get(rel) ?? [];
    const got = rendered.get(rel) ?? 0;
    int8 += want.length;
    bigintRendered += got;
    if (got !== want.length) {
      problems.push(
        `relation ${JSON.stringify(rel)}: the catalogue has ${String(want.length)} int8 column(s) [${want.join(', ')}] but the rendering has ${String(got)} bigint column(s) in drizzle's bigint mode (T-153, OD-107)`,
      );
    }
  }
  return { problems, int8, bigintRendered, points };
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
