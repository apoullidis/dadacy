/**
 * The matrix, checked against an INDEPENDENT transcription of SD §BE-10.
 *
 * PROTOCOL §5.1: "A check must not be derived from the same reading as the
 * thing it checks." A test that read `MATRIX` and asserted `can()` agrees with
 * it would be exactly that — the table and its check computed from one
 * reading, agreeing perfectly with each other and possibly not with the
 * specification. So SPEC_GRID below is a second, literal transcription of
 * SD §BE-10's printed grid, written in the specification's OWN legend
 * (`allow` / `own` / `window` / `bg` / `—`, plus its four qualified
 * spellings), and this file asserts that `matrix.ts` says the same thing.
 *
 * Reading a row: the ten columns are SD §BE-10's own column order —
 * parent, sitter, trusted_contact, support, ts_operator, ts_senior, dsl,
 * finance, compliance, engineer.
 *
 * The `!` suffix marks a cell requiring step-up, per SD §BE-10's sentence
 * "…and every admin action beyond read".
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MATRIX } from './matrix.ts';
import { ROLES } from './types.ts';
import type { Cell, Grant, GrantKind, Role } from './types.ts';

/** SD §BE-10's legend spellings, mapped to the grant kind each denotes. */
const LEGEND: Record<string, GrantKind> = {
  '-': 'deny',
  allow: 'allow',
  own: 'own',
  window: 'window',
  bg: 'break_glass',
  cap: 'capability',
  '4eyes': 'four_eyes',
  modelA: 'art10',
  locale: 'locale',
};

/**
 * SD §BE-10's grid, transcribed. One line per (resource, action); ten
 * space-separated cells in the specification's column order.
 */
const SPEC_GRID: readonly (readonly [Cell, string])[] = [
  ['account#read', 'own own - - - - - - - -'],
  ['account#update', 'own! own! - - - - - - - -'],
  ['account#remove_permanently', '- - - - - 4eyes! allow! - - -'],
  ['sitter.public_profile#read', 'allow allow - allow allow allow allow - - -'],
  ['sitter.contact_details#read', '- own - - bg bg bg - - bg'],
  ['child.health#read', 'own window - - bg bg bg - - bg'],
  ['child.health#write', 'own - - - - - - - - -'],
  ['certificate_outcome_metadata#read', '- own - - bg bg bg - bg bg'],
  ['certificate_outcome#record', '- - - - modelA! modelA! modelA! - - -'],
  ['idv_result#read', '- own - - bg bg bg - bg bg'],
  ['sitter_search#search', 'allow - - allow allow allow allow - - -'],
  ['booking#create', 'allow - - - - - - - - -'],
  ['booking#accept', '- own - - - - - - - -'],
  ['booking#decline', '- own - - - - - - - -'],
  ['booking#cancel', 'own own - allow! allow! allow! allow! - - -'],
  ['message.content#read', 'own own - - bg bg bg - - -'],
  ['message.metadata#read', 'own own - allow bg bg bg - - -'],
  ['message#send', 'own own - - - - - - - -'],
  ['session#read', 'own own cap allow allow allow allow - - -'],
  ['session#check_in', '- own - - - - - - - -'],
  ['session#arrival', '- own - - - - - - - -'],
  ['session#end', '- own - - - - - - - -'],
  ['sos#raise', 'own own - - - - - - - -'],
  ['sos#raise_concern', '- - cap - - - - - - -'],
  ['sit_summary#write', '- own - - - - - - - -'],
  ['review#submit', 'own own - - - - - - - -'],
  ['review#remove', '- - - - allow! allow! allow! - - -'],
  ['verification_decision#record', '- - - - allow! allow! allow! - - -'],
  ['non_clear_outcome#review', '- - - - - 4eyes! allow! - - -'],
  // SD line 1270 prints `allow!` for dsl here. The stakeholder ruling decisions.md OE-46
  // (T-186) supersedes that one cell, so the transcription follows the ruling, not SD.
  ['four_eyes#countersign', '- - - - - allow! - - - -'],
  ['account_suspension#apply', '- - - - allow! allow! allow! - - -'],
  ['pairing_block#apply', '- - - - allow! allow! allow! - - -'],
  ['safeguarding_referral#make', '- - - - - - 4eyes! - - -'],
  ['staffed_hours_version#publish', '- - - - - - 4eyes! - 4eyes! -'],
  ['rota_shift#publish', '- - - - - allow! allow! - - -'],
  ['content_moderation#moderate', '- - - - locale! locale! locale! - - -'],
  ['refund#issue', '- - - - allow! allow! - allow! - -'],
  ['payout_ledger#read', 'own own - - - - - allow - -'],
  ['payout_ledger.metadata#read', 'own own - allow - - - allow - -'],
  ['audit_log#read', '- - - - own own own own allow -'],
  ['retention_run#approve', '- - - - - - - - 4eyes! -'],
  ['dsar#request', 'own own - - - - - - - -'],
  ['dsar#execute', '- - - - - - - - allow! -'],
  ['feature_flag#toggle', '- - - - - allow! allow! - - allow!'],
  ['feature_flag.compliance#toggle', '- - - - - 4eyes! 4eyes! - 4eyes! -'],
  ['production_data#read', '- - - - - - - - - bg'],
];

