/**
 * T-089 against the real database and the CONTAINERISED worker — `scripts/svc up <ticket> db
 * worker --verify --build` on a database `db:migrate up` has brought to `0029`, then
 * `scripts/svc run <ticket> -- pnpm --filter @kinvara/worker test:integration`.
 *
 * Two kinds of case live here:
 *   - DIRECT: this process calls `@kinvara/core-modules/availability` inside its own
 *     `Database.withAppRw` (so as `app_rw`: `SET LOCAL ROLE app_rw`) — the gate's idempotence and
 *     template-change cases, the concurrency case (E.3 U-11), OD-335, U-12, U-9 (a), U-2, U-13.
 *   - THROUGH THE WORKER: a job is sent (pg-boss client below: no `work()`, no timekeeper) and a
 *     job that reaches `completed` was handled by another process — the `worker` container (the
 *     only other process on the project's network, `svc ps` in the evidence).
 *
 * EXPECTED SLOT SETS ARE ANCHORED OUTSIDE THE CODE: Postgres computes them from the same inputs
 * with `generate_series` over local dates and `(date + time) AT TIME ZONE 'Europe/Nicosia'`
 * (`expected()` below), never with the materialiser or `resolveLocal`. The fixtures avoid DST-gap
 * wall times, where the two resolutions are allowed to differ (the materialiser's DST rules are
 * held by the package's unit cases with host-`date` literals).
 *
 * Every sitter is fresh per case (ids from `newAvailabilityId`), so the worker's own handling of
 * an enqueued job never races another case's assertions.
 */
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import {
  addException,
  localToday,
  materialiseSitter,
  newAvailabilityId,
  readPublicAvailability,
  readTemplate,
  replaceTemplate,
  SLOT_MATERIALISE_NIGHTLY_CRON,
  SLOT_MATERIALISE_NIGHTLY_QUEUE,
  SLOT_MATERIALISE_NIGHTLY_TZ,
  SLOT_MATERIALISE_QUEUE,
  TemplatePreconditionFailedError,
} from '@kinvara/core-modules/availability';
import { JobEnqueuer } from '@kinvara/core-modules/jobs';
import { Database } from '@kinvara/core-modules/runtime';
import type { Ulid } from '@kinvara/domain-types';
import { clientBoss, databaseUrl, superuserPool, waitFor } from './fixtures/db.ts';

let pool: Pool;
let boss: PgBoss;
let db: Database;
let enqueuer: JobEnqueuer;
const created: string[] = [];

beforeAll(async () => {
  pool = superuserPool();
  boss = await clientBoss();
  db = new Database(
    { connectionString: databaseUrl(), application_name: 'kinvara-worker-test', max: 6 },
    () => undefined,
  );
  enqueuer = new JobEnqueuer(boss);
});

afterAll(async () => {
  // This file's sitters go with the run (the availability rows cascade from sitter_profile), so a
  // re-run on the same project does not inherit them — and the nightly case's fan-out stays the
  // size of one run.
  await pool.query(`DELETE FROM public.sitter_profile WHERE id = ANY($1::char(26)[])`, [created]);
  await pool.query(`DELETE FROM public.account WHERE id = ANY($1::char(26)[])`, [created]);
  await pool.query(`DELETE FROM public.cluster WHERE name = 't089'`);
  await boss.stop({ graceful: false, close: true });
  await db.onApplicationShutdown();
  await pool.end();
});

type Pair = [string, string];

/** A sitter profile (superuser: `bookable_state` is derived and `app_rw` cannot write it). */
async function sitter(
  opts: { bookable?: boolean; lonLat?: [number, number]; radiusM?: number } = {},
): Promise<Ulid> {
  const id = newAvailabilityId();
  created.push(id);
  await pool.query(
    `INSERT INTO public.account (id, pseudonym, tos_version) VALUES ($1, $2, 'test')`,
    [id, newAvailabilityId()],
  );
  await pool.query(
    `INSERT INTO public.sitter_profile (id, bookable_state, base_location, travel_radius_m)
     VALUES ($1, $2::public.bookable_state,
             CASE WHEN $3::float8 IS NULL THEN NULL
                  ELSE ST_SetSRID(ST_MakePoint($3::float8, $4::float8), 4326)::geography END,
             $5)`,
    [
      id,
      opts.bookable === false ? 'onboarding' : 'bookable',
      opts.lonLat?.[0] ?? null,
      opts.lonLat?.[1] ?? null,
      opts.radiusM ?? 5000,
    ],
  );
  return id;
}

