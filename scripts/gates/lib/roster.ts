/**
 * THE PR GATE ROSTER — T-005.
 *
 * SD §QD-4's PR row is a sentence. This file is that sentence turned into data,
 * so that "no gate silently absent, and no gate silently skipped" is a property
 * a program can check rather than a promise a reader has to take on trust.
 *
 * Two lists live here and they are checked against each other on every run:
 *
 *   SPEC_PR_ROW  the semicolon-separated items of SD §QD-4's PR row, quoted.
 *                IT IS A TRANSCRIPTION AND NOTHING MECHANICAL ANCHORS IT.
 *                software-design.md lives outside the git repo these gates
 *                run in, so no gate can re-read it. What `gate:pr` checks is
 *                the ROSTER against this list, both ways (cases A1 and A4);
 *                it cannot check this list against SD. A coordinated edit to
 *                an item here AND to the roster entry answering it passes,
 *                and an SD revision adding an eighteenth PR item would go
 *                unnoticed. Re-checking the transcription when SD is revised
 *                is the orchestrator's standing obligation, recorded as such
 *                rather than described here as something a gate does.
 *   ROSTER       every gate command the PR stage knows about, each carrying the
 *                SPEC_PR_ROW item it answers (or PROGRAMME, for the gates this
 *                build added that SD does not name).
 *
 * `gate:pr` FAILS if a SPEC_PR_ROW item has no roster entry. That is the
 * divergence check: a gate cannot be dropped, only moved between classes, and
 * every non-BLOCKING class must carry an owner and an unblock condition or the
 * roster itself is refused.
 *
 * EVERY ROSTERED GATE IS EXECUTED ON EVERY `gate:pr` RUN, including the ones
 * that are not expected to pass. Its outcome must match its declared class:
 *
 *   BLOCKING  must exit 0. Non-zero fails gate:pr.
 *   PENDING   the gate's CONTENT does not exist yet and is owed by a named
 *             ticket. The command must exist and must exit NON-ZERO. If it
 *             starts exiting 0 the owner has supplied it and nobody promoted
 *             it, so gate:pr FAILS and says so. Its failure does not otherwise
 *             fail gate:pr — the roster, not the exit status, is what makes its
 *             absence visible.
 *   BLOCKED   the check EXISTS and is red for a reason owned by a named, parked
 *             ticket. It runs and is judged against a pinned expected failure.
 *             Green, or red in any other way, FAILS gate:pr.
 *   SERVICE   in SD's PR row, but needs a running service, and `gate:pr`
 *             declares none (DOCKER.md §4/§7: `scripts/dev` has egress and no
 *             services). Executed by `gate:heavy` / `scripts/svc run`. The
 *             command must exist and must refuse in the PR stage WITH ITS OWN
 *             `GATE NEEDS A SERVICE` BANNER — not PENDING's "not yet
 *             supplied", which would be false of a gate that is supplied and
 *             runs one stage over (T-006). scripts/gates/lib/heavy-roster.ts
 *             refuses a SERVICE entry here that the heavy stage does not
 *             execute, so this class can no longer name a stage in prose and
 *             be believed.
 *
 * Why PENDING does not fail gate:pr: `gate:pr` is the Definition-of-Done gate
 * every other ticket in the programme must show green (PROTOCOL §5). A stage
 * that is red from now until the last hook lands is a stage nobody can satisfy,
 * and a gate nobody can satisfy stops being read. The teeth are elsewhere and
 * they are sharper: the hook is EXECUTED, its class is asserted, its owner is
 * named, and the roster is held against the spec text.
 */

export type GateClass = 'BLOCKING' | 'PENDING' | 'BLOCKED' | 'SERVICE';

/** The literal item of SD §QD-4's PR row a roster entry answers. */
export const PROGRAMME = 'PROGRAMME' as const;

export interface RosterEntry {
  /** The pnpm script name. `pnpm run <name>` must exist. */
  readonly name: string;
  /** The SD §QD-4 PR-row item this answers, verbatim, or PROGRAMME. */
  readonly spec: string;
  readonly cls: GateClass;
  readonly why: string;
  /** Required for PENDING / BLOCKED / SERVICE: who owes the green. */
  readonly owner?: string;
  /** Required for PENDING / BLOCKED / SERVICE: what exactly makes it green. */
  readonly unblocks?: string;
}

