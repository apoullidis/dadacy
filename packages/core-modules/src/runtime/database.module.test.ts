/**
 * `DatabaseModule.forRoot` in a real Nest 11 application context (no HTTP adapter, no database):
 * the app's factory receives what its `inject` list names from the modules it imports, the
 * `Database` it builds is the one every importer receives, and a token nobody provides is refused
 * at boot. The pool is lazy, so nothing here connects (./database.test.ts).
 */
import 'reflect-metadata';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Database, DatabaseModule, type DatabaseSource } from './index.ts';

const SETTINGS = Symbol('test.settings');
const UNPROVIDED = Symbol('test.unprovided');

test("the app's factory gets its injected settings, and every importer gets the same Database", async () => {
  const seen: unknown[] = [];
  const settings: DatabaseSource = {
    connectionString: undefined,
    application_name: 'kinvara-test',
    options: '-c role=app_rw',
  };
  class SettingsModule {}
  Module({ providers: [{ provide: SETTINGS, useValue: settings }], exports: [SETTINGS] })(
    SettingsModule,
  );
  const BOUND = DatabaseModule.forRoot({
    imports: [SettingsModule],
    inject: [SETTINGS],
    useFactory: (s: DatabaseSource) => {
      seen.push(s);
      return { source: s, log: () => undefined };
    },
  });
  class AppDatabaseModule {}
  Module({ imports: [BOUND], exports: [BOUND] })(AppDatabaseModule);
  const A = Symbol('A');
  const B = Symbol('B');
  class FeatureA {}
  Module({
    imports: [AppDatabaseModule],
    providers: [{ provide: A, useFactory: (db: Database) => db, inject: [Database] }],
    exports: [A],
  })(FeatureA);
  class FeatureB {}
  Module({
    imports: [AppDatabaseModule],
    providers: [{ provide: B, useFactory: (db: Database) => db, inject: [Database] }],
    exports: [B],
  })(FeatureB);
  class Root {}
  Module({ imports: [FeatureA, FeatureB] })(Root);

  const app = await NestFactory.createApplicationContext(Root, { logger: false });
  try {
    const a: unknown = app.get(A, { strict: false });
    const b: unknown = app.get(B, { strict: false });
    assert.ok(a instanceof Database);
    assert.equal(a, b);
    assert.deepEqual(seen, [settings]);
  } finally {
    await app.close();
  }
});

test('an inject token no imported module provides is refused at boot', async () => {
  class Root {}
  Module({
    imports: [
      DatabaseModule.forRoot({
        inject: [UNPROVIDED],
        useFactory: () => ({
          source: { connectionString: undefined, application_name: 'kinvara-test' },
          log: () => undefined,
        }),
      }),
    ],
  })(Root);
  await assert.rejects(
    NestFactory.createApplicationContext(Root, { logger: false, abortOnError: false }),
    /can't resolve dependencies/,
  );
});
