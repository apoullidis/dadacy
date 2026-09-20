/**
 * `gate:safety-review-currency` — T-044. SD §Revision Log D8, SA §TS-12.3.
 *
 * THE RULE, quoted from `T-040` § Published contract §6 because this gate is
 * that paragraph and nothing wider: *for every `safety_critical` key K and
 * every enabled locale L, FAIL unless `entries[L][K]` exists AND
 * `content_hash === contentHash(source(L,K))` AND `status === "signed_off"` AND
 * `provenance !== "placeholder"` AND `reviewed_by` and `reviewed_at` are
 * non-null — UNLESS K is listed in an unexpired `pending_pipeline` waiver.*
 *
 * WHAT THIS GATE IS THE OTHER HALF OF. `gate:locale-completeness` (T-042)
 * proves a `safety_critical` string is PRESENT and RENDERABLE; it states in its
 * own contract §5 that a present, well-formed string that is WRONG passes it.
 * Provenance is this half: a human is named, a review date is recorded, and the
 * hash binds both to the exact bytes now in the catalogue. Editing a safety
 * string changes its hash and therefore un-signs it — that is the mechanism,
 * not a side effect.
 *
 * WHY IT IS GREEN TODAY, SAID OUT LOUD RATHER THAN DISCOVERED. No safety copy
 * in this repository has been authored, translated or signed off: all 24
 * records are `provenance: "placeholder"` (T-040) and T-049 created none, since
 * there is no DSL to reach. A literal reading of the rule would therefore be
 * RED ON THE TRUNK the day this gate is promoted. The waiver is what carries
 * it: T-040 published a dated, self-closing waiver over exactly those keys, and
 * T-049 re-anchored its date to 2026-12-05 (stakeholder decision OE-5). So the
 * gate is green BECAUSE OF THE WAIVER, it says so on stdout in those words, and
 * it goes RED of its own accord the day after `expected_by`. A waiver that
 * never expires is a green gate wearing a date, which is why the expiry is
 * anchored OUTSIDE the register (below).
 *
 * THREE READINGS, FROM ARTEFACTS THAT ARE NOT EACH OTHER (PROTOCOL §5.1: "a
 * check must not be derived from the same reading as the thing it checks"):
 *
 *   A  THE SOURCE ARTEFACTS — `locale-registry.json` (which locales),
 *      `tiers.json` x `TIER_POLICY.requiresSafetyReview` (which keys),
 *      `catalogues/<locale>/<ns>.json` (the bytes hashed) and `review.json`
 *      (`entries` + `pending_pipeline`). This is the rule above.
 *   B  THE COMMITTED COMPILED ARTEFACT — `keysAtTier('safety_critical')` and
 *      `enabledLocales()` from `compiled/`. If the tier table that SHIPS and
 *      the tier table this gate read disagree, one of them is enforcing a
 *      different rule and the gate says so rather than picking one.
 *   C  THE PINS IN THIS FILE — the key set, the locale set and the waiver's
 *      expiry and key set as they stood on 2026-09-20, written HERE, in source
 *      the register cannot edit. They are the answer to "if it checked nothing,
 *      would it say so?", because every cheap way to make this gate examine
 *      less is an edit to a file the pins do not live in:
 *        - re-tier `session.checkins_missed` to `operational`  -> TIER-ESCAPE
 *        - disable `ru` in the registry                        -> LOCALE-DISABLED
 *        - move `expected_by` a year out                       -> WAIVER-RENEWED
 *        - add a NEW safety key to the waiver                  -> WAIVER-EXTENDED
 *        - delete records while the waiver covers them         -> WAIVED-NO-RECORD
 *      The first four were the cheap routes T-040's QA (QA-F3, QA-F4, QA-F5)
 *      named as open after T-049 clears the suite's own waiver assertions.
 *
 * WHAT THIS GATE DOES NOT READ, MEASURED RATHER THAN ASSERTED. `review.json`'s
 * `pipeline` block (T-049) is a SIBLING key of `pending_pipeline` and nothing
 * here reads it: this gate loads the register through `loadReviewRegister()`,
 * which projects `version`, `pending_pipeline` and `entries` and nothing else.
 * T-049 § contract §1 says a gate implementing T-040 §6 verbatim needs no
 * change for it, and says explicitly that that is a reading of the rule and not
 * a measurement. The measurement is in `state/EP-0/T-044.md` § Evidence 3.
 * `pipelineIncoherences()` is deliberately NOT wired in — T-049 offers it and
 * does not require it, and wiring it would couple this gate to a block that
 * names no people yet.
 *
 * USAGE:  node packages/i18n/tools/safety-review-currency.ts [--root <dir>]
 *
 * `--root` points reading A at another package root (the Vitest cases build one
 * in a temporary directory). READINGS B AND C ARE THEN NOT RUN — the compiled
 * catalogue reachable from this script belongs to `packages/i18n` and not to
 * that root, and the pins are about THIS package's key set — and the PASS/FAIL
 * BANNER SAYS SO, so a `--root` run can never be pasted as evidence of a full
 * one. The committed `pnpm gate:safety-review-currency` passes no arguments.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contentHash,
  catalogueSource,
  loadReviewRegister,
  endOfDay,
  isoDay,
} from '../src/review.ts';
import type { ReviewRecord, PendingPipeline } from '../src/review.ts';
import { TIER_POLICY } from '../src/tiers.ts';
import type { Tier } from '../src/types.ts';

const GATE = 'gate:safety-review-currency';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------- pins */

