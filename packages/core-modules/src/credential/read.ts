/**
 * Q-1, THE SCHEME READ (T-060 `## Migration request` › "What the code does with it", row Q-1), and
 * its 60-second in-process cache (SD §PERF-2 cache table, line 4035: "In-process | … `credential_scheme`
 * … | 60 s").
 *
 * Q-1 is the published column list with `ORDER BY id` added, run as `app_rw` inside the caller's
 * `Tx` (`withAppRw`: `SET LOCAL ROLE app_rw`), which holds `SELECT` on the table and nothing else
 * (`T-251` §3). Every row is parsed closed (`parseSchemeRow`); one bad row refuses the whole read.
 *
 * THE CACHE (`CredentialSchemeCache`):
 *   - one entry per jurisdiction, holding the frozen array of one successful read;
 *   - an entry is served while `now - loadedAt < 60_000` ms, and re-read on the first call after;
 *   - concurrent calls for a jurisdiction with no fresh entry share ONE read;
 *   - a failed read is NOT cached: the error goes to every caller sharing it, and the next call
 *     reads again (a fail-closed answer must not be pinned for a minute by a transient fault, nor
 *     a stale success served after a failure — there is no stale-on-error).
 *   - NO PUB/SUB INVALIDATION. SD 4035 says "Pub/sub invalidation on write"; no application role
 *     can write this table (`app_rw` holds `SELECT` only, `T-251` §3), so there is no write to
 *     publish from. A write by a migration or an `app_ddl`/superuser session reaches each process
 *     at its first call 60 s or more after that process's previous Q-1 completed (at most 60 s
 *     plus one read after the commit). EV-53: the ticket that builds SD 347's scheme editor owes
 *     the invalidation (state/EP-5/T-060.md § Published contract — LIVE §2, §6).
 * Held without a database by `read.test.ts` (an injected loader and clock), and against the seeded
 * schema by `test/credential-scheme.spec.ts` (the same frozen array within the window, a new one
 * after it).
 */
import { sql } from 'drizzle-orm';
import type { Database, LogLine, Tx } from '../runtime/index.ts';
import { CredentialSchemeReadError, parseSchemeRow, type CredentialScheme } from './scheme.ts';

/** SD 4035. */
export const SCHEME_CACHE_TTL_MS = 60_000;

/** Fixed text: the jurisdiction is not echoed. */
export const JURISDICTION_REFUSED =
  'credential: jurisdiction must be an ISO 3166-1 alpha-2 code in upper case (e.g. CY)';

const ALPHA2 = /^[A-Z]{2}$/;

function assertJurisdiction(jurisdiction: unknown): asserts jurisdiction is string {
  if (typeof jurisdiction !== 'string' || !ALPHA2.test(jurisdiction)) {
    throw new TypeError(JURISDICTION_REFUSED);
  }
}

/**
 * Q-1 inside `tx`. Returns the jurisdiction's schemes, ascending `id`, deeply frozen (an empty
 * array for a jurisdiction with no rows). Throws `CredentialSchemeReadError` if any row fails the
 * closed parse, and `TypeError(JURISDICTION_REFUSED)` before any query for a malformed jurisdiction.
 */
export async function readCredentialSchemes(
  tx: Tx,
  jurisdiction: string,
): Promise<readonly CredentialScheme[]> {
  assertJurisdiction(jurisdiction);
  const result = await tx.execute<Record<string, unknown>>(
    sql`SELECT id, jurisdiction, check_type, scheme_name, scheme_name_i18n, issuing_body,
               validity_model, default_validity_months, max_age_at_submission_months,
               attestation_interval_days, attestation_grace_days, reference_format_regex,
               mandatory_rules
          FROM public.credential_scheme
         WHERE jurisdiction = ${jurisdiction}
         ORDER BY id`,
  );
  return Object.freeze(result.rows.map((row) => parseSchemeRow(row)));
}

export type SchemeLoader = (jurisdiction: string) => Promise<readonly CredentialScheme[]>;

interface Entry {
  readonly loadedAt: number;
  readonly schemes: readonly CredentialScheme[];
}

export interface CredentialSchemeCacheOptions {
  /** The clock in epoch milliseconds; injectable for tests. Default `Date.now`. */
  readonly now?: () => number;
}

/** Fixed prefix of the line logged when a read is refused. */
export const SCHEME_READ_REFUSED_LOG = 'credential: credential_scheme read refused';

export class CredentialSchemeCache {
  readonly #load: SchemeLoader;
  readonly #log: LogLine;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  readonly #inFlight = new Map<string, Promise<readonly CredentialScheme[]>>();

  /**
   * Over a `Database`: each miss runs Q-1 in its own `withAppRw`. Over a function: the loader is
   * called on each miss (tests, or a caller with its own transaction discipline).
   */
  constructor(
    source: Database | SchemeLoader,
    log: LogLine,
    options: CredentialSchemeCacheOptions = {},
  ) {
    this.#load =
      typeof source === 'function'
        ? source
        : (jurisdiction) => source.withAppRw((tx) => readCredentialSchemes(tx, jurisdiction));
    this.#log = log;
    this.#now = options.now ?? Date.now;
  }

  /** The jurisdiction's schemes, from the cache when fresh. See the file header. */
  async forJurisdiction(jurisdiction: string): Promise<readonly CredentialScheme[]> {
    assertJurisdiction(jurisdiction);
    const entry = this.#entries.get(jurisdiction);
    if (entry !== undefined && this.#now() - entry.loadedAt < SCHEME_CACHE_TTL_MS) {
      return entry.schemes;
    }
    const pending = this.#inFlight.get(jurisdiction);
    if (pending !== undefined) return pending;
    const read = (async () => {
      try {
        const schemes = await this.#load(jurisdiction);
        this.#entries.set(jurisdiction, { loadedAt: this.#now(), schemes });
        return schemes;
      } catch (thrown) {
        this.#entries.delete(jurisdiction);
        if (thrown instanceof CredentialSchemeReadError) {
          this.#log(
            `${SCHEME_READ_REFUSED_LOG} jurisdiction=${jurisdiction} fields=${thrown.fields.join(',')}`,
          );
        }
        throw thrown;
      } finally {
        this.#inFlight.delete(jurisdiction);
      }
    })();
    this.#inFlight.set(jurisdiction, read);
    return read;
  }

  /** The scheme with `id` in `jurisdiction`, or `undefined` if that jurisdiction has none. */
  async byId(jurisdiction: string, id: number): Promise<CredentialScheme | undefined> {
    return (await this.forJurisdiction(jurisdiction)).find((s) => s.id === id);
  }
}
