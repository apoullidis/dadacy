/**
 * THE ROLE / PERMISSION MATRIX — SD §BE-10, transcribed as data.
 *
 * This file is a table and nothing else: it contains no `if`, no loop and no
 * function call, so it contributes no branch to the coverage gate. Every
 * branch lives in `can.ts`, and this file is the thing those branches are
 * driven by. That split is deliberate — SD §QD-1 requires "every
 * (actor, action, resource, time) combination in the role matrix" to be
 * exercised, and a matrix written as code would make the combination count and
 * the branch count the same number, which is how a table-driven test quietly
 * stops testing the table.
 *
 * SD §BE-10's legend, and how each cell spelling is modelled:
 *
 *   allow    -> A   (or AS where step-up applies)   basis `role_grant`
 *   own      -> O   (or OS)                         basis `own_record`
 *   window   -> W                                   basis `confirmed_booking_window`
 *   bg       -> BG                                  basis `break_glass`
 *   —        -> D                                   reason `role_missing`
 *
 * and the four qualified spellings the matrix also uses:
 *
 *   "allow (four-eyes)"        -> F4      reason `four_eyes_required` until countersigned
 *   "allow (Model A only)"     -> ART     reason `art10_model_prohibits_outcome_recording`
 *   "only if operator_language
 *    covers L" / "same"        -> LOC     reason `operator_does_not_cover_locale`
 *   "whitelisted subset" /
 *   "raise concern only"       -> CAP     DENIES today (TL-F2)
 *
 * The CAP cells are transcribed from the grid correctly and are NOT changed by
 * TL-F2: SD §BE-10 line 1262 really does give `trusted_contact` a "whitelisted
 * subset" of `session#read`, and line 1264 "raise concern only" on SOS. What
 * changed is the EVALUATOR behind the symbol, in `can.ts`: the capability grant
 * now fails closed, because the token's scope is not statable from SD §BE-10
 * (see the `capability` case there). So a CAP cell denies today, and the day a
 * successor gives `Capability` a scope, these two cells start allowing again
 * with no edit to this table.
 *
 * THE `W` CELL WAS IN THE SAME POSITION UNDER OE-20 AND IS NOT ANY MORE.
 * `T-134` restored the `window` evaluator with a real input contract, so the
 * single `W` cell — `sitter` on `child.health#read`, line 1251 of SD §BE-10 —
 * allows again. It needed NO EDIT HERE, which is the property this file was
 * kept honest for: the grid said `window` throughout, and the evaluator caught
 * back up with it.
 *
 * So exactly one withdrawal remains, and it is the CAP one: `trusted_contact`
 * gets no `session#read` and no `sos#raise_concern` (this table's two CAP
 * cells, and its only two non-deny cells), because OD-64 — the shape the
 * token's scope takes as an input to `can()` — is still unruled. It returns
 * with no edit to this table too, once it is.
 *
 * Nothing in this file records a withdrawal: a table that edited itself
 * whenever an evaluator was withdrawn would stop being a transcription of the
 * specification, which is the one property it exists to have.
 *
 * Three spellings in the matrix are NOT authorisation decisions and are
 * recorded here rather than modelled, because modelling them would make this
 * table claim something it cannot enforce:
 *   - "allow (with reason)" (support cancelling a booking) — the reason is a
 *     required request field, not a condition on the decision;
 *   - "allow (<= threshold)" (ts_operator refunds) — the threshold is priced in
 *     `market_config`, and money never crosses the wire from the client
 *     (PROTOCOL §9.6), so it is the pricing module's to enforce;
 *   - "metadata only" / "own status only" — a narrowing of WHAT is returned,
 *     modelled as a separate resource (`message.metadata`,
 *     `payout_ledger.metadata`) or as `own`, never as a flag on a decision.
 *
 * Step-up (the `S`-suffixed constants) follows SD §BE-10's own sentence:
 * payout account, home address, email/phone, password/passkey, payment-method
 * deletion, DSAR download, subscription cancellation — "and every admin action
 * beyond read".
 *
 * "Beyond read" means beyond READING, not beyond the literal action named
 * `read`. The non-mutating actions here are `read` AND `search`, and the
 * specification's own grid leaves `sitter_search#search` un-stepped-up for
 * `support`. So every back-office action that MUTATES carries step-up and
 * neither a read nor a search does — held by matrix.test.ts › *every
 * back-office action that mutates requires step-up, and no read or search
 * does*, which is the test that caught the wider reading.
 */
