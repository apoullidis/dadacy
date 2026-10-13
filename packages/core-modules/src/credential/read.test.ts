/**
 * `CredentialSchemeCache` without a database (T-060; SD §PERF-2 line 4035): an injected loader and
 * clock. The DB-backed cache over the seeded schema is `test/credential-scheme.spec.ts`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CredentialSchemeCache,
  CredentialSchemeReadError,
  JURISDICTION_REFUSED,
  SCHEME_CACHE_TTL_MS,
  SCHEME_READ_REFUSED_LOG,
  type CredentialScheme,
} from './index.ts';

function harness(fail?: () => Error) {
  let t = 1_000_000;
  const calls: string[] = [];
  const lines: string[] = [];
  const cache = new CredentialSchemeCache(
    async (j) => {
      calls.push(j);
      await Promise.resolve();
      if (fail !== undefined) throw fail();
      return Object.freeze([{ id: calls.length } as unknown as CredentialScheme]);
    },
    (l) => lines.push(l),
    { now: () => t },
  );
  return { cache, calls, lines, advance: (ms: number) => (t += ms) };
}

test('the TTL is 60 seconds', () => {
  assert.equal(SCHEME_CACHE_TTL_MS, 60_000);
});

test('a second call inside 60 s is served from the cache; at 60 s it reads again', async () => {
  const h = harness();
  const a = await h.cache.forJurisdiction('CY');
  h.advance(59_999);
  const b = await h.cache.forJurisdiction('CY');
  assert.equal(a, b);
  assert.deepEqual(h.calls, ['CY']);
  h.advance(1);
  const c = await h.cache.forJurisdiction('CY');
  assert.notEqual(c, a);
  assert.deepEqual(h.calls, ['CY', 'CY']);
});

test('jurisdictions are cached separately', async () => {
  const h = harness();
  await h.cache.forJurisdiction('CY');
  await h.cache.forJurisdiction('GR');
  await h.cache.forJurisdiction('CY');
  assert.deepEqual(h.calls, ['CY', 'GR']);
});

test('concurrent misses share one read', async () => {
  const h = harness();
  const [a, b, c] = await Promise.all([
    h.cache.forJurisdiction('CY'),
    h.cache.forJurisdiction('CY'),
    h.cache.forJurisdiction('CY'),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.deepEqual(h.calls, ['CY']);
});

test('a failed read is not cached: each caller gets the error and the next call reads again', async () => {
  const h = harness(() => new CredentialSchemeReadError(['mandatory_rules']));
  await assert.rejects(h.cache.forJurisdiction('CY'), CredentialSchemeReadError);
  await assert.rejects(h.cache.forJurisdiction('CY'), CredentialSchemeReadError);
  assert.deepEqual(h.calls, ['CY', 'CY']);
  assert.deepEqual(h.lines, [
    `${SCHEME_READ_REFUSED_LOG} jurisdiction=CY fields=mandatory_rules`,
    `${SCHEME_READ_REFUSED_LOG} jurisdiction=CY fields=mandatory_rules`,
  ]);
});

test('a malformed jurisdiction is refused before any read, and is not echoed', async () => {
  const h = harness();
  for (const j of ['cy', 'CYP', '', 'C', 'ΚΥ', 'CY ', undefined as unknown as string]) {
    await assert.rejects(
      h.cache.forJurisdiction(j),
      (e: unknown) => e instanceof TypeError && e.message === JURISDICTION_REFUSED,
    );
  }
  assert.deepEqual(h.calls, []);
});

test('byId finds a scheme by id within the jurisdiction, and answers undefined otherwise', async () => {
  const h = harness();
  assert.equal((await h.cache.byId('CY', 1))?.id, 1);
  assert.equal(await h.cache.byId('CY', 2), undefined);
});
