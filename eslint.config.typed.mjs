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
// Type-aware linting is slower than syntactic linting (measured: about 17 s
// against about 8 s on this host), which is the other reason it is its own
// gate: `pnpm gate:lint` stays the fast one.

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
    // into typed code, and leaving any of them out leaves that route open.
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
  },
});