/** Template rows written directly (as app_rw would; the PUT path has its own cases). */
async function templateRows(
  id: Ulid,
  rows: { weekday: number; start: string; end: string }[],
): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO public.availability_template (id, sitter_id, weekday, start_local, end_local, effective_from)
       VALUES ($1, $2, $3, $4::time, $5::time, (now() AT TIME ZONE 'Europe/Nicosia')::date - 7)`,
      [newAvailabilityId(), id, r.weekday, r.start, r.end],
    );
  }
}

async function slots(id: Ulid): Promise<{ pairs: Pair[]; clusters: number[][]; ids: string[] }> {
  const rows = (
    await pool.query<{ s: Date; e: Date; c: number[]; id: string }>(
      `SELECT lower(span) AS s, upper(span) AS e, cluster_ids AS c, id::text AS id
         FROM public.availability_slot WHERE sitter_id = $1 ORDER BY lower(span)`,
      [id],
    )
  ).rows;
  return {
    pairs: rows.map((r) => [r.s.toISOString(), r.e.toISOString()]),
    clusters: rows.map((r) => r.c),
    ids: rows.map((r) => r.id),
  };
}

/**
 * THE EXTERNAL ANCHOR. Weekly blocks (ISO weekday 1 = Monday) over the 56 local dates from local
 * today, minus whole local dates in `skip`, resolved by Postgres's own `AT TIME ZONE`.
 */
async function expected(
  blocks: { isodow: number; start: string; end: string }[],
  skip: string[] = [],
): Promise<Pair[]> {
  const rows = (
    await pool.query<{ s: Date; e: Date }>(
      `WITH today AS (SELECT (now() AT TIME ZONE 'Europe/Nicosia')::date AS d),
            b AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(isodow int, start text, "end" text))
       SELECT (g::date + b.start::time) AT TIME ZONE 'Europe/Nicosia' AS s,
              (g::date + b."end"::time) AT TIME ZONE 'Europe/Nicosia' AS e
         FROM today, generate_series(today.d, today.d + 55, interval '1 day') g
         JOIN b ON b.isodow = extract(isodow FROM g)::int
        WHERE NOT (g::date = ANY ($2::date[]))
        ORDER BY 1`,
      [JSON.stringify(blocks), skip],
    )
  ).rows;
  return rows.map((r) => [r.s.toISOString(), r.e.toISOString()]);
}

/** A local date `offset` days after local today whose ISO weekday is `isodow` (first such). */
async function localDate(isodow: number, offset: number): Promise<string> {
  const row = (
    await pool.query<{ d: string }>(
      `SELECT g::date::text AS d
         FROM generate_series((now() AT TIME ZONE 'Europe/Nicosia')::date + $2::int,
                              (now() AT TIME ZONE 'Europe/Nicosia')::date + $2::int + 6, interval '1 day') g
        WHERE extract(isodow FROM g)::int = $1 LIMIT 1`,
      [isodow, offset],
    )
  ).rows[0];
  assert.ok(row !== undefined);
  return row.d;
}

async function at(date: string, time: string): Promise<string> {
  const row = (
    await pool.query<{ t: Date }>(
      `SELECT ($1::date + $2::time) AT TIME ZONE 'Europe/Nicosia' AS t`,
      [date, time],
    )
  ).rows[0];
  assert.ok(row !== undefined);
  return row.t.toISOString();
}

async function completedJob(
  queue: string,
  where: string,
  params: unknown[],
  after: Date,
): Promise<{ id: string; output: unknown; createdOn: Date }> {
  return waitFor(`a completed ${queue} job`, 60_000, async () => {
    const row = (
      await pool.query<{ id: string; state: string; output: unknown; created_on: Date }>(
        `SELECT id::text, state::text, output, created_on FROM pgboss.job
          WHERE name = $1 AND created_on >= $2 AND ${where}
          ORDER BY created_on DESC LIMIT 1`,
        [queue, after, ...params],
      )
    ).rows[0];
    if (row === undefined) return undefined;
    if (row.state === 'failed')
      throw new Error(`${queue} job ${row.id} failed: ${JSON.stringify(row.output)}`);
    return row.state === 'completed'
      ? { id: row.id, output: row.output, createdOn: row.created_on }
      : undefined;
  });
}

/** A refusal as `<SQLSTATE> <constraint>` read from the driver error drizzle wraps in `cause`. */
function sqlState(reason: unknown): string {
  const cause: unknown =
    typeof reason === 'object' && reason !== null && 'cause' in reason ? reason.cause : reason;
  const field = (k: string): string =>
    typeof cause === 'object' && cause !== null && k in cause
      ? String((cause as Record<string, unknown>)[k])
      : '?';
  return `${field('code')} ${field('constraint')}`;
}

const MON_WED_FRI = [
  { weekday: 0, start: '16:00', end: '20:00' },
  { weekday: 2, start: '16:00', end: '20:00' },
  { weekday: 4, start: '16:00', end: '20:00' },
];
const ISO_MON_WED_FRI = [
  { isodow: 1, start: '16:00', end: '20:00' },
  { isodow: 3, start: '16:00', end: '20:00' },
  { isodow: 5, start: '16:00', end: '20:00' },
];

test(
  'T-089 gate (a) materialisation is idempotent: two runs with unchanged inputs write the same slot set, equal to the externally computed set',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    await templateRows(id, MON_WED_FRI);
    const removed = await localDate(3, 8);
    await pool.query(
      `INSERT INTO public.availability_exception (id, sitter_id, on_date, kind) VALUES ($1, $2, $3::date, 'REMOVE')`,
      [newAvailabilityId(), id, removed],
    );
    const want = await expected(ISO_MON_WED_FRI, [removed]);
    assert.ok(want.length >= 20, `the expected set is non-trivial (${String(want.length)})`);

    await db.withAppRw((tx) => materialiseSitter(tx, id));
    const first = await slots(id);
    const genFirst = (
      await pool.query<{ g: Date }>(
        `SELECT max(generated_at) AS g FROM public.availability_slot WHERE sitter_id = $1`,
        [id],
      )
    ).rows[0]?.g;
    await db.withAppRw((tx) => materialiseSitter(tx, id));
    const second = await slots(id);
    const genSecond = (
      await pool.query<{ g: Date }>(
        `SELECT min(generated_at) AS g FROM public.availability_slot WHERE sitter_id = $1`,
        [id],
      )
    ).rows[0]?.g;

    assert.deepEqual(first.pairs, want, 'run 1 = the expected set (count and every span)');
    assert.deepEqual(second.pairs, first.pairs, 'run 2 = run 1');
    assert.deepEqual(second.clusters, first.clusters);
    assert.ok(
      genFirst !== undefined && genSecond !== undefined && genSecond >= genFirst,
      'generated_at does not go back',
    );
    assert.equal(
      new Set([...first.ids, ...second.ids]).size,
      first.ids.length * 2,
      'every row of run 2 is a fresh ULID (E.3 U-1)',
    );
  },
);

test(
  'T-089 gate (b) a template change re-materialises without duplicating: Wed 16-20 -> 18-22 via E.3 U-2 replacement, then three runs give exactly the new set',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    await templateRows(id, MON_WED_FRI);
    await db.withAppRw((tx) => materialiseSitter(tx, id));
    assert.deepEqual((await slots(id)).pairs, await expected(ISO_MON_WED_FRI));

    const today = localToday(new Date());
    await db.withAppRw(async (tx) => {
      const current = await readTemplate(tx, id);
      return replaceTemplate(tx, enqueuer, {
        sitterId: id,
        ifMatch: current.etag,
        body: {
          effectiveFrom: today,
          tz: 'Europe/Nicosia',
          blocks: [
            { weekday: 0, startLocal: '16:00', endLocal: '20:00' },
            { weekday: 2, startLocal: '18:00', endLocal: '22:00' },
            { weekday: 4, startLocal: '16:00', endLocal: '20:00' },
          ],
        },
      });
    });
    // Contract §3 / E.3 U-2 (5), on any weekday the suite runs (rework 1, QA Q-3): the three old
    // rows are retired to the day BEFORE effectiveFrom (= local today, read by Postgres here, not
    // by the code) with version 2; the three new rows begin on it with version 1. A retire to
    // effectiveFrom itself would leave old and new both live today.
    const rowsAfter = (
      await pool.query<{ retired: number; fresh: number; n: number }>(
        `WITH t AS (SELECT (now() AT TIME ZONE 'Europe/Nicosia')::date AS d)
         SELECT count(*) FILTER (WHERE effective_from < t.d AND effective_to = t.d - 1 AND version = 2)::int AS retired,
                count(*) FILTER (WHERE effective_from = t.d AND effective_to IS NULL AND version = 1)::int AS fresh,
                count(*)::int AS n
           FROM public.availability_template, t WHERE sitter_id = $1`,
        [id],
      )
    ).rows[0];
    assert.deepEqual(
      rowsAfter,
      { retired: 3, fresh: 3, n: 6 },
      'retired rows end the day before effectiveFrom (effective_to = effectiveFrom - 1, version + 1)',
    );
    const want = await expected([
      { isodow: 1, start: '16:00', end: '20:00' },
      { isodow: 3, start: '18:00', end: '22:00' },
      { isodow: 5, start: '16:00', end: '20:00' },
    ]);
    for (let run = 1; run <= 3; run++) {
      await db.withAppRw((tx) => materialiseSitter(tx, id));
      const got = await slots(id);
      assert.deepEqual(
        got.pairs,
        want,
        `run ${String(run)}: exactly the new set, ${String(want.length)} slots`,
      );
    }
    const oldWed = await expected([{ isodow: 3, start: '16:00', end: '20:00' }]);
    const got = (await slots(id)).pairs.map((p) => p.join(' '));
    assert.ok(
      oldWed.every((p) => !got.includes(p.join(' '))),
      'no slot of the old Wednesday block survives',
    );
  },
);

test(
  'the template change THROUGH THE CONTAINERISED WORKER: the replacement enqueues search.slot_materialise in its transaction and the worker writes exactly the new set',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    const before = new Date(Date.now() - 1000);
    const today = localToday(new Date());
    await db.withAppRw(async (tx) =>
      replaceTemplate(tx, enqueuer, {
        sitterId: id,
        ifMatch: (await readTemplate(tx, id)).etag,
        body: {
          effectiveFrom: today,
          tz: 'Europe/Nicosia',
          blocks: [{ weekday: 1, startLocal: '10:00', endLocal: '13:00' }],
        },
      }),
    );
    const done = await completedJob(SLOT_MATERIALISE_QUEUE, `data->>'sitterId' = $3`, [id], before);
    const out = done.output as { written: number; bookable: boolean };
    assert.equal(out.bookable, true);
    const want = await expected([{ isodow: 2, start: '10:00', end: '13:00' }]);
    assert.equal(out.written, want.length, "the worker's own count");
    assert.deepEqual((await slots(id)).pairs, want);
    const proc = (
      await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'kinvara-worker' AND client_addr IS DISTINCT FROM inet_client_addr()`,
      )
    ).rows[0];
    assert.ok((proc?.n ?? 0) >= 1, 'the worker container holds sessions from another address');
  },
);

