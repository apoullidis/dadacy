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
export interface PendingPipeline {
  readonly opened_at: string;
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
