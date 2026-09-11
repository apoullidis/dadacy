/**
 * `E164` — SD §DH-2. A phone number in ITU-T E.164 form: `+`, a first digit
 * 1–9, then 1–14 more digits (15 digits at most), no spaces or punctuation.
 *
 * This is a SHAPE check only. It does not claim the number is allocated, is a
 * mobile, or belongs to any country's numbering plan; the telephony adapter
 * owns that.
 */
import type { Brand } from './brand.ts';
import { InvalidInputError } from './errors.ts';

export type E164 = Brand<string, 'E164'>;

const E164_SHAPE = /^\+[1-9][0-9]{1,14}$/;

export function isE164(value: unknown): value is E164 {
  return typeof value === 'string' && E164_SHAPE.test(value);
}

export function e164(value: unknown, field: string): E164 {
  if (!isE164(value)) throw new InvalidInputError({ field });
  return value;
}
