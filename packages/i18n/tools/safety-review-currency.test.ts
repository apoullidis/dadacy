/**
 * `gate:safety-review-currency` — T-044, attacked rather than observed passing;
 * T-258, the OE-5 terminal state and the refusal of every human-review claim.
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
 *   3. the expected reason substring (and, where the claim is "every pair",
 *      the number of times it is printed).
 *
 * THE BASELINE IS FINAL (T-258). Since stakeholder ruling OE-5 (2026-10-11) no
 * human reviews safety copy, and OE-81 makes AI-authored, unreviewed copy
 * releasable. So the state a refusal case breaks once is `finalise()`: the 24
 * COMMITTED records — AI-authored under OE-66/OE-67, hashes current — moved to
 * `status: "unreviewed_by_ruling"` with `review_ruling: "OE-5"`, reviewer and
 * date null, and no waiver. That fixture must PASS, which is what makes each
 * refusal below a statement about one field and not an always-failing gate.
 * The T-044 baseline — `deliver()`, every record signed off by a named human —
 * is kept, and is now itself a NEGATIVE: it claims a review.
 *
 * NOTHING HERE IMPORTS THE RULINGS. The model name and the ruling ids below are
 * literals written in this file, so a change to `tools/rulings.ts` is judged
 * against them rather than agreeing with itself (PROTOCOL §5.1). The committed
 * `review.json` is the other independent copy: `finalise()` keeps its
 * `authored_by` and `ruling` as committed.
 *
 * WHAT IS NOT COVERED HERE, and is therefore in
 * `tools/safety-review-currency-negatives.ts` and the evidence file instead:
 * readings B and C — the committed `compiled/` artefact and the key, locale and
 * waiver pins — which are about THIS package's tracked files and cannot be
 * planted in a temporary root, and any mutation of `tools/rulings.ts` (the gate
 * subprocess imports the committed module). Same status and same reason as
 * `T-042`'s `tools/locale-completeness-negatives.ts` (OD-57).
 * `AUTHORED_CONTENT_PINNED` and the rulings ARE applied under `--root`: they
 * are per-record checks in reading A, and a temporary root copies this
 * package's catalogues, so the committed hashes are the fixture's hashes.
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

/**
 * The model OE-66/OE-67 name, written HERE as a third copy (the others are
 * `tools/rulings.ts` and the committed `review.json`). Used only to build
 * forgeries and near misses, never to decide what passes.
 */
const MODEL_LITERAL = 'Claude Opus (claude-opus-5-5), AI agent';

/** An invented, real-looking name. It is not a person; it is the shape a forged review takes. */
const REAL_LOOKING_REVIEWER = 'Eleni Constantinou, Designated Safeguarding Lead';

/** The terminal status T-258 adds (`src/types.ts`). */
const FINAL = 'unreviewed_by_ruling';

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

