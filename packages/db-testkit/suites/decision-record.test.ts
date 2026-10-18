/**
 * T-268 — `public.decision_record` and `public.statement_of_reasons` (migration 0031), SD §DB-10
 * lines 2735–2752, append-only for the two application roles (SA §SEC-8; 0001 Section 4).
 * Brief: tasks/state/EP-5/OD-350-cut.md § 4.1.
 *
 * WHAT IS PINNED, each in one assertion:
 *   - each table's columns (name, type, NOT NULL, default) in order;
 *   - each table's catalogue shape (tech-lead failure mode 5): non-internal triggers, rewrite rules,
 *     policies, and both row-level-security flags — '0 triggers, 0 rules, rls=false, force=false,
 *     0 policies'. A trigger, rule or policy added to either table turns this suite red;
 *   - each table's owner and ACL text, the has_table_privilege matrix of the four application-facing
 *     roles over all eight table privileges, and the count of column-level ACLs (zero);
 *   - the non-NOT-NULL constraints of both tables.
 * NOT PINNED: indexes beyond what the two primary keys imply, comments' text, and anything about who
 * writes or what inputs carries (the per-decision_type allowlist is EP-13's; the database checks only
 * that inputs is non-NULL jsonb).
 *
 * WHAT IS REFUSED, each over a REAL LOGIN that is a member of exactly one role (never SET ROLE from a
 * superuser session; T-020 Evidence §4), each asserting psql's exit status AND the ERROR line with its
 * SQLSTATE (src/expect.ts; T-115 § contract TL2-F4):
 *   - app_rw and app_admin_rw: UPDATE, DELETE and TRUNCATE on each table -> 42501;
 *   - app_safety_rw and answering_service: INSERT and SELECT on each table -> 42501;
 *   - a statement_of_reasons row naming an absent decision_record_id -> 23503.
 * "THE MUTATION LANDED". Every UPDATE/DELETE refusal targets a row asserted present beforehand, and
 * the row's text is compared before and after, so the refusal is not a statement that matched
 * nothing. Every INSERT refusal compares the table's row count before and after.
 * CONTROLS, AND WHICH REFUSALS HAVE NONE (narrowed in T-268 rework 1, QA-F1):
 *   - each UPDATE and DELETE refusal of app_rw and app_admin_rw has a CONTROL that grants exactly
 *     that privilege to that role (asserted landed), runs the same statement inside a rolled-back
 *     transaction and sees it succeed, then revokes it (asserted gone);
 *   - one outsider INSERT refusal has a CONTROL of the same form (app_safety_rw into decision_record);
 *     answering_service has none, because the guard refuses the GRANT (tested below);
 *   - the foreign-key refusal's CONTROL drops the foreign key (asserted gone) and runs the same INSERT
 *     as the bootstrap superuser, not as app_rw, so it changes the principal as well as the key; the
 *     refusal's attribution to the key rests on the asserted message naming the constraint;
 *   - the TRUNCATE refusals, the outsider SELECT refusals and the other three outsider INSERT
 *     refusals have NO CONTROL: their attribution rests on the asserted
 *     '42501: permission denied for table <t>' line alone. (TRUNCATE decision_record CASCADE also
 *     needs TRUNCATE on statement_of_reasons: measured by QA, T-268 evidence QA-E6 QA-T1.)
 * The SA §INT-10 guard is called DIRECTLY (OD-76), clean after up and raising on a planted state.
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

const SUITE = 'decision-record';
const DR = 'public.decision_record';
const SOR = 'public.statement_of_reasons';
const TABLES = [DR, SOR] as const;

/** One login per role, each a member of that role alone. */
const LOGINS = {
  app_rw: 't268_app_rw_probe',
  app_admin_rw: 't268_app_admin_rw_probe',
  app_safety_rw: 't268_app_safety_rw_probe',
  answering_service: 't268_answering_service_probe',
} as const;
type Role = keyof typeof LOGINS;
const WRITERS: readonly Role[] = ['app_rw', 'app_admin_rw'];
const OUTSIDERS: readonly Role[] = ['app_safety_rw', 'answering_service'];

