/**
 * SENTRY — WIRING AND CONFIGURATION ONLY. THERE IS NO ACCOUNT AND NO DSN.
 *
 * SA §TS-10 chooses Sentry for errors and front-end RUM. PROTOCOL §9.9 and
 * DOCKER.md §7 say there is no real vendor credential and no route off the
 * host: `kinvara-int` is `internal: true`. So the live half of this row is
 * BLOCKED AND ESCALATED, not improvised around — `initSentry` REFUSES a
 * configured DSN rather than letting a container discover at run time that its
 * packets cannot leave.
 *
 * WHAT IS REAL HERE, and it is the half that carries the risk anyway:
 * `beforeSend`, the third of SA §TS-10 rule 1's three redaction points. It is
 * written as an ALLOWLIST — it REBUILDS the event from a fixed key set rather
 * than deleting fields from the event it was given. That is the difference the
 * rule is about: a denylist fails on the field nobody thought of, and Sentry
 * adds fields between releases.
 *
 * `beforeSend` IS A PURE FUNCTION AND IS TESTED AS ONE (`src/sentry.test.ts`).
 * It has never run inside the Sentry SDK on this machine and this file does not
 * claim it has.
 */
import { lookupRoute } from './routes.ts';
import { RESERVED_ROUTES } from './routes.ts';

/**
 * SD §SEC-I5 / SA §I-3 layer 5: the routes whose REQUEST BODIES are excluded
 * from access logging at the ALB, the OTel Collector and Sentry.
 *
 * Note the width of the control actually implemented: the allowlist below
 * carries NO request body for ANY route, so this list is a subset of what is
 * already dropped. It is kept as an explicit second layer because SD names
 * these routes by hand, and because a later widening of the allowlist must not
 * silently re-expose them. `scrubEvent` drops the WHOLE EVENT for these.
 */
export const BODY_EXCLUDED_ROUTE_PREFIXES: readonly string[] = [
  'POST /v1/sessions/{sessionId}/arrival',
  'POST /arrival',
  'GET /v1/admin/sighting-sessions',
  'POST /v1/admin/sighting-sessions',
];

/**
 * The only keys a scrubbed event may carry. Everything Sentry would otherwise
 * attach — `request` (url, headers, cookies, data), `user`, `breadcrumbs`,
 * `extra`, `contexts`, `server_name`, `message`, `exception.value` — is absent
 * because it is not in this list, not because something removed it.
 */
export const SENTRY_ALLOWED_KEYS: readonly string[] = [
  'event_id',
  'timestamp',
  'platform',
  'level',
  'environment',
  'release',
  'transaction',
  'tags',
  'fingerprint',
];

/** The only tags that survive. They are the contract's own fields. */
export const SENTRY_ALLOWED_TAGS: readonly string[] = [
  'trace_id',
  'route',
  'module',
  'actor_role',
  'status',
  'data_class',
];

export interface SentryEventLike {
  readonly [key: string]: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * THE SCRUBBER. Returns a NEW object built from the allowlist, or `null` to
 * drop the event entirely.
 *
 * Rules, each with a test in `src/sentry.test.ts`:
 *   - a non-object event is dropped;
 *   - an event whose `transaction` is not a REGISTERED ROUTE TEMPLATE has its
 *     transaction replaced by `(unregistered)` — a concrete URL never survives,
 *     exactly as on a span;
 *   - an event on a body-excluded route is dropped whole;
 *   - `tags` are rebuilt from `SENTRY_ALLOWED_TAGS`, values coerced to strings
 *     and truncated to 200 characters;
 *   - every other key is absent.
 */
export function scrubEvent(event: unknown): SentryEventLike | null {
  if (!isPlainObject(event)) return null;

  const transactionRaw = event['transaction'];
  const transaction = typeof transactionRaw === 'string' ? transactionRaw : '';
  for (const prefix of BODY_EXCLUDED_ROUTE_PREFIXES) {
    if (transaction.startsWith(prefix)) return null;
  }

  const out: Record<string, unknown> = {};
  for (const key of SENTRY_ALLOWED_KEYS) {
    if (key === 'transaction' || key === 'tags') continue;
    if (Object.hasOwn(event, key)) {
      const value = event[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
    }
  }
  out['transaction'] =
    lookupRoute(transaction) === undefined ? RESERVED_ROUTES.unregistered : transaction;

  const tagsIn = event['tags'];
  const tags: Record<string, string> = {};
  if (isPlainObject(tagsIn)) {
    for (const tag of SENTRY_ALLOWED_TAGS) {
      const value = tagsIn[tag];
      if (typeof value === 'string' || typeof value === 'number') {
        tags[tag] = String(value).slice(0, 200);
      }
    }
  }
  out['tags'] = tags;
  return out;
}

export class SentryNotAvailable extends Error {
  constructor(message: string) {
    super(`observability: ${message}`);
    this.name = 'SentryNotAvailable';
  }
}

export interface SentryConfig {
  readonly dsn: string;
  readonly environment: string;
  readonly release: string;
  readonly sendDefaultPii: false;
  readonly tracesSampleRate: number;
  readonly beforeSend: (event: unknown) => SentryEventLike | null;
  readonly beforeSendTransaction: (event: unknown) => SentryEventLike | null;
}

/**
 * The configuration an SDK would be initialised with. Built and returned; NOT
 * handed to any SDK, because no SDK is installed and no DSN exists.
 */
export function sentryConfig(env: Readonly<Record<string, string | undefined>>): SentryConfig {
  return {
    dsn: env['SENTRY_DSN'] ?? '',
    environment: env['KINVARA_ENV'] ?? 'local',
    release: env['KINVARA_RELEASE'] ?? 'dev',
    sendDefaultPii: false,
    tracesSampleRate: Number(env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0'),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}

/**
 * REFUSES rather than initialising. A non-empty `SENTRY_DSN` in this
 * environment is a configuration error, not a feature: every application
 * container is on `internal: true` `kinvara-int` and has no route off the host,
 * so the call would fail — silently, inside the SDK, at run time, which is the
 * worst place to discover it. PROTOCOL §9.9: blocked and escalated, never
 * improvised.
 */
export function initSentry(env: Readonly<Record<string, string | undefined>>): SentryConfig {
  const config = sentryConfig(env);
  if (config.dsn !== '') {
    throw new SentryNotAvailable(
      'SENTRY_DSN is set. There is no Sentry account for this build and every application container is on an internal:true network with no egress (DOCKER.md §7). Sentry is wiring and configuration here, not a live destination — see state/EP-1/T-008.md § Published contract §6.',
    );
  }
  return config;
}
