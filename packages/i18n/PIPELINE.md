# The trilingual safety-copy pipeline

**Owner:** `T-049` (front-end / i18n) · **Register:** [`review.json`](./review.json) `§ pipeline`
**Specs:** SD §DH-5 external dependency 2 · SA §TS-12.4 · PM §MVP-L4 AC4, §MVP-L5 AC7, §MVP-IS5 AC7 · DV-7, DV-11 · SD Revision Log D8
**Status on 2026-09-05:** engineering side complete; **external side not started, and blocked on a stakeholder.**
**Status on 2026-09-28 (`T-233`):** the copy exists and is **AI-authored, not reviewed.** Stakeholder rulings **OE-66** (2026-09-27T18:54:51Z) and **OE-67** (2026-09-27T19:27:39Z) made an AI model — Claude Opus (`claude-opus-5-5`) — the **author** of all `el` and `ru` copy, the `el`/`ru` prohibited-claim lists, and the eight `en` `safety_critical` strings (`decisions.md` EV-16). **OE-68** kept the banned-claims list as it stands. **Nothing is signed off: the named human DSL and deputy review is unchanged by all three rulings, and neither person is named.** See §2 and §7.
**Decision review date: 2026-12-05** (re-anchored once from 2026-10-17 — §5).

---

## 0. Read this first

This document describes how a `safety_critical` string gets from _authored_ to
_signed off_, and **who must exist for each step**. It exists because SD §DH-5
identifies this pipeline as one of the two external dependencies that can slip
the whole programme:

> **Six weeks of lead time on a path that has no engineering dependency and therefore gets scheduled last by default.**

Two things this document deliberately does **not** contain:

1. **Any safety copy.** Not English, not Greek, not Russian. The copy lives in
   the catalogues. Until `T-233` every `safety_critical` string there was an
   **engineering placeholder** written by `T-040`; since `T-233` every one is
   **AI-authored** under OE-66/OE-67 and recorded as `provenance:
"ai_authored"` in `review.json`, at `status: "pending_review"`. **It is not
   reviewed and it must not ship until it is.** Writing copy that _read_ as
   reviewed would be the exact failure this whole mechanism exists to prevent —
   an English SMS delivered to a Russian speaker succeeds at every layer,
   returns 200, raises no alarm, and is discovered when it matters least.
2. **The Greek and Russian prohibited-claim lists.** They are in
   `prohibited/{el,ru}.json`, **AI-authored under OE-66** — a stakeholder-accepted
   deviation from PM §MVP-L4 AC6's "enumerated by a native speaker" (EV-16).
   `T-043` builds the gate over them. See §6.

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

### Who actually authored the copy now in the catalogues — OE-66 / OE-67

Stated plainly, because the table above describes the pipeline as specified
and the rulings changed who did the first half of it:

| What                                                              | Author                                                                                   | Ruling                              | Reviewed by |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- | ----------- |
| Every `el` catalogue key, safety and non-safety                   | Claude Opus (`claude-opus-5-5`), AI agent                                                | OE-66 (EV-16), 2026-09-27T18:54:51Z | **nobody**  |
| Every `ru` catalogue key, safety and non-safety                   | Claude Opus (`claude-opus-5-5`), AI agent                                                | OE-66 (EV-16), 2026-09-27T18:54:51Z | **nobody**  |
| `prohibited/el.json`, `prohibited/ru.json`                        | Claude Opus (`claude-opus-5-5`), AI agent                                                | OE-66 (EV-16)                       | **nobody**  |
| The eight `en` `safety_critical` keys, and their meaning contract | Claude Opus (`claude-opus-5-5`), AI agent                                                | OE-67, 2026-09-27T19:27:39Z         | **nobody**  |
| Every other `en` key                                              | unchanged by `T-233` (byte-identical to `main` at `3d52098`); `T-040`'s engineering copy | —                                   | **nobody**  |

- **The practitioner and the translator are displaced for this copy, not
  abolished.** Their roles and stages stay in the register: if the stakeholder
  later engages humans to author or re-author, that is the path, and it is
  unchanged.