test(
  'E.3 U-11: two concurrent materialisations of one sitter both commit and the final set equals one run (x10)',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    await templateRows(id, MON_WED_FRI);
    const want = await expected(ISO_MON_WED_FRI);
    for (let i = 0; i < 10; i++) {
      const results = await Promise.allSettled([
        db.withAppRw((tx) => materialiseSitter(tx, id)),
        db.withAppRw((tx) => materialiseSitter(tx, id)),
      ]);
      const refused = results
        .filter((r) => r.status === 'rejected')
        .map((r) => sqlState((r as PromiseRejectedResult).reason));
      assert.deepEqual(refused, [], `round ${String(i)}: both committed`);
      assert.deepEqual((await slots(id)).pairs, want, `round ${String(i)}: one run's set`);
    }
  },
);

test(
  'OD-335 in the database: whole-day REMOVE then ADD 09:00-17:00 gives a 09:00-17:00 slot; the reverse order gives none; two in ONE transaction order by id',
  { timeout: 90_000 },
  async () => {
    const date = await localDate(4, 10); // a Thursday
    const block = [{ weekday: 3, start: '08:00', end: '20:00' }];
    const wantSlot: Pair = [await at(date, '09:00'), await at(date, '17:00')];
    const lo = await at(date, '00:00');
    const hi = await at(date, '23:59');
    const onDate = (pairs: Pair[]) => pairs.filter(([s, e]) => s < hi && e > lo);

    const a = await sitter();
    await templateRows(a, block);
    await db.withAppRw((tx) =>
      addException(tx, enqueuer, a, {
        date,
        kind: 'REMOVE',
        startLocal: null,
        endLocal: null,
        tz: 'Europe/Nicosia',
      }),
    );
    await db.withAppRw((tx) =>
      addException(tx, enqueuer, a, {
        date,
        kind: 'ADD',
        startLocal: '09:00',
        endLocal: '17:00',
        tz: 'Europe/Nicosia',
      }),
    );
    await db.withAppRw((tx) => materialiseSitter(tx, a));
    assert.deepEqual(onDate((await slots(a)).pairs), [wantSlot], 'REMOVE then ADD');

    const b = await sitter();
    await templateRows(b, block);
    await db.withAppRw((tx) =>
      addException(tx, enqueuer, b, {
        date,
        kind: 'ADD',
        startLocal: '09:00',
        endLocal: '17:00',
        tz: 'Europe/Nicosia',
      }),
    );
    await db.withAppRw((tx) =>
      addException(tx, enqueuer, b, {
        date,
        kind: 'REMOVE',
        startLocal: null,
        endLocal: null,
        tz: 'Europe/Nicosia',
      }),
    );
    await db.withAppRw((tx) => materialiseSitter(tx, b));
    assert.deepEqual(onDate((await slots(b)).pairs), [], 'ADD then REMOVE');

    const c = await sitter();
    await templateRows(c, block);
    await db.withAppRw(async (tx) => {
      await addException(tx, enqueuer, c, {
        date,
        kind: 'REMOVE',
        startLocal: null,
        endLocal: null,
        tz: 'Europe/Nicosia',
      });
      await addException(tx, enqueuer, c, {
        date,
        kind: 'ADD',
        startLocal: '09:00',
        endLocal: '17:00',
        tz: 'Europe/Nicosia',
      });
    });
    const rows = (
      await pool.query<{ kind: string; same: boolean }>(
        `SELECT kind, count(*) OVER (PARTITION BY created_at) = 2 AS same FROM public.availability_exception WHERE sitter_id = $1 ORDER BY id`,
        [c],
      )
    ).rows;
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['REMOVE', 'ADD'],
      'id order is write order',
    );
    assert.ok(
      rows.every((r) => r.same),
      'both share created_at (one transaction): id alone orders them',
    );
    await db.withAppRw((tx) => materialiseSitter(tx, c));
    assert.deepEqual(
      onDate((await slots(c)).pairs),
      [wantSlot],
      'one transaction, REMOVE then ADD',
    );
  },
);

