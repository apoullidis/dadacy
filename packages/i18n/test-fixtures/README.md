# `packages/i18n/test-fixtures/`

Miniature i18n packages the compiler is pointed at with `compile({ root, out })`.
Each case is the smallest catalogue that reproduces one failure.

`src/runtime.ts` and `src/types.ts` in each case are one-line re-exports of the
real package's modules, because `tools/compile.ts` emits imports relative to the
root it was given.

Compiler output goes to `<case>/dist/`, which is ignored by git, prettier, eslint
and the root typecheck program — a fixture's generated code is not repository
code and must not be able to turn a gate red on its own.
