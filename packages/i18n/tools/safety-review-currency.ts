/**
 * `gate:safety-review-currency` — T-044; T-258 (the OE-5 terminal state);
 * T-259 (the register flipped to it, the waiver retired, NOTE-NOT-TEXT).
 * SD §Revision Log D8, SA §TS-12.3, as departed from under EV-16 (extended by
 * stakeholder ruling OE-5, 2026-10-11) and OE-81.
 *
 * THE RULE SINCE T-258. For every `safety_critical` key K and every enabled
 * locale L, FAIL unless `entries[L][K]` exists AND
 * `content_hash === contentHash(source(L,K))` (STALE-RECORD) AND `provenance`
 * is `ai_authored` (PLACEHOLDER / NOT-AI-AUTHORED / MALFORMED-RECORD) AND
 * `ruling` is a ruling in `tools/rulings.ts` covering L (UNRULED-AUTHOR) AND
 * `authored_by` is exactly a model that ruling names (WRONG-AUTHOR) AND the
 * record claims no review — `status` is not `signed_off`, and no field whose
 * name contains "review" other than `review_ruling` is non-null, which
 * includes `reviewed_by` and `reviewed_at` (CLAIMS-REVIEW) AND it carries no
 * field outside the nine of `RECORD_FIELDS` (UNDEFINED-FIELD) AND its `note`,
 * if present, is a string or `null` (NOTE-NOT-TEXT; T-259) AND `status` is
 * `unreviewed_by_ruling` (NOT-FINAL) AND `review_ruling` is a ruling in
 * `REVIEW_DROPPED_RULINGS` covering L (UNRULED-NO-REVIEW) AND `content_hash`
 * equals `AUTHORED_CONTENT_PINNED[L][K]` in this file (UNPINNED-CONTENT).
 * If K is listed in an unexpired `pending_pipeline` waiver, the authorship and
 * finality conjuncts (PLACEHOLDER, NOT-AI-AUTHORED, UNRULED-AUTHOR,
 * WRONG-AUTHOR, NOT-FINAL, UNRULED-NO-REVIEW) are NOT checked. Everything else
 * still is: the record's existence (WAIVED-NO-RECORD), that it is an object
 * (MALFORMED-RECORD), CLAIMS-REVIEW, UNDEFINED-FIELD, NOTE-NOT-TEXT, and its
 * bytes (NO-SOURCE, STALE-RECORD, UNPINNED-CONTENT; T-258 rework 1). No waiver
 * is committed since T-259; one can be re-added, bounded as below. Inside a
 * waiver the VALUES of `authored_by`, `ruling`, `review_ruling` and of a
 * `status` other than `signed_off` are not judged here; `gate:unit-tests`
 * judges some of them.
 * This supersedes T-040 § contract §6's rule, which required `signed_off` and a
 * named reviewer: under OE-5 no human reviews this copy, so a review claim
 * is now the refusal, not the requirement. "A review claim" here means only
 * what CLAIMS-REVIEW, UNDEFINED-FIELD and NOTE-NOT-TEXT read: a `signed_off`
 * status, a non-null `review`-named field other than `review_ruling`, a field
 * outside the record's nine, or a `note` that is not a string or `null` (an
 * object, an array, a number, a boolean — so a sign-off cannot be nested in it;
 * T-259, OD-353). The TEXT of a string `note` is never read: a sentence saying
 * a review happened passes. A duplicated JSON key is judged by its last value.
 *
 * WHAT THIS GATE IS THE OTHER HALF OF. `gate:locale-completeness` (T-042)
 * proves a `safety_critical` string is PRESENT and RENDERABLE; it states in its
 * own contract §5 that a present, well-formed string that is WRONG passes it.
 * Provenance is this half: who wrote the string (a model, under a ruling this
 * gate reads), that nobody reviewed it (and that the record says so), and the
 * exact bytes accepted, bound twice — by the record's hash and by a pin in this
 * file. NOTHING HERE PROVES THE COPY IS RIGHT, OR THAT THE MODEL WROTE IT: an
 * edit that changes the catalogue, the record and the pin in one commit
 * passes, and review of the diff is the control for it.
 *
 * WHY IT IS GREEN, SAID OUT LOUD RATHER THAN DISCOVERED. Since T-259 all 24
 * committed records are `ai_authored` (T-233, OE-66/OE-67) and final with no
 * review under OE-5, and `pending_pipeline` is null. Every pair is checked in
 * full and accepted as AI-authored and REVIEWED BY NOBODY, and every run
 * prints that count, citing OE-5, so a green run never reads as "reviewed".
 * No date is in force: the T-040/T-049 waiver that turned this gate red on
 * 2026-12-06 is gone, because the human review it waited for was ruled out
 * (OE-5, 2026-10-11). Running this gate with the clock past 2026-12-05 is
 * green (`state/EP-0/T-259.md` § Evidence, NEG `T259-CLOCK-PAST-ANCHOR`).
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
 * still models the human roster T-260 removes. What T-258 takes from it is the
 * authorship rule alone, applied here against the same rulings literal
 * (`tools/rulings.ts`), which closes OD-258: this gate run alone now refuses an
 * AI record signed off by anyone, the model included. The one T-233 authorship
 * rule NOT applied here is "the model is not a named person in
 * `pipeline.roles`", because this gate does not read the roster.
 *
 * USAGE:  node packages/i18n/tools/safety-review-currency.ts [--root <dir>]
 *
 * `--root` points reading A at another package root (the Vitest cases build one
 * in a temporary directory). READINGS B AND C ARE THEN NOT RUN — the compiled
 * catalogue reachable from this script belongs to `packages/i18n` and not to
 * that root, and the key, locale and waiver pins are about THIS package's key
 * set — and the PASS/FAIL BANNER SAYS SO, so a `--root` run can never be pasted
 * as evidence of a full one. The rulings and `AUTHORED_CONTENT_PINNED` ARE
 * applied under `--root`: they are per-record checks inside reading A. The
 * committed `pnpm gate:safety-review-currency` passes no arguments.
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
import { AI_RULINGS, REVIEW_DROPPED_RULINGS } from './rulings.ts';

const GATE = 'gate:safety-review-currency';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------- pins */

