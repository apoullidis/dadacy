/**
 * The members of `pg` 8.23.0 that `apps/worker` calls and
 * `packages/core-modules/src/runtime/pg.d.ts` does not declare. This file only ADDS to that declaration (interface merging); it declares no class and
 * no default export, so the root `pnpm -w typecheck` program, which sees both files, has one
 * `Pool` and one `pg`. Why there is no `@types/pg`: decisions.md OD-121/OD-123 (core's file says it).
 *
 * WHAT IT ADDS, and where each is called at run time (so a wrong member still compiles and fails
 * there instead — `skipLibCheck` skips declaration files):
 *   (`PoolConfig.options` and `PoolConfig.connectionTimeoutMillis`, which src/config.ts passes, moved
 *   to the package's file in T-245, because the package's `Database` passes them too. pg sends
 *   `options` in the startup packet: pg/lib/connection-parameters.js, client.js.)
 *   - `PoolClient.on('notification')`: test/fixtures/db.ts (the suite's LISTEN on the selftest channel).
 */
declare module 'pg' {
  interface Notification {
    readonly channel: string;
    readonly payload?: string;
  }

  interface PoolClient {
    on(event: 'notification', listener: (message: Notification) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
}
