/**
 * A refusal to start, as distinct from a crash (PROTOCOL §5.1: "refused", "failed" and "crashed"
 * are three distinguishable outcomes). src/main.ts prints `WORKER REFUSED (<reason>): <message>`
 * and exits REFUSED_EXIT; any other boot failure prints `WORKER BOOT FAILED` and exits 1.
 *
 * The message is the worker's own fixed text with catalogue values, plus, for `database`, the
 * driver's error code and message. It never includes DATABASE_URL.
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
