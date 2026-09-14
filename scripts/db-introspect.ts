/**
 * db:introspect / db:introspect:check — T-138 (tech-lead).
 *
 * Spec: SD §DB-1 ("the Drizzle schema is generated from introspection (`drizzle-kit pull`) and
 * committed. A CI check fails if introspection output differs from the committed schema"),
 * SD §DH-1 (`db/schema.ts` GENERATED, committed, parity-checked), SD §QD-4 PR row, and
 * tech-lead.md non-negotiable 2: the SQL file leads, the ORM follows.
 *
 *   ./scripts/svc run <ticket> -- pnpm run --silent db:introspect         # write db/schema.ts
 *   ./scripts/svc run <ticket> -- pnpm run --silent db:introspect:check   # compare, never write
 *
 * It needs a database (`db` profile) and reaches it only through the libpq environment
 * (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE), which is also what `db:migrate` uses. The
 * connection URL handed to drizzle-kit is built from those same variables, so psql, the
 * migration runner and drizzle-kit cannot be pointed at different databases by the environment.
 *
 * WHAT A RUN DOES, IN ORDER. Every step's failure is a tagged problem line, `  - [I-TAG] …`.
 *   1. [I-MIGRATE] `node scripts/db-migrate.ts up`: it BRINGS THE DATABASE UP TO the highest
 *      migration in db/migrations. The run is judged by its exit status and its single banner
 *      together (T-136 § contract §2). So this check changes the database it is pointed at.
 *   2. [I-RECORD] the database's migration record must read the highest up file's number.
 *   3. [I-SCOPE] the catalogue: every relation (r, p, v, m, f) outside pg_catalog,
 *      information_schema and pg_toast, and whether an extension owns it (pg_depend deptype 'e').
 *      A relation no extension owns, outside schema `public`, fails: this pipeline introspects
 *      `public` only and must not silently omit a table. An extension member whose name is not a
 *      plain identifier fails too, because it becomes a glob below.
 *   4. [I-PULL] drizzle-kit pull, from a config file written to a temporary directory, with
 *      schemaFilter `public` and one `!<name>` tablesFilter per extension member. So extension
 *      internals (postgis, pg_partman, pg_stat_statements) are excluded by a catalogue rule,
 *      not by a list kept here.
 *   4a. [I-MAP] (T-150, OD-97) each `unknown("col")` drizzle-kit writes for a type it cannot parse
 *      is rewritten from a CLOSED map (`citext`, `bytea` -> customType). Any other type fails the
 *      run: `unknown(...)` is never written (scripts/gates/lib/schema-render.ts).
 *   4b. [I-POLICY] (T-152 rework 1, OD-109) drizzle-kit keeps a row-level security policy's
 *      `using` and `withCheck` only for the first pg_policies row it receives per table, from a query
 *      with no ORDER BY, so on a table with two or more policies the rendering is wrong and follows
 *      the query plan. Every pgPolicy entry is checked against pg_policy (read in step 3c), its
 *      dropped expressions restored, and it is rewritten from the catalogue row
 *      (scripts/gates/lib/schema-policy.ts). A disagreement or a shape it does not know fails the run.
 *   4c. [I-ORDER] (T-152, OD-106, OD-108) drizzle-kit renders objects in the order its catalogue
 *      queries return rows, and several of those queries have no ORDER BY, so the order follows
 *      planner statistics and heap position rather than the schema. The rendering is put in a
 *      canonical order: key column lists in the catalogue's own order (pg_constraint.conkey /
 *      confkey, read in step 3b), table entries by kind and name, declarations by name, imports by
 *      name (scripts/gates/lib/schema-order.ts). A shape it does not recognise fails the run. This
 *      pipeline does not ANALYZE: statistics are not an input to the rendering.
 *   4d. [I-TSC] (T-150, OD-93) TypeScript's own unused-identifier fixes are applied until a pass
 *      edits nothing, with the compiler options of the root tsconfig.json. Any diagnostic left in
 *      the rendering fails the run, so a file `tsc` would refuse at its first importer is neither
 *      written nor accepted.
 *   5. [I-VACUOUS] anti-vacuity, anchored OUTSIDE drizzle-kit: the relation names in the rendering
 *      must equal the names the catalogue lists as owned by no extension in `public`. An
 *      introspection that returns nothing while the catalogue holds a relation fails. When both
 *      are empty, the run says so on stdout (T-001 contract, gate rule 2) and does not fail: the
 *      committed migrations are then genuinely relation-free.
 *   6. write mode: db/schema.ts := the generated header + drizzle-kit's schema.ts after 4a-4d.
 *      Both modes build that rendering the same way, so the parity check compares against it.
 *      check mode: [I-MISSING] db/schema.ts absent; [I-DIGEST] its header does not verify
 *      (scripts/gates/lib/schema-digest.ts); [I-DIFF] it differs from the fresh rendering.
 *
 * Outcomes: exit 0 + `GATE PASS  <name>`; exit 1 + `GATE FAIL  <name> — N problem(s):` and the
 * tagged lines; exit 2 + `GATE FAIL` for an unknown argument; exit 70 + `GATE CRASH  <name>` if
 * this script throws. Only drizzle-kit's schema.ts is kept: its relations.ts, SQL file and
 * meta/ snapshot are discarded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, bin, capture } from './gates/lib/run.ts';
import { SCHEMA_REL, renderSchemaFile, verifySchemaFile } from './gates/lib/schema-digest.ts';
import {
  CONSTRAINT_KEYS_SQL,
  canonicalOrder,
  parseConstraintKeys,
} from './gates/lib/schema-order.ts';
import { POLICIES_SQL, canonicalPolicies, parsePolicies } from './gates/lib/schema-policy.ts';
import {
  TYPESCRIPT_VERSION,
  mapColumnTypes,
  pruneUnused,
  readRootCompilerOptions,
} from './gates/lib/schema-render.ts';

const INTROSPECTED_SCHEMA = 'public';
const TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.json');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');
const SCHEMA_PATH = path.join(REPO_ROOT, SCHEMA_REL);
const UP_FILE = /^(\d{4})_[a-z0-9][a-z0-9_]*\.up\.sql$/;
const PLAIN_IDENT = /^[a-z_][a-z0-9_]*$/;
const BANNER = /^MIGRATE (OK|FAIL|REFUSED|ERROR|CRASH) {2}/;

const mode = process.argv[2];
const extra = process.argv.slice(3);
const GATE = mode === '--write' ? 'db:introspect' : 'db:introspect:check';

function snippet(s: string): string {
  const t = s.length > 160 ? `${s.slice(0, 160)}…` : s;
  return JSON.stringify(t);
}

function tail(s: string, n = 12): string {
  return s.trimEnd().split('\n').slice(-n).join('\n      ');
}

function psql(sql: string): { ok: boolean; out: string; err: string } {
  const r = capture('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  return {
    ok: r.code === 0,
    out: r.stdout,
    err: `${r.stderr}${r.spawnFailed ? ' (spawn failed)' : ''}`,
  };
}

function main(): void {
  if ((mode !== '--check' && mode !== '--write') || extra.length > 0) {
    console.error(`\nGATE FAIL  ${GATE} — 1 problem(s):`);
    console.error(
      `  - [I-ARGS] usage: node scripts/db-introspect.ts --check | --write (got ${snippet(process.argv.slice(2).join(' '))})`,
    );
    process.exit(2);
  }

  const failures: string[] = [];
  const problem = (tag: string, msg: string): void => {
    failures.push(`[${tag}] ${msg}`);
  };
  const done = (): never => {
    if (failures.length === 0) {
      console.log(`\nGATE PASS  ${GATE}`);
      process.exit(0);
    }
    console.error(`\nGATE FAIL  ${GATE} — ${String(failures.length)} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  };

  const env = process.env;
  const host = env['PGHOST'];
  const user = env['PGUSER'];
  const database = env['PGDATABASE'];
  if (host === undefined || user === undefined || database === undefined) {
    problem(
      'I-PULL',
      'PGHOST, PGUSER and PGDATABASE must be set (run under `scripts/svc run <ticket> --`)',
    );
    done();
  }
  const port = env['PGPORT'] ?? '5432';
  const password = env['PGPASSWORD'] ?? '';
  console.log(
    `${GATE}: database ${String(database)} on ${String(host)}:${port} as ${String(user)}`,
  );

  // 1. migrations
  const ups = fs
    .readdirSync(MIGRATIONS_DIR)
    .map((f) => UP_FILE.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .sort();
  const highest = ups.at(-1);
  if (highest === undefined) {
    problem('I-MIGRATE', `no up file in ${path.relative(REPO_ROOT, MIGRATIONS_DIR)}`);
    done();
  }
  const mig = capture(process.execPath, ['scripts/db-migrate.ts', 'up']);
  const migOut = `${mig.stdout}${mig.stderr}`;
  const banners = migOut.split('\n').filter((l) => BANNER.test(l));
  console.log(
    `  db:migrate up: exit ${String(mig.code)}; ${banners.length === 1 ? (banners[0] ?? '') : `${String(banners.length)} banner(s)`}`,
  );
  if (!(mig.code === 0 && banners.length === 1 && (banners[0] ?? '').startsWith('MIGRATE OK  '))) {
    problem(
      'I-MIGRATE',
      `db:migrate up did not report OK (exit ${String(mig.code)}):\n      ${tail(migOut)}`,
    );
    done();
  }

  // 2. record
  const rec = psql(
    "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()",
  );
  const record = rec.out.trim();
  const wantRecord = `kinvara-migrate version=${String(highest)}`;
  console.log(`  migration record: ${snippet(record)}; highest up file: ${String(highest)}`);
  if (!rec.ok || record !== wantRecord) {
    problem(
      'I-RECORD',
      `the database record reads ${snippet(record)}, expected ${snippet(wantRecord)} ${rec.err.trim()}`,
    );
    done();
  }

  // 3. catalogue
  const cat = psql(`
    SELECT n.nspname || '|' || c.relname || '|' ||
           (EXISTS (SELECT 1 FROM pg_depend d
                     WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'))::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp\\_%'
     ORDER BY 1`);
  if (!cat.ok) {
    problem('I-SCOPE', `cannot read the catalogue: ${cat.err.trim()}`);
    done();
  }
  const rows = cat.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const [schema = '', name = '', ext = ''] = l.split('|');
      return { schema, name, extensionMember: ext === 'true' };
    });
  const members = rows.filter((r) => r.extensionMember && r.schema === INTROSPECTED_SCHEMA);
  const owned = rows
    .filter((r) => !r.extensionMember && r.schema === INTROSPECTED_SCHEMA)
    .map((r) => r.name)
    .sort();
  const elsewhere = rows.filter((r) => !r.extensionMember && r.schema !== INTROSPECTED_SCHEMA);
  console.log(
    `  catalogue: ${String(rows.length)} relation(s); ${String(members.length)} extension member(s) in ${INTROSPECTED_SCHEMA} excluded; ${String(owned.length)} relation(s) owned by no extension in ${INTROSPECTED_SCHEMA}`,
  );
  for (const r of elsewhere) {
    problem(
      'I-SCOPE',
      `relation ${r.schema}.${r.name} is owned by no extension and is outside schema ${INTROSPECTED_SCHEMA}, which is the only schema introspected; it would be silently absent from ${SCHEMA_REL}`,
    );
  }
  for (const m of members) {
    if (!PLAIN_IDENT.test(m.name))
      problem(
        'I-SCOPE',
        `extension member ${snippet(m.name)} is not a plain identifier and cannot be excluded by a glob safely`,
      );
  }
  if (failures.length > 0) done();

  // 3b. key column order of every PRIMARY KEY, UNIQUE and FOREIGN KEY in public (T-152)
  const keyRead = psql(CONSTRAINT_KEYS_SQL);
  const parsedKeys = keyRead.ok
    ? parseConstraintKeys(keyRead.out.trim())
    : { ok: false as const, problem: keyRead.err.trim() };
  if (!parsedKeys.ok) {
    problem(
      'I-ORDER',
      `cannot read constraint key columns from the catalogue: ${parsedKeys.problem}`,
    );
    done();
  }
  const constraintKeys = parsedKeys.ok ? parsedKeys.keys : [];

  // 3c. every row-level security policy on a table in public, from pg_policy (T-152 rework 1, OD-109)
  const policyRead = psql(POLICIES_SQL);
  const parsedPolicies = policyRead.ok
    ? parsePolicies(policyRead.out.trim())
    : { ok: false as const, problem: policyRead.err.trim() };
  if (!parsedPolicies.ok) {
    problem(
      'I-POLICY',
      `cannot read row-level security policies from the catalogue: ${parsedPolicies.problem}`,
    );
    done();
  }
  const cataloguePolicies = parsedPolicies.ok ? parsedPolicies.policies : [];

  // 4. pull
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvara-introspect-'));
  const out = path.join(tmp, 'out');
  const cfgPath = path.join(tmp, 'drizzle.config.mjs');
  const url = `postgres://${encodeURIComponent(String(user))}:${encodeURIComponent(password)}@${String(host)}:${port}/${encodeURIComponent(String(database))}`;
  const config = {
    dialect: 'postgresql',
    out,
    schemaFilter: [INTROSPECTED_SCHEMA],
    tablesFilter: members.map((m) => `!${m.name}`),
    dbCredentials: { url },
  };
  fs.writeFileSync(cfgPath, `export default ${JSON.stringify(config, null, 2)};\n`);
  const kitVersion = (
    JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'drizzle-kit', 'package.json'), 'utf8'),
    ) as { version: string }
  ).version;
  const pull = capture(bin('drizzle-kit'), ['pull', `--config=${cfgPath}`]);
  const pulled = path.join(out, 'schema.ts');
  let raw = '';
  if (pull.code !== 0 || !fs.existsSync(pulled)) {
    problem(
      'I-PULL',
      `drizzle-kit ${kitVersion} pull exit ${String(pull.code)}, schema.ts ${fs.existsSync(pulled) ? 'written' : 'NOT written'}:\n      ${tail(`${pull.stdout}${pull.stderr}`)}`,
    );
  } else {
    raw = fs.readFileSync(pulled, 'utf8');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length > 0) done();

  // 4a. map the column types drizzle-kit cannot render, from a closed map (T-150, OD-97)
  const mapping = mapColumnTypes(raw);
  if (!mapping.ok) {
    for (const p of mapping.problems) problem('I-MAP', p);
    done();
  }
  const mappedBody = mapping.ok ? mapping.body : raw;
  console.log(
    `  mapped column type(s): ${mapping.ok && mapping.mapped.length > 0 ? mapping.mapped.join(', ') : 'none'}`,
  );

  // 4b. row-level security policies checked against and rendered from pg_policy (T-152 rework 1, OD-109)
  const policed = canonicalPolicies(mappedBody, cataloguePolicies);
  if (!policed.ok) {
    for (const p of policed.problems) problem('I-POLICY', p);
    done();
  }
  const policyBody = policed.ok ? policed.body : mappedBody;
  console.log(
    `  policies: ${policed.ok ? `${String(policed.policies)} checked against pg_policy; ${String(policed.restored)} expression(s) drizzle-kit dropped restored; ${String(policed.rewritten)} entr(ies) rewritten from the catalogue` : 'failed'}`,
  );

  // 4c. canonical order, so the rendering is a function of the schema alone (T-152, OD-106, OD-108)
  const ordered = canonicalOrder(policyBody, constraintKeys);
  if (!ordered.ok) {
    for (const p of ordered.problems) problem('I-ORDER', p);
    done();
  }
  const orderedBody = ordered.ok ? ordered.body : policyBody;
  console.log(
    `  canonical order: ${ordered.ok ? `${String(ordered.declarations)} declaration(s), ${String(ordered.entries)} table entr(ies), ${String(ordered.keyLists)} key column list(s) from the catalogue; ${String(ordered.moved)} element(s) moved from drizzle-kit's order` : 'failed'}`,
  );

  // 4d. prune unused identifiers with TypeScript's own fixes, under the root tsconfig (T-150, OD-93)
  const root = readRootCompilerOptions(TSCONFIG_PATH);
  if (root.errors.length > 0) {
    for (const e of root.errors) problem('I-TSC', `tsconfig.json: ${e}`);
    done();
  }
  const pruned = pruneUnused(orderedBody, SCHEMA_PATH, root.options);
  console.log(
    `  pruned with typescript ${TYPESCRIPT_VERSION}: ${String(pruned.edits)} edit(s) in ${String(pruned.passes)} pass(es); ${String(pruned.diagnostics.length)} diagnostic(s) left`,
  );
  if (!pruned.converged) {
    problem('I-TSC', `pruning still made edits after ${String(pruned.passes)} passes`);
  }
  for (const d of pruned.diagnostics) {
    problem(
      'I-TSC',
      `the rendering of ${SCHEMA_REL} would not typecheck under tsconfig.json when imported: ${d}`,
    );
  }
  if (failures.length > 0) done();
  const body = pruned.text;

  // 5. anti-vacuity, against the catalogue, read from the rendering that is written and compared
  const introspected = [
    ...body.matchAll(/^export const [\w$]+ = pg(?:Table|View|MaterializedView)\("([^"]+)"/gm),
  ]
    .map((m) => m[1] ?? '')
    .sort();
  console.log(
    `  drizzle-kit ${kitVersion}: ${String(introspected.length)} relation(s) introspected from ${INTROSPECTED_SCHEMA}`,
  );
  if (introspected.join(',') !== owned.join(',')) {
    problem(
      'I-VACUOUS',
      `drizzle-kit wrote ${String(introspected.length)} relation(s) [${introspected.join(', ')}] but the catalogue lists ${String(owned.length)} owned by no extension in ${INTROSPECTED_SCHEMA} [${owned.join(', ')}]`,
    );
    done();
  }
  if (owned.length === 0) {
    console.log(
      `  VACUOUS: 0 relations introspected, and the catalogue independently lists 0 relations owned by no extension in ${INTROSPECTED_SCHEMA} after migration ${String(highest)}. The parity below compares an empty schema.`,
    );
  }

  const fresh = renderSchemaFile(body, kitVersion);

  // 6. write, or compare
  if (mode === '--write') {
    fs.writeFileSync(SCHEMA_PATH, fresh);
    console.log(`  wrote ${SCHEMA_REL} (${String(Buffer.byteLength(fresh))} bytes)`);
    done();
  }
  if (!fs.existsSync(SCHEMA_PATH)) {
    problem(
      'I-MISSING',
      `${SCHEMA_REL} does not exist. There is nothing to compare, and that is a failure: run \`pnpm run db:introspect\` and commit the file`,
    );
    done();
  }
  const committed = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const verdict = verifySchemaFile(committed);
  if (!verdict.ok) problem('I-DIGEST', `${SCHEMA_REL}: ${verdict.reason}`);
  if (committed !== fresh) {
    const a = committed.split('\n');
    const b = fresh.split('\n');
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k += 1;
    problem(
      'I-DIFF',
      `${SCHEMA_REL} differs from a fresh introspection at line ${String(k + 1)}: committed ${snippet(a[k] ?? '(end of file)')}, introspected ${snippet(b[k] ?? '(end of file)')}. Regenerate with \`pnpm run db:introspect\` in the same change set as the migration; never edit it by hand`,
    );
  } else {
    console.log(
      `  ${SCHEMA_REL}: byte-identical to a fresh introspection (${String(Buffer.byteLength(fresh))} bytes)`,
    );
  }
  done();
}

try {
  main();
} catch (e) {
  console.error(
    `\nGATE CRASH  ${GATE}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(70);
}
