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
   * Who wrote the string: only when `provenance` is `ai_authored` and `ruling`
   * cites a stakeholder ruling that makes a model the author of this locale's
   * copy, that model, named exactly as the ruling names it. Since OE-5 (T-260)
   * there is no human route: a person's name, or a model without a ruling, is
   * refused by `pipelineIncoherences()` at every status. `null` while nothing
   * has been authored.
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
// T-049 — the pipeline itself, as data; reduced by T-260 to what OE-5 leaves.
//
// `entries` above records who wrote each `safety_critical` string and, since
// T-259, that it is final with no review under stakeholder ruling OE-5. The
// `pipeline` block below records, per key, how the string is consumed
// (`channel`), whether it sits on the emergency panel, and the two translation
// bans; and, since T-264, which gates make SA §TS-12.4's two checks
// (`automated_checks`, OE-82).
//
// **What T-260 removed, and why.** T-049 recorded a HUMAN path: a roster of
// four roles (a Greek-authoring safeguarding practitioner, a briefed Russian
// translator, the DSL and the deputy), a sequence of stages they would
// complete, a per-locale authoring method, and a sign-off rule that a
// `signed_off` record had to satisfy against all of it. OE-66/OE-67 made an AI
// model the author of this copy and OE-5 (2026-10-11; EV-16 as extended)
// dropped the DSL + deputy review: no human authors or reviews it, and nothing
// may record or claim that one did. T-259 deleted the dates; T-260 deletes the
// roster, the stages, the methods and the sign-off path. `pipelineIncoherences`
// now refuses any of them coming back (`pipeline.roles`, `pipeline.stages`, a
// per-locale `locales` method, or any field outside the closed set), and any
// record that names a human or a review.
//
// **What this is not.** None of it asserts that any copy is right, and none of
// it can prove which model wrote the bytes. This register lives in the same
// repository as the copy it describes; `content_hash` proves currency, not
// authorship. `gate:safety-review-currency` pins the accepted bytes in its own
// source (T-258), which makes a change visible in review of the diff.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the string is consumed. `spoken_by_user` and `voice` both require SA
 * §TS-12.4's read-aloud pass; `undetermined` fails closed, because a string
 * whose channel nobody has decided would silently skip that pass.
 */
export type CopyChannel = 'screen' | 'spoken_by_user' | 'voice' | 'undetermined';

/** The channels `CopyChannel` admits, for the run-time check in `pipelineIncoherences`. */
const COPY_CHANNELS: readonly CopyChannel[] = ['screen', 'spoken_by_user', 'voice', 'undetermined'];

export interface PipelineAssignment {
  /** PM §MVP-IS5 AC7: number labels, the 112 script, the address-reading prompt. */
  readonly emergency_panel: boolean;
  readonly channel: CopyChannel;
  readonly channel_note: string;
  readonly machine_translation: 'prohibited' | 'permitted';
  readonly runtime_translation: 'prohibited' | 'permitted';
}

export interface CopyPipeline {
  readonly opened_by: string;
  /** The day engineering opened the pipeline (2026-09-05). A record of the past, not a date in force. */
  readonly engineering_kickoff: string;
  /**
   * T-264 (OE-82): the two checks SA §TS-12.4 asked a person to make, as the
   * gates that make them. DESCRIPTIVE ONLY: no `who`, no `completed_at`, and no
   * applicability — which keys each applies to is pinned in gate source
   * (`tools/automated-checks.ts`), never read from here.
   */
  readonly automated_checks?: readonly AutomatedCheckEntry[];
  readonly assignments: Readonly<Record<string, PipelineAssignment>>;
}

/** One entry of `pipeline.automated_checks` (T-264). */
export interface AutomatedCheckEntry {
  readonly id: string;
  readonly gate: string;
  readonly ticket: string;
  readonly record: string;
  readonly what: string;
}

/**
 * T-260. The fields a `pipeline` block may carry, and the fields one
 * `assignments` entry may carry — closed sets, written here and never read
 * from `review.json`, so a register cannot widen the set it is checked
 * against. `//` is the register's comment key.
 */
const PIPELINE_FIELDS: readonly string[] = [
  '//',
  'opened_by',
  'engineering_kickoff',
  'automated_checks',
  'assignments',
];
const ASSIGNMENT_FIELDS: readonly string[] = [
  'emergency_panel',
  'channel',
  'channel_note',
  'machine_translation',
  'runtime_translation',
];

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
    // Fail closed. An absent pipeline block must be loud: it carries every
    // safety key's channel and translation bans, which three gates read
    // (gate:safety-review-currency, gate:read-aloud, gate:sms-segments), and a
    // loader that returned a friendly empty object would hide their absence.
    throw new TypeError(
      'review.json has no `pipeline` block. It carries each safety_critical key’s channel, emergency-panel flag and translation bans (T-049, T-260); without it nothing says how a safety string is consumed.',
    );
  }
  return pipeline as CopyPipeline;
}

