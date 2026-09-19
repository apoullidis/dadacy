/**
 * T-147 — `NotifyJobBase`, SD §BE-14 lines 1504–1511.
 *
 * EVERY EXPECTATION ABOUT THE LOCALE SET IS READ FROM
 * `packages/i18n/locale-registry.json`, never from a list written here. A list
 * here would agree with the schema while both disagreed with the registry —
 * PROTOCOL §5.1's "a check must not be derived from the same reading as the
 * thing it checks". The registry file is read with `node:fs`, which is neither
 * Zod's reading nor `@kinvara/i18n`'s compiled reading.
 *
 * ANTI-VACUITY: the registry read is asserted non-empty, and the corpus of
 * NON-locales is asserted non-empty after being filtered against the registry,
 * so a registry that grew to contain every candidate cannot silently empty the
 * refusal cases.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isUlid, ulid, type Ulid } from '@kinvara/domain-types';
import { assertLocale, type Locale } from '@kinvara/i18n';
import { describe, expect, test } from 'vitest';
import * as z from 'zod';
import { COMPONENT_SCHEMAS } from './endpoints.ts';
import { LOCALE_REFUSED, LocaleSchema, NotifyJobBase, ULID_REFUSED, UlidSchema } from './jobs.ts';

interface RegistryRow {
  code: string;
  enabled: boolean;
}
interface RegistryFile {
  defaultLocale: string;
  locales: RegistryRow[];
}

const REGISTRY_PATH = fileURLToPath(new URL('../../i18n/locale-registry.json', import.meta.url));
const REGISTRY = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
const ENABLED_CODES: readonly string[] = REGISTRY.locales
  .filter((l) => l.enabled)
  .map((l) => l.code);

/**
 * Candidate strings that a reasonable engineer might hand a locale field. The
 * ones that ARE registered are filtered out, so this list cannot go stale
 * against the registry in the direction that empties a refusal case.
 */
const NON_LOCALE_CANDIDATES = [
  'tr',
  'de',
  'fr',
  'ar',
  'EN',
  'En',
  'en-GB',
  'en_US',
  'zz',
  'und',
  ' en',
];
const UNREGISTERED_CODES = NON_LOCALE_CANDIDATES.filter((c) => !ENABLED_CODES.includes(c));

const A_ULID = '01J9ZC8QW1K2Y3M4N5P6R7S8T9';
const AN_INSTANT = '2026-09-19T20:40:00Z';

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipientAccountId: A_ULID,
    recipientLocale: ENABLED_CODES[0],
    enqueuedAt: AN_INSTANT,
    ...over,
  };
}

