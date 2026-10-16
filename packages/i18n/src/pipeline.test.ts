/**
 * `review.json` § `pipeline` — the trilingual safety-copy pipeline as data.
 * T-049; SD §DH-5 external dependency 2; SA §TS-12.4; PM §MVP-L4 AC4,
 * §MVP-L5 AC7, §MVP-IS5 AC7; DV-7, DV-11.
 *
 * T-259 (stakeholder ruling OE-5, 2026-10-11) deleted the first of the two
 * kinds of test this file had: the ANCHORED ARITHMETIC over the deadline, the
 * lead time, the latest external start, the re-anchor chain and its bound
 * (`DEADLINE`, `LEAD_TIME_DAYS`, `ORIGINAL_EXPECTED_BY`,
 * `MAX_UNSTARTED_RE_ANCHORS`). Those dates measured the time left for a human
 * engagement the ruling abolished, and the register no longer carries them;
 * one test below asserts that it does not.
 *
 * What remains, and the difference still matters:
 *
 *  (b) **Coherence between the plan and the delivery.** Everything that would
 *      have to be true for a `signed_off` record to be believable. These pass
 *      today by covering nothing — no record is signed off — so each one is
 *      proven by CONSTRUCTING the forgery it exists to refuse and watching it
 *      come back as a problem. A predicate that has only ever seen a green
 *      corpus has not been shown to be wired to anything.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadReviewRegister,
  loadCopyPipeline,
  pipelineIncoherences,
  stageManifestProblems,
  stageApplies,
} from './review.ts';
import type { ReviewRegister, CopyPipeline } from './review.ts';
import { keysAtTier } from './tiers.ts';
import { enabledLocales } from './registry.ts';
import { MODEL, AI_RULINGS } from '../tools/rulings.ts';

const LOCALES = enabledLocales().map((l) => l.code);
const SAFETY_KEYS = [...keysAtTier('safety_critical')];

/*
 * T-233's `MODEL` and `AI_RULINGS` — the model identity OE-66/OE-67 name and
 * the ONLY rulings that make a model an author — were written here as
 * literals. T-258 moved them, unchanged, into `tools/rulings.ts` so that
 * `gate:safety-review-currency` reads the same literal (closing OD-258's split,
 * where only this suite could tell a legitimate AI record from a forged one).
 * They are still never read from `review.json`; see that file's header.
 */

test('the pipeline block exists, is loaded fail-closed, and carries no date in force (T-259, OE-5)', () => {
  // T-259 deleted the five fields that put a date in force — they measured the
  // time left for a human engagement that stakeholder ruling OE-5 abolished —
  // and `pending_pipeline`'s re-anchor chain with them. Re-adding any of them
  // turns this red. `engineering_kickoff` stays: it records a past day.
  const pipeline = loadCopyPipeline() as unknown as Record<string, unknown>;
  for (const gone of [
    'deadline',
    'lead_time_days',
    'latest_external_start',
    'external_start',
    'blocked_on',
  ]) {
    assert.ok(!(gone in pipeline), `pipeline.${gone} is back; no date is in force since OE-5`);
  }
  assert.equal(pipeline['engineering_kickoff'], '2026-09-05');
  assert.equal(loadReviewRegister().pending_pipeline, null, 'pending_pipeline is null since T-259');
});

