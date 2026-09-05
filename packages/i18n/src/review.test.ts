/**
 * `review.json` — provenance as a build input (SD Revision Log D8).
 *
 * `T-044` implements `gate:safety-review-currency` over this file. What is
 * tested here is the part `T-044` must be able to rely on: the hash definition,
 * and that the register actually covers every `safety_critical` key in every
 * enabled locale rather than being a decorative stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, loadReviewRegister, catalogueSource } from './review.ts';
import type { ReviewRecord } from './review.ts';
import { keysAtTier } from './tiers.ts';
import { enabledLocales } from './registry.ts';

test('contentHash matches an independently-derived SHA-256', () => {
  // Expected values computed outside this codebase, with python3 on the host:
  //   hashlib.sha256(unicodedata.normalize('NFC', s).encode()).hexdigest()
  // A hash function checked only against itself proves nothing; `T-044`'s gate
  // and `T-049`'s pipeline both depend on this exact definition.
  assert.equal(
    contentHash('Hold to send an SOS. An operator will call you.'),
    'sha256:2779e508d44880d7bb96b5a86d53d787df9a323a587b4a5f81635cdcf15363e4',
  );
  assert.equal(
    contentHash('\u0395\u03c0\u03b1\u03bb\u03b7\u03b8\u03b5\u03c5\u03bc\u03ad\u03bd\u03b7'),
    'sha256:aebae6db1358686e1ff4d2aa9720419561408116c5e488954cf36c772362d0ed',
  );
  assert.match(contentHash('x'), /^sha256:[0-9a-f]{64}$/);
});

test('NFC normalisation is load-bearing, not decoration', () => {
  // Greek tonos and the Cyrillic short-i breve both have composed and
  // decomposed forms. A translation tool that emits NFD would otherwise appear
  // to have changed every string it touched, and would fail a review that is in
  // fact current.
  const greekComposed = '\u0395\u03c0\u03b1\u03bb\u03b7\u03b8\u03b5\u03c5\u03bc\u03ad\u03bd\u03b7'; // ...μένη, U+03AD
  const greekDecomposed =
    '\u0395\u03c0\u03b1\u03bb\u03b7\u03b8\u03b5\u03c5\u03bc\u03b5\u0301\u03bd\u03b7'; // ...με + U+0301 + νη
  assert.notEqual(greekComposed, greekDecomposed, 'the two forms must differ as strings');
  assert.equal(contentHash(greekComposed), contentHash(greekDecomposed));

  const cyrillicComposed = '\u043c\u043e\u0439'; // мой, U+0439
  const cyrillicDecomposed = '\u043c\u043e\u0438\u0306'; // мо + и + U+0306
  assert.notEqual(cyrillicComposed, cyrillicDecomposed);
  assert.equal(contentHash(cyrillicComposed), contentHash(cyrillicDecomposed));
});

test('a changed safety string un-signs its own review record', () => {
  const before = contentHash('Κρατήστε πατημένο για αποστολή SOS.');
  const after = contentHash('Κρατήστε πατημένο για αποστολή SOS!');
  assert.notEqual(before, after);
});

test('the register covers every safety_critical key in every enabled locale', () => {
  const register = loadReviewRegister();
  const keys = keysAtTier('safety_critical');
  assert.ok(keys.length > 0);
  for (const locale of enabledLocales()) {
    const perLocale: Readonly<Record<string, ReviewRecord>> | undefined =
      register.entries[locale.code];
    assert.ok(perLocale !== undefined, `review.json has no entries for '${locale.code}'`);
    for (const key of keys) {
      const record: ReviewRecord | undefined = perLocale[key];
      assert.ok(record !== undefined, `review.json is missing ${locale.code}/${key}`);
      const source: string | undefined = catalogueSource(locale.code, key);
      assert.ok(source !== undefined, `catalogue is missing ${locale.code}/${key}`);
      assert.equal(
        record.content_hash,
        contentHash(source),
        `${locale.code}/${key}: recorded hash does not match the catalogue source`,
      );
    }
  }
});

test('the safety copy is honestly recorded as unreviewed placeholder', () => {
  // This test asserts the CURRENT, correct state and will be deleted by T-049
  // when real reviewed copy lands. It exists so that "placeholder" cannot
  // quietly become "shipped" without a test changing.
  const register = loadReviewRegister();
  for (const locale of enabledLocales()) {
    for (const key of keysAtTier('safety_critical')) {
      const record = register.entries[locale.code]?.[key];
      assert.equal(record?.status, 'pending_review', `${locale.code}/${key}`);
      assert.equal(record?.provenance, 'placeholder');
      assert.equal(record?.reviewed_by, null);
    }
  }
});

test('the pending-pipeline waiver is dated, owned, and expires', () => {
  const register = loadReviewRegister();
  const waiver = register.pending_pipeline;
  assert.ok(waiver !== null, 'placeholder safety copy must be covered by an explicit waiver');
  assert.equal(waiver.ticket, 'T-049');
  const opened = Date.parse(waiver.opened_at);
  const expected = Date.parse(waiver.expected_by);
  assert.ok(Number.isFinite(opened) && Number.isFinite(expected));
  const weeks = (expected - opened) / (7 * 24 * 3600 * 1000);
  assert.ok(
    weeks >= 5.5 && weeks <= 6.5,
    `expected the six-week lead time, got ${weeks.toFixed(1)} weeks`,
  );
  assert.deepEqual([...waiver.keys].sort(), [...keysAtTier('safety_critical')].sort());
});
