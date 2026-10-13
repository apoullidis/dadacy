/**
 * THE MATERIALISER'S TRANSACTION (`T-089.md` Q6, as `T-163` § Published contract — LIVE §2 and §7
 * bind it). One call, inside the caller's `Database.withAppRw`, recomputes ONE sitter's slots:
 *
 *   1. E.3 U-11's lock (`lock.ts`);
 *   2. read the profile (`bookable_state`, `base_location`, `travel_radius_m`), the template rows,
 *      the exception rows, and the cluster set — never `booking` (role row T-089, OD-136);
 *   3. compute the free set (`materialise.ts`);
 *   4. `DELETE FROM public.availability_slot WHERE sitter_id = $1` — the whole sitter, BEFORE the
 *      insert (T-163 §2: without it an overlapping replacement is refused `23P01`);
 *   5. one `INSERT … SELECT … unnest(…)` with a fresh ULID per row (E.3 U-1), and NO `ON
 *      CONFLICT` (T-163 §2: `DO NOTHING` would silently skip an overlapping slot).
 *
 * WHY IT IS IDEMPOTENT (SD 2268 "idempotent recompute of the whole window per sitter, never an
 * incremental patch"; SD 1411): the slot set is a function of the rows read in step 2 and of local
 * today. Step 4 removes every slot of the sitter, so a second run with the same inputs writes the
 * same spans, and a changed template writes the new set in place of the old — there is nothing to
 * apply twice. Held against the database by the worker suite (*idempotent* and *template change*
 * cases), and red-first: with step 4 deleted the template-change case raises `23P01`.
 *
 * THE CLUSTER SET (OE-32 U-9 (a), Part F): the ids of clusters whose centroid lies within
 * `travel_radius_m` of `base_location`, `ST_DWithin` on `geography` (metres), excluding clusters
 * whose `state` is `'closed'` (`T-160` U-7, Part F: closed means retired, never matched or listed).
 * Ascending id. A sitter with no `base_location`, or no cluster in reach, gets `'{}'`, which is
 * legal (U-9 (a); `0029` accepts it). Every slot of a sitter carries the same set.
 */
import { sql } from 'drizzle-orm';
import type { Ulid } from '@kinvara/domain-types';
import type { Tx } from '../runtime/index.ts';
import { addDays } from './civil.ts';
import { newAvailabilityId } from './ids.ts';
import { lockSitterAvailability } from './lock.ts';
import {
  HORIZON_DAYS,
  HORIZON_ZONE,
  materialise,
  type ExceptionRow,
  type Span,
  type TemplateRow,
} from './materialise.ts';
import { instantToLocal } from '@kinvara/domain-types';

export interface MaterialiseOptions {
  /** The clock; injectable so a test can pin local today. */
  readonly now?: Date;
  /** The slot id generator (E.3 U-1); injectable for tests only. */
  readonly newId?: () => string;
}

export interface MaterialiseResult {
  readonly sitterFound: boolean;
  readonly bookable: boolean;
  readonly today: string;
  readonly clusterIds: readonly number[];
  readonly deleted: number;
  readonly spans: readonly Span[];
}

interface ProfileRow extends Record<string, unknown> {
  readonly bookable_state: string;
}
interface TemplateDbRow extends Record<string, unknown> {
  readonly weekday: number;
  readonly start_local: string;
  readonly end_local: string;
  readonly tz: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
}
interface ExceptionDbRow extends Record<string, unknown> {
  readonly id: string;
  readonly on_date: string;
  readonly kind: 'ADD' | 'REMOVE';
  readonly start_local: string | null;
  readonly end_local: string | null;
  readonly tz: string;
  readonly created_at: Date | string;
}
interface ClusterRow extends Record<string, unknown> {
  readonly id: number;
}

/** Local today in `HORIZON_ZONE` for `now`. */
export function localToday(now: Date): string {
  return instantToLocal(now, HORIZON_ZONE).date;
}

export async function materialiseSitter(
  tx: Tx,
  sitterId: Ulid,
  options: MaterialiseOptions = {},
): Promise<MaterialiseResult> {
  await lockSitterAvailability(tx, sitterId);
  const today = localToday(options.now ?? new Date());
  // One extra date either side: a row in another zone can reach into the horizon (materialise.ts).
  const firstDate = addDays(today, -1);
  const lastDate = addDays(today, HORIZON_DAYS);

  const profile = (
    await tx.execute<ProfileRow>(
      sql`SELECT bookable_state::text AS bookable_state
            FROM public.sitter_profile WHERE id = ${sitterId}`,
    )
  ).rows[0];

  const templates: TemplateRow[] = (
    await tx.execute<TemplateDbRow>(
      sql`SELECT weekday, start_local::text AS start_local, end_local::text AS end_local, tz,
                 effective_from::text AS effective_from, effective_to::text AS effective_to
            FROM public.availability_template
           WHERE sitter_id = ${sitterId}
             AND effective_from <= ${lastDate}::date
             AND (effective_to IS NULL OR effective_to >= ${firstDate}::date)`,
    )
  ).rows.map((r) => ({
    weekday: Number(r.weekday),
    startLocal: r.start_local,
    endLocal: r.end_local,
    tz: r.tz,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  }));

  const exceptions: ExceptionRow[] = (
    await tx.execute<ExceptionDbRow>(
      sql`SELECT id::text AS id, on_date::text AS on_date, kind, start_local::text AS start_local,
                 end_local::text AS end_local, tz, created_at
            FROM public.availability_exception
           WHERE sitter_id = ${sitterId}
             AND on_date BETWEEN ${firstDate}::date AND ${lastDate}::date`,
    )
  ).rows.map((r) => ({
    id: r.id,
    onDate: r.on_date,
    kind: r.kind,
    startLocal: r.start_local,
    endLocal: r.end_local,
    tz: r.tz,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  }));

  const clusterIds = (
    await tx.execute<ClusterRow>(
      sql`SELECT c.id
            FROM public.cluster c, public.sitter_profile s
           WHERE s.id = ${sitterId}
             AND s.base_location IS NOT NULL
             AND c.state <> 'closed'
             AND ST_DWithin(ST_Centroid(c.boundary), s.base_location, s.travel_radius_m)
           ORDER BY c.id`,
    )
  ).rows.map((r) => Number(r.id));

  const bookable = profile?.bookable_state === 'bookable';
  const spans = materialise({ bookable, templates, exceptions, today });

  const deleted = (
    await tx.execute<{ n: number }>(
      sql`WITH d AS (DELETE FROM public.availability_slot WHERE sitter_id = ${sitterId} RETURNING 1)
          SELECT count(*)::int AS n FROM d`,
    )
  ).rows[0]?.n;

  if (spans.length > 0) {
    const newId = options.newId ?? newAvailabilityId;
    const ids = spans.map(() => newId());
    const starts = spans.map((s) => s.startsAt.toISOString());
    const ends = spans.map((s) => s.endsAt.toISOString());
    await tx.execute(
      sql`INSERT INTO public.availability_slot (id, sitter_id, span, cluster_ids)
          SELECT u.id, ${sitterId}, tstzrange(u.s, u.e, '[)'), ${sql.param(clusterIds)}::int[]
            FROM unnest(${sql.param(ids)}::char(26)[], ${sql.param(starts)}::timestamptz[],
                        ${sql.param(ends)}::timestamptz[]) AS u(id, s, e)`,
    );
  }

  return {
    sitterFound: profile !== undefined,
    bookable,
    today,
    clusterIds,
    deleted: Number(deleted ?? 0),
    spans,
  };
}
