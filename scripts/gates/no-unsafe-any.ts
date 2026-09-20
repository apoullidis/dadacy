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
 * eslint.config.typed.mjs. The sites that are red today are in packages owned
 * by other agents — three of them DELIBERATE tripwires whose own comments say
 * landing OD-60 should turn them red. THE COUNT IS NOT WRITTEN HERE ON PURPOSE:
 * it moved from nine to thirteen the moment T-147 merged, and a count in a
 * comment beside a register that prints its own count is a second copy waiting
 * to go stale (PROTOCOL §5.3 R2). The register is
 * no-unsafe-any.baseline.json, every entry carries its owner and its reason,
 * the gate prints the totals on every run, and every direction of movement
 * fails this gate:
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
 * a list: ONE MORE site fails the build, today, which is OD-60's live harm.
 *
 * WHAT IT DOES NOT CLAIM. It does not claim the baselined sites are harmless;
 * it claims they are known, owned and frozen. It does not close them — those
 * are their owners' to close, and T-022 § contract §3 must be narrowed when its
 * tripwire fires. And it is a lint rule, not a proof. TWO assertion routes
 * reach a brand with an `any` value and neither of the five enabled rules sees
 * either of them:
 *
 *   `x as unknown as T`  — the laundering cast. Recorded in the refusal files
 *                          of packages/contracts and packages/domain-types; it
 *                          is not OD-60 and no `no-unsafe-*` rule covers it.
 *   `x as T`             — the DIRECT assertion, and it is the more idiomatic
 *                          spelling at a JSON boundary. `JSON.parse(s) as
 *                          MinorUnits` is clean under the committed overlay,
 *                          measured (qa-verification, rework 1, X4 —
 *                          eslint exit 0). The plugin ships a rule for it,
 *                          `@typescript-eslint/no-unsafe-type-assertion`, and
 *                          adding it to the overlay reports two errors on that
 *                          same file. IT IS NOT ENABLED HERE. Whether to enable
 *                          it is T-174's: the blast radius is four other
 *                          agents' packages, which is a behaviour change, not a
 *                          wording one (stakeholder ruling OE-40, 2026-09-20).
 *
 * Two different spellings; only the first was named until 2026-09-20 (QR2-F2).
 *
 * ANTI-VACUITY, and it is the important part. A lint gate reports clean in
 * THREE ways, and this gate reads two of them. It reports clean when it lints
 * nothing (C1); when the rule it counts is not enabled (C2); AND when the rule
 * IS enabled, DOES apply to the file, and is suppressed AT the file by an
 * inline `eslint-disable` comment. `calculateConfigForFile` resolves the STATIC
 * configuration and does not see inline directives, and the base config sets no
 * `linterOptions.noInlineConfig` — so a tracked file carrying a five-rule
 * disable header and a genuine `any`-value site is GATE PASS, measured by
 * qa-verification (T-005 QR2-A1). THAT THIRD ROUTE IS OPEN AND IS T-174's, by
 * name; it is written here because an enumeration that said "two" was what made
 * it invisible. The two this gate does read, neither of them the occurrence
 * report itself (PROTOCOL §5.1 — a check must not be derived from the same
 * reading as the thing it checks):
 *
 *   C1  THE FILE SET. `git ls-files` says which TypeScript files exist under
 *       apps/, packages/ and scripts/. Every one of THEM must appear in
 *       ESLint's result set, and none of THEM may carry a fatal parse error.
 *       An `ignores` entry added to either config, or a TRACKED file ESLint
 *       declines to parse, turns this red instead of green (UNCOVERED /
 *       FATAL). A file git does not track is not in this reading at all —
 *       see the scoping note beside the loop, and cases D9/D10.
 *   C2  THE RULE SET IN FORCE, PER FILE, from ESLint's own resolved config
 *       (`ESLint#calculateConfigForFile`) — not from reading the overlay's
 *       text, and not from what the occurrence report happens to mention.
 *       Every file in C1's set must resolve to a config carrying all five
 *       `no-unsafe-*` rules AND `no-explicit-any` at severity `error`
 *       (RULES-NOT-IN-FORCE / NO-CONFIG).
 *
 * C2 EXISTS BECAUSE C1 ALONE WAS GETTABLE-PAST, TWO WAYS, BOTH DEMONSTRATED BY
 * QA ON THE FIRST VERIFICATION PASS AND BOTH NOW CASES IN THE SUITE:
 *   * deleting `'@typescript-eslint/no-unsafe-call'` from the overlay left this
 *     gate GREEN, because nothing asserted the rule was enabled and no baseline
 *     entry cites it. The other four were caught only by the coincidence that
 *     the baseline does cite them — incidental, not designed (case D6);
 *   * NARROWING the overlay's `files:` glob left it GREEN too, with a real
 *     `any`-value site planted in the dropped directory, because the BASE
 *     config still reports on every file: C1's report set stayed complete while
 *     the overlay's rules applied to a smaller set (cases D7, D8).
 * C2 is derived from the typed block's own per-file resolution, so a deleted
 * rule and a narrowed glob are both red — and the claim this header makes is
 * now the claim those three cases test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { REPO_ROOT, bin, capture, finish } from './lib/run.ts';

