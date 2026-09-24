/**
 * `pnpm --filter @kinvara/i18n run gate:sms-segments:negatives` — T-046.
 *
 * The committed negative cases for `gate:sms-segments` THAT CANNOT BE RUN FROM
 * A TEMPORARY ROOT, because they are about the COMMITTED artefacts of this
 * package as they sit in the working tree: `channels.json`, `tiers.json`,
 * `locale-registry.json`, `catalogues/` and — the reason this file exists —
 * `compiled/`, which `--root` runs never read. Everything that can be planted
 * in a temporary root is in `tools/sms-segments.test.ts` instead, where
 * `pnpm test` — and therefore `gate:unit-tests` and `gate:pr` — runs it on
 * every PR.
 *
 * TWO OF THESE ARE THE TICKET'S ACCEPTANCE CRITERION ON THE REAL TREE, ON THE
 * REAL GREEK TEMPLATE, WITH THE REAL DECLARED SUBSTITUTION: the committed
 * `catalogues/el/session.json` string is padded so that its WORST-CASE RENDER
 * is exactly 134 UCS-2 code units (two segments — PASS, headroom 0) and then
 * exactly 135 (three segments — FAIL). The pad lengths are not typed here: they
 * are computed from the unit count the CONTROL run PRINTS, so that changing the
 * catalogue copy or the declared worst case moves the pad rather than silently
 * turning a case into a harness error (PROTOCOL §5.3 R1 — prefer a number the
 * machine prints).
 *
 * Each case plants one edit in each of one or more TRACKED files, ASSERTS THE
 * EDITS LANDED by reading them back from disk, runs `node tools/sms-segments.ts`
 * with no arguments (the same command `pnpm gate:sms-segments` runs), judges it
 * on the exit status, the banner and the expected reason lines, then restores
 * every file BYTE FOR BYTE and asserts the restore. A CONTROL run at the start
 * and an identical one at the end bracket the whole thing.
 *
 * It refuses to start unless `git status --porcelain packages/i18n` is empty,
 * and it takes no arguments. It is NOT a `*.test.ts` file, so neither Vitest
 * nor `tools/run-tests.ts` reads it, `pnpm test` does not run it, and — like
 * `test:negatives`, `T-042`'s equivalent and `T-044`'s — NO GATE RUNS IT
 * (OD-57 is `T-005`'s; this script inherits that status rather than changing
 * it). It mutates the working tree, so it must never run while `gate:pr` is
 * running: `gate:pr` refuses a dirty tree (`T-005` § Published contract §4).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PKG, 'tools', 'sms-segments.ts');

const CHANNELS = 'packages/i18n/channels.json';
const TIERS = 'packages/i18n/tiers.json';
const REGISTRY = 'packages/i18n/locale-registry.json';
const CATALOGUE_EL = 'packages/i18n/catalogues/el/session.json';
const COMPILED_EL = 'packages/i18n/compiled/el/session.ts';
const COMPILED_INDEX = 'packages/i18n/compiled/index.ts';

/** The one key declared `sms: true` today. */
const KEY = 'session.checkins_missed';
/** A Greek letter that is NOT in the GSM-7 alphabet, so each one costs one UCS-2 unit. */
const PAD = 'α';

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

/** Append `n` non-GSM-7 Greek characters to the Greek SMS template's SOURCE. */
function padGreek(n: number): (s: string) => string {
  return json((doc) => {
    doc['checkins_missed'] = `${String(doc['checkins_missed'])}${PAD.repeat(n)}`;
  });
}

/**
 * The same pad, applied to the COMMITTED COMPILED AST for the same key.
 *
 * BOTH edits are required, and finding that out was reading B working. The
 * first version of the two acceptance cases padded the catalogue source alone
 * and the gate refused them with COMPILED-DRIFT — correctly: the source said
 * 134 units and the compiled function that actually ships still said 65, so the
 * measurement would have been about a string nobody sends. The compiled AST is
 * edited here by hand rather than by running `pnpm --filter @kinvara/i18n
 * build`, because a full build rewrites every file under `compiled/` and this
 * harness restores exactly the files it planted in.
 */
function padCompiledGreek(n: number): (s: string) => string {
  return (s) => {
    const anchor = "  { type: 1, value: 'sitterName' },\n]";
    if (!s.includes(anchor))
      throw new Error('the compiled el AST does not have the shape expected');
    return s.replace(anchor, `${anchor.slice(0, -1)}  { type: 0, value: '${PAD.repeat(n)}' },\n]`);
  };
}