/**
 * SD §BE-10's PRINTED rows, transcribed in the specification's own row order
 * and labels (lines 1248-1285), each against the (resource, action) rows
 * `matrix.ts` turns it into. This is the second reading that makes the "38
 * printed rows decompose into 46" sentence falsifiable: before this table the
 * sentence was prose, and it was wrong in two places without any test moving
 * (QR-2 — it named `Refunds / credits / compensation` as a split row, which it
 * is not, and omitted `SOS`, which is one).
 */
const PRINTED_ROWS: readonly (readonly [string, readonly Cell[]])[] = [
  ['Own account read/update', ['account#read', 'account#update']],
  ['Sitter public profile read', ['sitter.public_profile#read']],
  ['Sitter surname / address / phone', ['sitter.contact_details#read']],
  ['Child health read', ['child.health#read']],
  ['Child health write', ['child.health#write']],
  ['Certificate outcome metadata (Art 10)', ['certificate_outcome_metadata#read']],
  ['Record a certificate outcome', ['certificate_outcome#record']],
  ['IDV result', ['idv_result#read']],
  ['Search sitters', ['sitter_search#search']],
  ['Create booking request', ['booking#create']],
  ['Accept/decline booking', ['booking#accept', 'booking#decline']],
  ['Cancel booking', ['booking#cancel']],
  ['Message read (content)', ['message.content#read', 'message.metadata#read']],
  ['Message send', ['message#send']],
  ['Session read', ['session#read']],
  ['Check-in / arrival / end', ['session#check_in', 'session#arrival', 'session#end']],
  ['SOS', ['sos#raise', 'sos#raise_concern']],
  ['Sit summary write', ['sit_summary#write']],
  ['Review submit', ['review#submit']],
  ['Review remove', ['review#remove']],
  ['Verification decision', ['verification_decision#record']],
  ['Non-clear criminal-record outcome', ['non_clear_outcome#review']],
  ['Four-eyes countersign', ['four_eyes#countersign']],
  ['Suspend (temporary)', ['account_suspension#apply']],
  ['Permanent removal', ['account#remove_permanently']],
  ['Pairing block', ['pairing_block#apply']],
  ['Cyprus safeguarding referral', ['safeguarding_referral#make']],
  ['Publish a staffed-hours version', ['staffed_hours_version#publish']],
  ['Publish a rota shift', ['rota_shift#publish']],
  ['Moderate content in locale L', ['content_moderation#moderate']],
  ['Refunds / credits / compensation', ['refund#issue']],
  ['Payout / ledger read', ['payout_ledger#read', 'payout_ledger.metadata#read']],
  ['Audit log read', ['audit_log#read']],
  ['Retention run approve', ['retention_run#approve']],
  ['DSAR / erasure execute', ['dsar#request', 'dsar#execute']],
  ['Feature flags (non-compliance)', ['feature_flag#toggle']],
  ['Feature flags (compliance: true)', ['feature_flag.compliance#toggle']],
  ['Production data', ['production_data#read']],
];

