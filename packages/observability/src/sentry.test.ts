/**
 * `beforeSend` as a pure function. It has never run inside the Sentry SDK on
 * this machine, and nothing here claims it has.
 */
import { describe, expect, test } from 'vitest';
import {
  SENTRY_ALLOWED_KEYS,
  SentryNotAvailable,
  initSentry,
  scrubEvent,
  sentryConfig,
} from './sentry.ts';
import { RESERVED_ROUTES } from './routes.ts';

const fullEvent = (): Record<string, unknown> => ({
  event_id: 'abc',
  timestamp: 1,
  level: 'error',
  transaction: 'POST /v1/auth/login',
  message: 'login failed for parent@example.cy',
  request: {
    url: 'https://app.kinvara.cy/v1/auth/login?email=parent@example.cy',
    headers: { cookie: 'session=abc', authorization: 'Bearer xyz' },
    data: { email: 'parent@example.cy', password: 'hunter2hunter2' },
  },
  user: { id: '01J0', email: 'parent@example.cy', ip_address: '1.2.3.4' },
  breadcrumbs: [{ message: 'CY17002001280000001200527600' }],
  extra: { iban: 'CY17002001280000001200527600', name: 'Χριστοδούλου' },
  contexts: { device: { name: 'pixel' } },
  server_name: 'core-7f9',
  exception: { values: [{ value: '+35799123456' }] },
  tags: { route: 'POST /v1/auth/login', data_class: 'C2', email: 'parent@example.cy' },
});

describe('the scrubber is an ALLOWLIST: it rebuilds the event, it does not delete from it', () => {
  test('only allowlisted keys survive, and every planted value is absent from the whole result', () => {
    const scrubbed = scrubEvent(fullEvent());
    expect(scrubbed).not.toBeNull();
    const keys = Object.keys(scrubbed as object).sort();
    for (const key of keys) expect(SENTRY_ALLOWED_KEYS).toContain(key);
    const json = JSON.stringify(scrubbed);
    for (const planted of [
      'parent@example.cy',
      'hunter2hunter2',
      'CY17002001280000001200527600',
      'Χριστοδούλου',
      '+35799123456',
      'Bearer xyz',
      'session=abc',
      '1.2.3.4',
      'core-7f9',
      'pixel',
    ]) {
      expect(json, `${planted} survived beforeSend`).not.toContain(planted);
    }
  });

  test('a tag that is not in the tag allowlist is absent', () => {
    const scrubbed = scrubEvent(fullEvent()) as { tags: Record<string, string> };
    expect(Object.keys(scrubbed.tags).sort()).toEqual(['data_class', 'route']);
  });

  test('a transaction that is not a registered route template becomes (unregistered)', () => {
    const scrubbed = scrubEvent({
      transaction: 'POST /v1/accounts/parent@example.cy',
    }) as { transaction: string };
    expect(scrubbed.transaction).toBe(RESERVED_ROUTES.unregistered);
  });

  test('an event on a body-excluded route is dropped whole (SD §SEC-I5, SA §I-3 layer 5)', () => {
    expect(scrubEvent({ transaction: 'POST /arrival', level: 'error' })).toBeNull();
    expect(
      scrubEvent({ transaction: 'GET /v1/admin/sighting-sessions/01J0', level: 'error' }),
    ).toBeNull();
  });

  test('a non-object event is dropped', () => {
    expect(scrubEvent(null)).toBeNull();
    expect(scrubEvent('parent@example.cy')).toBeNull();
    expect(scrubEvent([1, 2])).toBeNull();
  });

  test('a nested allowlisted key carrying an object is dropped, not flattened', () => {
    const scrubbed = scrubEvent({
      transaction: 'GET /healthz',
      level: { nested: 'parent@example.cy' },
    }) as Record<string, unknown>;
    expect(scrubbed['level']).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('parent@example.cy');
  });
});

describe('Sentry is wiring, not a live destination', () => {
  test('an empty DSN yields a config with sendDefaultPii false and both hooks bound', () => {
    const config = initSentry({ SENTRY_DSN: '' });
    expect(config.sendDefaultPii).toBe(false);
    expect(config.beforeSend).toBe(scrubEvent);
    expect(config.beforeSendTransaction).toBe(scrubEvent);
  });

  test('a non-empty DSN is REFUSED — blocked and escalated, not improvised around', () => {
    expect(() => initSentry({ SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' })).toThrow(
      SentryNotAvailable,
    );
    expect(() => initSentry({ SENTRY_DSN: 'anything' })).toThrow(/no Sentry account/);
  });

  test('sentryConfig builds without throwing even when initSentry would refuse', () => {
    expect(sentryConfig({ SENTRY_DSN: 'x' }).dsn).toBe('x');
  });
});
