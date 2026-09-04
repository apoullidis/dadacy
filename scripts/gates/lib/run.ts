/**
 * Shared helpers for the Kinvara gate scripts (T-001).
 *
 * PROTOCOL.md §5.1: "a gate is a command". Every gate in this directory is a
 * program that exits 0 or non-zero and prints why. Nothing here swallows an
 * exit status, and nothing here compares output without also comparing the
 * exit status — see the zsh word-splitting near-miss recorded in T-000.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const REPO_ROOT: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** Absolute path to a binary installed by pnpm at the workspace root. */
export function bin(name: string): string {
  return path.join(REPO_ROOT, 'node_modules', '.bin', name);
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnFailed: boolean;
}

/** Run a command, capture its output. Never throws. */
export function capture(
  cmd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): ExecResult {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') merged[k] = v;
  }
  for (const [k, v] of Object.entries(env)) merged[k] = v;

  const r = spawnSync(cmd, [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: merged,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    return { code: 127, stdout: '', stderr: r.error.message, spawnFailed: true };
  }
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    spawnFailed: false,
  };
}

/** Run a command with its output going straight to this process's streams. */
export function stream(cmd: string, args: readonly string[]): number {
  const r = spawnSync(cmd, [...args], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.error !== undefined) {
    console.error(`  cannot execute '${cmd}': ${r.error.message}`);
    return 127;
  }
  return r.status ?? 1;
}

/** The pins in .tool-versions, the single source of truth (DOCKER.md §4.2). */
export function toolVersions(): ReadonlyMap<string, string> {
  const text = fs.readFileSync(path.join(REPO_ROOT, '.tool-versions'), 'utf8');
  const pins = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    const key = parts[0];
    const value = parts[1];
    if (key !== undefined && value !== undefined) pins.set(key, value);
  }
  return pins;
}

/** Terminate a gate. Exit 0 only on a clean pass; any failure is non-zero. */
export function finish(gate: string, failures: readonly string[]): never {
  if (failures.length === 0) {
    console.log(`\nGATE PASS  ${gate}`);
    process.exit(0);
  }
  console.error(`\nGATE FAIL  ${gate} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