function parseCell(spelling: string): Grant {
  const stepUp = spelling.endsWith('!');
  const bare = stepUp ? spelling.slice(0, -1) : spelling;
  const kind = LEGEND[bare];
  assert.notEqual(kind, undefined, `unknown legend spelling ${JSON.stringify(spelling)}`);
  return stepUp ? { kind: kind as GrantKind, stepUp: true } : { kind: kind as GrantKind };
}

test('the transcription of SD §BE-10 is itself well formed: 46 rows of 10 cells, no duplicates', () => {
  assert.equal(SPEC_GRID.length, 46);
  const seen = new Set<string>();
  for (const [key, spelling] of SPEC_GRID) {
    assert.equal(seen.has(key), false, `duplicate row ${key}`);
    seen.add(key);
    assert.equal(spelling.trim().split(/\s+/).length, ROLES.length, `row ${key} is not 10 cells`);
  }
});

test('matrix.ts and the SD §BE-10 transcription name exactly the same (resource, action) rows', () => {
  const inCode = [...MATRIX.keys()].sort();
  const inSpec = SPEC_GRID.map(([k]) => k).sort();
  assert.deepEqual(inCode, inSpec);
});

test('every one of the 460 cells in matrix.ts equals the SD §BE-10 transcription', () => {
  let compared = 0;
  for (const [key, spelling] of SPEC_GRID) {
    const row = MATRIX.get(key);
    assert.notEqual(row, undefined, `matrix.ts has no row ${key}`);
    const cells = spelling.trim().split(/\s+/);
    for (const [i, role] of ROLES.entries()) {
      const expected = parseCell(cells[i] ?? '');
      const actual = (row as Record<Role, Grant>)[role];
      assert.deepEqual(
        { kind: actual.kind, stepUp: actual.stepUp === true },
        { kind: expected.kind, stepUp: expected.stepUp === true },
        `${key} / ${role}`,
      );
      compared++;
    }
  }
  assert.equal(compared, 460);
});

test('the ten roles are SA §TS-7 and SD §BE-10 column order, with no duplicates', () => {
  assert.deepEqual(
    [...ROLES],
    [
      'parent',
      'sitter',
      'trusted_contact',
      'support',
      'ts_operator',
      'ts_senior',
      'dsl',
      'finance',
      'compliance',
      'engineer',
    ],
  );
  assert.equal(new Set(ROLES).size, ROLES.length);
});

test('no role but engineer reaches production data, and engineer reaches it only by break-glass', () => {
  const row = MATRIX.get('production_data#read');
  assert.notEqual(row, undefined);
  for (const role of ROLES) {
    const grant = (row as Record<Role, Grant>)[role];
    assert.equal(grant.kind, role === 'engineer' ? 'break_glass' : 'deny', role);
  }
});

test('SD §BE-10: support reaches message and payout metadata but never message content', () => {
  const content = MATRIX.get('message.content#read');
  const metadata = MATRIX.get('message.metadata#read');
  const ledger = MATRIX.get('payout_ledger#read');
  const ledgerMeta = MATRIX.get('payout_ledger.metadata#read');
  assert.equal((content as Record<Role, Grant>).support.kind, 'deny');
  assert.equal((metadata as Record<Role, Grant>).support.kind, 'allow');
  assert.equal((ledger as Record<Role, Grant>).support.kind, 'deny');
  assert.equal((ledgerMeta as Record<Role, Grant>).support.kind, 'allow');
});