test('nothing in the pipeline claims a person or a stage that has happened', () => {
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
  // T-233: the committed records now cite a ruling (`ai_authored`). A patch that
  // does not mention `ruling` describes a HUMAN-path record, as every fixture
  // written before T-233 assumes, so the base record's citation is dropped
  // rather than left dangling on a `translated_professional` record.
  const prior: Record<string, unknown> = { ...base.entries[locale]?.[key] };
  if (!('ruling' in patch)) delete prior['ruling'];
  return {
    ...base,
    entries: {
      ...base.entries,
      [locale]: {
        ...base.entries[locale],
        [key]: { ...prior, ...patch } as never,
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
    AI_RULINGS,
  );
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
});

test('the coherence predicates are silent on the register as it actually stands', () => {
  assert.deepEqual(
    pipelineIncoherences(
      loadReviewRegister(),
      loadCopyPipeline(),
      LOCALES,
      SAFETY_KEYS,
      Date.now(),
      AI_RULINGS,
    ),
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
    AI_RULINGS,
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
    AI_RULINGS,
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
    AI_RULINGS,
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
    AI_RULINGS,
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
    AI_RULINGS,
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
    AI_RULINGS,
  );
  assert.ok(
    problems.some((p) => /signed off while its channel is undetermined/.test(p)),
    JSON.stringify(problems, null, 2),
  );
});

test('NEGATIVE — a safety_critical key with no pipeline assignment at all', () => {
  const pipeline = loadCopyPipeline();
  const stripped: CopyPipeline = { ...pipeline, assignments: {} };
  const problems = pipelineIncoherences(
    loadReviewRegister(),
    stripped,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
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
    AI_RULINGS,
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

test('NEGATIVE — QA-F2 / T-233: a machine author WITHOUT an OE-66/67 citation is still refused', () => {
  // The DeepL case, converted rather than deleted. OE-66/OE-67 opened ONE route
  // for a non-human author, and it is a citation, not a relaxation: the rulings
  // are passed in (AI_RULINGS), so this is refused WITH the rulings in force —
  // not by the fail-closed default.
  const problems = ruProblems({ authored_by: 'DeepL Pro v3 (machine)' });
  assert.ok(
    problems.some((p) =>
      /is not a named person in pipeline\.roles, and the record cites no stakeholder ruling/.test(
        p,
      ),
    ),
    JSON.stringify(problems, null, 2),
  );
  // …and at PENDING status too. An unreviewed record naming a machine is still a
  // claim about who wrote safety copy, and it is refused before anyone signs it.
  const pending = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', {
      provenance: 'translated_professional',
      status: 'pending_review',
      authored_by: 'DeepL Pro v3 (machine)',
      reviewed_by: null,
      reviewed_at: null,
    }),
    deliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
  assert.ok(
    pending.some((p) =>
      /ru\/safety\.sos\.confirm: authored_by 'DeepL Pro v3 \(machine\)' is not a named person in pipeline\.roles, and the record cites no stakeholder ruling/.test(
        p,
      ),
    ),
    JSON.stringify(pending, null, 2),
  );
  // …and dressed up as AI authorship: `ai_authored` and a real OE-66 citation,
  // but not the model OE-66 names. The route is for the ruling's model, not for
  // any engine that can be typed into the field.
  const dressed = ruProblems({
    provenance: 'ai_authored',
    ruling: 'OE-66',
    authored_by: 'DeepL Pro v3 (machine)',
  });
  assert.ok(
    dressed.some((p) =>
      /ai_authored under OE-66, but authored_by is "DeepL Pro v3 \(machine\)"/.test(p),
    ),
    JSON.stringify(dressed, null, 2),
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
// naming a person into the roster (and, until T-259 deleted the field, recording an external_start) — not on a
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
  const problems = pipelineIncoherences(
    loadReviewRegister(),
    oneHuman,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
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
  const problems = pipelineIncoherences(
    loadReviewRegister(),
    same,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
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
  const claimed = pipelineIncoherences(
    loadReviewRegister(),
    dual,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
  assert.ok(
    claimed.some((x) => /One person cannot be briefed by themselves/.test(x)),
    JSON.stringify(claimed, null, 2),
  );

  // Re-declare `ru` as natively authored and the same roster is fine — provided
  // the two stages that describe a translation are honestly null, which is what
  // the R3 applicability rule below both permits and requires.
  const authoredRu: CopyPipeline = {
    ...dual,
    stages: dual.stages.map((s) =>
      s.id === 'brief_ru_translator' || s.id === 'translate_ru' ? { ...s, completed_at: null } : s,
    ),
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
    pipelineIncoherences(loadReviewRegister(), authoredRu, LOCALES, SAFETY_KEYS, NOW, AI_RULINGS),
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
    AI_RULINGS,
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
    AI_RULINGS,
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
    AI_RULINGS,
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
    AI_RULINGS,
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

// ─── §5.1 re-read: claims in the published contract that had no test ───

test("T-040's published `entries` shape survives this ticket, field by field", () => {
  // The contract said "nothing T-044 codes against has changed" and offered no
  // way to find out if that stopped being true. T-040 § Published contract §6
  // names exactly these fields and exactly this rule; a downstream gate is built
  // on them, so they are asserted here rather than asserted about.
  const register = loadReviewRegister();
  for (const locale of LOCALES) {
    for (const key of SAFETY_KEYS) {
      const r = register.entries[locale]?.[key];
      assert.ok(r !== undefined, `${locale}/${key} missing`);
      assert.match(r.content_hash, /^sha256:[0-9a-f]{64}$/);
      assert.ok(
        [
          'authored',
          'translated_professional',
          'legal_review',
          'placeholder',
          'ai_authored',
        ].includes(r.provenance),
      );
      // T-233 widened this shape ADDITIVELY and only in these two ways: one new
      // provenance value, and one optional field that is present exactly when
      // that value is. A T-044-style reader that ignores `ruling` loses nothing.
      assert.equal(
        r.provenance === 'ai_authored',
        typeof r.ruling === 'string',
        `${locale}/${key}: \`ruling\` must be present exactly when provenance is ai_authored`,
      );
      // T-258 widened it ADDITIVELY again, in the same two ways: one terminal
      // status (final, reviewed by nobody, by stakeholder ruling OE-5) and one
      // optional field naming that ruling, present exactly when that status is.
      assert.ok(['signed_off', 'pending_review', 'unreviewed_by_ruling'].includes(r.status));
      assert.equal(
        r.status === 'unreviewed_by_ruling',
        typeof r.review_ruling === 'string',
        `${locale}/${key}: \`review_ruling\` must be present exactly when status is unreviewed_by_ruling`,
      );
      for (const f of ['authored_by', 'reviewed_by', 'reviewed_at'] as const) {
        assert.ok(r[f] === null || typeof r[f] === 'string', `${locale}/${key}.${f}`);
      }
    }
  }
});

test('the build-time review module is not reachable from the browser entry point', () => {
  // The contract says `rendersNothingVisible`/`describeContentFree` "are not part
  // of the package surface", and that `@kinvara/i18n/review` is build-time only.
  // Both were assertions about a package.json nobody was reading.
  const pkg: { exports: Record<string, string> } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './compiled/*', './review'].sort());
  assert.ok(
    !Object.values(pkg.exports).some((v) => v.includes('tools/')),
    'tools/ must not be an export — compile.ts reads the filesystem at build time',
  );
});

test('NEGATIVE — the stage list is a SEQUENCE, which the contract claimed and nothing checked', () => {
  // Turned up by the §5.1 re-read of my own contract: "Stage ids, all blocking,
  // in order" was a claim with no test. Same family as QA's F6d one level up.
  const p = deliveredPipeline();
  const outOfOrder: CopyPipeline = {
    ...p,
    stages: p.stages.map((s) =>
      s.id === 'brief_ru_translator' ? { ...s, completed_at: '2026-12-01T10:00:00Z' } : s,
    ),
  };
  const problems = pipelineIncoherences(
    loadReviewRegister(),
    outOfOrder,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
  assert.ok(
    problems.some((x) =>
      /'translate_ru' completed .*, before 'brief_ru_translator' which precedes it/.test(x),
    ),
    JSON.stringify(problems, null, 2),
  );
});

/**
 * R3-F1. The stages SA §TS-12.4 defines, in its order. Written HERE, never
 * read from `review.json` — a register supplying the list it is checked against
 * would be checking that it equals itself, which is how `blocking` came to be
 * flippable with the suite green.
 *
 * T-264 (OE-82): FOUR, not six. `in_context_screenshot_review` and
 * `read_aloud_voice` were `who: "dsl"` stages; under OE-82 they are automated
 * gates (`gate:safety-copy-render`, `gate:read-aloud`) enforced by
 * gate:safety-review-currency at the terminal status, and `pipeline.stages`
 * may not carry them back: re-adding either, with any `who`, is red here (NEG
 * `T264-STAGE-READDED-DSL`). The four left are the human path T-260 deletes.
 */
const STAGE_MANIFEST: readonly string[] = [
  'author_en_el',
  'brief_ru_translator',
  'translate_ru',
  'dsl_signoff',
];

test('R3-F1: four stage ids, that order, ALL BLOCKING (T-264: the 360 px and read-aloud checks are gates, not stages)', () => {
  assert.deepEqual(stageManifestProblems(loadCopyPipeline(), STAGE_MANIFEST), []);
});

test('NEGATIVE — R3-F1: clearing ANY stage’s `blocking` flag goes red', () => {
  // The half the §5.1 re-read missed, and the one carrying the weight: `blocking`
  // is the flag the sign-off rule reads, so clearing `dsl_signoff.blocking`
  // removed DSL sign-off from the requirement while all 94 tests stayed green.
  // Asserted at every position, not just the one QA happened to flip.
  const p = loadCopyPipeline();
  for (const [i, stage] of p.stages.entries()) {
    const flipped: CopyPipeline = {
      ...p,
      stages: p.stages.map((s, j) => (i === j ? { ...s, blocking: false } : s)),
    };
    const problems = stageManifestProblems(flipped, STAGE_MANIFEST);
    assert.ok(
      problems.some((x) => x.includes(`['${stage.id}'].blocking is false`)),
      `clearing blocking on '${stage.id}' must be caught — got ${JSON.stringify(problems)}`,
    );
  }
});

test('NEGATIVE — R3-F1: adding, removing or reordering a stage goes red', () => {
  const p = loadCopyPipeline();
  const mutations: readonly (readonly [string, CopyPipeline])[] = [
    ['removed', { ...p, stages: p.stages.filter((s) => s.id !== 'dsl_signoff') }],
    ['reordered', { ...p, stages: [...p.stages].reverse() }],
    [
      'renamed',
      {
        ...p,
        stages: p.stages.map((s) => (s.id === 'dsl_signoff' ? { ...s, id: 'dsl_signoff_v2' } : s)),
      },
    ],
  ];
  for (const [label, mutated] of mutations) {
    assert.ok(
      stageManifestProblems(mutated, STAGE_MANIFEST).some((x) =>
        /is a change to the pipeline, not to a list/.test(x),
      ),
      `${label} must be caught`,
    );
  }
});

test('T-264: pipeline.automated_checks names the two gates and their records, and carries no who, no completed_at and no applicability', () => {
  const checks = loadCopyPipeline().automated_checks;
  assert.ok(checks !== undefined, 'pipeline.automated_checks is absent');
  assert.deepEqual(
    checks.map((c) => [c.id, c.gate, c.ticket, c.record]),
    [
      ['read_aloud', 'gate:read-aloud', 'T-263', 'packages/i18n/checks/read-aloud.json'],
      ['render_360', 'gate:safety-copy-render', 'T-265', 'packages/i18n/checks/render-360.json'],
    ],
  );
  for (const c of checks) {
    // Descriptive only: a person, a date or a key list here would be a stage
    // under another name, and applicability lives in gate source.
    assert.deepEqual(Object.keys(c).sort(), ['gate', 'id', 'record', 'ticket', 'what'], c.id);
  }
});

test('R3: the dual-role path no longer demands a completion for an event that cannot happen', () => {
  // The complement QA named of the rule I had just written. One practitioner
  // authoring all three locales natively is permitted (§4b) precisely because
  // there is nobody to brief — yet `brief_ru_translator` and `translate_ru` were
  // still blocking, so signing anything off demanded a `completed_at` for two
  // events that did not occur. My own mechanism was manufacturing pressure to
  // write a false date, which is the pattern this register exists to prevent.
  const p = deliveredPipeline();
  const nativeRu: CopyPipeline = {
    ...p,
    roles: {
      ...p.roles,
      russian_translator_briefed: {
        ...p.roles['russian_translator_briefed']!,
        named: PRACTITIONER,
      },
    },
    assignments: Object.fromEntries(
      Object.entries(p.assignments).map(([k, a]) => [
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
    // Honestly null: these two events did not happen.
    stages: p.stages.map((s) =>
      s.id === 'brief_ru_translator' || s.id === 'translate_ru' ? { ...s, completed_at: null } : s,
    ),
  };
  assert.equal(stageApplies('brief_ru_translator', nativeRu), false);
  assert.equal(stageApplies('translate_ru', nativeRu), false);
  assert.equal(stageApplies('dsl_signoff', nativeRu), true);

  const problems = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', {
      ...SIGNED,
      provenance: 'authored',
      authored_by: PRACTITIONER,
    }),
    nativeRu,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));

  // And the flags themselves are untouched — applicability is DERIVED, not a
  // flag anyone can clear. R3-F1's manifest still holds over this pipeline.
  assert.deepEqual(stageManifestProblems(nativeRu, STAGE_MANIFEST), []);
});

test('NEGATIVE — R3: a stage that could not have happened may not be dated', () => {
  // The inverse, without which the exemption is a licence: drop
  // `translated_briefed` from every locale and then date the briefing anyway.
  const p = deliveredPipeline();
  const nativeRu: CopyPipeline = {
    ...p,
    assignments: Object.fromEntries(
      Object.entries(p.assignments).map(([k, a]) => [
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
    // …but the briefing is still dated.
  };
  const problems = pipelineIncoherences(
    loadReviewRegister(),
    nativeRu,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
  assert.ok(
    problems.some((x) => /'brief_ru_translator'.*may not be dated/.test(x)),
    JSON.stringify(problems, null, 2),
  );
});

test('the register as it stands: every stage applies, and none is dated', () => {
  // The real file uses `translated_briefed` for `ru`, so all four stages apply —
  // the exemption above is reachable only by a roster that does not exist yet.
  const p = loadCopyPipeline();
  for (const id of STAGE_MANIFEST) assert.equal(stageApplies(id, p), true, id);
  assert.deepEqual(
    p.stages.filter((s) => s.completed_at !== null),
    [],
  );
});

// ─── T-233: the AI-authorship route (OE-66 / OE-67, EV-16) ───
//
// One route for a non-human author, and the tests below pin both of its edges:
// what it ACCEPTS (a truthfully recorded model, under a ruling that covers the
// locale, at any status short of `signed_off`), and what it still REFUSES — every forgery the
// human path refuses, plus the ones this route itself could invite.

/** A DSL sign-off of OE-66 copy: the model authored it, the named human DSL reviewed it. */
const AI_SIGNED = {
  provenance: 'ai_authored',
  ruling: 'OE-66',
  status: 'signed_off',
  authored_by: MODEL,
  reviewed_by: DSL,
  reviewed_at: REVIEWED,
};

const AUTHORING_STAGES = ['author_en_el', 'brief_ru_translator', 'translate_ru'];
// T-264: the 360 px and read-aloud checks are gates, not stages (OE-82).
const REVIEW_STAGES = ['dsl_signoff'];

/** A delivered pipeline in which nobody authored anything: the three authoring stages honestly null. */
function aiDeliveredPipeline(): CopyPipeline {
  const p = deliveredPipeline();
  return {
    ...p,
    stages: p.stages.map((s) =>
      AUTHORING_STAGES.includes(s.id) ? { ...s, completed_at: null } : s,
    ),
  };
}

function aiProblems(
  patch: Record<string, unknown>,
  pipeline: CopyPipeline = aiDeliveredPipeline(),
  locale = 'ru',
  key = 'safety.sos.confirm',
): string[] {
  return pipelineIncoherences(
    withRecord(locale, key, { ...AI_SIGNED, ...patch }),
    pipeline,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
}

test('every record is AI-authored and final under OE-5; none is signed off', () => {
  const register = loadReviewRegister();
  let n = 0;
  for (const locale of LOCALES) {
    for (const key of SAFETY_KEYS) {
      const r = register.entries[locale]?.[key];
      assert.ok(r !== undefined, `${locale}/${key}`);
      assert.equal(r.provenance, 'ai_authored', `${locale}/${key}`);
      assert.equal(r.authored_by, MODEL, `${locale}/${key}: the model, truthfully`);
      assert.equal(r.ruling, locale === 'en' ? 'OE-67' : 'OE-66', `${locale}/${key}`);
      assert.equal(
        r.status,
        'unreviewed_by_ruling',
        `${locale}/${key}: final with no review, by ruling — never signed off`,
      );
      assert.equal(r.review_ruling, 'OE-5', `${locale}/${key}: the ruling that dropped review`);
      assert.equal(r.reviewed_by, null, `${locale}/${key}: no reviewer exists`);
      assert.equal(r.reviewed_at, null, `${locale}/${key}`);
      n += 1;
    }
  }
  assert.equal(n, 24);
});

test('NEGATIVE — T-259: the terminal status is refused if it carries a reviewer or a review date, even one the roster names', () => {
  // OE-5-cut §3 item 3. `unreviewed_by_ruling` means final with NO review; a
  // record cannot be that and name a reviewer. The DSL pair is named and
  // confirmed in this pipeline, so before T-259 a terminal record naming the
  // DSL reported nothing here (the at-every-status reviewer rule admits the
  // DSL pair).
  const final = { status: 'unreviewed_by_ruling', review_ruling: 'OE-5' };
  const both = aiProblems({ ...final, reviewed_by: DSL, reviewed_at: REVIEWED });
  assert.ok(
    both.some((p) =>
      /ru\/safety\.sos\.confirm: status 'unreviewed_by_ruling' \(final with no review, OE-5\) but reviewed_by is "B\. Lead, DSL"/.test(
        p,
      ),
    ),
    JSON.stringify(both, null, 2),
  );
  const dateOnly = aiProblems({ ...final, reviewed_by: null, reviewed_at: REVIEWED });
  assert.ok(
    dateOnly.some((p) =>
      /but reviewed_by is null and reviewed_at is "2026-12-02T09:00:00Z"/.test(p),
    ),
    JSON.stringify(dateOnly, null, 2),
  );
  // Not over-wide: the same record with neither is clean.
  assert.deepEqual(aiProblems({ ...final, reviewed_by: null, reviewed_at: null }), []);
});

test('NEGATIVE — T-233: a caller that supplies no rulings refuses every AI-authored record (fail closed)', () => {
  const problems = pipelineIncoherences(
    loadReviewRegister(),
    loadCopyPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
  );
  assert.equal(problems.length, 24, JSON.stringify(problems, null, 2));
  assert.ok(
    problems.every((p) =>
      /cites 'OE-6[67]', which is not a stakeholder ruling that makes a model an author \(known: none\)/.test(
        p,
      ),
    ),
  );
});

test('T-233: an OE-66 AI-authored record is accepted as AUTHORED — with the roster filled and every stage done', () => {
  // The committed register (24 `ai_authored` records, final under OE-5 since T-259) against
  // a pipeline in which the four humans are named and confirmed: the authorship
  // is coherent, and nothing claims a review, so nothing is reported.
  assert.deepEqual(
    pipelineIncoherences(
      loadReviewRegister(),
      deliveredPipeline(),
      LOCALES,
      SAFETY_KEYS,
      NOW,
      AI_RULINGS,
    ),
    [],
  );
});

test('NEGATIVE — T-233: …but NOT as signed_off without a human DSL or deputy review', () => {
  const noReviewer = aiProblems({ reviewed_by: null, reviewed_at: null });
  assert.ok(
    noReviewer.some((p) => /signed off without an author, a reviewer or a review date/.test(p)),
    JSON.stringify(noReviewer, null, 2),
  );
  // The model reviewing its own copy: not the DSL pair, and self-review.
  const selfReview = aiProblems({ reviewed_by: MODEL });
  assert.ok(
    selfReview.some((p) =>
      /signed off by 'Claude Opus .*', who is not the named DSL or deputy/.test(p),
    ),
    JSON.stringify(selfReview, null, 2),
  );
  assert.ok(selfReview.some((p) => /both authored and signed off this safety string/.test(p)));
  // Whoever happened to be editing.
  const someone = aiProblems({ reviewed_by: 'Someone Else' });
  assert.ok(
    someone.some((p) => /'Someone Else', who is not the named DSL or deputy/.test(p)),
    JSON.stringify(someone, null, 2),
  );
  // And TODAY'S roster, in which the DSL and deputy are unnamed: no sign-off of
  // AI copy can be coherent until a stakeholder names them.
  const today = aiProblems({}, loadCopyPipeline());
  assert.ok(
    today.some((p) => /who is not the named DSL or deputy in pipeline\.roles/.test(p)),
    JSON.stringify(today, null, 2),
  );
});

test('T-233: the AI route is SATISFIABLE — a named human DSL reviewing OE-66 copy reports nothing', () => {
  // Without this the route could be vacuous in the other direction. Note what
  // the pipeline holds: the authoring stages are null, because no practitioner
  // authored the copy and no translator was briefed. They are not demanded of
  // an AI-authored record — demanding them would manufacture pressure to date
  // an event that never happened (R3). Every REVIEW stage is complete.
  const problems = aiProblems({});
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
  // The same stages ARE still demanded of a human-path record on the same pipeline.
  const human = pipelineIncoherences(
    withRecord('ru', 'safety.sos.confirm', SIGNED),
    aiDeliveredPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
  for (const id of ['brief_ru_translator', 'translate_ru']) {
    assert.ok(
      human.some((p) => p.includes(`blocking pipeline stage '${id}' is not complete`)),
      `${id} must still gate a human-path sign-off — got ${JSON.stringify(human)}`,
    );
  }
});

test('NEGATIVE — T-233: every REVIEW predicate still refuses its forgery on an AI-authored record', () => {
  // Reviewer named but never confirmed by a stakeholder.
  const p = aiDeliveredPipeline();
  const unconfirmed: CopyPipeline = {
    ...p,
    roles: { ...p.roles, dsl: { ...p.roles['dsl']!, confirmed_by_stakeholder_on: null } },
  };
  assert.ok(
    aiProblems({}, unconfirmed).some((x) =>
      /signed off by 'B\. Lead, DSL', who is named in pipeline\.roles but carries no stakeholder confirmation date/.test(
        x,
      ),
    ),
  );
  // Each REVIEW stage, left incomplete, blocks the sign-off.
  for (const id of REVIEW_STAGES) {
    const missing: CopyPipeline = {
      ...p,
      stages: p.stages.map((s) => (s.id === id ? { ...s, completed_at: null } : s)),
    };
    const problems = aiProblems({}, missing);
    assert.ok(
      problems.some((x) => x.includes(`blocking pipeline stage '${id}' is not complete`)),
      `${id}: ${JSON.stringify(problems)}`,
    );
  }
  // Dates: future, 2019, and — new for this route — before the ruling existed.
  assert.ok(
    aiProblems({ reviewed_at: '2027-06-01T09:00:00Z' }).some((x) => /is in the future/.test(x)),
  );
  assert.ok(
    aiProblems({ reviewed_at: '2019-04-01T09:00:00Z' }).some((x) =>
      /predates the day this pipeline was opened/.test(x),
    ),
  );
  const noStart: CopyPipeline = {
    ...p,
    external_start: null,
    stages: p.stages.map((s) => ({ ...s, completed_at: null })),
  };
  const early = aiProblems({ reviewed_at: '2026-09-27T12:00:00Z' }, noStart);
  assert.ok(
    early.some((x) =>
      /predates OE-66 \(2026-09-27T18:54:51Z\), the ruling under which this copy was written/.test(
        x,
      ),
    ),
    JSON.stringify(early, null, 2),
  );
  // Channel undetermined.
  const channel = aiProblems({}, p, 'ru', 'session.checkins_missed');
  assert.ok(
    channel.some((x) => /signed off while its channel is undetermined/.test(x)),
    JSON.stringify(channel, null, 2),
  );
});

test('NEGATIVE — T-233: the citation must be a real ruling, covering this locale, on a record that says a model wrote it', () => {
  // Refused at PENDING status — before anyone signs anything.
  const pending = (patch: Record<string, unknown>, locale = 'ru'): string[] =>
    pipelineIncoherences(
      withRecord(locale, 'safety.sos.confirm', {
        ...AI_SIGNED,
        status: 'pending_review',
        reviewed_by: null,
        reviewed_at: null,
        ...patch,
      }),
      loadCopyPipeline(),
      LOCALES,
      SAFETY_KEYS,
      NOW,
      AI_RULINGS,
    );
  const cases: readonly (readonly [string, string[], RegExp])[] = [
    [
      'ai_authored, no ruling',
      pending({ ruling: undefined }),
      /provenance 'ai_authored' with no `ruling`/,
    ],
    [
      'a ruling that makes nobody an author',
      pending({ ruling: 'OE-5' }),
      /cites 'OE-5', which is not a stakeholder ruling that makes a model an author/,
    ],
    [
      'OE-67 (en) cited on el',
      pending({ ruling: 'OE-67' }, 'el'),
      /el\/safety\.sos\.confirm: cites OE-67, which makes a model the author of en copy, not el/,
    ],
    [
      'a ruling on a human-provenance record',
      pending({ provenance: 'authored' }),
      /cites ruling 'OE-66' but its provenance is 'authored'/,
    ],
    [
      'a human name recorded as the AI author',
      pending({ authored_by: 'Maria Georgiou' }),
      /ai_authored under OE-66, but authored_by is "Maria Georgiou", not the model OE-66 names/,
    ],
    [
      'a roster human recorded as the AI author',
      pending({ authored_by: PRACTITIONER }),
      /ai_authored under OE-66, but authored_by is "P\. Practitioner.*", not the model OE-66 names/,
    ],
  ];
  for (const [label, problems, expected] of cases) {
    assert.ok(
      problems.some((x) => expected.test(x)),
      `${label}: ${JSON.stringify(problems)}`,
    );
  }

  // T-233 rework (QA-F1). The model name must match EXACTLY. Near misses —
  // what a careless transcription, a different model version or a look-alike
  // letter would produce — are each refused. Written with explicit code points
  // where the difference is invisible.
  const nearMisses: readonly (readonly [string, string])[] = [
    ['trailing space', `${MODEL} `],
    ['leading space', ` ${MODEL}`],
    ['lower case', MODEL.toLowerCase()],
    ['another version', 'Claude Opus (claude-opus-4-1), AI agent'],
    ['bare model family', 'Claude Opus'],
    ['Cyrillic С (U+0421) for Latin C', `С${MODEL.slice(1)}`],
    // T-043 (T-233 QA-F4): invisible and compatibility characters. The first
    // two are red under a strip-zero-width mutation of review.ts's comparison,
    // the last two under an NFKC-normalise mutation (tools/review-citation-
    // negatives.ts) — so "exact to the character" is tested, not only true.
    ['zero-width space (U+200B)', `Claude\u200B Opus (claude-opus-5-5), AI agent`],
    ['byte-order mark (U+FEFF)', `\uFEFF${MODEL}`],
    ['no-break space (U+00A0)', `Claude\u00A0Opus (claude-opus-5-5), AI agent`],
    ['fullwidth parenthesis (U+FF08)', `Claude Opus \uFF08claude-opus-5-5), AI agent`],
  ];
  // Every near miss is judged before any assertion fails, so a run that lets
  // several through names all of them (the mutation harness reads this list).
  const accepted: string[] = [];
  for (const [label, name] of nearMisses) {
    assert.notEqual(name, MODEL, `${label}: the fixture must differ from the model`);
    const problems = pending({ authored_by: name });
    if (
      !problems.some((x) =>
        /ai_authored under OE-66, but authored_by is .*, not the model OE-66 names/.test(x),
      )
    ) {
      accepted.push(label);
    }
  }
  assert.deepEqual(
    accepted,
    [],
    `near misses that must be refused were accepted: ${JSON.stringify(accepted)}`,
  );
  // …and the exact name, on the same fixture, is accepted — so the refusals
  // above are about the name and nothing else.
  assert.deepEqual(pending({}), []);
});

test('NEGATIVE — T-233 rework (QA O2): reviewed_by is checked at EVERY status', () => {
  const at = (patch: Record<string, unknown>, pipeline = loadCopyPipeline()): string[] =>
    pipelineIncoherences(
      withRecord('ru', 'safety.sos.confirm', {
        ...AI_SIGNED,
        status: 'pending_review',
        reviewed_at: null,
        ...patch,
      }),
      pipeline,
      LOCALES,
      SAFETY_KEYS,
      NOW,
      AI_RULINGS,
    );
  // The model as reviewer on an unsigned record.
  const model = at({ reviewed_by: MODEL });
  assert.ok(
    model.some((x) =>
      /reviewed_by 'Claude Opus .*' is an AI model that a ruling names as an author/.test(x),
    ),
    JSON.stringify(model, null, 2),
  );
  assert.ok(
    model.some((x) =>
      /is not the named DSL or deputy in pipeline\.roles, on a record at 'pending_review'/.test(x),
    ),
    JSON.stringify(model, null, 2),
  );
  // Anyone outside the DSL pair, on an unsigned record.
  const other = at({ reviewed_by: 'Someone Else' }, deliveredPipeline());
  assert.ok(
    other.some((x) =>
      /reviewed_by 'Someone Else' is not the named DSL or deputy .* 'pending_review'/.test(x),
    ),
    JSON.stringify(other, null, 2),
  );
  // The named DSL on an unsigned record (review in progress) is coherent.
  assert.deepEqual(at({ reviewed_by: DSL }, deliveredPipeline()), []);
  // And the model is refused as reviewer on a SIGNED record by the new rule too.
  const signed = aiProblems({ reviewed_by: MODEL });
  assert.ok(signed.some((x) => /is an AI model that a ruling names as an author/.test(x)));
});

test('T-233 rework (QA O3): a DSL sign-off of AI copy needs NO authoring role named — the two may stay null', () => {
  // PIPELINE §5's amendment: step 1 reduces to naming the DSL and the deputy.
  // Pinned here: the practitioner and translator unnamed (and unconfirmed),
  // every authoring stage null, the DSL pair named and confirmed, the review
  // stages done — and the AI sign-off is coherent.
  const p = aiDeliveredPipeline();
  const onlyDslPair: CopyPipeline = {
    ...p,
    roles: {
      ...p.roles,
      greek_authoring_safeguarding_practitioner: {
        ...p.roles['greek_authoring_safeguarding_practitioner']!,
        named: null,
        confirmed_by_stakeholder_on: null,
      },
      russian_translator_briefed: {
        ...p.roles['russian_translator_briefed']!,
        named: null,
        confirmed_by_stakeholder_on: null,
      },
    },
  };
  assert.equal(onlyDslPair.roles['greek_authoring_safeguarding_practitioner']?.named, null);
  assert.equal(onlyDslPair.roles['russian_translator_briefed']?.named, null);
  const problems = aiProblems({}, onlyDslPair);
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
  // …while the DSL pair may NOT stay null: unname the DSL and the same sign-off is refused.
  const noDsl: CopyPipeline = {
    ...onlyDslPair,
    roles: {
      ...onlyDslPair.roles,
      dsl: { ...onlyDslPair.roles['dsl']!, named: null, confirmed_by_stakeholder_on: null },
    },
  };
  assert.ok(aiProblems({}, noDsl).some((x) => /who is not the named DSL or deputy/.test(x)));
});

test('NEGATIVE — T-233: the model named into the roster is refused — a model is not a roster member', () => {
  const p = deliveredPipeline();
  const modelAsDeputy: CopyPipeline = {
    ...p,
    roles: { ...p.roles, dsl_deputy: { ...p.roles['dsl_deputy']!, named: MODEL } },
  };
  const problems = pipelineIncoherences(
    loadReviewRegister(),
    modelAsDeputy,
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
  assert.equal(problems.length, 24, JSON.stringify(problems, null, 2));
  assert.ok(problems.every((x) => /which is also a named person in pipeline\.roles/.test(x)));
});