- **The DSL and the deputy are NOT displaced.** OE-66 says so in terms: the
  DSL + deputy review (`reviewed_by`, PM §MVP-L5 AC7) is unchanged — still
  humans, still unnamed. **The milestone still needs both named and confirmed**
  (`pipeline.roles.dsl`, `pipeline.roles.dsl_deputy`), and it still needs their
  per-locale sign-off, the 360 px in-context review and the read-aloud pass.
  No AI agent can do any of those, and the register refuses a model in
  `reviewed_by` (§3).
- The drafts, their authors' notes and the meaning contract the `el`/`ru`
  safety strings were aligned to are in
  `tasks/state/EP-0/OE-66/{en,el,ru}/` (`en/MEANING.md` is the contract). They
  are inputs to this package, not part of it.

## 3. How a sign-off is recorded, and what un-does it

One record per `safety_critical` key **per locale**, in `review.json § entries`
(shape published by `T-040`; `T-049` left it unchanged; **`T-233` widened it
additively** — one provenance value, `ai_authored`, and one optional field,
`ruling`, present exactly when that value is):

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

What every one of the 24 records actually says today (`T-233`):

```jsonc
"safety.sos.confirm": {
  "content_hash": "sha256:…",              // current: the landed AI-authored copy
  "provenance":   "ai_authored",
  "status":       "pending_review",        // NOT signed off
  "authored_by":  "Claude Opus (claude-opus-5-5), AI agent",
  "ruling":       "OE-66",                 // "OE-67" for en
  "reviewed_by":  null,                    // no DSL or deputy is named
  "reviewed_at":  null
}
```

**The provenance rule for a model author (OE-66 / OE-67).** A record may name
an AI model as `authored_by` only when **all** of these hold, and each is
checked at **every** status, not only at sign-off:

1. `provenance` is `"ai_authored"` and `ruling` is present — both or neither;
2. `ruling` is a stakeholder ruling that makes a model an author. The rulings
   are **not** in `review.json`: they are a literal in `src/pipeline.test.ts`
   (`AI_RULINGS`, transcribed from `decisions.md`) passed into
   `pipelineIncoherences()`, whose default is **no rulings**, so any other
   caller refuses every `ai_authored` record. A register that listed its own
   authority could widen it in the same commit as the record that needs it;
3. the ruling covers the record's locale (OE-66: `el`, `ru`; OE-67: `en`);
4. `authored_by` is **exactly** the model the ruling names — never a human
   name, never another engine; and
5. that model is not a named person in `pipeline.roles`.

An `ai_authored` record is **authored, never reviewed.** For it to become
`signed_off`, everything in the table below that concerns the **review** still
applies unchanged: a named, stakeholder-confirmed DSL or deputy in
`reviewed_by`, a `reviewed_at` in range, every review stage complete, and a
decided channel. Two things are different, and only two: the ruling stands in
for "provenance equals the method" and for the author-role rows (the model has
no roster role — rule 5 keeps it out of the roster entirely), and the three
**authoring** stages (`author_en_el`, `brief_ru_translator`, `translate_ru`,
selected by their `who` being an authoring role) are not demanded of an
AI-authored record, because they describe events the ruling displaced and
demanding a date for them would manufacture pressure to write a false one.
They are still demanded of every human-path record. One date rule is added:
`reviewed_at` may not precede the ruling's own timestamp.

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

What the predicates in `pipelineIncoherences()` buy is exactly this list, and no
more than this list. Each row is proven in `src/pipeline.test.ts` by
**constructing** the record it refuses and asserting the problem comes back —
and, because several of these were tightened at once, by proving that a
_coherent_ delivery reports nothing, so the set is not vacuous.

