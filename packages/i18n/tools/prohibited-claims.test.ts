/**
 * `gate:prohibited-claims` — T-043, attacked rather than observed passing.
 *
 * Every NEGATIVE case copies this package's real inputs (`catalogues/`,
 * `prohibited/`, `locale-registry.json`) into a temporary root, PLANTS one
 * defect, ASSERTS THE PLANT LANDED by reading the file back, runs the real
 * gate script as a subprocess with `--root`, and judges it on three readings a
 * gate that did nothing could not all produce: the exit status, exactly one
 * `GATE PASS` / `GATE FAIL` banner (so a crash is a third outcome and never
 * counts as a refusal — PROTOCOL §5.1), and the expected reason substring.
 * `--root` changes WHERE the gate reads, not WHAT it reads: this gate has no
 * reading that a temporary root cannot host (it reads no `compiled/`), so
 * every refusal is demonstrable here and runs on every PR through
 * `gate:unit-tests`.
 *
 * The phrases in the `independent` cases are WRITTEN HERE, with explicit code
 * points where the difference is invisible, not read from a list — so the
 * lists and the fold are checked against something outside themselves.
 *
 * T-132 § Published contract (rework 2) §2's convention holds in this file:
 * every title is a string literal and every `test(` starts its own line.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SCRIPT = join(PKG, 'tools', 'prohibited-claims.ts');
const T = 120_000;

/** PM §MVP-IS9 AC6 and §MVP-S8 AC5, written here independently of the gate. */
const PM_CLAIMS: readonly string[] = [
  '24/7 support',
  '24/7 staffed',
  'always on',
  'round-the-clock team',
  'someone is always watching',
  'continuously monitored',
  'live monitoring',
  'real-time checks',
  'always up to date',
  'we check daily/weekly',
];
/** The model OE-66 names, spelled as T-233's register spells it. */
const MODEL = 'Claude Opus (claude-opus-5-5), AI agent';

interface GateRun {
  readonly code: number;
  readonly out: string;
  readonly banner: 'PASS' | 'FAIL' | 'NONE' | 'BOTH';
}

function runGate(args: readonly string[]): GateRun {
  const r = spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const pass = (out.match(/^GATE PASS {2}gate:prohibited-claims/gm) ?? []).length;
  const fail = (out.match(/^GATE FAIL {2}gate:prohibited-claims/gm) ?? []).length;
  let banner: GateRun['banner'] = 'NONE';
  if (pass + fail > 1) banner = 'BOTH';
  else if (pass === 1) banner = 'PASS';
  else if (fail === 1) banner = 'FAIL';
  return { code: r.status ?? -1, out, banner };
}

/** A fresh copy of the real inputs. */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 't043-'));
  cpSync(join(PKG, 'catalogues'), join(root, 'catalogues'), { recursive: true });
  cpSync(join(PKG, 'prohibited'), join(root, 'prohibited'), { recursive: true });
  cpSync(join(PKG, 'locale-registry.json'), join(root, 'locale-registry.json'));
  return root;
}