test(
  'OD-335 in the database, the created_at key: an exception written in a LATER transaction under a SMALLER id applies after the earlier one (and the mirror)',
  { timeout: 90_000 },
  async () => {
    // ids are monotonic within one process only (`ids.ts`); two `core` tasks can write a later
    // row under a smaller id. The rows go in by explicit id, one autocommit statement (one
    // transaction, one `now()`) each, `created_at` left to the column default.
    const date = await localDate(4, 10); // a Thursday
    const block = [{ weekday: 3, start: '08:00', end: '20:00' }];
    const wantSlot: Pair = [await at(date, '09:00'), await at(date, '17:00')];
    const lo = await at(date, '00:00');
    const hi = await at(date, '23:59');
    const onDate = (pairs: Pair[]) => pairs.filter(([s, e]) => s < hi && e > lo);
    const insert = (
      id: string,
      sitterId: Ulid,
      kind: 'ADD' | 'REMOVE',
      start: string | null,
      end: string | null,
    ) =>
      pool.query(
        `INSERT INTO public.availability_exception (id, sitter_id, on_date, kind, start_local, end_local, tz)
         VALUES ($1, $2, $3::date, $4, $5::time, $6::time, 'Europe/Nicosia')`,
        [id, sitterId, date, kind, start, end],
      );
    const order = async (sitterId: Ulid) =>
      (
        await pool.query<{ kind: string; later_created: boolean; smaller_id: boolean }>(
          `SELECT kind,
                  created_at > min(created_at) OVER () AS later_created,
                  id < max(id) OVER () AS smaller_id
             FROM public.availability_exception WHERE sitter_id = $1 ORDER BY created_at`,
          [sitterId],
        )
      ).rows;

    const d = await sitter();
    await templateRows(d, block);
    const dSmall = newAvailabilityId();
    const dBig = newAvailabilityId();
    await insert(dBig, d, 'REMOVE', null, null);
    await insert(dSmall, d, 'ADD', '09:00', '17:00');
    assert.deepEqual(
      await order(d),
      [
        { kind: 'REMOVE', later_created: false, smaller_id: false },
        { kind: 'ADD', later_created: true, smaller_id: true },
      ],
      'the fixture: the REMOVE is earlier by created_at and larger by id',
    );
    await db.withAppRw((tx) => materialiseSitter(tx, d));
    assert.deepEqual(
      onDate((await slots(d)).pairs),
      [wantSlot],
      'created_at first: REMOVE then ADD gives 09:00-17:00 (id order alone would give none)',
    );

    const e = await sitter();
    await templateRows(e, block);
    const eSmall = newAvailabilityId();
    const eBig = newAvailabilityId();
    await insert(eBig, e, 'ADD', '09:00', '17:00');
    await insert(eSmall, e, 'REMOVE', null, null);
    assert.deepEqual(
      await order(e),
      [
        { kind: 'ADD', later_created: false, smaller_id: false },
        { kind: 'REMOVE', later_created: true, smaller_id: true },
      ],
      'the fixture: the ADD is earlier by created_at and larger by id',
    );
    await db.withAppRw((tx) => materialiseSitter(tx, e));
    assert.deepEqual(
      onDate((await slots(e)).pairs),
      [],
      'created_at first: ADD then REMOVE gives none (id order alone would give 09:00-17:00)',
    );
  },
);

