/**
 * THE HEAVY GATE ROSTER — T-006.
 *
 * SD §QD-4 has two PR-stage rows. `scripts/gates/lib/roster.ts` (T-005) holds
 * the first one as data. THIS FILE HOLDS THE SECOND — the "PR (heavy)" row —
 * plus the one item of the PR row that cannot run in the PR stage at all, and
 * whose execution SD's pipeline therefore has nowhere else to put.
 *
 * It is the same shape as T-005's roster, deliberately, and for the same
 * reason: so that "no sub-gate silently absent, and no sub-gate silently
 * skipped" is a property a program checks rather than a promise a reader takes
 * on trust. Four classes, every rostered entry EXECUTED on every run, an owner
 * and an unblock condition on every entry that is not green.
 *
 * WHY THIS MATTERS MORE HERE THAN IN THE PR STAGE, AND IT IS THE WHOLE POINT
 * OF T-006. Three of SD's four heavy items — Lighthouse, axe-core and the
 * Playwright journeys — have NOTHING TO RUN AGAINST on the day this lands.
 * `apps/web` is a declared placeholder (T-001: "topology only ... no source,
 * no dependencies, no scripts"), owned by `frontend-developer`, and the
 * tickets that would give it a page, a flow and a journey — T-050, T-051,
 * T-120 — are themselves `blocked`. The tempting move is to stand a Lighthouse
 * run up against the placeholder and report a number. A green heavy gate that
 * scanned nothing is worse than no heavy gate at all: it is
 * platform-infrastructure.md's "a gate that is configured but not blocking is
 * worse than no gate", one level up, and PROTOCOL §5.1's question asked of the
 * aggregate itself — IF IT CHECKED NOTHING, WOULD IT SAY SO?
 *
 * So the three are rostered PENDING with their real owners and their real
 * unblock conditions, and they are EXECUTED on every run as not-yet-supplied
 * hooks. If one of them ever starts exiting 0, `gate:heavy` goes red and
 * demands the promotion, exactly as `gate:pr` does (case A8's property, one
 * stage over).
 *
 *   BLOCKING  must exit 0, AND must print its own evidence anchor. A banner
 *             with no anchor beside it is judged CRASHED, not passed — a
 *             harness must never infer a verdict from a signal a no-op also
 *             produces (PROTOCOL §5.1).
 *   PENDING   the gate's CONTENT does not exist yet and is owed by a named
 *             ticket. The command must exist and must exit NON-ZERO with the
 *             `GATE NOT YET SUPPLIED` banner.
 *   BLOCKED   the check EXISTS and is red for a reason owned by a named,
 *             parked ticket, judged against a pinned expected failure.
 *   SERVICE   in a stage that cannot start the service it needs. Nothing is
 *             in this class here, and that is the point of the stage: the
 *             heavy stage is where a SERVICE gate RUNS.
 *
 * THE ENTRY POINT IS PART OF THE ROSTER, BECAUSE NO ONE INVOCATION HAS BOTH.
 * `DOCKER.md` §7 and T-034 §2 put the Docker socket in `scripts/dev --docker`
 * and REFUSE it to `scripts/svc run` by name; `svc run` is the only thing that
 * puts a process on a ticket's `kinvara-int` where `postgres:5432` resolves.
 * The Testcontainers suite needs the socket and no compose service; Drizzle
 * parity needs a compose service and no socket. They cannot share a process,
 * so each entry declares the entry point it requires and `scripts/gates/
 * heavy.ts` runs the ones the current invocation can run — and REFUSES to
 * report a pass for the ones it did not run unless a receipt from the other
 * invocation, at this same tree state, carries their output.
 */
import { PROGRAMME, ROSTER, SPEC_PR_ROW } from './roster.ts';
import type { GateClass } from './roster.ts';

export type { GateClass };
export { PROGRAMME };

/**
 * The entry point an entry requires.
 *
 *   'any'      runs anywhere — the not-yet-supplied hooks.
 *   'socket'   `scripts/dev --docker` (KINVARA_DOCKER_SOCKET=1). Testcontainers.
 *   'service'  `scripts/svc run <ticket>` (KINVARA_PROJECT + PGHOST). Compose.
 */
export type Segment = 'any' | 'socket' | 'service';

/** Marks an entry answering SD §QD-4's PR row rather than its heavy row. */
export const PR_ROW = 'PR_ROW' as const;

