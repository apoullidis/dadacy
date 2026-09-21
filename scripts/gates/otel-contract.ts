/**
 * gate:otel-contract — T-008.
 *
 * SD §QD-5's instrumentation contract is three tuples and a "No PII (SEC-I5)".
 * `T-119` owns the leak canary that will test the second half with the Cyprus
 * patterns and the cross-script name set; it is `blocked_by T-008` and could
 * not be used here. THIS GATE IS THE WEAKER, STATIC HALF, and it is written so
 * that its weakness is legible rather than implied.
 *
 * WHAT IT CHECKS. Six checks, each anchored on an artefact OTHER than the one
 * it judges, because a check derived from the same reading as the thing it
 * checks agrees with it perfectly and with the world not at all (PROTOCOL
 * §5.1):
 *
 *   R1  every operation in `packages/contracts`' OPERATIONS table has an entry
 *       in `packages/observability`'s ROUTE_REGISTRY.
 *       anchor: the OpenAPI operation table, which the registry does not write.
 *   R2  the registry is well formed: `assertRegistry()` accepts it, and every
 *       `data_class` is one of SA §SEC-3's four.
 *       anchor: `contract.ts`'s DATA_CLASSES and MODULES.
 *   R3  `docker/otel-collector.yaml` is an ALLOWLIST (`allow_all_keys: false`),
 *       it allows every field of the three tuples, and `redaction` is in every
 *       pipeline. anchor: `contract.ts`'s three field lists.
 *   R4  each dashboard in `infra/observability/dashboards` names only metrics
 *       this pipeline produces, only labels that are dimensions of it, and only
 *       label VALUES that are in the closed set that label draws from.
 *       anchor: the collector's `spanmetrics` block and `contract.ts`'s enums.
 *   R5  the wiring is present: `apps/core/src/server.ts` calls
 *       `installObservability`, and nothing under `apps/core/src/observability`
 *       reads `request.url`.
 *       anchor: `apps/core`'s own source, read as text.
 *   R6  `contract.ts`'s ACTOR_ROLES is `packages/contracts`' ACCOUNT_ROLES plus
 *       exactly `anonymous` and `system`. The duplication is deliberate (see
 *       contract.ts); this is what stops it drifting.
 *       anchor: `packages/contracts/src/endpoints.ts`, read as text.
 *
 * WHAT IT DOES NOT CHECK, stated here because a reader of a green gate needs it
 * more than a reader of this file's checks does:
 *
 *   - IT DOES NOT LOOK FOR PII. It has no pattern set, no name list and no
 *     script awareness. It proves the contract has nowhere for free text to
 *     sit; it does not prove that nothing in this system ever emitted any.
 *     `T-119` (`gate:pii-canary`) is the ticket that widens this.
 *   - It runs nothing. No collector, no Jaeger, no request. The end-to-end
 *     half is `packages/observability/tools/canary.ts`, which needs the `otel`
 *     profile and therefore cannot live in `gate:pr` (`svc: none`,
 *     `DOCKER.md` §7) — the same structural bound `gate:drizzle-parity` has.
 *   - It reads the collector config as YAML text. It does not run
 *     `otelcol validate`, which needs the image.
 *
 * ANTI-VACUITY. Every check prints what it examined and REFUSES A ZERO. A gate
 * that checked nothing must say so, not pass (PROTOCOL §5.1). The floors are
 * pinned below and case `Z1`..`Z6` in scripts/negative-tests/otel-contract.sh
 * drives each one to zero and asserts the refusal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT, finish } from './lib/run.ts';
import type * as ContractModule from '../../packages/observability/src/contract.ts';
import type * as RoutesModule from '../../packages/observability/src/routes.ts';
import type * as EndpointsModule from '../../packages/contracts/src/endpoints.ts';

const GATE = 'gate:otel-contract';
const failures: string[] = [];

/**
 * THE THREE MODULES ARE IMPORTED DYNAMICALLY, INSIDE A try, AND THAT IS NOT
 * STYLE. `routes.ts` calls `assertRegistry()` AT MODULE LOAD — deliberately, so
 * a malformed registry cannot reach a running container. A static import here
 * would therefore make a malformed registry crash this gate with an uncaught
 * exception instead of printing its own `GATE FAIL` banner, and "crashed",
 * "refused" and "did nothing" would stop being three distinguishable outcomes
 * (PROTOCOL §5.1; T-005 § contract §5 case B2/B3 is the same shape one level
 * up). Cases R2a-R2c in scripts/negative-tests/otel-contract.sh assert the
 * banner, not merely a non-zero exit.
 */