/**
 * READING C. FOUR pins — SAFETY_KEYS_PINNED, WAIVER_KEYS_CEILING,
 * LOCALES_PINNED and WAIVER_NOT_AFTER — written in this file on 2026-09-20 by
 * T-044, because a gate whose expected workload is read entirely out of the
 * files it is checking can be silenced by editing those files (PROTOCOL §5.1).
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
 * register recorded: stakeholder decision OE-5, taken 2026-09-05 from T-049's
 * OD-15, moving 2026-10-17 -> 2026-12-05 because the original window was
 * exactly the lead time and so had zero slack on the day it opened.
 *
 * KEPT BY T-259, which set `pending_pipeline` to null (OE-5-cut §2 item 4):
 * with no waiver committed this pin bounds a waiver RE-ADDED later, so one
 * cannot outlive this day and cannot be renewed silently (NEG `WAIVER-RENEWED`,
 * a waiver re-added with `expected_by` 2027-01-01). `ANCHOR` in
 * `src/review.test.ts` and `DEADLINE` in `src/pipeline.test.ts`, which moved
 * with it until T-259, are deleted; this is the one anchor left.
 *
 * EARLIER IS ALLOWED, LATER IS NOT. Shortening a waiver cannot buy time, so an
 * `expected_by` before this day is not a finding; one after it is
 * WAIVER-RENEWED. Moving this line is an orchestrator decision, never a repair
 * for a red build.
 */
const WAIVER_NOT_AFTER = '2026-12-05';

