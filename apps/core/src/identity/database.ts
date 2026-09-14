/**
 * The identity module's Postgres access.
 *
 * ONE POOL PER PROCESS, CREATED ON FIRST USE. `tools/build.ts` and T-135's fault server load
 * `AppModule` with no database, and they connect to nothing.
 *
 * THE PRINCIPAL. `T-020` § contract §3 and `T-140` § contract §5 say `core` connects as `app_rw`.
 * The compose stack instead gives `core` the bootstrap superuser (decisions.md OD-116). So every
 * transaction here runs `SET LOCAL ROLE app_rw` before its first statement, and a statement beyond
 * `app_rw`'s grants is refused inside the transaction. Held by `test/identity.inprocess.test.ts` ›
 * *withAppRw runs as app_rw …*.
 *
 * A superuser session can `RESET ROLE`. So this guards this module's own SQL against exceeding the
 * grants; it is not a boundary around `core`.
 */
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { errorClass } from '../problem-json/error-class.ts';

export type Tx = PoolClient;

export type LogLine = (line: string) => void;

/** Fixed text: nothing from the connection string. */
export const DATABASE_URL_REFUSED = 'identity: DATABASE_URL is not set, so there is no database';

export const DATABASE_LOG = Object.freeze({
  idleClientError: 'identity: an idle database connection failed; the pool discarded it',
});

const toStderr: LogLine = (line) => {
  process.stderr.write(`[core] ${line}\n`);
};

export class Database {
  readonly #connectionString: string | undefined;
  readonly #log: LogLine;
  #pool: Pool | undefined;

  constructor(connectionString: string | undefined, log: LogLine = toStderr) {
    this.#connectionString = connectionString;
    this.#log = log;
  }

  #pool_(): Pool {
    if (this.#pool !== undefined) return this.#pool;
    const connectionString = this.#connectionString;
    if (connectionString === undefined || connectionString === '') {
      throw new TypeError(DATABASE_URL_REFUSED);
    }
    const pool = new pg.Pool({ connectionString, application_name: 'kinvara-core' });
    // Without a listener, an idle client's error crashes the process.
    pool.on('error', (thrown) => {
      this.#log(`${DATABASE_LOG.idleClientError} class=${errorClass(thrown)}`);
    });
    this.#pool = pool;
    return pool;
  }

  /** One transaction as `app_rw`: BEGIN, SET LOCAL ROLE app_rw, `work`, COMMIT (or ROLLBACK). */
  async withAppRw<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.#pool_().connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_rw');
      const result = await work(client);
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

  /** Nest calls this from `app.close()` (the drain in `server.ts`). */
  async onApplicationShutdown(): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    if (pool !== undefined) await pool.end();
  }
}
