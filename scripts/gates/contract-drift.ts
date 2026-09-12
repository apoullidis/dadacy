/**
 * gate:contract-drift — T-001 reserved this name for `tech-lead` (Zod <-> OpenAPI);
 * T-022 supplies the rule set.
 *
 * WHAT IT CHECKS. `packages/contracts` commits two GENERATED artefacts,
 * `openapi.json` and `src/generated/client.ts`, both derived from the Zod
 * schemas in `src/endpoints.ts`. This gate regenerates them into a temporary
 * directory and requires the bytes to be identical to the committed ones. A
 * Zod edit committed without regenerating is refused; so is a hand edit to
 * either generated file.
 *
 * WHICH ARTEFACT IS THE SOURCE OF TRUTH — PROTOCOL §5.1 requires this to be
 * said, because a check comparing two artefacts is worthless if nobody knows
 * which one leads. **The Zod schemas lead.** `openapi.json` and the client are
 * outputs. On a mismatch the fix is ALWAYS to re-run the generator, never to
 * edit the document to match — and the message below says so, because the
 * cheapest way to make this gate green is exactly the wrong one.
 *
 * WHAT WOULD MAKE THE TWO AGREE WHILE BOTH ARE WRONG, stated rather than
 * discovered later. This gate compares a regeneration against a committed
 * generation. If `tools/generate.ts` mistranslates a schema, it mistranslates
 * it identically both times and this gate is GREEN on a wrong document. **This
 * gate cannot catch a generator bug, and does not claim to.** Two other things
 * do, and neither is this gate:
 *   - `pnpm -w typecheck` (in `gate:pr`): the generated client's `satisfies`
 *     clauses require what the Zod schema PARSES to be assignable to the type
 *     the DOCUMENT declares, so a mistranslated type is a compile error.
 *   - `packages/contracts` › `openapi.test.ts` › *Zod and the generated
 *     document agree, payload by payload, on every case in the corpus*, which
 *     validates payloads against the document with `src/json-schema-check.ts`
 *     — a validator that shares no code with Zod. Bounded by its corpus, and
 *     NOT in any gate (OD-57).
 *
 * NON-VACUITY. A check that did nothing must say so (PROTOCOL §5.1). This one
 * asserts, before judging any bytes, that the generator exited 0 and that
 * every expected artefact was actually produced in the temp directory and
 * exists in the repository. If the generator silently wrote nothing, the gate
 * FAILs with "produced no <file>" rather than comparing two absent files and
 * finding them equal.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/run.ts';

const PKG = join(REPO_ROOT, 'packages', 'contracts');

/** Each generated artefact: where the generator puts it, and where it is committed. */
const ARTEFACTS = [
  { produced: 'openapi.json', committed: join(PKG, 'openapi.json') },
  { produced: 'client.ts', committed: join(PKG, 'src', 'generated', 'client.ts') },
] as const;

const problems: string[] = [];
const tmp = mkdtempSync(join(tmpdir(), 'contract-drift-'));

try {
  const run = spawnSync('node', [join(PKG, 'tools', 'generate.ts'), '--out-dir', tmp], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  // The generator's own stdout is forwarded ONLY when it fails. On success it
  // says "wrote <path>" twice, and those paths are inside the mkdtemp
  // directory, so they differ on every run — which made this gate's output
  // non-deterministic while its verdict was perfectly stable. Measured: two
  // consecutive passing runs exited 0 and differed in bytes. PROTOCOL §5.1
  // requires a comparison check to assert the exit status AND the bytes, so a
  // gate whose own output cannot be compared is a gate that cannot be used in
  // one. On failure the generator's output is the diagnostic and is forwarded.
  if (run.status !== 0 && run.stdout !== '') process.stdout.write(run.stdout);
  if (run.stderr !== '') process.stderr.write(run.stderr);

  if (run.error !== undefined) {
    problems.push(`the generator did not start: ${run.error.message}`);
  } else if (run.status !== 0) {
    problems.push(`the generator exited ${String(run.status)}, so nothing could be compared`);
  } else {
    for (const { produced, committed } of ARTEFACTS) {
      const fresh = join(tmp, produced);
      // Non-vacuity, both sides, before any comparison.
      if (!existsSync(fresh)) {
        problems.push(`the generator produced no ${produced}: there is nothing to compare against`);
        continue;
      }
      if (!existsSync(committed)) {
        problems.push(
          `${committed} is missing: run \`pnpm --filter @kinvara/contracts run generate\` and commit it`,
        );
        continue;
      }
      const a = readFileSync(committed, 'utf8');
      const b = readFileSync(fresh, 'utf8');
      if (a === b) continue;

      const aLines = a.split('\n');
      const bLines = b.split('\n');
      const at = aLines.findIndex((line, i) => line !== bLines[i]);
      problems.push(
        `${produced} is out of date — the committed file and a fresh generation differ.\n` +
          `      first difference at line ${String(at + 1)}:\n` +
          `        committed:  ${JSON.stringify(aLines[at] ?? '(end of file)')}\n` +
          `        generated:  ${JSON.stringify(bLines[at] ?? '(end of file)')}\n` +
          '      THE ZOD SCHEMAS IN src/endpoints.ts ARE THE SOURCE OF TRUTH. Fix this by\n' +
          '      running `pnpm --filter @kinvara/contracts run generate` and committing the\n' +
          '      result — never by editing the generated file to match.',
      );
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\nGATE FAIL  gate:contract-drift — ${String(problems.length)} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `\ngate:contract-drift: ${String(ARTEFACTS.length)} generated artefact(s) match a fresh generation`,
);
console.log('\nGATE PASS  gate:contract-drift');