/** 26-character ids (char(26)); the content is synthetic. */
const SEED_DR = '01T268SEEDDECISIONRECORD00';
/** A decision_record no statement references, so a DELETE on it is refused by nothing but privilege. */
const SEED_DR_LONE = '01T268SEEDLONEDECISION0000';
const SEED_SOR = '01T268SEEDSTATEMENTREASON0';
const ABSENT_DR = '01T268ABSENTDECISIONREC000';

const DR_INSERT = (id: string): string =>
  `INSERT INTO ${DR} (id, subject_id, decision_type, automated, ruleset_id, ruleset_version, inputs, output, explanation)
     VALUES ('${id}', '01T268SUBJECT0000000000000', 'suspension', true, 'I-8', '1',
             '{"credential_id": "01T268CRED000000000000000"}'::jsonb, 'review_hold', 'synthetic fixture')`;
const SOR_INSERT = (id: string, decisionRecordId: string): string =>
  `INSERT INTO ${SOR} (id, decision_record_id, recipient_id, ground, facts_relied_on, automated_means_used,
                      redress_route, template_version)
     VALUES ('${id}', '${decisionRecordId}', '01T268SUBJECT0000000000000', 'synthetic ground',
             'synthetic facts', true, 'appeal', 'v1')`;

/** An UPDATE and a DELETE per table, each naming the seeded row, each RETURNING its id. */
const MUTATIONS: ReadonlyArray<readonly [table: string, verb: string, sql: string, seed: string]> =
  [
    [
      DR,
      'UPDATE',
      `UPDATE ${DR} SET output = 'tampered' WHERE id = '${SEED_DR_LONE}' RETURNING id`,
      SEED_DR_LONE,
    ],
    [DR, 'DELETE', `DELETE FROM ${DR} WHERE id = '${SEED_DR_LONE}' RETURNING id`, SEED_DR_LONE],
    [
      SOR,
      'UPDATE',
      `UPDATE ${SOR} SET ground = 'tampered' WHERE id = '${SEED_SOR}' RETURNING id`,
      SEED_SOR,
    ],
    [SOR, 'DELETE', `DELETE FROM ${SOR} WHERE id = '${SEED_SOR}' RETURNING id`, SEED_SOR],
  ];

const bare = (table: string): string => table.replace('public.', '');

let db: Cluster;

beforeAll(async () => {
  db = await acquireMigratedCluster(SUITE);
  await db.sql({
    commands: [
      ...Object.entries(LOGINS).map(
        ([role, login]) =>
          `CREATE ROLE ${login} LOGIN PASSWORD '${PROBE_PASSWORD}' IN ROLE ${role}`,
      ),
      DR_INSERT(SEED_DR),
      DR_INSERT(SEED_DR_LONE),
      SOR_INSERT(SEED_SOR, SEED_DR),
    ],
  });
}, 300_000);

afterAll(async () => {
  if (db !== undefined) await db.stop();
});

/** Statements as the bootstrap superuser, in one session, SQLSTATE in the message. */
function asSuperuser(...sql: string[]): Promise<PsqlResult> {
  return db.psql({ commands: sql, verbose: true, stopOnError: true, raw: true });
}

/** Statements over a real login, in one session, SQLSTATE in the message. */
function asLogin(role: Role, ...sql: string[]): Promise<PsqlResult> {
  return db.psql({
    user: LOGINS[role],
    password: PROBE_PASSWORD,
    commands: sql,
    verbose: true,
    stopOnError: true,
    raw: true,
  });
}

/** The row's whole text, or '(absent)'. */
function rowText(table: string, id: string): Promise<string> {
  return db.value(
    `SELECT coalesce((SELECT t::text FROM ${table} t WHERE id = '${id}'), '(absent)')`,
  );
}

