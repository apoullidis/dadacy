/**
 * THE ROUTE REGISTRY — the single place `module` and `data_class` are set.
 *
 * HOW `data_class` IS SET, stated once and enforced three ways:
 *
 *   It is set HERE, per ROUTE TEMPLATE, at design time. It is never taken from
 *   the request, never taken from the caller, and never inferred at run time.
 *   A route's class is the HIGHEST SA §SEC-3 class of data that route handles.
 *
 *   1. STATICALLY. `pnpm gate:otel-contract` (check R1) reads
 *      `packages/contracts`' OPERATIONS table and fails if any operation has no
 *      entry here. The expected set therefore comes from a DIFFERENT artefact
 *      than the registry itself (PROTOCOL §5.1: a check must not be derived
 *      from the same reading as the thing it checks).
 *   2. AT MODULE LOAD. `assertRegistry()` runs at import time. A malformed
 *      entry — a data class outside SA §SEC-3's four, a module outside
 *      SA §SA-2's set, a duplicate key, a path that is not a template — throws,
 *      so the app does not boot.
 *   3. AT EMIT TIME. `emitRequestSpan` looks the route up here. A route with no
 *      entry cannot produce a classified span: see `UNCLASSIFIED` below.
 *
 * WHAT HAPPENS WHEN IT IS ABSENT OR WRONG:
 *
 *   ABSENT (no registry entry for the route)  -> the span is REFUSED as
 *     emitted. `refuseRequestSpan` substitutes the reserved template
 *     `(unregistered)` for the route, `data_class: 'UNCLASSIFIED'`, and
 *     `module: 'meta'`, and increments `counters.refusedSpans`. The concrete
 *     path NEVER reaches the exporter. The request itself still succeeds —
 *     observability must not be able to fail a request — but the span says, in
 *     the exporter's own output, that the contract was not met.
 *   WRONG (a value outside SA §SEC-3's four) -> `assertRegistry` throws at
 *     import, `gate:otel-contract` R2 is red, and `emitRequestSpan` refuses.
 *   INCONSISTENT (a caller passing a `data_class` that disagrees with the
 *     registry) -> refused with `REFUSAL.routeDataClassMismatch`. The caller
 *     cannot upgrade or downgrade a route's class from the request path.
 *
 * Every sentence above names a test in `src/routes.test.ts` or a case in
 * `scripts/negative-tests/otel-contract.sh`; see state/EP-1/T-008.md
 * § Published contract §3.
 */
import { DATA_CLASSES, MODULES, type DataClass, type KinvaraModule } from './contract.ts';

export interface RouteEntry {
  readonly module: KinvaraModule;
  readonly data_class: DataClass;
  /** Why this class and not a lower one. Read by a human, and by nothing else. */
  readonly because: string;
}

/**
 * The reserved templates. They are route VALUES, not paths, and no HTTP request
 * can ever produce them by accident: a real key always contains a space and a
 * leading slash.
 */
export const RESERVED_ROUTES = Object.freeze({
  /** A request that matched no route. Its concrete path is discarded. */
  unmatched: '(unmatched)',
  /** A route with no registry entry. Produced only by `refuseRequestSpan`. */
  unregistered: '(unregistered)',
});

/**
 * Key: `<METHOD> <path template>`, method upper-case, path exactly as
 * `packages/contracts`' OPERATIONS declares it.
 *
 * ADDING A ROUTE: add its entry here in the same change set as the controller.
 * `gate:otel-contract` R1 goes red the moment an operation exists without one,
 * so this cannot be forgotten and discovered in production.
 */
export const ROUTE_REGISTRY: Readonly<Record<string, RouteEntry>> = Object.freeze({
  'GET /v1/meta/platform-fee': {
    module: 'meta',
    data_class: 'C4',
    because: 'SA §SEC-3 C4 — pricing configuration. The response carries no subject at all.',
  },
  'POST /v1/auth/register': {
    module: 'identity',
    data_class: 'C2',
    because: 'SA §SEC-3 C2 — the request carries an e-mail address and a password.',
  },
  'POST /v1/auth/login': {
    module: 'identity',
    data_class: 'C2',
    because: 'SA §SEC-3 C2 — the request carries an e-mail address and a password.',
  },
  'POST /v1/auth/logout': {
    module: 'identity',
    data_class: 'C2',
    because: 'SA §SEC-3 C2 — the request carries a session cookie identifying a person.',
  },
  'GET /healthz': {
    module: 'meta',
    data_class: 'C4',
    because:
      'SA §SEC-3 C4 — the image HEALTHCHECK route (T-135 § contract §4). Not in the API document, so R1 does not derive it; it is here because it is served.',
  },
  [RESERVED_ROUTES.unmatched]: {
    module: 'meta',
    data_class: 'C4',
    because:
      'A request that matched no route. THE CONCRETE PATH IS DISCARDED, which is the point: an unmatched path is the most likely place for an e-mail address or an id to arrive, and it must never become a span attribute.',
  },
  [RESERVED_ROUTES.unregistered]: {
    module: 'meta',
    data_class: 'C4',
    because:
      'The refusal template. Its own class is C4 because the template carries no subject; the span it appears on is stamped UNCLASSIFIED, which is not a class.',
  },
});

/** `<METHOD> <path>` with the method upper-cased. The only supported key form. */
export const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

export const lookupRoute = (route: string): RouteEntry | undefined =>
  Object.hasOwn(ROUTE_REGISTRY, route) ? ROUTE_REGISTRY[route] : undefined;

export class RegistryMalformed extends Error {
  constructor(message: string) {
    super(`observability: route registry is malformed — ${message}`);
    this.name = 'RegistryMalformed';
  }
}

const RESERVED = new Set<string>(Object.values(RESERVED_ROUTES));
/** `<METHOD> /path`, with no query string, no fragment and no `:param`-free concrete id. */
const TEMPLATE = /^[A-Z]+ \/[A-Za-z0-9\-._~/{}]*$/;

/**
 * Runs at import (bottom of this file). It is the layer-2 check of the three
 * above, and it is deliberately separate from `gate:otel-contract` so that a
 * malformed registry cannot reach a running container even if the gate were
 * never run.
 */
export function assertRegistry(
  registry: Readonly<Record<string, RouteEntry>> = ROUTE_REGISTRY,
): void {
  const keys = Object.keys(registry);
  if (keys.length === 0) throw new RegistryMalformed('it is empty');
  for (const key of keys) {
    const entry = registry[key];
    if (entry === undefined) throw new RegistryMalformed(`${key} has no entry`);
    if (!RESERVED.has(key) && !TEMPLATE.test(key)) {
      throw new RegistryMalformed(
        `${JSON.stringify(key)} is not "<METHOD> /template" — a concrete URL, a query string or a fragment is exactly what must never become a route attribute`,
      );
    }
    if (!(MODULES as readonly string[]).includes(entry.module)) {
      throw new RegistryMalformed(
        `${key} declares module ${JSON.stringify(entry.module)}, which is not in SA §SA-2`,
      );
    }
    if (!(DATA_CLASSES as readonly string[]).includes(entry.data_class)) {
      throw new RegistryMalformed(
        `${key} declares data_class ${JSON.stringify(entry.data_class)}, which is not one of SA §SEC-3's ${DATA_CLASSES.join(', ')}`,
      );
    }
    if (entry.because.trim() === '') {
      throw new RegistryMalformed(`${key} gives no reason for its class`);
    }
  }
}

assertRegistry();
