/**
 * `review.json` § `pipeline` — the safety-copy pipeline as data, and the
 * coherence of the register against stakeholder rulings OE-66/OE-67/OE-5.
 * T-049; T-233; T-259; T-260; SA §TS-12.4 and PM §MVP-L4 AC4/AC6, §MVP-S7 AC1,
 * §MVP-L5 AC7 as departed from under EV-16 (extended by OE-5 and OE-82);
 * PM §MVP-IS5 AC7; DV-7, DV-11.
 *
 * T-259 deleted the dates that measured a human engagement OE-5 abolished.
 * T-260 deleted the rest of the human path: the roster (`pipeline.roles`),
 * the stages a person completes (`pipeline.stages`), the per-locale authoring
 * method (`assignments[*].locales`) and the sign-off rules over them — about
 * forty tests that each constructed a human sign-off and watched it refused
 * or accepted. What remains:
 *
 *  - **the plan's shape**: every `safety_critical` key carries a channel, the
 *    emergency-panel flag and the two translation bans, and nothing else; the
 *    `pipeline` block carries no roster and no stages, and re-adding either is
 *    refused naming whom it names;
 *  - **provenance coherence at every status**: the model, under a ruling that
 *    names it exactly and covers the locale; never a human author, never a
 *    human provenance, never `signed_off`, never a reviewer or a review date.
 *
 * Each refusal is proven by CONSTRUCTING the record or block it refuses and
 * watching it come back as a problem; the committed register is proven to
 * report nothing, so the set is not vacuous.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReviewRegister, loadCopyPipeline, pipelineIncoherences } from './review.ts';
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

// ─── the coherence predicates, each proven by constructing its forgery ───

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

/** An instant after every ruling cited here; `pipelineIncoherences` no longer reads it (T-260). */
const NOW = Date.parse('2026-12-03T00:00:00Z');
const REVIEWED = '2026-12-02T09:00:00Z';
/** A human name. No roster exists since T-260, so this names a person and nothing else. */
const PRACTITIONER = 'P. Practitioner, safeguarding practitioner (Cyprus)';
const DSL = 'B. Lead, DSL';

/**
 * An AI-authored OE-66 record CLAIMING a sign-off. Under OE-5 every part of
 * that claim is refused; tests below override `status` to probe authorship at
 * a status that claims nothing.
 */
const AI_SIGNED = {
  provenance: 'ai_authored',
  ruling: 'OE-66',
  status: 'signed_off',
  authored_by: MODEL,
  reviewed_by: null,
  reviewed_at: null,
};

/** The committed terminal record, as T-259 flipped it. */
const AI_FINAL = {
  provenance: 'ai_authored',
  ruling: 'OE-66',
  status: 'unreviewed_by_ruling',
  review_ruling: 'OE-5',
  authored_by: MODEL,
  reviewed_by: null,
  reviewed_at: null,
};

function aiProblems(
  patch: Record<string, unknown>,
  locale = 'ru',
  key = 'safety.sos.confirm',
): string[] {
  return pipelineIncoherences(
    withRecord(locale, key, { ...AI_FINAL, ...patch }),
    loadCopyPipeline(),
    LOCALES,
    SAFETY_KEYS,
    NOW,
    AI_RULINGS,
  );
}

/**
 * T-260. The fields a `pipeline` block and one assignment carry since OE-5,
 * written HERE and never read from `review.json` — a register that supplied
 * the set it is checked against would be checking that it equals itself
 * (PROTOCOL §5.1). Replaces T-049's `STAGE_MANIFEST` and T-264's R3-F1 case:
 * there are no stages left to manifest, and a `stages` block coming back is
 * refused below and by the coherence run over the committed register.
 */
const PIPELINE_SHAPE: readonly string[] = [
  '//',
  'assignments',
  'automated_checks',
  'engineering_kickoff',
  'opened_by',
];
const ASSIGNMENT_SHAPE: readonly string[] = [
  'channel',
  'channel_note',
  'emergency_panel',
  'machine_translation',
  'runtime_translation',
];

