/**
 * THE SMS SEGMENT ARITHMETIC — T-046. PM §MVP-N1 AC3, SA §C7.
 *
 * A PURE MODULE WITH NO SIDE EFFECTS, split out of `tools/sms-segments.ts` for
 * one reason and it is worth stating: the gate ends in an unconditional
 * top-level `await main(...)`, exactly as `T-042`'s and `T-044`'s do, so that
 * `node tools/sms-segments.ts` CANNOT be made to exit 0 having run nothing. A
 * module-is-entry-point guard would have let the test file import the gate
 * directly — and would have put a branch between "the gate was invoked" and
 * "the gate ran", which is precisely the shape PROTOCOL §5.1 forbids: a harness
 * must never infer a verdict from a signal a no-op also produces. The
 * arithmetic lives here instead, and the gate and `tools/sms-segments.test.ts`
 * both import it.
 *
 * WHY THE OBVIOUS NUMBERS ARE WRONG. PM §MVP-N1 AC3(c) says "70 characters per
 * segment instead of 160". Those are the SINGLE-segment figures. A CONCATENATED
 * segment carries a 6-octet User Data Header, so:
 *
 *      GSM-7   160 septets single,  153 per segment when concatenated
 *      UCS-2    70 units   single,   67 per segment when concatenated
 *                          (6 octets = 48 bits = 7 septets = 3 UTF-16 units)
 *
 * "<= 2 segments" is therefore <= 306 SEPTETS or <= 134 UTF-16 CODE UNITS — not
 * 320 and not 140. A gate built on 70 and 160 is wrong in the direction that
 * LETS A THREE-SEGMENT MESSAGE THROUGH. Both sides of both boundaries are
 * asserted in `tools/sms-segments.test.ts`.
 */

/**
 * The GSM 03.38 seven-bit default alphabet, in table order, rows 0x00–0x7F.
 * `\u001b` at 0x1B is the ESCAPE position and is removed from the basic set
 * below: it is not a character anyone writes, it is the prefix of the extension
 * table.
 *
 * The ten Greek capitals at 0x10–0x1A are the reason trap 1 exists: a Greek
 * string is NOT automatically UCS-2, and the locale-based rule that assumes it
 * is rejects valid Greek copy.
 */
const GSM7_BASIC_TABLE =
  '@£$¥èéùìòÇ\nØø\rÅå' +
  'Δ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ' +
  ' !"#¤%&\'()*+,-./' +
  '0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNO' +
  'PQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmno' +
  'pqrstuvwxyzäöñüà';

/** The GSM 03.38 extension table. Each of these costs TWO septets: ESC + the code. */
const GSM7_EXTENSION_TABLE = '\f^{}\\[~]|€';

/** 127 characters: the 128 table positions less the ESCAPE at 0x1B. */
export const GSM7_BASIC: ReadonlySet<string> = new Set(
  [...GSM7_BASIC_TABLE].filter((c) => c !== '\u001b'),
);

/** 10 characters, each two septets. */
export const GSM7_EXTENSION: ReadonlySet<string> = new Set([...GSM7_EXTENSION_TABLE]);

/**
 * Septets, or `undefined` when the string is not GSM-7 encodable at all.
 *
 * Iterated by CODE POINT, so a non-BMP character is one iteration and falls
 * straight through to `undefined` — nothing outside the BMP is in either table.
 */
export function gsm7Septets(text: string): number | undefined {
  let septets = 0;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) septets += 1;
    else if (GSM7_EXTENSION.has(ch)) septets += 2;
    else return undefined;
  }
  return septets;
}

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface Measurement {
  readonly encoding: SmsEncoding;
  /** Septets for GSM-7; UTF-16 CODE UNITS for UCS-2. */
  readonly units: number;
  readonly segments: number;
  /** Units still available before this string would need a third segment. */
  readonly headroom: number;
  /** Non-BMP code points, each of which costs TWO UCS-2 units. Reported so trap 3 is measured. */
  readonly surrogatePairs: number;
}

/** Single-segment capacity, then per-segment capacity once a UDH is present. */
export const CAPACITY: Readonly<Record<SmsEncoding, { single: number; concatenated: number }>> = {
  'GSM-7': { single: 160, concatenated: 153 },
  'UCS-2': { single: 70, concatenated: 67 },
};

/** The budget this gate asserts, from PM §MVP-N1 AC3 / SA §C7. */
export const MAX_SEGMENTS = 2;

export function segmentsFor(encoding: SmsEncoding, units: number): number {
  const cap = CAPACITY[encoding];
  if (units <= cap.single) return 1;
  return Math.ceil(units / cap.concatenated);
}

/** The largest `units` value that still fits in `MAX_SEGMENTS`: 306 GSM-7, 134 UCS-2. */
export function budgetFor(encoding: SmsEncoding): number {
  return CAPACITY[encoding].concatenated * MAX_SEGMENTS;
}

/**
 * MEASURE the encoding; never infer it from the locale (trap 2). A string is
 * GSM-7 iff every one of its code points is in the basic or the extension
 * table; otherwise it is UCS-2 and is counted in UTF-16 CODE UNITS (trap 3),
 * which is what `String.prototype.length` returns.
 */
export function measure(text: string): Measurement {
  let surrogatePairs = 0;
  for (const ch of text) if (ch.length === 2) surrogatePairs += 1;
  const septets = gsm7Septets(text);
  const encoding: SmsEncoding = septets === undefined ? 'UCS-2' : 'GSM-7';
  const units = septets ?? text.length;
  return {
    encoding,
    units,
    segments: segmentsFor(encoding, units),
    headroom: budgetFor(encoding) - units,
    surrogatePairs,
  };
}
