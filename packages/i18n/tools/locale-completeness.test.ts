/**
 * `gate:locale-completeness` — T-042, attacked rather than observed passing.
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
 * Two of the cases are CONTROLS that must PASS, and one of them
 * (`a complete catalogue passes`) is the one that stops every refusal below
 * from being satisfied by a gate that simply always fails.
 *
 * WHAT IS NOT COVERED HERE, and is therefore in the evidence file instead:
 * readings B and C, which need the COMMITTED `compiled/` of this package and
 * so cannot be planted in a temporary root. They are demonstrated by
 * `tools/locale-completeness-negatives.ts`, which mutates the working tree and
 * is not run by any gate — the same status and the same reason as
 * `test:negatives` (T-132 § Published contract (rework 2) §6, OD-57).
 *
 * T-132 § Published contract (rework 2) §2's convention holds in this file:
 * every title is a string literal and every `test(` starts its own line.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { strictKeys, enabledLocales } from '../src/index.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PACKAGE_ROOT, 'tools', 'locale-completeness.ts');

/** A safety_critical key that exists in all three locales today. */
const SAFETY_KEY_FILE = join('catalogues', 'ru', 'session.json');
const SAFETY_KEY = 'checkins_missed';

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
  const pass = /^GATE PASS {2}gate:locale-completeness/m.test(out);
  const fail = /^GATE FAIL {2}gate:locale-completeness/m.test(out);
  let banner: GateRun['banner'] = 'NONE';
  if (pass && fail) banner = 'BOTH';
  else if (pass) banner = 'PASS';
  else if (fail) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

/**
 * A package root holding only what reading A needs: the registry, the tier
 * table and the catalogues, copied from the real package. `compiled/` is
 * deliberately NOT copied — its modules import `../../src/runtime.ts` and
 * `intl-messageformat`, neither of which resolves from a temporary directory.
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 't042-'));
  for (const entry of ['locale-registry.json', 'tiers.json']) {
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

/**
 * Run one case. `plant` mutates the root and `landed` must then return true —
 * a mutation that did not land would otherwise let a case report a verdict
 * about an unmodified tree (PROTOCOL §5.1, the T-039 harness defect).
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

/** Replace the `ru` safety_critical message with `value`. */
function setSafetyValue(root: string, value: unknown): void {
  const doc = readJson(root, SAFETY_KEY_FILE);
  doc[SAFETY_KEY] = value;
  writeJson(root, SAFETY_KEY_FILE, doc);
}

test('CONTROL — the committed catalogues pass, and the pair count is the product of two independent readings', () => {
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  assert.equal(run.code, 0, run.out);
  // The expected number is computed here from the package's own exports, not
  // copied from the gate's output, so this assertion is a second instrument
  // rather than the gate agreeing with itself.
  const expected = strictKeys().length * enabledLocales().length;
  assert.ok(expected > 0, 'the package declares no strict keys or no enabled locales');
  assert.ok(
    run.out.includes(`examined ${String(expected)} (locale, key) pair(s)`),
    `reading A did not examine ${String(expected)} pairs\n${run.out}`,
  );
  assert.ok(
    run.out.includes(`examined ${String(expected)} compiled (locale, key) pair(s)`),
    `reading B did not examine ${String(expected)} pairs\n${run.out}`,
  );
});

test('CONTROL — an unmutated copy of the catalogues passes under --root, and the banner says the compiled catalogue was not read', () => {
  attack(
    () => {},
    () => true,
    'PASS',
    ['READINGS B AND C NOT RUN'],
  );
});

test('a safety_critical key deleted from ru is refused, naming the key, the tier and the locale', () => {
  attack(
    (root) => {
      const doc = readJson(root, SAFETY_KEY_FILE);
      delete doc[SAFETY_KEY];
      writeJson(root, SAFETY_KEY_FILE, doc);
    },
    (root) => !(SAFETY_KEY in readJson(root, SAFETY_KEY_FILE)),
    'FAIL',
    ["MISSING 'session.checkins_missed' (safety_critical) in ru", 'catalogues/ru/session.json'],
  );
});

test('a transactional key deleted from el is refused', () => {
  attack(
    (root) => {
      const doc = readJson(root, join('catalogues', 'el', 'legal.json'));
      delete doc['terms.accept'];
      writeJson(root, join('catalogues', 'el', 'legal.json'), doc);
    },
    (root) => !('terms.accept' in readJson(root, join('catalogues', 'el', 'legal.json'))),
    'FAIL',
    ["MISSING 'legal.terms.accept' (transactional) in el"],
  );
});

test('an empty string is refused — presence is not content', () => {
  attack(
    (root) => {
      setSafetyValue(root, '');
    },
    (root) => readJson(root, SAFETY_KEY_FILE)[SAFETY_KEY] === '',
    'FAIL',
    ["CONTENT-FREE 'session.checkins_missed' (safety_critical) in ru"],
  );
});

test('a value of only invisible code points is refused', () => {
  attack(
    (root) => {
      setSafetyValue(root, '​­');
    },
    (root) => readJson(root, SAFETY_KEY_FILE)[SAFETY_KEY] === '​­',
    'FAIL',
    ['CONTENT-FREE', 'renders nothing a reader would see'],
  );
});

test('a syntactically valid ICU message with a blank plural branch is refused (SD FE-10)', () => {
  const planted = '{count, plural, one {} few {x} many {x} other {x}} {sitterName}';
  attack(
    (root) => {
      setSafetyValue(root, planted);
    },
    (root) => readJson(root, SAFETY_KEY_FILE)[SAFETY_KEY] === planted,
    'FAIL',
    ['EMPTY-MESSAGE', "the 'one' branch of plural 'count'"],
  );
});

