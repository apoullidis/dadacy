/**
 * The pins for OE-82's automated checks — T-263 (`gate:read-aloud`).
 *
 * A BUILD-TIME module under `tools/`, outside `package.json` `exports`, so no
 * browser or server import can reach it (asserted in
 * `tools/read-aloud.test.ts`). Every value here is written as a LITERAL and is
 * NEVER read from `review.json`, the catalogues or the record: a check that took
 * its own scope from the file it checks would be checking that the file agrees
 * with itself (PROTOCOL §5.1). `T-264` adds its render pins to this file.
 *
 * Changing a value here is a reviewed edit with its own reason:
 *   - `READ_ALOUD_KEYS_PINNED` moves in the SAME commit as a `review.json`
 *     channel change, or `gate:read-aloud` is red `CHANNEL-DRIFT`;
 *   - `CHECK_TOOLS` moves with `.tool-versions` (a Vitest case compares them);
 *   - a budget is an engineering default from `state/EP-0/OE-82-cut.md` §3;
 *     MOVING ONE IS AN OD ENTRY in `decisions.md`, never a convenience edit,
 *     and never the answer to copy that fails it (OE-83 Q3 is open).
 */

/** The spoken channels, as `review.json`'s `pipeline.assignments[*].channel` spells them. */
export type SpokenChannel = 'spoken_by_user' | 'voice' | 'undetermined';

/**
 * Every key whose copy-review channel is not `screen`, with that channel, as it
 * stood on 2026-10-16 (`main` 1207b64). `undetermined` is here because it fails
 * closed (T-049 § contract §3: it counts as applying). 3 keys x 3 enabled
 * locales = 9 pairs.
 */
export const READ_ALOUD_KEYS_PINNED: Readonly<Record<string, SpokenChannel>> = {
  'safety.emergency.address_prompt': 'spoken_by_user',
  'safety.emergency.call_112.script': 'spoken_by_user',
  'session.checkins_missed': 'undetermined',
};

/** The synthesiser, equal to `.tool-versions`' `espeak-ng` line (T-262 § contract §1). */
export const CHECK_TOOLS = { 'espeak-ng': '1.51' } as const;

/** The literal every record's `checked_by` must carry. Never a person (OE-5, OE-82). */
export const CHECKED_BY = 'automation:gate:read-aloud';

/** `espeak-ng -v <voice>` per locale; resolves to gmw/en, grk/el, zle/ru (T-262 § contract §3). */
export const VOICES: Readonly<Record<string, string>> = { en: 'en', el: 'el', ru: 'ru' };

/**
 * Numbers that may be spoken (PROTOCOL §9 item 7): 112 is the only number the
 * SOS flow dials; 199, 116 111 and 1466 are labelled panel entries. A digit run
 * in a form's template text — spaces inside it allowed — must be exactly one of these.
 */
export const SPOKEN_NUMBERS: readonly string[] = ['112', '199', '1466', '116 111'];

/** Words exempt from R2 (mixed script) and R4 (acronym), and from R1's script test. */
export const SPOKEN_TOKENS_ALLOWED: readonly string[] = ['Kinvara', 'SOS'];

/** Duration budgets, ms, per channel. Defaults from OE-82-cut §3 (SD §INT-H.1 prices a 45 s rung). */
export const DURATION_BUDGET_MS: Readonly<Record<SpokenChannel, number>> = {
  spoken_by_user: 20_000,
  undetermined: 20_000,
  voice: 30_000,
};

/** R5: at most this many words in one sentence. Default from OE-82-cut §3. */
export const MAX_WORDS_PER_SENTENCE = 20;

/**
 * R1's speakable punctuation, for every locale: `. , ; : ? ! — – ' ’ " “ ” « » ( )`
 * plus U+037E GREEK QUESTION MARK, exactly the cut's list. Letters of the
 * locale's script, decimal digits and U+0020 SPACE are speakable as well.
 * U+002D HYPHEN-MINUS is NOT in the list: it is admitted only by the OD-356 rule below.
 */
export const SPEAKABLE_PUNCTUATION = '.,;:?!—–\'’"“”«»();';

/**
 * OD-356 (ruled 2026-10-16T08:48:17Z, orchestrator: option (b), narrowly).
 * R1 admits U+002D HYPHEN-MINUS ONLY WORD-INTERNALLY: immediately between two
 * letters of the same script, as in `check-in`. Everywhere else it stays
 * UNSPEAKABLE-CHAR: standalone, leading or trailing a word, doubled (`--`),
 * next to a digit (`112-199`, `-5`), next to a `{param}` or `#` inert token,
 * or between letters of two scripts (which R2 refuses as well). Measured, in
 * state/EP-0/T-263.md: espeak-ng 1.51 voices no phoneme for the word-internal
 * hyphen of `check-in`, and reads `112-199` with a spoken "dash".
 * Implemented in tools/read-aloud.ts `wordInternalHyphen()`.
 */

/** The script whose letters a locale's copy is written in (Unicode `Script=` value). */
export const LOCALE_SCRIPT: Readonly<Record<string, 'Latin' | 'Greek' | 'Cyrillic'>> = {
  en: 'Latin',
  el: 'Greek',
  ru: 'Cyrillic',
};

/**
 * The FIXTURE every `{param}` is spoken with. Fictional; no real address is
 * checked (§ contract bound). Each value must itself pass R1 for its locale.
 */
export const FIXTURE_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: { address: '12 Example Street, Nicosia 1065', sitterName: 'Maria' },
  el: { address: 'Οδός Παραδείγματος 12, Λευκωσία 1065', sitterName: 'Μαρία' },
  ru: { address: 'улица Примерная 12, Никосия 1065', sitterName: 'Мария' },
};

/**
 * The count each CLDR cardinal category is spoken with. The tool refuses a
 * fixture whose count `Intl.PluralRules` does not put in that category
 * (`FIXTURE-WRONG-CATEGORY`), so this cannot silently exercise the wrong branch.
 */
export const FIXTURE_PLURAL_COUNTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  en: { one: 1, other: 3 },
  el: { one: 1, other: 3 },
  ru: { one: 1, few: 3, many: 5, other: 1.5 },
};
