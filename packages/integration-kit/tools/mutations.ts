/**
 * T-142's mutation harness: each mechanism the gate names, deleted or moved, must turn the tests
 * that claim it red. Run: `pnpm --filter @kinvara/integration-kit exec node tools/mutations.ts`.
 *
 * It never edits the working tree. Each run copies `src/` and `package.json` into a fresh temp
 * directory (with `node_modules` symlinked back), applies ONE fixed-string replacement there, and
 * runs Vitest against the copy with a JSON report.
 *
 * PROTOCOL §5.1, "if your check did nothing at all, would it say so?" — each of these is a
 * distinct outcome and none reads as another:
 *   - HARNESS ERROR: the find string does not occur exactly once, the written copy does not carry
 *     the replacement, the copy differs from the original in anything but it, Vitest wrote no
 *     report, or the CONTROL run (the unmutated copy) is not all green;
 *   - NOT RED: the mutation landed and a named test still passed, or the run lost tests (a file
 *     that failed to load is a crash, not a refusal: every mutant must register the CONTROL's
 *     count of tests, file by file);
 *   - RED: exit non-zero, every named test present with status `failed`, and the count intact.
 * Exit 0 only if the CONTROL passed and every mutant is RED.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Mutant {
  readonly id: string;
  readonly mechanism: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly red: readonly string[];
}

const T = {
  no4xx:
    'no retry on a 4xx: 400, 401, 403, 404, 405, 409, 410, 412, 413 and 422 each come back after exactly one attempt',
  retryable: 'isRetryableStatus is true for 429 and 500 to 599 and false for every other status from 100 to 499',
  fourxxBreaker: 'a 4xx is a success for the breaker: 20 consecutive 404s leave it closed',
  opens: 'the breaker opens at 50% failure over 20 calls: 10 failed of 20 opens it and the next call is refused',
  refusesThroughCaller:
    'through the caller: an open breaker refuses the next call without reaching the transport, as upstream_unavailable with reason circuit_open',
  whileOpen:
    'while open every call is refused; at 30000 ms exactly one probe is admitted and a second call is still refused',
  breakerPin: 'BREAKER pins SD INT: opens at 50% failure over 20 calls in 60000 ms, probe after 30000 ms',
  timeout2s:
    'the request-path timeout is 2 s: an attempt still pending at 1999 ms is not aborted, and at 2000 ms it is',
  timeoutSix:
    'a call whose every attempt times out settles as upstream_unavailable after six attempts, at 12000 ms and not before',
  worker5s: 'a worker caller passing the 5 s timeout is not aborted at 4999 ms and is at 5000 ms',
  timeoutPin:
    'TIMEOUT_MS pins SD INT: 2000 ms request path, 5000 ms worker, 10000 ms provider-hosted redirect creation',
  jitterHalf: 'full jitter: with random() = 0.5 the five waits are 100, 200, 400, 800 and 1600 ms',
  jitterCap:
    'full jitter: with random() just under 1 each wait stays below its cap of 200, 400, 800, 1600 and 3200 ms',
  stopAtFive:
    'retries stop at five: a persistent 503 is attempted six times and then thrown as upstream_unavailable',
  retryPin: 'RETRY pins SD INT: caps of 200, 400, 800, 1600 and 3200 ms, at most 5 retries',
} as const;

const MUTANTS: readonly Mutant[] = [
  {
    id: 'M1',
    mechanism: 'no retry on a 4xx: the 5xx lower bound moved to 400',
    file: 'src/caller.ts',
    find: '(status >= 500 && status <= 599)',
    replace: '(status >= 400 && status <= 599)',
    red: [T.no4xx, T.retryable, T.fourxxBreaker],
  },
  {
    id: 'M2',
    mechanism: 'the breaker trip deleted',
    file: 'src/breaker.ts',
    find: 'failures / window.length >= BREAKER.failureRatio',
    replace: 'false',
    red: [T.opens, T.refusesThroughCaller],
  },
  {
    id: 'M3',
    mechanism: 'the breaker threshold moved from 50% to 55%',
    file: 'src/policy.ts',
    find: 'failureRatio: 0.5,',
    replace: 'failureRatio: 0.55,',
    red: [T.opens, T.breakerPin],
  },
  {
    id: 'M4',
    mechanism: 'the refusal while open deleted: acquire admits every call',
    file: 'src/breaker.ts',
    find: '      return undefined;',
    replace: '      const admitted: Permit = Object.freeze({ probe: false });\n      issued.add(admitted);\n      return admitted;',
    red: [T.opens, T.whileOpen, T.refusesThroughCaller],
  },
  {
    id: 'M5',
    mechanism: 'the timeout deleted: the timer fires and neither aborts nor ends the attempt',
    file: 'src/caller.ts',
    find: "      controller.abort();\n      resolve({ kind: 'timeout' });\n",
    replace: '',
    red: [T.timeout2s, T.timeoutSix, T.worker5s],
  },
  {
    id: 'M6',
    mechanism: 'the request-path timeout moved from 2000 ms to 2500 ms',
    file: 'src/policy.ts',
    find: 'requestPath: 2_000,',
    replace: 'requestPath: 2_500,',
    red: [T.timeout2s, T.timeoutSix, T.timeoutPin],
  },
  {
    id: 'M7',
    mechanism: 'the jitter deleted: every wait is its full cap',
    file: 'src/caller.ts',
    find: 'Math.floor(r * cap)',
    replace: 'cap',
    red: [T.jitterHalf, T.jitterCap],
  },
  {
    id: 'M8',
    mechanism: 'the retry limit moved from 5 to 4',
    file: 'src/policy.ts',
    find: 'maxRetries: 5,',
    replace: 'maxRetries: 4,',
    red: [T.stopAtFive, T.timeoutSix, T.retryPin],
  },
];

interface FileResult {
  name: string;
  assertionResults: { title: string; status: string }[];
}
interface Report {
  numTotalTests: number;
  numFailedTests: number;
  success: boolean;
  testResults: FileResult[];
}
interface Run {
  readonly status: number | null;
  readonly report: Report | undefined;
}

function runCopy(mutant: Mutant | undefined): Run {
  const tmp = mkdtempSync(join(tmpdir(), 'integration-kit-mutant-'));
  try {
    cpSync(join(PKG, 'src'), join(tmp, 'src'), { recursive: true });
    cpSync(join(PKG, 'package.json'), join(tmp, 'package.json'));
    symlinkSync(join(PKG, 'node_modules'), join(tmp, 'node_modules'));

    if (mutant !== undefined) {
      const target = join(tmp, mutant.file);
      const original = readFileSync(target, 'utf8');
      const hits = original.split(mutant.find).length - 1;
      if (hits !== 1) harnessError(`${mutant.id}: the find string occurs ${String(hits)} times in ${mutant.file}, not once`);
      const mutated = original.replace(mutant.find, () => mutant.replace);
      writeFileSync(target, mutated);
      const readBack = readFileSync(target, 'utf8');
      if (readBack === original) harnessError(`${mutant.id}: the written copy is unchanged`);
      if (mutant.replace !== '' && !readBack.includes(mutant.replace)) {
        harnessError(`${mutant.id}: the written copy does not carry the replacement`);
      }
      if (readBack.split(mutant.find).length - 1 !== 0 && !mutant.replace.includes(mutant.find)) {
        harnessError(`${mutant.id}: the find string is still present after the replacement`);
      }
      console.log(`${mutant.id}: landed in ${mutant.file} (1 occurrence replaced; ${String(original.length)} -> ${String(readBack.length)} bytes)`);
    }

    const reportPath = join(tmp, 'report.json');
    const run = spawnSync(
      join(PKG, 'node_modules', '.bin', 'vitest'),
      ['run', '--reporter=json', `--outputFile.json=${reportPath}`],
      { cwd: tmp, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 },
    );
    const report = existsSync(reportPath)
      ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Report)
      : undefined;
    return { status: run.status, report };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function harnessError(message: string): never {
  console.error(`HARNESS ERROR  ${message}`);
  process.exit(3);
}

const perFile = (r: Report): Map<string, number> =>
  new Map(r.testResults.map((f) => [basename(f.name), f.assertionResults.length]));

const control = runCopy(undefined);
if (control.report === undefined) harnessError('CONTROL: vitest wrote no report');
if (control.status !== 0 || !control.report.success || control.report.numFailedTests !== 0) {
  harnessError(`CONTROL: the unmutated copy is not green (exit ${String(control.status)}, failed ${String(control.report.numFailedTests)})`);
}
const controlFiles = perFile(control.report);
console.log(
  `CONTROL: exit 0, ${String(control.report.numTotalTests)} tests passed in ${String(controlFiles.size)} files ` +
    `(${[...controlFiles].map(([f, n]) => `${f} ${String(n)}`).join(', ')})`,
);

let red = 0;
for (const m of MUTANTS) {
  const run = runCopy(m);
  const problems: string[] = [];
  if (run.report === undefined) harnessError(`${m.id}: vitest wrote no report (exit ${String(run.status)})`);
  const r = run.report;
  if (run.status === 0) problems.push('vitest exited 0');
  const files = perFile(r);
  for (const [f, n] of controlFiles) {
    if (files.get(f) !== n) {
      problems.push(`${f} registered ${String(files.get(f) ?? 0)} tests, CONTROL ${String(n)} (a crash, not a refusal)`);
    }
  }
  const status = new Map(r.testResults.flatMap((f) => f.assertionResults.map((a) => [a.title, a.status])));
  for (const title of m.red) {
    const s = status.get(title);
    if (s !== 'failed') problems.push(`named test ${s === undefined ? 'ABSENT' : s.toUpperCase()}: ${title}`);
  }
  const failed = [...status].filter(([, s]) => s === 'failed').map(([t]) => t);
  if (problems.length === 0) {
    red++;
    console.log(`RED      ${m.id}  ${m.mechanism}  (exit ${String(run.status)}; ${String(failed.length)} of ${String(r.numTotalTests)} failed)`);
  } else {
    console.log(`NOT RED  ${m.id}  ${m.mechanism}  (exit ${String(run.status)}; ${String(failed.length)} of ${String(r.numTotalTests)} failed)`);
    for (const p of problems) console.log(`           - ${p}`);
  }
  for (const t of failed) console.log(`           failed: ${t}`);
}

if (red !== MUTANTS.length) {
  console.error(`\nMUTATIONS FAIL  ${String(red)} of ${String(MUTANTS.length)} mutants red`);
  process.exit(1);
}
console.log(`\nMUTATIONS PASS  ${String(red)} of ${String(MUTANTS.length)} mutants red, CONTROL green`);