function buildCases(elWorstUnits: number, budget: number): readonly Case[] {
  const toLimit = budget - elWorstUnits;
  const overLimit = toLimit + 1;
  return [
    {
      name: 'ACCEPTANCE-AT-THE-LIMIT',
      why:
        "T-046's acceptance criterion, half one: the assertion PASSES AT THE LIMIT. The real " +
        `Greek template is padded by ${String(toLimit)} non-GSM-7 character(s) so its worst-case ` +
        `render is exactly ${String(budget)} UCS-2 code units — two concatenated segments at 67 ` +
        'units each, with ZERO headroom. A gate built on the single-segment figure of 70 would ' +
        'call 140 units two segments; this one calls 135 three. The compiled artefact is padded ' +
        'in the same case because reading B compares the two renders byte for byte — see ' +
        'padCompiledGreek above.',
      edits: [
        { file: CATALOGUE_EL, plant: padGreek(toLimit) },
        { file: COMPILED_EL, plant: padCompiledGreek(toLimit) },
      ],
      expect: 'PASS',
      mustInclude: [`UCS-2  ${String(budget)} unit(s) 2 segment(s), headroom 0 unit(s)`],
      mustExclude: ['GATE FAIL', 'CRASH', 'OVER-BUDGET'],
    },
    {
      name: 'ACCEPTANCE-OVER-BUDGET',
      why:
        "T-046's acceptance criterion, half two: the assertion FAILS on a Greek template " +
        'EXCEEDING two segments. One character more than the case above. The refusal names the ' +
        'key, the locale, the measured encoding, the unit count, the segment count, the budget ' +
        'and the worst binding that produced it.',
      edits: [
        { file: CATALOGUE_EL, plant: padGreek(overLimit) },
        { file: COMPILED_EL, plant: padCompiledGreek(overLimit) },
      ],
      expect: 'FAIL',
      mustInclude: [
        `OVER-BUDGET '${KEY}' in el`,
        `${String(budget + 1)} UCS-2 unit(s) is 3 segments`,
        `over the 2-segment budget of ${String(budget)}`,
        'Shorten it by at least 1 unit(s)',
      ],
      mustExclude: ['GATE PASS', 'CRASH'],
    },
    {
      name: 'SMS-CORPUS-EMPTIED',
      why:
        'The cheapest way to make this gate assert nothing is to flip the one `sms: true` flag ' +
        'to false — it deletes nothing and renames nothing. Two refusals fire: the pin in the ' +
        'gate (SMS-ESCAPE) and the floor under the corpus (NO-SMS-CORPUS). Either alone would ' +
        'be enough; both are here because the pin can be moved deliberately and the floor ' +
        'cannot be moved at all without a ticket saying so.',
      edits: [
        {
          file: CHANNELS,
          plant: json((doc) => {
            const map = doc['channels'] as Record<string, Record<string, unknown>>;
            map[KEY] = { ...map[KEY], sms: false };
          }),
        },
      ],
      expect: 'FAIL',
      mustInclude: [
        'NO-SMS-CORPUS channels.json declares no key as `sms: true`',
        `SMS-ESCAPE '${KEY}' was declared \`sms: true\` in channels.json on 2026-09-21`,
      ],
      mustExclude: ['GATE PASS', 'CRASH'],
    },
    {
      name: 'STRICT-KEY-UNDECLARED',
      why:
        'A new strict-tier key with no `channels.json` entry is a template nothing ' +
        'length-audits. Here an `operational` key is promoted to `transactional` — the shape of ' +
        'a real change — and the declaration is not updated. TIER-DRIFT fires alongside because ' +
        'the committed `compiled/` still carries the old tier table.',
      edits: [
        {
          file: TIERS,
          plant: json((doc) => {
            (doc['tiers'] as Record<string, string>)['notify.checkin.reminder'] = 'transactional';
          }),
        },
      ],
      expect: 'FAIL',
      mustInclude: [
        "CHANNEL-UNDECLARED 'notify.checkin.reminder' is a strict-tier key with no entry",
        'TIER-DRIFT tiers.json and the committed compiled/tiers.ts disagree',
      ],
      mustExclude: ['GATE PASS', 'CRASH'],
    },
    {
      name: 'LOCALE-DISABLED',
      why:
        '"<=2 segments PER LOCALE" is only as wide as the enabled set, so disabling a locale ' +
        'retires every one of its measurements at once. The locale set is pinned in the gate ' +
        'for the same reason the corpus is, and LOCALE-DRIFT fires from the second artefact.',
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
        "LOCALE-DISABLED 'ru' was an enabled locale on 2026-09-21",
        'LOCALE-DRIFT locale-registry.json enables',
      ],
      mustExclude: ['GATE PASS', 'CRASH'],
    },
    {
      name: 'COMPILED-DRIFT',
      why:
        'READING B, and it is the reason this file exists. The gate measures the CATALOGUE ' +
        'SOURCE; the product sends the COMMITTED COMPILED FUNCTION. Here the compiled Greek ' +
        'message is lengthened and the source is untouched, so reading A is unchanged and ' +
        'GREEN — the same run prints the source measurement — while reading B refuses. A gate ' +
        'that read only one of the two artefacts would measure a string nobody sends.',
      edits: [
        {
          file: COMPILED_EL,
          plant: (s) => s.replace("' χαμένες καταγραφές'", "' χαμένες καταγραφές και άλλα'"),
        },
      ],
      expect: 'FAIL',
      mustInclude: [
        `COMPILED-DRIFT '${KEY}' in el`,
        'the catalogue source renders',
        'the COMMITTED COMPILED FUNCTION renders',
      ],
      mustExclude: ['GATE PASS', 'CRASH'],
    },
    {
      name: 'COMPILED-MISSING',
      why:
        'READING B again: the committed compiled catalogue loses the message function for a key ' +
        'this gate asserts a budget over, while the catalogue source still has it. Reading A ' +
        'measures and passes it; reading B names it.',
      edits: [
        {
          file: COMPILED_EL,
          plant: (s) =>
            s.replace(
              "  'session.checkins_missed': (params: {",
              "  'session.checkins_missed_REMOVED': (params: {",
            ),
        },
      ],
      expect: 'FAIL',
      mustInclude: [`COMPILED-MISSING '${KEY}' in el`],
      mustExclude: ['GATE PASS', 'CRASH'],
    },
    {
      name: 'COMPILED-UNREADABLE',
      why:
        "A broken `compiled/` must produce this gate's OWN banner, not an uncaught exception. " +
        '"Did nothing", "refused" and "crashed" have to be three distinguishable outcomes ' +
        '(PROTOCOL §5.1) — and the reason line must be the diagnosis, not a stack trace. The ' +
        'floor measurement must still be printed, because reading A does not depend on ' +
        'reading B.',
      edits: [{ file: COMPILED_INDEX, plant: (s) => `${s}\nexport const T046_BROKEN = (;\n` }],
      expect: 'FAIL',
      mustInclude: [
        'COMPILED-UNREADABLE the committed compiled artefact could not be loaded',
        'examined {PAIRS} (locale, key) pair(s)',
      ],
      mustExclude: ['GATE PASS', 'CRASH'],
    },
  ];
}

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
  const pass = /^GATE PASS {2}gate:sms-segments/m.test(out);
  const fail = /^GATE FAIL {2}gate:sms-segments/m.test(out);
  let banner = 'NONE';
  if (pass && fail) banner = 'BOTH';
  else if (pass) banner = 'PASS';
  else if (fail) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