/** How many problem lines of the FAIL list start with this refusal name. */
function countRefusals(out: string, name: string): number {
  return out.split('\n').filter((l) => l.startsWith(`  - ${name} `)).length;
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

/** `keys x enabled locales`, from the package's own exports. */
function expectedPairs(): number {
  return reviewTieredKeys().length * enabledLocales().length;
}

type Entries = Record<string, Record<string, Record<string, unknown>>>;

function entriesOf(root: string): Entries {
  return readJson(root, 'review.json')['entries'] as Entries;
}

function recordOf(root: string, locale: string, key: string): Record<string, unknown> | undefined {
  return entriesOf(root)[locale]?.[key];
}

/**
 * Rewrite a root's `review.json` into the OE-5 TERMINAL STATE: every committed
 * record, for every key and every enabled locale, kept exactly as committed
 * (AI-authored, its ruling, its hash) except that it becomes final with no
 * review, and `pending_pipeline: null`. This is the state `T-259` moves the
 * real register to. It is written into a temporary directory and deleted.
 */
function finalise(root: string): void {
  const register = readJson(root, 'review.json');
  const entries = register['entries'] as Entries;
  for (const locale of enabledLocales().map((d) => d.code)) {
    for (const key of reviewTieredKeys()) {
      const record = entries[locale]?.[key];
      assert.ok(
        record !== undefined,
        `the committed register has no record for ${key} in ${locale}`,
      );
      entries[locale] = {
        ...entries[locale],
        [key]: {
          ...record,
          status: FINAL,
          review_ruling: 'OE-5',
          reviewed_by: null,
          reviewed_at: null,
        },
      };
    }
  }
  register['pending_pipeline'] = null;
  writeJson(root, 'review.json', register);
}

/**
 * T-044's baseline: a COMPLETE DELIVERY by humans — every record `authored` or
 * `translated_professional`, signed off by a named reviewer, no waiver. Before
 * OE-5 it passed; since T-258 it is refused on every pair.
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

/** Mutate one record of a fixture. A `null` patch value is written; `undefined` deletes the field. */
function editRecord(
  root: string,
  locale: string,
  key: string,
  patch: Record<string, unknown>,
): void {
  const register = readJson(root, 'review.json');
  const entries = register['entries'] as Entries;
  const record = entries[locale]?.[key];
  assert.ok(record !== undefined, `no record for ${key} in ${locale}`);
  const next: Record<string, unknown> = { ...record };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  entries[locale] = { ...entries[locale], [key]: next };
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
 * `absent` names refusals that must NOT be printed; `counts` pins how many
 * problem lines a refusal produces.
 */
function attack(
  plant: (root: string) => void,
  landed: (root: string) => boolean,
  expect: 'PASS' | 'FAIL',
  reasons: readonly string[],
  absent: readonly string[] = [],
  counts: Readonly<Record<string, number>> = {},
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
    for (const name of ['CRASH', ...absent]) {
      assert.ok(!run.out.includes(name), `${name} must not be printed\n${run.out}`);
    }
    for (const [name, n] of Object.entries(counts)) {
      assert.equal(
        countRefusals(run.out, name),
        n,
        `${name} must be printed ${String(n)} time(s)\n${run.out}`,
      );
    }
    assert.ok(
      run.out.includes('SOURCE READING ONLY'),
      `a --root run must say so in its banner\n${run.out}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every refusal T-258 adds. A finalised fixture with one defect must print exactly the one it plants. */
const T258_REFUSALS = [
  'NOT-AI-AUTHORED',
  'UNRULED-AUTHOR',
  'WRONG-AUTHOR',
  'CLAIMS-REVIEW',
  'NOT-FINAL',
  'UNRULED-NO-REVIEW',
  'UNPINNED-CONTENT',
] as const;

function othersThan(...planted: readonly string[]): readonly string[] {
  return T258_REFUSALS.filter((r) => !planted.includes(r)).map((r) => `  - ${r} `);
}

/* ------------------------------------------------------------- the controls */

test('CONTROL — the committed tree passes, and the pair count is the product of two independent readings', () => {
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  assert.equal(run.code, 0, run.out);
  assert.ok(
    run.out.includes(`examined ${String(expectedPairs())} (locale, key) pair(s)`),
    `the gate must print the pair count, and it must equal ${String(expectedPairs())}\n${run.out}`,
  );
  assert.ok(!run.out.includes('SOURCE READING ONLY'), run.out);
});

test('CONTROL — today the gate is green BECAUSE OF THE WAIVER, says so with the date that ends it, and accepts nothing under OE-5 yet', () => {
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  const n = String(expectedPairs());
  assert.ok(run.out.includes(`NOTE: all ${n} pair(s) are waived`), run.out);
  assert.ok(run.out.includes('This gate is green BECAUSE OF THE WAIVER'), run.out);
  assert.ok(run.out.includes('from the day after, every one of them fails here'), run.out);
  assert.ok(
    run.out.includes(`OE-5: 0 of ${n} pair(s) accepted as AI-authored and reviewed by nobody`),
    run.out,
  );
});

test('CONTROL — every pair final under OE-5 and pinned, no waiver: the gate passes and says all of them were reviewed by nobody', () => {
  const n = String(expectedPairs());
  attack(
    (root) => {
      finalise(root);
    },
    (root) =>
      readJson(root, 'review.json')['pending_pipeline'] === null &&
      Object.values(entriesOf(root)).every((perLocale) =>
        Object.values(perLocale).every(
          (r) =>
            r['status'] === FINAL && r['review_ruling'] === 'OE-5' && r['reviewed_by'] === null,
        ),
      ),
    'PASS',
    [
      'waiver: none in force — every record is checked in full',
      `examined ${n} (locale, key) pair(s)`,
      `0 waived, ${n} with a record read`,
      `OE-5: ${n} of ${n} pair(s) accepted as AI-authored and reviewed by nobody`,
    ],
    ['NOTE: all'],
  );
});

/* ---------------------------------- CLAIMS-REVIEW: nothing may claim a human */

test('CLAIMS-REVIEW — an AI record signed off by a real-looking reviewer is refused, outside the waiver', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'ru', SAFETY_KEY, {
        status: 'signed_off',
        reviewed_by: REAL_LOOKING_REVIEWER,
        reviewed_at: '2026-10-12T09:00:00Z',
      });
    },
    (root) => recordOf(root, 'ru', SAFETY_KEY)?.['reviewed_by'] === REAL_LOOKING_REVIEWER,
    'FAIL',
    [
      `CLAIMS-REVIEW '${SAFETY_KEY}' in ru`,
      'status is "signed_off"',
      `reviewed_by is "${REAL_LOOKING_REVIEWER}"`,
      'reviewed_at is "2026-10-12T09:00:00Z"',
      `NOT-FINAL '${SAFETY_KEY}' in ru`,
    ],
    othersThan('CLAIMS-REVIEW', 'NOT-FINAL'),
    { 'CLAIMS-REVIEW': 1 },
  );
});

test('CLAIMS-REVIEW — the same claim on a record INSIDE the waiver is refused too: the waiver never covers a review claim', () => {
  attack(
    (root) => {
      editRecord(root, 'ru', SAFETY_KEY, {
        status: 'signed_off',
        reviewed_by: REAL_LOOKING_REVIEWER,
        reviewed_at: '2026-10-12T09:00:00Z',
      });
    },
    (root) => {
      const waiver = readJson(root, 'review.json')['pending_pipeline'] as Record<string, unknown>;
      return (
        (waiver['keys'] as string[]).includes(SAFETY_KEY) &&
        recordOf(root, 'ru', SAFETY_KEY)?.['status'] === 'signed_off'
      );
    },
    'FAIL',
    [
      '(in force)',
      `${String(expectedPairs())} waived, 0 with a record read`,
      `CLAIMS-REVIEW '${SAFETY_KEY}' in ru (waived)`,
    ],
    othersThan('CLAIMS-REVIEW'),
    { 'CLAIMS-REVIEW': 1 },
  );
});

test('CLAIMS-REVIEW — reviewed_by set alone, on a final record, is refused', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'el', SAFETY_KEY, { reviewed_by: REAL_LOOKING_REVIEWER });
    },
    (root) =>
      recordOf(root, 'el', SAFETY_KEY)?.['reviewed_by'] === REAL_LOOKING_REVIEWER &&
      recordOf(root, 'el', SAFETY_KEY)?.['status'] === FINAL,
    'FAIL',
    [`CLAIMS-REVIEW '${SAFETY_KEY}' in el`, `reviewed_by is "${REAL_LOOKING_REVIEWER}"`],
    othersThan('CLAIMS-REVIEW'),
    { 'CLAIMS-REVIEW': 1 },
  );
});

test('CLAIMS-REVIEW — reviewed_at set alone, on a final record, is refused', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'el', SAFETY_KEY, { reviewed_at: '2026-10-12T09:00:00Z' });
    },
    (root) =>
      recordOf(root, 'el', SAFETY_KEY)?.['reviewed_at'] === '2026-10-12T09:00:00Z' &&
      recordOf(root, 'el', SAFETY_KEY)?.['reviewed_by'] === null,
    'FAIL',
    [`CLAIMS-REVIEW '${SAFETY_KEY}' in el`, 'reviewed_at is "2026-10-12T09:00:00Z"'],
    othersThan('CLAIMS-REVIEW'),
    { 'CLAIMS-REVIEW': 1 },
  );
});

test('CLAIMS-REVIEW — a review claim in a field the register does not define (review_date, reviewer) is refused; review_ruling alone is not a claim', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'el', SAFETY_KEY, { review_date: '2026-10-12' });
      editRecord(root, 'ru', SAFETY_KEY, { reviewer: REAL_LOOKING_REVIEWER });
    },
    (root) =>
      recordOf(root, 'el', SAFETY_KEY)?.['review_date'] === '2026-10-12' &&
      recordOf(root, 'ru', SAFETY_KEY)?.['reviewer'] === REAL_LOOKING_REVIEWER &&
      recordOf(root, 'en', SAFETY_KEY)?.['review_ruling'] === 'OE-5',
    'FAIL',
    [
      `CLAIMS-REVIEW '${SAFETY_KEY}' in el: review_date is "2026-10-12"`,
      `CLAIMS-REVIEW '${SAFETY_KEY}' in ru: reviewer is "${REAL_LOOKING_REVIEWER}"`,
    ],
    othersThan('CLAIMS-REVIEW'),
    { 'CLAIMS-REVIEW': 2 },
  );
});

test('CLAIMS-REVIEW — status signed_off alone, with no reviewer and no date, is refused', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'en', SAFETY_KEY, { status: 'signed_off' });
    },
    (root) =>
      recordOf(root, 'en', SAFETY_KEY)?.['status'] === 'signed_off' &&
      recordOf(root, 'en', SAFETY_KEY)?.['reviewed_by'] === null &&
      recordOf(root, 'en', SAFETY_KEY)?.['reviewed_at'] === null,
    'FAIL',
    [
      `CLAIMS-REVIEW '${SAFETY_KEY}' in en`,
      'status is "signed_off"',
      `NOT-FINAL '${SAFETY_KEY}' in en`,
    ],
    othersThan('CLAIMS-REVIEW', 'NOT-FINAL'),
    { 'CLAIMS-REVIEW': 1 },
  );
});

test('OD-258 — the forgery T-233 QA measured, every AI record signed off with the model as reviewer and no waiver, is refused by this gate alone', () => {
  const n = expectedPairs();
  attack(
    (root) => {
      const register = readJson(root, 'review.json');
      register['pending_pipeline'] = null;
      for (const perLocale of Object.values(register['entries'] as Entries)) {
        for (const record of Object.values(perLocale)) {
          record['status'] = 'signed_off';
          record['reviewed_by'] = MODEL_LITERAL;
          record['reviewed_at'] = '2026-10-01T09:00:00Z';
        }
      }
      writeJson(root, 'review.json', register);
    },
    (root) =>
      readJson(root, 'review.json')['pending_pipeline'] === null &&
      Object.values(entriesOf(root)).every((perLocale) =>
        Object.values(perLocale).every((r) => r['reviewed_by'] === MODEL_LITERAL),
      ),
    'FAIL',
    [`CLAIMS-REVIEW '${SAFETY_KEY}' in ru`, `reviewed_by is "${MODEL_LITERAL}"`],
    ['UNRULED-AUTHOR', 'WRONG-AUTHOR', 'NOT-AI-AUTHORED', 'UNPINNED-CONTENT', 'STALE-RECORD'],
    { 'CLAIMS-REVIEW': n, 'NOT-FINAL': n, 'UNRULED-NO-REVIEW': n },
  );
});

test('a delivered pre-OE-5 register — human authors, signed off by a DSL reviewer, no waiver — is now refused on every pair', () => {
  const n = expectedPairs();
  attack(
    (root) => {
      deliver(root);
    },
    (root) =>
      readJson(root, 'review.json')['pending_pipeline'] === null &&
      recordOf(root, 'ru', SAFETY_KEY)?.['provenance'] === 'translated_professional',
    'FAIL',
    [
      `NOT-AI-AUTHORED '${SAFETY_KEY}' in ru`,
      'provenance is "translated_professional"',
      `CLAIMS-REVIEW '${SAFETY_KEY}' in en`,
    ],
    ['PLACEHOLDER', 'MALFORMED-RECORD'],
    { 'NOT-AI-AUTHORED': n, 'CLAIMS-REVIEW': n, 'NOT-FINAL': n, 'UNRULED-NO-REVIEW': n },
  );
});

/* ------------------------------------- authorship: the gate reads the rulings */

test('WRONG-AUTHOR — a human name as authored_by under OE-66 is refused, and so is every near miss of the model name', () => {
  const plants: readonly (readonly [string, string, string])[] = [
    ['el', SAFETY_KEY, 'Maria Georgiou'],
    ['ru', SAFETY_KEY, 'Claude Opus (claude-opus-4-1), AI agent'],
    ['el', 'safety.sos.confirm', `${MODEL_LITERAL} `],
    ['ru', 'safety.sos.confirm', MODEL_LITERAL.toLowerCase()],
    ['el', 'safety.emergency.call_112.label', `С${MODEL_LITERAL.slice(1)}`],
    ['ru', 'safety.emergency.call_112.label', 'Claude​ Opus (claude-opus-5-5), AI agent'],
    ['en', SAFETY_KEY, 'Claude Opus'],
  ];
  attack(
    (root) => {
      finalise(root);
      for (const [locale, key, name] of plants) {
        assert.notEqual(name, MODEL_LITERAL);
        editRecord(root, locale, key, { authored_by: name });
      }
    },
    (root) => plants.every(([l, k, name]) => recordOf(root, l, k)?.['authored_by'] === name),
    'FAIL',
    plants.map(
      ([l, k, name]) => `WRONG-AUTHOR '${k}' in ${l}: authored_by is ${JSON.stringify(name)}`,
    ),
    othersThan('WRONG-AUTHOR'),
    { 'WRONG-AUTHOR': plants.length },
  );
});

test('UNRULED-AUTHOR — OE-67 cited on el is refused: OE-67 makes a model the author of en copy only', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'el', SAFETY_KEY, { ruling: 'OE-67' });
    },
    (root) => recordOf(root, 'el', SAFETY_KEY)?.['ruling'] === 'OE-67',
    'FAIL',
    [
      `UNRULED-AUTHOR '${SAFETY_KEY}' in el`,
      'cites OE-67, which makes a model the author of en copy',
    ],
    othersThan('UNRULED-AUTHOR'),
    { 'UNRULED-AUTHOR': 1 },
  );
});

test('UNRULED-AUTHOR — an AI record with no ruling, or citing OE-5 (a review ruling, not an author ruling), is refused', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'ru', SAFETY_KEY, { ruling: undefined });
      editRecord(root, 'en', SAFETY_KEY, { ruling: 'OE-5' });
    },
    (root) =>
      !('ruling' in (recordOf(root, 'ru', SAFETY_KEY) ?? { ruling: 1 })) &&
      recordOf(root, 'en', SAFETY_KEY)?.['ruling'] === 'OE-5',
    'FAIL',
    [
      `UNRULED-AUTHOR '${SAFETY_KEY}' in ru: provenance "ai_authored" with no \`ruling\``,
      `UNRULED-AUTHOR '${SAFETY_KEY}' in en: cites "OE-5", which is not a stakeholder ruling that makes a model an author`,
    ],
    othersThan('UNRULED-AUTHOR'),
    { 'UNRULED-AUTHOR': 2 },
  );
});