/**
 * READING C. Three pins, written in this file on 2026-09-20 by T-044, because
 * a gate whose expected workload is read entirely out of the files it is
 * checking can be silenced by editing those files (PROTOCOL §5.1).
 *
 * T-040's QA left this as a named obligation on this ticket (QA-F5): *"T-044
 * should assert the `safety_critical` key set against a committed, reviewed
 * list rather than deriving it from `tiers.json` alone — the tier file is both
 * the thing being checked and the source of the check."*
 */

/**
 * Every key tiered `safety_critical` on 2026-09-20. The check is `subset`, in
 * ONE direction: each of these must STILL be `safety_critical`. Adding a
 * ninth safety key later is not a failure and needs no edit here; losing
 * one of these — re-tiered, renamed or deleted — is TIER-ESCAPE, because that
 * is the shape of "make the gate check less".
 */
const SAFETY_KEYS_PINNED: readonly string[] = [
  'safety.emergency.address_prompt',
  'safety.emergency.call_112.label',
  'safety.emergency.call_112.script',
  'safety.helpline.116111.label',
  'safety.helpline.1466.label',
  'safety.helpline.199.label',
  'safety.sos.confirm',
  'session.checkins_missed',
];

/**
 * The keys T-049's waiver covers, as its `keys` array stood on 2026-09-20. The
 * check is the OTHER direction — `waiver.keys` must be a SUBSET of this — and
 * the asymmetry is the whole point of the constant:
 *
 *   - removing a key from the waiver is T-049 DELIVERING that key, and must
 *     need no edit here (T-040 QA-F4: the old equality assertion made partial
 *     delivery impossible);
 *   - adding a key to the waiver is extending a September waiver over copy it
 *     was never opened for, which QA-F4 named as the thing the mechanism
 *     actively invites. That is WAIVER-EXTENDED, and it costs an edit to this
 *     file plus an orchestrator decision against BOARD RK-2.
 *
 * It is deliberately a SECOND literal rather than an alias of the list above,
 * even though the two are equal today. They must not be kept equal by
 * construction: a ninth `safety_critical` key must grow the first list and
 * must NOT be admissible to the waiver.
 */
