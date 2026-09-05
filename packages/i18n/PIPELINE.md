# The trilingual safety-copy pipeline

**Owner:** `T-049` (front-end / i18n) · **Register:** [`review.json`](./review.json) `§ pipeline`
**Specs:** SD §DH-5 external dependency 2 · SA §TS-12.4 · PM §MVP-L4 AC4, §MVP-L5 AC7, §MVP-IS5 AC7 · DV-7, DV-11 · SD Revision Log D8
**Status on 2026-09-05:** engineering side complete; **external side not started, and blocked on a stakeholder.**

---

## 0. Read this first

This document describes how a `safety_critical` string gets from _authored_ to
_signed off_, and **who must exist for each step**. It exists because SD §DH-5
identifies this pipeline as one of the two external dependencies that can slip
the whole programme:

> **Six weeks of lead time on a path that has no engineering dependency and therefore gets scheduled last by default.**

Two things this document deliberately does **not** contain:

1. **Any safety copy.** Not English, not Greek, not Russian. Every
   `safety_critical` string in the catalogues today is an **engineering
   placeholder** written by `T-040` to exercise the compile, gate and render
   mechanisms. It is recorded as `provenance: "placeholder"` in `review.json`
   and it must not ship. Writing copy here that _read_ as reviewed would be the
   exact failure this whole mechanism exists to prevent — an English SMS
   delivered to a Russian speaker succeeds at every layer, returns 200, raises
   no alarm, and is discovered when it matters least.
2. **The Greek and Russian prohibited-claim lists.** Those are `T-043`'s, and
   PM §MVP-L4 AC6 requires them to be **enumerated by a native speaker rather
   than machine-derived**. Pre-writing them from the English list would produce
   a satisfied-looking artefact that checks nothing. See §6.

---

## 1. The flow

Straight from SA §TS-12.4, with the mechanism each step lands in.

```
                 ┌──────────────────────────────────────────────────────┐
                 │  1. AUTHOR — English and Greek IN PARALLEL           │
                 │     Greek-authoring safeguarding practitioner        │
                 │     NOT English-then-translate.                      │
                 └───────────────────────┬──────────────────────────────┘
                                         │
                 ┌───────────────────────▼──────────────────────────────┐
                 │  2. BRIEF the Russian translator on the              │
                 │     SAFEGUARDING CONTEXT — before translating        │
                 │     (a translator who does not know a string is an   │
                 │      escalation message will produce a grammatically │
                 │      perfect, operationally useless one)             │
                 └───────────────────────┬──────────────────────────────┘
                                         │
                 ┌───────────────────────▼──────────────────────────────┐
                 │  3. TRANSLATE ru — briefed professional human.       │
                 │     Machine translation is prohibited outright at    │
                 │     this tier (DV-11) and cannot produce a record.   │
                 └───────────────────────┬──────────────────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                │
┌───────▼─────────┐        ┌─────────────▼──────────┐      ┌──────────────▼────────┐
│ 4. DSL SIGN-OFF │        │ 5. IN-CONTEXT REVIEW   │      │ 6. READ-ALOUD PASS    │
│    PER LOCALE   │        │    running product,    │      │    voice + spoken     │
│    → review.json│        │    360 px Android      │      │    strings (DV-7)     │
└─────────────────┘        └────────────────────────┘      └───────────────────────┘
        │
        └──► gate:safety-review-currency (T-044) goes green for that key+locale
```

Steps 4, 5 and 6 are all **blocking** in `review.json § pipeline.stages`, and a
record signed off while any of them is incomplete is reported as an
incoherence by `pipelineIncoherences()`. Step 5 needs `T-050`/`T-051`'s surfaces
to exist; it cannot complete before they do, and it must not be recorded as
though it had.

## 2. Who must exist

There is no way to do this without these people. Naming them is a stakeholder
act — no agent in this programme can engage a practitioner or contract a
translator, and none has tried.