test('NOT-AI-AUTHORED — provenance authored with no ruling is refused: since OE-5 no human-path record is accepted', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'el', SAFETY_KEY, {
        provenance: 'authored',
        ruling: undefined,
        authored_by: 'Maria Georgiou',
      });
    },
    (root) =>
      recordOf(root, 'el', SAFETY_KEY)?.['provenance'] === 'authored' &&
      !('ruling' in (recordOf(root, 'el', SAFETY_KEY) ?? { ruling: 1 })),
    'FAIL',
    [`NOT-AI-AUTHORED '${SAFETY_KEY}' in el`, 'provenance is "authored"'],
    othersThan('NOT-AI-AUTHORED'),
    { 'NOT-AI-AUTHORED': 1 },
  );
});

test('PLACEHOLDER — a final record over placeholder provenance is refused: engineering copy must not ship', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'ru', SAFETY_KEY, { provenance: 'placeholder', ruling: undefined });
    },
    (root) => recordOf(root, 'ru', SAFETY_KEY)?.['provenance'] === 'placeholder',
    'FAIL',
    [`PLACEHOLDER '${SAFETY_KEY}' in ru`, 'It must not ship'],
    othersThan(),
    {},
  );
});

test('a record whose provenance is not one of the five values is refused rather than skipped', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'ru', SAFETY_KEY, { provenance: 'vibes' });
    },
    (root) => recordOf(root, 'ru', SAFETY_KEY)?.['provenance'] === 'vibes',
    'FAIL',
    [`MALFORMED-RECORD '${SAFETY_KEY}' in ru`, 'provenance is "vibes"'],
    othersThan(),
    {},
  );
});