const loadFailure = (label: string, thrown: unknown): string =>
  `${label}: ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : 'a non-Error was thrown'}`;

let contract: typeof ContractModule | undefined;
let routes: typeof RoutesModule | undefined;
let endpoints: typeof EndpointsModule | undefined;

try {
  contract = await import('../../packages/observability/src/contract.ts');
} catch (thrown) {
  failures.push(loadFailure('R2 packages/observability/src/contract.ts would not load', thrown));
}
try {
  routes = await import('../../packages/observability/src/routes.ts');
} catch (thrown) {
  failures.push(
    loadFailure(
      'R2 packages/observability/src/routes.ts would not load — assertRegistry() refuses the registry AT IMPORT, so this is a malformed registry, not a syntax error',
      thrown,
    ),
  );
}
try {
  endpoints = await import('../../packages/contracts/src/endpoints.ts');
} catch (thrown) {
  failures.push(loadFailure('R1 packages/contracts/src/endpoints.ts would not load', thrown));
}

if (contract === undefined || routes === undefined || endpoints === undefined) {
  console.log(`${GATE}: one or more source modules would not load; nothing else could be checked.`);
  finish(GATE, failures);
}

const {
  ACTOR_ROLES,
  BREAKER_STATES,
  DATA_CLASSES,
  JOB_FIELDS,
  MODULES,
  PROVIDERS,
  PROVIDER_FIELDS,
  QUEUES,
  REQUEST_FIELDS,
  UNCLASSIFIED,
} = contract;
const { ROUTE_REGISTRY, RESERVED_ROUTES, assertRegistry } = routes;
const { OPERATIONS } = endpoints;

const COLLECTOR = path.join(REPO_ROOT, 'docker', 'otel-collector.yaml');
const DASHBOARD_DIR = path.join(REPO_ROOT, 'infra', 'observability', 'dashboards');
const CORE_SERVER = path.join(REPO_ROOT, 'apps', 'core', 'src', 'server.ts');
const CORE_OBS_DIR = path.join(REPO_ROOT, 'apps', 'core', 'src', 'observability');
const ENDPOINTS = path.join(REPO_ROOT, 'packages', 'contracts', 'src', 'endpoints.ts');

/**
 * THE FLOORS. Each is the count this gate had when the floor was last moved,
 * and each refusal below is the anti-vacuity half of the check above it.
 * Moving one down is how a check stops checking; `gate:otel-contract` refuses
 * rather than reporting a green run over a shrinking list.
 */
const FLOOR = Object.freeze({
  /** packages/contracts' OPERATIONS at T-008: T-135's one plus T-141/T-026's three. */
  operations: 4,
  /** ROUTE_REGISTRY at T-008: four operations + /healthz + the two reserved templates. */
  registryEntries: 7,
  /**
   * The UNION of SD §QD-5's three tuples. 7 + 5 + 5 = 17 named fields, of which
   * `duration_ms` appears in all three (2 repeats) and `status` in two (1
   * repeat), so 17 − 3 = 14 distinct. Printed by every run.
   */
  contractFields: 14,
  /** docker/otel-collector.yaml's allowed_keys at T-008. Printed by every run. */
  allowedKeys: 21,
  /** SD §QD-5 names three by hand: T&S golden signals, engineering SLO, finance reconciliation. */
  dashboards: 3,
  panels: 14,
  expressions: 17,
});

const read = (file: string): string => fs.readFileSync(file, 'utf8');

// ---------------------------------------------------------------- R1 + R2
let registryEntries = 0;
try {
  assertRegistry();
  registryEntries = Object.keys(ROUTE_REGISTRY).length;
} catch (thrown) {
  failures.push(
    `R2 the route registry does not satisfy assertRegistry(): ${
      thrown instanceof Error ? thrown.message : 'a non-Error was thrown'
    }`,
  );
}
if (registryEntries < FLOOR.registryEntries) {
  failures.push(
    `R2 ROUTE_REGISTRY has ${String(registryEntries)} entr(ies); the floor is ${String(FLOOR.registryEntries)}. A registry that classifies nothing is the vacuous pass this gate exists to refuse.`,
  );
}

