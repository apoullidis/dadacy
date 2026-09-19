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
// WHY A SEPARATE GATE RATHER THAN A SEPARATE RULE IN THE BASE CONFIG. Nine
// sites in six files are red today, in packages owned by four other agents, and
// one of them (packages/contracts/type-tests/refusals.ts) is a DELIBERATE
// tripwire whose comment says: "When OD-60 lands this line turns gate:lint red,
// which is the intended signal." Turning gate:lint red on main is not a thing
// T-005 may do to the whole programme, and editing those files is not T-005's
// either (role file: "you wire gates; you do not write the code they check").
// So the nine are enumerated in scripts/gates/no-unsafe-any.baseline.json with
// their owners, a TENTH fails the gate, and REMOVING one fails it too — which
// is what makes it a ratchet rather than a waiver.
//
// Type-aware linting is slower than syntactic linting, which is the other
// reason it is its own gate: `pnpm gate:lint` stays the fast one. Measured
// through `scripts/dev`, the only way anything runs on this host:
// `gate:no-unsafe-any` about 17 s (16.6 s and 17.7 s on two runs of this
// branch) against `gate:lint` about 12 s (12.4 s both times). Container start
// is 0.5 s (`time ./scripts/dev node -e ''`), so it is not what the gap is made
// of. Stated as an "about" with the measurements beside it because an exact
// figure here goes stale on the next commit — which is what happened to the
// previous one, "about 17 s against about 8 s": the 8 s was not reproducible
// through this instrument at all.

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
    // The family, in full. Each one is a different route from an `any` value
    // into typed code.
    //
    // WHAT GUARANTEES THAT, AND IT IS NOT THIS COMMENT. `gate:no-unsafe-any`
    // check C2 resolves THIS config per file with ESLint's own API and FAILS
    // unless all five below, plus the base config's `no-explicit-any`, are at
    // `error` on every TypeScript file git tracks under apps/, packages/ and
    // scripts/. So deleting one of the five, or narrowing the `files:` list
    // above, is red (cases D6, D7, D8 in scripts/negative-tests/pr-gates.sh).
    // Before C2 existed both were GREEN: the gate is a ratchet over OCCURRENCE
    // COUNTS, and a rule that is not enabled produces none.
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
  },
});
