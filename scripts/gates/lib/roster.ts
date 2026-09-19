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
 *                Nothing in this file may change what that row says.
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
 *             command must exist and must refuse in the PR stage.
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
    // T-005, OD-60. The no-unsafe-* family needs type information, and nine
    // sites in six files owned by four other agents are red today. A ratchet,
    // not a waiver: the nine are enumerated with their owners, a tenth fails,
    // and fixing one of the nine also fails until its entry is removed.
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
    why: 'the committed negative suites — the refusals every other gate contract cites (OD-152, OD-120, OD-154, OD-161a)',
  },
  {
    // OD-51.
    name: 'gate:supply-chain',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: "pnpm's minimum-release-age exemptions are a recorded decision, not a line pnpm writes for you (OD-51)",
  },
  {
    name: 'gate:workflow',
    spec: PROGRAMME,
    cls: 'BLOCKING',
    why: '.github/workflows/*.yml is schema-valid and names exactly this roster — authored and validated, NEVER executed (PROTOCOL §5.1)',
  },

  // -------------------------------------------------- needs a service (T-006)
  {
    name: 'gate:drizzle-parity',
    spec: 'Drizzle introspection parity',
    cls: 'SERVICE',
    why: '`pnpm -w db:introspect:check` migrates a real database and re-introspects it (T-138, T-150, T-152)',
    owner: 'T-006 (gate:heavy) — the command itself is LIVE and owned by T-138',
    unblocks:
      'run it where a database exists: `scripts/svc run <ticket> -- pnpm -w db:introspect:check`. It cannot run in the PR stage because gate:pr declares `svc: none` (DOCKER.md §7). T-006 puts it in gate:heavy.',
  },

  // ------------------------------------------------ hooks other agents supply
  {
    name: 'gate:locale-completeness',
    spec: '`gate:locale-completeness`',
    cls: 'PENDING',
    why: 'no Critical- or Transactional-tier string may resolve to a missing translation (SA §TS-12.3, SD §FE-10)',
    owner: 'T-042 — frontend-developer (blocked_by T-040, T-005)',
    unblocks:
      'T-042 replaces the hook with the check and moves this entry to BLOCKING. Acceptance: the gate fails on a deliberately removed `ru` key and passes when restored.',
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
    name: 'gate:safety-review-currency',
    spec: '`gate:safety-review-currency`',
    cls: 'PENDING',
    why: 'a `safety_critical` string without a current DSL review record fails the build (SD §Revision Log D8, SA §TS-12.3)',
    owner: 'T-044 — frontend-developer (blocked_by T-040, T-005)',
    unblocks:
      'T-044 makes `review.json` a build input and the gate fails on a `safety_critical` string with a stale or absent review record.',
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
    name: 'gate:sms-segments',
    spec: 'the SMS segment-count assertion',
    cls: 'PENDING',
    why: 'every Critical/Transactional SMS template at ≤2 segments per locale, UCS-2 at 70 chars for `el`/`ru` (PM §MVP-N1 AC3, SA §TS-12, §C7)',
    owner: 'T-046 — frontend-developer (blocked_by T-040)',
    unblocks:
      'T-046 supplies the assertion; it fails on a Greek template exceeding 2 segments and passes at the limit.',
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
