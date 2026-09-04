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