const WAIVER_KEYS_CEILING: readonly string[] = [
  'safety.emergency.address_prompt',
  'safety.emergency.call_112.label',
  'safety.emergency.call_112.script',
  'safety.helpline.116111.label',
  'safety.helpline.1466.label',
  'safety.helpline.199.label',
  'safety.sos.confirm',
  'session.checkins_missed',
];

/** Every locale enabled in `locale-registry.json` on 2026-09-20. Same direction as the key pin. */
const LOCALES_PINNED: readonly string[] = ['en', 'el', 'ru'];

/**
 * THE WAIVER MAY NOT EXPIRE LATER THAN THIS DAY.
 *
 * T-040's QA found (QA-F3) that a waiver policed only by its own two dates can
 * be renewed indefinitely by moving both of them forward, with every check
 * green — the check and the thing checked computed from one reading. The anchor
 * therefore lives here, in the gate, and not in `review.json`.
 *
 * 2026-12-05 is `pending_pipeline.expected_by` after the ONE re-anchor the
 * register records: stakeholder decision OE-5, taken 2026-09-05 from T-049's
 * OD-15, moving 2026-10-17 -> 2026-12-05 because the original window was
 * exactly the lead time and so had zero slack on the day it opened.
 *
 * EARLIER IS ALLOWED, LATER IS NOT. Shortening a waiver cannot buy time, so an
 * `expected_by` before this day is not a finding; one after it is
 * WAIVER-RENEWED. Moving this line is an orchestrator decision against BOARD
 * RK-2 (and moves `ANCHOR` in `src/review.test.ts` and `DEADLINE` in
 * `src/pipeline.test.ts` with it — T-049 § contract §4a), never a repair for a
 * red build.
 */
const WAIVER_NOT_AFTER = '2026-12-05';

/* ----------------------------------------------------------------- output */

/**
 * Everything goes to STDOUT, banner included, so a piped paste keeps its order
 * (T-042 does the same, for the same reason).
 */
