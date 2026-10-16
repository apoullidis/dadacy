# The trilingual safety-copy pipeline

**Owner:** `T-049` (front-end / i18n) · **Register:** [`review.json`](./review.json) `§ pipeline`
**Specs:** SD §DH-5 external dependency 2 · SA §TS-12.4 · PM §MVP-L4 AC4, §MVP-L5 AC7, §MVP-IS5 AC7 · DV-7, DV-11 · SD Revision Log D8 — **as departed from under EV-16** (stakeholder rulings OE-66, OE-67, OE-5, OE-81, OE-82)
**Status on 2026-09-05:** engineering side complete; external side not started, and blocked on a stakeholder. _(History: superseded by the lines below.)_
**Status on 2026-09-28 (`T-233`):** the copy exists and is **AI-authored, not reviewed.** Stakeholder rulings **OE-66** (2026-09-27T18:54:51Z) and **OE-67** (2026-09-27T19:27:39Z) made an AI model — Claude Opus (`claude-opus-5-5`) — the **author** of all `el` and `ru` copy, the `el`/`ru` prohibited-claim lists, and the eight `en` `safety_critical` strings (`decisions.md` EV-16). **OE-68** kept the banned-claims list as it stands.
**Status since 2026-10-11 (stakeholder ruling OE-5; `T-259`, `T-264`, `T-260`): no human authors or reviews this copy.** OE-5 dropped the DSL and deputy review (EV-16 extended) and OE-81 makes AI-authored, unreviewed safety copy releasable. All 24 records are final with no review (`status: "unreviewed_by_ruling"`, `review_ruling: "OE-5"`, reviewer and date `null`), `pending_pipeline` is `null`, and **no date is in force** (§5). Under **OE-82** the 360 px in-context check and the read-aloud check are automated gates (§1). **`T-260` removed the human path from the register:** `review.json § pipeline` carries no roster of people (`roles`), no steps a person completes (`stages`) and no per-locale authoring method, and `src/pipeline.test.ts` refuses any of them coming back (§3). The briefs that were Appendices A–C are withdrawn (end of this file).

---

## 0. Read this first

This document describes how a `safety_critical` string is produced, recorded
and checked, now that no person does any of it. It began as T-049's account of
one of the two external dependencies SD §DH-5 says can slip the programme — a
six-week engagement of named humans — and the stakeholder ruled that
engagement out (OE-66/OE-67, then OE-5). What is left is a register, the gates
that read it, and the limits of both.

Two things this document deliberately does **not** contain:

1. **Any safety copy.** Not English, not Greek, not Russian. The copy lives in
   the catalogues. Until `T-233` every `safety_critical` string there was an
   **engineering placeholder** written by `T-040`; since `T-233` every one is
   **AI-authored** under OE-66/OE-67 and recorded as `provenance:
"ai_authored"` in `review.json`, and since `T-259` at `status:
"unreviewed_by_ruling"` with `review_ruling: "OE-5"`. **It is not reviewed and
   no review will happen** (OE-5); OE-81 makes it releasable as it stands.
   Writing copy that _read_ as reviewed would be the exact failure this whole
   mechanism exists to prevent —
   an English SMS delivered to a Russian speaker succeeds at every layer,
   returns 200, raises no alarm, and is discovered when it matters least.
2. **The Greek and Russian prohibited-claim lists.** They are in
   `prohibited/{el,ru}.json`, **AI-authored under OE-66** — a stakeholder-accepted
   deviation from PM §MVP-L4 AC6's "enumerated by a native speaker" (EV-16).
   `gate:prohibited-claims` (`T-043`) reads them. See §6.

---

## 1. The flow

SA §TS-12.4 specified a human pipeline: a Cyprus safeguarding practitioner
authoring English and Greek in parallel, a briefed professional translator for
Russian, a DSL sign-off per locale, an in-context review at 360 px and a
read-aloud pass. Under EV-16 as extended, each step is either done by a model,
dropped, or done by a gate:

```
                 ┌──────────────────────────────────────────────────────┐
                 │  1. AUTHOR — en, el, ru: an AI model                 │
                 │     Claude Opus (claude-opus-5-5), under OE-67 (en)  │
                 │     and OE-66 (el, ru). el/ru written to the en      │
                 │     meaning contract, not translated from it.        │
                 │     Machine translation stays prohibited (DV-11).    │
                 └───────────────────────┬──────────────────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                │
┌───────▼─────────┐        ┌─────────────▼──────────┐      ┌──────────────▼────────┐
│ 2. REVIEW       │        │ 3. 360 px RENDER CHECK │      │ 4. READ-ALOUD CHECK   │
│    DROPPED by   │        │    a gate (OE-82):     │      │    a gate (OE-82):    │
│    OE-5         │        │    gate:safety-copy-   │      │    gate:read-aloud,   │
│                 │        │    render (T-265),     │      │    espeak-ng, record  │
│                 │        │    checks/render-360   │      │    checks/read-aloud  │
└─────────────────┘        └────────────────────────┘      └───────────────────────┘
        │                                │                                │
        └──► gate:safety-review-currency passes a record only as final with NO
             review under OE-5, and, since T-264, only with a current passing
             check record for 3 (or its key listed in AWAITING_SURFACE) and 4
```

**The practitioner and the translator were replaced by the model** (OE-66,
OE-67). A record names the model in `authored_by` and cites the ruling in
`ruling`; a person's name there is refused (§3).

**Since stakeholder ruling OE-5 (2026-10-11) step 2 does not happen.** No record
is signed off; every record is `unreviewed_by_ruling` under `review_ruling:
"OE-5"`, and the gate refuses a `signed_off` status (`CLAIMS-REVIEW`; NEG
`T259-SIGNED-OFF`).

**Since stakeholder ruling OE-82, steps 3 and 4 are automated gates, not
people, and not stages.** `pipeline.automated_checks` names the two gates and
their records. Step 4 is `gate:read-aloud` (`T-263`): every spoken safety string
(`READ_ALOUD_KEYS_PINNED`, `tools/automated-checks.ts`) is synthesised in every
enabled locale and plural form, and `checks/read-aloud.json` records the
result. Step 3 is `gate:safety-copy-render` (`T-265`, not yet built): every
shown safety string (`RENDER_KEYS_PINNED`) is rendered at a pinned 360 px
Android viewport, into `checks/render-360.json`. A key whose surface does not
exist yet is listed in `AWAITING_SURFACE` against the ticket that builds it
(today all eight: seven `T-110`, one `T-107`), and that list must be empty for
production readiness. **`gate:safety-review-currency` enforces both at the
terminal status** (`T-264`): a record there whose read-aloud check is absent,
stale, failed or made with another tool is refused, and so is one whose key is
neither awaiting nor carries a current passing render record; a check record
naming a person, a channel that disagrees with the pins, and an awaiting key
that has a render record or is named in tracked app source are refused at any
status. Every run prints `automated checks: read-aloud <a>/<b> pairs current;
render-360 <c> checked, <d> awaiting surface (…)`. What a check does not show
is stated in `state/EP-0/T-263.md` § Published contract — LIVE §6 (espeak-ng
is a formant synthesiser; pronunciation is not checked).

**There are no stages.** T-049 recorded the human steps as `pipeline.stages`,
each with a `who` naming a role and a `completed_at`; `T-264` removed the two
checks from that list and `T-260` removed the other four (`author_en_el`,
`brief_ru_translator`, `translate_ru`, `dsl_signoff`) and the list itself. A
`stages` block re-added to `review.json` is refused, naming each stage and its
`who` (`src/pipeline.test.ts` _NEGATIVE — T-260: a roles or stages block
re-added, naming a person or a human role, is refused_, and _the coherence
predicates are silent on the register as it actually stands_ over the real
file; NEG `T264-STAGE-READDED-DSL`).

## 2. Who must exist — nobody