| Role in `pipeline.roles`                    | Who                                                                      | Why this specific person, and not a substitute                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `greek_authoring_safeguarding_practitioner` | A safeguarding practitioner working **in Cyprus**                        | The copy encodes the **Cyprus** reporting pathway — 112, 199, 116 111, 1466, Social Welfare Services — not a UK one. A translator, however good, cannot author a safeguarding instruction; and PM §MVP-L4 AC4 and §MVP-S7 AC1 both require Greek **authorship**, in parallel with English, not Greek translation |
| `russian_translator_briefed`                | A professional translator, **briefed on the safeguarding context first** | The brief is a separate, separately-recorded stage precisely because it is the step that gets skipped. SA §TS-12.4 states the failure in these words: _a translator who does not know a string is an escalation message will produce a grammatically perfect, operationally useless one_                         |
| `dsl` + `dsl_deputy`                        | The Designated Safeguarding Lead and deputy                              | Only these two names may appear in `reviewed_by`. **Between them they must cover English, Greek and Russian** (PM §MVP-L5 AC7): a DSL who cannot read Russian cannot sign off Russian copy, and the deputy is how that is covered. This is why the roster has four rows and not three                            |

Each role carries `named` and `confirmed_by_stakeholder_on`, both `null` today.

## 3. How a sign-off is recorded, and what un-does it

One record per `safety_critical` key **per locale**, in `review.json § entries`
(shape published by `T-040`; unchanged by this ticket):

```jsonc
"safety.sos.confirm": {
  "content_hash": "sha256:…",              // over the NFC-normalised UTF-8 source
  "provenance":   "authored",              // or "translated_professional"
  "status":       "signed_off",
  "authored_by":  "Name, role",
  "reviewed_by":  "Name, role (DSL)",
  "reviewed_at":  "2026-10-14T09:00:00Z"
}
```

**Editing a safety string changes its hash and therefore un-signs it. That is the
mechanism, not a side effect.** A reviewed Greek string cannot vouch for an
unreviewed Russian one, because the register is keyed by locale as well as key.

`gate:safety-review-currency` (`T-044`) fails unless, for every
`safety_critical` key and every enabled locale, a record exists whose
`content_hash` matches the current source, whose `status` is `signed_off`, whose
`provenance` is not `placeholder`, and which names a reviewer and a date —
**unless** the key sits inside an unexpired `pending_pipeline` waiver.

### What stops a record saying "reviewed" when nothing was reviewed

Asked and answered as directly as it can be, because the honest answer is not
"nothing".

**It cannot be prevented outright.** This register lives in the same repository
as the copy it vouches for, so a determined edit can write a sign-off that never
happened. `content_hash` binds a record to the _current_ source — it proves
**currency, not review**. Nothing here is a cryptographic countersignature from
an external party, and this document does not claim one.

What the predicates in `pipelineIncoherences()` buy is that a forged sign-off is
**no longer a one-word edit**. To make one, all of the following must be written
in the same commit, in the file whose entire subject is provenance:

| Predicate                                                  | The forgery it refuses                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `provenance` must equal the method the assignment required | Greek produced by translating the English and recorded as if authored                                                 |
| `authored_by ≠ reviewed_by`                                | The author signing off their own safety copy                                                                          |
| `reviewed_by` ∈ the named DSL or deputy                    | A sign-off by whoever happened to be editing                                                                          |
| that person carries `confirmed_by_stakeholder_on`          | A DSL invented in the same commit                                                                                     |
| every **blocking** stage `completed_at` is set             | Russian translated by a competent professional who was **never briefed** — the most likely real-world version of this |
| `channel ≠ "undetermined"`                                 | A string signed off before anyone decided whether it is spoken aloud, so the read-aloud pass silently did not apply   |

Each of those is proven in `src/pipeline.test.ts` by **constructing** the
forgery and asserting it comes back as a problem.

## 4. The strings — eight keys, three locales, 24 records

All eight are `safety_critical` and all 24 records are `provenance: "placeholder"`
today. The **Intent** column is what the string is _for_; it is not approved
copy and the English placeholder in the catalogue is not either.

