/**
 * `review.json` § `pipeline` — the trilingual safety-copy pipeline as data.
 * T-049; SD §DH-5 external dependency 2; SA §TS-12.4; PM §MVP-L4 AC4,
 * §MVP-L5 AC7, §MVP-IS5 AC7; DV-7, DV-11.
 *
 * Two kinds of test here, and the difference matters.
 *
 *  (a) **Anchored arithmetic.** The lead time and the deadline are written HERE
 *      as literals taken from the specification and from the waiver, and the
 *      value recorded in `review.json` is checked against them. Buying slack by
 *      editing the file therefore turns this suite red. This is the shape QA-F3
 *      asked for: a check must not be derived from the same reading as the thing
 *      it checks (PROTOCOL §5.1).
 *
 *  (b) **Coherence between the plan and the delivery.** Everything that would
 *      have to be true for a `signed_off` record to be believable. These pass
 *      today by covering nothing — no record is signed off — so each one is
 *      proven by CONSTRUCTING the forgery it exists to refuse and watching it
 *      come back as a problem. A predicate that has only ever seen a green
 *      corpus has not been shown to be wired to anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadReviewRegister,
  loadCopyPipeline,
  latestExternalStart,
  slackDays,
  endOfDay,
  pipelineIncoherences,
  reAnchorProblems,
} from './review.ts';
import type { ReviewRegister, CopyPipeline } from './review.ts';
import { keysAtTier } from './tiers.ts';
import { enabledLocales } from './registry.ts';

const LOCALES = enabledLocales().map((l) => l.code);
const SAFETY_KEYS = [...keysAtTier('safety_critical')];

/**
 * Written here, not read from review.json.
 *   - 2026-10-17 is the waiver expiry T-040 opened and the date T-044's gate
 *     starts failing on placeholder copy. Moving it is an orchestrator decision
 *     against BOARD RK-2 and must cost an edit to this line.
 *   - 42 days is SD §DH-5 external dependency 2's "six weeks of lead time".
 */
const DEADLINE = '2026-12-05';
const LEAD_TIME_DAYS = 42;

/**
 * The date `T-040` opened the waiver with, before the 2026-09-05 re-anchor.
 * Written here so the re-anchor chain has something outside itself to start
 * from: a chain whose own first row supplied its origin could not detect a
 * rewritten origin.
 */
const ORIGINAL_EXPECTED_BY = '2026-10-17';

/**
 * How many times the date may be moved while **nothing has been engaged**.
 *
 * This is the bound that stops a self-closing waiver becoming an open-ended one,
 * and it lives HERE rather than in `review.json` on purpose: a register that
 * could raise its own limit would be measuring itself (PROTOCOL §5.1). One
 * re-anchor has been made — the honest 2026-09-05 one. A second, still with no
 * `external_start`, reds this suite and forces an orchestrator decision against
 * BOARD RK-2 rather than another quiet edit.
 *
 * Re-anchors made AFTER a real `external_start` is recorded are not counted:
 * once the pipeline is genuinely running, moving a date is scheduling, not drift.
 */
const MAX_UNSTARTED_RE_ANCHORS = 1;

/**
 * The pipeline whose `external_start` a given waiver is being checked against.
 * `pipeline.external_start` is the declared source of truth (R2-F3), so a test
 * that varies the waiver's mirror must vary the source with it — otherwise it is
 * testing the disagreement, not the rule.
 */
function pipelineWith(waiver: { external_start?: string | null }): CopyPipeline {
  return { ...loadCopyPipeline(), external_start: waiver.external_start ?? null };
}

test('the pipeline block exists and is loaded fail-closed', () => {
  const pipeline: CopyPipeline = loadCopyPipeline();
  assert.equal(pipeline.deadline, DEADLINE);
  assert.equal(pipeline.lead_time_days, LEAD_TIME_DAYS);
  assert.equal(pipeline.engineering_kickoff, '2026-09-05');
});

test('latest_external_start is the deadline minus the lead time, computed outside the file', () => {
  // The whole risk of this ticket in one assertion. If the recorded value is
  // ever nudged later to make the schedule look survivable, this reds.
  const pipeline = loadCopyPipeline();
  assert.equal(latestExternalStart(DEADLINE, LEAD_TIME_DAYS), '2026-10-24');
  assert.equal(pipeline.latest_external_start, latestExternalStart(DEADLINE, LEAD_TIME_DAYS));

  // And the arithmetic itself, against cases computed by hand rather than by
  // the same expression: six weeks before 2026-10-17 is 2026-09-05, and one day
  // less of lead time is one day more of slack.
  assert.equal(latestExternalStart('2026-12-05', 42), '2026-10-24');
  assert.equal(latestExternalStart('2026-12-05', 41), '2026-10-25');
  assert.equal(latestExternalStart('2026-12-05', 0), '2026-12-05');
  // and the original anchor, which is the OD-15 measurement itself
  assert.equal(latestExternalStart('2026-10-17', 42), '2026-09-05');
});