test('a malformed ICU message is refused', () => {
  const planted = '{count, plural, one {#} other';
  attack(
    (root) => {
      setSafetyValue(root, planted);
    },
    (root) => readJson(root, SAFETY_KEY_FILE)[SAFETY_KEY] === planted,
    'FAIL',
    ['MALFORMED'],
  );
});

test('a nested object where a flat string belongs is refused', () => {
  attack(
    (root) => {
      setSafetyValue(root, { one: 'x' });
    },
    (root) => typeof readJson(root, SAFETY_KEY_FILE)[SAFETY_KEY] === 'object',
    'FAIL',
    ['NOT-A-STRING'],
  );
});

test('deleting a whole locale directory is refused, because the locale set comes from the registry and not from readdir', () => {
  attack(
    (root) => {
      rmSync(join(root, 'catalogues', 'ru'), { recursive: true, force: true });
    },
    (root) => {
      try {
        readJson(root, SAFETY_KEY_FILE);
        return false;
      } catch {
        return true;
      }
    },
    'FAIL',
    ['MISSING-CATALOGUE catalogues/ru/ does not exist', "'ru' is an ENABLED locale"],
  );
});

test('deleting one namespace file from a locale is refused', () => {
  attack(
    (root) => {
      rmSync(join(root, 'catalogues', 'ru', 'safety.json'));
    },
    (root) => {
      try {
        readJson(root, join('catalogues', 'ru', 'safety.json'));
        return false;
      } catch {
        return true;
      }
    },
    'FAIL',
    ['MISSING-CATALOGUE catalogues/ru/safety.json is absent'],
  );
});

test('re-tiering every strict key to operational does not make the gate green — it makes it say it checked nothing', () => {
  attack(
    (root) => {
      const doc = readJson(root, 'tiers.json');
      const tiers = doc['tiers'] as Record<string, string>;
      for (const key of Object.keys(tiers)) tiers[key] = 'operational';
      writeJson(root, 'tiers.json', doc);
    },
    (root) => {
      const tiers = readJson(root, 'tiers.json')['tiers'] as Record<string, string>;
      return Object.values(tiers).every((t) => t === 'operational');
    },
    'FAIL',
    ['NO-COMPARISON', 'assigns no key to safety_critical or transactional'],
  );
});

test('disabling every locale but the default does not make the gate green', () => {
  attack(
    (root) => {
      const doc = readJson(root, 'locale-registry.json');
      const rows = doc['locales'] as Record<string, unknown>[];
      for (const row of rows) if (row['code'] !== 'en') row['enabled'] = false;
      writeJson(root, 'locale-registry.json', doc);
    },
    (root) => {
      const rows = readJson(root, 'locale-registry.json')['locales'] as Record<string, unknown>[];
      return rows.filter((r) => r['enabled'] === true).length === 1;
    },
    'FAIL',
    ['NO-COMPARISON', 'enabled locale(s). A completeness gate over fewer'],
  );
});

test('a tiered key that does not exist in the default locale is refused, so the expected key set cannot be a list checking itself', () => {
  attack(
    (root) => {
      const doc = readJson(root, 'tiers.json');
      const tiers = doc['tiers'] as Record<string, string>;
      tiers['safety.invented_by_nobody'] = 'safety_critical';
      writeJson(root, 'tiers.json', doc);
    },
    (root) => {
      const tiers = readJson(root, 'tiers.json')['tiers'] as Record<string, string>;
      return tiers['safety.invented_by_nobody'] === 'safety_critical';
    },
    'FAIL',
    ["UNSOURCED-KEY 'safety.invented_by_nobody'"],
  );
});

test('a tier value that is not one of the four is refused rather than skipped', () => {
  attack(
    (root) => {
      const doc = readJson(root, 'tiers.json');
      const tiers = doc['tiers'] as Record<string, string>;
      tiers['safety.sos.confirm'] = 'safety-critical';
      writeJson(root, 'tiers.json', doc);
    },
    (root) => {
      const tiers = readJson(root, 'tiers.json')['tiers'] as Record<string, string>;
      return tiers['safety.sos.confirm'] === 'safety-critical';
    },
    'FAIL',
    ['INPUT tiers.json', "'safety.sos.confirm' has tier"],
  );
});

test('an OPERATIONAL key deleted from ru still passes — the fallback tiers are outside this gate on purpose', () => {
  attack(
    (root) => {
      const doc = readJson(root, join('catalogues', 'ru', 'notify.json'));
      delete doc['checkin.reminder'];
      writeJson(root, join('catalogues', 'ru', 'notify.json'), doc);
    },
    (root) => !('checkin.reminder' in readJson(root, join('catalogues', 'ru', 'notify.json'))),
    'PASS',
    ['GATE PASS'],
  );
});

test('a root with no locale-registry.json is refused, not treated as having nothing to check', () => {
  const root = mkdtempSync(join(tmpdir(), 't042-empty-'));
  try {
    mkdirSync(join(root, 'catalogues'));
    const run = runGate(['--root', root]);
    assert.equal(run.banner, 'FAIL', run.out);
    assert.notEqual(run.code, 0, run.out);
    assert.ok(run.out.includes('INPUT locale-registry.json'), run.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unrecognised argument exits 2 before any reading, and prints no banner', () => {
  const run = runGate(['--only=safety']);
  assert.equal(run.code, 2, run.out);
  assert.equal(run.banner, 'NONE', run.out);
  assert.ok(run.out.includes('unrecognised argument'), run.out);
});