function readDoc(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Writes a JSON edit and asserts it landed by reading it back. */
function plantJson(path: string, mutate: (d: Record<string, unknown>) => void): void {
  const doc = readDoc(path);
  mutate(doc);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  writeFileSync(path, text);
  assert.equal(readFileSync(path, 'utf8'), text, `plant did not land in ${path}`);
}

/** Plants `value` as catalogues/<locale>/<file>'s <key>, then runs the gate. */
function withString(locale: string, file: string, key: string, value: string): GateRun {
  const root = freshRoot();
  try {
    const path = join(root, 'catalogues', locale, file);
    plantJson(path, (d) => {
      d[key] = value;
    });
    assert.equal(readDoc(path)[key], value);
    return runGate(['--root', root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Mutates prohibited/<locale>.json (or deletes it when `mutate` is null), then runs the gate. */
function withList(locale: string, mutate: ((d: Record<string, unknown>) => void) | null): GateRun {
  const root = freshRoot();
  try {
    const path = join(root, 'prohibited', `${locale}.json`);
    if (mutate === null) {
      rmSync(path);
      assert.equal(existsSync(path), false, 'the delete did not land');
    } else {
      plantJson(path, mutate);
    }
    return runGate(['--root', root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function banned(d: Record<string, unknown>): { claim: string; phrases: unknown[] }[] {
  return d['banned'] as { claim: string; phrases: unknown[] }[];
}

/** The list entry for `claim`, asserted present. */
function entryFor(
  d: Record<string, unknown>,
  claim: string,
): { claim: string; phrases: unknown[] } {
  const e = banned(d).find((b) => b.claim === claim);
  assert.ok(e !== undefined, `no entry for ${claim}`);
  return e;
}

function expectFail(run: GateRun, label: string, ...reasons: readonly (string | RegExp)[]): void {
  assert.equal(run.banner, 'FAIL', `${label}: expected one GATE FAIL banner\n${run.out}`);
  assert.equal(run.code, 1, `${label}: exit status\n${run.out}`);
  assert.doesNotMatch(run.out, /CRASH/, `${label}: a crash is not a refusal\n${run.out}`);
  for (const r of reasons) {
    const hit = typeof r === 'string' ? run.out.includes(r) : r.test(run.out);
    assert.ok(hit, `${label}: missing reason ${String(r)}\n${run.out}`);
  }
}

function expectPass(run: GateRun, label: string): void {
  assert.equal(run.banner, 'PASS', `${label}: expected one GATE PASS banner\n${run.out}`);
  assert.equal(run.code, 0, `${label}: exit status\n${run.out}`);
}

/** Strings in catalogues/<locale>/, counted here (top-level `//` excluded), not by the gate. */
function countStrings(root: string, locale: string): number {
  let n = 0;
  for (const f of readdirSync(join(root, 'catalogues', locale))) {
    if (!f.endsWith('.json')) continue;
    for (const [k, v] of Object.entries(readDoc(join(root, 'catalogues', locale, f)))) {
      if (k !== '//' && typeof v === 'string') n += 1;
    }
  }
  return n;
}

/* ---------------------------------------------------------------- controls */

test(
  'CONTROL — the committed package passes, and scans the string count computed here',
  () => {
    const run = runGate([]);
    expectPass(run, 'committed package');
    assert.match(run.out, /^GATE PASS {2}gate:prohibited-claims$/m, 'no --root in the real banner');
    let total = 0;
    for (const locale of ['en', 'el', 'ru']) {
      const n = countStrings(PKG, locale);
      assert.ok(n > 0);
      total += n;
      assert.ok(
        run.out.includes(`scanned catalogues/${locale}/: ${String(n)} string(s)`),
        `${locale}: ${String(n)}\n${run.out}`,
      );
    }
    assert.ok(run.out.includes(`scanned ${String(total)} string(s)`), run.out);
  },
  T,
);

test(
  'CONTROL — an unmodified copy passes, and the banner names the root',
  () => {
    const root = freshRoot();
    try {
      const run = runGate(['--root', root]);
      expectPass(run, 'unmodified copy');
      assert.ok(run.out.includes(`GATE PASS  gate:prohibited-claims  [--root ${root}]`), run.out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  T,
);

test('CONTROL — each list carries exactly the ten PM claims, as written in this file', () => {
  for (const locale of ['el', 'ru']) {
    const d = readDoc(join(PKG, 'prohibited', `${locale}.json`));
    assert.deepEqual(
      banned(d)
        .map((b) => b.claim)
        .sort(),
      [...PM_CLAIMS].sort(),
      locale,
    );
  }
});

/* ------------------------------------- the acceptance criterion: per locale */

test(
  'NEGATIVE — every PM claim planted in an en string is refused, claim by claim',
  () => {
    for (const claim of PM_CLAIMS) {
      const phrase = claim === 'we check daily/weekly' ? 'we check weekly' : claim;
      const run = withString('en', 'common.json', 'app.name', `Kinvara: ${phrase}.`);
      expectFail(
        run,
        `en ${claim}`,
        `PROHIBITED en/common.app.name contains ${JSON.stringify(phrase)} — claim ${JSON.stringify(claim)}, from PM (en)`,
      );
    }
  },
  T,
);

test(
  'NEGATIVE — every el claim planted in an el string is refused, claim by claim',
  () => {
    const d = readDoc(join(PKG, 'prohibited', 'el.json'));
    assert.equal(banned(d).length, PM_CLAIMS.length);
    for (const { claim, phrases } of banned(d)) {
      const phrase = String(phrases[0]);
      const run = withString('el', 'common.json', 'app.name', `Kinvara: ${phrase}.`);
      expectFail(
        run,
        `el ${claim}`,
        `PROHIBITED el/common.app.name contains ${JSON.stringify(phrase)} — claim ${JSON.stringify(claim)}, from prohibited/el.json`,
      );
    }
  },
  T,
);

test(
  'NEGATIVE — every ru claim planted in a ru string is refused, claim by claim',
  () => {
    const d = readDoc(join(PKG, 'prohibited', 'ru.json'));
    assert.equal(banned(d).length, PM_CLAIMS.length);
    for (const { claim, phrases } of banned(d)) {
      const phrase = String(phrases[0]);
      const run = withString('ru', 'common.json', 'app.name', `Kinvara: ${phrase}.`);
      expectFail(
        run,
        `ru ${claim}`,
        `PROHIBITED ru/common.app.name contains ${JSON.stringify(phrase)} — claim ${JSON.stringify(claim)}, from prohibited/ru.json`,
      );
    }
  },
  T,
);

test(
  'NEGATIVE — escrow (SA DV-3) is refused in each of the three languages',
  () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['en', 'Payments are held in Escrow.', '"escrow"'],
      ['el', 'Η πληρωμή μένει σε λογαριασμό μεσεγγύησης.', '"μεσεγγύηση"'],
      ['ru', 'Оплата хранится на эскроу-счёте.', '"эскроу"'],
    ];
    for (const [locale, text, phrase] of cases) {
      expectFail(
        withString(locale, 'common.json', 'app.name', text),
        `escrow ${locale}`,
        `PROHIBITED ${locale}/common.app.name contains ${phrase} — claim "escrow (SA DV-3)", from SD (DV-3)`,
      );
    }
  },
  T,
);

/* ----------------------------- independent phrases and the fold, attacked */

test(
  'NEGATIVE — phrases written here, in forms a list does not spell, are refused',
  () => {
    const cases: readonly (readonly [string, string, string, RegExp])[] = [
      // Greek: capitals without tonos, decomposed tonos, the wrong sigma form.
      [
        'el',
        'capitals, no tonos',
        'ΣΥΝΕΧΗΣ ΠΑΡΑΚΟΛΟΥΘΗΣΗ ΣΤΟ ΣΠΙΤΙ',
        /claim "continuously monitored", from prohibited\/el\.json/,
      ],
      [
        'el',
        'NFD tonos',
        'συνεχη\u0301ς παρακολου\u0301θηση',
        /claim "continuously monitored", from prohibited\/el\.json/,
      ],
      [
        'el',
        'medial sigma at the end',
        'συνεχησ παρακολουθηση',
        /claim "continuously monitored", from prohibited\/el\.json/,
      ],
      // OD-256: bare 24/7 in Greek copy, matched by the EL list's own entry.
      [
        'el',
        'bare 24/7 (OD-256)',
        'Γραμμή 24/7 για γονείς',
        /contains "24\/7" — claim "24\/7 support", from prohibited\/el\.json/,
      ],
      // Russian: capitals, ё spelled out, and an honest negation (no allow-list).
      [
        'ru',
        'capitals',
        'КРУГЛОСУТОЧНАЯ ПОДДЕРЖКА',
        /contains "круглосуточная поддержка" — claim "24\/7 support", from prohibited\/ru\.json/,
      ],
      [
        'ru',
        'е where the list spells ё',
        'Профиль всегда обновлен',
        /contains "всегда обновлён" — claim "always up to date", from prohibited\/ru\.json/,
      ],
      [
        'ru',
        'honest negation is still flagged',
        'Мы не работаем круглосуточно.',
        /contains "работаем круглосуточно" — claim "24\/7 staffed"/,
      ],
      // English: invisible and compatibility characters inside a phrase.
      ['en', 'NBSP', '24/7\u00A0Support for parents', /contains "24\/7 support"/],
      ['en', 'zero-width space', '24/\u200B7 support', /contains "24\/7 support"/],
      ['en', 'BOM', 'always\uFEFF on', /contains "always on"/],
      ['en', 'fullwidth digits', '\uFF12\uFF14/\uFF17 support', /contains "24\/7 support"/],
      [
        'en',
        'non-breaking hyphens',
        'Our round\u2011the\u2011clock team',
        /contains "round-the-clock team"/,
      ],
      [
        'en',
        'bare round-the-clock (SA §TS-12.3)',
        'Help, round-the-clock',
        /contains "round-the-clock" — claim "round-the-clock team"/,
      ],
    ];
    for (const [locale, label, text, expected] of cases) {
      expectFail(
        withString(locale, 'common.json', 'app.name', text),
        `${locale} ${label}`,
        expected,
      );
    }
  },
  T,
);

test(
  'NEGATIVE — a marketing-tier string is scanned like a safety one',
  () => {
    expectFail(
      withString('en', 'common.json', 'marketing.tagline', 'Childcare in Cyprus, always on.'),
      'tagline',
      'PROHIBITED en/common.marketing.tagline contains "always on"',
    );
  },
  T,
);

/* ------------------------------------------------- fail closed on the lists */

test(
  'NEGATIVE — CONTRACTS obligation: deleting prohibited/ru.json or el.json fails closed',
  () => {
    for (const locale of ['ru', 'el']) {
      const run = withList(locale, null);
      expectFail(run, `delete ${locale}`, `ABSENT-LIST prohibited/${locale}.json does not exist`);
    }
  },
  T,
);

test(
  'NEGATIVE — a list gutted, short a claim, or with an empty claim or phrase is refused',
  () => {
    const gutted = withList('ru', (d) => {
      d['banned'] = [];
    });
    expectFail(
      gutted,
      'gutted',
      'MISSING-CLAIM prohibited/ru.json has no entry for "24/7 support"',
    );
    assert.equal((gutted.out.match(/MISSING-CLAIM/g) ?? []).length, 10, gutted.out);

    expectFail(
      withList('el', (d) => {
        d['banned'] = banned(d).filter((b) => b.claim !== 'live monitoring');
      }),
      'one claim removed',
      'MISSING-CLAIM prohibited/el.json has no entry for "live monitoring"',
    );
    expectFail(
      withList('el', (d) => {
        entryFor(d, '24/7 support').phrases = [];
      }),
      'empty claim',
      'EMPTY-CLAIM prohibited/el.json "24/7 support" has no phrases',
    );
    expectFail(
      withList('ru', (d) => {
        entryFor(d, '24/7 staffed').phrases.push('\u200B \u00A0');
      }),
      'invisible phrase',
      /EMPTY-PHRASE prohibited\/ru\.json "24\/7 staffed" phrases\[\d+\]/,
    );
    expectFail(
      withList('ru', (d) => {
        banned(d).push({ claim: 'cheap', phrases: ['дёшево'] });
      }),
      'unknown claim',
      'UNKNOWN-CLAIM prohibited/ru.json',
    );
    expectFail(
      withList('ru', (d) => {
        banned(d).push({ claim: 'always on', phrases: ['всегда онлайн'] });
      }),
      'duplicate claim',
      'DUPLICATE-CLAIM prohibited/ru.json lists "always on" twice',
    );
  },
  T,
);

test(
  'NEGATIVE — a list that is not JSON, not an object, or for another locale is refused',
  () => {
    const root = freshRoot();
    try {
      writeFileSync(join(root, 'prohibited', 'ru.json'), '{ "locale": "ru", ');
      expectFail(
        runGate(['--root', root]),
        'not JSON',
        'MALFORMED-LIST prohibited/ru.json is not valid JSON',
      );
      writeFileSync(join(root, 'prohibited', 'ru.json'), '[]\n');
      expectFail(
        runGate(['--root', root]),
        'array',
        'MALFORMED-LIST prohibited/ru.json is not a JSON object',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expectFail(
      withList('ru', (d) => {
        d['locale'] = 'el';
      }),
      'wrong locale',
      'LOCALE-MISMATCH prohibited/ru.json declares locale "el"',
    );
  },
  T,
);

test(
  'NEGATIVE — authorship: the list must cite OE-66 and name exactly the model it names',
  () => {
    expectFail(
      withList('el', (d) => {
        delete d['ruling'];
      }),
      'no ruling',
      'UNRULED-AUTHOR prohibited/el.json: provenance "ai_authored", ruling undefined',
    );
    expectFail(
      withList('el', (d) => {
        d['ruling'] = 'OE-67';
      }),
      'OE-67 is not a list ruling',
      'UNRULED-AUTHOR prohibited/el.json cites "OE-67"',
    );
    expectFail(
      withList('ru', (d) => {
        d['provenance'] = 'authored';
        d['authored_by'] = 'Maria Georgiou';
      }),
      'a human author',
      'UNRULED-AUTHOR prohibited/ru.json: provenance "authored"',
    );
    const nearMisses: readonly (readonly [string, string])[] = [
      ['a human name', 'Maria Georgiou'],
      ['the pre-T-043 suffixed string', `${MODEL}, under stakeholder ruling OE-66`],
      ['trailing space', `${MODEL} `],
      ['another version', 'Claude Opus (claude-opus-4-1), AI agent'],
      ['Cyrillic \u0421 (U+0421)', `\u0421${MODEL.slice(1)}`],
      ['zero-width space', `Claude\u200B Opus (claude-opus-5-5), AI agent`],
      ['NBSP', 'Claude\u00A0Opus (claude-opus-5-5), AI agent'],
      ['fullwidth parenthesis', 'Claude Opus \uFF08claude-opus-5-5), AI agent'],
    ];
    for (const [label, name] of nearMisses) {
      assert.notEqual(name, MODEL, label);
      expectFail(
        withList('ru', (d) => {
          d['authored_by'] = name;
        }),
        label,
        `WRONG-AUTHOR prohibited/ru.json: authored_by is ${JSON.stringify(name)}, not the model OE-66 names`,
      );
    }
  },
  T,
);

test(
  'NEGATIVE — a list that records or claims a review is refused (OE-5, EV-16)',
  () => {
    const claims: readonly (readonly [string, unknown])[] = [
      ['reviewed_by', 'A. Person, DSL'],
      ['reviewed_at', '2026-10-01T09:00:00Z'],
      ['review_date', '2026-10-01'],
    ];
    for (const [field, value] of claims) {
      expectFail(
        withList('el', (d) => {
          d[field] = value;
        }),
        field,
        `CLAIMS-REVIEW prohibited/el.json: '${field}' is ${JSON.stringify(value)}`,
      );
    }
    // …and `null`, which claims nothing, is not a claim.
    expectPass(
      withList('el', (d) => {
        d['reviewed_by'] = null;
      }),
      'reviewed_by null',
    );
  },
  T,
);

test(
  'NEGATIVE — a phrase that bans a permitted claim, or a wrong permitted set, is refused',
  () => {
    expectFail(
      withList('el', (d) => {
        entryFor(d, 'we check daily/weekly').phrases.push('every 12 months');
      }),
      'bans an en permitted claim',
      'BANS-PERMITTED prohibited/el.json phrase "every 12 months" (claim "we check daily/weekly") matches the permitted claim "Re-verified every 12 months"',
    );
    expectFail(
      withList('ru', (d) => {
        entryFor(d, 'we check daily/weekly').phrases.push('повторная проверка');
      }),
      'bans the list’s own rendering',
      'BANS-PERMITTED prohibited/ru.json phrase "повторная проверка"',
    );
    expectFail(
      withList('ru', (d) => {
        (d['permitted'] as unknown[]).pop();
      }),
      'a permitted claim dropped',
      'PERMITTED-SET prohibited/ru.json',
    );
  },
  T,
);

/* ---------------------------------------------- fail closed on the corpus */

test(
  'NEGATIVE — a fourth enabled locale with no list fails closed',
  () => {
    const root = freshRoot();
    try {
      plantJson(join(root, 'locale-registry.json'), (d) => {
        (d['locales'] as unknown[]).push({
          code: 'tr',
          endonym: 'Türkçe',
          direction: 'ltr',
          isSafetyLanguage: false,
          pluralCategories: ['one', 'other'],
          enabled: true,
        });
      });
      mkdirSync(join(root, 'catalogues', 'tr'));
      writeFileSync(join(root, 'catalogues', 'tr', 'common.json'), '{ "app.name": "Kinvara" }\n');
      expectFail(runGate(['--root', root]), 'tr', 'ABSENT-LIST prohibited/tr.json does not exist');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  T,
);

test(
  'NEGATIVE — an enabled locale with no catalogue, or no registry, is refused, not scanned as empty',
  () => {
    const root = freshRoot();
    try {
      rmSync(join(root, 'catalogues', 'ru'), { recursive: true });
      assert.equal(existsSync(join(root, 'catalogues', 'ru')), false);
      expectFail(
        runGate(['--root', root]),
        'no ru catalogue',
        'MISSING-CATALOGUE catalogues/ru/ does not exist',
      );
      rmSync(join(root, 'locale-registry.json'));
      expectFail(
        runGate(['--root', root]),
        'no registry',
        'INPUT locale-registry.json could not be read',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const only = freshRoot();
    try {
      plantJson(join(only, 'locale-registry.json'), (d) => {
        for (const row of d['locales'] as Record<string, unknown>[])
          row['enabled'] = row['code'] === 'en';
      });
      expectFail(runGate(['--root', only]), 'en only', 'NO-COMPARISON the registry enables [en]');
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  },
  T,
);

test('NEGATIVE — an unrecognised argument exits 2 with no banner', () => {
  const run = runGate(['--locale', 'ru']);
  assert.equal(run.code, 2, run.out);
  assert.equal(run.banner, 'NONE', run.out);
});

/* ------------------------------------------------ bounds, asserted as such */

test(
  'BOUND — what this gate does NOT catch, asserted so the contract stays true',
  () => {
    // The `//` comment key is not copy and is not scanned.
    expectPass(withString('en', 'common.json', '//', 'never write "24/7 support"'), '// comment');
    // A phrase split by an ICU argument is invisible to substring matching.
    expectPass(
      withString('en', 'common.json', 'app.name', 'Kinvara is always {state}.'),
      'ICU-split phrase',
    );
    // Greeklish (Latin-script Greek) is not folded: SD routes it through
    // packages/text-normalise (T-065), which does not exist yet.
    expectPass(withString('el', 'common.json', 'app.name', 'synexis parakolouthisi'), 'Greeklish');
    // The OE-69 tagline's old wording is an unbounded staffing claim, but not a
    // listed phrase: this gate would NOT have caught it.
    expectPass(
      withString(
        'en',
        'common.json',
        'marketing.tagline',
        'Childcare in Cyprus, with a safeguarding operator on shift.',
      ),
      'old tagline',
    );
  },
  T,
);
