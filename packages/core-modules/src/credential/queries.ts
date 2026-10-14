/**
 * Q-2…Q-5's SQL (T-060 `## Migration request` › "What the code does with it"), as `T-255` sends it.
 * PACKAGE-INTERNAL: not exported from `./credential`. `repository.ts` is the only product caller; the
 * integration suite imports these builders to run the same statement text under `EXPLAIN` and to
 * send a statement the repository itself never sends (a sitter's write to `valid`), so that the
 * database's refusal is shown, not the repository's.
 *
 * Every value is a bind parameter (drizzle's `sql` template). No statement names `DELETE`: there is
 * no delete path (T-252 §3: no role holds `DELETE`). Every write names only granted columns (T-252
 * §3, R-9): `id`, `sitter_id`, `scheme_id` and `status` on INSERT, and on UPDATE only `status`,
 * `reference_number` and `issued_on`.
 *
 * Dates (`date`) are read as `YYYY-MM-DD` text and instants (`timestamptz`) as UTC ISO-8601 text
 * with microseconds, so no driver type parser, time zone or precision loss sits between the column
 * and the caller.
 */
import { sql, type SQL } from 'drizzle-orm';

/** UTC ISO-8601 with microseconds, e.g. `2026-10-13T21:02:26.123456Z`. */
function instant(column: string): SQL {
  return sql.raw(
    `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`,
  );
}

/** The twenty columns of `sitter_credential` (T-252 §1), in SD's order. */
export const CREDENTIAL_COLUMNS: SQL = sql.join(
  [
    sql.raw('id, sitter_id, scheme_id, status, reference_number'),
    sql.raw('issued_on::text AS issued_on, expires_on::text AS expires_on, expiry_provenance'),
    sql.raw('next_recertification_due_at::text AS next_recertification_due_at'),
    instant('last_attestation_at'),
    instant('next_attestation_due_at'),
    sql.raw('attestation_template_version, attestation_locale, decision, decided_by'),
    instant('decided_at'),
    sql.raw('decision_reason_code, provider, provider_ref'),
    instant('created_at'),
  ],
  sql.raw(', '),
);

/** Q-2: the rows `sitter_id` holds. Under a sitter actor, RLS returns only the actor's own. */
export function q2SelectBySitter(sitterId: string): SQL {
  return sql`SELECT ${CREDENTIAL_COLUMNS} FROM public.sitter_credential
              WHERE sitter_id = ${sitterId} ORDER BY scheme_id`;
}

/** Q-2 by row id (Q-4's state read). Under a sitter actor, another sitter's id reads 0 rows. */
export function q2SelectById(id: string): SQL {
  return sql`SELECT ${CREDENTIAL_COLUMNS} FROM public.sitter_credential WHERE id = ${id}`;
}

/** Q-3, verbatim apart from `public.` and `RETURNING id` (which counts the rows inserted). */
export function q3InsertNotStarted(id: string, sitterId: string, schemeId: number): SQL {
  return sql`INSERT INTO public.sitter_credential (id, sitter_id, scheme_id, status)
             VALUES (${id}, ${sitterId}, ${schemeId}, 'not_started')
             ON CONFLICT (sitter_id, scheme_id) DO NOTHING
             RETURNING id`;
}

export interface Q4Update {
  readonly id: string;
  /** The status the row must hold for the write to land (compare-and-set). */
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly referenceNumber: string | null;
  /** `YYYY-MM-DD` or null. */
  readonly issuedOn: string | null;
}

/**
 * Q-4: `UPDATE … SET status, reference_number, issued_on … WHERE id = $ AND status = $`. Ownership is
 * NOT in the predicate: under a sitter actor, RLS (`sitter_credential_sitter_update`) is what makes
 * another sitter's row update 0 rows, and its WITH CHECK is what refuses a sitter's `valid`.
 */
export function q4Update(u: Q4Update): SQL {
  return sql`UPDATE public.sitter_credential
                SET status = ${u.toStatus}, reference_number = ${u.referenceNumber},
                    issued_on = ${u.issuedOn}::date
              WHERE id = ${u.id} AND status = ${u.fromStatus}
              RETURNING id`;
}

/** The three Q-5 sweeps, each served by its partial index (`0026`, T-252 §1). */
export type SweepKind = 'recertification' | 'attestation' | 'expiry';

/**
 * Q-5: `SELECT id FROM sitter_credential WHERE status = 'valid' AND <due column> <= $1`, ordered by
 * id. `recertification` → `next_recertification_due_at` (date) / `idx_sitter_credential_recert_due`;
 * `attestation` → `next_attestation_due_at` (timestamptz) / `idx_sitter_credential_attestation_due`;
 * `expiry` → `expires_on` (date) / `idx_sitter_credential_expires` (whose predicate also says
 * `expires_on IS NOT NULL`, which `<=` implies).
 */
export function q5Due(kind: SweepKind, asOf: string): SQL {
  switch (kind) {
    case 'recertification':
      return sql`SELECT id FROM public.sitter_credential
                  WHERE status = 'valid' AND next_recertification_due_at <= ${asOf}::date
                  ORDER BY id`;
    case 'attestation':
      return sql`SELECT id FROM public.sitter_credential
                  WHERE status = 'valid' AND next_attestation_due_at <= ${asOf}::timestamptz
                  ORDER BY id`;
    case 'expiry':
      return sql`SELECT id FROM public.sitter_credential
                  WHERE status = 'valid' AND expires_on <= ${asOf}::date
                  ORDER BY id`;
  }
}

/** The actor this transaction carries, as the policies read it (read only; nothing is set). */
export const READ_ACTOR: SQL = sql`SELECT NULLIF(current_setting('app.actor_role', true), '') AS actor_role,
                                          NULLIF(current_setting('app.actor_id', true), '') AS actor_id`;
