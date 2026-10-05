/**
 * The members of `pg` 8.23.0 that `apps/worker` calls and `apps/core/src/pg.d.ts` does not
 * declare. This file only ADDS to that declaration (interface merging); it declares no class and
 * no default export, so the root `pnpm -w typecheck` program, which sees both files, has one
 * `Pool` and one `pg`. Why there is no `@types/pg`: decisions.md OD-121/OD-123 (core's file says it).
 *
 * WHAT IT ADDS, and where each is called at run time (so a wrong member still compiles and fails
 * there instead — `skipLibCheck` skips declaration files):
 *   - `PoolConfig.options`: libpq's startup `options` (`-c role=app_rw`), src/config.ts; pg passes
 *     it in the startup packet (pg/lib/connection-parameters.js, client.js).
 *   - `PoolConfig.connectionTimeoutMillis`: src/config.ts.
 *   - `PoolClient.on('notification')`: test/fixtures/listen.ts (LISTEN).
 */
declare module 'pg' {
  interface PoolConfig {
    readonly options?: string;
    readonly connectionTimeoutMillis?: number;
  }

  interface Notification {
    readonly channel: string;
    readonly payload?: string;
  }

  interface PoolClient {
    on(event: 'notification', listener: (message: Notification) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
}
