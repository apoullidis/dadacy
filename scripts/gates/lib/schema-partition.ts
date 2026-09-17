/**
 * The partitioned-table step `db:introspect` applies to drizzle-kit's `schema.ts` before the policy
 * step, the canonical order and pruning — T-165 (tech-lead), for OD-84.
 *
 * Why it exists. drizzle-kit 0.31.10 lists relations with `c.relkind IN ('r', 'v', 'm')`
 * (node_modules/drizzle-kit/bin.cjs 17574 and 18435), so a PARTITIONED TABLE — `relkind = 'p'` — is
 * never rendered, while each of its PARTITIONS is rendered as a plain `pgTable` of its own. Measured
 * (T-165 § Evidence M1–M4): a parent with two partitions gives `[I-VACUOUS]`, and a parent with no
 * partition renders nothing at all. So neither half of the naive fix works on its own: excluding the
 * partitions leaves drizzle-kit rendering NOTHING for the family, and rendering the partitions puts
 * names in `db/schema.ts` that a migration can compute from its own apply date (`0006` does exactly
 * that in schema `pgboss`: `queue_stats_YYYYMMDD`) or that pg_partman creates at run time.
 *
 * What it does, to the text drizzle-kit wrote (after T-150's type map, before T-152's policy step):
 *   1. For every partitioned table in `public` owned by no extension, the TEMPLATE is the first of
 *      its partitions in `public` in byte order. Its `pgTable` declaration is rewritten into the
 *      PARENT's: the export name, the table name, and every constraint and index name are mapped to
 *      the parent's by the catalogue (`pg_constraint.conparentid`, `pg_inherits` over index
 *      relations), never by string surgery. A partition's columns are the parent's columns, which
 *      this step checks in the catalogue before using the rendering.
 *   2. The parent's row-level security policies are rendered into the same entry list from
 *      `pg_policy` (T-152's `renderPolicy`), because a partition carries none of the parent's.
 *   3. Every other partition of that parent in `public` is removed from the rendering.
 * Everything it cannot check is a problem, and it never passes a partitioned family through
 * silently: a sub-partitioned table, a partition outside `public`, a parent with no partition, a partition whose
 * column shape is not the parent's, an identity column (drizzle-kit renders a partition's as
 * `name: "null", startWith: null`, measured), a name in the template with no counterpart on the
 * parent, an export name this step and drizzle-kit would spell differently, and PostgreSQL's
 * per-partition clone of a foreign key on a table that is not itself a partition.
 */
import ts from 'typescript';
import { type CataloguePolicy, renderPolicy } from './schema-policy.ts';

/** One partition of a partitioned table, as the catalogue has it. */
export interface CataloguePartition {
  readonly schema: string;
  readonly name: string;
  /** the partition is itself partitioned (relkind 'p') */
  readonly subPartitioned: boolean;
  /** the column signature: name, type, typmod, notNull, identity, generated and default, by attnum */
  readonly columns: string;
  /** every constraint and index name this partition owns, and the parent's counterpart, or null */
  readonly names: readonly { readonly from: string; readonly to: string | null }[];
}

/** One partitioned table in `public`, owned by no extension. */
export interface CatalogueParent {
  readonly name: string;
  /** the parent is itself a partition of something else (a sub-partitioned table) */
  readonly isPartition: boolean;
  readonly columns: string;
  /** the parent has a column PostgreSQL generates as an identity */
  readonly identity: boolean;
  readonly partitions: readonly CataloguePartition[];
}

/**
 * A constraint on a table in `public` that PostgreSQL cloned from another constraint on the SAME
 * table — what a FOREIGN KEY into a partitioned table leaves behind, one clone per partition.
 */
export interface CatalogueClone {
  readonly table: string;
  readonly name: string;
  readonly parent: string;
}

export interface PartitionCatalogue {
  readonly parents: readonly CatalogueParent[];
  readonly clones: readonly CatalogueClone[];
}