test(
  'E.3 U-12 (a): a sitter who is not bookable gets zero slots, and an earlier slot set is deleted',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    await templateRows(id, MON_WED_FRI);
    await db.withAppRw((tx) => materialiseSitter(tx, id));
    assert.ok((await slots(id)).pairs.length > 0);
    await pool.query(
      `UPDATE public.sitter_profile SET bookable_state = 'review_hold' WHERE id = $1`,
      [id],
    );
    const result = await db.withAppRw((tx) => materialiseSitter(tx, id));
    assert.equal(result.bookable, false);
    assert.deepEqual((await slots(id)).pairs, []);
  },
);

test(
  'U-9 (a): every slot carries the clusters whose centroid is within travel_radius_m of base_location, closed clusters excluded, ascending',
  { timeout: 90_000 },
  async () => {
    const poly = (lon: number, lat: number) =>
      `SRID=4326;POLYGON((${String(lon - 0.01)} ${String(lat - 0.01)},${String(lon + 0.01)} ${String(lat - 0.01)},${String(lon + 0.01)} ${String(lat + 0.01)},${String(lon - 0.01)} ${String(lat + 0.01)},${String(lon - 0.01)} ${String(lat - 0.01)}))`;
    const ins = async (lon: number, lat: number, state: string): Promise<number> => {
      const row = (
        await pool.query<{ id: number }>(
          `INSERT INTO public.cluster (metro, name, boundary, state, name_i18n)
         VALUES ('CY', 't089', $1::geography, $2, '{"en":"t","el":"t","ru":"t"}') RETURNING id`,
          [poly(lon, lat), state],
        )
      ).rows[0];
      assert.ok(row !== undefined);
      return row.id;
    };
    // Base at (33.0000, 35.0000), radius 5000 m. 0.02 deg latitude ≈ 2.2 km (inside); 0.2 deg ≈ 22 km (outside).
    const near = await ins(33.0, 35.02, 'waitlist');
    const near2 = await ins(33.0, 34.98, 'waitlist');
    const far = await ins(33.0, 35.2, 'waitlist');
    const closed = await ins(33.0, 35.01, 'waitlist');
    await pool.query(`UPDATE public.cluster SET state = 'closed' WHERE id = $1`, [closed]);
    const within = (
      await pool.query<{ id: number }>(
        `SELECT id FROM public.cluster
        WHERE id = ANY($1::int[]) AND ST_Distance(ST_Centroid(boundary), ST_SetSRID(ST_MakePoint(33.0, 35.0), 4326)::geography) <= 5000
        ORDER BY id`,
        [[near, near2, far, closed]],
      )
    ).rows.map((r) => r.id);
    assert.deepEqual(
      within,
      [near, near2, closed].sort((x, y) => x - y),
      'the fixture places three centroids in reach and one out (ST_Distance, independent of ST_DWithin)',
    );

    const id = await sitter({ lonLat: [33.0, 35.0], radiusM: 5000 });
    await templateRows(id, MON_WED_FRI);
    await db.withAppRw((tx) => materialiseSitter(tx, id));
    const got = await slots(id);
    assert.ok(got.clusters.length > 0);
    const mine = got.clusters.map((cs) => cs.filter((c) => [near, near2, far, closed].includes(c)));
    for (const cs of mine)
      assert.deepEqual(
        cs,
        [near, near2].sort((x, y) => x - y),
      );

    const nowhere = await sitter();
    await templateRows(nowhere, MON_WED_FRI);
    await db.withAppRw((tx) => materialiseSitter(tx, nowhere));
    assert.ok(
      (await slots(nowhere)).clusters.every((cs) => cs.length === 0),
      "no base_location: '{}' on every slot",
    );
  },
);

