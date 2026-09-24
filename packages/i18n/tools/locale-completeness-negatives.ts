/**
 * `pnpm --filter @kinvara/i18n run gate:locale-completeness:negatives` — T-042.
 *
 * The committed negative cases for `gate:locale-completeness` THAT CANNOT BE
 * RUN FROM A TEMPORARY ROOT, because they are about the COMMITTED artefacts of
 * this package: `compiled/`, `tiers.json` and `locale-registry.json` as they
 * sit in the working tree. Everything that can be planted in a temporary root
 * is in `tools/locale-completeness.test.ts` instead, where `pnpm test` — and
 * therefore `gate:unit-tests` and `gate:pr` — runs it on every PR.
 *
 * Each case plants one edit in a TRACKED file, ASSERTS THE EDIT LANDED, runs
 * `node tools/locale-completeness.ts` with no arguments (the same command
 * `pnpm gate:locale-completeness` runs), judges it on the exit status, the
 * banner and the expected reason lines, then restores the file BYTE FOR BYTE
 * and asserts the restore. A CONTROL run at the start and an identical one at
 * the end bracket the whole thing.
 *
 * It refuses to start unless `git status --porcelain packages/i18n` is empty,
 * and it takes no arguments. It is NOT a `*.test.ts` file, so neither Vitest
 * nor `tools/run-tests.ts` reads it, `pnpm test` does not run it, and — like
 * `test:negatives` — NO GATE RUNS IT (OD-57 is `T-005`'s, and this script
 * inherits that status rather than changing it). It mutates the working tree,
 * so it must never run while `gate:pr` is running: `gate:pr` refuses a dirty
 * tree (`T-005` § Published contract §4).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PKG, 'tools', 'locale-completeness.ts');

interface Case {
  readonly name: string;
  readonly why: string;
  /** Repository-relative path, as git prints it. */
  readonly file: string;
  readonly plant: (s: string) => string;
  readonly expect: 'PASS' | 'FAIL';
  readonly mustInclude: readonly string[];
  readonly mustExclude: readonly string[];
}

function replaceOnce(s: string, old: string, rep: string): string {
  const at = s.indexOf(old);
  if (at < 0) throw new Error(`anchor not found: ${JSON.stringify(old.slice(0, 60))}`);
  return s.slice(0, at) + rep + s.slice(at + old.length);
}