/**
 * THE REPLACEMENT ANCHOR (T-258; `OE-5-cut.md` §2 item 4): the exact content
 * hash of every safety string accepted as AI-authored and final with no review
 * under OE-5, per (locale, key). A record whose `content_hash` is not the one
 * pinned here is UNPINNED-CONTENT, inside an unexpired waiver or not (rework 1).
 *
 * Why it exists. Before OE-5, editing a safety string un-signed it: its hash
 * moved, the record went STALE, and only a human re-signing it cleared that.
 * Under OE-5 nobody signs. Without this pin an edit plus a matching hash in
 * `review.json` — two files the same commit can change — would pass. With it,
 * the same edit fails here until THIS FILE is edited too, whether or not a
 * waiver covers the key. That includes today's waiver and one re-added on or
 * before 2026-12-05 (Vitest *UNPINNED-CONTENT — a safety string edited…*,
 * *UNPINNED-CONTENT (waived) — …*, *a waiver RE-ADDED after the flip…*). A new
 * `safety_critical` key has no pin, and an absent pin never matches (Vitest
 * *UNPINNED-CONTENT — a NEW safety_critical key…*). A newly enabled locale
 * takes the same branch; that is a reading of the code, not a case.
 *
 * THE BOUND, STATED PLAINLY. This makes a change VISIBLE. It does not PREVENT
 * one: a commit can edit the catalogue, the record and this pin together, and
 * review of the diff is the control for that. Nothing here can prove that the
 * named model wrote the bytes. SD Revision Log D8's "an MT engine cannot
 * produce a DSL review record" weakens to "a changed or new `safety_critical`
 * string in a pair this gate examines cannot pass it without an edit to this
 * pin"; that weakening is inherent in the ruling. Copy below the
 * `safety_critical` tier is not examined at all (Vitest *COUNTEREXAMPLE…*).
 *
 * Filled by T-258 with the 24 hashes the committed register carried at
 * `main` `f36b40f` — each equal to `contentHash()` of the committed catalogue
 * string, which `src/review.test.ts`'s currency test asserts. The cut (§3)
 * allowed T-258 to ship it empty or partial for T-259 to fill; measured, an
 * empty pin makes the cut's own CONTROL (every pair final and pinned, passing)
 * unsatisfiable. Since rework 1 it is consulted for waived pairs too, and the
 * committed tree stays green (all 24 pins equal an independently computed
 * NFC-sha256 of the committed strings: `state/EP-0/T-258.md` § Rework 1, R1).
 *
 * Not a reading-C pin: it is applied per record inside reading A, so it also
 * binds under `--root` (a temporary root copies this package's catalogues).
 */