test('T-260: the pipeline names no person and no human step — no roles, no stages, no per-locale method', () => {
  // Replaces T-049's "nothing in the pipeline claims a person or a stage that
  // has happened" (T-259 D2 kept it for this ticket), which asserted over a
  // roster and stages that no longer exist. The closed key sets are the claim.
  const raw = loadCopyPipeline() as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).sort(), [...PIPELINE_SHAPE]);
  const assignments = raw['assignments'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(assignments).sort(), [...SAFETY_KEYS].sort());
  for (const [key, a] of Object.entries(assignments)) {
    assert.deepEqual(Object.keys(a).sort(), [...ASSIGNMENT_SHAPE], key);
  }
});

test('NEGATIVE — T-260: a roles or stages block re-added, naming a person or a human role, is refused', () => {
  const p = loadCopyPipeline();
  const at = (pipeline: unknown): string[] =>
    pipelineIncoherences(
      loadReviewRegister(),
      pipeline as CopyPipeline,
      LOCALES,
      SAFETY_KEYS,
      NOW,
      AI_RULINGS,
    );
  // A roster naming a person: the stakeholder's old next action, now withdrawn.
  const roster = at({
    ...p,
    roles: { dsl: { named: 'B. Lead', confirmed_by_stakeholder_on: '2026-10-20' } },
  });
  assert.ok(
    roster.some((x) =>
      /^pipeline\.roles is not a field of the pipeline .* naming dsl = "B\. Lead"\./.test(x),
    ),
    JSON.stringify(roster, null, 2),
  );
  // A roster naming nobody is still a roster of human roles.
  const emptyRoster = at({ ...p, roles: { dsl: { named: null } } });
  assert.ok(
    emptyRoster.some((x) =>
      /^pipeline\.roles is not a field .* roster of human roles \[dsl\]/.test(x),
    ),
    JSON.stringify(emptyRoster, null, 2),
  );
  // A stage whose `who` is a human role — the shape T-264's NEG case re-added.
  for (const [id, who] of [
    ['dsl_signoff', 'dsl'],
    ['author_en_el', 'greek_authoring_safeguarding_practitioner'],
    ['in_context_screenshot_review', 'dsl'],
  ] as const) {
    const staged = at({
      ...p,
      stages: [{ id, blocking: true, who, what: '…', output: '…', completed_at: null }],
    });
    assert.ok(
      staged.some(
        (x) =>
          x.startsWith('pipeline.stages is not a field of the pipeline') &&
          x.includes(`${id} (who: "${who}")`),
      ),
      `${id}: ${JSON.stringify(staged)}`,
    );
  }
  // An empty stage list, and any other field, are refused too: the set is closed.
  assert.ok(at({ ...p, stages: [] }).some((x) => x.startsWith('pipeline.stages is not a field')));
  assert.ok(
    at({ ...p, external_start: null }).some((x) =>
      x.startsWith('pipeline.external_start is not a field'),
    ),
  );
  // A per-locale method on one assignment, as T-049 wrote it for every key.
  const method = at({
    ...p,
    assignments: {
      ...p.assignments,
      'safety.sos.confirm': {
        ...p.assignments['safety.sos.confirm'],
        locales: { el: { method: 'authored', required_provenance: 'authored', why: '…' } },
      },
    },
  });
  assert.ok(
    method.some((x) =>
      /^pipeline\.assignments\['safety\.sos\.confirm'\]\.locales is not a field of an assignment/.test(
        x,
      ),
    ),
    JSON.stringify(method, null, 2),
  );
  // Not over-wide: the committed pipeline reports nothing.
  assert.deepEqual(at(p), []);
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
  assert.ok(problems.every((p) => /has no channel and no translation ban/.test(p)));
});

