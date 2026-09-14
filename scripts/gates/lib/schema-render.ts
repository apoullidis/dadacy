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

export type MapResult =
  | { readonly ok: true; readonly body: string; readonly mapped: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] };

export function mapColumnTypes(body: string): MapResult {
  const problems: string[] = [];
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
  if (used.size === 0) return { ok: true, body: out, mapped: [] };

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
  return { ok: true, body: lines.join('\n'), mapped };
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
