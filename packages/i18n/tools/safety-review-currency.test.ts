/**
 * `gate:safety-review-currency` — T-044, attacked rather than observed passing.
 *
 * PROTOCOL §5.1: "Running your gate proves it executes. ATTACKING it proves
 * what it covers." Every case below builds a package root in a temporary
 * directory, PLANTS one defect, ASSERTS THE PLANT LANDED by reading the file
 * back, runs the real gate script as a subprocess, and judges it on three
 * readings a gate that did nothing could not all produce:
 *
 *   1. the exit status;
 *   2. exactly one `GATE PASS` / `GATE FAIL` banner — so a crash is a third
 *      outcome and never counts as a refusal (PROTOCOL §5.1, OD-27);
 *   3. the expected reason substring.
 *
 * EVERY CONJUNCT OF THE RULE GETS ITS OWN CASE. `T-040` § contract §6 states
 * the rule as a conjunction — record exists AND hash matches AND status is
 * `signed_off` AND provenance is not `placeholder` AND `reviewed_by` AND
 * `reviewed_at` — and a conjunction with one covering test is half
 * falsifiable. The baseline for those six is DELIVERED: a fixture whose 24
 * records are coherently signed off with correct hashes and NO waiver, which
 * must PASS. Each refusal case then breaks exactly one conjunct of it.
 *
 * THAT BASELINE IS ALSO THE ANSWER TO "would an always-failing gate pass these
 * cases?" — it would not: `a delivered register with no waiver passes` and
 * `the committed tree passes` are both PASS cases, and the second is the real
 * tree.
 *
 * WHAT IS NOT COVERED HERE, and is therefore in
 * `tools/safety-review-currency-negatives.ts` and the evidence file instead:
 * readings B and C — the committed `compiled/` artefact and the pins — which
 * are about THIS package's tracked files and cannot be planted in a temporary
 * root. Same status and same reason as `T-042`'s
 * `tools/locale-completeness-negatives.ts` (OD-57).
 *
 * `T-132` § Published contract (rework 2) §2's convention holds in this file:
 * every title is a string literal and every `test(` starts its own line.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { keysAtTier, enabledLocales, TIER_POLICY } from '../src/index.ts';
import type { Tier } from '../src/types.ts';
import { contentHash, catalogueSource } from '../src/review.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PACKAGE_ROOT, 'tools', 'safety-review-currency.ts');

/** A `safety_critical` key that exists in all three locales today. */
const SAFETY_KEY = 'session.checkins_missed';
/** Its catalogue file, relative to a root. */
const SAFETY_KEY_FILE = join('catalogues', 'ru', 'session.json');

interface GateRun {
  readonly code: number;
  readonly out: string;
  readonly banner: 'PASS' | 'FAIL' | 'NONE' | 'BOTH';
}

