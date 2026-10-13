/**
 * THE RLS ACTOR (T-254; SD 3906, SD 1240, SA-10 at SD 4604; CUT-T-060 R-2). Who a transaction acts
 * for, as the row-level-security policies read it: `app.actor_id`, `app.actor_role` and
 * `app.break_glass`, set transaction-locally by `Database.withActor` (./database.ts).
 *
 * TWO KINDS, AND NOTHING ELSE.
 *   - A PERSON: an account id that `@kinvara/policy`'s `knownId` accepts (T-134: `isUlid`, so every
 *     spelling of absence, `''`, `null`, `0`, `undefined`, an object, a lower-cased id, is refused),
 *     acting in ONE role that `@kinvara/policy`'s `isRole` accepts. `app.actor_id` = the account
 *     id, `app.actor_role` = the role.
 *   - A SYSTEM JOB (SD 1240: "`actor_type: 'system'` and a named job identity"): a job name of the
 *     shape `JOB_IDENTITY_SHAPE`. `app.actor_id` = the job name, `app.actor_role` = `'system'`.
 *
 * THE ROLE SET IS THE POLICY CONTRACT'S, IMPORTED, NOT COPIED (EV-40 brief, BOARD T-254). It is
 * `@kinvara/policy`'s `Role` / `isRole` and nothing else; it is NOT `account_role.role`'s CHECK in
 * migration `0005`. CAVEAT (EV-40): the policy set still holds `dsl` today, so a `dsl` person actor
 * is accepted here; `deputy_dsl` and `referee` are refused because the policy does not model them.
 * EV-40 removed the `dsl` role; when the `packages/policy` successor drops it, this set follows with
 * no edit here. `'system'` is not a policy role, so a person can never carry the system role.
 *
 * VALIDATED TWICE. The constructors (`personActor`, `systemActor`) refuse a bad input with
 * `ActorRefusedError`, and `actorSettings` re-checks the actor when a transaction starts, because
 * the brand is a type only: `as unknown as Actor` compiles (as for `Tx`). The refusal text is fixed
 * and never carries the refused value.
 */
import type { AccountId } from '@kinvara/domain-types';
import { isRole, knownId, type Role } from '@kinvara/policy';

declare const ACTOR_BRAND: unique symbol;

/** The three custom GUCs the RLS policies read (T-252 § Published contract — LIVE §2). */
export const ACTOR_GUCS = Object.freeze({
  actorId: 'app.actor_id',
  actorRole: 'app.actor_role',
  breakGlass: 'app.break_glass',
} as const);

/** `app.actor_role` for a system job. Not a member of `@kinvara/policy`'s `Role`. */
export const SYSTEM_ACTOR_ROLE = 'system';

/** `app.break_glass` values: exactly `'on'` when requested, `'off'` otherwise. */
export const BREAK_GLASS_ON = 'on';
export const BREAK_GLASS_OFF = 'off';

/**
 * A named job identity: lower case, starting with a letter, then letters, digits, `_`, `.`, `:` or
 * `-`, 1 to 63 characters (a queue name such as `search.slot_materialise` fits). Lower case only, so
 * a job identity can never be read as an account id (a ULID is upper case).
 */
export const JOB_IDENTITY_SHAPE = /^[a-z][a-z0-9_.:-]{0,62}$/;

export interface PersonActor {
  readonly kind: 'person';
  readonly accountId: AccountId;
  readonly role: Role;
  readonly [ACTOR_BRAND]: 'validated actor';
}

export interface SystemActor {
  readonly kind: 'system';
  readonly job: string;
  readonly [ACTOR_BRAND]: 'validated actor';
}

/** Built only by `personActor` / `systemActor`; an object literal lacks the brand. */
export type Actor = PersonActor | SystemActor;

/** `withActor`'s third argument. Break-glass is set only by passing exactly this. */
export interface ActorTxOptions {
  readonly breakGlass: true;
}

