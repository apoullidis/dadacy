/**
 * T-020 Evidence §9, ported — the object classes, and the RULE behind them.
 *
 * This is the half of `T-020` that caught real defects. The first version of
 * the guard was written by *imagining* how a read path might appear; it covered
 * relations, columns, sequences, definer functions, default ACLs, schemas and
 * role attributes, and its comment claimed it refused a read path "by any
 * route". `qa-verification` then granted `SELECT` on a **large object**, the
 * function returned clean, and the vendor principal read the object in full.
 * Checks 11–16 were rewritten by ENUMERATING PostgreSQL's object classes,
 * because the classes `GRANT` can name are a closed documented list.
 *
 * The last test in this file is the most important one and it is the reason
 * this suite is not a list of five probes. `tech-lead` derived the rule that
 * the enumeration only approximated:
 *
 *   > A grant is preventable here IF AND ONLY IF the catalogue holding its ACL
 *   > is per-database. Grants recorded in a shared catalogue fire nothing.
 *
 * So the suite checks the RULE against `pg_class`, not the list against itself.
 * A future PostgreSQL that adds a shared catalogue with an `aclitem[]` column
 * adds a fifth detective-only class, and this file goes red the first time it
 * runs on that version — rather than waiting for someone to be surprised.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_DATABASE,
  acquireMigratedCluster,
  asVendor,
  installInt10Fixtures,
  type Cluster,
} from '../src/index.ts';
import { assertPermitted, assertRefused, INT10_RAISE } from '../src/expect.ts';

const SUITE = 'int10-object-classes';
const LOID = 424242;
/**
 * A name in Greek script and an E.164 test number on country code 991
 * (SD §Revision Log G6, SQ-27). A Latin-only payload here would still prove the
 * privilege, but this package's fixtures are never Latin-only on principle.
 */
const LO_PAYLOAD = 'child name: Α. Χριστοδούλου, phone +99170000009';

let db: Cluster;

before(
  async () => {
    db = await acquireMigratedCluster(SUITE);
    await installInt10Fixtures(db);
  },
  { timeout: 300_000 },
);

after(async () => {
  if (db !== undefined) await db.stop();
});

describe('check 11 — LARGE OBJECTS (QA-F9: the tenth read path)', () => {
  test('the object exists and carries readable content, so the refusal is not vacuous', async () => {
    assert.equal(
      await db.value(`SELECT lo_from_bytea(${String(LOID)}, convert_to('${LO_PAYLOAD}','UTF8'))`),
      String(LOID),
    );
    assert.equal(await db.value(`SELECT convert_from(lo_get(${String(LOID)}),'UTF8')`), LO_PAYLOAD);
  });

  test('GRANT SELECT ON LARGE OBJECT is REFUSED at the GRANT', async () => {
    assertRefused(
      'GRANT SELECT ON LARGE OBJECT',
      await db.psql({
        commands: [`GRANT SELECT ON LARGE OBJECT ${String(LOID)} TO answering_service`],
      }),
      { message: INT10_RAISE },
    );
  });

  test('and the read QA demonstrated is gone', async () => {
    assertRefused(
      'the vendor reading the large object',
      await db.psql(asVendor(`SELECT convert_from(lo_get(${String(LOID)}),'UTF8')`)),
      { message: `permission denied for large object ${String(LOID)}` },
    );
  });
});

describe('check 15 — FOREIGN DATA WRAPPERS (per-database, therefore preventable)', () => {
  test('GRANT USAGE ON FOREIGN DATA WRAPPER is REFUSED at the GRANT', async () => {
    await db.sql({ commands: ['CREATE FOREIGN DATA WRAPPER kv_probe_fdw'] });
    assertRefused(
      'GRANT USAGE ON FOREIGN DATA WRAPPER',
      await db.psql({
        commands: ['GRANT USAGE ON FOREIGN DATA WRAPPER kv_probe_fdw TO answering_service'],
      }),
      { message: INT10_RAISE },
    );
  });
});

