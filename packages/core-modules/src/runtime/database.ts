/**
 * The shared Postgres access every module uses, in every deployable that loads it: Drizzle over
 * `pg` (SD §DB-1 line 1755, §SEC-I2 line 3893). Moved here from `apps/core/src/identity/` by
 * T-245 (OD-292a, EV-30); `withAppRw` is unchanged.
 *
 * ONE POOL PER `Database`, CREATED ON FIRST USE. `apps/core`'s `tools/build.ts` and T-135's fault
 * server load `AppModule` with no database, and they connect to nothing.
 *
 * WHERE IT CONNECTS IS THE APP'S CHOICE, NOT THIS FILE'S. Each app binds `Database` to its own
 * `DatabaseSource` through `DatabaseModule.forRoot` (./database.module.ts): `apps/core` to
 * `DATABASE_URL` with `application_name = 'kinvara-core'`; `apps/worker` to `WorkerRuntimeModule`'s
 * `CONNECTION_SETTINGS`, which add libpq's `-c role=app_rw` to every connection. The pool is built
 * from the source's fields and nothing else (`poolConfigFor`).
 *
 * THE PRINCIPAL. `T-020` § contract §3 and `T-140` § contract §5 say the apps connect as `app_rw`.
 * The compose stack instead gives them the bootstrap superuser (decisions.md OD-116). So every
 * transaction here runs `SET LOCAL ROLE app_rw` before its first statement, and a statement beyond
 * `app_rw`'s grants is refused inside the transaction. Held by `apps/core`'s
 * `test/identity.inprocess.test.ts` › *withAppRw runs as app_rw …*, against core's binding, which
 * carries no role option, so that case reads what this statement does.
 *
 * A superuser session can `RESET ROLE`. So this guards the callers' own queries against exceeding
 * the grants; it is not a boundary around the process.
 *
 * The three session statements (`BEGIN`, `SET LOCAL ROLE app_rw`, `COMMIT`/`ROLLBACK`) are constant
 * strings with no parameters, sent on the pooled connection. Every read and write of a table goes
 * through the Drizzle handle `work` receives.
 */
import pg from 'pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { errorClass } from './error-class.ts';

/** A Drizzle handle bound to ONE pooled connection, inside an `app_rw` transaction. */
export type Tx = NodePgDatabase;

export type LogLine = (line: string) => void;

/**
 * Where an app's `Database` connects. `connectionString` may be absent: the refusal comes on first
 * use, never at construction. The optional fields are passed to `pg.Pool` only when present.
 */
export interface DatabaseSource {
  readonly connectionString: string | undefined;
  /** Per app: `kinvara-core`, `kinvara-worker`. */
  readonly application_name: string;
  /** libpq startup options, e.g. the worker's `-c role=app_rw`. */
  readonly options?: string;
  readonly connectionTimeoutMillis?: number;
  readonly max?: number;
}

/** Fixed text: nothing from the connection string. */
export const DATABASE_URL_REFUSED = 'database: DATABASE_URL is not set, so there is no database';

export const DATABASE_LOG = Object.freeze({
  idleClientError: 'database: an idle database connection failed; the pool discarded it',
});

/** The `pg.Pool` options for a source: its fields, the absent optional ones omitted. */
export function poolConfigFor(source: DatabaseSource, connectionString: string): PoolConfig {
  return {
    connectionString,
    application_name: source.application_name,
    ...(source.options === undefined ? {} : { options: source.options }),
    ...(source.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: source.connectionTimeoutMillis }),
    ...(source.max === undefined ? {} : { max: source.max }),
  };
}

export class Database {
  readonly #source: DatabaseSource;
  readonly #log: LogLine;
  #pool: Pool | undefined;

  constructor(source: DatabaseSource, log: LogLine) {
    this.#source = source;
    this.#log = log;
  }

  #pool_(): Pool {
    if (this.#pool !== undefined) return this.#pool;
    const connectionString = this.#source.connectionString;
    if (connectionString === undefined || connectionString === '') {
      throw new TypeError(DATABASE_URL_REFUSED);
    }
    const pool = new pg.Pool(poolConfigFor(this.#source, connectionString));
    // Without a listener, an idle client's error crashes the process.
    pool.on('error', (thrown) => {
      this.#log(`${DATABASE_LOG.idleClientError} class=${errorClass(thrown)}`);
    });
    this.#pool = pool;
    return pool;
  }

  /** One transaction as `app_rw`: BEGIN, SET LOCAL ROLE app_rw, `work`, COMMIT (or ROLLBACK). */
  async withAppRw<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.#pool_().connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_rw');
      const result = await work(drizzle({ client }));
      await client.query('COMMIT');
      return result;
    } catch (thrown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw thrown;
    } finally {
      client.release(broken);
    }
  }

  /**
   * Nest calls this from `app.close()`: in `apps/core`, the drain in `server.ts`; in `apps/worker`,
   * after `BossHost.drain()` has returned (T-242 RW1-C §2), so no in-flight handler loses the pool.
   */
  async onApplicationShutdown(): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    if (pool !== undefined) await pool.end();
  }
}
