/**
 * Every committed migration, applied to a suite's cluster by `T-136`'s runner.
 *
 * Until `T-137` the harness applied `0001` alone, with its own `psql -f`, so no
 * re-runnable suite exercised `0002` onward (`T-021` § contract §5, `T-143`
 * § contract §5). This file does NOT order or apply migrations itself: it runs
 * `scripts/db-migrate.ts up` (`T-136` § Published contract) as a child process
 * against the cluster, and judges the run. A second implementation of the
 * ordering, the principal rules or the transaction rules would be a second
 * thing to keep in step with the one the programme actually uses.
 *
 * Three readings, so that "applied" is not inferred from a signal a no-op also
 * produces (PROTOCOL §5.1):
 *
 *   1. the runner's EXIT STATUS and its BANNER, which must agree with each other
 *      (`T-136` § contract §2) — anything else is a crash, never a verdict;
 *   2. the database's own record, read back over a separate connection and
 *      compared with the highest migration THIS file lists from the directory,
 *      so a run that printed `MIGRATE OK` and applied nothing is refused;
 *   3. before any cluster starts: a `dir` other than `db/migrations` must carry
 *      every committed migration FILE byte for byte, so the `dir` option can
 *      add a scratch migration file but cannot drop or alter a committed file.
 *      It fixes which files are applied, not the state they leave: an added
 *      migration can undo a committed one's effect (tech-lead TV-A2, D4c).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, type Cluster, type PsqlResult } from './cluster.ts';

export { MIGRATE_RUNNER } from './cluster.ts';
/** The committed migrations. */
export const MIGRATIONS_DIR = 'db/migrations';

/** The exit status `T-136` § contract §2 pairs with each banner. */
const EXIT_FOR_BANNER: Readonly<Record<string, number>> = {
  OK: 0,
  FAIL: 1,
  REFUSED: 2,
  ERROR: 3,
  CRASH: 70,
};
const BANNER = /^MIGRATE (OK|FAIL|REFUSED|ERROR|CRASH) {2}(.*)$/gm;
const FAIL_TEXT = /^(\d{4}_[a-z0-9][a-z0-9_]*\.(?:up|down)\.sql): psql exited (\d+); (.+)$/;
/** An up file, read independently of the runner's own pattern. */
const UP_FILE = /^(\d{4})_[a-z0-9][a-z0-9_]*\.up\.sql$/;

export type MigrateVerdict =
  | { readonly kind: 'OK'; readonly banner: string }
  | {
      readonly kind: 'FAIL';
      readonly banner: string;
      /** The migration file psql ran when it exited non-zero. */
      readonly file: string;
      readonly psqlExit: number;
      readonly consequence: string;
    }
  | { readonly kind: 'REFUSED'; readonly banner: string }
  | { readonly kind: 'ERROR'; readonly banner: string }
  | { readonly kind: 'CRASH'; readonly reason: string };

/**
 * Judge one runner invocation by its exit status AND its banner together.
 *
 * Exactly one banner across stdout and stderr, and an exit status that is the
 * one `T-136` pairs with it. A `MIGRATE CRASH` banner, no banner, two banners, a
 * banner whose exit disagrees, or a `FAIL` banner not in the contract's
 * `<file>: psql exited N; …` form are all `CRASH`: the harness never reports a
 * migration as having failed unless the runner said which file and which psql
 * exit.
 */
export function judgeMigrateRun(
  run: Pick<PsqlResult, 'code' | 'stdout' | 'stderr'>,
): MigrateVerdict {
  const banners = [...run.stdout.matchAll(BANNER), ...run.stderr.matchAll(BANNER)];
  if (banners.length !== 1) {
    return {
      kind: 'CRASH',
      reason: `db:migrate printed ${String(banners.length)} MIGRATE banner(s), not exactly one (exit ${String(run.code)})`,
    };
  }
  const word = banners[0]?.[1] ?? '';
  const text = banners[0]?.[2] ?? '';
  const banner = `MIGRATE ${word}  ${text}`;
  if (word === 'CRASH') {
    return { kind: 'CRASH', reason: `the runner threw (exit ${String(run.code)}): ${banner}` };
  }
  if (run.code !== EXIT_FOR_BANNER[word]) {
    return {
      kind: 'CRASH',
      reason: `db:migrate exited ${String(run.code)} but printed '${banner}', which the runner pairs with exit ${String(EXIT_FOR_BANNER[word])}`,
    };
  }
  if (word === 'FAIL') {
    const m = FAIL_TEXT.exec(text);
    if (m === null) {
      return {
        kind: 'CRASH',
        reason: `db:migrate exited 1 but its banner does not name a file and a psql exit: '${banner}'`,
      };
    }
    return {
      kind: 'FAIL',
      banner,
      file: m[1] ?? '',
      psqlExit: Number(m[2]),
      consequence: m[3] ?? '',
    };
  }
  if (word === 'OK' || word === 'REFUSED' || word === 'ERROR') return { kind: word, banner };
  return { kind: 'CRASH', reason: `unrecognised banner '${banner}'` };
}

