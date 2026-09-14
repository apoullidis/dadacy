/**
 * hibp-fake — the local stand-in for the Have I Been Pwned Pwned Passwords
 * k-anonymity RANGE API (https://api.pwnedpasswords.com/range/{prefix}).
 *
 * Ticket: T-139. Owner: platform-infrastructure. DOCKER.md §3, §7, §8;
 * decisions.md OE-22. Node built-ins only: this container sits on
 * `kinvara-int` (`internal: true`) and must start with no registry.
 *
 * =========================================================================
 * A FAKE NEVER EXCEEDS THE REAL THING'S CAPABILITY (PROTOCOL §9 item 11)
 * =========================================================================
 *
 * It answers ONE request: `GET /range/<5 hex chars>`, and nothing else. There
 * is deliberately no `/healthz`, no assertion API and no full-hash lookup —
 * the real API has none of them, and a consumer that learned to call one
 * here would be building against a service that does not exist. The
 * container healthcheck queries `/range/00000` instead.
 *
 * The shape is copied from two sources, cited in state/EP-1/T-139.md:
 *   - the HIBP API v3 documentation, https://haveibeenpwned.com/API/v3
 *     (path, case-insensitive prefix, `SUFFIX:COUNT` lines, "every single one
 *     will return HTTP 200; there is no circumstance in which the API should
 *     return HTTP 404");
 *   - the real API as measured from the host on 2026-09-14 (content types,
 *     CRLF separators with no trailing CRLF, uppercase suffixes, and the 400 /
 *     405 bodies, which the documentation does not state).
 *
 * NOT IMPLEMENTED, and refused with 501 rather than silently ignored: NTLM
 * mode (`?mode=ntlm`) and response padding (`Add-Padding: true`). The real API
 * supports both. Ignoring them would hand a consumer a SHA-1, unpadded body it
 * believes is NTLM or padded — that is a lie, so it is a refusal instead.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? '4100');
const CORPUS_PATH = process.env.HIBP_CORPUS ?? '/srv/corpus.txt';

// Byte-exact copies of the real API's answers (measured 2026-09-14).
const OK_TYPE = 'text/plain; charset=utf-8';
const ERR_TYPE = 'text/plain;charset=UTF-8';
const MSG_FORMAT = 'The hash prefix was not in a valid format';
const MSG_HEX = 'The hash prefix was not valid hexadecimal';

// ---------------------------------------------------------------------------
// The corpus. FAIL CLOSED: a malformed line or an empty corpus stops start-up,
// so a typo cannot produce a fake that quietly answers "not breached" for
// everything (which is the direction T-141 fails open in, and would hide).
// ---------------------------------------------------------------------------
/** @type {Map<string, {suffix: string, count: number}[]>} prefix -> sorted entries */
const byPrefix = new Map();
{
  const lines = readFileSync(CORPUS_PATH, 'utf8').split('\n');
  let entries = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const m = /^([0-9A-F]{40}):([1-9][0-9]*)$/.exec(line);
    if (!m) {
      console.error(
        `hibp-fake: corpus line ${String(i + 1)} is not "<40 UPPERCASE HEX>:<count>=1+": ${line}`,
      );
      process.exit(1);
    }
    const hash = m[1];
    const prefix = hash.slice(0, 5);
    const list = byPrefix.get(prefix) ?? [];
    if (list.some((e) => e.suffix === hash.slice(5))) {
      console.error(`hibp-fake: corpus line ${String(i + 1)} duplicates ${hash}`);
      process.exit(1);
    }
    list.push({ suffix: hash.slice(5), count: Number(m[2]) });
    byPrefix.set(prefix, list);
    entries += 1;
  });
  if (entries === 0) {
    console.error(`hibp-fake: corpus ${CORPUS_PATH} has no entries`);
    process.exit(1);
  }
  for (const list of byPrefix.values()) list.sort((a, b) => (a.suffix < b.suffix ? -1 : 1));
  console.log(`hibp-fake: ${String(entries)} entries under ${String(byPrefix.size)} prefixes`);
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const rawUrl = req.url ?? '';
  const q = rawUrl.indexOf('?');
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? '' : rawUrl.slice(q + 1);

  if (req.method !== 'GET') {
    send(
      res,
      405,
      ERR_TYPE,
      `Only GET requests can be used to query ranges, but this request used the ${String(req.method)} verb`,
    );
    return;
  }

  // Exactly `/range/` followed by five characters, nothing after them — not a
  // trailing slash, not a sixth character, not a full 40-character hash. The
  // real API answers every other path with the same 400 (measured: `/range/`,
  // `/range/21BD1/`, `/range/%2021BD`, `/nope`).
  const m = /^\/range\/([^/]*)$/.exec(path);
  if (!m || m[1].length !== 5) {
    send(res, 400, ERR_TYPE, MSG_FORMAT);
    return;
  }
  // Not case-sensitive (API v3 docs): `21bd1` and `21BD1` are the same prefix.
  if (!/^[0-9A-Fa-f]{5}$/.test(m[1])) {
    send(res, 400, ERR_TYPE, MSG_HEX);
    return;
  }

  if (query !== '' || req.headers['add-padding'] !== undefined) {
    send(
      res,
      501,
      ERR_TYPE,
      'hibp-fake (T-139) implements only the unpadded SHA-1 range lookup; ' +
        'query parameters (e.g. mode=ntlm) and the Add-Padding header are not implemented here',
    );
    return;
  }

  // A prefix nothing is seeded under: 200 with an EMPTY body, never 404 —
  // "every single one will return HTTP 200" (API v3 docs).
  const list = byPrefix.get(m[1].toUpperCase()) ?? [];
  send(res, 200, OK_TYPE, list.map((e) => `${e.suffix}:${String(e.count)}`).join('\r\n'));
});

server.listen(PORT, () => console.log(`hibp-fake: listening on ${String(PORT)}`));

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
