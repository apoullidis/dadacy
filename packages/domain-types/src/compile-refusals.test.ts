/**
 * The compile-time half of T-023's contract: every `@ts-expect-error` directive
 * in type-tests/refusals.ts hides exactly the refusal it names.
 *
 * Why not rely on `pnpm -w typecheck` alone: an unused directive is an error
 * (TS2578), so the typecheck proves each marked line errors — but it accepts
 * ANY error there, including one from a typo or a deleted import, which would
 * leave the brand unproven while the gate stays green (PROTOCOL §5.1, "a
 * harness must never infer a verdict from a signal that a no-op also
 * produces"). The compiler is the oracle here; the expected code and type
 * names are written by hand in the directive, not derived from the compiler.
 *
 * THIS CHECK IS IN NO GATE (OD-57). `gate:pr` runs only the typecheck half.
 * This file runs only when someone runs `pnpm --filter @kinvara/domain-types
 * test` or `pnpm -w test` by hand, until T-005 wires package tests into a gate.
 * It also cannot see a refusal row DELETED, directive and line together. It
 * requires only 20 directives in total (the gate case once, the money case
 * twice), so any two other rows can vanish with typecheck and this file green.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(PKG, 'type-tests', 'refusals.ts');
const SOURCE = readFileSync(FILE, 'utf8');
const DIRECTIVE = /^\s*\/\/ @ts-expect-error (TS[0-9]+)((?: '[^']+')+)\s*$/;

interface Case {
  /** 0-based line of the refused statement (the line after the directive) */
  line: number;
  code: number;
  names: string[];
}

function readCases(): Case[] {
  const cases: Case[] = [];
  SOURCE.split('\n').forEach((text, i) => {
    const m = DIRECTIVE.exec(text);
    if (m === null) return;
    const names = [...(m[2] ?? '').matchAll(/'([^']+)'/g)].map((n) => n[1] ?? '');
    cases.push({ line: i + 1, code: Number((m[1] ?? '').slice(2)), names });
  });
  return cases;
}

function compile(source: string): readonly ts.Diagnostic[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(PKG, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new TypeError(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  assert.ok(parsed !== undefined, 'tsconfig.json did not parse');
  const host = ts.createCompilerHost(parsed.options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, create) =>
    name === FILE
      ? ts.createSourceFile(name, source, language)
      : read(name, language, onError, create);
  const program = ts.createProgram({ rootNames: [FILE], options: parsed.options, host });
  return ts.getPreEmitDiagnostics(program);
}

function describeDiagnostic(d: ts.Diagnostic): string {
  const where =
    d.file !== undefined && d.start !== undefined
      ? `${d.file.fileName}:${String(d.file.getLineAndCharacterOfPosition(d.start).line + 1)}`
      : '(global)';
  return `${where} TS${String(d.code)} ${ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0] ?? ''}`;
}

test('the refusals file compiles clean as written: every directive is used and every CONTROL line compiles', () => {
  const diagnostics = compile(SOURCE);
  assert.deepEqual(diagnostics.map(describeDiagnostic), []);
}, 120_000);

test('each stripped directive exposes exactly the refusal it names on the line beneath it, and nothing else errors', () => {
  const cases = readCases();
  assert.ok(cases.length >= 20, `only ${String(cases.length)} directives were read`);

  // A pragma this reader does not parse (`@ts-ignore`, a `/* */` form, names
  // without quotes) would stay live below and hide its line's error unseen.
  const unread = SOURCE.split('\n').filter(
    (l) => l.includes('@ts-') && !DIRECTIVE.test(l) && !/^\s*\*/.test(l),
  );
  assert.deepEqual(unread, [], 'a @ts- pragma outside the header is not a parsed directive');

  const stripped = SOURCE.split('\n')
    .map((l) => (DIRECTIVE.test(l) ? l.replace('// @ts-expect-error ', '// (stripped) ') : l))
    .join('\n');
  const changed = SOURCE.split('\n').filter((l, i) => l !== stripped.split('\n')[i]).length;
  assert.equal(changed, cases.length, 'the strip did not land on exactly the directive lines');

  const diagnostics = compile(stripped);
  const problems: string[] = [];
  for (const c of cases) {
    const here = diagnostics.filter(
      (d) =>
        d.file?.fileName === FILE &&
        d.start !== undefined &&
        d.file.getLineAndCharacterOfPosition(d.start).line === c.line,
    );
    const first = here[0];
    if (here.length !== 1 || first === undefined) {
      problems.push(
        `line ${String(c.line + 1)}: ${String(here.length)} diagnostics, want exactly 1 TS${String(c.code)}`,
      );
      continue;
    }
    const message = ts.flattenDiagnosticMessageText(first.messageText, '\n').split('\n')[0] ?? '';
    if (first.code !== c.code)
      problems.push(
        `line ${String(c.line + 1)}: TS${String(first.code)}, want TS${String(c.code)}: ${message}`,
      );
    for (const name of c.names) {
      if (!message.includes(`'${name}'`))
        problems.push(`line ${String(c.line + 1)}: message does not name '${name}': ${message}`);
    }
  }
  const caseLines = new Set(cases.map((c) => c.line));
  for (const d of diagnostics) {
    const line =
      d.file !== undefined && d.start !== undefined
        ? d.file.getLineAndCharacterOfPosition(d.start).line
        : -1;
    if (d.file?.fileName !== FILE || !caseLines.has(line))
      problems.push(`unexpected: ${describeDiagnostic(d)}`);
  }
  assert.deepEqual(problems, []);
}, 120_000);

test('the gate case is present: a BookingId passed where a SessionId is expected is TS2345', () => {
  const found = readCases().filter(
    (c) => c.code === 2345 && c.names.join() === 'BookingId,SessionId',
  );
  assert.equal(found.length, 1);
});

test('the money case is present: a number passed where MinorUnits is expected is TS2345', () => {
  const found = readCases().filter(
    (c) => c.code === 2345 && c.names.join() === 'number,MinorUnits',
  );
  assert.equal(found.length, 2);
});
