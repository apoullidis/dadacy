/**
 * Run the span canary against `apps/core` booted IN THE TOOLBOX — T-008.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT. The supported evidence form for an HTTP
 * endpoint is `svc up <t> api --verify --build` and a request against the
 * CONTAINERISED `core` (DOCKER.md §5). **That is not available on `main`
 * `fdbad99`: the `core` image does not build**, at `[core prod-deps 7/7]`,
 * because `packages/i18n` declares `@formatjs/icu-messageformat-parser` as a
 * devDependency while `intl-messageformat` pulls it in at run time —
 * `decisions.md` OD-186, reproduced at `main` on a clean worktree, and
 * `T-154`'s QR-A3 / OD-123 gone live now that `apps/core` reaches
 * `@kinvara/i18n` through `@kinvara/contracts`.
 *
 * So this boots the REAL `apps/core` — `src/main.ts`, the real Fastify hooks,
 * the real exporter — inside the toolbox, ON THE TICKET'S `kinvara-int`
 * NETWORK, so that the collector and Jaeger are the real containers reached by
 * compose service name. The wire between the app and the collector is real;
 * the wire between a client and the app is loopback inside one container.
 *
 * WHAT THIS FORM DOES NOT PROVE, and DOCKER.md §5 names each one: signal
 * handling on shutdown, DNS between application containers, file paths inside
 * the image, env resolution in the image, non-root permissions, and
 * `NODE_ENV`. It is `T-135`'s precedent for its own (ii)/(iii) refusals —
 * "they ran against a real process on 127.0.0.1 inside the toolbox, using the
 * same `src/` code" — and it carries the same bound.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = process.env['KINVARA_CANARY_PORT'] ?? '3000';
const BASE = `http://127.0.0.1:${PORT}`;

const app = spawn(process.execPath, ['apps/core/src/main.ts'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    PORT,
    OTEL_SERVICE_NAME: process.env['OTEL_SERVICE_NAME_CORE'] ?? 'kinvara-core',
  },
});

let appExited = false;
app.on('exit', (code, signal) => {
  appExited = true;
  process.stderr.write(`[canary-run] core exited code=${String(code)} signal=${String(signal)}\n`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ready = async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (appExited) return false;
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
};

const up = await ready();
if (!up) {
  process.stderr.write(`[canary-run] HARNESS ERROR: core never answered ${BASE}/healthz\n`);
  app.kill('SIGKILL');
  process.exit(2);
}
process.stderr.write(`[canary-run] core is answering on ${BASE}; running the canary\n`);

const canary = spawn(process.execPath, ['packages/observability/tools/canary.ts'], {
  stdio: 'inherit',
  env: { ...process.env, CORE_BASE_URL: BASE },
});

const code = await new Promise((resolve) => {
  canary.on('exit', (c) => resolve(c ?? 1));
});

app.kill('SIGTERM');
await sleep(1500);
if (!appExited) app.kill('SIGKILL');
process.exit(code);
