/**
 * The worker's one log sink (stderr, `[worker] ` prefix), the reader that turns a thrown value into
 * `code=<sqlstate|none> <message>[ queue=<name>]`, and the Nest logger that routes the framework's
 * own lines into the same sink.
 *
 * NO STACK IS EVER LOGGED. Driver and server errors are logged with their code and message as
 * given; the ones T-148 saw name a role, a database or a schema, never a password. Nothing here
 * logs DATABASE_URL.
 */
import type { LoggerService } from '@nestjs/common';

export type WorkerLog = (line: string) => void;

export const log: WorkerLog = (line) => {
  process.stderr.write(`[worker] ${line}\n`);
};

/**
 * pg-boss emits a worker's fetch error as a PLAIN OBJECT spread from the Error
 * (`{ ...error, message, stack, queue, worker }`, dist/manager.js), so `instanceof Error` alone
 * would print `[object Object]` — measured in the image (state/EP-2/T-148.md). This reads the
 * `message` property instead. The stack is never read.
 */
export function describe(thrown: unknown): string {
  const field = (key: string): unknown =>
    typeof thrown === 'object' && thrown !== null && key in thrown
      ? (thrown as Record<string, unknown>)[key]
      : undefined;
  const code = field('code');
  const message = field('message');
  const queue = field('queue');
  return (
    `code=${typeof code === 'string' ? code : 'none'} ` +
    `${typeof message === 'string' ? message : String(thrown)}` +
    (typeof queue === 'string' ? ` queue=${queue}` : '')
  );
}

/**
 * NestJS's own lines. `warn` and `error` reach the sink as `nest <level>: <message>`; the first
 * argument only, so a stack Nest passes as a second argument (its ExceptionHandler does, on a
 * provider that fails to construct) is dropped. `log`/`debug`/`verbose` (the "Starting Nest
 * application…" / "dependencies initialized" lines) are not printed.
 */
export class WorkerNestLogger implements LoggerService {
  readonly #sink: WorkerLog;

  constructor(sink: WorkerLog) {
    this.#sink = sink;
  }

  log(): void {}

  debug(): void {}

  verbose(): void {}

  warn(message: unknown): void {
    this.#sink(`nest warn: ${WorkerNestLogger.text(message)}`);
  }

  error(message: unknown): void {
    this.#sink(`nest error: ${WorkerNestLogger.text(message)}`);
  }

  private static text(message: unknown): string {
    if (message instanceof Error) return message.message;
    return typeof message === 'string' ? message : describe(message);
  }
}
