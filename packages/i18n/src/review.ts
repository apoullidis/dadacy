/**
 * `review.json` — provenance as a build input. SA §TS-12.3/§TS-12.4,
 * SD §FE-10 and SD Revision Log D8.
 *
 * **Build-time only.** This module reads the filesystem and is deliberately not
 * re-exported from the package root, so it can never be pulled into a browser
 * bundle. `import { … } from '@kinvara/i18n/review'`.
 *
 * The argument it implemented until stakeholder ruling OE-5 (2026-10-11), in
 * one line: *an MT engine cannot produce a DSL review record.* OE-5 removed
 * human review of this copy (EV-16 as extended), so that argument weakens, and
 * the weakening is inherent in the ruling. Since T-258/T-259,
 * `gate:safety-review-currency` passes a `safety_critical` record outside an
 * unexpired `pending_pipeline` waiver (none is committed since T-259) only
 * when: it is AI-authored under a ruling the GATE reads (`tools/rulings.ts`)
 * with that ruling's exact model as `authored_by`; it is final with no review
 * under OE-5 (`unreviewed_by_ruling`, `review_ruling: "OE-5"`); its `status`
 * is not `signed_off` and no field whose name contains "review" other than
 * `review_ruling` is non-null (the gate's `claimsReview()`); it carries no
 * field outside the record's nine (`undefinedFields()`); its `note`, if
 * present, is a string or null (`noteNotText()`, T-259) — the TEXT of a string
 * note is not read, so a sentence claiming a review is not refused; and it
 * carries the exact content hash pinned in the gate's own source
 * (`AUTHORED_CONTENT_PINNED`). So *a changed or new `safety_critical` string
 * cannot pass the gate without an edit to the gate's pin* (the gate's Vitest
 * *UNPINNED-CONTENT* cases, waived and not). That makes a change VISIBLE in
 * review of the diff. It does not prove that the named model wrote the bytes,
 * and copy below `safety_critical` is not examined. Machine translation is
 * still prohibited for `safety_critical` and `transactional` copy (DV-11).
 *
 * `T-044` owns `gate:safety-review-currency` and reads this file. Its records
 * were written by `T-233` (OE-66/OE-67) and moved to the terminal state by
 * `T-259` (OE-5); no external pipeline populates it any more.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewProvenance, ReviewStatus } from './types.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The content hash of one catalogue string, in one locale.
 *
 * **Defined exactly, because two tickets must agree byte for byte:** lowercase
 * hex SHA-256 over the UTF-8 encoding of the message source after Unicode NFC
 * normalisation, prefixed `sha256:`. NFC matters here and is not decoration —
 * Greek tonos and Cyrillic и-breve have both composed and decomposed
 * representations, an editor or a translation tool may emit either, and without
 * normalisation a byte-identical-looking string would appear to have changed
 * and would fail a review that is in fact current.
 */
export function contentHash(source: string): string {
  return `sha256:${createHash('sha256').update(source.normalize('NFC'), 'utf8').digest('hex')}`;
}

export interface ReviewRecord {
  /** `contentHash()` of the reviewed source, in this locale. */
  readonly content_hash: string;
  readonly provenance: ReviewProvenance;
  readonly status: ReviewStatus;
  /**
   * Who wrote the string. A named human in `pipeline.roles`, OR — only when
   * `provenance` is `ai_authored` and `ruling` cites a stakeholder ruling that
   * makes a model the author of this locale's copy — that model, named exactly
   * as the ruling names it. Never a human name standing in for a model, and
   * never a model without a ruling. `null` while nothing has been authored.
   */
  readonly authored_by: string | null;
  /**
   * T-233. The stakeholder ruling (`decisions.md`, e.g. `OE-66`) under which an
   * AI model is this record's author. Present if and only if `provenance` is
   * `ai_authored`.
   */
  readonly ruling?: string;
  /**
   * T-258. The stakeholder ruling (e.g. `OE-5`) under which this record is final
   * with NO review. Present exactly when `status` is `unreviewed_by_ruling`.
   */
  readonly review_ruling?: string;
  /**
   * The DSL or legal reviewer who signed off. On a `safety_critical` record it
   * must be `null` at every status since OE-5 — `gate:safety-review-currency`
   * refuses any value as `CLAIMS-REVIEW` (T-258).
   */
  readonly reviewed_by: string | null;
  /** ISO-8601 UTC. Same rule as `reviewed_by`: `null` on a `safety_critical` record since OE-5. */
  readonly reviewed_at: string | null;
  /**
   * Prose, or nothing. `gate:safety-review-currency` refuses a present `note`
   * that is neither a string nor `null` as NOTE-NOT-TEXT (T-259, OD-353), so a
   * sign-off cannot be recorded as structured data inside it. The text of a
   * string note is not read by the gate.
   */
  readonly note?: string | null;
}

