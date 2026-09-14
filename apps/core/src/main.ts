/**
 * `pnpm --filter @kinvara/core start` — what the image runs (`node --run start`,
 * chosen by `docker/app-runtime/entrypoint.mjs` because this package declares
 * `start`). Listens on `0.0.0.0:$PORT` (3000 in the image, `core:3000` on
 * `kinvara-int`).
 */
import { AppModule } from './app.module.ts';
import { errorClass } from './problem-json/error-class.ts';
import { startServer } from './server.ts';

const port = Number(process.env['PORT'] ?? '3000');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('[core] PORT is not a TCP port number, exiting 1\n');
  process.exit(1);
}

try {
  await startServer({ module: AppModule, port, host: '0.0.0.0' });
} catch (thrown) {
  process.stderr.write(`[core] boot failed class=${errorClass(thrown)}, exiting 1\n`);
  process.exit(1);
}
