/**
 * T-028 — SA §SA-4 I-1, layers 1 and 3 (migration 0030): the bookable_state derivation, the triggers
 * that re-run it, the enqueue of search.slot_materialise on a bookable_state change, the OD-325 read
 * path, the page-only reconciler, and the OD-317/OD-318 shadow attack against the real call graph.
 * Layer 2 (assert_sitter_bookable() on booking, SITTER_NOT_BOOKABLE) is T-091's (OD-351).
 *
 * THE RULE UNDER TEST (0030's header; T-157 E-1, E-2, E-4 (b) as re-ruled by OE-90; EV-39; T-060 R-3):
 *   account suspended -> suspended; removed or erased -> removed; else any credential in review_hold
 *   -> review_hold; else COMPLETE and account active -> bookable; else onboarding. COMPLETE: the
 *   account's jurisdiction has >= 1 credential_scheme, every one with mandatory_rules exactly v1, and
 *   a 'valid' credential of the sitter for each. tier 'sitter' (rank 1) when COMPLETE, else NULL (0).
 * EXPECTED below is written from that rule and E-1's literal ranks, never read back from 0030.
 *
 * HOW IT RUNS. One disposable cluster (Testcontainers). Committed fixture rows are written by the
 * superuser in beforeAll, after the search.slot_materialise queue is created with the worker's
 * options (core-modules availability/jobs.ts: retryLimit 2, retryDelay 1, retryBackoff false,
 * expireInSeconds 120; policy standard, pg-boss's default). Privilege and RLS cases run over REAL
 * LOGIN principals, each a member of exactly one role. Every write runs in a transaction that is
 * never committed (`inTransaction`), except where a case says it commits (then it restores what it
 * changed, and the last case re-checks that the reconciler is clean). Every refusal asserts psql's
 * exit status AND its `ERROR:  <SQLSTATE>: <message>` line.
 *
 * WHAT IS PINNED in one assertion each: the eight 0030 functions (owner, SECURITY DEFINER, ACL,
 * volatility, proconfig — the OD-318 path pin for every function in the call graph); the four
 * triggers (definition, enabled); the added policy (definition). sitter_credential's and
 * sitter_profile's one-line pins live in their own suites.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  PROBE_PASSWORD,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused } from '../src/expect.ts';

const SUITE = 'i1-bookable-state';

const LOGINS = {
  app_rw: 't028_app_rw_probe',
  app_admin_rw: 't028_app_admin_rw_probe',
  app_safety_rw: 't028_app_safety_rw_probe',
  answering_service: 't028_answering_service_probe',
  app_ddl: 't028_app_ddl_probe',
} as const;

/** Canonical ULIDs (Crockford base32, upper case, first character 0-7): the job payload carries them. */
const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const sid = (tag: string): string => `01K8T028S${tag}`.padEnd(26, '0');
const cid = (tag: string): string => `01K8T028C${tag}`.padEnd(26, '0');

const S = {
  FULL: sid('FA'), //     active, both valid
  READY: sid('RE'), //    active, none (the shadow case's victim)
  HALF: sid('HA'), //     active, White valid only
  PHALF: sid('PH'), //    pending (dob verified), White valid only
  PEND: sid('PE'), //     pending, both valid
  SUSP: sid('SP'), //     suspended, both valid
  REM: sid('RM'), //      removed, both valid
  ERASED: sid('ER'), //   erased, both valid
  HOLD: sid('HD'), //     active, White valid, Art22 review_hold
  RB2: sid('RB'), //      active, both valid (RB-2 break-glass sequence, commits)
  ADMIN: sid('AD'), //    active, both valid (app_admin_rw suspension, commits)
} as const;
for (const id of Object.values(S)) assert.match(id, CANONICAL_ULID, id);

const WHITE = `(SELECT id FROM public.credential_scheme WHERE jurisdiction = 'CY' AND scheme_name = 'White Criminal Record Certificate')`;
const ART22 = `(SELECT id FROM public.credential_scheme WHERE jurisdiction = 'CY' AND scheme_name = 'Certificate under Art. 22(6), Law 91(I)/2014')`;

/** account status per sitter, and which credentials it holds (scheme -> status). */
const FIXTURE: Readonly<Record<keyof typeof S, { status: string; creds: Record<string, string> }>> =
  {
    FULL: { status: 'active', creds: { W: 'valid', A: 'valid' } },
    READY: { status: 'active', creds: {} },
    HALF: { status: 'active', creds: { W: 'valid' } },
    PHALF: { status: 'pending', creds: { W: 'valid' } },
    PEND: { status: 'pending', creds: { W: 'valid', A: 'valid' } },
    SUSP: { status: 'suspended', creds: { W: 'valid', A: 'valid' } },
    REM: { status: 'removed', creds: { W: 'valid', A: 'valid' } },
    ERASED: { status: 'erased', creds: { W: 'valid', A: 'valid' } },
    HOLD: { status: 'active', creds: { W: 'valid', A: 'review_hold' } },
    RB2: { status: 'active', creds: { W: 'valid', A: 'valid' } },
    ADMIN: { status: 'active', creds: { W: 'valid', A: 'valid' } },
  };

/** state|tier|tier_rank|bookable_since-set, written from the rule and E-1, not from 0030. */
const EXPECTED: Readonly<Record<keyof typeof S, string>> = {
  FULL: 'bookable|sitter|1|t',
  READY: 'onboarding|NULL|0|f',
  HALF: 'onboarding|NULL|0|f',
  PHALF: 'onboarding|NULL|0|f',
  PEND: 'onboarding|sitter|1|f', // E-2: pending is never bookable
  SUSP: 'suspended|sitter|1|f', // E-4 (b) / OE-90
  REM: 'removed|sitter|1|f',
  ERASED: 'removed|sitter|1|f', // E-2: erased -> removed
  HOLD: 'review_hold|NULL|0|f',
  RB2: 'bookable|sitter|1|t',
  ADMIN: 'bookable|sitter|1|t',
};

/** A credential id: the sitter's own tag (S[k] chars 9-10) and the scheme letter. */
const credId = (k: keyof typeof S, scheme: string): string => cid(`${S[k].slice(9, 11)}${scheme}`);

const QUEUE = 'search.slot_materialise';
const QUEUE_OPTIONS =
  '{"policy": "standard", "retryLimit": 2, "retryDelay": 1, "retryBackoff": false, "expireInSeconds": 120}';

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  const keys = Object.keys(S) as (keyof typeof S)[];
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      `SELECT pgboss.create_queue('${QUEUE}', '${QUEUE_OPTIONS}'::jsonb)`,
      ...keys.map(
        (k, i) =>
          `INSERT INTO public.account (id, pseudonym, tos_version, status, dob_verified_18)
             VALUES ('${S[k]}', '${`01K8T028P${String(i).padStart(2, '0')}`.padEnd(26, '0')}', 't028', '${FIXTURE[k].status}', true)`,
      ),
      `INSERT INTO public.sitter_profile (id) SELECT unnest(ARRAY[${keys.map((k) => `'${S[k]}'`).join(', ')}])`,
      ...keys.flatMap((k) =>
        Object.entries(FIXTURE[k].creds).map(
          ([scheme, status]) =>
            `INSERT INTO public.sitter_credential (id, sitter_id, scheme_id, status)
               VALUES ('${credId(k, scheme)}', '${S[k]}', ${scheme === 'W' ? WHITE : ART22}, '${status}')`,
        ),
      ),
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

const inTransaction = (commands: string[]): string[] => ['BEGIN', ...commands];

function asSuperuser(...commands: string[]): Promise<PsqlResult> {
  return db.psql({ commands: inTransaction(commands), verbose: true, stopOnError: true });
}

function asLogin(login: string, ...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands: inTransaction(commands),
    verbose: true,
    stopOnError: true,
  });
}

/** The same, committed (each command its own transaction). */
function asLoginCommitted(login: string, ...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands,
    verbose: true,
    stopOnError: true,
  });
}

