/**
 * `review.json` — provenance as a build input. SA §TS-12.3/§TS-12.4,
 * SD §FE-10 and SD Revision Log D8.
 *
 * **Build-time only.** This module reads the filesystem and is deliberately not
 * re-exported from the package root, so it can never be pulled into a browser
 * bundle. `import { … } from '@kinvara/i18n/review'`.
 *
 * The argument it implements, in one line: *an MT engine cannot produce a DSL
 * review record.* Machine translation is prohibited for `safety_critical` and
 * `transactional` copy (DV-11), and the way that prohibition is made
 * enforceable rather than merely intended is that passing the gate requires a
 * commit to this file naming a human reviewer — there is no other route.
 *
 * `T-044` owns `gate:safety-review-currency` and reads this file.
 * `T-049`'s six-week external copy pipeline is what populates it.
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
  /** Named human. `null` only while `status` is `pending_review`. */
  readonly authored_by: string | null;
  /** The DSL or legal reviewer who signed off. `null` only while `status` is `pending_review`. */
  readonly reviewed_by: string | null;
  /** ISO-8601 UTC. `null` only while `status` is `pending_review`. */
  readonly reviewed_at: string | null;
  readonly note?: string;
}

/**
 * A dated, self-closing waiver for copy that is out at the external pipeline.
 *
 * This exists because SD §DH-5's trilingual safety-copy pipeline has a **six-week
 * external lead time** (`T-049`) and the engineering skeleton necessarily lands
 * first. It is a waiver and not an ignore-list, and the difference is the whole
 * point: it names an owner, it names the keys, and it **expires**. After
 * `expected_by`, `gate:safety-review-currency` fails on the waived keys exactly
 * as it would on unwaived ones. That is BOARD RK-2's standing escalation
 * expressed as a build failure with a date on it rather than as a reminder.
 */
/**
 * One deliberate move of `expected_by`, with its reason. Append-only.
 *
 * The chain exists so that the date is not a single mutable field. Each row's
 * `from` is the previous row's `to`, the first `from` is the original date, and
 * the last `to` must equal `expected_by` — so editing the date without saying
 * why is a red test rather than a quiet edit.
 */
export interface ReAnchor {
  readonly from: string;
  readonly to: string;
  readonly decided_on: string;
  readonly decided_by: string;
  readonly reason: string;
  /** `external_start` as it stood when this decision was made. `null` = nothing had begun. */
  readonly external_start_at_decision: string | null;
  readonly note?: string;
}

export interface PendingPipeline {
  readonly opened_at: string;
  /**
   * **A decision review date, not a delivery date.** Nobody has promised copy by
   * it; no external engagement has begun, so there is nothing to promise. What
   * must happen by it is a *decision* — record a real `external_start` and
   * re-anchor to start + the lead time, or re-anchor again with a stated reason.
   *
   * The gate behaviour is unchanged and the self-closing property is unchanged:
   * after this date `gate:safety-review-currency` fails on these keys exactly as
   * on unwaived ones. **This is not an open-ended waiver.** Re-anchors made while
   * `external_start` is null are bounded by a literal in `src/pipeline.test.ts`,
   * deliberately outside this file — a register that could raise its own limit
   * would be measuring itself (PROTOCOL §5.1).
   */
  readonly expected_by: string;
  /** Mirrors `pipeline.external_start`, which is the source of truth. Explicitly null, never absent. */
  readonly external_start?: string | null;
  readonly owner: string;
  readonly ticket: string;
  readonly reason: string;
  readonly keys: readonly string[];
  readonly re_anchors?: readonly ReAnchor[];
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
// `entries` above records what HAS been reviewed. Everything below records what
// MUST happen to each `safety_critical` string, by whom, in which language, and
// by when — so that SD §DH-5's six-week external lead time can be measured
// against a date rather than remembered.
//
// **What this is not.** None of it asserts that any copy has been authored,
// translated or reviewed, and none of it can. The honest limit is stated once,
// here, rather than implied: this register lives in the same repository as the
// copy it vouches for, so a sufficiently determined edit can write a sign-off
// that never happened. `content_hash` binds a record to the CURRENT source, which
// proves currency, not review. What the predicates below buy is that a forged
// sign-off can no longer be a one-word edit: it must name an author, name a
// DIFFERENT reviewer, and add both to a roster carrying a stakeholder
// confirmation date — in the same commit, in a file whose whole subject is
// provenance. Loud and specific instead of cheap and silent. That is the claim,
// and it is not a stronger one.
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
  /** The day engineering opened the pipeline. Real, and it is not the external start. */
  readonly engineering_kickoff: string;
  /** The day the brief reaches a named practitioner. `null` until a stakeholder sets it. */
  readonly external_start: string | null;
  readonly lead_time_days: number;
  readonly deadline: string;
  readonly latest_external_start: string;
  readonly blocked_on: string;
  readonly roles: Readonly<Record<string, PipelineRole>>;
  readonly stages: readonly PipelineStage[];
  readonly assignments: Readonly<Record<string, PipelineAssignment>>;
}

