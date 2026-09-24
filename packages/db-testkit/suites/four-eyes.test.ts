/**
 * T-030 — SA §SA-4 I-5, four-eyes approvals, at the DATABASE layer (migration 0007).
 *
 * I-5 has two clauses this suite refuses:
 *   (a) the approver is a different actor from the submitter — SD's CHECK
 *       `approval_distinct_actors` (23514), and the trigger's case/whitespace-folded
 *       comparison (KV051);
 *   (b) the approver holds an unrevoked `ts_senior` role — decisions.md OE-21, "ts_senior
 *       ONLY", whoever performed the action — held by the trigger
 *       `trg_approval_four_eyes` → `public.assert_second_actor_differs()` (KV052), reading
 *       account_role as the countersigning transaction sees it. That holds only against a
 *       principal that cannot write ts_senior rows; app_rw can, and the LIMITATION B2/B3/B4
 *       cases below pin the route it leaves OPEN until T-186 (decisions.md OE-47; QA-F1).
 *
 * The LIMITATION RP1/RP2 cases pin what a countersigned row does not bind (QA-F2): the
 * consumer obligation is in T-030 § contract §7.
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
  /** status 'suspended', with a LIVE ts_senior role. */
  suspended: id('SUSPENDED'),
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
      `INSERT INTO public.account (id, pseudonym, tos_version, status)
         VALUES ('${acc}', '${id(`PSEUDO${String(i).padStart(2, '0')}`)}', 't030-tos',
                 '${acc === ACC.suspended ? 'suspended' : 'pending'}')`,
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
          WHERE account_id IN ('${ACC.tsSenior}', '${ACC.seniorElse}', '${ACC.revoked}', '${ACC.suspended}')`,
      ),
      [
        `${ACC.revoked}:ts_senior:false`,
        `${ACC.seniorElse}:compliance:true`,
        `${ACC.seniorElse}:deputy_dsl:true`,
        `${ACC.seniorElse}:dsl:true`,
        `${ACC.suspended}:ts_senior:true`,
        `${ACC.tsSenior}:ts_senior:true`,
      ]
        .sort()
        .join(','),
    );
    assert.equal(
      await db.value(`SELECT status::text FROM public.account WHERE id = '${ACC.suspended}'`),
      'suspended',
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

  test('a later UPDATE of a countersigned row re-checks the approver: once the ts_senior is revoked, re-writing the countersignature is REFUSED (KV052)', async () => {
    const a = nextApprovalId();
    assertRefusedWith(
      'approver revoked, row re-written',
      await asApp(
        'BEGIN',
        insertPending(a, 'retention_run#approve', ACC.compliance),
        countersign(a, ACC.tsSenior),
        `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
        `UPDATE public.approval SET decision = 'reject' WHERE id = '${a}'`,
      ),
      ERR_NOT_TS_SENIOR,
    );
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
    // never commits and cannot leak into the next test's state.
    const revoke = await asApp(
      'BEGIN',
      "SET LOCAL lock_timeout = '1s'",
      `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
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
    const revoking = asApp(
      'BEGIN',
      `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      'SELECT pg_sleep(3)',
      'COMMIT',
    );
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