const CASES: readonly Case[] = [
  {
    name: 'RU-KEY-REMOVED',
    why:
      "T-042's acceptance criterion: the gate fails on a deliberately removed `ru` key. " +
      'The SOURCE is edited and `compiled/` is left alone, which is the state a human is ' +
      'actually in — reading B would still find the message function.',
    file: 'packages/i18n/catalogues/ru/session.json',
    plant: (s) =>
      replaceOnce(s, '  "checkins_missed":', '  "checkins_missed_T042_REMOVED_BY_THIS_CASE":'),
    expect: 'FAIL',
    mustInclude: [
      "MISSING 'session.checkins_missed' (safety_critical) in ru",
      'it cannot ship untranslated',
      '!!  ru: {STRICT_MINUS_1}/{STRICT} strict-tier keys present',
    ],
    mustExclude: ['GATE PASS'],
  },
  {
    name: 'COMPILED-KEY-REMOVED',
    why:
      'SD §FE-10 says this gate runs against the COMPILED catalogue. Here the source is ' +
      'untouched and the committed compiled artefact has lost the message function — the ' +
      'shape a hand-edit of `compiled/` produces. Reading A is green; reading B is not.',
    file: 'packages/i18n/compiled/ru/session.ts',
    plant: (s) => replaceOnce(s, "  'session.checkins_missed': (", "  'session.T042_RENAMED': ("),
    expect: 'FAIL',
    mustInclude: [
      "COMPILED-MISSING 'session.checkins_missed' has no compiled message function in 'ru'",
      'ok  ru: {STRICT}/{STRICT} strict-tier keys present',
    ],
    mustExclude: ['GATE PASS'],
  },
  {
    name: 'TIER-PROMOTED-WITHOUT-TRANSLATION',
    why:
      '`common.marketing.tagline` is a marketing key that exists only in `en`, which is ' +
      'permitted (SA §TS-12.1). Promoting it to `transactional` in `tiers.json` without ' +
      'recompiling must fail two ways at once: the key is now strict and untranslated ' +
      '(reading A), and `tiers.json` no longer agrees with the committed `compiled/tiers.ts` ' +
      'about the strict-tier key set (reading C).',
    file: 'packages/i18n/tiers.json',
    plant: (s) =>
      replaceOnce(
        s,
        '"common.marketing.tagline": "marketing"',
        '"common.marketing.tagline": "transactional"',
      ),
    expect: 'FAIL',
    mustInclude: [
      "MISSING 'common.marketing.tagline' (transactional) in el",
      "MISSING 'common.marketing.tagline' (transactional) in ru",
      'TIER-DRIFT tiers.json and the committed compiled/tiers.ts disagree',
    ],
    mustExclude: ['GATE PASS'],
  },
  {
    name: 'LOCALE-ENABLED-WITHOUT-CATALOGUE',
    why:
      'A fourth locale is a row in `locale-registry.json` (SA §TS-12.2 rule 5). Adding an ' +
      'ENABLED row and nothing else must refuse: every strict key is untranslated in it, and ' +
      'the committed compiled registry does not know about it either.',
    file: 'packages/i18n/locale-registry.json',
    plant: (s) =>
      replaceOnce(
        s,
        '    {\n      "code": "el",',
        '    {\n      "code": "tr",\n      "endonym": "Türkçe",\n      "direction": "ltr",\n' +
          '      "isSafetyLanguage": false,\n      "pluralCategories": ["one", "other"],\n' +
          '      "enabled": true\n    },\n    {\n      "code": "el",',
      ),
    expect: 'FAIL',
    mustInclude: [
      'MISSING-CATALOGUE catalogues/tr/ does not exist',
      'LOCALE-DRIFT locale-registry.json enables',
    ],
    mustExclude: ['GATE PASS'],
  },
  {
    name: 'COMPILED-UNLOADABLE',
    why:
      "A broken `compiled/` must produce this gate's OWN banner, not an uncaught exception. " +
      '"Did nothing", "refused" and "crashed" have to be three distinguishable outcomes ' +
      '(PROTOCOL §5.1) — and the reason line must be the diagnosis, not a stack trace.',
    file: 'packages/i18n/compiled/index.ts',
    plant: (s) => `${s}\nexport const T042_BROKEN = (;\n`,
    expect: 'FAIL',
    mustInclude: [
      'COMPILED-UNREADABLE the committed compiled catalogue could not be loaded',
      'examined {PAIRS} (locale, key) pair(s)',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
];

/* ------------------------------------------------------------------ driver */

const REPO = join(PKG, '..', '..');

function git(args: readonly string[]): string {
  const r = spawnSync('git', [...args], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function runGate(): { code: number; out: string; banner: string } {
  const r = spawnSync(process.execPath, [GATE_SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const pass = /^GATE PASS {2}gate:locale-completeness/m.test(out);
  const fail = /^GATE FAIL {2}gate:locale-completeness/m.test(out);
  let banner = 'NONE';
  if (pass && fail) banner = 'BOTH';
  else if (pass) banner = 'PASS';
  else if (fail) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

if (process.argv.length > 2) {
  console.error('locale-completeness-negatives: takes no arguments');
  process.exit(2);
}

const dirty = git(['status', '--porcelain', 'packages/i18n']).trim();
if (dirty !== '') {
  console.error('REFUSED: packages/i18n is not clean. Commit first — this script mutates it.');
  console.error(dirty);
  process.exit(2);
}

let unexpected = 0;
let ran = 0;

console.log('CONTROL — the committed tree');
const control = runGate();
console.log(control.out.trimEnd());
if (control.banner !== 'PASS' || control.code !== 0) {
  console.error('!! CONTROL did not pass; every case below would be meaningless.');
  process.exit(1);
}

/**
 * The two numbers a case's expected lines need are taken from the CONTROL run
 * rather than typed here, so that adding a strict-tier key or a locale does
 * not silently turn a case into a HARNESS ERROR nobody reads (PROTOCOL §5.3
 * R1: prefer a number the machine prints).
 */
const pairsMatch = /examined ([0-9]+) \(locale, key\) pair\(s\)/.exec(control.out);
const strictMatch = /ok {2}en: ([0-9]+)\/([0-9]+) strict-tier keys present/.exec(control.out);
if (pairsMatch?.[1] === undefined || strictMatch?.[2] === undefined) {
  console.error('!! CONTROL printed neither the pair count nor the per-locale count');
  process.exit(1);
}
const PAIRS = pairsMatch[1];
const STRICT = strictMatch[2];
const STRICT_MINUS_1 = String(Number(STRICT) - 1);
function fill(s: string): string {
  return s
    .replaceAll('{PAIRS}', PAIRS)
    .replaceAll('{STRICT_MINUS_1}', STRICT_MINUS_1)
    .replaceAll('{STRICT}', STRICT);
}
console.log(`  (expectations filled from CONTROL: ${PAIRS} pair(s), ${STRICT} strict key(s))`);

for (const c of CASES) {
  ran += 1;
  const abs = join(REPO, c.file);
  const before = readFileSync(abs, 'utf8');
  let planted: string;
  try {
    planted = c.plant(before);
  } catch (err) {
    console.error(
      `!! ${c.name}  HARNESS ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    unexpected += 1;
    continue;
  }
  if (planted === before) {
    console.error(`!! ${c.name}  HARNESS ERROR: the plant changed nothing`);
    unexpected += 1;
    continue;
  }
  writeFileSync(abs, planted, 'utf8');

  const problems: string[] = [];
  try {
    // The mutation is asserted from disk, not from the variable above.
    if (readFileSync(abs, 'utf8') !== planted) problems.push('the plant is not on disk');
    const run = runGate();
    if (run.banner !== c.expect) problems.push(`banner=${run.banner} expected=${c.expect}`);
    if (c.expect === 'PASS' ? run.code !== 0 : run.code === 0) {
      problems.push(`exit=${String(run.code)} expected ${c.expect === 'PASS' ? '0' : 'non-zero'}`);
    }
    for (const raw of c.mustInclude) {
      const s = fill(raw);
      if (!run.out.includes(s)) problems.push(`missing: ${s}`);
    }
    for (const s of c.mustExclude)
      if (run.out.includes(s)) problems.push(`present but banned: ${s}`);
    if (problems.length > 0) {
      console.log(run.out.trimEnd());
    } else {
      const line = run.out.split('\n').find((l) => l.startsWith('GATE ')) ?? '';
      console.log(`   ${c.name.padEnd(36)} ok  exit=${String(run.code)}  ${line}`);
    }
  } finally {
    writeFileSync(abs, before, 'utf8');
    if (readFileSync(abs, 'utf8') !== before) problems.push('RESTORE FAILED — the file differs');
  }
  if (problems.length > 0) {
    unexpected += 1;
    console.error(`!! ${c.name}  UNEXPECTED`);
    for (const p of problems) console.error(`       ${p}`);
    console.error(`       why: ${c.why}`);
  }
}

const after = git(['status', '--porcelain', 'packages/i18n']).trim();
if (after !== '') {
  unexpected += 1;
  console.error('!! the working tree was not restored:');
  console.error(after);
}

console.log('\nCONTROL (re-run on the restored tree)');
const control2 = runGate();
console.log(control2.out.trimEnd());
if (control2.out !== control.out || control2.code !== control.code) {
  unexpected += 1;
  console.error('!! the restored tree does not reproduce the CONTROL run byte for byte');
}

console.log('');
if (unexpected === 0) {
  console.log(`ALL ${String(ran)} CASES BEHAVED AS EXPECTED`);
  process.exit(0);
}
console.log(`!! ${String(unexpected)} of ${String(ran)} CASE(S) MISBEHAVED`);
process.exit(1);
