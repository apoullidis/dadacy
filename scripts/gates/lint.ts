/**
 * gate:lint — ESLint (flat config) + Prettier, repository-wide. SD §DH-2:
 * "Prettier + ESLint (flat config), no debate, no per-file overrides."
 */
import { bin, stream, finish } from './lib/run.ts';

const failures: string[] = [];

console.log('$ eslint .');
if (stream(bin('eslint'), ['.']) !== 0) failures.push('eslint reported problems');

console.log('\n$ prettier --check .');
if (stream(bin('prettier'), ['--check', '.']) !== 0) {
  failures.push('prettier found unformatted files (run `pnpm -w format`)');
}

finish('gate:lint', failures);
