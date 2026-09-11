/**
 * gate:semgrep — the Semgrep project rules (SD §QD-4 PR row, SD §DH-2). T-133.
 *
 * It runs COMMITTED, LOCAL rule files only: --config is always .semgrep.yml in
 * this repository. No registry rule, no `--config auto`, no URL, no token.
 *
 * THE HARNESS-NO-OP CLASS (PROTOCOL §5.1) governs the shape of this file,
 * because Semgrep produces a no-op that looks exactly like success in THREE
 * separate ways, all measured on semgrep 1.176.1 during T-133:
 *
 *   1. `semgrep scan` exits 0 WITH FINDINGS unless --error is passed. Measured:
 *      29 results, exit 0. So the exit status alone cannot tell clean from
 *      dirty. This gate passes --error AND parses the results, and treats
 *      disagreement between the two signals as a harness failure.
 *   2. A rule file that matches nothing is indistinguishable from a clean tree:
 *      both are "no results". SELF_TESTS below fixes that — every rule must
 *      fire on a known-bad fixture and stay silent on known-good controls,
 *      every run, before the real scan is believed.
 *   3. A scan that scans NO FILES exits 0 with no results. Measured: a
 *      gitignored path yields `scanned: []` at exit 0. This gate prints the
 *      scanned count and says so loudly when the rule's scope is empty.
 *
 * FOUR outcomes are kept distinguishable, not three (rework 1, QA-F1): the tree
 * is clean, the tree is dirty, the RULE SET cannot be believed, or THIS GATE
 * ITSELF crashed. Every run prints exactly one OUTCOME line and every failure
 * carries a tag — FINDING / RULES / SELFTEST / SEMGREP / CONFIG / HARNESS —
 * and every exit path goes through finish(), so no red path can skip the
 * `GATE FAIL gate:semgrep` banner. Before rework 1 one empty YAML list item
 * (`printf '  -\n' >> .semgrep.yml`) exited 1 with an uncaught TypeError and
 * ZERO banner lines: "crashed" and "refused" were the same outcome, which is
 * the one thing this structure exists to prevent.
 *
 * NETWORK POSTURE — measured, not assumed (rework 1, QA-F2). With a UDP DNS
 * sink as the container's only resolver and its control firing, the committed
 * gate produced 32 lookups of semgrep.dev. They were attributed: the SCAN was
 * already clean (the gate's own flags take it to 0), and every one of them came
 * from the bare `semgrep --version` in section 1, which ran with inherited
 * environment and no version-check suppression. Every semgrep invocation in
 * this file now carries SEMGREP_ENABLE_VERSION_CHECK=0 and, where the CLI
 * accepts it, --disable-version-check. Re-measured after the fix: 0.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT, finish, toolVersions } from './lib/run.ts';

const failures: string[] = [];

const RULES_FILE = path.join(REPO_ROOT, '.semgrep.yml');
const IGNORE_FILE = path.join(REPO_ROOT, '.semgrepignore');
const rel = (p: string): string => path.relative(REPO_ROOT, p);

/**
 * The flags every invocation carries. They are constants, not parameters,
 * because the network posture is a property of the gate and not of the caller:
 *   --metrics=off            asks semgrep to send no usage metrics. That is a
 *                            flag we pass, NOT a measured property: the DNS
 *                            sink below sees resolution attempts, never
 *                            payloads, so "no telemetry" is not claimed here.
 *   --disable-version-check  no call to semgrep.dev on startup
 *   --error                  exit non-zero on a finding (see no-op 1 above)
 */
const NETWORK_FLAGS: readonly string[] = ['--metrics=off', '--disable-version-check'];
const SCAN_FLAGS: readonly string[] = [...NETWORK_FLAGS, '--error', '--json', '--quiet'];

/** Environment variables that would change where rules come from, or send data. */
const FORBIDDEN_ENV: readonly string[] = [
  'SEMGREP_APP_TOKEN', // logs the scan in to the Semgrep platform
  'SEMGREP_RULES', // an implicit --config
  'SEMGREP_REPO_URL',
  'SEMGREP_SEND_METRICS',
];

/**
 * The environment EVERY semgrep invocation gets: the caller's, minus anything
 * that would redirect rules or send data, plus the version-check kill switch.
 * QA-F2: section 1's version probe used to bypass this and it was the entire
 * source of the semgrep.dev lookups.
 */
function semgrepEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !FORBIDDEN_ENV.includes(k)) env[k] = v;
  }
  env['SEMGREP_ENABLE_VERSION_CHECK'] = '0';
  return env;
}

interface SemgrepPosition {
  readonly line: number;
}
interface SemgrepResult {
  readonly check_id: string;
  readonly path: string;
  readonly start: SemgrepPosition;
}
interface SemgrepPaths {
  readonly scanned?: readonly string[];
}
interface SemgrepOutput {
  readonly results: readonly SemgrepResult[];
  readonly errors: readonly unknown[];
  readonly paths?: SemgrepPaths;
}
interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnFailed: boolean;
}

/** A rule id as Semgrep reports it is namespaced by the config's path. */
const bareId = (checkId: string): string => checkId.split('.').pop() ?? checkId;

function runSemgrep(cwd: string, configPath: string, target: string): Run {
  const r = spawnSync('semgrep', ['scan', '--config', configPath, ...SCAN_FLAGS, target], {
    cwd,
    encoding: 'utf8',
    env: semgrepEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    return { code: 127, stdout: '', stderr: r.error.message, spawnFailed: true };
  }
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    spawnFailed: false,
  };
}

/**
 * Parse a run into results, or explain why it cannot be believed. Any of:
 * a spawn failure, exit >= 2, unparseable JSON, or a non-empty `errors` array
 * is a CRASH, not a verdict — Semgrep reports an invalid rule file as exit 7
 * with an errors entry, which must never read as "no findings".
 */
function readRun(r: Run, label: string): SemgrepOutput | string {
  if (r.spawnFailed) {
    return `SEMGREP: ${label}: semgrep could not be executed (${r.stderr.trim().slice(0, 160)}). It lives in the toolbox image — run \`scripts/dev --build\`.`;
  }
  if (r.code !== 0 && r.code !== 1) {
    return `SEMGREP: ${label}: semgrep exited ${String(r.code)} — that is an ERROR, not a verdict. stderr: ${r.stderr.trim().slice(0, 300)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return `SEMGREP: ${label}: semgrep's --json output did not parse (${r.stdout.length} bytes). Treated as a crash, never as a clean run.`;
  }
  const out = parsed as SemgrepOutput;
  if (!Array.isArray(out.results) || !Array.isArray(out.errors)) {
    return `SEMGREP: ${label}: --json output has no results/errors arrays; shape not recognised.`;
  }
  if (out.errors.length > 0) {
    return `SEMGREP: ${label}: semgrep reported ${String(out.errors.length)} engine/rule error(s): ${JSON.stringify(out.errors).slice(0, 300)}`;
  }
  // Cross-check the two signals (no-op 1): --error must make findings non-zero.
  if (out.results.length > 0 && r.code === 0) {
    return `SEMGREP: ${label}: ${String(out.results.length)} finding(s) reported at exit 0 — --error is not taking effect, so the exit status cannot be trusted.`;
  }
  if (out.results.length === 0 && r.code === 1) {
    return `SEMGREP: ${label}: exit 1 with no findings in the JSON — status and output disagree.`;
  }
  return out;
}

/**
 * Read a file that MUST be a readable regular file, or return the reason it is
 * not. A directory and a chmod-000 file both used to reach readFileSync and
 * throw past every banner (QA-F1's class).
 */
function readRegularFile(file: string, tag: string): { text: string } | { why: string } {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return { why: `${tag}: ${rel(file)} cannot be inspected: ${describe(e)}` };
  }
  if (st.isDirectory()) {
    return {
      why: `${tag}: ${rel(file)} is a DIRECTORY, not a rule file. The gate has no rules it can read, which is a failure and never a pass.`,
    };
  }
  if (!st.isFile()) {
    return { why: `${tag}: ${rel(file)} is not a regular file.` };
  }
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return {
      why: `${tag}: ${rel(file)} exists but cannot be READ: ${describe(e)}. An unreadable rule set must not look like a clean tree.`,
    };
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return `${e.name}${code === undefined ? '' : ` [${code}]`}: ${e.message}`;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// The self-test corpus. One entry per rule id in .semgrep.yml; a rule without
// one fails the gate.
//
// Each line is tagged `true` if the rule MUST match it and `false` if it MUST
// NOT. The expected line numbers are computed from the array, so editing the
// corpus cannot desynchronise it from its own expectations — and because the
// comparison is an exact SET, a rule that stops catching a shape and a rule
// that starts flagging a control both turn this red.
// ---------------------------------------------------------------------------
interface SelfTest {
  /** Path under the fixture root; must satisfy the rule's own `paths:`. */
  readonly file: string;
  /** [source line, must this rule match it?] */
  readonly lines: readonly (readonly [string, boolean])[];
}

