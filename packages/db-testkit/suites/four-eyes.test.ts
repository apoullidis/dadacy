/**
 * T-030 — SA §SA-4 I-5, four-eyes approvals, at the DATABASE layer (migration 0007).
 *
 * T-186 — the I-5 follow-ups the stakeholder ruled (migration 0008): OE-45 (only an ACTIVE
 * account's ts_senior countersigns) and OE-47 (only app_admin_rw may write a ts_senior row).
 *
 * I-5 has two clauses this suite refuses:
 *   (a) the approver is a different actor from the submitter — SD's CHECK
 *       `approval_distinct_actors` (23514), and the trigger's case/whitespace-folded
 *       comparison (KV051);
 *   (b) the approver holds an unrevoked `ts_senior` role — decisions.md OE-21, "ts_senior
 *       ONLY", whoever performed the action — ON AN ACTIVE ACCOUNT (OE-45), held by the
 *       trigger `trg_approval_four_eyes` → `public.assert_second_actor_differs()` (KV052 no
 *       such role; KV054 the account is not active), reading account_role joined to account
 *       as the countersigning transaction sees them. Since 0008, app_rw cannot write a
 *       ts_senior row (`trg_account_role_ts_senior_admin_only`, KV053; OE-47), so QA's B2/B3/B4
 *       routes are REFUSED below, each with an app_admin_rw CONTROL.
 *
 * What is still open is pinned as LIMITATION cases, each asserting the stored row: app_rw
 * writes account.status, so it can make a suspended approver active around a countersignature
 * (decisions.md OD-222); and RP1/RP2 pin what a countersigned row does not bind (T-030 QA-F2):
 * the consumer obligation is in T-186 § Published contract.
 *
 * Every fixture account is ACTIVE (with dob_verified_18, which account_min_age_verified requires)
 * unless the test names its status, so a ts_senior CONTROL is refused only by what the test changes.
 * ts_senior rows are written by the superuser in fixtures and by the app_admin_rw login in tests.
 *
 * Every refusal asserts psql's exit status AND the exact `ERROR:  <SQLSTATE>: …` line, so a
 * crash, a connection failure or a refusal for another reason cannot read as this one
 * (T-115 § contract TL2-F4). Each refusal has a CONTROL: the same statement with a
 * `ts_senior` approver is accepted, so the clause under test is what refused it.
 *
 * Countersignatures run over a REAL LOGIN in `app_rw` alone (`apps/core` connects as
 * `app_rw`, T-020 § contract §3), never `SET ROLE` from a superuser session.
 *
 * The tests share one cluster in file order. Fixtures are written in `beforeAll`; every
 * control that writes runs inside BEGIN … ROLLBACK, and every refused write runs inside
 * BEGIN, so psql stopping on the error leaves nothing behind. The two race tests restore
 * what they change and assert it.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  acquireMigratedCluster,
  PROBE_PASSWORD,
  type Cluster,
  type PsqlResult,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'four-eyes';

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't030_app_rw_probe',
  app_admin_rw: 't030_app_admin_rw_probe',
  app_safety_rw: 't030_app_safety_rw_probe',
  answering_service: 't030_answering_service_probe',
  /** T-186: the owner of account_role and approval, which OE-47 does not admit either. */
  app_ddl: 't186_app_ddl_probe',
} as const;
/** A login holding privileges on `approval` and NOTHING on `account_role` (invoker test). */
const APPROVAL_ONLY_LOGIN = 't030_approval_only_probe';

/** A 26-character fixture id. */
const id = (tag: string): string => {
  const v = `01K4T030${tag}`.padEnd(26, '0');
  assert.equal(v.length, 26, `fixture id ${v} is not char(26) wide`);
  return v;
};

/** Accounts, and the roles each holds (all unrevoked unless named). */
const ACC = {
  /** The approver OE-21 admits. */
  tsSenior: id('TSSENIOR'),
  /** A second ts_senior, used as a submitter so a ts_senior can be the approver elsewhere. */
  tsSenior2: id('TSSENIORTWO'),
  /**
   * Every role SD §BE-10's grid gives a four-eyes cell to, EXCEPT ts_senior: dsl,
   * deputy_dsl, compliance. This is the approver a literal reading of the grid (OD-66's
   * other branch) would admit, and OE-21 refuses.
   */
  seniorElse: id('SENIORELSE'),
  dsl: id('DSL'),
  compliance: id('COMPLIANCE'),
  tsOperator: id('TSOPERATOR'),
  parent: id('PARENT'),
  noRole: id('NOROLE'),
  /** ts_senior granted, then revoked. */
  revoked: id('REVOKED'),
  /** status 'suspended', with a LIVE ts_senior role (OE-45). */
  suspended: id('SUSPENDED'),
  /** status 'removed', with a LIVE ts_senior role (OE-45). */
  removed: id('REMOVED'),
  /** status 'erased', with a LIVE ts_senior role (OE-45). */
  erased: id('ERASED'),
  /** status 'pending', with a LIVE ts_senior role: not active either. */
  pendingTs: id('PENDINGTS'),
  /** An active ts_senior used by the tests that revoke, suspend or re-check (T-186). */
  tsSeniorScratch: id('TSSCRATCH'),
  /** An account whose id is the LOWER-CASE spelling of `tsSenior2`'s, holding ts_senior. */
  lowerOfTsSenior2: id('TSSENIORTWO').toLowerCase(),
  /** sod_finance_ts fixtures (T-140 QA-A3): finance REVOKED + ts_operator live. */
  sodFinance: id('SODFINANCE'),
  /** ts_operator live + parent live, no finance row. */
  sodB: id('SODB'),
  /** finance live, nothing else. */
  sodC: id('SODC'),
} as const;
/** An id no account holds. */
const NO_SUCH_ACCOUNT = id('NOSUCHACCOUNT');

const ROLES_OF: Readonly<Record<string, readonly string[]>> = {
  [ACC.tsSenior]: ['ts_senior'],
  [ACC.tsSenior2]: ['ts_senior'],
  [ACC.seniorElse]: ['dsl', 'deputy_dsl', 'compliance'],
  [ACC.dsl]: ['dsl'],
  [ACC.compliance]: ['compliance'],
  [ACC.tsOperator]: ['ts_operator'],
  [ACC.parent]: ['parent'],
  [ACC.noRole]: [],
  [ACC.revoked]: ['ts_senior'],
  [ACC.suspended]: ['ts_senior'],
  [ACC.removed]: ['ts_senior'],
  [ACC.erased]: ['ts_senior'],
  [ACC.pendingTs]: ['ts_senior'],
  [ACC.tsSeniorScratch]: ['ts_senior'],
  [ACC.lowerOfTsSenior2]: ['ts_senior'],
  [ACC.sodFinance]: ['ts_operator'],
  [ACC.sodB]: ['ts_operator', 'parent'],
  [ACC.sodC]: ['finance'],
};

/**
 * The nine `F4` cells: the (action, performing role) pairs SD §BE-10's grid marks
 * "four-eyes" (software-design.md lines 1269-1284), as `T-024`'s matrix transcribes them.
 * The trigger does not read `action`, so each cell is refused by the same mechanism; the
 * per-cell cases pin that no action is exempt.
 */
const F4_CELLS: readonly {
  readonly action: string;
  readonly performer: string;
  readonly sd: number;
}[] = [
  { action: 'non_clear_outcome#review', performer: 'ts_senior', sd: 1269 },
  { action: 'account#remove_permanently', performer: 'ts_senior', sd: 1272 },
  { action: 'safeguarding_referral#make', performer: 'dsl', sd: 1274 },
  { action: 'staffed_hours_version#publish', performer: 'dsl', sd: 1275 },
  { action: 'staffed_hours_version#publish', performer: 'compliance', sd: 1275 },
  { action: 'retention_run#approve', performer: 'compliance', sd: 1281 },
  { action: 'feature_flag.compliance#toggle', performer: 'ts_senior', sd: 1284 },
  { action: 'feature_flag.compliance#toggle', performer: 'dsl', sd: 1284 },
  { action: 'feature_flag.compliance#toggle', performer: 'compliance', sd: 1284 },
];
assert.equal(F4_CELLS.length, 9, 'SD §BE-10 has nine four-eyes cells');

