/**
 * THE PIPELINE — `pnpm --filter @kinvara/contracts run generate`.
 *
 *     src/endpoints.ts (Zod)  --z.toJSONSchema-->  openapi.json
 *     openapi.json (re-read from disk)  ---------->  src/generated/client.ts
 *
 * Both artefacts are COMMITTED. `pnpm gate:contract-drift` regenerates them
 * into a temporary directory and requires the bytes to be identical, so a Zod
 * edit committed without regenerating is refused.
 *
 * THE SECOND LEG RE-READS THE FILE IT JUST WROTE, deliberately. The client
 * could have been emitted from the Zod schemas directly — it would be less
 * code. It is not, because then `openapi.json` would be a side artefact that
 * nothing consumed, and a generator bug that corrupted the document would not
 * show up in the client. Reading it back makes the client the document's first
 * consumer, exactly as an external client would be, so a broken document
 * breaks the build. T-022 § Published contract §5 states the limit of what
 * this buys.
 *
 * DETERMINISM is a requirement, not a hope: the gate compares bytes, so the
 * output must not carry a timestamp, a hostname, an absolute path or a
 * set-iteration order. Nothing here reads the clock or the environment.
 * `Object.keys` order is insertion order, and every object below is built in a
 * fixed order from `OPERATIONS` and `COMPONENT_SCHEMAS`, which are arrays and
 * a literal. Held by `gate:contract-drift` itself, which runs the generator a
 * second time and would report drift against its own first output.
 *
 * USAGE: `node tools/generate.ts [--out-dir <dir>]`. With `--out-dir` it
 * writes `<dir>/openapi.json` and `<dir>/client.ts` and touches nothing in the
 * repository; that is the mode the gate uses.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import {
  API_TITLE,
  API_VERSION,
  COMPONENT_SCHEMAS,
  OPERATIONS,
  type Operation,
} from '../src/endpoints.ts';
import { FORBIDDEN_MEMBERS } from '../src/problem.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

export const OPENAPI_FILE = 'openapi.json';
export const CLIENT_FILE = 'client.ts';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── leg 1: Zod -> OpenAPI 3.1 ──────────────────────────────────────────────

/**
 * One component schema. `$schema` is dropped: it is a JSON Schema document
 * header and has no place inside an OpenAPI `components/schemas` entry.
 */
function componentSchema(name: string, schema: z.ZodType): Record<string, unknown> {
  const emitted: unknown = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  if (!isRecord(emitted)) throw new TypeError(`${name}: z.toJSONSchema did not return an object`);
  const out: Record<string, unknown> = { ...emitted };
  delete out['$schema'];

  // OE-15(2), the one clause Zod cannot express: `detail` and `instance` are
  // never emitted, and the body permits OTHER extension members (SD §BE-15),
  // so "additionalProperties: false" is not the right instrument. JSON
  // Schema's `not` is. Read from the same constant the runtime check reads —
  // stated as a bound in T-022 § Published contract §7.
  if (name === 'Problem') {
    out['not'] = { anyOf: FORBIDDEN_MEMBERS.map((member) => ({ required: [member] })) };
  }
  return out;
}

function operationObject(op: Operation): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const r of op.responses) {
    if (!Object.hasOwn(COMPONENT_SCHEMAS, r.schema)) {
      throw new TypeError(
        `${op.operationId}: response ${String(r.status)} names an unknown schema ${r.schema}`,
      );
    }
    const mediaType = r.status >= 400 ? 'application/problem+json' : 'application/json';
    responses[String(r.status)] = {
      description: r.description,
      content: { [mediaType]: { schema: { $ref: `#/components/schemas/${r.schema}` } } },
    };
  }
  const out: Record<string, unknown> = { operationId: op.operationId, summary: op.summary };
  // T-141: an operation that takes a body declares it as a REQUIRED JSON body. Inserted
  // between `summary` and `responses`, so an operation without one renders exactly as
  // it did before this key existed.
  if (op.request !== undefined) {
    if (!Object.hasOwn(COMPONENT_SCHEMAS, op.request)) {
      throw new TypeError(`${op.operationId}: request names an unknown schema ${op.request}`);
    }
    out['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${op.request}` } } },
    };
  }
  out['responses'] = responses;
  return out;
}

export function buildOpenApi(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const name of Object.keys(COMPONENT_SCHEMAS)) {
    const schema = COMPONENT_SCHEMAS[name];
    if (schema === undefined) throw new TypeError(`${name}: no schema`);
    schemas[name] = componentSchema(name, schema);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const existing = paths[op.path] ?? {};
    existing[op.method] = operationObject(op);
    paths[op.path] = existing;
  }

  return {
    openapi: '3.1.1',
    info: {
      title: API_TITLE,
      version: API_VERSION,
      description:
        'Generated from the Zod schemas in packages/contracts/src/endpoints.ts. ' +
        'Do not edit by hand: pnpm gate:contract-drift refuses a hand edit.',
    },
    paths,
    components: { schemas },
  };
}