const SELF_TESTS: ReadonlyMap<string, SelfTest> = new Map([
  [
    'no-any',
    {
      file: 'packages/policy/src/selftest.ts',
      lines: [
        // --- must match: fifteen shapes an `any` can take in TypeScript
        ['export function s1(x: any): void { void x; }', true],
        ['export const s2: any = 1;', true],
        ['export function s3(): any { return 1; }', true],
        ['export const s4 = 1 as any;', true],
        ['export const s5 = <any>1;', true],
        ['export type S6 = any;', true],
        ['export const s7: Array<any> = [];', true],
        ['export const s8: any[] = [];', true],
        ['export const s9: Record<string, any> = {};', true],
        ['export interface S10 { k: any }', true],
        ['export const s11 = (m: any) => m;', true],
        ['export type S12 = { o: string } | any;', true],
        ['export class S13 { q: any = 1; }', true],
        ['export const s14 = new Map<string, any>();', true],
        ['export function s15<T = any>(t: T): T { return t; }', true],
        // --- must NOT match: the false positives a textual rule invites
        ['// any in a line comment', false],
        ['/* any in a block comment */', false],
        ["export const c1 = 'any';", false],
        ['export const c2 = "double any";', false],
        ['export const c3: unknown = 1;', false],
        ['export const anyway = 1;', false],
        ['export const c4 = { any: 1 };', false],
        ['export const c5 = c4.any;', false],
        ['export const c6 = `template any`;', false],
      ],
    },
  ],
]);

const ruleIds: string[] = [];
let scannedCount = -1;
let findingCount = 0;

// ---------------------------------------------------------------------------
// 1. The tool itself.
// ---------------------------------------------------------------------------
function sectionTool(): void {
  console.log('1. TOOL — semgrep is present and matches its pin\n');

  const pinned = toolVersions().get('semgrep');
  // QA-F4: a missing pin used to make the comparison below a NO-OP — the gate
  // printed `(pinned undefined)` and passed while checking nothing. gate:toolbox
  // catches it, but a gate that reports success while asserting nothing is the
  // defect class this file is about, so it is refused here too.
  if (pinned === undefined) {
    failures.push(
      'CONFIG: .tool-versions declares no `semgrep` pin, so there is nothing to check this ' +
        'binary against. A gate whose version assertion has no expected value is asserting ' +
        'nothing; add the pin (and see the .tool-versions header for the two obligations ' +
        'that follow it).',
    );
  }

  // The version probe carries the same no-network environment as every other
  // invocation (QA-F2). Measured with a DNS sink: bare, this call produced 32
  // lookups of semgrep.dev; with the kill switch, 0.
  const ver = spawnSync('semgrep', ['--version', '--disable-version-check'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: semgrepEnv(),
  });
  if (ver.error !== undefined) {
    failures.push(
      'CONFIG: semgrep is not on PATH. It lives in the toolbox image — run `scripts/dev --build`.',
    );
    return;
  }
  const found = (ver.stdout ?? '').trim().split('\n')[0] ?? '';
  console.log(`  semgrep ${found} (pinned ${pinned ?? 'NOTHING — see the failure below'})`);
  if (pinned !== undefined && found !== pinned) {
    failures.push(`CONFIG: semgrep ${found} != .tool-versions pin ${pinned}; rebuild the toolbox`);
  }
}

