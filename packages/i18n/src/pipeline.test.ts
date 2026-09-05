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
  assert.deepEqual(reAnchorProblems(waiver, ORIGINAL_EXPECTED_BY, MAX_UNSTARTED_RE_ANCHORS), []);
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
  const problems = reAnchorProblems(waiver, ORIGINAL_EXPECTED_BY, MAX_UNSTARTED_RE_ANCHORS);
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
  const problems = reAnchorProblems(waiver, ORIGINAL_EXPECTED_BY, MAX_UNSTARTED_RE_ANCHORS);
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
  const problems = reAnchorProblems(waiver, ORIGINAL_EXPECTED_BY, MAX_UNSTARTED_RE_ANCHORS);
  assert.ok(
    problems.some((p) => /over a bound of 1/.test(p)),
    JSON.stringify(problems, null, 2),
  );
  // And the same move, once the pipeline is genuinely running, is scheduling
  // rather than drift — so it is permitted.
  const started = {
    ...waiver,
    re_anchors: waiver.re_anchors.map((r, i) =>
      i === waiver.re_anchors.length - 1 ? { ...r, external_start_at_decision: '2026-10-24' } : r,
    ),
  };
  assert.deepEqual(reAnchorProblems(started, ORIGINAL_EXPECTED_BY, MAX_UNSTARTED_RE_ANCHORS), []);
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

const SIGNED = {
  provenance: 'translated_professional',
  status: 'signed_off',
  authored_by: 'A. Translator, professional translator',
  reviewed_by: 'B. Lead, DSL',
  reviewed_at: '2026-10-14T09:00:00Z',
};

/** A pipeline in the state it would be in AFTER a real delivery — everything else valid. */
function deliveredPipeline(): CopyPipeline {
  const p = loadCopyPipeline();
  return {
    ...p,
    external_start: '2026-09-05',
    roles: Object.fromEntries(
      Object.entries(p.roles).map(([id, r]) => [
        id,
        {
          ...r,
          named: id === 'dsl' ? 'B. Lead, DSL' : `${id} person`,
          confirmed_by_stakeholder_on: '2026-09-05',
        },
      ]),
    ),
    stages: p.stages.map((s) => ({ ...s, completed_at: '2026-10-14T09:00:00Z' })),
  };
}

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
    withRecord('ru', 'safety.sos.confirm', { ...SIGNED, authored_by: 'B. Lead, DSL' }),
    deliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
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
  );
  assert.ok(
    problems.some((p) => /signed off while its channel is undetermined/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — a safety_critical key with no pipeline assignment at all', () => {
  const pipeline = loadCopyPipeline();
  const stripped: CopyPipeline = { ...pipeline, assignments: {} };
  const problems = pipelineIncoherences(loadReviewRegister(), stripped, LOCALES, SAFETY_KEYS);
  assert.equal(problems.length, SAFETY_KEYS.length, JSON.stringify(problems, null, 2));
  assert.ok(problems.every((p) => /has nobody who must author it/.test(p)));
});

test('NEGATIVE — an absent pipeline block fails closed rather than reading as empty', () => {
  assert.throws(
    () => loadCopyPipeline('/nonexistent-root-for-t-049'),
    (err: unknown) => err instanceof Error,
  );
});