const asRw = (...c: string[]): Promise<PsqlResult> => asLogin(LOGINS.app_rw, ...c);
const SYSTEM = [`SET LOCAL app.actor_role = 'system'`, `SET LOCAL app.actor_id = 'job:t028'`];

/** `<label>=state|tier|rank|since-set` for one sitter, read qualified. */
const STATE = (id: string, label = 'state'): string =>
  `SELECT '${label}=' || bookable_state || '|' || coalesce(tier::text, 'NULL') || '|' || tier_rank || '|' ||
          CASE WHEN bookable_since IS NULL THEN 'f' ELSE 't' END FROM public.sitter_profile WHERE id = '${id}'`;
/** `<label>=<n>` jobs on the queue for one sitter. */
const JOBS = (id: string, label = 'jobs'): string =>
  `SELECT '${label}=' || count(*) FROM pgboss.job WHERE name = '${QUEUE}' AND data->>'sitterId' = '${id}'`;

const has = (what: string, r: PsqlResult, ...markers: string[]): void => {
  for (const m of markers) {
    assert.ok(
      r.output.includes(m),
      `${what}: expected ${JSON.stringify(m)} in the output.\n${r.output}`,
    );
  }
};

function refusedWith(what: string, r: PsqlResult, errorLine: string): void {
  assertRefused(what, r, { message: errorLine });
  assert.equal(
    (r.output.match(/ERROR: {2}[0-9A-Z]{5}:/g) ?? []).length,
    1,
    `${what}: expected exactly one ERROR line.\n${r.output}`,
  );
}

const ALL_STATES_SQL = `SELECT string_agg(id || '=' || bookable_state || '|' || coalesce(tier::text, 'NULL') || '|' || tier_rank || '|' ||
                                  CASE WHEN bookable_since IS NULL THEN 'f' ELSE 't' END, ',' ORDER BY id) FROM public.sitter_profile`;
const expectedAll = (overrides: Partial<Record<keyof typeof S, string>> = {}): string =>
  (Object.keys(S) as (keyof typeof S)[])
    .map((k) => [S[k], overrides[k] ?? EXPECTED[k]] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, v]) => `${id}=${v}`)
    .join(',');

const KV080 = (n: number, of: number): string =>
  `ERROR:  KV080: I1_BOOKABLE_STATE_DIVERGENCE: ${String(n)} of ${String(of)} sitter_profile rows disagree with the I-1 derivation`;
const KV081 =
  'ERROR:  KV081: I1_SLOT_MATERIALISE_QUEUE_ABSENT: bookable_state changed to bookable, and the pg-boss queue search.slot_materialise does not exist, so the change cannot be enqueued';
const KV082 =
  'ERROR:  KV082: I1_SLOT_MATERIALISE_NO_SITTER: the id names no sitter_profile row, so no search.slot_materialise job is enqueued';
const SKIPPED =
  'WARNING:  01K81: I1_SLOT_MATERIALISE_SKIPPED: bookable_state changed to a non-bookable state and the pg-boss queue search.slot_materialise does not exist; the change commits without a job';
/** Delete the queue (and, first, its jobs: q_fkey is ON DELETE RESTRICT, deferred). Superuser only. */
const DROP_QUEUE = [
  `DELETE FROM pgboss.job WHERE name = '${QUEUE}'`,
  `DELETE FROM pgboss.queue WHERE name = '${QUEUE}'`,
  `SELECT 'queue=' || count(*) FROM pgboss.queue WHERE name = '${QUEUE}'`,
];
const N_SITTERS = Object.keys(S).length;
const N_CREDS = Object.values(FIXTURE).reduce((n, f) => n + Object.keys(f.creds).length, 0);

// =================================================================================================
describe('0030 — the catalogue: functions, triggers, policy', () => {
  test('the eight functions: owner, SECURITY DEFINER, ACL (EXECUTE revoked from PUBLIC), volatility and proconfig — search_path = pg_catalog, pg_temp on EVERY function in the call graph (OD-318), app.i1_derivation = on on the two that read sitter_credential as app_ddl', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(p.proname || '|' || CASE WHEN r.rolsuper THEN 'SUPERUSER' ELSE r.rolname END || '|' ||
                           p.prosecdef || '|' || p.provolatile::text || '|' ||
                           replace(coalesce(p.proacl::text, 'NULL'), r.rolname || '=X/' || r.rolname, 'OWNER') || '|' ||
                           array_to_string(p.proconfig, ';'), E'\\n' ORDER BY p.proname)
           FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'i1\\_%'`,
      ),
      [
        'i1_account_rederive|app_ddl|false|v|{OWNER}|search_path=pg_catalog, pg_temp',
        'i1_derived_bookable|app_ddl|false|s|{OWNER}|search_path=pg_catalog, pg_temp',
        'i1_enqueue_slot_materialise|SUPERUSER|true|v|{OWNER,app_ddl=X/' +
          '__SU__}|search_path=pg_catalog, pg_temp',
        'i1_reconcile_bookable_state|app_ddl|true|s|{OWNER,app_rw=X/app_ddl}|search_path=pg_catalog, pg_temp;app.i1_derivation=on',
        'i1_rederive_sitter|app_ddl|true|v|{OWNER,app_rw=X/app_ddl,app_admin_rw=X/app_ddl}|search_path=pg_catalog, pg_temp;app.i1_derivation=on',
        'i1_sitter_credential_rederive|app_ddl|false|v|{OWNER}|search_path=pg_catalog, pg_temp',
        'i1_sitter_credential_truncate_rederive|app_ddl|false|v|{OWNER}|search_path=pg_catalog, pg_temp',
        'i1_sitter_profile_enqueue|app_ddl|false|v|{OWNER}|search_path=pg_catalog, pg_temp',
      ]
        .join('\n')
        .replace('__SU__', await db.value(`SELECT current_user`)),
    );
  });

  test('the four triggers, as PostgreSQL deparses them, all enabled (O)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(tgenabled::text || ' ' || pg_get_triggerdef(oid), E'\\n' ORDER BY tgname)
           FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\\_%i1\\_%'`,
      ),
      [
        'O CREATE TRIGGER trg_account_i1_rederive AFTER UPDATE OF status, jurisdiction ON public.account FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR (old.jurisdiction IS DISTINCT FROM new.jurisdiction))) EXECUTE FUNCTION i1_account_rederive()',
        'O CREATE TRIGGER trg_sitter_credential_i1_rederive AFTER INSERT OR DELETE OR UPDATE ON public.sitter_credential FOR EACH ROW EXECUTE FUNCTION i1_sitter_credential_rederive()',
        'O CREATE TRIGGER trg_sitter_credential_i1_truncate AFTER TRUNCATE ON public.sitter_credential FOR EACH STATEMENT EXECUTE FUNCTION i1_sitter_credential_truncate_rederive()',
        'O CREATE TRIGGER trg_sitter_profile_i1_enqueue AFTER UPDATE OF bookable_state ON public.sitter_profile FOR EACH ROW WHEN ((old.bookable_state IS DISTINCT FROM new.bookable_state)) EXECUTE FUNCTION i1_sitter_profile_enqueue()',
      ].join('\n'),
    );
  });

  test('the OD-325 read policy: permissive, SELECT only, TO app_ddl only, USING app.i1_derivation = on read through NULLIF', async () => {
    assert.equal(
      await db.value(
        `SELECT polname || '|' || polcmd::text || '|' || polpermissive || '|' ||
                (SELECT string_agg(rolname, ',') FROM pg_roles WHERE oid = ANY (polroles)) || '|' ||
                pg_get_expr(polqual, polrelid) || '|' || coalesce(pg_get_expr(polwithcheck, polrelid), '-')
           FROM pg_policy WHERE polrelid = 'public.sitter_credential'::regclass AND polname = 'sitter_credential_i1_derivation_select'`,
      ),
      "sitter_credential_i1_derivation_select|r|true|app_ddl|(NULLIF(current_setting('app.i1_derivation'::text, true), ''::text) = 'on'::text)|-",
    );
  });

  test('no 0030 function and no 0030 trigger names the reference column, the reference format or the attestation due date (T-252 §6, T-060 §6, T-061 §6): searched in prosrc and pg_get_triggerdef', async () => {
    assert.equal(
      await db.value(
        `SELECT coalesce(string_agg(n, ','), 'none') FROM (
           SELECT proname AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'i1\\_%'
              AND prosrc ~* '(reference_number|reference_format_regex|next_attestation_due_at|attestation_grace)'
           UNION ALL
           SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\\_%i1\\_%'
              AND pg_get_triggerdef(oid) ~* '(reference_number|reference_format_regex|next_attestation_due_at)') x`,
      ),
      'none',
    );
    // anti-vacuity: the search reads the bodies it claims to (each body names its own inputs; since
    // rework 1 the enqueue too, which reads public.sitter_profile).
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'i1\\_%' AND prosrc ~ 'public\\.'`,
      ),
      '8',
    );
  });

  test('QA-F5 (rework 1): the columns the derivation helper reads, as alias-qualified references in its body, are exactly account id/status/jurisdiction, credential_scheme id/jurisdiction/mandatory_rules and sitter_credential sitter_id/scheme_id/status', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(DISTINCT m[1] || '.' || m[2], ',' ORDER BY m[1] || '.' || m[2])
           FROM pg_proc, regexp_matches(prosrc, '\\m(a|cs|sc)\\.([a-z_]+)', 'g') AS m
          WHERE oid = 'public.i1_derived_bookable(bpchar)'::regprocedure`,
      ),
      'a.id,a.jurisdiction,a.status,cs.id,cs.jurisdiction,cs.mandatory_rules,sc.scheme_id,sc.sitter_id,sc.status',
    );
  });

  test('the SA §INT-10 guard, called directly after up, returns clean', async () => {
    assertPermitted(
      'guard',
      await db.psql({
        commands: ['SELECT kinvara_guard.assert_answering_service_write_only()'],
        verbose: true,
        stopOnError: true,
      }),
    );
  });
});