/** The submitter for a cell: an account holding the performing role. */
const SUBMITTER_FOR: Readonly<Record<string, string>> = {
  ts_senior: ACC.tsSenior2,
  dsl: ACC.dsl,
  compliance: ACC.compliance,
};

const ERR_CHECK =
  'ERROR:  23514: new row for relation "approval" violates check constraint "approval_distinct_actors"';
const ERR_NOT_DIFFERENT =
  'ERROR:  KV051: I5_SECOND_ACTOR_NOT_DIFFERENT: public.approval requires approver_id to be a different actor from submitter_id';
const ERR_NOT_TS_SENIOR =
  'ERROR:  KV052: I5_APPROVER_LACKS_TS_SENIOR: public.approval.approver_id holds no unrevoked ts_senior role';
/** T-186, OE-45: a live ts_senior on an account whose status is not active. */
const ERR_NOT_ACTIVE =
  'ERROR:  KV054: I5_APPROVER_NOT_ACTIVE: public.approval.approver_id holds ts_senior on an account that is not active';
/** T-186, OE-47: a ts_senior row written by a role without app_admin_rw's privileges. */
const errTsSeniorWrite = (op: 'INSERT' | 'UPDATE' | 'DELETE', role: string): string =>
  `ERROR:  KV053: I5_TS_SENIOR_WRITE_REFUSED: ${op} of a ts_senior row in public.account_role by role ${role}`;

/** The status each fixture account is created with: ACTIVE unless named here (T-186). */
const STATUS_OF: Readonly<Record<string, string>> = {
  [ACC.suspended]: 'suspended',
  [ACC.removed]: 'removed',
  [ACC.erased]: 'erased',
  [ACC.pendingTs]: 'pending',
};

let seq = 0;
/** A fresh approval id per statement, so no two tests collide on the primary key. */
const nextApprovalId = (): string => id(`APPR${String(++seq).padStart(4, '0')}`);

/** A pending approval (no approver yet). */
const insertPending = (approvalId: string, action: string, submitter: string): string =>
  `INSERT INTO public.approval (id, subject_type, subject_id, action, submitter_id, submitted_at)
     VALUES ('${approvalId}', 'case', '${id('SUBJECT')}', '${action}', '${submitter}', now())`;

/** The countersignature, as `/v1/admin/approvals/{id}/countersign` would write it. */
const countersign = (approvalId: string, approver: string): string =>
  `UPDATE public.approval
      SET approver_id = '${approver}', approved_at = now(), decision = 'approve', rationale = 't030'
    WHERE id = '${approvalId}'`;

/** An approval written with its approver in the same INSERT. */
const insertCountersigned = (approvalId: string, submitter: string, approver: string): string =>
  `INSERT INTO public.approval (id, subject_type, subject_id, action, submitter_id, submitted_at,
                                approver_id, approved_at, decision)
     VALUES ('${approvalId}', 'case', '${id('SUBJECT')}', 'account#remove_permanently',
             '${submitter}', now(), '${approver}', now(), 'approve')`;

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  const accountRows = Object.values(ACC).map(
    (acc, i) =>
      `INSERT INTO public.account (id, pseudonym, tos_version, status, dob_verified_18)
         VALUES ('${acc}', '${id(`PSEUDO${String(i).padStart(2, '0')}`)}', 't030-tos',
                 '${STATUS_OF[acc] ?? 'active'}', true)`,
  );
  const roleRows = Object.entries(ROLES_OF).flatMap(([acc, roles]) =>
    roles.map(
      (r) => `INSERT INTO public.account_role (account_id, role) VALUES ('${acc}', '${r}')`,
    ),
  );
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      `CREATE ROLE ${APPROVAL_ONLY_LOGIN} LOGIN PASSWORD '${PROBE_PASSWORD}'`,
      ...accountRows,
      ...roleRows,
      `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACC.revoked}'`,
      // sod fixture: ts_operator live, finance present but REVOKED (legal).
      `INSERT INTO public.account_role (account_id, role, revoked_at)
         VALUES ('${ACC.sodFinance}', 'finance', now())`,
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** Statements as the bootstrap superuser, SQLSTATE in the message, stopping at the first error. */
function asSuperuser(...commands: string[]): Promise<PsqlResult> {
  return db.psql({ commands, verbose: true, stopOnError: true });
}

/** Statements over a real login, SQLSTATE in the message, stopping at the first error. */
function asLogin(login: string, ...commands: string[]): Promise<PsqlResult> {
  return db.psql({
    user: login,
    password: PROBE_PASSWORD,
    commands,
    verbose: true,
    stopOnError: true,
  });
}
const asApp = (...commands: string[]): Promise<PsqlResult> => asLogin(LOGINS.app_rw, ...commands);
/** T-186: the one principal OE-47 lets write a ts_senior row. */
const asAdmin = (...commands: string[]): Promise<PsqlResult> =>
  asLogin(LOGINS.app_admin_rw, ...commands);

/** Revoke / un-revoke an account's ts_senior, as app_admin_rw (OE-47), committed. */
const REVOKE_TS = (acc: string): string =>
  `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${acc}' AND role = 'ts_senior'`;
const UNREVOKE_TS = (acc: string): string =>
  `UPDATE public.account_role SET revoked_at = NULL WHERE account_id = '${acc}' AND role = 'ts_senior'`;

/** One approval row as stored, or `(none)`: `approver|decision|rationale|approved_at`. */
const storedRow = (approvalId: string): string =>
  `SELECT coalesce((SELECT coalesce(approver_id, '-') || '|' || coalesce(decision, '-') || '|'
                          || coalesce(rationale, '-') || '|' || coalesce(approved_at::text, '-')
                     FROM public.approval WHERE id = '${approvalId}'), '(none)')`;

/** Refused with exactly this ERROR line (and, where given, psql named the constraint). */
function assertRefusedWith(
  what: string,
  r: PsqlResult,
  errorLine: string,
  constraint?: string,
): void {
  assertRefused(what, r, { message: errorLine });
  if (constraint !== undefined) {
    const field = `CONSTRAINT NAME:  ${constraint}`;
    assert.ok(
      r.output.includes(field),
      `${what}: expected ${JSON.stringify(field)} in the output.\n${r.output}`,
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('0007 — what exists', () => {
  test('approval is owned by app_ddl; its ACL is exactly app_ddl and app_rw SELECT, INSERT, UPDATE', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_userbyid(relowner) || '|' || relacl::text FROM pg_class
          WHERE oid = 'public.approval'::regclass`,
      ),
      'app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=arw/app_ddl}',
    );
  });

  test('the trigger is an enabled AFTER ROW INSERT OR UPDATE trigger on approval, calling an INVOKER function', async () => {
    assert.equal(
      await db.value(
        `SELECT t.tgenabled::text || '|' || pg_get_triggerdef(t.oid) || '|' || p.prosecdef::text
                || '|' || pg_get_userbyid(p.proowner)
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'trg_approval_four_eyes' AND t.tgrelid = 'public.approval'::regclass`,
      ),
      "O|CREATE TRIGGER trg_approval_four_eyes AFTER INSERT OR UPDATE ON public.approval FOR EACH ROW EXECUTE FUNCTION assert_second_actor_differs('submitter_id', 'approver_id')|false|app_ddl",
    );
  });

  test('the fixture roles are what the tests below rely on', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(account_id || ':' || role || ':' || (revoked_at IS NULL)::text, ',' ORDER BY account_id COLLATE "C", role COLLATE "C")
           FROM public.account_role
          WHERE account_id IN ('${ACC.tsSenior}', '${ACC.seniorElse}', '${ACC.revoked}', '${ACC.suspended}',
                               '${ACC.removed}', '${ACC.erased}', '${ACC.pendingTs}')`,
      ),
      [
        `${ACC.revoked}:ts_senior:false`,
        `${ACC.seniorElse}:compliance:true`,
        `${ACC.seniorElse}:deputy_dsl:true`,
        `${ACC.seniorElse}:dsl:true`,
        `${ACC.suspended}:ts_senior:true`,
        `${ACC.removed}:ts_senior:true`,
        `${ACC.erased}:ts_senior:true`,
        `${ACC.pendingTs}:ts_senior:true`,
        `${ACC.tsSenior}:ts_senior:true`,
      ]
        .sort()
        .join(','),
    );
    // T-186 (QA2-A4, QM5): every account is ACTIVE except the four named non-active ones.
    assert.equal(
      await db.value(
        `SELECT string_agg(status::text || '=' || n::text, ',' ORDER BY status::text)
           FROM (SELECT status, count(*) AS n FROM public.account GROUP BY status) s`,
      ),
      `active=${String(Object.keys(ACC).length - 4)},erased=1,pending=1,removed=1,suspended=1`,
    );
  });

  test('T-186: account_role carries an enabled BEFORE ROW INSERT OR UPDATE OR DELETE trigger calling an INVOKER function owned by app_ddl (OE-47)', async () => {
    assert.equal(
      await db.value(
        `SELECT t.tgenabled::text || '|' || pg_get_triggerdef(t.oid) || '|' || p.prosecdef::text
                || '|' || pg_get_userbyid(p.proowner) || '|' || array_to_string(p.proconfig, ',')
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'trg_account_role_ts_senior_admin_only'
            AND t.tgrelid = 'public.account_role'::regclass`,
      ),
      'O|CREATE TRIGGER trg_account_role_ts_senior_admin_only BEFORE INSERT OR DELETE OR UPDATE ON public.account_role FOR EACH ROW EXECUTE FUNCTION assert_ts_senior_written_by_admin()|false|app_ddl|search_path=pg_catalog',
    );
  });

  test('T-186: account_role ACL is exactly app_ddl, app_rw SELECT/INSERT/UPDATE and app_admin_rw SELECT/INSERT/UPDATE: no DELETE to either', async () => {
    assert.equal(
      await db.value(
        `SELECT pg_get_userbyid(relowner) || '|' || relacl::text FROM pg_class
          WHERE oid = 'public.account_role'::regclass`,
      ),
      'app_ddl|{app_ddl=arwdDxtm/app_ddl,app_rw=arw/app_ddl,app_admin_rw=arw/app_ddl}',
    );
  });
});

