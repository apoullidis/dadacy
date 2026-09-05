/**
 * Assertions shared by the constraint suites.
 *
 * Every one of them asserts the **exit status** as well as the bytes.
 * PROTOCOL §5.1: "Two runs that both fail identically are byte-identical" —
 * two separate agents on this build compared two identical `exit 127` error
 * messages as if that were a pass. A refusal that is only matched on its
 * message would pass for a psql that never connected.
 */
import assert from 'node:assert/strict';
import type { PsqlResult } from './cluster.ts';

export interface Refusal {
  /** A substring that must appear in psql's combined output. */
  readonly message: string;
  /** The SQLSTATE, when the statement was run with `\set VERBOSITY verbose`. */
  readonly sqlstate?: string;
}

/** The statement was refused: psql exited non-zero AND said why. */
export function assertRefused(what: string, r: PsqlResult, expected: Refusal): void {
  assert.notEqual(
    r.code,
    0,
    `${what}: expected psql to exit non-zero (the statement must be REFUSED) but it exited 0.\n${r.output}`,
  );
  assert.ok(
    r.output.includes(expected.message),
    `${what}: psql exited ${String(r.code)} but the output does not contain ${JSON.stringify(expected.message)}.\n${r.output}`,
  );
  if (expected.sqlstate !== undefined) {
    assert.ok(
      r.output.includes(expected.sqlstate),
      `${what}: expected SQLSTATE ${expected.sqlstate} in the output.\n${r.output}`,
    );
  }
}

/** The statement was permitted: psql exited 0. */
export function assertPermitted(what: string, r: PsqlResult): void {
  assert.equal(
    r.code,
    0,
    `${what}: expected psql to exit 0 (the statement must be PERMITTED) but it exited ${String(r.code)}.\n${r.output}`,
  );
}

/** The SA §INT-10 guard's own raise, whatever the object class that triggered it. */
export const INT10_RAISE = 'INT10_ANSWERING_SERVICE_READ_PATH';
/** `insufficient_privilege` — what a refused read looks like on the wire. */
export const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501';