function finish(banner: string, failures: readonly string[]): never {
  if (failures.length === 0) {
    console.log(`\nGATE PASS  ${banner}`);
    process.exit(0);
  }
  console.log(`\nGATE FAIL  ${banner} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ input */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseArgs(argv: readonly string[]): { root: string; explicitRoot: boolean } {
  let root = PACKAGE_ROOT;
  let explicitRoot = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`${GATE}: --root needs a directory`);
        process.exit(2);
      }
      root = value;
      explicitRoot = true;
      i += 1;
      continue;
    }
    // Refused rather than ignored: an unrecognised argument is far more likely
    // to be a narrowing someone expected to take effect.
    console.error(`${GATE}: unrecognised argument ${JSON.stringify(arg)}`);
    process.exit(2);
  }
  return { root, explicitRoot };
}

interface Registry {
  readonly defaultLocale: string;
  readonly enabled: readonly string[];
}

function loadRegistry(root: string, failures: string[]): Registry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'locale-registry.json'), 'utf8')) as unknown;
  } catch (err) {
    failures.push(`INPUT locale-registry.json is unreadable or not JSON — ${String(err)}`);
    return undefined;
  }
  if (
    !isRecord(raw) ||
    typeof raw['defaultLocale'] !== 'string' ||
    !Array.isArray(raw['locales'])
  ) {
    failures.push(
      'INPUT locale-registry.json needs a string `defaultLocale` and a `locales` array',
    );
    return undefined;
  }
  const enabled: string[] = [];
  for (const row of raw['locales']) {
    if (!isRecord(row)) continue;
    if (typeof row['code'] === 'string' && row['enabled'] === true) enabled.push(row['code']);
  }
  return { defaultLocale: raw['defaultLocale'], enabled };
}

/**
 * The keys that need a review record, from `tiers.json` filtered by
 * `TIER_POLICY[tier].requiresSafetyReview`. DERIVED, never the literal
 * `'safety_critical'`: `src/tiers.ts` is the one place the four tiers'
 * behaviour is stated (T-040 § contract §2), and a fifth tier that needed a
 * review record would be covered here with no edit.
 */
function loadReviewTieredKeys(
  root: string,
  failures: string[],
): { keys: readonly string[]; tiered: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'tiers.json'), 'utf8')) as unknown;
  } catch (err) {
    failures.push(`INPUT tiers.json is unreadable or not JSON — ${String(err)}`);
    return { keys: [], tiered: 0 };
  }
  const tiers = isRecord(raw) ? raw['tiers'] : undefined;
  if (!isRecord(tiers)) {
    failures.push('INPUT tiers.json needs a `tiers` object mapping fully-qualified key -> tier');
    return { keys: [], tiered: 0 };
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(tiers)) {
    if (typeof value !== 'string' || !(value in TIER_POLICY)) {
      failures.push(
        `INPUT tiers.json: '${key}' has tier ${JSON.stringify(value)}, which is not one of ` +
          `${Object.keys(TIER_POLICY).join(', ')}. A mis-tiered key cannot be placed on either ` +
          'side of this gate, so it is refused rather than skipped.',
      );
      continue;
    }
    if (TIER_POLICY[value as Tier].requiresSafetyReview) keys.push(key);
  }
  return { keys: keys.sort(), tiered: Object.keys(tiers).length };
}

/* ------------------------------------------------------------ the waiver */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Waiver {
  readonly keys: ReadonlySet<string>;
  readonly expectedBy: string;
  readonly expired: boolean;
}

/**
 * Validate the waiver, then decide whether it is still in force.
 *
 * A malformed waiver is NOT "no waiver": it is refused. The two outcomes look
 * the same from a distance and are opposite in effect — "no waiver" makes the
 * gate strict, "malformed waiver" would make it silently lenient if the
 * malformation were in `keys`.
 */
function readWaiver(
  pending: PendingPipeline | null,
  safetyKeys: readonly string[],
  nowMs: number,
  failures: string[],
): Waiver | undefined {
  if (pending === null || pending === undefined) return undefined;
  if (!isRecord(pending)) {
    failures.push('WAIVER-MALFORMED `pending_pipeline` is present but is not an object.');
    return undefined;
  }
  const p = pending as unknown as Record<string, unknown>;
  let bad = false;
  for (const field of ['opened_at', 'expected_by'] as const) {
    const v = p[field];
    if (
      typeof v !== 'string' ||
      !ISO_DAY.test(v) ||
      !Number.isFinite(Date.parse(`${v}T00:00:00Z`))
    ) {
      failures.push(
        `WAIVER-MALFORMED \`pending_pipeline.${field}\` is ${JSON.stringify(v)}; a waiver is a ` +
          'dated instrument and an undated one cannot self-close.',
      );
      bad = true;
    }
  }
  for (const field of ['owner', 'ticket', 'reason'] as const) {
    const v = p[field];
    if (typeof v !== 'string' || v.trim() === '') {
      failures.push(
        `WAIVER-MALFORMED \`pending_pipeline.${field}\` is ${JSON.stringify(v)}; a waiver names ` +
          'an owner, a ticket and a reason, or it is an ignore-list.',
      );
      bad = true;
    }
  }
  const rawKeys = p['keys'];
  if (!Array.isArray(rawKeys) || rawKeys.some((k) => typeof k !== 'string')) {
    failures.push(
      'WAIVER-MALFORMED `pending_pipeline.keys` must be an array of fully-qualified key strings; ' +
        'a waiver that does not name its keys waives an unknown set.',
    );
    bad = true;
  }
  if (bad) return undefined;

  const keys = (rawKeys as string[]).slice();
  const expectedBy = p['expected_by'] as string;

  for (const key of keys) {
    if (!safetyKeys.includes(key)) {
      failures.push(
        `WAIVER-OVERREACH the waiver names '${key}', which is not a key needing a safety review ` +
          'record in tiers.json. A waiver may only waive what this gate would otherwise check; ' +
          'naming anything else means the waiver and the tier table have drifted apart.',
      );
    }
  }
  if (endOfDay(expectedBy) > endOfDay(WAIVER_NOT_AFTER)) {
    failures.push(
      `WAIVER-RENEWED \`pending_pipeline.expected_by\` is ${expectedBy}, later than the ` +
        `${WAIVER_NOT_AFTER} anchor pinned in this gate. The safety-copy waiver self-closes ` +
        'against time; it must not be renewable by editing the field that expires it (T-040 ' +
        'QA-F3). Moving it is an orchestrator decision against BOARD RK-2 and moves this line ' +
        'with it.',
    );
  }

  const expired = nowMs > endOfDay(expectedBy);
  if (expired) {
    failures.push(
      `WAIVER-EXPIRED the safety-copy waiver's DECISION REVIEW DATE ${expectedBy} has passed ` +
        `(today is ${isoDay(nowMs)}). Nobody promised copy by it (T-049 § contract §1), so this ` +
        'is not "copy is late": it is the decision that was due — record a real ' +
        '`external_start` and re-anchor to start + the lead time, or re-anchor again with a ' +
        'stated reason. Until then every waived key is checked exactly as an unwaived one, ' +
        'below.',
    );
  }
  return { keys: new Set(keys), expectedBy, expired };
}

