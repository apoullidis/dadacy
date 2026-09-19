/**
 * gate:no-unsafe-any — T-005, closing the live half of decisions.md OD-60.
 *
 * SD §DH-2: "`any` is a lint error everywhere." `gate:lint` enforces the half
 * that is visible in the syntax (`no-explicit-any`: `as any`, `x: any`). OD-60
 * is the other half, measured by qa-verification while verifying T-023: an
 * `any` VALUE — the thing `JSON.parse` returns — flows into every branded type
 * in packages/domain-types unchallenged, "including a float into MinorUnits".
 * Nothing refused it: not tsc, not ESLint.
 *
 * WHAT THIS GATE IS. A ratchet over the `no-unsafe-*` family under
 * eslint.config.typed.mjs. Nine sites in six files are red on `main c27c354`,
 * in packages owned by four other agents — two of them DELIBERATE tripwires
 * whose own comments say landing OD-60 should turn them red. They are
 * enumerated in no-unsafe-any.baseline.json with their owner and their reason,
 * and every direction of movement fails this gate:
 *
 *   N1  a site that is not in the baseline           -> NEW
 *   N2  more occurrences of a rule in a baselined file than the baseline
 *       records                                      -> INCREASED
 *   N3  fewer, or none — the site was fixed and the debt entry outlived it
 *                                                    -> STALE
 *   N4  a baseline entry with no owner               -> UNOWNED
 *
 * N3 is what stops this being an open-ended allowance: an entry cannot quietly
 * survive the thing it was recorded for. N1 is what makes it a gate rather than
 * a list: a TENTH site fails the build, today, which is OD-60's live harm.
 *
 * WHAT IT DOES NOT CLAIM. It does not claim the nine are harmless; it claims
 * they are known, owned and frozen. It does not close the sites — those are
 * their owners' to close, and T-022 § contract §3 must be narrowed when its
 * tripwire fires. And it is a lint rule, not a proof: a cast through `unknown`
 * reaches any brand and no `no-unsafe-*` rule sees it (that route is recorded
 * in the same two refusal files and is not OD-60).
 *
 * ANTI-VACUITY, and it is the important part. A lint gate reports clean when it
 * lints nothing. So this gate does not trust the ESLint run to say what it
 * covered: it asks `git ls-files` which TypeScript files exist under apps/,
 * packages/ and scripts/, and FAILS if ESLint's result set does not include
 * every one of them. An `ignores` entry added to either config, a changed glob,
 * or a file ESLint declines to parse all turn this red instead of green
 * (PROTOCOL §5.1 — a check must not be derived from the same reading as the
 * thing it checks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bin, capture, finish } from './lib/run.ts';

const CONFIG = 'eslint.config.typed.mjs';
const BASELINE = 'scripts/gates/no-unsafe-any.baseline.json';
const FAMILY = [
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-return',
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-explicit-any',
];
/** Files ESLint is expected to cover, by root. */
const ROOTS = ['apps/', 'packages/', 'scripts/'];
const TS = /\.tsx?$/;

const failures: string[] = [];

interface BaselineSite {
  readonly owner?: string;
  readonly why?: string;
  readonly rules?: Readonly<Record<string, number>>;
}
interface BaselineFile {
  readonly sites?: Readonly<Record<string, BaselineSite>>;
}

const baselineRaw: unknown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BASELINE), 'utf8'));
const baseline = (baselineRaw as BaselineFile).sites ?? {};

// ------------------------------------------------------ which files must be covered
const ls = capture('git', ['ls-files']);
if (ls.spawnFailed || ls.code !== 0) {
  finish('gate:no-unsafe-any', [`git ls-files failed: ${ls.stderr.trim()}`]);
}
const expected = new Set(
  ls.stdout.split('\n').filter((f) => f !== '' && TS.test(f) && ROOTS.some((r) => f.startsWith(r))),
);

// ---------------------------------------------------------------------- run
console.log(`$ eslint --config ${CONFIG} -f json .`);
const r = capture(bin('eslint'), ['--config', CONFIG, '-f', 'json', '.']);
if (r.spawnFailed) finish('gate:no-unsafe-any', [`could not execute eslint: ${r.stderr.trim()}`]);

interface Message {
  readonly ruleId?: string | null;
  readonly line?: number;
  readonly column?: number;
  readonly message?: string;
  readonly severity?: number;
}
interface Result {
  readonly filePath: string;
  readonly messages?: readonly Message[];
  readonly fatalErrorCount?: number;
}