if (process.argv.length > 2) {
  console.error('sms-segments-negatives: takes no arguments');
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
 * Every number a case needs is taken from the CONTROL run rather than typed
 * here (PROTOCOL §5.3 R1). If the Greek copy or the declared worst case
 * changes, the pad lengths move with it and the boundary stays the boundary.
 */
const pairsMatch = /examined ([0-9]+) \(locale, key\) pair\(s\)/.exec(control.out);
const budgetMatch = /<= ([0-9]+) UTF-16 code units \(UCS-2/.exec(control.out);
const elMatch = new RegExp(
  `^ {4}el ${KEY.replace('.', '\\.')} +UCS-2 +([0-9]+) unit\\(s\\) [0-9]+ segment\\(s\\), headroom`,
  'm',
).exec(control.out);
if (pairsMatch?.[1] === undefined || budgetMatch?.[1] === undefined || elMatch?.[1] === undefined) {
  console.error('!! CONTROL did not print the pair count, the UCS-2 budget and the el worst case');
  process.exit(1);
}
const PAIRS = pairsMatch[1];
const BUDGET = Number(budgetMatch[1]);
const EL_WORST = Number(elMatch[1]);
function fill(s: string): string {
  return s.replaceAll('{PAIRS}', PAIRS);
}
console.log(
  `  (expectations filled from CONTROL: ${PAIRS} pair(s); UCS-2 two-segment budget ${String(
    BUDGET,
  )}; el worst-case render ${String(EL_WORST)} unit(s), so the pads are ${String(
    BUDGET - EL_WORST,
  )} and ${String(BUDGET - EL_WORST + 1)})`,
);

const CASES = buildCases(EL_WORST, BUDGET);

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