export interface HeavyEntry {
  /** The pnpm script name. `pnpm run <name>` must exist. */
  readonly name: string;
  /** The SD §QD-4 "PR (heavy)" row item this answers, verbatim, or PR_ROW. */
  readonly spec: string;
  /** Set iff spec is PR_ROW: the SD §QD-4 PR-row item, verbatim. */
  readonly prSpec?: string;
  readonly cls: GateClass;
  readonly segment: Segment;
  readonly why: string;
  readonly owner?: string;
  readonly unblocks?: string;
  /**
   * BLOCKING only. Substrings and patterns the gate's own output must carry
   * for a zero exit to count as a pass.
   *
   * THIS IS NOT A SECOND CHECK OF THE THING THE SUB-GATE CHECKS, and it must
   * not be read as one — it is computed from the same output, so it could not
   * be (PROTOCOL §5.1's same-source rule). It is the aggregate refusing to
   * accept a BANNER WITHOUT THE RUN'S OWN EVIDENCE BESIDE IT: a sub-gate
   * replaced by `true`, a sub-gate that skipped every file, a sub-gate that
   * printed a pass over an empty set. "Ran and did something", "refused" and
   * "crashed" stay three distinguishable outcomes.
   */
  readonly anchors?: readonly AnchorSpec[];
  /** BLOCKED only: the failure this entry is pinned to, and its owner's ticket. */
  readonly pinnedFailure?: string;
  readonly pinnedCases?: number;
}

export interface AnchorSpec {
  /** Human name, printed when it is missing. */
  readonly label: string;
  /** A line the output must carry. */
  readonly pattern: RegExp;
  /**
   * Optional numeric floor: every capture group named here must parse as a
   * number and be >= its floor. This is the anti-vacuity half.
   */
  readonly atLeast?: readonly (readonly [group: number, floor: number])[];
  /** Optional: two capture groups that must be equal. */
  readonly equal?: readonly (readonly [a: number, b: number])[];
}

/**
 * SD §QD-4, the "PR (heavy)" row, split on its semicolons and quoted verbatim.
 *
 * FOUR items. Read from software-design.md line 4186 directly.
 *
 * IT IS A TRANSCRIPTION AND NOTHING MECHANICAL ANCHORS IT — the same bound
 * T-005's SPEC_PR_ROW carries and for the same reason: software-design.md
 * lives outside the git repo these gates run in, so no gate can re-read it.
 * What `gate:heavy` checks is the ROSTER against this list, both ways. It
 * cannot check this list against SD. A coordinated edit to an item here AND to
 * the entry answering it passes, and an SD revision adding a fifth heavy item
 * would go unnoticed. Re-checking the transcription when SD is revised is the
 * orchestrator's standing obligation (T-005 § contract §1 records it), not
 * something this gate does.
 */
export const SPEC_HEAVY_ROW: readonly string[] = [
  'Lighthouse CI (Moto-G profile, `?locale=el`)',
  '`axe-core` on all core flows in all three locales',
  'Playwright on the four journeys incl. offline + keyboard variants + the `?locale=pseudo` viewport matrix',
  'Testcontainers constraint suite',
];

const WEB_IS_A_PLACEHOLDER =
  'apps/web is a declared placeholder (T-001: topology only, no source, no dependencies, no ' +
  'scripts) and belongs to frontend-developer. There is nothing to load, scan or drive. ' +
  'T-006 deliberately did NOT stand this up against the placeholder: a green heavy gate that ' +
  'scanned nothing is the worst outcome available here.';