test('NEGATIVE — T-260: an assignment whose channel is not a CopyChannel, or whose translation is permitted', () => {
  const p = loadCopyPipeline();
  const sos = p.assignments['safety.sos.confirm']!;
  const at = (patch: Record<string, unknown>): string[] =>
    pipelineIncoherences(
      loadReviewRegister(),
      {
        ...p,
        assignments: { ...p.assignments, 'safety.sos.confirm': { ...sos, ...patch } },
      } as CopyPipeline,
      LOCALES,
      SAFETY_KEYS,
      NOW,
      AI_RULINGS,
    );
  assert.ok(
    at({ channel: 'spoken' }).some((x) =>
      /\.channel is "spoken", not one of screen, spoken_by_user, voice, undetermined/.test(x),
    ),
  );
  assert.ok(
    at({ machine_translation: 'permitted' }).some((x) =>
      /machine_translation must be 'prohibited' \(DV-11\)/.test(x),
    ),
  );
  assert.ok(
    at({ runtime_translation: 'permitted' }).some((x) =>
      /runtime_translation must be 'prohibited'/.test(x),
    ),
  );
  // `undetermined` is a CopyChannel: it fails closed in the gates that read it, not here.
  assert.deepEqual(at({ channel: 'undetermined' }), []);
});

test('NEGATIVE — an absent pipeline block fails closed rather than reading as empty', () => {
  assert.throws(
    () => loadCopyPipeline('/nonexistent-root-for-t-049'),
    (err: unknown) => err instanceof Error,
  );
});

test('NEGATIVE — QA-F2 / T-233: a machine author WITHOUT an OE-66/67 citation is still refused', () => {
  // The DeepL case, converted rather than deleted. OE-66/OE-67 opened ONE route
  // for a non-human author, and it is a citation, not a relaxation: the rulings
  // are passed in (AI_RULINGS), so this is refused WITH the rulings in force —
  // not by the fail-closed default. Since T-260 there is no roster for a name
  // to resolve against, so the same refusal covers a person's name.
  for (const status of ['unreviewed_by_ruling', 'pending_review']) {
    const problems = pipelineIncoherences(
      withRecord('ru', 'safety.sos.confirm', {
        provenance: 'translated_professional',
        status,
        authored_by: 'DeepL Pro v3 (machine)',
        reviewed_by: null,
        reviewed_at: null,
      }),
      loadCopyPipeline(),
      LOCALES,
      SAFETY_KEYS,
      NOW,
      AI_RULINGS,
    );
    assert.ok(
      problems.some((p) =>
        /ru\/safety\.sos\.confirm: authored_by 'DeepL Pro v3 \(machine\)' is not a model that a stakeholder ruling names, and the record cites no ruling/.test(
          p,
        ),
      ),
      `${status}: ${JSON.stringify(problems, null, 2)}`,
    );
  }
  // …and dressed up as AI authorship: `ai_authored` and a real OE-66 citation,
  // but not the model OE-66 names. The route is for the ruling's model, not for
  // any engine that can be typed into the field.
  const dressed = aiProblems({ authored_by: 'DeepL Pro v3 (machine)' });
  assert.ok(
    dressed.some((p) =>
      /ai_authored under OE-66, but authored_by is "DeepL Pro v3 \(machine\)"/.test(p),
    ),
    JSON.stringify(dressed, null, 2),
  );
});