describe('I-5 clause (a) — the approver is a different actor', () => {
  test('the submitter countersigning their own approval is REFUSED by approval_distinct_actors (23514)', async () => {
    const a = nextApprovalId();
    assertRefusedWith(
      'self-countersign by UPDATE',
      await asApp(
        'BEGIN',
        insertPending(a, 'account#remove_permanently', ACC.tsSenior),
        countersign(a, ACC.tsSenior),
      ),
      ERR_CHECK,
      'approval_distinct_actors',
    );
  });

  test('the same, written in one INSERT, is REFUSED by approval_distinct_actors (23514)', async () => {
    assertRefusedWith(
      'self-countersign by INSERT',
      await asApp('BEGIN', insertCountersigned(nextApprovalId(), ACC.tsSenior, ACC.tsSenior)),
      ERR_CHECK,
      'approval_distinct_actors',
    );
  });

  test("the submitter's id LOWER-CASED is REFUSED by the trigger (KV051), although that spelling is an account holding ts_senior", async () => {
    const a = nextApprovalId();
    assertRefusedWith(
      'lower-cased self-countersign',
      await asApp(
        'BEGIN',
        insertPending(a, 'account#remove_permanently', ACC.tsSenior2),
        countersign(a, ACC.lowerOfTsSenior2),
      ),
      ERR_NOT_DIFFERENT,
    );
  });

  test('CONTROL — that lower-case-id account countersigning SOMEONE ELSE is accepted, so clause (a) is what refused it', async () => {
    const a = nextApprovalId();
    assertPermitted(
      'lower-case account countersigns another submitter',
      await asApp(
        'BEGIN',
        insertPending(a, 'account#remove_permanently', ACC.dsl),
        countersign(a, ACC.lowerOfTsSenior2),
        'ROLLBACK',
      ),
    );
  });
});

describe('I-5 clause (b), OE-21 — a different account WITHOUT ts_senior is refused, for each of the nine F4 cells', () => {
  for (const cellCase of F4_CELLS) {
    const label = `${cellCase.action} performed by ${cellCase.performer} (SD line ${String(cellCase.sd)})`;

    test(`${label}: a countersigner holding dsl, deputy_dsl and compliance but NOT ts_senior is REFUSED (KV052)`, async () => {
      const a = nextApprovalId();
      assertRefusedWith(
        label,
        await asApp(
          'BEGIN',
          insertPending(a, cellCase.action, SUBMITTER_FOR[cellCase.performer] ?? ''),
          countersign(a, ACC.seniorElse),
        ),
        ERR_NOT_TS_SENIOR,
      );
    });

    test(`${label}: CONTROL — a different account holding ts_senior is accepted`, async () => {
      const a = nextApprovalId();
      const r = await db.psql({
        user: LOGINS.app_rw,
        password: PROBE_PASSWORD,
        raw: true,
        verbose: true,
        stopOnError: true,
        commands: [
          'BEGIN',
          insertPending(a, cellCase.action, SUBMITTER_FOR[cellCase.performer] ?? ''),
          countersign(a, ACC.tsSenior),
          `SELECT 'countersigned=' || approver_id FROM public.approval WHERE id = '${a}'`,
          'ROLLBACK',
        ],
      });
      assertPermitted(label, r);
      assert.ok(
        r.stdout.includes(`countersigned=${ACC.tsSenior}`),
        `${label}: row not countersigned.\n${r.output}`,
      );
    });
  }
});

describe('I-5 clause (b) — every other kind of approver is refused (KV052)', () => {
  const others: readonly [string, string][] = [
    ['a ts_senior whose role is REVOKED', ACC.revoked],
    ['a ts_operator', ACC.tsOperator],
    ['a parent', ACC.parent],
    ['an account holding no role', ACC.noRole],
    ['an id no account holds', NO_SUCH_ACCOUNT],
    ['a dsl alone', ACC.dsl],
    ['a compliance alone', ACC.compliance],
  ];
  for (const [what, approver] of others) {
    test(`${what} is REFUSED (KV052)`, async () => {
      const a = nextApprovalId();
      assertRefusedWith(
        what,
        await asApp(
          'BEGIN',
          insertPending(a, 'retention_run#approve', ACC.tsSenior2),
          countersign(a, approver),
        ),
        ERR_NOT_TS_SENIOR,
      );
    });
  }

  test('an approver without ts_senior written in the INSERT itself is REFUSED (KV052): the trigger fires on INSERT too', async () => {
    assertRefusedWith(
      'countersigned at INSERT',
      await asApp('BEGIN', insertCountersigned(nextApprovalId(), ACC.dsl, ACC.seniorElse)),
      ERR_NOT_TS_SENIOR,
    );
  });

  test('CONTROL — the revoked ts_senior, un-revoked, is accepted', async () => {
    const a = nextApprovalId();
    assertPermitted(
      'un-revoked ts_senior',
      await asSuperuser(
        'BEGIN',
        `UPDATE public.account_role SET revoked_at = NULL WHERE account_id = '${ACC.revoked}' AND role = 'ts_senior'`,
        insertPending(a, 'retention_run#approve', ACC.compliance),
        countersign(a, ACC.revoked),
        'ROLLBACK',
      ),
    );
  });

  test('a later UPDATE of a countersigned row re-checks the approver: once app_admin_rw has revoked the ts_senior, re-writing the row is REFUSED (KV052), and only nulling approver_id is accepted (TL-A2)', async () => {
    // T-186 (QA2-A4 QM1): the revoke is app_admin_rw's, committed, because app_rw may no longer
    // write a ts_senior row. A dedicated account, so no other test sees the revoke.
    const acc = ACC.tsSeniorScratch;
    const a = nextApprovalId();
    assertPermitted(
      'countersigned and committed',
      await asApp(insertPending(a, 'retention_run#approve', ACC.compliance), countersign(a, acc)),
    );
    assertPermitted('app_admin_rw revokes, committed', await asAdmin(REVOKE_TS(acc)));
    const rewrite = await asApp(
      'BEGIN',
      `UPDATE public.approval SET rationale = 'edited later' WHERE id = '${a}'`,
    );
    const nulled = await db.psql({
      user: LOGINS.app_rw,
      password: PROBE_PASSWORD,
      raw: true,
      verbose: true,
      stopOnError: true,
      commands: [
        'BEGIN',
        `UPDATE public.approval SET approver_id = NULL WHERE id = '${a}'`,
        `SELECT 'nulled=' || coalesce(approver_id, '-') FROM public.approval WHERE id = '${a}'`,
        'ROLLBACK',
      ],
    });
    const stored = await db.value(storedRow(a));
    // Restore before judging (superuser: the fixture writer), and prove it.
    await db.sql({ commands: [UNREVOKE_TS(acc), `DELETE FROM public.approval WHERE id = '${a}'`] });
    assertRefusedWith('approver revoked, row re-written', rewrite, ERR_NOT_TS_SENIOR);
    assertPermitted('nulling approver_id', nulled);
    assert.ok(nulled.stdout.includes('nulled=-'), `approver_id nulled.\n${nulled.output}`);
    assert.ok(
      stored.startsWith(`${acc}|approve|t030|`),
      `the refused edit left the row: ${stored}`,
    );
    assert.equal(await db.value(liveTsSenior(acc)), '1', 'restored');
  });
});

