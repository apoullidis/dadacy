/**
 * `BossHost` — pg-boss 12.26.4 as a NestJS provider (T-242, OE-79). One instance per process,
 * provided by `WorkerRuntimeModule` (src/runtime.module.ts) and injected into every queue handler.
 *
 * ITS LIFECYCLE IS NEST'S:
 *   onModuleInit           open a session as `app_rw` and preflight it (src/preflight.ts, SELECTs
 *                          only) — throw a WorkerRefusal on any finding, before pg-boss issues a
 *                          statement; print the boot line; start pg-boss with `migrate: false`
 *                          (src/config.ts). Every `onModuleInit` in the process runs before any
 *                          `onApplicationBootstrap`, so pg-boss is started before a handler asks
 *                          for it.
 *   (handlers)             each queue's handler provider calls `work()` from its own
 *                          `onApplicationBootstrap` (src/selftest.handler.ts is the pattern).
 *   drain()                THE DRAIN, called by src/main.ts on the first SIGTERM/SIGINT BEFORE
 *                          `app.close()`: no new fetch; in-flight handlers get up to
 *                          STOP_TIMEOUT_MS; pg-boss stops. It counts what went wrong after it
 *                          began (StopReport), so the verdict line cannot read as success over a
 *                          job that failed during shutdown.
 *   onApplicationShutdown  closes this pool, after `drain()` has returned.
 *
 * WHY THE DRAIN IS NOT A NEST HOOK (T-242 rework 1, QA-F1 / OD-293). `close()` in @nestjs/core
 * 11.2.3 (nest-application-context.js) runs every module's `onModuleDestroy`, then every
 * `beforeApplicationShutdown`, then `dispose()`, then every `onApplicationShutdown`; each pass
 * walks the modules in ascending distance from the root (`getModulesToTriggerHooksOn()` reversed),
 * awaiting one module before the next. This module is imported by every handler's module, so it
 * is the deepest, and a drain in any hook here runs AFTER the teardown of the services handlers
 * inject (a pool `end()`ed in `onModuleDestroy` or `onApplicationShutdown`),
 * and the in-flight job fails mid-drain. Measured: QA's `depteardown`/`deptdestroy`, red at
 * `d2c9720`. Which hook would be early enough depends on the module graph later tickets build
 * (Nest orders the passes by module distance), so the drain is not placed in one: it runs before
 * `close()` is called at all, and when `close()` starts pg-boss has already stopped.
 * apps/worker/tools/drain-check.sh holds the order (its check `O`) against the stand-in module's
 * real teardown (src/selftest-reporter.module.ts).
 *
 * If `close()` is reached without `drain()` (nothing in main.ts does that), the hook below stops
 * pg-boss itself and says it is late, rather than leave it running.
 */
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PgBoss } from 'pg-boss';
import type { WorkHandlerFor, WorkOptions } from 'pg-boss';
import {
  bossConfig,
  pgBossVersion,
  requiredSchemaVersion,
  RUNTIME_ROLE,
  STOP_TIMEOUT_MS,
  type ConnectionSettings,
} from './config.ts';
import { describe, type WorkerLog } from './log.ts';
import { preflight } from './preflight.ts';
import { WorkerRefusal } from './refusal.ts';

export interface InFlight {
  count: number;
}

export interface StopReport {
  /** handlers still running when pg-boss's stop returned (pg-boss failed them: failWip) */
  readonly stillRunning: number;
  /** handlers that rejected (their job failed) after drain() began */
  readonly handlerFailures: number;
  /** pg-boss `error` events after drain() began */
  readonly bossErrors: number;
  /** whether the stop ran in drain() — false when the shutdown hook had to stop pg-boss late */
  readonly beforeClose: boolean;
}

export class BossHost implements OnModuleInit, OnApplicationShutdown {
  readonly #settings: ConnectionSettings;
  readonly #pool: Pool;
  readonly #log: WorkerLog;
  readonly #inFlight: InFlight = { count: 0 };
  readonly #queues: string[] = [];
  #boss: PgBoss | undefined;
  #stop: StopReport | undefined;
  #draining = false;
  #handlerFailures = 0;
  #bossErrors = 0;

  constructor(settings: ConnectionSettings, pool: Pool, log: WorkerLog) {
    this.#settings = settings;
    this.#pool = pool;
    this.#log = log;
  }

