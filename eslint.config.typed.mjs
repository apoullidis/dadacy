// Kinvara ESLint — the TYPE-AWARE overlay. T-005, decisions.md OD-60.
//
// SD §DH-2 says "`any` is a lint error everywhere". `no-explicit-any` in
// eslint.config.mjs refuses a WRITTEN `any` — `as any`, `x: any`. It cannot see
// an `any` VALUE, because a value's type is not in the syntax: `JSON.parse(s)`
// is typed `any` by TypeScript itself, and it flowed into every branded type in
// packages/domain-types unchallenged, a float into `MinorUnits` included. That
// is the whole of OD-60, and closing it needs type information, which needs
// `projectService`.
//
// THIS FILE IS AN OVERLAY, NOT A FORK. It imports eslint.config.mjs and adds
// one block. Every rule, ignore and override in the base config applies here
// unchanged, so `gate:lint` and `gate:no-unsafe-any` cannot drift apart in the
// base rules — there is only one copy of them. What this file adds is the
// `no-unsafe-*` family over the workspace's TypeScript.
//
// WHY A SEPARATE GATE RATHER THAN A SEPARATE RULE IN THE BASE CONFIG. Sites in
// other agents' packages are red today, three of them DELIBERATE tripwires
// whose own comments say "When OD-60 lands this line turns gate:lint red, which
// is the intended signal" (packages/contracts/type-tests/refusals.ts and
// jobs-refusals.ts, packages/domain-types/type-tests/refusals.ts). Turning
// gate:lint red on main is not a thing T-005 may do to the whole programme, and
// editing those files is not T-005's either (role file: "you wire gates; you do
// not write the code they check"). So they are enumerated in
// scripts/gates/no-unsafe-any.baseline.json with their owners; ONE MORE fails
// the gate and REMOVING one fails it too, which is what makes it a ratchet
// rather than a waiver. THE COUNT IS NOT REPEATED HERE: it was "nine sites in
// six files" and became thirteen in seven the moment T-147 merged. The register
// holds the count and the gate prints it (PROTOCOL §5.3 R2 — a second copy of a
// number is a second thing to forget).
//
// Type-aware linting is slower than syntactic linting, which is the other
// reason it is its own gate: `pnpm gate:lint` stays the fast one. Measured
// through `scripts/dev`, the only way anything runs on this host:
// `gate:no-unsafe-any` 16.2-17.8 s against `gate:lint` 12.2-13.3 s. Those are
// the lowest and highest of EVERY measurement recorded for this ticket,
// qa-verification's included; the individual runs are in
// tasks/state/EP-1/T-005.md. Container start is 0.5 s
// (`time ./scripts/dev node -e ''`), so it is not what the gap is made of.
// A RANGE, not a point, and deliberately: an exact figure here goes stale on
// the next commit or on the next run's noise, which is exactly what happened
// to the one this replaces ("about 17 s against about 8 s" — and its 8 s was
// never reproducible through this instrument at all).

import base from './eslint.config.mjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(...base, {
  files: [
    'apps/**/*.ts',
    'apps/**/*.tsx',
    'packages/**/*.ts',
    'packages/**/*.tsx',
    'scripts/**/*.ts',
  ],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    // FIVE of the TEN rules matching `no-unsafe-*` that the pinned plugin
    // ships. These five are the VALUE-FLOW routes: an `any` value assigned,
    // member-accessed, called, returned, or passed as an argument.
    //
    // THIS COMMENT SAID "The family, in full." IT WAS FALSE (QR2-F2,
    // qa-verification 2026-09-19; re-measured by T-005 on 2026-09-20 rather
    // than taken on the reviewer's word). The instrument:
    //   $ node -e 'require("<plugin>/package.json").version'   -> 8.69.0
    //   $ ls <plugin>/dist/rules | grep '^no-unsafe' | grep -v '\.d\.ts'
    //   no-unsafe-argument  no-unsafe-assignment  no-unsafe-call
    //   no-unsafe-declaration-merging  no-unsafe-enum-comparison
    //   no-unsafe-function-type  no-unsafe-member-access  no-unsafe-return
    //   no-unsafe-type-assertion  no-unsafe-unary-minus        (10)
    //
    // THE ONE THAT MATTERS AMONG THE FIVE NOT ENABLED IS
    // `no-unsafe-type-assertion`, and it is not a gap in the wording only.
    // Measured at main 6582596, on a file in this overlay's own globs:
    //
    //   const cfg = JSON.parse(process.env['X'] ?? '{}') as { fee: MinorUnits };
    //   return JSON.parse(s) as MinorUnits;
    //
    //   $ eslint --config eslint.config.typed.mjs <that file>   -> exit 0
    //   $ ... with no-unsafe-type-assertion added to this block -> exit 1,
    //     2 errors: "Unsafe assertion from `any` detected"
    //
    // So a DIRECT assertion (`as T`) walks an `any` into a brand past all five
    // of the rules below. That is a different spelling from the `as unknown as
    // T` route the OD-60 contract already bounds, and it is the more idiomatic
    // one at a JSON boundary — it is OD-60's own reported example.
    // `gate:no-unsafe-any` § WHAT IT DOES NOT CLAIM names both routes.
    //
    // WHETHER TO ENABLE IT IS **T-174's**, NOT THIS FILE'S. The blast radius is
    // four other agents' packages, so it is a behaviour change, not a wording
    // one — carved out by the stakeholder when ruling OE-40 on 2026-09-20
    // precisely so it could not be closed by a sentence. The other four
    // unenabled rules (declaration-merging, enum-comparison, function-type,
    // unary-minus) are not `any`-value routes at all.
    //
    // WHAT GUARANTEES THE FIVE BELOW ARE ON, AND IT IS NOT THIS COMMENT.
    // `gate:no-unsafe-any` check C2 resolves THIS config per file with ESLint's
    // own API and FAILS unless all five, plus the base config's
    // `no-explicit-any`, are at `error` on every TypeScript file git tracks
    // under apps/, packages/ and scripts/. So deleting one of the five, or
    // narrowing the `files:` list above, is red (cases D6, D7, D8 in
    // scripts/negative-tests/pr-gates.sh, and D7/D8 now assert the COUNT the
    // gate prints, not only the reason). Before C2 existed both were GREEN: the
    // gate is a ratchet over OCCURRENCE COUNTS, and a rule that is not enabled
    // produces none.
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
  },
});