test('the ORIGINAL waiver window was exactly the lead time — the OD-15 finding, kept', () => {
  // Kept, not deleted, and deliberately re-expressed against the recorded
  // origin rather than against the current `expected_by`. The finding is why the
  // date moved; erasing it because the date moved would be exactly the
  // delete-the-evidence pattern this build has been failed for twice.
  //
  // T-040 set expected_by = opened_at + six weeks because SD §DH-5 says six
  // weeks, not because a clock had started. So the latest workable external
  // start fell on the day the register was created, and slack was zero on
  // arrival. That is what OD-15 reported and what OE-5 acted on.
  const register = loadReviewRegister();
  const waiver = register.pending_pipeline;
  assert.ok(waiver !== null);
  const originalWindow = (endOfDay(ORIGINAL_EXPECTED_BY) - endOfDay(waiver.opened_at)) / 86_400_000;
  assert.equal(
    originalWindow,
    LEAD_TIME_DAYS,
    'the waiver as opened had a window exactly equal to the lead time, i.e. zero slack',
  );
  assert.equal(latestExternalStart(ORIGINAL_EXPECTED_BY, LEAD_TIME_DAYS), waiver.opened_at);

  // And the re-anchor bought back a real window rather than merely a later date.
  const currentWindow = (endOfDay(DEADLINE) - endOfDay(waiver.opened_at)) / 86_400_000;
  assert.ok(currentWindow > LEAD_TIME_DAYS, 'the re-anchored window must exceed the lead time');
});

test('expected_by is a DECISION REVIEW DATE and the chain says how it got there', () => {
  const register = loadReviewRegister();
  const waiver = register.pending_pipeline;
  assert.ok(waiver !== null);
  assert.equal(waiver.expected_by, DEADLINE);
  assert.deepEqual(
    reAnchorProblems(waiver, pipelineWith(waiver), ORIGINAL_EXPECTED_BY, MAX_UNSTARTED_RE_ANCHORS),
    [],
  );
  // Every re-anchor so far was made with nothing engaged, and says so.
  for (const row of waiver.re_anchors ?? []) {
    assert.equal(row.external_start_at_decision, null);
    assert.ok(row.reason.length > 0);
  }
});