| Key                                | Intent                                                                                                                                                                                                                  | Channel                | Emergency panel? |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------- |
| `safety.emergency.call_112.label`  | The button that dials **112**, the single emergency number for police, ambulance and fire                                                                                                                               | screen                 | yes              |
| `safety.emergency.call_112.script` | What the caller **says aloud** to the 112 operator, with the booking address substituted                                                                                                                                | **spoken by the user** | yes              |
| `safety.emergency.address_prompt`  | Instructs the caller to read the address to the operator; rendered at display size, and it is what shows when the network is gone                                                                                       | **spoken by the user** | yes              |
| `safety.helpline.116111.label`     | The pan-EU child and adolescent helpline, operated in Cyprus by Hope For Children CRC Policy Center                                                                                                                     | screen                 | yes              |
| `safety.helpline.1466.label`       | The Hope For Children line — abuse, neglect, bullying, cyberbullying, grooming. **The operational relationship between 1466 and 116 111 is unverified (PM §Q16) and the labelling must be confirmed with the operator** | screen                 | yes              |
| `safety.helpline.199.label`        | The alternative national emergency number, same dispatch. **A documented fallback — 112 is the primary and the one used in all copy and all training**                                                                  | screen                 | yes              |
| `safety.sos.confirm`               | The SOS confirmation on the session screen: hold to send, an operator calls back                                                                                                                                        | screen                 | no               |
| `session.checkins_missed`          | An escalation-ladder message — _N_ missed check-ins. **Russian has four plural categories** and this string is wrong on 2, 3, 4, 5, 11, 22, 111 … if only `one`/`other` are supplied                                    | **undetermined**       | no               |

Two constraints that bind the authors, not just the engineers:

- **112 is the only number this product dials.** 199, 116 111 and 1466 are
  _labelled panel entries_. **999, 101, NHS 111, MASH, LADO and NSPCC do not
  exist in this product** and a UK number in a Cyprus safety panel is a safety
  defect, not a copy defect.
- **`session.checkins_missed` needs all four Russian plural forms** — `one`,
  `few`, `many`, `other`. A two-form Russian catalogue compiles, renders and is
  silently wrong; that is measured in `tools/compile.test.ts`.

`session.checkins_missed`'s channel is **`undetermined` on purpose and fails
closed.** DV-7 adds an automated **voice** rung with pre-recorded audio per
locale (SA §INT-5r), and whether this key rides that rung is `T-105`/`T-107`'s
determination. Until it is made, a read-aloud pass may or may not be required —
so the register refuses sign-off rather than dropping the question.

## 5. What a human must do next — and by when

**By 2026-10-17** `gate:safety-review-currency` starts failing the build on all
24 records. That is the waiver `T-040` opened, and it is deliberately
self-closing.

**The problem is that the waiver window _is_ the lead time.** `opened_at`
2026-09-05 → `expected_by` 2026-10-17 is exactly **42 days**, and 42 days is SD
§DH-5's six-week external lead time verbatim. So:

```
latest_external_start  =  deadline − lead time  =  2026-10-17 − 42 days  =  2026-09-05
```

**There is no slack.** Recorded as **OD-15** in `tasks/state/decisions.md`, and
asserted in `src/pipeline.test.ts` against the deadline and the lead time
written there as literals, so the value cannot be nudged later to make the
schedule look survivable.

### The ask, in order

1. **Name the four people** and fill `named` +
   `confirmed_by_stakeholder_on` in `review.json § pipeline.roles`: the
   Greek-authoring safeguarding practitioner, the Russian translator, the DSL
   and the deputy. §MVP-L5 AC7 requires the DSL pair to cover all three
   languages between them, so check that before confirming them.
2. **Send Appendix A** to the practitioner and **Appendix B** to the
   translator. Both are written to be sent as they stand.
3. **Record `external_start`** on the day the brief is _actually delivered_ —
   not the day it is written, and not in advance. An undated start cannot be
   measured against a lead time.
4. **If the brief cannot be delivered by 2026-09-05**, then the 2026-10-17
   deadline is already unachievable and the honest move is a recorded
   orchestrator decision against **BOARD RK-2** that moves `expected_by` **and**
   the `2026-10-17` anchor in `src/review.test.ts` together, with the new date
   justified. **Do not** let the date arrive and be repaired under pressure: the
   cheapest repair at that point is deleting the waiver, and deleting the waiver
   deletes the only record saying this copy is unreviewed.

Doing neither (1)–(3) nor (4) means the build fails on 2026-10-18 with no
prepared answer.

## 6. Also on this engagement — `T-043`'s prohibited-claim lists

Not this ticket's deliverable, and stated here because **the same two people are
the only route to it** and it is on the same six-week clock.