// ── leg 2: the OpenAPI document -> a typed client ──────────────────────────

/** A TS type expression for one JSON Schema node, read from the DOCUMENT. */
function tsType(node: unknown, indent: string): string {
  if (!isRecord(node)) throw new TypeError('client emitter: schema node is not an object');

  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const prefix = '#/components/schemas/';
    if (!ref.startsWith(prefix)) throw new TypeError(`client emitter: unsupported $ref ${ref}`);
    return ref.slice(prefix.length);
  }

  if ('const' in node) return JSON.stringify(node['const']);

  const enumeration = node['enum'];
  if (Array.isArray(enumeration)) {
    return enumeration.map((v) => JSON.stringify(v)).join(' | ');
  }

  const type = node['type'];
  if (type === 'string') return 'string';
  if (type === 'boolean') return 'boolean';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'array') return `readonly ${tsType(node['items'], indent)}[]`;
  if (type === 'object') {
    const properties = isRecord(node['properties']) ? node['properties'] : {};
    const required = new Set(
      (Array.isArray(node['required']) ? node['required'] : []).filter(
        (n): n is string => typeof n === 'string',
      ),
    );
    const inner = `${indent}  `;
    const lines: string[] = [];
    for (const name of Object.keys(properties)) {
      const optional = required.has(name) ? '' : '?';
      lines.push(`${inner}readonly ${name}${optional}: ${tsType(properties[name], inner)};`);
    }
    const additional = node['additionalProperties'];
    if (additional !== false && additional !== undefined) {
      // SD §BE-15's extension members. `unknown`, not `any`: SD §DH-2 bans `any`.
      lines.push(`${inner}readonly [extension: string]: unknown;`);
    }
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  throw new TypeError(`client emitter: unsupported schema node ${JSON.stringify(node)}`);
}

