/**
 * One disposable Postgres CLUSTER per suite.
 *
 * ===========================================================================
 * WHY A CLUSTER AND NOT A DATABASE — the decision the T-020 reviewer measured
 * ===========================================================================
 *
 * `CREATE ROLE` has no `IF NOT EXISTS` and **roles are cluster-global**, so
 * running `0001` a second time against a second database in the SAME cluster
 * fails at `role "app_rw" already exists`. There are two ways out and this
 * harness takes the first:
 *
 *   (a) ONE CLUSTER PER SUITE — what this file does.
 *   (b) one cluster, many databases, dropping the five roles between suites.
 *
 * (b) is rejected for three reasons, in order of how much they cost:
 *
 *   1. It is not parallel-safe, and cannot be made so. Roles are cluster-global,
 *      so "drop the five roles" is a *cluster-wide* mutation: suite A's teardown
 *      deletes the roles suite B is mid-way through asserting against. The whole
 *      reason `DOCKER.md` §1 puts constraint suites on Testcontainers is that
 *      "a leaked row from a neighbouring suite makes a constraint test lie" —
 *      a leaked *role* makes it lie about privileges, which is the only thing
 *      these particular suites assert.
 *   2. Dropping a role is not a one-liner and the difference is load-bearing.
 *      `DROP ROLE` fails while any object depends on it, so (b) needs
 *      `REASSIGN OWNED` + `DROP OWNED` in every database of the cluster first —
 *      i.e. the teardown has to enumerate state, and a teardown that enumerates
 *      is a teardown that can miss. Anything it misses is granted privilege
 *      surviving into the next suite: the failure is a *false PASS* on a
 *      negative test, which is the one failure this package exists to prevent.
 *   3. `0001`'s §Section 0 preflight asserts `shared_preload_libraries`, a
 *      CLUSTER-level parameter. A per-database split cannot vary it, so the
 *      P3 preflight suite (T-020 Evidence §6) would have nothing to test
 *      against without restarting the shared cluster underneath its neighbours.
 *
 * The cost of (a) is honest and bounded: one container start per suite file,
 * ~3 s against a cached image, 512 MB at a time (`--test-concurrency=1`, so the
 * peak is one cluster — the `db` profile's own budget, `DOCKER.md` §3).
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  CLUSTER_MEMORY_BYTES,
  CLUSTER_NANO_CPUS,
  FORBIDDEN_IMAGE_PREFIX,
  POSTGRES_IMAGE,
} from './image.ts';
import {
  assertDockerAvailable,
  connectSelfToNetwork,
  containerLogs,
  createAndStartContainer,
  createInternalNetwork,
  disconnectSelfFromNetwork,
  imagePresent,
  removeContainer,
  removeNetwork,
  selfContainerId,
} from './engine.ts';

export const REPO_ROOT: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** The database every suite installs `0001` into. */
export const APP_DATABASE = 'kinvara';
/** The bootstrap superuser, as `compose.yml` names it. */
export const SUPERUSER = 'app';

export interface PsqlOptions {
  /** SQL statements, each run as its own `-c`, exactly as T-020's evidence did. */
  readonly commands?: readonly string[];
  /** A file to run instead of `-c` statements. Absolute, or relative to the repo root. */
  readonly file?: string;
  /** Connect as this role. Defaults to the bootstrap superuser. */
  readonly user?: string;
  readonly password?: string;
  /** Defaults to `kinvara`. */
  readonly database?: string;
  /** `-v ON_ERROR_STOP=1`. Default true; psql then exits 3 on the first error. */
  readonly stopOnError?: boolean;
  /** Wrap the whole invocation in one transaction (`--single-transaction`). */
  readonly singleTransaction?: boolean;
  /** `-A -t` — unaligned, tuples only, for exact string comparison. */
  readonly raw?: boolean;
  /** `\set VERBOSITY verbose`, so the SQLSTATE is in the message. */
  readonly verbose?: boolean;
}

export interface PsqlResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout + stderr, which is where a reader looks for a refusal. */
  readonly output: string;
}

export interface Cluster {
  /** The suite this cluster belongs to. */
  readonly suite: string;
  readonly containerId: string;
  readonly host: string;
  readonly port: number;
  psql(options: PsqlOptions): Promise<PsqlResult>;
  /** `psql`, asserting exit 0. Throws with the output on anything else. */
  sql(options: PsqlOptions): Promise<PsqlResult>;
  /** One value, trimmed — `-A -t` with a single row and column. */
  value(sql: string, options?: PsqlOptions): Promise<string>;
  logs(): Promise<string>;
  stop(): Promise<void>;
}