let operationsChecked = 0;
for (const operation of OPERATIONS) {
  operationsChecked += 1;
  const key = `${operation.method.toUpperCase()} ${operation.path}`;
  if (!Object.hasOwn(ROUTE_REGISTRY, key)) {
    failures.push(
      `R1 ${key} (operationId ${operation.operationId}) is in packages/contracts' OPERATIONS and has NO ROUTE_REGISTRY entry, so a request to it would emit data_class=${UNCLASSIFIED}. Add it to packages/observability/src/routes.ts in the same change set as the controller.`,
    );
  }
}
if (operationsChecked < FLOOR.operations) {
  failures.push(
    `R1 read ${String(operationsChecked)} operation(s) from packages/contracts; the floor is ${String(FLOOR.operations)}. Zero operations would make R1 vacuously green.`,
  );
}

// ---------------------------------------------------------------- R3
const CONTRACT_FIELDS: readonly string[] = [
  ...new Set<string>([...REQUEST_FIELDS, ...JOB_FIELDS, ...PROVIDER_FIELDS]),
];
if (CONTRACT_FIELDS.length < FLOOR.contractFields) {
  failures.push(
    `R3 the three SD §QD-5 tuples give ${String(CONTRACT_FIELDS.length)} distinct field(s); the floor is ${String(FLOOR.contractFields)}. A shrunken contract would make the allowlist check vacuous.`,
  );
}

interface RedactionBlock {
  allow_all_keys?: unknown;
  allowed_keys?: unknown;
  summary?: unknown;
}
interface SpanMetricsBlock {
  namespace?: unknown;
  dimensions?: unknown;
}
interface CollectorConfig {
  processors?: { redaction?: RedactionBlock };
  connectors?: { spanmetrics?: SpanMetricsBlock };
  service?: { pipelines?: Record<string, { receivers?: unknown; processors?: unknown }> };
}

let allowedKeys: string[] = [];
let spanMetricsNamespace = '';
let spanMetricsDimensions: string[] = [];
try {
  const config = parse(read(COLLECTOR)) as CollectorConfig;
  const redaction = config.processors?.redaction;
  if (redaction === undefined) {
    failures.push(
      `R3 docker/otel-collector.yaml declares no \`redaction\` processor. It is the SECOND of SA §TS-10 rule 1's three redaction points and the only one that bounds what ARRIVES rather than what this repository emits.`,
    );
  } else {
    if (redaction.allow_all_keys !== false) {
      failures.push(
        `R3 docker/otel-collector.yaml's redaction processor has allow_all_keys=${JSON.stringify(redaction.allow_all_keys)}; it must be false. SA §TS-10 rule 1 is an ALLOWLIST, "not a denylist — denylists fail on the field nobody thought of".`,
      );
    }
    allowedKeys = Array.isArray(redaction.allowed_keys)
      ? redaction.allowed_keys.filter((k): k is string => typeof k === 'string')
      : [];
    for (const field of CONTRACT_FIELDS) {
      if (!allowedKeys.includes(field)) {
        failures.push(
          `R3 ${field} is a field of SD §QD-5's instrumentation contract and is NOT in the collector's allowed_keys, so the collector would strip it off every span. packages/observability and docker/otel-collector.yaml must name the same set.`,
        );
      }
    }
    if (!allowedKeys.includes('service.name')) {
      failures.push(
        `R3 service.name is not in allowed_keys. Without it Jaeger cannot name the service and the trace is unfindable rather than clean.`,
      );
    }
  }

  const pipelines = config.service?.pipelines ?? {};
  const pipelineNames = Object.keys(pipelines);
  if (pipelineNames.length === 0) {
    failures.push(`R3 docker/otel-collector.yaml declares no pipelines, so nothing is redacted.`);
  }
  for (const name of pipelineNames) {
    const processors = pipelines[name]?.processors;
    const list = Array.isArray(processors) ? processors.map(String) : [];
    if (!list.includes('redaction')) {
      failures.push(
        `R3 pipeline \`${name}\` does not run the redaction processor (it runs: ${list.join(', ') || 'nothing'}). Every pipeline with a receiver carries telemetry that has not been through the allowlist.`,
      );
    }
  }

  const spanmetrics = config.connectors?.spanmetrics;
  spanMetricsNamespace = typeof spanmetrics?.namespace === 'string' ? spanmetrics.namespace : '';
  spanMetricsDimensions = Array.isArray(spanmetrics?.dimensions)
    ? spanmetrics.dimensions
        .map((d) =>
          typeof d === 'object' && d !== null && 'name' in d
            ? String((d as { name: unknown }).name)
            : '',
        )
        .filter((n) => n !== '')
    : [];
  for (const dimension of spanMetricsDimensions) {
    if (!allowedKeys.includes(dimension)) {
      failures.push(
        `R3 the spanmetrics connector reads dimension \`${dimension}\`, which the redaction allowlist does not pass. A metric label that is not an allowlisted span attribute is a label with nowhere to come from.`,
      );
    }
  }
} catch (thrown) {
  failures.push(
    `R3 docker/otel-collector.yaml could not be read or parsed: ${
      thrown instanceof Error ? thrown.message : 'a non-Error was thrown'
    }`,
  );
}
if (allowedKeys.length < FLOOR.allowedKeys) {
  failures.push(
    `R3 the collector allowlist has ${String(allowedKeys.length)} key(s); the floor is ${String(FLOOR.allowedKeys)}. An empty allowlist strips everything, which is "safe" and useless.`,
  );
}