test(
  'E.3 U-2: a missing or stale If-Match is refused 412 with the current representation; of two concurrent replacements with one ETag exactly one is refused',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    const today = localToday(new Date());
    const body = {
      effectiveFrom: today,
      tz: 'Europe/Nicosia',
      blocks: [{ weekday: 0, startLocal: '09:00', endLocal: '10:00' }],
    };
    const first = await db.withAppRw(async (tx) =>
      replaceTemplate(tx, enqueuer, {
        sitterId: id,
        ifMatch: (await readTemplate(tx, id)).etag,
        body,
      }),
    );
    await assert.rejects(
      db.withAppRw((tx) =>
        replaceTemplate(tx, enqueuer, { sitterId: id, ifMatch: undefined, body }),
      ),
      (e: unknown) =>
        e instanceof TemplatePreconditionFailedError &&
        e.status === 412 &&
        e.current.etag === first.etag,
    );
    await assert.rejects(
      db.withAppRw((tx) =>
        replaceTemplate(tx, enqueuer, { sitterId: id, ifMatch: '"stale"', body }),
      ),
      (e: unknown) => e instanceof TemplatePreconditionFailedError,
    );
    for (let i = 0; i < 5; i++) {
      const etag = await db.withAppRw(async (tx) => (await readTemplate(tx, id)).etag);
      const both = await Promise.allSettled([
        db.withAppRw((tx) => replaceTemplate(tx, enqueuer, { sitterId: id, ifMatch: etag, body })),
        db.withAppRw((tx) => replaceTemplate(tx, enqueuer, { sitterId: id, ifMatch: etag, body })),
      ]);
      const refused = both.filter((r) => r.status === 'rejected');
      assert.equal(refused.length, 1, `round ${String(i)}: exactly one of the two is refused`);
      assert.ok(
        (refused[0] as PromiseRejectedResult).reason instanceof TemplatePreconditionFailedError,
      );
    }
    await assert.rejects(
      db.withAppRw(async (tx) =>
        replaceTemplate(tx, enqueuer, {
          sitterId: id,
          ifMatch: (await readTemplate(tx, id)).etag,
          body: { ...body, effectiveFrom: '2020-01-01' },
        }),
      ),
      { name: 'InvalidInputError', field: 'effectiveFrom' } as object,
    );
  },
);