export const HEAVY_ROSTER: readonly HeavyEntry[] = [
  // ------------------------------------------------- SD §QD-4 "PR (heavy)" row
  {
    name: 'gate:lighthouse',
    spec: 'Lighthouse CI (Moto-G profile, `?locale=el`)',
    cls: 'PENDING',
    segment: 'any',
    why: 'Lighthouse CI on the Moto-G profile against the `?locale=el` render, with the SD §PERF budgets as its assertion',
    owner: 'T-051 — frontend-developer (blocked_by T-050, which is blocked_by T-047)',
    unblocks: `T-051 supplies the runner and the budgets once apps/web has a route to load. ${WEB_IS_A_PLACEHOLDER}`,
  },
  {
    name: 'gate:axe',
    spec: '`axe-core` on all core flows in all three locales',
    cls: 'PENDING',
    segment: 'any',
    why: 'axe-core over every core flow in `en`, `el` and `ru`, failing on any violation at the SD §FE accessibility bar',
    owner: 'T-051 — frontend-developer (blocked_by T-050, which is blocked_by T-047)',
    unblocks: `T-051 supplies the flow list and the axe run once apps/web has a flow to scan. ${WEB_IS_A_PLACEHOLDER}`,
  },
  {
    name: 'gate:playwright-journeys',
    spec:
      'Playwright on the four journeys incl. offline + keyboard variants + the ' +
      '`?locale=pseudo` viewport matrix',
    cls: 'PENDING',
    segment: 'any',
    why: "Playwright over SD's four critical journeys, each in its offline and keyboard variants, plus the `?locale=pseudo` viewport matrix",
    owner: 'T-120 — qa-verification (blocked_by T-115, T-052)',
    unblocks: `T-120 supplies the four journeys once apps/web has a journey to drive. ${WEB_IS_A_PLACEHOLDER}`,
  },
  {
    name: 'gate:constraint-suite',
    spec: 'Testcontainers constraint suite',
    cls: 'BLOCKING',
    segment: 'socket',
    why: "T-115's harness: every constraint suite against a disposable cluster of the SAME pinned Postgres image docker/compose.yml declares, asserted at acquisition",
    anchors: [
      {
        label: 'the run registered tests, every file ran, and all of them passed',
        // `  ok    tests 171 / passed 171 / failed 0 / skipped 0 / todo 0 /
        //   files 12 of 12, 0 failed (numFailedTestSuites 0)`
        pattern:
          /tests (\d+) \/ passed (\d+) \/ failed (\d+) \/ skipped (\d+) \/ todo (\d+) \/ files (\d+) of (\d+)/,
        atLeast: [
          [1, 1],
          [6, 1],
        ],
        equal: [
          [1, 2],
          [6, 7],
        ],
      },
    ],
  },

  // ---------------------------- SD §QD-4's PR row, executed where it CAN run
  {
    // T-005 § contract §3 rosters this SERVICE and names T-006 as the place it
    // runs; roster.ts's own entry says so in its `unblocks`. This is that
    // place. The command is T-138's and is LIVE.
    name: 'gate:drizzle-parity',
    spec: PR_ROW,
    prSpec: 'Drizzle introspection parity',
    cls: 'BLOCKING',
    segment: 'service',
    why: "`pnpm -w db:introspect:check` (T-138) migrates the ticket project's real database, re-introspects it and compares the rendering to the committed db/schema.ts byte for byte",
    anchors: [
      {
        label: 'it migrated a real database',
        pattern: /MIGRATE OK {2}up: \S+ -> \S+/,
      },
      {
        label: 'it introspected at least one relation from a real catalogue',
        pattern: /drizzle-kit \S+: (\d+) relation\(s\) introspected from public/,
        atLeast: [[1, 1]],
      },
      {
        label: 'it compared the committed file against a fresh rendering',
        pattern: /db\/schema\.ts: byte-identical to a fresh introspection/,
      },
    ],
  },

  // ------------- a committed suite that no stage could run until this one
  {
    // T-005 § contract §6: `gate:negative-suites` pins this suite's SHA-256
    // instead of running it, because the PR stage has no database — and says
    // "its home is gate:heavy (T-006) even once green". This is that home, and
    // running it is what closes the gap T-005 names: a digest detects that the
    // FILE changed, and OD-154 happened when `main` moved underneath a suite
    // nobody had touched.
    name: 'gate:db-introspect-suite',
    spec: PROGRAMME,
    cls: 'BLOCKED',
    segment: 'service',
    why: "scripts/negative-tests/db-introspect.sh — 65 cases attacking T-138's parity check, against a real database",
    owner: 'T-165 — tech-lead, PARKED awaiting stakeholder ruling OE-37 (OD-154)',
    unblocks:
      "T-165 re-cuts the K36-K49 plants to add to 0006's `pgboss` schema and takes the admitted counts from the catalogue. Then this entry becomes BLOCKING and the pinned failure below is deleted.",
    pinnedFailure: '!! 25 of 65 cases misbehaved',
    anchors: [
      {
        label: 'the suite printed a footer at all',
        pattern: /(ALL \d+ CASES BEHAVED AS EXPECTED|!! \d+ of \d+ cases misbehaved)/,
      },
    ],
  },
];