/**
 * SD §QD-4, the PR row, split on its semicolons and quoted verbatim.
 *
 * SEVENTEEN items. `platform-infrastructure.md` § Charter says "sixteen
 * blocking PR gates"; the row as written has seventeen semicolon-separated
 * items. Reported in state/EP-1/T-005.md rather than reconciled by quietly
 * dropping one — the count is the role file's, the text is SD's, and SD is
 * authoritative for mechanism (PROTOCOL §2).
 */
export const SPEC_PR_ROW: readonly string[] = [
  'Typecheck',
  'ESLint + import-boundary (dependency-cruiser)',
  'unit tests',
  'policy tests at 100% branch',
  'Zod↔OpenAPI drift',
  '`size-limit` per route',
  'migration lint',
  '`pnpm audit` + Trivy',
  'gitleaks',
  'Semgrep project rules',
  'Drizzle introspection parity',
  '`gate:locale-completeness`',
  '`gate:prohibited-claims`',
  '`gate:safety-review-currency`',
  '`gate:plural-completeness` (EV-2)',
  'the SMS segment-count assertion',
  'the PII leak-canary (§SEC-I5)',
];

export const ROSTER: readonly RosterEntry[] = [
  // ---------------------------------------------------------------- T-001's
  {
    name: 'gate:toolbox',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: 'toolchain pins, determinism, ownership (QA-F3)',
  },
  {
    name: 'gate:typecheck',
    spec: 'Typecheck',
    cls: 'BLOCKING',
    why: 'TypeScript strict across the workspace (SD §DH-2)',
  },
  {
    name: 'gate:lint',
    spec: 'ESLint + import-boundary (dependency-cruiser)',
    cls: 'BLOCKING',
    why: 'ESLint flat config + Prettier (SD §DH-2)',
  },
  {
    name: 'gate:deps',
    spec: 'ESLint + import-boundary (dependency-cruiser)',
    cls: 'BLOCKING',
    why: 'dependency-cruiser module boundaries (SA §SA-2)',
  },
  {
    // T-005, OD-60. FIVE of the plugin's ten `no-unsafe-*` rules — the
    // value-flow ones — which need type information. Sites in other agents'
    // packages are red today. A ratchet, not a waiver: each is enumerated with
    // its owner in scripts/gates/no-unsafe-any.baseline.json, ONE MORE fails,
    // and fixing one also fails until its entry is removed. The COUNT is not
    // written here (it moved from nine to thirteen when T-147 merged) and
    // neither is a claim that the five are the whole family — they are not:
    // `no-unsafe-type-assertion` is not enabled and is T-174's decision.
    name: 'gate:no-unsafe-any',
    spec: 'ESLint + import-boundary (dependency-cruiser)',
    cls: 'BLOCKING',
    why: 'an `any` VALUE reaching a branded type — the half `no-explicit-any` cannot see (OD-60, SD §DH-2)',
  },
  {
    name: 'gate:secrets',
    spec: 'gitleaks',
    cls: 'BLOCKING',
    why: 'gitleaks (SD §QD-4)',
  },
  {
    name: 'gate:trivy',
    spec: '`pnpm audit` + Trivy',
    cls: 'BLOCKING',
    why: 'dependency vulnerabilities, HIGH+CRITICAL over the whole lockfile (SD §QD-4)',
  },
  {
    // T-005. T-001 wired Trivy and deliberately left this half out; SD names
    // both. Decided, not inherited — state/EP-1/T-005.md § The `pnpm audit`
    // decision.
    name: 'gate:audit',
    spec: '`pnpm audit` + Trivy',
    cls: 'BLOCKING',
    why: 'the GitHub Advisory database over the same lockfile, at Trivy’s threshold (SD §QD-4)',
  },
  {
    name: 'gate:size-limit',
    spec: '`size-limit` per route',
    cls: 'BLOCKING',
    why: 'per-route JS budgets (SD §PERF)',
  },
  {
    name: 'gate:egress-boundary',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: 'every compose service on kinvara-int and nothing else; svc run has no egress; an overlay ADDITION is not an override (DOCKER.md §7, OD-12, OD-16, QA-F5)',
  },
  {
    name: 'gate:app-images',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: 'static checks over EVERY Dockerfile an overlay service builds and over compose.yml + every overlay (DOCKER.md §5, §3). The scope of each check is published in state/EP-1/T-036.md § Published contract, with the negative case that falsifies it; this gate is static and still cannot look inside an image — anchor image properties on docker image inspect and on the build',
  },
  {
    name: 'gate:otel-contract',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: "SD §QD-5's instrumentation contract held against the artefacts that consume it: every OpenAPI operation has a route -> data_class entry, the OTel Collector is an ALLOWLIST (SA §TS-10 rule 1) carrying every contract field, the three dashboards name only metrics/labels/label VALUES this pipeline produces, and apps/core's adapter never reads the raw request URL. IT CONTAINS NO PII PATTERN AND RUNS NOTHING — gate:pii-canary (T-119) is the leak canary and state/EP-1/T-008.md § contract §5 states this ticket's own mechanism at its true width",
  },
  {
    name: 'gate:constraint-suite:static',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: "the Testcontainers image tag is compose's, and no constraint suite mocks the database (T-115)",
  },
  {
    name: 'gate:migration-lint',
    spec: 'migration lint',
    cls: 'BLOCKING',
    why: 'expand/contract, protected objects, append-only grants, and merged migrations change only in comments (SD §DB-13, PROTOCOL §3)',
  },

  // ---------------------------------------------------------------- T-005's
  {
    // T-133 published it and recorded "not in gate:pr — T-005's".
    name: 'gate:semgrep',
    spec: 'Semgrep project rules',
    cls: 'BLOCKING',
    why: 'the committed local rule set, no network, no registry rule (T-133)',
  },
  {
    // OD-61: the row is blocking and the rule set is enumerated nowhere that
    // blocks. This is where it is enumerated, and it refuses drift both ways.
    name: 'gate:semgrep-rules',
    spec: 'Semgrep project rules',
    cls: 'BLOCKING',
    why: "SD §QD-1's thirteen project rules enumerated where they block, each INSTALLED or with the ticket that owes it (OD-61)",
  },
  {
    // T-022 published it and recorded "not in gate:pr — T-005's".
    name: 'gate:contract-drift',
    spec: 'Zod↔OpenAPI drift',
    cls: 'BLOCKING',
    why: 'the committed OpenAPI document and typed client must match a fresh generation from the Zod schemas (T-022)',
  },
  {
    // OD-57 + OD-3.
    name: 'gate:unit-tests',
    spec: 'unit tests',
    cls: 'BLOCKING',
    why: "every workspace package's `test` script, and a package that ships source or test files without one (OD-57, OD-3)",
  },
  {
    name: 'gate:policy-coverage',
    spec: 'policy tests at 100% branch',
    cls: 'BLOCKING',
    why: 'packages/policy at 100% branch over every tracked source file it has (SD §QD-1, SA §TS-11)',
  },
  {
    // OD-152.
    name: 'gate:negative-suites',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: 'the committed negative suites this gate rosters — the refusals every other gate contract cites (OD-152, OD-120, OD-154, OD-161a). The roster is a hand list, not a scan of scripts/negative-tests/: see OD-170.',
  },
  {
    // OD-51.
    name: 'gate:supply-chain',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: "pnpm's minimum-release-age exemptions are a recorded decision, not a line pnpm writes for you (OD-51)",
  },
  {
    // T-005's own negative suite. Not a member of gate:negative-suites, which
    // it attacks (its lock and its dirty-tree refusal); see the header of
    // scripts/gates/pr-gate-suite.ts.
    name: 'gate:pr-gate-suite',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: "scripts/negative-tests/pr-gates.sh — every refusal T-005's gates make, demonstrated refusing (PROTOCOL §5 item 4)",
  },
  {
    name: 'gate:workflow',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: '.github/workflows/*.yml is schema-valid and names exactly this roster — authored and validated, NEVER executed (PROTOCOL §5.1)',
  },

  // -------------------------------------------------- needs a service (T-006)
  {
    // T-006 LANDED, and this entry's meaning changed with it although its CLASS
    // did not. `pnpm gate:drizzle-parity` is no longer a not-yet-supplied hook:
    // it is scripts/gates/drizzle-parity.ts, which runs T-138's live
    // `db:introspect:check` wherever a database is attached and prints
    // `GATE NEEDS A SERVICE` where one is not. It stays SERVICE here because
    // this stage declares `svc: none` and always will (DOCKER.md §7) — that is
    // structural, not a debt, and no ticket can pay it off. What T-006
    // discharged is the DEBT: scripts/gates/lib/heavy-roster.ts rosters it
    // BLOCKING and `pnpm gate:heavy` executes it against the ticket project's
    // real database. heavyRosterProblems() refuses a SERVICE entry here that
    // the heavy roster does not execute, so a second one cannot be added and
    // then run nowhere.
    name: 'gate:drizzle-parity',
    spec: 'Drizzle introspection parity',
    cls: 'SERVICE',
    why: '`pnpm -w db:introspect:check` migrates a real database and re-introspects it (T-138, T-150, T-152)',
    owner: 'T-006 (gate:heavy) — SUPPLIED there; the command is LIVE and owned by T-138',
    unblocks:
      'nothing here: it is green where it runs. `pnpm gate:heavy` executes it under `scripts/svc run <ticket> --`. It cannot run in THIS stage because gate:pr declares `svc: none` (DOCKER.md §7), which is structural and permanent.',
  },

  // ------------------------------------------------ hooks other agents supply
  {
    // T-042 supplied it (frontend-developer), so this entry moved PENDING ->
    // BLOCKING and lost its owner/unblocks fields, as T-005 § Published
    // contract §8 requires. The check reads the catalogue SOURCE and the
    // committed compiled/ — see packages/i18n/tools/locale-completeness.ts.
    name: 'gate:locale-completeness',
    spec: '`gate:locale-completeness`',
    cls: 'BLOCKING',
    why: 'no Critical- or Transactional-tier string may resolve to a missing translation (SA §TS-12.3, SD §FE-10)',
  },
  {
    name: 'gate:prohibited-claims',
    spec: '`gate:prohibited-claims`',
    cls: 'PENDING',
    why: 'prohibited marketing claims across all three locales, `el`/`ru` lists natively authored (PM §MVP-L4 AC6, §MVP-S8 AC5, §MVP-IS9 AC6)',
    owner: 'T-043 — frontend-developer (blocked_by T-040, T-005)',
    unblocks:
      'T-043 supplies the three lists with named authorship and the gate fails on each prohibited string in each locale (nine demonstrated failures minimum).',
  },
  {
    // T-044 supplied it (frontend-developer), so this entry moved PENDING ->
    // BLOCKING and lost its owner/unblocks fields, as T-005 § Published
    // contract §8 (as amended, OD-176) requires. It is green today BECAUSE OF
    // the dated, self-closing T-049 waiver, which it prints and which expires
    // 2026-12-05 — see packages/i18n/tools/safety-review-currency.ts.
    name: 'gate:safety-review-currency',
    spec: '`gate:safety-review-currency`',
    cls: 'BLOCKING',
    why: 'a `safety_critical` string without a current DSL review record fails the build (SD §Revision Log D8, SA §TS-12.3)',
  },
  {
    name: 'gate:plural-completeness',
    spec: '`gate:plural-completeness` (EV-2)',
    cls: 'PENDING',
    why: 'reads `locale_registry.plural_categories` so it generalises to a fourth locale (SD EV-2)',
    owner: 'T-045 — frontend-developer (blocked_by T-040, T-064)',
    unblocks:
      'T-045 reads the registry and the gate fails on a `ru` catalogue supplying only `one`/`other`.',
  },
  {
    // T-046 supplied it (frontend-developer), so this entry moved PENDING ->
    // BLOCKING and lost its owner/unblocks fields, as T-005 § Published
    // contract §8 (as amended, OD-176) requires. The corpus it asserts over is
    // DECLARED in packages/i18n/channels.json, because before T-046 "every
    // Critical/Transactional SMS template" named a set nobody had defined and
    // the obvious gate would have been green over nothing.
    //
    // THE `why` BELOW WAS CORRECTED BY T-046 (rework 1b), under T-005 § contract
    // §8 as amended — OD-176's SIXTH GRANTED EDIT, as clarified by the
    // orchestrator 2026-09-21T13:15Z: a ticket PROMOTING A HOOK may correct its
    // OWN entry's `why` when the correction is a fact its own published contract
    // measures, at any delivery made while the amendment is in force, INCLUDING
    // A REWORK. No other entry and no other field.
    //
    // The old text, quoted so the diff is not the only record of it:
    //
    //   every Critical/Transactional SMS template at ≤2 segments per locale,
    //   UCS-2 at 70 chars for `el`/`ru` (PM §MVP-N1 AC3, SA §TS-12, §C7)
    //
    // Two of its clauses were MEASURED false by the ticket that supplied this
    // gate, and this entry's text is what gate:pr PRINTS as the gate's
    // description on every run:
    //
    //  1. `70` is the SINGLE-segment UCS-2 figure. A concatenated segment
    //     carries a 6-octet UDH — 48 bits, 3 UTF-16 code units — so it holds 67
    //     and <=2 segments is <=134 units, not 140. The GSM-7 pair is 153/306,
    //     not 160/320. A gate built on 70 admits a THREE-segment message: 140
    //     units is 3. Measured both ways on the real Greek template — it passes
    //     at exactly 134 and fails at 135 (T-046 § Evidence 3).
    //  2. "UCS-2 for el/ru" is an assumption and it is wrong in BOTH
    //     directions. Ten Greek capitals — Δ Φ Γ Λ Ω Π Ψ Σ Θ Ξ — are in the
    //     GSM-7 basic alphabet, so a 200-character all-Greek-capital string
    //     measures 2 segments while the locale rule calls it 3 and REJECTS
    //     VALID COPY; and FOUR `en` strings are UCS-2 because of an em dash
    //     (call_112.label, helpline.116111.label, helpline.1466.label,
    //     helpline.199.label), so the rule is lenient there. QA-F3 is that this
    //     comment said "three" when the measurement, in T-046 § Published
    //     contract §4 and in QA-2, is four.
    //
    // The authority is in T-046 § Published contract §4 (the arithmetic) and §2
    // (the declared corpus); decisions.md OD-180 is the row that carried this
    // defect while the bound forbade the edit.
    name: 'gate:sms-segments',
    spec: 'the SMS segment-count assertion',
    cls: 'BLOCKING',
    why: 'every Critical/Transactional SMS template — the corpus DECLARED in packages/i18n/channels.json — at ≤2 segments per locale, which is ≤134 UCS-2 code units or ≤306 GSM-7 septets because a concatenated segment pays a 6-octet UDH (70/160 are the SINGLE-segment figures), with the encoding MEASURED per string and never inferred from the locale (PM §MVP-N1 AC3, SA §TS-12, §C7)',
  },
  {
    name: 'gate:pii-canary',
    spec: 'the PII leak-canary (§SEC-I5)',
    cls: 'PENDING',
    why: 'Cyprus ID/ARC/TIN/IBAN/passport/vehicle/E.164 patterns and the cross-script name canary, over log lines (SD §SEC-I5, §Revision Log G1)',
    owner: 'T-119 — qa-verification (blocked_by T-116, T-008)',
    unblocks:
      'T-119 supplies the pattern set; each pattern is demonstrated catching a planted value in a log line, the cross-script canary catching «Χριστοδούλου».',
  },
];

/** Entries needing an owner + unblock condition, by class. */
export function rosterProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of ROSTER) {
    if (seen.has(e.name)) problems.push(`duplicate roster entry: ${e.name}`);
    seen.add(e.name);
    if (e.cls !== 'BLOCKING') {
      if (e.owner === undefined || e.owner.trim() === '') {
        problems.push(
          `${e.name} is ${e.cls} with no owner — a class with no owner is a silent skip`,
        );
      }
      if (e.unblocks === undefined || e.unblocks.trim() === '') {
        problems.push(
          `${e.name} is ${e.cls} with no unblock condition — that is an open-ended allowance`,
        );
      }
    }
    if (e.spec !== PROGRAMME && !SPEC_PR_ROW.includes(e.spec)) {
      problems.push(
        `${e.name} claims SD §QD-4 item ${JSON.stringify(e.spec)}, which is not in SPEC_PR_ROW`,
      );
    }
  }
  for (const item of SPEC_PR_ROW) {
    if (!ROSTER.some((e) => e.spec === item)) {
      problems.push(
        `SD §QD-4 PR row item ${JSON.stringify(item)} has NO roster entry — silently absent`,
      );
    }
  }
  return problems;
}