describe('I-5 — what the trigger does NOT read (stated, not decided: decisions.md)', () => {
  test('LIMITATION — a SUSPENDED account holding a live ts_senior is ACCEPTED: SA §SA-4 I-5, OE-21 and SD name the role only', async () => {
    const a = nextApprovalId();
    assertPermitted(
      'suspended ts_senior countersigns',
      await asApp(
        'BEGIN',
        insertPending(a, 'retention_run#approve', ACC.compliance),
        countersign(a, ACC.suspended),
        'ROLLBACK',
      ),
    );
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

describe('I-5 clause (b) — LIMITATION (T-030 QA-F1): app_rw can write account_role, so it can meet clause (b) for any account. OPEN until T-186 (decisions.md OE-47)', () => {
  // Each case COMMITS, because committing is the finding: the trigger checks account_role as
  // the countersigning transaction sees it, and nothing re-checks at commit. Each restores its
  // own writes as the superuser BEFORE judging, and asserts the restore, so no later test
  // inherits them. T-186 turns each of these into a refusal; this file then changes with it.

  test('LIMITATION B2 — app_rw, ONE transaction: un-revoke a revoked ts_senior, countersign, write revoked_at back, COMMIT: ACCEPTED, and account_role is byte-identical afterwards', async () => {
    const before = await db.value(ROLE_TABLE);
    const revokedAt = await db.value(
      `SELECT revoked_at::text FROM public.account_role WHERE account_id = '${ACC.revoked}' AND role = 'ts_senior'`,
    );
    assert.notEqual(revokedAt, '', 'precondition: the fixture ts_senior is revoked');
    const a = nextApprovalId();
    const r = await asApp(
      'BEGIN',
      insertPending(a, 'safeguarding_referral#make', ACC.dsl),
      `UPDATE public.account_role SET revoked_at = NULL WHERE account_id = '${ACC.revoked}' AND role = 'ts_senior'`,
      countersign(a, ACC.revoked),
      `UPDATE public.account_role SET revoked_at = '${revokedAt}' WHERE account_id = '${ACC.revoked}' AND role = 'ts_senior'`,
      'COMMIT',
    );
    const committed = await db.value(
      `SELECT coalesce(approver_id, '(none)') || '|' || coalesce(decision, '(none)') FROM public.approval WHERE id = '${a}'`,
    );
    const liveAfter = await db.value(liveTsSenior(ACC.revoked));
    const after = await db.value(ROLE_TABLE);
    await db.sql({ commands: [`DELETE FROM public.approval WHERE id = '${a}'`] });
    assertPermitted('B2 transaction', r);
    assert.equal(committed, `${ACC.revoked}|approve`, 'B2: the countersignature committed');
    assert.equal(liveAfter, '0', 'B2: the committed approver holds no live ts_senior');
    assert.equal(after, before, 'B2: account_role is byte-identical before and after');
    assert.equal(await db.value(`SELECT count(*)::text FROM public.approval WHERE id = '${a}'`), '0');
  });

  test('LIMITATION B3 — app_rw, ONE transaction: move a live ts_senior row onto a no-role account, countersign as it, move the row back, COMMIT: ACCEPTED, and account_role is byte-identical afterwards', async () => {
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
    const committed = await db.value(
      `SELECT coalesce(approver_id, '(none)') FROM public.approval WHERE id = '${a}'`,
    );
    const noRoleRows = await db.value(
      `SELECT count(*)::text FROM public.account_role WHERE account_id = '${ACC.noRole}'`,
    );
    const after = await db.value(ROLE_TABLE);
    await db.sql({ commands: [`DELETE FROM public.approval WHERE id = '${a}'`] });
    assertPermitted('B3 transaction', r);
    assert.equal(committed, ACC.noRole, 'B3: the countersignature by a no-role account committed');
    assert.equal(noRoleRows, '0', 'B3: the approver holds no role row in any committed state');
    assert.equal(after, before, 'B3: account_role is byte-identical before and after');
    assert.equal(await db.value(`SELECT count(*)::text FROM public.approval WHERE id = '${a}'`), '0');
  });

  test('LIMITATION B4 — app_rw grants ts_senior to a no-role account and commits; a later countersignature by it is ACCEPTED', async () => {
    assert.equal(await db.value(liveTsSenior(ACC.noRole)), '0', 'precondition: no role');
    const grant = await asApp(
      `INSERT INTO public.account_role (account_id, role) VALUES ('${ACC.noRole}', 'ts_senior')`,
    );
    const a = nextApprovalId();
    const r = await asApp(
      'BEGIN',
      insertPending(a, 'retention_run#approve', ACC.compliance),
      countersign(a, ACC.noRole),
      'COMMIT',
    );
    const committed = await db.value(
      `SELECT coalesce(approver_id, '(none)') FROM public.approval WHERE id = '${a}'`,
    );
    await db.sql({
      commands: [
        `DELETE FROM public.approval WHERE id = '${a}'`,
        `DELETE FROM public.account_role WHERE account_id = '${ACC.noRole}'`,
      ],
    });
    assertPermitted('B4 grant by app_rw', grant);
    assertPermitted('B4 countersignature', r);
    assert.equal(committed, ACC.noRole, 'B4: the countersignature committed');
    assert.equal(
      await db.value(
        `SELECT (SELECT count(*) FROM public.approval WHERE id = '${a}') || '|' ||
                (SELECT count(*) FROM public.account_role WHERE account_id = '${ACC.noRole}')`,
      ),
      '0|0',
    );
  });
});

describe('I-5 — what a countersigned row does NOT bind (T-030 QA-F2): the consumer must (contract §7)', () => {
  test('LIMITATION RP1 — after a valid countersignature, app_rw re-points action, subject_type, subject_id and submitter_id: each ACCEPTED', async () => {
    const a = nextApprovalId();
    const r = await db.psql({
      user: LOGINS.app_rw,
      password: PROBE_PASSWORD,
      raw: true,
      verbose: true,
      stopOnError: true,
      commands: [
        'BEGIN',
        insertPending(a, 'safeguarding_referral#make', ACC.dsl),
        countersign(a, ACC.tsSenior),
        `UPDATE public.approval SET action = 'account#remove_permanently' WHERE id = '${a}'`,
        `UPDATE public.approval SET subject_type = 'account', subject_id = '${id('OTHERSUBJ')}' WHERE id = '${a}'`,
        `UPDATE public.approval SET submitter_id = '${ACC.compliance}' WHERE id = '${a}'`,
        `SELECT 'row=' || action || '|' || subject_type || '|' || subject_id || '|' || submitter_id
                || '|' || approver_id || '|' || decision FROM public.approval WHERE id = '${a}'`,
        'ROLLBACK',
      ],
    });
    assertPermitted('RP1', r);
    assert.ok(
      r.stdout.includes(
        `row=account#remove_permanently|account|${id('OTHERSUBJ')}|${ACC.compliance}|${ACC.tsSenior}|approve`,
      ),
      `RP1: every re-point landed and the countersignature stands.\n${r.output}`,
    );
  });

  test('LIMITATION RP2 — an approver set with decision NULL, and with decision reject, are both ACCEPTED: approver_id IS NOT NULL does not mean approved', async () => {
    const [a1, a2] = [nextApprovalId(), nextApprovalId()];
    const withDecision = (approvalId: string, decision: string): string =>
      `INSERT INTO public.approval (id, subject_type, subject_id, action, submitter_id, submitted_at,
                                    approver_id, approved_at, decision)
         VALUES ('${approvalId}', 'case', '${id('SUBJECT')}', 'retention_run#approve',
                 '${ACC.compliance}', now(), '${ACC.tsSenior}', now(), ${decision})`;
    assertPermitted(
      'RP2',
      await asApp('BEGIN', withDecision(a1, 'NULL'), withDecision(a2, "'reject'"), 'ROLLBACK'),
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
      const revoke = await asApp(
        `UPDATE public.account_role SET revoked_at = now() WHERE account_id = '${ACC.tsSenior}' AND role = 'ts_senior'`,
      );
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

  test('after 0007 the SA §INT-10 guard, called directly, returns clean', async () => {
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
