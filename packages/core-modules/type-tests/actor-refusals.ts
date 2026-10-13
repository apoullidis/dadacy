/**
 * COMPILE-TIME REFUSALS for the RLS actor transaction — T-254 ("a call with no actor does not
 * compile"). Never executed; compiled by `pnpm -w typecheck` (in `gate:pr`), which fails with TS2578
 * if a line under a `@ts-expect-error` directive stops being an error.
 *
 * THE BOUND (as `enqueue-refusals.ts`): a directive accepts ANY error on its line. The codes named
 * below were read off one real `tsc` run with the directives removed, recorded in
 * state/EP-2/T-254.md § Red-first; nothing re-checks them. The brand is a type only:
 * `as unknown as Actor` compiles, which is why `withActor` re-validates at run time.
 *
 * Lines marked CONTROL must compile.
 */
import type { AccountId } from '@kinvara/domain-types';
import {
  bindSystemActor,
  personActor,
  systemActor,
  type Actor,
  type Database,
} from '@kinvara/core-modules/runtime';

declare const db: Database;
const work = async (): Promise<number> => 1;
const ID = '01J9Z8Y7X6W5V4T3S2R1Q0P9N8';

// No actor at all: the only signature takes the actor first.
// @ts-expect-error TS2554 expected 2-3 arguments
void db.withActor(work);

// `undefined` / `null` where the actor belongs.
// @ts-expect-error TS2345 undefined is not assignable to Actor
void db.withActor(undefined, work);
// @ts-expect-error TS2345 null is not assignable to Actor
void db.withActor(null, work);

// An object literal shaped like an actor is not one: it lacks the brand only the constructors add.
// @ts-expect-error TS2345 the literal lacks the Actor brand
void db.withActor({ kind: 'person', accountId: ID as AccountId, role: 'sitter' }, work);
// @ts-expect-error TS2345 the literal lacks the Actor brand
void db.withActor({ kind: 'system', job: 'credential.sweep' }, work);

// Break-glass is only ever the literal `true`.
// @ts-expect-error TS2322 false is not assignable to true
void db.withActor(personActor(ID, 'ts_operator'), work, { breakGlass: false });
// @ts-expect-error TS2353 an unknown key in the options
void db.withActor(personActor(ID, 'ts_operator'), work, { breakGlass: true, purpose: 'x' });

// The worker's bound runner takes no actor argument: there is nowhere to pass a person.
// @ts-expect-error TS2345 a PersonActor is not the work function
void bindSystemActor(db, 'credential.sweep').withActor(personActor(ID, 'sitter'), work);

// CONTROLS.
void db.withActor(personActor(ID, 'sitter'), work);
void db.withActor(systemActor('credential.sweep'), work);
void db.withActor(personActor(ID, 'ts_operator'), work, { breakGlass: true });
void bindSystemActor(db, 'credential.sweep').withActor(work);
export const forged: Actor = { kind: 'system', job: 'x' } as unknown as Actor;