| Predicate                                                                                                                                               | The forgery it refuses                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `provenance` equals the method the assignment required _(or, for `ai_authored`, the five-part ruling rule above)_                                       | Greek produced by translating the English and recorded as if authored                                                            |
| **`authored_by` resolves to a named person in the roster, or to the model a cited OE-66/OE-67 ruling names — at every status**                          | `authored_by: "DeepL Pro v3 (machine)"` with no citation — a machine, on a register whose whole subject is that MT is prohibited |
| **the author's role is the one the method calls for**                                                                                                   | The practitioner recorded as having produced the Russian, or the translator the Greek                                            |
| **the author's role is not a reviewer role, and differs from the reviewer's**                                                                           | One human filling both sides of a four-eyes check                                                                                |
| `authored_by ≠ reviewed_by` as strings, _as well_                                                                                                       | _(kept, but the role comparison is what carries the weight — see below)_                                                         |
| `reviewed_by` ∈ the named DSL or deputy                                                                                                                 | A sign-off by whoever happened to be editing                                                                                     |
| that person carries `confirmed_by_stakeholder_on`                                                                                                       | A DSL invented in the same commit                                                                                                |
| **`reviewed_at` is not in the future, not before the latest completed blocking stage, not before the pipeline opened, and not before `external_start`** | A 2019 sign-off; a sign-off dated before the translator was briefed                                                              |
| every **blocking** stage `completed_at` is set                                                                                                          | Russian translated by a competent professional who was **never briefed** — the most likely real-world version of this            |
| `channel ≠ "undetermined"`                                                                                                                              | A string signed off before anyone decided whether it is spoken aloud, so the read-aloud pass silently did not apply              |

> **Why the role comparison and not the string comparison.** The first version of
> this table claimed `authored_by ≠ reviewed_by` enforced "a different reviewer".
> It did not: it was string inequality over unconstrained free text, so
> `"B. Lead"` and `"B. Lead, DSL"` are one human and passed silently. Both fields
> now resolve against the roster — a closed, stakeholder-confirmed set — so
> distinctness is between two identified _roles_, and a name that resolves to
> nothing is refused outright.

Each row is still proven by a constructed forgery in `src/pipeline.test.ts`,
now with the rulings in force; the AI route's own cases are the `T-233` block at
the end of that file: a machine author without a citation refused (pending and
signed off), an OE-66 record accepted as authored and refused as signed off
without a human DSL/deputy, every review predicate refusing its forgery on an
AI-authored record, the citation refused when it is missing, unknown, for the
wrong locale, on a human provenance, or naming a human, and the model refused
if it is ever named into the roster.

**Four roles must be four people, and that is checked the moment they are named
— not at sign-off.** Nothing previously required it: `dsl` and `dsl_deputy` could
be one human and every predicate above stayed silent, which defeats the reason
both roles exist. PM §MVP-L5 AC7 makes trilingual coverage a property of the
**pair**, so a pair of one covers whatever that one person covers, and a
Russian-speaking sitter's copy would be signed off by nobody who reads Russian.

| Roster rule                                                   | What it stops                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `dsl` ≠ `dsl_deputy`                                          | The pair of one, above                                                |
| No person holds both an authoring and a reviewing role        | Four eyes, caught at naming time rather than months later at sign-off |
| A duplicated name is a finding, resolved by declaration order | Behaviour that depended on JSON key order                             |
| `confirmed_by_stakeholder_on` must parse as a date            | `"pending"`, which satisfied "has a value" and nothing else           |
| Stage `completed_at` values must not go backwards             | Russian translated before its translator was briefed                  |

**Deliberately not a rule:** the practitioner and the translator may be the same
person. A trilingual safeguarding practitioner authoring all three locales
natively is _better_ than a translation, and a rule against it would enforce a
staffing shape the specs do not require. What is refused is **calling it a
translation** — there is nobody to brief and no brief to acknowledge. Re-declare
`ru` as `method: "authored"` and the same roster is clean.

## 4. The strings — eight keys, three locales, 24 records

All eight are `safety_critical`. Since `T-233` all 24 records are
`provenance: "ai_authored"`, `status: "pending_review"` (§3). The **Intent**
column is what the string is _for_ as `T-049` wrote it; **the meaning contract
the landed copy was written to is `tasks/state/EP-0/OE-66/en/MEANING.md`
(OE-67), and where the two differ the contract is what the copy says** — noted
in the column. None of it is approved copy.

