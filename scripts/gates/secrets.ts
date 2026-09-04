/**
 * gate:secrets — gitleaks over the working tree. SD §QD-4 PR row.
 *
 * `gitleaks dir` scans the filesystem rather than git history, so an
 * uncommitted secret is caught before it can ever become a commit. That is the
 * order that matters: a secret found in history has already leaked.
 */
import { capture, stream, finish, toolVersions } from './lib/run.ts';

const failures: string[] = [];
const pinned = toolVersions().get('gitleaks');

const v = capture('gitleaks', ['version']);
if (v.spawnFailed || v.code !== 0) {
  failures.push(
    'gitleaks is not on PATH. It lives in the toolbox image — run `scripts/dev --build`.',
  );
} else {
  const found = v.stdout.trim();
  console.log(`gitleaks ${found} (pinned ${String(pinned)})`);
  if (pinned !== undefined && found !== pinned) {
    failures.push(`gitleaks ${found} != .tool-versions pin ${pinned}; rebuild the toolbox`);
  }
}

if (failures.length === 0) {
  console.log('\n$ gitleaks dir . --config .gitleaks.toml --no-banner --redact');
  const code = stream('gitleaks', [
    'dir',
    '.',
    '--config',
    '.gitleaks.toml',
    '--no-banner',
    '--redact',
    '--exit-code',
    '1',
  ]);
  if (code !== 0) failures.push(`gitleaks exited ${String(code)} — a secret was detected`);
}

finish('gate:secrets', failures);
