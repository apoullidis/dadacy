/**
 * hibp-fake smoke check and refusals. Ticket: T-139.
 *
 *   scripts/svc up  <ticket> hibp
 *   scripts/svc run <ticket> -- node docker/fakes/hibp/smoke.mjs
 *
 * Exits 0 only if every case behaved; prints every response it judged, so the
 * evidence is the terminal and not a summary (PROTOCOL.md §5.1).
 *
 * NOT DERIVED FROM THE CORPUS FILE. The expectations below start from the
 * synthetic PLAINTEXT passwords and hash them here with node:crypto, and the
 * digests are also pinned as literals computed independently (host python3
 * hashlib, recorded in state/EP-1/T-139.md). A corpus typo therefore fails
 * this check instead of agreeing with it.
 *
 * CONTROLS. A server that answered 400 to everything would pass every refusal
 * below, so the positive cases run in the same invocation; and a server that
 * returned every seeded suffix for every prefix would pass the positive cases,
 * so a clean password sharing a seeded prefix must NOT find its suffix.
 */
import { createHash } from 'node:crypto';

const BASE = process.env.HIBP_API_BASE ?? 'http://hibp-fake:4100';

const PASSWORDS = {
  breached01: ['kinvara-T139-synthetic-breached-01', 'C8DBF9E79064DA54AB6D05F9B419054EE30C93A0', 3],
  breached02: ['kinvara-T139-synthetic-breached-02', 'B126B0F8F5DAE00434836783A01A6F200104BAFB', 1],
  clean01: ['kinvara-T139-synthetic-clean-01', 'C6954FF60BC0ED63E5FFA885B333915D7E19A0A9', 0],
  cleanSibling: [
    'kinvara-T139-synthetic-clean-sibling-66358',
    'C8DBF955A66E385E7D01D0BABB74A17D648CDD18',
    0,
  ],
};

const OK_TYPE = 'text/plain; charset=utf-8';
const ERR_TYPE = 'text/plain;charset=UTF-8';
const MSG_FORMAT = 'The hash prefix was not in a valid format';
const MSG_HEX = 'The hash prefix was not valid hexadecimal';

let failures = 0;
let judged = 0;
const check = (cond, what, detail = '') => {
  judged += 1;
  if (cond) console.log(`  ok       ${what}`);
  else {
    failures += 1;
    console.log(`  FAILED   ${what}${detail === '' ? '' : `\n           ${detail}`}`);
  }
};

const req = async (method, path, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, { method, headers });
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  const shown = JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
  const hdr = Object.keys(headers).length === 0 ? '' : ` ${JSON.stringify(headers)}`;
  console.log(
    `\n  ${method} ${path}${hdr}\n    -> ${String(res.status)}  content-type: ${type}  body(${String(text.length)}): ${shown}`,
  );
  return { status: res.status, type, text };
};

const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();

console.log(`hibp-fake smoke — ${BASE}`);

console.log('\n== 0. the synthetic passwords hash to the pinned literals');
for (const [name, [pw, pinned]] of Object.entries(PASSWORDS)) {
  check(sha1(pw) === pinned, `${name}: sha1("${pw}") = ${pinned}`, `got ${sha1(pw)}`);
}

const lines = (text) => (text === '' ? [] : text.split('\r\n'));

console.log('\n== 1. SMOKE — a seeded breached password: its prefix returns its suffix');
{
  const [, hash, count] = PASSWORDS.breached01;
  const r = await req('GET', `/range/${hash.slice(0, 5)}`);
  check(r.status === 200, 'status 200');
  check(r.type === OK_TYPE, `content-type is "${OK_TYPE}"`, `got "${r.type}"`);
  check(
    lines(r.text).includes(`${hash.slice(5)}:${String(count)}`),
    `body has line ${hash.slice(5)}:${String(count)}`,
  );
  check(
    lines(r.text).every((l) => /^[0-9A-F]{35}:[0-9]+$/.test(l)),
    'every line is <35 UPPERCASE hex>:<count>',
  );
  check(
    !r.text.endsWith('\r\n') && !r.text.includes('\n\n'),
    'lines CRLF-separated, no trailing CRLF',
  );
  const sib = PASSWORDS.cleanSibling[1];
  check(
    sib.slice(0, 5) === hash.slice(0, 5),
    `control: clean sibling shares prefix ${hash.slice(0, 5)}`,
  );
  check(!r.text.includes(sib.slice(5)), `control: clean sibling suffix ${sib.slice(5)} is ABSENT`);

  const lower = await req('GET', `/range/${hash.slice(0, 5).toLowerCase()}`);
  check(
    lower.status === 200 && lower.text === r.text,
    'lowercase prefix is accepted and returns the identical body (docs: "not case-sensitive")',
  );
}
{
  const [, hash, count] = PASSWORDS.breached02;
  const r = await req('GET', `/range/${hash.slice(0, 5)}`);
  check(
    r.status === 200 && lines(r.text).includes(`${hash.slice(5)}:${String(count)}`),
    `breached02: 200 with ${hash.slice(5)}:${String(count)}`,
  );
}

