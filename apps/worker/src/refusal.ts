/**
 * A refusal to start, as distinct from a crash (PROTOCOL §5.1: "refused", "failed" and "crashed"
 * are three distinguishable outcomes). src/main.ts prints `WORKER REFUSED (<reason>): <message>`
 * and exits REFUSED_EXIT; any other boot failure prints `WORKER BOOT FAILED` and exits 1.
 *
 * The message is written here, by the worker, from fixed text and catalogue values. It never
 * carries the connection string.
 */
export type RefusalReason =
  'config' | 'database' | 'principal' | 'schema-missing' | 'privilege' | 'schema-version';

export const REFUSED_EXIT = 2;

export class WorkerRefusal extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.name = 'WorkerRefusal';
    this.reason = reason;
  }
}
