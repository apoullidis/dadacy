/**
 * `pnpm --filter @kinvara/i18n run test:negatives`: the committed negative
 * cases for `tools/run-tests.ts` (T-132 rework 1, QR-F1 and QR-F2).
 *
 * Each case plants one edit in `src/catalogue.test.ts`, asserts that the edit
 * landed, and runs `node tools/run-tests.ts`. It checks the exit status and
 * the exact lines the run must print; a crash or a no-op must not read as the
 * expected verdict (PROTOCOL §5.1). It then restores the file byte for byte,
 * asserts that, and re-runs the clean tree. That run must print the same
 * `run-tests:` summary as the CONTROL run at the start.
 *
 * `red` cases are refusals that T-132 § Published contract claims. `bound`
 * cases are routes the contract says are NOT refused. They are asserted green,
 * so if one of them is ever closed this script fails and the contract has to
 * change with it.
 *
 * `limitation` cases (T-132 rework 2, decisions.md OE-14) are asserted the same
 * way. They are the routes QA's rework 1 re-review found open (QR2-F1, QR2-F2,
 * QR2-F3), which the contract now discloses. They are limitations, not
 * refusals: each passes because the gap exists. Whoever closes one must
 * change its expectation, and the contract, in the same commit.
 *
 * It must start from a clean `packages/i18n` (read with git) and it takes no
 * arguments. It is not a `*.test.ts` file, so neither Vitest nor run-tests.ts
 * reads it, and `pnpm test` does not run it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'src/catalogue.test.ts';
const TARGET_PATH = join(PKG, TARGET);
/** The first test in TARGET, the one QA's reproduction loses. */
const LOST_TITLE = 'the fallback table is exactly SA §TS-12.1';
const DOLLAR = '$';
/** QR2-F2: the leaf title a hand-written `en` block and a looped `describe` share. */
const SHARED_TITLE = 'T132QA the 112 script resolves and is safety_critical';

interface Counts {
  /** tests in the CONTROL run, all files */
  n: number;
  /** `test(` call sites at the start of a line in TARGET, as run-tests.ts counts them */
  k: number;
}
interface Case {
  name: string;
  expect: 'red' | 'bound' | 'limitation';
  why: string;
  plant: (s: string) => string;
  exit: number;
  /** lines the run's output must contain */
  mustInclude: (c: Counts) => string[];
  /** strings the run's output must not contain */
  mustExclude: string[];
}

function firstBlock(s: string): [number, number] {
  const i = s.indexOf("\ntest('") + 1;
  if (i === 0) throw new Error("anchor not found: the first \\ntest('");
  const end = s.indexOf('\n});\n', i);
  if (end < 0) throw new Error('anchor not found: the end of the first test');
  return [i, end + '\n});'.length];
}
function replaceOnce(s: string, old: string, rep: string): string {
  const at = s.indexOf(old);
  if (at < 0) throw new Error(`anchor not found: ${JSON.stringify(old)}`);
  return s.slice(0, at) + rep + s.slice(at + old.length);
}
/** QA's `ctx-*` mutation: the first test's body is prefixed with `inject`. */
function prefixFirstBody(s: string, inject: string): string {
  const [i, j] = firstBlock(s);
  return s.slice(0, i) + replaceOnce(s.slice(i, j), '() => {', inject) + s.slice(j);
}
const refusedByName = `declared test ${JSON.stringify(LOST_TITLE)} did not run`;
const lostPassLine = `✓ ${TARGET} > ${LOST_TITLE}`;