// ---------------------------------------------------------------------------
// 2. The network posture, asserted before anything runs.
// ---------------------------------------------------------------------------
function sectionNetwork(): void {
  console.log('\n2. NETWORK — rules are local, and no invocation checks its version\n');

  for (const key of FORBIDDEN_ENV) {
    const v = process.env[key];
    if (v !== undefined && v !== '') {
      failures.push(
        `CONFIG: ${key} is set. This gate runs committed local rules with no network; ` +
          'a token, an implicit --config or a metrics setting from the environment would change ' +
          'what runs or what is sent. Unset it.',
      );
    }
  }
  console.log(`  ok no ${FORBIDDEN_ENV.join(' / ')} in the environment`);
  console.log(`  ok flags: ${SCAN_FLAGS.join(' ')}`);
  console.log(`  ok config is a local path: ${rel(RULES_FILE)}`);
  console.log('  ok every semgrep invocation carries SEMGREP_ENABLE_VERSION_CHECK=0');
  // What was MEASURED, in the register of a measurement (PROTOCOL §5.1). Not
  // "no telemetry": this instrument sees resolution attempts, not payloads.
  console.log(
    "  NOTE: measured T-133 rework 1 with a UDP DNS sink as the container's only\n" +
      '        resolver, its control firing: 0 lookups of semgrep.dev across a\n' +
      '        whole gate run. Nothing is claimed about payloads, or about semgrep\n' +
      "        under any configuration other than this gate's own.",
  );
}

// ---------------------------------------------------------------------------
// 3. The rule file.
// ---------------------------------------------------------------------------
interface RuleDoc {
  readonly rules?: unknown;
}

function sectionRules(): void {
  console.log('\n3. RULES — the committed rule file is present, parses and defines rules\n');

  if (!fs.existsSync(RULES_FILE)) {
    failures.push(
      `RULES: ${rel(RULES_FILE)} does not exist. The gate has no rules to run, ` +
        'which is a failure and never a pass — a missing rule set and a clean tree must not look alike.',
    );
  } else {
    const read = readRegularFile(RULES_FILE, 'RULES');
    if ('why' in read) {
      failures.push(read.why);
    } else if (read.text.trim() === '') {
      failures.push(
        `RULES: ${rel(RULES_FILE)} is empty. An empty rule set matches nothing ` +
          'and would report a clean tree forever.',
      );
    } else {
      readRuleList(read.text);
    }
  }

  checkIgnoreFile();
}

function readRuleList(text: string): void {
  let doc: RuleDoc | undefined;
  try {
    // parse() THROWS on a source holding more than one YAML document
    // ("Source contains multiple documents"). That is the fail-closed direction
    // and it is deliberate — see T-130/OD-41, where reading only the first
    // document of a multi-document file hid a whole service from two gates.
    doc = parse(text) as RuleDoc;
  } catch (e) {
    failures.push(`RULES: ${rel(RULES_FILE)} is not valid YAML: ${describe(e)}`);
    return;
  }

  const rules: unknown = doc === null || doc === undefined ? undefined : doc.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    failures.push(
      `RULES: ${rel(RULES_FILE)} declares no rules (expected a non-empty \`rules:\` list).`,
    );
    return;
  }

  const seen = new Set<string>();
  for (const [i, entry] of rules.entries()) {
    const where = `rule #${String(i + 1)}`;
    // QA-F1: `- ` on its own is a null list item, and a null reached `.id`
    // unguarded — an uncaught TypeError, exit 1, no banner. A string or a
    // nested list are the same shape of slip.
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(
        `RULES: ${where} in ${rel(RULES_FILE)} is not a mapping (got ${entry === null ? 'null' : Array.isArray(entry) ? 'a list' : typeof entry}). ` +
          'An empty or malformed list item is a rule the engine will never run; it is refused ' +
          'here rather than crashing the gate.',
      );
      continue;
    }
    const r = entry as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : '';
    if (id === '') {
      failures.push(`RULES: ${where} in ${rel(RULES_FILE)} has no id`);
      continue;
    }
    if (seen.has(id)) {
      failures.push(
        `RULES: duplicate rule id '${id}' in ${rel(RULES_FILE)}. Ids key the self-test table, ` +
          'so a duplicate would let one rule stand in for the proof of another.',
      );
      continue;
    }
    seen.add(id);
    ruleIds.push(id);
    const message = r['message'];
    if (typeof message !== 'string' || message.trim() === '') {
      failures.push(`RULES: rule '${id}' has no message`);
    }
    const languages = r['languages'];
    if (!Array.isArray(languages) || languages.length === 0) {
      failures.push(`RULES: rule '${id}' declares no languages`);
    }
    if (!SELF_TESTS.has(id)) {
      failures.push(
        `SELFTEST: rule '${id}' has no self-test in scripts/gates/semgrep.ts. A rule whose ` +
          'pattern matches nothing is invisible at exit 0, so every rule must prove it fires ' +
          'on a known-bad fixture and stays silent on the controls.',
      );
    }
  }
  if (ruleIds.length > 0) {
    console.log(`  ok ${String(ruleIds.length)} rule(s): ${ruleIds.join(', ')}`);
  }
}

