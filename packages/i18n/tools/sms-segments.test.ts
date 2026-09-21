/**
 * `gate:sms-segments` — T-046, attacked rather than observed passing.
 *
 * PROTOCOL §5.1: "Running your gate proves it executes. ATTACKING it proves
 * what it covers." Two families of case:
 *
 *   THE ARITHMETIC, in process. The segment maths is the half that is easy to
 *   get wrong in the direction that lets a three-segment message through, so
 *   every boundary is asserted on BOTH SIDES and the three traps — the UDH, the
 *   GSM-7 Greek capitals, UTF-16 code units — each get a case that would be
 *   green under the obvious wrong answer and is red under it here.
 *
 *   THE GATE, as a subprocess against a package root built in a temporary
 *   directory. Each case PLANTS one defect, ASSERTS THE PLANT LANDED by reading
 *   the file back, and judges the run on three readings a gate that did nothing
 *   could not all produce: the exit status; exactly one GATE PASS / GATE FAIL
 *   banner, so a crash is a third outcome and never counts as a refusal
 *   (PROTOCOL §5.1, OD-27); and the expected reason substring.
 *
 * THE BASELINE IS A PASS, so "would an always-failing gate pass these cases?"
 * is answered by the cases and not by argument: `the committed tree passes` and
 * `a fresh fixture root passes` are both PASS cases, and the first is the real
 * tree.
 *
 * WHAT IS NOT HERE, and is in `tools/sms-segments-negatives.ts` and the
 * evidence file instead: READING B, the committed `compiled/` artefact, which
 * cannot be planted in a temporary root (`--root` runs readings A, C and D
 * only, and says so in its banner). Same status and same reason as `T-042`'s
 * `tools/locale-completeness-negatives.ts` and `T-044`'s equivalent (OD-57).
 *
 * `T-132` § Published contract (rework 2) §2's convention holds in this file:
 * every test title is a string literal and every `test(` starts its own line.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { strictKeys, enabledLocales } from '../src/index.ts';
import {
  GSM7_BASIC,
  GSM7_EXTENSION,
  MAX_SEGMENTS,
  budgetFor,
  gsm7Septets,
  measure,
  segmentsFor,
} from './sms-encoding.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PACKAGE_ROOT, 'tools', 'sms-segments.ts');

/** The one key declared `sms: true` today, and the file its source lives in. */
const SMS_KEY = 'session.checkins_missed';
const SMS_KEY_LOCAL = 'checkins_missed';
const SMS_KEY_NS = 'session';

/* ─────────────────────────────────────────────────── the arithmetic, in process */

test('a single segment is the full 160 GSM-7 septets or 70 UCS-2 units — the UDH is paid only on concatenation', () => {
  assert.equal(segmentsFor('GSM-7', 160), 1);
  assert.equal(segmentsFor('UCS-2', 70), 1);
  assert.equal(segmentsFor('GSM-7', 161), 2);
  assert.equal(segmentsFor('UCS-2', 71), 2);
});

test('two concatenated UCS-2 segments are 134 code units, not 140: 134 is two and 135 is three', () => {
  assert.equal(budgetFor('UCS-2'), 134);
  assert.equal(segmentsFor('UCS-2', 134), 2);
  assert.equal(segmentsFor('UCS-2', 135), 3);
});

test('two concatenated GSM-7 segments are 306 septets, not 320: 306 is two and 307 is three', () => {
  assert.equal(budgetFor('GSM-7'), 306);
  assert.equal(segmentsFor('GSM-7', 306), 2);
  assert.equal(segmentsFor('GSM-7', 307), 3);
});

test('THE TRAP: the naive 2x70 reading admits a three-segment message — 140 UCS-2 units is three segments', () => {
  const m = measure('α'.repeat(140));
  assert.equal(m.encoding, 'UCS-2');
  assert.equal(m.units, 140);
  assert.ok(m.units <= 2 * 70, 'the naive reading would call 140 units two segments');
  assert.equal(m.segments, 3);
  assert.ok(m.segments > MAX_SEGMENTS);
});

test('THE TRAP: the naive 2x160 reading admits a three-segment GSM-7 message — 320 septets is three segments', () => {
  const m = measure('x'.repeat(320));
  assert.equal(m.encoding, 'GSM-7');
  assert.ok(m.units <= 2 * 160, 'the naive reading would call 320 septets two segments');
  assert.equal(m.segments, 3);
});

test('THE TRAP: the ten Greek capitals GSM-7 carries encode as GSM-7, so a Greek string is not always UCS-2', () => {
  const m = measure('ΔΦΓΛΩΠΨΣΘΞ');
  assert.equal(m.encoding, 'GSM-7');
  assert.equal(m.units, 10);
  assert.equal(m.segments, 1);
});

test('a Greek capital GSM-7 does not carry forces UCS-2 — GSM-7 holds only the Latin look-alikes', () => {
  for (const ch of 'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ') {
    assert.equal(
      gsm7Septets(ch),
      undefined,
      `U+${ch.codePointAt(0)?.toString(16)} should not be GSM-7`,
    );
  }
  assert.equal(measure('ΑΒΕ').encoding, 'UCS-2');
});

test('MEASURED, NOT INFERRED: the locale-based rule REJECTS VALID GREEK COPY at 200 characters', () => {
  const greek = 'ΔΦΓΛΩΠΨΣΘΞ'.repeat(20);
  assert.equal(greek.length, 200);
  const measured = measure(greek);
  assert.equal(measured.encoding, 'GSM-7');
  assert.equal(measured.segments, 2, 'measured: 200 septets is two GSM-7 segments');
  const assumed = segmentsFor('UCS-2', greek.length);
  assert.equal(assumed, 3, 'assumed from the locale: 200 UCS-2 units is three segments');
  assert.ok(
    assumed > measured.segments,
    'the locale-based rule is strict in the wrong direction here',
  );
});

test('and the locale-based rule is LENIENT in the other direction for a lowercase Greek string', () => {
  const greek = 'α'.repeat(140);
  assert.equal(measure(greek).segments, 3);
  assert.equal(
    segmentsFor('GSM-7', greek.length),
    1,
    'assuming GSM-7 would call 140 characters one segment',
  );
});

test('UCS-2 counts UTF-16 CODE UNITS, not code points: a non-BMP code point costs two', () => {
  const text = '\u{1F600}'.repeat(50);
  assert.equal([...text].length, 50, 'fifty code points');
  const m = measure(text);
  assert.equal(m.encoding, 'UCS-2');
  assert.equal(m.units, 100, 'one hundred UTF-16 code units');
  assert.equal(m.surrogatePairs, 50);
  assert.equal(m.segments, 2);
  assert.equal(
    segmentsFor('UCS-2', [...text].length),
    1,
    'counting code points would say one segment',
  );
});

