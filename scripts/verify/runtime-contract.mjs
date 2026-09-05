/**
 * scripts/verify/runtime-contract.mjs <base-url>
 *
 * The behavioural contract of a Kinvara application runtime, printed
 * DETERMINISTICALLY so that two runs can be compared byte for byte.
 *
 * DOCKER.md §5's claim is that the toolbox and the image must agree, and that
 * where they do not, the image is right. This is the command that makes that
 * claim testable: run it against the app started inside the toolbox, run it
 * against the same app running as its container under `--verify`, and diff.
 *
 * WHAT IS COMPARED, AND WHAT DELIBERATELY IS NOT.
 * Compared: the app identity, the runtime mode, the Node version, and the
 * behaviour of every route. Those are the contract.
 * NOT compared, and printed separately under `env:` for a human: pid and uid.
 * They genuinely differ — the toolbox runs as the invoking user (1000) and the
 * image as its own 10001 — and folding them into the comparison would mean
 * either a diff that can never be empty or a normalisation that hides a real
 * change of user. They are reported so that the difference is visible rather
 * than smoothed away.
 */
const base = process.argv[2];
if (base === undefined) {
  console.error('usage: node scripts/verify/runtime-contract.mjs <base-url>');
  process.exit(2);
}

const get = async (path) => {
  try {
    const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, error: e.cause?.code ?? e.name ?? String(e), json: null };
  }
};

const contract = [];
const env = [];

const health = await get('/healthz');
contract.push(`healthz.status            ${String(health.status)}`);
contract.push(`healthz.app               ${String(health.json?.app)}`);
contract.push(`healthz.mode              ${String(health.json?.mode)}`);
contract.push(`healthz.kind              ${String(health.json?.kind)}`);
contract.push(`healthz.status_field      ${String(health.json?.status)}`);
contract.push(`healthz.draining          ${String(health.json?.draining)}`);
contract.push(`node.version              ${String(health.json?.node)}`);
env.push(`env: pid=${String(health.json?.pid)} uid=${String(health.json?.uid)}`);

const ready = await get('/readyz');
contract.push(`readyz.status             ${String(ready.status)}`);

const unknown = await get('/no-such-route');
contract.push(`unknown-route.status      ${String(unknown.status)}`);
contract.push(`unknown-route.status_field ${String(unknown.json?.status)}`);

const t0 = Date.now();
const slow = await get('/__placeholder/slow?ms=300');
const elapsed = Date.now() - t0;
contract.push(`slow.status               ${String(slow.status)}`);
contract.push(`slow.slept_at_least_300ms ${String(Number(slow.json?.slept_ms) >= 300)}`);
contract.push(`slow.client_waited        ${String(elapsed >= 300)}`);

for (const line of contract) console.log(line);
for (const line of env) console.error(line);

const ok =
  health.status === 200 && ready.status === 200 && unknown.status === 404 && slow.status === 200;
console.log(`CONTRACT ${ok ? 'OK' : 'BROKEN'}`);
process.exit(ok ? 0 : 1);
