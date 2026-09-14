/**
 * A MINIMAL JSON Schema (draft 2020-12) validator, over exactly the subset
 * this repository's generated document uses.
 *
 * WHY THIS EXISTS, and it is the whole point of the file — PROTOCOL §5.1:
 * *"a check must not be derived from the same reading as the thing it
 * checks"*. The Zod schemas are the source of truth and `z.toJSONSchema`
 * emits `openapi.json` from them. If the tests then validated payloads with
 * ZOD, every test would be asking Zod whether Zod is right, and a generator
 * that mistranslated a schema would pass: Zod and the document would agree
 * because only one of them was ever consulted.
 *
 * So this validator reads the GENERATED DOCUMENT and nothing else. It shares
 * no code with Zod. The conformance tests then run one corpus of payloads past
 * both and require the same verdict on each
 * (`openapi.test.ts` › *Zod and the generated document agree, payload by
 * payload, on every case in the corpus*). Two independent implementations
 * agreeing is evidence; one implementation agreeing with itself is not.
 *
 * WHAT WOULD STILL FOOL BOTH, stated rather than left for a reviewer to find:
 * a corpus with no case that distinguishes them. Agreement is only as wide as
 * the payloads fed to it, and the corpus is written by hand. It is listed in
 * `openapi.test.ts` and its size is asserted, so it cannot shrink unnoticed —
 * but "the corpus covers everything that matters" is NOT claimed.
 *
 * SUPPORTED KEYWORDS — and an unsupported one is a FAIL, never a pass
 * (`fail closed`): `$ref` (to `#/components/schemas/*` only), `type`
 * (object/string/integer/number/boolean/array), `const`, `enum`, `pattern`,
 * `minLength`, `maxLength` (code points, T-141), `minimum`, `maximum`, `properties`, `required`,
 * `additionalProperties` (boolean or schema), `items`, `not`, `anyOf`,
 * `allOf`. Anything else in a schema object raises, so a generator that
 * started emitting a keyword this cannot read turns the tests red instead of
 * silently validating nothing. Held by `openapi.test.ts` ›
 * *the validator refuses a schema keyword it does not model, rather than
 * ignoring it*.
 */

/** The document root, needed so `$ref` can be resolved. */
export interface SchemaRoot {
  readonly components?: { readonly schemas?: Record<string, unknown> };
}

const KNOWN = new Set([
  '$ref',
  '$schema',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'not',
  'anyOf',
  'allOf',
  'format',
  'examples',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate `value` against `schema`. Returns the list of problems; an empty
 * list means valid. Throws on a schema this validator does not model.
 */
export function validate(value: unknown, schema: unknown, root: SchemaRoot, path = '$'): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: schema is false, no value is permitted here`];
  if (!isRecord(schema)) throw new TypeError(`${path}: schema is not an object`);

  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) {
      throw new TypeError(`${path}: json-schema-check does not model the keyword ${key}`);
    }
  }

  const problems: string[] = [];

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const prefix = '#/components/schemas/';
    if (!ref.startsWith(prefix)) throw new TypeError(`${path}: unsupported $ref ${ref}`);
    const name = ref.slice(prefix.length);
    const target = root.components?.schemas?.[name];
    if (target === undefined) throw new TypeError(`${path}: $ref ${ref} does not resolve`);
    return validate(value, target, root, path);
  }

  const type = schema['type'];
  if (typeof type === 'string') {
    const ok =
      type === 'object'
        ? isRecord(value)
        : type === 'array'
          ? Array.isArray(value)
          : type === 'string'
            ? typeof value === 'string'
            : type === 'boolean'
              ? typeof value === 'boolean'
              : type === 'integer'
                ? typeof value === 'number' && Number.isInteger(value)
                : type === 'number'
                  ? typeof value === 'number' && Number.isFinite(value)
                  : (() => {
                      throw new TypeError(`${path}: unsupported type ${type}`);
                    })();
    if (!ok) problems.push(`${path}: expected type ${type}, got ${describe(value)}`);
  }

  if ('const' in schema && value !== schema['const']) {
    problems.push(`${path}: expected const ${JSON.stringify(schema['const'])}`);
  }

  const enumeration = schema['enum'];
  if (Array.isArray(enumeration) && !enumeration.includes(value)) {
    problems.push(
      `${path}: ${JSON.stringify(value)} is not one of the ${enumeration.length} enum members`,
    );
  }

  if (typeof value === 'string') {
    const pattern = schema['pattern'];
    if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${pattern}`);
    }
    const minLength = schema['minLength'];
    if (typeof minLength === 'number' && value.length < minLength) {
      problems.push(`${path}: shorter than minLength ${String(minLength)}`);
    }
    // T-141: JSON Schema 2020-12 §6.3.1 counts a string's length in characters as RFC 8259
    // defines them (code points), not UTF-16 units. The document's only `maxLength` today is
    // `RegisterRequest.email`, which `z.email()` limits to ASCII, where the two counts agree.
    const maxLength = schema['maxLength'];
    if (typeof maxLength === 'number' && [...value].length > maxLength) {
      problems.push(`${path}: longer than maxLength ${String(maxLength)}`);
    }
  }

  if (typeof value === 'number') {
    const minimum = schema['minimum'];
    if (typeof minimum === 'number' && value < minimum) {
      problems.push(`${path}: below minimum ${String(minimum)}`);
    }
    const maximum = schema['maximum'];
    if (typeof maximum === 'number' && value > maximum) {
      problems.push(`${path}: above maximum ${String(maximum)}`);
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === 'string' && !Object.hasOwn(value, name)) {
          problems.push(`${path}: missing required property ${name}`);
        }
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (childSchema !== undefined) {
        problems.push(...validate(child, childSchema, root, `${path}.${name}`));
        continue;
      }
      const additional = schema['additionalProperties'];
      if (additional === false) {
        problems.push(`${path}: additional property ${name} is not permitted`);
      } else if (additional !== undefined && additional !== true) {
        problems.push(...validate(child, additional, root, `${path}.${name}`));
      }
    }
  }

  if (Array.isArray(value) && schema['items'] !== undefined) {
    value.forEach((item, i) => {
      problems.push(...validate(item, schema['items'], root, `${path}[${String(i)}]`));
    });
  }

  if ('not' in schema && validate(value, schema['not'], root, path).length === 0) {
    problems.push(`${path}: matches a schema it must not match`);
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf) && !anyOf.some((s) => validate(value, s, root, path).length === 0)) {
    problems.push(`${path}: matches none of the ${anyOf.length} anyOf branches`);
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const s of allOf) problems.push(...validate(value, s, root, path));
  }

  return problems;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
