/**
 * gate:negative-suites — T-005, closing OD-152.
 *
 * THE DEFECT THIS EXISTS FOR. Every gate contract in this build cites a
 * negative suite as the test that falsifies it. No gate ran one. In eight days
 * that cost three findings, none of which anything noticed:
 *
 *   OD-120  app-images.sh case 21 misjudged from T-135 until T-156.
 *   OD-154  db-introspect.sh red on `main` since T-146 merged — a merged
 *           migration silently invalidated another ticket's committed cases.
 *   OD-161a schema-typecheck.sh case S09 red on `main` since T-141 merged.
 *
 * All three have the same shape: a suite written against a placeholder that
 * another ticket then filled in. That is why the suites run on EVERY PR and not
 * only when a gate script changes — the input that breaks them is the input
 * nobody thinks of as related.
 *
 * ---------------------------------------------------------------------------
 * HOW A SUITE IS JUDGED. Never by exit status alone. Every suite here prints
 * one of two footers and this gate requires the right one, with the right
 * number in it:
 *
 *     ALL <n> CASES BEHAVED AS EXPECTED        (green)
 *     !! <b> of <n> CASE(S) MISBEHAVED / cases misbehaved   (red)
 *
 * and <n> is held against a PINNED case count. That pin is the anti-vacuity
 * anchor, and it is the point: a suite gutted to zero cases prints
 * `ALL 0 CASES BEHAVED AS EXPECTED` and exits 0, which is a gate passing
 * because it ran nothing — the exact defect this whole ticket exists to
 * prevent. `did nothing`, `refused` and `crashed` stay three distinguishable
 * outcomes: no footer at all is CRASH, whatever the exit status says.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RED SUITES. They are not skipped and they are not waived.
 *
 *   schema-typecheck.sh  is RUN, and judged against a PINNED EXPECTED FAILURE:
 *                        exactly `!! 1 of 16 cases misbehaved`, the one case
 *                        being S09, for the recorded cause. Green, a different
 *                        count, or a different case FAILS this gate and says
 *                        which ticket owns the answer. The allowance is closed,
 *                        enumerated and self-closing in the safe direction:
 *                        when T-168 lands, the suite goes green, the pin stops
 *                        matching, and this gate goes RED demanding promotion.
 *
 *   db-introspect.sh     needs the `db` profile. `gate:pr` declares `svc: none`
 *                        (DOCKER.md §7) so it CANNOT be run here at all — not a
 *                        policy choice, a structural one. It is rostered, named,
 *                        printed with its owner, and anchored on the SHA-256 of
 *                        the suite file: when T-165 changes it, this gate goes
 *                        RED and demands a re-measurement against a real
 *                        database. Its home is `gate:heavy` (T-006).
 *
 * ---------------------------------------------------------------------------
 * OD-55 — SERIALITY IS PART OF THE DESIGN, NOT AN INSTRUCTION IN A COMMENT.
 * `egress-boundary.sh` mutates the LIVE `scripts/dev` for one case each (root,
 * privileged, refusal removed). Any OTHER `scripts/dev` on the same tree during
 * that window runs under the mutated file. `app-images.sh` mutates nine tracked
 * files and overwrites any edit made to them WHILE it runs (T-156 § contract 5).
 * So: every suite here runs sequentially, in the foreground, and this gate takes
 * an exclusive lock file first. A second concurrent run is REFUSED, loudly,
 * rather than being allowed to interleave with the first.
 *
 * A CLEAN TREE IS REQUIRED, and this gate says so before it starts rather than
 * letting the third suite say it confusingly in the middle. migration-lint.sh
 * and schema-typecheck.sh refuse a dirty tree themselves; app-images.sh does
 * not and silently loses a mid-run edit to one of its nine files. One early,
 * uniform refusal is the honest version of both.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, capture, finish } from './lib/run.ts';

type SuiteState = 'GREEN' | 'BLOCKED' | 'NEEDS-SERVICE';

interface Suite {
  readonly id: string;
  readonly file: string;
  /** The pinned case count the footer must report. */
  readonly cases: number;
  readonly state: SuiteState;
  readonly why: string;
  /** BLOCKED / NEEDS-SERVICE only. */
  readonly owner?: string;
  readonly unblocks?: string;
  /** BLOCKED only: the exact failure that is tolerated, and nothing else. */
  readonly pinnedFailure?: {
    readonly misbehaved: number;
    readonly caseIds: readonly string[];
    readonly causeSubstring: string;
  };
  /** BLOCKED / NEEDS-SERVICE only: sha256 of the suite file when pinned. */
  readonly digest?: string;
}

