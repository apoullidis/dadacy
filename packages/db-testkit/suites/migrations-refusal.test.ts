/**
 * T-137 — when a migration does not apply, cluster ACQUISITION throws, and the
 * throw says which file and which psql exit. It must be distinguishable from a
 * crash (PROTOCOL §5.1: "did nothing", "refused" and "crashed" are three
 * different results).
 *
 * The scratch migration lives in a temporary directory that carries a copy of
 * every committed migration plus one more, numbered above the highest. Nothing
 * is written into `db/migrations` (T-136 § contract §9: use `--dir`).
 *
 * One acquire call site, as every suite has. The crash cases are judged on the
 * REAL run this acquisition produced, each changed in one way and the change
 * asserted to have landed before its verdict is read.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireMigratedCluster,
  assertCarriesEveryCommittedMigration,
  highestMigrationIn,
  judgeMigrateRun,
  MigrationsNotApplied,
  MIGRATIONS_DIR,
  REPO_ROOT,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';

const SUITE = 'migrations-refusal';
const COMMITTED_DIR = path.join(REPO_ROOT, MIGRATIONS_DIR);
const PSQL_SCRIPT_ERROR = 3;

let db: Cluster | undefined;
let thrown: unknown;
let scratch = '';
let brokenUp = '';
let brokenId = '';
let committedUps: string[] = [];

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvara-t137-scratch-'));
  for (const name of fs.readdirSync(COMMITTED_DIR)) {
    fs.copyFileSync(path.join(COMMITTED_DIR, name), path.join(scratch, name));
  }
  committedUps = fs
    .readdirSync(COMMITTED_DIR)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
  brokenId = String(Number(highestMigrationIn(COMMITTED_DIR)) + 1).padStart(4, '0');
  brokenUp = `${brokenId}_t137_scratch_broken.up.sql`;
  fs.writeFileSync(
    path.join(scratch, brokenUp),
    '-- @phase: expand\n' +
      '-- T-137 scratch migration: names a table that does not exist, so psql exits 3.\n' +
      'ALTER TABLE public.t137_no_such_table ADD COLUMN note text;\n',
  );
  fs.writeFileSync(
    path.join(scratch, `${brokenId}_t137_scratch_broken.down.sql`),
    '-- T-137 scratch migration down file.\nSELECT 1;\n',
  );
  try {
    db = await acquireMigratedCluster(SUITE, { dir: scratch });
  } catch (err) {
    thrown = err;
  }
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
  if (scratch !== '') fs.rmSync(scratch, { recursive: true, force: true });
});

function notApplied(): MigrationsNotApplied {
  assert.equal(
    db,
    undefined,
    'acquisition must not hand back a cluster when a migration did not apply',
  );
  assert.ok(
    thrown instanceof MigrationsNotApplied,
    `acquisition must throw MigrationsNotApplied, got: ${String(thrown)}`,
  );
  return thrown;
}

function realRun(): PsqlResult {
  const run = notApplied().run;
  assert.ok(run !== undefined, 'the error must carry the runner invocation');
  return run;
}

describe('a scratch migration that does not apply — acquisition throws, naming the file and the psql exit', () => {
  test('MigrationsNotApplied, kind FAIL, the scratch file, psql exit 3, db:migrate exit 1', () => {
    const e = notApplied();
    assert.equal(e.kind, 'FAIL', e.message);
    const v = e.verdict;
    assert.ok(v !== undefined && v.kind === 'FAIL', e.message);
    assert.equal(v.file, brokenUp);
    assert.equal(v.psqlExit, PSQL_SCRIPT_ERROR);
    assert.equal(realRun().code, 1);
    assert.ok(
      e.message.includes(brokenUp) && e.message.includes(`psql exit ${String(PSQL_SCRIPT_ERROR)}`),
      `the thrown message itself must name the file and the psql exit.\n${e.message}`,
    );
    assert.ok(
      e.message.includes('relation "public.t137_no_such_table" does not exist'),
      `the thrown message must carry psql's own error.\n${e.message}`,
    );
  });

  test('it stopped AT the scratch file, after every committed migration applied in order — not refused before running', () => {
    const out = realRun().output;
    // The runner pads the verb (`apply  <file>`); match on whitespace, not a count of spaces.
    const applyLine = (file: string, from: number): number => {
      const re = new RegExp(`\\bapply\\s+${file.replace(/[.]/g, '\\.')}\\b`, 'g');
      re.lastIndex = from;
      return re.exec(out)?.index ?? -1;
    };
    let at = 0;
    for (const up of committedUps) {
      const applyAt = applyLine(up, at);
      assert.ok(applyAt >= at, `expected "apply ${up}" after offset ${String(at)}.\n${out}`);
      const okAt = out.indexOf(`ok; record -> ${up.slice(0, 4)}`, applyAt);
      assert.ok(
        okAt > applyAt,
        `expected "ok; record -> ${up.slice(0, 4)}" after applying ${up}.\n${out}`,
      );
      at = okAt;
    }
    assert.ok(applyLine(brokenUp, at) > at, `the scratch file must run last.\n${out}`);
    assert.ok(
      !out.includes(`ok; record -> ${brokenId}`),
      `the scratch file must not be recorded.\n${out}`,
    );
  });
});

describe('distinguishable from a crash — the same real run, changed one way at a time, is judged CRASH', () => {
  test('CONTROL — the unchanged run is judged FAIL', () => {
    assert.equal(judgeMigrateRun(realRun()).kind, 'FAIL');
  });

  const BANNER_LINE = /^MIGRATE FAIL {2}.*$/m;
  const changes: readonly {
    readonly name: string;
    readonly change: (r: PsqlResult) => Pick<PsqlResult, 'code' | 'stdout' | 'stderr'>;
    readonly landed: (r: Pick<PsqlResult, 'code' | 'stdout' | 'stderr'>) => boolean;
  }[] = [
    {
      name: 'no banner, exit 1 kept — a runner that died before reporting exits 1 too',
      change: (r) => ({
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr.replace(BANNER_LINE, ''),
      }),
      landed: (m) => m.code === 1 && !/MIGRATE /.test(m.stdout + m.stderr),
    },
    {
      name: 'exit 70 with the FAIL banner',
      change: (r) => ({ ...r, code: 70 }),
      landed: (m) => m.code === 70 && BANNER_LINE.test(m.stderr),
    },
    {
      name: 'exit 0 with the FAIL banner',
      change: (r) => ({ ...r, code: 0 }),
      landed: (m) => m.code === 0 && BANNER_LINE.test(m.stderr),
    },
    {
      name: 'the banner printed twice',
      change: (r) => ({ ...r, stderr: `${r.stderr}\n${BANNER_LINE.exec(r.stderr)?.[0] ?? ''}\n` }),
      landed: (m) => (m.stderr.match(/^MIGRATE FAIL {2}/gm) ?? []).length === 2,
    },
    {
      name: 'a FAIL banner that names no file and no psql exit',
      change: (r) => ({
        ...r,
        stderr: r.stderr.replace(
          BANNER_LINE,
          'MIGRATE FAIL  every step exited 0, but the record reads 0003, not the target 0004',
        ),
      }),
      landed: (m) => /^MIGRATE FAIL {2}every step/m.test(m.stderr) && m.code === 1,
    },
    {
      name: 'the runner’s own CRASH banner at exit 70',
      change: (r) => ({
        ...r,
        code: 70,
        stderr: r.stderr.replace(BANNER_LINE, 'MIGRATE CRASH  Error: EACCES: permission denied'),
      }),
      landed: (m) =>
        m.code === 70 && /^MIGRATE CRASH {2}/m.test(m.stderr) && !BANNER_LINE.test(m.stderr),
    },
  ];
  for (const c of changes) {
    test(`CRASH, not FAIL — ${c.name}`, () => {
      const m = c.change(realRun());
      assert.ok(
        c.landed(m),
        `the change did not land, so its verdict would mean nothing:\n${m.stderr}`,
      );
      const v = judgeMigrateRun(m);
      assert.equal(v.kind, 'CRASH', `judged ${v.kind}`);
    });
  }
});

describe('the dir option can add a migration, never drop or alter a committed one', () => {
  test('CONTROL — the scratch directory carries every committed migration', () => {
    assert.deepEqual(
      assertCarriesEveryCommittedMigration(SUITE, scratch),
      fs.readdirSync(COMMITTED_DIR).sort(),
    );
  });

  test('a directory missing the highest committed migration is refused before any cluster starts', () => {
    const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvara-t137-partial-'));
    try {
      const dropped = committedUps[committedUps.length - 1] ?? '';
      for (const name of fs.readdirSync(COMMITTED_DIR)) {
        if (name !== dropped)
          fs.copyFileSync(path.join(COMMITTED_DIR, name), path.join(partial, name));
      }
      assert.ok(
        dropped !== '' && !fs.existsSync(path.join(partial, dropped)),
        'the drop must land',
      );
      assert.throws(
        () => assertCarriesEveryCommittedMigration(SUITE, partial),
        (e: unknown) =>
          e instanceof MigrationsNotApplied &&
          e.kind === 'INCOMPLETE_DIR' &&
          e.message.includes(`${dropped} is missing`),
      );
    } finally {
      fs.rmSync(partial, { recursive: true, force: true });
    }
  });

  test('a directory whose copy of a committed migration differs by one byte is refused', () => {
    const altered = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvara-t137-altered-'));
    try {
      for (const name of fs.readdirSync(COMMITTED_DIR)) {
        fs.copyFileSync(path.join(COMMITTED_DIR, name), path.join(altered, name));
      }
      const target = committedUps[0] ?? '';
      fs.appendFileSync(path.join(altered, target), '\n');
      assert.notDeepEqual(
        fs.readFileSync(path.join(altered, target)),
        fs.readFileSync(path.join(COMMITTED_DIR, target)),
        'the change must land',
      );
      assert.throws(
        () => assertCarriesEveryCommittedMigration(SUITE, altered),
        (e: unknown) =>
          e instanceof MigrationsNotApplied &&
          e.kind === 'INCOMPLETE_DIR' &&
          e.message.includes(`${target} differs from the committed file`),
      );
    } finally {
      fs.rmSync(altered, { recursive: true, force: true });
    }
  });
});
