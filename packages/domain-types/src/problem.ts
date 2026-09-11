/**
 * `toProblem` — the framework-neutral half of SD §DH-2's "single exception
 * filter". The NestJS filter in `core` (not yet scaffolded) is a thin wrapper
 * that calls this and writes `status`, `contentType` and `body`.
 *
 * The body is BUILT from an allowlist, not copied from the error and pruned:
 * `type`, `title`, `status`, `code`, `field?`, `retryable` (SD §BE-2's
 * "never echoes input" row), plus the error's declared extensions with every
 * `value` key removed at any depth (SD §BE-2: "the global exception filter
 * strips any `value` key as a backstop"). An extension cannot replace a
 * standard member, and `detail` / `instance` are never emitted: `detail` is
 * free text, which is exactly the channel an echoed input would travel through,
 * and the UI "maps `code` → copy, never parses `detail`".
 *
 * Anything that is not a DomainError becomes a 500 `internal_error` carrying
 * nothing from the thrown value.
 *
 * `typeBase` is a required argument, not a constant, because SD writes the
 * error-type host two ways (§BE-2 `errors.kinvara.co`, §BE-15
 * `errors.kinvara.cy`); the caller that owns the HTTP surface decides.
 */
import { DomainError, type JsonValue } from './errors.ts';

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly retryable: boolean;
  readonly [extension: string]: JsonValue | undefined;
}

export interface Problem {
  readonly status: number;
  readonly contentType: 'application/problem+json';
  readonly body: ProblemBody;
}

const STANDARD = new Set(['type', 'title', 'status', 'code', 'field', 'retryable']);
const NEVER_EMITTED = new Set(['value', 'detail', 'instance']);
const TYPE_BASE = /^https:\/\/[a-z0-9.-]+\/(?:[a-z0-9._-]+\/)*$/;

function withoutValue(json: JsonValue): JsonValue {
  if (Array.isArray(json)) return json.map(withoutValue);
  if (typeof json === 'object' && json !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(json)) if (k !== 'value') out[k] = withoutValue(v);
    return out;
  }
  return json;
}

export function toProblem(error: unknown, typeBase: string): Problem {
  if (!TYPE_BASE.test(typeBase)) {
    throw new TypeError('toProblem: typeBase must be an https URL ending in "/"');
  }
  if (!(error instanceof DomainError)) {
    return {
      status: 500,
      contentType: 'application/problem+json',
      body: {
        type: `${typeBase}internal_error`,
        title: 'Internal error',
        status: 500,
        code: 'internal_error',
        retryable: false,
      },
    };
  }
  const body: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(error.problemExtensions())) {
    if (!STANDARD.has(k) && !NEVER_EMITTED.has(k)) body[k] = withoutValue(v);
  }
  body['type'] = `${typeBase}${error.code}`;
  body['title'] = error.title;
  body['status'] = error.status;
  body['code'] = error.code;
  if (error.field !== undefined) body['field'] = error.field;
  body['retryable'] = error.retryable;
  return {
    status: error.status,
    contentType: 'application/problem+json',
    body: body as unknown as ProblemBody,
  };
}