const SUITES: readonly Suite[] = [
  {
    id: 'migration-lint',
    file: 'scripts/negative-tests/migration-lint.sh',
    cases: 227,
    state: 'GREEN',
    why: 'gate:migration-lint: expand/contract, protected objects, R-ROLE-SWITCH, R-RUN-AS, R-MERGED, R-TRAILER, R-VENDOR-SQL (T-021, T-031, T-167)',
  },
  {
    id: 'semgrep',
    file: 'scripts/negative-tests/semgrep.sh',
    cases: 24,
    state: 'GREEN',
    why: 'gate:semgrep: every exit path banners with a tagged reason, the pin is asserted, and case 21/22 hold the anti-vacuity pair (T-133, T-024)',
  },
  {
    id: 'dev-deps-guard',
    file: 'scripts/negative-tests/dev-deps-guard.sh',
    cases: 29,
    state: 'GREEN',
    why: 'the runtime image dev-dependency guard: what the RULE decides, including the one route it lets through (T-154, OD-117, OD-122)',
  },
  {
    id: 'egress-boundary',
    file: 'scripts/negative-tests/egress-boundary.sh',
    cases: 79,
    state: 'GREEN',
    why: 'gate:egress-boundary: kinvara-int, no host ports, no egress under svc run, overlay ADDITION is not an override (T-018, T-037, T-130, T-131)',
  },
  {
    id: 'app-images',
    file: 'scripts/negative-tests/app-images.sh',
    cases: 136,
    state: 'GREEN',
    why: 'gate:app-images: every Dockerfile an overlay service builds, plus the suite’s own working-tree verdict (T-035, T-036, T-156)',
  },
  {
    id: 'schema-typecheck',
    file: 'scripts/negative-tests/schema-typecheck.sh',
    cases: 16,
    state: 'BLOCKED',
    why: 'does the generated db/schema.ts typecheck when a module imports it (T-150, OD-93, OD-97)',
    owner: 'T-168 — platform-infrastructure, PARKED awaiting stakeholder ruling OE-39',
    unblocks:
      "S09 swaps db/schema.ts for main-before-T-150's rendering; apps/core/src/identity/account.repository.ts:30 — committed AFTER the case was written (T-141) — then reports three TS2305s the expectation does not list. It goes green when T-168 updates S09's expected error set. Then THIS gate goes red until the entry is moved to GREEN (decisions.md OD-161a).",
    pinnedFailure: {
      misbehaved: 1,
      caseIds: ['S09'],
      causeSubstring: 'apps/core/src/identity/account.repository.ts:30 TS2305',
    },
    digest: 'ebc6c43dfdb52953fbdca47c209a2ff11ef69f0ed1a4e6984fa7ba4f07fe0759',
  },
  {
    id: 'db-introspect',
    file: 'scripts/negative-tests/db-introspect.sh',
    cases: 65,
    state: 'NEEDS-SERVICE',
    why: 'db:introspect:check: the closed type map, canonical order, RLS policies, the pgboss exclusion (T-138, T-150, T-152, T-145)',
    owner: 'T-165 — tech-lead, PARKED awaiting stakeholder ruling OE-37',
    unblocks:
      "T-146's 0006 created schema `pgboss` with twelve relations; every K36-K49 case was written when it did not exist, so `!! 25 of 65 cases misbehaved` on `main` (OD-154, measured twice: tech-lead 2026-09-17 at 3b4e570, qa-verification 2026-09-18 at 3c54c71). T-165 re-cuts the plants to add to 0006's schema and takes the admitted counts from the catalogue. It ALSO needs the `db` profile, so its home is gate:heavy (T-006) even once green: `scripts/svc run <ticket> -- bash scripts/negative-tests/db-introspect.sh`.",
    digest: 'e373e536ead265b1600e0f2a2e2121fb318960826bcb4e6fcf745b475455834e',
  },
];

