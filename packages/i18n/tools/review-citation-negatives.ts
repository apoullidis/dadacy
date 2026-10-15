/**
 * `pnpm --filter @kinvara/i18n run test:review-citation-mutations` — T-043,
 * for `T-233`'s QA-F4 (BOARD row, 2026-09-28T14:31:10Z).
 *
 * `T-233` § Published contract §1 rule (iv): `authored_by` must be exactly the
 * model a ruling names. `src/review.ts` compares the raw string with
 * `cited.authors.includes(record.authored_by)` — no normalisation — and
 * PIPELINE.md says the rule is "exact to the character". This script proves
 * the near-miss cases in `src/pipeline.test.ts`'s citation test are what
 * would notice if that comparison ever started normalising: it plants each of
 * two plausible "helpful" edits to that one line, runs that one test, and
 * requires it to fail naming EXACTLY the near misses the edit lets through.
 *
 *   NFKC        `record.authored_by.normalize('NFKC')` — folds the no-break
 *               space and the fullwidth parenthesis, so exactly those two must
 *               be reported accepted.
 *   STRIP-ZW    zero-width characters and the BOM removed — so exactly the
 *               zero-width space and the BOM must be reported accepted.
 *
 * Each case asserts its mutation LANDED (read back from disk), judges the run
 * on the exit status AND the reported list (a crash, or a red test for any
 * other reason, does not match), then restores `src/review.ts` byte for byte
 * and asserts the restore. A CONTROL run on the unmutated file brackets both.
 *
 * It refuses to start unless `git status --porcelain packages/i18n/src` is
 * empty and takes no arguments. It is NOT a `*.test.ts` file: `pnpm test`
 * does not run it, and NO GATE RUNS IT (it mutates the working tree, which
 * `gate:pr` refuses — T-005 § Published contract §4), exactly like the
 * package's other `*-negatives.ts` scripts.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW = join(PKG, 'src', 'review.ts');
const VITEST = join(PKG, 'node_modules', 'vitest', 'vitest.mjs');
const TITLE = 'the citation must be a real ruling, covering this locale';
const TARGET = '!cited.authors.includes(record.authored_by)';

interface Case {
  readonly name: string;
  readonly replacement: string | null;
  /** The near-miss labels the test must report accepted; [] means it must pass. */
  readonly accepted: readonly string[];
}

const CASES: readonly Case[] = [
  { name: 'CONTROL (unmutated)', replacement: null, accepted: [] },
  {
    name: 'NFKC',
    replacement: "!cited.authors.includes(record.authored_by.normalize('NFKC'))",
    accepted: ['no-break space (U+00A0)', 'fullwidth parenthesis (U+FF08)'],
  },
  {
    name: 'STRIP-ZW',
    replacement:
      "!cited.authors.includes(record.authored_by.replace(/[\\u200B-\\u200D\\u2060\\uFEFF]/gu, ''))",
    accepted: ['zero-width space (U+200B)', 'byte-order mark (U+FEFF)'],
  },
  { name: 'CONTROL (after)', replacement: null, accepted: [] },
];

if (process.argv.length > 2) {
  console.error('review-citation-negatives takes no arguments');
  process.exit(2);
}
const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src'], {
  cwd: PKG,
  encoding: 'utf8',
});
if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
  console.error(
    `refusing to start: packages/i18n/src is not clean\n${dirty.stdout}${dirty.stderr}`,
  );
  process.exit(2);
}

const original = readFileSync(REVIEW, 'utf8');
if (original.split(TARGET).length !== 2) {
  console.error(`refusing to start: expected exactly one occurrence of ${TARGET} in src/review.ts`);
  process.exit(2);
}

let misbehaved = 0;
for (const c of CASES) {
  let verdict: string;
  try {
    if (c.replacement !== null) {
      writeFileSync(REVIEW, original.replace(TARGET, c.replacement));
      const now = readFileSync(REVIEW, 'utf8');
      if (!now.includes(c.replacement) || now.includes(TARGET)) {
        throw new Error('the mutation did not land');
      }
    }
    const r = spawnSync(
      process.execPath,
      [VITEST, 'run', 'src/pipeline.test.ts', '-t', TITLE, '--no-color'],
      { cwd: PKG, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const out = `${r.stdout}${r.stderr}`;
    const m = /near misses that must be refused were accepted: (\[[^\]]*\])/u.exec(out);
    const reported = m?.[1] === undefined ? null : (JSON.parse(m[1]) as string[]);
    // Exactly one test ran, whatever its result: a filter that matched nothing
    // (a renamed title) must not read as a pass.
    const ran = /Tests\s+1 (?:failed|passed)\b/u.test(out);
    if (c.accepted.length === 0) {
      verdict =
        r.status === 0 && reported === null && ran
          ? 'ok    passed'
          : `!!    expected a pass, got exit ${String(r.status)}, reported ${JSON.stringify(reported)}`;
    } else {
      verdict =
        r.status !== 0 && ran && JSON.stringify(reported) === JSON.stringify(c.accepted)
          ? `ok    red, reporting exactly ${JSON.stringify(reported)}`
          : `!!    expected red reporting ${JSON.stringify(c.accepted)}, got exit ${String(r.status)}, reported ${JSON.stringify(reported)}`;
    }
  } catch (err) {
    verdict = `!!    harness error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    writeFileSync(REVIEW, original);
  }
  if (readFileSync(REVIEW, 'utf8') !== original) {
    console.log('!!    src/review.ts was NOT restored byte for byte — stop and restore it by hand');
    process.exit(1);
  }
  if (verdict.startsWith('!!')) misbehaved += 1;
  console.log(`${c.name.padEnd(20)} ${verdict}`);
}
console.log(
  misbehaved === 0
    ? `\nALL ${String(CASES.length)} CASES BEHAVED AS EXPECTED`
    : `\n!! ${String(misbehaved)} of ${String(CASES.length)} cases misbehaved`,
);
process.exit(misbehaved === 0 ? 0 : 1);
