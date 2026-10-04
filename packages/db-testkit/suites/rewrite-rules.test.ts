/**
 * T-237 — no rewrite rule on any relation in the application schemas (T-234 tech-lead TL-5 (b), successor
 * item S3).
 *
 * A rewrite rule (`CREATE RULE … DO INSTEAD …`) changes what a write does without a trigger, a grant or a
 * constraint, so no refusal test sees it unless the rule happens to swallow the very write that test makes:
 * T-196 QA2-F1 measured a conditional INSTEAD rule on webauthn_credential passing every behavioural case.
 * Eight db-testkit suites pin `pg_rewrite` for their own tables (T-234); this suite is the sweep that
 * covers every table, the ones no suite pins and every future one, in one assertion.
 *
 * THE SWEEP. Every `pg_rewrite` row whose relation lives in a schema that is not PostgreSQL's own
 * (`pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp_*`), except the `_RETURN` rule of a view or
 * materialized view, which IS that view's definition (PostgreSQL stores every view as one). So: any rule
 * on a table or a partitioned table, and any rule on a view other than its definition. On the committed
 * migration set it must read `none`.
 *
 * WHAT MAKES IT A CHECK AND NOT A READING (PROTOCOL §5.1). (1) The sweep is shown REFUSING: inside a
 * transaction that is never committed, a rule is created on one table of EVERY application schema that
 * holds one, in four shapes (an unconditional INSTEAD NOTHING, the inert conditional `WHERE false` that
 * T-234 QA-5 used, an ALSO rule, and an INSTEAD rule on a view), and the sweep must name exactly those.
 * (2) Its CONTROL: a view created in a transaction has its own `_RETURN` row in `pg_rewrite` (asserted),
 * and the sweep still reads `none`. (3) Anti-vacuity: the schemas it reads must include `public` and
 * `pgboss`, the two the committed migrations create tables in, and hold at least one table each.
 *
 * gate:migration-lint's R-RULE refuses `CREATE RULE` in a migration at authoring time; this suite is the
 * database-side half, after every migration has run. Neither sees a rule created outside a migration and
 * dropped before the suite runs.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { acquireMigratedCluster, type Cluster } from '../src/index.ts';

const SUITE = 'rewrite-rules';

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** A schema that is PostgreSQL's own; everything else is an application schema. */
const NOT_SYSTEM = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'`;

/** Every rewrite rule in the application schemas except a view's own definition, or `none`. */
const SWEEP = `SELECT coalesce(string_agg(n.nspname || '.' || c.relname || ':' || r.rulename || ':' || c.relkind::text, ', '
                                         ORDER BY n.nspname, c.relname, r.rulename), 'none')
                 FROM pg_rewrite r
                 JOIN pg_class c ON c.oid = r.ev_class
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE ${NOT_SYSTEM} AND NOT (r.rulename = '_RETURN' AND c.relkind IN ('v', 'm'))`;

/** One table (relkind r or p) per application schema, the first by name: `schema.table:relkind`. */
const ONE_TABLE_PER_SCHEMA = `SELECT string_agg(t, ' ' ORDER BY t) FROM (
    SELECT DISTINCT ON (n.nspname) n.nspname || '.' || c.relname || ':' || c.relkind::text AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${NOT_SYSTEM} AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     ORDER BY n.nspname, c.relname) x`;

/**
 * Statements in one transaction that psql's session end rolls back, as the bootstrap superuser; the
 * value of the LAST statement, which must be a one-row, one-column SELECT.
 */
async function inRolledBackTransaction(...commands: string[]): Promise<string> {
  const r = await db.psql({
    commands: ['BEGIN', ...commands],
    raw: true,
    stopOnError: true,
    verbose: true,
  });
  assert.equal(r.code, 0, `psql exited ${String(r.code)}:\n${r.output}`);
  const lines = r.stdout.split('\n').filter((l) => l.trim() !== '');
  return (lines[lines.length - 1] ?? '').trim();
}

describe('T-237 — rewrite rules in the application schemas', () => {
  test('anti-vacuity: the schemas the sweep reads include public and pgboss, each holding a table', async () => {
    const tables = await db.value(ONE_TABLE_PER_SCHEMA);
    const schemas = tables.split(' ').map((t) => t.split('.')[0]);
    for (const s of ['public', 'pgboss']) {
      assert.ok(schemas.includes(s), `no table in schema ${s} is read by the sweep: ${tables}`);
    }
  });

  test('the committed migration set: no rewrite rule on any relation in the application schemas, except the _RETURN rule of a view', async () => {
    assert.equal(await db.value(SWEEP), 'none');
  });

  test('REFUSAL: a rule on one table of every application schema, in three shapes, and an INSTEAD rule on a view, are each named by the sweep', async () => {
    const tables = (await db.value(ONE_TABLE_PER_SCHEMA)).split(' ');
    const shapes = [
      (t: string, i: number) =>
        `CREATE RULE t237_instead_${String(i)} AS ON INSERT TO ${t} DO INSTEAD NOTHING`,
      (t: string, i: number) =>
        `CREATE RULE t237_inert_${String(i)} AS ON UPDATE TO ${t} WHERE false DO INSTEAD NOTHING`,
      (t: string, i: number) =>
        `CREATE RULE t237_also_${String(i)} AS ON DELETE TO ${t} DO ALSO NOTIFY t237`,
    ];
    const commands: string[] = [];
    const want: string[] = [];
    tables.forEach((entry, i) => {
      const [qualified = '', kind = ''] = entry.split(':');
      const [schema = '', rel = ''] = qualified.split('.');
      for (const shape of shapes) {
        const sql = shape(`"${schema}"."${rel}"`, i);
        commands.push(sql);
        const name = /CREATE RULE (\S+)/.exec(sql)?.[1] ?? '?';
        want.push(`${schema}.${rel}:${name}:${kind}`);
      }
    });
    commands.push(
      'CREATE VIEW public.t237_view AS SELECT 1 AS x',
      'CREATE RULE t237_view_instead AS ON INSERT TO public.t237_view DO INSTEAD NOTHING',
    );
    want.push('public.t237_view:t237_view_instead:v');
    const got = await inRolledBackTransaction(...commands, SWEEP);
    // Compared as SETS: the sweep orders by the database's ICU collation, which is not JS's code-unit order.
    assert.deepEqual(got.split(', ').sort(), [...want].sort());
    assert.equal(tables.length * shapes.length + 1, want.length);
    assert.equal(await db.value(SWEEP), 'none', 'the probe rules were rolled back');
  });

  test('CONTROL: the _RETURN rule of a view is in pg_rewrite and is not reported', async () => {
    const got = await inRolledBackTransaction(
      'CREATE VIEW public.t237_view AS SELECT 1 AS x',
      'CREATE MATERIALIZED VIEW public.t237_matview AS SELECT 1 AS x',
      `SELECT (SELECT string_agg(c.relname || ':' || r.rulename, ',' ORDER BY c.relname)
                 FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
                WHERE c.oid IN ('public.t237_view'::regclass, 'public.t237_matview'::regclass))
              || ' | ' || (${SWEEP})`,
    );
    assert.equal(got, 't237_matview:_RETURN,t237_view:_RETURN | none');
  });
});