describe('I-5 clause (b) — the role row is read FOR SHARE, so a concurrent revoke cannot race a countersignature', () => {
  test('a revoke of the approver’s ts_senior WAITS on an open countersignature, and times out (55P03)', async () => {
    const a = nextApprovalId();
    await asSuperuser(insertPending(a, 'safeguarding_referral#make', ACC.dsl));
    const countersigning = asApp(
      'BEGIN',
      countersign(a, ACC.tsSenior),
      'SELECT pg_sleep(4)',
      'ROLLBACK',
    );
    await sleep(1500);
    // Inside BEGIN … ROLLBACK, so that if the lock did NOT block it, the revoke still
    // never commits and cannot leak into the next test's state. app_admin_rw revokes (T-186).
    const revoke = await asAdmin(
      'BEGIN',
      "SET LOCAL lock_timeout = '1s'",
      REVOKE_TS(ACC.tsSenior),
      'ROLLBACK',
    );
    const cs = await countersigning;
    assertPermitted('the countersignature transaction', cs);
    assertRefusedWith(
      'the concurrent revoke',
      revoke,
      'ERROR:  55P03: canceling statement due to lock timeout',
    );
    assert.equal(
      await db.value(
        `SELECT (revoked_at IS NULL)::text FROM public.account_role WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      ),
      'true',
    );
  });

  test('a countersignature that WAITS on an open revoke is REFUSED once the revoke commits (KV052)', async () => {
    // Precondition, so a revoke leaked from elsewhere cannot make this refusal vacuous.
    assert.equal(
      await db.value(
        `SELECT (revoked_at IS NULL)::text FROM public.account_role WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      ),
      'true',
    );
    const a = nextApprovalId();
    await asSuperuser(insertPending(a, 'safeguarding_referral#make', ACC.dsl));
    const revoking = asAdmin('BEGIN', REVOKE_TS(ACC.tsSenior), 'SELECT pg_sleep(3)', 'COMMIT');
    await sleep(1500);
    const cs = await asApp(countersign(a, ACC.tsSenior));
    const rv = await revoking;
    // Restore before judging, so a failure here cannot leak a revoked fixture into later tests.
    await db.sql({
      commands: [
        `UPDATE public.account_role SET revoked_at = NULL WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      ],
    });
    assertPermitted('the revoke transaction', rv);
    assertRefusedWith('the waiting countersignature', cs, ERR_NOT_TS_SENIOR);
    // Prove the restore, and that nothing was countersigned.
    assert.equal(
      await db.value(
        `SELECT (SELECT (revoked_at IS NULL)::text FROM public.account_role WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior')
                || '|' || (SELECT coalesce(approver_id, '(none)') FROM public.approval WHERE id = '${a}')`,
      ),
      'true|(none)',
    );
  });
});

/**
 * T-186, OE-45: only an ACTIVE account's ts_senior satisfies I-5. Each non-active status is
 * refused (KV054) over the real app_rw login, and nothing is stored; each has a CONTROL in
 * which the same account, made active by the superuser and committed, IS accepted and the
 * countersignature IS stored, so the status is what refused it. Until T-186 the suspended
 * case was pinned as a LIMITATION (ACCEPTED), asserting psql's exit status only (QA2-A1).
 */
describe('I-5 clause (b), OE-45 — a live ts_senior on an account that is NOT ACTIVE is refused (KV054)', () => {
  const nonActive: readonly [string, string][] = [
    ['suspended', ACC.suspended],
    ['removed', ACC.removed],
    ['erased', ACC.erased],
    ['pending', ACC.pendingTs],
  ];
  for (const [status, acc] of nonActive) {
    test(`a ${status.toUpperCase()} account holding a live ts_senior is REFUSED (KV054), and nothing is stored`, async () => {
      assert.equal(
        await db.value(
          `SELECT status::text || '|' || (${liveTsSenior(acc)}) FROM public.account WHERE id = '${acc}'`,
        ),
        `${status}|1`,
        'precondition: that status, with a live ts_senior',
      );
      const a = nextApprovalId();
      const r = await asApp(
        'BEGIN',
        insertPending(a, 'retention_run#approve', ACC.compliance),
        countersign(a, acc),
      );
      assertRefusedWith(`${status} ts_senior countersigns`, r, ERR_NOT_ACTIVE);
      assert.equal(await db.value(storedRow(a)), '(none)', `${status}: nothing stored`);
    });

    test(`CONTROL — the same ${status} account, made ACTIVE, is accepted and its countersignature is stored`, async () => {
      const a = nextApprovalId();
      await db.sql({
        commands: [`UPDATE public.account SET status = 'active' WHERE id = '${acc}'`],
      });
      const r = await asApp(
        insertPending(a, 'retention_run#approve', ACC.compliance),
        countersign(a, acc),
      );
      const stored = await db.value(storedRow(a));
      // Restore before judging, and prove it.
      await db.sql({
        commands: [
          `UPDATE public.account SET status = '${status}' WHERE id = '${acc}'`,
          `DELETE FROM public.approval WHERE id = '${a}'`,
        ],
      });
      assertPermitted(`${status} made active`, r);
      assert.ok(stored.startsWith(`${acc}|approve|t030|`), `${status} control stored: ${stored}`);
      assert.equal(
        await db.value(`SELECT status::text FROM public.account WHERE id = '${acc}'`),
        status,
      );
    });
  }

  test('an approver whose account is not active is refused at INSERT too (KV054)', async () => {
    assertRefusedWith(
      'countersigned at INSERT by a suspended ts_senior',
      await asApp('BEGIN', insertCountersigned(nextApprovalId(), ACC.dsl, ACC.suspended)),
      ERR_NOT_ACTIVE,
    );
  });

  test('a revoked ts_senior on an ACTIVE account is still KV052, not KV054: the two refusals stay distinct', async () => {
    assert.equal(
      await db.value(`SELECT status::text FROM public.account WHERE id = '${ACC.revoked}'`),
      'active',
    );
    const a = nextApprovalId();
    assertRefusedWith(
      'revoked on active',
      await asApp(
        'BEGIN',
        insertPending(a, 'retention_run#approve', ACC.compliance),
        countersign(a, ACC.revoked),
      ),
      ERR_NOT_TS_SENIOR,
    );
  });

  test('once the approver is suspended, a later UPDATE of the countersigned row is REFUSED (KV054) and nulling approver_id is accepted (TL-A2)', async () => {
    const acc = ACC.tsSeniorScratch;
    const a = nextApprovalId();
    assertPermitted(
      'countersigned and committed',
      await asApp(insertPending(a, 'retention_run#approve', ACC.compliance), countersign(a, acc)),
    );
    assertPermitted(
      'app_rw suspends the approver, committed',
      await asApp(`UPDATE public.account SET status = 'suspended' WHERE id = '${acc}'`),
    );
    const rewrite = await asApp(
      'BEGIN',
      `UPDATE public.approval SET rationale = 'x' WHERE id = '${a}'`,
    );
    const nulled = await asApp(
      'BEGIN',
      `UPDATE public.approval SET approver_id = NULL WHERE id = '${a}'`,
      'ROLLBACK',
    );
    await db.sql({
      commands: [
        `UPDATE public.account SET status = 'active' WHERE id = '${acc}'`,
        `DELETE FROM public.approval WHERE id = '${a}'`,
      ],
    });
    assertRefusedWith('suspended approver, row re-written', rewrite, ERR_NOT_ACTIVE);
    assertPermitted('nulling approver_id', nulled);
  });
});

describe('I-5 clause (b), OE-45 — the account row is read FOR SHARE too, so a concurrent status change cannot race a countersignature', () => {
  test('a SUSPEND of the approver’s account WAITS on an open countersignature, and times out (55P03)', async () => {
    const acc = ACC.tsSeniorScratch;
    const a = nextApprovalId();
    await asSuperuser(insertPending(a, 'safeguarding_referral#make', ACC.dsl));
    const countersigning = asApp('BEGIN', countersign(a, acc), 'SELECT pg_sleep(4)', 'ROLLBACK');
    await sleep(1500);
    const suspend = await asApp(
      'BEGIN',
      "SET LOCAL lock_timeout = '1s'",
      `UPDATE public.account SET status = 'suspended' WHERE id = '${acc}'`,
      'ROLLBACK',
    );
    const cs = await countersigning;
    await db.sql({ commands: [`DELETE FROM public.approval WHERE id = '${a}'`] });
    assertPermitted('the countersignature transaction', cs);
    assertRefusedWith(
      'the concurrent suspend',
      suspend,
      'ERROR:  55P03: canceling statement due to lock timeout',
    );
    assert.equal(
      await db.value(`SELECT status::text FROM public.account WHERE id = '${acc}'`),
      'active',
    );
  });

  test('a countersignature that WAITS on an open suspend is REFUSED once the suspend commits (KV054)', async () => {
    const acc = ACC.tsSeniorScratch;
    assert.equal(
      await db.value(`SELECT status::text FROM public.account WHERE id = '${acc}'`),
      'active',
      'precondition',
    );
    const a = nextApprovalId();
    await asSuperuser(insertPending(a, 'safeguarding_referral#make', ACC.dsl));
    const suspending = asApp(
      'BEGIN',
      `UPDATE public.account SET status = 'suspended' WHERE id = '${acc}'`,
      'SELECT pg_sleep(3)',
      'COMMIT',
    );
    await sleep(1500);
    const cs = await asApp(countersign(a, acc));
    const sp = await suspending;
    const stored = await db.value(storedRow(a));
    await db.sql({
      commands: [
        `UPDATE public.account SET status = 'active' WHERE id = '${acc}'`,
        `DELETE FROM public.approval WHERE id = '${a}'`,
      ],
    });
    assertPermitted('the suspend transaction', sp);
    assertRefusedWith('the waiting countersignature', cs, ERR_NOT_ACTIVE);
    assert.ok(stored.startsWith('-|'), `nothing countersigned: ${stored}`);
  });
});

describe('I-5 clause (b), OE-45 — LIMITATION (decisions.md OD-222): app_rw writes account.status, so it can make a non-active approver active around a countersignature', () => {
  test('LIMITATION — app_rw, ONE transaction: set a SUSPENDED ts_senior account active, countersign, set it back, COMMIT: ACCEPTED, and the stored approver is suspended', async () => {
    const acc = ACC.suspended;
    const a = nextApprovalId();
    const r = await asApp(
      'BEGIN',
      insertPending(a, 'safeguarding_referral#make', ACC.dsl),
      `UPDATE public.account SET status = 'active' WHERE id = '${acc}'`,
      countersign(a, acc),
      `UPDATE public.account SET status = 'suspended' WHERE id = '${acc}'`,
      'COMMIT',
    );
    const stored = await db.value(
      `SELECT (${storedRow(a)}) || '#' || (SELECT status::text FROM public.account WHERE id = '${acc}')`,
    );
    await db.sql({ commands: [`DELETE FROM public.approval WHERE id = '${a}'`] });
    assertPermitted('OD-222 transaction', r);
    assert.ok(
      stored.startsWith(`${acc}|approve|t030|`) && stored.endsWith('#suspended'),
      `OD-222: a suspended approver's countersignature committed: ${stored}`,
    );
    assert.equal(await db.value(storedRow(a)), '(none)', 'cleaned up');
  });
});

/** Every account_role row, byte for byte, so an attack can be shown to leave no trace. */
const ROLE_TABLE = `SELECT string_agg(account_id || ':' || role || ':' || coalesce(granted_by, '-') || ':'
                        || granted_at::text || ':' || coalesce(revoked_at::text, 'LIVE'), ' | '
                        ORDER BY account_id COLLATE "C", role COLLATE "C")
                     FROM public.account_role`;
/** Live ts_senior rows an account holds. */
const liveTsSenior = (acc: string): string =>
  `SELECT count(*)::text FROM public.account_role
    WHERE account_id = '${acc}' AND role = 'ts_senior' AND revoked_at IS NULL`;

/**
 * T-186, OE-47: only app_admin_rw may grant, revoke, un-revoke or move a ts_senior row. QA's
 * three routes (T-030 QA-F1) were pinned here as ACCEPTED until T-186; each is now REFUSED for
 * app_rw at its first ts_senior write (KV053), nothing is stored, account_role is byte-identical
 * afterwards, and each has an app_admin_rw CONTROL showing the same write IS accepted from the
 * principal OE-47 admits (inside BEGIN … ROLLBACK, the row read back before the rollback).
 */
describe('I-5 clause (b), OE-47 — app_rw cannot write a ts_senior row, so QA-F1 B2/B3/B4 are REFUSED (KV053); app_admin_rw may', () => {
  test('B2 — app_rw, ONE transaction: un-revoke a revoked ts_senior, countersign, write revoked_at back: REFUSED at the un-revoke (KV053), and nothing is stored', async () => {
    const before = await db.value(ROLE_TABLE);
    assert.equal(await db.value(liveTsSenior(ACC.revoked)), '0', 'precondition: revoked');
    const revokedAt = await db.value(
      `SELECT revoked_at::text FROM public.account_role WHERE account_id = '${ACC.revoked}' AND role = 'ts_senior'`,
    );
    const a = nextApprovalId();
    const r = await asApp(
      'BEGIN',
      insertPending(a, 'safeguarding_referral#make', ACC.dsl),
      UNREVOKE_TS(ACC.revoked),
      countersign(a, ACC.revoked),
      `UPDATE public.account_role SET revoked_at = '${revokedAt}' WHERE account_id = '${ACC.revoked}' AND role = 'ts_senior'`,
      'COMMIT',
    );
    assertRefusedWith('B2', r, errTsSeniorWrite('UPDATE', LOGINS.app_rw));
    assert.equal(await db.value(storedRow(a)), '(none)', 'B2: nothing stored');
    assert.equal(await db.value(ROLE_TABLE), before, 'B2: account_role unchanged');
  });

  test('B2 CONTROL — app_admin_rw un-revokes the same ts_senior: accepted, and the row reads live before the rollback', async () => {
    const r = await db.psql({
      user: LOGINS.app_admin_rw,
      password: PROBE_PASSWORD,
      raw: true,
      verbose: true,
      stopOnError: true,
      commands: [
        'BEGIN',
        UNREVOKE_TS(ACC.revoked),
        `SELECT 'live=' || (${liveTsSenior(ACC.revoked)})`,
        'ROLLBACK',
      ],
    });
    assertPermitted('admin un-revoke', r);
    assert.ok(r.stdout.includes('live=1'), `admin un-revoke landed.\n${r.output}`);
    assert.equal(await db.value(liveTsSenior(ACC.revoked)), '0', 'rolled back');
  });

  test('B3 — app_rw, ONE transaction: move a live ts_senior row onto a no-role account, countersign as it, move it back: REFUSED at the move (KV053), and nothing is stored', async () => {
    const before = await db.value(ROLE_TABLE);
    assert.equal(await db.value(liveTsSenior(ACC.noRole)), '0', 'precondition: no role');
    const a = nextApprovalId();
    const r = await asApp(
      'BEGIN',
      insertPending(a, 'safeguarding_referral#make', ACC.dsl),
      `UPDATE public.account_role SET account_id = '${ACC.noRole}' WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      countersign(a, ACC.noRole),
      `UPDATE public.account_role SET account_id = '${ACC.tsSenior}' WHERE account_id = '${ACC.noRole}' AND role = 'ts_senior'`,
      'COMMIT',
    );
    assertRefusedWith('B3', r, errTsSeniorWrite('UPDATE', LOGINS.app_rw));
    assert.equal(await db.value(storedRow(a)), '(none)', 'B3: nothing stored');
    assert.equal(await db.value(ROLE_TABLE), before, 'B3: account_role unchanged');
  });

  test('B3 CONTROL — app_admin_rw moves the same row: accepted, and the row reads moved before the rollback', async () => {
    const r = await db.psql({
      user: LOGINS.app_admin_rw,
      password: PROBE_PASSWORD,
      raw: true,
      verbose: true,
      stopOnError: true,
      commands: [
        'BEGIN',
        `UPDATE public.account_role SET account_id = '${ACC.noRole}' WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
        `SELECT 'moved=' || (${liveTsSenior(ACC.noRole)})`,
        'ROLLBACK',
      ],
    });
    assertPermitted('admin move', r);
    assert.ok(r.stdout.includes('moved=1'), `admin move landed.\n${r.output}`);
    assert.equal(await db.value(liveTsSenior(ACC.tsSenior)), '1', 'rolled back');
  });

  test('B4 — app_rw grants ts_senior to a no-role account: REFUSED (KV053), and a later countersignature by it is REFUSED (KV052)', async () => {
    const before = await db.value(ROLE_TABLE);
    const grant = await asApp(
      `INSERT INTO public.account_role (account_id, role) VALUES ('${ACC.noRole}', 'ts_senior')`,
    );
    const a = nextApprovalId();
    const cs = await asApp(
      'BEGIN',
      insertPending(a, 'retention_run#approve', ACC.compliance),
      countersign(a, ACC.noRole),
      'COMMIT',
    );
    assertRefusedWith('B4 grant by app_rw', grant, errTsSeniorWrite('INSERT', LOGINS.app_rw));
    assertRefusedWith('B4 countersignature', cs, ERR_NOT_TS_SENIOR);
    assert.equal(await db.value(storedRow(a)), '(none)', 'B4: nothing stored');
    assert.equal(await db.value(ROLE_TABLE), before, 'B4: account_role unchanged');
  });

  test('B4 CONTROL — app_admin_rw grants ts_senior (committed); a later countersignature by that account is accepted and stored', async () => {
    const grant = await asAdmin(
      `INSERT INTO public.account_role (account_id, role, granted_by) VALUES ('${ACC.noRole}', 'ts_senior', '${ACC.tsSenior}')`,
    );
    const a = nextApprovalId();
    const cs = await asApp(
      insertPending(a, 'retention_run#approve', ACC.compliance),
      countersign(a, ACC.noRole),
    );
    const stored = await db.value(storedRow(a));
    await db.sql({
      commands: [
        `DELETE FROM public.approval WHERE id = '${a}'`,
        `DELETE FROM public.account_role WHERE account_id = '${ACC.noRole}'`,
      ],
    });
    assertPermitted('B4 control grant by app_admin_rw', grant);
    assertPermitted('B4 control countersignature', cs);
    assert.ok(stored.startsWith(`${ACC.noRole}|approve|t030|`), `B4 control stored: ${stored}`);
    assert.equal(
      await db.value(
        `SELECT count(*)::text FROM public.account_role WHERE account_id = '${ACC.noRole}'`,
      ),
      '0',
      'cleaned up',
    );
  });

  test('app_rw is refused every other way of writing a ts_senior row: re-role TO ts_senior, re-role AWAY from it, an upsert un-revoke, a MERGE un-revoke (each KV053)', async () => {
    const before = await db.value(ROLE_TABLE);
    const cases: readonly [string, 'INSERT' | 'UPDATE', string][] = [
      [
        're-role a parent row to ts_senior',
        'UPDATE',
        `UPDATE public.account_role SET role = 'ts_senior' WHERE account_id = '${ACC.parent}' AND role = 'parent'`,
      ],
      [
        're-role a ts_senior row to parent',
        'UPDATE',
        `UPDATE public.account_role SET role = 'parent' WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      ],
      [
        // A BEFORE INSERT trigger fires on the proposed row before the conflict is found.
        'INSERT … ON CONFLICT DO UPDATE un-revoking a ts_senior',
        'INSERT',
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACC.revoked}', 'ts_senior')
           ON CONFLICT (account_id, role) DO UPDATE SET revoked_at = NULL`,
      ],
      [
        'MERGE un-revoking a ts_senior',
        'UPDATE',
        `MERGE INTO public.account_role ar USING (SELECT '${ACC.revoked}'::char(26) AS a) s
           ON ar.account_id = s.a AND ar.role = 'ts_senior'
           WHEN MATCHED THEN UPDATE SET revoked_at = NULL`,
      ],
    ];
    for (const [what, op, sql] of cases) {
      assertRefusedWith(what, await asApp('BEGIN', sql), errTsSeniorWrite(op, LOGINS.app_rw));
    }
    assert.equal(await db.value(ROLE_TABLE), before, 'account_role unchanged');
  });

  test('CONTROL — app_rw still writes every role that is not ts_senior: a parent row inserted and revoked, read back before the rollback', async () => {
    const r = await db.psql({
      user: LOGINS.app_rw,
      password: PROBE_PASSWORD,
      raw: true,
      verbose: true,
      stopOnError: true,
      commands: [
        'BEGIN',
        `INSERT INTO public.account_role (account_id, role) VALUES ('${ACC.noRole}', 'parent')`,
        `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACC.noRole}' AND role = 'parent'`,
        `SELECT 'rows=' || count(*) || ',revoked=' || count(revoked_at) FROM public.account_role WHERE account_id = '${ACC.noRole}'`,
        'ROLLBACK',
      ],
    });
    assertPermitted('app_rw writes a parent row', r);
    assert.ok(r.stdout.includes('rows=1,revoked=1'), `app_rw write landed.\n${r.output}`);
  });

  test('app_ddl, the owner of account_role, is refused too (KV053 on UPDATE and on DELETE); app_rw and app_admin_rw hold no DELETE (42501)', async () => {
    const before = await db.value(ROLE_TABLE);
    assertRefusedWith(
      'app_ddl un-revoke',
      await asLogin(LOGINS.app_ddl, 'BEGIN', UNREVOKE_TS(ACC.revoked)),
      errTsSeniorWrite('UPDATE', LOGINS.app_ddl),
    );
    assertRefusedWith(
      'app_ddl delete',
      await asLogin(
        LOGINS.app_ddl,
        'BEGIN',
        `DELETE FROM public.account_role WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      ),
      errTsSeniorWrite('DELETE', LOGINS.app_ddl),
    );
    for (const login of [LOGINS.app_rw, LOGINS.app_admin_rw]) {
      assertRefusedWith(
        `${login} delete`,
        await asLogin(
          login,
          'BEGIN',
          `DELETE FROM public.account_role WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
        ),
        'ERROR:  42501: permission denied for table account_role',
      );
    }
    assert.equal(await db.value(ROLE_TABLE), before, 'account_role unchanged');
  });
});

