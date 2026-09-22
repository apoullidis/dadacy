/**
 * gate:drizzle-parity — SD §QD-4's PR-row item "Drizzle introspection parity",
 * executed where a database exists. T-006.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED HERE, AND WHY IT IS NOT A WORDING CHANGE.
 *
 * Until T-006 this name resolved to `scripts/gates/not-yet-supplied.ts`, which
 * prints `GATE NOT YET SUPPLIED` and names T-006 as the ticket that owes it.
 * THAT WAS TRUE AND IS NOW FALSE. The command it stood in for —
 * `pnpm -w db:introspect:check`, T-138's — has been LIVE since T-138 merged;
 * what was missing was a stage that could run it. T-006 is that stage. Leaving
 * the hook in place would have left `gate:pr` printing "not yet supplied" about
 * a gate that is supplied and runs, which is the register defect PROTOCOL §5.1
 * spends a page on.
 *
 * So this gate now has TWO outcomes where the hook had one, and they are
 * deliberately different banners:
 *
 *   GATE NEEDS A SERVICE   the command exists and is live; THIS invocation has
 *                          no database, because `gate:pr` declares `svc: none`
 *                          and `scripts/dev` attaches no service (DOCKER.md
 *                          §4.2, §7). Exit 1.
 *   GATE PASS / GATE FAIL  a database is attached: the check ran, and its
 *                          verdict is this gate's verdict.
 *
 * `scripts/gates/pr.ts` requires the SERVICE class to print the first of those
 * — not the `GATE NOT YET SUPPLIED` banner a PENDING hook prints. That is the
 * PR stage's four classes becoming four distinguishable RESULTS rather than
 * three results and a label: "not supplied", "needs a service" and "crashed"
 * are now three outcomes a reader and a program can tell apart (PROTOCOL
 * §5.1's harness-no-op rule).
 *
 * WHAT THIS FILE DOES NOT DO. It does not re-implement or second-guess the
 * parity check. Every refusal — I-MIGRATE, I-RECORD, I-SCOPE, I-PULL,
 * I-VACUOUS, I-MISSING, I-DIGEST, I-DIFF, I-ARGS and the CRASH path — is
 * T-138 § Published contract §2 and is falsified by
 * scripts/negative-tests/db-introspect.sh, not by anything here. This file
 * decides only WHETHER THE CHECK COULD RUN, and refuses to report a pass from
 * a zero exit that printed no banner.
 */
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './lib/run.ts';
import { ROSTER } from './lib/roster.ts';

const NAME = 'gate:drizzle-parity';
const entry = ROSTER.find((e) => e.name === NAME);

/**
 * A database is attached iff we are inside `scripts/svc run` on a ticket
 * project (KINVARA_PROJECT) AND the libpq environment it injects is present
 * (PGHOST — T-138 § contract §1: the URL drizzle-kit gets is built from PG*,
 * and DATABASE_URL is not read). Nothing here probes a port: an invocation is
 * its entry point, and "I found a database" in a toolbox that should not have
 * one is a finding, not a capability.
 */
const project = process.env['KINVARA_PROJECT'] ?? '';
const pghost = process.env['PGHOST'] ?? '';

if (project === '' || pghost === '') {
  console.error(`GATE NEEDS A SERVICE  ${NAME}`);
  console.error(`  Class:   ${entry?.cls ?? 'UNKNOWN — this name is in no roster entry'}`);
  console.error(
    `  Needs:   the \`db\` profile. KINVARA_PROJECT=${JSON.stringify(project)} PGHOST=${JSON.stringify(pghost)}`,
  );
  console.error(`  Runs in: ${entry?.owner ?? 'UNKNOWN'}`);
  console.error(`  Run it:  ${entry?.unblocks ?? 'UNRECORDED — that is an open-ended allowance'}`);
  console.error(`  Checks:  ${entry?.why ?? ''}`);
  console.error('');
  console.error('  THE COMMAND IS LIVE AND THIS IS NOT A STUB. `pnpm -w db:introspect:check`');
  console.error('  (T-138) exists, blocks, and is executed by `pnpm gate:heavy` (T-006) against');
  console.error("  the ticket project's real database. This banner means only that the current");
  console.error('  invocation has no database to point it at — which is structural, not a debt:');
  console.error(
    '  gate:pr declares `svc: none` and scripts/dev attaches no service (DOCKER.md §7).',
  );
  process.exit(1);
}

console.log(`${NAME}: a database is attached (project ${project}, PGHOST ${pghost}).`);
console.log('running `node scripts/db-introspect.ts --check` (T-138 § Published contract §1)\n');

const r = spawnSync('node', ['scripts/db-introspect.ts', '--check'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
process.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`);
const code = r.error !== undefined ? 127 : (r.status ?? 1);

/**
 * Three readings, which a check that did nothing could not all produce
 * (PROTOCOL §5.1): the exit status, exactly one banner of the expected kind,
 * and — for a pass — the evidence lines beside it. `gate:heavy` asserts the
 * third independently; it is asserted here too so that running this gate ALONE
 * is not weaker than running it inside the aggregate.
 */
const banners = text
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => /^GATE (PASS|FAIL|CRASH) {2}db:introspect:check/.test(l));

const problems: string[] = [];
if (code === 0) {
  if (banners.length !== 1 || !banners[0]?.startsWith('GATE PASS')) {
    problems.push(
      `db:introspect:check exited 0 with ${String(banners.length)} banner(s) ` +
        `${JSON.stringify(banners)} — a crash that happens to exit 0 and a pass must not look the same`,
    );
  }
  if (!/MIGRATE OK {2}up: \S+ -> \S+/.test(text)) {
    problems.push(
      'db:introspect:check exited 0 without a `MIGRATE OK up:` line — it reached no database',
    );
  }
  if (!/db\/schema\.ts: byte-identical to a fresh introspection/.test(text)) {
    problems.push(
      'db:introspect:check exited 0 without comparing the committed file to a fresh rendering',
    );
  }
} else {
  problems.push(`db:introspect:check exited ${String(code)} — see its tagged problem lines above`);
}

if (problems.length === 0) {
  console.log(`\nGATE PASS  ${NAME}`);
  process.exit(0);
}
console.error(`\nGATE FAIL  ${NAME} — ${String(problems.length)} problem(s):`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
