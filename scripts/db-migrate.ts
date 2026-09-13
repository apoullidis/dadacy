/**
 * db:migrate — the ordered migration runner (T-136, decisions.md OE-22).
 *
 *   pnpm run db:migrate status             [--dir <path>]
 *   pnpm run db:migrate up    [--to NNNN]  [--dir <path>]
 *   pnpm run db:migrate down   --to NNNN   [--dir <path>]      --to 0000 reverts every migration
 *
 * It applies `db/migrations/NNNN_slug.up.sql` in number order, reverts to a target with the
 * `.down.sql` files in reverse order, and re-applies. It connects with `psql` using the libpq
 * environment; under `scripts/svc run <ticket>` that is `postgres:5432` as the bootstrap
 * superuser `app` (T-016 § contract §7). It needs no Node dependency.
 *
 * OUTCOMES. Each is a distinct exit status AND a distinct banner (PROTOCOL §5.1: "did nothing",
 * "refused" and "crashed" must be three different results):
 *   0  MIGRATE OK       the record reads the target
 *   1  MIGRATE FAIL     a migration file was run and psql exited non-zero
 *   2  MIGRATE REFUSED  no migration file was run: the arguments, the directory or the record
 *                       were refused
 *   3  MIGRATE ERROR    the database state could not be read (no migration file was run)
 *  70  MIGRATE CRASH    the runner threw
 *
 * THE RECORD. The applied version is `COMMENT ON DATABASE <db> IS 'kinvara-migrate version=NNNN'`
 * (no comment = 0000). It is not a table: a ledger table cannot exist before 0001 creates
 * `app_ddl`, its own down file would delete the record needed to revert below it, and a table in
 * schema `public` would be owned by `app_ddl`, which could rewrite it. Changing a database's
 * comment needs its owner or a superuser. The record is written in the same transaction as the
 * migration it records. A database comment that is not a record is refused, never overwritten.
 *
 * TRANSACTIONS (SD §DB-13 rule 4). A file runs inside one transaction with the record update
 * (`psql -1`), unless the file carries a line `-- @no-transaction`. A file that ends the runner's
 * transaction itself (`COMMIT`, `END`, `ROLLBACK`) is detected after it runs, and fails: what it
 * ran before the break is committed.
 *
 * PRINCIPAL (SD §DB-13 rule 6; T-021 § contract §4 and §6). A migration runs as `app_ddl`, by
 * `SET ROLE app_ddl` in the migration's session, unless it is one of the two merged migrations
 * that must run as the bootstrap superuser (below), or its UP file carries
 * `-- @run-as: bootstrap-superuser — <reference>`, where the reference names a T-NNN, OE-n, OD-n,
 * EV-n or SQ-n. A down file runs as its up file does.
 *
 * DIRECTORY RULES, all checked before any SQL runs:
 *   - every entry is a file named `NNNN_slug.up.sql` or `NNNN_slug.down.sql` (the lint's pattern);
 *   - one slug per number; no down file without its up file;
 *   - numbers run from 0001 with none skipped;
 *   - every migration has a down file, except one whose up file declares `-- @phase: contract`
 *     (SD §DB-13 rule 3). Such a migration can be applied; reverting through it is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { REPO_ROOT, capture } from './gates/lib/run.ts';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_REFUSED = 2;
const EXIT_ERROR = 3;
const EXIT_CRASH = 70;

const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.(up|down)\.sql$/;
const REFERENCE = /\b(?:T-\d{3}|OE-\d+|OD-\d+|EV-\d+|SQ-\d+)\b/;
const RECORD_RE = /^kinvara-migrate version=(\d{4})$/;
const MARKER_LINE = /^[ \t]*--[ \t]*@(run-as|no-transaction|phase)\b(.*)$/;
const TXN_BROKEN = 'KINVARA-MIGRATE-TXN-BROKEN';
const USAGE =
  'usage: db:migrate status [--dir <path>] | up [--to NNNN] [--dir <path>] | down --to NNNN [--dir <path>]';

/** The merged migrations that run as the bootstrap superuser, by exact name, and why. */
const BOOTSTRAP_SUPERUSER: ReadonlyMap<string, string> = new Map([
  ['0001_extensions_and_roles', 'T-020: creates app_ddl itself and installs untrusted extensions'],
  [
    '0002_int10_guard_stat_statements_execute',
    'T-021 contract §4 (S1-O): replaces a function the bootstrap superuser owns',
  ],
]);

class Refused extends Error {}
class Unreadable extends Error {}
class StepFailed extends Error {}

interface Migration {
  readonly id: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string | null;
  readonly contract: boolean;
  /** Why it runs as the bootstrap superuser; null means it runs as app_ddl. */
  readonly superuser: string | null;
  readonly upNoTransaction: boolean;
  readonly downNoTransaction: boolean;
}

