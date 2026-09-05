// Kinvara ESLint flat config — SD §DH-2: "Prettier + ESLint (flat config), no
// debate, no per-file overrides."
//
// T-001 wires the tool and the standards SD §DH-2 states by name. The
// project-specific rules that belong to other agents are NOT here:
//   - the `render(templateId, locale, params)` call-site rule  -> T-041 (SE-8)
//   - `no throw new Error(...)` in domain code                 -> tech-lead
//   - the ILIKE ban (DV-13)                                    -> tech-lead
//   - Semgrep project rules                                    -> T-005
// Module boundaries are dependency-cruiser's job, not ESLint's (SA §SA-2).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '.pnpm-store/**',
      '.cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // CommonJS tool configuration files. `.dependency-cruiser.cjs` is the one
    // file in the repo that is legitimately CJS: dependency-cruiser loads it
    // with require().
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    // Plain ESM run directly by Node, with no build step, no bundler and no
    // dependency: the vendor fakes (T-017, docker/fakes), the application
    // image's entrypoint and healthcheck (T-018, docker/app-runtime) and the
    // verification probes (T-018, scripts/verify). They are linted like
    // everything else — but Node's globals have to be declared for them,
    // because the rest of this repo is TypeScript and typescript-eslint turns
    // `no-undef` off for TS files (the compiler already answers that question).
    //
    // The glob is `**/*.mjs`, NOT a list of the three directories. A list is a
    // thing to forget: the fourth directory of hand-written ESM would lint
    // clean against `no-undef` by simply not matching, which is a check that
    // quietly stops applying rather than one that fails. T-018 widened it for
    // that reason, having been the fourth directory.
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  {
    rules: {
      // SD §DH-2: "`any` is a lint error everywhere; in packages/policy it is
      // a Semgrep failure." The Semgrep half is T-005's.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
);