| Key                                | Intent                                                                                                                                                                                                                                                                              | Channel                | Emergency panel? |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------- |
| `safety.emergency.call_112.label`  | The button that dials **112**, the single emergency number for police, ambulance and fire                                                                                                                                                                                           | screen                 | yes              |
| `safety.emergency.call_112.script` | What the caller **says aloud** to the 112 operator, with the booking address substituted                                                                                                                                                                                            | **spoken by the user** | yes              |
| `safety.emergency.address_prompt`  | Instructs the caller to read the address to the operator; rendered at display size, and it is what shows when the network is gone                                                                                                                                                   | **spoken by the user** | yes              |
| `safety.helpline.116111.label`     | The pan-EU child and adolescent helpline, operated in Cyprus by Hope For Children CRC Policy Center                                                                                                                                                                                 | screen                 | yes              |
| `safety.helpline.1466.label`       | The Hope For Children line. **The operational relationship between 1466 and 116 111 is unverified (PM §Q16) and the labelling must be confirmed with the operator.** _The landed copy carries no scope list (MEANING §5: an unverified, partial list implies the rest is excluded)_ | screen                 | yes              |
| `safety.helpline.199.label`        | The alternative national emergency number, same dispatch. **A documented fallback — 112 is the primary and the one used in all copy and all training**                                                                                                                              | screen                 | yes              |
| `safety.sos.confirm`               | The SOS confirmation on the session screen. _The landed copy is gesture-neutral and promises no callback: PM §MVP-IS5 AC4 says "one tap, confirm" and specifies no callback to the initiator (OD-251, open)_                                                                        | screen                 | no               |
| `session.checkins_missed`          | An escalation-ladder message — _N_ check-ins not received (the landed copy does not say "missed": PM §MVP-IS3 AC6/AC7). **Russian has four plural categories** and this string is wrong on 2, 3, 4, 5, 11, 22, 111 … if only `one`/`other` are supplied                             | **undetermined**       | no               |

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

### What changed on 2026-09-05, and why

`T-040` opened the waiver with `opened_at 2026-09-05` → `expected_by 2026-10-17`.
That interval is **exactly 42 days**, which is SD §DH-5's six-week external lead
time verbatim. So:

```
latest external start  =  deadline − lead time  =  2026-10-17 − 42 days  =  2026-09-05
```

— the day the register was created. **The window had zero slack on arrival.**
Recorded as **OD-15** in `tasks/state/decisions.md` and escalated as **OE-5**.

The conclusion the stakeholder drew is the right one: **2026-10-17 was never a
forecast.** `T-040` wrote six weeks because the spec says six weeks, not because
a clock had started — and no clock has started, because no engagement has begun.
A date nobody ever committed to should not be allowed to expire into a build
failure whose cheapest repair is deleting the waiver.

**Decision: re-anchor honestly to `2026-12-05`, and redefine what the date
means.**

### `expected_by` is a decision review date, not a delivery date

Nobody has promised safety copy by 2026-12-05. What must happen by it is a
**decision**: either a real `external_start` is recorded and the date is
re-anchored to _start + 42 days_, or it is re-anchored again with a stated
reason. **The gate behaviour is unchanged** — after `expected_by`,
`gate:safety-review-currency` fails the build on these keys exactly as on
unwaived ones — so the self-closing property, which is the entire value of the
mechanism, survives the change.

**This is not an open-ended waiver and it is prevented from becoming one**, by
four things that all live _outside_ the register:

| Guard                                            | Where it lives                                                                      | What it stops                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expected_by ≤ 2026-12-05`                       | a literal in `src/review.test.ts`                                                   | The date drifting later without an edit to a test file                                                                                                                               |
| `pipeline.deadline === '2026-12-05'`             | a literal in `src/pipeline.test.ts`                                                 | The date drifting _earlier_ in the register than the anchor, or the anchor moving without the register                                                                               |
| **≤ 1 re-anchor while `external_start` is null** | `MAX_UNSTARTED_RE_ANCHORS` in `src/pipeline.test.ts`                                | Moving the date repeatedly while nothing is engaged. One has been used                                                                                                               |
| `expected_by ≤ 2026-12-05`                       | `WAIVER_NOT_AFTER` in `tools/safety-review-currency.ts` (`T-044`, added 2026-09-20) | The same drift, in the gate that blocks the PR rather than in a test: a later `expected_by` is refused as `WAIVER-RENEWED`. Earlier is allowed — shortening a waiver cannot buy time |

And one that lives inside, but is checkable: `pending_pipeline.re_anchors` is an
**append-only chain**. Each row's `from` is the previous row's `to`, the first
`from` is the original `2026-10-17`, and the last `to` must equal `expected_by`.
**A date moved without a row explaining it is a red test**, even when every
literal above is moved with it — demonstrated in `T-049`'s evidence, case C.

> **The §5.1 question, asked of this record — and then asked again one level
> down.** _Could it report "we are on track" while nothing has been engaged?_ On
> its own, **yes** — append a row every time the date approaches, and the chain
> stays perfectly coherent while nothing happens. That is why the _bound_ is a
> literal in a test file rather than a field in the register: a register that
> could raise its own limit would be measuring itself.
>
> **The first version stopped there, and that was not far enough.** The bound was
> outside, but the predicate deciding whether it _applied_ was inside: it
> filtered on `external_start_at_decision`, a field each row writes **about
> itself**, and never compared it against the waiver's actual `external_start`. A
> date typed into that one field bought an exemption from a limit that was
> otherwise unreachable. Exemption is now granted against the waiver's **actual**
> state, and a row claiming a start the waiver does not have — or decided before
> the start it invokes — is reported rather than silently declined.

`external_start` is recorded as an **explicit `null`**, in both
`pipeline` and `pending_pipeline`, and `loadCopyPipeline()` **refuses to load a
pipeline whose `external_start` key is absent** — a null that means "has not
happened" is checkable; a missing key reads identically to a field nobody
thought to add.

### What blocks, and what does not — say this plainly

**The copy pipeline blocks a milestone, not the build.** Roughly 24 of 25 ready
tickets are unaffected and the programme keeps moving. What is genuinely blocked,
and stays blocked deliberately:

- **`T-043` (`gate:prohibited-claims`).** Its gate requires **nine demonstrated
  failures** over the `el`/`ru` lists. Since OE-66 those lists exist, AI-authored
  (§6), so `T-043` no longer waits for native speakers to write them.
- **The M0 exit gate.** SD §DH-5 conditions it on native authorship **with named
  authorship**. OE-66/OE-67 replaced that authorship with a named **model**
  (EV-16), recorded truthfully; they did **not** replace the review. **M0 still
  needs the named, stakeholder-confirmed human DSL and deputy, and their
  per-locale sign-off**, and no re-anchoring of a date changes that.

**The re-anchor does not make the dependency go away.** It replaces a date nobody
committed to with a date somebody decided, and it makes the next move cost a
decision instead of an edit.

### The ask, in order

> **Amended by `T-233` for OE-66 / OE-67 — steps 1 and 2 only.** The copy now
> exists, AI-authored, so the practitioner and the translator are no longer on
> the critical path for it. **Step 1 reduces to naming and confirming the DSL
> and the deputy DSL** (the two authoring roles may stay `null`), and **step 2
> becomes: send Appendix C to them**, not Appendices A and B. Steps 3–5 — the
> `external_start` / `expected_by` / `WAIVER_NOT_AFTER` mechanics — are
> **unchanged**, and they still govern the waiver's date. What `external_start`
> should mean when no external author is being briefed is a question for the
> stakeholder at the 2026-12-05 decision; `T-233` has not answered it and has
> not recorded one.

1. **Name the four people** in `review.json § pipeline.roles` and set
   `confirmed_by_stakeholder_on`: the **Greek-authoring safeguarding
   practitioner** — _the long pole, and the Cyprus constraint is not negotiable,
   because the copy encodes the Cyprus reporting pathway_ — the **Russian
   translator**, the **DSL** and the **deputy DSL**. PM §MVP-L5 AC7 requires the
   DSL pair to cover English, Greek and Russian between them; verify that before
   confirming them.
2. **Send Appendix A** to the practitioner and **Appendix B** to the translator.
   Both are complete as written. Appendix B must not go out with the strings
   attached until the translator has acknowledged the brief — that
   acknowledgement is the recorded stage `brief_ru_translator`, and it is the
   stage that gets skipped.
3. **Record `external_start`** on the day the brief is _actually_ delivered. Not
   the day it is written, and not in advance.
4. **Then re-anchor `expected_by` to `external_start + 42 days`**, appending a
   `re_anchors` row with `external_start_at_decision` set — which is the moment
   the date becomes a genuine forecast for the first time, and the moment the
   unstarted-re-anchor bound stops applying. **If that lands after 2026-12-05,
   move `WAIVER_NOT_AFTER` in `tools/safety-review-currency.ts` in the same
   commit**, or `gate:safety-review-currency` refuses it as `WAIVER-RENEWED`.
   That cost is the same cost the two test literals already carry, in the gate
   that blocks a PR.
5. **If 2026-12-05 arrives with `external_start` still null**, that is a second
   unstarted re-anchor and it must be an explicit orchestrator decision against
   BOARD **RK-2**, moving `pending_pipeline.expected_by`, the `2026-12-05`
   literals in both test files, `WAIVER_NOT_AFTER` in
   `tools/safety-review-currency.ts`, `MAX_UNSTARTED_RE_ANCHORS`, and a new
   `re_anchors` row, plus `pipeline.deadline` and
   `pipeline.latest_external_start` — **together**. That cost is the intended
   mechanism. What must not happen is the date arriving unattended: the cheapest
   repair under pressure is deleting the waiver, and deleting the waiver deletes
   the only record saying this copy is unreviewed.

## 6. Also on this engagement — `T-043`'s prohibited-claim lists

Not `T-049`'s deliverable. **Since `T-233` both lists exist:**
`packages/i18n/prohibited/el.json` (10 claims, 597 phrases) and `ru.json` (10
claims, 290 phrases), each with its locale's renderings of the three permitted
claims. **Both are AI-authored under OE-66** (`"provenance": "ai_authored"`,
`"authored_by": "Claude Opus (claude-opus-5-5), AI agent, under stakeholder
ruling OE-66"` inside each file) — a stakeholder-accepted deviation (EV-16)
from PM §MVP-L4 AC6, which asks for a native speaker. **Nothing reads them yet:**
`gate:prohibited-claims` is still the `not-yet-supplied` stub (PENDING, owed by
`T-043`), and no other code in the repository opens `prohibited/`. **OE-68
(2026-09-27T19:27:39Z) ruled that the banned list stands**: "24/7 support" and
"24/7 staffed" stay banned, the safety line is described without a staffing
claim, and PM §MVP-IS5 AC6's "reachable 24/7" is superseded for all copy. The
English list is a fixed set of testable constants:

> Never: _"24/7 support"_, _"24/7 staffed"_, _"always on"_, _"round-the-clock team"_, _"someone is always watching"_, _"continuously monitored"_, _"live monitoring"_, _"real-time checks"_, _"always up to date"_, _"we check daily/weekly"_.
>
> Permitted, exactly: _"Re-verified every 12 months"_, _"Attested every 90 days"_, _"Re-checked immediately on any concern"_.

> **Note for `T-043`, which will build `gate:prohibited-claims`:** this document
> quotes the banned English phrases verbatim, above. `T-040`'s contract scopes the
> gate to `catalogues/**`, which excludes this file — **keep it scoped.** A gate
> widened to `packages/i18n/**` would fail on the document that explains it, and
> the obvious repair would be to soften the quotes here until the list is no
> longer testable. **Scoping matters twice now:** `prohibited/{el,ru}.json` are
> themselves lists of banned phrases, so a gate that scanned them as copy would
> fail on its own input. The gate must still **fail closed on the absent
> `prohibited/{el,ru}.json` path**, which is a different rule and is not relaxed
> by this one. **Now that the files exist, that rule can only be proven by
> deleting one in a temporary root** — the committed tree no longer exercises
> the absent path by itself.

What was asked of a native speaker — **the phrases a Greek or Russian copywriter
would actually reach for, not translations of the English** — was asked of the
OE-66 authors instead. Their own caveats, which `T-043` inherits
(`tasks/state/EP-0/OE-66/{el,ru}/NOTES.md` §4):