test('a GSM-7 extension character costs TWO septets, so 160 characters can be two segments', () => {
  assert.equal(gsm7Septets('€'), 2);
  assert.equal(gsm7Septets('^{}\\[~]|'), 16);
  const text = `${'x'.repeat(159)}€`;
  assert.equal(text.length, 160);
  const m = measure(text);
  assert.equal(m.units, 161);
  assert.equal(m.segments, 2);
});

test('an em dash is not in GSM-7, so an ENGLISH catalogue string can be UCS-2', () => {
  const source = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'catalogues', 'en', 'safety.json'), 'utf8'),
  ) as Record<string, string>;
  const label = source['helpline.199.label'];
  assert.ok(label !== undefined);
  assert.ok(label.includes('—'), 'the committed string carries an em dash');
  assert.equal(measure(label).encoding, 'UCS-2');
});

test('the GSM-7 tables are the 127 basic characters and the 10 extension characters', () => {
  assert.equal(GSM7_BASIC.size, 127, '128 table positions less the ESCAPE at 0x1B');
  assert.equal(GSM7_EXTENSION.size, 10);
  assert.equal(GSM7_BASIC.has('\u001b'), false, 'ESCAPE is a prefix, not a character');
  assert.equal(gsm7Septets('\u001b'), undefined);
});

test('headroom is measured against the encoding the string actually uses, not against the longer budget', () => {
  const latin = measure('x'.repeat(66));
  const greek = measure('α'.repeat(66));
  assert.equal(latin.units, greek.units);
  assert.equal(latin.segments, greek.segments);
  assert.equal(latin.headroom, 240);
  assert.equal(greek.headroom, 68);
});

/* ───────────────────────────────────────────────── the gate, as a subprocess */

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
  const pass = /^GATE PASS {2}gate:sms-segments/m.test(out);
  const fail = /^GATE FAIL {2}gate:sms-segments/m.test(out);
  let banner: GateRun['banner'] = 'NONE';
  if (pass && fail) banner = 'BOTH';
  else if (pass) banner = 'PASS';
  else if (fail) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

/**
 * A package root holding exactly what readings A, C and D need. `compiled/` is
 * deliberately NOT copied — its modules import `../../src/runtime.ts` and
 * `intl-messageformat`, neither of which resolves from a temporary directory,
 * which is also why `--root` runs reading B not at all.
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 't046-'));
  for (const entry of ['locale-registry.json', 'tiers.json', 'review.json', 'channels.json']) {
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

/** Replace the SMS key's source string in one locale. */
function plantSource(root: string, locale: string, text: string): void {
  const rel = join('catalogues', locale, `${SMS_KEY_NS}.json`);
  const ns = readJson(root, rel);
  ns[SMS_KEY_LOCAL] = text;
  writeJson(root, rel, ns);
}

function sourceOf(root: string, locale: string): unknown {
  return readJson(root, join('catalogues', locale, `${SMS_KEY_NS}.json`))[SMS_KEY_LOCAL];
}

/**
 * THE BOUNDARY FIXTURE. Replace the SMS key's source in EVERY enabled locale
 * with a parameterless literal, and drop the `worst_case` block, so that the
 * string the gate measures is exactly the string written here and the boundary
 * cases are about the arithmetic and nothing else. Locales not named get a
 * short literal.
 *
 * Both halves are needed. Leaving `worst_case` in place with a parameterless
 * message is PARAM-SURPLUS; leaving the other locales' ICU templates in place
 * with `worst_case` gone is PARAM-UNDECLARED. Both are true refusals, and
 * neither is the one being demonstrated.
 */
function plantLiteralEverywhere(root: string, byLocale: Readonly<Record<string, string>>): void {
  const channels = readJson(root, 'channels.json');
  const map = channels['channels'] as Record<string, Record<string, unknown>>;
  const entry = { ...map[SMS_KEY] };
  delete entry['worst_case'];
  map[SMS_KEY] = entry;
  writeJson(root, 'channels.json', channels);
  for (const locale of ['en', 'el', 'ru']) {
    plantSource(root, locale, byLocale[locale] ?? 'ok');
  }
}

function editChannel(root: string, key: string, patch: Record<string, unknown> | null): void {
  const channels = readJson(root, 'channels.json');
  const map = channels['channels'] as Record<string, Record<string, unknown>>;
  if (patch === null) delete map[key];
  else map[key] = { ...map[key], ...patch };
  writeJson(root, 'channels.json', channels);
}

/**
 * Run one case. `plant` mutates the root and `landed` must then return true — a
 * mutation that did not land would otherwise let a case report a verdict about
 * an unmodified tree (PROTOCOL §5.1, the `T-039` harness defect: four probes
 * silently changed nothing and reported GATE PASS on an unmutated tree).
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
    assert.ok(landed(root), 'the plant did not land; the run below would judge an unmutated tree');
    const run = runGate(['--root', root]);
    assert.equal(run.banner, expect, `expected exactly one ${expect} banner\n${run.out}`);
    assert.equal(run.code, expect === 'PASS' ? 0 : 1, run.out);
    for (const reason of reasons) {
      assert.ok(run.out.includes(reason), `expected ${JSON.stringify(reason)} in:\n${run.out}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('CONTROL: the committed tree passes, with every reading run', () => {
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  assert.equal(run.code, 0, run.out);
  assert.ok(run.out.includes('compiled artefact:'), 'reading B ran');
  assert.ok(run.out.includes('reading D (review.json § pipeline.assignments)'), 'reading D ran');
});

test('CONTROL: a fresh fixture root passes, so the refusal cases below are not an always-red gate', () => {
  attack(
    () => undefined,
    () => true,
    'PASS',
    ['SMS TEMPLATES', 'asserted 3 (locale, key) pair(s)'],
  );
});

test('ANTI-VACUITY CONTROL: the pair count the gate prints equals strict keys x enabled locales, computed from the package exports', () => {
  const expected = strictKeys().length * enabledLocales().length;
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  assert.ok(
    run.out.includes(`examined ${String(expected)} (locale, key) pair(s)`),
    `expected the gate to have examined ${String(expected)} pairs:\n${run.out}`,
  );
});

/* ── the acceptance criterion: a Greek template over the limit, and at it ── */

test('ACCEPTANCE: a Greek SMS template EXCEEDING two segments is refused, naming the key and the locale', () => {
  attack(
    (root) => plantLiteralEverywhere(root, { el: 'α'.repeat(135) }),
    (root) => sourceOf(root, 'el') === 'α'.repeat(135),
    'FAIL',
    [
      `OVER-BUDGET '${SMS_KEY}' in el`,
      '135 UCS-2 unit(s) is 3 segments',
      'over the 2-segment budget of 134',
    ],
  );
});

test('ACCEPTANCE: a Greek SMS template AT the limit — exactly 134 UCS-2 units, two segments — passes', () => {
  attack(
    (root) => plantLiteralEverywhere(root, { el: 'α'.repeat(134) }),
    (root) => sourceOf(root, 'el') === 'α'.repeat(134),
    'PASS',
    ['el session.checkins_missed', 'UCS-2  134 unit(s) 2 segment(s), headroom 0 unit(s)'],
  );
});

