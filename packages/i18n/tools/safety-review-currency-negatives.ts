/**
 * `pnpm --filter @kinvara/i18n run gate:safety-review-currency:negatives` — T-044.
 *
 * The committed negative cases for `gate:safety-review-currency` THAT CANNOT BE
 * RUN FROM A TEMPORARY ROOT, because they are about the COMMITTED artefacts of
 * this package as they sit in the working tree: `review.json`, `tiers.json`,
 * `locale-registry.json` and `compiled/`. Everything that can be planted in a
 * temporary root is in `tools/safety-review-currency.test.ts` instead, where
 * `pnpm test` — and therefore `gate:unit-tests` and `gate:pr` — runs it on
 * every PR.
 *
 * TWO OF THESE ARE THE TICKET'S ACCEPTANCE CRITERION on the real tree: a
 * `safety_critical` string with a STALE review record, and one with an ABSENT
 * one. Both are reached without inventing a review record and without moving
 * any entry to `signed_off`: the plant takes ONE key out of the waiver's `keys`
 * list, which is exactly the shape of `T-049` delivering that key (the waiver
 * pin is a subset check precisely so that partial delivery is free — T-040
 * QA-F4), and then staleness or absence is planted over the real placeholder
 * record.
 *
 * Each case plants one edit in each of one or more TRACKED files, ASSERTS THE
 * EDITS LANDED, runs `node tools/safety-review-currency.ts` with no arguments
 * (the same command `pnpm gate:safety-review-currency` runs), judges it on the
 * exit status, the banner and the expected reason lines, then restores every
 * file BYTE FOR BYTE and asserts the restore. A CONTROL run at the start and an
 * identical one at the end bracket the whole thing.
 *
 * It refuses to start unless `git status --porcelain packages/i18n` is empty,
 * and it takes no arguments. It is NOT a `*.test.ts` file, so neither Vitest
 * nor `tools/run-tests.ts` reads it, `pnpm test` does not run it, and — like
 * `test:negatives` and `T-042`'s equivalent — NO GATE RUNS IT (OD-57 is
 * `T-005`'s; this script inherits that status rather than changing it). It
 * mutates the working tree, so it must never run while `gate:pr` is running:
 * `gate:pr` refuses a dirty tree (`T-005` § Published contract §4).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PKG, 'tools', 'safety-review-currency.ts');

const REVIEW = 'packages/i18n/review.json';
const TIERS = 'packages/i18n/tiers.json';
const REGISTRY = 'packages/i18n/locale-registry.json';
const CATALOGUE_RU = 'packages/i18n/catalogues/ru/session.json';
const COMPILED = 'packages/i18n/compiled/index.ts';

/** The waived `safety_critical` key these cases use. */
const KEY = 'session.checkins_missed';

interface Edit {
  /** Repository-relative path, as git prints it. */
  readonly file: string;
  readonly plant: (s: string) => string;
}

interface Case {
  readonly name: string;
  readonly why: string;
  readonly edits: readonly Edit[];
  readonly expect: 'PASS' | 'FAIL';
  readonly mustInclude: readonly string[];
  readonly mustExclude: readonly string[];
}

/** JSON in, JSON out — for plants that are easier to state as data than as text. */
function json(mutate: (doc: Record<string, unknown>) => void): (s: string) => string {
  return (s) => {
    const doc = JSON.parse(s) as Record<string, unknown>;
    mutate(doc);
    return `${JSON.stringify(doc, null, 2)}\n`;
  };
}

function waiverOf(doc: Record<string, unknown>): Record<string, unknown> {
  const w = doc['pending_pipeline'];
  if (typeof w !== 'object' || w === null) throw new Error('review.json has no pending_pipeline');
  return w as Record<string, unknown>;
}

/** Take one key out of the waiver — the shape of T-049 delivering that key. */
function unwaive(doc: Record<string, unknown>, key: string): void {
  const w = waiverOf(doc);
  const keys = w['keys'] as string[];
  if (!keys.includes(key)) throw new Error(`${key} is not in the waiver`);
  w['keys'] = keys.filter((k) => k !== key);
}