/** Why an actor was refused. Closed. */
export type ActorRefusal =
  'actor_missing' | 'actor_kind' | 'account_id' | 'role' | 'job_identity' | 'break_glass_option';

const REFUSAL_TEXT: Readonly<Record<ActorRefusal, string>> = Object.freeze({
  actor_missing: 'actor: no actor was given',
  actor_kind: "actor: the actor is neither a 'person' nor a 'system' actor",
  account_id: 'actor: the account id is not a well-formed id',
  role: "actor: the role is not one of @kinvara/policy's roles",
  job_identity: 'actor: the job identity is not a well-formed job name',
  break_glass_option: 'actor: the options must be absent or exactly { breakGlass: true }',
});

/** Refused before any SQL. `reason` is closed; the message is fixed and carries no input. */
export class ActorRefusedError extends Error {
  override readonly name = 'ActorRefusedError';
  readonly reason: ActorRefusal;
  constructor(reason: ActorRefusal) {
    super(REFUSAL_TEXT[reason]);
    this.reason = reason;
  }
}

/** A person acting in one role. Throws `ActorRefusedError` (`account_id`, `role`). */
export function personActor(accountId: unknown, role: unknown): PersonActor {
  if (!knownId(accountId)) throw new ActorRefusedError('account_id');
  if (!isRole(role)) throw new ActorRefusedError('role');
  return Object.freeze({ kind: 'person', accountId, role }) as unknown as PersonActor;
}

/** A system job (SD 1240). Throws `ActorRefusedError` (`job_identity`). */
export function systemActor(job: unknown): SystemActor {
  if (!isJobIdentity(job)) throw new ActorRefusedError('job_identity');
  return Object.freeze({ kind: 'system', job }) as unknown as SystemActor;
}

function isJobIdentity(value: unknown): value is string {
  return typeof value === 'string' && JOB_IDENTITY_SHAPE.test(value);
}

/** The three GUC values, in `ACTOR_GUCS` order. */
export interface ActorSettings {
  readonly actorId: string;
  readonly actorRole: string;
  readonly breakGlass: typeof BREAK_GLASS_ON | typeof BREAK_GLASS_OFF;
}

/**
 * PACKAGE-INTERNAL (not exported from `./runtime`). Re-validate `actor` and `options` from scratch
 * (they may be forged past the types) and return the values `withActor` sets. Throws
 * `ActorRefusedError`; touches nothing.
 */
export function actorSettings(actor: unknown, options: unknown): ActorSettings {
  if (typeof actor !== 'object' || actor === null) throw new ActorRefusedError('actor_missing');
  const a = actor as { kind?: unknown; accountId?: unknown; role?: unknown; job?: unknown };
  let actorId: string;
  let actorRole: string;
  if (a.kind === 'person') {
    if (!knownId(a.accountId)) throw new ActorRefusedError('account_id');
    if (!isRole(a.role)) throw new ActorRefusedError('role');
    actorId = a.accountId;
    actorRole = a.role;
  } else if (a.kind === 'system') {
    if (!isJobIdentity(a.job)) throw new ActorRefusedError('job_identity');
    actorId = a.job;
    actorRole = SYSTEM_ACTOR_ROLE;
  } else {
    throw new ActorRefusedError('actor_kind');
  }
  return { actorId, actorRole, breakGlass: breakGlassValue(options) };
}

/** Exactly `undefined` → `'off'`; exactly an object whose one own key is `breakGlass: true` → `'on'`. */
function breakGlassValue(options: unknown): ActorSettings['breakGlass'] {
  if (options === undefined) return BREAK_GLASS_OFF;
  if (
    typeof options === 'object' &&
    options !== null &&
    Object.keys(options).length === 1 &&
    (options as { breakGlass?: unknown }).breakGlass === true
  ) {
    return BREAK_GLASS_ON;
  }
  throw new ActorRefusedError('break_glass_option');
}
