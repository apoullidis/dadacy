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
req.on('timeout', () => { req.destroy(); console.error('healthz timed out'); process.exit(1); });
req.on('error', (e) => { console.error(`healthz: ${e.code ?? e.message}`); process.exit(1); });
req.end();