const CASES: readonly Case[] = [
  {
    name: 'DELIVERED-THEN-STALE',
    why:
      "T-044's acceptance criterion, half one: a `safety_critical` string with a STALE review " +
      'record fails the build. The key leaves the waiver (delivery) and the catalogue string is ' +
      'then edited under its record, which is what editing reviewed safety copy looks like. No ' +
      'record is signed off to reach this: the placeholder refusals fire alongside.',
    edits: [
      { file: REVIEW, plant: json((doc) => unwaive(doc, KEY)) },
      {
        file: CATALOGUE_RU,
        plant: json((doc) => {
          doc['checkins_missed'] = `${String(doc['checkins_missed'])} !!`;
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `STALE-RECORD '${KEY}' in ru`,
      'the catalogue string now hashes to sha256:',
      `PLACEHOLDER '${KEY}' in ru`,
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'DELIVERED-THEN-ABSENT',
    why:
      "T-044's acceptance criterion, half two: a `safety_critical` string with an ABSENT review " +
      'record fails the build. Absence must fail, or the gate could be satisfied by deleting ' +
      'records (T-040 § contract §6).',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          unwaive(doc, KEY);
          const entries = doc['entries'] as Record<string, Record<string, unknown>>;
          for (const locale of Object.keys(entries)) delete entries[locale]?.[KEY];
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `MISSING-RECORD '${KEY}' in en`,
      `MISSING-RECORD '${KEY}' in el`,
      `MISSING-RECORD '${KEY}' in ru`,
      'review.json has no record',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'DELIVERED-STILL-PLACEHOLDER',
    why:
      'The state this repository is actually in, with the waiver taken off one key: the record ' +
      'exists and its hash is current, and it is still engineering copy nobody reviewed. Each ' +
      'conjunct of the rule reports separately, so the failure says which one is missing.',
    edits: [{ file: REVIEW, plant: json((doc) => unwaive(doc, KEY)) }],
    expect: 'FAIL',
    mustInclude: [
      `NOT-SIGNED-OFF '${KEY}' in ru`,
      `PLACEHOLDER '${KEY}' in ru`,
      `UNREVIEWED '${KEY}' in ru`,
      `UNDATED '${KEY}' in ru`,
    ],
    mustExclude: ['GATE PASS', 'STALE-RECORD', 'CRASH'],
  },
  {
    name: 'WAIVER-LAPSED',
    why:
      'THE SELF-CLOSING PROPERTY, on the real tree. The waiver is the only reason this gate is ' +
      'green today; move its decision review date into the past and every waived pair is ' +
      'checked exactly as an unwaived one. This is what happens by itself on 2026-12-06.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          waiverOf(doc)['expected_by'] = '2026-09-19';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "WAIVER-EXPIRED the safety-copy waiver's DECISION REVIEW DATE 2026-09-19 has passed",
      'it is the decision that was due',
      `PLACEHOLDER '${KEY}' in ru`,
      "PLACEHOLDER 'safety.sos.confirm' in en",
    ],
    mustExclude: ['GATE PASS', 'BECAUSE OF THE WAIVER', 'CRASH'],
  },
  {
    name: 'WAIVER-RENEWED',
    why:
      'T-040 QA-F3: a waiver policed only by its own dates can be renewed indefinitely by ' +
      'moving them. The anchor is a literal in the gate, so a renewal is refused by a file the ' +
      'register cannot edit.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          waiverOf(doc)['expected_by'] = '2027-06-01';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: ['WAIVER-RENEWED', 'later than the 2026-12-05 anchor pinned in this gate'],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'WAIVER-EXTENDED',
    why:
      'T-040 QA-F4: the mechanism invites extending a September waiver over copy written later. ' +
      'Here a `transactional` key is promoted to `safety_critical` and added to the waiver in ' +
      'the same change — the cheapest way to make a new safety key stop failing.',
    edits: [
      {
        file: TIERS,
        plant: json((doc) => {
          (doc['tiers'] as Record<string, string>)['legal.terms.accept'] = 'safety_critical';
        }),
      },
      {
        file: REVIEW,
        plant: json((doc) => {
          const w = waiverOf(doc);
          w['keys'] = [...(w['keys'] as string[]), 'legal.terms.accept'];
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "WAIVER-EXTENDED the waiver names 'legal.terms.accept', which was not in it on 2026-09-20",
      'TIER-DRIFT',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'TIER-ESCAPE',
    why:
      "T-040 QA-F5: after T-049 clears the suite's own waiver assertions, re-tiering a safety " +
      'key is the cheapest way to make this gate check less, and nothing else guards it. The ' +
      'pin is in the gate, so the tier file cannot both be the thing checked and the source of ' +
      'the check.',
    edits: [
      {
        file: TIERS,
        plant: json((doc) => {
          (doc['tiers'] as Record<string, string>)[KEY] = 'operational';
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `TIER-ESCAPE '${KEY}' was tiered safety_critical on 2026-09-20`,
      `WAIVER-OVERREACH the waiver names '${KEY}'`,
      'TIER-DRIFT',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'LOCALE-DISABLED',
    why:
      'Disabling a locale removes all of its review records from this gate at once — the other ' +
      'half of "make the gate check less". The locale set is pinned in the gate for the same ' +
      'reason the key set is.',
    edits: [
      {
        file: REGISTRY,
        plant: json((doc) => {
          for (const row of doc['locales'] as Record<string, unknown>[]) {
            if (row['code'] === 'ru') row['enabled'] = false;
          }
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      "LOCALE-DISABLED 'ru' was an enabled locale on 2026-09-20",
      'LOCALE-DRIFT locale-registry.json enables',
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'WAIVED-NO-RECORD',
    why:
      'The waiver waives the CURRENCY of a review, not the EXISTENCE of the provenance row. ' +
      'Without this the first move anyone makes against a gate — delete what it reads — would ' +
      'be green today, because every key is waived.',
    edits: [
      {
        file: REVIEW,
        plant: json((doc) => {
          const entries = doc['entries'] as Record<string, Record<string, unknown>>;
          for (const locale of Object.keys(entries)) entries[locale] = {};
        }),
      },
    ],
    expect: 'FAIL',
    mustInclude: [
      `WAIVED-NO-RECORD '${KEY}' in ru`,
      'not the existence of the provenance row',
      "WAIVED-NO-RECORD 'safety.sos.confirm' in en",
    ],
    mustExclude: ['GATE PASS', 'CRASH'],
  },
  {
    name: 'COMPILED-UNREADABLE',
    why:
      "A broken `compiled/` must produce this gate's OWN banner, not an uncaught exception. " +
      '"Did nothing", "refused" and "crashed" have to be three distinguishable outcomes ' +
      '(PROTOCOL §5.1) — and the reason line must be the diagnosis, not a stack trace.',
    edits: [{ file: COMPILED, plant: (s) => `${s}\nexport const T044_BROKEN = (;\n` }],
    expect: 'FAIL',
    mustInclude: [
      'COMPILED-UNREADABLE the committed compiled artefact could not be loaded',
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
  const pass = /^GATE PASS {2}gate:safety-review-currency/m.test(out);
  const fail = /^GATE FAIL {2}gate:safety-review-currency/m.test(out);
  let banner = 'NONE';
  if (pass && fail) banner = 'BOTH';
  else if (pass) banner = 'PASS';
  else if (fail) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

if (process.argv.length > 2) {
  console.error('safety-review-currency-negatives: takes no arguments');
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
 * The pair count a case's expected lines need is taken from the CONTROL run
 * rather than typed here, so that adding a safety key or a locale does not
 * silently turn a case into a HARNESS ERROR nobody reads (PROTOCOL §5.3 R1:
 * prefer a number the machine prints).
 */
const pairsMatch = /examined ([0-9]+) \(locale, key\) pair\(s\)/.exec(control.out);
if (pairsMatch?.[1] === undefined) {
  console.error('!! CONTROL printed no pair count');
  process.exit(1);
}
const PAIRS = pairsMatch[1];
function fill(s: string): string {
  return s.replaceAll('{PAIRS}', PAIRS);
}
console.log(`  (expectations filled from CONTROL: ${PAIRS} pair(s))`);

for (const c of CASES) {
  ran += 1;
  const originals = new Map<string, string>();
  const problems: string[] = [];
  try {
    for (const edit of c.edits) {
      const abs = join(REPO, edit.file);
      const before = readFileSync(abs, 'utf8');
      originals.set(edit.file, before);
      const planted = edit.plant(before);
      if (planted === before) throw new Error(`the plant changed nothing in ${edit.file}`);
      writeFileSync(abs, planted, 'utf8');
      // The mutation is asserted from disk, not from the variable above.
      if (readFileSync(abs, 'utf8') !== planted)
        throw new Error(`the plant is not on disk: ${edit.file}`);
    }
    const run = runGate();
    if (run.banner !== c.expect) problems.push(`banner=${run.banner} expected=${c.expect}`);
    if (c.expect === 'PASS' ? run.code !== 0 : run.code === 0) {
      problems.push(`exit=${String(run.code)} expected ${c.expect === 'PASS' ? '0' : 'non-zero'}`);
    }
    for (const raw of c.mustInclude) {
      const s = fill(raw);
      if (!run.out.includes(s)) problems.push(`missing: ${s}`);
    }
    for (const s of c.mustExclude) {
      if (run.out.includes(s)) problems.push(`present but banned: ${s}`);
    }
    if (problems.length > 0) {
      console.log(run.out.trimEnd());
    } else {
      const line = run.out.split('\n').find((l) => l.startsWith('GATE ')) ?? '';
      console.log(`   ${c.name.padEnd(28)} ok  exit=${String(run.code)}  ${line}`);
    }
  } catch (err) {
    problems.push(`HARNESS ERROR: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const [file, before] of originals) {
      const abs = join(REPO, file);
      writeFileSync(abs, before, 'utf8');
      if (readFileSync(abs, 'utf8') !== before) problems.push(`RESTORE FAILED: ${file}`);
    }
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