/**
 * What a countersigned row does NOT bind (T-030 QA-F2), pinned as LIMITATION cases. Since T-186
 * each COMMITS as app_rw and the row is then read back in a separate session, so a mechanism that
 * silently dropped or rewrote the row (QA's QM4 plant) turns the case red instead of leaving it
 * green on psql's exit status alone (QA2-A1). RP1 covers every column a consumer must bind,
 * decision, rationale and approved_at included (T-030 tech-lead C4 (i), QA2-A2).
 */
describe('I-5 — what a countersigned row does NOT bind (T-030 QA-F2): the consumer must (T-186 § Published contract)', () => {
  test('LIMITATION RP1 — after a valid countersignature, app_rw re-points action, subject_type, subject_id and submitter_id, and rewrites decision, rationale and approved_at: each ACCEPTED and STORED, and the countersignature stands', async () => {
    const a = nextApprovalId();
    const r = await asApp(
      'BEGIN',
      insertPending(a, 'safeguarding_referral#make', ACC.dsl),
      countersign(a, ACC.tsSenior),
      'COMMIT',
      `UPDATE public.approval SET action = 'account#remove_permanently' WHERE id = '${a}'`,
      `UPDATE public.approval SET subject_type = 'account', subject_id = '${id('OTHERSUBJ')}' WHERE id = '${a}'`,
      `UPDATE public.approval SET submitter_id = '${ACC.compliance}' WHERE id = '${a}'`,
      `UPDATE public.approval SET decision = 'reject' WHERE id = '${a}'`,
      `UPDATE public.approval SET rationale = 'rewritten' WHERE id = '${a}'`,
      `UPDATE public.approval SET approved_at = '2020-01-01 00:00:00+00' WHERE id = '${a}'`,
    );
    const stored = await db.value(
      `SELECT coalesce((SELECT action || '|' || subject_type || '|' || subject_id || '|' || submitter_id
                               || '|' || approver_id || '|' || decision || '|' || rationale || '|'
                               || to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
                          FROM public.approval WHERE id = '${a}'), '(none)')`,
    );
    await db.sql({ commands: [`DELETE FROM public.approval WHERE id = '${a}'`] });
    assertPermitted('RP1', r);
    assert.equal(
      stored,
      `account#remove_permanently|account|${id('OTHERSUBJ')}|${ACC.compliance}|${ACC.tsSenior}|reject|rewritten|2020-01-01 00:00:00`,
      'RP1: every re-point and rewrite was stored, and the countersignature stands',
    );
  });

  test('LIMITATION RP2 — an approver set with decision NULL, and with decision reject, are both ACCEPTED and STORED: approver_id IS NOT NULL does not mean approved', async () => {
    const [a1, a2] = [nextApprovalId(), nextApprovalId()];
    const withDecision = (approvalId: string, decision: string): string =>
      `INSERT INTO public.approval (id, subject_type, subject_id, action, submitter_id, submitted_at,
                                    approver_id, approved_at, decision)
         VALUES ('${approvalId}', 'case', '${id('SUBJECT')}', 'retention_run#approve',
                 '${ACC.compliance}', now(), '${ACC.tsSenior}', now(), ${decision})`;
    const r = await asApp(withDecision(a1, 'NULL'), withDecision(a2, "'reject'"));
    const stored = await db.value(`SELECT (${storedRow(a1)}) || '#' || (${storedRow(a2)})`);
    await db.sql({ commands: [`DELETE FROM public.approval WHERE id IN ('${a1}', '${a2}')`] });
    assertPermitted('RP2', r);
    assert.ok(
      new RegExp(`^${ACC.tsSenior}\\|-\\|-\\|[^#]+#${ACC.tsSenior}\\|reject\\|-\\|`).test(stored),
      `RP2: both rows stored with the approver set, decisions NULL and reject: ${stored}`,
    );
  });
});

