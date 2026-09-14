/**
 * The row-level security policy step `db:introspect` applies to drizzle-kit's `schema.ts` before it
 * orders, prunes, writes or compares `db/schema.ts` — T-152 rework 1 (tech-lead), for OD-109
 * (qa-verification's QA-F1).
 *
 * Why it exists. drizzle-kit 0.31.10's pull reads policies with `SELECT … FROM pg_policies WHERE
 * schemaname = 'public'`, which has no ORDER BY (node_modules/drizzle-kit/bin.cjs 17685–17700), and
 * keeps a policy's `using` and `withCheck` only for the FIRST row it receives for each table. Every
 * later policy on that table is stored without either expression. So on a table with two or more
 * policies the rendering is wrong in every state, and which policy loses its expressions follows
 * the query plan: measured changing after ANALYZE, VACUUM ANALYZE and a migration down/up. T-020
 * § contract §3 puts row-level security on every `app_admin_rw` table, so this shape will arrive.
 *
 * What it does, to the text drizzle-kit wrote (after T-150's type map, before T-152's order step):
 *   1. Every `pgPolicy(...)` call must be an entry of a pgTable's `(table) => [ ... ]` extra config,
 *      in drizzle-kit's shape: `pgPolicy("<name>", { as: "…", for: "…", to: ["…", …],
 *      using?: sql`…`, withCheck?: sql`…` })`.
 *   2. Each entry is matched to exactly one pg_policy row of its table (POLICIES_SQL, which reads
 *      pg_policy itself, not the pg_policies view drizzle-kit reads), and every pg_policy row of a
 *      rendered table must be matched by an entry. What drizzle-kit DID render is checked against
 *      that row: `as` (polpermissive), `for` (polcmd), `to` (polroles, by name, in the order
 *      pg_policies gives) and any expression it rendered (pg_get_expr of polqual / polwithcheck). An
 *      expression it did NOT render while the row has one is the drop above, and is restored.
 *   3. Every entry is rewritten from its row with drizzle-kit's own template (bin.cjs 85875–85890),
 *      so its text never depends on which row drizzle-kit happened to receive first.
 * A disagreement, a shape it does not recognise, a name or role that cannot sit inside `"…"`, or an
 * expression that cannot sit inside a template literal byte for byte, is a problem. It never passes
 * a policy through unchecked.
 */
import ts from 'typescript';

/** One row-level security policy on a table in `public`, as the catalogue has it. */
export interface CataloguePolicy {
  readonly table: string;
  readonly name: string;
  /** drizzle-kit's `as` */
  readonly as: 'permissive' | 'restrictive';
  /** drizzle-kit's `for` */
  readonly command: 'select' | 'insert' | 'update' | 'delete' | 'all';
  /** drizzle-kit's `to`: role names ordered by name, as pg_policies orders them; PUBLIC is "public" */
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
}