const CASES: Case[] = [
  {
    name: 'QR-F1-LOOP-MASK',
    expect: 'red',
    why: "QA's exact reproduction: the first test inside a block that never runs, plus a two-row loop over test()",
    plant: (s) => {
      const [i, j] = firstBlock(s);
      const wrapped =
        s.slice(0, i) + 'if (process.env.T132QA_NEVER) {\n' + s.slice(i, j) + '\n}' + s.slice(j);
      return (
        wrapped +
        '\n// T132QA table-driven rows\nfor (const n of [1, 2]) {\n' +
        `  test(\`T132QA table row ${DOLLAR}{String(n)}\`, () => {\n    assert.ok(n > 0);\n  });\n}\n`
      );
    },
    exit: 1,
    mustInclude: ({ n }) => [
      refusedByName,
      `run-tests: ${String(n + 1)} of ${String(n + 1)} tests passed`,
      'TEST FAIL  @kinvara/i18n — 1 problem(s)',
    ],
    mustExclude: [lostPassLine],
  },
  {
    name: 'COND-ONELINE',
    expect: 'red',
    why: 'if (cond) test(...) on one line: a bound at dd645b3 (LOST-ONELINE), refused by name now',
    plant: (s) => replaceOnce(s, "\ntest('", "\nif (process.env.T132QA_NEVER) test('"),
    exit: 1,
    mustInclude: ({ n }) => [
      refusedByName,
      `run-tests: ${String(n - 1)} of ${String(n - 1)} tests passed`,
      'TEST FAIL  @kinvara/i18n — 1 problem(s)',
    ],
    mustExclude: [lostPassLine],
  },
  {
    name: 'NONLITERAL-NO-SURPLUS',
    expect: 'red',
    why: 'a template-titled test that never runs, in a file with no surplus: the per-file floor refuses it',
    plant: (s) =>
      s +
      '\n// T132 a template-titled test that never runs\nif (process.env.T132_NEVER) {\n' +
      `  test(\`T132 non-literal ${DOLLAR}{'title'}\`, () => {});\n}\n`,
    exit: 1,
    mustInclude: ({ n, k }) => [
      `${TARGET}: ${String(k)} tests registered at run time, ${String(k + 1)} test( call sites in source`,
      `run-tests: ${String(n)} of ${String(n)} tests passed`,
      'TEST FAIL  @kinvara/i18n — 1 problem(s)',
    ],
    mustExclude: ['T132 non-literal title'],
  },
  {
    name: 'NONLITERAL-MASKED',
    expect: 'bound',
    why: 'the residue: a template-titled test that never runs, masked by a two-row loop in the same file',
    plant: (s) =>
      s +
      '\n// T132 a template-titled test that never runs, and a table-driven loop\n' +
      'if (process.env.T132_NEVER) {\n' +
      `  test(\`T132 non-literal ${DOLLAR}{'title'}\`, () => {});\n}\n` +
      'for (const n of [1, 2]) {\n' +
      `  test(\`T132 residue row ${DOLLAR}{String(n)}\`, () => {\n    assert.ok(n > 0);\n  });\n}\n`,
    exit: 0,
    mustInclude: ({ n }) => [
      `run-tests: ${String(n + 2)} of ${String(n + 2)} tests passed`,
      'TEST PASS  @kinvara/i18n',
    ],
    mustExclude: ['T132 non-literal title'],
  },
  {
    name: 'CTX-CRASH-CONTROL',
    expect: 'red',
    why: 'the control for the next case: the same crashing body, with no fails flag',
    plant: (s) =>
      prefixFirstBody(s, "(ctx) => {\n  void ctx; throw new Error('T132QA crash'); // T132QA"),
    exit: 1,
    mustInclude: () => [
      'numFailedTests is 1, not 0',
      `declared test ${JSON.stringify(LOST_TITLE)} ran with status failed, not passed`,
    ],
    mustExclude: [lostPassLine],
  },
  {
    name: 'CTX-TASK-FAILS',
    expect: 'bound',
    why: "QR-F2, QA's exact plant: ctx.task.fails = true, then a crash, reports as passed",
    plant: (s) =>
      prefixFirstBody(
        s,
        "(ctx) => {\n  ctx.task.fails = true; throw new Error('T132QA crash'); // T132QA",
      ),
    exit: 0,
    mustInclude: ({ n }) => [
      lostPassLine,
      `run-tests: ${String(n)} of ${String(n)} tests passed`,
      'TEST PASS  @kinvara/i18n',
    ],
    mustExclude: [],
  },
  {
    name: 'QR2-F1-ONELINE-NONLITERAL',
    expect: 'limitation',
    why:
      "QR2-F1, QA's exact line (ONELINE-NONLITERAL-EXPR): a generated title in a one-line if, " +
      'never run, in a file with no surplus',
    plant: (s) =>
      s +
      '\n// T132QA one-line conditional, generated title, expression body\n' +
      `if (process.env.T132QA_NEVER) test(\`${DOLLAR}{EN} T132QA generated\`, () => ` +
      "assert.equal(EN, 'en'));\n",
    exit: 0,
    mustInclude: ({ n }) => [
      `run-tests: ${String(n)} of ${String(n)} tests passed`,
      'TEST PASS  @kinvara/i18n',
    ],
    mustExclude: ['T132QA generated', 'test( call sites in source'],
  },
  {
    name: 'QR2-F2-PER-LOCALE-EN-LOST',
    expect: 'limitation',
    why:
      "QR2-F2, QA's prettier-formatted plant (PER-LOCALE-EN-LOST-FMT): a lost en block, paid " +
      'for by a looped describe whose test has the same leaf title',
    plant: (s) =>
      replaceOnce(s, "import { test } from 'vitest';", "import { describe, test } from 'vitest';") +
      '\n// T132QA per-locale blocks, the hand-written en block lost\n' +
      'if (process.env.T132QA_NEVER) {\n' +
      "  describe('en', () => {\n" +
      `    test('${SHARED_TITLE}', () => {\n` +
      "      assert.equal(resolveMessage('safety.sos.confirm', EN).tier, 'safety_critical');\n" +
      '    });\n' +
      '  });\n' +
      '}\n' +
      'for (const locale of [EL, RU]) {\n' +
      '  describe(String(locale), () => {\n' +
      `    test('${SHARED_TITLE}', () => {\n` +
      "      assert.equal(resolveMessage('safety.sos.confirm', locale).tier, 'safety_critical');\n" +
      '    });\n' +
      '  });\n' +
      '}\n',
    exit: 0,
    mustInclude: ({ n }) => [
      `✓ ${TARGET} > el > ${SHARED_TITLE}`,
      `✓ ${TARGET} > ru > ${SHARED_TITLE}`,
      `run-tests: ${String(n + 2)} of ${String(n + 2)} tests passed`,
      'TEST PASS  @kinvara/i18n',
    ],
    mustExclude: [`> en > ${SHARED_TITLE}`],
  },
  {
    name: 'QR2-F3-RENAME-ONLY',
    expect: 'limitation',
    why: "QR2-F3, QA's plant: a renamed test passes, because the source and the report change together",
    plant: (s) => replaceOnce(s, `\ntest('${LOST_TITLE}`, `\ntest('T132QA renamed: ${LOST_TITLE}`),
    exit: 0,
    mustInclude: ({ n }) => [
      `✓ ${TARGET} > T132QA renamed: ${LOST_TITLE}`,
      `run-tests: ${String(n)} of ${String(n)} tests passed`,
      'TEST PASS  @kinvara/i18n',
    ],
    mustExclude: [lostPassLine],
  },
  {
    name: 'QR2-F3-CTX-FAILS-ASSERT',
    expect: 'limitation',
    why: "QR2-F3, QA's plant: ctx.task.fails = true, then a failed assertion (not a crash), reports as passed",
    plant: (s) =>
      prefixFirstBody(s, '(ctx) => {\n  ctx.task.fails = true; assert.equal(1, 2); // T132QA'),
    exit: 0,
    mustInclude: ({ n }) => [
      lostPassLine,
      `run-tests: ${String(n)} of ${String(n)} tests passed`,
      'TEST PASS  @kinvara/i18n',
    ],
    mustExclude: [],
  },
];

