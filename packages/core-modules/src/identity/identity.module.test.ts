/**
 * `IdentitySharedModule.forRoot` in a real Nest 11 application context, no database (T-246): in
 * both apps' import shapes, `AccountContacts` uses the APP's one `Database` — the binding factory
 * runs once, and shutting that `Database` down makes `AccountContacts` answer the shutdown
 * refusal, which a second `Database` would not. Nothing connects (no connection string).
 */
import 'reflect-metadata';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { accountId } from '@kinvara/domain-types';
import {
  Database,
  DATABASE_URL_REFUSED,
  DatabaseModule,
  DatabaseShutDownError,
} from '../runtime/index.ts';
import { AccountContacts, IdentitySharedModule } from './index.ts';

const ID = accountId('01K0T2460000000000000000AB', 'accountId');

function bound(calls: string[]): DynamicModule {
  return DatabaseModule.forRoot({
    useFactory: () => {
      calls.push('factory');
      return {
        source: { connectionString: undefined, application_name: 'kinvara-test' },
        log: () => undefined,
      };
    },
  });
}

async function sameDatabase(root: object, calls: string[]): Promise<void> {
  const app = await NestFactory.createApplicationContext(root as never, { logger: false });
  try {
    const contacts = app.get(AccountContacts, { strict: false });
    const db = app.get(Database, { strict: false });
    assert.ok(contacts instanceof AccountContacts);
    assert.deepEqual(calls, ['factory']);
    await assert.rejects(contacts.contactOf(ID), (e: unknown) => {
      assert.ok(e instanceof TypeError && e.message === DATABASE_URL_REFUSED, String(e));
      return true;
    });
    await db.onApplicationShutdown();
    await assert.rejects(contacts.contactOf(ID), (e: unknown) => {
      assert.ok(
        e instanceof DatabaseShutDownError,
        `expected the shutdown refusal, got ${String(e)}`,
      );
      return true;
    });
  } finally {
    await app.close();
  }
}

test("core's shape: the forRoot result imported by the app module and passed as database — one Database, the app's", async () => {
  const calls: string[] = [];
  const CORE_DATABASE = bound(calls);
  class AppIdentityModule {}
  Module({
    imports: [CORE_DATABASE, IdentitySharedModule.forRoot({ database: CORE_DATABASE })],
    exports: [CORE_DATABASE],
  })(AppIdentityModule);
  await sameDatabase(AppIdentityModule, calls);
});

test("the worker's shape: a static module re-exporting the binding, passed as database — one Database, the app's", async () => {
  const calls: string[] = [];
  const BOUND = bound(calls);
  class AppDatabaseModule {}
  Module({ imports: [BOUND], exports: [BOUND] })(AppDatabaseModule);
  class Handler {}
  Module({
    imports: [AppDatabaseModule, IdentitySharedModule.forRoot({ database: AppDatabaseModule })],
  })(Handler);
  await sameDatabase(Handler, calls);
});
