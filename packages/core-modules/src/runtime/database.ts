/**
 * The shared Postgres access every module uses, in every deployable that loads it: Drizzle over
 * `pg` (SD §DB-1 line 1755, §SEC-I2 line 3893). Moved here from `apps/core/src/identity/` by
 * T-245 (OD-292a, EV-30). T-149 added the branded `Tx` and the join (`joinTx`): `withAppRw` sends
 * the same statements as before, and now waits for every enqueue joined to its `Tx` before COMMIT
 * or ROLLBACK (OD-303).
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
 * strings with no parameters, sent on the pooled connection. `withActor` (T-254) adds one more,
 * `SET_ACTOR_SQL`, a constant string whose three values are bind parameters. Every read and write of a table goes
 * through the Drizzle handle `work` receives.
 */
import pg from 'pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { errorClass } from './error-class.ts';
import {
  ACTOR_GUCS,
  actorSettings,
  type Actor,
  type ActorTxOptions,
  type SystemActor,
  systemActor,
} from './actor.ts';

declare const TX_BRAND: unique symbol;

/**
 * A Drizzle handle bound to ONE pooled connection, inside an `app_rw` transaction.
 *
 * BRANDED (T-149). Only `withAppRw` and `withActor` (T-254) mint one, so a function that takes a `Tx` cannot be handed a
 * pool-bound `drizzle(pool)` handle, `undefined`, or nothing at all: each is a compile error. The
 * enqueue (`@kinvara/core-modules/jobs`) relies on it — SD §BE-11 line 1313, a job is enqueued in
 * the caller's transaction. Held by `type-tests/enqueue-refusals.ts` under `pnpm -w typecheck`.
 * The brand is a type only. Measured (T-149 QA-3): `pooled as Tx` is TS2352 and `{ ...tx }` is
 * TS2322, but `as unknown as Tx` and `Object.assign({}, tx)` compile — which is why the enqueue
 * also checks at run time (`joinTx`), and why a forged `Tx` handed to any OTHER consumer is
 * refused by nothing.
 */
export type Tx = NodePgDatabase & { readonly [TX_BRAND]: 'app_rw transaction' };

/**
 * The life of one `withAppRw` transaction, as the enqueue sees it (T-149 rework 1, OD-303):
 *   - `open`     — `work` is running. `joinTx` accepts new operations.
 *   - `settling` — `work` has returned or thrown. `joinTx` refuses new operations, but statements
 *                  of operations already joined still run (`assertLiveTx` passes): `withAppRw` is
 *                  waiting for them, BEFORE its COMMIT or ROLLBACK.
 *   - `closed`   — every joined operation has settled; COMMIT or ROLLBACK is next. Nothing runs.
 */
interface TxState {
  phase: 'open' | 'settling' | 'closed';
  readonly joined: Promise<unknown>[];
}
const txStates = new WeakMap<object, TxState>();

/** Fixed text of `TransactionClosedError`. */
export const TRANSACTION_CLOSED =
  'database: this Tx is not an open withAppRw transaction (it committed, rolled back, or was never one)';

/**
 * A `Tx` used outside its transaction: after `withAppRw`'s `work` returned (the transaction is
 * committing, rolling back, or done), or a value that was never minted by `withAppRw`. A statement
 * on it would run in autocommit on a released connection — for an enqueue, a job after commit
 * (SD §BE-11 line 1313).
 */
export class TransactionClosedError extends Error {
  override readonly name = 'TransactionClosedError';
  constructor() {
    super(TRANSACTION_CLOSED);
  }
}

/**
 * PACKAGE-INTERNAL (not exported from `./runtime`). Run `operation` as part of `tx`'s transaction.
 * Refused with `TransactionClosedError` (as a rejection; `operation` is not called) unless `tx` is
 * an open `withAppRw` transaction whose `work` is still running. Once joined, `withAppRw` does not
 * COMMIT or ROLLBACK until the operation has settled, so its statements run INSIDE the transaction
 * even if the caller never awaited it (OD-303); and if it rejects, the transaction rolls back and
 * `withAppRw` rejects with that error. The returned promise is marked handled here, so an
 * un-awaited rejection surfaces through `withAppRw`, not as an unhandled rejection.
 */
export function joinTx<T>(tx: Tx, operation: () => Promise<T>): Promise<T> {
  const state = txStates.get(tx);
  if (state === undefined || state.phase !== 'open') {
    return Promise.reject(new TransactionClosedError());
  }
  let joined: Promise<T>;
  try {
    joined = operation();
  } catch (thrown) {
    joined = Promise.reject(thrown as Error);
  }
  state.joined.push(joined);
  joined.then(undefined, () => undefined);
  return joined;
}

/**
 * PACKAGE-INTERNAL. Throws `TransactionClosedError` unless a statement on `tx` would still run
 * inside its transaction (phase `open` or `settling`). The enqueue calls it at the moment each
 * statement is issued, not only when `enqueue` is called.
 */