export type PolicyResult =
  | {
      readonly ok: true;
      readonly body: string;
      /** pgPolicy entries checked against pg_policy */
      readonly policies: number;
      /** expressions drizzle-kit left out that the catalogue has */
      readonly restored: number;
      /** entries whose text differs from what drizzle-kit wrote */
      readonly rewritten: number;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The catalogue query the caller runs. One JSON array. `roleCount` lets the parser refuse a
 * polroles entry that resolves to no role.
 */
export const POLICIES_SQL = `
  SELECT coalesce(json_agg(json_build_object(
           'table', c.relname,
           'name', pol.polname,
           'permissive', pol.polpermissive,
           'cmd', pol.polcmd::text,
           'roleCount', cardinality(pol.polroles),
           'roles', CASE WHEN pol.polroles = '{0}'::oid[] THEN json_build_array('public'::text)
                         ELSE (SELECT coalesce(json_agg(r.rolname ORDER BY r.rolname), '[]'::json)
                                 FROM pg_roles r WHERE r.oid = ANY (pol.polroles)) END,
           'using', pg_get_expr(pol.polqual, pol.polrelid),
           'withCheck', pg_get_expr(pol.polwithcheck, pol.polrelid))
         ORDER BY c.relname, pol.polname), '[]'::json)
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'`;

/** pg_policy.polcmd -> drizzle-kit's `for` (the pg_policies view's mapping, lower-cased as drizzle-kit writes it). */
const COMMANDS: ReadonlyMap<string, CataloguePolicy['command']> = new Map([
  ['r', 'select'],
  ['a', 'insert'],
  ['w', 'update'],
  ['d', 'delete'],
  ['*', 'all'],
]);

const FIELDS: ReadonlySet<string> = new Set(['as', 'for', 'to', 'using', 'withCheck']);
/** cannot be written inside drizzle-kit's `"…"` byte for byte */
const QUOTE_UNSAFE = /["\\\r\n]/;
/** cannot be written inside drizzle-kit's sql`…` byte for byte */
const TEMPLATE_UNSAFE = /[`\\]|\$\{/;

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** Parse and shape-check the output of POLICIES_SQL. */
export function parsePolicies(
  json: string,
):
  | { readonly ok: true; readonly policies: readonly CataloguePolicy[] }
  | { readonly ok: false; readonly problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, problem: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(data)) return { ok: false, problem: 'not a JSON array' };
  const policies: CataloguePolicy[] = [];
  for (const row of data) {
    const r: unknown = row;
    if (typeof r !== 'object' || r === null)
      return { ok: false, problem: 'a row is not an object' };
    const table: unknown = Reflect.get(r, 'table');
    const name: unknown = Reflect.get(r, 'name');
    const permissive: unknown = Reflect.get(r, 'permissive');
    const cmd: unknown = Reflect.get(r, 'cmd');
    const roleCount: unknown = Reflect.get(r, 'roleCount');
    const roles: unknown = Reflect.get(r, 'roles');
    const using: unknown = Reflect.get(r, 'using');
    const withCheck: unknown = Reflect.get(r, 'withCheck');
    const command = typeof cmd === 'string' ? COMMANDS.get(cmd) : undefined;
    if (
      typeof table !== 'string' ||
      typeof name !== 'string' ||
      typeof permissive !== 'boolean' ||
      command === undefined ||
      typeof roleCount !== 'number' ||
      !isStrings(roles) ||
      !(using === null || typeof using === 'string') ||
      !(withCheck === null || typeof withCheck === 'string')
    ) {
      return {
        ok: false,
        problem: `row ${JSON.stringify(r).slice(0, 200)} does not have the expected shape`,
      };
    }
    if (roles.length !== roleCount) {
      return {
        ok: false,
        problem: `policy "${name}" on table "${table}" lists ${String(roleCount)} role(s) in polroles, of which ${String(roles.length)} resolve to a role`,
      };
    }
    policies.push({
      table,
      name,
      as: permissive ? 'permissive' : 'restrictive',
      command,
      roles,
      using,
      withCheck,
    });
  }
  return { ok: true, policies };
}

/** drizzle-kit 0.31.10's pgPolicy entry for a policy (bin.cjs 85875–85890), without its trailing `,`. */
export function renderPolicy(p: CataloguePolicy): string {
  const to = p.roles.map((r) => `"${r}"`).join(', ');
  const using = p.using === null ? '' : `, using: sql\`${p.using}\``;
  const withCheck = p.withCheck === null ? '' : `, withCheck: sql\`${p.withCheck}\` `;
  return `pgPolicy("${p.name}", { as: "${p.as}", for: "${p.command}", to: [${to}]${using}${withCheck} })`;
}

interface RenderedPolicy {
  readonly name: string;
  readonly as: string;
  readonly for: string;
  readonly to: readonly string[];
  readonly using: string | undefined;
  readonly withCheck: string | undefined;
}

function snippet(sf: ts.SourceFile, node: ts.Node): string {
  return JSON.stringify(node.getText(sf).replace(/\s+/g, ' ').slice(0, 120));
}

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

/** A `pgTable("<name>", { … }, (table) => [ … ])` declaration: its name and extra-config array. */
function tableOf(
  stmt: ts.Statement,
): { readonly name: string; readonly extras: ts.ArrayLiteralExpression | undefined } | undefined {
  if (!ts.isVariableStatement(stmt)) return undefined;
  const decl = stmt.declarationList.declarations[0];
  if (stmt.declarationList.declarations.length !== 1 || decl?.initializer === undefined) {
    return undefined;
  }
  const call = rootCall(decl.initializer);
  if (
    call === undefined ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'pgTable'
  ) {
    return undefined;
  }
  const nameArg = call.arguments[0];
  if (nameArg === undefined || !ts.isStringLiteral(nameArg)) return undefined;
  const fn = call.arguments[2];
  const extras =
    fn !== undefined && ts.isArrowFunction(fn) && ts.isArrayLiteralExpression(fn.body)
      ? fn.body
      : undefined;
  return { name: nameArg.text, extras };
}

function isPolicyCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'pgPolicy'
  );
}