interface Markers {
  readonly runAs: readonly string[];
  readonly noTransaction: boolean;
  readonly phases: readonly string[];
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readMarkers(file: string): Markers {
  const runAs: string[] = [];
  const phases: string[] = [];
  let noTransaction = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = MARKER_LINE.exec(line);
    if (m === null) continue;
    const rest = m[2] ?? '';
    if (m[1] === 'no-transaction') noTransaction = true;
    else if (m[1] === 'run-as') runAs.push(rest.replace(/^\s*:\s*/, '').trim());
    else phases.push((/^\s*:\s*([a-z]+)/.exec(rest) ?? [])[1] ?? '');
  }
  return { runAs, noTransaction, phases };
}

// ---------------------------------------------------------------------------
// 1. The directory: every rule checked before any SQL runs
// ---------------------------------------------------------------------------

function loadMigrations(dir: string): Migration[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Refused(`cannot read the migrations directory ${dir}: ${message(e)}`);
  }

  const problems: string[] = [];
  const byId = new Map<string, { slugs: Set<string>; up: string | null; down: string | null }>();
  for (const entry of entries) {
    const m = FILE_RE.exec(entry.name);
    if (!entry.isFile() || m === null) {
      problems.push(
        `unrecognised entry ${entry.name}: every entry must be a file named NNNN_slug.up.sql or NNNN_slug.down.sql`,
      );
      continue;
    }
    const id = m[1] ?? '';
    const slug = m[2] ?? '';
    const slot = byId.get(id) ?? { slugs: new Set<string>(), up: null, down: null };
    slot.slugs.add(slug);
    if (m[3] === 'up') slot.up = entry.name;
    else slot.down = entry.name;
    byId.set(id, slot);
  }

  const ids = [...byId.keys()].sort();
  if (ids.length === 0 && problems.length === 0) {
    problems.push(`no migrations found in ${dir}`);
  }
  const highest = ids.length === 0 ? 0 : Number(ids[ids.length - 1]);
  for (let n = 1; n <= highest; n += 1) {
    if (!byId.has(pad(n))) {
      problems.push(
        `numbering gap: no migration numbered ${pad(n)} (the highest is ${pad(highest)}); numbers run from 0001 with none skipped`,
      );
    }
  }
  if (byId.has('0000')) problems.push('migration 0000 is not allowed: numbers start at 0001');

  const migrations: Migration[] = [];
  for (const id of ids) {
    const slot = byId.get(id);
    if (slot === undefined) continue;
    if (slot.slugs.size !== 1) {
      problems.push(
        `number ${id} has ${String(slot.slugs.size)} names: ${[...slot.slugs].sort().join(', ')}`,
      );
      continue;
    }
    const name = `${id}_${[...slot.slugs][0] ?? ''}`;
    if (slot.up === null) {
      problems.push(`${name}.down.sql has no up file ${name}.up.sql`);
      continue;
    }
    const upPath = path.join(dir, slot.up);
    const downPath = slot.down === null ? null : path.join(dir, slot.down);
    const up = readMarkers(upPath);
    const down = downPath === null ? null : readMarkers(downPath);
    const contract = up.phases.length === 1 && up.phases[0] === 'contract';
    if (downPath === null && !contract) {
      problems.push(
        `missing down file ${name}.down.sql: only a migration whose up file declares \`-- @phase: contract\` may omit it (SD §DB-13 rule 3)`,
      );
    }
    if (down !== null && down.runAs.length > 0) {
      problems.push(
        `${name}.down.sql carries @run-as: declare it in the up file; a down file runs as its up file does`,
      );
    }
    let superuser = BOOTSTRAP_SUPERUSER.get(name) ?? null;
    if (up.runAs.length > 1) {
      problems.push(
        `${name}.up.sql carries ${String(up.runAs.length)} @run-as markers; at most one`,
      );
    } else if (up.runAs.length === 1) {
      const value = up.runAs[0] ?? '';
      if (!/^bootstrap-superuser\b/.test(value) || !REFERENCE.test(value)) {
        problems.push(
          `${name}.up.sql: \`-- @run-as: ${value}\` is refused; the only form is \`-- @run-as: bootstrap-superuser — <reference>\`, the reference naming a T-NNN, OE-n, OD-n, EV-n or SQ-n`,
        );
      } else {
        superuser = value;
      }
    }
    migrations.push({
      id,
      name,
      upPath,
      downPath,
      contract,
      superuser,
      upNoTransaction: up.noTransaction,
      downNoTransaction: down?.noTransaction ?? false,
    });
  }

  if (problems.length > 0) {
    throw new Refused(
      `the migrations directory ${dir} is refused:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return migrations;
}

// ---------------------------------------------------------------------------
// 2. The database: principal and record
// ---------------------------------------------------------------------------

interface DbState {
  readonly user: string;
  readonly superuser: boolean;
  readonly database: string;
  readonly recorded: string;
}

const PSQL_BASE = ['-X', '-q', '-v', 'ON_ERROR_STOP=1'] as const;

function readState(): DbState {
  const sql =
    "SELECT json_build_object('user', current_user, 'superuser', (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), " +
    "'database', current_database(), 'comment', shobj_description(d.oid, 'pg_database')) " +
    'FROM pg_database d WHERE d.datname = current_database()';
  const r = capture('psql', [...PSQL_BASE, '-A', '-t', '-c', sql]);
  if (r.code !== 0) {
    throw new Unreadable(`psql exited ${String(r.code)}: ${r.stderr.trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch (e) {
    throw new Unreadable(`unexpected state reading ${JSON.stringify(r.stdout)}: ${message(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Unreadable(`unexpected state reading ${JSON.stringify(r.stdout)}`);
  }
  const o = parsed as Record<string, unknown>;
  const user = typeof o['user'] === 'string' ? o['user'] : '';
  const database = typeof o['database'] === 'string' ? o['database'] : '';
  const comment = o['comment'];
  let recorded = '0000';
  if (typeof comment === 'string') {
    const m = RECORD_RE.exec(comment);
    if (m === null) {
      throw new Refused(
        `database ${database} carries a comment that is not a db:migrate record (${JSON.stringify(comment)}); refusing to overwrite it`,
      );
    }
    recorded = m[1] ?? '0000';
  } else if (comment !== null) {
    throw new Unreadable(`unexpected comment value in ${JSON.stringify(r.stdout)}`);
  }
  return { user, superuser: o['superuser'] === true, database, recorded };
}

// ---------------------------------------------------------------------------
// 3. One step: one file, its principal, and the record, in one transaction
// ---------------------------------------------------------------------------

function runStep(m: Migration, direction: 'up' | 'down', recordAfter: string): void {
  const file = direction === 'up' ? m.upPath : m.downPath;
  if (file === null) throw new Error(`internal: ${m.name} has no ${direction} file`);
  const noTransaction = direction === 'up' ? m.upNoTransaction : m.downNoTransaction;
  const base = path.basename(file);
  const principal = m.superuser === null ? 'app_ddl' : `bootstrap superuser (${m.superuser})`;
  console.log(
    `  ${direction === 'up' ? 'apply ' : 'revert'} ${base}  as ${principal}; ${noTransaction ? 'NO transaction (@no-transaction)' : 'one transaction'}`,
  );

  const nonce = randomBytes(12).toString('hex');
  const setRecord =
    recordAfter === '0000'
      ? "EXECUTE format('COMMENT ON DATABASE %I IS NULL', current_database());"
      : `EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'kinvara-migrate version=${recordAfter}');`;
  const guard = noTransaction
    ? ''
    : `IF current_setting('kinvara_migrate.txn', true) IS DISTINCT FROM '${nonce}' THEN ` +
      `RAISE EXCEPTION '${TXN_BROKEN}: % ended the runner''s transaction (a COMMIT, END or ROLLBACK inside it)', '${base}'; END IF;`;

  const args: string[] = [...PSQL_BASE];
  if (!noTransaction) args.push('-1', '-c', `SET LOCAL kinvara_migrate.txn = '${nonce}'`);
  if (m.superuser === null) args.push('-c', 'SET ROLE app_ddl');
  args.push(
    '-f',
    file,
    '-c',
    'RESET ROLE',
    '-c',
    `DO $kinvara_migrate$ BEGIN ${guard} ${setRecord} END $kinvara_migrate$`,
  );

  const r = capture('psql', args);
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  if (r.code === 0) {
    console.log(`    ok; record -> ${recordAfter}`);
    return;
  }
  let consequence: string;
  if (r.stderr.includes(TXN_BROKEN)) {
    consequence =
      'the file ended the runner transaction: statements it ran before the break are COMMITTED, and the record was not advanced';
  } else if (noTransaction) {
    consequence =
      'the file ran outside a transaction (@no-transaction): statements before the error are committed, and the record was not advanced';
  } else {
    consequence =
      'the transaction was rolled back: the file and the record update were not committed';
  }
  throw new StepFailed(`${base}: psql exited ${String(r.code)}; ${consequence}`);
}

// ---------------------------------------------------------------------------
// 4. Commands
// ---------------------------------------------------------------------------

interface Args {
  readonly command: 'status' | 'up' | 'down';
  readonly to: string | null;
  readonly dir: string;
}

function parseArgs(argv: readonly string[]): Args {
  const rest = argv[0] === '--' ? argv.slice(1) : [...argv];
  const command = rest.shift();
  if (command !== 'status' && command !== 'up' && command !== 'down') {
    throw new Refused(`unknown or missing command ${JSON.stringify(command ?? '')}\n${USAGE}`);
  }
  let to: string | null = null;
  let dir: string | null = null;
  while (rest.length > 0) {
    const arg = rest.shift() ?? '';
    const eq = /^(--to|--dir)=(.*)$/.exec(arg);
    const flag = eq === null ? arg : (eq[1] ?? '');
    if (flag !== '--to' && flag !== '--dir')
      throw new Refused(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    const value = eq === null ? rest.shift() : eq[2];
    if (value === undefined || value === '') throw new Refused(`${flag} needs a value\n${USAGE}`);
    if (flag === '--to') {
      if (to !== null) throw new Refused(`--to given twice\n${USAGE}`);
      if (!/^\d{4}$/.test(value))
        throw new Refused(`--to must be four digits, got ${JSON.stringify(value)}`);
      to = value;
    } else {
      if (dir !== null) throw new Refused(`--dir given twice\n${USAGE}`);
      dir = path.resolve(value);
    }
  }
  if (command === 'status' && to !== null) throw new Refused(`status takes no --to\n${USAGE}`);
  if (command === 'down' && to === null) {
    throw new Refused(
      `down needs an explicit --to NNNN (--to 0000 reverts every migration)\n${USAGE}`,
    );
  }
  return { command, to, dir: dir ?? path.join(REPO_ROOT, 'db', 'migrations') };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const migrations = loadMigrations(args.dir);
  const highest = migrations[migrations.length - 1]?.id ?? '0000';
  const state = readState();
  const where = `${process.env['PGHOST'] ?? '(libpq default host)'}:${process.env['PGPORT'] ?? '(default port)'}`;
  console.log(
    `db:migrate ${args.command}: ${String(migrations.length)} migration(s) in ${path.relative(REPO_ROOT, args.dir) || '.'} (highest ${highest}); ` +
      `database ${state.database} at ${where} as ${state.user} (superuser ${String(state.superuser)}); recorded ${state.recorded}`,
  );
  if (state.recorded > highest) {
    throw new Refused(
      `the database records version ${state.recorded}, but the directory's highest migration is ${highest}: a recorded migration has no file`,
    );
  }

  if (args.command === 'status') {
    for (const m of migrations) {
      console.log(
        `  ${m.id <= state.recorded ? '[applied]' : '[pending]'} ${m.name}  down:${m.downPath === null ? 'none (contract)' : 'yes'}  as:${m.superuser === null ? 'app_ddl' : 'bootstrap-superuser'}${m.upNoTransaction ? '  @no-transaction' : ''}`,
      );
    }
    console.log(`\nMIGRATE OK  status: recorded ${state.recorded}, highest ${highest}`);
    return EXIT_OK;
  }

  const target = args.to ?? highest;
  if (target > highest) {
    throw new Refused(`--to ${target} is above the highest migration, ${highest}`);
  }
  let steps = 0;
  if (args.command === 'up') {
    if (target < state.recorded) {
      throw new Refused(
        `up --to ${target} is below the recorded version ${state.recorded}; use down`,
      );
    }
    for (const m of migrations) {
      if (m.id <= state.recorded || m.id > target) continue;
      runStep(m, 'up', m.id);
      steps += 1;
    }
  } else {
    if (target > state.recorded) {
      throw new Refused(
        `down --to ${target} is above the recorded version ${state.recorded}; use up`,
      );
    }
    const reverting = migrations.filter((m) => m.id > target && m.id <= state.recorded).reverse();
    const irreversible = reverting.filter((m) => m.downPath === null);
    if (irreversible.length > 0) {
      throw new Refused(
        `down --to ${target} would revert ${irreversible.map((m) => m.name).join(', ')}, which has no down file (a contract migration is not reversible; roll forward, SD §DB-13 rule 3)`,
      );
    }
    for (const m of reverting) {
      runStep(m, 'down', pad(Number(m.id) - 1));
      steps += 1;
    }
  }

  const after = readState();
  if (after.recorded !== target) {
    throw new StepFailed(
      `every step exited 0, but the record reads ${after.recorded}, not the target ${target}`,
    );
  }
  console.log(
    `\nMIGRATE OK  ${args.command}: ${state.recorded} -> ${after.recorded} (${String(steps)} step(s)) on database ${after.database}`,
  );
  return EXIT_OK;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  if (e instanceof Refused) {
    console.error(`\nMIGRATE REFUSED  ${e.message}`);
    process.exit(EXIT_REFUSED);
  }
  if (e instanceof StepFailed) {
    console.error(`\nMIGRATE FAIL  ${e.message}`);
    process.exit(EXIT_FAIL);
  }
  if (e instanceof Unreadable) {
    console.error(`\nMIGRATE ERROR  cannot read the database state: ${e.message}`);
    process.exit(EXIT_ERROR);
  }
  console.error(`\nMIGRATE CRASH  ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(EXIT_CRASH);
}