// ---------------------------------------------------------------- R4
/** Metric names this pipeline produces, derived from the collector config. */
const metricNames = (): readonly string[] => {
  const ns = spanMetricsNamespace === '' ? '' : `${spanMetricsNamespace}_`;
  return [
    `${ns}calls_total`,
    `${ns}duration_milliseconds_bucket`,
    `${ns}duration_milliseconds_sum`,
    `${ns}duration_milliseconds_count`,
    'provider_health',
  ];
};

/**
 * Label names a query may use: the connector's configured dimensions, the
 * dimensions it always emits, `le` for a histogram, and the `provider_health`
 * gauge's two attributes.
 */
const labelNames = (): readonly string[] => [
  ...spanMetricsDimensions,
  'service_name',
  'span_name',
  'span_kind',
  'status_code',
  'le',
  'provider',
  'state',
];

/** The closed set each label's VALUES are drawn from. A label absent here is value-unchecked. */
const labelValues: Readonly<Record<string, readonly string[]>> = {
  route: [...Object.keys(ROUTE_REGISTRY)],
  module: [...MODULES],
  actor_role: [...ACTOR_ROLES],
  data_class: [...DATA_CLASSES, UNCLASSIFIED],
  provider: [...PROVIDERS],
  state: [...BREAKER_STATES],
  queue: [...QUEUES],
};