/**
 * The problems in the roster itself, before any gate is executed.
 *
 * H3 is the one that is anchored OUTSIDE this file: it reads T-005's PR roster
 * and requires that every `SERVICE` entry there — a gate SD puts in the PR row
 * that the PR stage structurally cannot run — is executed here, and that
 * nothing here claims a PR-row item whose PR entry is not SERVICE. Before
 * T-006 the SERVICE class named T-006 in prose and nothing checked it; a
 * second SERVICE gate added to the PR roster would have been rostered nowhere
 * and run nowhere, and `gate:pr` would have stayed green.
 */
export function heavyRosterProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const e of HEAVY_ROSTER) {
    if (seen.has(e.name)) problems.push(`duplicate heavy roster entry: ${e.name}`);
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
    if (e.cls === 'BLOCKING' && (e.anchors === undefined || e.anchors.length === 0)) {
      problems.push(
        `${e.name} is BLOCKING with no evidence anchor — a zero exit would then be accepted from a ` +
          'sub-gate that did nothing (PROTOCOL §5.1)',
      );
    }
    if (e.cls === 'BLOCKED' && (e.pinnedFailure === undefined || e.pinnedFailure.trim() === '')) {
      problems.push(`${e.name} is BLOCKED with no pinned expected failure`);
    }

    // H2 — the entry answers something SD actually says.
    if (e.spec === PR_ROW) {
      if (e.prSpec === undefined || !SPEC_PR_ROW.includes(e.prSpec)) {
        problems.push(
          `${e.name} is marked PR_ROW with prSpec ${JSON.stringify(e.prSpec)}, which is not in ` +
            "SPEC_PR_ROW (scripts/gates/lib/roster.ts, T-005's transcription of SD §QD-4's PR row)",
        );
      }
    } else if (e.spec !== PROGRAMME && !SPEC_HEAVY_ROW.includes(e.spec)) {
      problems.push(
        `${e.name} claims SD §QD-4 heavy-row item ${JSON.stringify(e.spec)}, which is not in ` +
          'SPEC_HEAVY_ROW',
      );
    }
  }

  // H1 — every heavy-row item is answered.
  for (const item of SPEC_HEAVY_ROW) {
    if (!HEAVY_ROSTER.some((e) => e.spec === item)) {
      problems.push(
        `SD §QD-4 "PR (heavy)" row item ${JSON.stringify(item)} has NO roster entry — silently absent`,
      );
    }
  }

  // H3 — the cross-file anchor, both ways, against T-005's PR roster.
  for (const pr of ROSTER) {
    if (pr.cls !== 'SERVICE') continue;
    const here = HEAVY_ROSTER.find((e) => e.name === pr.name);
    if (here === undefined) {
      problems.push(
        `${pr.name} is SERVICE in the PR roster — SD puts it in the PR row and the PR stage ` +
          'cannot start a service for it — and it has NO entry here. A SERVICE gate that the ' +
          'heavy stage does not execute is a gate that runs NOWHERE, and gate:pr stays green ' +
          'while it does (T-005 § contract §2).',
      );
      continue;
    }
    if (here.prSpec !== pr.spec) {
      problems.push(
        `${pr.name} answers SD §QD-4 item ${JSON.stringify(pr.spec)} in the PR roster but ` +
          `${JSON.stringify(here.prSpec)} here — the two stages disagree about what it is for`,
      );
    }
    if (here.cls === 'PENDING' || here.cls === 'SERVICE') {
      problems.push(
        `${pr.name} is SERVICE in the PR roster and ${here.cls} here, so it is executed for real ` +
          'in neither stage',
      );
    }
  }
  for (const e of HEAVY_ROSTER) {
    if (e.spec !== PR_ROW) continue;
    const pr = ROSTER.find((r) => r.name === e.name);
    if (pr === undefined) {
      problems.push(`${e.name} is marked PR_ROW but is in no PR roster entry`);
    } else if (pr.cls !== 'SERVICE') {
      problems.push(
        `${e.name} is marked PR_ROW but its PR roster entry is ${pr.cls}, not SERVICE — the heavy ` +
          'stage executes the PR-row gates the PR stage CANNOT, and this one can run there',
      );
    }
  }

  return problems;
}