let results: readonly Result[];
try {
  const parsed: unknown = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) throw new Error('the JSON formatter did not produce an array');
  results = parsed as readonly Result[];
} catch (e) {
  finish('gate:no-unsafe-any', [
    `eslint did not produce a JSON report (exit ${String(r.code)}): ` +
      `${e instanceof Error ? e.message : String(e)}. stderr: ${JSON.stringify(r.stderr.slice(0, 600))}`,
  ]);
}

// ------------------------------------------------------------- coverage first
const covered = new Set<string>();
for (const res of results) {
  covered.add(path.relative(REPO_ROOT, res.filePath));
  if ((res.fatalErrorCount ?? 0) > 0) {
    failures.push(
      `FATAL ${path.relative(REPO_ROOT, res.filePath)}: eslint could not parse it — ` +
        `${res.messages?.[0]?.message ?? '(no message)'}. An unparsed file is an unchecked file.`,
    );
  }
}
const uncovered = [...expected].filter((f) => !covered.has(f)).sort();
console.log(
  `  files eslint reported on: ${String(covered.size)}; TypeScript files git tracks under ` +
    `${ROOTS.join(', ')}: ${String(expected.size)}`,
);
if (uncovered.length > 0) {
  failures.push(
    `UNCOVERED ${String(uncovered.length)} tracked TypeScript file(s) were NOT linted by this ` +
      `gate: ${uncovered.slice(0, 20).join(', ')}${uncovered.length > 20 ? ' …' : ''}. ` +
      'A lint gate that stopped looking at a file reports clean. Check the `ignores` blocks in ' +
      `eslint.config.mjs and ${CONFIG}.`,
  );
}

// --------------------------------------------------------------- the ratchet
const actual = new Map<string, Map<string, number>>();
for (const res of results) {
  const rel = path.relative(REPO_ROOT, res.filePath);
  for (const m of res.messages ?? []) {
    const rule = m.ruleId ?? '';
    if (!FAMILY.includes(rule)) continue;
    let byRule = actual.get(rel);
    if (byRule === undefined) {
      byRule = new Map<string, number>();
      actual.set(rel, byRule);
    }
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }
}

let recorded = 0;
for (const [file, site] of Object.entries(baseline)) {
  if (site.owner === undefined || site.owner.trim() === '') {
    failures.push(`UNOWNED ${file}: a baseline entry with no owner is an open-ended allowance`);
  }
  for (const [rule, count] of Object.entries(site.rules ?? {})) {
    recorded += count;
    const seen = actual.get(file)?.get(rule) ?? 0;
    if (seen > count) {
      failures.push(
        `INCREASED ${file} ${rule}: ${String(seen)} occurrence(s), baseline ${String(count)}. ` +
          `Owner: ${site.owner ?? '(none)'}.`,
      );
    } else if (seen < count) {
      failures.push(
        `STALE ${file} ${rule}: ${String(seen)} occurrence(s), baseline ${String(count)}. ` +
          `The site was fixed or moved — remove or lower the entry in ${BASELINE}. ` +
          'A debt entry that outlives its debt is exactly the open-ended allowance this ' +
          'baseline is not allowed to become.',
      );
    }
  }
}

for (const [file, byRule] of actual) {
  for (const [rule, count] of byRule) {
    const known = baseline[file]?.rules?.[rule];
    if (known === undefined) {
      failures.push(
        `NEW ${file} ${rule}: ${String(count)} occurrence(s), not in ${BASELINE}. ` +
          'This is OD-60 biting: an `any` value reaching typed code. Fix it — do not add it ' +
          'to the baseline unless a named ticket owns it and the reason is written down.',
      );
    }
  }
}

const seenTotal = [...actual.values()].reduce(
  (n, byRule) => n + [...byRule.values()].reduce((a, b) => a + b, 0),
  0,
);
console.log(
  `  unsafe-any occurrences: ${String(seenTotal)} seen, ${String(recorded)} recorded in ${BASELINE} ` +
    `across ${String(Object.keys(baseline).length)} file(s).`,
);
for (const [file, site] of Object.entries(baseline)) {
  console.log(`    ${file}  <- ${site.owner ?? '(no owner)'}`);
}

finish('gate:no-unsafe-any', failures);
