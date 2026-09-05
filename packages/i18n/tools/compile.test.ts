/**
 * The compiler's refusals, and the one failure it deliberately does NOT refuse.
 *
 * Every case here is a *negative*: the compiler exists to turn a class of silent
 * content defect into a build failure, and a compiler that has only ever been
 * seen succeed has not been shown to be wired to anything (PROTOCOL §5.1).
 *
 * The last test is the important one. A Russian catalogue supplying only
 * `one`/`other` is valid ICU: it parses, it compiles, it loads and it renders.
 * The compiler cannot refuse it, and this test measures exactly how wrong the
 * result is — which is the case EV-2's `gate:plural-completeness` (`T-045`)
 * exists for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, CompileError } from './compile.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');

async function compileFixture(name: string): Promise<string[]> {
  const root = join(FIXTURES, name);
  try {
    await compile({ root, out: join(root, 'dist') });
    return [];
  } catch (err) {
    if (err instanceof CompileError) return [...err.problems];
    throw err;
  }
}

test('negative — a malformed ICU message is a build failure, not a runtime exception', async () => {
  const problems = await compileFixture('malformed-icu');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /catalogues\/en\/session\.json 'checkins_missed'/);
  assert.match(problems[0] ?? '', /malformed ICU message/);
});

test('negative — a catalogue key with no tier fails closed', async () => {
  const problems = await compileFixture('untiered-key');
  assert.ok(
    problems.some((p) => /'safety\.emergency\.call_112\.label' has no tier/.test(p)),
    `expected an untiered-key failure, got ${JSON.stringify(problems)}`,
  );
  // And it must not be rescued by a neighbouring key's tier: `safety.sos.confirm`
  // is tiered `safety_critical` in the same namespace and does not confer it.
  assert.ok(!problems.some((p) => /'safety\.sos\.confirm' has no tier/.test(p)));
});

test('negative — a key that exists only in a translation is an orphan', async () => {
  const problems = await compileFixture('orphan-key');
  assert.ok(
    problems.some((p) => /catalogues\/ru\/: 'booking\.count\.upcomming'/.test(p)),
    `expected an orphan-key failure, got ${JSON.stringify(problems)}`,
  );
});

test('the real catalogues compile, and every strict-tier key is emitted', async () => {
  const result = await compile({ check: true });
  assert.deepEqual(
    result.drift,
    [],
    'compiled/ is stale — run `pnpm --filter @kinvara/i18n build`',
  );
  assert.deepEqual(result.locales, ['en', 'el', 'ru']);
  assert.ok(result.strictKeyCount > 0);
});

test('a two-category Russian catalogue COMPILES, RENDERS, and is silently wrong', async () => {
  // This is the defect stated as a measurement rather than as a warning.
  const root = join(FIXTURES, 'two-category-ru');
  const out = join(root, 'dist');
  rmSync(out, { recursive: true, force: true });
  const result = await compile({ root, out });
  assert.ok(
    result.files.size > 0,
    'a two-category ru catalogue must compile — the compiler cannot catch this',
  );

  const mod: { messages: Record<string, (p: { count: number; sitterName: string }) => string> } =
    await import(join(out, 'ru', 'index.ts'));
  const render = (count: number): string =>
    mod.messages['session.checkins_missed']?.({ count, sitterName: 'X' }) ?? '';

  // Where the two-category file happens to agree with the four-category one:
  assert.equal(render(1), 'Пропущена 1 отметка от X'); //   one   — correct
  assert.equal(render(2), 'Пропущено 2 отметки от X'); //   few   — correct BY ACCIDENT

  // And where it does not. These are the counts a `one`/`other` file gets wrong,
  // in a string that reaches a parent as a missed-check-in escalation:
  for (const [count, wrong, right] of [
    [0, 'Пропущено 0 отметки от X', 'Пропущено 0 отметок от X'],
    [5, 'Пропущено 5 отметки от X', 'Пропущено 5 отметок от X'],
    [11, 'Пропущено 11 отметки от X', 'Пропущено 11 отметок от X'],
    [111, 'Пропущено 111 отметки от X', 'Пропущено 111 отметок от X'],
  ] as const) {
    assert.equal(render(count), wrong, `two-category ru at ${String(count)}`);
    assert.notEqual(render(count), right);
  }

  rmSync(out, { recursive: true, force: true });
});