/* ------------------------------------------------- one (locale, key) pair */

const PROVENANCE_VALUES = ['authored', 'translated_professional', 'legal_review', 'placeholder'];

/**
 * The rule, one pair at a time. EACH CONJUNCT GETS ITS OWN NAMED REFUSAL and
 * its own case: "stale or absent" is two claims, and a compound claim with one
 * covering test is half-falsifiable (the note QA raised on T-042).
 */
function checkPair(
  root: string,
  locale: string,
  key: string,
  record: ReviewRecord | undefined,
  failures: string[],
): void {
  const where = `'${key}' in ${locale}`;
  const source = catalogueSource(locale, key, root);
  if (source === undefined) {
    failures.push(
      `NO-SOURCE ${where}: the catalogue has no string for this key, so its review record cannot ` +
        'be held against anything. gate:locale-completeness (T-042) names the same absence as ' +
        'MISSING; here it means currency is unjudgeable, which fails closed.',
    );
    return;
  }
  if (record === undefined) {
    failures.push(
      `MISSING-RECORD ${where}: review.json has no record. Absence must fail — a gate that ` +
        'passed on a deleted record could be satisfied by deleting records (T-040 § contract §6).',
    );
    return;
  }
  if (!isRecord(record)) {
    failures.push(`MALFORMED-RECORD ${where}: the review record is not an object.`);
    return;
  }
  const expected = contentHash(source);
  if (record.content_hash !== expected) {
    failures.push(
      `STALE-RECORD ${where}: the record's content_hash is ` +
        `${JSON.stringify(record.content_hash)} but the catalogue string now hashes to ` +
        `${expected}. The reviewed text and the shipped text are not the same text. Editing a ` +
        'safety string un-signs it; that is the mechanism, not a side effect.',
    );
  }
  if (record.status !== 'signed_off') {
    failures.push(
      `NOT-SIGNED-OFF ${where}: status is ${JSON.stringify(record.status)}. A safety_critical ` +
        'string ships only on a DSL sign-off (SA §TS-12.4).',
    );
  }
  if (record.provenance === 'placeholder') {
    failures.push(
      `PLACEHOLDER ${where}: provenance is "placeholder" — engineering copy written to exercise ` +
        'the mechanism, not reviewed safety copy. It must not ship.',
    );
  } else if (!PROVENANCE_VALUES.includes(record.provenance)) {
    failures.push(
      `MALFORMED-RECORD ${where}: provenance is ${JSON.stringify(record.provenance)}, not one of ` +
        `${PROVENANCE_VALUES.join(', ')}.`,
    );
  }
  if (record.reviewed_by === null || record.reviewed_by === undefined) {
    failures.push(
      `UNREVIEWED ${where}: reviewed_by is null. The record must name the human who signed it ` +
        'off — an MT engine cannot produce one, which is what makes DV-11 enforceable rather ' +
        'than intended.',
    );
  }
  if (typeof record.reviewed_at !== 'string' || !Number.isFinite(Date.parse(record.reviewed_at))) {
    failures.push(
      `UNDATED ${where}: reviewed_at is ${JSON.stringify(record.reviewed_at)}. A sign-off with ` +
        'no date cannot be held against the content it signed.',
    );
  }
}