function run(): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['tools/run-tests.ts'], {
    cwd: PKG,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined)
    return { code: null, out: `run-tests did not start: ${r.error.message}` };
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const VERDICT = /^ {2}- |^TEST (PASS|FAIL)|^run-tests: |^\s*Tests /;
function show(out: string): void {
  for (const l of out.split('\n')) if (VERDICT.test(l)) console.log(`   | ${l}`);
}
function summaryOf(out: string): string | undefined {
  return out.split('\n').find((l) => l.startsWith('run-tests: '));
}

if (process.argv.length > 2) {
  console.error('run-tests-negatives: takes no arguments');
  process.exit(2);
}
const st = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: PKG, encoding: 'utf8' });
if (st.error !== undefined || st.status !== 0) {
  console.error(`run-tests-negatives: cannot read git status (${st.error?.message ?? st.stderr})`);
  process.exit(99);
}
if (st.stdout !== '') {
  console.error(`run-tests-negatives: packages/i18n is not clean:\n${st.stdout}`);
  process.exit(99);
}
const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PKG, encoding: 'utf8' });
console.log(`HEAD ${head.stdout.trim()}`);

const original = readFileSync(TARGET_PATH, 'utf8');
const restore = (): void => writeFileSync(TARGET_PATH, original, 'utf8');
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