import type { Action, Cell, Grant, Resource, Row } from './types.ts';

const D: Grant = { kind: 'deny' };
const A: Grant = { kind: 'allow' };
const AS: Grant = { kind: 'allow', stepUp: true };
const O: Grant = { kind: 'own' };
const OS: Grant = { kind: 'own', stepUp: true };
const W: Grant = { kind: 'window' };
const BG: Grant = { kind: 'break_glass' };
const CAP: Grant = { kind: 'capability' };
const F4: Grant = { kind: 'four_eyes', stepUp: true };
const ART: Grant = { kind: 'art10', stepUp: true };
const LOC: Grant = { kind: 'locale', stepUp: true };

/**
 * Columns in SD §BE-10's order, so a row here can be read against the row in
 * the specification without re-ordering anything:
 * parent, sitter, trusted_contact, support, ts_operator, ts_senior, dsl,
 * finance, compliance, engineer.
 */
function row(
  parent: Grant,
  sitter: Grant,
  trusted_contact: Grant,
  support: Grant,
  ts_operator: Grant,
  ts_senior: Grant,
  dsl: Grant,
  finance: Grant,
  compliance: Grant,
  engineer: Grant,
): Row {
  return {
    parent,
    sitter,
    trusted_contact,
    support,
    ts_operator,
    ts_senior,
    dsl,
    finance,
    compliance,
    engineer,
  };
}

export const cell = (resource: Resource, action: Action): Cell => `${resource}#${action}`;

/**
 * **`MATRIX` transcribes SD §BE-10. It is NOT a statement of what `can()`
 * enforces** (TL2-A2). The two agree on every cell except the two `CAP` ones,
 * which the table shows as grants and which `can()` refuses while OD-64 is
 * unruled. Only `can()` answers what is enforced: a UI or a nav gate derived
 * from this table would show what the API refuses, which is the direction
 * SD §FE-3 line 465 forbids. **If `can()` refuses a case this table appears to
 * grant, the answer is the owning ticket, never a bypass and never a table
 * edit.**
 *
 * Every (resource, action) pair SD §BE-10 names. The matrix's 38 printed rows
 * decompose into these 46 by three routes, and SEVEN rows take one of them:
 *
 *   - three rows name more than one action in the row header itself:
 *     "Own account read/update" (2), "Accept/decline booking" (2),
 *     "Check-in / arrival / end" (3);
 *   - two rows name a NARROWER action in a single column, which becomes a row
 *     of its own: "SOS" ("raise concern only", trusted_contact) and
 *     "DSAR / erasure execute" ("request own", parent and sitter);
 *   - two rows name a metadata sub-view modelled as its own resource:
 *     "Message read (content)" -> `message.metadata`, and
 *     "Payout / ledger read" -> `payout_ledger.metadata`.
 *
 * 38 + 4 + 2 + 2 = 46. "Refunds / credits / compensation" is NOT one of the
 * seven: the three words are one action here, `refund#issue`.
 *
 * Held by matrix.test.ts › *the 38 printed rows of SD §BE-10 decompose into
 * exactly the 46 rows matrix.ts names* and › *exactly seven printed rows
 * become more than one row, and refunds / credits / compensation is not one of
 * them*, which drive a second transcription of the printed row list.
 */