const DAY_MS = 86_400_000;

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

/**
 * The last day the external half can begin and still land by `deadline`.
 *
 * Deliberately a function of two inputs that come from OUTSIDE this file — the
 * waiver's fixed expiry and SD §DH-5's stated lead time — rather than of the
 * interval between two dates the file itself carries. That interval is exactly
 * what QA-F3 caught `T-040` doing: a check derived from the same reading as the
 * thing it checks can only ever confirm it (PROTOCOL §5.1).
 */
export function latestExternalStart(deadline: string, leadTimeDays: number): string {
  return isoDay(endOfDay(deadline) - leadTimeDays * DAY_MS);
}

/** Days of slack remaining before the deadline becomes unachievable, given today. */
export function slackDays(pipeline: CopyPipeline, now: number): number {
  const latest = endOfDay(latestExternalStart(pipeline.deadline, pipeline.lead_time_days));
  const from = pipeline.external_start === null ? now : endOfDay(pipeline.external_start);
  return Math.floor((latest - from) / DAY_MS);
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
  if (!('external_start' in (pipeline as Record<string, unknown>))) {
    // Point 3 of the re-anchor decision, as a refusal rather than a convention.
    // `null` means "has not happened" and is checkable; an ABSENT key is
    // ambiguous — it reads identically to a field nobody thought to add, and the
    // whole value of this record is that the absence of a start is data.
    throw new TypeError(
      'review.json § pipeline has no `external_start` key. Record it explicitly as null — an absent key cannot be told apart from a field nobody added, and the absence of an external start is the fact this register exists to carry.',
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
export function pipelineIncoherences(
  register: ReviewRegister,
  pipeline: CopyPipeline,
  locales: readonly string[],
  safetyKeys: readonly string[],
): string[] {
  const problems: string[] = [];

  const namedPeople = new Map<string, PipelineRole>();
  for (const role of Object.values(pipeline.roles)) {
    if (role.named !== null) namedPeople.set(role.named, role);
  }
  const reviewerRoles = new Set(['dsl', 'dsl_deputy']);
  const reviewerNames = new Set(
    Object.entries(pipeline.roles)
      .filter(([id, r]) => reviewerRoles.has(id) && r.named !== null)
      .map(([, r]) => r.named as string),
  );

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
      if (record === undefined || record.status !== 'signed_off') continue;

      // From here down: a record CLAIMS to be reviewed. Everything is checked.
      if (record.provenance !== per.required_provenance) {
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
      if (record.authored_by === record.reviewed_by) {
        problems.push(
          `${locale}/${key}: '${record.authored_by}' both authored and signed off this safety string. Review by the author is not review.`,
        );
      }
      if (!reviewerNames.has(record.reviewed_by)) {
        problems.push(
          `${locale}/${key}: signed off by '${record.reviewed_by}', who is not the named DSL or deputy in pipeline.roles. Only the DSL pair may sign off safety copy (PM §MVP-L5 AC7).`,
        );
      }
      const reviewer = namedPeople.get(record.reviewed_by);
      if (reviewer !== undefined && reviewer.confirmed_by_stakeholder_on === null) {
        problems.push(
          `${locale}/${key}: signed off by '${record.reviewed_by}', who is named in pipeline.roles but carries no stakeholder confirmation date`,
        );
      }
      for (const stage of pipeline.stages) {
        if (!stage.blocking) continue;
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
 * Whether the `expected_by` chain tells a coherent story. Empty means it does.
 *
 * **The question PROTOCOL §5.1 forces, asked of this record itself: could it
 * report "we are on track" while nothing has been engaged?** Yes — trivially, by
 * appending a re-anchor row every time the date approaches. The chain is
 * self-reported and every field in it is derived from the same file, so on its
 * own it can only ever confirm itself.
 *
 * So the bound is **not** here. `maxUnstartedReAnchors` is passed in, and its
 * only caller writes it as a literal in the test file: a register that could
 * raise its own limit would be measuring itself. Cumulative drift is bounded
 * separately and also from outside, by the dated anchor in `review.test.ts`.
 * What this function checks is only that the chain is *continuous* and that it
 * *agrees with* the date it claims to explain — which is what turns a silent
 * date edit into a red test.
 */
export function reAnchorProblems(
  waiver: PendingPipeline,
  originalExpectedBy: string,
  maxUnstartedReAnchors: number,
): string[] {
  const problems: string[] = [];
  const chain = waiver.re_anchors ?? [];

  if (chain.length === 0) {
    if (waiver.expected_by !== originalExpectedBy) {
      problems.push(
        `expected_by is ${waiver.expected_by} but there are no re_anchors rows explaining the move from ${originalExpectedBy}. A date without a recorded decision is an edit, not a schedule.`,
      );
    }
    return problems;
  }

  if (chain[0]?.from !== originalExpectedBy) {
    problems.push(
      `re_anchors[0].from is ${String(chain[0]?.from)}, not the original ${originalExpectedBy}. The chain must start where the waiver did, or the earliest move is unaccounted for.`,
    );
  }
  for (let i = 1; i < chain.length; i += 1) {
    const prev = chain[i - 1];
    const cur = chain[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.from !== prev.to) {
      problems.push(
        `re_anchors[${String(i)}].from (${cur.from}) does not continue from re_anchors[${String(i - 1)}].to (${prev.to}) — a gap here is a date that moved without a decision`,
      );
    }
  }
  const last = chain[chain.length - 1];
  if (last !== undefined && last.to !== waiver.expected_by) {
    problems.push(
      `expected_by is ${waiver.expected_by} but the last re-anchor moved it to ${last.to}. The date was edited without recording why.`,
    );
  }
  for (const [i, row] of chain.entries()) {
    if (endOfDay(row.to) <= endOfDay(row.from)) {
      problems.push(
        `re_anchors[${String(i)}] does not move the date forward (${row.from} → ${row.to})`,
      );
    }
    if (row.reason.trim() === '' || row.decided_by.trim() === '') {
      problems.push(`re_anchors[${String(i)}] has no stated reason or no decider`);
    }
  }

  const unstarted = chain.filter((r) => r.external_start_at_decision === null).length;
  if (unstarted > maxUnstartedReAnchors) {
    problems.push(
      `${String(unstarted)} re-anchors have been made with no external_start recorded, over a bound of ${String(maxUnstartedReAnchors)}. Repeatedly moving the date while nothing has been engaged is the shape of an open-ended waiver, which this mechanism exists to not become. Raising the bound is an orchestrator decision against BOARD RK-2 and must cost an edit to the literal in src/pipeline.test.ts.`,
    );
  }
  return problems;
}
