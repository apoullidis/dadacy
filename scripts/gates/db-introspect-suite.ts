/**
 * gate:db-introspect-suite — the one committed negative suite that no stage
 * could run. T-006.
 *
 * `scripts/negative-tests/db-introspect.sh` is 141 cases at 3119884 attacking
 * T-138's parity check. `gate:negative-suites` rosters it NEEDS-SERVICE and pins
 * its SHA-256 instead of running it, because the PR stage declares `svc: none`
 * (T-005 § contract §6). Its own entry there says, in terms: "its home is
 * gate:heavy (T-006) even once green". This is that home.
 *
 * IT IS GREEN, AND `gate:heavy` ROSTERS IT `BLOCKING` (T-190, OD-220). It was
 * `BLOCKED` against a pinned failure while OD-154 held K36-K49m red; T-165
 * (merged 3119884) re-cut those plants and the suite printed `ALL 141 CASES
 * BEHAVED AS EXPECTED` on a fresh `db` project. So now ANY misbehaving case,
 * and any run with no footer, fails gate:heavy.
 *
 * THE PASS BANNER IS EXACTLY `GATE PASS  gate:db-introspect-suite`, with the
 * counts on the line after it. gate:heavy's BLOCKING judgement requires that
 * exact line (T-006 § contract §4); the old banner carried the counts on the
 * same line, which the BLOCKED class never read and the BLOCKING class refuses
 * (T-190, finding F1).
 *
 * WHAT THIS ADDS OVER THE DIGEST PIN IT SITS BESIDE. The digest in
 * `gate:negative-suites` detects that the FILE changed; it cannot detect that
 * `main` moved underneath the suite, which is exactly how OD-154 happened (a
 * migration merged; the suite was untouched). T-005 § contract §6 names that
 * gap and says it is gate:heavy's. Running the suite against a real database
 * is what closes it: the count is re-measured on every heavy run.
 *
 * IT NEEDS A FRESH `db` PROJECT (OD-189). K18's history attack walks back to
 * targets DERIVED from the committed migrations (T-188, OD-218): every
 * committed number below the highest, nearest first, stopping at the first
 * `down --to <n>` then `up` that moves drizzle-kit's table-list order. If no
 * target moves it, the suite ABORTS at exit 2 WITH NO FOOTER, which is the one
 * shape a harness must be able to tell from a refusal: this gate prints
 * `GATE CRASH` for it, and `gate:heavy` refuses the run rather than reading
 * exit 2 as a verdict. A second run on a used database with the derived
 * walk was measured ONCE (qa-verification, T-188 at f748b73): it reached its
 * footer, `!! 25 of 81`, exit 1, with K18 `ok` at `down --to 0006`. One run is
 * not a guarantee. The walk it replaced was fixed at `down --to 0005` /
 * `down --to 0004`, and with that walk a second run aborted:
 * Measured both ways at T-006's head: fresh project → `!! 25 of 65`, exit 1,
 * 206.3 s; the same project a second time → ABORT, exit 2, 97.7 s, no footer.
 * So: `./scripts/svc down <ticket>` before the heavy stage's service segment.
 * DOCKER.md §5 asks that of every evidence run anyway.
 *
 * THE SUITE REFUSES A DIRTY TREE, and so this gate does. That is not a
 * preference — the suite plants migrations and deletes db/schema.ts, and
 * T-168 gave it EXIT/INT/TERM traps precisely because an interrupted run must
 * put tracked files back. Commit first; uncommitted work is not evidence
 * anyway (PROTOCOL §3). This mirrors `gate:pr`'s clean-tree requirement
 * (T-005 § contract §4) rather than inventing a second convention.
 */
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './lib/run.ts';

const NAME = 'gate:db-introspect-suite';
const SUITE = 'scripts/negative-tests/db-introspect.sh';

const project = process.env['KINVARA_PROJECT'] ?? '';
const pghost = process.env['PGHOST'] ?? '';
if (project === '' || pghost === '') {
  console.error(`GATE NEEDS A SERVICE  ${NAME}`);
  console.error(
    `  Needs:   the \`db\` profile. KINVARA_PROJECT=${JSON.stringify(project)} PGHOST=${JSON.stringify(pghost)}`,
  );
  console.error(`  Run it:  ./scripts/svc run <ticket> -- pnpm -w ${NAME}`);
  console.error('');
  console.error('  The suite is committed and is not a stub. This banner means only that the');
  console.error('  current invocation has no database to point it at.');
  process.exit(1);
}

const dirty = spawnSync('git', ['status', '--porcelain'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
});
if ((dirty.stdout ?? '').trim() !== '') {
  console.error(`GATE FAIL  ${NAME} — 1 problem(s):`);
  console.error(`  - the working tree is not clean, and ${SUITE} refuses one before it starts.`);
  console.error('    It plants migrations and deletes db/schema.ts; a dirty tree is how a suite');
  console.error('    eats an uncommitted edit (OD-119, OD-160). Commit first.');
  for (const l of (dirty.stdout ?? '').trimEnd().split('\n')) console.error(`      ${l}`);
  process.exit(1);
}

console.log(`$ bash ${SUITE}   (project ${project}, PGHOST ${pghost})`);
const started = Date.now();
const r = spawnSync('bash', [SUITE], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const code = r.error !== undefined ? 127 : (r.status ?? 1);
const secs = Math.round((Date.now() - started) / 100) / 10;

/**
 * Three readings again, and the footer is the one that matters: a suite that
 * crashed before printing a footer exits non-zero too, and OD-27 is the record
 * of what happens when a harness reads any non-zero as a refusal.
 */
const green = /^ALL (\d+) CASES BEHAVED AS EXPECTED$/m.exec(text);
const red = /^!! (\d+) of (\d+) cases misbehaved$/m.exec(text);

console.log(text.trimEnd().split('\n').slice(-6).join('\n'));

if (green === null && red === null) {
  console.error(
    `\nGATE CRASH  ${NAME} — the suite printed NO FOOTER (exit ${String(code)}, ${String(secs)}s).`,
  );
  console.error('  Neither "ALL n CASES BEHAVED AS EXPECTED" nor "!! n of m cases misbehaved" is');
  console.error('  present, so this run is not a verdict — it is a process that died. A crash and');
  console.error('  a refusal must not look the same (PROTOCOL §5.1, OD-27).');
  process.exit(70);
}

if (green !== null) {
  if (code !== 0) {
    console.error(
      `\nGATE FAIL  ${NAME} — the footer is green and the exit status is ${String(code)}; the two disagree.`,
    );
    process.exit(1);
  }
  console.log(`\nGATE PASS  ${NAME}`);
  console.log(`  ${green[1] ?? '?'} cases, ${String(secs)}s`);
  process.exit(0);
}

console.error(
  `\nGATE FAIL  ${NAME} — !! ${String(red?.[1])} of ${String(red?.[2])} cases misbehaved  (exit ${String(code)}, ${String(secs)}s)`,
);
console.error('  gate:heavy rosters this suite BLOCKING (T-190, OD-220): every case must behave.');
console.error("  This gate prints the suite's last six lines only; the suite's own `BAD` lines");
console.error('  name the cases (run `bash scripts/negative-tests/db-introspect.sh` under svc run).');
process.exit(1);
