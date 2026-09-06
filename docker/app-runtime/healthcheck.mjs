/**
 * docker/app-runtime/healthcheck.mjs — the HEALTHCHECK of every kinvara/*
 * application image (T-018).
 *
 * It lives in the IMAGE, not in compose, deliberately. A healthcheck declared
 * only in compose.yml is a property of one way of starting the container; a
 * HEALTHCHECK in the Dockerfile travels with the image, so `docker run` and
 * ECS (T-003) get the same one. DOCKER.md §5's whole argument is that the
 * image is what will be deployed.
 *
 * No curl and no wget: the node runtime is already there, and adding a package
 * to a runtime image to ask it a question it can answer itself is weight and
 * CVE surface for nothing.
 */
import fs from 'node:fs';
import http from 'node:http';

/**
 * A SECOND LAYER, NOT THE FIX (T-035).
 *
 * `gate:app-images` now resolves USER the way Docker does — last-wins along
 * the target stage's ancestry — so a root image cannot be committed through
 * either route that was measured (a `USER root` appended to the shipping
 * stage, or a compose `target:` moved to a stage that never sets one). This is
 * the belt to that pair of braces, and it exists because of what QA measured
 * on T-034: the `USER root` image came up `healthy`, reporting `"uid":0` about
 * itself in its own /healthz payload. The uid was in the output and nothing
 * compared it to anything, so a root container announced its own defect and
 * was marked healthy for it.
 *
 * WHAT THIS DOES NOT CATCH, said plainly because tech-lead measured it before
 * asking for it: the compose `target:` route produces an image with NO
 * HEALTHCHECK AT ALL (`Healthcheck=null`, `docker-entrypoint.sh` at PID 1),
 * so this file is never executed there. A refusal cannot fire in an image that
 * never runs it. That route is closed by the gate, above, and by nothing here.
 * The same is true of any image whose HEALTHCHECK is `NONE` or removed.
 *
 * `process.getuid` is undefined on Windows; the images are Alpine, but a
 * healthcheck that threw a TypeError would be indistinguishable from a
 * genuinely unhealthy container, so it is checked rather than assumed.
 */
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error(
    'refusing to report healthy: this container runs as uid 0 (root). The image is ' +
      "built non-root (USER 10001:10001 in docker/app.Dockerfile's runtime stage), so " +
      'root here means the stage that shipped is not the one that was checked — a USER ' +
      'later in the ancestry, or a compose build.target pointing at a stage that sets ' +
      "none. Run: docker image inspect <image> --format '{{.Config.User}}'",
  );
  process.exit(1);
}

const KIND = process.env.KINVARA_APP_KIND ?? 'http';
const PORT = Number(process.env.PORT ?? '3000');
const HEARTBEAT = process.env.KINVARA_HEARTBEAT ?? '/tmp/kinvara-heartbeat';
const MAX_AGE_MS = Number(process.env.KINVARA_HEARTBEAT_MAX_AGE_MS ?? '15000');

if (KIND === 'worker') {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
  } catch (e) {
    console.error(`no heartbeat at ${HEARTBEAT}: ${e.code ?? e.message}`);
    process.exit(1);
  }
  const age = Date.now() - Number(raw.at ?? 0);
  if (!Number.isFinite(age) || age > MAX_AGE_MS) {
    console.error(`heartbeat is ${String(age)}ms old (max ${String(MAX_AGE_MS)})`);
    process.exit(1);
  }
  console.log(`heartbeat ${String(age)}ms old`);
  process.exit(0);
}

const req = http.request(
  { host: '127.0.0.1', port: PORT, path: '/healthz', method: 'GET', timeout: 3000 },
  (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      console.log(`${String(res.statusCode)} ${body.slice(0, 200)}`);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);
req.on('timeout', () => {
  req.destroy();
  console.error('healthz timed out');
  process.exit(1);
});
req.on('error', (e) => {
  console.error(`healthz: ${e.code ?? e.message}`);
  process.exit(1);
});
req.end();
