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
 * THE FOOTER'S CASE COUNT IS HELD AGAINST THE PIN (T-237, OD-267). `gate:negative-suites` pins
 * this suite's case count (`cases:` in its SUITES entry `db-introspect`) but cannot run it, so until
 * T-237 nothing compared a real run's count with that pin: a detached commit whose suite printed
 * `ALL 143 CASES BEHAVED AS EXPECTED` against a pin of 144 got GATE PASS here (QA on T-214). The pin
 * is read from scripts/gates/negative-suites.ts's SYNTAX TREE (the `cases` numeric literal of the one
 * SUITES element whose `id` is 'db-introspect'), BEFORE the suite runs; an unreadable pin, or more
 * or fewer than one such entry, is GATE FAIL without running anything. A green footer over any other
 * count is GATE FAIL, and a red footer reports its count beside the pin. The pin and the footer are
 * two readings of two artefacts (a number a person wrote when the suite was last measured, and the
 * count a real run printed), so neither is taken on the other's word.
 *
 * `KINVARA_DBI_SUITE=<path>` replaces the suite with another script, for the cases in
 * scripts/negative-tests/heavy-gates.sh that attack this judgement without a database (the same
 * convention as gate:negative-suites' KINVARA_NEG_SUITES_TABLE). Every banner of such a run says
 * `[OVERRIDE SUITE: <path>]`, so it can never be read as, or carried by gate:heavy as, a real pass:
 * gate:heavy requires the exact line `GATE PASS  gate:db-introspect-suite`.
 *
 * THE SUITE REFUSES A DIRTY TREE, and so this gate does. That is not a
 * preference — the suite plants migrations and deletes db/schema.ts, and
 * T-168 gave it EXIT/INT/TERM traps precisely because an interrupted run must
 * put tracked files back. Commit first; uncommitted work is not evidence
 * anyway (PROTOCOL §3). This mirrors `gate:pr`'s clean-tree requirement
 * (T-005 § contract §4) rather than inventing a second convention.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { REPO_ROOT } from './lib/run.ts';

const OVERRIDE = process.env['KINVARA_DBI_SUITE'] ?? '';
const NAME =
  OVERRIDE === ''
    ? 'gate:db-introspect-suite'
    : `gate:db-introspect-suite [OVERRIDE SUITE: ${OVERRIDE}]`;
const SUITE = OVERRIDE === '' ? 'scripts/negative-tests/db-introspect.sh' : OVERRIDE;
const ROSTER = 'scripts/gates/negative-suites.ts';
const ENTRY = 'db-introspect';

/**
 * T-237 (OD-267): the case count gate:negative-suites pins for this suite, read from the roster's
 * syntax tree: the numeric literal `cases` of the one element of `const SUITES = [...]` whose `id` is
 * the string 'db-introspect'. Anything else (no such entry, two, a `cases` that is not a literal) is
 * an error, never a default.
 */
function pinnedCases(): { readonly cases: number } | { readonly error: string } {
  const file = path.join(REPO_ROOT, ROSTER);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: `${ROSTER} cannot be read` };
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts: (number | null)[] = [];
  const prop = (o: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
    for (const p of o.properties) {
      if (
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === key
      )
        return p.initializer;
    }
    return undefined;
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'SUITES' &&
      n.initializer !== undefined &&
      ts.isArrayLiteralExpression(n.initializer)
    ) {
      for (const el of n.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        const id = prop(el, 'id');
        if (id === undefined || !ts.isStringLiteral(id) || id.text !== ENTRY) continue;
        const c = prop(el, 'cases');
        counts.push(c !== undefined && ts.isNumericLiteral(c) ? Number(c.text) : null);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const only = counts[0];
  if (counts.length !== 1 || only === undefined || only === null) {
    return {
      error:
        `${ROSTER} has ${String(counts.length)} SUITES entr(ies) with id '${ENTRY}'` +
        (counts.length === 1 ? ' and its `cases` is not a numeric literal' : '') +
        '; exactly one, with a literal case count, is required',
    };
  }
  return { cases: only };
}

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

const pin = pinnedCases();
if ('error' in pin) {
  console.error(`GATE FAIL  ${NAME} — 1 problem(s):`);
  console.error(
    `  - cannot read the case count gate:negative-suites pins for this suite: ${pin.error}.`,
  );
  console.error(
    '    Without it a run that skipped a case is indistinguishable from a full one (OD-267).',
  );
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

console.log(
  `$ bash ${SUITE}   (project ${project}, PGHOST ${pghost}; pinned at ${String(pin.cases)} cases in ${ROSTER})`,
);
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
  const n = Number(green[1]);
  if (n !== pin.cases) {
    console.error(
      `\nGATE FAIL  ${NAME} — the footer reports ${String(n)} case(s); ${ROSTER} pins '${ENTRY}' at ${String(pin.cases)}.`,
    );
    console.error(
      '  A case was added, deleted or skipped (OD-267: a case calling an undefined helper was',
    );
    console.error(
      '  skipped with a green footer). A pass over a different set of cases is not the pass',
    );
    console.error(
      `  that was pinned: re-verify the suite, then move \`cases\` in ${ROSTER} with the new number.`,
    );
    process.exit(1);
  }
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
if (Number(red?.[2]) !== pin.cases) {
  console.error(
    `  And the footer counts ${String(red?.[2])} case(s), where ${ROSTER} pins '${ENTRY}' at ${String(pin.cases)} (OD-267).`,
  );
}
console.error("  This gate prints the suite's last six lines only; the suite's own `BAD` lines");
console.error(
  '  name the cases (run `bash scripts/negative-tests/db-introspect.sh` under svc run).',
);
process.exit(1);
