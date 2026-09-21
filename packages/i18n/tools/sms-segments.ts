/**
 * `gate:sms-segments` — T-046. PM §MVP-N1 AC3 and AC5, SA §TS-12, SA §C7.
 *
 * THE RULE: every Critical/Transactional SMS template is at most TWO SEGMENTS
 * in every enabled locale, measured at a declared worst-case substitution.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS GATE HAD TO SOLVE FIRST, stated because it is the whole
 * design and not a preamble.
 *
 * "Every Critical/Transactional SMS template" denoted A SET NOBODY HAD DEFINED.
 * `tiers.json` carries 14 strict-tier keys; not one of them was marked as an
 * SMS template, and at `main` 9dd95f8 there was no `sms` file and no `sms` key
 * anywhere in the repository. The obvious gate — iterate the SMS templates,
 * count segments — would therefore have been VACUOUSLY GREEN because it
 * iterated nothing, which is this build's worst failure mode (PROTOCOL §5.1,
 * and the attack both T-042 and T-044 were put through).
 *
 * The answer is `packages/i18n/channels.json`: the delivery-channel
 * declaration, exact and exhaustive over the strict tiers exactly as
 * `tiers.json` is over the catalogue, with `sms: true | false` and a non-empty
 * `why` per key and NO THIRD VALUE. A key nobody has decided about is a gate
 * failure (CHANNEL-UNDECLARED), not a shrug. The corpus is then DECLARED and
 * falsifiable rather than inferred, and it is cross-checked against a file this
 * gate does not own — see READING D.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ARITHMETIC, and why the obvious numbers are wrong. It lives in
 * `tools/sms-encoding.ts` — a pure module with no side effects — because THIS
 * file ends in an unconditional top-level `await main(...)`, exactly as
 * `T-042`'s and `T-044`'s gates do, so that `node tools/sms-segments.ts` cannot
 * be made to exit 0 having run nothing. The test file imports the arithmetic
 * from there and runs THIS file as a subprocess.
 *
 * PM §MVP-N1 AC3(c) says "70 characters per segment instead of 160". Those are
 * the SINGLE-segment figures. A CONCATENATED segment carries a 6-octet User
 * Data Header, so:
 *
 *      GSM-7   160 septets single,  153 per segment when concatenated
 *      UCS-2    70 units   single,   67 per segment when concatenated
 *                          (6 octets = 48 bits = 7 septets = 3 UTF-16 units)
 *
 * So "<= 2 segments" is <= 306 SEPTETS (GSM-7) or <= 134 UTF-16 CODE UNITS
 * (UCS-2) — NOT 320 and NOT 140. A gate that used 70 and 160 would be wrong in
 * the direction that LETS A THREE-SEGMENT MESSAGE THROUGH: 140 UCS-2 units is
 * three segments, and the naive reading calls it two. Measured, both ways, in
 * `tools/sms-segments.test.ts`.
 *
 * FOUR MORE PLACES THE OBVIOUS ANSWER IS WRONG, each measured rather than
 * assumed:
 *
 *  1. "`el`/`ru` are UCS-2" IS AN ASSUMPTION. Ten Greek capitals — Δ Φ Γ Λ Ω Π
 *     Ψ Σ Θ Ξ — are IN the GSM-7 basic alphabet, so a Greek string can encode
 *     as GSM-7 and get the 153-septet budget. The other Greek capitals (Α Β Ε
 *     Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ) are NOT: GSM-7 carries only their Latin
 *     look-alikes. This gate therefore MEASURES the encoding of each rendered
 *     string and never infers it from the locale. The locale-based rule is not
 *     merely imprecise, it is wrong in the strict direction: a 200-character
 *     all-Greek-capital string is 2 segments measured and 3 segments assumed,
 *     so the assumption REJECTS VALID COPY. Both readings are in the cases.
 *
 *  2. UCS-2 COUNTS UTF-16 CODE UNITS, NOT CODE POINTS. Anything outside the BMP
 *     costs two. This gate counts `String.prototype.length` and PRINTS the
 *     number of surrogate pairs it saw, so "there are none in this corpus" is a
 *     measurement on every run and not a belief.
 *
 *  3. AN ICU TEMPLATE HAS NO SINGLE LENGTH. `session.checkins_missed` is a
 *     plural with a parameterised name, and `ru` has four CLDR categories. What
 *     is measured is stated in § the worst case below and is DECLARED IN
 *     COMMITTED DATA, so the claim carries its bound.
 *
 *  4. AND A PLURAL'S BRANCHES ARE NOT ITS CLDR CATEGORIES. ICU matches an
 *     EXPLICIT `=0` / `=1` branch BEFORE any category rule, applies `offset:`
 *     before selecting one, and `selectordinal` uses the ORDINAL category set.
 *     A candidate set built from the registry's category list alone leaves
 *     whole branches unbound — T-046's rework-1 finding (QA-F1): a Greek
 *     template with a long `=0` branch compiled, shipped and sent THREE
 *     SEGMENTS while this gate printed `1 segment(s), headroom 69` and exited
 *     0.
 *
 *  5. AND A PARAMETER'S BRANCHES ARE NOT ONE ELEMENT'S BRANCHES. This line
 *     said, at c140093, that candidates come from "the LAST such element per
 *     parameter, so an explicit `=N` in an EARLIER element is still unmeasured
 *     (T-176 owns it)". THAT GAP IS CLOSED. A message is read as a list of
 *     BRANCHING SITES and a parameter's candidate set is one value per BRANCH
 *     SIGNATURE across all of its sites — for `select` as well as `plural`, and
 *     a `select` worst case declared in `channels.json` is now honoured. See
 *     § the worst case below, which also states what the model still assumes
 *     and — the part that matters — how it is checked against ICU rather than
 *     against itself.
 *     ("THREE MORE PLACES" above is now five.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIVE READINGS, FROM ARTEFACTS THAT ARE NOT EACH OTHER (PROTOCOL §5.1: "a
 * check must not be derived from the same reading as the thing it checks").
 *
 *   A1 THE FLOOR — every strict-tier key x every enabled locale: the COMMITTED
 *      SOURCE STRING is measured and printed, placeholders unexpanded. This is
 *      not an SMS bound and the output says so on every line; it is what makes
 *      a run that examined nothing impossible to mistake for a pass. If the
 *      pair count is not `strict keys x enabled locales`, VACUOUS-RUN.
 *
 *   A2 THE ASSERTION — the SMS corpus (keys declared `sms: true`) x every
 *      enabled locale, RENDERED at the declared worst case with the real
 *      `intl-messageformat` evaluator, refused above 2 segments (OVER-BUDGET).
 *
 *   B  THE COMMITTED COMPILED ARTEFACT — the same worst case rendered through
 *      `CATALOGUES[locale][key]`, which is what SHIPS, and required to be
 *      BYTE-IDENTICAL to the source render (COMPILED-DRIFT); plus the strict
 *      key set and the enabled locale set (TIER-DRIFT, LOCALE-DRIFT).
 *
 *   C  THE PINS IN THIS FILE — the strict key set, the locale set, the SMS
 *      corpus AND THE DECLARED WORST CASE as they stood on 2026-09-21 (four
 *      pins, not three), written HERE, in source that
 *      `channels.json` and `tiers.json` cannot edit. They are the answer to "if
 *      it checked nothing, would it say so?", because every cheap way to make
 *      this gate assert less is an edit to a file the pins do not live in:
 *        - flip `session.checkins_missed` to `sms: false`  -> SMS-ESCAPE
 *        - re-tier it out of `safety_critical`             -> STRICT-ESCAPE
 *        - disable `el` in the registry                    -> LOCALE-DISABLED
 *        - empty `channels.json`'s sms set entirely        -> NO-SMS-CORPUS
 *        - narrow the declared worst case it is measured at -> WORST-CASE-NARROWED
 *
 *   D  `review.json` § `pipeline.assignments[<key>].channel` (T-049) — a file
 *      this gate does not own and this ticket did not write. ONE DIRECTION
 *      ONLY: a DETERMINED, non-deliverable copy-review channel (`screen`,
 *      `spoken_by_user`, `voice`) means the key cannot be an SMS body, so
 *      `channels.json` must say `sms: false` (CHANNEL-CONTRADICTION). A channel
 *      of `undetermined` constrains nothing, and the run says so rather than
 *      letting silence read as agreement.
 *
 * USAGE:  node packages/i18n/tools/sms-segments.ts [--root <dir>]
 *
 * `--root` points readings A, C and D at another package root (the
 * Vitest cases build one in a temporary directory). READING B IS THEN NOT RUN —
 * the compiled catalogue reachable from this script belongs to `packages/i18n`
 * and not to that root — AND THE BANNER SAYS SO on both the pass and the fail
 * path, so a `--root` run can never be pasted as evidence of a full one. The
 * committed `pnpm gate:sms-segments` passes no arguments. Any other argument
 * exits 2, before any reading, with no banner.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { IntlMessageFormat } from 'intl-messageformat';
import { catalogueSource } from '../src/review.ts';
import { TIER_POLICY } from '../src/tiers.ts';
import type { Tier } from '../src/types.ts';
import { CAPACITY, MAX_SEGMENTS, budgetFor, measure } from './sms-encoding.ts';
import type { Measurement } from './sms-encoding.ts';

const GATE = 'gate:sms-segments';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ----------------------------------------------------------------- output */