  /** The started pg-boss. Throws before `onModuleInit` has finished: a handler must not race it. */
  get boss(): PgBoss {
    if (this.#boss === undefined) throw new Error('BossHost: pg-boss is not started');
    return this.#boss;
  }

  get inFlight(): number {
    return this.#inFlight.count;
  }

  /** The queues `work()` registered, in order — read by the ready line, not restated. */
  get queues(): readonly string[] {
    return this.#queues;
  }

  /** Set when pg-boss has been stopped. */
  get stopReport(): StopReport | undefined {
    return this.#stop;
  }

  async onModuleInit(): Promise<void> {
    const requiredVersion = requiredSchemaVersion();
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (thrown) {
      throw new WorkerRefusal(
        'database',
        `could not open a session as ${RUNTIME_ROLE} (${describe(thrown)})`,
      );
    }
    const found = await (async () => {
      try {
        return await preflight(client, requiredVersion);
      } finally {
        client.release();
      }
    })();
    // Every value on this line is READ — from the session, the catalogue and the config object
    // pg-boss is given — so a changed setting changes the line rather than leaving it to lie.
    const config = bossConfig(this.#settings);
    this.#log(
      `mode=real  pg-boss ${pgBossVersion()} against schema pgboss v${String(found.schemaVersion)}; ` +
        `login ${found.sessionUser} (superuser=${String(found.sessionIsSuperuser)}), running as ` +
        `${found.currentUser} (startup option ${JSON.stringify(this.#settings.options)}); ` +
        `migrate=${String(config.migrate)}`,
    );

    const instance = new PgBoss(config);
    instance.on('error', (thrown) => {
      if (this.#draining) this.#bossErrors += 1;
      this.#log(`pg-boss error (${describe(thrown)})`);
    });
    instance.on('warning', (warning) => this.#log(`pg-boss warning: ${warning.message}`));
    try {
      await instance.start();
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : '';
      if (
        message === 'pg-boss database requires migrations' ||
        message === 'pg-boss is not installed'
      ) {
        throw new WorkerRefusal('schema-version', `pg-boss refused the schema: ${message}`);
      }
      throw thrown;
    }
    this.#boss = instance;
  }

  /**
   * `boss.work()`, with the handler counted in flight for the drain's report. A queue's handler
   * provider calls this from its `onApplicationBootstrap`.
   */
  async work<ReqData, ResData = unknown, const O extends WorkOptions = WorkOptions>(
    queue: string,
    options: O,
    handler: WorkHandlerFor<O, ReqData, ResData>,
  ): Promise<string> {
    // pg-boss calls the handler with one argument (the batch, or one job under `perJobResults`);
    // the wrapper passes whatever it is given through unchanged and only counts.
    const inner = handler as (arg: never) => Promise<unknown>;
    const counted = async (arg: never): Promise<unknown> => {
      this.#inFlight.count += 1;
      try {
        return await inner(arg);
      } catch (thrown) {
        if (this.#draining) this.#handlerFailures += 1;
        throw thrown;
      } finally {
        this.#inFlight.count -= 1;
      }
    };
    const id = await this.boss.work<ReqData, ResData, O>(
      queue,
      options,
      counted as WorkHandlerFor<O, ReqData, ResData>,
    );
    this.#queues.push(queue);
    return id;
  }

  /**
   * Stop pg-boss gracefully: no new fetch, in-flight handlers get up to STOP_TIMEOUT_MS. Called by
   * src/main.ts BEFORE `app.close()`, so no other module has torn anything down yet. Idempotent.
   */
  async drain(): Promise<StopReport> {
    return this.#stopBoss(true);
  }

  async #stopBoss(beforeClose: boolean): Promise<StopReport> {
    if (this.#stop !== undefined) return this.#stop;
    this.#draining = true;
    await this.#boss?.stop({ graceful: true, close: true, timeout: STOP_TIMEOUT_MS });
    this.#stop = {
      stillRunning: this.#inFlight.count,
      handlerFailures: this.#handlerFailures,
      bossErrors: this.#bossErrors,
      beforeClose,
    };
    return this.#stop;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.#stop === undefined) {
      this.#log(
        'BossHost: the application context is closing and drain() has not run; stopping pg-boss ' +
          "now, AFTER other modules' teardown hooks",
      );
      await this.#stopBoss(false);
    }
    await this.#pool.end();
  }
}