describe('I-5 clause (b) — the race under REPEATABLE READ and SERIALIZABLE (T-030 QA-A3): refused 40001, not KV052', () => {
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
    test(`${level}: a countersignature whose snapshot predates a committed revoke of its approver's ts_senior is REFUSED (40001)`, async () => {
      assert.equal(await db.value(liveTsSenior(ACC.tsSenior)), '1', 'precondition: ts_senior live');
      const a = nextApprovalId();
      await asSuperuser(insertPending(a, 'safeguarding_referral#make', ACC.dsl));
      const countersigning = asApp(
        `BEGIN ISOLATION LEVEL ${level}`,
        // Takes the snapshot, which still sees the ts_senior live.
        `SELECT count(*) FROM public.account_role WHERE account_id = '${ACC.tsSenior}' AND revoked_at IS NULL`,
        'SELECT pg_sleep(3)',
        countersign(a, ACC.tsSenior),
        'COMMIT',
      );
      await sleep(1500);
      const revoke = await asAdmin(REVOKE_TS(ACC.tsSenior));
      const cs = await countersigning;
      // Restore before judging.
      await db.sql({
        commands: [
          `UPDATE public.account_role SET revoked_at = NULL WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
        ],
      });
      assertPermitted('the committed revoke', revoke);
      assertRefusedWith(
        `${level} countersignature`,
        cs,
        'ERROR:  40001: could not serialize access due to concurrent update',
      );
      assert.equal(
        await db.value(
          `SELECT (${liveTsSenior(ACC.tsSenior)}) || '|' || (SELECT coalesce(approver_id, '(none)') FROM public.approval WHERE id = '${a}')`,
        ),
        '1|(none)',
      );
    });
  }
});

describe('the generic machinery — assert_second_actor_differs(first, second) on another table', () => {
  test('attached to a table with NO CHECK, its own clause (a) refuses the same actor (KV051), and absence of the first actor (KV051)', async () => {
    const r = await asSuperuser(
      'BEGIN',
      'CREATE TABLE public.t030_generic (first_actor text, second_actor text)',
      `CREATE TRIGGER t030_generic_four_eyes AFTER INSERT OR UPDATE ON public.t030_generic
         FOR EACH ROW EXECUTE FUNCTION public.assert_second_actor_differs('first_actor', 'second_actor')`,
      `INSERT INTO public.t030_generic VALUES ('${ACC.tsSenior}', '${ACC.tsSenior}')`,
    );
    assertRefusedWith(
      'generic same actor',
      r,
      'ERROR:  KV051: I5_SECOND_ACTOR_NOT_DIFFERENT: public.t030_generic requires second_actor to be a different actor from first_actor',
    );
    const r2 = await asSuperuser(
      'BEGIN',
      'CREATE TABLE public.t030_generic (first_actor text, second_actor text)',
      `CREATE TRIGGER t030_generic_four_eyes AFTER INSERT OR UPDATE ON public.t030_generic
         FOR EACH ROW EXECUTE FUNCTION public.assert_second_actor_differs('first_actor', 'second_actor')`,
      `INSERT INTO public.t030_generic VALUES (NULL, '${ACC.tsSenior}')`,
    );
    assertRefusedWith(
      'generic absent first actor',
      r2,
      'ERROR:  KV051: I5_SECOND_ACTOR_NOT_DIFFERENT: public.t030_generic requires second_actor to be a different actor from first_actor',
    );
  });

  test('on that table, a second actor without ts_senior is REFUSED (KV052); CONTROL — a ts_senior, and no second actor, are accepted', async () => {
    const setup = [
      'BEGIN',
      'CREATE TABLE public.t030_generic (first_actor text, second_actor text)',
      `CREATE TRIGGER t030_generic_four_eyes AFTER INSERT OR UPDATE ON public.t030_generic
         FOR EACH ROW EXECUTE FUNCTION public.assert_second_actor_differs('first_actor', 'second_actor')`,
    ];
    assertRefusedWith(
      'generic no ts_senior',
      await asSuperuser(
        ...setup,
        `INSERT INTO public.t030_generic VALUES ('${ACC.dsl}', '${ACC.seniorElse}')`,
      ),
      'ERROR:  KV052: I5_APPROVER_LACKS_TS_SENIOR: public.t030_generic.second_actor holds no unrevoked ts_senior role',
    );
    assertPermitted(
      'generic ts_senior; generic pending',
      await asSuperuser(
        ...setup,
        `INSERT INTO public.t030_generic VALUES ('${ACC.dsl}', '${ACC.tsSenior}')`,
        `INSERT INTO public.t030_generic VALUES ('${ACC.dsl}', NULL)`,
        'ROLLBACK',
      ),
    );
  });

  test('a trigger naming a column the row does not have is REFUSED when it fires (KV050), never read as "not countersigned"', async () => {
    assertRefusedWith(
      'misnamed column',
      await asSuperuser(
        'BEGIN',
        'CREATE TABLE public.t030_generic (first_actor text, second_actor text)',
        `CREATE TRIGGER t030_generic_four_eyes AFTER INSERT ON public.t030_generic
           FOR EACH ROW EXECUTE FUNCTION public.assert_second_actor_differs('first_actor', 'secnd_actor')`,
        `INSERT INTO public.t030_generic VALUES ('${ACC.dsl}', NULL)`,
      ),
      'ERROR:  KV050: I5_TRIGGER_MISCONFIGURED: trigger t030_generic_four_eyes on public.t030_generic must name two columns of the row',
    );
    assertRefusedWith(
      'one argument',
      await asSuperuser(
        'BEGIN',
        'CREATE TABLE public.t030_generic (first_actor text, second_actor text)',
        `CREATE TRIGGER t030_generic_four_eyes AFTER INSERT ON public.t030_generic
           FOR EACH ROW EXECUTE FUNCTION public.assert_second_actor_differs('first_actor')`,
        `INSERT INTO public.t030_generic VALUES ('${ACC.dsl}', '${ACC.tsSenior}')`,
      ),
      'ERROR:  KV050: I5_TRIGGER_MISCONFIGURED',
    );
    assert.equal(
      await db.value(`SELECT (to_regclass('public.t030_generic') IS NULL)::text`),
      'true',
    );
  });
});

describe('0007 — grants', () => {
  for (const role of ['answering_service', 'app_safety_rw', 'app_admin_rw'] as const) {
    test(`${role}: SELECT on approval is REFUSED (42501)`, async () => {
      assertRefusedWith(
        `${role} SELECT approval`,
        await asLogin(LOGINS[role], 'SELECT id FROM public.approval'),
        'ERROR:  42501: permission denied for table approval',
      );
    });
  }

  test('app_rw: DELETE on approval is REFUSED (42501)', async () => {
    assertRefusedWith(
      'app_rw DELETE approval',
      await asApp('DELETE FROM public.approval'),
      'ERROR:  42501: permission denied for table approval',
    );
  });

  test('GRANT SELECT ON approval TO answering_service is REFUSED at the GRANT by the SA §INT-10 guard', async () => {
    assertRefused(
      'grant to the vendor',
      await asSuperuser('GRANT SELECT ON public.approval TO answering_service'),
      {
        message: INT10_RAISE,
      },
    );
    assert.equal(
      await db.value(
        `SELECT has_table_privilege('answering_service', 'public.approval', 'SELECT')::text`,
      ),
      'false',
    );
  });

  test('a role that may write approval but cannot read account_role is REFUSED at the countersignature (42501): the invoker trigger fails closed', async () => {
    const a = nextApprovalId();
    // Granted here, not in beforeAll, so the exact-ACL test above reads 0007's ACL alone.
    const grants = [
      `GRANT CONNECT ON DATABASE kinvara TO ${APPROVAL_ONLY_LOGIN}`,
      `GRANT USAGE ON SCHEMA public TO ${APPROVAL_ONLY_LOGIN}`,
      `GRANT SELECT, INSERT, UPDATE ON public.approval TO ${APPROVAL_ONLY_LOGIN}`,
    ];
    await db.sql({ commands: grants });
    const control = await asLogin(
      APPROVAL_ONLY_LOGIN,
      'BEGIN',
      insertPending(a, 'retention_run#approve', ACC.compliance),
      'ROLLBACK',
    );
    const r = await asLogin(
      APPROVAL_ONLY_LOGIN,
      'BEGIN',
      insertPending(a, 'retention_run#approve', ACC.compliance),
      countersign(a, ACC.tsSenior),
    );
    await db.sql({
      commands: grants.map((g) => g.replace(/^GRANT/, 'REVOKE').replace(' TO ', ' FROM ')),
    });
    assertPermitted('CONTROL — the same login may insert a pending approval', control);
    assertRefusedWith(
      'approval-only login countersigns',
      r,
      'ERROR:  42501: permission denied for table account_role',
    );
    assert.equal(
      await db.value(`SELECT relacl::text FROM pg_class WHERE oid = 'public.approval'::regclass`),
      '{app_ddl=arwdDxtm/app_ddl,app_rw=arw/app_ddl}',
    );
  });

  test('T-186: a role that may write approval and lock account_role but cannot read account is REFUSED at the countersignature (42501): the status read fails closed too', async () => {
    const a = nextApprovalId();
    const grants = [
      `GRANT CONNECT ON DATABASE kinvara TO ${APPROVAL_ONLY_LOGIN}`,
      `GRANT USAGE ON SCHEMA public TO ${APPROVAL_ONLY_LOGIN}`,
      `GRANT SELECT, INSERT, UPDATE ON public.approval TO ${APPROVAL_ONLY_LOGIN}`,
      `GRANT SELECT, UPDATE ON public.account_role TO ${APPROVAL_ONLY_LOGIN}`,
    ];
    await db.sql({ commands: grants });
    const r = await asLogin(
      APPROVAL_ONLY_LOGIN,
      'BEGIN',
      insertPending(a, 'retention_run#approve', ACC.compliance),
      countersign(a, ACC.tsSenior),
    );
    await db.sql({
      commands: grants.map((g) => g.replace(/^GRANT/, 'REVOKE').replace(' TO ', ' FROM ')),
    });
    assertRefusedWith(
      'approval + account_role login countersigns',
      r,
      'ERROR:  42501: permission denied for table account',
    );
    assert.equal(
      await db.value(
        `SELECT relacl::text FROM pg_class WHERE oid = 'public.account_role'::regclass`,
      ),
      '{app_ddl=arwdDxtm/app_ddl,app_rw=arw/app_ddl,app_admin_rw=arw/app_ddl}',
    );
  });

  test('after 0008 the SA §INT-10 guard, called directly, returns clean', async () => {
    assertPermitted(
      'guard direct call',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });
});

describe('sod_finance_ts on the UPDATE path (T-140 QA-A3 N2a–N2c; T-030 builds on it)', () => {
  test('un-revoking finance while ts_operator is live is REFUSED by sod_finance_ts (23505)', async () => {
    assertRefusedWith(
      'N2a',
      await asApp(
        'BEGIN',
        `UPDATE public.account_role SET revoked_at = NULL WHERE account_id = '${ACC.sodFinance}' AND role = 'finance'`,
      ),
      'ERROR:  23505: duplicate key value violates unique constraint "sod_finance_ts"',
      'sod_finance_ts',
    );
  });

  test('re-roling a live parent to finance while ts_operator is live is REFUSED by sod_finance_ts (23505)', async () => {
    assertRefusedWith(
      'N2b',
      await asApp(
        'BEGIN',
        `UPDATE public.account_role SET role = 'finance' WHERE account_id = '${ACC.sodB}' AND role = 'parent'`,
      ),
      'ERROR:  23505: duplicate key value violates unique constraint "sod_finance_ts"',
      'sod_finance_ts',
    );
  });

  test('moving a live ts_operator onto an account holding live finance is REFUSED by sod_finance_ts (23505)', async () => {
    assertRefusedWith(
      'N2c',
      await asApp(
        'BEGIN',
        `UPDATE public.account_role SET account_id = '${ACC.sodC}' WHERE account_id = '${ACC.sodB}' AND role = 'ts_operator'`,
      ),
      'ERROR:  23505: duplicate key value violates unique constraint "sod_finance_ts"',
      'sod_finance_ts',
    );
  });

  test('CONTROL — revoke ts_operator, then un-revoke finance: accepted', async () => {
    assertPermitted(
      'N2 control',
      await asApp(
        'BEGIN',
        `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACC.sodFinance}' AND role = 'ts_operator'`,
        `UPDATE public.account_role SET revoked_at = NULL WHERE account_id = '${ACC.sodFinance}' AND role = 'finance'`,
        'ROLLBACK',
      ),
    );
  });
});

describe('after the refusals', () => {
  test('no approval row survived the refused statements, and the ts_senior fixture is live', async () => {
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM public.approval WHERE approver_id IS NOT NULL) || '|' ||
                (SELECT (revoked_at IS NULL)::text FROM public.account_role
                  WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior')`,
      ),
      '0|true',
    );
  });
});