test('the off-by-one is on the 67-unit side: 140 units — the naive 2x70 — is refused as three segments', () => {
  attack(
    (root) => plantLiteralEverywhere(root, { el: 'α'.repeat(140) }),
    (root) => sourceOf(root, 'el') === 'α'.repeat(140),
    'FAIL',
    ['140 UCS-2 unit(s) is 3 segments'],
  );
});

test('a realistic long Greek sentence over the budget is refused, with the shortfall named', () => {
  const greek =
    'Δεν καταγράφηκαν οι προγραμματισμένες καταγραφές από τη φύλακα και ο υπεύθυνος προστασίας παιδιού προσπαθεί ήδη να επικοινωνήσει μαζί σας τώρα.';
  attack(
    (root) => plantLiteralEverywhere(root, { el: greek }),
    (root) => sourceOf(root, 'el') === greek,
    'FAIL',
    ['OVER-BUDGET', 'Shorten it by at least'],
  );
});

test('the GSM-7 boundary has two sides too: 306 septets passes and 307 is refused', () => {
  attack(
    (root) => plantLiteralEverywhere(root, { en: 'x'.repeat(306) }),
    (root) => sourceOf(root, 'en') === 'x'.repeat(306),
    'PASS',
    ['GSM-7  306 unit(s) 2 segment(s), headroom 0 unit(s)'],
  );
  attack(
    (root) => plantLiteralEverywhere(root, { en: 'x'.repeat(307) }),
    (root) => sourceOf(root, 'en') === 'x'.repeat(307),
    'FAIL',
    ['307 GSM-7 unit(s) is 3 segments', 'over the 2-segment budget of 306'],
  );
});

test('one non-GSM-7 character costs the WHOLE message the UCS-2 budget: 200 Latin characters plus one é is refused', () => {
  const text = `${'x'.repeat(200)}α`;
  attack(
    (root) => plantLiteralEverywhere(root, { en: text }),
    (root) => sourceOf(root, 'en') === text,
    'FAIL',
    ['201 UCS-2 unit(s) is 3 segments', 'over the 2-segment budget of 134'],
  );
});

/* ─────────────────────── the corpus definition: it cannot be emptied quietly ── */

test('declaring the only SMS key `sms: false` does NOT make the gate green — it is SMS-ESCAPE and NO-SMS-CORPUS', () => {
  attack(
    (root) => editChannel(root, SMS_KEY, { sms: false }),
    (root) =>
      (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
        SMS_KEY
      ]?.['sms'] === false,
    'FAIL',
    ['NO-SMS-CORPUS', `SMS-ESCAPE '${SMS_KEY}'`],
  );
});

test('deleting channels.json entirely is refused rather than producing zero findings', () => {
  attack(
    (root) => rmSync(join(root, 'channels.json')),
    (root) =>
      !readFileSync(join(root, 'tiers.json'), 'utf8').includes('\u0000') &&
      !existsSyncish(join(root, 'channels.json')),
    'FAIL',
    [
      'INPUT channels.json is absent',
      'a run that found no templates because it could not read the list of them',
    ],
  );
});

