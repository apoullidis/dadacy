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
 * THE ONE SUITE THAT IS NOT RUN HERE. It is not skipped and it is not waived.
 *
 *   db-introspect.sh     needs the `db` profile. `gate:pr` declares `svc: none`
 *                        (DOCKER.md §7) so it CANNOT be run here at all — not a
 *                        policy choice, a structural one. It is rostered, named,
 *                        printed with its owner, and anchored on the SHA-256 of
 *                        the suite file: when its file changes, this gate goes
 *                        RED and demands a re-measurement against a real
 *                        database. Its home is `gate:heavy` (T-006).
 *
 * BOTH TRIPWIRES HAVE NOW FIRED ONCE, FOR REAL, ON ONE REBASE (2026-09-20,
 * T-005 onto main 6582596), which is the only evidence that they work that is
 * worth anything:
 *   * schema-typecheck.sh was BLOCKED against a pinned expected failure
 *     (`!! 1 of 16`, S09, its recorded cause). T-168 merged and fixed S09; the
 *     suite went green, the pin stopped matching, and this gate went RED
 *     demanding the promotion. It is now GREEN-classed. That is case B7's
 *     property observed rather than simulated.
 *   * db-introspect.sh's digest moved, because T-168 gave it EXIT/INT/TERM
 *     traps. This gate went RED demanding a re-measurement; the new digest was
 *     taken with sha256sum, not edited.
 *
 * WHAT THIS ROSTER DOES NOT DO, and it bit on the same rebase. SUITES below is
 * a HAND-MAINTAINED LIST. Nothing derives it from `scripts/negative-tests/*.sh`,
 * so a newly committed suite is not run by this gate and nothing goes red —
 * which is OD-152's own shape. Live at 6582596: `jobs-contract.sh` (T-147) and
 * `db-migrate.sh` are committed and NOT in this table. See
 * tasks/state/EP-1/T-005.md § Integration and decisions.md OD-170.
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
    // 136 -> 148, 2026-09-22, T-179: twelve cases (144-155) for gate:app-images
    // §7, the stop-grace rule. No case removed, renamed or re-classed; case 87's
    // PLANT gained one line (stop_grace_period) — T-179 § Evidence.
    // 148 -> 158, 2026-09-22, T-180: ten cases (156-165) — §7 holds the ONE use
    // of GROUP_DRAIN_MS and derives the entrypoint from §6's ENTRYPOINT. No case
    // removed, renamed or re-classed; the PLANTS of 43/44/45 each gained the same
    // WORKDIR + COPY docker/app-runtime/ lines and an ENTRYPOINT at the copy, and
    // 45's old plant is case 165 — T-180 § Evidence.
    // 158 -> 161, 2026-09-22, T-180 rework 1: cases 166-168 (QA-F4, a same-named
    // let/var/multi-declarator const shadowing GROUP_DRAIN_MS). No case removed,
    // renamed, re-classed or re-planted — T-180 § Rework 1.
    // 161 -> 185, 2026-09-22, T-182: twenty-four cases (169-192) for §7's PID-1
    // RESOLUTION — a compose entrypoint: (list and string), a mount over the
    // script (volumes: and configs:), a NODE_OPTIONS preload from compose and
    // from the image's ENV, a code-loading and an unmodelled node flag, a RUN
    // that rewrites the script, an ADDed archive, stop_signal:, init:,
    // working_dir:, env_file:, D13 and a non-const declaration — SIXTEEN
    // refusals and EIGHT controls. (This line read "with seven controls" until
    // 2026-09-22: OD-204, the surviving sibling of a miscount T-182 disclosed
    // and corrected in entrypoint.mjs's docblock but not here. The split is
    // counted from the suite's own run_case verdicts — `grep -oE 'run_case
    // "(169|1[7-9][0-9]|19[0-2]) [^"]*" (PASS|FAIL)'` -> 16 FAIL, 8 PASS — and
    // the lesson is R2's: a self-found miscount is a measurement, and a
    // measurement gets its siblings swept.)
    // 185 -> 199, 2026-09-22, T-182 rework 1 (qa-verification QA-1): fourteen
    // cases (193-206) for §7c/§7d, the SECOND question — what PID 1 *is*, and
    // what code is loaded into it. `pid:` (two spellings), an unclassified
    // compose key, `user:`, `pull_policy:`, LD_PRELOAD, a NODE_* nobody named,
    // PATH, `command:` as a string, the chaos overlay declaring an application
    // service, and a `secrets:` target. THE REFUSAL/CONTROL SPLIT IS NOT
    // WRITTEN HERE. It read "TEN refusals and FOUR controls" until 2026-09-23
    // and it was wrong; it is DELETED rather than re-numbered, because OD-207
    // rules that the SHAPE is the defect — a hand-written count beside a live
    // literal is not checked by anything and must be re-derived by hand every
    // time the literal moves, and on this ticket it moved five times (161 ->
    // 185 -> 199 -> 204). This was the THIRD live instance of that shape in
    // this comment block: OD-204's is the first, corrected in the 161 -> 185
    // entry above, and this one was written twelve lines below that correction
    // in the same breath. The instrument, which is the literal a reader can
    // check: `grep -oE 'run_case "(19[3-9]|20[0-6]) [^"]*" (PASS|FAIL)'
    // scripts/negative-tests/app-images.sh | awk '{print $NF}' | sort |
    // uniq -c`. Two of these cases plant something nobody in this family has
    // named: 196 a compose KEY, which is the ALLOW-LIST property (§7c), and
    // 201 a variable inside a listed NAMESPACE, which is not the same
    // property — §7d is a deny-list.
    // No case removed, renamed, re-classed or re-planted in either change,
    // so OD-176(d)'s four conditions are not engaged — T-182 § Evidence and
    // § Rework 1.
    // 199 -> 204, 2026-09-23, T-182 rework 2 (OE-44, stakeholder ruling B):
    // five cases (207-211) for §7d WIDENED BY MEASUREMENT. The orchestrator
    // beat rework 1's four-namespace environment rule with `OPENSSL_CONF`
    // inside `core`'s own `environment:` block at gate exit 0; node links
    // OpenSSL 3.5.7 statically and that variable dlopens a module into PID 1
    // (measured: a real .so ends PID 1 in node::InitializeOncePerProcess-
    // Internal, SIGABRT, container ExitCode=139). OPENSSL_* is now a loader
    // namespace and SSL_CERT_FILE/SSL_CERT_DIR/CTLOG_FILE are refused by name:
    // FOUR refusals (207 compose, 208 the image's ENV, 209 a spelling nobody
    // named, 210 the exact-name half) and ONE control (211, the scope). No
    // existing case touched, so OD-176(d) is again not engaged — T-182
    // § Rework 2.
    cases: 204,
    state: 'GREEN',
    why: 'gate:app-images: every Dockerfile an overlay service builds, plus the suite’s own working-tree verdict (T-035, T-036, T-156)',
  },
  {
    // T-180. Runs docker/app-runtime/entrypoint.mjs as a process (no Docker, no
    // services) against a temp-dir fixture app: WHERE the group-drain deadline
    // counts from, and that PID 1 does not wait when no signal was forwarded.
    // About 27 s: the three deadline cases run concurrently.
    id: 'entrypoint-lifecycle',
    file: 'scripts/negative-tests/entrypoint-lifecycle.sh',
    cases: 18,
    state: 'GREEN',
    why: "PID 1's group-drain deadline counts from the FIRST forwarded signal, a second signal does not move it, and with NO signal forwarded PID 1 exits at once with the app's exit code (T-180, TL-A1 on T-179); a signal death is reported as 128 + signo, including two signals outside the six first pinned so a literal table cannot pass, and the argv path's stderr line is held apart from the shell path's, which must not say whose death it was because PID 1 does not check whether the shell exec'd — asserted with the shell kept and with the shell exec'd; the deadline rule's one cost — a survived signal anchors a later stop — is pinned so a re-anchor cannot land in silence (T-181)",
  },
  {
    id: 'otel-contract',
    file: 'scripts/negative-tests/otel-contract.sh',
    cases: 29,
    state: 'GREEN',
    why: "gate:otel-contract: a served operation with no data_class entry, a malformed registry BANNERING instead of crashing, the collector allowlist, a dashboard naming a route or class nothing serves, and the one line apps/core's adapter may never write (T-008)",
  },
  {
    id: 'schema-typecheck',
    file: 'scripts/negative-tests/schema-typecheck.sh',
    // 16 -> 24, 2026-09-24, T-153 merging main 3385ede (OE-35 A): T-153 committed P05-P09 and
    // P07m/P08m/P09m (eight cases) before this pin existed; the merge put them under it and this gate
    // went RED on the count, as designed. Measured, not edited: `./scripts/dev bash
    // scripts/negative-tests/schema-typecheck.sh` at d1dedcb printed `ALL 24 CASES BEHAVED AS
    // EXPECTED`, exit 0 (tasks/state/EP-2/T-153.md § Rework 2, phase R2-5).
    cases: 24,
    // PROMOTED BLOCKED -> GREEN, 2026-09-20, when T-005 rebased onto main
    // 6582596. T-168 merged (aa45209, 3c54c71, 9b35d3e) and fixed S09, so the
    // suite is green on the trunk: `ALL 16 CASES BEHAVED AS EXPECTED`, exit 0,
    // 1:26.06 at 9f60552 — pasted in tasks/state/EP-1/T-005.md § I2.
    //
    // THIS IS THE TRIPWIRE FIRING, NOT A WAIVER BEING LIFTED. The BLOCKED entry
    // carried a pinned expected failure (`!! 1 of 16`, S09, the recorded cause)
    // and the digest of the suite file. When T-168 landed, BOTH stopped
    // matching and this gate went RED demanding the promotion — case B7 is that
    // property, and it is the one that fired here for real. The allowance could
    // not outlive its reason, which is what § contract 6 said it could not.
    state: 'GREEN',
    why: 'does the generated db/schema.ts typecheck when a module imports it (T-150, T-168, OD-93, OD-97, OD-161a)',
  },
  {
    // T-006. Attacks gate:heavy, its two new sub-gates, and the SERVICE half of
    // gate:pr's class judgement. NO SERVICES, deliberately: a suite that needed
    // the socket or a database could not be a member of this gate, and a
    // committed suite no gate runs is OD-152.
    id: 'heavy-gates',
    file: 'scripts/negative-tests/heavy-gates.sh',
    cases: 36,
    state: 'GREEN',
    why: "gate:heavy: the roster held against SD §QD-4's heavy row, the cross-file anchor on the PR roster's SERVICE class, the evidence anchors, the receipt coverage rule, and gate:workflow's W8 (T-006)",
  },
  {
    id: 'db-introspect',
    file: 'scripts/negative-tests/db-introspect.sh',
    // 65 -> 81, 2026-09-24, T-153 merging main 3385ede: T-153 added K50-K62r (sixteen cases). NOT a
    // green count: see the digest note below for what was and was not measured.
    // 81 -> 141, 2026-09-24, T-165 rework 2 (OE-37 (A)) merging main b71408e: T-165's own cases
    // (renumbered K150-K189, 44 from cycles 0/1 and 16 from rework 2) join T-153's. A GREEN count:
    // `ALL 141 CASES BEHAVED AS EXPECTED` on a fresh db project at 4feb38f (T-165.md § Rework 2, S3).
    cases: 141,
    state: 'NEEDS-SERVICE',
    why: 'db:introspect:check: the closed type map, canonical order, RLS policies, the pgboss exclusion (T-138, T-150, T-152, T-145)',
    owner:
      'T-165 — tech-lead (the cases); the gate:heavy promotion of gate:db-introspect-suite is platform-infrastructure (OD-220)',
    unblocks:
      "NEEDS-SERVICE is structural: the suite needs the `db` profile and the PR stage has none, so its home is gate:heavy (T-006), where `gate:db-introspect-suite` runs it against a real database. OD-154 (K36-K49m red since 0006) is closed by T-165's re-cut plants: 141/141 on a fresh db project at 4feb38f. gate:heavy still rosters that entry BLOCKED against `!! 25 of 81`, so a green run is refused there until it is promoted to BLOCKING (T-006 § contract §8/§10; OD-220). Run it with `scripts/svc run <ticket> -- pnpm -w gate:db-introspect-suite`.",
    // RE-MEASURED 2026-09-20 on the rebase onto main 6582596. T-168 added
    // EXIT/INT/TERM traps to this suite (9b35d3e), so the digest moved and this
    // gate went RED — the tripwire firing, exactly as § contract 6 said it
    // would. The new value is the sha256 of the file at that commit, taken with
    // the instrument, never edited by hand (PROTOCOL §5.2):
    //   $ git cat-file blob 6582596:scripts/negative-tests/db-introspect.sh | sha256sum
    //   30708f1b2c3e458e54292488346fd2e9cd95490a40c8124e590ec935151155fb
    // WHAT MOVING THE PIN DOES NOT MEAN. It does not mean the suite was
    // re-measured against a database — it cannot be, here (svc: none). T-168
    // changed the suite's restore/trap machinery and added no case, so the
    // pinned `cases: 65` is unchanged and OD-154's `!! 25 of 65` on `main` is
    // still the last real reading anyone has. The pin detects an edit; that is
    // all it has ever claimed to detect.
    // RE-PINNED 2026-09-24 by T-153 merging main 3385ede (OE-35 A): the merge brought T-153's cases
    // K50-K62r and its K60 correction (d1dedcb) under this pin, and this gate went RED. Taken with
    // the instrument, never edited by hand (PROTOCOL §5.2):
    //   $ git cat-file blob d1dedcb:scripts/negative-tests/db-introspect.sh | sha256sum
    //   780ce587371ef47beeb4f12d68fa6192350a2024cce48e1b1ff28d84f9a58365
    // WHAT WAS MEASURED against a real database at d1dedcb (T-153.md § Rework 2): the COMMITTED suite
    // ABORTS at K18 before printing a footer, exactly as it does on main 3385ede (OD-218: with 0007
    // the history attack's two walk-back steps cannot move `public`'s order). With K18's walk
    // lengthened in an uncommitted copy (one line), it prints `!! 25 of 81 cases misbehaved`: the 25
    // are OD-154's K36-K49m, unchanged; every other case, T-153's K50-K62r included, is `ok`.
    // RE-PINNED 2026-09-24 by T-188 (OD-218): K18's walk-back is now derived from the committed
    // migrations instead of fixed at HIGHEST-1/HIGHEST-2 (d126c68); no case added or removed, so
    // `cases: 81` is unchanged. Taken with the instrument, never edited by hand (PROTOCOL §5.2):
    //   $ git cat-file blob d126c68:scripts/negative-tests/db-introspect.sh | sha256sum
    //   c21c64120c03a473144fe9d7ce9dfd1d1b38f0e2d232d61be54753817aa4ebd3
    // MEASURED against a real database at d126c68 (tasks/state/EP-2/T-188.md § Evidence B): the
    // committed suite now reaches its footer, `!! 25 of 81 cases misbehaved`, exit 1; K18 is `ok`
    // (down --to 0004 moved the order); the 25 are OD-154's K36-K49m, unchanged.
    // RE-PINNED 2026-09-24 by T-165 rework 2 (OE-37 (A)): the merge of main b71408e, the renumbering
    // of T-165's cases past T-153's (K50-K80 -> K150-K180) and K181-K189 moved the digest, and this
    // gate went RED (T-165.md § Rework 2, NS-red). Taken with the instrument, never edited by hand:
    //   $ git cat-file blob 4feb38f:scripts/negative-tests/db-introspect.sh | sha256sum
    //   99c2400f0f07e5871396ec88e79efcb654476600187aee11f5b95195f8fd4f72
    // MEASURED against a real database at 4feb38f (§ Rework 2, S3): `ALL 141 CASES BEHAVED AS
    // EXPECTED`, exit 0, on a fresh never-analysed db project.
    digest: '99c2400f0f07e5871396ec88e79efcb654476600187aee11f5b95195f8fd4f72',
  },
];

/**
 * THE DIFFERENTIAL HARNESS (the convention T-036 set for this repo, and the
 * reason this gate has FIFTEEN cases against it — B0..B14 in
 * scripts/negative-tests/pr-gates.sh — instead of one green run).
 *
 * A full pass of the real suites is 290.4s at 8c35307 — the six
 * per-suite figures THIS GATE PRINTS, summed: 58.6 + 70.6 + 2.7 + 20.5 + 40.8 + 97.2. The figure is
 * recomputed and printed on every run, so this line is a pointer at the gate's
 * own output rather than a second copy of it, and the attribution is to the
 * commit the sum was taken at (PROTOCOL §5.3 R1). The run is pasted in
 * tasks/state/EP-1/T-005.md. That is far too slow to attack the JUDGING with,
 * and the judging is the part that decides whether a red suite can reach
 * `main`. `KINVARA_NEG_SUITES_TABLE=<path to json>` replaces the
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
