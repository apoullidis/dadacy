/**
 * The locale registry client — SA §TS-12.2 rule 5.
 *
 * The property under test is that the locale set behaves like data: it is read
 * from `locale-registry.json`, it is validated at runtime, and there is no
 * function here that will hand you a locale you did not supply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allLocales,
  enabledLocales,
  safetyLocales,
  isLocale,
  asLocale,
  assertLocale,
  describeLocale,
  pluralCategories,
  defaultLocale,
} from './registry.ts';

test('the three MVP locales are registered, each named in its own language', () => {
  assert.deepEqual(
    enabledLocales().map((d) => [d.code, d.endonym]),
    [
      ['en', 'English'],
      ['el', 'Ελληνικά'],
      ['ru', 'Русский'],
    ],
  );
  assert.equal(allLocales().length, enabledLocales().length);
});

test('plural categories come from the registry, and Russian has four', () => {
  assert.deepEqual([...pluralCategories(assertLocale('en'))], ['one', 'other']);
  assert.deepEqual([...pluralCategories(assertLocale('el'))], ['one', 'other']);
  assert.deepEqual([...pluralCategories(assertLocale('ru'))], ['one', 'few', 'many', 'other']);
});

test('all three MVP locales are safety languages', () => {
  // A fourth UI locale is cheap; a fourth SAFETY locale needs a lexicon, a
  // red-team and an operator on every shift (SA §TS-12, PM Q14). The flag is
  // where that distinction is stated rather than discovered.
  assert.deepEqual(
    safetyLocales().map((d) => d.code),
    ['en', 'el', 'ru'],
  );
});

test('negative — an unregistered locale is refused, and the message says why', () => {
  for (const bad of ['tr', 'EN', 'en-US', 'ru-RU', '', 'pseudo', null, undefined, 42, {}]) {
    assert.equal(isLocale(bad), false, `${JSON.stringify(bad)} must not be a locale`);
    assert.equal(asLocale(bad), undefined);
    assert.throws(() => assertLocale(bad), RangeError, `assertLocale(${JSON.stringify(bad)})`);
  }
  assert.throws(() => assertLocale('tr'), /is not an enabled locale.*Registered: en, el, ru/s);
});

test('negative — describeLocale refuses a string that never passed the registry', () => {
  // The brand makes this a type error at every honest call site; the runtime
  // check is what holds when a value crosses a boundary the compiler cannot see
  // — a job payload, a database row, a query parameter.
  assert.throws(() => describeLocale('tr' as never), /not registered/);
});

test('the default locale is the LAST step of negotiation, not a fallback argument', () => {
  assert.equal(defaultLocale(), 'en');
});

test('QA-F1 — an extra argument cannot rescue an invalid locale', () => {
  // `Function.length` is NOT a guard here and the earlier version of this test
  // was wrong to imply it was. Measured on Node 24.20.0:
  //
  //   (v, fallback = 'en')  ->  .length === 1
  //   (v, ...rest)          ->  .length === 1
  //   (v)                   ->  .length === 1
  //
  // `length` stops counting at the first default or rest parameter, so an arity
  // assertion passes unchanged through precisely the edit SE-8 exists to forbid.
  // What is asserted instead is the BEHAVIOUR: no extra argument, in any
  // position, can make an unregistered locale resolve to something.
  const sneak = assertLocale as unknown as (...args: unknown[]) => unknown;
  assert.throws(() => sneak('tr', 'en'), RangeError);
  assert.throws(() => sneak('tr', 'en', 'el'), RangeError);
  assert.throws(() => sneak(undefined, 'en'), RangeError);
  assert.throws(() => sneak(null, defaultLocale()), RangeError);

  const sneakAs = asLocale as unknown as (...args: unknown[]) => unknown;
  assert.equal(sneakAs('tr', 'en'), undefined);
  assert.equal(sneakAs(undefined, 'en'), undefined);

  const sneakDescribe = describeLocale as unknown as (...args: unknown[]) => unknown;
  assert.throws(() => sneakDescribe('tr', 'en'), /not registered/);
});

test('QA-F1 — defaultLocale() is called from exactly one place in src/, on the non-strict path', () => {
  // The structural half. A default locale can only leak from a call site, so the
  // guard is on call sites rather than on a signature: `defaultLocale()` is
  // reachable from exactly ONE line of the package's runtime source, and that
  // line is the `operational`/`marketing` fallback branch that SA §TS-12.1
  // permits. A second call site is not necessarily wrong — but it must be a
  // deliberate edit to this test, not an accident.
  const dir = dirname(fileURLToPath(import.meta.url));
  const callSites: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'registry.ts') continue;
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bdefaultLocale\s*\(/.test(line)) callSites.push(`${file}:${String(i + 1)}`);
    });
  }
  assert.deepEqual(
    callSites,
    ['catalogue.ts:82'],
    `defaultLocale() call sites changed: ${JSON.stringify(callSites)}. ` +
      'If this is deliberate, confirm the new site is on a non-strict fallback path and update this assertion.',
  );
});

test('QA-F1 — no ambient locale source is reachable from this package', () => {
  // The other way English leaks in: reading a locale from the environment rather
  // than receiving it. Scanned across the package's runtime source, because a
  // signature check cannot see `process.env.LANG` inside a function body.
  const dir = dirname(fileURLToPath(import.meta.url));
  const banned =
    /process\.env|navigator\.language|resolvedOptions\(\)\.locale|Intl\.getCanonicalLocales/;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = readFileSync(join(dir, file), 'utf8');
    assert.ok(!banned.test(src), `${file} reads a locale from ambient context`);
  }
});