/* ------------------------------------------------------------------- main */

async function main(argv: readonly string[]): Promise<void> {
  const { root, explicitRoot } = parseArgs(argv);
  const banner = explicitRoot
    ? `${GATE}  [--root ${root}: SOURCE READING ONLY — the compiled artefact and the pins were NOT read]`
    : GATE;
  const failures: string[] = [];
  const nowMs = Date.now();

  console.log(`${GATE}: reading ${root}`);

  const registry = loadRegistry(root, failures);
  const { keys: safetyKeys, tiered } = loadReviewTieredKeys(root, failures);
  if (registry === undefined) finish(banner, failures);

  const enabled = registry.enabled;
  const reviewTiers = (Object.keys(TIER_POLICY) as Tier[]).filter(
    (t) => TIER_POLICY[t].requiresSafetyReview,
  );

  console.log(`  today (UTC): ${isoDay(nowMs)}`);
  console.log(`  enabled locales (locale-registry.json): ${enabled.join(', ')}`);
  console.log(
    `  tiers needing a review record (TIER_POLICY.requiresSafetyReview): ${reviewTiers.join(', ')}`,
  );
  console.log(
    `  keys needing a review record (tiers.json): ${String(safetyKeys.length)} of ` +
      `${String(tiered)} tiered keys`,
  );

  // ------------------------------------------------------- V. anti-vacuity
  if (safetyKeys.length === 0) {
    failures.push(
      'NO-COMPARISON tiers.json assigns no key to a tier that requires a safety review record. ' +
        'This gate would examine nothing and exit 0 — the vacuous pass it exists to prevent.',
    );
  }
  if (enabled.length === 0) {
    failures.push(
      'NO-COMPARISON locale-registry.json enables no locale. There would be no (locale, key) ' +
        'pair to hold a review record against.',
    );
  }
  if (failures.length > 0) finish(banner, failures);

  // --------------------------------------------------------- the register
  let register;
  try {
    register = loadReviewRegister(root);
  } catch (err) {
    finish(banner, [
      ...failures,
      `INPUT review.json is unreadable or not a register — ${err instanceof Error ? err.message : String(err)}. ` +
        'Provenance is a BUILD INPUT (SD §Revision Log D8): an unreadable register is a failed ' +
        'build, never an empty one.',
    ]);
  }

  const waiver = readWaiver(register.pending_pipeline, safetyKeys, nowMs, failures);
  if (waiver === undefined) {
    console.log('  waiver: none in force — every record is checked in full');
  } else {
    console.log(
      `  waiver: pending_pipeline expires ${waiver.expectedBy} ` +
        `(${waiver.expired ? 'EXPIRED — it waives nothing' : 'in force'}), naming ` +
        `${String(waiver.keys.size)} key(s); anchor in this gate is ${WAIVER_NOT_AFTER}`,
    );
  }
  const waiverActive = waiver !== undefined && !waiver.expired;

  // ------------------------------------------ A. every key, in every locale
  let examined = 0;
  let waived = 0;
  let verified = 0;
  const verifiedPerLocale = new Map<string, number>();
  const waivedPerLocale = new Map<string, number>();

  for (const locale of enabled) {
    const perLocale: Readonly<Record<string, ReviewRecord>> | undefined = register.entries[locale];
    let localeVerified = 0;
    let localeWaived = 0;
    for (const key of safetyKeys) {
      examined += 1;
      const record = perLocale === undefined ? undefined : perLocale[key];
      if (waiverActive && waiver.keys.has(key)) {
        waived += 1;
        localeWaived += 1;
        // The waiver waives the CURRENCY OF A REVIEW, not the existence of a
        // provenance record. Without this, deleting all 24 records would be
        // green today, and "delete the thing being checked" is the first move
        // anyone makes against a gate. T-040 § contract §8 describes a waived
        // key as skipped entirely; this is narrower than the waiver it
        // describes, never wider, and a placeholder record satisfies it.
        if (record === undefined) {
          failures.push(
            `WAIVED-NO-RECORD '${key}' in ${locale}: the key is inside the T-049 waiver, but ` +
              'review.json has no record for it at all. The waiver waives the currency of a ' +
              'review, not the existence of the provenance row that the pipeline will fill.',
          );
        }
        continue;
      }
      checkPair(root, locale, key, record, failures);
      if (record !== undefined) {
        verified += 1;
        localeVerified += 1;
      }
    }
    verifiedPerLocale.set(locale, localeVerified);
    waivedPerLocale.set(locale, localeWaived);
  }

  for (const locale of enabled) {
    console.log(
      `  ${locale}: ${String(waivedPerLocale.get(locale) ?? 0)} waived, ` +
        `${String(verifiedPerLocale.get(locale) ?? 0)} held against a review record`,
    );
  }

  const expectedPairs = safetyKeys.length * enabled.length;
  console.log(
    `  examined ${String(examined)} (locale, key) pair(s) — ${String(safetyKeys.length)} key(s) ` +
      `x ${String(enabled.length)} enabled locale(s); ${String(waived)} waived, ` +
      `${String(verified)} with a record read`,
  );
  if (examined !== expectedPairs) {
    failures.push(
      `VACUOUS-RUN examined ${String(examined)} (locale, key) pair(s); ` +
        `${String(safetyKeys.length)} key(s) x ${String(enabled.length)} locale(s) is ` +
        `${String(expectedPairs)}. Some pair was never looked at.`,
    );
  }
  if (waived === examined && examined > 0) {
    // NOT a failure, and it is the honest state of this repository today. It is
    // PRINTED because a gate that is green while checking nothing must say so
    // (PROTOCOL §5.1) — and because the sentence names the date that ends it.
    console.log(
      `  NOTE: all ${String(examined)} pair(s) are waived and NONE had its review currency ` +
        `verified. This gate is green BECAUSE OF THE WAIVER, which expires ${String(
          waiver?.expectedBy,
        )}; from the day after, every one of them fails here.`,
    );
  }

  // -------------------------------------------------- B and C: the anchors
  if (explicitRoot) {
    console.log(
      '  READINGS B AND C NOT RUN: --root was given. The compiled artefact reachable from this ' +
        'script belongs to packages/i18n, and the pins are about that package. Reading A only.',
    );
    finish(banner, failures);
  }

  checkPins(safetyKeys, enabled, waiver, failures);
  await checkCompiled(safetyKeys, enabled, failures);
  finish(banner, failures);
}