function token(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * The environment `psql` runs with.
 *
 * **Built from nothing, never merged into `process.env`.** `scripts/svc run`
 * injects `PGHOST`/`PGUSER`/`PGDATABASE`/`DATABASE_URL` for the COMPOSE
 * postgres (`T-016` § Published contract §7). If this harness inherited them,
 * a bug that left `host` empty would not fail — it would quietly run the
 * constraint suite against the ticket's compose database, and on the shared
 * `kinvara-dev` stack it would run against a long-lived one. That is the exact
 * contamination `DOCKER.md` §1 forbids, and the only reliable defence is to
 * not have the variables in scope.
 */
function psqlEnv(c: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    PGHOST: c.host,
    PGPORT: String(c.port),
    PGUSER: c.user,
    PGPASSWORD: c.password,
    PGDATABASE: c.database,
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'kinvara-db-testkit',
  };
}

function runPsql(env: Record<string, string>, args: readonly string[]): Promise<PsqlResult> {
  return new Promise((resolve) => {
    execFile(
      'psql',
      [...args],
      { env, cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 127;
        resolve({ code, stdout, stderr, output: `${stdout}${stderr}` });
      },
    );
  });
}

/**
 * Start a cluster, create the application database with `T-020` § Published
 * contract §1's statement **verbatim**, and hand it back.
 *
 * The `CREATE DATABASE` is not optional decoration. `datlocprovider`,
 * `datlocale` and `encoding` cannot be altered after the fact, and `0001`
 * refuses a database that gets them wrong; `TEMPLATE template0` is what keeps
 * the four auto-created PostGIS extensions of OD-8 out of it.
 */
export interface AcquireOptions {
  /**
   * Override the server command. Exactly one suite needs it: `0001`'s §Section 0
   * preflight asserts `shared_preload_libraries`, a CLUSTER-level parameter, and
   * the only honest way to watch that assertion refuse is to start a cluster
   * whose parameter is genuinely wrong (T-020 Evidence §6, P3).
   */
  readonly command?: readonly string[];
}

