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
import { compile, CompileError, rendersNothingVisible } from './compile.ts';

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

test('negative — a blank string, and a blank plural branch, are refused (QA-F2)', async () => {
  // `""` is valid ICU. It parses, compiles, typechecks and renders `""`. The
  // strict-tier completeness type checks that a PROPERTY EXISTS, not that it has
  // content, so a blank Russian SOS confirmation would otherwise ship with every
  // gate green — and `gate:safety-review-currency` would not see it either while
  // the key sits inside the T-049 waiver. The compiler is the only layer that can
  // tell presence from content.
  const problems = await compileFixture('blank-safety-string');
  assert.equal(problems.length, 2, JSON.stringify(problems, null, 2));
  assert.ok(
    problems.some((p) => /'sos\.confirm' renders nothing visible \(empty string\)/.test(p)),
    'an empty message must be refused',
  );
  assert.ok(
    problems.some((p) => /the 'many' branch of plural 'count' is empty/.test(p)),
    'an empty plural branch must be refused too — the same defect one level down',
  );
});

test('negative — a value that survives trim() but renders nothing is refused (T-049)', async () => {
  // The carried obligation from T-040 / QA round 2, and the one blank shape that
  // is not hypothetical for THIS ticket: `T-049` takes delivery of copy authored
  // outside the repository, in a spreadsheet or a CAT tool. A stripped
  // placeholder, a soft hyphen left by a wrapping tool, or an editor's LTR mark
  // all produce a cell that LOOKS filled and renders as nothing.
  //
  // Note what is asserted here and what is not. The `trim()` block below is an
  // EXTERNAL fact about the language — it would hold with no Kinvara code in the
  // tree at all — and it is what makes the second block meaningful. A test that
  // only checked `rendersNothingVisible` against its own regex would be derived
  // from the same reading as the thing it checks (PROTOCOL §5.1).
  const named: readonly (readonly [string, number])[] = [
    ['U+200B ZERO WIDTH SPACE', 0x200b],
    ['U+00AD SOFT HYPHEN', 0x00ad],
    ['U+2060 WORD JOINER', 0x2060],
    ['U+200E LEFT-TO-RIGHT MARK', 0x200e],
    ['U+0301 COMBINING ACUTE ACCENT, bare', 0x0301],
    // Added after QA round 1 drove the FIRST version of this predicate. Each of
    // these four passed it, compiled, linked, and rendered blank — the same
    // defect the predicate was written to close, intact one property along.
    ['U+2800 BRAILLE PATTERN BLANK', 0x2800],
    ['U+0000 NULL', 0x0000],
    ['U+FFF9 INTERLINEAR ANNOTATION ANCHOR', 0xfff9],
    ['U+FDD0 noncharacter', 0xfdd0],
  ];
  for (const [name, cp] of named) {
    const ch = String.fromCodePoint(cp);
    assert.notEqual(ch.trim(), '', `${name}: trim() was expected NOT to strip this`);
    assert.ok(rendersNothingVisible(ch), `${name}: must be refused as content-free`);
  }

  // U+2800 is the one that shows why "derived from Unicode properties" cannot be
  // the WHOLE construction. It carries none of them, and it is the character of
  // choice for invisible text on the web precisely because of that.
  for (const prop of [
    'White_Space',
    'Default_Ignorable_Code_Point',
    'Mark',
    'Cc',
    'Cf',
    'Noncharacter_Code_Point',
  ]) {
    assert.ok(
      !new RegExp(`^\\p{${prop}}$`, 'u').test(String.fromCodePoint(0x2800)),
      `U+2800 was expected NOT to carry ${prop} — if it now does, simplify the predicate`,
    );
  }

  // THE RESIDUAL, asserted rather than described, so the claim in the contract
  // stays true. These two are NOT refused and must not be: both normally render
  // as a visible .notdef box, and only a font that maps them to a blank glyph
  // would make them invisible. Claiming otherwise would be the overclaim this
  // rework exists to remove.
  for (const [name, cp] of [
    ['U+E000 private use', 0xe000],
    ['U+0378 unassigned', 0x0378],
  ] as const) {
    assert.ok(
      !rendersNothingVisible(String.fromCodePoint(cp)),
      `${name} must NOT be refused — the compiler cannot know how a font renders it`,
    );
  }
  // `U+00A0` is the one shape the old `trim()` check already caught. Keeping it
  // here records WHY the gap existed rather than leaving it as folklore.
  assert.equal(' '.trim(), '', 'U+00A0 was already stripped by trim()');
  assert.ok(rendersNothingVisible(' '));

  // And the predicate must not fire on real copy, including a DECOMPOSED Greek
  // letter — `α` + U+0301 is a letter, and refusing it would break NFD input
  // from exactly the external tools this ticket takes delivery from.
  for (const real of [
    'Call 112 — emergency services',
    'Κρατήστε πατημένο για αποστολή SOS.',
    'Удерживайте, чтобы отправить SOS.',
    'ά',
    '1466',
    '​Η SOS',
  ]) {
    assert.ok(!rendersNothingVisible(real), `false positive on ${JSON.stringify(real)}`);
  }

  // The compiler refuses all seven, including the invisible plural branch one
  // level down — the same defect inside `many`, which only ever fires on 5, 11,
  // 111 … and so is invisible in a two-example spot check as well as on screen.
  const problems = await compileFixture('invisible-safety-string');
  assert.equal(problems.length, 11, JSON.stringify(problems, null, 2));
  for (const key of [
    'zwsp',
    'soft_hyphen',
    'word_joiner',
    'ltr_mark',
    'bare_combining_mark',
    'nbsp',
    'braille_blank',
    'c0_control',
    'interlinear',
    'noncharacter',
  ]) {
    assert.ok(
      problems.some((p) => p.includes(`'${key}' renders nothing visible`)),
      `${key} must be refused — got ${JSON.stringify(problems)}`,
    );
  }
  assert.ok(
    problems.some((p) => /the 'many' branch of plural 'count' is empty/.test(p)),
    'an invisible plural branch must be refused too',
  );
  // The message names the shape, so the error is actionable on a cell that looks full.
  assert.ok(problems.some((p) => /invisible character\(s\): U\+200B/.test(p)));
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
