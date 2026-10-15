/**
 * `review.json` — provenance as a build input (SD Revision Log D8).
 *
 * `T-044` implements `gate:safety-review-currency` over this file. What is
 * tested here is the part `T-044` must be able to rely on: the hash definition,
 * and that the register actually covers every `safety_critical` key in every
 * enabled locale rather than being a decorative stub.
 */
import { test } from 'vitest';
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

test('every safety_critical record is final with no review under OE-5, with a null reviewer and date (T-259)', () => {
  // Replaces T-040's "either signed off or explicitly waived (QA-F4)". Since
  // stakeholder ruling OE-5 (2026-10-11) no human reviews this copy, so the
  // per-record property is no longer "signed off, or waived": it is "final with
  // no review, by that ruling, and naming nobody". `pending_pipeline` is null
  // (below), so no record is covered by a waiver.
  const register = loadReviewRegister();
  const wrong: string[] = [];
  let n = 0;
  for (const locale of enabledLocales()) {
    for (const key of keysAtTier('safety_critical')) {
      const record: ReviewRecord | undefined = register.entries[locale.code]?.[key];
      n += 1;
      if (
        record === undefined ||
        record.status !== 'unreviewed_by_ruling' ||
        record.review_ruling !== 'OE-5' ||
        record.provenance !== 'ai_authored' ||
        record.reviewed_by !== null ||
        record.reviewed_at !== null
      ) {
        wrong.push(`${locale.code}/${key}`);
      }
    }
  }
  assert.ok(n > 0);
  assert.deepEqual(wrong, [], 'safety_critical records that are not final-unreviewed under OE-5');
});

test('the waiver may only cover safety_critical keys (QA-F4)', () => {
  const register = loadReviewRegister();
  const safety = new Set<string>(keysAtTier('safety_critical'));
  const stray = (register.pending_pipeline?.keys ?? []).filter((k) => !safety.has(k));
  assert.deepEqual(stray, [], 'the waiver covers keys that are not safety_critical');
});

test('pending_pipeline is null: the waiver waited for a human review that OE-5 ruled out (T-259)', () => {
  // Replaces three tests: the waiver's fixed `ANCHOR = 2026-12-05` (QA-F3), its
  // self-closing check (which, with all 24 records `ai_authored` since T-233,
  // checked nothing on the real tree — OE-5-cut §1a), and "a waived key must be
  // honestly recorded as unreviewed". There is no waiver to anchor. The bound on
  // a waiver RE-ADDED later is in the gate, not here: `WAIVER_NOT_AFTER`
  // (2026-12-05) and the WAIVER-* refusals, unchanged (T-258 LIVE §3).
  assert.equal(loadReviewRegister().pending_pipeline, null);
});