/**
 * THE DIFFERENTIAL HARNESS (the convention T-036 set for this repo, and the
 * reason this gate has FIFTEEN cases against it — B0..B14 in
 * scripts/negative-tests/pr-gates.sh — instead of one green run).
 *
 * A full pass of the real suites is 4m45s: the six per-suite figures this gate
 * prints, summed, at 9f99b1e — 60.2 + 72.9 + 2.8 + 20.8 + 42.3 + 85.8 = 284.8s.
 * That is far too slow to attack the JUDGING with, and the judging is the part
 * that decides whether a red suite can reach `main`. `KINVARA_NEG_SUITES_TABLE=<path to json>` replaces the
 * table above with tiny scripted suites, so every branch (no footer, a footer
 * that disagrees with the exit status, a case count that moved, a pinned
 * failure that became green, a digest that moved) has a case that runs in
 * milliseconds.
 *
 * THE ENV FORM IS MANDATORY and this is not pedantry (OD-62, ruled 2026-09-12):
 * `scripts/dev` forwards only HOME, CI, TZ and LANG, so a variable written in
 * front of the invocation stays on the HOST, never enters the container, and
 * the gate then silently judges the REAL table while the case believes
 * otherwise — the harness-no-op shape PROTOCOL §5.1 names. Use:
 *
 *   ./scripts/dev env KINVARA_NEG_SUITES_TABLE=/tmp/t.json pnpm gate:negative-suites
 *
 * An overridden run says so in its BANNER, not only in a line above it, so a
 * pasted `GATE PASS` from an override can never be read as a real pass. Nothing
 * in this repository sets the variable; `gate:pr` does not.
 */
const OVERRIDE = process.env['KINVARA_NEG_SUITES_TABLE'];
const SUITE_TABLE: readonly Suite[] =
  OVERRIDE !== undefined && OVERRIDE !== ''
    ? (JSON.parse(fs.readFileSync(OVERRIDE, 'utf8')) as readonly Suite[])
    : SUITES;
const GATE_NAME =
  OVERRIDE !== undefined && OVERRIDE !== ''
    ? `gate:negative-suites [OVERRIDE TABLE: ${OVERRIDE}]`
    : 'gate:negative-suites';

const GREEN_FOOTER = /^ALL ([0-9]+) CASES BEHAVED AS EXPECTED$/m;
const RED_FOOTER = /^!! ([0-9]+) of ([0-9]+) (?:CASE\(S\) MISBEHAVED|cases misbehaved)/m;
/**
 * A misbehaving case line, in either spelling the eight suites use:
 *   `BAD  S09  C1: ...`            (schema-typecheck.sh, migration-lint.sh)
 *   `!! 21 apps/core has src/ ...` (app-images.sh, egress-boundary.sh, ...)
 * The lookahead keeps the RED FOOTER itself (`!! 1 of 16 cases misbehaved`)
 * out of the case-id set — without it the footer contributes a case called "1".
 */
const BAD_CASE = /^(?:BAD|!!)[ \t]+(?![0-9]+ of )(\S+)[ \t]/gm;

const failures: string[] = [];
const notes: string[] = [];

// ----------------------------------------------------- the lock (OD-55, T-156)
const lockDir = path.join(REPO_ROOT, '.cache');
const lockFile = path.join(lockDir, 'negative-suites.lock');
fs.mkdirSync(lockDir, { recursive: true });
let lockFd: number;
try {
  lockFd = fs.openSync(lockFile, 'wx');
} catch {
  finish(GATE_NAME, [
    `another run holds ${path.relative(REPO_ROOT, lockFile)}. REFUSED rather than interleaved: ` +
      'egress-boundary.sh mutates the live scripts/dev and app-images.sh overwrites nine tracked ' +
      'files mid-run (OD-55, T-156 § contract 5). If no run is in flight, delete the lock file.',
  ]);
}
fs.writeSync(lockFd, `pid ${String(process.pid)} ${new Date().toISOString()}\n`);
const releaseLock = (): void => {
  try {
    fs.closeSync(lockFd);
    fs.unlinkSync(lockFile);
  } catch {
    /* already gone */
  }
};
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    releaseLock();
    process.exit(130);
  });
}