function existsSyncish(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test('a strict-tier key with no channels.json entry is refused, so the declaration cannot have a hole in it', () => {
  attack(
    (root) => editChannel(root, 'legal.terms.accept', null),
    (root) =>
      !(
        'legal.terms.accept' in
        (readJson(root, 'channels.json')['channels'] as Record<string, unknown>)
      ),
    'FAIL',
    ["CHANNEL-UNDECLARED 'legal.terms.accept'"],
  );
});

test('a channels.json entry whose `sms` is not a boolean is refused — there is no third value and no default', () => {
  attack(
    (root) => editChannel(root, 'legal.terms.accept', { sms: 'undetermined' }),
    (root) =>
      (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
        'legal.terms.accept'
      ]?.['sms'] === 'undetermined',
    'FAIL',
    ['CHANNEL-UNDECLARED', 'There is deliberately no third value'],
  );
});

test('a channels.json entry with an empty `why` is refused: the declaration is a design decision', () => {
  attack(
    (root) => editChannel(root, 'legal.terms.accept', { why: '   ' }),
    (root) =>
      (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
        'legal.terms.accept'
      ]?.['why'] === '   ',
    'FAIL',
    ["CHANNEL-UNREASONED 'legal.terms.accept'"],
  );
});

test('declaring a channel for a key that is not strict-tier is refused as drift between two files', () => {
  attack(
    (root) => editChannel(root, 'notify.checkin.reminder', { sms: true, why: 'planted' }),
    (root) =>
      'notify.checkin.reminder' in
      (readJson(root, 'channels.json')['channels'] as Record<string, unknown>),
    'FAIL',
    ['CHANNEL-SURPLUS', 'notify.checkin.reminder'],
  );
});

test('READING D: declaring a key `sms: true` whose pipeline channel is `screen` is a contradiction, not a silent win', () => {
  attack(
    (root) => editChannel(root, 'safety.helpline.199.label', { sms: true }),
    (root) =>
      (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
        'safety.helpline.199.label'
      ]?.['sms'] === true,
    'FAIL',
    ['CHANNEL-CONTRADICTION', "channel as 'screen'"],
  );
});

/* ───────────────────────────── "if it checked nothing, would it say so?" ── */

test('re-tiering every strict key to operational does NOT make the gate green', () => {
  attack(
    (root) => {
      const tiers = readJson(root, 'tiers.json');
      const map = tiers['tiers'] as Record<string, string>;
      for (const key of Object.keys(map)) map[key] = 'operational';
      writeJson(root, 'tiers.json', tiers);
    },
    (root) =>
      Object.values(readJson(root, 'tiers.json')['tiers'] as Record<string, string>).every(
        (t) => t === 'operational',
      ),
    'FAIL',
    ['NO-COMPARISON tiers.json assigns no key to a strict tier'],
  );
});

test('re-tiering ONE pinned strict key out of the strict tiers is STRICT-ESCAPE', () => {
  attack(
    (root) => {
      const tiers = readJson(root, 'tiers.json');
      (tiers['tiers'] as Record<string, string>)['legal.terms.accept'] = 'operational';
      writeJson(root, 'tiers.json', tiers);
    },
    (root) =>
      (readJson(root, 'tiers.json')['tiers'] as Record<string, string>)['legal.terms.accept'] ===
      'operational',
    'FAIL',
    ["STRICT-ESCAPE 'legal.terms.accept'"],
  );
});

test('disabling every locale does NOT make the gate green', () => {
  attack(
    (root) => {
      const reg = readJson(root, 'locale-registry.json');
      for (const row of reg['locales'] as Record<string, unknown>[]) row['enabled'] = false;
      writeJson(root, 'locale-registry.json', reg);
    },
    (root) =>
      (readJson(root, 'locale-registry.json')['locales'] as Record<string, unknown>[]).every(
        (r) => r['enabled'] === false,
      ),
    'FAIL',
    ['NO-COMPARISON locale-registry.json enables no locale'],
  );
});

test('disabling ONE locale does not silently shrink the per-locale claim — it is LOCALE-DISABLED', () => {
  attack(
    (root) => {
      const reg = readJson(root, 'locale-registry.json');
      for (const row of reg['locales'] as Record<string, unknown>[]) {
        if (row['code'] === 'el') row['enabled'] = false;
      }
      writeJson(root, 'locale-registry.json', reg);
    },
    (root) =>
      (readJson(root, 'locale-registry.json')['locales'] as Record<string, unknown>[]).some(
        (r) => r['code'] === 'el' && r['enabled'] === false,
      ),
    'FAIL',
    ["LOCALE-DISABLED 'el'"],
  );
});

test('deleting the SMS template from one locale is refused rather than examined as an absent pair', () => {
  attack(
    (root) => {
      const rel = join('catalogues', 'ru', `${SMS_KEY_NS}.json`);
      const ns = readJson(root, rel);
      delete ns[SMS_KEY_LOCAL];
      writeJson(root, rel, ns);
    },
    (root) => sourceOf(root, 'ru') === undefined,
    'FAIL',
    [`NO-SOURCE '${SMS_KEY}' has no catalogue string in 'ru'`],
  );
});

test('a tiers.json value that is not one of the four tiers is refused rather than skipped', () => {
  attack(
    (root) => {
      const tiers = readJson(root, 'tiers.json');
      (tiers['tiers'] as Record<string, string>)[SMS_KEY] = 'critical';
      writeJson(root, 'tiers.json', tiers);
    },
    (root) =>
      (readJson(root, 'tiers.json')['tiers'] as Record<string, string>)[SMS_KEY] === 'critical',
    'FAIL',
    ['INPUT tiers.json', 'which is not one of'],
  );
});

test('a locale-registry row with no pluralCategories is refused: there would be no worst case to compute', () => {
  attack(
    (root) => {
      const reg = readJson(root, 'locale-registry.json');
      for (const row of reg['locales'] as Record<string, unknown>[]) {
        if (row['code'] === 'ru') delete row['pluralCategories'];
      }
      writeJson(root, 'locale-registry.json', reg);
    },
    (root) =>
      (readJson(root, 'locale-registry.json')['locales'] as Record<string, unknown>[]).some(
        (r) => r['code'] === 'ru' && r['pluralCategories'] === undefined,
      ),
    'FAIL',
    ['INPUT locale-registry.json', 'no `pluralCategories` array'],
  );
});

/* ───────────────────────────── the worst case: the bound must be declared ── */

test('an SMS template taking a parameter with no declared worst case is refused', () => {
  attack(
    (root) => {
      const rel = join('catalogues', 'en', `${SMS_KEY_NS}.json`);
      const ns = readJson(root, rel);
      ns[SMS_KEY_LOCAL] =
        '{count, plural, one {# missed check-in} other {# missed check-ins}} from {sitterName} at {venue}';
      writeJson(root, rel, ns);
    },
    (root) => String(sourceOf(root, 'en')).includes('{venue}'),
    'FAIL',
    ["PARAM-UNDECLARED 'session.checkins_missed' in en", "'venue'"],
  );
});

test('a declared worst case for a parameter the message does not take is refused as a renamed placeholder', () => {
  attack(
    (root) =>
      editChannel(root, SMS_KEY, {
        worst_case: {
          count: { kind: 'plural', max: 9, why: 'planted' },
          sitterName: { kind: 'text', values: ['A'], why: 'planted' },
          ghost: { kind: 'text', values: ['B'], why: 'planted' },
        },
      }),
    (root) =>
      'ghost' in
      ((readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
        SMS_KEY
      ]?.['worst_case'] as Record<string, unknown>),
    'FAIL',
    ["PARAM-SURPLUS 'session.checkins_missed'", "'ghost'"],
  );
});

test('a declared bound with no `why` is refused: an expectation in the grammar of a measurement', () => {
  attack(
    (root) =>
      editChannel(root, SMS_KEY, {
        worst_case: {
          count: { kind: 'plural', max: 9 },
          sitterName: { kind: 'text', values: ['A'], why: 'planted' },
        },
      }),
    (root) =>
      (
        (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
          SMS_KEY
        ]?.['worst_case'] as Record<string, Record<string, unknown>>
      )['count']?.['why'] === undefined,
    'FAIL',
    ['CHANNEL-UNREASONED', 'worst_case.count'],
  );
});

test('a Russian SMS plural missing a category the registry declares is refused HERE as well as by T-045', () => {
  attack(
    (root) => {
      const rel = join('catalogues', 'ru', `${SMS_KEY_NS}.json`);
      const ns = readJson(root, rel);
      ns[SMS_KEY_LOCAL] =
        '{count, plural, one {Пропущена # отметка} other {Пропущено # отметки}} от {sitterName}';
      writeJson(root, rel, ns);
    },
    (root) => !String(sourceOf(root, 'ru')).includes('many {'),
    'FAIL',
    ['PLURAL-COVERAGE', "has no 'few' branch", "has no 'many' branch"],
  );
});

test('the declared substitution product is enumerated in full, never sampled — an oversized product is refused', () => {
  attack(
    (root) =>
      editChannel(root, SMS_KEY, {
        worst_case: {
          count: { kind: 'plural', max: 9, why: 'planted' },
          sitterName: {
            kind: 'text',
            values: Array.from({ length: 2048 }, (_, i) => `name-${String(i)}`),
            why: 'planted',
          },
        },
      }),
    (root) =>
      (
        (
          (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
            SMS_KEY
          ]?.['worst_case'] as Record<string, Record<string, unknown>>
        )['sitterName']?.['values'] as unknown[]
      ).length === 2048,
    'FAIL',
    ['WORST-CASE-EXPLOSION', 'never samples it'],
  );
});

test('a decomposed (non-NFC) SMS string is refused: the decomposed form costs more UTF-16 code units', () => {
  const composed = 'ά'.repeat(60);
  const decomposed = composed.normalize('NFD');
  attack(
    (root) => plantLiteralEverywhere(root, { el: decomposed }),
    (root) => sourceOf(root, 'el') === decomposed && decomposed.length > composed.length,
    'FAIL',
    ['NOT-NFC', 'in el'],
  );
});

test('narrowing the declared plural bound does NOT make the gate green — the bound itself is pinned', () => {
  attack(
    (root) =>
      editChannel(root, SMS_KEY, {
        worst_case: {
          count: { kind: 'plural', max: 9, why: 'planted — narrower than the pin' },
          sitterName: {
            kind: 'text',
            values: ['Konstantina Papadopoulou-Hadjigeorgiou'],
            why: 'planted',
          },
        },
      }),
    (root) =>
      (
        (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
          SMS_KEY
        ]?.['worst_case'] as Record<string, Record<string, unknown>>
      )['count']?.['max'] === 9,
    'FAIL',
    ['WORST-CASE-NARROWED', 'worst_case.count', 'the declared plural bound is 9'],
  );
});

test('replacing the declared names with short ones does NOT make the gate green: the pin is on LENGTH', () => {
  attack(
    (root) =>
      editChannel(root, SMS_KEY, {
        worst_case: {
          count: { kind: 'plural', max: 999, why: 'planted' },
          sitterName: { kind: 'text', values: ['A', 'B', 'C'], why: 'planted — three of them' },
        },
      }),
    (root) =>
      (
        (
          (readJson(root, 'channels.json')['channels'] as Record<string, Record<string, unknown>>)[
            SMS_KEY
          ]?.['worst_case'] as Record<string, Record<string, unknown>>
        )['sitterName']?.['values'] as unknown[]
      ).length === 3,
    'FAIL',
    ['WORST-CASE-NARROWED', 'worst_case.sitterName', 'the longest declared value is 1'],
  );
});

/* ─────────────────────────────────────────────── the command's own surface ── */

test('an unrecognised argument exits 2 before any reading, with no banner', () => {
  const run = runGate(['--only=el']);
  assert.equal(run.code, 2);
  assert.equal(run.banner, 'NONE', run.out);
  assert.ok(run.out.includes('unrecognised argument'), run.out);
});

test('--root with no directory exits 2', () => {
  const run = runGate(['--root']);
  assert.equal(run.code, 2);
  assert.equal(run.banner, 'NONE', run.out);
});

test('a --root run says SOURCE READING ONLY on the PASS path, so it cannot be pasted as a full run', () => {
  const root = makeRoot();
  try {
    const run = runGate(['--root', root]);
    assert.equal(run.banner, 'PASS', run.out);
    assert.ok(run.out.includes('SOURCE READING ONLY'), run.out);
    assert.ok(run.out.includes('READING B NOT RUN'), run.out);
    assert.equal(run.out.includes('compiled artefact:'), false, 'reading B must not have run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a --root run says SOURCE READING ONLY on the FAIL path too', () => {
  attack(
    (root) => plantLiteralEverywhere(root, { el: 'α'.repeat(135) }),
    (root) => sourceOf(root, 'el') === 'α'.repeat(135),
    'FAIL',
    ['SOURCE READING ONLY'],
  );
});

/* ─── the worst case covers every branch of every branching ELEMENT (QA-F1 · T-176) ─── */

/**
 * T-046 rework 1. `qa-verification` falsified the sentence this whole gate
 * rests on — that the declared worst case is the worst — with ordinary ICU
 * idiom: an explicit `=0` branch. It is matched BEFORE any category rule, and
 * the old candidate set had one value per REGISTRY-declared CLDR category, so
 * `=0` was never bound, never rendered and never measured. The plant below is
 * QA's own: the committed Greek template with a long `=0` branch, which sends
 * 171 UCS-2 units — three segments — while the gate printed
 * `1 segment(s), headroom 69` and exited 0.
 *
 * Every case in this block would be GREEN under the old rule and is RED (or
 * names its branch) under the new one, which is the only property that makes
 * them worth committing.
 *
 * THE GAP THIS BLOCK USED TO DECLARE IS CLOSED (T-176), AND ITS CASES ARE IN
 * THE T-176 BLOCK AT THE END OF THIS FILE. What stood here said that the shape
 * is keyed by PARAMETER NAME, that a parameter branched on by more than one
 * element keeps only the LAST element's branches, that `PLURAL-UNREACHABLE`
 * could not see the difference, and that there was DELIBERATELY NO CASE for
 * either the `plural` or the `select` form because the gap was open. All of
 * that was true at `c140093` and none of it is true now: the candidate set is
 * one value per BRANCH SIGNATURE over EVERY site, and both forms are planted
 * and red (`T-176: the same parameter pluralised TWICE…`, `T-176: the same
 * parameter selected TWICE…`).
 *
 * TWO OF THE THREE NARROWER BOUNDS THAT STOOD HERE ARE ALSO CLOSED, and the
 * third is not — read it as still live:
 *
 *  - the `offset:` case below proves the `one` branch is REACHED. It still does
 *    not prove the candidate is the WORST one, but that is no longer a gap:
 *    the ranking is now on the strings the message INSERTS, and
 *    `T-176: with an `offset:`, the candidate is the value `#` renders longest`
 *    is the case for it.
 *  - an explicit `=N` OUTSIDE the declared [0, max] is bound at its own value.
 *    STILL reasoned, not planted: no committed message has one.
 *  - "the pin is on LENGTH" means LENGTH AND NOT SCRIPT. **Still open.**
 *    Replacing the declared Greek name with a 38-character LATIN one keeps
 *    `WORST_CASE_FLOOR` satisfied and retires the cross-script measurement; no
 *    case here catches that, and the warning lives beside the names in
 *    channels.json. It is not T-176's — T-176 owns the candidate model, not the
 *    declaration's own review.
 */
const GREEK_ZERO_BRANCH =
  'Καμία χαμένη καταγραφή από {sitterName} σήμερα. Όλα τα check-in ολοκληρώθηκαν κανονικά ' +
  'και δεν χρειάζεται καμία ενέργεια από εσάς αυτή τη στιγμή.';

const GREEK_WITH_ZERO =
  `{count, plural, =0 {${GREEK_ZERO_BRANCH}} ` +
  'one {# χαμένη καταγραφή από {sitterName}} other {# χαμένες καταγραφές από {sitterName}}}';

test('QA-F1: an explicit `=0` plural branch IS rendered — a long Greek `=0` branch is three segments and is REFUSED', () => {
  attack(
    (root) => plantSource(root, 'el', GREEK_WITH_ZERO),
    (root) => String(sourceOf(root, 'el')).includes('=0 {Καμία'),
    'FAIL',
    ['OVER-BUDGET', "'session.checkins_missed' in el", 'is 3 segments', '"count":0'],
  );
});

test('QA-F1: an explicit `=0` branch that fits passes, and the run NAMES the branch it bound', () => {
  attack(
    (root) =>
      plantSource(
        root,
        'el',
        '{count, plural, =0 {Καμία χαμένη καταγραφή από {sitterName}} ' +
          'one {# χαμένη καταγραφή από {sitterName}} other {# χαμένες καταγραφές από {sitterName}}}',
      ),
    (root) => String(sourceOf(root, 'el')).includes('=0 {'),
    'PASS',
    ['declares explicit branch(es) [=0]'],
  );
});

test('a plural `offset:` is applied before the category is selected, so the `one` branch is reached and measured', () => {
  const longOne =
    'Μία ακόμη χαμένη καταγραφή από {sitterName} πέρα από όσες σας έχουν ήδη σταλεί σήμερα, ' +
    'και η φύλαξη συνεχίζεται κανονικά προς το παρόν χωρίς καμία άλλη ενέργεια.';
  attack(
    (root) =>
      plantSource(
        root,
        'el',
        `{count, plural, offset:1 one {${longOne}} other {# χαμένες καταγραφές από {sitterName}}}`,
      ),
    (root) => String(sourceOf(root, 'el')).includes('offset:1'),
    'FAIL',
    ['OVER-BUDGET', "'session.checkins_missed' in el", 'is 3 segments', 'Μία ακόμη'],
  );
});

test('a `selectordinal` is REFUSED rather than measured against the cardinal categories the registry declares', () => {
  attack(
    (root) =>
      plantSource(
        root,
        'en',
        '{count, selectordinal, one {#st from {sitterName}} two {#nd from {sitterName}} ' +
          'few {#rd from {sitterName}} other {#th from {sitterName}}}',
      ),
    (root) => String(sourceOf(root, 'en')).includes('selectordinal'),
    'FAIL',
    ['PLURAL-ORDINAL', "'count' is a `selectordinal`", 'CARDINAL set'],
  );
});

test('a declared branch NOTHING in the domain renders is PLURAL-UNREACHABLE — the mirror of QA-F1', () => {
  attack(
    (root) =>
      plantSource(
        root,
        'el',
        '{count, plural, one {# χαμένη καταγραφή από {sitterName}} ' +
          'many {# χαμένων καταγραφών από {sitterName}} ' +
          'other {# χαμένες καταγραφές από {sitterName}}}',
      ),
    (root) => String(sourceOf(root, 'el')).includes('many {'),
    'FAIL',
    ['PLURAL-UNREACHABLE', "renders the plural branch 'many'"],
  );
});

test('a category branch SHADOWED by an explicit branch is named and NOT refused — PLURAL-COVERAGE still requires it', () => {
  attack(
    (root) =>
      plantSource(
        root,
        'en',
        '{count, plural, =1 {One missed check-in from {sitterName}} ' +
          'one {# missed check-in from {sitterName}} ' +
          'other {# missed check-ins from {sitterName}}}',
      ),
    (root) => String(sourceOf(root, 'en')).includes('=1 {'),
    'PASS',
    ['plural branch [one] is SHADOWED', 'declares explicit branch(es) [=1]'],
  );
});

test('QA-F2: the half-integer fallback takes the LONGEST half-integer in the declared domain, not the first', () => {
  // The expectation is derived from `Intl`, never from the gate's own output:
  // the `ru` `other` branch is unreachable with integers, and the longest
  // FORMATTED half-integer in [0, 999] is what the rule in § contract §5 says
  // is measured. At `6b685c5` the gate took 0.5 — the first — and printed a
  // headroom two units wider than its own rule gives.
  const rules = new Intl.PluralRules('ru');
  const fmt = new Intl.NumberFormat('ru');
  let longest = 0;
  for (let n = 0; n <= 999; n += 1) {
    const v = n + 0.5;
    if (rules.select(v) !== 'other') continue;
    longest = Math.max(longest, fmt.format(v).length);
  }
  assert.ok(longest > fmt.format(0.5).length, 'the first half-integer must not be the longest');
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  const line = run.out.split('\n').find((l) => l.includes('worst binding') && l.includes('.5'));
  assert.ok(line !== undefined, `no half-integer worst binding was printed:\n${run.out}`);
  const bound = /"count":([0-9.]+)/.exec(line);
  assert.ok(bound !== null, line);
  assert.equal(fmt.format(Number(bound[1])).length, longest, line);
});

/* ────────────────────────── T-176 — the model, and the check that is not it ─────────────────────── */

/**
 * T-046 shipped with two DECLARED gaps and a note, and `qa-verification` found
 * each member of the family by asking WHAT ELSE DOES THE CANDIDATE SET ASSUME?
 * The cases below are the four measured members, plus the two that matter most:
 * the ones that prove the CHECK is not derived from the READING.
 *
 * `regressedGate` writes a copy of the gate with one anchored line replaced,
 * asserts the anchor was unique, and runs THAT copy against a fixture root. The
 * two regressions restore T-046's behaviour exactly — its per-parameter reading
 * and its `format(v)` ranking — and the assertion is that the independent check
 * FIRES ON THEM, without having been told what the defect is. A check that
 * could not catch the defect it replaced could not catch a fifth member either.
 *
 * The temporary directory is outside the repository and carries a symlink to
 * the package's own `node_modules`, so the copy resolves `intl-messageformat`
 * exactly as the committed gate does and no untracked file is ever written into
 * the working tree (`test:negatives` refuses a dirty one, and `gate:pr` refuses
 * a dirty tree outright — `T-005` § contract §4).
 */
function regressedGate(replacements: readonly (readonly [string, string])[]): {
  dir: string;
  file: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 't176-regress-'));
  symlinkSync(join(PACKAGE_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  let src = readFileSync(GATE_SCRIPT, 'utf8');
  for (const [from, to] of replacements) {
    assert.equal(
      src.split(from).length - 1,
      1,
      `the regression anchor must be unique, or the case judges a gate it did not regress: ${from}`,
    );
    src = src.replace(from, to);
  }
  src = src
    .replace(/from '\.\.\/src\//g, `from '${join(PACKAGE_ROOT, 'src')}/`)
    .replace(
      /from '\.\/sms-encoding\.ts'/g,
      `from '${join(PACKAGE_ROOT, 'tools', 'sms-encoding.ts')}'`,
    );
  const file = join(dir, 'gate.ts');
  writeFileSync(file, src, 'utf8');
  return { dir, file };
}

/** `attack`, but against a named gate file — used for the two regressions and their controls. */
function attackWith(
  gate: string,
  plant: (root: string) => void,
  landed: (root: string) => boolean,
  expect: 'PASS' | 'FAIL',
  present: readonly string[],
  absent: readonly string[] = [],
): void {
  const root = makeRoot();
  try {
    plant(root);
    assert.ok(landed(root), 'the plant did not land; the run below would judge an unmutated tree');
    const r = spawnSync(process.execPath, [gate, '--root', root], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const pass = /^GATE PASS {2}gate:sms-segments/m.test(out);
    const fail = /^GATE FAIL {2}gate:sms-segments/m.test(out);
    assert.equal(
      pass && fail ? 'BOTH' : pass ? 'PASS' : fail ? 'FAIL' : 'NONE',
      expect,
      `expected exactly one ${expect} banner\n${out}`,
    );
    assert.equal(r.status, expect === 'PASS' ? 0 : 1, out);
    for (const reason of present) {
      assert.ok(out.includes(reason), `expected ${JSON.stringify(reason)} in:\n${out}`);
    }
    for (const reason of absent) {
      assert.ok(!out.includes(reason), `did NOT expect ${JSON.stringify(reason)} in:\n${out}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** T-046's reading: `shapeOf` keyed by parameter, keeping the LAST element only. */
const REGRESS_READING = ['      sites: list,', '      sites: list.slice(-1),'] as const;
/** T-046's ranking: longest `Intl.NumberFormat(v)` form, not longest INSERTED string. */
const REGRESS_RANKING = [
  '      let width = offsets.reduce((n, o) => n + fmt.format(v - o).length, 0);',
  '      let width = fmt.format(v).length;',
] as const;

/** `qa-verification`'s QR-3 plant: agreement in two places, the `=0` in the FIRST element. */
const EL_TWO_PLURALS =
  '{count, plural, =0 {Καμία χαμένη καταγραφή από {sitterName} σήμερα, όλα τα check-in ' +
  'ολοκληρώθηκαν κανονικά και δεν χρειάζεται καμία ενέργεια από εσάς} ' +
  'one {# χαμένη καταγραφή} other {# χαμένες καταγραφές}} από {sitterName}. ' +
  '{count, plural, one {Χρειάζεται} other {Χρειάζονται}} έλεγχο.';

/** The `select` form of the same defect: the long branch in the FIRST of two elements. */
const EL_TWO_SELECTS =
  '{tone, select, urgent {ΕΠΕΙΓΟΝ: χαμένη καταγραφή από {sitterName}. Χρειάζεται άμεση ' +
  'ενέργεια από εσάς τώρα, παρακαλούμε επικοινωνήστε αμέσως} other {Χαμένη καταγραφή}} ' +
  'από {sitterName}. {tone, select, other {Ελέγξτε}}.';

/** A filler with a full CLDR branch set, for the locales a case is not about. */
const FILLER: Readonly<Record<string, string>> = {
  en: '{count, plural, one {# a} other {# b}} {sitterName}',
  el: '{count, plural, one {# α} other {# β}} {sitterName}',
  ru: '{count, plural, one {# а} few {# б} many {# в} other {# г}} {sitterName}',
};

/** Plant a message in one locale and the full-branch filler in the other two. */
function plantOnly(root: string, locale: string, text: string): void {
  for (const other of ['en', 'el', 'ru']) {
    plantSource(root, other, other === locale ? text : (FILLER[other] ?? 'ok'));
  }
}

/**
 * The same for a `select` message: the filler must take the SAME parameters, or
 * the other two locales raise PARAM-SURPLUS and the case is judging that
 * instead of what it is about.
 */
function plantSelectOnly(root: string, locale: string, text: string): void {
  for (const other of ['en', 'el', 'ru']) {
    plantSource(
      root,
      other,
      other === locale ? text : '{tone, select, other {Missed check-in}} {sitterName}',
    );
  }
}

/** The `worst_case` a `select` case declares: `tone` and the name, and no plural. */
const SELECT_WORST_CASE: Record<string, unknown> = {
  sitterName: {
    kind: 'text',
    values: ['Konstantina Papadopoulou-Hadjigeorgiou'],
    why: 'the case',
  },
};

test('T-176: the same parameter pluralised TWICE — the FIRST element`s `=0` branch is measured, not lost', () => {
  attack(
    (root) => plantOnly(root, 'el', EL_TWO_PLURALS),
    (root) => String(sourceOf(root, 'el')).includes('=0 {Καμία'),
    'FAIL',
    [
      'OVER-BUDGET',
      "'session.checkins_missed' in el",
      '219 UCS-2 unit(s) is 4 segments',
      '"count":0',
    ],
  );
});

test('T-176: the same parameter SELECTED twice — the FIRST element`s branch is bound, and `select` had no PLURAL-COVERAGE to fall back on', () => {
  attack(
    (root) => {
      plantSelectOnly(root, 'el', EL_TWO_SELECTS);
      editChannel(root, SMS_KEY, { worst_case: SELECT_WORST_CASE });
    },
    (root) => String(sourceOf(root, 'el')).includes('{tone, select, urgent {ΕΠΕΙΓΟΝ'),
    'FAIL',
    ['OVER-BUDGET', "'session.checkins_missed' in el", 'is 3 segments', '"tone":"urgent"'],
  );
});

test('T-176: three elements on one parameter — a long branch in the MIDDLE is measured, so it is not a last-element rule either', () => {
  attack(
    (root) =>
      plantOnly(
        root,
        'el',
        '{count, plural, one {α} other {β}} {count, plural, =7 {' +
          'ΧΧΧΧΧΧΧΧΧΧ'.repeat(18) +
          '} one {γ} other {δ}} {count, plural, one {ε} other {ζ}} {sitterName}',
      ),
    (root) => String(sourceOf(root, 'el')).includes('=7 {'),
    'FAIL',
    ['OVER-BUDGET', "'session.checkins_missed' in el", '"count":7'],
  );
});

test('T-176: with an `offset:`, the candidate is the value `#` renders longest, not the value `format(v)` is longest for', () => {
  attack(
    (root) =>
      plantOnly(
        root,
        'en',
        '{count, plural, offset:100 one {one missed from {sitterName}} ' +
          'other {# missed check-ins from {sitterName} ' +
          'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}}',
      ),
    (root) => String(sourceOf(root, 'en')).includes('offset:100'),
    'FAIL',
    // `#` renders `v - 100`, so the longest inserted form in [0, 999] is at
    // v = 0 ("-100", four characters) and NOT at v = 999 ("899", three) nor at
    // T-046's pick of v = 100 ("100" ranked on the unadjusted value).
    ['OVER-BUDGET', '"count":0'],
  );
});

test('T-176: a `select` worst case declared in channels.json IS honoured — T-046 returned the message`s branch names and ignored it', () => {
  attack(
    (root) => {
      plantSelectOnly(
        root,
        'en',
        '{tone, select, other {Missed check-in}} for {tone} from {sitterName}',
      );
      editChannel(root, SMS_KEY, {
        worst_case: {
          ...SELECT_WORST_CASE,
          tone: {
            kind: 'text',
            values: ['a-declared-tone-value-that-is-not-a-branch-name-at-all-and-is-long'],
            why: 'the case',
          },
        },
      });
    },
    (root) => String(sourceOf(root, 'en')).includes('{tone, select, other'),
    'PASS',
    ['"tone":"a-declared-tone-value-that-is-not-a-branch-name-at-all-and-is-long"'],
  );
});

test('T-176: a SECOND `//`-prefixed comment key inside worst_case is a comment, not a malformed declared parameter', () => {
  attack(
    (root) => {
      const channels = readJson(root, 'channels.json');
      const map = channels['channels'] as Record<string, Record<string, unknown>>;
      const entry = { ...map[SMS_KEY] };
      const wc = { ...(entry['worst_case'] as Record<string, unknown>) };
      wc['//2'] = 'a second comment key, which T-046 refused as INPUT';
      entry['worst_case'] = wc;
      map[SMS_KEY] = entry;
      writeJson(root, 'channels.json', channels);
    },
    (root) =>
      JSON.stringify(readJson(root, 'channels.json')).includes('a second comment key, which'),
    'PASS',
    ['asserted 3 (locale, key) pair(s)'],
  );
});

test('T-176: a parameter branched on as BOTH a plural and a select is refused rather than measured against one of the two', () => {
  attack(
    (root) =>
      plantOnly(
        root,
        'en',
        '{p, plural, one {a} other {b}} {p, select, x {y} other {z}} {sitterName}',
      ),
    (root) => String(sourceOf(root, 'en')).includes('{p, select,'),
    'FAIL',
    ['PARAM-KIND-CONFLICT', "'p' is branched on as BOTH a plural and a select"],
  );
});

test('T-176: a declared domain too large to check the candidate set against ICU is REFUSED, never sampled', () => {
  attack(
    (root) => {
      plantOnly(root, 'en', FILLER['en'] ?? 'ok');
      editChannel(root, SMS_KEY, {
        worst_case: {
          count: { kind: 'plural', max: 200000, why: 'the case' },
          sitterName: {
            kind: 'text',
            values: ['Konstantina Papadopoulou-Hadjigeorgiou'],
            why: 'the case',
          },
        },
      });
    },
    (root) => JSON.stringify(readJson(root, 'channels.json')).includes('200000'),
    'FAIL',
    ['VERIFICATION-EXPLOSION', 'over the 250000 cap', 'refuses rather than sampling'],
  );
});

test('T-176: a parameter reachable only inside an ICU tag is SEEN — T-046`s shape did not traverse tag children', () => {
  attack(
    (root) =>
      plantOnly(
        root,
        'en',
        'Missed <b>{who}</b> {count, plural, one {#} other {#}} from {sitterName}',
      ),
    (root) => String(sourceOf(root, 'en')).includes('<b>{who}</b>'),
    'FAIL',
    ['PARAM-UNDECLARED', "'who' is a parameter of this message"],
  );
});

test('T-176 ANTI-VACUITY: the run PRINTS how many bindings it checked against ICU, and the number is the declared domain computed from channels.json', () => {
  // Derived from the DECLARATION and from Intl, never from the gate's output:
  // the integers in [0, max], the same count of half-integers, times the
  // declared names. If the check ever examined nothing, this is the line that
  // would say so — `verified 0 binding(s)` — rather than the gate passing.
  const channels = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'channels.json'), 'utf8')) as Record<
    string,
    Record<string, Record<string, Record<string, Record<string, unknown>>>>
  >;
  const wc = channels['channels']?.[SMS_KEY]?.['worst_case'];
  const max = wc?.['count']?.['max'];
  const names = wc?.['sitterName']?.['values'];
  assert.equal(typeof max, 'number');
  assert.ok(Array.isArray(names));
  const expected = 2 * (Number(max) + 1) * (names as unknown[]).length;
  const run = runGate([]);
  assert.equal(run.banner, 'PASS', run.out);
  assert.ok(
    run.out.includes(`verified ${String(expected)} binding(s) of the declared domain`),
    `expected the gate to have verified ${String(expected)} bindings:\n${run.out}`,
  );
  assert.ok(
    run.out.includes('4 of 4 declared branch(es)'),
    `expected all four ru branches to have been rendered by the measured set:\n${run.out}`,
  );
});

test('T-176 THE CHECK IS NOT THE READING: regressing the reading to T-046`s per-parameter one makes the gate refuse ITSELF with CANDIDATE-INCOMPLETE', () => {
  const regressed = regressedGate([REGRESS_READING]);
  try {
    attackWith(
      regressed.file,
      (root) => plantOnly(root, 'el', EL_TWO_PLURALS),
      (root) => String(sourceOf(root, 'el')).includes('=0 {Καμία'),
      'FAIL',
      [
        'CANDIDATE-INCOMPLETE',
        "ICU renders branch '=0' of the plural element #0 on 'count'",
        'NO binding this gate measured ever rendered it',
        '4 of 5 declared branch(es)',
      ],
    );
  } finally {
    rmSync(regressed.dir, { recursive: true, force: true });
  }
});

test('T-176 THE CONTROL: the DELIVERED reading renders all five branches and CANDIDATE-INCOMPLETE does not fire on the same plant', () => {
  const control = regressedGate([]);
  try {
    attackWith(
      control.file,
      (root) => plantOnly(root, 'el', EL_TWO_PLURALS),
      (root) => String(sourceOf(root, 'el')).includes('=0 {Καμία'),
      'FAIL',
      ['5 of 5 declared branch(es)', 'OVER-BUDGET', '219 UCS-2 unit(s) is 4 segments'],
      ['CANDIDATE-INCOMPLETE'],
    );
  } finally {
    rmSync(control.dir, { recursive: true, force: true });
  }
});

test('T-176 THE CHECK IS NOT THE RANKING: regressing the ranking to `format(v)` makes the gate refuse itself with CANDIDATE-UNDERSTATED', () => {
  const regressed = regressedGate([REGRESS_RANKING]);
  const plant = (root: string): void =>
    plantOnly(
      root,
      'en',
      '{count, plural, offset:100 one {one missed from {sitterName}} ' +
        'other {# missed check-ins from {sitterName} ' +
        'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}}',
    );
  const landed = (root: string): boolean => String(sourceOf(root, 'en')).includes('offset:100');
  try {
    attackWith(regressed.file, plant, landed, 'FAIL', [
      'CANDIDATE-UNDERSTATED',
      'The reduction kept the wrong representative of a branch signature',
    ]);
  } finally {
    rmSync(regressed.dir, { recursive: true, force: true });
  }
  const control = regressedGate([]);
  try {
    attackWith(control.file, plant, landed, 'FAIL', ['OVER-BUDGET'], ['CANDIDATE-UNDERSTATED']);
  } finally {
    rmSync(control.dir, { recursive: true, force: true });
  }
});

test('T-176 MEMBER FIVE, found by asking the model its own question: a `select` parameter that is also PRINTED needs a declared worst case', () => {
  // The candidate set assumed a `select` parameter's value set is its BRANCH
  // NAMES. True of what it SELECTS; false of what it PRINTS. Measured at
  // `b58b713` before the fix: the gate printed `69 unit(s) 1 segment(s),
  // headroom 65` and exited 0 while ICU sent 214 units — FOUR segments — at a
  // 150-character `tone`.
  attack(
    (root) => {
      plantSelectOnly(
        root,
        'en',
        '{tone, select, other {Missed check-in}} — {tone} — from {sitterName}',
      );
      editChannel(root, SMS_KEY, { worst_case: SELECT_WORST_CASE });
    },
    (root) => String(sourceOf(root, 'en')).includes('— {tone} —'),
    'FAIL',
    ['PARAM-UNDECLARED', "'tone' selects a branch AND is printed", 'they bound nothing about'],
  );
});

test('T-176 and its converse: a `select` parameter that is NEVER printed needs no declaration, because its branch names determine the render', () => {
  attack(
    (root) => {
      plantSelectOnly(root, 'en', '{tone, select, urgent {Urgent} other {Missed}} {sitterName}');
      editChannel(root, SMS_KEY, { worst_case: SELECT_WORST_CASE });
    },
    (root) => String(sourceOf(root, 'en')).includes('urgent {Urgent}'),
    'PASS',
    ['"tone":"urgent"', 'asserted 3 (locale, key) pair(s)'],
  );
});