export type NotAppliedKind =
  | 'FAIL'
  | 'REFUSED'
  | 'ERROR'
  | 'CRASH'
  /** The runner said OK; the database's record does not read the highest migration. */
  | 'NOT_RECORDED'
  /** A `dir` that does not carry every committed migration byte for byte. No cluster was started. */
  | 'INCOMPLETE_DIR';

/** Thrown by `acquireMigratedCluster` when the migrations did not all apply. */
export class MigrationsNotApplied extends Error {
  readonly kind: NotAppliedKind;
  readonly suite: string;
  /** The runner invocation, when there was one. */
  readonly run: PsqlResult | undefined;
  readonly verdict: MigrateVerdict | undefined;

  constructor(c: {
    kind: NotAppliedKind;
    suite: string;
    summary: string;
    run?: PsqlResult;
    verdict?: MigrateVerdict;
  }) {
    super(
      `migrations did not apply for suite '${c.suite}' — ${c.kind}: ${c.summary}` +
        (c.run === undefined ? '' : `\n--- db:migrate output ---\n${c.run.output}`),
    );
    this.name = 'MigrationsNotApplied';
    this.kind = c.kind;
    this.suite = c.suite;
    this.run = c.run;
    this.verdict = c.verdict;
  }
}

/** The highest migration number with an up file in `dir`, read without the runner. */
export function highestMigrationIn(dir: string): string {
  const ids = fs
    .readdirSync(dir)
    .map((f) => UP_FILE.exec(f)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
  const highest = ids[ids.length - 1];
  if (highest === undefined) throw new Error(`${dir} holds no migration up file`);
  return highest;
}

/**
 * Refuse a migrations directory that does not carry every file of
 * `db/migrations`, byte for byte. Returns the file names checked.
 */
export function assertCarriesEveryCommittedMigration(suite: string, dir: string): string[] {
  const committedDir = path.join(REPO_ROOT, MIGRATIONS_DIR);
  const committed = fs.readdirSync(committedDir).sort();
  if (committed.length === 0) {
    throw new MigrationsNotApplied({
      kind: 'INCOMPLETE_DIR',
      suite,
      summary: `${MIGRATIONS_DIR} is empty: there is nothing to apply, and a harness that applied nothing must not pass`,
    });
  }
  if (path.resolve(dir) === committedDir) return committed;
  const problems: string[] = [];
  for (const name of committed) {
    const theirs = path.join(dir, name);
    if (!fs.existsSync(theirs)) {
      problems.push(`${name} is missing`);
    } else if (!fs.readFileSync(theirs).equals(fs.readFileSync(path.join(committedDir, name)))) {
      problems.push(`${name} differs from the committed file`);
    }
  }
  if (problems.length > 0) {
    throw new MigrationsNotApplied({
      kind: 'INCOMPLETE_DIR',
      suite,
      summary:
        `${dir} does not carry every committed migration (${problems.join('; ')}). A scratch ` +
        `directory may ADD migration files; it may not drop or alter a file in ${MIGRATIONS_DIR}.`,
    });
  }
  return committed;
}

/**
 * `db:migrate up --dir <dir>` against the cluster's `kinvara` database, as the
 * bootstrap superuser, judged, and then checked against the database's record.
 * Throws `MigrationsNotApplied` on anything but a verified `OK`.
 */
export async function applyMigrations(cluster: Cluster, dir: string): Promise<PsqlResult> {
  const run = await cluster.migrate(['up', '--dir', path.resolve(dir)]);
  const verdict = judgeMigrateRun(run);
  switch (verdict.kind) {
    case 'OK':
      break;
    case 'FAIL':
      throw new MigrationsNotApplied({
        kind: 'FAIL',
        suite: cluster.suite,
        summary:
          `${verdict.file} failed with psql exit ${String(verdict.psqlExit)} (db:migrate exit ` +
          `${String(run.code)}); ${verdict.consequence}. If psql's error is the SA §INT-10 guard ` +
          `raising KV010, the guard has found a real read path.`,
        run,
        verdict,
      });
    case 'REFUSED':
    case 'ERROR':
      throw new MigrationsNotApplied({
        kind: verdict.kind,
        suite: cluster.suite,
        summary: `db:migrate exit ${String(run.code)}, no migration file ran: ${verdict.banner}`,
        run,
        verdict,
      });
    case 'CRASH':
      throw new MigrationsNotApplied({
        kind: 'CRASH',
        suite: cluster.suite,
        summary:
          `db:migrate did not report in T-136 § contract §2's form, so the harness cannot say ` +
          `whether a migration failed: ${verdict.reason}`,
        run,
        verdict,
      });
  }
  const want = `kinvara-migrate version=${highestMigrationIn(dir)}`;
  const recorded = await cluster.value(
    `SELECT coalesce(shobj_description(oid, 'pg_database'), '(no comment)')
       FROM pg_database WHERE datname = current_database()`,
  );
  if (recorded !== want) {
    throw new MigrationsNotApplied({
      kind: 'NOT_RECORDED',
      suite: cluster.suite,
      summary: `db:migrate printed '${verdict.banner}', but the database records '${recorded}', not '${want}'`,
      run,
      verdict,
    });
  }
  return run;
}