const AUTHORED_CONTENT_PINNED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'safety.emergency.address_prompt':
      'sha256:ba7d12bfb51d44dac1e4d295ba6e1958c44b6b80941c227a51ffed00a2d66b21',
    'safety.emergency.call_112.label':
      'sha256:fb2d7ba42c38acfd95b6d8170d081365d13604fa225c9f39a49fe5628af1b44f',
    'safety.emergency.call_112.script':
      'sha256:b28ef2a488fa1ce5d1dc97f6442886547ea4069e4fa40164ab3309c522e2f33c',
    'safety.helpline.116111.label':
      'sha256:683a613367d2bf112d61d5776a61618650f7a7d40c76d4756f71f5952141ba1e',
    'safety.helpline.1466.label':
      'sha256:ae4b702322aa691073f7169cc9b7b06e5e65cfea71cc78c1c5ff96e262b50e0e',
    'safety.helpline.199.label':
      'sha256:0d689c6aeea19ecfc72bac1bf244498fb6cbbb7a366504af232e9e1d065b996b',
    'safety.sos.confirm': 'sha256:342b18f4e610094106850734e3c7fd55b4566898111ecb9a3f1bdd7bc1af3edd',
    'session.checkins_missed':
      'sha256:cb64809d098db9a1b0b90d6c2c01f7da08d198d792c16d352140067cbe9cad18',
  },
  el: {
    'safety.emergency.address_prompt':
      'sha256:f942969a2405b2bfb8babdec3410a29878bd58abb384e31b6b71f87beedf5b81',
    'safety.emergency.call_112.label':
      'sha256:f3282b692ee2e584ef76d44680ff46bba2ebe10609ba2114fca41993281c7274',
    'safety.emergency.call_112.script':
      'sha256:5f5e2816b748dd4fa2153bd83b1d002a955aaa4ec43aa3e26100df3d802978b6',
    'safety.helpline.116111.label':
      'sha256:53cc43738de3f2964cdc024cea407f64661bfcb667dff45508d6704e33f64c1a',
    'safety.helpline.1466.label':
      'sha256:24b478fe5386eadd4bd645649015f139ce75ba73335d28e36f3a84f8a834caae',
    'safety.helpline.199.label':
      'sha256:6ee8a81d63be2acfdf7af071193f4b775f2739ba5baf1f9b4e6f4e68f8f188c5',
    'safety.sos.confirm': 'sha256:e22d5b3d1dc081a86e6f5baef3e1b045e4c01d8d63c960ed49b950a1420fc1a9',
    'session.checkins_missed':
      'sha256:1d53ec4f326ee233f10ff28ffde8babf063d0943f2732f1140708342a8a9422b',
  },
  ru: {
    'safety.emergency.address_prompt':
      'sha256:cb176fd5b0d6c0c91e44e78eda43fce0ac61ac5e3503697d41e3a4b0d97a4c92',
    'safety.emergency.call_112.label':
      'sha256:0d062dc2df242b8f5ae30dd52098ff65629088ca629ba4beb49c679d4a0dddfb',
    'safety.emergency.call_112.script':
      'sha256:a0ec55a8f3862d981e70f1a4eb73e972b33846401e4f6680ee7ffc06dbbb4ff4',
    'safety.helpline.116111.label':
      'sha256:6d87f33e6832b1c1f198ef5f5f9c2b41fdeade3aa885fe4e618d7e6b525b68ac',
    'safety.helpline.1466.label':
      'sha256:646f7e01eca1a5dc8cdba7e98c293057f24692586da4ae621068a70353f836af',
    'safety.helpline.199.label':
      'sha256:04ecd049923efd888060927ea027a70ffc42c80156465b6b673959c05b33baee',
    'safety.sos.confirm': 'sha256:22039738873227fea69fa0f269799d9b17f1e51df1fed651b01940660ddead50',
    'session.checkins_missed':
      'sha256:cdf9119a8ba54fd4c14688649f1e4182ec6b9c0365dd5f9ceab726fe23e31589',
  },
};

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
        'is not "copy is late": it is the decision that was due — remove the waiver, or record ' +
        'a new decision (a date later than the anchor in this gate is WAIVER-RENEWED). Until ' +
        'then every waived key is checked exactly as an unwaived one, below.',
    );
  }
  return { keys: new Set(keys), expectedBy, expired };
}

/* ------------------------------------------------- one (locale, key) pair */

// T-233 added `ai_authored` (OE-66/OE-67, EV-16). Since T-258 it is the ONLY
// provenance accepted outside the waiver; the other three non-placeholder
// values are well-formed (never MALFORMED-RECORD) and refused as
// NOT-AI-AUTHORED, because since OE-5 no human authors or reviews this copy.
const PROVENANCE_VALUES = [
  'authored',
  'translated_professional',
  'legal_review',
  'placeholder',
  'ai_authored',
];

/** The terminal status T-258 adds: final, reviewed by nobody, by stakeholder ruling (`src/types.ts`). */
const FINAL_STATUS = 'unreviewed_by_ruling';

/**
 * CLAIMS-REVIEW, at ANY status and on waived records too (T-258; OE-5: nothing
 * may record or claim a human review). `status: "signed_off"` is a claim, and
 * so is any non-null field whose name contains "review" other than
 * `review_ruling`. Each is a claim on its own, so one is enough; all of them
 * are named on one line. Returns whether a claim was found.
 */
