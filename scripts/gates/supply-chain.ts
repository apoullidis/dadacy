/**
 * gate:supply-chain — T-005, closing OD-51.
 *
 * THE DEFECT. `scripts/dev pnpm install` of a package published inside pnpm's
 * `minimumReleaseAge` window prints ONE informational line —
 * `Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml` — exits 0,
 * and leaves the exemption in a committed file where it reads like
 * configuration somebody chose. Nothing read that key. The supply-chain delay
 * that exists to catch a compromised release is then off for that package, and
 * the only record is a line that scrolled past.
 *
 * TWO MECHANISMS, because either alone is soft:
 *
 *   S1  `minimumReleaseAgeStrict: true` in pnpm-workspace.yaml — pnpm's own
 *       suggestion. With it, pnpm REFUSES the install instead of writing the
 *       exemption. This is the half that prevents the defect.
 *   S2  this gate, which is the half that survives someone deleting S1. It
 *       fails if the setting is absent or not `true`, and it fails on ANY
 *       `minimumReleaseAgeExclude` entry, naming each one.
 *
 * S2 exists because S1 is a line in a YAML file that an install could rewrite,
 * and a prevention nobody checks is a prevention that stops one day without
 * saying so. "If your check did nothing at all, would it say so?" — this one
 * fails when the key it reads is missing, not when it is false.
 *
 * THE REMEDY IS NOT TO ADD AN ENTRY. CONTRACTS.md, from T-115: pin a release
 * OLDER than the window instead — T-115 pinned vite 8.2.2 over the day-old
 * 8.3.0 for exactly this reason. A diff touching `minimumReleaseAgeExclude` is
 * a finding to report, never a fix. If an exemption is genuinely the right
 * answer it is a stakeholder decision recorded in decisions.md, and the entry
 * arrives here with that reference — not from an install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, finish } from './lib/run.ts';

const WS = 'pnpm-workspace.yaml';
const failures: string[] = [];

const file = path.join(REPO_ROOT, WS);
if (!fs.existsSync(file)) finish('gate:supply-chain', [`${WS} does not exist`]);
const lines = fs.readFileSync(file, 'utf8').split('\n');

/** A top-level `key: value` line, comments and indented lines excluded. */
function topLevel(key: string): string | undefined {
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('#') || /^\s/.test(line)) continue;
    const m = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
    if (m !== null) return (m[1] ?? '').trim();
  }
  return undefined;
}

// ------------------------------------------------------------------------ S1
const strict = topLevel('minimumReleaseAgeStrict');
if (strict === undefined) {
  failures.push(
    `S1 ${WS} has no top-level \`minimumReleaseAgeStrict\`. Without it pnpm writes an exemption ` +
      'into this file and exits 0 (OD-51). Restore `minimumReleaseAgeStrict: true`.',
  );
} else if (strict !== 'true') {
  failures.push(
    `S1 \`minimumReleaseAgeStrict\` is ${JSON.stringify(strict)}, not \`true\`. Anything but true ` +
      'lets pnpm exempt a package silently.',
  );
} else {
  console.log(`  ok  ${WS}: minimumReleaseAgeStrict: true`);
}

// ------------------------------------------------------------------------ S2
const excluded: string[] = [];
let inExclude = false;
let excludeInline: string | undefined;
for (const raw of lines) {
  const line = raw.replace(/\r$/, '');
  if (/^minimumReleaseAgeExclude:\s*(.*)$/.test(line)) {
    const rest = /^minimumReleaseAgeExclude:\s*(.*)$/.exec(line)?.[1]?.trim() ?? '';
    inExclude = true;
    if (rest !== '' && rest !== '[]' && !rest.startsWith('#')) excludeInline = rest;
    continue;
  }
  if (inExclude) {
    if (/^\s+-\s*(.+)$/.test(line)) {
      const v = /^\s+-\s*(.+)$/.exec(line)?.[1]?.trim();
      if (v !== undefined && v !== '' && !v.startsWith('#')) excluded.push(v);
      continue;
    }
    if (line.trim() === '' || line.startsWith('#')) continue;
    inExclude = false;
  }
}
if (excludeInline !== undefined) excluded.push(excludeInline);

if (excluded.length > 0) {
  failures.push(
    `S2 ${WS} carries ${String(excluded.length)} \`minimumReleaseAgeExclude\` entry(ies): ` +
      `${excluded.join(', ')}. pnpm writes these itself on an install and exits 0 (OD-51). ` +
      'The remedy is to PIN A RELEASE OLDER THAN THE WINDOW, not to keep the exemption ' +
      '(T-115 pinned vite 8.2.2 over the day-old 8.3.0 for this reason). If an exemption is ' +
      'genuinely right it is a recorded decision in decisions.md, and this gate is where you ' +
      'record that it was taken deliberately.',
  );
} else {
  console.log(`  ok  ${WS}: no minimumReleaseAgeExclude entries`);
}

finish('gate:supply-chain', failures);