test('SD §BE-10: support has no route at all to child health, certificate metadata or IDV results', () => {
  for (const key of [
    'child.health#read',
    'certificate_outcome_metadata#read',
    'idv_result#read',
  ] as const) {
    const row = MATRIX.get(key);
    assert.equal((row as Record<Role, Grant>).support.kind, 'deny', key);
  }
});

test('SD §BE-10: only ts_senior and dsl may end an account permanently, and ts_operator may not', () => {
  const row = MATRIX.get('account#remove_permanently') as Record<Role, Grant>;
  assert.equal(row.ts_operator.kind, 'deny');
  assert.equal(row.ts_senior.kind, 'four_eyes');
  assert.equal(row.dsl.kind, 'allow');
});

test('SD §BE-17 item 4: recording a certificate outcome is the art10 grant for the three T&S roles', () => {
  const row = MATRIX.get('certificate_outcome#record') as Record<Role, Grant>;
  for (const role of ROLES) {
    const expected = role === 'ts_operator' || role === 'ts_senior' || role === 'dsl';
    assert.equal(row[role].kind, expected ? 'art10' : 'deny', role);
  }
});

test('every back-office action that mutates requires step-up, and no read or search does', () => {
  const backOffice: readonly Role[] = [
    'support',
    'ts_operator',
    'ts_senior',
    'dsl',
    'finance',
    'compliance',
    'engineer',
  ];
  // SD §BE-10 says "every admin action beyond read". Taken literally that
  // would catch `search`, which this test caught it doing: `sitter_search#search`
  // is `allow` for support with no step-up in the specification's own grid.
  // "Beyond read" means beyond READING — the non-mutating actions are `read`
  // and `search`, and those are the two the matrix leaves un-stepped-up.
  const NON_MUTATING = new Set(['read', 'search']);
  let checked = 0;
  for (const [key, row] of MATRIX) {
    const action = key.split('#')[1] ?? '';
    const mutates = !NON_MUTATING.has(action);
    for (const role of backOffice) {
      const grant = (row as Record<Role, Grant>)[role];
      if (grant.kind === 'deny') continue;
      assert.equal(grant.stepUp === true, mutates, `${key} / ${role}`);
      checked++;
    }
  }
  assert.equal(checked > 0, true);
});

test('the 38 printed rows of SD §BE-10 decompose into exactly the 46 rows matrix.ts names', () => {
  assert.equal(PRINTED_ROWS.length, 38);
  const produced: Cell[] = [];
  for (const [label, cells] of PRINTED_ROWS) {
    assert.equal(cells.length > 0, true, `${label} produces no row`);
    produced.push(...cells);
  }
  assert.equal(produced.length, 46);
  assert.equal(new Set(produced).size, 46, 'a printed row may not produce a row twice');
  assert.deepEqual([...produced].sort(), [...MATRIX.keys()].sort());
});

test('exactly seven printed rows become more than one row, and refunds is not one of them', () => {
  const split = PRINTED_ROWS.filter(([, cells]) => cells.length > 1).map(([label]) => label);
  assert.deepEqual(split, [
    'Own account read/update',
    'Accept/decline booking',
    'Message read (content)',
    'Check-in / arrival / end',
    'SOS',
    'Payout / ledger read',
    'DSAR / erasure execute',
  ]);
  const refunds = PRINTED_ROWS.find(([label]) => label === 'Refunds / credits / compensation');
  assert.deepEqual(refunds?.[1], ['refund#issue']);
});

test('every grant kind in the vocabulary is actually used by at least one cell', () => {
  const used = new Set<GrantKind>();
  for (const [, row] of MATRIX) {
    for (const role of ROLES) used.add((row as Record<Role, Grant>)[role].kind);
  }
  assert.deepEqual([...used].sort(), [
    'allow',
    'art10',
    'break_glass',
    'capability',
    'deny',
    'four_eyes',
    'locale',
    'own',
    'window',
  ]);
});
