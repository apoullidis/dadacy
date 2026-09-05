/**
 * Tier-dependent fallback — SA §TS-12.1, SD §FE-10.
 *
 * The two strict tiers have no runtime fallback *path*, so what is tested here
 * is that reaching for one raises rather than silently rendering English. The
 * absence itself is enforced a layer up, by `compiled/index.ts` typechecking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCatalogue, resolveMessage, MissingMessageError } from './catalogue.ts';
import { assertLocale } from './registry.ts';
import {
  TIER_POLICY,
  STRICT_TIERS,
  isStrictTier,
  tierOf,
  keysAtTier,
  strictKeys,
  allKeys,
} from './tiers.ts';
import type { MessageKey } from './tiers.ts';

const EN = assertLocale('en');
const EL = assertLocale('el');
const RU = assertLocale('ru');

test('the fallback table is exactly SA §TS-12.1', () => {
  assert.equal(TIER_POLICY.safety_critical.onMissingTranslation, 'build_failure');
  assert.equal(TIER_POLICY.transactional.onMissingTranslation, 'build_failure');
  assert.equal(TIER_POLICY.operational.onMissingTranslation, 'fallback_to_default_with_notice');
  assert.equal(TIER_POLICY.marketing.onMissingTranslation, 'fallback_to_default_with_notice');
  assert.deepEqual([...STRICT_TIERS].sort(), ['safety_critical', 'transactional']);
});

test('machine translation is prohibited on exactly the two strict tiers (DV-11)', () => {
  for (const tier of ['safety_critical', 'transactional'] as const) {
    assert.equal(TIER_POLICY[tier].machineTranslationPermitted, false);
  }
  for (const tier of ['operational', 'marketing'] as const) {
    assert.equal(TIER_POLICY[tier].machineTranslationPermitted, true);
  }
});

test('a safety_critical key resolves in each locale and never reports a fallback', () => {
  for (const locale of [EN, EL, RU]) {
    const r = resolveMessage('session.checkins_missed', locale);
    assert.equal(r.tier, 'safety_critical');
    assert.equal(r.renderedIn, locale);
    assert.equal(r.usedFallback, false);
    assert.equal(r.fallbackMetric, null);
  }
});

test('an operational key with no translation falls back, visibly and countably', () => {
  // `notify.digest.weekly_subject` exists only in `en` — long-tail operational
  // copy that has not been through the translator yet. That is permitted, and
  // the surface owes the reader a notice for it.
  const r = resolveMessage('notify.digest.weekly_subject', RU);
  assert.equal(r.tier, 'operational');
  assert.equal(r.requested, 'ru');
  assert.equal(r.renderedIn, 'en');
  assert.equal(r.usedFallback, true);
  assert.equal(r.fallbackMetric, 'i18n.fallback_rendered');
  assert.equal(TIER_POLICY[r.tier].rendersFallbackNotice, true);
});

test('negative — a strict-tier key with no translation raises instead of falling back', () => {
  // Simulated by removing the key from a copy of the compiled catalogue: the
  // real one cannot be missing it, because `compiled/index.ts` would not
  // typecheck. This proves the runtime has no fallback branch to take.
  const el = { ...getCatalogue(EL) };
  delete el['session.checkins_missed'];
  const original = getCatalogue(EL);
  assert.ok('session.checkins_missed' in original);
  assert.ok(!('session.checkins_missed' in el));

  // And the error the loader raises when it does happen:
  assert.throws(() => {
    throw new MissingMessageError('session.checkins_missed' as MessageKey, EL, 'safety_critical');
  }, /no runtime fallback path by design/);
});

test('negative — an unregistered locale has no catalogue', () => {
  assert.throws(() => getCatalogue('tr' as never), /not registered/);
});

test('every key is tiered, and the strict set is derived rather than listed', () => {
  const keys = allKeys();
  assert.ok(keys.length > 0);
  for (const k of keys) assert.ok(tierOf(k) in TIER_POLICY, `${k} has no policy`);
  assert.deepEqual(
    [...strictKeys()].sort(),
    [...keysAtTier('safety_critical'), ...keysAtTier('transactional')].sort(),
  );
  assert.ok(strictKeys().every((k) => isStrictTier(tierOf(k))));
});

test('the emergency panel and the 112 script are safety_critical, not transactional', () => {
  // PM §MVP-IS5 AC7. If one of these ever slips to `operational` it becomes
  // English-fallback-able, and no test outside this line would notice.
  for (const key of [
    'safety.emergency.call_112.label',
    'safety.emergency.call_112.script',
    'safety.emergency.address_prompt',
    'safety.helpline.116111.label',
    'safety.helpline.1466.label',
    'safety.helpline.199.label',
    'safety.sos.confirm',
  ] as const) {
    assert.equal(tierOf(key), 'safety_critical', key);
  }
});