/* ----------------------------------------------- final, by ruling, and pinned */

test('NOT-FINAL — an unwaived record still at pending_review is refused', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'ru', SAFETY_KEY, { status: 'pending_review', review_ruling: undefined });
    },
    (root) => recordOf(root, 'ru', SAFETY_KEY)?.['status'] === 'pending_review',
    'FAIL',
    [`NOT-FINAL '${SAFETY_KEY}' in ru`, 'status is "pending_review"'],
    othersThan('NOT-FINAL', 'UNRULED-NO-REVIEW'),
    { 'NOT-FINAL': 1, 'UNRULED-NO-REVIEW': 1 },
  );
});

test('UNRULED-NO-REVIEW — a final record with no review_ruling, or citing OE-66 (an author ruling), is refused', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'ru', SAFETY_KEY, { review_ruling: undefined });
      editRecord(root, 'el', SAFETY_KEY, { review_ruling: 'OE-66' });
    },
    (root) =>
      !('review_ruling' in (recordOf(root, 'ru', SAFETY_KEY) ?? { review_ruling: 1 })) &&
      recordOf(root, 'el', SAFETY_KEY)?.['review_ruling'] === 'OE-66',
    'FAIL',
    [
      `UNRULED-NO-REVIEW '${SAFETY_KEY}' in ru: review_ruling is undefined`,
      `UNRULED-NO-REVIEW '${SAFETY_KEY}' in el: review_ruling is "OE-66"`,
    ],
    othersThan('UNRULED-NO-REVIEW'),
    { 'UNRULED-NO-REVIEW': 2 },
  );
});