/** READING C — the pins in this file against the source artefacts. */
function checkPins(
  safetyKeys: readonly string[],
  enabled: readonly string[],
  waiver: Waiver | undefined,
  failures: string[],
): void {
  for (const key of SAFETY_KEYS_PINNED) {
    if (!safetyKeys.includes(key)) {
      failures.push(
        `TIER-ESCAPE '${key}' was tiered safety_critical on 2026-09-20 and no longer needs a ` +
          'review record. Re-tiering a safety key is the cheapest way to make this gate check ' +
          'less, and after T-049 nothing else in the suite guards it (T-040 QA-F5). If the ' +
          'change is deliberate, edit SAFETY_KEYS_PINNED in this gate in the same commit.',
      );
    }
  }
  for (const locale of LOCALES_PINNED) {
    if (!enabled.includes(locale)) {
      failures.push(
        `LOCALE-DISABLED '${locale}' was an enabled locale on 2026-09-20 and is not one now. ` +
          'Disabling a locale removes every one of its review records from this gate at once. ' +
          'If it is deliberate, edit LOCALES_PINNED in this gate in the same commit.',
      );
    }
  }
  if (waiver !== undefined) {
    for (const key of waiver.keys) {
      if (!WAIVER_KEYS_CEILING.includes(key)) {
        failures.push(
          `WAIVER-EXTENDED the waiver names '${key}', which was not in it on 2026-09-20. A ` +
            'waiver opened in September for copy that was out at the external pipeline must not ' +
            'grow to cover copy written later (T-040 QA-F4). Removing keys is delivery and is ' +
            'free; adding one costs an edit here and an orchestrator decision (BOARD RK-2).',
        );
      }
    }
  }
}