// ------------------------------------------------------------ a clean tree
const porcelain = capture('git', ['status', '--porcelain']);
if (porcelain.spawnFailed || porcelain.code !== 0) {
  finish(GATE_NAME, ['`git status --porcelain` failed; git is a hard dependency here']);
}
if (porcelain.stdout.trim() !== '') {
  finish(GATE_NAME, [
    'the working tree is not clean. These suites plant into the real tree and restore it with ' +
      '`git checkout`; two of them refuse a dirty tree themselves, and app-images.sh silently ' +
      'overwrites a mid-run edit to any of its nine backed-up files (T-156 § contract 5). ' +
      'Commit first — uncommitted work is not evidence anyway (PROTOCOL §3).\n' +
      porcelain.stdout.trimEnd(),
  ]);
}

// --------------------------------------------------------------- run them
console.log('The suites run SEQUENTIALLY, in the foreground, under an exclusive lock (OD-55).\n');

let ran = 0;
for (const s of SUITE_TABLE) {
  // `resolve`, not `join`: an entry may name an absolute path (the override
  // table's scripted suites live outside the repo so they cannot dirty the tree).
  const abs = path.resolve(REPO_ROOT, s.file);
  console.log(`${'-'.repeat(78)}\n  ${s.id}  [${s.state}]  pinned at ${String(s.cases)} case(s)`);
  console.log(`    ${s.why}`);

  if (!fs.existsSync(abs)) {
    failures.push(`${s.id}: ${s.file} does not exist — a rostered suite was deleted`);
    continue;
  }

  if (s.digest !== undefined) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (actual !== s.digest) {
      failures.push(
        `${s.id}: ${s.file} has changed (sha256 ${actual}, pinned ${s.digest}). ` +
          `This suite is pinned because it is not green on \`main\` and its answer is owed by ` +
          `${s.owner ?? '(unrecorded)'}. Re-measure it and either update the pin or move the ` +
          `entry to GREEN in scripts/gates/negative-suites.ts.`,
      );
      continue;
    }
  }

  if (s.state === 'NEEDS-SERVICE') {
    console.log(`    NOT RUN HERE — it needs a running service and gate:pr declares svc: none.`);
    console.log(`    owed by: ${s.owner ?? '(unrecorded)'}`);
    console.log(`    goes green when: ${s.unblocks ?? '(unrecorded)'}`);
    console.log(`    the suite file is pinned at sha256 ${s.digest ?? '(none)'}, unchanged.`);
    notes.push(
      `${s.id}: NOT RUN (needs the \`db\` profile; gate:pr has no services). Owner: ${s.owner ?? '(unrecorded)'}.`,
    );
    if (s.owner === undefined || s.unblocks === undefined || s.digest === undefined) {
      failures.push(`${s.id}: NEEDS-SERVICE with no owner, no unblock condition or no digest pin`);
    }
    continue;
  }

  const started = Date.now();
  const r = spawnSync('bash', [abs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  ran += 1;
  if (r.error !== undefined) {
    failures.push(`${s.id}: could not execute ${s.file}: ${r.error.message}`);
    continue;
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const code = r.status ?? 1;
  const green = GREEN_FOOTER.exec(out);
  const red = RED_FOOTER.exec(out);

  if (green === null && red === null) {
    failures.push(
      `${s.id}: NO FOOTER. The suite printed neither "ALL n CASES BEHAVED AS EXPECTED" nor ` +
        `"!! b of n". Exit ${String(code)} is not a verdict on its own — this is a CRASH or a ` +
        `no-op, and it is reported as one (PROTOCOL §5.1). Last lines:\n` +
        out.trimEnd().split('\n').slice(-8).join('\n'),
    );
    continue;
  }
  if (green !== null && red !== null) {
    failures.push(`${s.id}: printed BOTH footers — the output is not judgeable`);
    continue;
  }

  const reported = Number(green !== null ? green[1] : (red?.[2] ?? '-1'));
  if (reported !== s.cases) {
    failures.push(
      `${s.id}: the footer reports ${String(reported)} case(s); the pin is ${String(s.cases)}. ` +
        `A case was added or deleted. A pass over a shrinking suite is the vacuity this gate ` +
        `exists to refuse — re-verify the suite and update the pin in ` +
        `scripts/gates/negative-suites.ts with the new number.`,
    );
    continue;
  }

  if (s.state === 'GREEN') {
    if (green === null) {
      const bad = [...out.matchAll(BAD_CASE)].map((m) => m[1]).slice(0, 12);
      failures.push(
        `${s.id}: RED. ${red?.[0] ?? ''} (exit ${String(code)}). Misbehaving case(s): ` +
          `${bad.length > 0 ? bad.join(', ') : '(not parsed — read the output)'}. ` +
          `This suite is green on \`main\`; something in this change set broke it.`,
      );
      console.log(out.trimEnd().split('\n').slice(-25).join('\n'));
      continue;
    }
    if (code !== 0) {
      failures.push(`${s.id}: green footer but exit ${String(code)} — the two disagree`);
      continue;
    }
    console.log(`    ok  ALL ${String(reported)} CASES BEHAVED AS EXPECTED, exit 0, ${secs}s`);
    continue;
  }

  // ------------------------------------------------------ BLOCKED, pinned red
  const pin = s.pinnedFailure;
  if (pin === undefined || s.owner === undefined || s.unblocks === undefined) {
    failures.push(`${s.id}: BLOCKED with no pinned failure, no owner or no unblock condition`);
    continue;
  }
  if (green !== null) {
    failures.push(
      `${s.id}: is GREEN. The pinned failure no longer reproduces, so ${s.owner} has landed. ` +
        `Move this entry to GREEN in scripts/gates/negative-suites.ts. This gate is red on ` +
        `purpose until you do: an allowance that outlives its reason is the open-ended kind.`,
    );
    continue;
  }
  const misbehaved = Number(red?.[1] ?? '-1');
  const badIds = [...out.matchAll(BAD_CASE)].map((m) => m[1] ?? '');
  const unexpected = badIds.filter((id) => !pin.caseIds.includes(id));
  const missing = pin.caseIds.filter((id) => !badIds.includes(id));
  if (misbehaved !== pin.misbehaved || unexpected.length > 0 || missing.length > 0) {
    failures.push(
      `${s.id}: RED IN A WAY THAT IS NOT THE PINNED ONE. Expected exactly ` +
        `${String(pin.misbehaved)} misbehaving case ${pin.caseIds.join(', ')}; got ` +
        `${String(misbehaved)} (${badIds.join(', ') || 'none parsed'}). ` +
        `unexpected=[${unexpected.join(', ')}] missing=[${missing.join(', ')}]. ` +
        `The known red is ${s.owner}'s; this is something else.`,
    );
    console.log(out.trimEnd().split('\n').slice(-25).join('\n'));
    continue;
  }
  if (!out.includes(pin.causeSubstring)) {
    failures.push(
      `${s.id}: ${pin.caseIds.join(', ')} is red as pinned, but NOT for the recorded cause ` +
        `(${pin.causeSubstring} is absent from the output). Same case, different reason — ` +
        `re-diagnose before trusting the pin.`,
    );
    continue;
  }
  if (code === 0) {
    failures.push(`${s.id}: red footer but exit 0 — the two disagree`);
    continue;
  }
  console.log(
    `    BLOCKED as pinned: ${String(misbehaved)} of ${String(reported)} misbehaved ` +
      `(${pin.caseIds.join(', ')}), exit ${String(code)}, ${secs}s`,
  );
  console.log(`    owed by: ${s.owner}`);
  console.log(`    goes green when: ${s.unblocks}`);
  notes.push(
    `${s.id}: RED as pinned (${String(misbehaved)} of ${String(reported)}, ${pin.caseIds.join(', ')}). Owner: ${s.owner}.`,
  );
}

// ------------------------------------------------------------- anti-vacuity
const expectedRuns = SUITE_TABLE.filter((s) => s.state !== 'NEEDS-SERVICE').length;
if (ran !== expectedRuns) {
  failures.push(
    `${String(ran)} of ${String(expectedRuns)} runnable suite(s) actually ran. ` +
      'A suite that did not run is not a suite that passed.',
  );
}
const pinnedTotal = SUITE_TABLE.reduce((n, s) => n + s.cases, 0);
console.log(`\n${'-'.repeat(78)}`);
console.log(
  `  ${String(ran)} suite(s) executed of ${String(SUITE_TABLE.length)} rostered; ` +
    `${String(pinnedTotal)} case(s) pinned in total.`,
);
for (const n of notes) console.log(`  NOT GREEN — ${n}`);

finish(GATE_NAME, failures);