- **Matching.** Both lists assume case-insensitive substring matching after
  NFC; `el` also assumes tonos/diaeresis stripped (every phrase is listed both
  ways), `ru` assumes ё→е folding (listed both ways only for the commonest).
- **Negation.** Substring matching flags honest negations («мы НЕ работаем
  круглосуточно»); the `ru` author asks for an explicit allow-list rather than
  dropped phrases.
- **Deliberately not banned:** bare «присмотр», «в реальном времени» and
  «видеонаблюдение» (`ru`); bare «σε πραγματικό χρόνο», «κάθε λεπτό» and «πάντα»
  (`el`) — each because required or ordinary copy contains it.
- **The two lists disagree on bare "24/7".** `ru` bans it; `el` left it off
  because of the PM §MVP-IS5 AC6 conflict (OD-249) that **OE-68 has since
  resolved**. `el`'s reason is gone; which way `T-043` goes is a decision, not a
  drafting detail.
- **"escrow"** (SA DV-3) is on neither list and not in the English one above.
- **Nobody has red-teamed either list.** Recall against real Greek or Russian
  marketing copy is unmeasured.

## 7. Limits of this document, stated rather than discovered

- **No copy is reviewed here**, and none can be from inside this repository.
  The copy that exists was **authored by an AI model** under OE-66/OE-67; that
  is a statement of who wrote it, not of whether it is right.
- **The register cannot prove review, only currency and coherence** (§3). It
  can now also not prove that the model named in `authored_by` wrote the string
  — only that the record cites a ruling permitting that author for that locale.
- **Stage 5, the in-context screenshot review, cannot begin** until `T-050` /
  `T-051` render these strings in a running product at 360 px. **Nothing has
  been measured at 360 px.** What has been measured is length in code points
  (Python `len()` over the catalogue value, `{address}` counted as its nine
  source characters, `T-233` at the landed copy): `call_112.script` `en` 94,
  `el` 106, `ru` 101; `sos.confirm` `en` 94, `el` 116, `ru` 117. Both are
  expected to wrap at 360 px; whether they wrap cleanly is what stage 5 is for.
  (The `el` author's own note gives 111 for `sos.confirm`; the value in the
  catalogue measures 116.)
- **Stage 6, the read-aloud pass, has not happened** for the two
  `spoken_by_user` keys in any locale.
- **`session.checkins_missed`'s channel is undetermined** and depends on
  `T-105`/`T-107`; its recipient is undetermined too. The register refuses
  sign-off until the channel is decided.
- **`safety.helpline.1466.label`'s labelling is unverified** (PM §Q16) and must
  be confirmed with Hope For Children before launch — a copy review cannot
  settle it. OE-67 fixed the placeholder's wrong organisation (OD-247); it did
  not verify the right one.
- **The 112 language is unverified.** Every word of the 112 script and the
  address prompt is in the reader's own language (MEANING.md's spoken-language
  rule). Whether Cyprus 112 takes a call in Russian, or brings in an
  interpreter, and what its operator asks first, are **not verified** by anyone.
- **No phone number, operator, organisation or service status was verified** by
  any author — 112, 199, 116 111, 1466, Hope For Children.