test(
  'E.3 U-2 / OD-336: a row voided before it began (effective_to = effective_from - 1, still >= today) is NOT in the current set or its ETag',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    const today = localToday(new Date());
    const later = (await pool.query<{ d: string }>(`SELECT ($1::date + 20)::text AS d`, [today]))
      .rows[0]?.d;
    const sooner = (await pool.query<{ d: string }>(`SELECT ($1::date + 10)::text AS d`, [today]))
      .rows[0]?.d;
    assert.ok(later !== undefined && sooner !== undefined);
    const body = (from: string, start: string) => ({
      effectiveFrom: from,
      tz: 'Europe/Nicosia',
      blocks: [{ weekday: 2, startLocal: start, endLocal: '22:00' }],
    });
    await db.withAppRw(async (tx) =>
      replaceTemplate(tx, enqueuer, {
        sitterId: id,
        ifMatch: (await readTemplate(tx, id)).etag,
        body: body(later, '18:00'),
      }),
    );
    const after = await db.withAppRw(async (tx) =>
      replaceTemplate(tx, enqueuer, {
        sitterId: id,
        ifMatch: (await readTemplate(tx, id)).etag,
        body: body(sooner, '19:00'),
      }),
    );
    const voided = (
      await pool.query<{
        effective_from: string;
        effective_to: string;
        version: number;
        literal: boolean;
      }>(
        `SELECT effective_from::text, effective_to::text, version,
              (effective_to IS NULL OR effective_to >= $2::date) AS literal
         FROM public.availability_template WHERE sitter_id = $1 AND effective_to < effective_from`,
        [id, today],
      )
    ).rows;
    assert.equal(voided.length, 1, 'the later block was voided');
    assert.equal(
      voided[0]?.literal,
      true,
      "U-2 (2)'s predicate alone selects it (the OD-336 measurement)",
    );
    assert.deepEqual(
      after.rows.map((r) => [r.startLocal, r.effectiveFrom]),
      [['19:00', sooner]],
      'the current set holds only the new block',
    );
  },
);