function claimsReview(
  where: string,
  record: Readonly<Record<string, unknown>>,
  failures: string[],
): boolean {
  const claims: string[] = [];
  if (record['status'] === 'signed_off') claims.push('status is "signed_off"');
  // `reviewed_by`, `reviewed_at` and ANY other field whose name contains
  // "review" (a `review_date`, a `reviewer`, …), the rule T-043 applies to the
  // prohibited-claim lists. `review_ruling` is the one exception: it names the
  // ruling that REMOVED review, which is the opposite of a claim.
  for (const [field, v] of Object.entries(record)) {
    if (!/review/iu.test(field) || field === 'review_ruling') continue;
    if (v !== null && v !== undefined) claims.push(`${field} is ${JSON.stringify(v)}`);
  }
  if (claims.length === 0) return false;
  failures.push(
    `CLAIMS-REVIEW ${where}: ${claims.join('; ')}. Since stakeholder ruling OE-5 (2026-10-11) no ` +
      'human reviews safety copy, and nothing may record or claim a review: `status` must never ' +
      'be "signed_off" and `reviewed_by`/`reviewed_at` must be null (EV-16).',
  );
  return true;
}

/**
 * THE RECORD'S CLOSED FIELD SET (T-258 rework 1, QA-F1): exactly the fields
 * `ReviewRecord` defines in `src/review.ts`. Any other field on a record is
 * UNDEFINED-FIELD, at any status and on waived records too, whatever its name
 * and even when it is null. CLAIMS-REVIEW reads field NAMES for "review", so
 * without this a sign-off in `signed_off_by`, `approved_by` or `dsl_signoff`
 * passed and was counted "reviewed by nobody" (QA A1-A4). A new field is an
 * edit to this list, in gate source, in the same commit.
 */
const RECORD_FIELDS: readonly string[] = [
  'content_hash',
  'provenance',
  'status',
  'authored_by',
  'ruling',
  'review_ruling',
  'reviewed_by',
  'reviewed_at',
  'note',
];

/** UNDEFINED-FIELD: one line per field outside RECORD_FIELDS. Returns whether any was found. */
function undefinedFields(
  where: string,
  record: Readonly<Record<string, unknown>>,
  failures: string[],
): boolean {
  let found = false;
  for (const [field, v] of Object.entries(record)) {
    if (RECORD_FIELDS.includes(field)) continue;
    found = true;
    failures.push(
      `UNDEFINED-FIELD ${where}: ${field} is ${v === undefined ? 'undefined' : JSON.stringify(v)}, ` +
        `and ${JSON.stringify(field)} is not a field of a review record ` +
        `(${RECORD_FIELDS.join(', ')}). The field set is closed so that a sign-off, an approval or a ` +
        'review cannot be recorded under a field name outside it (OE-5: nothing may record or claim one). ' +
        'This check reads field names, not the value of a defined field (NOTE-NOT-TEXT reads the JSON type of note, not its text). Adding a field is an edit to RECORD_FIELDS in this gate.',
    );
  }
  return found;
}

/**
 * NOTE-NOT-TEXT (T-259, OD-353; T-258 QA D-NEST1/2/8, R2-NOTE-NUM/BOOL): `note`
 * is prose or nothing. A `note` that is present and is neither a string nor
 * `null` — an object, an array, a number, a boolean — is refused, at any
 * status and on waived records too. Without this a sign-off nested in it
 * (`note: {"signed_off_by": …}`) passed the flipped register and was counted
 * "reviewed by nobody". An absent `note` is accepted (the field is optional).
 * What this does NOT read: the TEXT of a string `note`. A sentence saying a
 * review happened is still not refused here; review of the diff is the control
 * for prose. Returns whether it refused.
 */