/** Read one entry in drizzle-kit's shape, or say why it is not. */
function readEntry(sf: ts.SourceFile, call: ts.CallExpression): RenderedPolicy | string {
  const [nameArg, objArg] = call.arguments;
  if (
    call.arguments.length !== 2 ||
    nameArg === undefined ||
    !ts.isStringLiteral(nameArg) ||
    objArg === undefined ||
    !ts.isObjectLiteralExpression(objArg)
  ) {
    return 'is not `pgPolicy("<name>", { … })`';
  }
  const seen = new Map<string, ts.Expression>();
  for (const p of objArg.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !FIELDS.has(p.name.text)) {
      return `has a property ${snippet(sf, p)} this step does not know`;
    }
    if (seen.has(p.name.text)) return `names \`${p.name.text}\` twice`;
    seen.set(p.name.text, p.initializer);
  }
  const str = (key: string): string | undefined => {
    const v = seen.get(key);
    return v !== undefined && ts.isStringLiteral(v) ? v.text : undefined;
  };
  const expr = (key: string): string | undefined | null => {
    const v = seen.get(key);
    if (v === undefined) return undefined;
    if (
      !ts.isTaggedTemplateExpression(v) ||
      !ts.isIdentifier(v.tag) ||
      v.tag.text !== 'sql' ||
      !ts.isNoSubstitutionTemplateLiteral(v.template)
    ) {
      return null;
    }
    return sf.text.slice(v.template.getStart(sf) + 1, v.template.getEnd() - 1);
  };
  const as = str('as');
  const command = str('for');
  const toNode = seen.get('to');
  const to =
    toNode !== undefined &&
    ts.isArrayLiteralExpression(toNode) &&
    toNode.elements.every((e) => ts.isStringLiteral(e))
      ? toNode.elements.map((e) => (ts.isStringLiteral(e) ? e.text : ''))
      : undefined;
  const using = expr('using');
  const withCheck = expr('withCheck');
  if (as === undefined || command === undefined || to === undefined) {
    return 'does not have `as: "…"`, `for: "…"` and `to: ["…", …]` as string literals';
  }
  if (using === null || withCheck === null) {
    return 'has a `using` or `withCheck` that is not a sql`…` template with no substitution';
  }
  return { name: nameArg.text, as, for: command, to, using, withCheck };
}

export function canonicalPolicies(
  source: string,
  catalogue: readonly CataloguePolicy[],
): PolicyResult {
  const sf = ts.createSourceFile(
    'schema.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const problems: string[] = [];
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  const entries = new Set<ts.Node>();
  const renderedTables = new Set<string>();
  const matched = new Set<CataloguePolicy>();
  let policies = 0;
  let restored = 0;
  let rewritten = 0;

  for (const stmt of sf.statements) {
    const table = tableOf(stmt);
    if (table === undefined) continue;
    renderedTables.add(table.name);
    for (const el of table.extras?.elements ?? []) {
      if (!isPolicyCall(el)) continue;
      entries.add(el);
      policies += 1;
      const where = `table "${table.name}": pgPolicy ${snippet(sf, el)}`;
      const got = readEntry(sf, el);
      if (typeof got === 'string') {
        problems.push(`${where} ${got}`);
        continue;
      }
      const rows = catalogue.filter((p) => p.table === table.name && p.name === got.name);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        problems.push(
          `${where}: pg_policy has ${String(rows.length)} policy row(s) of that name on that table`,
        );
        continue;
      }
      if (matched.has(row)) {
        problems.push(`${where}: the policy is rendered more than once`);
        continue;
      }
      matched.add(row);
      const before = problems.length;
      if (got.as !== row.as) {
        problems.push(
          `${where}: as ${JSON.stringify(got.as)} but pg_policy has ${JSON.stringify(row.as)}`,
        );
      }
      if (got.for !== row.command) {
        problems.push(
          `${where}: for ${JSON.stringify(got.for)} but pg_policy has ${JSON.stringify(row.command)}`,
        );
      }
      if (JSON.stringify(got.to) !== JSON.stringify(row.roles)) {
        problems.push(
          `${where}: to ${JSON.stringify(got.to)} but pg_policy has ${JSON.stringify(row.roles)}`,
        );
      }
      for (const field of ['using', 'withCheck'] as const) {
        const have = got[field];
        const want = row[field];
        if (have === undefined && want !== null) {
          // drizzle-kit 0.31.10 drops both expressions for every policy on a table but the first row
          restored += 1;
          continue;
        }
        if ((have ?? null) !== want) {
          problems.push(
            `${where}: ${field} is ${have === undefined ? 'absent' : JSON.stringify(have)} but pg_policy has ${JSON.stringify(want)}`,
          );
        }
      }
      for (const s of [row.name, ...row.roles]) {
        if (QUOTE_UNSAFE.test(s)) {
          problems.push(
            `${where}: the name ${JSON.stringify(s)} cannot be written inside "…" byte for byte`,
          );
        }
      }
      for (const s of [row.using, row.withCheck]) {
        if (s !== null && TEMPLATE_UNSAFE.test(s)) {
          problems.push(
            `${where}: the expression ${JSON.stringify(s)} cannot be written inside sql\`…\` byte for byte`,
          );
        }
      }
      if (problems.length > before) continue;
      const text = renderPolicy(row);
      if (text !== el.getText(sf)) {
        rewritten += 1;
        edits.push({ start: el.getStart(sf), end: el.getEnd(), text });
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (isPolicyCall(node) && !entries.has(node)) {
      problems.push(
        `pgPolicy call ${snippet(sf, node)} is not an entry of a pgTable's \`(table) => [ ... ]\` extra config`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const p of catalogue) {
    if (renderedTables.has(p.table) && !matched.has(p)) {
      problems.push(
        `table "${p.table}": pg_policy has policy "${p.name}", which the rendering does not contain`,
      );
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  let body = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    body = body.slice(0, e.start) + e.text + body.slice(e.end);
  }
  return { ok: true, body, policies, restored, rewritten };
}