console.log(
  '\n== 2. SMOKE — an unseeded prefix: the not-found shape is 200 with an empty body, never 404',
);
{
  const hash = PASSWORDS.clean01[1];
  const r = await req('GET', `/range/${hash.slice(0, 5)}`);
  check(
    r.status === 200,
    'status 200 (docs: "no circumstance in which the API should return HTTP 404")',
  );
  check(r.type === OK_TYPE, `content-type is "${OK_TYPE}"`, `got "${r.type}"`);
  check(r.text === '', 'body is empty');
}

console.log('\n== 3. REFUSALS — every shape the real API refuses, byte-for-byte');
const refuse = async (label, method, path, status, type, body, headers = {}) => {
  const r = await req(method, path, headers);
  check(
    r.status === status && r.type === type && (body === null || r.text === body),
    `${label} -> ${String(status)}${body === null ? '' : ` "${body}"`}`,
    `got ${String(r.status)} "${r.type}" ${JSON.stringify(r.text)}`,
  );
};
const full = PASSWORDS.breached01[1];
await refuse('a FULL 40-char hash', 'GET', `/range/${full}`, 400, ERR_TYPE, MSG_FORMAT);
await refuse('4 chars', 'GET', `/range/${full.slice(0, 4)}`, 400, ERR_TYPE, MSG_FORMAT);
await refuse('6 chars', 'GET', `/range/${full.slice(0, 6)}`, 400, ERR_TYPE, MSG_FORMAT);
await refuse('5 chars, non-hex', 'GET', '/range/C8DBG', 400, ERR_TYPE, MSG_HEX);
await refuse('empty prefix', 'GET', '/range/', 400, ERR_TYPE, MSG_FORMAT);
await refuse('trailing slash', 'GET', `/range/${full.slice(0, 5)}/`, 400, ERR_TYPE, MSG_FORMAT);
await refuse('no /healthz (the real API has none)', 'GET', '/healthz', 400, ERR_TYPE, MSG_FORMAT);
await refuse(
  'no full-hash lookup route',
  'GET',
  `/pwnedpassword/${full}`,
  400,
  ERR_TYPE,
  MSG_FORMAT,
);
await refuse(
  'POST',
  'POST',
  `/range/${full.slice(0, 5)}`,
  405,
  ERR_TYPE,
  'Only GET requests can be used to query ranges, but this request used the POST verb',
);
await refuse(
  'mode=ntlm (not implemented here)',
  'GET',
  `/range/${full.slice(0, 5)}?mode=ntlm`,
  501,
  ERR_TYPE,
  null,
);
await refuse(
  'Add-Padding (not implemented here)',
  'GET',
  `/range/${full.slice(0, 5)}`,
  501,
  ERR_TYPE,
  null,
  { 'Add-Padding': 'true' },
);

console.log(`\n${String(judged)} checks judged, ${String(failures)} failed`);
// Exactly the number of checks written above (4 + 8 + 1 + 3 + 11). Anything
// else means a section did not run, and a partial run is not a pass.
if (judged !== 27) {
  console.log(
    `SMOKE FAIL  hibp-fake — ${String(judged)} checks ran, 27 are written (harness did not run to completion)`,
  );
  process.exit(1);
}
console.log(failures === 0 ? 'SMOKE PASS  hibp-fake' : 'SMOKE FAIL  hibp-fake');
process.exit(failures === 0 ? 0 : 1);