const METRIC_IN_EXPR = /\b([a-z_][a-z0-9_]*)\s*\{/g;
const METRIC_BARE = /\brate\(\s*([a-z_][a-z0-9_]*)\s*\[/g;
const LABEL_MATCHER = /([a-z_][a-z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"/g;
const BY_CLAUSE = /\bby\s*\(([^)]*)\)/g;

interface Panel {
  title?: unknown;
  targets?: unknown;
}
interface Dashboard {
  uid?: unknown;
  title?: unknown;
  schemaVersion?: unknown;
  panels?: unknown;
}

let dashboards = 0;
let panels = 0;
let expressions = 0;

let dashboardFiles: string[] = [];
try {
  dashboardFiles = fs
    .readdirSync(DASHBOARD_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
} catch {
  failures.push(`R4 ${path.relative(REPO_ROOT, DASHBOARD_DIR)} does not exist.`);
}

for (const file of dashboardFiles) {
  const rel = path.join('infra', 'observability', 'dashboards', file);
  let dashboard: Dashboard;
  try {
    dashboard = JSON.parse(read(path.join(DASHBOARD_DIR, file))) as Dashboard;
  } catch (thrown) {
    failures.push(
      `R4 ${rel} is not valid JSON: ${thrown instanceof Error ? thrown.message : 'unknown'}`,
    );
    continue;
  }
  dashboards += 1;
  for (const key of ['uid', 'title', 'schemaVersion', 'panels'] as const) {
    if (dashboard[key] === undefined) failures.push(`R4 ${rel} has no \`${key}\`.`);
  }
  const panelList = Array.isArray(dashboard.panels) ? (dashboard.panels as Panel[]) : [];
  if (panelList.length === 0) failures.push(`R4 ${rel} has no panels.`);
  for (const panel of panelList) {
    panels += 1;
    const title = typeof panel.title === 'string' ? panel.title : '(untitled)';
    const targets = Array.isArray(panel.targets) ? panel.targets : [];
    if (targets.length === 0) {
      failures.push(`R4 ${rel} panel "${title}" has no targets, so it queries nothing.`);
      continue;
    }
    for (const target of targets) {
      const expr =
        typeof target === 'object' && target !== null && 'expr' in target
          ? String((target as { expr: unknown }).expr)
          : '';
      if (expr === '') {
        failures.push(`R4 ${rel} panel "${title}" has a target with no expr.`);
        continue;
      }
      expressions += 1;
      const seen = new Set<string>();
      for (const re of [METRIC_IN_EXPR, METRIC_BARE]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null = re.exec(expr);
        while (m !== null) {
          if (m[1] !== undefined) seen.add(m[1]);
          m = re.exec(expr);
        }
      }
      for (const name of seen) {
        if (!metricNames().includes(name)) {
          failures.push(
            `R4 ${rel} panel "${title}" queries metric \`${name}\`, which this pipeline does not produce. It produces: ${metricNames().join(', ')}. A board that queries a metric nobody emits renders blank and reads as "no problem".`,
          );
        }
      }
      LABEL_MATCHER.lastIndex = 0;
      let lm: RegExpExecArray | null = LABEL_MATCHER.exec(expr);
      while (lm !== null) {
        const label = lm[1] ?? '';
        const op = lm[2] ?? '=';
        const value = lm[3] ?? '';
        if (!labelNames().includes(label)) {
          failures.push(
            `R4 ${rel} panel "${title}" filters on label \`${label}\`, which is not a dimension of this pipeline. Allowed: ${labelNames().join(', ')}.`,
          );
        } else if (op === '=' && Object.hasOwn(labelValues, label)) {
          const allowed = labelValues[label] ?? [];
          if (!allowed.includes(value)) {
            failures.push(
              `R4 ${rel} panel "${title}" filters ${label}="${value}", which is not in that label's closed set. A board naming a route, module or class nothing serves is the "green check, zero coverage" failure of SD §Revision Log G1.`,
            );
          }
        }
        lm = LABEL_MATCHER.exec(expr);
      }
      BY_CLAUSE.lastIndex = 0;
      let bm: RegExpExecArray | null = BY_CLAUSE.exec(expr);
      while (bm !== null) {
        for (const raw of (bm[1] ?? '').split(',')) {
          const label = raw.trim();
          if (label !== '' && !labelNames().includes(label)) {
            failures.push(
              `R4 ${rel} panel "${title}" groups by \`${label}\`, which is not a dimension of this pipeline.`,
            );
          }
        }
        bm = BY_CLAUSE.exec(expr);
      }
    }
  }
}
if (dashboards !== FLOOR.dashboards) {
  failures.push(
    `R4 found ${String(dashboards)} dashboard definition(s); SD §QD-5 names exactly ${String(FLOOR.dashboards)} — the T&S golden-signal board, the engineering SLO board and the finance reconciliation board.`,
  );
}
if (panels < FLOOR.panels) {
  failures.push(
    `R4 read ${String(panels)} panel(s); the floor is ${String(FLOOR.panels)}. Three empty dashboards would satisfy the count above and check nothing.`,
  );
}
if (expressions < FLOOR.expressions) {
  failures.push(
    `R4 read ${String(expressions)} query expression(s); the floor is ${String(FLOOR.expressions)}. A panel set with no queries is the same vacuous pass one level down.`,
  );
}

// ---------------------------------------------------------------- R5
/**
 * Comments are removed BEFORE either R5 check reads the source, and for both
 * directions of the rule.
 *
 * The FORBID direction needs it because the comments in
 * `apps/core/src/observability/install.ts` name `request.url` on purpose, to
 * explain why it is never read. The REQUIRE direction needs it for the
 * opposite reason, and that one is a measured defect, not a precaution:
 * `scripts/negative-tests/otel-contract.sh` case R5a commented the call out
 * and this gate stayed GREEN, because `// installObservability(app);` still
 * matches a regex over the raw text. That is OD-26 / OD-28's family — "every
 * forbid-check reads the comment-stripped source while the require-checks read
 * the raw source" — reproduced in a seventh place by its own suite before
 * anyone else had to find it.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

try {
  const server = stripComments(read(CORE_SERVER));
  if (!/installObservability\s*\(/.test(server)) {
    failures.push(
      `R5 apps/core/src/server.ts does not call installObservability(). The contract is emitted by nothing, and every claim about it is about code that never runs.`,
    );
  }
  const obsFiles = fs
    .readdirSync(CORE_OBS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  if (obsFiles.length === 0) {
    failures.push(`R5 apps/core/src/observability contains no TypeScript file.`);
  }
  for (const file of obsFiles) {
    const live = stripComments(read(path.join(CORE_OBS_DIR, file)));
    for (const pattern of [/\brequest\.url\b/, /\breq\.url\b/, /\brequest\.originalUrl\b/]) {
      if (pattern.test(live)) {
        failures.push(
          `R5 apps/core/src/observability/${file} reads the raw request URL (${pattern.source}). The route attribute comes from the ROUTER'S REGISTERED TEMPLATE; the URL the client sent is where a path parameter, a query string or an e-mail address arrives, and nothing here may read it.`,
        );
      }
    }
  }
} catch (thrown) {
  failures.push(
    `R5 could not read apps/core's observability wiring: ${
      thrown instanceof Error ? thrown.message : 'unknown'
    }`,
  );
}

// ---------------------------------------------------------------- R6
try {
  const endpoints = read(ENDPOINTS);
  const block = /export const ACCOUNT_ROLES = \[([\s\S]*?)\] as const;/.exec(endpoints);
  if (block?.[1] === undefined) {
    failures.push(
      `R6 packages/contracts/src/endpoints.ts has no \`export const ACCOUNT_ROLES = [...] as const;\` block, so ACTOR_ROLES cannot be held against it.`,
    );
  } else {
    const declared = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
    const expected = [...declared, 'anonymous', 'system'];
    const actual = [...ACTOR_ROLES];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `R6 packages/observability's ACTOR_ROLES is ${JSON.stringify(actual)}; packages/contracts' ACCOUNT_ROLES plus anonymous and system is ${JSON.stringify(expected)}. The duplication is deliberate (importing @kinvara/contracts' root drags @kinvara/i18n into every app that emits a span); this check is what stops it drifting.`,
      );
    }
    if (declared.length === 0) {
      failures.push(`R6 read 0 roles from packages/contracts, so the comparison is vacuous.`);
    }
  }
} catch (thrown) {
  failures.push(
    `R6 could not read packages/contracts/src/endpoints.ts: ${
      thrown instanceof Error ? thrown.message : 'unknown'
    }`,
  );
}

// ---------------------------------------------------------------- report
console.log(`${GATE}:`);
console.log(`  R1 operations checked against the route registry: ${String(operationsChecked)}`);
console.log(`  R2 route registry entries: ${String(registryEntries)}`);
console.log(
  `  R3 contract fields: ${String(CONTRACT_FIELDS.length)}; collector allowlist keys: ${String(allowedKeys.length)}; spanmetrics dimensions: ${String(spanMetricsDimensions.length)}`,
);
console.log(
  `  R4 dashboards: ${String(dashboards)}; panels: ${String(panels)}; query expressions: ${String(expressions)}`,
);
console.log(`  R5 apps/core wiring read`);
console.log(`  R6 ACTOR_ROLES held against packages/contracts' ACCOUNT_ROLES`);
console.log(
  `  reserved route templates: ${Object.values(RESERVED_ROUTES).join(' ')} (a concrete URL never becomes a route attribute)`,
);
console.log(
  `  NOT CHECKED HERE: any PII pattern, any cross-script name form, and anything that needs a running collector. T-119 (gate:pii-canary) widens the first two; packages/observability/tools/canary.ts is the end-to-end half and needs the otel profile.`,
);

finish(GATE, failures);
