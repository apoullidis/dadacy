/**
 * QUEUE PAYLOADS — `NotifyJobBase`, per SD §BE-14 (lines 1504–1511). T-147.
 *
 * SD §BE-14 line 1497: *"Every enqueued job payload carries `recipientLocale`,
 * stamped at enqueue time from the actor or recipient record — never looked up
 * when the job runs. There is no default."* Line 1504: *"every notify-bearing
 * job payload extends this"*. This module is that base, and nothing else.
 *
 * THIS IS NOT PART OF THE HTTP SURFACE. A job payload is an internal queue
 * contract, not a wire type: it is deliberately absent from
 * `COMPONENT_SCHEMAS`, so `openapi.json` and `src/generated/client.ts` do not
 * move when this file changes. `jobs.test.ts` › *jobs.ts is absent from the
 * OpenAPI document: a queue payload is not an HTTP wire type* asserts that,
 * and `pnpm gate:contract-drift` is the other reading of the same fact.
 *
 * WHY THE FIELDS ARE BRANDED AT THE TYPE LEVEL, not merely validated. The
 * failure SD §BE-14 exists to prevent is *silent*: an English safety SMS to a
 * Russian speaker at 22:40 succeeds at every layer — 200 from the provider,
 * `delivered` DLR, acknowledged-reach metric satisfied — and is useless to the
 * recipient. So `recipientLocale`'s INPUT type is `Locale`, the branded string
 * only `assertLocale` can produce (T-040 § Published contract §4), and
 * `recipientAccountId`'s is `Ulid`, which only T-023's constructor produces.
 * A caller that has not resolved a locale cannot type a payload at all; that
 * is SE-8 ("locale is a value carried on the work item, never read from
 * ambient context") turned into a compile error rather than a code review.
 *
 * WHAT THIS MODULE DOES NOT COVER — SD §BE-14 lines 1525–1532 list FOUR
 * recipients with NO ACCOUNT (a trusted contact on `/share/{token}`, a referee
 * on a reference form, an out-of-hours INT-10 caller, an SMS to a number with
 * no account). `recipientAccountId` is REQUIRED here because SD line 1506
 * makes it required, and SD states no payload shape for those four. That gap
 * is OD-90 G2, open with the stakeholder. **Do not extend this base with an
 * optional `recipientAccountId`, a union, or a placeholder to accommodate
 * them** — see state/EP-2/T-147.md § Published contract §5, which names each
 * of the four and its locale source.
 */
import { InvalidInputError, ulid, type Ulid } from '@kinvara/domain-types';
import { assertLocale, type Locale } from '@kinvara/i18n';
import * as z from 'zod';

/**
 * The refusal messages. Fixed strings: they name the rule, and they never
 * carry the rejected value (PROTOCOL §9.2 — no error payload echoes an input;
 * a job payload's rejected `recipientAccountId` is a subject identifier).
 * Exported so a caller or a test can assert the exact refusal rather than
 * "something threw".
 */
export const LOCALE_REFUSED =
  'recipientLocale must be an enabled locale from packages/i18n/locale-registry.json (SD §BE-14); the rejected value is not shown';
export const ULID_REFUSED = 'must be a canonical ULID (SD §BE-2); the rejected value is not shown';

/**
 * `typeof value === 'string'` before the constructor call NARROWS NOTHING:
 * `assertLocale` and `ulid` both already refuse every non-string, and the two
 * verdict-parity cases — `jobs.test.ts` ›
 * *LocaleSchema and assertLocale return the same verdict for every candidate*
 * and
 * *the ULID schema verdict is the domain-types constructor verdict, value for value*
 * — assert that over a shared corpus that includes non-strings.
 * It is here so a hostile `toString` never reaches
 * `assertLocale`'s message builder, which interpolates `String(value)`:
 * without it, `LocaleSchema.safeParse({ toString() { throw … } })` THROWS out
 * of `safeParse` instead of returning a refusal. Held by *a value whose
 * String() throws is refused cleanly, not by throwing out of safeParse*.
 *
 * The `catch` re-throws anything that is not the constructor's own refusal, so
 * a programming error inside `@kinvara/i18n` cannot read as "not a locale".
 */
