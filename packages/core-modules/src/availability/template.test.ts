/**
 * E.3 U-2's ETag and the template input rules (C7 (a), C9 (b)). The ETag's expected value is
 * computed by the host (`printf '…' | sha256sum`), pasted in § Implementation › U1.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TemplateReplaceInput, templateEtag } from './template.ts';

test('ETag of the empty set is the quoted SHA-256 of the empty string (host: e3b0c442…b855)', () => {
  assert.equal(
    templateEtag([]),
    '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
  );
});

test('ETag: id:version lines sorted by id, joined by \\n (host: printf "01A:2\\n01B:1" | sha256sum)', () => {
  const expected = '"c5410d49af1708e9628b88201380a255c32979eff0ab80332c002d9e665e47a7"';
  assert.equal(
    templateEtag([
      { id: '01B', version: 1 },
      { id: '01A', version: 2 },
    ]),
    expected,
  );
  assert.notEqual(
    templateEtag([
      { id: '01B', version: 2 },
      { id: '01A', version: 2 },
    ]),
    expected,
    'a version change changes the ETag',
  );
});

test('template input: 24:00 end accepted (C7 (a)); a block crossing midnight, end <= start, weekday 7, HH:MM:SS refused', () => {
  const body = (blocks: unknown[]) => ({
    blocks,
    effectiveFrom: '2026-11-01',
    tz: 'Europe/Nicosia',
  });
  assert.equal(
    TemplateReplaceInput.safeParse(
      body([
        { weekday: 4, startLocal: '19:00', endLocal: '24:00' },
        { weekday: 5, startLocal: '00:00', endLocal: '01:00' },
      ]),
    ).success,
    true,
  );
  assert.equal(
    TemplateReplaceInput.safeParse(body([{ weekday: 4, startLocal: '19:00', endLocal: '01:00' }]))
      .success,
    false,
  );
  assert.equal(
    TemplateReplaceInput.safeParse(body([{ weekday: 4, startLocal: '19:00', endLocal: '19:00' }]))
      .success,
    false,
  );
  assert.equal(
    TemplateReplaceInput.safeParse(body([{ weekday: 7, startLocal: '10:00', endLocal: '11:00' }]))
      .success,
    false,
  );
  assert.equal(
    TemplateReplaceInput.safeParse(
      body([{ weekday: 1, startLocal: '10:00:00', endLocal: '11:00' }]),
    ).success,
    false,
  );
  assert.equal(
    TemplateReplaceInput.safeParse(body([{ weekday: 1, startLocal: '24:00', endLocal: '24:00' }]))
      .success,
    false,
  );
  assert.equal(
    TemplateReplaceInput.safeParse({ ...body([]), version: 3 }).success,
    false,
    'strict: an unknown key is refused',
  );
});