test('NEGATIVE — moving expected_by without recording why is caught', () => {
  // A silent date edit: the field moves, the chain does not.
  const register = loadReviewRegister();
  const waiver = { ...register.pending_pipeline!, expected_by: '2027-03-01' };
  const problems = reAnchorProblems(
    waiver,
    pipelineWith(waiver),
    ORIGINAL_EXPECTED_BY,
    MAX_UNSTARTED_RE_ANCHORS,
  );
  assert.ok(
    problems.some((p) => /The date was edited without recording why/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — a chain with a gap in it is caught', () => {
  const register = loadReviewRegister();
  const base = register.pending_pipeline!;
  const waiver = {
    ...base,
    expected_by: '2027-03-01',
    re_anchors: [
      ...(base.re_anchors ?? []),
      {
        from: '2027-01-01', // does not continue from 2026-12-05
        to: '2027-03-01',
        decided_on: '2026-12-05',
        decided_by: 'x',
        reason: 'y',
        external_start_at_decision: null,
      },
    ],
  };
  const problems = reAnchorProblems(
    waiver,
    pipelineWith(waiver),
    ORIGINAL_EXPECTED_BY,
    MAX_UNSTARTED_RE_ANCHORS,
  );
  assert.ok(
    problems.some((p) => /does not continue from/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — a second re-anchor with nothing engaged exceeds the bound', () => {
  // The answer to "could this record report we are on track while nothing has
  // been engaged". On its own, yes: append a row each time the date approaches.
  // The bound is what stops it, and the bound is a literal in THIS file, not a
  // field in the register — a register that could raise its own limit would be
  // measuring itself.
  const register = loadReviewRegister();
  const base = register.pending_pipeline!;
  const waiver = {
    ...base,
    expected_by: '2027-01-16',
    re_anchors: [
      ...(base.re_anchors ?? []),
      {
        from: DEADLINE,
        to: '2027-01-16',
        decided_on: '2026-12-05',
        decided_by: 'whoever was editing',
        reason: 'still nothing has started',
        external_start_at_decision: null,
      },
    ],
  };
  const problems = reAnchorProblems(
    waiver,
    pipelineWith(waiver),
    ORIGINAL_EXPECTED_BY,
    MAX_UNSTARTED_RE_ANCHORS,
  );
  assert.ok(
    problems.some((p) => /over a bound of 1/.test(p)),
    JSON.stringify(problems, null, 2),
  );
  // And the same move, once the pipeline is GENUINELY running, is scheduling
  // rather than drift — so it is permitted. Note what had to change for that to
  // be true: the waiver's own `external_start`, not just the row's account of
  // itself. The earlier version of this test set only the row, which is exactly
  // the hole QA-F1 found: it asserted the exemption held while the waiver still
  // said nothing had started, and it passed.
  const started = {
    ...waiver,
    external_start: '2026-10-24',
    re_anchors: waiver.re_anchors.map((r, i) =>
      i === waiver.re_anchors.length - 1
        ? { ...r, decided_on: '2026-12-05', external_start_at_decision: '2026-10-24' }
        : { ...r, external_start_at_decision: '2026-10-24', decided_on: '2026-10-24' },
    ),
  };
  assert.deepEqual(
    reAnchorProblems(
      started,
      pipelineWith(started),
      ORIGINAL_EXPECTED_BY,
      MAX_UNSTARTED_RE_ANCHORS,
    ),
    [],
  );
});

test('NEGATIVE — QA-F1: a re-anchor cannot certify its own exemption from the bound', () => {
  // The forgery the first version of this mechanism allowed, and the reason it
  // was a rework rather than a note: the BOUND was outside the register, but the
  // predicate deciding whether it APPLIED was inside it. Filtering on
  // `external_start_at_decision` — a field the row writes about itself — meant a
  // date typed into that one field bought an exemption from a limit that was
  // otherwise unreachable. Exemption is now granted against the waiver's actual
  // `external_start`, which is null.
  const register = loadReviewRegister();
  const base = register.pending_pipeline!;
  assert.equal(base.external_start, null, 'precondition: nothing has been engaged');
  const forged = {
    ...base,
    expected_by: '2027-01-16',
    re_anchors: [
      ...(base.re_anchors ?? []),
      {
        from: DEADLINE,
        to: '2027-01-16',
        decided_on: '2026-12-05',
        decided_by: 'whoever was editing',
        reason: 'still nothing has started',
        // The single field that used to buy the exemption.
        external_start_at_decision: '2026-10-24',
      },
    ],
  };
  const problems = reAnchorProblems(
    forged,
    pipelineWith(forged),
    ORIGINAL_EXPECTED_BY,
    MAX_UNSTARTED_RE_ANCHORS,
  );
  assert.ok(
    problems.some((p) => /cannot certify its own exemption from the bound/.test(p)),
    JSON.stringify(problems, null, 2),
  );
  assert.ok(
    problems.some((p) => /over a bound of 1/.test(p)),
    'and it must still count against the bound',
  );
});

test('NEGATIVE — an exemption cannot be backdated to before the start that grants it', () => {
  const register = loadReviewRegister();
  const base = register.pending_pipeline!;
  const forged = {
    ...base,
    external_start: '2026-10-24',
    expected_by: '2027-01-16',
    re_anchors: [
      { ...base.re_anchors![0]!, external_start_at_decision: '2026-10-24' }, // decided_on 2026-09-05
      {
        from: DEADLINE,
        to: '2027-01-16',
        decided_on: '2026-12-05',
        decided_by: 'x',
        reason: 'y',
        external_start_at_decision: '2026-10-24',
      },
    ],
  };
  const problems = reAnchorProblems(
    forged,
    pipelineWith(forged),
    ORIGINAL_EXPECTED_BY,
    MAX_UNSTARTED_RE_ANCHORS,
  );
  assert.ok(
    problems.some((p) => /before the external start it claims to be exempt under/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — a row claiming a start date the waiver does not have', () => {
  const register = loadReviewRegister();
  const base = register.pending_pipeline!;
  const forged = {
    ...base,
    external_start: '2026-10-24',
    re_anchors: (base.re_anchors ?? []).map((r) => ({
      ...r,
      external_start_at_decision: '2026-09-01',
    })),
  };
  const problems = reAnchorProblems(
    forged,
    pipelineWith(forged),
    ORIGINAL_EXPECTED_BY,
    MAX_UNSTARTED_RE_ANCHORS,
  );
  assert.ok(
    problems.some((p) => /There is one start date, not one per row/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('external_start is recorded as an explicit null, and an absent key fails closed', () => {
  const pipeline = loadCopyPipeline();
  assert.equal(pipeline.external_start, null);
  assert.ok('external_start' in pipeline, 'the key must be PRESENT and null, never absent');
  const register = loadReviewRegister();
  assert.equal(register.pending_pipeline?.external_start, null);
});

test('slackDays measures from the recorded external start, or from today while it is null', () => {
  const pipeline = loadCopyPipeline();
  // Null start: slack is measured against the wall clock, which is what makes
  // "nobody has started" visible rather than merely true.
  assert.equal(slackDays(pipeline, endOfDay('2026-10-24')), 0);
  assert.equal(slackDays(pipeline, endOfDay('2026-10-20')), 4);
  assert.equal(slackDays(pipeline, endOfDay('2026-11-07')), -14);
  // A recorded start pins it: the clock stops mattering and the recorded date does.
  const started = { ...pipeline, external_start: '2026-11-07' };
  assert.equal(slackDays(started, endOfDay('2026-10-20')), -14);
});

test('a recorded external_start may not already be past the last workable day', () => {
  // The one date assertion that CAN fail today, and it fails on a lie rather
  // than on the calendar: recording a start date that is already too late while
  // leaving the deadline in place is an inconsistency, not a schedule.
  //
  // Deliberately NOT a test that reds when `external_start` is null and the date
  // passes. That test's cheapest repair would be writing a start date that never
  // happened, or deleting the test — pressure in exactly the wrong direction on
  // the one file that records this copy is unreviewed (T-040 QA-F1/QA-F4, twice).
  // The dated build failure this programme already owns is the waiver expiry, and
  // one doomsday clock, owned and escalated, is worth more than two.
  const pipeline = loadCopyPipeline();
  if (pipeline.external_start === null) return;
  assert.ok(
    endOfDay(pipeline.external_start) <= endOfDay(pipeline.latest_external_start),
    `external_start ${pipeline.external_start} is past ${pipeline.latest_external_start}, the last day compatible with a ${String(LEAD_TIME_DAYS)}-day lead time and a ${DEADLINE} deadline. Either the deadline moved (an orchestrator decision, BOARD RK-2) or this date is wrong.`,
  );
});

test('nothing in the pipeline claims a person, a stage or a start that has happened', () => {
  // The honest state on 2026-09-05, asserted so that it cannot drift into
  // optimism. This test EMPTIES ITSELF as the pipeline genuinely progresses —
  // it asserts over the roles and stages that are still unfilled, never over a
  // fixed list, so naming one practitioner does not turn it red and invite a
  // deletion (the shape T-040's QA-F1 was failed for).
  const pipeline = loadCopyPipeline();
  for (const [id, role] of Object.entries(pipeline.roles)) {
    if (role.named === null) {
      assert.equal(
        role.confirmed_by_stakeholder_on,
        null,
        `role '${id}' has a stakeholder confirmation date but nobody named`,
      );
    }
  }
  for (const stage of pipeline.stages) {
    if (stage.completed_at !== null) {
      assert.ok(
        Number.isFinite(Date.parse(stage.completed_at)),
        `stage '${stage.id}' completed_at is not a date`,
      );
    }
  }
});

test('every safety_critical key has a per-locale method, and Greek is AUTHORED not translated', () => {
  // PM §MVP-L4 AC4 and §MVP-S7 AC1 both require Greek AUTHORSHIP. A Greek
  // translation of an English safety string is a different artefact from a Greek
  // safety string, and this is where the difference is a rule rather than a hope.
  const pipeline = loadCopyPipeline();
  assert.ok(SAFETY_KEYS.length > 0);
  for (const key of SAFETY_KEYS) {
    const a = pipeline.assignments[key];
    assert.ok(a !== undefined, `no pipeline assignment for ${key}`);
    for (const locale of LOCALES) {
      assert.ok(a.locales[locale] !== undefined, `${key}: no rule for ${locale}`);
    }
    assert.equal(
      a.locales['el']?.method,
      'authored',
      `${key}: Greek must be authored, not translated`,
    );
    assert.equal(a.locales['en']?.method, 'authored', `${key}: English is the source authorship`);
    assert.notEqual(a.locales['ru']?.method, undefined);
  }
});

test('machine translation is prohibited on every safety_critical assignment — derived from TIER_POLICY', async () => {
  // Derived rather than restated. `TIER_POLICY.safety_critical.machineTranslationPermitted`
  // is the one place DV-11's rule lives; if it ever flipped, this test would flip
  // with it instead of contradicting it silently.
  const { TIER_POLICY } = await import('./tiers.ts');
  const permitted = TIER_POLICY.safety_critical.machineTranslationPermitted;
  assert.equal(permitted, false, 'DV-11: MT is prohibited on safety_critical');
  const pipeline = loadCopyPipeline();
  for (const key of SAFETY_KEYS) {
    assert.equal(
      pipeline.assignments[key]?.machine_translation,
      permitted ? 'permitted' : 'prohibited',
    );
  }
});

test('the emergency panel is never translated at runtime, and the set is derived from the keys', () => {
  // PM §MVP-IS5 AC7 names "number labels, the 112 script and the address-reading
  // prompt". Those are exactly the `safety.emergency.*` and `safety.helpline.*`
  // keys, so the set is computed from the catalogue rather than hand-listed —
  // adding `safety.helpline.1440.label` puts it under the rule automatically.
  const pipeline = loadCopyPipeline();
  const panel = SAFETY_KEYS.filter(
    (k) => k.startsWith('safety.emergency.') || k.startsWith('safety.helpline.'),
  );
  assert.ok(panel.length >= 6, `expected the emergency panel keys, found ${String(panel.length)}`);
  for (const key of panel) {
    const a = pipeline.assignments[key];
    assert.equal(a?.emergency_panel, true, `${key} is an emergency-panel key`);
    assert.equal(a?.runtime_translation, 'prohibited', `${key}: PM §MVP-IS5 AC7`);
    assert.notEqual(a?.channel, 'undetermined', `${key}: the panel's channel is known`);
  }
});

// ─── (b) the coherence predicates, each proven by constructing its forgery ───

function withRecord(locale: string, key: string, patch: Record<string, unknown>): ReviewRegister {
  const base = loadReviewRegister();
  return {
    ...base,
    entries: {
      ...base.entries,
      [locale]: {
        ...base.entries[locale],
        [key]: { ...base.entries[locale]?.[key], ...patch } as never,
      },
    },
  };
}

/** A delivery that genuinely happened, expressed in dates a test can reason about. */
const START = '2026-10-24';
const STAGES_DONE = '2026-12-01T09:00:00Z';
const REVIEWED = '2026-12-02T09:00:00Z';
const NOW = Date.parse('2026-12-03T00:00:00Z');

const PRACTITIONER = 'P. Practitioner, safeguarding practitioner (Cyprus)';
const TRANSLATOR = 'T. Translator, professional translator';
const DSL = 'B. Lead, DSL';
const DEPUTY = 'D. Deputy, deputy DSL';

/** A coherent Russian sign-off: translated by the briefed translator, reviewed by the DSL. */
const SIGNED = {
  provenance: 'translated_professional',
  status: 'signed_off',
  authored_by: TRANSLATOR,
  reviewed_by: DSL,
  reviewed_at: REVIEWED,
};

/** A pipeline in the state it would be in AFTER a real delivery — everything else valid. */
function deliveredPipeline(): CopyPipeline {
  const p = loadCopyPipeline();
  const names: Record<string, string> = {
    greek_authoring_safeguarding_practitioner: PRACTITIONER,
    russian_translator_briefed: TRANSLATOR,
    dsl: DSL,
    dsl_deputy: DEPUTY,
  };
  return {
    ...p,
    external_start: START,
    roles: Object.fromEntries(
      Object.entries(p.roles).map(([id, r]) => [
        id,
        { ...r, named: names[id] ?? `${id} person`, confirmed_by_stakeholder_on: '2026-10-20' },
      ]),
    ),
    stages: p.stages.map((s) => ({ ...s, completed_at: STAGES_DONE })),
    // `session.checkins_missed` must have a decided channel before anything can
    // be signed off — the fixture below signs off a key that is not it, but the
    // channel rule is per key and this keeps the baseline honest.
    assignments: p.assignments,
  };
}

test('the coherence predicates are SATISFIABLE — a genuine delivery reports nothing', () => {
  // The test that stops the whole predicate set being vacuous. A check nothing
  // can ever pass is as useless as one nothing can fail, and after QA-F2 tightened
  // five rules at once this is the one that proves they can all hold together.
  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', SIGNED),
    deliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
});

test('the coherence predicates are silent on the register as it actually stands', () => {
  assert.deepEqual(
    pipelineIncoherences(loadReviewRegister(), loadCopyPipeline(), LOCALES, SAFETY_KEYS),
    [],
    'nothing is signed off today, so nothing should be contradicted',
  );
});

test('NEGATIVE — a sign-off whose provenance is not the method the pipeline required', () => {
  // The forgery this one refuses: Greek produced by translating the English and
  // recorded as `translated_professional`, signed off, gate green. The pipeline
  // says Greek is AUTHORED, so the record and the plan disagree and it is caught.
  const problems = pipelineIncoherences(
    withRecord('el', 'safety.sos.confirm', SIGNED),
    deliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((p) =>
      /el\/safety\.sos\.confirm: signed off with provenance 'translated_professional', but the pipeline requires 'authored'/.test(
        p,
      ),
    ),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — the author signed off their own safety copy', () => {
  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', { ...SIGNED, authored_by: DSL }),
    deliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((p) => /both authored and signed off this safety string/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — signed off by someone who is not the named DSL or deputy', () => {
  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', { ...SIGNED, reviewed_by: 'Someone Else' }),
    deliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((p) => /not the named DSL or deputy in pipeline\.roles/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — a reviewer named in the roster but never confirmed by a stakeholder', () => {
  const delivered = deliveredPipeline();
  const unconfirmed: CopyPipeline = {
    ...delivered,
    roles: {
      ...delivered.roles,
      dsl: { ...delivered.roles['dsl'], confirmed_by_stakeholder_on: null } as never,
    },
  };
  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', SIGNED),
    unconfirmed,
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((p) => /carries no stakeholder confirmation date/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — signed off while a blocking stage never completed', () => {
  // The one that catches the most likely real-world version of this: Russian
  // translated by a competent professional who was never briefed on the
  // safeguarding context, producing copy that is grammatically perfect and
  // operationally useless (SA §TS-12.4, in those words).
  const delivered = deliveredPipeline();
  const unbriefed: CopyPipeline = {
    ...delivered,
    stages: delivered.stages.map((s) =>
      s.id === 'brief_ru_translator' ? { ...s, completed_at: null } : s,
    ),
  };
  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', SIGNED),
    unbriefed,
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((p) => /blocking pipeline stage 'brief_ru_translator' is not complete/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — signed off while nobody has decided whether the string is spoken', () => {
  // `session.checkins_missed` is an escalation-ladder message and DV-7 adds an
  // automated VOICE rung with pre-recorded audio per locale (SA §INT-5r). Whether
  // this key rides that rung is T-105's determination. Until it is made, the
  // read-aloud pass may or may not apply — so sign-off is refused rather than the
  // question being quietly dropped.
  const pipeline = loadCopyPipeline();
  assert.equal(pipeline.assignments['session.checkins_missed']?.channel, 'undetermined');
  const problems = pipelineIncoherences(
    withRecord('ru', 'session.checkins_missed', SIGNED),
    deliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((p) => /signed off while its channel is undetermined/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — a safety_critical key with no pipeline assignment at all', () => {
  const pipeline = loadCopyPipeline();
  const stripped: CopyPipeline = { ...pipeline, assignments: {} };
  const problems = pipelineIncoherences(loadReviewRegister(), stripped, LOCALES, SAFETY_KEYS, NOW);
  assert.equal(problems.length, SAFETY_KEYS.length, JSON.stringify(problems, null, 2));
  assert.ok(problems.every((p) => /has nobody who must author it/.test(p)));
});

test('NEGATIVE — an absent pipeline block fails closed rather than reading as empty', () => {
  assert.throws(
    () => loadCopyPipeline('/nonexistent-root-for-t-049'),
    (err: unknown) => err instanceof Error,
  );
});

// ─── QA-F2: five forgeries the first version of these predicates let through ───

function ruProblems(patch: Record<string, unknown>, pipeline = deliveredPipeline()): string[] {
  return pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', { ...SIGNED, ...patch }),
    pipeline,
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
}

test('NEGATIVE — QA-F2: one human spelled two ways passes string inequality', () => {
  // The load-bearing one. `authored_by !== reviewed_by` was string inequality over
  // unconstrained free text, so "B. Lead" and "B. Lead, DSL" are one person and
  // the four-eyes check saw two. Both names now resolve against the roster, so
  // distinctness is between identified ROLES rather than between two strings —
  // and a name that resolves to nothing is refused outright, which is what
  // catches this spelling.
  const problems = ruProblems({ authored_by: 'B. Lead' });
  assert.ok(
    problems.some((p) => /authored_by 'B\. Lead' is not a named person in pipeline\.roles/.test(p)),
    JSON.stringify(problems, null, 2),
  );
  // And the same human properly named is caught as a role collision, not a typo.
  const asRole = ruProblems({ authored_by: DSL });
  assert.ok(
    asRole.some((p) => /authored_by holds a reviewer role/.test(p)),
    JSON.stringify(asRole, null, 2),
  );
});

test('NEGATIVE — QA-F2: a machine in authored_by, on a register whose subject is that MT is banned', () => {
  const problems = ruProblems({ authored_by: 'DeepL Pro v3 (machine)' });
  assert.ok(
    problems.some((p) => /is not a named person in pipeline\.roles/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — QA-F2: the wrong role produced the copy', () => {
  // The practitioner authoring Russian, or the translator authoring Greek: both
  // are named, confirmed humans, and both are the wrong human for the method the
  // pipeline recorded. Derived from `AUTHORING_ROLE_FOR_METHOD`, not hand-listed.
  const problems = ruProblems({ authored_by: PRACTITIONER });
  assert.ok(
    problems.some((p) =>
      /authored_by is the 'greek_authoring_safeguarding_practitioner', but the pipeline requires this locale to be produced by the 'russian_translator_briefed'/.test(
        p,
      ),
    ),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — QA-F2: reviewed_at was bounded by nothing at either end', () => {
  const old = ruProblems({ reviewed_at: '2019-04-01T09:00:00Z' });
  assert.ok(
    old.some((p) => /predates the day this pipeline was opened/.test(p)),
    JSON.stringify(old, null, 2),
  );
  const future = ruProblems({ reviewed_at: '2027-06-01T09:00:00Z' });
  assert.ok(
    future.some((p) => /is in the future/.test(p)),
    JSON.stringify(future, null, 2),
  );
});

test('NEGATIVE — QA-F2: signed off before the translator was briefed', () => {
  // The most likely real version: every stage genuinely completed, the reviewer
  // real, the author real — and the sign-off dated before the brief landed. The
  // floor is DERIVED from the blocking stages' own completion dates rather than
  // written as a fixed date that would rot the moment the schedule moved.
  const problems = ruProblems({ reviewed_at: '2026-11-01T09:00:00Z' });
  assert.ok(
    problems.some((p) => /precedes the completion of a blocking pipeline stage/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — QA-F2: signed off before the copy was even sent out for authorship', () => {
  const p = deliveredPipeline();
  const noStages: CopyPipeline = {
    ...p,
    stages: p.stages.map((s) => ({ ...s, completed_at: null })),
  };
  const problems = ruProblems({ reviewed_at: '2026-10-01T09:00:00Z' }, noStages);
  assert.ok(
    problems.some((p2) => /predates external_start/.test(p2)),
    JSON.stringify(problems, null, 2),
  );
});

// ─── Round-2 residuals. Every one of these fires on a STAKEHOLDER ACTION —
// naming a person into the roster, or recording a real external_start — not on a
// ticket dispatch. There is no ticket between here and the moment they matter,
// which is why they are closed here rather than carried.

test('NEGATIVE — R2-F2: one person named as both DSL and deputy defeats the pair', () => {
  // PM §MVP-L5 AC7 makes trilingual coverage a property of TWO people: the DSL
  // and deputy must cover English, Greek and Russian BETWEEN THEM. A pair of one
  // covers whatever that one person covers, and every other predicate here stayed
  // silent about it — including the four-eyes check, because the author was still
  // a different name. This is the hole the stakeholder falls into on their very
  // next action.
  const p = deliveredPipeline();
  const oneHuman: CopyPipeline = {
    ...p,
    roles: { ...p.roles, dsl_deputy: { ...p.roles['dsl_deputy']!, named: DSL } },
  };
  const problems = pipelineIncoherences(loadReviewRegister(), oneHuman, LOCALES, SAFETY_KEYS, NOW);
  assert.ok(
    problems.some((x) => /named as both the DSL and the deputy DSL/.test(x)),
    JSON.stringify(problems, null, 2),
  );
  // And it fires with NOTHING signed off — the register as it actually stands.
  // A rule that only bit at sign-off time would bite months after the mistake.
});

test('NEGATIVE — R2-F2: one person on both sides of four eyes, caught at naming time', () => {
  const p = deliveredPipeline();
  const same: CopyPipeline = {
    ...p,
    roles: {
      ...p.roles,
      greek_authoring_safeguarding_practitioner: {
        ...p.roles['greek_authoring_safeguarding_practitioner']!,
        named: DSL,
      },
    },
  };
  const problems = pipelineIncoherences(loadReviewRegister(), same, LOCALES, SAFETY_KEYS, NOW);
  assert.ok(
    problems.some((x) => /holds both an authoring role .* and a reviewing role/.test(x)),
    JSON.stringify(problems, null, 2),
  );
});

test('R2-F2: practitioner and translator as one person is NOT banned — only claiming a brief is', () => {
  // Deliberately not a ban. A trilingual safeguarding practitioner authoring all
  // three locales natively is BETTER than a translation, and a rule forbidding it
  // would be enforcing a staffing shape the specs do not require. What is
  // incoherent is calling it a translation: there is no translator to brief and
  // no brief to acknowledge, so two blocking stages describe nothing.
  const p = deliveredPipeline();
  const dual: CopyPipeline = {
    ...p,
    roles: {
      ...p.roles,
      russian_translator_briefed: {
        ...p.roles['russian_translator_briefed']!,
        named: PRACTITIONER,
      },
    },
  };
  const claimed = pipelineIncoherences(loadReviewRegister(), dual, LOCALES, SAFETY_KEYS, NOW);
  assert.ok(
    claimed.some((x) => /One person cannot be briefed by themselves/.test(x)),
    JSON.stringify(claimed, null, 2),
  );

  // Re-declare `ru` as natively authored and the same roster is fine.
  const authoredRu: CopyPipeline = {
    ...dual,
    assignments: Object.fromEntries(
      Object.entries(dual.assignments).map(([k, a]) => [
        k,
        {
          ...a,
          locales: {
            ...a.locales,
            ru: { ...a.locales['ru']!, method: 'authored', required_provenance: 'authored' },
          },
        },
      ]),
    ),
  };
  assert.deepEqual(
    pipelineIncoherences(loadReviewRegister(), authoredRu, LOCALES, SAFETY_KEYS, NOW),
    [],
    'a practitioner authoring all three locales natively must be permitted',
  );
});

test('NEGATIVE — R2-F2: a duplicated name no longer resolves by JSON key order', () => {
  // `roleOfName` was `Map.set` in a loop, so a name held by two roles resolved to
  // whichever key JSON happened to write last, and every downstream check
  // inherited that. Order-dependence is now a reported finding, and resolution is
  // by declaration order so the message is at least deterministic.
  const p = deliveredPipeline();
  const dup = (order: readonly string[]): CopyPipeline => ({
    ...p,
    roles: Object.fromEntries(
      order.map((id) => [
        id,
        { ...p.roles[id]!, named: id === 'dsl_deputy' ? DSL : p.roles[id]!.named },
      ]),
    ),
  });
  const forward = pipelineIncoherences(
    loadReviewRegister(),
    dup([
      'dsl',
      'dsl_deputy',
      'greek_authoring_safeguarding_practitioner',
      'russian_translator_briefed',
    ]),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  const reversed = pipelineIncoherences(
    loadReviewRegister(),
    dup([
      'dsl_deputy',
      'dsl',
      'greek_authoring_safeguarding_practitioner',
      'russian_translator_briefed',
    ]),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(forward.some((x) => /named as both the DSL and the deputy DSL/.test(x)));
  assert.deepEqual(
    forward.filter((x) => /pipeline\.roles:/.test(x)),
    reversed.filter((x) => /pipeline\.roles:/.test(x)),
    'the finding must not depend on JSON key order',
  );
});

test('NEGATIVE — R2-F1: the AUTHOR must carry a stakeholder confirmation date too', () => {
  // The prose said "each carrying a stakeholder confirmation date"; only the
  // reviewer's was checked. Implemented rather than narrowed — an unconfirmed
  // author is the same hole as an unconfirmed reviewer: a name added in the same
  // commit as the sign-off, vouched for by nobody.
  const p = deliveredPipeline();
  const unconfirmedAuthor: CopyPipeline = {
    ...p,
    roles: {
      ...p.roles,
      russian_translator_briefed: {
        ...p.roles['russian_translator_briefed']!,
        confirmed_by_stakeholder_on: null,
      },
    },
  };
  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', SIGNED),
    unconfirmedAuthor,
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((x) =>
      /authored_by '.*' is named in pipeline\.roles but carries no stakeholder confirmation date/.test(
        x,
      ),
    ),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — R2-F1: "pending" is not a confirmation date', () => {
  const p = deliveredPipeline();
  const pending: CopyPipeline = {
    ...p,
    roles: { ...p.roles, dsl: { ...p.roles['dsl']!, confirmed_by_stakeholder_on: 'pending' } },
  };
  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', SIGNED),
    pending,
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.ok(
    problems.some((x) => /is 'pending', which is not a date/.test(x)),
    JSON.stringify(problems, null, 2),
  );
  assert.ok(
    problems.some((x) => /carries no stakeholder confirmation date/.test(x)),
    'and the sign-off itself must be refused, not only the roster flagged',
  );
});

test('NEGATIVE — R2-F3: the pending_pipeline mirror disagreeing with the source is a finding', () => {
  // Harmless today only because both are separately asserted null. Live the
  // moment a real start is recorded in one of them — which is a stakeholder
  // action, in this file, with no ticket in between.
  const register = loadReviewRegister();
  const waiver = { ...register.pending_pipeline!, external_start: '2026-10-24' };
  const pipeline = loadCopyPipeline(); // external_start still null
  const problems = reAnchorProblems(
    waiver,
    pipeline,
    ORIGINAL_EXPECTED_BY,
    MAX_UNSTARTED_RE_ANCHORS,
  );
  assert.ok(
    problems.some((x) => /does not match pipeline\.external_start/.test(x)),
    JSON.stringify(problems, null, 2),
  );
  // And the exemption is decided from the SOURCE, not the mirror: the waiver's
  // mirror claims a start, the source says null, so the row still counts.
  const forged = {
    ...waiver,
    expected_by: '2027-01-16',
    re_anchors: [
      ...(waiver.re_anchors ?? []),
      {
        from: DEADLINE,
        to: '2027-01-16',
        decided_on: '2026-12-05',
        decided_by: 'x',
        reason: 'y',
        external_start_at_decision: '2026-10-24',
      },
    ],
  };
  const p2 = reAnchorProblems(forged, pipeline, ORIGINAL_EXPECTED_BY, MAX_UNSTARTED_RE_ANCHORS);
  assert.ok(
    p2.some((x) => /over a bound of 1/.test(x)),
    JSON.stringify(p2, null, 2),
  );
});

test('the mirror and the source agree in the register as it actually stands', () => {
  const register = loadReviewRegister();
  const pipeline = loadCopyPipeline();
  assert.equal(register.pending_pipeline?.external_start, pipeline.external_start);
  assert.deepEqual(
    reAnchorProblems(
      register.pending_pipeline!,
      pipeline,
      ORIGINAL_EXPECTED_BY,
      MAX_UNSTARTED_RE_ANCHORS,
    ),
    [],
  );
});