function noteNotText(
  where: string,
  record: Readonly<Record<string, unknown>>,
  failures: string[],
): boolean {
  if (!Object.hasOwn(record, 'note')) return false;
  const v = record['note'];
  if (typeof v === 'string' || v === null) return false;
  const kind = Array.isArray(v)
    ? 'an array'
    : typeof v === 'object'
      ? 'an object'
      : `a ${typeof v}`;
  failures.push(
    `NOTE-NOT-TEXT ${where}: note is ${v === undefined ? 'undefined' : JSON.stringify(v)} (${kind}), ` +
      'not a string or null. A note is prose or nothing, so that a sign-off, an approval or a ' +
      'review cannot be recorded as structured data inside it (OE-5: nothing may record or ' +
      'claim one). This check reads the JSON type of note, not its text.',
  );
  return true;
}

/**
 * The content checks, shared by a pair outside the waiver and a WAIVED pair
 * (T-258 rework 1, QA-F2: the waiver waives finality, not the bytes). NO-SOURCE
 * returns false and the caller stops; otherwise STALE-RECORD and
 * UNPINNED-CONTENT are each judged.
 */
function noSource(where: string, failures: string[]): void {
  failures.push(
    `NO-SOURCE ${where}: the catalogue has no string for this key, so its review record cannot ` +
      'be held against anything. gate:locale-completeness (T-042) names the same absence as ' +
      'MISSING; here it means currency is unjudgeable, which fails closed.',
  );
}

function staleRecord(
  where: string,
  record: ReviewRecord,
  source: string,
  failures: string[],
): void {
  const expected = contentHash(source);
  if (record.content_hash !== expected) {
    failures.push(
      `STALE-RECORD ${where}: the record's content_hash is ` +
        `${JSON.stringify(record.content_hash)} but the catalogue string now hashes to ` +
        `${expected}. The recorded text and the shipped text are not the same text.`,
    );
  }
}

function unpinnedContent(
  where: string,
  locale: string,
  key: string,
  record: ReviewRecord,
  failures: string[],
): void {
  const pinned = AUTHORED_CONTENT_PINNED[locale]?.[key];
  if (record.content_hash !== pinned) {
    failures.push(
      `UNPINNED-CONTENT ${where}: content_hash ${JSON.stringify(record.content_hash)} is not the ` +
        `hash pinned for it in AUTHORED_CONTENT_PINNED (${pinned === undefined ? 'none pinned' : pinned}) in ` +
        'tools/safety-review-currency.ts. Under OE-5 nobody re-signs an edited safety string, so ' +
        'an edit is accepted only when the same commit edits that pin — a change to gate source ' +
        'that review of the diff can see.',
    );
  }
}

/**
 * The authorship half (T-233 § contract §1, read by the GATE since T-258 —
 * OD-258). `ruling` must be a ruling in `tools/rulings.ts` that covers this
 * locale, and `authored_by` must be exactly a model that ruling names: raw
 * string comparison, no normalisation, so case, spacing, zero-width and
 * look-alike variants are all refused.
 */
function checkAuthorship(
  where: string,
  locale: string,
  record: ReviewRecord,
  failures: string[],
): void {
  const ruling = AI_RULINGS.find((r) => r.id === record.ruling);
  if (typeof record.ruling !== 'string') {
    failures.push(
      `UNRULED-AUTHOR ${where}: provenance "ai_authored" with no \`ruling\`. A model may be ` +
        'recorded as the author only under a stakeholder ruling that makes it one (known: ' +
        `${AI_RULINGS.map((r) => r.id).join(', ') || 'none'}).`,
    );
  } else if (ruling === undefined) {
    failures.push(
      `UNRULED-AUTHOR ${where}: cites ${JSON.stringify(record.ruling)}, which is not a ` +
        'stakeholder ruling that makes a model an author (known: ' +
        `${AI_RULINGS.map((r) => r.id).join(', ') || 'none'}).`,
    );
  } else if (!ruling.locales.includes(locale)) {
    failures.push(
      `UNRULED-AUTHOR ${where}: cites ${ruling.id}, which makes a model the author of ` +
        `${ruling.locales.join('/')} copy, not ${locale}.`,
    );
  } else if (record.authored_by === null || !ruling.authors.includes(record.authored_by)) {
    failures.push(
      `WRONG-AUTHOR ${where}: authored_by is ${JSON.stringify(record.authored_by)}, not the model ` +
        `${ruling.id} names (${ruling.authors.map((a) => JSON.stringify(a)).join('; ')}), ` +
        'character for character. Record the model truthfully — never a human name, never ' +
        'another engine or version.',
    );
  }
}