/**
 * A stakeholder ruling that makes an AI model the AUTHOR of one or more
 * locales' copy — T-233; `decisions.md` OE-66 (`el`, `ru`) and OE-67 (`en`
 * safety_critical), EV-16.
 *
 * **Passed in, never read from `review.json`.** Its callers import the literal
 * `AI_RULINGS` from `tools/rulings.ts` (T-258), transcribed from
 * `decisions.md`. A register that listed the rulings it is checked against
 * could widen its own authority in the same commit as the record that needs it.
 * The default is NO rulings, so any caller that does not supply them refuses
 * every `ai_authored` record — fail closed.
 */
export interface AiAuthorshipRuling {
  /** The ruling id exactly as `decisions.md` names it, e.g. `OE-66`. */
  readonly id: string;
  /** When the stakeholder made it (ISO-8601 UTC). */
  readonly decided_at: string;
  /** The locales whose copy the ruling makes the model the author of. */
  readonly locales: readonly string[];
  /** The model identities the ruling names, exactly as `authored_by` must spell them. */
  readonly authors: readonly string[];
}

const NO_AI_RULINGS: readonly AiAuthorshipRuling[] = [];

/** Provenances that claim a HUMAN wrote or reviewed the string. */
const HUMAN_PROVENANCES: readonly ReviewProvenance[] = [
  'authored',
  'translated_professional',
  'legal_review',
];

/**
 * Every way the register contradicts stakeholder rulings OE-66/OE-67/OE-5, as a
 * list of strings. Empty means nothing here names a human or a review.
 *
 * This is deliberately NOT `gate:safety-review-currency` — that gate fails the
 * build, and it does not call this function. This runs over the committed
 * register in `src/pipeline.test.ts`, and so in `gate:unit-tests`/`gate:pr`.
 *
 * T-260 reduced it to two things:
 *
 *  1. **Provenance coherence, at every status.** A model may be `authored_by`
 *     only under a ruling that names it, covers the locale, and is cited in
 *     `ruling` on an `ai_authored` record (T-233). A non-null `authored_by` on
 *     any other record, and any human provenance, is refused. `status` may not
 *     be `signed_off`, and `reviewed_by`/`reviewed_at` must be null: no review
 *     exists under OE-5, so a record naming a reviewer or a review date at any
 *     status is refused.
 *  2. **The plan's shape.** Every `safety_critical` key has an assignment whose
 *     channel is a `CopyChannel` and whose machine- and runtime-translation are
 *     prohibited; the `pipeline` block and each assignment carry only the
 *     fields of the closed sets above. A `roles` block (a roster of people), a
 *     `stages` block (steps someone completes) or a per-locale `locales` method
 *     is refused, with whatever it names.
 *
 * `_now` is unused since T-260 removed the sign-off path's date rules. It stays
 * so that the published signature (T-049 § contract §2, T-233 § contract §1)
 * keeps `aiRulings` in sixth position.
 */