test('UNPINNED-CONTENT — a safety string edited with its record hash updated, but not the pin in the gate, is refused', () => {
  attack(
    (root) => {
      finalise(root);
      const doc = readJson(root, SAFETY_KEY_FILE);
      const edited = `${String(doc['checkins_missed'])} (edited)`;
      doc['checkins_missed'] = edited;
      writeJson(root, SAFETY_KEY_FILE, doc);
      editRecord(root, 'ru', SAFETY_KEY, { content_hash: contentHash(edited) });
    },
    (root) => {
      const source = catalogueSource('ru', SAFETY_KEY, root);
      return (
        source !== undefined &&
        source.endsWith(' (edited)') &&
        recordOf(root, 'ru', SAFETY_KEY)?.['content_hash'] === contentHash(source)
      );
    },
    'FAIL',
    [`UNPINNED-CONTENT '${SAFETY_KEY}' in ru`, 'AUTHORED_CONTENT_PINNED'],
    ['STALE-RECORD', ...othersThan('UNPINNED-CONTENT')],
    { 'UNPINNED-CONTENT': 1 },
  );
});

/* ---------------------- currency and presence, unchanged, off a final tree */

test('a DELETED review record is refused — absence must fail, or the gate could be satisfied by deleting records', () => {
  attack(
    (root) => {
      finalise(root);
      const register = readJson(root, 'review.json');
      const entries = register['entries'] as Record<string, Record<string, unknown>>;
      const ru = { ...entries['ru'] };
      delete ru[SAFETY_KEY];
      entries['ru'] = ru;
      writeJson(root, 'review.json', register);
    },
    (root) => !(SAFETY_KEY in (entriesOf(root)['ru'] ?? {})),
    'FAIL',
    [`MISSING-RECORD '${SAFETY_KEY}' in ru`, 'review.json has no record'],
    othersThan(),
    {},
  );
});