/**
 * .semgrepignore removes coverage, so an entry that names a scanned tree is
 * refused.
 *
 * WHAT THIS CHECK ACTUALLY TESTS, stated at its true width (QA-F3, rework 1):
 * the literal TEXT of each live entry, for the substrings `packages` or `apps`.
 * That is derived from the same reading as the thing it checks (PROTOCOL §5.1),
 * so an entry that names the same tree ANOTHER way is NOT caught: `policy/` and
 * `*.ts` both give GATE PASS at exit 0 with `0 file(s) scanned` — measured by
 * qa-verification. The check that would close it is an anti-vacuity assertion
 * (the count of files actually scanned under packages/ must be non-zero), and
 * it CANNOT be added here: packages/policy holds no source yet, so it would be
 * red on a clean tree. It is carried to T-024 in CONTRACTS.md — the ticket that
 * lands that source — and until then a green gate:semgrep is not evidence that
 * any rule ran over any code. Comment lines are stripped before the test so a
 * commented-out entry cannot satisfy it (T-036 / OD-26's shape).
 */
function checkIgnoreFile(): void {
  if (!fs.existsSync(IGNORE_FILE)) {
    failures.push(
      'RULES: .semgrepignore is missing. Without it semgrep applies its BUILT-IN defaults, which ' +
        'silently skip test/ and tests/ directories — measured in T-133 — so a rule scoped to a ' +
        'package would not apply to two ordinary directory names, at exit 0.',
    );
    return;
  }
  const read = readRegularFile(IGNORE_FILE, 'RULES');
  if ('why' in read) {
    failures.push(read.why);
    return;
  }
  const live = read.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const exempts = live.filter((l) => /(^|\/)(packages|apps)(\/|$)/.test(l));
  if (exempts.length > 0) {
    failures.push(
      `RULES: .semgrepignore exempts source paths (${exempts.join(', ')}). That removes coverage ` +
        'from a rule scope silently; remove the entry or narrow the rule instead.',
    );
    return;
  }
  console.log(
    `  ok .semgrepignore: ${String(live.length)} live entries, none whose TEXT names ` +
      'packages/ or apps/',
  );
}