`packages/i18n/prohibited/{el,ru}.json` do not exist and are **deliberately
absent rather than empty** — an empty file there would read as a satisfied
dependency. PM §MVP-L4 AC6 requires the Greek and Russian equivalents of the
banned claims to be **enumerated by a native speaker**, not machine-derived from
the English. The English list is a fixed set of testable constants:

> Never: _"24/7 support"_, _"24/7 staffed"_, _"always on"_, _"round-the-clock team"_, _"someone is always watching"_, _"continuously monitored"_, _"live monitoring"_, _"real-time checks"_, _"always up to date"_, _"we check daily/weekly"_.
>
> Permitted, exactly: _"Re-verified every 12 months"_, _"Attested every 90 days"_, _"Re-checked immediately on any concern"_.

> **Note for `T-043`, which will build `gate:prohibited-claims`:** this document
> quotes the banned English phrases verbatim, above. `T-040`'s contract scopes the
> gate to `catalogues/**`, which excludes this file — **keep it scoped.** A gate
> widened to `packages/i18n/**` would fail on the document that explains it, and
> the obvious repair would be to soften the quotes here until the list is no
> longer testable. The gate must still **fail closed on the absent
> `prohibited/{el,ru}.json` path**, which is a different rule and is not relaxed
> by this one.

What is needed from a native speaker is **the phrases a Greek or Russian
copywriter would actually reach for to make the same claim** — which are not
translations of these, and are the reason a translated list would pass while
checking nothing. Appendix A and Appendix B each ask for it.

## 7. Limits of this document, stated rather than discovered

- **No copy is authored, translated or reviewed here**, and none can be from
  inside this repository.
- **The register cannot prove review, only currency and coherence** (§3).
- **Stage 5, the in-context screenshot review, cannot begin** until `T-050` /
  `T-051` render these strings in a running product at 360 px.
- **`session.checkins_missed`'s channel is undetermined** and depends on
  `T-105`/`T-107`.
- **`safety.helpline.1466.label`'s labelling is unverified** (PM §Q16) and must
  be confirmed with the operator before launch — a copy review cannot settle it.

---

# Appendix A — brief for the Greek-authoring safeguarding practitioner

> Send as it stands. Fill the bracketed fields.

**Engagement.** Author the safety-critical user-facing copy for a Cyprus
childcare-booking platform, **in English and Greek in parallel**, for eight
strings. Six of them are the in-app emergency panel.

**The single most important instruction: do not write English and then have it
translated into Greek.** Greek is authored, not translated. A Greek translation
of an English safeguarding instruction is a different artefact from a Greek
safeguarding instruction, and the platform's build rules record which one it
received.

**Context you need in order to write these.**

- The product is used by parents and by sitters during a booked childcare
  session in the **Republic of Cyprus**. Users are English-, Greek- or
  Russian-speaking, and they receive **identical safeguarding**, not a
  translated veneer.
- **112** is the single emergency number this product dials, for police,
  ambulance and fire. **199** is a documented alternative feeding the same
  dispatch, shown as a labelled entry only. **116 111** is the pan-EU child and
  adolescent helpline; **1466** is the Hope For Children line. UK numbers —
  999, 101, NHS 111 — and UK bodies — MASH, LADO, NSPCC — are **not in this
  product** and must not appear.
- These strings are read by a frightened adult, on a phone, possibly with a
  child present, possibly with no network. Two of them are **read aloud to a
  112 operator**.
- Several are shown on a **360 px-wide** Android screen. Length is a safety
  property, not a style preference.

**The eight strings**, with what each is for. _(The English shown in the
codebase today is an engineering placeholder written to test the build. It is
not approved copy and you are not editing it — please write these fresh.)_

1. `safety.emergency.call_112.label` — the label on the button that dials 112.
2. `safety.emergency.call_112.script` — **what the caller says aloud** to the
   112 operator. The booking address is substituted into it as `{address}`.
3. `safety.emergency.address_prompt` — tells the caller to read the address to
   the operator; `{address}` is substituted. This is the string that renders at
   display size when the network is gone.
4. `safety.helpline.116111.label` — label for the child and adolescent helpline.
5. `safety.helpline.1466.label` — label for the Hope For Children line, covering
   abuse, neglect, bullying, cyberbullying and grooming. _(Please flag if the
   relationship between 1466 and 116 111 as stated here is wrong; we have not
   been able to confirm it with the operator.)_