test('a STALE record is refused when the catalogue string is edited under it — the reviewed text and the shipped text differ', () => {
  attack(
    (root) => {
      finalise(root);
      const doc = readJson(root, SAFETY_KEY_FILE);
      doc['checkins_missed'] = `${String(doc['checkins_missed'])} (edited after review)`;
      writeJson(root, SAFETY_KEY_FILE, doc);
    },
    (root) => String(readJson(root, SAFETY_KEY_FILE)['checkins_missed']).includes('after review'),
    'FAIL',
    [`STALE-RECORD '${SAFETY_KEY}' in ru`, 'the catalogue string now hashes to sha256:'],
    othersThan(),
    {},
  );
});

test('a STALE record is refused when the record carries a hash of some other text — the other direction of the same mismatch', () => {
  attack(
    (root) => {
      finalise(root);
      editRecord(root, 'el', SAFETY_KEY, { content_hash: contentHash('some other text entirely') });
    },
    (root) =>
      recordOf(root, 'el', SAFETY_KEY)?.['content_hash'] ===
      contentHash('some other text entirely'),
    'FAIL',
    [`STALE-RECORD '${SAFETY_KEY}' in el`, `UNPINNED-CONTENT '${SAFETY_KEY}' in el`],
    othersThan('UNPINNED-CONTENT'),
    {},
  );
});