/** Everything to STDOUT, banner included, so a piped paste keeps its order (T-042, T-044). */
function finish(banner: string, failures: readonly string[]): never {
  if (failures.length === 0) {
    console.log(`\nGATE PASS  ${banner}`);
    process.exit(0);
  }
  console.log(`\nGATE FAIL  ${banner} — ${String(failures.length)} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

/* ------------------------------------------------------------------- pins */

/**
 * READING C. FOUR pins, written in this file on 2026-09-21 by T-046, because a
 * gate whose expected workload is read entirely out of the files it is checking
 * can be silenced by editing those files (PROTOCOL §5.1). Each is checked in
 * ONE direction — "each of these must STILL be there" — so GROWING the corpus,
 * the key set or the locale set needs no edit here, and SHRINKING it costs a
 * conspicuous edit to this file in the same commit.
 */

/** Every key declared `sms: true` in `channels.json` on 2026-09-21. */
const SMS_KEYS_PINNED: readonly string[] = ['session.checkins_missed'];

/** Every key tiered `safety_critical` or `transactional` on 2026-09-21 — the floor's workload. */
const STRICT_KEYS_PINNED: readonly string[] = [
  'booking.cancel.fee_notice',
  'booking.count.upcoming',
  'common.dossier.verified',
  'common.fallback.not_translated',
  'legal.terms.accept',
  'safety.emergency.address_prompt',
  'safety.emergency.call_112.label',
  'safety.emergency.call_112.script',
  'safety.helpline.116111.label',
  'safety.helpline.1466.label',
  'safety.helpline.199.label',
  'safety.sos.confirm',
  'session.checkins_missed',
  'session.staffed_hours.commitment',
];

/** Every locale enabled on 2026-09-21. */
const LOCALES_PINNED: readonly string[] = ['en', 'el', 'ru'];

/**
 * THE DECLARED BOUND ITSELF, pinned — because the cheapest remaining way to
 * make this gate assert LESS is not to remove a template, it is to NARROW the
 * worst case it is measured at. Dropping `count`'s `max` to 9 and deleting two
 * of the three declared names leaves the corpus intact, the pair count intact
 * and the gate green over a much weaker claim.
 *
 * Checked in ONE direction, like every other pin: each entry must still be AT
 * LEAST this wide. Widening a bound is free; narrowing one costs an edit here
 * in the same commit. `text` pins the length of the LONGEST declared value,
 * not the number of them, because three one-character names would satisfy a
 * count and measure nothing.
 *
 * BOUND, DECLARED HERE AS WELL AS IN § contract §5 BECAUSE THIS IS WHERE THE
 * PIN LIVES: it pins LENGTH, NOT SCRIPT. Swapping the declared Greek name for a
 * 38-character LATIN one keeps this floor satisfied and keeps the gate green,
 * while quietly retiring the cross-script measurement — `en` would become GSM-7
 * with ~240 units of headroom, and "an English SMS naming a Greek sitter is
 * UCS-2" would stop being measured by anything. The same warning is in
 * channels.json beside the declared names, which is where that edit is made.
 */
const WORST_CASE_FLOOR: Readonly<
  Record<
    string,
    {
      readonly plural?: Readonly<Record<string, number>>;
      readonly text?: Readonly<Record<string, number>>;
    }
  >
> = {
  'session.checkins_missed': { plural: { count: 999 }, text: { sitterName: 35 } },
};

/**
 * READING D's one-directional rule, as data. A copy-review channel in
 * `review.json` § pipeline that is DETERMINED and names a surface the user
 * looks at or speaks from cannot also be the body of an outbound message.
 * `undetermined` is deliberately absent: it constrains nothing.
 */
const PIPELINE_CHANNELS_THAT_FORBID_SMS: readonly string[] = ['screen', 'spoken_by_user', 'voice'];

/**
 * The cartesian product of declared worst-case substitutions is bounded, so the
 * gate can never silently SAMPLE a corner of it. Exceeding this is a refusal,
 * not a truncation.
 */
const MAX_SUBSTITUTIONS_PER_PAIR = 4096;

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
  readonly enabled: readonly string[];
  readonly pluralCategories: ReadonlyMap<string, readonly string[]>;
}

/**
 * The locale set and each locale's CLDR categories come from
 * `locale-registry.json`, NOT from `readdirSync('catalogues/')` and NOT from a
 * list in this gate — the same anti-vacuity choice T-042 § contract §3 makes,
 * for the same reason: deleting a catalogue directory must not make the gate
 * examine fewer locales. `pluralCategories` is read here (rather than through
 * `pluralCategories()`, which reads `compiled/`) so that reading A stands on
 * the source artefact alone and `--root` remains meaningful.
 */
function loadRegistry(root: string, failures: string[]): Registry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'locale-registry.json'), 'utf8')) as unknown;
  } catch (err) {
    failures.push(`INPUT locale-registry.json is unreadable or not JSON — ${String(err)}`);
    return undefined;
  }
  if (!isRecord(raw) || !Array.isArray(raw['locales'])) {
    failures.push('INPUT locale-registry.json needs a `locales` array');
    return undefined;
  }
  const enabled: string[] = [];
  const cats = new Map<string, readonly string[]>();
  for (const row of raw['locales']) {
    if (!isRecord(row)) continue;
    const code = row['code'];
    if (typeof code !== 'string' || row['enabled'] !== true) continue;
    enabled.push(code);
    const declared = row['pluralCategories'];
    if (!Array.isArray(declared) || declared.some((c) => typeof c !== 'string')) {
      failures.push(
        `INPUT locale-registry.json: '${code}' has no \`pluralCategories\` array. The worst case ` +
          'over a plural message is computed per declared BRANCH, and this list is what says which ' +
          'category branches the message must declare (PLURAL-COVERAGE); without it there is no ' +
          'worst case to compute and the assertion would quietly cover fewer branches.',
      );
      continue;
    }
    cats.set(code, declared as string[]);
  }
  return { enabled, pluralCategories: cats };
}

/**
 * The strict-tier key set, DERIVED from `tiers.json` filtered by
 * `TIER_POLICY[tier].onMissingTranslation === 'build_failure'` — never the
 * literal `'safety_critical'`. `src/tiers.ts` is the one place the four tiers'
 * behaviour is stated (T-040 § contract §2), so a fifth strict tier would be
 * covered here with no edit.
 */
function loadStrictKeys(
  root: string,
  failures: string[],
): { keys: readonly string[]; all: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'tiers.json'), 'utf8')) as unknown;
  } catch (err) {
    failures.push(`INPUT tiers.json is unreadable or not JSON — ${String(err)}`);
    return { keys: [], all: 0 };
  }
  const tiers = isRecord(raw) ? raw['tiers'] : undefined;
  if (!isRecord(tiers)) {
    failures.push('INPUT tiers.json needs a `tiers` object mapping fully-qualified key -> tier');
    return { keys: [], all: 0 };
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
    if (TIER_POLICY[value as Tier].onMissingTranslation === 'build_failure') keys.push(key);
  }
  return { keys: keys.sort(), all: Object.keys(tiers).length };
}

/* ----------------------------------------------------- the channel declaration */

interface PluralParam {
  readonly kind: 'plural';
  readonly max: number;
}
interface TextParam {
  readonly kind: 'text';
  readonly values: readonly string[];
}
type DeclaredParam = PluralParam | TextParam;

interface ChannelEntry {
  readonly sms: boolean;
  readonly worstCase: ReadonlyMap<string, DeclaredParam>;
}

/**
 * `channels.json`, validated hard. EXACT AND EXHAUSTIVE over the strict-tier
 * key set in both directions — an undeclared strict key is CHANNEL-UNDECLARED
 * and a declared non-strict key is CHANNEL-SURPLUS — because the whole value of
 * this file is that it is the definition of a set, and a definition with a hole
 * in it defines nothing.
 */