function runGate(args: readonly string[]): GateRun {
  const r = spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const pass = /^GATE PASS {2}gate:safety-review-currency/m.test(out);
  const fail = /^GATE FAIL {2}gate:safety-review-currency/m.test(out);
  let banner: GateRun['banner'] = 'NONE';
  if (pass && fail) banner = 'BOTH';
  else if (pass) banner = 'PASS';
  else if (fail) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

/**
 * A package root holding exactly what reading A needs. `compiled/` is
 * deliberately NOT copied — its modules import `../../src/runtime.ts` and
 * `intl-messageformat`, neither of which resolves from a temporary directory,
 * which is also why `--root` runs reading A alone.
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 't044-'));
  for (const entry of ['locale-registry.json', 'tiers.json', 'review.json']) {
    cpSync(join(PACKAGE_ROOT, entry), join(root, entry));
  }
  cpSync(join(PACKAGE_ROOT, 'catalogues'), join(root, 'catalogues'), { recursive: true });
  return root;
}

function readJson(root: string, rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, unknown>;
}

function writeJson(root: string, rel: string, value: unknown): void {
  writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The keys this gate must examine, from the package's own exports — never from the gate's output. */
function reviewTieredKeys(): readonly string[] {
  return (Object.keys(TIER_POLICY) as Tier[])
    .filter((t) => TIER_POLICY[t].requiresSafetyReview)
    .flatMap((t) => [...keysAtTier(t)])
    .sort();
}

/**
 * Rewrite a root's `review.json` as a COMPLETE, COHERENT DELIVERY: every key,
 * every locale, signed off, hashes taken over the fixture's own catalogue
 * source, and `pending_pipeline: null`. This is the state `T-049`'s pipeline
 * is supposed to reach, and it is the baseline each refusal case breaks once.
 *
 * It invents nothing in the real register: it is written into a temporary
 * directory that is deleted at the end of the case.
 */
function deliver(root: string): void {
  const register = readJson(root, 'review.json');
  const entries: Record<string, Record<string, unknown>> = {};
  for (const locale of enabledLocales().map((d) => d.code)) {
    const perLocale: Record<string, unknown> = {};
    for (const key of reviewTieredKeys()) {
      const source = catalogueSource(locale, key, root);
      assert.ok(source !== undefined, `fixture has no source for ${key} in ${locale}`);
      perLocale[key] = {
        content_hash: contentHash(source),
        provenance: locale === 'ru' ? 'translated_professional' : 'authored',
        status: 'signed_off',
        authored_by: 'FIXTURE AUTHOR, not a real person',
        reviewed_by: 'FIXTURE REVIEWER (DSL), not a real person',
        reviewed_at: '2026-09-19T09:00:00Z',
        note: 'temporary-directory fixture for tools/safety-review-currency.test.ts',
      };
    }
    entries[locale] = perLocale;
  }
  register['entries'] = entries;
  register['pending_pipeline'] = null;
  writeJson(root, 'review.json', register);
}

/** Mutate one record of a delivered fixture. */
function editRecord(
  root: string,
  locale: string,
  key: string,
  patch: Record<string, unknown>,
): void {
  const register = readJson(root, 'review.json');
  const entries = register['entries'] as Record<string, Record<string, Record<string, unknown>>>;
  const record = entries[locale]?.[key];
  assert.ok(record !== undefined, `no record for ${key} in ${locale}`);
  entries[locale] = { ...entries[locale], [key]: { ...record, ...patch } };
  writeJson(root, 'review.json', register);
}

/** Mutate the waiver of a fixture that still carries one. */
function editWaiver(root: string, patch: Record<string, unknown>): void {
  const register = readJson(root, 'review.json');
  const waiver = register['pending_pipeline'] as Record<string, unknown>;
  register['pending_pipeline'] = { ...waiver, ...patch };
  writeJson(root, 'review.json', register);
}

/**
 * Run one case. `plant` mutates the root and `landed` must then return true —
 * a mutation that did not land would otherwise let a case report a verdict
 * about an unmodified tree (PROTOCOL §5.1, the `T-039` harness defect).
 */
function attack(
  plant: (root: string) => void,
  landed: (root: string) => boolean,
  expect: 'PASS' | 'FAIL',
  reasons: readonly string[],
): void {
  const root = makeRoot();
  try {
    plant(root);
    assert.equal(landed(root), true, 'the mutation did not land; this case would judge nothing');
    const run = runGate(['--root', root]);
    assert.equal(run.banner, expect, `banner was ${run.banner}, expected ${expect}\n${run.out}`);
    if (expect === 'PASS') assert.equal(run.code, 0, run.out);
    else assert.notEqual(run.code, 0, run.out);
    for (const reason of reasons) {
      assert.ok(run.out.includes(reason), `missing reason ${JSON.stringify(reason)}\n${run.out}`);
    }
    assert.ok(
      run.out.includes('SOURCE READING ONLY'),
      `a --root run must say so in its banner\n${run.out}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- the controls */

test('CONTROL — the committed tree passes, and the pair count is the product of two independent readings', () => {
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  assert.equal(run.code, 0, run.out);
  const expected = reviewTieredKeys().length * enabledLocales().length;
  assert.ok(
    run.out.includes(`examined ${String(expected)} (locale, key) pair(s)`),
    `the gate must print the pair count, and it must equal ${String(expected)}\n${run.out}`,
  );
  assert.ok(!run.out.includes('SOURCE READING ONLY'), run.out);
});

test('CONTROL — today the gate is green BECAUSE OF THE WAIVER, and it says so with the date that ends it', () => {
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  const expected = reviewTieredKeys().length * enabledLocales().length;
  assert.ok(
    run.out.includes(
      `NOTE: all ${String(expected)} pair(s) are waived and NONE had its review currency verified`,
    ),
    run.out,
  );
  assert.ok(run.out.includes('This gate is green BECAUSE OF THE WAIVER'), run.out);
  assert.ok(run.out.includes('from the day after, every one of them fails here'), run.out);
});

test('CONTROL — a delivered register with no waiver at all passes: the refusals below are not an always-failing gate', () => {
  attack(
    (root) => {
      deliver(root);
    },
    (root) => readJson(root, 'review.json')['pending_pipeline'] === null,
    'PASS',
    ['waiver: none in force — every record is checked in full', '0 waived, 24 with a record read'],
  );
});

/* ------------------- the rule, one conjunct at a time, off a delivered tree */

test('a DELETED review record is refused — absence must fail, or the gate could be satisfied by deleting records', () => {
  attack(
    (root) => {
      deliver(root);
      const register = readJson(root, 'review.json');
      const entries = register['entries'] as Record<string, Record<string, unknown>>;
      const ru = { ...entries['ru'] };
      delete ru[SAFETY_KEY];
      entries['ru'] = ru;
      writeJson(root, 'review.json', register);
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, unknown>
      >;
      return !(SAFETY_KEY in (entries['ru'] ?? {}));
    },
    'FAIL',
    [`MISSING-RECORD '${SAFETY_KEY}' in ru`, 'review.json has no record'],
  );
});

test('a STALE record is refused when the catalogue string is edited under it — the reviewed text and the shipped text differ', () => {
  attack(
    (root) => {
      deliver(root);
      const doc = readJson(root, SAFETY_KEY_FILE);
      doc['checkins_missed'] = `${String(doc['checkins_missed'])} (edited after review)`;
      writeJson(root, SAFETY_KEY_FILE, doc);
    },
    (root) => String(readJson(root, SAFETY_KEY_FILE)['checkins_missed']).includes('after review'),
    'FAIL',
    [`STALE-RECORD '${SAFETY_KEY}' in ru`, 'the catalogue string now hashes to sha256:'],
  );
});

test('a STALE record is refused when the record carries a hash of some other text — the other direction of the same mismatch', () => {
  attack(
    (root) => {
      deliver(root);
      editRecord(root, 'el', SAFETY_KEY, { content_hash: contentHash('some other text entirely') });
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return (
        entries['el']?.[SAFETY_KEY]?.['content_hash'] === contentHash('some other text entirely')
      );
    },
    'FAIL',
    [`STALE-RECORD '${SAFETY_KEY}' in el`],
  );
});

test('a record still at status pending_review is refused', () => {
  attack(
    (root) => {
      deliver(root);
      editRecord(root, 'ru', SAFETY_KEY, { status: 'pending_review' });
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return entries['ru']?.[SAFETY_KEY]?.['status'] === 'pending_review';
    },
    'FAIL',
    [`NOT-SIGNED-OFF '${SAFETY_KEY}' in ru`, 'status is "pending_review"'],
  );
});

test('a record signed off over PLACEHOLDER provenance is refused — signing off engineering copy is not a review', () => {
  attack(
    (root) => {
      deliver(root);
      editRecord(root, 'ru', SAFETY_KEY, { provenance: 'placeholder' });
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return entries['ru']?.[SAFETY_KEY]?.['provenance'] === 'placeholder';
    },
    'FAIL',
    [`PLACEHOLDER '${SAFETY_KEY}' in ru`, 'It must not ship'],
  );
});

test('a record with reviewed_by null is refused — an MT engine cannot name a reviewer', () => {
  attack(
    (root) => {
      deliver(root);
      editRecord(root, 'ru', SAFETY_KEY, { reviewed_by: null });
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return entries['ru']?.[SAFETY_KEY]?.['reviewed_by'] === null;
    },
    'FAIL',
    [`UNREVIEWED '${SAFETY_KEY}' in ru`, 'reviewed_by is null'],
  );
});

test('a record with reviewed_at null is refused — its own case, because it is its own conjunct', () => {
  attack(
    (root) => {
      deliver(root);
      editRecord(root, 'ru', SAFETY_KEY, { reviewed_at: null });
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return entries['ru']?.[SAFETY_KEY]?.['reviewed_at'] === null;
    },
    'FAIL',
    [`UNDATED '${SAFETY_KEY}' in ru`, 'reviewed_at is null'],
  );
});

test('a record whose reviewed_at is prose rather than a date is refused', () => {
  attack(
    (root) => {
      deliver(root);
      editRecord(root, 'ru', SAFETY_KEY, { reviewed_at: 'when the DSL gets to it' });
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return entries['ru']?.[SAFETY_KEY]?.['reviewed_at'] === 'when the DSL gets to it';
    },
    'FAIL',
    [`UNDATED '${SAFETY_KEY}' in ru`, '"when the DSL gets to it"'],
  );
});

test('a record whose provenance is not one of the four values is refused rather than skipped', () => {
  attack(
    (root) => {
      deliver(root);
      editRecord(root, 'ru', SAFETY_KEY, { provenance: 'vibes' });
    },
    (root) => {
      const entries = readJson(root, 'review.json')['entries'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return entries['ru']?.[SAFETY_KEY]?.['provenance'] === 'vibes';
    },
    'FAIL',
    [`MALFORMED-RECORD '${SAFETY_KEY}' in ru`, 'provenance is "vibes"'],
  );
});

test('a signed-off record for a key whose catalogue string has been deleted is refused — currency is unjudgeable', () => {
  attack(
    (root) => {
      deliver(root);
      const doc = readJson(root, SAFETY_KEY_FILE);
      delete doc['checkins_missed'];
      writeJson(root, SAFETY_KEY_FILE, doc);
    },
    (root) => !('checkins_missed' in readJson(root, SAFETY_KEY_FILE)),
    'FAIL',
    [`NO-SOURCE '${SAFETY_KEY}' in ru`, 'fails closed'],
  );
});

/* ----------------------------------------------------------- the waiver */

test('WITH THE WAIVER IN FORCE the committed unreviewed register passes, and that is the only reason it does', () => {
  attack(
    () => {
      /* nothing: the copied root IS the committed register, waiver and all */
    },
    (root) =>
      (readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>) !== null,
    'PASS',
    ['This gate is green BECAUSE OF THE WAIVER'],
  );
});

test('WITHOUT THE WAIVER the same committed register is refused on every unreviewed record — the waiver is load-bearing, not decorative', () => {
  attack(
    (root) => {
      const register = readJson(root, 'review.json');
      register['pending_pipeline'] = null;
      writeJson(root, 'review.json', register);
    },
    (root) => readJson(root, 'review.json')['pending_pipeline'] === null,
    'FAIL',
    [
      'waiver: none in force',
      // T-233: the committed records are `ai_authored` (OE-66/OE-67), no longer
      // `placeholder` — so the refusal is that nobody has reviewed them.
      `NOT-SIGNED-OFF '${SAFETY_KEY}' in ru`,
      `UNREVIEWED '${SAFETY_KEY}' in ru`,
      `NOT-SIGNED-OFF '${SAFETY_KEY}' in en`,
    ],
  );
});

test('AN EXPIRED WAIVER waives nothing: the same unreviewed records are refused, and the reason names the decision review date', () => {
  attack(
    (root) => {
      editWaiver(root, { expected_by: '2026-09-19' });
    },
    (root) =>
      (readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>)[
        'expected_by'
      ] === '2026-09-19',
    'FAIL',
    [
      "WAIVER-EXPIRED the safety-copy waiver's DECISION REVIEW DATE 2026-09-19 has passed",
      'it is the decision that was due',
      `NOT-SIGNED-OFF '${SAFETY_KEY}' in ru`,
      `UNDATED '${SAFETY_KEY}' in ru`,
    ],
  );
});

test('T-233: `ai_authored` is a well-formed provenance that satisfies NOTHING — unreviewed AI copy is refused on review, never as malformed', () => {
  // Before T-233 this gate refused `ai_authored` as MALFORMED-RECORD, which is a
  // wrong reason: the record is well-formed, it is UNREVIEWED. The refusal must
  // name the missing review, and must still fire, so that a DSL sign-off is the
  // only way through (OE-66: the DSL + deputy review is unchanged).
  const root = makeRoot();
  try {
    const register = readJson(root, 'review.json');
    register['pending_pipeline'] = null;
    writeJson(root, 'review.json', register);
    const entries = register['entries'] as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(entries['ru']?.[SAFETY_KEY]?.['provenance'], 'ai_authored', 'precondition');
    const run = runGate(['--root', root]);
    assert.equal(run.banner, 'FAIL', run.out);
    assert.notEqual(run.code, 0, run.out);
    for (const reason of [
      `NOT-SIGNED-OFF '${SAFETY_KEY}' in ru`,
      `UNREVIEWED '${SAFETY_KEY}' in ru`,
      `UNDATED '${SAFETY_KEY}' in ru`,
    ]) {
      assert.ok(run.out.includes(reason), `missing ${reason}\n${run.out}`);
    }
    assert.ok(!run.out.includes('MALFORMED-RECORD'), run.out);
    assert.ok(!run.out.includes('PLACEHOLDER'), run.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a waiver renewed past the anchor pinned in the gate is refused — it cannot be renewed by editing the field that expires it', () => {
  attack(
    (root) => {
      editWaiver(root, { expected_by: '2027-06-01' });
    },
    (root) =>
      (readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>)[
        'expected_by'
      ] === '2027-06-01',
    'FAIL',
    ['WAIVER-RENEWED', 'later than the 2026-12-05 anchor pinned in this gate'],
  );
});

test('a waiver naming a key that needs no review record is refused as overreach', () => {
  attack(
    (root) => {
      const register = readJson(root, 'review.json');
      const waiver = register['pending_pipeline'] as Record<string, unknown>;
      waiver['keys'] = [...(waiver['keys'] as string[]), 'common.marketing.tagline'];
      writeJson(root, 'review.json', register);
    },
    (root) =>
      (
        (readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>)[
          'keys'
        ] as string[]
      ).includes('common.marketing.tagline'),
    'FAIL',
    ["WAIVER-OVERREACH the waiver names 'common.marketing.tagline'"],
  );
});

test('a waiver with no owner is refused — a waiver names an owner, a ticket and a reason, or it is an ignore-list', () => {
  attack(
    (root) => {
      const register = readJson(root, 'review.json');
      const waiver = { ...(register['pending_pipeline'] as Record<string, unknown>) };
      delete waiver['owner'];
      register['pending_pipeline'] = waiver;
      writeJson(root, 'review.json', register);
    },
    (root) =>
      !('owner' in (readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>)),
    'FAIL',
    ['WAIVER-MALFORMED `pending_pipeline.owner`'],
  );
});

test('a waiver with an undated expiry is refused — an undated waiver cannot self-close', () => {
  attack(
    (root) => {
      editWaiver(root, { expected_by: 'when the copy arrives' });
    },
    (root) =>
      (readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>)[
        'expected_by'
      ] === 'when the copy arrives',
    'FAIL',
    ['WAIVER-MALFORMED `pending_pipeline.expected_by`', 'cannot self-close'],
  );
});

test('a waiver whose keys are not a list is refused rather than treated as waiving nothing or everything', () => {
  attack(
    (root) => {
      editWaiver(root, { keys: 'all of them' });
    },
    (root) =>
      (readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>)['keys'] ===
      'all of them',
    'FAIL',
    ['WAIVER-MALFORMED `pending_pipeline.keys`', 'waives an unknown set'],
  );
});

test('WAIVED-NO-RECORD: deleting the records the waiver covers does not buy a pass', () => {
  attack(
    (root) => {
      const register = readJson(root, 'review.json');
      register['entries'] = { en: {}, el: {}, ru: {} };
      writeJson(root, 'review.json', register);
    },
    (root) =>
      Object.keys(
        (readJson(root, 'review.json')['entries'] as Record<string, Record<string, unknown>>)[
          'ru'
        ] ?? { x: 1 },
      ).length === 0,
    'FAIL',
    [`WAIVED-NO-RECORD '${SAFETY_KEY}' in ru`, 'not the existence of the provenance row'],
  );
});

/* ------------------------------------------- "if it checked nothing…" (A) */

test('re-tiering every key that needs a review record does not make the gate green', () => {
  attack(
    (root) => {
      const tiers = readJson(root, 'tiers.json');
      const table = tiers['tiers'] as Record<string, string>;
      for (const [key, tier] of Object.entries(table)) {
        if (TIER_POLICY[tier as Tier]?.requiresSafetyReview) table[key] = 'operational';
      }
      writeJson(root, 'tiers.json', tiers);
    },
    (root) =>
      Object.values(readJson(root, 'tiers.json')['tiers'] as Record<string, string>).every(
        (t) => !TIER_POLICY[t as Tier]?.requiresSafetyReview,
      ),
    'FAIL',
    ['NO-COMPARISON tiers.json assigns no key to a tier that requires a safety review record'],
  );
});

test('disabling every locale does not make the gate green', () => {
  attack(
    (root) => {
      const registry = readJson(root, 'locale-registry.json');
      for (const row of registry['locales'] as Record<string, unknown>[]) row['enabled'] = false;
      writeJson(root, 'locale-registry.json', registry);
    },
    (root) =>
      (readJson(root, 'locale-registry.json')['locales'] as Record<string, unknown>[]).every(
        (r) => r['enabled'] === false,
      ),
    'FAIL',
    ['NO-COMPARISON locale-registry.json enables no locale'],
  );
});

test('a review.json that is not JSON is a failed build, never an empty one', () => {
  attack(
    (root) => {
      writeFileSync(join(root, 'review.json'), '{ not json', 'utf8');
    },
    (root) => readFileSync(join(root, 'review.json'), 'utf8').startsWith('{ not json'),
    'FAIL',
    ['INPUT review.json is unreadable or not a register'],
  );
});

test('a review.json with no entries block is refused', () => {
  attack(
    (root) => {
      const register = readJson(root, 'review.json');
      delete register['entries'];
      writeJson(root, 'review.json', register);
    },
    (root) => !('entries' in readJson(root, 'review.json')),
    'FAIL',
    ['INPUT review.json is unreadable or not a register', '`entries` must be an object'],
  );
});

test('a tiers.json value that is not one of the four tiers is refused rather than skipped', () => {
  attack(
    (root) => {
      const tiers = readJson(root, 'tiers.json');
      (tiers['tiers'] as Record<string, string>)[SAFETY_KEY] = 'safety_critical_ish';
      writeJson(root, 'tiers.json', tiers);
    },
    (root) =>
      (readJson(root, 'tiers.json')['tiers'] as Record<string, string>)[SAFETY_KEY] ===
      'safety_critical_ish',
    'FAIL',
    ['INPUT tiers.json', '"safety_critical_ish"'],
  );
});

/* ------------------------------------------------- scope, stated as a case */

test('COUNTEREXAMPLE — a transactional key with no review record at all passes: this gate is the safety-review half only', () => {
  attack(
    (root) => {
      deliver(root);
      const tiers = readJson(root, 'tiers.json');
      const table = tiers['tiers'] as Record<string, string>;
      const transactional = Object.entries(table).find(([, t]) => t === 'transactional');
      assert.ok(transactional !== undefined, 'the fixture has no transactional key');
      // nothing else changes: `deliver()` wrote records only for the
      // review-tiered keys, so every transactional key is unrecorded already.
      writeJson(root, 'tiers.json', tiers);
    },
    (root) =>
      Object.values(readJson(root, 'tiers.json')['tiers'] as Record<string, string>).includes(
        'transactional',
      ),
    'PASS',
    ['keys needing a review record (tiers.json): 8 of'],
  );
});

test('an unrecognised argument exits 2 before any reading, with no banner at all', () => {
  const run = runGate(['--skip-waiver']);
  assert.equal(run.code, 2, run.out);
  assert.equal(run.banner, 'NONE', run.out);
  assert.ok(run.out.includes('unrecognised argument "--skip-waiver"'), run.out);
});
