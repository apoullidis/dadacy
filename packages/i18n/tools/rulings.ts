/**
 * The stakeholder rulings `packages/i18n` is checked against — T-258
 * (`tasks/state/EP-0/OE-5-cut.md` §2 item 3, §3 T-258 items 1-2; OD-258).
 *
 * WHY THIS FILE EXISTS. Until T-258 the AI-author rulings lived only in
 * `src/pipeline.test.ts`, so `gate:safety-review-currency` could not tell a
 * legitimate AI-authored record from a forged one on its own: run alone with
 * the waiver removed, it passed 24 records signed off by the model itself
 * (OD-258, measured by `T-233`'s QA). The gate and the tests now import the
 * SAME literal from here, so the gate reads the rulings itself.
 *
 * WHERE IT MAY BE READ FROM. `tools/` is not part of the package surface:
 * `package.json`'s `exports` are exactly `.`, `./review` and `./compiled/*`,
 * none of which resolves into `tools/` (asserted in `src/pipeline.test.ts`).
 * So no runtime consumer can import these rulings, and nothing in a browser
 * bundle can widen them.
 *
 * WHY NOT `review.json`. A register that listed the rulings it is checked
 * against could widen its own authority in the same commit as the record that
 * needs it (PROTOCOL §5.1). These literals are transcribed from
 * `tasks/state/decisions.md`, which is outside `app/`: no test can cross-check
 * the transcription, so an edit here is caught by review of the diff, not by a
 * gate. Adding a ruling, a locale or a model is a stakeholder decision recorded
 * in `decisions.md` first, and must cost an edit to this file.
 */
import type { AiAuthorshipRuling } from '../src/review.ts';

/**
 * The model identity OE-66 and OE-67 name as the author, spelled exactly as
 * `authored_by` must carry it. Transcribed from the drafts' own provenance
 * lines (`tasks/state/EP-0/OE-66/{en,el,ru}/NOTES.md`: "Claude Opus
 * (claude-opus-5-5), AI agent"). Moved here from `src/pipeline.test.ts` by
 * T-258; `tools/prohibited-claims.ts` (T-043) reads the same constant for the
 * prohibited-claim lists' author.
 */
export const MODEL = 'Claude Opus (claude-opus-5-5), AI agent';

/**
 * The ONLY stakeholder rulings that make an AI model the AUTHOR of catalogue
 * copy recorded in `review.json`:
 *   - OE-66, 2026-09-27T18:54:51Z: the model authors ALL `el` and `ru` copy,
 *     safety_critical included (EV-16).
 *   - OE-67, 2026-09-27T19:27:39Z: the model authors the `en` safety_critical
 *     copy. Every key in `entries` is safety_critical, so the locale is the
 *     whole of its scope here.
 * Moved verbatim from `src/pipeline.test.ts` (T-233) by T-258.
 */
export const AI_RULINGS: readonly AiAuthorshipRuling[] = [
  { id: 'OE-66', decided_at: '2026-09-27T18:54:51Z', locales: ['el', 'ru'], authors: [MODEL] },
  { id: 'OE-67', decided_at: '2026-09-27T19:27:39Z', locales: ['en'], authors: [MODEL] },
];

/** A stakeholder ruling that removes human review of safety copy, for the locales it names. */
export interface ReviewDroppedRuling {
  /** The ruling id exactly as `decisions.md` names it. */
  readonly id: string;
  /** When the stakeholder made it (ISO-8601 UTC). */
  readonly decided_at: string;
  /** The locales whose safety copy is final with no human review under this ruling. */
  readonly locales: readonly string[];
}

/**
 * The ONLY stakeholder ruling under which a `safety_critical` record is FINAL
 * WITH NO REVIEW — the `unreviewed_by_ruling` status, cited in `review_ruling`:
 *   - OE-5, ruled 2026-10-11T08:13:50Z (`decisions.md` Open register OE-5 row;
 *     § Stakeholder decisions, OE-5 RULED 2026-10-11; EV-16 as extended): AI
 *     agents author the copy and the four-reviewer action is dropped, the DSL +
 *     deputy `reviewed_by` review included. Nothing may record or claim a human
 *     review. OE-81 (2026-10-11T12:56:28Z): such copy is releasable, and
 *     `gate:safety-review-currency` may pass on it.
 * It names no model: it removes the review, it does not make anyone an author.
 * Authorship is AI_RULINGS' question, and a record must satisfy both.
 */
export const REVIEW_DROPPED_RULINGS: readonly ReviewDroppedRuling[] = [
  { id: 'OE-5', decided_at: '2026-10-11T08:13:50Z', locales: ['en', 'el', 'ru'] },
];
