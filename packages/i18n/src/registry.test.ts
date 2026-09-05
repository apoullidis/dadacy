/**
 * The locale registry client — SA §TS-12.2 rule 5.
 *
 * The property under test is that the locale set behaves like data: it is read
 * from `locale-registry.json`, it is validated at runtime, and there is no
 * function here that will hand you a locale you did not supply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  // `assertLocale` takes no second parameter. If this ever gains one, SE-8 has
  // been quietly reopened one layer below `render()`.
  assert.equal(assertLocale.length, 1);
});
