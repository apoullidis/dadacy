/**
 * The client half of `apps/worker/tools/drain-check.sh` — T-148 acceptance (d): SIGTERM with a
 * job in flight → the job completes and the worker exits 0 inside its grace.
 *
 * WHY NOT scripts/verify/sigterm-drain.sh ALONE. That verifier's in-flight unit is an HTTP request
 * to `<service>:<port>` (T-151 § contract §4); the worker has no port (compose.verify.yml: "A
 * worker has no port"), so against `worker` it can only REFUSE (exit 2, no signal sent). This
 * script keeps its shape — the probe on the project's network, the signal from the host, marker
 * files in between, the host judging exit code and time — with a JOB as the in-flight unit:
 *
 *   A  the job in flight when SIGTERM was sent COMPLETED: state `completed`, `completed_on` after
 *      the host's signal timestamp, and its handler's `done` notification received;
 *   B  a job sent AFTER the signal was never fetched — still `created`, no handler `start` —
 *      once the container has exited (the worker stopped taking work, it did not merely finish).
 * C and D (exited 0; well inside stop_grace_period) are judged by the host, as in sigterm-drain.sh.
 *
 * Runs under `scripts/svc run <ticket> --`, so it reaches `postgres:5432` and has no Docker socket.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { SELFTEST_QUEUE } from '../src/selftest.ts';
import { clientBoss, job, listen, superuserPool, waitFor } from '../test/fixtures/db.ts';

const DIR = process.env['KINVARA_DRAIN_DIR'] ?? '.cache/worker-drain';
const HOLD_MS = 6_000;
mkdirSync(DIR, { recursive: true });

const pool = superuserPool();
const listener = await listen(pool);
const boss = await clientBoss();
const tag = `drain.${Date.now().toString(36)}`;

const inflightId = await boss.send(SELFTEST_QUEUE, { op: 'hold', tag, holdMs: HOLD_MS });
if (inflightId === null) throw new Error('send returned no id');
await waitFor('the hold job to start in the worker', 20_000, async () =>
  listener.notes.some((n) => n.id === inflightId && n.phase === 'start') ? true : undefined,
);
writeFileSync(`${DIR}/inflight`, inflightId);
console.log(
  `in-flight job         ${inflightId} (op=hold, holdMs=${String(HOLD_MS)}) started in the worker`,
);

await waitFor('the host to send SIGTERM', 30_000, async () =>
  existsSync(`${DIR}/sigterm-sent`) ? true : undefined,
);
// The host writes `date +%s.%N` the moment after `docker kill -s TERM`; one kernel clock.
const signalSentAt = Number(readFileSync(`${DIR}/sigterm-sent`, 'utf8').trim()) * 1000;
await sleep(1_000);
const afterId = await boss.send(SELFTEST_QUEUE, { op: 'echo', tag: `${tag}.after` });
if (afterId === null) throw new Error('send returned no id');
console.log(`job sent after SIGTERM ${afterId} (op=echo)`);

await waitFor('the host to see the container exit', 45_000, async () =>
  existsSync(`${DIR}/exited`) ? true : undefined,
);
const held = await job(pool, inflightId);
const after = await job(pool, afterId);
const heldDone = listener.notes.find((n) => n.id === inflightId && n.phase === 'done');
const afterNotes = listener.notes.filter((n) => n.id === afterId);
await boss.stop({ graceful: false, close: true });
await listener.close();
await pool.end();

const okA =
  held?.state === 'completed' &&
  heldDone !== undefined &&
  held.completed_on !== null &&
  Number.isFinite(signalSentAt) &&
  held.completed_on.getTime() > signalSentAt;
const okB = after?.state === 'created' && afterNotes.length === 0;
console.log(
  `\nA the in-flight job completed across SIGTERM                 ${okA ? 'PASS' : 'FAIL'}  ` +
    `(state=${String(held?.state)} completed_on=${String(held?.completed_on?.toISOString())} ` +
    `sigterm_sent=${Number.isFinite(signalSentAt) ? new Date(signalSentAt).toISOString() : 'unparsed'} ` +
    `done_note=${String(heldDone !== undefined)} host=${String(heldDone?.host)})`,
);
console.log(
  `B a job sent after SIGTERM was never fetched                 ${okB ? 'PASS' : 'FAIL'}  ` +
    `(state=${String(after?.state)} handler_notes=${String(afterNotes.length)})`,
);
process.exit(okA && okB ? 0 : 1);