export function buildClient(doc: Record<string, unknown>): string {
  const components = doc['components'];
  const schemas =
    isRecord(components) && isRecord(components['schemas']) ? components['schemas'] : {};
  const paths = isRecord(doc['paths']) ? doc['paths'] : {};

  const out: string[] = [];
  out.push('/**');
  out.push(' * GENERATED FILE — do not edit.');
  out.push(' *');
  out.push(' * Written by packages/contracts/tools/generate.ts from openapi.json, which is');
  out.push(' * itself generated from the Zod schemas in src/endpoints.ts. Edit the Zod, then');
  out.push(' * run `pnpm --filter @kinvara/contracts run generate`. `pnpm gate:contract-drift`');
  out.push(' * refuses a hand edit to this file and a Zod edit that was not regenerated.');
  out.push(' *');
  out.push(' * THE TYPES BELOW COME FROM THE DOCUMENT; the runtime parse below comes from the');
  out.push(' * Zod schema. They are two derivations of one contract, and `tsc` has to accept');
  out.push(' * the assignment between them — see the `satisfies` clauses at the end. That is a');
  out.push(' * cross-check `pnpm -w typecheck` enforces, and typecheck IS in gate:pr, unlike');
  out.push(" * this package's tests (OD-57).");
  out.push(' */');
  out.push("import * as schemas from '../endpoints.ts';");
  out.push('');

  for (const name of Object.keys(schemas)) {
    out.push(`export interface ${name} ${tsType(schemas[name], '')}`);
    out.push('');
  }

  out.push('export interface ClientOptions {');
  out.push('  /** Origin the API is served from, with no trailing slash. */');
  out.push('  readonly baseUrl: string;');
  out.push('  /** Injected for tests; defaults to the global fetch. */');
  out.push('  readonly fetch?: typeof globalThis.fetch;');
  out.push('}');
  out.push('');
  out.push('/** Thrown when the server answers a problem+json body. */');
  out.push('export class ProblemResponseError extends Error {');
  out.push('  readonly problem: Problem;');
  out.push('  constructor(problem: Problem) {');
  out.push('    // The MESSAGE is the code, never the body: a logged stack must not carry a');
  out.push('    // field name or an extension value (PROTOCOL §9.2).');
  out.push('    super(problem.code);');
  out.push("    this.name = 'ProblemResponseError';");
  out.push('    this.problem = problem;');
  out.push('  }');
  out.push('}');
  out.push('');

  const methods: string[] = [];
  const impls: string[] = [];
  const checks: string[] = [];
  for (const path of Object.keys(paths)) {
    const byMethod = paths[path];
    if (!isRecord(byMethod)) continue;
    for (const method of Object.keys(byMethod)) {
      const op = byMethod[method];
      if (!isRecord(op)) continue;
      const id = String(op['operationId']);
      const responses = isRecord(op['responses']) ? op['responses'] : {};
      const okStatus = Object.keys(responses).find((s) => Number(s) < 400) ?? '200';
      const okResponse = responses[okStatus];
      const okSchema = isRecord(okResponse)
        ? (() => {
            const content = okResponse['content'];
            if (!isRecord(content)) throw new TypeError(`${id}: response has no content`);
            const first = content[Object.keys(content)[0] ?? ''];
            if (!isRecord(first)) throw new TypeError(`${id}: response has no media type`);
            return tsType(first['schema'], '');
          })()
        : 'unknown';

      // T-141: an operation with a request body takes it as its one argument, read
      // from the DOCUMENT's `requestBody`. The body is parsed by its Zod schema BEFORE
      // the request is sent, so the client refuses a payload the contract refuses
      // instead of sending it. An operation without one renders exactly as before.
      const requestBody = op['requestBody'];
      const requestSchema = isRecord(requestBody)
        ? (() => {
            const content = requestBody['content'];
            if (!isRecord(content)) throw new TypeError(`${id}: request body has no content`);
            const json = content['application/json'];
            if (!isRecord(json)) throw new TypeError(`${id}: request body is not application/json`);
            return tsType(json['schema'], '');
          })()
        : undefined;
      const param = requestSchema === undefined ? '' : `body: ${requestSchema}`;
      const fetchArgs =
        requestSchema === undefined
          ? `'${String(path)}', '${method.toUpperCase()}'`
          : `'${String(path)}', '${method.toUpperCase()}', schemas.${requestSchema}.parse(body)`;

      methods.push(`  readonly ${id}: (${param}) => Promise<${okSchema}>;`);
      impls.push(`    ${id}: async (${param}) => {`);
      impls.push(`      const response = await doFetch(${fetchArgs});`);
      impls.push(`      return schemas.${okSchema}.parse(await response.json()) as ${okSchema};`);
      impls.push('    },');
      checks.push(
        `type _${id}Parsed = ReturnType<typeof schemas.${okSchema}.parse> extends infer P ? P : never;`,
      );
      checks.push(`const _${id}Check = null as unknown as _${id}Parsed satisfies ${okSchema};`);
      checks.push(`void _${id}Check;`);
      if (requestSchema !== undefined) {
        checks.push(
          `type _${id}Request = ReturnType<typeof schemas.${requestSchema}.parse> extends infer P ? P : never;`,
        );
        checks.push(
          `const _${id}RequestCheck = null as unknown as _${id}Request satisfies ${requestSchema};`,
        );
        checks.push(`void _${id}RequestCheck;`);
      }
    }
  }

  out.push('export interface KinvaraClient {');
  out.push(...methods);
  out.push('}');
  out.push('');
  out.push('export function createClient(options: ClientOptions): KinvaraClient {');
  out.push(
    '  const doFetch = async (path: string, method: string, body?: unknown): Promise<Response> => {',
  );
  out.push('    const impl = options.fetch ?? globalThis.fetch;');
  out.push("    const accept = 'application/json, application/problem+json';");
  out.push('    const init: RequestInit =');
  out.push('      body === undefined');
  out.push('        ? { method, headers: { accept } }');
  out.push(
    "        : { method, headers: { accept, 'content-type': 'application/json' }, body: JSON.stringify(body) };",
  );
  out.push('    const response = await impl(`${options.baseUrl}${path}`, init);');
  out.push('    if (!response.ok) {');
  out.push(
    '      throw new ProblemResponseError(schemas.Problem.parse(await response.json()) as Problem);',
  );
  out.push('    }');
  out.push('    return response;');
  out.push('  };');
  out.push('  return {');
  out.push(...impls);
  out.push('  };');
  out.push('}');
  out.push('');
  out.push('// The cross-check named in the header: what the Zod schema parses must be');
  out.push('// assignable to the type the DOCUMENT declares. A generator that mistranslated a');
  out.push('// schema fails here, under `pnpm -w typecheck`.');
  out.push(...checks);
  out.push('');
  return out.join('\n');
}

// ── entry point ────────────────────────────────────────────────────────────

function outDirFromArgv(argv: readonly string[]): string {
  const i = argv.indexOf('--out-dir');
  if (i === -1) return join(PKG, 'src', 'generated');
  const dir = argv[i + 1];
  if (dir === undefined) {
    console.error('generate: --out-dir needs a directory');
    process.exit(2);
  }
  return dir;
}

const argv = process.argv.slice(2);
const inPlace = !argv.includes('--out-dir');
const outDir = outDirFromArgv(argv);
const doc = buildOpenApi();
const docText = `${JSON.stringify(doc, null, 2)}\n`;

mkdirSync(outDir, { recursive: true });
const openapiPath = inPlace ? join(PKG, OPENAPI_FILE) : join(outDir, OPENAPI_FILE);
writeFileSync(openapiPath, docText, 'utf8');

// Leg 2 reads the file back from disk, rather than reusing `doc` in memory.
const reread: unknown = JSON.parse(readFileSync(openapiPath, 'utf8'));
if (!isRecord(reread)) throw new TypeError('the document just written did not parse as an object');
writeFileSync(join(outDir, CLIENT_FILE), buildClient(reread), 'utf8');

console.log(`generate: wrote ${openapiPath}`);
console.log(`generate: wrote ${join(outDir, CLIENT_FILE)}`);