test('NEGATIVE — T-260: a person as author is refused at every status, and so is any human provenance', () => {
  // What the roster used to admit: a named, confirmed practitioner as author
  // (harness case T260-HUMAN-AUTHOR-ROSTERED was green at a84c47f).
  for (const provenance of ['authored', 'translated_professional', 'legal_review']) {
    const problems = aiProblems({ provenance, ruling: undefined, authored_by: PRACTITIONER });
    assert.ok(
      problems.some((x) =>
        /authored_by 'P\. Practitioner.*' is not a model that a stakeholder ruling names/.test(x),
      ),
      `${provenance}: ${JSON.stringify(problems)}`,
    );
    assert.ok(
      problems.some((x) =>
        x.includes(`provenance '${provenance}' claims a human wrote or reviewed this string`),
      ),
      `${provenance}: ${JSON.stringify(problems)}`,
    );
  }
  // A human provenance with nobody named still claims a human.
  assert.ok(
    aiProblems({ provenance: 'authored', ruling: undefined, authored_by: null }).some((x) =>
      x.includes("provenance 'authored' claims a human"),
    ),
  );
  // Not over-wide: `placeholder` with nobody named claims nothing here (the gate
  // refuses it as PLACEHOLDER).
  assert.deepEqual(
    aiProblems({ provenance: 'placeholder', ruling: undefined, authored_by: null }),
    [],
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

test('NEGATIVE — T-259/T-260: the terminal status is refused if it carries a reviewer or a review date, whoever it names', () => {
  // OE-5-cut §3 item 3. `unreviewed_by_ruling` means final with NO review; a
  // record cannot be that and name a reviewer. T-259 titled this "…even one the
  // roster names"; since T-260 there is no roster, so no name is admitted.
  const both = aiProblems({ reviewed_by: DSL, reviewed_at: REVIEWED });
  assert.ok(
    both.some((p) =>
      /ru\/safety\.sos\.confirm: status 'unreviewed_by_ruling' \(final with no review, OE-5\) but reviewed_by is "B\. Lead, DSL"/.test(
        p,
      ),
    ),
    JSON.stringify(both, null, 2),
  );
  const dateOnly = aiProblems({ reviewed_by: null, reviewed_at: REVIEWED });
  assert.ok(
    dateOnly.some((p) =>
      /but reviewed_by is null and reviewed_at is "2026-12-02T09:00:00Z"/.test(p),
    ),
    JSON.stringify(dateOnly, null, 2),
  );
  // Not over-wide: the same record with neither is clean.
  assert.deepEqual(aiProblems({ reviewed_by: null, reviewed_at: null }), []);
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

test('NEGATIVE — T-260: nothing is signed off under OE-5 — signed_off is refused whoever reviewed it, or nobody', () => {
  // Replaces T-233's "…but NOT as signed_off without a human DSL or deputy
  // review": there is no DSL or deputy to review it (OE-5), so the status
  // itself is the claim refused.
  for (const reviewer of [null, DSL, 'Someone Else']) {
    const problems = aiProblems({
      status: 'signed_off',
      review_ruling: undefined,
      reviewed_by: reviewer,
      reviewed_at: reviewer === null ? null : REVIEWED,
    });
    assert.ok(
      problems.some((x) =>
        /ru\/safety\.sos\.confirm: status 'signed_off'\. No review of this copy exists under OE-5/.test(
          x,
        ),
      ),
      `${String(reviewer)}: ${JSON.stringify(problems)}`,
    );
  }
  // The model reviewing its own copy is refused as a reviewer too.
  const self = aiProblems({
    status: 'signed_off',
    review_ruling: undefined,
    reviewed_by: MODEL,
    reviewed_at: REVIEWED,
  });
  assert.ok(
    self.some((x) =>
      /reviewed_by 'Claude Opus .*' is an AI model that a ruling names as an author/.test(x),
    ),
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
  // T-233 admitted the named DSL or deputy in `reviewed_by` on a pending record;
  // since T-260 no reviewer is admitted at any status (harness case
  // T260-DSL-REVIEWER-PENDING was green at a84c47f).
  const at = (patch: Record<string, unknown>): string[] =>
    aiProblems({ status: 'pending_review', review_ruling: undefined, reviewed_at: null, ...patch });
  // The model as reviewer on an unsigned record.
  const model = at({ reviewed_by: MODEL });
  assert.ok(
    model.some((x) =>
      /reviewed_by 'Claude Opus .*' is an AI model that a ruling names as an author/.test(x),
    ),
    JSON.stringify(model, null, 2),
  );
  // Anyone — a DSL by title, or anyone else — on an unsigned record.
  for (const who of [DSL, 'Someone Else']) {
    const problems = at({ reviewed_by: who });
    assert.ok(
      problems.some((x) =>
        x.includes(
          `reviewed_by is ${JSON.stringify(who)} and reviewed_at is null on a record at 'pending_review'. No review of this copy exists under OE-5`,
        ),
      ),
      `${who}: ${JSON.stringify(problems)}`,
    );
  }
  // A review date alone, too.
  assert.ok(
    at({ reviewed_by: null, reviewed_at: REVIEWED }).some((x) =>
      x.includes("on a record at 'pending_review'"),
    ),
  );
  // Not over-wide: a pending record naming nobody reports nothing here (the
  // gate refuses it as NOT-FINAL).
  assert.deepEqual(at({ reviewed_by: null }), []);
});