/**
 * A dated, self-closing waiver over `safety_critical` keys — `T-040`, `T-044`.
 *
 * **None is committed since T-259**: `pending_pipeline` is `null`. The waiver
 * existed to force a decision on HUMAN review by a date; stakeholder ruling
 * OE-5 (2026-10-11) was that decision — there is no human review — so T-259
 * set it to null and deleted the re-anchor chain (`re_anchors`) and the
 * `external_start` mirror. That is not a renewal: no date moved.
 *
 * The type stays because a waiver can still be RE-ADDED, and the gate still
 * bounds one: it names an owner, a ticket, a reason and its keys, and it
 * expires; `expected_by` later than the gate's `WAIVER_NOT_AFTER` pin
 * (`2026-12-05`) is WAIVER-RENEWED, so a re-added waiver cannot outlive that
 * day, and after `expected_by` it waives nothing (WAIVER-EXPIRED). Inside one,
 * the gate still checks a record's existence, review claims, closed field set,
 * note type, currency and pin (T-258 LIVE §3).
 */
export interface PendingPipeline {
  readonly opened_at: string;
  /** The last day the waiver is in force, a `YYYY-MM-DD` day, never later than the gate's `WAIVER_NOT_AFTER`. */
  readonly expected_by: string;
  readonly owner: string;
  readonly ticket: string;
  readonly reason: string;
  readonly keys: readonly string[];
}

export interface ReviewRegister {
  readonly version: number;
  readonly pending_pipeline: PendingPipeline | null;
  /** locale code → fully-qualified key → record. */
  readonly entries: Readonly<Record<string, Readonly<Record<string, ReviewRecord>>>>;
}