SA §TS-12.4, PM §MVP-L4 AC4, §MVP-S7 AC1 and §MVP-L5 AC7 required four people
here: a Greek-authoring safeguarding practitioner working in Cyprus, a briefed
professional Russian translator, and a DSL and deputy who between them read
English, Greek and Russian and signed off each locale. `review.json` carried
them as `pipeline.roles`, each with `named` and `confirmed_by_stakeholder_on`,
and naming them was the stakeholder's open action. **OE-66/OE-67 replaced the
two authors with an AI model and OE-5 dropped the DSL and deputy review, so the
action was withdrawn and `T-260` deleted the roster.** EV-16 (as extended)
records each spec clause this departs from. A `roles` block re-added to
`review.json` is refused, naming whom it names (`src/pipeline.test.ts`
_NEGATIVE — T-260: a roles or stages block re-added…_; NEG
`T260-ROLES-READDED-PERSON`).

### Who actually authored the copy now in the catalogues — OE-66 / OE-67

| What                                                                              | Author                                                                                                                                                                                | Ruling                              | Reviewed by |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------- |
| Every `el` catalogue key, safety and non-safety — written or retained (see below) | Claude Opus (`claude-opus-5-5`), AI agent                                                                                                                                             | OE-66 (EV-16), 2026-09-27T18:54:51Z | **nobody**  |
| Every `ru` catalogue key, safety and non-safety — written or retained (see below) | Claude Opus (`claude-opus-5-5`), AI agent                                                                                                                                             | OE-66 (EV-16), 2026-09-27T18:54:51Z | **nobody**  |
| `prohibited/el.json`, `prohibited/ru.json`                                        | Claude Opus (`claude-opus-5-5`), AI agent                                                                                                                                             | OE-66 (EV-16)                       | **nobody**  |
| The eight `en` `safety_critical` keys, and their meaning contract                 | Claude Opus (`claude-opus-5-5`), AI agent                                                                                                                                             | OE-67, 2026-09-27T19:27:39Z         | **nobody**  |
| Every other `en` key                                                              | unchanged by `T-233` (byte-identical to `main` at `3d52098`); `T-040`'s engineering copy — except `common.marketing.tagline`, reworded by `T-043` (Claude Opus, AI agent) under OE-69 | —                                   | **nobody**  |

- **"Written or retained."** The OE-66 drafts are the source of every `el`
  and `ru` value, but seven of those values are byte-identical to `T-040`'s
  text on `main` at `3d52098` — the model kept them rather than rewrote them:
  `el` `booking.count.upcoming`, `common.app.name`, `common.dossier.verified`,
  `common.locale.switch_prompt`; `ru` `booking.count.upcoming`,
  `common.app.name`, `common.dossier.verified`. None is `safety_critical`.
  OE-66 makes the model responsible for all of it either way.
- The drafts, their authors' notes and the meaning contract the `el`/`ru`
  safety strings were aligned to are in
  `tasks/state/EP-0/OE-66/{en,el,ru}/` (`en/MEANING.md` is the contract). They
  are inputs to this package, not part of it.
- **Nobody reviewed any of it, and nobody will** (OE-5). OE-81 makes it
  releasable as it stands. No AI agent stands in for the review either: the
  register refuses a model in `reviewed_by` (§3).

## 3. How a record is kept, and what refuses one

