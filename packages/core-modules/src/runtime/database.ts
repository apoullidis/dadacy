/**
 * The shared Postgres access every module uses, in every deployable that loads it: Drizzle over
 * `pg` (SD §DB-1 line 1755, §SEC-I2 line 3893). Moved here from `apps/core/src/identity/` by
 * T-245 (OD-292a, EV-30); `withAppRw` is unchanged.
 *
 * ONE POOL PER `Database`, CREATED ON FIRST USE. `apps/core`'s `tools/build.ts` and T-135's fault
 * server load `AppModule` with no database, and they connect to nothing.
 *
 * NO USE AFTER SHUTDOWN (T-245 rework 1, QA-F1 / OD-298). `onApplicationShutdown` ends the pool and
 * marks the `Database` shut down for good: every later `withAppRw` rejects with
 * `DatabaseShutDownError` (fixed text `DATABASE_SHUT_DOWN`) and opens nothing. Before this, a use
 * after shutdown silently built a NEW pool that nothing ever ended, so a `Database` torn down too
 * early was invisible: a job in flight simply reconnected. Now such a job FAILS — which is what lets
 * the worker's `tools/drain-check.sh` (check A) see a `Database` torn down before the drain (QA's
 * `dbfirst` mutant: DRAIN PASS before this change, DRAIN FAIL after; state/EP-2/T-245.md § Rework 1).
 * Held without a database by `database.test.ts` › *use after shutdown is refused …*.
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

declare const TX_BRAND: unique symbol;

/**
 * A Drizzle handle bound to ONE pooled connection, inside an `app_rw` transaction.
 *
 * BRANDED (T-149). Only `withAppRw` mints one, so a function that takes a `Tx` cannot be handed a
 * pool-bound `drizzle(pool)` handle, `undefined`, or nothing at all: each is a compile error. The
 * enqueue (`@kinvara/core-modules/jobs`) relies on it — SD §BE-11 line 1313, a job is enqueued in
 * the caller's transaction. Held by `type-tests/enqueue-refusals.ts` under `pnpm -w typecheck`.
 * The brand is a type only; `as unknown as Tx` gets past it, which is why `assertOpenTx` exists.
 */
export type Tx = NodePgDatabase & { readonly [TX_BRAND]: 'app_rw transaction' };

/**
 * The `Tx` handles whose transaction is still open: added before `work` runs, removed before
 * COMMIT or ROLLBACK. A handle kept past its transaction is no longer in it (T-149).
 */
const openTx = new WeakSet<object>();

/** Fixed text of `TransactionClosedError`. */
export const TRANSACTION_CLOSED =
  'database: this Tx is not an open withAppRw transaction (it committed, rolled back, or was never one)';

/**
 * A `Tx` used outside its transaction: after `withAppRw` committed or rolled back, or a value that
 * was never minted by `withAppRw`. Its connection has gone back to the pool, so a statement on it
 * would run in autocommit — for an enqueue, a job after commit (SD §BE-11 line 1313).
 */
export class TransactionClosedError extends Error {
  override readonly name = 'TransactionClosedError';
  constructor() {
    super(TRANSACTION_CLOSED);
  }
}

/** Throws `TransactionClosedError` unless `tx` is an open `withAppRw` transaction. */
export function assertOpenTx(tx: Tx): void {
  if (!openTx.has(tx)) throw new TransactionClosedError();
}

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

/** Fixed text of `DatabaseShutDownError`. */
export const DATABASE_SHUT_DOWN =
  'database: this Database was shut down (onApplicationShutdown ran); it opens no new pool';

/**
 * A `withAppRw` after `onApplicationShutdown`. Refused, never served by a new pool: a module that
 * still needs the database after its app's teardown began is an ordering defect, and it must fail
 * where it happens rather than reconnect unseen.
 */
export class DatabaseShutDownError extends Error {
  override readonly name = 'DatabaseShutDownError';
  constructor() {
    super(DATABASE_SHUT_DOWN);
  }
}

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
  #shutDown = false;

  constructor(source: DatabaseSource, log: LogLine) {
    this.#source = source;
    this.#log = log;
  }

  #pool_(): Pool {
    if (this.#shutDown) throw new DatabaseShutDownError();
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

  /**
   * One transaction as `app_rw`: BEGIN, SET LOCAL ROLE app_rw, `work`, COMMIT (or ROLLBACK).
   * Rejects `DatabaseShutDownError` once `onApplicationShutdown` has run.
   */
  async withAppRw<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.#pool_().connect();
    let broken = false;
    let tx: Tx | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_rw');
      // The one place a `Tx` is minted (the brand is a type; see `Tx`).
      tx = drizzle({ client }) as unknown as Tx;
      openTx.add(tx);
      const result = await work(tx);
      openTx.delete(tx);
      await client.query('COMMIT');
      return result;
    } catch (thrown) {
      if (tx !== undefined) openTx.delete(tx);
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
   * after `BossHost.drain()` has returned (T-242 RW1-C §2). Ends the pool (idempotent) and refuses
   * every later `withAppRw` — so if this ever ran before the drain, the in-flight job's
   * `withAppRw` would reject and drain-check A would go red (T-245 rework 1, RW1-R2).
   */
  async onApplicationShutdown(): Promise<void> {
    this.#shutDown = true;
    const pool = this.#pool;
    this.#pool = undefined;
    if (pool !== undefined) await pool.end();
  }
}
