/**
 * Type declarations for the members of `pg` 8.23.0 that `apps/core` calls. This is NOT `@types/pg`.
 *
 * WHY THIS FILE EXISTS (decisions.md OD-121, OD-123; docs/adr/0002 § OD-121). While `@types/pg`
 * is declared anywhere in the workspace, pnpm resolves it as `drizzle-orm`'s optional peer and
 * links it, with its dependency `@types/node`, into `core`'s production install. T-154's image
 * guard refuses both. Declaring the two type packages as runtime `dependencies` would ship them,
 * and T-154 § contract §3 says not to declare a devtool there. So `apps/core` declares no
 * `@types/pg`, and types the members it uses here.
 *
 * WHAT IT COVERS: exactly what `src/identity/database.ts` and the tests under `test/` call.
 *   - `new Pool({ connectionString, application_name?, max? })`;
 *   - `Pool#connect`, `Pool#query`, `Pool#on('error')`, `Pool#end`;
 *   - `PoolClient#query`, `PoolClient#release`;
 *   - `QueryResult#rows`.
 * It describes no other part of pg's API. Every member is called at run time by
 * `test/identity.inprocess.test.ts` and the container suite, so a member declared wrongly still
 * compiles, and fails there instead.
 *
 * WHAT IT DOES NOT CHECK. `skipLibCheck` (tsconfig.base.json) skips every declaration file,
 * this one included. `drizzle-orm/node-postgres`'s declarations import their `pg` types from this
 * module, and where they name a member it lacks, they degrade silently instead of erroring.
 */
declare module 'pg' {
  export interface QueryResult<R> {
    readonly rows: R[];
  }

  export interface PoolConfig {
    readonly connectionString?: string;
    readonly application_name?: string;
    readonly max?: number;
  }

  export interface PoolClient {
    query<R = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    release(destroy?: boolean): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    query<R = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    on(event: 'error', listener: (error: Error) => void): this;
    end(): Promise<void>;
  }

  const pg: { readonly Pool: typeof Pool };
  export default pg;
}