One record per `safety_critical` key **per locale**, in `review.json § entries`
(shape published by `T-040`; widened additively by `T-233` — the provenance
value `ai_authored` and the field `ruling`, present exactly when that value
is — and by `T-258` — the status `unreviewed_by_ruling` and the field
`review_ruling`, present exactly when that status is; `src/pipeline.test.ts`
_T-040's published `entries` shape survives this ticket, field by field_).

What every one of the 24 records says (`T-233`, flipped by `T-259`):

```jsonc
"safety.sos.confirm": {
  "content_hash": "sha256:…",              // current: the landed AI-authored copy
  "provenance":   "ai_authored",
  "status":       "unreviewed_by_ruling",  // final with NO review, by ruling — never signed off
  "authored_by":  "Claude Opus (claude-opus-5-5), AI agent",
  "ruling":       "OE-66",                 // "OE-67" for en
  "review_ruling": "OE-5",                 // the ruling that dropped the review
  "reviewed_by":  null,                    // nobody reviews this copy (OE-5)
  "reviewed_at":  null,
  "note":         "… No review: dropped by stakeholder ruling OE-5 …"
}
```

**The provenance rule (OE-66 / OE-67, as narrowed by OE-5).** A record may name
an author only when **all** of these hold, at **every** status:

1. `provenance` is `"ai_authored"` and `ruling` is present — both or neither;
2. `ruling` is a stakeholder ruling that makes a model an author. The rulings
   are **not** in `review.json`: they are the literal `AI_RULINGS` in
   `tools/rulings.ts` (transcribed from `decisions.md`; `T-258`), which the
   gate imports and `src/pipeline.test.ts` passes into
   `pipelineIncoherences()`, whose default is **no rulings**, so any other
   caller refuses every `ai_authored` record (_NEGATIVE — T-233: a caller that
   supplies no rulings refuses every AI-authored record (fail closed)_). A
   register that listed its own authority could widen it in the same commit as
   the record that needs it;
3. the ruling covers the record's locale (OE-66: `el`, `ru`; OE-67: `en`);
4. `authored_by` is **exactly** the model the ruling names — never a human
   name, never another engine.

**No human route remains (`T-260`).** A non-null `authored_by` on a record that
is not `ai_authored` is refused, and so is a provenance claiming a human
(`authored`, `translated_professional`, `legal_review`), whoever is named or
nobody (_NEGATIVE — T-260: a person as author is refused at every status, and
so is any human provenance_; _NEGATIVE — QA-F2 / T-233: a machine author
WITHOUT an OE-66/67 citation is still refused_). **No review exists (OE-5):**
`status: "signed_off"` is refused whoever is named as reviewer, or nobody
(_NEGATIVE — T-260: nothing is signed off under OE-5…_), and so is a non-null
`reviewed_by` or `reviewed_at` at any status (_NEGATIVE — T-233 rework (QA O2):
reviewed_by is checked at EVERY status_; _NEGATIVE — T-259/T-260: the terminal
status is refused if it carries a reviewer or a review date, whoever it
names_); a model that a ruling names as an author is refused there by name.

Rule 4 is exact to the character — a raw string comparison with no
normalisation. What is tested is ten near misses, each refused: a trailing or
leading space, a different case, another model version, the bare family name, a
Cyrillic look-alike letter, a zero-width space, a byte-order mark, a no-break
space and a fullwidth parenthesis (`src/pipeline.test.ts`, the citation test).
The last four are each red under an edit that would normalise the comparison
(NFKC, or stripping zero-width characters) —
`pnpm --filter @kinvara/i18n run test:review-citation-mutations` (T-043).

**The plan's shape is closed.** `review.json § pipeline` carries exactly
`opened_by`, `engineering_kickoff`, `automated_checks` and `assignments` (and a
`//` comment), and each assignment exactly `emergency_panel`, `channel`,
`channel_note`, `machine_translation` and `runtime_translation`
(_T-260: the pipeline names no person and no human step — no roles, no stages,
no per-locale method_). `pipelineIncoherences()` refuses any other field,
naming whom a `roles` block names and each stage's `who`, a channel that is
not one of `screen`, `spoken_by_user`, `voice`, `undetermined`, and a
translation that is not prohibited. The sets are written in `src/review.ts`
and `src/pipeline.test.ts`, never read from `review.json`.

**Editing a safety string changes its hash.** The register is keyed by locale
as well as key, so a Greek record cannot vouch for a Russian string.

`gate:safety-review-currency` (`T-044`; rule replaced by `T-258` under
stakeholder ruling OE-5) fails unless, for every `safety_critical` key and
every enabled locale, a record exists whose `content_hash` matches the current
source **and** the hash pinned in the gate's own `AUTHORED_CONTENT_PINNED`,
whose `provenance` is `ai_authored` with a `ruling` and an exact `authored_by`
that the gate's `tools/rulings.ts` accepts for that locale, whose `status` is
`unreviewed_by_ruling` with `review_ruling: "OE-5"`, and which claims no review
(`status` never `signed_off`, no non-null field named with `review` other
than `review_ruling`) and carries no field outside the nine a record defines
(`UNDEFINED-FIELD`), and whose `note`, if present, is a string or `null`
(`NOTE-NOT-TEXT`, `T-259`). When the key sits inside an unexpired
`pending_pipeline` waiver — none is committed since `T-259`, and one re-added
cannot outlive 2026-12-05 (`WAIVER-RENEWED`) — authorship and finality are not
checked. The record's existence, the no-review-claim rule, the closed field set,
the note type, currency and the pin still are (`T-258` rework 1, `T-259`). So since OE-5, the gate refuses a record whose `status` is
`signed_off`, which carries a non-null `review`-named field other than
`review_ruling`, or which carries
any field outside the nine (`signed_off_by`, `approved_by`, `dsl_signoff`, …),
waived or not (the gate's Vitest _UNDEFINED-FIELD_ and _CLAIMS-REVIEW_ cases).
Inside a waiver it does not judge the _values_ of `authored_by`, `ruling`,
`review_ruling` or a `status` other than `signed_off`. It refuses a `note` that
is an object, an array, a number or a boolean, waived or not (the gate's Vitest
_NOTE-NOT-TEXT_ cases; OD-353), but it never reads the **text** of a string
`note`: a sentence saying a review happened passes.

### What stops a record saying "reviewed" when nothing was reviewed

Asked and answered as directly as it can be, because the honest answer is not
"nothing".

**It cannot be prevented outright.** This register lives in the same repository
as the copy it describes, so a determined edit can write anything into it.
`content_hash` binds a record to the _current_ source — it proves **currency,
not authorship and not correctness**. Nothing here is a cryptographic
countersignature from an external party, and this document does not claim one.

What does refuse a review claim in a committed register:

- `gate:safety-review-currency` (BLOCKING in `gate:pr`): `CLAIMS-REVIEW` on a
  `signed_off` status or a non-null `review`-named field other than
  `review_ruling`; `UNDEFINED-FIELD` on any field outside the nine; and
  `NOTE-NOT-TEXT` on a `note` that is structured data — waived or not
  (`state/EP-0/T-258.md`, `T-259.md` § Published contract — LIVE).
- `pipelineIncoherences()`, run over the committed register by
  `src/pipeline.test.ts` in `gate:unit-tests`: everything in this section's
  rules above, including the cases the gate does not judge inside a waiver
  (the values of `authored_by`, `ruling` and a non-`signed_off` `status`).

What does **not**: the **text** of a string `note` is read by nothing, so a
sentence saying a review happened passes both; and a duplicated JSON key is
judged by its last value (`JSON.parse`).

## 4. The strings — eight keys, three locales, 24 records

All eight are `safety_critical`. Since `T-233` all 24 records are
`provenance: "ai_authored"`, and since `T-259` `status: "unreviewed_by_ruling"`
under `review_ruling: "OE-5"` (§3). The **Intent**
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
determination. Until it is made, the key is treated as both spoken and shown:
it is pinned in `READ_ALOUD_KEYS_PINNED`, so `gate:read-aloud` checks it in
every enabled locale, and in `RENDER_KEYS_PINNED`, awaiting its surface
(`T-107`) — since `T-264` the read-aloud check is required of it, not optional
(`state/EP-0/T-264.md` § Published contract — LIVE §2). Deciding the channel
means changing it here and both pins in the same commit, or the gate refuses
it as `CHANNEL-DRIFT`.

## 5. The date — none is in force

### History, kept (2026-09-05)

`T-040` opened the waiver with `opened_at 2026-09-05` → `expected_by 2026-10-17`,
exactly 42 days — SD §DH-5's six-week external lead time — so the latest
workable external start was the day the register was created and the window had
zero slack on arrival (**OD-15**, escalated as **OE-5**). On 2026-09-05 the
stakeholder re-anchored it to **2026-12-05** as a _decision review date_ (OE-5,
first entry). Until `T-259`, `gate:safety-review-currency` went red on
**2026-12-06** by itself: measured by `T-044`'s QA by bracketing the boundary,
and again with the clock faked to 2026-12-06 at `main` `34aaadf` (`GATE FAIL …
49 problem(s)`, `WAIVER-EXPIRED` then 24 `NOT-FINAL`; `state/EP-0/T-259.md`
§ Evidence E9).

### The decision the date was waiting for, and what `T-259` did with it

The date existed to force a decision on **human review**. Stakeholder ruling
**OE-5** (2026-10-11T08:13:50Z; EV-16 extended) was that decision: AI agents
author the copy, and the four-reviewer action is dropped, the DSL + deputy
`reviewed_by` review (PM §MVP-L5 AC7) included. **OE-81** rules that this copy is
releasable. So `T-259`:

- moved all 24 records to `status: "unreviewed_by_ruling"` with
  `review_ruling: "OE-5"`, reviewer and date `null`, and reworded each `note` to
  say no review happened and none will (`src/review.test.ts` _every
  safety_critical record is final with no review under OE-5…_);
- set `pending_pipeline` to `null`, which deletes its re-anchor chain
  (`src/review.test.ts` _pending_pipeline is null…_);
- deleted `pipeline.deadline`, `lead_time_days`, `latest_external_start`,
  `external_start` and `blocked_on` with their notes (`src/pipeline.test.ts`
  _the pipeline block exists, is loaded fail-closed, and carries no date in
  force_), and the test-file anchors `ANCHOR`, `DEADLINE`, `LEAD_TIME_DAYS`,
  `ORIGINAL_EXPECTED_BY` and `MAX_UNSTARTED_RE_ANCHORS` with the tests over them.

**This is not a renewal. No date moved**; the event the date waited for was
ruled out by the stakeholder, on the record. **Measured, not argued:** the gate
run on the committed tree with the clock faked to 2026-12-06 and to 2027-06-01
is `GATE PASS` (NEG `T259-CLOCK-PAST-ANCHOR`, `T259-CLOCK-2027`), and so is the
package's test suite with the clock at 2026-12-06 (`state/EP-0/T-259.md`
§ Evidence E11).

### The one anchor left — it bounds a waiver someone re-adds

`WAIVER_NOT_AFTER = '2026-12-05'` in `tools/safety-review-currency.ts`, and every
`WAIVER-*` refusal, are unchanged. A `pending_pipeline` re-added with a later
`expected_by` is `WAIVER-RENEWED` (NEG `WAIVER-RENEWED`, with 2027-01-01; Vitest
_a waiver renewed past the anchor pinned in the gate is refused_), so no waiver
can be in force after 2026-12-05 and none can be renewed by editing the field
that expires it. Inside one that is in force the gate still checks each record's
existence, review claims, closed field set, note type, currency and pin (the
Vitest _… INSIDE the waiver …_ and _(waived)_ cases, run at a faked clock inside
the rebuilt pre-`T-259` waiver).

### What is not claimed

- Nothing here makes the copy right or proves which model wrote it; an edit that
  changes the catalogue, the record's hash and the gate's pin in one commit
  passes, and review of the diff is the control (`T-258` § Published contract —
  LIVE §7).
- The 360 px in-context check and the read-aloud check are enforced since
  `T-264` by `gate:safety-review-currency` reading their committed records (§1).
  No key is render-checked yet: all eight await a surface (`AWAITING_SURFACE`),
  so nothing has been rendered at 360 px.
- The ask this section used to end with — name four people, send Appendices A,
  B and C, record `external_start`, re-anchor — was **withdrawn by OE-5**, and
  `T-260` withdrew the appendices (end of this file).

## 6. Also on this engagement — `T-043`'s prohibited-claim lists

Not `T-049`'s deliverable. **Since `T-233` both lists exist:**
`packages/i18n/prohibited/el.json` (10 claims; 598 phrases since `T-043` added
bare "24/7") and `ru.json` (10 claims, 290 phrases), each with its locale's
renderings of the three permitted claims. **Both are AI-authored under OE-66**
(`"provenance": "ai_authored"`, `"ruling": "OE-66"`, `"authored_by": "Claude
Opus (claude-opus-5-5), AI agent"` inside each file; reviewed by nobody, OE-5) —
a stakeholder-accepted deviation (EV-16) from PM §MVP-L4 AC6, which asks for a
native speaker. **`gate:prohibited-claims` (`T-043`, BLOCKING) reads them** —
`tools/prohibited-claims.ts`; its contract is `tasks/state/EP-0/T-043.md`
§ Published contract — LIVE, and the counts above are what its run prints. **OE-68
(2026-09-27T19:27:39Z) ruled that the banned list stands**: "24/7 support" and
"24/7 staffed" stay banned, the safety line is described without a staffing
claim, and PM §MVP-IS5 AC6's "reachable 24/7" is superseded for all copy. The
English list is a fixed set of testable constants:

> Never: _"24/7 support"_, _"24/7 staffed"_, _"always on"_, _"round-the-clock team"_, _"someone is always watching"_, _"continuously monitored"_, _"live monitoring"_, _"real-time checks"_, _"always up to date"_, _"we check daily/weekly"_.
>
> Permitted, exactly: _"Re-verified every 12 months"_, _"Attested every 90 days"_, _"Re-checked immediately on any concern"_.

> **Note on `gate:prohibited-claims` (`T-043`):** this document
> quotes the banned English phrases verbatim, above. `T-040`'s contract scopes the
> gate to `catalogues/**`, which excludes this file — **keep it scoped.** A gate
> widened to `packages/i18n/**` would fail on the document that explains it, and
> the obvious repair would be to soften the quotes here until the list is no
> longer testable. **Scoping matters twice now:** `prohibited/{el,ru}.json` are
> themselves lists of banned phrases, so a gate that scanned them as copy would
> fail on its own input. The gate must still **fail closed on the absent
> `prohibited/{el,ru}.json` path**, which is a different rule and is not relaxed
> by this one. It is proven by deleting one in a temporary root
> (`tools/prohibited-claims.test.ts`), since the committed tree no longer
> exercises the absent path by itself.

What was asked of a native speaker — **the phrases a Greek or Russian copywriter
would actually reach for, not translations of the English** — was asked of the
OE-66 authors instead. Their own caveats (`tasks/state/EP-0/OE-66/{el,ru}/NOTES.md`
§4), each with what `T-043` did about it:

- **Matching.** Both lists assume case-insensitive substring matching after
  NFC; `el` also assumes tonos/diaeresis stripped (every phrase is listed both
  ways), `ru` assumes ё→е folding (listed both ways only for the commonest).
  The gate does exactly that, plus NFKC, both sigma forms, and invisible
  characters removed; Greeklish is not folded (SD routes it through
  `packages/text-normalise`, `T-065`, not built).
- **Negation.** Substring matching flags honest negations («мы НЕ работаем
  круглосуточно»); the `ru` author asks for an explicit allow-list rather than
  dropped phrases. Measured at `T-043`: no catalogue string is hit at all, so
  there is no case to allow and the gate has no allow-list; one is added, as
  narrow as the string, when real copy needs it.
- **Deliberately not banned:** bare «присмотр», «в реальном времени» and
  «видеонаблюдение» (`ru`); bare «σε πραγματικό χρόνο», «κάθε λεπτό» and «πάντα»
  (`el`) — each because required or ordinary copy contains it.
- **Bare "24/7".** `ru` banned it; `el` left it off because of the PM §MVP-IS5
  AC6 conflict (OD-249) that **OE-68 has since resolved**. `T-043` added it to
  `el` (OD-256).
- **"escrow"** (SA DV-3) is on neither list and not in the English one above;
  SD names it and its Greek and Russian forms for this gate, so the gate carries
  "escrow", «μεσεγγύηση» and «эскроу» as constants of its own.
- **Nobody has red-teamed either list.** Recall against real Greek or Russian
  marketing copy is unmeasured.

## 7. Limits of this document, stated rather than discovered

- **No copy is reviewed here**, and none can be from inside this repository.
  The copy that exists was **authored by an AI model** under OE-66/OE-67; that
  is a statement of who wrote it, not of whether it is right.
- **The register cannot prove authorship or correctness, only currency and
  coherence** (§3). It cannot prove that the model named in `authored_by`
  wrote the string — only that the record cites a ruling permitting that
  author for that locale — and nothing here reviews it (OE-5).
- **Step 5, the 360 px render check (`gate:safety-copy-render`, `T-265`),
  has nothing to render yet**: no app surface shows these strings, and every
  key is in `AWAITING_SURFACE` against `T-110` or `T-107`. **Nothing has been
  measured at 360 px.** What has been measured is length in code points
  (Python `len()` over the catalogue value, `{address}` counted as its nine
  source characters, `T-233` at the landed copy): `call_112.script` `en` 94,
  `el` 106, `ru` 101; `sos.confirm` `en` 94, `el` 116, `ru` 117. Both are
  expected to wrap at 360 px; whether they wrap cleanly is what step 5 is for.
  (The `el` author's own note gives 111 for `sos.confirm`; the value in the
  catalogue measures 116.)
- **Step 6, the read-aloud check, is automated** (`gate:read-aloud`, `T-263`)
  and passes for the two `spoken_by_user` keys and `session.checkins_missed`
  in all three locales (9 pairs). No person has read any of them aloud, and
  espeak-ng does not check pronunciation (`T-263` § Published contract — LIVE
  §6).
- **`session.checkins_missed`'s channel is undetermined** and depends on
  `T-105`/`T-107`; its recipient is undetermined too. Until it is decided
  the key is held to both automated checks (§4).
- **`safety.helpline.1466.label`'s labelling is unverified** (PM §Q16) and must
  be confirmed with Hope For Children before launch — no check of the copy
  can settle it. OE-67 fixed the placeholder's wrong organisation (OD-247); it did
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
    mechanical; the argued check is in each NOTES.md; **no human check
    exists** — OE-5 dropped the DSL review).
  - **OD-251** — _open._ The SOS gesture (PM "one tap, confirm" vs "hold to
    send"), whether the confirmation should say the other party and the
    emergency contacts are notified (AC4 c/d), and the absence of any specified
    callback. The copy is gesture-neutral and silent on both until decided; if
    the control ships as hold-to-send, `safety.sos.confirm` changes in all three
    locales, and the gate refuses it until the same commit moves each record's
    hash and `AUTHORED_CONTENT_PINNED` (`STALE-RECORD`, `UNPINNED-CONTENT`).

---

# Appendices A, B and C — withdrawn under OE-5

Until `T-260` this file ended with three briefs: **A** for the Greek-authoring
safeguarding practitioner, **B** for the briefed Russian translator, and **C**
(added by `T-233`) for the DSL and deputy DSL — including Appendix C's asks for
a per-locale sign-off, the 360 px in-context review and the read-aloud pass.
Stakeholder rulings OE-66/OE-67 made an AI model the author of this copy, OE-5
(2026-10-11) dropped the DSL and deputy review, and OE-82 made the two checks
automated gates (§1), so no brief has anyone to go to. They were withdrawn by
`T-260`; their text survives in git (`git show a84c47f:packages/i18n/PIPELINE.md`,
from the line `# Appendix A`).
