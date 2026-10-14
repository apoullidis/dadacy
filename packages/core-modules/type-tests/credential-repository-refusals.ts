/**
 * COMPILE-TIME REFUSALS for the `sitter_credential` repository — T-255 ("an actorless call does not
 * compile"). Never executed; compiled by `pnpm -w typecheck` (in `gate:pr`), which fails with TS2578
 * if a line under a `@ts-expect-error` directive stops being an error.
 *
 * THE BOUND (as `actor-refusals.ts`): a directive accepts ANY error on its line. The codes named
 * below were read off one real `tsc` run with the directives removed, recorded in
 * state/EP-5/T-255.md; nothing re-checks them. The brand is a type only (`as unknown as
 * SitterActor` compiles), which is why every function re-reads the actor at run time.
 *
 * Lines marked CONTROL must compile.
 */
import type { AccountId } from '@kinvara/domain-types';
import {
  dueForAttestation,
  dueForExpiry,
  dueForRecertification,
  ensureOnboardingCredentials,
  listOwnCredentials,
  sitterActor,
  submitCertificate,
} from '@kinvara/core-modules/credential';
import {
  bindSystemActor,
  personActor,
  systemActor,
  type Database,
} from '@kinvara/core-modules/runtime';

declare const db: Database;
const ID = '01J9Z8Y7X6W5V4T3S2R1Q0P9N8';
const sub = { credentialId: ID, jurisdiction: 'CY', referenceNumber: '0', issuedOn: null };
const log = (): void => undefined;

// No actor at all.
// @ts-expect-error TS2554 expected 2 arguments
void listOwnCredentials(db);
// @ts-expect-error TS2554 expected 3 arguments (the jurisdiction is not an actor)
void ensureOnboardingCredentials(db, 'CY');
// @ts-expect-error TS2554 expected 4 arguments
void submitCertificate(db, sub, log);
// @ts-expect-error TS2345 undefined is not a SitterActor
void listOwnCredentials(db, undefined);

// A person in another role, a system actor, or a literal shaped like a sitter actor.
// @ts-expect-error TS2345 role Role is not assignable to 'sitter'
void listOwnCredentials(db, personActor(ID, 'parent'));
// @ts-expect-error TS2345 a SystemActor is not a SitterActor
void submitCertificate(db, systemActor('credential.expiry_sweep'), sub, log);
// @ts-expect-error TS2345 the literal lacks the Actor brand
void listOwnCredentials(db, { kind: 'person', accountId: ID as AccountId, role: 'sitter' });

// A sweep takes a bound system runner: neither the bare Database nor nothing.
// @ts-expect-error TS2345 a Database is not a SystemActorDatabase (no bound actor)
void dueForRecertification(db, '2026-01-20');
// @ts-expect-error TS2554 expected 2 arguments
void dueForExpiry('2026-01-20');
// @ts-expect-error TS2345 a string is not a Date
void dueForAttestation(bindSystemActor(db, 'credential.attestation_sweep'), '2026-01-20');

// CONTROLS.
void listOwnCredentials(db, sitterActor(ID));
void ensureOnboardingCredentials(db, sitterActor(ID), 'CY');
void submitCertificate(db, sitterActor(ID), sub, log);
void dueForRecertification(bindSystemActor(db, 'credential.recert_sweep'), '2026-01-20');
void dueForExpiry(bindSystemActor(db, 'credential.expiry_sweep'), '2026-01-20');
void dueForAttestation(bindSystemActor(db, 'credential.attestation_sweep'), new Date());
