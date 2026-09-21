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
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
