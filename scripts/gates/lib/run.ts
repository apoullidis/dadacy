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

/**
 * Every script that IMPORTS THIS MODULE writes stdout and stderr synchronously
 * when either is a pipe or a socket (T-239, OD-262). Gates that do not import it
 * are NOT covered: `packages/i18n/tools/{locale-completeness,safety-review-currency,
 * sms-segments}.ts` (all BLOCKING in gate:pr, each with its own finish ->
 * process.exit; 1,153 / 1,027 / 6,729 bytes of output measured at 8341e3f, far
 * under either buffer below — OD-266), and scripts/gates/not-yet-supplied.ts.
 *
 * Gates end in `process.exit` (`finish()` below, and the aggregates' own exits).
 * `process.exit` discards any write libuv has not yet handed to the kernel, and
 * on this host stdout is NOT synchronous when it is a pipe or a socket, which is
 * what gate:heavy's two segments met (measured, tasks/state/EP-1/T-239.md R0–R0d):
 *   - under `capture()` (spawnSync) fd 1 is an AF_UNIX socketpair with SO_SNDBUF
 *     131072; one write of ~155 KB is accepted up to 146,176 bytes and the rest
 *     is queued — so gate:constraint-suite's GATE PASS banner was dropped and
 *     gate:heavy (correctly) refused the run;
 *   - under `scripts/dev` fd 1 is a 64 KiB FIFO; gate:heavy's own ~150 KB print
 *     of a sub-gate's output was cut at the first 64 KiB the same way.
 * Setting the handle blocking makes write() return only after the kernel has
 * every byte, so nothing is queued when `process.exit` runs. Files and TTYs are
 * left alone (Node documents both as synchronous on Linux; T-239 measured pipes
 * and sockets only). A pipe or socket whose
 * handle cannot be made blocking is REFUSED (exit 70) rather than run lossy.
 *
 * The trade, measured by T-239's QA (QA-3b): a reader that STOPS READING but
 * keeps the pipe open (an unscrolled pager, `| less`) now holds the gate in
 * write() until the reader drains or a signal ends it; before, the gate exited 0
 * with its output cut. That fails safe (no verdict for bytes nobody read), and
 * no reader in this build does it: spawnSync, docker, `> file`, `| cat` and
 * `| tee` all drain. A reader that CLOSES early gives EPIPE, and the gate ends
 * in exit 70 (GATE CRASH) or its own non-zero, never a hang (QA-3a).
 */
function blockingStdio(): void {
  for (const [fd, s] of [
    [1, process.stdout],
    [2, process.stderr],
  ] as const) {
    let lossy: boolean;
    try {
      const st = fs.fstatSync(fd);
      lossy = st.isFIFO() || st.isSocket();
    } catch {
      continue; // fd closed: nothing to lose
    }
    if (!lossy) continue;
    const h = (s as unknown as { _handle?: { setBlocking?: (on: boolean) => number } })._handle;
    const rc = typeof h?.setBlocking === 'function' ? h.setBlocking(true) : -1;
    if (rc !== 0) {
      fs.writeSync(
        2,
        `GATE CRASH  fd ${String(fd)} is a pipe/socket that cannot be made blocking ` +
          `(setBlocking -> ${String(rc)}); refusing to run a gate whose output process.exit ` +
          `could drop (T-239).\n`,
      );
      process.exit(70);
    }
  }
}
blockingStdio();

/**
 * `process.exit`, refusing to drop output (T-239). After `blockingStdio()` no
 * write can still be pending here (`writableLength` counts a partly-sent write
 * whole); if one is, the gate's own output is
 * incomplete, so this exits 70 with a GATE CRASH line written straight to fd 2
 * instead of letting `code` stand for a run whose text was cut.
 */
export function exitFlushed(code: number): never {
  const queued = process.stdout.writableLength + process.stderr.writableLength;
  if (queued > 0) {
    try {
      fs.writeSync(
        2,
        `\nGATE CRASH  stdout/stderr writes totalling ${String(queued)} byte(s) not completed at exit ` +
          `(intended exit ${String(code)}); the printed output is incomplete (T-239).\n`,
      );
    } catch {
      // fd 2 itself is full or gone: the exit status below still says it.
    }
    process.exit(70);
  }
  process.exit(code);
}

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
    exitFlushed(0);
  }
  console.error(`\nGATE FAIL  ${gate} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  exitFlushed(1);
}