describe('check 14 — UNTRUSTED LANGUAGES, and the false positive that only running it found', () => {
  test('a clean database does not trip check 14', async () => {
    // As first written, check 14 fired on a clean database: has_language_privilege()
    // reports USAGE on `c` and `internal` for every role. They are CALL HANDLERS,
    // not procedural languages, and creating a function in either needs superuser
    // regardless. Filtering on `lanispl` as well as `lanpltrusted` fixed it.
    assertPermitted(
      'the assertion on a clean database',
      await db.psql({ commands: ['SELECT public.assert_answering_service_write_only()'] }),
    );
  });

  test("the filter's premise holds on this server: c and internal are not procedural languages", async () => {
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_language WHERE lanname IN ('c','internal') AND lanispl`,
      ),
      '0',
    );
    assert.equal(
      await db.value(`SELECT count(*) FROM pg_language WHERE lanispl AND NOT lanpltrusted`),
      '0',
      'no untrusted procedural language is installed; if one ever is, check 14 must see it',
    );
  });
});

describe('checks 12, 13, 16 and role membership — DETECTIVE ONLY, and measured as such', () => {
  test('all four are accepted silently, while a per-database grant in the SAME invocation is refused', async () => {
    // The control is the whole test. Without a statement that DOES fire in the
    // same psql invocation, "nothing fired" would be indistinguishable from
    // "the trigger was not installed".
    const r = await db.psql({
      commands: [
        `GRANT ALTER SYSTEM ON PARAMETER log_statement TO answering_service`,
        `GRANT TEMPORARY ON DATABASE ${APP_DATABASE} TO answering_service`,
        `GRANT CREATE ON TABLESPACE pg_default TO answering_service`,
        `GRANT app_rw TO answering_service`,
        // the control — per-database, and it must be refused
        `GRANT SELECT ON public.account TO answering_service`,
      ],
    });
    assertRefused('the control grant', r, { message: INT10_RAISE });
    assert.equal(
      (r.output.match(/^GRANT$/gm) ?? []).length + (r.output.match(/^GRANT ROLE$/gm) ?? []).length,
      4,
      `the four shared-catalogue grants must all have been ACCEPTED before the control was refused.\n${r.output}`,
    );
  });

  test('but the assertion detects every one of them', async () => {
    const r = await db.psql({ commands: ['SELECT public.assert_answering_service_write_only()'] });
    assertRefused('the assertion', r, { message: INT10_RAISE });
    for (const detail of [
      'holds ALTER SYSTEM on parameter log_statement',
      `holds TEMPORARY on database ${APP_DATABASE}`,
      'holds CREATE on tablespace pg_default',
      'is a member of role app_rw',
    ]) {
      assert.ok(
        r.output.includes(detail),
        `the assertion must report "${detail}" — it is detective-only, so the report is the whole control.\n${r.output}`,
      );
    }
  });

  test('revoked, the boundary is restored', async () => {
    assertPermitted(
      'the revokes',
      await db.psql({
        commands: [
          `REVOKE ALTER SYSTEM ON PARAMETER log_statement FROM answering_service`,
          `REVOKE TEMPORARY ON DATABASE ${APP_DATABASE} FROM answering_service`,
          `REVOKE CREATE ON TABLESPACE pg_default FROM answering_service`,
          `REVOKE app_rw FROM answering_service`,
          `SELECT public.assert_answering_service_write_only()`,
        ],
      }),
    );
  });
});

describe('THE RULE, not the list — preventable iff the ACL catalogue is per-database', () => {
  test('exactly three shared catalogues carry an aclitem[] column, and pg_auth_members is the fourth class', async () => {
    // Derived from the server, not from a table in this file. If PostgreSQL 19
    // adds a shared catalogue with an ACL column, this goes red on the first
    // run against it and the coverage statement in T-020 § Published contract
    // §5 needs a fifth row. That is the difference between a rule you can
    // derive and a list you have to remember to extend.
    const withAcl = await db.value(
      `SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
         FROM pg_class c
        WHERE c.relisshared AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid
                         AND a.atttypid = 'aclitem[]'::regtype
                         AND NOT a.attisdropped)`,
    );
    assert.equal(withAcl, 'pg_database,pg_parameter_acl,pg_tablespace');

    const sharedTotal = await db.value(
      `SELECT count(*) FROM pg_class WHERE relisshared AND relkind = 'r'`,
    );
    assert.equal(sharedTotal, '11', 'PostgreSQL 18 has exactly eleven shared catalogues');

    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_class WHERE relname = 'pg_auth_members' AND relisshared`,
      ),
      '1',
      'membership IS the grant, so pg_auth_members is grantable without an ACL column',
    );
  });

  test('PostgreSQL refuses an event trigger on GRANT ROLE outright — the gap is structural, not an oversight', async () => {
    assertRefused(
      "CREATE EVENT TRIGGER … WHEN TAG IN ('GRANT ROLE')",
      await db.psql({
        commands: [
          `CREATE FUNCTION public.kv_probe_et() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$`,
          `CREATE EVENT TRIGGER kv_probe_grant_role ON ddl_command_end
             WHEN TAG IN ('GRANT ROLE') EXECUTE FUNCTION public.kv_probe_et()`,
        ],
      }),
      { message: 'event triggers are not supported for GRANT ROLE' },
    );
  });

  test('until T-033 lands, all four detective-only classes are detectable but UNMONITORED', async () => {
    // T-020 § Published contract §5 ends: "That sentence stays in this contract
    // until it does — if you are reading this and T-033 is done, the sentence
    // should have been removed and was not." This is that sentence with a
    // mechanism behind it: the reconciler is the only thing that closes these
    // four, and nothing in the database can tell you whether it is scheduled.
    assert.equal(
      await db.value(
        `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'assert_answering_service_write_only'`,
      ),
      '1',
      'the function T-033 must call on a schedule must exist for the compensating control to be buildable',
    );
  });
});
