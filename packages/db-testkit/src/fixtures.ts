/**
 * The stand-in tables and login principals `T-020` Evidence §4 and §7 created
 * by hand, as a function a suite calls.
 *
 * These are stand-ins for tables that do not exist yet — `out_of_hours_report`
 * is `T-112`'s and `account` is `T-026`'s — created in the suite's own cluster
 * and never by a migration. They are here rather than in each suite because
 * three suites need the same ones, and a copy per suite is how two of them end
 * up asserting against different fixtures without anyone noticing.
 *
 * Every `CREATE TABLE` and `GRANT` below fires `trg_int10_answering_service`.
 * That is deliberate and it is half the point of §4: the guard permits exactly
 * what SA §INT-10 permits, so a setup that the guard refused would mean the
 * guard was a blanket rather than a scalpel.
 */
import type { Cluster } from './cluster.ts';

/**
 * A password that exists only inside a disposable cluster for the life of one
 * suite. `gate:secrets` (gitleaks) sees this file; the string is deliberately
 * self-describing so a reader — human or scanner — can tell it apart from a
 * credential. There is no route from here to anything that outlives the suite.
 */
export const PROBE_PASSWORD = 'probe-local-only-disposable-cluster';

export const AS_PROBE = 'answering_service_probe';
export const SAFETY_PROBE = 'safety_gw_probe';

export const ACCOUNT_ID = '01J0000000000000000000000A';
export const ACCOUNT_EMAIL = 'parent@example.test';

/**
 * `out_of_hours_report` + `account`, one seeded row, the INT-10 grants, and a
 * REAL LOGIN PRINCIPAL whose only membership is `answering_service`.
 *
 * The login principal is not a convenience. `T-020` Evidence §4 is explicit
 * that `SET ROLE` from a superuser session "would be a weaker claim about a
 * different thing": `SET ROLE` keeps the session's own authenticated identity
 * and its `rolbypassrls`, so a refusal observed under it does not establish
 * that the vendor's connection is refused. Every negative below is over a real
 * connection as this role.
 */
export async function installInt10Fixtures(cluster: Cluster): Promise<void> {
  await cluster.sql({
    commands: [
      `CREATE TABLE public.out_of_hours_report (
         id char(26) PRIMARY KEY,
         provider_call_ref text NOT NULL,
         severity text NOT NULL,
         structured_report jsonb NOT NULL,
         caller_locale text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE public.account (
         id char(26) PRIMARY KEY,
         email_ci text NOT NULL,
         locale text NOT NULL)`,
      `INSERT INTO public.account VALUES ('${ACCOUNT_ID}','${ACCOUNT_EMAIL}','el')`,
      `GRANT INSERT ON public.out_of_hours_report TO answering_service`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.account, public.out_of_hours_report TO app_rw`,
      `CREATE ROLE ${AS_PROBE} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE answering_service`,
      `SELECT public.assert_answering_service_write_only()`,
    ],
  });
}

/** `T-020` Evidence §7's two stand-ins, and `safety-gw`'s login principal. */
export async function installSafetyFixtures(cluster: Cluster): Promise<void> {
  await cluster.sql({
    commands: [
      `CREATE TABLE public.session_safety_projection (
         id char(26) PRIMARY KEY,
         sitter_display_name text NOT NULL)`,
      `CREATE TABLE public.session_event (
         id char(26) PRIMARY KEY,
         session_id char(26) NOT NULL,
         kind text NOT NULL)`,
      `INSERT INTO public.session_safety_projection VALUES ('01J000000000000000000000S1','Α. Χριστοδούλου')`,
      // SD §DB-11's shape, verbatim: SELECT on the one table safety-gw does not
      // own, INSERT on the ones it does. INSERT and not INSERT/UPDATE — the
      // narrow reading, T-020 § Published contract §4.
      `GRANT SELECT ON public.session_safety_projection TO app_safety_rw`,
      `GRANT INSERT ON public.session_event TO app_safety_rw`,
      `CREATE ROLE ${SAFETY_PROBE} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE app_safety_rw`,
    ],
  });
}

/** Connect as the answering-service vendor principal (no statement). */
export const VENDOR_CONN = { user: AS_PROBE, password: PROBE_PASSWORD } as const;
/** Connect as `safety-gw`'s principal (no statement). */
export const SAFETY_CONN = { user: SAFETY_PROBE, password: PROBE_PASSWORD } as const;

/** Run one statement as the answering-service vendor principal. */
export function asVendor(sql: string): {
  user: string;
  password: string;
  commands: readonly string[];
  stopOnError: boolean;
} {
  return { user: AS_PROBE, password: PROBE_PASSWORD, commands: [sql], stopOnError: true };
}

/** Run one statement as `safety-gw`'s principal. */
export function asSafetyGw(sql: string): {
  user: string;
  password: string;
  commands: readonly string[];
  stopOnError: boolean;
} {
  return { user: SAFETY_PROBE, password: PROBE_PASSWORD, commands: [sql], stopOnError: true };
}