function rowCount(table: string): Promise<string> {
  return db.value(`SELECT count(*)::text FROM ${table}`);
}

function hasPriv(role: Role, table: string, priv: string): Promise<string> {
  return db.value(`SELECT has_table_privilege('${role}', '${table}', '${priv}')::text`);
}

describe('0031 — the two tables, pinned', () => {
  test('decision_record has SD 2735–2744 columns in order, with their types, NOT NULLs and defaults', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' not null' ELSE '' END ||
                           coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY attnum)
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE attrelid = '${DR}'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id character(26) not null, subject_id character(26) not null, decision_type text not null, ' +
        'made_at timestamp with time zone not null default now(), automated boolean not null, ruleset_id text, ' +
        'ruleset_version text, inputs jsonb not null, output text not null, explanation text not null, ' +
        'human_reviewed boolean not null default false, reviewer_id character(26), reviewed_at timestamp with time zone, ' +
        'appeal_id character(26), case_id character(26)',
    );
  });

  test('statement_of_reasons has SD 2746–2752 columns in order, with their types, NOT NULLs and defaults', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' not null' ELSE '' END ||
                           coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY attnum)
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE attrelid = '${SOR}'::regclass AND attnum > 0 AND NOT attisdropped`,
      ),
      'id character(26) not null, decision_record_id character(26) not null, recipient_id character(26) not null, ' +
        'ground text not null, facts_relied_on text not null, automated_means_used boolean not null, ' +
        'redress_route text not null, template_version text not null, ' +
        'issued_at timestamp with time zone not null default now(), delivered_at timestamp with time zone',
    );
  });

  for (const table of TABLES) {
    test(`${bare(table)}: no non-internal trigger, no rewrite rule, no row-level security, no policy (failure mode 5)`, async () => {
      assert.equal(
        await db.value(
          `SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) || ' triggers, ' ||
                  (SELECT count(*) FROM pg_rewrite WHERE ev_class = c.oid) || ' rules, rls=' ||
                  c.relrowsecurity || ', force=' || c.relforcerowsecurity || ', ' ||
                  (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || ' policies'
             FROM pg_class c WHERE c.oid = '${table}'::regclass`,
        ),
        '0 triggers, 0 rules, rls=false, force=false, 0 policies',
      );
    });
  }

  test('the keys: two primary keys and the one foreign key, ON DELETE/UPDATE NO ACTION (SD 2736, 2747)', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid), ' ; ' ORDER BY conname)
           FROM pg_constraint WHERE conrelid IN ('${DR}'::regclass, '${SOR}'::regclass) AND contype <> 'n'`,
      ),
      'decision_record:decision_record_pkey:PRIMARY KEY (id) ; ' +
        'statement_of_reasons:statement_of_reasons_decision_record_id_fkey:FOREIGN KEY (decision_record_id) REFERENCES decision_record(id) ; ' +
        'statement_of_reasons:statement_of_reasons_pkey:PRIMARY KEY (id)',
    );
  });

  test('owner and ACL: app_ddl owns both; app_rw and app_admin_rw hold SELECT+INSERT (ar) and nothing else is granted', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(relname || ' ' || pg_get_userbyid(relowner) || ' ' || relacl::text, ' ; ' ORDER BY relname)
           FROM pg_class WHERE oid IN ('${DR}'::regclass, '${SOR}'::regclass)`,
      ),
      'decision_record app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl,app_admin_rw=ar/app_ddl} ; ' +
        'statement_of_reasons app_ddl {app_ddl=arwdDxtm/app_ddl,app_rw=ar/app_ddl,app_admin_rw=ar/app_ddl}',
    );
  });

  test('reachable privileges (has_table_privilege: grants through PUBLIC and membership included), and no column-level ACL', async () => {
    assert.equal(
      await db.value(
        `SELECT string_agg(r || '@' || t || '=' || coalesce(h, '-'), ' ' ORDER BY t, ro) FROM (
           SELECT r, ro, t, string_agg(p, ',' ORDER BY o) FILTER (WHERE has_table_privilege(r, 'public.' || t, p)) AS h
             FROM unnest(ARRAY['app_rw','app_admin_rw','app_safety_rw','answering_service']) WITH ORDINALITY AS x(r, ro)
            CROSS JOIN unnest(ARRAY['decision_record','statement_of_reasons']) AS y(t)
            CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
                       WITH ORDINALITY AS z(p, o)
            GROUP BY r, ro, t) s`,
      ),
      'app_rw@decision_record=SELECT,INSERT app_admin_rw@decision_record=SELECT,INSERT ' +
        'app_safety_rw@decision_record=- answering_service@decision_record=- ' +
        'app_rw@statement_of_reasons=SELECT,INSERT app_admin_rw@statement_of_reasons=SELECT,INSERT ' +
        'app_safety_rw@statement_of_reasons=- answering_service@statement_of_reasons=-',
    );
    assert.equal(
      await db.value(
        `SELECT count(*)::text FROM pg_attribute
          WHERE attrelid IN ('${DR}'::regclass, '${SOR}'::regclass) AND attacl IS NOT NULL`,
      ),
      '0',
    );
  });
});

describe('0031 — grants, over real logins', () => {
  test('each probe is a real login, not a superuser, and a member of exactly its one role', async () => {
    for (const [role, login] of Object.entries(LOGINS)) {
      const r = await db.psql({
        user: login,
        password: PROBE_PASSWORD,
        raw: true,
        commands: [
          `SELECT session_user || '|' || rolsuper || '|' ||
                  (SELECT string_agg(b.rolname, ',') FROM pg_auth_members m
                     JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid)
             FROM pg_roles r WHERE r.rolname = session_user`,
        ],
      });
      assertPermitted(`connect as ${login}`, r);
      assert.equal(r.stdout.trim(), `${login}|false|${role}`);
    }
  });

  for (const role of WRITERS) {
    test(`POSITIVE — ${role} INSERTs a decision_record and its statement_of_reasons, and SELECTs both back`, async () => {
      const suffix = role === 'app_rw' ? 'RW' : 'AD';
      const drId = `01T268POSDR${suffix}0000000000000`;
      const sorId = `01T268POSSR${suffix}0000000000000`;
      const r = await asLogin(
        role,
        DR_INSERT(drId),
        SOR_INSERT(sorId, drId),
        `SELECT d.id || '|' || d.decision_type || '|' || d.human_reviewed || '|' || s.id || '|' || s.automated_means_used
           FROM ${DR} d JOIN ${SOR} s ON s.decision_record_id = d.id WHERE d.id = '${drId}'`,
      );
      assertPermitted(`${role} insert and read`, r);
      assert.ok(
        r.stdout.includes(`${drId}|suspension|false|${sorId}|true`),
        `${role}: the rows were not read back.\n${r.output}`,
      );
    });
  }

  test('the seeded rows the refusals below aim at are present (non-vacuity)', async () => {
    assert.notEqual(await rowText(DR, SEED_DR), '(absent)');
    assert.notEqual(await rowText(DR, SEED_DR_LONE), '(absent)');
    assert.notEqual(await rowText(SOR, SEED_SOR), '(absent)');
  });

  for (const role of WRITERS) {
    for (const [table, verb, sql, seed] of MUTATIONS) {
      test(`${role} ${verb} on ${bare(table)} is REFUSED (42501), and the targeted row is unchanged`, async () => {
        const before = await rowText(table, seed);
        assert.notEqual(before, '(absent)', `the row ${verb} aims at must exist first`);
        assertRefused(`${role} ${verb} ${bare(table)}`, await asLogin(role, sql), {
          message: `ERROR:  42501: permission denied for table ${bare(table)}`,
        });
        assert.equal(await rowText(table, seed), before);
      });
    }
    for (const table of TABLES) {
      test(`${role} TRUNCATE on ${bare(table)} is REFUSED (42501), and the row count is unchanged`, async () => {
        const before = await rowCount(table);
        assert.notEqual(before, '0');
        assertRefused(
          `${role} TRUNCATE ${bare(table)}`,
          await asLogin(role, `TRUNCATE ${table} CASCADE`),
          { message: `ERROR:  42501: permission denied for table ${bare(table)}` },
        );
        assert.equal(await rowCount(table), before);
      });
    }
  }

  // CONTROL for the UPDATE and DELETE refusals above (the TRUNCATE refusals have none): the grant is
  // the only thing refusing them. For each writer, table and verb, the superuser grants the one
  // privilege (asserted landed), the login runs the same statement inside a transaction it rolls back
  // and it RETURNS the seeded id, then the privilege is revoked (asserted gone). If the refusal had
  // any other cause, the statement would fail here too.
  for (const role of WRITERS) {
    for (const [table, verb, sql, seed] of MUTATIONS) {
      test(`CONTROL — with ${verb} granted to ${role} on ${bare(table)}, the same statement succeeds; revoked, it is gone again`, async () => {
        assert.equal(await hasPriv(role, table, verb), 'false');
        assertPermitted('grant', await asSuperuser(`GRANT ${verb} ON ${table} TO ${role}`));
        let r: PsqlResult;
        try {
          assert.equal(await hasPriv(role, table, verb), 'true', 'the GRANT did not land');
          r = await asLogin(role, 'BEGIN', sql, 'ROLLBACK');
        } finally {
          assertPermitted('revoke', await asSuperuser(`REVOKE ${verb} ON ${table} FROM ${role}`));
        }
        assertPermitted(`${role} ${verb} with the grant`, r);
        assert.ok(r.stdout.includes(seed), `${verb} matched no row.\n${r.output}`);
        assert.equal(await hasPriv(role, table, verb), 'false', 'the REVOKE did not land');
        assert.notEqual(await rowText(table, seed), '(absent)');
      });
    }
  }

  for (const role of OUTSIDERS) {
    test(`${role} INSERT into decision_record is REFUSED (42501), and nothing lands`, async () => {
      const before = await rowCount(DR);
      assertRefused(
        `${role} INSERT decision_record`,
        await asLogin(role, DR_INSERT('01T268OUTSIDERDR0000000000')),
        {
          message: 'ERROR:  42501: permission denied for table decision_record',
        },
      );
      assert.equal(await rowCount(DR), before);
    });
    test(`${role} INSERT into statement_of_reasons is REFUSED (42501), and nothing lands`, async () => {
      const before = await rowCount(SOR);
      assertRefused(
        `${role} INSERT statement_of_reasons`,
        await asLogin(role, SOR_INSERT('01T268OUTSIDERSR0000000000', SEED_DR)),
        { message: 'ERROR:  42501: permission denied for table statement_of_reasons' },
      );
      assert.equal(await rowCount(SOR), before);
    });
    for (const table of TABLES) {
      test(`${role} SELECT on ${bare(table)} is REFUSED (42501)`, async () => {
        assertRefused(
          `${role} SELECT ${bare(table)}`,
          await asLogin(role, `SELECT id FROM ${table}`),
          {
            message: `ERROR:  42501: permission denied for table ${bare(table)}`,
          },
        );
      });
    }
  }

  test('CONTROL — with INSERT granted to app_safety_rw on decision_record, its INSERT succeeds; revoked, it is gone again', async () => {
    // answering_service is not given this control: the guard refuses any such GRANT (tested below).
    assertPermitted('grant', await asSuperuser(`GRANT INSERT ON ${DR} TO app_safety_rw`));
    let r: PsqlResult;
    try {
      assert.equal(await hasPriv('app_safety_rw', DR, 'INSERT'), 'true', 'the GRANT did not land');
      r = await asLogin(
        'app_safety_rw',
        'BEGIN',
        DR_INSERT('01T268SAFETYCONTROL0000000'),
        'ROLLBACK',
      );
    } finally {
      assertPermitted('revoke', await asSuperuser(`REVOKE INSERT ON ${DR} FROM app_safety_rw`));
    }
    assertPermitted('app_safety_rw INSERT with the grant', r);
    assert.equal(await hasPriv('app_safety_rw', DR, 'INSERT'), 'false', 'the REVOKE did not land');
  });
});

describe('0031 — the foreign key', () => {
  test('a statement_of_reasons naming an absent decision_record_id is REFUSED by statement_of_reasons_decision_record_id_fkey (23503), as app_rw', async () => {
    assert.equal(await rowText(DR, ABSENT_DR), '(absent)', 'the id must really be absent');
    const before = await rowCount(SOR);
    const r = await asLogin('app_rw', SOR_INSERT('01T268ORPHANSTATEMENT00000', ABSENT_DR));
    assertRefused('orphan statement', r, {
      message:
        'ERROR:  23503: insert or update on table "statement_of_reasons" violates foreign key constraint "statement_of_reasons_decision_record_id_fkey"',
    });
    assert.equal(await rowCount(SOR), before);
  });

  test('CONTROL — with the foreign key dropped (asserted gone) inside a rolled-back transaction, the same INSERT lands', async () => {
    const r = await asSuperuser(
      'BEGIN',
      `ALTER TABLE ${SOR} DROP CONSTRAINT statement_of_reasons_decision_record_id_fkey`,
      `SELECT 'fk=' || count(*) FROM pg_constraint WHERE conname = 'statement_of_reasons_decision_record_id_fkey'`,
      SOR_INSERT('01T268ORPHANSTATEMENT00000', ABSENT_DR),
      `SELECT 'landed=' || count(*) FROM ${SOR} WHERE decision_record_id = '${ABSENT_DR}'`,
      'ROLLBACK',
    );
    assertPermitted('drop the FK and insert', r);
    assert.ok(r.stdout.includes('fk=0'), `the DROP CONSTRAINT did not land.\n${r.output}`);
    assert.ok(
      r.stdout.includes('landed=1'),
      `the orphan did not land without the FK.\n${r.output}`,
    );
    assert.equal(
      await db.value(
        `SELECT count(*)::text FROM pg_constraint WHERE conname = 'statement_of_reasons_decision_record_id_fkey'`,
      ),
      '1',
      'the rollback did not restore the FK',
    );
  });
});

describe('0031 — the SA §INT-10 guard, called DIRECTLY (OD-76)', () => {
  test('after up, and after every case above, the guard returns clean', async () => {
    assertPermitted(
      'direct call',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  test('the same reading raises on a known-bad state, and is clean again once it is removed', async () => {
    assertPermitted(
      'plant',
      await asSuperuser('GRANT TEMPORARY ON DATABASE kinvara TO answering_service'),
    );
    const bad = await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()');
    assertPermitted(
      'remove',
      await asSuperuser('REVOKE TEMPORARY ON DATABASE kinvara FROM answering_service'),
    );
    assertRefused('direct call on the known-bad state', bad, {
      message: `ERROR:  KV010: ${INT10_RAISE}`,
    });
    assert.ok(
      bad.output.includes('answering_service holds TEMPORARY on database kinvara'),
      bad.output,
    );
    assertPermitted(
      'direct call after removal',
      await asSuperuser('SELECT kinvara_guard.assert_answering_service_write_only()'),
    );
  });

  for (const table of TABLES) {
    test(`GRANT SELECT on ${bare(table)} to answering_service is REFUSED by the guard, and lands nothing`, async () => {
      const r = await asSuperuser(`GRANT SELECT ON ${table} TO answering_service`);
      assertRefused(`GRANT SELECT ${bare(table)}`, r, { message: `ERROR:  KV010: ${INT10_RAISE}` });
      assert.ok(r.output.includes(`answering_service holds SELECT on ${table}`), r.output);
      assert.equal(await hasPriv('answering_service', table, 'SELECT'), 'false');
    });
  }
});