6. `safety.helpline.199.label` — label for the alternative emergency number.
7. `safety.sos.confirm` — the SOS control on the session screen: the user holds
   it to send an alert, and a trained operator calls them back.
8. `session.checkins_missed` — an escalation message sent when a sitter has
   missed _N_ scheduled check-ins. It takes a count, so it needs the correct
   plural forms.

**Two further asks while we have you.**

- **A Greek prohibited-claims list.** We are forbidden from claiming continuous
  or 24/7 supervision, and a build check enforces it in every language. In
  English the banned phrases are _"24/7 support"_, _"24/7 staffed"_, _"always
  on"_, _"round-the-clock team"_, _"someone is always watching"_, _"continuously
  monitored"_, _"live monitoring"_, _"real-time checks"_, _"always up to date"_,
  _"we check daily/weekly"_; the only permitted claims are _"Re-verified every
  12 months"_, _"Attested every 90 days"_ and _"Re-checked immediately on any
  concern"_. **We do not want these translated.** We want the phrases a Greek
  copywriter would actually reach for to make the same over-claim — which are
  usually not translations of ours.
- **A read-aloud check** on strings 2 and 3, spoken by someone who has not read
  them, to confirm they survive being said under stress.

**Deliverable and timing.** Eight English strings, eight Greek strings, the
Greek prohibited-claims list, and your name and role as they should be recorded
against the copy. Lead time budgeted: **six weeks** from the day you receive
this. **Please confirm the date you received it**, because the platform's build
records that date and measures against it.

**Sign-off.** Your copy is reviewed and signed off separately by the platform's
Designated Safeguarding Lead. Sign-off by the author is not accepted, and the
system enforces that.

---

# Appendix B — brief for the Russian translator

> Send as it stands. **Do not send the strings until the translator has
> acknowledged this brief** — the acknowledgement is a recorded stage, and it is
> the stage that gets skipped.

**Engagement.** Translate eight safety-critical strings from the authored
English and Greek into Russian, for a childcare-booking platform used in the
Republic of Cyprus.

**Why you are being briefed before you see the strings.** These are not product
copy. Each one is part of an emergency or escalation pathway, and a translation
that is grammatically perfect but operationally wrong is worse than no
translation, because it succeeds silently — it renders, it passes every check,
and it fails at the only moment it matters. You need to know what each string
_does_, and the list below tells you.

**Context.**

- The reader is a Russian-speaking parent or sitter in Cyprus, on a phone,
  during or around a childcare session, often under stress.
- **112** is the emergency number. **199**, **116 111** and **1466** are labelled
  entries and are _not_ dialled by the product. UK numbers and UK bodies do not
  appear.
- Two strings are **read aloud by the user to a 112 operator**. They must be
  sayable, not merely readable.
- **Machine translation is prohibited outright for these strings** and the
  platform cannot record a machine-produced translation as reviewed. This is a
  rule about the artefact, not a comment on quality.
- Several are shown on a **360 px-wide** Android screen. Russian expands
  relative to English; where a shorter form is safe, prefer it, and where it is
  not, say so rather than truncating meaning.

**The eight strings and what each does** — the same list as Appendix A, items
1–8, supplied with the authored English and Greek.

**Plurals — the one technical constraint.** `session.checkins_missed` takes a
count. **Russian uses four plural categories: `one`, `few`, `many`, `other`.**
Supplying only two is a common failure and the result is silently wrong on 2, 3,
4, 5, 11, 22, 111 and many other counts. All four forms are required.

**Also.** A **Russian prohibited-claims list** — the phrases a Russian
copywriter would reach for to claim continuous or 24/7 supervision. Please do
**not** translate our English list; we need the phrases that would actually be
used, which are usually different.

**Deliverable and timing.** Eight Russian strings with all four plural forms
where required, the Russian prohibited-claims list, notes on anything you could
not render safely, and your name and role as they should be recorded against the
copy. Lead time budgeted: **six weeks**.

**Sign-off.** Your translation is reviewed and signed off by the platform's
Designated Safeguarding Lead or deputy, who reads Russian. Sign-off by the
translator is not accepted, and the system enforces that.
