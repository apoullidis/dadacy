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
 *   onApplicationShutdown  THE DRAIN: no new fetch; in-flight handlers get up to STOP_TIMEOUT_MS;
 *                          then the pool is closed. src/main.ts calls `app.close()` on the
 *                          first SIGTERM/SIGINT (and prints the signal line), which is what runs this hook, and
 *                          decides the exit.
 *
 * WHY THE POOL IS CLOSED HERE and not in a hook of its own: Nest runs the `onApplicationShutdown`
 * hooks of one module's providers concurrently (`Promise.all`, @nestjs/core
 * hooks/on-app-shutdown.hook.js), so a separate "close the pool" hook could close it under a
 * handler still draining. The pool is closed after pg-boss's stop has returned.
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
  /** handlers still running when pg-boss's stop returned (pg-boss failed them back: failWip) */
  readonly stillRunning: number;
}

export class BossHost implements OnModuleInit, OnApplicationShutdown {
  readonly #settings: ConnectionSettings;
  readonly #pool: Pool;
  readonly #log: WorkerLog;
  readonly #inFlight: InFlight = { count: 0 };
  readonly #queues: string[] = [];
  #boss: PgBoss | undefined;
  #stop: StopReport | undefined;

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

  /** Set when the drain has run. */
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
    instance.on('error', (thrown) => this.#log(`pg-boss error (${describe(thrown)})`));
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

  async onApplicationShutdown(): Promise<void> {
    if (this.#boss === undefined) {
      await this.#pool.end();
      this.#stop = { stillRunning: 0 };
      return;
    }
    await this.#boss.stop({ graceful: true, close: true, timeout: STOP_TIMEOUT_MS });
    await this.#pool.end();
    this.#stop = { stillRunning: this.#inFlight.count };
  }
}
