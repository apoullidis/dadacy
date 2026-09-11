/**
 * gate:semgrep — the Semgrep project rules (SD §QD-4 PR row, SD §DH-2). T-133.
 *
 * It runs COMMITTED, LOCAL rule files only: --config is always .semgrep.yml in
 * this repository. No registry rule, no `--config auto`, no URL, no token. The
 * gate is green with networking disabled, which is what lets it run under
 * `scripts/svc run`, where there is no egress at all (DOCKER.md §7).
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
 * So "refused", "crashed" and "did nothing" are three distinguishable
 * outcomes here: every run prints one OUTCOME line, and each failure reason is
 * tagged FINDING / RULES / SELFTEST / SEMGREP / CONFIG.
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

/**
 * The flags every invocation carries. They are constants, not parameters,
 * because the network posture is a property of the gate and not of the caller:
 *   --metrics=off            no telemetry, ever
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
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !FORBIDDEN_ENV.includes(k)) env[k] = v;
  }
  env['SEMGREP_ENABLE_VERSION_CHECK'] = '0';
  const r = spawnSync('semgrep', ['scan', '--config', configPath, ...SCAN_FLAGS, target], {
    cwd,
    encoding: 'utf8',
    env,
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

// ---------------------------------------------------------------------------
// 1. The tool itself.
// ---------------------------------------------------------------------------
console.log('1. TOOL — semgrep is present and matches its pin\n');

const pinned = toolVersions().get('semgrep');
const ver = spawnSync('semgrep', ['--version'], { encoding: 'utf8', cwd: REPO_ROOT });
if (ver.error !== undefined) {
  failures.push(
    'CONFIG: semgrep is not on PATH. It lives in the toolbox image — run `scripts/dev --build`.',
  );
} else {
  const found = (ver.stdout ?? '').trim().split('\n')[0] ?? '';
  console.log(`  semgrep ${found} (pinned ${String(pinned)})`);
  if (pinned !== undefined && found !== pinned) {
    failures.push(`CONFIG: semgrep ${found} != .tool-versions pin ${pinned}; rebuild the toolbox`);
  }
}

// ---------------------------------------------------------------------------
// 2. The network posture, asserted before anything runs.
// ---------------------------------------------------------------------------
console.log('\n2. NETWORK — local rules only, no telemetry, no registry\n');

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
console.log(`  ok config is a local path: ${path.relative(REPO_ROOT, RULES_FILE)}`);

// ---------------------------------------------------------------------------
// 3. The rule file.
// ---------------------------------------------------------------------------
console.log('\n3. RULES — the committed rule file is present, parses and defines rules\n');

interface RuleDoc {
  readonly rules?: readonly {
    readonly id?: unknown;
    readonly languages?: unknown;
    readonly message?: unknown;
    readonly severity?: unknown;
  }[];
}

const ruleIds: string[] = [];
if (!fs.existsSync(RULES_FILE)) {
  failures.push(
    `RULES: ${path.relative(REPO_ROOT, RULES_FILE)} does not exist. The gate has no rules to run, ` +
      'which is a failure and never a pass — a missing rule set and a clean tree must not look alike.',
  );
} else {
  const text = fs.readFileSync(RULES_FILE, 'utf8');
  if (text.trim() === '') {
    failures.push(
      `RULES: ${path.relative(REPO_ROOT, RULES_FILE)} is empty. An empty rule set matches nothing ` +
        'and would report a clean tree forever.',
    );
  } else {
    let doc: RuleDoc | undefined;
    try {
      doc = parse(text) as RuleDoc;
    } catch (e) {
      failures.push(
        `RULES: ${path.relative(REPO_ROOT, RULES_FILE)} is not valid YAML: ${String(e)}`,
      );
    }
    const rules = doc?.rules;
    if (doc !== undefined && (!Array.isArray(rules) || rules.length === 0)) {
      failures.push(
        `RULES: ${path.relative(REPO_ROOT, RULES_FILE)} declares no rules (expected a non-empty \`rules:\` list).`,
      );
    } else if (Array.isArray(rules)) {
      for (const r of rules) {
        const id = typeof r.id === 'string' ? r.id : '';
        if (id === '') {
          failures.push('RULES: a rule in the file has no id');
          continue;
        }
        ruleIds.push(id);
        if (typeof r.message !== 'string' || r.message.trim() === '') {
          failures.push(`RULES: rule '${id}' has no message`);
        }
        if (!Array.isArray(r.languages) || r.languages.length === 0) {
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
      console.log(`  ok ${String(ruleIds.length)} rule(s): ${ruleIds.join(', ')}`);
    }
  }
}

// The scope guard: .semgrepignore removes coverage, so it may not exempt the
// very tree a rule is scoped to. Comment lines are stripped before the test so
// that a commented-out entry cannot satisfy it (T-036 / OD-26's shape).
if (!fs.existsSync(IGNORE_FILE)) {
  failures.push(
    'RULES: .semgrepignore is missing. Without it semgrep applies its BUILT-IN defaults, which ' +
      'silently skip test/ and tests/ directories — measured in T-133 — so a rule scoped to a ' +
      'package would not apply to two ordinary directory names, at exit 0.',
  );
} else {
  const live = fs
    .readFileSync(IGNORE_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const exempts = live.filter((l) => /(^|\/)(packages|apps)(\/|$)/.test(l));
  if (exempts.length > 0) {
    failures.push(
      `RULES: .semgrepignore exempts source paths (${exempts.join(', ')}). That removes coverage ` +
        'from a rule scope silently; remove the entry or narrow the rule instead.',
    );
  } else {
    console.log(
      `  ok .semgrepignore has ${String(live.length)} entries, none under packages/ or apps/`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. SELF-TEST — every rule fires on known-bad code and is silent on controls.
// ---------------------------------------------------------------------------
console.log('\n4. SELF-TEST — each rule proves it still matches what it claims to\n');

if (failures.length === 0) {
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
} else {
  console.log('  -- skipped: the rule set above is not usable, so a self-test would prove nothing');
}

// ---------------------------------------------------------------------------
// 5. The scan of this repository.
// ---------------------------------------------------------------------------
console.log('\n5. SCAN — the committed rules over the working tree\n');

let scannedCount = -1;
let findingCount = 0;
if (failures.length === 0) {
  const run = runSemgrep(REPO_ROOT, RULES_FILE, '.');
  const read = readRun(run, 'scan');
  if (typeof read === 'string') {
    failures.push(read);
  } else {
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
} else {
  console.log('  -- skipped: an earlier section failed, so a scan result would not be meaningful');
}

// ---------------------------------------------------------------------------
// The one-line outcome, so that "refused", "crashed" and "did nothing" are
// never the same line.
// ---------------------------------------------------------------------------
const kind = (tag: string): boolean => failures.some((f) => f.startsWith(tag));
const outcome =
  failures.length === 0
    ? `CLEAN — ${String(scannedCount)} file(s) scanned, 0 findings`
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