test('a final record for a key whose catalogue string has been deleted is refused — currency is unjudgeable', () => {
  attack(
    (root) => {
      finalise(root);
      const doc = readJson(root, SAFETY_KEY_FILE);
      delete doc['checkins_missed'];
      writeJson(root, SAFETY_KEY_FILE, doc);
    },
    (root) => !('checkins_missed' in readJson(root, SAFETY_KEY_FILE)),
    'FAIL',
    [`NO-SOURCE '${SAFETY_KEY}' in ru`, 'fails closed'],
    othersThan(),
    {},
  );
});

/* ----------------------------------------------------------- the waiver */

test('WITH THE WAIVER IN FORCE the committed register passes, and that is the only reason it does', () => {
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

test('WITHOUT THE WAIVER the committed register is refused on every pair as NOT FINAL — and its OE-66/OE-67 authorship is accepted by this gate alone (OD-258)', () => {
  const n = expectedPairs();
  attack(
    (root) => {
      const register = readJson(root, 'review.json');
      register['pending_pipeline'] = null;
      writeJson(root, 'review.json', register);
    },
    (root) =>
      readJson(root, 'review.json')['pending_pipeline'] === null &&
      recordOf(root, 'ru', SAFETY_KEY)?.['provenance'] === 'ai_authored',
    'FAIL',
    ['waiver: none in force', `NOT-FINAL '${SAFETY_KEY}' in ru`, `NOT-FINAL '${SAFETY_KEY}' in en`],
    [
      'UNRULED-AUTHOR',
      'WRONG-AUTHOR',
      'NOT-AI-AUTHORED',
      'CLAIMS-REVIEW',
      'UNPINNED-CONTENT',
      'STALE-RECORD',
      'MALFORMED-RECORD',
      'PLACEHOLDER',
    ],
    { 'NOT-FINAL': n, 'UNRULED-NO-REVIEW': n },
  );
});

test('AN EXPIRED WAIVER waives nothing: the same records are refused, and the reason names the decision review date', () => {
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
      `NOT-FINAL '${SAFETY_KEY}' in ru`,
      `UNRULED-NO-REVIEW '${SAFETY_KEY}' in ru`,
    ],
    ['BECAUSE OF THE WAIVER'],
  );
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
    (root) => Object.keys(entriesOf(root)['ru'] ?? { x: 1 }).length === 0,
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
      finalise(root);
      const tiers = readJson(root, 'tiers.json');
      const table = tiers['tiers'] as Record<string, string>;
      const transactional = Object.entries(table).find(([, t]) => t === 'transactional');
      assert.ok(transactional !== undefined, 'the fixture has no transactional key');
      // nothing else changes: the committed register holds records only for
      // the review-tiered keys, so every transactional key is unrecorded already.
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