export type PartitionResult =
  | {
      readonly ok: true;
      readonly body: string;
      /** partitioned parents rendered from a partition */
      readonly parents: number;
      /** partition declarations removed from the rendering */
      readonly removed: number;
      /** constraint and index names mapped to the parent's */
      readonly mapped: number;
      /** pgPolicy entries rendered into a parent from pg_policy */
      readonly policies: number;
      /** export names this step and drizzle-kit spell identically, checked in this rendering */
      readonly names: number;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The column signature of one relation: a JSON array of arrays, so no name can act as a separator. */
const COLUMN_SIG = `(SELECT coalesce(json_agg(json_build_array(
             a.attname, a.atttypid::int, a.atttypmod, a.attnotnull, a.attidentity, a.attgenerated,
             coalesce(pg_get_expr(ad.adbin, ad.adrelid), '')) ORDER BY a.attnum), '[]'::json)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE a.attrelid = REL AND a.attnum > 0 AND NOT a.attisdropped)`;

/**
 * The catalogue query the caller runs. One JSON object: the partitioned tables of `public` with
 * their partitions (in any schema), and the clone constraints above. Names are JSON strings.
 */
export const PARTITIONS_SQL = `
  WITH pub AS (
    SELECT c.oid, c.relname, c.relkind, c.relispartition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'))
  SELECT json_build_object(
    'parents', (SELECT coalesce(json_agg(json_build_object(
         'name', p.relname,
         'isPartition', p.relispartition,
         'columns', ${COLUMN_SIG.replace('REL', 'p.oid')},
         'identity', EXISTS (SELECT 1 FROM pg_attribute a
                              WHERE a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped
                                AND a.attidentity <> ''),
         'partitions', (SELECT coalesce(json_agg(json_build_object(
              'schema', cn.nspname,
              'name', ch.relname,
              'subPartitioned', ch.relkind = 'p',
              'columns', ${COLUMN_SIG.replace('REL', 'ch.oid')},
              'names', (SELECT coalesce(json_agg(json_build_object('from', m.from_name, 'to', m.to_name)
                                                 ORDER BY m.from_name, m.to_name), '[]'::json)
                          FROM (
                            SELECT con.conname AS from_name,
                                   coalesce(pcon.conname,
                                            (SELECT x.conname FROM pg_constraint x
                                              WHERE x.conrelid = p.oid AND x.conname = con.conname)) AS to_name
                              FROM pg_constraint con
                              LEFT JOIN pg_constraint pcon ON pcon.oid = con.conparentid
                             WHERE con.conrelid = ch.oid AND con.contype <> 'n'
                            UNION ALL
                            SELECT ci.relname, pi.relname
                              FROM pg_index i
                              JOIN pg_class ci ON ci.oid = i.indexrelid
                              LEFT JOIN pg_inherits ii ON ii.inhrelid = i.indexrelid
                              LEFT JOIN pg_class pi ON pi.oid = ii.inhparent
                             WHERE i.indrelid = ch.oid) m))
            ORDER BY cn.nspname, ch.relname), '[]'::json)
           FROM pg_inherits i
           JOIN pg_class ch ON ch.oid = i.inhrelid
           JOIN pg_namespace cn ON cn.oid = ch.relnamespace
          WHERE i.inhparent = p.oid))
       ORDER BY p.relname), '[]'::json)
     FROM pub p WHERE p.relkind = 'p'),
    'clones', (SELECT coalesce(json_agg(json_build_object(
         'table', cl.relname, 'name', con.conname, 'parent', pcon.conname)
       ORDER BY cl.relname, con.conname), '[]'::json)
     FROM pg_constraint con
     JOIN pg_constraint pcon ON pcon.oid = con.conparentid
     JOIN pub cl ON cl.oid = con.conrelid
    WHERE pcon.conrelid = con.conrelid AND NOT cl.relispartition))`;

/**
 * A relation name this step can spell as an export name exactly as drizzle-kit does: `_`-separated
 * runs of letters, each optionally ending in digits. drizzle-kit camel-cases with the `camelcase`
 * package, which also breaks a word at a digit-to-letter boundary (`t165_part_2026q1` ->
 * `t165Part2026Q1`, measured); this shape has no such boundary, so the two agree, and
 * `checkExportNames` holds that agreement against drizzle-kit's own output in the same rendering.
 */
const SAFE_RELNAME = /^[a-z]+[0-9]*(_[a-z]+[0-9]*)*$/;
/** cannot be written inside drizzle-kit's `"…"` byte for byte */
const QUOTE_UNSAFE = /["\\\r\n]/;

/** The export name drizzle-kit gives a relation whose name matches SAFE_RELNAME. */
export function exportName(relname: string): string {
  const parts = relname.split('_');
  return parts
    .map((p, i) => (i === 0 ? p : `${p.slice(0, 1).toUpperCase()}${p.slice(1)}`))
    .join('');
}

function isNames(v: unknown): v is { from: string; to: string | null }[] {
  return (
    Array.isArray(v) &&
    v.every((e) => {
      const r: unknown = e;
      if (typeof r !== 'object' || r === null) return false;
      const from: unknown = Reflect.get(r, 'from');
      const to: unknown = Reflect.get(r, 'to');
      return typeof from === 'string' && (to === null || typeof to === 'string');
    })
  );
}

/** Parse and shape-check the output of PARTITIONS_SQL. */
export function parsePartitions(
  json: string,
):
  | { readonly ok: true; readonly catalogue: PartitionCatalogue }
  | { readonly ok: false; readonly problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, problem: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof data !== 'object' || data === null) return { ok: false, problem: 'not a JSON object' };
  const rawParents: unknown = Reflect.get(data, 'parents');
  const rawClones: unknown = Reflect.get(data, 'clones');
  if (!Array.isArray(rawParents) || !Array.isArray(rawClones)) {
    return { ok: false, problem: 'does not have `parents` and `clones` arrays' };
  }
  const parents: CatalogueParent[] = [];
  for (const row of rawParents) {
    const r: unknown = row;
    if (typeof r !== 'object' || r === null)
      return { ok: false, problem: 'a parent is not an object' };
    const name: unknown = Reflect.get(r, 'name');
    const isPartition: unknown = Reflect.get(r, 'isPartition');
    const columns: unknown = Reflect.get(r, 'columns');
    const identity: unknown = Reflect.get(r, 'identity');
    const rawPartitions: unknown = Reflect.get(r, 'partitions');
    if (
      typeof name !== 'string' ||
      typeof isPartition !== 'boolean' ||
      typeof identity !== 'boolean' ||
      !Array.isArray(columns) ||
      !Array.isArray(rawPartitions)
    ) {
      return {
        ok: false,
        problem: `a parent is not {name, isPartition, columns, identity, partitions}`,
      };
    }
    const partitions: CataloguePartition[] = [];
    for (const p of rawPartitions) {
      const q: unknown = p;
      if (typeof q !== 'object' || q === null)
        return { ok: false, problem: 'a partition is not an object' };
      const schema: unknown = Reflect.get(q, 'schema');
      const pname: unknown = Reflect.get(q, 'name');
      const sub: unknown = Reflect.get(q, 'subPartitioned');
      const pcolumns: unknown = Reflect.get(q, 'columns');
      const names: unknown = Reflect.get(q, 'names');
      if (
        typeof schema !== 'string' ||
        typeof pname !== 'string' ||
        typeof sub !== 'boolean' ||
        !Array.isArray(pcolumns) ||
        !isNames(names)
      ) {
        return {
          ok: false,
          problem: 'a partition is not {schema, name, subPartitioned, columns, names}',
        };
      }
      partitions.push({
        schema,
        name: pname,
        subPartitioned: sub,
        columns: JSON.stringify(pcolumns),
        names,
      });
    }
    parents.push({ name, isPartition, columns: JSON.stringify(columns), identity, partitions });
  }
  const clones: CatalogueClone[] = [];
  for (const row of rawClones) {
    const r: unknown = row;
    if (typeof r !== 'object' || r === null)
      return { ok: false, problem: 'a clone is not an object' };
    const table: unknown = Reflect.get(r, 'table');
    const name: unknown = Reflect.get(r, 'name');
    const parent: unknown = Reflect.get(r, 'parent');
    if (typeof table !== 'string' || typeof name !== 'string' || typeof parent !== 'string') {
      return { ok: false, problem: 'a clone is not {table, name, parent}' };
    }
    clones.push({ table, name, parent });
  }
  return { ok: true, catalogue: { parents, clones } };
}

interface Declaration {
  readonly stmt: ts.Statement;
  readonly ident: ts.Identifier;
  readonly call: ts.CallExpression;
  readonly kind: string;
  readonly name: string;
  readonly literals: readonly ts.StringLiteral[];
  readonly extras: ts.ArrayLiteralExpression | undefined;
  readonly args: ts.NodeArray<ts.Expression>;
}

const KINDS: ReadonlySet<string> = new Set(['pgTable', 'pgView', 'pgMaterializedView']);

/** The innermost call of a chain such as `pgTable(...).enableRLS()`. */
function rootCall(node: ts.Expression): ts.CallExpression | undefined {
  let n: ts.Expression = node;
  while (ts.isCallExpression(n)) {
    if (ts.isIdentifier(n.expression)) return n;
    if (!ts.isPropertyAccessExpression(n.expression)) return undefined;
    n = n.expression.expression;
  }
  return undefined;
}

/** Every `export const <ident> = pgTable|pgView|pgMaterializedView("<name>", …)` declaration. */
function declarations(sf: ts.SourceFile): Declaration[] {
  const out: Declaration[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const decl = stmt.declarationList.declarations[0];
    if (stmt.declarationList.declarations.length !== 1 || decl?.initializer === undefined) continue;
    if (!ts.isIdentifier(decl.name)) continue;
    const call = rootCall(decl.initializer);
    if (
      call === undefined ||
      !ts.isIdentifier(call.expression) ||
      !KINDS.has(call.expression.text)
    ) {
      continue;
    }
    const nameArg = call.arguments[0];
    if (nameArg === undefined || !ts.isStringLiteral(nameArg)) continue;
    const literals: ts.StringLiteral[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) literals.push(node);
      ts.forEachChild(node, visit);
    };
    visit(stmt);
    const fn = call.arguments[2];
    const extras =
      fn !== undefined && ts.isArrowFunction(fn) && ts.isArrayLiteralExpression(fn.body)
        ? fn.body
        : undefined;
    out.push({
      stmt,
      ident: decl.name,
      call,
      kind: call.expression.text,
      name: nameArg.text,
      literals,
      extras,
      args: call.arguments,
    });
  }
  return out;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Rewrite drizzle-kit's rendering so that every partitioned table in `public` is a plain `pgTable`
 * under its own name and none of its partitions is rendered. `policies` is the same `pg_policy`
 * reading the policy step is given.
 */
export function canonicalPartitions(
  source: string,
  catalogue: PartitionCatalogue,
  policies: readonly CataloguePolicy[],
): PartitionResult {
  const problems: string[] = [];
  const sf = ts.createSourceFile(
    'schema.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const decls = declarations(sf);
  const byName = new Map(decls.map((d) => [d.name, d]));

  // Every partition of a parent in `public`, whatever schema it is in.
  const partitionInPublic = new Set<string>();
  for (const parent of catalogue.parents) {
    for (const p of parent.partitions) if (p.schema === 'public') partitionInPublic.add(p.name);
  }

  // PostgreSQL's per-partition clone of a constraint on a table that is not itself a partition:
  // one per partition of the table the foreign key points at. Refused wherever it is rendered.
  for (const clone of catalogue.clones) {
    const d = byName.get(clone.table);
    if (d !== undefined && d.literals.some((l) => l.text === clone.name)) {
      problems.push(
        `table "${clone.table}" renders "${clone.name}", PostgreSQL's per-partition clone of "${clone.parent}" on the same table: a foreign key into a partitioned table is rendered once per partition and this step does not represent it`,
      );
    }
  }

  if (catalogue.parents.length === 0) {
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, body: source, parents: 0, removed: 0, mapped: 0, policies: 0, names: 0 };
  }

  // The export names this step derives must be the names drizzle-kit itself wrote, for every
  // relation of a shape this step can spell, in this very rendering.
  let names = 0;
  for (const d of decls) {
    if (partitionInPublic.has(d.name) || !SAFE_RELNAME.test(d.name)) continue;
    names += 1;
    if (exportName(d.name) !== d.ident.text) {
      problems.push(
        `drizzle-kit exports relation "${d.name}" as \`${d.ident.text}\`, which this step would spell \`${exportName(d.name)}\`: it cannot name a partitioned table's export`,
      );
    }
  }

  const edits: Edit[] = [];
  let parents = 0;
  let removed = 0;
  let mapped = 0;
  let emitted = 0;

  for (const parent of catalogue.parents) {
    const where = `partitioned table "${parent.name}"`;
    if (parent.isPartition) {
      problems.push(`${where} is itself a partition: a sub-partitioned table is not represented`);
      continue;
    }
    if (parent.identity) {
      problems.push(
        `${where} has an identity column: drizzle-kit renders a partition's identity column as \`name: "null", startWith: null\`, which is not the parent's, so this step will not take it from a partition`,
      );
      continue;
    }
    if (!SAFE_RELNAME.test(parent.name)) {
      problems.push(
        `${where} is not named as \`<letters><digits>(_<letters><digits>)*\`, so this step cannot spell its export name as drizzle-kit would`,
      );
      continue;
    }
    // A partition outside `public` in a schema I-SCOPE admits (T-145: `pgboss`) would otherwise be
    // a partition of an application table that no check sees. A partition in any other schema is
    // I-SCOPE and the run has already stopped.
    const outside = parent.partitions.filter((p) => p.schema !== 'public');
    if (outside.length > 0) {
      problems.push(
        `${where}: partition ${outside.map((p) => `"${p.schema}"."${p.name}"`).join(', ')} is not in schema public, and a partition of a table in public is part of that table, not an admitted relation of its own`,
      );
      continue;
    }
    const local = parent.partitions;
    const templates = [...local].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const template = templates[0];
    if (template === undefined) {
      problems.push(
        `${where} has no partition, so drizzle-kit renders nothing this step could take its columns from`,
      );
      continue;
    }
    for (const p of parent.partitions) {
      if (p.subPartitioned) {
        problems.push(
          `${where}: partition "${p.schema}"."${p.name}" is itself partitioned: a sub-partitioned table is not represented`,
        );
      }
    }
    for (const p of local) {
      if (p.columns !== parent.columns) {
        problems.push(
          `${where}: partition "${p.name}" does not have the parent's columns in the parent's order (name, type, NOT NULL, identity, generated and default, by attnum), so its rendering is not the parent's`,
        );
      }
    }
    const decl = byName.get(template.name);
    if (decl === undefined) {
      problems.push(
        `${where}: drizzle-kit did not render partition "${template.name}", which this step takes the parent's columns from`,
      );
      continue;
    }
    if (decl.kind !== 'pgTable') {
      problems.push(
        `${where}: partition "${template.name}" is rendered as \`${decl.kind}\`, not \`pgTable\``,
      );
      continue;
    }
    const target = exportName(parent.name);
    const clash = decls.find((d) => d.ident.text === target && d !== decl);
    if (clash !== undefined) {
      problems.push(
        `${where}: its export name \`${target}\` is already used by relation "${clash.name}"`,
      );
      continue;
    }
    if (problems.length > 0) continue;

    // 1. the export name, 2. the table name and every constraint and index name, from the catalogue.
    const map = new Map<string, string | null>(template.names.map((n) => [n.from, n.to]));
    map.set(template.name, parent.name);
    edits.push({ start: decl.ident.getStart(sf), end: decl.ident.getEnd(), text: target });
    for (const lit of decl.literals) {
      const to = map.get(lit.text);
      if (to === undefined) continue;
      if (to === null) {
        problems.push(
          `${where}: partition "${template.name}" renders "${lit.text}", which is its own and has no counterpart on the parent`,
        );
        continue;
      }
      if (QUOTE_UNSAFE.test(to)) {
        problems.push(
          `${where}: the name ${JSON.stringify(to)} cannot be written inside "…" byte for byte`,
        );
        continue;
      }
      mapped += 1;
      edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: `"${to}"` });
    }

    // 3. the parent's own row-level security policies, which no partition carries.
    const mine = policies
      .filter((p) => p.table === parent.name)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (mine.length > 0) {
      const entries = mine.map((p) => renderPolicy(p));
      emitted += mine.length;
      if (decl.extras !== undefined) {
        // just inside the `]`, after a trailing comma the rendering may or may not already have
        const at = decl.extras.getEnd() - 1;
        const lead =
          decl.extras.elements.length === 0
            ? '\n\t'
            : decl.extras.elements.hasTrailingComma
              ? '\t'
              : ',\n\t';
        edits.push({ start: at, end: at, text: `${lead}${entries.join(',\n\t')},\n` });
      } else if (decl.args.length === 2) {
        const at = decl.args[1]?.getEnd() ?? decl.call.getEnd();
        edits.push({ start: at, end: at, text: `, (table) => [\n\t${entries.join(',\n\t')},\n]` });
      } else {
        problems.push(
          `${where}: partition "${template.name}" is not \`pgTable("<name>", { … })\` with an optional \`(table) => [ … ]\`, so this step cannot add the parent's ${String(mine.length)} policy entr(ies)`,
        );
        continue;
      }
    }

    // 4. every other partition of this parent in `public` leaves the rendering.
    for (const p of local) {
      if (p.name === template.name) continue;
      const d = byName.get(p.name);
      if (d === undefined) continue;
      removed += 1;
      edits.push({ start: d.stmt.getFullStart(), end: d.stmt.getEnd(), text: '' });
    }
    parents += 1;
  }

  if (problems.length > 0) return { ok: false, problems };

  let body = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    body = body.slice(0, e.start) + e.text + body.slice(e.end);
  }

  // Nothing may still name a partition this step removed: an FK entry pointing at one would
  // otherwise reach `tsc` as an undefined identifier rather than as this step's refusal.
  for (const name of partitionInPublic) {
    const d = byName.get(name);
    if (d === undefined) continue;
    const ident = d.ident.text;
    if (new RegExp(`(^|[^\\w$])${ident}([^\\w$]|$)`).test(body)) {
      problems.push(
        `the rendering still names \`${ident}\`, the export of partition "${name}", after the partition was removed`,
      );
    }
  }
  if (emitted > 0) {
    const fixed = addImports(body, emitted > 0);
    if (!fixed.ok) problems.push(...fixed.problems);
    else body = fixed.body;
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, body, parents, removed, mapped, policies: emitted, names };
}

/** `pgPolicy` and `sql` must be imported where this step emitted policy entries. */
function addImports(
  body: string,
  needPolicy: boolean,
):
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly problems: string[] } {
  let out = body;
  const problems: string[] = [];
  const core = /^import \{ ([^}]*) \} from "drizzle-orm\/pg-core"$/m.exec(out);
  if (needPolicy && core !== null && !/(^|[ ,])pgPolicy([ ,]|$)/.test(core[1] ?? '')) {
    out = out.replace(core[0], `import { ${core[1] ?? ''}, pgPolicy } from "drizzle-orm/pg-core"`);
  } else if (needPolicy && core === null) {
    problems.push('the rendering has no `drizzle-orm/pg-core` import to add `pgPolicy` to');
  }
  if (/sql`/.test(out) && !/^import \{[^}]*\bsql\b[^}]*\} from "drizzle-orm"$/m.test(out)) {
    problems.push('the rendering uses sql`…` and has no `import { sql } from "drizzle-orm"`');
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, body: out };
}
