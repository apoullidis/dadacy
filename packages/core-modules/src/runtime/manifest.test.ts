/**
 * The package's manifest (T-245, EV-30). Two properties a later edit could break without any
 * other unit test noticing:
 *   - no `@nestjs/platform-*` in any dependency section: it would put an HTTP adapter into the
 *     worker image (T-242 § contract §1 row 4). The image itself is checked in the evidence
 *     (`find … -path '*@nestjs/platform-*'`); this is the toolbox-side refusal;
 *   - the `exports` map names subpaths only, each ending at a module's `index.ts`, so no deep
 *     path (`@kinvara/core-modules/src/…`) resolves.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

test('no dependency section names an @nestjs/platform-* package', () => {
  const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .map((section) => manifest[section])
    .flatMap((deps) => (typeof deps === 'object' && deps !== null ? Object.keys(deps) : []));
  assert.ok(names.includes('@nestjs/common'), 'the reader found the dependencies');
  assert.deepEqual(
    names.filter((n) => n.startsWith('@nestjs/platform-')),
    [],
  );
});

test('the exports map is subpaths to module index files only', () => {
  const exportsMap = manifest['exports'];
  assert.ok(typeof exportsMap === 'object' && exportsMap !== null);
  const entries = Object.entries(exportsMap);
  assert.ok(entries.length > 0);
  for (const [key, target] of entries) {
    assert.match(key, /^\.\/[a-z-]+$/, `export key ${key}`);
    assert.equal(target, `./src/${key.slice(2)}/index.ts`, `export ${key}`);
  }
});