function loadChannels(
  root: string,
  strictKeys: readonly string[],
  failures: string[],
): ReadonlyMap<string, ChannelEntry> {
  const out = new Map<string, ChannelEntry>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8')) as unknown;
  } catch (err) {
    // FAIL CLOSED on the absent path, exactly as T-040 § contract §8 requires
    // of `gate:prohibited-claims`: a missing declaration must be a gate failure
    // and never zero findings, or the gate is green precisely while it is
    // checking nothing.
    failures.push(
      `INPUT channels.json is absent, unreadable or not JSON — ${String(err)}. This file IS the ` +
        'SMS corpus; without it there is no set to assert over, and a run that found no ' +
        'templates because it could not read the list of them is the vacuous pass this gate ' +
        'exists to prevent.',
    );
    return out;
  }
  const channels = isRecord(raw) ? raw['channels'] : undefined;
  if (!isRecord(channels)) {
    failures.push(
      'INPUT channels.json needs a `channels` object mapping fully-qualified key -> entry',
    );
    return out;
  }
  for (const [key, value] of Object.entries(channels)) {
    if (!isRecord(value)) {
      failures.push(`INPUT channels.json: '${key}' is not an object`);
      continue;
    }
    if (typeof value['sms'] !== 'boolean') {
      failures.push(
        `CHANNEL-UNDECLARED '${key}' has \`sms\` = ${JSON.stringify(value['sms'])}. It must be ` +
          'true or false. There is deliberately no third value and no default: a key nobody has ' +
          'decided about must stop the build, because the alternative is a template that is ' +
          'never length-audited and never noticed.',
      );
      continue;
    }
    if (typeof value['why'] !== 'string' || value['why'].trim() === '') {
      failures.push(
        `CHANNEL-UNREASONED '${key}' declares \`sms: ${String(value['sms'])}\` with no \`why\`. ` +
          'The declaration is a design decision; an undocumented one cannot be reviewed and ' +
          'cannot be contradicted.',
      );
      continue;
    }
    const worstCase = new Map<string, DeclaredParam>();
    const wc = value['worst_case'];
    if (wc !== undefined) {
      if (!isRecord(wc)) {
        failures.push(`INPUT channels.json: '${key}' has a \`worst_case\` that is not an object`);
        continue;
      }
      let bad = false;
      for (const [param, spec] of Object.entries(wc)) {
        // ANY key beginning with `//` is a comment, not a declared parameter —
        // the same convention `tiers.json` and this file's own top level use.
        // T-046 skipped the literal `'//'` ONLY, so a SECOND comment key was
        // INPUT-refused as a malformed declared parameter, and its own `select`
        // disclosure had to be appended into the existing `//` value instead of
        // being given a key of its own. A declaration whose comments cannot be
        // split is a declaration people stop annotating (T-176, member 4).
        if (param.startsWith('//')) continue;
        if (!isRecord(spec)) {
          failures.push(`INPUT channels.json: '${key}'.worst_case.${param} is not an object`);
          bad = true;
          continue;
        }
        if (spec['kind'] === 'plural') {
          const max = spec['max'];
          if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
            failures.push(
              `INPUT channels.json: '${key}'.worst_case.${param} is a plural with \`max\` = ` +
                `${JSON.stringify(max)}; it must be a non-negative integer, and it is the BOUND ` +
                'the <=2-segment claim carries.',
            );
            bad = true;
            continue;
          }
          worstCase.set(param, { kind: 'plural', max });
        } else if (spec['kind'] === 'text') {
          const values = spec['values'];
          if (
            !Array.isArray(values) ||
            values.length === 0 ||
            values.some((v) => typeof v !== 'string')
          ) {
            failures.push(
              `INPUT channels.json: '${key}'.worst_case.${param} is text with \`values\` = ` +
                `${JSON.stringify(values)}; it must be a non-empty array of strings.`,
            );
            bad = true;
            continue;
          }
          worstCase.set(param, { kind: 'text', values: values as string[] });
        } else {
          failures.push(
            `INPUT channels.json: '${key}'.worst_case.${param} has kind ` +
              `${JSON.stringify(spec['kind'])}; it must be 'plural' or 'text'.`,
          );
          bad = true;
        }
        if (typeof spec['why'] !== 'string' || spec['why'].trim() === '') {
          failures.push(
            `CHANNEL-UNREASONED '${key}'.worst_case.${param} declares a bound with no \`why\`. ` +
              'A bound with no stated source is the register defect PROTOCOL §5.1 names: an ' +
              'expectation written in the grammar of a measurement.',
          );
          bad = true;
        }
      }
      if (bad) continue;
    }
    out.set(key, { sms: value['sms'], worstCase });
  }

  for (const key of strictKeys) {
    if (!out.has(key)) {
      failures.push(
        `CHANNEL-UNDECLARED '${key}' is a strict-tier key with no entry in channels.json. The ` +
          'corpus this gate asserts over is EXACTLY the set declared there; a strict key outside ' +
          'it is a template nothing length-audits.',
      );
    }
  }
  for (const key of out.keys()) {
    if (!strictKeys.includes(key)) {
      failures.push(
        `CHANNEL-SURPLUS channels.json declares '${key}', which is not tiered safety_critical or ` +
          'transactional in tiers.json. PM §MVP-N1 AC3(a) reserves SMS for those two tiers; a ' +
          'declaration outside them means the two files have drifted apart.',
      );
    }
  }
  return out;
}

/* --------------------------------------------------- READING D: the pipeline */

/**
 * `review.json` § `pipeline.assignments[<key>].channel` — T-049's copy-review
 * channel, read from a file this gate does not own. Returns only what is there;
 * an absent pipeline is NOT a failure here (it is T-049's block and T-044's
 * gate reads a different part of the same file), but an absent block means the
 * cross-check covered nothing and the run SAYS SO rather than staying silent.
 */
function loadPipelineChannels(root: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'review.json'), 'utf8')) as unknown;
  } catch {
    return out;
  }
  const pipeline = isRecord(raw) ? raw['pipeline'] : undefined;
  const assignments = isRecord(pipeline) ? pipeline['assignments'] : undefined;
  if (!isRecord(assignments)) return out;
  for (const [key, value] of Object.entries(assignments)) {
    if (!isRecord(value)) continue;
    const channel = value['channel'];
    if (typeof channel === 'string') out.set(key, channel);
  }
  return out;
}