/**
 * The rule, one pair at a time, for a pair OUTSIDE the waiver. EACH CONJUNCT
 * GETS ITS OWN NAMED REFUSAL and its own case: a compound claim with one
 * covering test is half-falsifiable (the note QA raised on T-042).
 *
 * Since T-258 (OE-5, OE-81) the record is ACCEPTED only when it is current,
 * AI-authored under a ruling the gate reads, claims no review, carries no
 * field outside RECORD_FIELDS, is final with no review under a ruling the gate
 * reads, and carries the pinned hash. Returns
 * whether it was accepted — the number the OE-5 line prints.
 */
function checkPair(
  root: string,
  locale: string,
  key: string,
  record: ReviewRecord | undefined,
  failures: string[],
): boolean {
  const where = `'${key}' in ${locale}`;
  const before = failures.length;
  const source = catalogueSource(locale, key, root);
  if (source === undefined) {
    noSource(where, failures);
    return false;
  }
  if (record === undefined) {
    failures.push(
      `MISSING-RECORD ${where}: review.json has no record. Absence must fail — a gate that ` +
        'passed on a deleted record could be satisfied by deleting records (T-040 § contract §6).',
    );
    return false;
  }
  if (!isRecord(record)) {
    failures.push(`MALFORMED-RECORD ${where}: the review record is not an object.`);
    return false;
  }
  staleRecord(where, record, source, failures);

  // Who wrote it.
  if (record.provenance === 'placeholder') {
    failures.push(
      `PLACEHOLDER ${where}: provenance is "placeholder" — engineering copy written to exercise ` +
        'the mechanism, not authored safety copy. It must not ship.',
    );
  } else if (!PROVENANCE_VALUES.includes(record.provenance)) {
    failures.push(
      `MALFORMED-RECORD ${where}: provenance is ${JSON.stringify(record.provenance)}, not one of ` +
        `${PROVENANCE_VALUES.join(', ')}.`,
    );
  } else if (record.provenance !== 'ai_authored') {
    failures.push(
      `NOT-AI-AUTHORED ${where}: provenance is ${JSON.stringify(record.provenance)}. Since ` +
        'stakeholder ruling OE-5 safety copy is AI-authored under a ruling (OE-66/OE-67, EV-16) ' +
        'and no human authors or reviews it, so only "ai_authored" is accepted.',
    );
  } else {
    checkAuthorship(where, locale, record, failures);
  }

  // Whether it claims a review it cannot have had.
  claimsReview(where, record as unknown as Record<string, unknown>, failures);
  // Whether it carries any field a record does not have (rework 1, QA-F1).
  undefinedFields(where, record as unknown as Record<string, unknown>, failures);
  // Whether its note is anything but prose or nothing (T-259, OD-353).
  noteNotText(where, record as unknown as Record<string, unknown>, failures);

  // Whether it is final, by a ruling the gate reads.
  if (record.status !== FINAL_STATUS) {
    failures.push(
      `NOT-FINAL ${where}: status is ${JSON.stringify(record.status)}, not "${FINAL_STATUS}". ` +
        'Outside the waiver a safety_critical record ships only as final with no review, under ' +
        'the stakeholder ruling that removed review (OE-5; OE-81: releasable).',
    );
  }
  const dropped = REVIEW_DROPPED_RULINGS.find((r) => r.id === record.review_ruling);
  if (dropped === undefined || !dropped.locales.includes(locale)) {
    const cited =
      record.review_ruling === undefined ? 'undefined' : JSON.stringify(record.review_ruling);
    failures.push(
      `UNRULED-NO-REVIEW ${where}: review_ruling is ${cited}, which is not a stakeholder ruling ` +
        `that removes review of ${locale} safety copy (known: ` +
        `${REVIEW_DROPPED_RULINGS.map((r) => `${r.id} [${r.locales.join(', ')}]`).join(', ') || 'none'}). ` +
        'A record final with no review must say which ruling made it so.',
    );
  }

  // Whether the bytes are the ones accepted, pinned outside the register.
  unpinnedContent(where, locale, key, record, failures);
  return failures.length === before;
}