- **Open decisions the copy cannot settle** (`decisions.md`):
  - **OD-247** — ruled by OE-67; the `en` placeholder defects are fixed in the
    landed copy. The 1466 labelling itself remains unverified (above).
  - **OD-248** — _open._ `{address}` is one substitution, but the SOS screen
    shows the address in Greek and Latin script. Which rendering each locale's
    script receives is undecided; a Russian or English reader handed a
    Greek-script address cannot read it aloud.
  - **OD-249** — ruled by OE-68 (above, §6).
  - **OD-250** — ruled by OE-67: `el` and `ru` were re-authored to the one
    meaning contract (their `validate.py` §8/§2 conformance checks are
    mechanical; the argued check is in each NOTES.md; **the real check is the
    DSL's**).
  - **OD-251** — _open._ The SOS gesture (PM "one tap, confirm" vs "hold to
    send"), whether the confirmation should say the other party and the
    emergency contacts are notified (AC4 c/d), and the absence of any specified
    callback. The copy is gesture-neutral and silent on both until decided; if
    the control ships as hold-to-send, `safety.sos.confirm` changes in all three
    locales and its hash un-signs it.

---

# Appendix A — brief for the Greek-authoring safeguarding practitioner

> **SUPERSEDED FOR THE CURRENT COPY by OE-66 / OE-67 (2026-09-27). Do not send
> it as a brief for the copy now in the catalogues** — that copy was authored by
> an AI model, and the stakeholder chose that route over human authorship. It is
> kept as the brief for the human authoring path, which the rulings displaced but
> did not abolish, and it must be corrected before any use: items 5 and 7 below
> repeat two placeholder assumptions the meaning contract
> (`tasks/state/EP-0/OE-66/en/MEANING.md`) rejects — a 1466 scope list, and "holds
> it … an operator calls them back" (OD-251). **The brief that applies now is
> Appendix C.**
>
> _Original instruction:_ Send as it stands. Fill the bracketed fields.

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

> **SUPERSEDED FOR THE CURRENT COPY by OE-66 (2026-09-27). Do not send it as a
> brief for the copy now in the catalogues** — the Russian was authored by an AI
> model, aligned to the OE-67 meaning contract, not translated by a briefed
> human. Kept for the human path only. **The brief that applies now is
> Appendix C.**
>
> _Original instruction:_ Send as it stands. **Do not send the strings until the
> translator has acknowledged this brief** — the acknowledgement is a recorded
> stage, and it is the stage that gets skipped.

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

---

# Appendix C — brief for the DSL and the deputy DSL (added by `T-233`)

> **This is the brief that applies to the copy now in the catalogues.** It can
> be sent only once the stakeholder has named both people in
> `review.json § pipeline.roles` (`dsl`, `dsl_deputy`) with a
> `confirmed_by_stakeholder_on` date. Between them they must read English,
> Greek and Russian (PM §MVP-L5 AC7).

**What you are reviewing, and who wrote it.** Safety-critical copy for a Cyprus
childcare-booking platform, in English, Greek and Russian — **written by an AI
model** (Claude Opus), not by a person. The platform's stakeholder chose that
deliberately (rulings OE-66 and OE-67). **No human has authored or reviewed any
of it.** You are the first.

- **All three locales**: the eight safety-critical strings (six emergency-panel
  entries, the SOS confirmation, the missed check-in message).
- **Greek and Russian**: every other user-facing string as well.
- **Greek and Russian prohibited-claim lists**: the phrases a copywriter would
  use to over-claim supervision, which a build check will forbid.

**What to read first.** The meaning contract
(`tasks/state/EP-0/OE-66/en/MEANING.md`): for each safety string, the claims it
must make and the claims it must not. The Greek and Russian strings were written
to that contract, not translated from the English. Then each author's notes
(`…/OE-66/{en,el,ru}/NOTES.md`), which list their own uncertainties.

**What only you can settle, per locale:**

1. **Sign-off** of each string, per locale. Your name and the date are recorded
   against the exact text; any later edit un-signs it automatically.
2. **The 360 px in-context review** in the running product — not possible until
   the screens exist (`T-050`/`T-051`).
3. **The read-aloud pass** on the 112 script and the address prompt, spoken by
   someone who has not read them.
4. **The open questions** in §7: the 1466 labelling (confirm with Hope For
   Children), whether Cyprus 112 takes a call in Russian, which script the
   address is shown in (OD-248), the SOS gesture and whether the confirmation
   should say who else is notified (OD-251), and the missed-check-in message's
   channel and recipient.

**What you may not do.** Sign off copy you have not read in context, or sign
off a locale neither of you reads. The system refuses a sign-off by anyone who
is not the named DSL or deputy, and refuses one recorded before the ruling that
made the copy exist.