/* ------------------------------------------------------- the worst case */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MODEL (T-176), AND WHY IT IS A MODEL RATHER THAN FOUR PATCHES.
 *
 * T-046 shipped with a worst case built from a per-PARAMETER branch set, and
 * two QA passes found four members of ONE defect family by asking the same
 * question each time: WHAT ELSE DOES THE CANDIDATE SET ASSUME? Each member was
 * a different answer to that question —
 *
 *   1. that a parameter is branched on by exactly ONE element (`shapeOf` did
 *      `into.set(name, …)` unconditionally, so a message branching twice on one
 *      parameter kept only the LAST element's branches: a green gate, exit 0,
 *      printing `2 segment(s)` over a Greek message ICU sends as FOUR);
 *   2. the same for `select`, which was MORE exposed because there is no
 *      PLURAL-COVERAGE analogue and because a `select` worst_case declaration
 *      was ignored outright (`48 unit(s) 1 segment(s)`, exit 0, against 176
 *      units = three segments);
 *   3. that the longest `Intl.NumberFormat(v)` form is the longest RENDER, when
 *      `#` renders `v − offset`;
 *   4. (in the declaration's parser) that a comment key is spelled exactly `//`.
 *
 * Patching four members leaves the fifth. So the model is stated once, in terms
 * of what it actually assumes, and then CHECKED AGAINST ICU RATHER THAN AGAINST
 * ITSELF:
 *
 *   THE READING. A message is a list of BRANCHING SITES — one per `plural` or
 *   `select` ELEMENT, not per parameter — collected from the parsed AST,
 *   including sites nested inside another site's branch and inside an ICU tag.
 *   A parameter's model is the whole list of sites that branch on it.
 *
 *   THE REDUCTION. For a parameter, two values that make EVERY site on it
 *   select the same branch produce the same message SHAPE, so only the longest
 *   of them can be the worst case. The candidate set is therefore ONE VALUE PER
 *   DISTINCT BRANCH SIGNATURE — the tuple of branches all its sites select —
 *   and not one value per branch of one element. With a single site that is
 *   exactly T-046's rule, so nothing about the committed corpus moves; with two
 *   sites it is the fix for members 1 and 2 at once, because `=0 in the first
 *   element` is a signature no other value produces.
 *
 *   THE RANKING inside a signature class is on the STRINGS THE MESSAGE INSERTS
 *   — `format(v − offset)` for each distinct `offset:` among the sites, plus
 *   `format(v)` where the parameter is also printed plainly — and not on
 *   `format(v)` alone. That is member 3, closed by construction rather than by
 *   special case.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND THE PART THAT MATTERS MOST: THE CHECK IS NOT DERIVED FROM THE READING.
 *
 * T-046's mirror (`PLURAL-UNREACHABLE`) iterated the SAME per-parameter map the
 * enumeration did, so it was blind to exactly what the enumeration was blind to
 * — PROTOCOL §5.1's own failure mode, "a check must not be derived from the
 * same reading as the thing it checks". A reduction verified against the map it
 * was computed from rebuilds that trap one level up, so this one is verified
 * against ICU:
 *
 *   THE PROBE. A SENTINEL CLONE of the parsed AST is built in which every
 *   branch body of every site is prefixed with a unique `\u0001<site>:<branch>`
 *   literal, and it is formatted by the SAME `intl-messageformat` evaluator with
 *   the SAME binding. The output then NAMES the branches ICU actually selected.
 *   Nothing in it comes from `branchAt`, from the signature, or from the
 *   candidate map: it is ICU reporting on itself.
 *
 *   THE SWEEP. Every parameter that has a site is then swept across its WHOLE
 *   declared domain — not its candidate set — while the others are held at each
 *   of their candidates, and both the probe and the real message are rendered:
 *
 *     REACHABLE  = every (site, branch) the sweep observed ICU select.
 *     COVERED    = every (site, branch) the MEASURED product observed.
 *     SWEEP-WORST= the worst real render the sweep found.
 *
 *   CANDIDATE-INCOMPLETE fires on REACHABLE \ COVERED: ICU renders a branch
 *   somewhere in the declared domain that no binding this gate measured ever
 *   rendered. That is the refusal the old mirror could not make, and it does not
 *   know or care WHY the reduction missed it — a fifth member of this family
 *   turns the gate red without anyone having anticipated it.
 *
 *   CANDIDATE-UNDERSTATED fires when SWEEP-WORST is worse than the product's
 *   worst: the reduction kept the wrong representative of a signature class.
 *   The reported measurement is the worse of the two, so the budget is never
 *   asserted against the optimistic one.
 *
 *   PLURAL-UNREACHABLE / SELECT-UNREACHABLE now fire on branches the sweep
 *   never lit at all — a branch the catalogue declares and the declared domain
 *   cannot render — rather than on `shape.options` minus `best.keys()`.
 *
 * WHAT THIS STILL ASSUMES, stated rather than discovered — see § Published
 * contract §6 for the full list with its measurements:
 *   * the sweep varies ONE parameter at a time (others at their candidates), so
 *     it covers every site's branches but not every joint value pair;
 *   * the declared domain is a DECLARATION (`channels.json`), not a measurement;
 *   * `text` parameters are the declared literals and nothing verifies that the
 *     product cannot produce a longer one;
 *   * the SHADOWED exemption below is still decided with `Intl.PluralRules`.
 */

/** One `plural` or `select` ELEMENT, in AST traversal order. Not one per parameter. */
interface BranchSite {
  /** Stable index in traversal order; the probe's sentinels are keyed by it. */
  readonly id: number;
  readonly param: string;
  readonly kind: 'plural' | 'select';
  /** The branch names this ELEMENT declares, verbatim as ICU spells them (`=0`, `one`, …). */
  readonly options: readonly string[];
  /** For a `plural`: the ICU `offset:`, 0 when absent. The category is selected on `n - offset`. */
  readonly offset: number;
  /** For a `plural`: `selectordinal` rather than `plural`. Refused — see `candidatesFor`. */
  readonly ordinal: boolean;
}

interface ParamShape {
  readonly kind: 'plural' | 'select' | 'text';
  /** EVERY branching element on this parameter, in source order. Empty for `text`. */
  readonly sites: readonly BranchSite[];
  /** The UNION of every site's branch names. Never one element's set. */
  readonly options: readonly string[];
  /** How many times the parameter is printed plainly (`{p}`, `{p, number}`, …). */
  readonly plain: number;
}

const SENTINEL = '\u0001';
const siteKey = (site: BranchSite, branch: string): string => `${String(site.id)}:${branch}`;

/**
 * ONE traversal that does both halves of the reading, so they cannot drift: it
 * collects the sites AND writes the probe's sentinels into a clone of the same
 * AST, in the same order. `TYPE.tag` children are traversed — T-046's `shapeOf`
 * did not, so a parameter reachable only inside `<b>{who}</b>` was invisible to
 * the shape (it then failed loudly as RENDER-FAILED rather than silently, but
 * it was invisible).
 */
function collectSites(
  probe: MessageFormatElement[],
  sites: BranchSite[],
  plains: Map<string, number>,
): void {
  for (const el of probe) {
    switch (el.type) {
      case TYPE.plural:
      case TYPE.select: {
        const site: BranchSite = {
          id: sites.length,
          param: el.value,
          kind: el.type === TYPE.plural ? 'plural' : 'select',
          options: Object.keys(el.options),
          offset: el.type === TYPE.plural ? el.offset : 0,
          ordinal: el.type === TYPE.plural && el.pluralType === 'ordinal',
        };
        sites.push(site);
        for (const [name, opt] of Object.entries(el.options)) {
          opt.value = [
            { type: TYPE.literal, value: `${SENTINEL}${siteKey(site, name)}${SENTINEL}` },
            ...opt.value,
          ];
          collectSites(opt.value as MessageFormatElement[], sites, plains);
        }
        break;
      }
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        plains.set(el.value, (plains.get(el.value) ?? 0) + 1);
        break;
      case TYPE.tag:
        collectSites(el.children as MessageFormatElement[], sites, plains);
        break;
      default:
        break;
    }
  }
}

/** The parameters a message takes, each with EVERY element that branches on it. */
function shapeOf(
  sites: readonly BranchSite[],
  plains: ReadonlyMap<string, number>,
  failures: string[],
  where: string,
): Map<string, ParamShape> {
  const byParam = new Map<string, BranchSite[]>();
  for (const site of sites) {
    const list = byParam.get(site.param) ?? [];
    list.push(site);
    byParam.set(site.param, list);
  }
  const out = new Map<string, ParamShape>();
  for (const [param, list] of byParam) {
    const kinds = new Set(list.map((s) => s.kind));
    if (kinds.size > 1) {
      failures.push(
        `PARAM-KIND-CONFLICT ${where}: '${param}' is branched on as BOTH a plural and a select ` +
          'in the same message. The declared worst case can only be one of the two, so this gate ' +
          'refuses rather than picking one and measuring the message against the wrong domain.',
      );
    }
    const options: string[] = [];
    for (const site of list) {
      for (const name of site.options) if (!options.includes(name)) options.push(name);
    }
    out.set(param, {
      kind: list[0]?.kind ?? 'text',
      sites: list,
      options,
      plain: plains.get(param) ?? 0,
    });
  }
  for (const [param, count] of plains) {
    if (!out.has(param)) out.set(param, { kind: 'text', sites: [], options: [], plain: count });
  }
  return out;
}

/** The branch THIS SITE selects for `v`, selected the way ICU selects one. */
function branchAt(site: BranchSite, v: unknown, rules: Intl.PluralRules): string {
  if (site.kind === 'select') {
    const name = String(v);
    return site.options.includes(name) ? name : 'other';
  }
  const n = typeof v === 'number' ? v : Number(v);
  const exact = `=${String(n)}`;
  if (site.options.includes(exact)) return exact;
  const cat = rules.select(n - site.offset);
  return site.options.includes(cat) ? cat : 'other';
}

const signatureOf = (shape: ParamShape, v: unknown, rules: Intl.PluralRules): string =>
  shape.sites.map((s) => `${String(s.id)}=${branchAt(s, v, rules)}`).join('|');

/** The WHOLE declared domain of a parameter — what the sweep verifies the reduction against. */
function domainOf(shape: ParamShape, declared: DeclaredParam | undefined): readonly unknown[] {
  if (shape.kind === 'plural') {
    if (declared === undefined || declared.kind !== 'plural') return [];
    const out: number[] = [];
    for (let n = 0; n <= declared.max; n += 1) out.push(n);
    for (const site of shape.sites) {
      for (const branch of site.options) {
        if (!/^=\d+$/.test(branch)) continue;
        const v = Number(branch.slice(1));
        if (!out.includes(v)) out.push(v);
      }
    }
    for (let n = 0; n <= declared.max; n += 1) out.push(n + 0.5);
    return out;
  }
  if (shape.kind === 'select') {
    const out: string[] = [...shape.options];
    if (declared !== undefined && declared.kind === 'text') {
      for (const v of declared.values) if (!out.includes(v)) out.push(v);
    }
    return out;
  }
  return declared !== undefined && declared.kind === 'text' ? declared.values : [];
}

/**
 * THE CANDIDATE VALUES FOR ONE PARAMETER: one per distinct BRANCH SIGNATURE.
 *
 * The signature is the tuple of branches every site on this parameter selects,
 * so two values in the same class make the message take the same shape
 * everywhere and only the longest of them can be the worst case. This is the
 * whole of T-176's reading; `worstRender`'s sweep is what checks it.
 *
 * Integers first, then half-integers ONLY for a signature no integer produced —
 * kept from T-046 (QA-F2) because a half-integer is a value the product cannot
 * send, and it exists only so that a branch integers cannot reach (Russian's
 * `other`) is measured rather than skipped. Within a class the value kept is
 * the one whose INSERTED STRINGS are longest: `format(v − offset)` per distinct
 * `offset:` among the sites, plus `format(v)` where the parameter is also
 * printed plainly. Ties go to the larger value.
 *
 * A `select` parameter's domain is the UNION of every site's branch names AND
 * any values `channels.json` declares for it — T-046 returned one element's
 * branch names and ignored the declaration outright, so a declared value was
 * never bound and the file said so in a `why` nobody could rely on.
 */
function candidatesFor(
  param: string,
  shape: ParamShape,
  declared: DeclaredParam | undefined,
  locale: string,
  categories: readonly string[],
  where: string,
  failures: string[],
): readonly unknown[] {
  if (shape.kind === 'plural') {
    if (declared === undefined || declared.kind !== 'plural') {
      failures.push(
        `PARAM-UNDECLARED ${where}: '${param}' is a plural argument and channels.json declares ` +
          'no `{ "kind": "plural", "max": n }` bound for it. An ICU plural has no single length; ' +
          'without a declared magnitude there is no worst case to measure and the <=2-segment ' +
          'claim would carry no bound.',
      );
      return [];
    }
    for (const site of shape.sites) {
      if (!site.ordinal) continue;
      failures.push(
        `PLURAL-ORDINAL ${where}: '${param}' is a \`selectordinal\`. Its branches are the ORDINAL ` +
          'CLDR categories, and locale-registry.json declares the CARDINAL set — the one ' +
          'gate:plural-completeness (T-045) reads. This gate refuses rather than measuring a ' +
          'message against the wrong category set, or inventing an ordinal list from the runtime ' +
          'instead of from the registry. No catalogue message uses `selectordinal` today.',
      );
      return [];
    }
    const rules = new Intl.PluralRules(locale);
    const fmt = new Intl.NumberFormat(locale);
    // RANKS ON THE STRINGS THE MESSAGE INSERTS, not on `format(v)`: `#` renders
    // `v − offset`, and T-046 ranked on the unadjusted value and understated by
    // up to the digit-count difference between `max` and `max − offset`. Each
    // distinct offset is counted once; where the parameter is also printed
    // plainly, `format(v)` is counted too.
    const offsets = [...new Set(shape.sites.map((s) => s.offset))];
    const widthOf = (v: number): number => {
      let width = offsets.reduce((n, o) => n + fmt.format(v - o).length, 0);
      if (shape.plain > 0) width += fmt.format(v).length;
      return width;
    };
    const best = new Map<string, number>();
    const consider = (v: number): void => {
      const sig = signatureOf(shape, v, rules);
      const current = best.get(sig);
      if (current === undefined) {
        best.set(sig, v);
        return;
      }
      // Strictly greater INSERTED width wins; a tie keeps the first value
      // found, because a tie is by construction the same inserted width.
      if (widthOf(v) > widthOf(current)) best.set(sig, v);
    };
    // Pass 1 — the declared domain: the INTEGERS in [0, max], plus any explicit
    // `=N` branch OUTSIDE it, which is still a branch this message renders.
    // Measuring it is conservative: an extra binding can only widen the worst case.
    for (const v of domainOf(shape, declared)) {
      if (typeof v === 'number' && Number.isInteger(v)) consider(v);
    }
    const reachedByInteger = new Set(best.keys());
    // Pass 2 — half-integers, ONLY for a signature no integer reached.
    for (const v of domainOf(shape, declared)) {
      if (typeof v !== 'number' || Number.isInteger(v)) continue;
      if (reachedByInteger.has(signatureOf(shape, v, rules))) continue;
      consider(v);
    }
    const explicitBranches: string[] = [];
    for (const site of shape.sites) {
      for (const branch of site.options) {
        if (/^=\d+$/.test(branch) && !explicitBranches.includes(branch))
          explicitBranches.push(branch);
      }
    }
    if (explicitBranches.length > 0) {
      console.log(
        `      note ${where}: the plural on '${param}' declares explicit branch(es) ` +
          `[${explicitBranches.join(', ')}], which ICU matches BEFORE any CLDR category rule. ` +
          'Each is its own branch signature and is bound at its own value, INCLUDING when it is ' +
          'declared by an element other than the last (T-176) and including a value outside the ' +
          'declared domain, because a branch the gate never binds is a branch the product sends ' +
          'unmeasured (T-046 rework 1, QA-F1).',
      );
    }
    const fromHalves = [...best.entries()].filter(([sig]) => !reachedByInteger.has(sig));
    if (fromHalves.length > 0) {
      const branches = new Set<string>();
      for (const [, v] of fromHalves) {
        for (const site of shape.sites) branches.add(branchAt(site, v, rules));
      }
      console.log(
        `      note ${where}: plural branch${branches.size === 1 ? '' : 'es'} ` +
          `[${[...branches].join(', ')}] on '${param}' ${branches.size === 1 ? 'is' : 'are'} ` +
          `unreachable with any integer in the declared domain, so ${branches.size === 1 ? 'it was' : 'they were'} ` +
          `measured at ${fromHalves.map(([, v]) => String(v)).join(', ')} — the longest ` +
          'half-integer of that signature. The branch is in the catalogue, so it is rendered and ' +
          'measured rather than skipped. A half-integer is an INSTRUMENT, not a value the ' +
          'product can send.',
      );
    }
    // PLURAL-COVERAGE is asserted PER SITE, not per parameter. T-046 asserted it
    // against one element's branch set, so a second element missing a category
    // was only caught when it happened to be the last one read.
    for (const site of shape.sites) {
      if (!site.options.includes('other')) {
        failures.push(
          `PLURAL-COVERAGE ${where}: a plural element on '${param}' declares no \`other\` ` +
            'branch. ICU requires one and the worst case cannot be computed without it.',
        );
      }
      for (const cat of categories) {
        if (cat === 'other' || site.options.includes(cat)) continue;
        failures.push(
          `PLURAL-COVERAGE ${where}: a plural element on '${param}' has no '${cat}' branch, ` +
            `which locale-registry.json declares for '${locale}'. gate:plural-completeness ` +
            '(T-045) refuses this as a translation defect; it is refused HERE as well because a ' +
            'missing branch makes the worst case unmeasurable, and the two gates must not each ' +
            'assume the other caught it.',
        );
      }
    }
    return [...best.values()];
  }
  if (shape.kind === 'select') {
    // MEMBER FIVE, found by asking T-176's own question of T-176's own model:
    // WHAT ELSE DOES THE CANDIDATE SET ASSUME? It assumed a `select`
    // parameter's value set is its BRANCH NAMES. That is true of what the
    // parameter SELECTS and false of what it PRINTS: `{tone, select, other
    // {Missed check-in}} — {tone}` renders whatever string the product passes,
    // and nothing here bounds it. MEASURED on a fixture root at b58b713: the
    // gate printed `69 unit(s) 1 segment(s), headroom 65` and EXITED 0 while
    // ICU sent 214 units = FOUR SEGMENTS at a 150-character `tone`. So a
    // printed `select` parameter needs a declared worst case exactly as any
    // other printed parameter does — and one that is never printed does not,
    // because its branch names then determine the render completely, which is
    // now a stated property rather than an accident.
    if (shape.plain > 0 && (declared === undefined || declared.kind !== 'text')) {
      failures.push(
        `PARAM-UNDECLARED ${where}: '${param}' selects a branch AND is printed, and ` +
          'channels.json declares no worst-case value for it. The branch names bound what it ' +
          'SELECTS; they bound nothing about what it PRINTS, and the product passes a runtime ' +
          'string. Declare it as `{ "kind": "text", "values": [...] }` — the declared values are ' +
          'bound in addition to the branch names.',
      );
      return [];
    }
    const rules = new Intl.PluralRules(locale);
    const best = new Map<string, string>();
    for (const v of domainOf(shape, declared)) {
      const name = String(v);
      const sig = signatureOf(shape, name, rules);
      const current = best.get(sig);
      if (current === undefined || name.length > current.length) best.set(sig, name);
    }
    return [...best.values()];
  }
  if (declared === undefined || declared.kind !== 'text') {
    failures.push(
      `PARAM-UNDECLARED ${where}: '${param}' is a parameter of this message and channels.json ` +
        'declares no worst-case value for it. A placeholder takes a runtime value; an assertion ' +
        'that ignores it measures the template and claims it about the message.',
    );
    return [];
  }
  return declared.values;
}

interface Rendered {
  readonly text: string;
  readonly binding: Readonly<Record<string, unknown>>;
  readonly measurement: Measurement;
  /** Every parameter the message takes, whether or not it was bound. Reading C uses it. */
  readonly params: ReadonlySet<string>;
}

/** The cap on the independent verification sweep. Exceeded is a refusal, never a sample. */
const MAX_VERIFICATION_RENDERS = 250_000;

/**
 * The worst rendering of one (key, locale) pair over the whole declared
 * substitution product. The product is enumerated in full — never sampled — and
 * a product larger than MAX_SUBSTITUTIONS_PER_PAIR is a refusal.
 *
 * AND THEN IT IS CHECKED AGAINST ICU, not against itself: see the model note at
 * the top of this section. The sweep is what makes `CANDIDATE-INCOMPLETE`,
 * `CANDIDATE-UNDERSTATED` and the two `*-UNREACHABLE` refusals possible.
 */
function worstRender(
  source: string,
  locale: string,
  entry: ChannelEntry,
  categories: readonly string[],
  where: string,
  failures: string[],
): Rendered | undefined {
  let ast: MessageFormatElement[];
  try {
    ast = parse(source);
  } catch (err) {
    failures.push(
      `MALFORMED ${where}: the catalogue source does not parse as ICU — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  const probeAst = structuredClone(ast);
  const sites: BranchSite[] = [];
  const plains = new Map<string, number>();
  collectSites(probeAst, sites, plains);
  const shape = shapeOf(sites, plains, failures, where);

  const names = [...shape.keys()].sort();
  const axes: { name: string; values: readonly unknown[] }[] = [];
  for (const name of names) {
    const s = shape.get(name);
    if (s === undefined) continue;
    const values = candidatesFor(
      name,
      s,
      entry.worstCase.get(name),
      locale,
      categories,
      where,
      failures,
    );
    if (values.length === 0) return undefined;
    axes.push({ name, values });
  }
  for (const declaredName of entry.worstCase.keys()) {
    if (!shape.has(declaredName)) {
      failures.push(
        `PARAM-SURPLUS ${where}: channels.json declares a worst case for '${declaredName}', ` +
          'which this message does not take. A declaration for a parameter that is not there is ' +
          'usually a renamed placeholder, and it measures nothing.',
      );
    }
  }

  const total = axes.reduce((n, a) => n * a.values.length, 1);
  if (total > MAX_SUBSTITUTIONS_PER_PAIR) {
    failures.push(
      `WORST-CASE-EXPLOSION ${where}: the declared substitution product is ${String(total)} ` +
        `combinations, over the ${String(MAX_SUBSTITUTIONS_PER_PAIR)} cap. This gate enumerates ` +
        'the product in full and never samples it, so it refuses rather than measuring a corner ' +
        'of it and reporting a maximum.',
    );
    return undefined;
  }

  let formatter: IntlMessageFormat;
  let probe: IntlMessageFormat;
  try {
    formatter = new IntlMessageFormat(source, locale);
    probe = new IntlMessageFormat(probeAst, locale);
  } catch (err) {
    failures.push(`MALFORMED ${where}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  let worst: Rendered | undefined;
  const render = (acc: Record<string, unknown>): Rendered | undefined => {
    let text: string;
    try {
      const out = formatter.format(acc);
      text = typeof out === 'string' ? out : String(out);
    } catch (err) {
      failures.push(
        `RENDER-FAILED ${where} with ${JSON.stringify(acc)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    return { text, binding: { ...acc }, measurement: measure(text), params: new Set(names) };
  };
  // WORST means: most segments; then, at equal segments, LEAST HEADROOM — not
  // most units. The two differ and the difference is the point. An English
  // message carrying a Greek sitter's name is 66 UCS-2 units with 68 units of
  // headroom; the same message with a Latin name is 66 GSM-7 septets with 240.
  // Same segment count, same unit count, four times the room — so "most units"
  // would report the comfortable binding as the worst case and hide that one
  // non-GSM-7 character costs the whole message the UCS-2 budget.
  const worseThan = (a: Rendered, b: Rendered | undefined): boolean =>
    b === undefined ||
    a.measurement.segments > b.measurement.segments ||
    (a.measurement.segments === b.measurement.segments &&
      a.measurement.headroom < b.measurement.headroom);

  /** ICU's own report of which branches it selected, read out of the sentinel render. */
  const observe = (acc: Record<string, unknown>, into: Set<string>): void => {
    let out: string;
    try {
      const formatted = probe.format(acc);
      out = typeof formatted === 'string' ? formatted : String(formatted);
    } catch {
      return; // the real render reports the failure; the probe is not a second voice for it
    }
    // Split rather than match: a regular expression over a control character is
    // banned by `no-control-regex`, and the sentinel must be a character no
    // catalogue string can contain.
    const parts = out.split(SENTINEL);
    for (let i = 1; i < parts.length; i += 2) {
      const hit = parts[i];
      if (hit !== undefined) into.add(hit);
    }
  };

  const covered = new Set<string>();
  const bind = (index: number, acc: Record<string, unknown>): void => {
    const axis = axes[index];
    if (axis === undefined) {
      const r = render(acc);
      if (r === undefined) return;
      observe(acc, covered);
      if (worseThan(r, worst)) worst = r;
      return;
    }
    for (const value of axis.values) bind(index + 1, { ...acc, [axis.name]: value });
  };
  bind(0, {});
  if (worst === undefined) return undefined;

  // ───────────────────────────── the independent check (PROTOCOL §5.1)
  const branching = axes.filter((a) => (shape.get(a.name)?.sites.length ?? 0) > 0);
  const domains = new Map<string, readonly unknown[]>();
  for (const axis of branching) {
    const s = shape.get(axis.name);
    if (s === undefined) continue;
    domains.set(axis.name, domainOf(s, entry.worstCase.get(axis.name)));
  }
  let sweepBindings = 0;
  for (const axis of branching) {
    const others = axes.filter((a) => a.name !== axis.name);
    sweepBindings +=
      (domains.get(axis.name)?.length ?? 0) * others.reduce((n, a) => n * a.values.length, 1);
  }
  const declaredBranches: { site: BranchSite; branch: string }[] = [];
  for (const site of sites) {
    for (const branch of site.options) declaredBranches.push({ site, branch });
  }
  if (sweepBindings > MAX_VERIFICATION_RENDERS) {
    failures.push(
      `VERIFICATION-EXPLOSION ${where}: checking the candidate set against ICU over the declared ` +
        `domain would take ${String(sweepBindings)} render(s), over the ` +
        `${String(MAX_VERIFICATION_RENDERS)} cap. This gate refuses rather than sampling the ` +
        'domain, because an unverified reduction is exactly the defect T-176 exists to close. ' +
        'Narrow the declared domain, or split the message.',
    );
    return worst;
  }
  if (declaredBranches.length > 0 && sweepBindings === 0) {
    failures.push(
      `VERIFICATION-VACUOUS ${where}: the message declares ${String(declaredBranches.length)} ` +
        'branch(es) and the candidate set was checked against ICU over 0 binding(s). A check ' +
        'that examined nothing must say so rather than pass (PROTOCOL §5.1).',
    );
    return worst;
  }
  const reachable = new Set<string>();
  let sweepWorst: Rendered | undefined;
  let sweepRenderFailures = 0;
  let firstSweepRenderFailure: string | undefined;
  const quietRender = (acc: Record<string, unknown>): Rendered | undefined => {
    try {
      const out = formatter.format(acc);
      const text = typeof out === 'string' ? out : String(out);
      return { text, binding: { ...acc }, measurement: measure(text), params: new Set(names) };
    } catch (err) {
      sweepRenderFailures += 1;
      firstSweepRenderFailure ??= `${JSON.stringify(acc)}: ${err instanceof Error ? err.message : String(err)}`;
      return undefined;
    }
  };
  /**
   * The sweep runs in TWO PHASES, and the split is the same one T-046 made for
   * the candidate set: a HALF-INTEGER IS AN INSTRUMENT, NOT PART OF THE DOMAIN.
   * A count of missed check-ins is an integer and `100.5` is not, so a
   * half-integer is admitted only when it makes ICU render a branch NO INTEGER
   * IN THE DOMAIN REACHES — and "no integer reaches it" is decided from what
   * ICU was OBSERVED to select in phase 1, not from `signatureOf`. Were it
   * decided from `signatureOf`, this check would be reading the same map the
   * reduction does, which is the whole defect T-176 exists to close.
   */
  const sweep = (
    axis: { name: string; values: readonly unknown[] },
    values: readonly unknown[],
    admit: ((lit: ReadonlySet<string>) => boolean) | undefined,
  ): void => {
    const others = axes.filter((a) => a.name !== axis.name);
    const walk = (index: number, acc: Record<string, unknown>): void => {
      const other = others[index];
      if (other === undefined) {
        for (const v of values) {
          const binding = { ...acc, [axis.name]: v };
          const lit = new Set<string>();
          observe(binding, lit);
          if (admit !== undefined && !admit(lit)) continue;
          for (const key of lit) reachable.add(key);
          const r = quietRender(binding);
          if (r !== undefined && worseThan(r, sweepWorst)) sweepWorst = r;
        }
        return;
      }
      for (const value of other.values) walk(index + 1, { ...acc, [other.name]: value });
    };
    walk(0, {});
  };
  const isHalf = (v: unknown): boolean => typeof v === 'number' && !Number.isInteger(v);
  for (const axis of branching) {
    sweep(
      axis,
      (domains.get(axis.name) ?? []).filter((v) => !isHalf(v)),
      undefined,
    );
  }
  const reachedByInteger = new Set(reachable);
  for (const axis of branching) {
    const halves = (domains.get(axis.name) ?? []).filter(isHalf);
    if (halves.length === 0) continue;
    sweep(axis, halves, (lit) => [...lit].some((key) => !reachedByInteger.has(key)));
  }
  if (sweepRenderFailures > 0) {
    failures.push(
      `RENDER-FAILED ${where}: ${String(sweepRenderFailures)} binding(s) of the declared domain ` +
        `could not be rendered at all. The first was ${firstSweepRenderFailure ?? 'unknown'}`,
    );
  }

  const rules = new Intl.PluralRules(locale);
  let missed = 0;
  for (const { site, branch } of declaredBranches) {
    const key = siteKey(site, branch);
    if (covered.has(key)) continue;
    if (reachable.has(key)) {
      missed += 1;
      failures.push(
        `CANDIDATE-INCOMPLETE ${where}: ICU renders branch '${branch}' of the ` +
          `${site.kind} element #${String(site.id)} on '${site.param}' for a value in the ` +
          'declared domain, and NO binding this gate measured ever rendered it — so that branch ' +
          "of the message was never measured and the worst case is understated. This is ICU's " +
          'own report of which branch it selected, not this gate re-reading its own candidate ' +
          'map (PROTOCOL §5.1). The candidate set, not the catalogue, is what is wrong.',
      );
      continue;
    }
    // Not reachable at all. A CATEGORY branch every one of whose values is
    // matched by an explicit branch first is dead copy ICU can never render —
    // PLURAL-COVERAGE still requires it to be present, so refusing it would be
    // a trap. Anything else is a branch the declared domain cannot reach.
    const domain = domains.get(site.param) ?? [];
    const shadowed =
      site.kind === 'plural' &&
      !/^=\d+$/.test(branch) &&
      domain.some((v) => typeof v === 'number' && rules.select(v - site.offset) === branch);
    if (shadowed) {
      console.log(
        `      note ${where}: plural branch [${branch}] is SHADOWED (element ` +
          `#${String(site.id)} on '${site.param}') — CLDR selects it, but every value that ` +
          'selects it is matched by an explicit `=N` branch first, so ICU never renders it. Not ' +
          'measured, because it cannot be sent, and PLURAL-COVERAGE still requires it to be there.',
      );
      continue;
    }
    missed += 1;
    failures.push(
      `${site.kind === 'plural' ? 'PLURAL' : 'SELECT'}-UNREACHABLE ${where}: nothing in the ` +
        `declared domain of '${site.param}' renders the ${site.kind} branch '${branch}' of ` +
        `element #${String(site.id)} — measured by asking ICU which branch it selected, not by ` +
        "reading this gate's own candidate map. That branch of the message is therefore never " +
        'rendered and its length is never measured — the worst case would be understated.',
    );
  }
  if (sweepWorst !== undefined && worseThan(sweepWorst, worst)) {
    failures.push(
      `CANDIDATE-UNDERSTATED ${where}: the candidate set's worst binding ` +
        `${JSON.stringify(worst.binding)} measures ${String(worst.measurement.units)} ` +
        `${worst.measurement.encoding} unit(s) / ${String(worst.measurement.segments)} ` +
        `segment(s), but sweeping the declared domain against ICU found ` +
        `${JSON.stringify(sweepWorst.binding)} at ${String(sweepWorst.measurement.units)} ` +
        `unit(s) / ${String(sweepWorst.measurement.segments)} segment(s). The reduction kept the ` +
        'wrong representative of a branch signature. The budget below is asserted against the ' +
        'WORSE of the two, so this refusal is about the model and not about the copy.',
    );
    worst = sweepWorst;
  }
  console.log(
    `      verified ${String(sweepBindings)} binding(s) of the declared domain against ICU's own ` +
      `branch selection: ${String(declaredBranches.length - missed)} of ` +
      `${String(declaredBranches.length)} declared branch(es) at ${String(sites.length)} ` +
      `branching element(s) rendered by the measured set`,
  );
  return worst;
}

/* ------------------------------------------------------------------- main */

async function main(argv: readonly string[]): Promise<void> {
  const { root, explicitRoot } = parseArgs(argv);
  const banner = explicitRoot
    ? `${GATE}  [--root ${root}: SOURCE READING ONLY — the committed compiled artefact was NOT read]`
    : GATE;
  const failures: string[] = [];

  console.log(`${GATE}: reading ${root}`);
  console.log(
    `  budget: <= ${String(MAX_SEGMENTS)} segment(s) = <= ${String(budgetFor('GSM-7'))} septets ` +
      `(GSM-7, ${String(CAPACITY['GSM-7'].concatenated)}/segment concatenated) or ` +
      `<= ${String(budgetFor('UCS-2'))} UTF-16 code units (UCS-2, ` +
      `${String(CAPACITY['UCS-2'].concatenated)}/segment concatenated). The single-segment ` +
      `figures ${String(CAPACITY['GSM-7'].single)}/${String(CAPACITY['UCS-2'].single)} are NOT ` +
      'the two-segment budget: a concatenated segment pays a 6-octet UDH (PM §MVP-N1 AC3).',
  );

  const registry = loadRegistry(root, failures);
  const { keys: strictKeys, all: allTiered } = loadStrictKeys(root, failures);
  if (registry === undefined) finish(banner, failures);
  const enabled = registry.enabled;

  const strictTiers = (Object.keys(TIER_POLICY) as Tier[]).filter(
    (t) => TIER_POLICY[t].onMissingTranslation === 'build_failure',
  );
  console.log(`  enabled locales (locale-registry.json): ${enabled.join(', ')}`);
  console.log(
    `  strict tiers (TIER_POLICY.onMissingTranslation = build_failure): ${strictTiers.join(', ')}`,
  );
  console.log(
    `  strict-tier keys (tiers.json): ${String(strictKeys.length)} of ${String(allTiered)} tiered keys`,
  );

  // ------------------------------------------------------- V. anti-vacuity
  if (strictKeys.length === 0) {
    failures.push(
      'NO-COMPARISON tiers.json assigns no key to a strict tier. This gate would examine nothing ' +
        'and exit 0 — the vacuous pass it exists to prevent.',
    );
  }
  if (enabled.length === 0) {
    failures.push(
      'NO-COMPARISON locale-registry.json enables no locale. There would be no (locale, key) ' +
        'pair to measure, and "<=2 segments per locale" would be a claim about no locale.',
    );
  }
  if (failures.length > 0) finish(banner, failures);

  const channels = loadChannels(root, strictKeys, failures);
  const smsKeys = strictKeys.filter((k) => channels.get(k)?.sms === true);
  console.log(
    `  SMS corpus (channels.json, \`sms: true\`): ${String(smsKeys.length)} key(s)` +
      (smsKeys.length > 0 ? ` — ${smsKeys.join(', ')}` : ''),
  );
  if (smsKeys.length === 0 && failures.length === 0) {
    failures.push(
      'NO-SMS-CORPUS channels.json declares no key as `sms: true`, so the <=2-segment assertion ' +
        'would bind nothing and this gate would be GREEN BECAUSE IT FOUND NOTHING. PM §MVP-N1 ' +
        'AC5 puts the Critical tier on Push + SMS + in-app; a repository with strict-tier keys ' +
        'and no SMS template at all is a state to declare deliberately, not one to arrive at by ' +
        'flipping a flag. If it is deliberate, move SMS_KEYS_PINNED in this gate in the same ' +
        'commit and say why in the ticket.',
    );
  }

  // ------------------------------------------------- D. the pipeline cross-check
  const pipelineChannels = loadPipelineChannels(root);
  let crossChecked = 0;
  let unconstrained = 0;
  for (const key of strictKeys) {
    const channel = pipelineChannels.get(key);
    if (channel === undefined) continue;
    if (!PIPELINE_CHANNELS_THAT_FORBID_SMS.includes(channel)) {
      unconstrained += 1;
      continue;
    }
    crossChecked += 1;
    if (channels.get(key)?.sms === true) {
      failures.push(
        `CHANNEL-CONTRADICTION '${key}': review.json § pipeline determines its copy-review ` +
          `channel as '${channel}', which is a surface the user reads or speaks from, and ` +
          'channels.json declares it `sms: true`. One of the two files is wrong and this gate ' +
          'will not pick. (The converse is NOT checked: a pipeline channel of `undetermined` ' +
          'constrains nothing here.)',
      );
    }
  }
  console.log(
    `  reading D (review.json § pipeline.assignments): ${String(pipelineChannels.size)} ` +
      `assignment(s) found; ${String(crossChecked)} determined non-deliverable channel(s) ` +
      `cross-checked, ${String(unconstrained)} left unconstrained (\`undetermined\`). This ` +
      'cross-check runs in ONE direction only and cannot make a key SMS, only refuse one.',
  );

  // ------------------------------------------- A1. the floor: every strict pair
  console.log('');
  console.log(
    '  TEMPLATE SOURCE — every strict-tier key x every enabled locale, measured as committed ' +
      'with PLACEHOLDERS UNEXPANDED. This is NOT an SMS bound and no row here is refused on ' +
      'length; it is the workload that makes a run examining nothing impossible to mistake for ' +
      'a pass.',
  );
  let examined = 0;
  let surrogates = 0;
  let notNfc = 0;
  for (const locale of enabled) {
    for (const key of strictKeys) {
      examined += 1;
      const source = catalogueSource(locale, key, root);
      if (source === undefined) {
        failures.push(
          `NO-SOURCE '${key}' has no catalogue string in '${locale}', so nothing could be ` +
            'measured for it. gate:locale-completeness (T-042) is what names this as a missing ' +
            'translation; it is refused here because a pair with no source is a pair this gate ' +
            'silently skipped.',
        );
        continue;
      }
      const m = measure(source);
      surrogates += m.surrogatePairs;
      if (source !== source.normalize('NFC')) notNfc += 1;
      console.log(
        `    ${locale} ${key.padEnd(34)} ${m.encoding} ${String(m.units).padStart(4)} unit(s) ` +
          `${String(m.segments)} segment(s)`,
      );
    }
  }
  const expectedPairs = strictKeys.length * enabled.length;
  console.log(
    `  examined ${String(examined)} (locale, key) pair(s) — ${String(strictKeys.length)} strict ` +
      `key(s) x ${String(enabled.length)} enabled locale(s); ${String(surrogates)} non-BMP code ` +
      `point(s) seen (each costs TWO UCS-2 units), ${String(notNfc)} source string(s) not in NFC`,
  );
  if (examined !== expectedPairs) {
    failures.push(
      `VACUOUS-RUN examined ${String(examined)} (locale, key) pair(s); ` +
        `${String(strictKeys.length)} key(s) x ${String(enabled.length)} locale(s) is ` +
        `${String(expectedPairs)}. Some pair was never looked at.`,
    );
  }

  // ------------------------------- A2. the assertion: the SMS corpus, rendered
  console.log('');
  console.log(
    '  SMS TEMPLATES — rendered at the declared worst case in channels.json and REFUSED above ' +
      `${String(MAX_SEGMENTS)} segments. This is the assertion; everything above is the floor.`,
  );
  let asserted = 0;
  const sourceRenders = new Map<string, Rendered>();
  const observedParams = new Map<string, Set<string>>();
  for (const locale of enabled) {
    const categories = registry.pluralCategories.get(locale) ?? [];
    for (const key of smsKeys) {
      const where = `'${key}' in ${locale}`;
      const entry = channels.get(key);
      const source = catalogueSource(locale, key, root);
      if (entry === undefined || source === undefined) continue;
      const rendered = worstRender(source, locale, entry, categories, where, failures);
      if (rendered === undefined) continue;
      asserted += 1;
      const seen = observedParams.get(key) ?? new Set<string>();
      for (const name of rendered.params) seen.add(name);
      observedParams.set(key, seen);
      sourceRenders.set(`${locale}\u0000${key}`, rendered);
      const m = rendered.measurement;
      console.log(
        `    ${locale} ${key.padEnd(34)} ${m.encoding} ${String(m.units).padStart(4)} unit(s) ` +
          `${String(m.segments)} segment(s), headroom ${String(m.headroom)} unit(s)`,
      );
      console.log(`      worst binding ${JSON.stringify(rendered.binding)}`);
      console.log(`      renders ${JSON.stringify(rendered.text)}`);
      if (m.segments > MAX_SEGMENTS) {
        failures.push(
          `OVER-BUDGET ${where}: ${String(m.units)} ${m.encoding} unit(s) is ` +
            `${String(m.segments)} segments, over the ${String(MAX_SEGMENTS)}-segment budget of ` +
            `${String(budgetFor(m.encoding))} (PM §MVP-N1 AC3; SA §C7). Worst binding ` +
            `${JSON.stringify(rendered.binding)}. Shorten it by at least ` +
            `${String(-m.headroom)} unit(s), or change the encoding: every non-GSM-7 character ` +
            'in the string costs the whole message the UCS-2 budget.',
        );
      }
      if (rendered.text !== rendered.text.normalize('NFC')) {
        failures.push(
          `NOT-NFC ${where}: the worst-case render is not in Unicode NFC. The decomposed form ` +
            'costs more UTF-16 code units than the composed one for exactly the characters this ' +
            'product uses (Greek tonos, the Cyrillic short-i breve), so a decomposed catalogue ' +
            'string is a silent segment-count increase. review.json hashes the NFC form ' +
            '(T-040 § contract §6); the wire carries what is committed.',
        );
      }
    }
  }
  const expectedAssertions = smsKeys.length * enabled.length;
  console.log(
    `  asserted ${String(asserted)} (locale, key) pair(s) against the ${String(MAX_SEGMENTS)}-` +
      `segment budget — ${String(smsKeys.length)} SMS key(s) x ${String(enabled.length)} locale(s)`,
  );
  if (asserted !== expectedAssertions && failures.length === 0) {
    failures.push(
      `VACUOUS-RUN asserted ${String(asserted)} (locale, key) pair(s); ${String(smsKeys.length)} ` +
        `SMS key(s) x ${String(enabled.length)} locale(s) is ${String(expectedAssertions)}. ` +
        'Some declared SMS template was never rendered and never measured.',
    );
  }

  // ---------------------------------------------------------- C. the pins
  checkPins(strictKeys, enabled, smsKeys, channels, observedParams, failures);

  // ------------------------------------------------- B. the compiled artefact
  if (explicitRoot) {
    console.log(
      '  READING B NOT RUN: --root was given. The compiled artefact reachable from this script ' +
        'belongs to packages/i18n and not to that root. Readings A, C and D only.',
    );
    finish(banner, failures);
  }
  await checkCompiled(strictKeys, enabled, smsKeys, sourceRenders, failures);
  finish(banner, failures);
}

/** READING C — the pins in this file against the source artefacts. */
function checkPins(
  strictKeys: readonly string[],
  enabled: readonly string[],
  smsKeys: readonly string[],
  channels: ReadonlyMap<string, ChannelEntry>,
  observedParams: ReadonlyMap<string, ReadonlySet<string>>,
  failures: string[],
): void {
  for (const [key, floor] of Object.entries(WORST_CASE_FLOOR)) {
    if (!smsKeys.includes(key)) continue; // SMS-ESCAPE already named it
    const declared = channels.get(key)?.worstCase;
    if (declared === undefined) continue;
    // The floor binds a parameter the message STILL TAKES. A placeholder
    // deleted from the copy is a content change, not a narrowed bound, and
    // review of the diff is the control for it (§ contract §6).
    const takes = observedParams.get(key) ?? new Set<string>();
    for (const [param, min] of Object.entries(floor.plural ?? {})) {
      if (!takes.has(param)) continue;
      const spec = declared.get(param);
      if (spec === undefined || spec.kind !== 'plural' || spec.max < min) {
        failures.push(
          `WORST-CASE-NARROWED '${key}'.worst_case.${param}: the declared plural bound is ` +
            `${spec === undefined || spec.kind !== 'plural' ? 'absent' : String(spec.max)}, ` +
            `below the ${String(min)} pinned in this gate on 2026-09-21. Narrowing the worst ` +
            'case is the cheapest way to keep this gate green over a weaker claim: the corpus, ' +
            'the pair count and the banner are all unchanged and only the bound moves. Widening ' +
            'is free; narrowing costs an edit to WORST_CASE_FLOOR in the same commit.',
        );
      }
    }
    for (const [param, min] of Object.entries(floor.text ?? {})) {
      if (!takes.has(param)) continue;
      const spec = declared.get(param);
      const longest =
        spec === undefined || spec.kind !== 'text'
          ? 0
          : spec.values.reduce((n, v) => Math.max(n, v.length), 0);
      if (longest < min) {
        failures.push(
          `WORST-CASE-NARROWED '${key}'.worst_case.${param}: the longest declared value is ` +
            `${String(longest)} UTF-16 code unit(s), below the ${String(min)} pinned in this ` +
            'gate on 2026-09-21. The pin is on the LENGTH of the longest value, not on how many ' +
            'are declared, because three one-character names would satisfy a count and measure ' +
            'nothing.',
        );
      }
    }
  }
  for (const key of SMS_KEYS_PINNED) {
    if (!smsKeys.includes(key)) {
      failures.push(
        `SMS-ESCAPE '${key}' was declared \`sms: true\` in channels.json on 2026-09-21 and is ` +
          'not now. Flipping the flag is the cheapest way to make this gate assert less — it ' +
          'removes a template from the budget without deleting anything. If the change is ' +
          'deliberate, edit SMS_KEYS_PINNED in this gate in the same commit.',
      );
    }
  }
  for (const key of STRICT_KEYS_PINNED) {
    if (!strictKeys.includes(key)) {
      failures.push(
        `STRICT-ESCAPE '${key}' was tiered safety_critical or transactional on 2026-09-21 and is ` +
          "not now. Re-tiering it takes it out of channels.json's required set and out of this " +
          "gate's floor at once. If it is deliberate, edit STRICT_KEYS_PINNED in this gate in " +
          'the same commit.',
      );
    }
  }
  for (const locale of LOCALES_PINNED) {
    if (!enabled.includes(locale)) {
      failures.push(
        `LOCALE-DISABLED '${locale}' was an enabled locale on 2026-09-21 and is not one now. ` +
          '"<=2 segments PER LOCALE" is only as wide as the enabled set, and disabling a locale ' +
          'retires every one of its measurements at once. If it is deliberate, edit ' +
          'LOCALES_PINNED in this gate in the same commit.',
      );
    }
  }
}

/** READING B — the committed compiled artefact, which is what ships. */
async function checkCompiled(
  strictKeys: readonly string[],
  enabled: readonly string[],
  smsKeys: readonly string[],
  sourceRenders: ReadonlyMap<string, Rendered>,
  failures: string[],
): Promise<void> {
  // Imported late and defensively: a broken `compiled/` must produce this
  // gate's own GATE FAIL banner, never an uncaught exception (PROTOCOL §5.1 —
  // "did nothing", "refused" and "crashed" are three distinguishable outcomes).
  let compiledStrict: readonly string[];
  let compiledEnabled: readonly string[];
  let catalogues: Readonly<Record<string, Record<string, (args: never) => string>>>;
  try {
    const mod = (await import('../src/index.ts')) as unknown as {
      strictKeys: () => readonly string[];
      enabledLocales: () => readonly { code: string }[];
      CATALOGUES: Readonly<Record<string, Record<string, (args: never) => string>>>;
    };
    compiledStrict = [...mod.strictKeys()].sort();
    compiledEnabled = mod.enabledLocales().map((d) => d.code);
    catalogues = mod.CATALOGUES;
  } catch (err) {
    failures.push(
      `COMPILED-UNREADABLE the committed compiled artefact could not be loaded — ` +
        `${err instanceof Error ? err.message : String(err)}. Run ` +
        '`pnpm --filter @kinvara/i18n build` and commit `compiled/`.',
    );
    return;
  }

  const onlyInSource = strictKeys.filter((k) => !compiledStrict.includes(k));
  const onlyInCompiled = compiledStrict.filter((k) => !strictKeys.includes(k));
  if (onlyInSource.length > 0 || onlyInCompiled.length > 0) {
    failures.push(
      'TIER-DRIFT tiers.json and the committed compiled/tiers.ts disagree on the strict-tier key ' +
        `set — only in tiers.json: [${onlyInSource.join(', ')}]; only in compiled/: ` +
        `[${onlyInCompiled.join(', ')}]. This gate measured one of them and the product ships ` +
        'the other.',
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

  // The second artefact does the SAME render. If the compiled function and the
  // catalogue source disagree by one character, the string this gate measured
  // is not the string that ships, and the measurement is about the wrong text.
  let compared = 0;
  for (const locale of enabled) {
    for (const key of smsKeys) {
      const rendered = sourceRenders.get(`${locale}\u0000${key}`);
      if (rendered === undefined) continue;
      const fn = catalogues[locale]?.[key];
      if (typeof fn !== 'function') {
        failures.push(
          `COMPILED-MISSING '${key}' in ${locale}: the committed compiled catalogue has no ` +
            'message function for a key this gate asserts a segment budget over.',
        );
        continue;
      }
      let shipped: string;
      try {
        shipped = fn(rendered.binding as never);
      } catch (err) {
        failures.push(
          `COMPILED-RENDER-FAILED '${key}' in ${locale} with ` +
            `${JSON.stringify(rendered.binding)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      compared += 1;
      if (shipped !== rendered.text) {
        const a = measure(rendered.text);
        const b = measure(shipped);
        failures.push(
          `COMPILED-DRIFT '${key}' in ${locale}: the catalogue source renders ` +
            `${JSON.stringify(rendered.text)} (${a.encoding}, ${String(a.units)} unit(s), ` +
            `${String(a.segments)} segment(s)) and the COMMITTED COMPILED FUNCTION renders ` +
            `${JSON.stringify(shipped)} (${b.encoding}, ${String(b.units)} unit(s), ` +
            `${String(b.segments)} segment(s)) for the same binding. The measurement above is ` +
            'about the source; the product sends the compiled one. Run ' +
            '`pnpm --filter @kinvara/i18n build` and commit `compiled/`.',
        );
      }
    }
  }
  console.log(
    `  compiled artefact: ${String(compiledStrict.length)} strict key(s), locales ` +
      `[${compiledEnabled.join(', ')}]; ${String(compared)} SMS render(s) compared byte for byte ` +
      'against the source render',
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