const CONFIG = 'eslint.config.typed.mjs';
const BASELINE = 'scripts/gates/no-unsafe-any.baseline.json';
/** The five the overlay adds. C2 asserts each is at `error` on every file. */
const OVERLAY_RULES = [
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-return',
  '@typescript-eslint/no-unsafe-argument',
];
/** The base config's syntactic half (SD §DH-2), counted by the same ratchet. */
const BASE_RULE = '@typescript-eslint/no-explicit-any';
/** Every rule whose occurrences the ratchet below counts. */
const FAMILY = [...OVERLAY_RULES, BASE_RULE];
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
// THE FATAL READING IS SCOPED TO THE TRACKED SET, and that is the check being
// made equal to its own sentence (2026-09-20, found by rebasing onto main
// 6582596). C1 above says: "`git ls-files` says which TypeScript files exist
// under apps/, packages/ and scripts/. Every one of THEM must appear in
// ESLint's result set, and NONE OF THEM may carry a fatal parse error." The
// loop did not say `of them`: it raised FATAL for any file in ESLint's report,
// and ESLint's report includes files git ignores. Measured: T-147 left eight
// scratch files in the GITIGNORED apps/core/.cache/t147r1/bundle/, ESLint
// linted them, `projectService` could not place them in any tsconfig, and this
// gate was `GATE FAIL` with eight FATALs on files that are not in the
// repository at all. A gate another agent's leftover scratch can redden is a
// gate people learn to ignore.
//
// THE RATCHET BELOW IS DELIBERATELY WIDER and is NOT scoped this way: it counts
// occurrences over every file ESLint reports on, so a NEW site fails this gate
// before the file is even tracked. Case D1 plants an UNTRACKED file and
// requires NEW, which is exactly that property; D9/D10 are the pair for this
// one. The asymmetry is intended — coverage is a claim about what the repo
// contains, occurrences are a claim about what the linter saw.
//
// WHAT IS NOT CLOSED BY THIS, stated rather than implied: a gitignored file
// that DOES parse and does carry an `any` value would still be counted by the
// ratchet and reported as NEW. There is no such file today (an ignored path is
// not in any tsconfig `include`, which is why the measured instance was FATAL
// rather than NEW), and it is recorded in decisions.md OD-171 rather than
// assumed away.
const covered = new Set<string>();
for (const res of results) {
  const rel = path.relative(REPO_ROOT, res.filePath);
  covered.add(rel);
  if ((res.fatalErrorCount ?? 0) > 0 && expected.has(rel)) {
    failures.push(
      `FATAL ${rel}: eslint could not parse it — ` +
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

// ------------------------------------------- C2: the rule set actually in force
// C1 above reads ESLint's REPORT. That report is populated by the BASE config
// for every file whatever the overlay's `files:` glob says, and it mentions a
// rule only when that rule fired — so neither a deleted rule nor a narrowed
// glob is visible in it. C2 therefore asks ESLint to RESOLVE the config for
// each file and reads the severity it would apply. Same tool, different
// question, and it is the question the overlay's own comment answers.

/** ESLint normalises severities to `[2]`; accept the other spellings anyway. */
function severityOf(value: unknown): number | undefined {
  const head: unknown = Array.isArray(value) ? (value as readonly unknown[])[0] : value;
  if (typeof head === 'number') return head;
  if (head === 'error') return 2;
  if (head === 'warn') return 1;
  if (head === 'off') return 0;
  return undefined;
}

const api = new ESLint({ overrideConfigFile: CONFIG, cwd: REPO_ROOT });
const notInForce = new Map<string, string[]>();
const noConfig: string[] = [];
let inForce = 0;
for (const file of [...expected].sort()) {
  let resolved: unknown;
  try {
    resolved = await api.calculateConfigForFile(file);
  } catch (e) {
    notInForce.set(file, [
      `eslint could not resolve a config: ${e instanceof Error ? e.message : String(e)}`,
    ]);
    continue;
  }
  if (typeof resolved !== 'object' || resolved === null) {
    noConfig.push(file);
    continue;
  }
  const rules = (resolved as { rules?: Readonly<Record<string, unknown>> }).rules ?? {};
  const off = FAMILY.filter((rule) => severityOf(rules[rule]) !== 2);
  if (off.length > 0) notInForce.set(file, off);
  else inForce += 1;
}

console.log(
  `  ${CONFIG} resolved per file: ${String(inForce)}/${String(expected.size)} tracked file(s) ` +
    `have all ${String(FAMILY.length)} rule(s) at 'error' (eslint's own resolution, not a read ` +
    'of the config text)',
);

if (noConfig.length > 0) {
  failures.push(
    `NO-CONFIG ${String(noConfig.length)} tracked TypeScript file(s) resolve to NO eslint ` +
      `configuration at all — eslint would skip them: ${noConfig.slice(0, 20).join(', ')}` +
      `${noConfig.length > 20 ? ' …' : ''}.`,
  );
}
if (notInForce.size > 0) {
  const byRule = new Map<string, number>();
  for (const rules of notInForce.values()) {
    for (const rule of rules) byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }
  const perRule = [...byRule]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([rule, n]) => `${rule} (${String(n)} file(s))`)
    .join(', ');
  const examples = [...notInForce.keys()].slice(0, 5).join(', ');
  failures.push(
    `RULES-NOT-IN-FORCE ${String(notInForce.size)} of ${String(expected.size)} tracked ` +
      `TypeScript file(s) resolve to a config where these are NOT at 'error': ${perRule}. ` +
      `e.g. ${examples}${notInForce.size > 5 ? ' …' : ''}. This gate counts occurrences of ` +
      'exactly these rules, so a rule that is not enabled — or a file the overlay no longer ' +
      'selects — produces zero occurrences and a green run. Check the `rules` ' +
      `block and the \`files\` list in ${CONFIG}.`,
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
