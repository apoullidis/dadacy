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

test('every safety_critical record is either signed off or explicitly waived (QA-F4)', () => {
  // The direction that matters, and the one the earlier `deepEqual` had
  // backwards. Asserting `waiver.keys === keysAtTier('safety_critical')` turned
  // red the moment ANY ticket added a safety key, and the cheapest way back to
  // green was to append that key to a waiver it was never opened for. It also
  // made partial delivery by T-049 impossible: signing off three keys of eight
  // would have broken the suite.
  //
  // The property is per record, not per list: for every safety_critical key in
  // every enabled locale, the record is either genuinely signed off, or its key
  // is covered by the waiver. Nothing may be neither.
  const register = loadReviewRegister();
  const waived = new Set(register.pending_pipeline?.keys ?? []);
  const unaccounted: string[] = [];
  for (const locale of enabledLocales()) {
    for (const key of keysAtTier('safety_critical')) {
      const record: ReviewRecord | undefined = register.entries[locale.code]?.[key];
      const signedOff =
        record !== undefined &&
        record.status === 'signed_off' &&
        record.provenance !== 'placeholder' &&
        record.reviewed_by !== null &&
        record.reviewed_at !== null;
      if (!signedOff && !waived.has(key)) unaccounted.push(`${locale.code}/${key}`);
    }
  }
  assert.deepEqual(
    unaccounted,
    [],
    'safety_critical copy that is neither DSL-signed-off nor covered by the pending-pipeline waiver',
  );
});

test('the waiver may only cover safety_critical keys (QA-F4)', () => {
  const register = loadReviewRegister();
  const safety = new Set<string>(keysAtTier('safety_critical'));
  const stray = (register.pending_pipeline?.keys ?? []).filter((k) => !safety.has(k));
  assert.deepEqual(stray, [], 'the waiver covers keys that are not safety_critical');
});

test('the pending-pipeline waiver is anchored to a fixed date, not to its own interval (QA-F3)', () => {
  // The earlier assertion checked the INTERVAL between `opened_at` and
  // `expected_by`, both read from the same file it was policing — so moving both
  // dates forward renewed the waiver indefinitely and stayed green. A check
  // derived from the same source as the thing it checks can only ever confirm it
  // (PROTOCOL §5.1).
  //
  // The anchor is written HERE, as a literal, and is not read from review.json.
  // T-040 opened this waiver on 2026-09-05 against SD §DH-5's six-week external
  // lead time. Extending it past that date is a schedule decision that belongs to
  // the orchestrator (BOARD RK-2), and it must cost an edit to this line.
  //
  // RE-ANCHORED ONCE, on 2026-09-05, and moved TOGETHER with
  // `pending_pipeline.expected_by` — that is the whole discipline, and the guard
  // above must survive the change rather than be worked around by it. T-049
  // measured that 2026-09-05 → 2026-10-17 was exactly the 42-day external lead
  // time, so the original date was never a forecast: it was the spec's six weeks
  // written down on the day the register was created, with zero slack on arrival
  // (decisions.md OD-15, escalated as OE-5). Stakeholder decision: re-anchor
  // honestly to a DECISION REVIEW DATE rather than let it expire into a build
  // failure whose cheapest repair is deleting the waiver.
  const ANCHOR = Date.parse('2026-12-05T23:59:59Z');
  const register = loadReviewRegister();
  const waiver = register.pending_pipeline;
  assert.ok(waiver !== null, 'placeholder safety copy must be covered by an explicit waiver');
  assert.equal(waiver.ticket, 'T-049');

  const expected = Date.parse(`${waiver.expected_by}T23:59:59Z`);
  assert.ok(Number.isFinite(expected), `expected_by is not a date: ${waiver.expected_by}`);
  assert.ok(
    expected <= ANCHOR,
    `the waiver expires ${waiver.expected_by}, past the 2026-12-05 anchor this test pins. ` +
      'Renewing the safety-copy waiver is an orchestrator decision (RK-2), not a file edit.',
  );
  assert.ok(Date.parse(waiver.opened_at) < expected, 'opened_at must precede expected_by');
});

test('the waiver self-closes: once it expires, no placeholder may remain (QA-F3)', () => {
  // What "self-closing" actually means, asserted rather than described. Before
  // the date this passes silently; after it, the suite goes red on the real
  // property — placeholder safety copy still in the tree — rather than on the
  // date itself.
  const register = loadReviewRegister();
  const waiver = register.pending_pipeline;
  if (waiver === null) return;
  if (Date.now() <= Date.parse(`${waiver.expected_by}T23:59:59Z`)) return;

  const placeholders: string[] = [];
  for (const locale of enabledLocales()) {
    for (const key of keysAtTier('safety_critical')) {
      if (register.entries[locale.code]?.[key]?.provenance === 'placeholder') {
        placeholders.push(`${locale.code}/${key}`);
      }
    }
  }
  assert.deepEqual(
    placeholders,
    [],
    `the T-049 safety-copy waiver expired on ${waiver.expected_by} and this copy is still placeholder. ` +
      'It must not ship. Escalate to the orchestrator (BOARD RK-2).',
  );
});

test('a waived key must be honestly recorded as unreviewed placeholder', () => {
  // Scoped to the keys the waiver still covers, so it EMPTIES ITSELF as T-049
  // delivers instead of having to be deleted. The earlier version asserted the
  // whole safety set, which meant signing off one key of eight turned it red and
  // the cheapest green was to delete the test — pressure in exactly the wrong
  // direction on the one file recording that this copy is not reviewed.
  //
  // The invariant is the honest one: a waiver exists FOR unreviewed copy, so
  // anything inside it must still say so. Copy that is signed off leaves the
  // waiver; copy that is in the waiver has not been reviewed and may not claim
  // to have been.
  const register = loadReviewRegister();
  const waived = register.pending_pipeline?.keys ?? [];
  for (const locale of enabledLocales()) {
    for (const key of waived) {
      const record: ReviewRecord | undefined = register.entries[locale.code]?.[key];
      assert.ok(record !== undefined, `waived key ${locale.code}/${key} has no record at all`);
      assert.equal(record.status, 'pending_review', `${locale.code}/${key}`);
      assert.equal(record.provenance, 'placeholder', `${locale.code}/${key}`);
      assert.equal(record.reviewed_by, null, `${locale.code}/${key}`);
      assert.equal(record.reviewed_at, null, `${locale.code}/${key}`);
    }
  }
});