export function pipelineIncoherences(
  register: ReviewRegister,
  pipeline: CopyPipeline,
  locales: readonly string[],
  safetyKeys: readonly string[],
  _now?: number,
  aiRulings: readonly AiAuthorshipRuling[] = NO_AI_RULINGS,
): string[] {
  const problems: string[] = [];
  const raw = pipeline as unknown as Record<string, unknown>;

  // T-260. The human path may not come back under any name. Each foreign field
  // is one line; a roster or a stage list also says whom it names, because
  // naming a person is the claim OE-5 forbids.
  for (const field of Object.keys(raw)) {
    if (PIPELINE_FIELDS.includes(field)) continue;
    let detail = '';
    const value = raw[field];
    if (field === 'roles' && typeof value === 'object' && value !== null) {
      const named = Object.entries(value as Record<string, unknown>)
        .map(([id, r]) => [id, (r as { named?: unknown } | null)?.named] as const)
        .filter(([, n]) => n !== null && n !== undefined)
        .map(([id, n]) => `${id} = ${JSON.stringify(n)}`);
      detail = ` It is a roster of human roles [${Object.keys(value).join(', ')}]${named.length > 0 ? ` naming ${named.join('; ')}` : ''}.`;
    } else if (field === 'stages' && Array.isArray(value)) {
      const whos = value.map((s) => {
        const st = s as { id?: unknown; who?: unknown } | null;
        return `${String(st?.id)} (who: ${JSON.stringify(st?.who)})`;
      });
      detail = ` It is a list of steps someone completes: ${whos.join(', ') || '(empty)'}.`;
    }
    problems.push(
      `pipeline.${field} is not a field of the pipeline (${PIPELINE_FIELDS.filter((f) => f !== '//').join(', ')}).${detail} The human roster, the stages and the per-locale methods were withdrawn under OE-5 (T-260): no human authors or reviews this copy, and nothing may record that one does.`,
    );
  }

  for (const key of safetyKeys) {
    const assignment = pipeline.assignments[key];
    if (assignment === undefined) {
      problems.push(
        `pipeline.assignments is missing '${key}'. A safety_critical key with no assignment has no channel and no translation ban — it would arrive machine-translated and nothing here would say so.`,
      );
      continue;
    }
    for (const field of Object.keys(assignment)) {
      if (ASSIGNMENT_FIELDS.includes(field)) continue;
      problems.push(
        `pipeline.assignments['${key}'].${field} is not a field of an assignment (${ASSIGNMENT_FIELDS.join(', ')}). A per-locale authoring method or a "why" naming a practitioner or translator describes the human path withdrawn under OE-5 (T-260).`,
      );
    }
    if (!COPY_CHANNELS.includes(assignment.channel)) {
      problems.push(
        `pipeline.assignments['${key}'].channel is ${JSON.stringify(assignment.channel)}, not one of ${COPY_CHANNELS.join(', ')}`,
      );
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
  }

  for (const key of safetyKeys) {
    for (const locale of locales) {
      const record = register.entries[locale]?.[key];
      if (record === undefined) continue;

      // T-233 (OE-66 / OE-67, EV-16). AUTHORSHIP, at every status. The one
      // permitted author is a model, under a ruling that names it exactly and
      // covers this locale, on a record that says a model wrote it.
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
        }
      } else if (record.authored_by !== null) {
        problems.push(
          `${locale}/${key}: authored_by '${record.authored_by}' is not a model that a stakeholder ruling names, and the record cites no ruling. Under OE-66/OE-67 and OE-5 no human authors this copy: a free-text name, a person or a machine without a ruling is not an author of safety copy.`,
        );
      }
      if (HUMAN_PROVENANCES.includes(record.provenance)) {
        problems.push(
          `${locale}/${key}: provenance '${record.provenance}' claims a human wrote or reviewed this string. Under OE-66/OE-67 and OE-5 none did (T-260).`,
        );
      }

      // No review exists under OE-5, so nothing may be signed off and nobody
      // may be named as a reviewer, at any status.
      if (record.status === 'signed_off') {
        problems.push(
          `${locale}/${key}: status 'signed_off'. No review of this copy exists under OE-5 (EV-16 extended); a record claiming a sign-off claims a review that did not happen.`,
        );
      }
      if (record.reviewed_by !== null) {
        const reviewer = record.reviewed_by;
        if (aiRulings.some((r) => r.authors.includes(reviewer))) {
          problems.push(
            `${locale}/${key}: reviewed_by '${reviewer}' is an AI model that a ruling names as an author. A model is never a reviewer.`,
          );
        }
      }
      // T-259 (OE-5-cut §3 item 3). The terminal status means FINAL WITH NO
      // REVIEW, by stakeholder ruling. It is refused if it carries a reviewer
      // or a review date — a record cannot be both.
      if (
        record.status === 'unreviewed_by_ruling' &&
        (record.reviewed_by !== null || record.reviewed_at !== null)
      ) {
        problems.push(
          `${locale}/${key}: status 'unreviewed_by_ruling' (final with no review, OE-5) but reviewed_by is ${JSON.stringify(record.reviewed_by)} and reviewed_at is ${JSON.stringify(record.reviewed_at)}. A record reviewed by nobody names no reviewer and no review date.`,
        );
      } else if (record.reviewed_by !== null || record.reviewed_at !== null) {
        // T-260: the same at every other status — under OE-5 there is no
        // reviewer to name, pending or signed off.
        problems.push(
          `${locale}/${key}: reviewed_by is ${JSON.stringify(record.reviewed_by)} and reviewed_at is ${JSON.stringify(record.reviewed_at)} on a record at '${record.status}'. No review of this copy exists under OE-5, so no record names a reviewer or a review date, at any status.`,
        );
      }
    }
  }
  return problems;
}