/* ------------------------------------------------------------------- main */

async function main(argv: readonly string[]): Promise<void> {
  const { root, explicitRoot } = parseArgs(argv);
  const banner = explicitRoot
    ? `${GATE}  [--root ${root}: SOURCE READING ONLY — the compiled artefact and the key, locale and waiver pins were NOT read]`
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
  let accepted = 0;
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
        } else if (!isRecord(record)) {
          failures.push(
            `MALFORMED-RECORD '${key}' in ${locale} (waived): the review record is not an object.`,
          );
        } else {
          const where = `'${key}' in ${locale} (waived)`;
          // T-258: the waiver never covers a CLAIM of review. OE-5 forbids one
          // at any status, so the honesty property holds before T-259 too.
          claimsReview(where, record, failures);
          // Rework 1 (QA-F1): nor a field outside the record's closed set.
          undefinedFields(where, record, failures);
          // T-259 (OD-353): nor a note that is not text.
          noteNotText(where, record, failures);
          // Rework 1 (QA-F2): nor the BYTES. The waiver waives finality — the
          // status, the review ruling and the authorship — not currency or the
          // pin, so a catalogue edit plus a re-hashed record under a waiver
          // (today's, or one re-added later) still needs an edit to the pin.
          const source = catalogueSource(locale, key, root);
          if (source === undefined) {
            noSource(where, failures);
          } else {
            staleRecord(where, record, source, failures);
            unpinnedContent(where, locale, key, record, failures);
          }
        }
        continue;
      }
      if (checkPair(root, locale, key, record, failures)) accepted += 1;
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
  // T-258, OE-5-cut §2 item 5: EVERY run says how many pairs it passed as
  // AI-authored and reviewed by nobody, so a green gate never reads as
  // "reviewed".
  console.log(
    `  OE-5: ${String(accepted)} of ${String(examined)} pair(s) accepted as AI-authored and ` +
      'reviewed by nobody — final by stakeholder ruling OE-5 (2026-10-11), not by any review; ' +
      `${String(waived)} waived`,
  );
  if (waived === examined && examined > 0) {
    // NOT a failure; it was the state of this repository until T-259, and is
    // the state under any waiver re-added over every key. It is PRINTED because a gate that is green while checking almost nothing
    // must say so (PROTOCOL §5.1) — and because the sentence names the date
    // that ends it.
    console.log(
      `  NOTE: all ${String(examined)} pair(s) are waived: each was checked only for a record, ` +
        'for claiming no review (CLAIMS-REVIEW), for fields outside the record set ' +
        '(UNDEFINED-FIELD) and for its bytes (NO-SOURCE, STALE-RECORD, UNPINNED-CONTENT), and ' +
        'NONE was checked for authorship or as final under OE-5. ' +
        `This gate is green BECAUSE OF THE WAIVER, which expires ${String(
          waiver?.expectedBy,
        )}; from the day after, every one of them fails here unless it is final under OE-5.`,
    );
  }

  // -------------------------------------------------- B and C: the anchors
  if (explicitRoot) {
    console.log(
      '  READINGS B AND C NOT RUN: --root was given. The compiled artefact reachable from this ' +
        'script belongs to packages/i18n, and the key, locale and waiver pins are about that ' +
        'package. Reading A only — which still applies the rulings and AUTHORED_CONTENT_PINNED ' +
        'to every record.',
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