// =================================================================================================
describe('layer 1 — the derivation as ruled (E-1, E-2, E-4 (b) / OE-90, EV-39, T-060 R-3)', () => {
  test('every fixture sitter, derived by the triggers at insert, holds exactly the state, tier, rank and bookable_since the rule gives (EXPECTED is written from the rule, not read from 0030)', async () => {
    assert.equal(await db.value(ALL_STATES_SQL), expectedAll());
  });

  test('one job per bookable_state CHANGE at fixture time: the five sitters whose state left onboarding; none for PEND, whose tier changed and state did not', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(data->>'sitterId', ',' ORDER BY data->>'sitterId') FROM pgboss.job WHERE name = '${QUEUE}'`,
      ),
      [S.FULL, S.SUSP, S.REM, S.ERASED, S.HOLD, S.RB2, S.ADMIN].sort().join(','),
    );
  });

  test("E-1: the derived rank of tier sitter is 1, and under SD 3029 (tier_rank >= required) with E-1's required ranks (0–2 → 3, 3+ → 1) a bookable sitter meets a 3+ band and does not meet a 0–2 band; a sitter with no tier (rank 0) meets neither", async () => {
    const r = await asSuperuser(
      `SELECT 'full=' || (tier_rank >= 1) || ',' || (tier_rank >= 3) FROM public.sitter_profile WHERE id = '${S.FULL}'`,
      `SELECT 'half=' || (tier_rank >= 1) || ',' || (tier_rank >= 3) FROM public.sitter_profile WHERE id = '${S.HALF}'`,
    );
    assertPermitted('E-1', r);
    has('E-1', r, 'full=true,false', 'half=false,false');
  });

  test('E-1 bound: the derivation never writes childcare_professional or infant_qualified (no input for them on main); a planted infant_qualified/3 is re-derived to sitter/1 — and that UPDATE, made while the sitter stays bookable, KEEPS bookable_since', async () => {
    const r = await asSuperuser(
      `CREATE TEMP TABLE t028_since AS SELECT bookable_since AS s FROM public.sitter_profile WHERE id = '${S.FULL}'`,
      `UPDATE public.sitter_profile SET tier = 'infant_qualified', tier_rank = 3 WHERE id = '${S.FULL}'`,
      STATE(S.FULL, 'planted'),
      `SELECT 'derived=' || public.i1_rederive_sitter('${S.FULL}')`,
      STATE(S.FULL, 'after'),
      `SELECT 'kept=' || (p.bookable_since = t.s) FROM public.sitter_profile p, t028_since t WHERE p.id = '${S.FULL}'`,
    );
    assertPermitted('E-1 bound', r);
    has(
      'E-1 bound',
      r,
      'planted=bookable|infant_qualified|3|t',
      'derived=bookable',
      'after=bookable|sitter|1|t',
      'kept=true',
    );
  });

  test("OD-351: a mandatory credential moved to review_hold (system actor, app_rw) => bookable_state review_hold, tier NULL, bookable_since NULL, one job — in the writer's transaction", async () => {
    const r = await asRw(
      ...SYSTEM,
      JOBS(S.FULL, 'before'),
      `UPDATE public.sitter_credential SET status = 'review_hold' WHERE id = '${credId('FULL', 'A')}'`,
      STATE(S.FULL),
      JOBS(S.FULL, 'after'),
    );
    assertPermitted('review_hold', r);
    has('review_hold', r, 'UPDATE 1', 'before=1', 'state=review_hold|NULL|0|f', 'after=2');
  });

  test('mandatory_rules v1 is met; with the v1 CHECK dropped, each other value ({}, "mandatory": "none", "v": 2, JSON null) on ONE scheme makes that scheme unmet: the sitter is not bookable (onboarding, tier NULL), never optional', async () => {
    for (const value of [
      '{}',
      '{"v": 1, "mandatory": "none"}',
      '{"v": 2, "mandatory": "all_tiers"}',
      'null',
    ]) {
      const r = await asSuperuser(
        STATE(S.FULL, 'v1'),
        'ALTER TABLE public.credential_scheme DROP CONSTRAINT credential_scheme_mandatory_rules_v1',
        `UPDATE public.credential_scheme SET mandatory_rules = '${value}'::jsonb WHERE id = ${WHITE}`,
        `SELECT 'planted=' || (mandatory_rules = '${value}'::jsonb) FROM public.credential_scheme WHERE id = ${WHITE}`,
        `SELECT 'derived=' || public.i1_rederive_sitter('${S.FULL}')`,
        STATE(S.FULL, 'after'),
      );
      assertPermitted(value, r);
      has(
        value,
        r,
        'v1=bookable|sitter|1|t',
        'planted=true',
        'derived=onboarding',
        'after=onboarding|NULL|0|f',
      );
    }
  });

  test("a jurisdiction with no credential_scheme is not COMPLETE (fail closed): moving an active, fully credentialed sitter's account to GR re-derives (account trigger, jurisdiction) to onboarding", async () => {
    const r = await asSuperuser(
      `UPDATE public.account SET jurisdiction = 'GR' WHERE id = '${S.FULL}'`,
      `SELECT 'schemes=' || count(*) FROM public.credential_scheme WHERE jurisdiction = 'GR'`,
      STATE(S.FULL),
    );
    assertPermitted('GR', r);
    has('GR', r, 'schemes=0', 'state=onboarding|NULL|0|f');
  });

  test('bookable_since: set on entry to bookable, KEPT while bookable (a re-derive after an unrelated credential write leaves it byte-identical), NULL on exit; version is never written', async () => {
    const r = await asRw(
      ...SYSTEM,
      `SELECT 'since0=' || bookable_since || '|v=' || version FROM public.sitter_profile WHERE id = '${S.FULL}'`,
      `UPDATE public.sitter_credential SET issued_on = DATE '2026-01-01' WHERE id = '${credId('FULL', 'W')}'`,
      `SELECT 'since1=' || bookable_since || '|v=' || version FROM public.sitter_profile WHERE id = '${S.FULL}'`,
      `UPDATE public.sitter_credential SET status = 'expired' WHERE id = '${credId('FULL', 'W')}'`,
      `SELECT 'exit=' || coalesce(bookable_since::text, 'NULL') || '|v=' || version FROM public.sitter_profile WHERE id = '${S.FULL}'`,
    );
    assertPermitted('since', r);
    const since0 = /since0=([^|\n]+)\|v=1/.exec(r.output)?.[1];
    const since1 = /since1=([^|\n]+)\|v=1/.exec(r.output)?.[1];
    assert.ok(since0 !== undefined && since1 !== undefined, r.output);
    assert.equal(
      since1,
      since0,
      'bookable_since moved on a re-derive that kept the sitter bookable',
    );
    has('since', r, 'exit=NULL|v=1');
  });
});

// =================================================================================================
describe('layer 1 — what re-runs it: each trigger path, each writer', () => {
  test('app_rw (system actor) inserting the two valid credentials of an active sitter: onboarding -> bookable, tier sitter/1, exactly ONE job (the first insert changes no state)', async () => {
    const r = await asRw(
      ...SYSTEM,
      `INSERT INTO public.sitter_credential (id, sitter_id, scheme_id, status) VALUES ('${cid('NEW1')}', '${S.READY}', ${WHITE}, 'valid')`,
      STATE(S.READY, 'one'),
      `INSERT INTO public.sitter_credential (id, sitter_id, scheme_id, status) VALUES ('${cid('NEW2')}', '${S.READY}', ${ART22}, 'valid')`,
      STATE(S.READY, 'two'),
      JOBS(S.READY),
    );
    assertPermitted('insert', r);
    has('insert', r, 'one=onboarding|NULL|0|f', 'two=bookable|sitter|1|t', 'jobs=1');
  });

  test('a superuser DELETE of a credential re-derives its sitter (OLD.sitter_id): bookable -> onboarding, one more job', async () => {
    const r = await asSuperuser(
      `DELETE FROM public.sitter_credential WHERE id = '${credId('FULL', 'A')}'`,
      STATE(S.FULL),
      JOBS(S.FULL),
    );
    assertPermitted('delete', r);
    has('delete', r, 'DELETE 1', 'state=onboarding|NULL|0|f', 'jobs=2');
  });

  test('a superuser UPDATE moving a credential to another sitter re-derives BOTH (OLD and NEW sitter_id)', async () => {
    const r = await asSuperuser(
      `UPDATE public.sitter_credential SET sitter_id = '${S.HALF}' WHERE id = '${credId('FULL', 'A')}'`,
      STATE(S.FULL, 'old'),
      STATE(S.HALF, 'new'),
    );
    assertPermitted('move', r);
    has('move', r, 'old=onboarding|NULL|0|f', 'new=bookable|sitter|1|t');
  });

  test('TRUNCATE by a real app_ddl login (the owner; RLS does not apply to TRUNCATE) re-derives EVERY sitter: none bookable, none tiered, none in review_hold; account states still rule', async () => {
    const r = await asLogin(LOGINS.app_ddl, 'TRUNCATE public.sitter_credential', ALL_STATES_SQL);
    assertPermitted('truncate', r);
    has(
      'truncate',
      r,
      expectedAll({
        FULL: 'onboarding|NULL|0|f',
        PEND: 'onboarding|NULL|0|f',
        SUSP: 'suspended|NULL|0|f',
        REM: 'removed|NULL|0|f',
        ERASED: 'removed|NULL|0|f',
        HOLD: 'onboarding|NULL|0|f',
        RB2: 'onboarding|NULL|0|f',
        ADMIN: 'onboarding|NULL|0|f',
      }),
    );
  });

  test('EV-39: app_rw suspending the account => suspended + one job; lifting it => bookable again with a NEW bookable_since + one more job', async () => {
    const r = await asRw(
      `UPDATE public.account SET status = 'suspended' WHERE id = '${S.FULL}'`,
      STATE(S.FULL, 'susp'),
      JOBS(S.FULL, 'jobs1'),
      `UPDATE public.account SET status = 'active' WHERE id = '${S.FULL}'`,
      STATE(S.FULL, 'lifted'),
      JOBS(S.FULL, 'jobs2'),
    );
    assertPermitted('EV-39', r);
    has(
      'EV-39',
      r,
      'susp=suspended|sitter|1|f',
      'jobs1=2',
      'lifted=bookable|sitter|1|t',
      'jobs2=3',
    );
  });

  test('E-2: app_rw moving an account to erased => removed; to removed => removed; to pending => onboarding (never bookable)', async () => {
    for (const [status, want] of [
      ['erased', 'removed|sitter|1|f'],
      ['removed', 'removed|sitter|1|f'],
      ['pending', 'onboarding|sitter|1|f'],
    ] as const) {
      const r = await asRw(
        `UPDATE public.account SET status = '${status}' WHERE id = '${S.FULL}'`,
        STATE(S.FULL),
      );
      assertPermitted(status, r);
      has(status, r, `state=${want}`);
    }
  });

  test("app_admin_rw (UPDATE (status) on account, 0011) suspending a bookable sitter COMMITS: the trigger runs under app_admin_rw's EXECUTE grant and enqueues; restored by the superuser (re-derived bookable)", async () => {
    assertPermitted(
      'admin suspend',
      await asLoginCommitted(
        LOGINS.app_admin_rw,
        `UPDATE public.account SET status = 'suspended' WHERE id = '${S.ADMIN}'`,
      ),
    );
    assert.equal(await db.value(STATE(S.ADMIN)), 'state=suspended|sitter|1|f');
    assert.equal(await db.value(JOBS(S.ADMIN)), 'jobs=2');
    await db.sql({
      commands: [`UPDATE public.account SET status = 'active' WHERE id = '${S.ADMIN}'`],
    });
    assert.equal(await db.value(STATE(S.ADMIN)), 'state=bookable|sitter|1|t');
  });
});

// =================================================================================================
describe('the enqueue — search.slot_materialise on every bookable_state change (E.3 U-12; T-089 §7)', () => {
  test('the job row: name search.slot_materialise, data EXACTLY {"sitterId": <canonical ULID>} (one key), state created, priority 0, and retry_limit 2 / retry_delay 1 / retry_backoff false / expire_seconds 120 / policy standard — the queue\'s', async () => {
    const out = await db.value(
      `SELECT data::text || '|' || (data = jsonb_build_object('sitterId', '${S.FULL}')) || '|' ||
              (SELECT count(*) FROM jsonb_object_keys(data)) || '|' || state || '|' || priority || '|' ||
              retry_limit || '|' || retry_delay || '|' || retry_backoff || '|' || expire_seconds || '|' ||
              policy || '|' || (keep_until - start_after = (SELECT retention_seconds * interval '1 second' FROM pgboss.queue WHERE name = '${QUEUE}'))
         FROM pgboss.job WHERE name = '${QUEUE}' AND data->>'sitterId' = '${S.FULL}'`,
    );
    assert.equal(out, `{"sitterId": "${S.FULL}"}|true|1|created|0|2|1|false|120|standard|true`);
    assert.match(S.FULL, CANONICAL_ULID);
  });

  test("COPIED from pgboss.queue, not defaulted (QA-F4, rework 1): with every copied setting of the queue moved off pg-boss's and the column default (retry_limit 5, retry_delay 7, retry_backoff true, retry_delay_max 33, expire_seconds 77, deletion_seconds 4444, retention_seconds 5555, policy short, dead_letter t028.dlq, heartbeat_seconds 66), the next job carries each value, and keep_until - start_after = 5555 s", async () => {
    const r = await asSuperuser(
      `SELECT pgboss.create_queue('t028.dlq', '{"policy": "standard"}'::jsonb)`,
      `UPDATE pgboss.queue SET retry_limit = 5, retry_delay = 7, retry_backoff = true, retry_delay_max = 33,
              expire_seconds = 77, deletion_seconds = 4444, retention_seconds = 5555, policy = 'short',
              dead_letter = 't028.dlq', heartbeat_seconds = 66 WHERE name = '${QUEUE}'`,
      `UPDATE public.account SET status = 'suspended' WHERE id = '${S.FULL}'`,
      `SELECT 'job=' || retry_limit || '|' || retry_delay || '|' || retry_backoff || '|' || retry_delay_max || '|' ||
              expire_seconds || '|' || deletion_seconds || '|' || extract(epoch FROM keep_until - start_after) || '|' ||
              policy || '|' || dead_letter || '|' || heartbeat_seconds
         FROM pgboss.job WHERE name = '${QUEUE}' AND data->>'sitterId' = '${S.FULL}' AND created_on = now()`,
      `SET CONSTRAINTS ALL IMMEDIATE`,
    );
    assertPermitted('copy', r);
    has('copy', r, 'job=5|7|true|33|77|4444|5555.000000|short|t028.dlq|66', 'SET CONSTRAINTS');
  });

  test('NO change, NO job: a credential write that leaves bookable_state as it was (tier/rank too) enqueues nothing', async () => {
    const r = await asRw(
      ...SYSTEM,
      `UPDATE public.sitter_credential SET issued_on = DATE '2026-02-02' WHERE sitter_id = '${S.FULL}'`,
      JOBS(S.FULL),
    );
    assertPermitted('no change', r);
    has('no change', r, 'UPDATE 2', 'jobs=1');
  });

  test("the job is in the writer's transaction: a change rolled back leaves no job", async () => {
    const before = await db.value(JOBS(S.FULL));
    const r = await asRw(
      `UPDATE public.account SET status = 'suspended' WHERE id = '${S.FULL}'`,
      JOBS(S.FULL, 'inside'),
    );
    assertPermitted('rollback', r);
    has('rollback', r, 'inside=2');
    assert.equal(await db.value(JOBS(S.FULL)), before);
  });

  test('QUEUE ABSENT (no worker has booted), INTO bookable: a write that would make a sitter bookable is REFUSED KV081 and nothing lands (fail closed); a write that changes no state is accepted', async () => {
    const r = await asSuperuser(
      ...DROP_QUEUE,
      `UPDATE public.sitter_credential SET issued_on = DATE '2026-03-03' WHERE sitter_id = '${S.FULL}'`,
      `INSERT INTO public.sitter_credential (id, sitter_id, scheme_id, status) VALUES ('${cid('ABS1')}', '${S.HALF}', ${ART22}, 'valid')`,
    );
    has('absent', r, 'queue=0', 'UPDATE 2');
    refusedWith('absent', r, KV081);
    assert.equal(await db.value(STATE(S.HALF)), `state=${EXPECTED.HALF}`);
  });

  test('QUEUE ABSENT, OUT of bookable (QA-F3 option (a), rework 1): the E-4 (b) suspension (app_rw, account trigger) and an OD-351 review_hold (system actor, credential trigger) of two bookable sitters, in a transaction with no change INTO bookable (see QUEUE ABSENT, MIXED), are ACCEPTED: each sitter leaves bookable, no job is inserted, each write raises WARNING 01K81, and the deferred pg-boss foreign keys are satisfied (SET CONSTRAINTS ALL IMMEDIATE)', async () => {
    const r = await asSuperuser(
      ...DROP_QUEUE,
      `SET LOCAL ROLE app_rw`,
      ...SYSTEM,
      `UPDATE public.account SET status = 'suspended' WHERE id = '${S.FULL}'`,
      `UPDATE public.sitter_credential SET status = 'review_hold' WHERE id = '${credId('RB2', 'A')}'`,
      `RESET ROLE`,
      STATE(S.FULL, 'full'),
      STATE(S.RB2, 'rb2'),
      `SELECT 'alljobs=' || count(*) FROM pgboss.job WHERE name = '${QUEUE}'`,
      `SET CONSTRAINTS ALL IMMEDIATE`,
    );
    assertPermitted('out of bookable', r);
    has(
      'out of bookable',
      r,
      'queue=0',
      'full=suspended|sitter|1|f',
      'rb2=review_hold|NULL|0|f',
      'alljobs=0',
      'SET CONSTRAINTS',
    );
    assert.equal(r.output.split(SKIPPED).length - 1, 2, `expected two ${SKIPPED}\n${r.output}`);
  });

  test('QUEUE ABSENT, MIXED (QA2-F2, rework 2 — the bound on OUT of bookable): a change out of bookable is REFUSED with a change INTO bookable that shares its statement or its transaction (KV081 aborts both), so it does not land: (a) ONE app_rw UPDATE suspending FULL and reactivating SUSP is refused whole; (b) in one transaction, the suspension of FULL raises WARNING 01K81 and is visible inside, then the reactivation of SUSP is refused KV081; after each, FULL is still bookable and SUSP still suspended, and the dropped queue row is back (nothing committed)', async () => {
    const statuses = `CASE id WHEN '${S.FULL}' THEN 'suspended'::public.account_status ELSE 'active'::public.account_status END`;
    const after = async (what: string): Promise<void> => {
      assert.equal(await db.value(STATE(S.FULL)), `state=${EXPECTED.FULL}`, `${what}: FULL`);
      assert.equal(await db.value(STATE(S.SUSP)), `state=${EXPECTED.SUSP}`, `${what}: SUSP`);
      assert.equal(
        await db.value(`SELECT count(*) FROM pgboss.queue WHERE name = '${QUEUE}'`),
        '1',
        `${what}: queue restored`,
      );
    };
    // (a) one statement. Which row's trigger runs first is not pinned, so the WARNING may or may not
    // precede the refusal; the refusal and the end state are what is asserted.
    const a = await asSuperuser(
      ...DROP_QUEUE,
      `SET LOCAL ROLE app_rw`,
      ...SYSTEM,
      `UPDATE public.account SET status = ${statuses} WHERE id IN ('${S.FULL}', '${S.SUSP}')`,
    );
    has('mixed statement', a, 'queue=0');
    refusedWith('mixed statement', a, KV081);
    assert.ok(
      a.output.split(SKIPPED).length - 1 <= 1,
      `mixed statement: at most one ${SKIPPED}\n${a.output}`,
    );
    await after('mixed statement');
    // (b) one transaction, two statements, no savepoint.
    const b = await asSuperuser(
      ...DROP_QUEUE,
      `SET LOCAL ROLE app_rw`,
      ...SYSTEM,
      `UPDATE public.account SET status = 'suspended' WHERE id = '${S.FULL}'`,
      `RESET ROLE`,
      STATE(S.FULL, 'inside'),
      `SET LOCAL ROLE app_rw`,
      ...SYSTEM,
      `UPDATE public.account SET status = 'active' WHERE id = '${S.SUSP}'`,
    );
    has('mixed transaction', b, 'queue=0', 'inside=suspended|sitter|1|f');
    assert.equal(
      b.output.split(SKIPPED).length - 1,
      1,
      `mixed transaction: expected one ${SKIPPED}\n${b.output}`,
    );
    assert.ok(
      b.output.indexOf(SKIPPED) < b.output.indexOf(KV081),
      `mixed transaction: the WARNING precedes the refusal\n${b.output}`,
    );
    refusedWith('mixed transaction', b, KV081);
    await after('mixed transaction');
  });

  test('EV-57 (rework 1): app_ddl, the only role holding EXECUTE on the superuser-owned enqueue, inserts one job for an existing sitter_profile id; an id that names no sitter_profile (QA-A4\'s "this is not a sitter id") is REFUSED KV082 and no job lands', async () => {
    const ok = await asLogin(
      LOGINS.app_ddl,
      `SELECT public.i1_enqueue_slot_materialise('${S.HALF}')`,
    );
    assertPermitted('existing id', ok);
    const bad = await asLogin(
      LOGINS.app_ddl,
      `SELECT public.i1_enqueue_slot_materialise('this is not a sitter id')`,
    );
    refusedWith('no sitter', bad, KV082);
    const r = await asSuperuser(
      `SET LOCAL ROLE app_ddl`,
      `SELECT public.i1_enqueue_slot_materialise('${S.HALF}')`,
      `RESET ROLE`,
      JOBS(S.HALF, 'half'),
      `SELECT 'forged=' || count(*) FROM pgboss.job WHERE name = '${QUEUE}' AND data->>'sitterId' = 'this is not a sitter id'`,
    );
    assertPermitted('count', r);
    has('count', r, 'half=1', 'forged=0');
  });

  test('item 7 (RB-2 under OE-90), committed in sequence: (1) a break-glass app_ddl UPDATE of bookable_state to review_hold ENQUEUES (the sitter_profile trigger covers every writer); (2) the reconciler then PAGES (KV080) naming that sitter alone, because the manual hold is not what the derivation gives; (3) the app_ddl suspension (E-4 (b)) re-derives suspended and enqueues; (4) the reconciler is clean; (5) a later credential write does NOT undo the suspension', async () => {
    assertPermitted(
      '(1)',
      await asLoginCommitted(
        LOGINS.app_ddl,
        `UPDATE public.sitter_profile SET bookable_state = 'review_hold' WHERE id = '${S.RB2}'`,
      ),
    );
    assert.equal(await db.value(STATE(S.RB2)), 'state=review_hold|sitter|1|t');
    assert.equal(await db.value(JOBS(S.RB2)), 'jobs=2');
    const page = await asRw('SELECT public.i1_reconcile_bookable_state()');
    refusedWith('(2)', page, KV080(1, N_SITTERS));
    has('(2)', page, `DETAIL:  sitter_profile ids: ${S.RB2}\n`);
    assertPermitted(
      '(3)',
      await asLoginCommitted(
        LOGINS.app_ddl,
        `UPDATE public.account SET status = 'suspended' WHERE id = '${S.RB2}'`,
      ),
    );
    assert.equal(await db.value(STATE(S.RB2)), 'state=suspended|sitter|1|f');
    assert.equal(await db.value(JOBS(S.RB2)), 'jobs=3');
    const clean = await asRw(`SELECT 'checked=' || public.i1_reconcile_bookable_state()`);
    assertPermitted('(4)', clean);
    has('(4)', clean, `checked=${String(N_SITTERS)}`);
    const later = await asRw(
      ...SYSTEM,
      `UPDATE public.sitter_credential SET status = 'valid', issued_on = DATE '2026-04-04' WHERE sitter_id = '${S.RB2}'`,
      STATE(S.RB2),
      JOBS(S.RB2),
    );
    assertPermitted('(5)', later);
    has('(5)', later, 'UPDATE 2', 'state=suspended|sitter|1|f', 'jobs=3');
  });

  test('QA-F2 (rework 1): a manual review_hold is NOT a hold. Committed in sequence on a sitter the derivation calls bookable (ADMIN): (1) a break-glass app_ddl UPDATE to review_hold enqueues; (2) the reconciler pages (KV080) naming that sitter; (3) ONE routine system attestation write on a valid credential (last_attestation_at = now()) re-derives it to bookable, with a new bookable_since, and enqueues; (4) the reconciler is then CLEAN — the hold is gone and nothing pages', async () => {
    const jobs0 = Number((await db.value(JOBS(S.ADMIN))).slice('jobs='.length));
    assertPermitted(
      '(1)',
      await asLoginCommitted(
        LOGINS.app_ddl,
        `UPDATE public.sitter_profile SET bookable_state = 'review_hold' WHERE id = '${S.ADMIN}'`,
      ),
    );
    assert.equal(await db.value(STATE(S.ADMIN)), 'state=review_hold|sitter|1|t');
    assert.equal(await db.value(JOBS(S.ADMIN)), `jobs=${String(jobs0 + 1)}`);
    const page = await asRw('SELECT public.i1_reconcile_bookable_state()');
    refusedWith('(2)', page, KV080(1, N_SITTERS));
    has('(2)', page, `DETAIL:  sitter_profile ids: ${S.ADMIN}\n`);
    assertPermitted(
      '(3)',
      await asRw(
        ...SYSTEM,
        `UPDATE public.sitter_credential SET last_attestation_at = now() WHERE id = '${credId('ADMIN', 'W')}'`,
        'COMMIT',
      ),
    );
    assert.equal(await db.value(STATE(S.ADMIN)), `state=${EXPECTED.ADMIN}`);
    assert.equal(
      await db.value(`SELECT status FROM public.account WHERE id = '${S.ADMIN}'`),
      'active',
    );
    assert.equal(await db.value(JOBS(S.ADMIN)), `jobs=${String(jobs0 + 2)}`);
    const clean = await asRw(`SELECT 'checked=' || public.i1_reconcile_bookable_state()`);
    assertPermitted('(4)', clean);
    has('(4)', clean, `checked=${String(N_SITTERS)}`);
  });
});

// =================================================================================================
describe('OD-325 — the read path: the definer reads every sitter_credential row under FORCE; app_rw cannot reach the policy', () => {
  test('the derivation reads every row: as app_rw with no actor set (it sees 0 credential rows itself) the reconciler compares all sitters and is clean; with the policy DROPPED (superuser, rolled back) the same reconciler pages exactly the sitters whose derived values need a credential row', async () => {
    const r = await asRw(
      `SELECT 'visible=' || count(*) FROM public.sitter_credential`,
      `SELECT 'checked=' || public.i1_reconcile_bookable_state()`,
    );
    assertPermitted('with policy', r);
    has('with policy', r, 'visible=0', `checked=${String(N_SITTERS)}`);
    assert.equal(await db.value('SELECT count(*) FROM public.sitter_credential'), String(N_CREDS));
    const blind = await asSuperuser(
      'DROP POLICY sitter_credential_i1_derivation_select ON public.sitter_credential',
      'SELECT public.i1_reconcile_bookable_state()',
    );
    // Every sitter whose EXPECTED tier is sitter, or whose state needs a credential (HOLD).
    const needRows = (Object.keys(S) as (keyof typeof S)[])
      .filter((k) => EXPECTED[k].includes('|sitter|') || EXPECTED[k].startsWith('review_hold'))
      .map((k) => S[k])
      .sort();
    refusedWith('policy dropped', blind, KV080(needRows.length, N_SITTERS));
    has('policy dropped', blind, `DETAIL:  sitter_profile ids: ${needRows.join(',')}\n`);
  });

  test('app_rw cannot reach the policy: setting app.i1_derivation = on itself (the placeholder is settable by a role outside app_ddl), it still sees 0 rows (the policy is TO app_ddl), and SET ROLE app_ddl is refused (42501)', async () => {
    const r = await asRw(
      `SET LOCAL app.i1_derivation = 'on'`,
      `SELECT 'guc=' || current_setting('app.i1_derivation')`,
      `SELECT 'visible=' || count(*) FROM public.sitter_credential`,
    );
    assertPermitted('guc', r);
    has('guc', r, 'guc=on', 'visible=0');
    refusedWith(
      'set role',
      await asRw('SET ROLE app_ddl'),
      'ERROR:  42501: permission denied to set role "app_ddl"',
    );
  });

  test("a real app_ddl login: 0 rows without the GUC (T-252's measured fact still holds); NOT HELD — with app.i1_derivation = on it reads every row (any session acting as app_ddl, break-glass or a migration run as app_ddl, can set the placeholder; it could already NO FORCE); the policy is SELECT only: its UPDATE reaches 0 rows and its INSERT is refused 42501 (RLS)", async () => {
    const r = await asLogin(
      LOGINS.app_ddl,
      `SELECT 'nogucs=' || count(*) FROM public.sitter_credential`,
      `SET LOCAL app.i1_derivation = 'on'`,
      `SELECT 'guc=' || count(*) FROM public.sitter_credential`,
      `UPDATE public.sitter_credential SET issued_on = DATE '2026-05-05'`,
    );
    assertPermitted('app_ddl', r);
    has('app_ddl', r, 'nogucs=0', `guc=${String(N_CREDS)}`, 'UPDATE 0');
    refusedWith(
      'app_ddl insert',
      await asLogin(
        LOGINS.app_ddl,
        `SET LOCAL app.i1_derivation = 'on'`,
        `INSERT INTO public.sitter_credential (id, sitter_id, scheme_id, status) VALUES ('${cid('DDL')}', '${S.READY}', ${WHITE}, 'valid')`,
      ),
      'ERROR:  42501: new row violates row-level security policy for table "sitter_credential"',
    );
  });
});

// =================================================================================================
describe('layer 3 — the reconciler: compares, writes nothing, raises KV080 (the P0 mechanism for T-273)', () => {
  test('clean: returns the number of sitter_profile rows compared, and writes nothing (md5 of sitter_profile, sitter_credential and pgboss.job equal before and after)', async () => {
    const HASH = `SELECT 'hash=' || md5((SELECT string_agg(t::text, ',' ORDER BY t::text) FROM public.sitter_profile t) ||
                                       (SELECT string_agg(t::text, ',' ORDER BY t::text) FROM public.sitter_credential t) ||
                                       (SELECT string_agg(t::text, ',' ORDER BY t::text) FROM pgboss.job t))`;
    const r = await asSuperuser(
      HASH,
      `SELECT 'checked=' || public.i1_reconcile_bookable_state()`,
      HASH,
    );
    assertPermitted('clean', r);
    has('clean', r, `checked=${String(N_SITTERS)}`);
    const hashes = r.output.match(/hash=[0-9a-f]{32}/g) ?? [];
    assert.equal(hashes.length, 2, r.output);
    assert.equal(hashes[0], hashes[1]);
  });

  test("a non-bookable sitter discovered bookable (RB-2's trigger, planted by the superuser): KV080, 1 of N, DETAIL naming that sitter", async () => {
    const r = await asSuperuser(
      `UPDATE public.sitter_profile SET bookable_state = 'bookable', bookable_since = now() WHERE id = '${S.HALF}'`,
      'SELECT public.i1_reconcile_bookable_state()',
    );
    refusedWith('corrupt', r, KV080(1, N_SITTERS));
    has('corrupt', r, `DETAIL:  sitter_profile ids: ${S.HALF}\n`);
  });

  test('each compared value on its own: tier alone, tier_rank alone, and bookable_since set on a non-bookable sitter each raise KV080 naming the sitter; two corrupted sitters are both named, in id order', async () => {
    for (const set of [`tier = 'sitter'`, 'tier_rank = 2', 'bookable_since = now()']) {
      const r = await asSuperuser(
        `UPDATE public.sitter_profile SET ${set} WHERE id = '${S.HALF}'`,
        'SELECT public.i1_reconcile_bookable_state()',
      );
      refusedWith(set, r, KV080(1, N_SITTERS));
      has(set, r, `DETAIL:  sitter_profile ids: ${S.HALF}\n`);
    }
    const two = await asSuperuser(
      `UPDATE public.sitter_profile SET tier_rank = 2 WHERE id IN ('${S.HALF}', '${S.READY}')`,
      'SELECT public.i1_reconcile_bookable_state()',
    );
    refusedWith('two', two, KV080(2, N_SITTERS));
    has('two', two, `DETAIL:  sitter_profile ids: ${[S.HALF, S.READY].sort().join(',')}\n`);
  });

  test('a scheme added by a data migration is NOT re-derived by any trigger (bound): the reconciler reports every sitter it leaves stale', async () => {
    const r = await asSuperuser(
      `INSERT INTO public.credential_scheme (jurisdiction, check_type, scheme_name, issuing_body, validity_model, mandatory_rules)
         VALUES ('CY', 'training', 'T-028 planted scheme', 'Nobody', 'point_in_time', '{"v": 1, "mandatory": "all_tiers"}')`,
      STATE(S.FULL),
      'SELECT public.i1_reconcile_bookable_state()',
    );
    has('scheme', r, `state=${EXPECTED.FULL}`);
    const stale = (Object.keys(S) as (keyof typeof S)[])
      .filter((k) => EXPECTED[k].includes('|sitter|'))
      .map((k) => S[k])
      .sort();
    refusedWith('scheme', r, KV080(stale.length, N_SITTERS));
    has('scheme', r, `DETAIL:  sitter_profile ids: ${stale.join(',')}\n`);
  });

  test('EXECUTE: app_rw may call it; app_admin_rw, app_safety_rw and answering_service are refused 42501', async () => {
    assertPermitted('app_rw', await asRw('SELECT public.i1_reconcile_bookable_state()'));
    for (const login of [LOGINS.app_admin_rw, LOGINS.app_safety_rw, LOGINS.answering_service]) {
      refusedWith(
        login,
        await asLogin(login, 'SELECT public.i1_reconcile_bookable_state()'),
        'ERROR:  42501: permission denied for function i1_reconcile_bookable_state',
      );
    }
  });
});

// =================================================================================================
describe('the definer — G-3 (c) hygiene: id only, recompute only, EXECUTE where granted', () => {
  test('app_rw calling i1_rederive_sitter directly can only recompute: it returns the derived state and moves nothing; an id with no profile returns NULL', async () => {
    const r = await asRw(
      `SELECT 'r=' || public.i1_rederive_sitter('${S.HALF}')`,
      `SELECT 'none=' || coalesce(public.i1_rederive_sitter('${sid('ZZ')}')::text, 'NULL')`,
      JOBS(S.HALF),
    );
    assertPermitted('direct', r);
    has('direct', r, 'r=onboarding', 'none=NULL', 'jobs=0');
    assert.equal(await db.value(STATE(S.HALF)), `state=${EXPECTED.HALF}`);
  });

  test('app_rw still cannot write the protected four itself (42501), and app_safety_rw / answering_service cannot EXECUTE the definer (42501)', async () => {
    refusedWith(
      'direct write',
      await asRw(
        `UPDATE public.sitter_profile SET bookable_state = 'bookable' WHERE id = '${S.HALF}'`,
      ),
      'ERROR:  42501: permission denied for table sitter_profile',
    );
    for (const login of [LOGINS.app_safety_rw, LOGINS.answering_service]) {
      refusedWith(
        login,
        await asLogin(login, `SELECT public.i1_rederive_sitter('${S.HALF}')`),
        'ERROR:  42501: permission denied for function i1_rederive_sitter',
      );
    }
  });
});

// =================================================================================================
describe('OD-317 / OD-318 — the shadow attack against the real call graph (PROTOCOL §5.1: a committed case)', () => {
  // An app_rw-only login creates, in its own pg_temp: a TEMP table under the name of EVERY relation
  // the call graph reads or writes (sitter_profile, sitter_credential, credential_scheme, account,
  // pgboss's queue and job), each holding forged rows and granted to app_ddl; and a pg_temp DOMAIN
  // under the name of every non-catalog type the call graph uses (bookable_state, sitter_tier,
  // account_status, pgboss's job_state), whose CHECK calls an app_rw pg_temp function that, run as
  // app_ddl, writes the victim's protected four (T-158 QA2-S A4c-2's shape). Then, as the system actor,
  // it fires the derivation directly, through the sitter_credential trigger and through the account
  // trigger, and changes a state so the sitter_profile trigger and the enqueue run. If any relation
  // or type in anything run as an owner were resolved through search_path, a forged row or the forge
  // would choose a value. The harness .cache/T-028/mutate.sh unqualifies one name at a time in 0030
  // and shows this case red for each (mutation asserted landed).
  const forgedRows = (s: string): string[] => [
    // relations
    'CREATE TEMP TABLE sitter_profile (id char(26), bookable_state text, tier text, tier_rank int2, bookable_since timestamptz)',
    `INSERT INTO sitter_profile VALUES ('${sid('ZZ')}', 'onboarding', NULL, 0, NULL)`,
    'CREATE TEMP TABLE sitter_credential (sitter_id char(26), scheme_id int, status text)',
    `INSERT INTO sitter_credential SELECT x, s.id, 'valid' FROM unnest(ARRAY['${S.HALF}', '${S.PHALF}']) x, public.credential_scheme s`,
    `INSERT INTO sitter_credential SELECT '${S.PEND}', ${WHITE}, 'review_hold'`,
    'CREATE TEMP TABLE credential_scheme (id int, jurisdiction text, mandatory_rules jsonb)',
    `INSERT INTO credential_scheme SELECT id, 'CY', mandatory_rules FROM public.credential_scheme WHERE id = ${WHITE}`,
    'CREATE TEMP TABLE account (id char(26), status text, jurisdiction text)',
    `INSERT INTO account VALUES ('${S.PEND}', 'active', 'CY'), ('${S.PHALF}', 'active', 'CY'), ('${S.HALF}', 'active', 'CY'), ('${S.FULL}', 'active', 'CY')`,
    `CREATE TEMP TABLE queue AS SELECT * FROM pgboss.queue WHERE name = '${QUEUE}'`,
    'UPDATE queue SET retry_limit = 99, expire_seconds = 99',
    'CREATE TEMP TABLE job (LIKE pgboss.job INCLUDING DEFAULTS)',
    ...['sitter_profile', 'sitter_credential', 'credential_scheme', 'account', 'queue', 'job'].map(
      (t) => `GRANT ALL ON pg_temp.${t} TO app_ddl`,
    ),
    // types: the forge runs as whoever evaluates the domain CHECK
    `CREATE FUNCTION pg_temp.t028_forge() RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN
       UPDATE public.sitter_profile SET bookable_state = 'bookable', tier = 'infant_qualified', tier_rank = 3,
              bookable_since = now() WHERE id = '${s}';
       RETURN true; END $f$`,
    ...['bookable_state', 'sitter_tier', 'account_status', 'job_state'].map(
      (t) => `CREATE DOMAIN pg_temp.${t} AS text CHECK (pg_temp.t028_forge())`,
    ),
    // the plants landed
    `SELECT 'temp-relations=' || count(*) FROM pg_class WHERE relnamespace = pg_my_temp_schema()
        AND relname IN ('sitter_profile', 'sitter_credential', 'credential_scheme', 'account', 'queue', 'job') AND relkind = 'r'`,
    `SELECT 'temp-domains=' || count(*) FROM pg_type WHERE typnamespace = pg_my_temp_schema() AND typtype = 'd'
        AND typname IN ('bookable_state', 'sitter_tier', 'account_status', 'job_state')`,
    `SELECT 'forged=' || (SELECT count(*) FROM pg_temp.sitter_credential) || ',' || (SELECT count(*) FROM pg_temp.account) || ',' ||
            (SELECT retry_limit FROM pg_temp.queue)`,
  ];
  // The forged sitter_credential holds 5 rows: HALF and PHALF valid for both schemes, PEND review_hold.

  test("an app_rw-only login with every relation and type of the call graph shadowed in pg_temp: direct calls, the credential trigger, the account trigger, a state change and its enqueue, and the reconciler all read the REAL rows; the victim is untouched; the job lands in pgboss.job with the real queue's retry_limit; nothing was written to the shadows", async () => {
    const r = await asRw(
      `SELECT 'temp:' || has_database_privilege(current_database(), 'TEMP')`,
      ...forgedRows(S.READY),
      ...SYSTEM,
      // direct
      `SELECT 'd-half=' || public.i1_rederive_sitter('${S.HALF}')`,
      `SELECT 'd-pend=' || public.i1_rederive_sitter('${S.PEND}')`,
      // through the credential trigger
      `UPDATE public.sitter_credential SET issued_on = DATE '2026-06-06' WHERE sitter_id IN ('${S.HALF}', '${S.PEND}')`,
      // through the account trigger
      `UPDATE public.account SET status = 'active' WHERE id = '${S.PHALF}'`,
      // a real state change (revocation), so the sitter_profile trigger and the enqueue run
      `UPDATE public.sitter_credential SET status = 'expired' WHERE id = '${credId('FULL', 'W')}'`,
      // the real outcomes, read qualified
      STATE(S.HALF, 'half'),
      STATE(S.PEND, 'pend'),
      STATE(S.PHALF, 'phalf'),
      STATE(S.FULL, 'full'),
      STATE(S.READY, 'victim'),
      `SELECT 'job=' || count(*) || '|' || min(retry_limit) || '|' || min(expire_seconds) FROM pgboss.job
        WHERE name = '${QUEUE}' AND data->>'sitterId' = '${S.FULL}' AND created_on = now()`,
      `SELECT 'shadow-job=' || count(*) FROM pg_temp.job`,
      `SELECT 'shadow-profile=' || bookable_state FROM pg_temp.sitter_profile`,
      // the reconciler shares the helper and reads sitter_profile: it compares every REAL row, clean
      `SELECT 'recon=' || public.i1_reconcile_bookable_state()`,
    );
    assertPermitted('shadow', r);
    has(
      'shadow',
      r,
      'temp:true',
      'temp-relations=6',
      'temp-domains=4',
      'forged=5,4,99',
      'd-half=onboarding',
      'd-pend=onboarding',
      'half=onboarding|NULL|0|f',
      'pend=onboarding|sitter|1|f',
      'phalf=onboarding|NULL|0|f',
      'full=onboarding|NULL|0|f',
      'victim=onboarding|NULL|0|f',
      'job=1|2|120',
      'shadow-job=0',
      'shadow-profile=onboarding',
      `recon=${String(N_SITTERS)}`,
    );
  });

  test("CONTROL: the forge is live — called by app_rw itself it is refused 42501 (the write needs the owner's privilege), and evaluated by a real app_ddl login (the role every owner-run function in the graph but the enqueue runs as) it writes the victim: so a type resolved through search_path in owner-run code WOULD move the protected four", async () => {
    const self = await asRw(...forgedRows(S.READY), `SELECT 'x'::pg_temp.bookable_state`);
    refusedWith(
      'forge as app_rw',
      self,
      'ERROR:  42501: permission denied for table sitter_profile',
    );
    const owner = await asLogin(
      LOGINS.app_ddl,
      `CREATE FUNCTION pg_temp.t028_forge() RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN
         UPDATE public.sitter_profile SET bookable_state = 'bookable', tier = 'infant_qualified', tier_rank = 3,
                bookable_since = now() WHERE id = '${S.READY}';
         RETURN true; END $f$`,
      `CREATE DOMAIN pg_temp.bookable_state AS text CHECK (pg_temp.t028_forge())`,
      `SELECT 'x'::pg_temp.bookable_state`,
      STATE(S.READY, 'victim'),
    );
    // app_ddl cannot read pgboss.job but the enqueue is the superuser's definer: the write lands.
    assertPermitted('forge as app_ddl', owner);
    has('forge as app_ddl', owner, 'victim=bookable|infant_qualified|3|t');
  });

  test('CONTROL: a TEMP table shadow is live — the same forged sitter_credential read UNQUALIFIED by app_rw itself makes HALF look complete', async () => {
    const r = await asRw(
      ...forgedRows(S.READY),
      `SELECT 'unqualified=' || count(*) FROM sitter_credential WHERE sitter_id = '${S.HALF}' AND status = 'valid'`,
    );
    assertPermitted('temp control', r);
    has('temp control', r, 'unqualified=2');
  });
});

// =================================================================================================
describe('end state', () => {
  test('after every case (the committed ones restored or left consistent), the reconciler is clean over all sitters and the fixture states hold, RB2 now suspended', async () => {
    assert.equal(await db.value(`SELECT public.i1_reconcile_bookable_state()`), String(N_SITTERS));
    assert.equal(await db.value(ALL_STATES_SQL), expectedAll({ RB2: 'suspended|sitter|1|f' }));
  });
});