test(
  'U-13: public availability is whole-hour spans, rounded inward, clipped to [from, to)',
  { timeout: 90_000 },
  async () => {
    const id = await sitter();
    const date = await localDate(2, 7);
    const s = await at(date, '09:20');
    const e = await at(date, '12:40');
    await pool.query(
      `INSERT INTO public.availability_slot (id, sitter_id, span, cluster_ids) VALUES ($1, $2, tstzrange($3, $4, '[)'), '{}')`,
      [newAvailabilityId(), id, s, e],
    );
    const got = await db.withAppRw((tx) =>
      readPublicAvailability(
        tx,
        id,
        new Date(Date.parse(s) - 86_400_000),
        new Date(Date.parse(e) + 86_400_000),
      ),
    );
    assert.deepEqual(
      got.map((x) => [x.startsAt.toISOString(), x.endsAt.toISOString()]),
      [[await at(date, '10:00'), await at(date, '12:00')]],
    );
    const clipped = await db.withAppRw((tx) =>
      readPublicAvailability(tx, id, new Date(s), new Date(Date.parse(s) + 2 * 3_600_000)),
    );
    assert.deepEqual(
      clipped.map((x) => [x.startsAt.toISOString(), x.endsAt.toISOString()]),
      [[await at(date, '10:00'), await at(date, '11:00')]],
    );
  },
);

test(
  'C10 (a): the worker registers the nightly schedule, and a nightly job enqueues search.slot_materialise for every sitter profile, handled in the container',
  { timeout: 90_000 },
  async () => {
    const sched = (
      await pool.query<{ cron: string; timezone: string }>(
        `SELECT cron, timezone FROM pgboss.schedule WHERE name = $1`,
        [SLOT_MATERIALISE_NIGHTLY_QUEUE],
      )
    ).rows;
    assert.deepEqual(sched, [
      { cron: SLOT_MATERIALISE_NIGHTLY_CRON, timezone: SLOT_MATERIALISE_NIGHTLY_TZ },
    ]);
    assert.equal(SLOT_MATERIALISE_NIGHTLY_CRON, '15 0 * * *');

    const id = await sitter();
    await templateRows(id, [{ weekday: 6, start: '10:00', end: '12:00' }]);
    const before = new Date(Date.now() - 1000);
    const sent = await boss.send(SLOT_MATERIALISE_NIGHTLY_QUEUE, {});
    assert.ok(typeof sent === 'string');
    const nightly = await completedJob(
      SLOT_MATERIALISE_NIGHTLY_QUEUE,
      `id = $3::uuid`,
      [sent],
      before,
    );
    const profiles = (
      await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.sitter_profile`)
    ).rows[0]?.n;
    assert.equal(
      (nightly.output as { enqueued: number }).enqueued,
      profiles,
      'one job per sitter profile',
    );
    const fanout = (
      await pool.query<{ priority: number }>(
        `SELECT DISTINCT priority FROM pgboss.job WHERE name = $1 AND created_on >= $2 AND data->>'sitterId' IS NOT NULL`,
        [SLOT_MATERIALISE_QUEUE, nightly.createdOn],
      )
    ).rows.map((r) => r.priority);
    assert.ok(fanout.includes(-1), 'the fan-out jobs carry priority -1');
    await completedJob(SLOT_MATERIALISE_QUEUE, `data->>'sitterId' = $3`, [id], before);
    assert.deepEqual(
      (await slots(id)).pairs,
      await expected([{ isodow: 7, start: '10:00', end: '12:00' }]),
    );
  },
);

test(
  'the containerised worker fails a search.slot_materialise job whose payload is refused, writing nothing',
  { timeout: 90_000 },
  async () => {
    const before = new Date(Date.now() - 1000);
    const sent = await boss.send(
      SLOT_MATERIALISE_QUEUE,
      { sitterId: 'not-a-ulid' },
      { retryLimit: 0 },
    );
    assert.ok(typeof sent === 'string');
    const row = await waitFor('the refused job to fail', 60_000, async () => {
      const r = (
        await pool.query<{ state: string; output: { message?: string } }>(
          `SELECT state::text, output FROM pgboss.job WHERE id = $1::uuid AND created_on >= $2`,
          [sent, before],
        )
      ).rows[0];
      return r?.state === 'failed' ? r : undefined;
    });
    assert.match(String(row.output.message), /refused payload/);
  },
);