function isRegisteredLocale(value: unknown): value is Locale {
  if (typeof value !== 'string') return false;
  try {
    assertLocale(value);
    return true;
  } catch (error: unknown) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * The ULID check goes through T-023's CONSTRUCTOR, not through a second
 * regular expression: `packages/contracts` must never hold its own idea of
 * what a ULID is. `isUlid` is the predicate `ulid()` itself uses, and
 * `jobs.test.ts` ›
 * *the ULID schema verdict is the domain-types constructor verdict, value for value*
 * checks all three readings agree.
 */
function isUlidValue(value: unknown): value is Ulid {
  if (typeof value !== 'string') return false;
  try {
    ulid(value, 'recipientAccountId');
    return true;
  } catch (error: unknown) {
    if (error instanceof InvalidInputError) return false;
    throw error;
  }
}

/**
 * SD §BE-14 line 1507 names `LocaleSchema` and nothing in the repository
 * defined it (OD-90 F10, G3). IT LIVES HERE, and it is **not** a second locale
 * list: it delegates to `assertLocale`, which T-040 § Published contract §4
 * calls *"The only supported way to obtain a `Locale`. One parameter, no
 * fallback"*. The locale set stays DATA in `packages/i18n/locale-registry.json`
 * (SA §TS-12.2 rule 5) — adding Turkish is a row there, not an edit here.
 *
 * The cost, stated because it is a real one: this is the first
 * `@kinvara/contracts` → `@kinvara/i18n` dependency edge. See § Published
 * contract §3 for what survives `gate:deps` and what that gate does NOT model.
 */
export const LocaleSchema = z.custom<Locale>(isRegisteredLocale, {
  message: LOCALE_REFUSED,
});

/** A canonical ULID, as `@kinvara/domain-types` defines one. */
export const UlidSchema = z.custom<Ulid>(isUlidValue, { message: ULID_REFUSED });

/**
 * SD §BE-14 lines 1504–1511, verbatim in its three fields.
 *
 * `strictObject`, so an unknown key is REFUSED rather than stripped. A plain
 * `z.object` strips it silently (measured in T-022 deviation 2), and a job
 * payload that silently loses a field is the same class of failure as one that
 * silently loses a locale.
 *
 * `.extend()` PRESERVES BOTH properties — measured, not assumed, because SD
 * line 1504 makes every notify-bearing payload an extension of this one, and
 * a base whose guarantees evaporate on extension would guarantee nothing.
 * Held by *an extension of NotifyJobBase still refuses an unknown key* and
 * *an extension of NotifyJobBase still requires recipientLocale*.
 *
 * `enqueuedAt` is `z.string().datetime()`, exactly as SD line 1510 writes it.
 * MEASURED WIDTH: Zod 4.5.4's `.datetime()` accepts a `Z` terminator only — a
 * numeric UTC offset (`2026-09-19T00:00:00+02:00`) is REFUSED, and so is a
 * bare date. Held by *enqueuedAt accepts only a Z-terminated ISO datetime*.
 */
export const NotifyJobBase = z.strictObject({
  recipientAccountId: UlidSchema,
  recipientLocale: LocaleSchema,
  enqueuedAt: z.string().datetime(),
});

/** What a validated notify job payload IS. */
export type NotifyJobBasePayload = z.infer<typeof NotifyJobBase>;

/**
 * What a caller must SUPPLY. Identical to the payload type here (no field
 * transforms), and named separately because the compile refusal in
 * `type-tests/jobs-refusals.ts` is about the input side.
 */
export type NotifyJobBaseInput = z.input<typeof NotifyJobBase>;