// ---------------------------------------------------------------------------
// 4. SELF-TEST — every rule fires on known-bad code and is silent on controls.
// ---------------------------------------------------------------------------
function sectionSelfTest(): void {
  console.log('\n4. SELF-TEST — each rule proves it still matches what it claims to\n');

  if (failures.length > 0) {
    console.log(
      '  -- skipped: the rule set above is not usable, so a self-test would prove nothing',
    );
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvara-gate-semgrep-'));
  try {
    for (const id of ruleIds) {
      const spec = SELF_TESTS.get(id);
      if (spec === undefined) continue;
      const file = path.join(dir, spec.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, spec.lines.map(([src]) => src).join('\n') + '\n');

      const run = runSemgrep(dir, RULES_FILE, '.');
      const read = readRun(run, `self-test '${id}'`);
      if (typeof read === 'string') {
        failures.push(read);
        continue;
      }

      const scanned = read.paths?.scanned ?? [];
      if (scanned.length === 0) {
        failures.push(
          `SELFTEST: rule '${id}': semgrep scanned NO files of the fixture. The run proved nothing — ` +
            'this is the "did nothing" outcome, not a pass.',
        );
        continue;
      }

      const got = new Set(
        read.results.filter((r) => bareId(r.check_id) === id).map((r) => r.start.line),
      );
      const want = new Set(
        spec.lines.map(([, must], i) => (must ? i + 1 : 0)).filter((n) => n !== 0),
      );
      const missed = [...want].filter((n) => !got.has(n)).sort((a, b) => a - b);
      const spurious = [...got].filter((n) => !want.has(n)).sort((a, b) => a - b);

      if (missed.length > 0) {
        failures.push(
          `SELFTEST: rule '${id}' did NOT match ${String(missed.length)} known-bad line(s): ` +
            missed.map((n) => `${String(n)} (${spec.lines[n - 1]?.[0] ?? '?'})`).join('; '),
        );
      }
      if (spurious.length > 0) {
        failures.push(
          `SELFTEST: rule '${id}' matched ${String(spurious.length)} control line(s) it must not: ` +
            spurious.map((n) => `${String(n)} (${spec.lines[n - 1]?.[0] ?? '?'})`).join('; '),
        );
      }
      if (missed.length === 0 && spurious.length === 0) {
        console.log(
          `  ok ${id.padEnd(12)} matched all ${String(want.size)} known-bad lines, none of the ` +
            `${String(spec.lines.length - want.size)} controls`,
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. The scan of this repository.
// ---------------------------------------------------------------------------
function sectionScan(): void {
  console.log('\n5. SCAN — the committed rules over the working tree\n');

  if (failures.length > 0) {
    console.log(
      '  -- skipped: an earlier section failed, so a scan result would not be meaningful',
    );
    return;
  }

  const run = runSemgrep(REPO_ROOT, RULES_FILE, '.');
  const read = readRun(run, 'scan');
  if (typeof read === 'string') {
    failures.push(read);
    return;
  }
  const scanned = read.paths?.scanned ?? [];
  scannedCount = scanned.length;
  findingCount = read.results.length;
  console.log(`  files in scope and scanned: ${String(scannedCount)}`);
  if (scannedCount === 0) {
    // Not a failure: the rule is scoped to packages/policy, whose source is
    // T-024's and does not exist yet. Say so on stdout rather than passing
    // silently (T-001 § contract, rule 2). Section 4 is what keeps the rule
    // honest while its scope is empty.
    console.log(
      "  NOTE: no file matched the rules' paths. The gate is VACUOUS on this tree — the rule\n" +
        '        set is proven by the self-test above, not by this scan.',
    );
  }
  for (const r of read.results) {
    failures.push(`FINDING: ${bareId(r.check_id)} — ${r.path}:${String(r.start.line)}`);
  }
}

// ---------------------------------------------------------------------------
// Run, and make sure EVERY exit path prints the banner (QA-F1).
// ---------------------------------------------------------------------------
function report(): never {
  const kind = (tag: string): boolean => failures.some((f) => f.startsWith(tag));
  const outcome =
    failures.length === 0
      ? `CLEAN — ${String(scannedCount)} file(s) scanned, 0 findings`
      : kind('HARNESS:')
        ? 'GATE HARNESS ERROR — gate:semgrep itself threw; this is NOT a verdict about the tree'
        : kind('FINDING:')
          ? `VIOLATIONS — ${String(findingCount)} finding(s)`
          : kind('SELFTEST:')
            ? 'RULE SET NOT PROVEN — a rule failed its own self-test'
            : kind('RULES:')
              ? 'RULE SET UNUSABLE — missing, empty or invalid'
              : kind('SEMGREP:')
                ? 'SEMGREP ERROR — the run crashed or contradicted itself'
                : 'CONFIG ERROR — the tool or its environment is wrong';
  console.log(`\nOUTCOME: ${outcome}`);
  finish('gate:semgrep', failures);
}

// A last resort for anything that escapes the try below — an async callback, a
// rejected promise. Without it such a throw exits 1 with no banner, which is
// exactly the shape QA-F1 found.
process.on('uncaughtException', (e: unknown) => {
  failures.push(`HARNESS: uncaught exception in gate:semgrep — ${describe(e)}`);
  report();
});
process.on('unhandledRejection', (e: unknown) => {
  failures.push(`HARNESS: unhandled rejection in gate:semgrep — ${describe(e)}`);
  report();
});

try {
  sectionTool();
  sectionNetwork();
  sectionRules();
  sectionSelfTest();
  sectionScan();
} catch (e) {
  failures.push(
    `HARNESS: gate:semgrep threw while running — ${describe(e)}. The gate crashed; it did NOT ` +
      'examine the tree, and this must never be read as a clean run.',
  );
}

report();