export function assertLiveTx(tx: Tx): void {
  const phase = txStates.get(tx)?.phase;
  if (phase !== 'open' && phase !== 'settling') throw new TransactionClosedError();
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

/**
 * `withActor`'s one extra statement: the three GUCs, transaction-local (`is_local = true`, i.e.
 * `SET LOCAL`), values as bind parameters $1 $2 $3 in `ACTOR_GUCS` order.
 */
export const SET_ACTOR_SQL =
  `SELECT set_config('${ACTOR_GUCS.actorId}', $1, true), ` +
  `set_config('${ACTOR_GUCS.actorRole}', $2, true), ` +
  `set_config('${ACTOR_GUCS.breakGlass}', $3, true)`;

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
   * One transaction as `app_rw`: BEGIN, SET LOCAL ROLE app_rw, `work`, then — after every
   * operation joined to the `Tx` (`joinTx`, i.e. every enqueue) has settled — COMMIT, or ROLLBACK
   * and rethrow when `work` threw or a joined operation rejected (`work`'s error wins).
   * Rejects `DatabaseShutDownError` once `onApplicationShutdown` has run.
   *
   * Sets no actor. A table under FORCE row-level security (T-252's `sitter_credential`) shows such
   * a transaction 0 rows and refuses its writes: use `withActor` for those.
   */
  async withAppRw<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#transaction(undefined, work);
  }

  /**
   * One transaction as `app_rw` ACTING FOR `actor` (T-254; SD 3906, SD 1240). Exactly
   * `withAppRw`'s statements, plus ONE statement after `SET LOCAL ROLE app_rw` and before `work`:
   *
   *   SELECT set_config('app.actor_id', $1, true), set_config('app.actor_role', $2, true),
   *          set_config('app.break_glass', $3, true)
   *
   * `set_config(…, true)` is `SET LOCAL` (PostgreSQL: "is_local … only apply during the current
   * transaction"), with the values as bind parameters rather than spliced into SQL. It is never the
   * session form (`SET` / `is_local = false`): on a pooled connection that would carry the actor
   * into the next transaction (SA-10, SD 4604). After COMMIT or ROLLBACK the next transaction on the
   * connection reads the three as `''`, not NULL (measured: `test/actor-context.spec.ts`).
   *
   * Values: person → (account id, policy role, …); system → (job name, `'system'`, …); the third is
   * `'on'` ONLY when `options` is exactly `{ breakGlass: true }`, else `'off'`.
   *
   * REFUSED BEFORE ANY SQL: the actor and `options` are re-validated first (`ActorRefusedError`),
   * before the shut-down check, the URL check, and any pool or connection. There is no overload
   * without an actor, and an object literal is not an `Actor` (the brand), so neither compiles
   * (`type-tests/actor-refusals.ts`).
   *
   * BOUND (CUT-T-060 R-2.5): any code holding the `Tx`, and any `app_rw` session, can call
   * `set_config` itself and change all three, `app.break_glass` included. This is SA 835's backstop
   * against an application-layer bug, not a control against hostile application code.
   */
  async withActor<T>(
    actor: Actor,
    work: (tx: Tx) => Promise<T>,
    options?: ActorTxOptions,
  ): Promise<T> {
    const settings = actorSettings(actor, options);
    return this.#transaction(async (client) => {
      await client.query(SET_ACTOR_SQL, [
        settings.actorId,
        settings.actorRole,
        settings.breakGlass,
      ]);
    }, work);
  }

  async #transaction<T>(
    prelude: ((client: PoolClient) => Promise<void>) | undefined,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const client: PoolClient = await this.#pool_().connect();
    let broken = false;
    let state: TxState | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_rw');
      if (prelude !== undefined) await prelude(client);
      // The one place a `Tx` is minted (the brand is a type; see `Tx`).
      const tx = drizzle({ client }) as unknown as Tx;
      state = { phase: 'open', joined: [] };
      txStates.set(tx, state);
      let outcome:
        { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
      try {
        outcome = { ok: true, value: await work(tx) };
      } catch (thrown) {
        outcome = { ok: false, error: thrown };
      }
      // No new operation may join from here; those already joined finish INSIDE the transaction.
      state.phase = 'settling';
      const settled = await Promise.allSettled(state.joined);
      state.phase = 'closed';
      if (!outcome.ok) throw outcome.error;
      const refused = settled.find((s) => s.status === 'rejected');
      if (refused !== undefined) throw refused.reason;
      await client.query('COMMIT');
      return outcome.value;
    } catch (thrown) {
      if (state !== undefined) state.phase = 'closed';
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

/** A `Database` bound to one system actor: `withActor` without the actor argument. */
export interface SystemActorDatabase {
  readonly actor: SystemActor;
  withActor<T>(work: (tx: Tx) => Promise<T>, options?: ActorTxOptions): Promise<T>;
}

/**
 * THE WORKER'S BINDING (T-254). A worker has no session and no service JWT: every transaction it
 * runs acts as the system actor named after its job (SD 1240). Bind once, where the handler is
 * built, with the queue name as the job identity (`bindSystemActor(db, QUEUE)`); a refused name
 * throws `ActorRefusedError` there, at boot, not on the first job. A job payload is never an
 * identity source.
 */
export function bindSystemActor(db: Database, job: string): SystemActorDatabase {
  const actor = systemActor(job);
  return Object.freeze({
    actor,
    withActor: <T>(work: (tx: Tx) => Promise<T>, options?: ActorTxOptions): Promise<T> =>
      db.withActor(actor, work, options),
  });
}