export const MATRIX: ReadonlyMap<Cell, Row> = new Map<Cell, Row>([
  //                                    parent sitter t_c  supp ts_op ts_sen dsl  fin  comp eng
  ['account#read', row(O, O, D, D, D, D, D, D, D, D)],
  ['account#update', row(OS, OS, D, D, D, D, D, D, D, D)],
  ['account#remove_permanently', row(D, D, D, D, D, F4, AS, D, D, D)],
  ['sitter.public_profile#read', row(A, A, D, A, A, A, A, D, D, D)],
  ['sitter.contact_details#read', row(D, O, D, D, BG, BG, BG, D, D, BG)],
  ['child.health#read', row(O, W, D, D, BG, BG, BG, D, D, BG)],
  ['child.health#write', row(O, D, D, D, D, D, D, D, D, D)],
  ['certificate_outcome_metadata#read', row(D, O, D, D, BG, BG, BG, D, BG, BG)],
  ['certificate_outcome#record', row(D, D, D, D, ART, ART, ART, D, D, D)],
  ['idv_result#read', row(D, O, D, D, BG, BG, BG, D, BG, BG)],
  ['sitter_search#search', row(A, D, D, A, A, A, A, D, D, D)],
  ['booking#create', row(A, D, D, D, D, D, D, D, D, D)],
  ['booking#accept', row(D, O, D, D, D, D, D, D, D, D)],
  ['booking#decline', row(D, O, D, D, D, D, D, D, D, D)],
  ['booking#cancel', row(O, O, D, AS, AS, AS, AS, D, D, D)],
  ['message.content#read', row(O, O, D, D, BG, BG, BG, D, D, D)],
  ['message.metadata#read', row(O, O, D, A, BG, BG, BG, D, D, D)],
  ['message#send', row(O, O, D, D, D, D, D, D, D, D)],
  ['session#read', row(O, O, CAP, A, A, A, A, D, D, D)],
  ['session#check_in', row(D, O, D, D, D, D, D, D, D, D)],
  ['session#arrival', row(D, O, D, D, D, D, D, D, D, D)],
  ['session#end', row(D, O, D, D, D, D, D, D, D, D)],
  ['sos#raise', row(O, O, D, D, D, D, D, D, D, D)],
  ['sos#raise_concern', row(D, D, CAP, D, D, D, D, D, D, D)],
  ['sit_summary#write', row(D, O, D, D, D, D, D, D, D, D)],
  ['review#submit', row(O, O, D, D, D, D, D, D, D, D)],
  ['review#remove', row(D, D, D, D, AS, AS, AS, D, D, D)],
  ['verification_decision#record', row(D, D, D, D, AS, AS, AS, D, D, D)],
  ['non_clear_outcome#review', row(D, D, D, D, D, F4, AS, D, D, D)],
  ['four_eyes#countersign', row(D, D, D, D, D, AS, AS, D, D, D)],
  ['account_suspension#apply', row(D, D, D, D, AS, AS, AS, D, D, D)],
  ['pairing_block#apply', row(D, D, D, D, AS, AS, AS, D, D, D)],
  ['safeguarding_referral#make', row(D, D, D, D, D, D, F4, D, D, D)],
  ['staffed_hours_version#publish', row(D, D, D, D, D, D, F4, D, F4, D)],
  ['rota_shift#publish', row(D, D, D, D, D, AS, AS, D, D, D)],
  ['content_moderation#moderate', row(D, D, D, D, LOC, LOC, LOC, D, D, D)],
  ['refund#issue', row(D, D, D, D, AS, AS, D, AS, D, D)],
  ['payout_ledger#read', row(O, O, D, D, D, D, D, A, D, D)],
  ['payout_ledger.metadata#read', row(O, O, D, A, D, D, D, A, D, D)],
  ['audit_log#read', row(D, D, D, D, O, O, O, O, A, D)],
  ['retention_run#approve', row(D, D, D, D, D, D, D, D, F4, D)],
  ['dsar#request', row(O, O, D, D, D, D, D, D, D, D)],
  ['dsar#execute', row(D, D, D, D, D, D, D, D, AS, D)],
  ['feature_flag#toggle', row(D, D, D, D, D, AS, AS, D, D, AS)],
  ['feature_flag.compliance#toggle', row(D, D, D, D, D, F4, F4, D, F4, D)],
  ['production_data#read', row(D, D, D, D, D, D, D, D, D, BG)],
]);
