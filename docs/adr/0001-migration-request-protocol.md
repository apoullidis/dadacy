# ADR 0001 — The migration-request protocol

- **Status:** accepted
- **Date:** 2026-09-13
- **Ticket:** T-031 (tech-lead)
- **Refs:** PROTOCOL §3 (ownership of `db/migrations/**`, the `Ticket:` trailer), §4 (one implementation ticket per agent), §8 (requesting another module's schema); `tech-lead.md` cut-rule; the published contracts of `T-020`, `T-021` (rework 2), `T-136`, `T-137` (rework 1), `T-138` and `T-031`

## Context

PROTOCOL §3 makes `db/migrations/**` the property of `tech-lead`: no other agent creates a file there. Every other role file tells its agent to request schema from `tech-lead`, and PROTOCOL §8 says to report the need rather than build a stub. Until this ADR nothing said what a request contains, how the orchestrator turns one into BOARD rows, or how a migration gets its number. On 2026-09-13 five `ready` tickets owned by other roles could not complete without a migration (`T-060`, `T-064`, `T-067`, `T-080`, `T-089`), and `T-067`'s row still named `0003_audit_log`, a number `T-143` had already used.

Four mechanisms depend on migration numbers, so allocating them is not bookkeeping:

| Mechanism                        | What it does with the number                                                                                                                                                                          | Source                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `gate:migration-lint` R-STRUCT   | refuses a migration added in a change set when its number is at or below the highest migration at the base, and refuses two names on one number                                                       | `T-021` § contract (rework 2) §2, cases C92, C93 |
| `db:migrate`                     | refuses a numbering gap and two names on one number                                                                                                                                                   | `T-136` § contract §3, cases A1, A5              |
| `gate:constraint-suite` tripwire | stays red until `HIGHEST_COMMITTED` equals the highest up file and a probe keyed to that number holds after `up` and stops holding after `down`; only the highest migration is checked against a down | `T-137` § contract (rework 1) §5; TV2-A2         |
| `db:introspect:check`            | migrates the database to the highest committed migration before comparing                                                                                                                             | `T-138` § contract §1                            |

## Decision

### 1. What a requesting ticket supplies

The agent whose ticket needs schema writes a section headed `## Migration request` in its own evidence file (`tasks/state/<epic>/T-NNN.md`). It then reports to the orchestrator that the ticket is blocked on schema from `tech-lead` (PROTOCOL §8). It does not create a table, a fixture schema or a stub anywhere, and it does not write under `db/migrations/`.

The request states:

| Field                      | Required                                                                 | Content                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requesting ticket          | always                                                                   | its id and owning role                                                                                                                                                                                                                                                                                                                                     |
| Spec                       | always                                                                   | the SD section **and line numbers** defining each object; the SA §SA-4 invariant (`I-n`) if one applies; any `decisions.md` ruling (`OE-n`, `OD-n`, `EV-n`)                                                                                                                                                                                                |
| Tables and columns         | always                                                                   | per table: its name; per column: type, nullability, default, and the SD line it comes from                                                                                                                                                                                                                                                                 |
| Keys and constraints       | always                                                                   | the primary key (a ULID or `IDENTITY`, never `serial` on any table `answering_service` could reach, `T-020` § contract §4); foreign keys with their `ON DELETE` behaviour; `UNIQUE`, `CHECK` and `EXCLUDE` constraints; indexes                                                                                                                            |
| The invariant              | when a constraint exists                                                 | the rule in one sentence; which layer enforces it (a constraint, a trigger, an in-database gate, a reconciler; SA §SA-4); and the refusal each negative test must show, with the SQLSTATE or constraint name expected                                                                                                                                      |
| Grants                     | always                                                                   | the privileges each role (`app_rw`, `app_admin_rw`, `app_safety_rw`, `answering_service`) holds on each table. There are no default privileges (`T-020` § contract §4), so a table without a grant cannot be used, and `gate:migration-lint` refuses it (R-TABLE-GRANT). `audit_log`, `case_note` and `decision_record` take `INSERT` only (R-APPEND-ONLY) |
| Row-level security         | when the table is one SD lines 1309/3906 name (SA §TS-7 layer 2, §SEC-7) | the policies, with `ENABLE` and `FORCE ROW LEVEL SECURITY`. A table outside that list needs none (OD-223)                                                                                                                                                                                                                                                  |
| Phase                      | always                                                                   | `expand`, `contract` or `data`. A contract is its own later request (§2)                                                                                                                                                                                                                                                                                   |
| Seed data                  | when rows are seeded                                                     | the rows and their cited source                                                                                                                                                                                                                                                                                                                            |
| Superuser need             | when known                                                               | anything `app_ddl` cannot do (`CREATE EXTENSION`, replacing a superuser-owned object) and why. `tech-lead` decides whether the migration carries `-- @run-as`                                                                                                                                                                                              |
| Protected objects          | when one is touched                                                      | which one (`gate:migration-lint` R-PROTECTED's list) and the review reference                                                                                                                                                                                                                                                                              |
| Partitioning               | when the table is partitioned                                            | the key and the bounds. Read `CONTRACTS.md` OD-84 first: `db:introspect:check` cannot represent a partitioned parent today                                                                                                                                                                                                                                 |
| What the code does with it | always                                                                   | the queries the requesting code will run, so that grants and indexes can be checked against them                                                                                                                                                                                                                                                           |

`tech-lead` does not fill in a missing required field. A request that lacks one goes back through the orchestrator, naming the field. A field the spec leaves undecided is escalated (PROTOCOL §2), not guessed.

### 2. How the work is split into BOARD rows

For a requesting ticket `T-X`, owned by role `R`, the orchestrator cuts **one migration ticket per migration**. That follows the `tech-lead` cut-rule: one ticket is one migration, its invariant and its negative test.

```
| T-M | <T-X's epic> | <slug> migration for T-X | tech-lead → R | db | blocked | T-031, <migration tickets T-M waits on> | state/<epic>/T-M.md |
```

- **The owner cell** uses PROTOCOL §8's handoff form `tech-lead → R`. `tech-lead` writes the migration, and `R` receives it.
- **`T-M`'s brief** is `T-X`'s `## Migration request`, cited by path.
- **`T-X`'s row** keeps its owner. Its `blocked_by` gains `T-M`. `R` does not start the code until `T-M` is `done` and merged (PROTOCOL §3: merge immediately on `done`).
- **`T-M` writes, in one change set:**
  - the `NNNN_slug.up.sql` and `.down.sql` files;
  - `db/schema.ts`, regenerated (`T-138` § contract §4);
  - in `packages/db-testkit/suites/migrations-applied.test.ts`: `CREATED_BY['NNNN']`, with probes naming objects `NNNN` creates, and `HIGHEST_COMMITTED` moved (`T-137` § contract §5);
  - the invariant's negative tests at the database layer.

  It is a two-approval path (PROTOCOL §3): `qa-verification` reviews first, then a `tech-lead` instance other than the author (the `T-020`, `T-021` and `T-143` precedent).

- **`T-X` writes everything else:** repository and query code, module code, endpoints and their tests. It writes nothing under `db/migrations/` and never edits `db/schema.ts` by hand.
- **A row that bundles schema with feature work** (for example `T-060`, _"`credential_scheme` + `sitter_credential` (CY seeds)"_) is split. The migration and any seed rows go to `T-M`, and the feature code stays with `T-X`.
- **An expand and its later contract are two migration tickets.** The contract ticket is blocked by the expand ticket and by every ticket whose code stops using what the contract removes. `gate:migration-lint` R-CONTRACT-ALONE refuses a contract sharing a change set with anything but its own files and a regenerated `db/schema.ts` (`T-021` C30–C33, `T-138` C3H–C3K).
- **Dependencies between migrations go in `blocked_by`.** When an object references another migration's object (a foreign key into another module's table, say), `T-M`'s `blocked_by` includes the migration ticket that creates the referenced object.
- **A row names no migration number.** The number is allocated under §3.

### 3. How migration numbers are allocated

**A migration's number is the highest up-file number on `main` plus one. `tech-lead` takes it when `T-M` starts, not when the request is written or the row is cut.**

**Migration tickets are serial.** `tech-lead` holds one implementation ticket at a time (PROTOCOL §4). The orchestrator also does not dispatch a migration ticket while another is dispatched but not yet merged. On the BOARD, that is a `blocked_by` edge from each migration ticket to the one before it, in the order the orchestrator chooses. Every migration therefore starts from a `main` that already holds all earlier ones, and one change set carries one migration (`T-137` TV2-A2).

**If two are in flight anyway** (for example, one is in rework while another merges), the one merging second renumbers before it merges. It renames both files, re-keys `CREATED_BY`, moves `HIGHEST_COMMITTED`, regenerates `db/schema.ts` on the new base, re-runs up, down and up, and pastes the result again. It is not a fast-forward, so the owning agent merges (PROTOCOL §3). Skipping the renumbering fails loudly: after a rebase, R-STRUCT refuses the stale number (C92, C93 above), and so does the tripwire's first half.

### 4. The trailer rule, and what enforces it

Every commit whose tree differs under `db/migrations/` from its first parent must carry **exactly one** `Ticket: T-NNN` trailer. It has to sit in the final trailer block of the message, as git's trailer parser reads it:

```
git log -1 --format='%(trailers:key=Ticket,valueonly)' <commit>
```

Other trailers (`Co-Authored-By:`, session attribution) may come before or after it. For a migration commit, `T-NNN` is the migration ticket `T-M`; `T-M`'s BOARD row names the requesting ticket.

`gate:migration-lint` enforces this as **R-TRAILER**. It reads every commit in `merge-base(<base>, HEAD)..HEAD`, merge commits included, and never matches a line by position. The `T-031` § Published contract states its cases and its bounds: uncommitted files and commits already on the base are not read, and the value is checked for shape, not against the BOARD.

### 5. Migrations that run as the superuser

A migration runs as `app_ddl` unless its up file's header carries `-- @run-as: bootstrap-superuser — <T-NNN/OE-n/OD-n/EV-n/SQ-n …>` (`T-136` § contract §6). `gate:migration-lint` refuses, among other forms:

- a marker anywhere else, including inside a string, a dollar-quoted body or a block comment (**R-RUN-AS**);
- any statement that switches the session role (**R-ROLE-SWITCH**);
- any change to a line the runner reads in a merged migration (**R-MERGED**, OD-86).

The request states the need (§1). Whether to grant it is `tech-lead`'s decision, and the two-approval review is the control.

## Consequences

- The five waiting tickets each need a `## Migration request` before their migration ticket can be cut. The orchestrator can obtain one by dispatching the owning role for a request-only pass: no branch, and the only write is that section of its evidence file. Once the requests exist, it cuts the `T-M` rows under §2 and chains them under §3.
- `T-067`'s migration ticket inherits two carried obligations in its brief: OD-84 (a partitioned `audit_log` cannot pass `db:introspect:check` until `tech-lead` decides how a partitioned table is represented) and OD-78.
- Schema work queues behind one agent. That is accepted: PROTOCOL §9.1a already makes dispatch serial against the shared token budget, and a feature ticket starts as soon as its own migration merges.

### Alternatives rejected

- **Reserving numbers when a request is written.** A reservation goes stale whenever work is reordered or reworked. R-STRUCT, the runner and the tripwire all read `main`'s highest number, so a reservation list would be a second, disagreeing source of truth.
- **The requesting agent writes the migration, and `tech-lead` reviews it.** Forbidden by PROTOCOL §3's ownership rule.
- **Migration and feature code in one ticket.** Forbidden by the `tech-lead` cut-rule, and a contract migration cannot share its change set at all (R-CONTRACT-ALONE).