/** The issue paths a failed parse reports, as dotted strings. */
function paths(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('the registry reading this file is anchored on', () => {
  test('the registry file yields at least one enabled locale and at least one unregistered candidate', () => {
    expect(ENABLED_CODES.length).toBeGreaterThan(0);
    expect(UNREGISTERED_CODES.length).toBeGreaterThan(0);
    expect(ENABLED_CODES).toContain(REGISTRY.defaultLocale);
  });

  test('every enabled locale in the registry is accepted by LocaleSchema', () => {
    for (const code of ENABLED_CODES) {
      expect(LocaleSchema.safeParse(code), code).toMatchObject({ success: true });
    }
  });

  test('LocaleSchema and assertLocale return the same verdict for every candidate', () => {
    const corpus: unknown[] = [
      ...ENABLED_CODES,
      ...NON_LOCALE_CANDIDATES,
      '',
      null,
      undefined,
      7,
      {},
      [],
    ];
    let agreements = 0;
    for (const value of corpus) {
      let viaAssert: boolean;
      try {
        assertLocale(value);
        viaAssert = true;
      } catch {
        viaAssert = false;
      }
      expect(LocaleSchema.safeParse(value).success, JSON.stringify(value)).toBe(viaAssert);
      agreements += 1;
    }
    expect(agreements).toBe(corpus.length);
  });
});

describe('the control — SD §BE-14 lines 1504-1511, the three fields', () => {
  test('a payload with exactly the three fields parses, and the parsed value equals the input', () => {
    const input = base();
    const parsed = NotifyJobBase.parse(input);
    expect(parsed).toStrictEqual(input);
  });

  test('NotifyJobBase declares exactly the three keys SD names, and no others', () => {
    expect(Object.keys(NotifyJobBase.shape).sort()).toStrictEqual([
      'enqueuedAt',
      'recipientAccountId',
      'recipientLocale',
    ]);
  });
});

describe('recipientLocale — SD §BE-14 line 1507, REQUIRED, no default', () => {
  test('a payload with NO recipientLocale is refused, with the issue at that path', () => {
    const r = NotifyJobBase.safeParse({ recipientAccountId: A_ULID, enqueuedAt: AN_INSTANT });
    expect(r.success).toBe(false);
    expect(paths(r)).toStrictEqual(['recipientLocale']);
  });

  test('recipientLocale null is refused at that path', () => {
    const r = NotifyJobBase.safeParse(base({ recipientLocale: null }));
    expect(r.success).toBe(false);
    expect(paths(r)).toStrictEqual(['recipientLocale']);
  });

  test('recipientLocale the empty string is refused at that path', () => {
    const r = NotifyJobBase.safeParse(base({ recipientLocale: '' }));
    expect(r.success).toBe(false);
    expect(paths(r)).toStrictEqual(['recipientLocale']);
  });

  test('every code assertLocale refuses is refused at that path, by the registry', () => {
    for (const code of UNREGISTERED_CODES) {
      const r = NotifyJobBase.safeParse(base({ recipientLocale: code }));
      expect(r.success, code).toBe(false);
      expect(paths(r), code).toStrictEqual(['recipientLocale']);
    }
  });

  test('the refusal names the rule and never echoes the rejected value', () => {
    const secret = 'kl-SECRET-SUBJECT-CODE';
    const r = NotifyJobBase.safeParse(base({ recipientLocale: secret }));
    expect(r.success).toBe(false);
    const text = JSON.stringify(r.success ? {} : r.error.issues);
    expect(text).toContain(LOCALE_REFUSED);
    expect(text).not.toContain(secret);
  });

  test('a value whose String() throws is refused cleanly, not by throwing out of safeParse', () => {
    const hostile = {
      toString() {
        throw new Error('toString exploded');
      },
    };
    expect(() => LocaleSchema.safeParse(hostile)).not.toThrow();
    expect(LocaleSchema.safeParse(hostile).success).toBe(false);
  });
});

describe('recipientAccountId — SD §BE-14 line 1506, a ULID via the T-023 constructor', () => {
  test('a recipientAccountId that is not a ULID is refused at that path', () => {
    const notUlids = [
      '',
      'not-a-ulid',
      A_ULID.toLowerCase(),
      `${A_ULID}X`,
      A_ULID.slice(1),
      '81J9ZC8QW1K2Y3M4N5P6R7S8T9',
      42,
      null,
    ];
    expect(notUlids.length).toBeGreaterThan(0);
    for (const v of notUlids) {
      const r = NotifyJobBase.safeParse(base({ recipientAccountId: v }));
      expect(r.success, String(v)).toBe(false);
      expect(paths(r), String(v)).toStrictEqual(['recipientAccountId']);
    }
  });

  test('the ULID schema verdict is the domain-types constructor verdict, value for value', () => {
    const corpus: unknown[] = [
      A_ULID,
      '',
      'not-a-ulid',
      A_ULID.toLowerCase(),
      `${A_ULID}X`,
      '81J9ZC8QW1K2Y3M4N5P6R7S8T9',
      42,
      null,
      undefined,
      {},
    ];
    for (const value of corpus) {
      let viaConstructor: boolean;
      try {
        ulid(value, 'probe');
        viaConstructor = true;
      } catch {
        viaConstructor = false;
      }
      expect(UlidSchema.safeParse(value).success, JSON.stringify(value)).toBe(viaConstructor);
      expect(isUlid(value)).toBe(viaConstructor);
    }
  });

  test('the ULID refusal never echoes the rejected identifier', () => {
    const secret = '01SECRETACCOUNTIDENTIFIER9';
    const r = NotifyJobBase.safeParse(base({ recipientAccountId: `${secret}!` }));
    expect(r.success).toBe(false);
    const text = JSON.stringify(r.success ? {} : r.error.issues);
    expect(text).toContain(ULID_REFUSED);
    expect(text).not.toContain(secret);
  });
});

describe('enqueuedAt — SD §BE-14 line 1510', () => {
  test('enqueuedAt that is not an ISO datetime is refused at that path', () => {
    for (const v of ['', 'yesterday', '2026-09-19', '19/09/2026', 1758312000000, null]) {
      const r = NotifyJobBase.safeParse(base({ enqueuedAt: v }));
      expect(r.success, String(v)).toBe(false);
      expect(paths(r), String(v)).toStrictEqual(['enqueuedAt']);
    }
  });

  test('enqueuedAt accepts only a Z-terminated ISO datetime', () => {
    expect(NotifyJobBase.safeParse(base({ enqueuedAt: '2026-09-19T20:40:00Z' })).success).toBe(
      true,
    );
    expect(NotifyJobBase.safeParse(base({ enqueuedAt: '2026-09-19T20:40:00.123Z' })).success).toBe(
      true,
    );
    expect(NotifyJobBase.safeParse(base({ enqueuedAt: '2026-09-19T20:40:00+02:00' })).success).toBe(
      false,
    );
  });
});

describe('unknown keys — strictObject, not object', () => {
  test('an unknown key is REFUSED, not stripped', () => {
    const r = NotifyJobBase.safeParse(base({ recipientPhone: '+35799123456' }));
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.code)).toContain('unrecognized_keys');
  });
});