let unexpected = 0;
try {
  const control = run();
  const controlSummary = summaryOf(control.out);
  const m = /^run-tests: (\d+) of \1 tests passed/.exec(controlSummary ?? '');
  console.log('== CONTROL  (expect exit 0, TEST PASS)');
  console.log(`   exit=${String(control.code)}`);
  show(control.out);
  if (control.code !== 0 || !control.out.includes('TEST PASS') || m === null) {
    console.log('   UNEXPECTED: the clean tree is not green; no case can be judged');
    process.exitCode = 1;
  } else {
    const counts: Counts = {
      n: Number(m[1]),
      k: (original.match(/^\s*(?:test|it)\(/gm) ?? []).length,
    };
    for (const c of CASES) {
      const planted = c.plant(original);
      writeFileSync(TARGET_PATH, planted, 'utf8');
      const landed = readFileSync(TARGET_PATH, 'utf8');
      console.log(`== ${c.name}  (expect ${c.expect}: exit ${String(c.exit)})  ${c.why}`);
      if (landed === original || landed !== planted) {
        console.log('   MUTATION DID NOT LAND: CASE VOID');
        unexpected++;
        restore();
        continue;
      }
      landed.split('\n').forEach((l, i) => {
        if (/T132|process\.env\.T132/.test(l)) console.log(`   planted> ${String(i + 1)}:${l}`);
      });
      const r = run();
      console.log(`   exit=${String(r.code)}`);
      show(r.out);
      const wrong = [
        ...(r.code === c.exit ? [] : [`exit ${String(r.code)}, expected ${String(c.exit)}`]),
        ...c
          .mustInclude(counts)
          .filter((l) => !r.out.includes(l))
          .map((l) => `missing: ${l}`),
        ...c.mustExclude.filter((l) => r.out.includes(l)).map((l) => `present: ${l}`),
      ];
      restore();
      const restored = readFileSync(TARGET_PATH, 'utf8') === original;
      const again = run();
      const againOk = again.code === 0 && summaryOf(again.out) === controlSummary;
      if (!restored) wrong.push('the file was not restored byte for byte');
      if (!againOk) {
        wrong.push(`the reverted run is not the CONTROL run: exit ${String(again.code)}`);
      }
      console.log(
        `   reverted: file byte-identical ${restored ? 'yes' : 'NO'}; re-run exit ${String(again.code)}, ` +
          `summary ${againOk ? 'identical to CONTROL' : 'DIFFERENT'}`,
      );
      if (wrong.length === 0) console.log(`   verdict: ${c.expect} as expected`);
      else {
        unexpected++;
        for (const w of wrong) console.log(`   UNEXPECTED: ${w}`);
      }
    }
    console.log(`== ${String(CASES.length)} cases, ${String(unexpected)} unexpected`);
    if (unexpected > 0) process.exitCode = 1;
  }
} finally {
  restore();
}
const clean = spawnSync('git', ['status', '--porcelain', '--', '.'], {
  cwd: PKG,
  encoding: 'utf8',
});
console.log(`== tree clean: ${clean.stdout === '' ? 'yes' : 'NO'}`);
if (clean.stdout !== '') process.exitCode = 1;