export async function acquireCluster(
  suite: string,
  options: AcquireOptions = {},
): Promise<Cluster> {
  // Before anything is created: the tag must be compose's, and not the stock one.
  assertPinnedImage(POSTGRES_IMAGE);
  await assertDockerAvailable();

  if (!(await imagePresent(POSTGRES_IMAGE))) {
    throw new Error(
      `the pinned image ${POSTGRES_IMAGE} is not on this daemon.\n` +
        `Build it once: docker build -f docker/postgres.Dockerfile -t ${POSTGRES_IMAGE} docker/\n` +
        `(T-017 § Published contract §2.) The harness does not pull silently: an\n` +
        `unpinned pull is how compose and Testcontainers drift.`,
    );
  }

  const id = `${suite.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${token()}`;
  const networkName = `kinvara-tc-${id}`;
  const containerName = `kinvara-tc-${id}-postgres`;
  const password = crypto.randomBytes(18).toString('hex');
  const startedAt = Date.now();

  const self = await selfContainerId();
  const network = await createInternalNetwork(networkName);
  let containerId = '';
  try {
    containerId = await createAndStartContainer({
      name: containerName,
      image: POSTGRES_IMAGE,
      env: [
        `POSTGRES_USER=${SUPERUSER}`,
        `POSTGRES_PASSWORD=${password}`,
        // `postgres` is the maintenance database the entrypoint always makes,
        // so naming it here means the entrypoint creates NOTHING extra. The
        // application database is created below, by the §1 statement.
        'POSTGRES_DB=postgres',
        'TZ=UTC',
        'PGTZ=UTC',
      ],
      ...(options.command === undefined ? {} : { cmd: options.command }),
      networkId: network.id,
      networkAlias: containerName,
      memoryBytes: CLUSTER_MEMORY_BYTES,
      nanoCpus: CLUSTER_NANO_CPUS,
    });
    await connectSelfToNetwork(network.id, self);

    const env = psqlEnv({
      host: containerName,
      port: 5432,
      user: SUPERUSER,
      password,
      database: 'postgres',
    });

    // Readiness: poll a real query, not a TCP connect. `pg_isready` reports
    // ready during the entrypoint's own temporary single-user startup.
    const deadline = Date.now() + 90_000;
    let ready = false;
    let last: PsqlResult | undefined;
    while (Date.now() < deadline) {
      last = await runPsql(env, ['-X', '-q', '-A', '-t', '-c', 'SELECT 1']);
      if (last.code === 0 && last.stdout.trim() === '1') {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) {
      throw new Error(
        `cluster ${containerName} did not accept a query within 90s.\n` +
          `last psql exit ${String(last?.code ?? -1)}: ${last?.output ?? ''}\n` +
          `--- container logs ---\n${await containerLogs(containerId)}`,
      );
    }

    // The database, exactly as T-020 § Published contract §1 specifies it.
    const create = await runPsql(env, [
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE DATABASE ${APP_DATABASE}
         OWNER ${SUPERUSER}
         TEMPLATE template0
         ENCODING UTF8
         LOCALE_PROVIDER icu
         ICU_LOCALE 'und'
         LOCALE 'C.UTF-8'`,
    ]);
    if (create.code !== 0) {
      throw new Error(`CREATE DATABASE failed (exit ${String(create.code)}): ${create.output}`);
    }

    const cluster = makeCluster({
      suite,
      containerId,
      networkId: network.id,
      selfId: self,
      host: containerName,
      port: 5432,
      password,
      startedAt,
    });

    // ---- the anti-contamination assertions, before a suite touches anything --
    // Exported so `suites/harness-refusals.test.ts` can watch each one REFUSE on
    // a real cluster; an assertion nobody has seen refuse is decoration.
    await assertDisposable(cluster, { startedAt });

    return cluster;
  } catch (err) {
    if (containerId !== '') await removeContainer(containerId).catch(() => undefined);
    await disconnectSelfFromNetwork(network.id, self).catch(() => undefined);
    await removeNetwork(network.id).catch(() => undefined);
    throw err;
  }
}

function makeCluster(c: {
  suite: string;
  containerId: string;
  networkId: string;
  selfId: string;
  host: string;
  port: number;
  password: string;
  startedAt: number;
}): Cluster {
  async function psql(options: PsqlOptions): Promise<PsqlResult> {
    const env = psqlEnv({
      host: c.host,
      port: c.port,
      user: options.user ?? SUPERUSER,
      password: options.password ?? c.password,
      database: options.database ?? APP_DATABASE,
    });
    const args: string[] = ['-X'];
    if (options.stopOnError !== false) args.push('-v', 'ON_ERROR_STOP=1');
    if (options.singleTransaction === true) args.push('--single-transaction');
    if (options.raw === true) args.push('-A', '-t');
    if (options.verbose === true) args.push('-c', '\\set VERBOSITY verbose');
    for (const command of options.commands ?? []) args.push('-c', command);
    if (options.file !== undefined) {
      args.push(
        '-f',
        path.isAbsolute(options.file) ? options.file : path.join(REPO_ROOT, options.file),
      );
    }
    return runPsql(env, args);
  }

  return {
    suite: c.suite,
    containerId: c.containerId,
    host: c.host,
    port: c.port,
    psql,
    async sql(options: PsqlOptions): Promise<PsqlResult> {
      const r = await psql(options);
      if (r.code !== 0) {
        throw new Error(`expected psql to succeed but it exited ${String(r.code)}:\n${r.output}`);
      }
      return r;
    },
    async value(sql: string, options: PsqlOptions = {}): Promise<string> {
      const r = await psql({ ...options, raw: true, commands: [sql] });
      if (r.code !== 0) {
        throw new Error(`expected psql to succeed but it exited ${String(r.code)}:\n${r.output}`);
      }
      return r.stdout.trim();
    },
    logs: () => containerLogs(c.containerId),
    async stop(): Promise<void> {
      await removeContainer(c.containerId).catch(() => undefined);
      await disconnectSelfFromNetwork(c.networkId, c.selfId).catch(() => undefined);
      await removeNetwork(c.networkId).catch(() => undefined);
    },
  };
}

// ===========================================================================
// The harness's own refusals — exported so a suite can watch each one refuse
// (`suites/harness-refusals.test.ts`). An assertion nobody has seen refuse is
// decoration (PROTOCOL §5.1).
// ===========================================================================

/** The one file that declares the Postgres tag (`T-017` § Published contract §2). */
export const COMPOSE_FILE = 'docker/compose.yml';

/**
 * `compose.yml`'s `postgres` image, read NOW with a real YAML parser — a
 * hand-rolled subset is how `gate:egress-boundary` misread flow mappings
 * (`T-017` QA-F2).
 */
export function composePostgresImage(
  composePath: string = path.join(REPO_ROOT, COMPOSE_FILE),
): string {
  const doc: unknown = YAML.parse(fs.readFileSync(composePath, 'utf8'));
  const services =
    typeof doc === 'object' && doc !== null
      ? (doc as Record<string, unknown>)['services']
      : undefined;
  const postgres =
    typeof services === 'object' && services !== null
      ? (services as Record<string, unknown>)['postgres']
      : undefined;
  const image =
    typeof postgres === 'object' && postgres !== null
      ? (postgres as Record<string, unknown>)['image']
      : undefined;
  if (typeof image !== 'string' || image === '') {
    throw new Error(
      `${composePath} declares no postgres image, so the harness cannot confirm it would run ` +
        `compose's (DOCKER.md §1)`,
    );
  }
  return image;
}

/**
 * Refuse, before anything is created, an image that is the stock one or is not
 * compose's. `gate:constraint-suite` makes the identity check statically; this
 * is the same rule at the point of use, so a suite run DIRECTLY
 * (`pnpm --filter @kinvara/db-testkit run test:integration`) refuses a drifted
 * tag too. Measured before this existed (`state/EP-QA/T-115.md`, Attack A):
 * with the tag pointed at the stock image, the harness's own provisioning check
 * PASSED — it creates the database ICU `und` explicitly — and only `0001`'s
 * preflight refused.
 */
export function assertPinnedImage(
  image: string,
  composeImage: string = composePostgresImage(),
): void {
  if (image.startsWith(FORBIDDEN_IMAGE_PREFIX)) {
    throw new Error(
      `refusing the STOCK image ${image} (OD-10): it provisions a libc database with an empty ` +
        `shared_preload_libraries and four undeclared extensions. Use compose's image.`,
    );
  }
  if (image !== composeImage) {
    throw new Error(
      `image drift: the harness would start ${image} but docker/compose.yml's postgres is ` +
        `${composeImage}. DOCKER.md §1: the same tag in compose and Testcontainers.`,
    );
  }
}

/** The five roles `0001` creates. Cluster-global, and `CREATE ROLE` has no IF NOT EXISTS. */
export const FIVE_ROLES = [
  'app_rw',
  'app_admin_rw',
  'app_safety_rw',
  'app_ddl',
  'answering_service',
] as const;

export interface DisposableCheck {
  /** `Date.now()` taken when this suite began creating the cluster. */
  readonly startedAt: number;
  /** Tolerance on the freshness comparison, for boot time and clock skew. Default 30 s. */
  readonly slackSeconds?: number;
  /** The database whose provisioning is checked. Default `kinvara`. */
  readonly database?: string;
}

/**
 * The three anti-contamination refusals `acquireCluster` makes before a suite
 * touches anything. They are the difference between "this suite has its own
 * cluster" being a claim and being a checked property.
 */
export async function assertDisposable(cluster: Cluster, check: DisposableCheck): Promise<void> {
  const database = check.database ?? APP_DATABASE;
  const slack = check.slackSeconds ?? 30;

  const provider = await cluster.value(
    `SELECT datlocprovider::text || ':' || coalesce(datlocale,'')
       FROM pg_database WHERE datname = current_database()`,
    { database },
  );
  if (provider !== 'i:und') {
    throw new Error(
      `the harness database is provisioned wrong: ${database} has datlocprovider:datlocale = ` +
        `${provider}, expected i:und (T-020 § contract §1). Check that ${POSTGRES_IMAGE} is the ` +
        `image in use (OD-10).`,
    );
  }

  // Freshness. A cluster this suite started is at most seconds old; a shared or
  // leaked one is not. Two independent clocks — the postmaster's and this
  // process's — so this cannot pass by agreeing with itself.
  const ageSeconds = Number(
    await cluster.value(`SELECT extract(epoch from (now() - pg_postmaster_start_time()))`),
  );
  const wallSeconds = (Date.now() - check.startedAt) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds > wallSeconds + slack) {
    throw new Error(
      `the server this suite connected to has been up ${ageSeconds.toFixed(1)}s but this suite ` +
        `started it ${wallSeconds.toFixed(1)}s ago (tolerance ${String(slack)}s). That is not a ` +
        `disposable cluster — refusing to run a constraint suite against shared state ` +
        `(DOCKER.md §1).`,
    );
  }

  // Nothing may pre-exist: a cluster that already carries the roles is a reused one.
  const preexisting = await cluster.value(
    `SELECT count(*) FROM pg_roles WHERE rolname IN (${FIVE_ROLES.map((r) => `'${r}'`).join(',')})`,
  );
  if (preexisting !== '0') {
    throw new Error(
      `${preexisting} of the five 0001 roles already exist in this cluster. Roles are ` +
        `cluster-global; this cluster has been used before.`,
    );
  }
}

/** The `0001` baseline, resolved from the repo rather than copied into this package. */
export const BASELINE_UP = 'db/migrations/0001_extensions_and_roles.up.sql';
export const BASELINE_DOWN = 'db/migrations/0001_extensions_and_roles.down.sql';

export function baselineExists(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, BASELINE_UP));
}

/**
 * Apply `0001`, as a migration author would: one transaction, `ON_ERROR_STOP`.
 * Returns the result rather than throwing, because three suites exist precisely
 * to watch it REFUSE (T-020 Evidence §6).
 */
export async function applyBaseline(
  cluster: Cluster,
  database = APP_DATABASE,
): Promise<PsqlResult> {
  return cluster.psql({ database, file: BASELINE_UP, singleTransaction: true });
}

export async function revertBaseline(
  cluster: Cluster,
  database = APP_DATABASE,
): Promise<PsqlResult> {
  return cluster.psql({ database, file: BASELINE_DOWN, singleTransaction: true });
}