export function loadReviewRegister(root: string = PACKAGE_ROOT): ReviewRegister {
  const raw: unknown = JSON.parse(readFileSync(join(root, 'review.json'), 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new TypeError('review.json must be an object');
  const obj = raw as Record<string, unknown>;
  const entries = obj['entries'];
  if (typeof entries !== 'object' || entries === null) {
    throw new TypeError('review.json: `entries` must be an object keyed by locale');
  }
  const pending = obj['pending_pipeline'];
  return {
    version: typeof obj['version'] === 'number' ? obj['version'] : 0,
    pending_pipeline: (pending ?? null) as PendingPipeline | null,
    entries: entries as Readonly<Record<string, Readonly<Record<string, ReviewRecord>>>>,
  };
}

/** The raw catalogue source of one key in one locale — the text a `content_hash` is taken over. */
export function catalogueSource(
  locale: string,
  fullyQualifiedKey: string,
  root: string = PACKAGE_ROOT,
): string | undefined {
  const namespace = fullyQualifiedKey.slice(0, fullyQualifiedKey.indexOf('.'));
  const localKey = fullyQualifiedKey.slice(namespace.length + 1);
  const file = join(root, 'catalogues', locale, `${namespace}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[localKey];
  return typeof value === 'string' ? value : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// T-049 — the pipeline itself, as data.
//
// `entries` above records who wrote each `safety_critical` string and, since
// T-259, that it is final with no review under stakeholder ruling OE-5.
// Everything below recorded what MUST happen to each string, by whom and in
// which language, on the human path the rulings displaced (OE-66/OE-67) and
// abolished (OE-5). T-259 deleted the dates that measured SD §DH-5's six-week
// external lead time (`deadline`, `lead_time_days`, `latest_external_start`,
// `external_start`, `blocked_on`); the roster and the human stages are
// `T-260`'s to remove.
//
// **What this is not.** None of it asserts that any copy has been authored,
// translated or reviewed, and none of it can. The honest limit is stated once,
// here, rather than implied: this register lives in the same repository as the
// copy it vouches for, so a sufficiently determined edit can write a sign-off
// that never happened. `content_hash` binds a record to the CURRENT source, which
// proves currency, not review.
//
// What the predicates below buy is narrower than "forgery is hard", and QA round
// 1 (F2) was right that the first version of this comment overstated it. Stated
// as exactly what is tested: a `signed_off` record must name an author and a
// reviewer that are BOTH resolvable to distinct named roles in the roster, each
// carrying a stakeholder confirmation date; the author's role must be the one the
// assignment's method calls for and must not be a reviewer role; and
// `reviewed_at` must fall between the last completed blocking stage and now. Free
// text in either name field, a machine in `authored_by`, a 2019 date, and a
// sign-off predating the brief are each refused — those were the gaps.
//
// T-233 (stakeholder rulings OE-66 / OE-67, EV-16) adds ONE route for a
// non-human author, and it is narrow: `provenance: "ai_authored"`, `authored_by`
// equal to a model identity that a cited ruling names, `ruling` citing that
// ruling, and the ruling covering this locale. The rulings are passed IN
// (`AiAuthorshipRuling[]`), and their only real caller writes them as a literal
// in `src/pipeline.test.ts` — a register that could grant its own authorship
// authority would be measuring itself (PROTOCOL §5.1). A machine in
// `authored_by` WITHOUT such a citation is still refused, at any status. An
// AI-authored record is authored, not reviewed: signing it off still needs the
// named, stakeholder-confirmed human DSL or deputy and every other check below.
//
// It remains true that a real, stakeholder-confirmed DSL can be recorded as
// having reviewed something they did not. Nothing here catches that, and only a
// countersignature from outside the repository could.
// ─────────────────────────────────────────────────────────────────────────────

/** How one locale's copy for one key must be produced. */
export type CopyMethod = 'authored' | 'translated_briefed';

/**
 * Where the string is consumed. `spoken_by_user` and `voice` both require SA
 * §TS-12.4's read-aloud pass; `undetermined` fails closed, because a string
 * whose channel nobody has decided would silently skip that pass.
 */
export type CopyChannel = 'screen' | 'spoken_by_user' | 'voice' | 'undetermined';

export interface PipelineLocaleAssignment {
  readonly method: CopyMethod;
  /** The `provenance` an `entries` record for this locale must carry once delivered. */
  readonly required_provenance: ReviewProvenance;
  readonly why: string;
}

export interface PipelineAssignment {
  /** PM §MVP-IS5 AC7: number labels, the 112 script, the address-reading prompt. */
  readonly emergency_panel: boolean;
  readonly channel: CopyChannel;
  readonly channel_note: string;
  readonly machine_translation: 'prohibited' | 'permitted';
  readonly runtime_translation: 'prohibited' | 'permitted';
  readonly locales: Readonly<Record<string, PipelineLocaleAssignment>>;
}

export interface PipelineRole {
  readonly named: string | null;
  readonly confirmed_by_stakeholder_on: string | null;
  readonly what: string;
  readonly spec: string;
}

export interface PipelineStage {
  readonly id: string;
  readonly blocking: boolean;
  readonly who: string;
  readonly what: string;
  readonly output: string;
  readonly applies_to?: string;
  readonly completed_at: string | null;
}

export interface CopyPipeline {
  readonly opened_by: string;
  /** The day engineering opened the pipeline (2026-09-05). A record of the past, not a date in force. */
  readonly engineering_kickoff: string;
  /**
   * DELETED FROM THE REGISTER BY T-259, with `lead_time_days`, `deadline`,
   * `latest_external_start` and `blocked_on`: they measured the time left for
   * a human engagement that stakeholder ruling OE-5 abolished. Optional here
   * only because the sign-off path of `pipelineIncoherences()` still applies
   * T-049 § contract §4 rule 6 ("not before `external_start` when one is
   * recorded") to a fixture that records one; that path is `T-260`'s to remove.
   */
  readonly external_start?: string | null;
  readonly roles: Readonly<Record<string, PipelineRole>>;
  readonly stages: readonly PipelineStage[];
  readonly assignments: Readonly<Record<string, PipelineAssignment>>;
}

/** `YYYY-MM-DD` → epoch ms at end of that UTC day. Dates in this file are days, not instants. */
export function endOfDay(isoDate: string): number {
  const t = Date.parse(`${isoDate}T23:59:59Z`);
  if (!Number.isFinite(t)) throw new RangeError(`not an ISO date: ${isoDate}`);
  return t;
}

/** `YYYY-MM-DD` for an epoch-ms instant, UTC. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function loadCopyPipeline(root: string = PACKAGE_ROOT): CopyPipeline {
  const raw: unknown = JSON.parse(readFileSync(join(root, 'review.json'), 'utf8'));
  const obj = (raw ?? {}) as Record<string, unknown>;
  const pipeline = obj['pipeline'];
  if (typeof pipeline !== 'object' || pipeline === null) {
    // Fail closed. An absent pipeline block must be loud: the whole point of
    // T-049 is that this work gets scheduled last and then forgotten, and a
    // loader that returned a friendly empty object would restore exactly that.
    throw new TypeError(
      'review.json has no `pipeline` block. The trilingual safety-copy pipeline (SD §DH-5 external dependency 2) is what makes the six-week lead time measurable; without it the waiver expiry is a surprise rather than a schedule.',
    );
  }
  return pipeline as CopyPipeline;
}

/**
 * Every reason a `signed_off` record must not be believed, as a list of strings.
 * Empty means nothing here contradicts itself.
 *
 * This is deliberately NOT `gate:safety-review-currency` — that is `T-044`'s, it
 * reads `entries` and the waiver, and it is the gate that fails the build. These
 * are the *coherence* rules between the plan (`pipeline`) and the delivery
 * (`entries`), which `T-044` has no way to check because they did not exist when
 * its contract was written.
 */
/** Which pipeline role must produce copy by a given method. Derived from the plan, not listed twice. */
const AUTHORING_ROLE_FOR_METHOD: Readonly<Record<CopyMethod, string>> = {
  authored: 'greek_authoring_safeguarding_practitioner',
  translated_briefed: 'russian_translator_briefed',
};

const REVIEWER_ROLES: readonly string[] = ['dsl', 'dsl_deputy'];

/**
 * A stakeholder ruling that makes an AI model the AUTHOR of one or more
 * locales' copy — T-233; `decisions.md` OE-66 (`el`, `ru`) and OE-67 (`en`
 * safety_critical), EV-16.
 *
 * **Passed in, never read from `review.json`.** The only real caller writes the
 * rulings as a literal in `src/pipeline.test.ts`, transcribed from
 * `decisions.md`. A register that listed the rulings it is checked against could
 * widen its own authority in the same commit as the record that needs it.
 * The default is NO rulings, so any caller that does not supply them refuses
 * every `ai_authored` record — fail closed.
 */
export interface AiAuthorshipRuling {
  /** The ruling id exactly as `decisions.md` names it, e.g. `OE-66`. */
  readonly id: string;
  /** When the stakeholder made it (ISO-8601 UTC). Nothing it authorises can be reviewed before it. */
  readonly decided_at: string;
  /** The locales whose copy the ruling makes the model the author of. */
  readonly locales: readonly string[];
  /** The model identities the ruling names, exactly as `authored_by` must spell them. */
  readonly authors: readonly string[];
}

const NO_AI_RULINGS: readonly AiAuthorshipRuling[] = [];

/**
 * Whether a stage describes an event that can happen at all under the current
 * assignments — as opposed to whether it has happened.
 *
 * QA round 3 named the complement of the rule I had just written. The permissive
 * dual-role path (§4b: one practitioner authoring all three locales natively) is
 * permitted precisely because there is nobody to brief and no brief to
 * acknowledge — and yet `brief_ru_translator` and `translate_ru` stayed blocking,
 * so signing anything off demanded a `completed_at` for two events that did not
 * occur. **My own mechanism was manufacturing pressure to write a false date**,
 * which is the exact pattern this whole register exists to prevent.
 *
 * `blocking` and applicability are different questions and both are kept:
 * `blocking` says *when this applies, it gates* — all six are, and R3-F1 asserts
 * it. Applicability says *does it apply*, and it is **derived from the
 * assignments**, never a flag someone can clear.
 */
export function stageApplies(stageId: string, pipeline: CopyPipeline): boolean {
  const locales = Object.values(pipeline.assignments).flatMap((a) => Object.values(a.locales));
  switch (stageId) {
    case 'brief_ru_translator':
    case 'translate_ru':
      // No locale is being translated ⇒ there is no translator to brief.
      return locales.some((l) => l.method === 'translated_briefed');
    case 'read_aloud_voice':
      // SA §TS-12.4's read-aloud pass covers strings that are heard rather than
      // read. `undetermined` counts as applying: fail closed, because a stage
      // that might be needed must not be skipped by a question nobody answered.
      return Object.values(pipeline.assignments).some((a) => a.channel !== 'screen');
    default:
      return true;
  }
}

export function pipelineIncoherences(
  register: ReviewRegister,
  pipeline: CopyPipeline,
  locales: readonly string[],
  safetyKeys: readonly string[],
  now: number = Date.now(),
  aiRulings: readonly AiAuthorshipRuling[] = NO_AI_RULINGS,
): string[] {
  const problems: string[] = [];

  // QA-F2. `authored_by !== reviewed_by` was string inequality over unconstrained
  // free text, and it did not enforce what the contract claimed. "B. Lead" and
  // "B. Lead, DSL" are one human and passed; "DeepL Pro v3 (machine)" is not a
  // human at all and passed, on a register whose entire subject is that machine
  // translation is prohibited. Both names are now resolved against the roster —
  // a closed, stakeholder-confirmed set — so distinctness is between two
  // identified ROLES rather than between two arbitrary strings.
  // R2-F2. Roles → names, built so that a name held by two roles is a FINDING
  // rather than whichever role JSON key order happened to write last. The
  // previous `Map.set` was last-write-wins, so the behaviour of every check
  // downstream depended on the order of keys in a JSON file — and the stakeholder
  // is about to name four people into exactly those keys.
  const rolesOfName = new Map<string, string[]>();
  for (const [id, role] of Object.entries(pipeline.roles)) {
    if (role.named === null) continue;
    const held = rolesOfName.get(role.named) ?? [];
    held.push(id);
    rolesOfName.set(role.named, held);
  }
  const reviewerRoles = new Set(REVIEWER_ROLES);
  const authoringRoles = new Set(Object.values(AUTHORING_ROLE_FOR_METHOD));

  for (const [name, ids] of rolesOfName) {
    if (ids.length < 2) continue;
    const held = new Set(ids);

    // (i) The DSL pair. PM §MVP-L5 AC7 makes trilingual coverage a property of
    // TWO people — "the Designated Safeguarding Lead and deputy BETWEEN THEM must
    // cover all three languages". One person holding both roles satisfies every
    // other predicate here and defeats the reason both roles exist.
    if (held.has('dsl') && held.has('dsl_deputy')) {
      problems.push(
        `pipeline.roles: '${name}' is named as both the DSL and the deputy DSL. PM §MVP-L5 AC7 requires the pair to cover English, Greek and Russian BETWEEN THEM — a pair of one covers whatever that one person covers, and a Russian-speaking sitter's copy would be signed off by nobody who reads Russian.`,
      );
    }

    // (ii) Four eyes, caught at naming time rather than at sign-off time. The
    // per-record check already refuses an author who holds a reviewer role, but
    // it only fires once something is signed off; this fires the moment the
    // roster is filled in, which is the stakeholder's next action.
    const authoring = ids.filter((i) => authoringRoles.has(i));
    const reviewing = ids.filter((i) => reviewerRoles.has(i));
    if (authoring.length > 0 && reviewing.length > 0) {
      problems.push(
        `pipeline.roles: '${name}' holds both an authoring role (${authoring.join(', ')}) and a reviewing role (${reviewing.join(', ')}). Review by the author is not review, whichever field their name is typed into.`,
      );
    }

    // (iii) Author and translator as one person is NOT banned — a trilingual
    // safeguarding practitioner authoring all three locales natively would be
    // BETTER than a translation. What is incoherent is claiming it as a
    // translation: there is no translator to brief and no brief to acknowledge,
    // so `brief_ru_translator` and `translate_ru` describe nothing. Reported
    // only when some locale actually claims `translated_briefed`.
    if (
      held.has('greek_authoring_safeguarding_practitioner') &&
      held.has('russian_translator_briefed')
    ) {
      const briefed = safetyKeys.filter((k) =>
        Object.values(pipeline.assignments[k]?.locales ?? {}).some(
          (l) => l.method === 'translated_briefed',
        ),
      );
      if (briefed.length > 0) {
        problems.push(
          `pipeline.roles: '${name}' is both the authoring practitioner and the briefed translator, while ${String(briefed.length)} key(s) still claim method 'translated_briefed'. One person cannot be briefed by themselves — if they author all three locales, the method is 'authored' and the provenance is 'authored'.`,
        );
      }
    }
  }

  const roleOfName = new Map<string, string>();
  for (const [name, ids] of rolesOfName) {
    // A duplicate is already reported above; resolve to the first role in
    // declaration order so the message downstream is deterministic rather than
    // dependent on which key JSON happened to write last.
    if (ids[0] !== undefined) roleOfName.set(name, ids[0]);
  }
  const namedPeople = new Map<string, PipelineRole>();
  for (const role of Object.values(pipeline.roles)) {
    if (role.named !== null) namedPeople.set(role.named, role);
  }
  const reviewerNames = new Set(
    Object.entries(pipeline.roles)
      .filter(([id, r]) => reviewerRoles.has(id) && r.named !== null)
      .map(([, r]) => r.named as string),
  );

  // R2-F1. `confirmed_by_stakeholder_on` must be a DATE, not merely non-null:
  // "pending" satisfied "has a value" and satisfied nothing else. Checked at the
  // roster level so it fires when the stakeholder fills the roster in, not only
  // when something is signed off.
  const confirmedOn = (name: string): string | null =>
    namedPeople.get(name)?.confirmed_by_stakeholder_on ?? null;
  const isRealDate = (v: string | null): boolean => v !== null && Number.isFinite(Date.parse(v));
  for (const [id, role] of Object.entries(pipeline.roles)) {
    if (role.named === null) continue;
    if (
      role.confirmed_by_stakeholder_on !== null &&
      !isRealDate(role.confirmed_by_stakeholder_on)
    ) {
      problems.push(
        `pipeline.roles['${id}'].confirmed_by_stakeholder_on is '${role.confirmed_by_stakeholder_on}', which is not a date. A confirmation that cannot be placed in time is not a confirmation.`,
      );
    }
  }

  // §5.1 re-read. The contract calls the stage list "in order"; nothing checked
  // it, so that was a claim with no test. A later stage completing before an
  // earlier one is the same defect as QA's F6d one level up — the sequence is the
  // mechanism, and a sequence nothing enforces is a list.
  let previousStage: { id: string; at: number } | null = null;
  for (const stage of pipeline.stages) {
    if (stage.completed_at !== null && !stageApplies(stage.id, pipeline)) {
      // The inverse of the rule above, and it must exist or the exemption becomes
      // a licence: a stage that cannot have happened may not be recorded as
      // having happened. Dropping `translated_briefed` from every locale and then
      // dating `brief_ru_translator` is a claim about an event with no subject.
      problems.push(
        `pipeline.stages['${stage.id}'] is recorded complete at ${stage.completed_at}, but no assignment makes it applicable — nothing here is translated, so there was no translator to brief. A stage that could not have happened may not be dated.`,
      );
    }
    if (stage.completed_at === null) continue;
    const at = Date.parse(stage.completed_at);
    if (!Number.isFinite(at)) {
      problems.push(`pipeline.stages['${stage.id}'].completed_at is not a date`);
      continue;
    }
    if (previousStage !== null && at < previousStage.at) {
      problems.push(
        `pipeline.stages: '${stage.id}' completed ${stage.completed_at}, before '${previousStage.id}' which precedes it. The stage list is a sequence — Russian cannot be translated before its translator was briefed, and copy cannot be signed off before it was written.`,
      );
    }
    previousStage = { id: stage.id, at };
  }

  // The latest blocking stage a sign-off must not predate. Derived from the
  // stages themselves rather than from a hand-written floor date.
  let latestBlockingStage = Number.NEGATIVE_INFINITY;
  for (const stage of pipeline.stages) {
    if (!stage.blocking || stage.completed_at === null) continue;
    const t = Date.parse(stage.completed_at);
    if (Number.isFinite(t) && t > latestBlockingStage) latestBlockingStage = t;
  }

  for (const key of safetyKeys) {
    const assignment = pipeline.assignments[key];
    if (assignment === undefined) {
      problems.push(
        `pipeline.assignments is missing '${key}'. A safety_critical key with no assignment has nobody who must author it and no language rule — it would arrive machine-translated and nothing here would say so.`,
      );
      continue;
    }
    if (assignment.machine_translation !== 'prohibited') {
      problems.push(
        `pipeline.assignments['${key}'].machine_translation must be 'prohibited' (DV-11)`,
      );
    }
    if (assignment.runtime_translation !== 'prohibited') {
      problems.push(
        `pipeline.assignments['${key}'].runtime_translation must be 'prohibited' (PM §MVP-IS5 AC7)`,
      );
    }
    for (const locale of locales) {
      const per = assignment.locales[locale];
      if (per === undefined) {
        problems.push(`pipeline.assignments['${key}'] has no rule for locale '${locale}'`);
        continue;
      }
      const record = register.entries[locale]?.[key];
      if (record === undefined) continue;

      // T-233 (OE-66 / OE-67, EV-16). AUTHORSHIP is checked at every status, not
      // only at sign-off, because an `ai_authored` record is exactly the record
      // that is never signed off (since T-259, final with no review) — and a model or a free-text
      // name in `authored_by` is a claim about who wrote safety copy whether or
      // not anyone has reviewed it yet. `aiRuling` is set ONLY when every
      // condition of the one permitted non-human route holds.
      let aiRuling: AiAuthorshipRuling | undefined;
      if (record.provenance === 'ai_authored' || record.ruling !== undefined) {
        const cited = aiRulings.find((r) => r.id === record.ruling);
        if (record.provenance !== 'ai_authored') {
          problems.push(
            `${locale}/${key}: cites ruling '${String(record.ruling)}' but its provenance is '${record.provenance}'. A ruling that makes a model the author is cited only by a record that says a model wrote it.`,
          );
        } else if (record.ruling === undefined) {
          problems.push(
            `${locale}/${key}: provenance 'ai_authored' with no \`ruling\`. A model may be recorded as the author only under a stakeholder ruling that makes it one (OE-66 / OE-67) — without the citation it is a machine author with nothing behind it.`,
          );
        } else if (cited === undefined) {
          problems.push(
            `${locale}/${key}: cites '${record.ruling}', which is not a stakeholder ruling that makes a model an author (known: ${aiRulings.map((r) => r.id).join(', ') || 'none'}).`,
          );
        } else if (!cited.locales.includes(locale)) {
          problems.push(
            `${locale}/${key}: cites ${cited.id}, which makes a model the author of ${cited.locales.join('/')} copy, not ${locale}.`,
          );
        } else if (record.authored_by === null || !cited.authors.includes(record.authored_by)) {
          problems.push(
            `${locale}/${key}: ai_authored under ${cited.id}, but authored_by is ${JSON.stringify(record.authored_by)}, not the model ${cited.id} names (${cited.authors.join('; ')}). Record the model truthfully — never a human name, never a different engine.`,
          );
        } else if (rolesOfName.has(record.authored_by)) {
          problems.push(
            `${locale}/${key}: ai_authored by '${record.authored_by}', which is also a named person in pipeline.roles. A model is not a roster member, and a roster member is not a model.`,
          );
        } else {
          aiRuling = cited;
        }
      } else if (
        record.status !== 'signed_off' &&
        record.authored_by !== null &&
        !rolesOfName.has(record.authored_by)
      ) {
        // The signed-off path below refuses the same author with its own
        // message; this is the same refusal for a record nobody has signed yet.
        problems.push(
          `${locale}/${key}: authored_by '${record.authored_by}' is not a named person in pipeline.roles, and the record cites no stakeholder ruling that makes a model its author. A machine or a free-text name is not an author of safety copy.`,
        );
      }

      // T-233 rework (QA O2). `reviewed_by` is checked at EVERY status too. The
      // sign-off path below refuses a non-DSL reviewer, but a `pending_review`
      // record naming the model (or anyone outside the DSL pair) as its reviewer
      // passed here and was caught only by a waiver-scoped test. Two rules:
      // a model a ruling names as an AUTHOR is never a reviewer (OE-66: the DSL
      // + deputy review is human), and only the named DSL or deputy may appear
      // in the field at all, signed off or not.
      if (record.reviewed_by !== null) {
        const reviewer = record.reviewed_by;
        if (aiRulings.some((r) => r.authors.includes(reviewer))) {
          problems.push(
            `${locale}/${key}: reviewed_by '${reviewer}' is an AI model that a ruling names as an author. A model is never a reviewer — OE-66 leaves the DSL + deputy review human.`,
          );
        }
        if (record.status !== 'signed_off' && !reviewerNames.has(reviewer)) {
          problems.push(
            `${locale}/${key}: reviewed_by '${reviewer}' is not the named DSL or deputy in pipeline.roles, on a record at '${record.status}'. Only the DSL pair may appear in reviewed_by, at any status.`,
          );
        }
      }

      // T-259 (OE-5-cut §3 item 3). The terminal status means FINAL WITH NO
      // REVIEW, by stakeholder ruling. It is accepted here, and refused if it
      // carries a reviewer or a review date — a record cannot be both.
      if (
        record.status === 'unreviewed_by_ruling' &&
        (record.reviewed_by !== null || record.reviewed_at !== null)
      ) {
        problems.push(
          `${locale}/${key}: status 'unreviewed_by_ruling' (final with no review, OE-5) but reviewed_by is ${JSON.stringify(record.reviewed_by)} and reviewed_at is ${JSON.stringify(record.reviewed_at)}. A record reviewed by nobody names no reviewer and no review date.`,
        );
      }

      if (record.status !== 'signed_off') continue;

      // From here down: a record CLAIMS to be reviewed. Everything is checked.
      // An AI-authored record under a valid ruling is exempt from exactly one
      // thing here — that its provenance equals the METHOD the plan assigned —
      // because the ruling IS the stakeholder-accepted deviation from that
      // method (EV-16). Everything about the REVIEW is checked unchanged.
      if (aiRuling === undefined && record.provenance !== per.required_provenance) {
        problems.push(
          `${locale}/${key}: signed off with provenance '${record.provenance}', but the pipeline requires '${per.required_provenance}' (${per.method}). ${per.why}`,
        );
      }
      if (assignment.channel === 'undetermined') {
        problems.push(
          `${locale}/${key}: signed off while its channel is undetermined, so SA §TS-12.4's read-aloud pass may or may not apply and nobody has decided which.`,
        );
      }
      if (
        record.authored_by === null ||
        record.reviewed_by === null ||
        record.reviewed_at === null
      ) {
        problems.push(
          `${locale}/${key}: signed off without an author, a reviewer or a review date`,
        );
        continue;
      }
      // (a) The author must be a NAMED, stakeholder-confirmed person in the
      // roster, and must be the role the assignment's method calls for. This is
      // what stops `authored_by: "DeepL Pro v3 (machine)"` and what makes the
      // distinctness check below mean something.
      const authorRole = roleOfName.get(record.authored_by);
      // T-233: for a valid AI-authored record the ruling stands in for the
      // roster, so the role checks in (a) do not apply to the AUTHOR; the model
      // was already refused above if it appears in the roster at all. The
      // reviewer checks further down apply unchanged — the reviewer is human.
      if (aiRuling === undefined) {
        // R2-F1. The author's stakeholder confirmation was never checked — only
        // the reviewer's — while the prose claimed both. Implemented rather than
        // narrowed, because an unconfirmed author is the same hole as an
        // unconfirmed reviewer: a name added in the same commit as the sign-off,
        // vouched for by nobody.
        if (authorRole !== undefined && !isRealDate(confirmedOn(record.authored_by))) {
          problems.push(
            `${locale}/${key}: authored_by '${record.authored_by}' is named in pipeline.roles but carries no stakeholder confirmation date`,
          );
        }
        if (authorRole === undefined) {
          problems.push(
            `${locale}/${key}: authored_by '${record.authored_by}' is not a named person in pipeline.roles, and the record cites no stakeholder ruling that makes a model its author. Safety copy is produced by an identified human in a named role, or by a model under a ruling that names it (OE-66 / OE-67) — a free-text author cannot be checked against anything, and a machine can be typed into it.`,
          );
        } else {
          const expectedRole = AUTHORING_ROLE_FOR_METHOD[per.method];
          if (authorRole !== expectedRole) {
            problems.push(
              `${locale}/${key}: authored_by is the '${authorRole}', but the pipeline requires this locale to be produced by the '${expectedRole}' (method '${per.method}')`,
            );
          }
          if (reviewerRoles.has(authorRole)) {
            problems.push(
              `${locale}/${key}: authored_by holds a reviewer role ('${authorRole}'). One person cannot be both sides of a four-eyes check, however the two fields are spelled.`,
            );
          }
          const reviewerRole = roleOfName.get(record.reviewed_by);
          if (reviewerRole !== undefined && reviewerRole === authorRole) {
            problems.push(
              `${locale}/${key}: authored_by and reviewed_by are the same person in role '${authorRole}'. Review by the author is not review.`,
            );
          }
        }
      }
      if (record.authored_by === record.reviewed_by) {
        problems.push(
          `${locale}/${key}: '${record.authored_by}' both authored and signed off this safety string. Review by the author is not review.`,
        );
      }

      // (b) `reviewed_at` was bounded by nothing: a 2019 sign-off passed, and so
      // did one dated before the translator had been briefed. Bounded now at both
      // ends, and the lower bound is DERIVED from the stages rather than written
      // as a floor date that would rot.
      const reviewedAt = Date.parse(record.reviewed_at);
      if (!Number.isFinite(reviewedAt)) {
        problems.push(`${locale}/${key}: reviewed_at '${record.reviewed_at}' is not a date`);
      } else {
        if (reviewedAt > now) {
          problems.push(
            `${locale}/${key}: reviewed_at ${record.reviewed_at} is in the future. A review that has not happened yet has not happened.`,
          );
        }
        if (Number.isFinite(latestBlockingStage) && reviewedAt < latestBlockingStage) {
          problems.push(
            `${locale}/${key}: reviewed_at ${record.reviewed_at} precedes the completion of a blocking pipeline stage. Sign-off before the translator was briefed, or before the copy existed, is not sign-off.`,
          );
        }
        if (reviewedAt < endOfDay(pipeline.engineering_kickoff) - 86_400_000) {
          problems.push(
            `${locale}/${key}: reviewed_at ${record.reviewed_at} predates the day this pipeline was opened (${pipeline.engineering_kickoff}). Nothing here can have been reviewed before the register that records it existed.`,
          );
        }
        if (aiRuling !== undefined && reviewedAt < Date.parse(aiRuling.decided_at)) {
          problems.push(
            `${locale}/${key}: reviewed_at ${record.reviewed_at} predates ${aiRuling.id} (${aiRuling.decided_at}), the ruling under which this copy was written. Copy cannot be reviewed before it could exist.`,
          );
        }
        if (
          typeof pipeline.external_start === 'string' &&
          reviewedAt < endOfDay(pipeline.external_start) - 86_400_000
        ) {
          problems.push(
            `${locale}/${key}: reviewed_at ${record.reviewed_at} predates external_start (${pipeline.external_start}). The copy was not out for authorship yet.`,
          );
        }
      }
      if (!reviewerNames.has(record.reviewed_by)) {
        problems.push(
          `${locale}/${key}: signed off by '${record.reviewed_by}', who is not the named DSL or deputy in pipeline.roles. Only the DSL pair may sign off safety copy (PM §MVP-L5 AC7).`,
        );
      }
      if (namedPeople.has(record.reviewed_by) && !isRealDate(confirmedOn(record.reviewed_by))) {
        // Was `!== null`, which `"pending"` satisfied (R2-F1). A confirmation
        // that cannot be placed in time is not a confirmation.
        problems.push(
          `${locale}/${key}: signed off by '${record.reviewed_by}', who is named in pipeline.roles but carries no stakeholder confirmation date`,
        );
      }
      for (const stage of pipeline.stages) {
        if (!stage.blocking) continue;
        // A stage describing an event that cannot happen under these assignments
        // is not required — and must not be recorded as completed either (below).
        if (!stageApplies(stage.id, pipeline)) continue;
        // T-233. For a valid AI-authored record, the stages whose `who` is an
        // AUTHORING role (derived from AUTHORING_ROLE_FOR_METHOD, not listed)
        // describe events the ruling displaced: no practitioner authored it and
        // no translator was briefed. Demanding a date for them would manufacture
        // pressure to write a false one — R3's lesson. Every REVIEW stage
        // (DSL sign-off, 360 px in-context review, read-aloud) still applies.
        if (aiRuling !== undefined && authoringRoles.has(stage.who)) continue;
        if (stage.completed_at === null) {
          problems.push(
            `${locale}/${key}: signed off while the blocking pipeline stage '${stage.id}' is not complete — ${stage.what}`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Whether the stage list is the manifest it claims to be — the exact ids, in the
 * declared order, **every one of them blocking**.
 *
 * R3-F1. The contract sentence read "Stage ids, all blocking, in order". The
 * §5.1 re-read implemented *"in order"* and left *"all blocking"* unbacked — and
 * `blocking` is the flag every other rule here reads, so the unbacked clause was
 * the load-bearing one. Flipping `dsl_signoff.blocking` to `false` removed DSL
 * sign-off from the requirement entirely and the suite stayed green.
 *
 * **The expected manifest is passed in**, and its only caller writes it as a
 * literal in `src/pipeline.test.ts`. It is deliberately not read from
 * `review.json`: a register that supplied the list it is checked against would be
 * checking that it equals itself (PROTOCOL §5.1), which is exactly how the flag
 * came to be flippable in the first place.
 */
export function stageManifestProblems(
  pipeline: CopyPipeline,
  expectedIds: readonly string[],
): string[] {
  const problems: string[] = [];
  const actual = pipeline.stages.map((s) => s.id);
  if (actual.length !== expectedIds.length || actual.some((id, i) => id !== expectedIds[i])) {
    problems.push(
      `pipeline.stages is [${actual.join(', ')}]; the pipeline SA §TS-12.4 defines is [${expectedIds.join(', ')}]. Adding, removing or reordering a stage is a change to the pipeline, not to a list.`,
    );
  }
  for (const stage of pipeline.stages) {
    if (!stage.blocking) {
      problems.push(
        `pipeline.stages['${stage.id}'].blocking is false. Every stage in this pipeline is blocking — \`blocking\` is the flag the sign-off rule reads, so clearing one silently removes that step from the requirement while every other check stays green.`,
      );
    }
  }
  return problems;
}