describe('SD line 1504 — every notify-bearing payload EXTENDS this base', () => {
  const Extended = NotifyJobBase.extend({ templateId: z.string().min(1) });

  test('an extension of NotifyJobBase accepts a well-formed extended payload', () => {
    expect(Extended.safeParse(base({ templateId: 'notify.session.started' })).success).toBe(true);
  });

  test('an extension of NotifyJobBase still refuses an unknown key', () => {
    const r = Extended.safeParse(base({ templateId: 'notify.session.started', smuggled: 1 }));
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.code)).toContain('unrecognized_keys');
  });

  test('an extension of NotifyJobBase still requires recipientLocale', () => {
    const r = Extended.safeParse({
      recipientAccountId: A_ULID,
      enqueuedAt: AN_INSTANT,
      templateId: 'notify.session.started',
    });
    expect(r.success).toBe(false);
    expect(paths(r)).toStrictEqual(['recipientLocale']);
  });

  test('an extension of NotifyJobBase still refuses an unregistered recipientLocale', () => {
    const code = UNREGISTERED_CODES[0];
    const r = Extended.safeParse(base({ templateId: 'x', recipientLocale: code }));
    expect(r.success).toBe(false);
    expect(paths(r)).toStrictEqual(['recipientLocale']);
  });
});

describe('the HTTP surface does not move', () => {
  test('jobs.ts is absent from the OpenAPI document: a queue payload is not an HTTP wire type', () => {
    const names = Object.keys(COMPONENT_SCHEMAS);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(COMPONENT_SCHEMAS[n]).not.toBe(NotifyJobBase);
      expect(COMPONENT_SCHEMAS[n]).not.toBe(LocaleSchema);
      expect(COMPONENT_SCHEMAS[n]).not.toBe(UlidSchema);
    }
    expect(names).not.toContain('NotifyJobBase');
  });
});

describe('the claims jobs.ts makes about this file', () => {
  const JOBS_PATH = fileURLToPath(new URL('./jobs.ts', import.meta.url));
  const JOBS_SOURCE = readFileSync(JOBS_PATH, 'utf8');
  const TEST_SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8');

  /**
   * Every emphasised single-line span in jobs.ts that is not a spec quotation
   * (those begin with a double quote) is a CITATION of a test in this file.
   * PROTOCOL §5.1: "every sentence in a contract must name the test that would
   * fail if it were false" — a citation naming a test that does not exist is
   * the failure mode this programme has hit five times, so it is checked by a
   * test rather than by care.
   */
  const citations = [...JOBS_SOURCE.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
    .map((block) =>
      (block[1] ?? '')
        .replace(/^[ \t]*\*[ \t]?/gm, '')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\*\*[^*]*\*\*/g, '')
        .replace(/\*"[^*]*"\*/g, ''),
    )
    .flatMap((text) => [...text.matchAll(/\*([^*"]+?)\*/g)])
    .map((m) => (m[1] ?? '').trim())
    .filter((s) => s.length > 12);

  const declaredTitles = new Set(
    [...TEST_SOURCE.matchAll(/^\s*test\('((?:[^'\\]|\\.)*)',/gm)].map((m) => m[1] ?? ''),
  );

  test('every test jobs.ts cites by title exists in this file, and there are at least six', () => {
    expect(declaredTitles.size).toBeGreaterThan(0);
    expect(citations.length).toBeGreaterThanOrEqual(6);
    const missing = citations.filter((c) => !declaredTitles.has(c));
    expect(missing).toStrictEqual([]);
  });
});

describe('what this ticket does NOT solve — SD §BE-14 lines 1525-1532 (OD-90 G2)', () => {
  test('LIMITATION: a recipient with no account cannot be expressed, because recipientAccountId is required', () => {
    // The four recipients SD names at 1525-1532 — a trusted contact on
    // /share/{token}, a referee, an out-of-hours INT-10 caller, an SMS to a
    // number with no account — have a stated LOCALE SOURCE and no stated
    // payload shape. SD line 1506 makes recipientAccountId required, so this
    // base cannot describe them. That is disclosed, not solved (PROTOCOL §2).
    // This case goes RED the day someone makes recipientAccountId optional or
    // widens it into a union, which is the signal that G2 was answered by an
    // invention rather than a ruling.
    const r = NotifyJobBase.safeParse({
      recipientLocale: ENABLED_CODES[0],
      enqueuedAt: AN_INSTANT,
    });
    expect(r.success).toBe(false);
    expect(paths(r)).toStrictEqual(['recipientAccountId']);
  });
});

/** Typed, so the branded input types are exercised by the typecheck too. */
const typedPayload: { recipientAccountId: Ulid; recipientLocale: Locale; enqueuedAt: string } = {
  recipientAccountId: ulid(A_ULID, 'recipientAccountId'),
  recipientLocale: assertLocale(ENABLED_CODES[0]),
  enqueuedAt: AN_INSTANT,
};

describe('the branded input types', () => {
  test('a payload built from the branded constructors parses', () => {
    expect(NotifyJobBase.parse(typedPayload)).toStrictEqual(typedPayload);
  });
});