/** READING B — the committed compiled artefact, which is what ships. */
async function checkCompiled(
  safetyKeys: readonly string[],
  enabled: readonly string[],
  failures: string[],
): Promise<void> {
  // Imported late and defensively: a broken `compiled/` must produce this
  // gate's own GATE FAIL banner, never an uncaught exception (PROTOCOL §5.1 —
  // "did nothing", "refused" and "crashed" are three distinguishable outcomes).
  let compiledSafety: readonly string[];
  let compiledEnabled: readonly string[];
  try {
    const mod = (await import('../src/index.ts')) as unknown as {
      keysAtTier: (t: string) => readonly string[];
      enabledLocales: () => readonly { code: string }[];
      TIER_POLICY: Readonly<Record<string, { requiresSafetyReview: boolean }>>;
    };
    const tiers = Object.keys(mod.TIER_POLICY).filter(
      (t) => mod.TIER_POLICY[t]?.requiresSafetyReview === true,
    );
    compiledSafety = tiers.flatMap((t) => [...mod.keysAtTier(t)]).sort();
    compiledEnabled = mod.enabledLocales().map((d) => d.code);
  } catch (err) {
    failures.push(
      `COMPILED-UNREADABLE the committed compiled artefact could not be loaded — ` +
        `${err instanceof Error ? err.message : String(err)}. Run ` +
        '`pnpm --filter @kinvara/i18n build` and commit `compiled/`.',
    );
    return;
  }

  const onlyInSource = safetyKeys.filter((k) => !compiledSafety.includes(k));
  const onlyInCompiled = compiledSafety.filter((k) => !safetyKeys.includes(k));
  if (onlyInSource.length > 0 || onlyInCompiled.length > 0) {
    failures.push(
      'TIER-DRIFT tiers.json and the committed compiled/tiers.ts disagree on which keys need a ' +
        `safety review record — only in tiers.json: [${onlyInSource.join(', ')}]; only in ` +
        `compiled/: [${onlyInCompiled.join(', ')}]. This gate read one of them and the product ` +
        'ships the other.',
    );
  }
  const drift =
    enabled.length !== compiledEnabled.length || enabled.some((c) => !compiledEnabled.includes(c));
  if (drift) {
    failures.push(
      `LOCALE-DRIFT locale-registry.json enables [${enabled.join(', ')}] but the committed ` +
        `compiled registry enables [${compiledEnabled.join(', ')}].`,
    );
  }
  console.log(
    `  compiled artefact: ${String(compiledSafety.length)} key(s) needing a review record, ` +
      `locales [${compiledEnabled.join(', ')}]`,
  );
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  // A crash is not a refusal. If this gate dies for a reason it did not
  // anticipate it still prints its own banner, so `gate:pr` and any harness
  // reading the output can tell the three outcomes apart (PROTOCOL §5.1).
  console.log(`\nGATE FAIL  ${GATE} — 1 problem(s):`);
  console.log(`  - CRASH ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
