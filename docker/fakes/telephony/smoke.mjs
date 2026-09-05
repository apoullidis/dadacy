/**
 * fake-telephony smoke check. Ticket: T-017.
 *
 *   scripts/svc up  <ticket> tel
 *   scripts/svc run <ticket> -- node docker/fakes/telephony/smoke.mjs
 *
 * A command that exits 0 or non-zero and prints why (PROTOCOL.md §5.1). It is
 * here so the container's behaviour — above all THE 501 — is re-runnable by
 * QA and by every later telephony ticket, rather than being a curl somebody
 * once pasted into an evidence file.
 *
 * The check that matters most is the last one, and it has a CONTROL. Asserting
 * "this path returns 501" proves nothing on a server that returns 501 to
 * everything, so an ordinary unknown path must come back 404 in the same run.
 */

const BASE = process.env.TELEPHONY_BASE_URL ?? 'http://fake-telephony:4000';

let failures = 0;
const ok = (what) => console.log(`  ok       ${what}`);
const bad = (what, detail) => {
  failures += 1;
  console.log(`  FAILED   ${what}\n           ${detail}`);
};
const check = (cond, what, detail) => (cond ? ok(what) : bad(what, detail));

const req = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    /* left null on purpose: a non-JSON body is itself the finding */
  }
  return { status: res.status, text, json };
};

console.log(`fake-telephony smoke — ${BASE}\n`);

// --- reset, so a re-run asserts the same thing ------------------------------
await req('DELETE', '/v1/_fake/recordings');

// --- health -----------------------------------------------------------------
{
  const r = await req('GET', '/healthz');
  check(r.status === 200 && r.json?.ok === true, 'GET /healthz -> 200', `got ${String(r.status)}`);
}

// --- outbound SMS, and the UCS-2 constraint (SA INT-5r) ---------------------
//
// Not decoration. §Success Metrics caps Critical templates at 2 segments PER
// LOCALE, and a body that fits one segment in English routinely needs two or
// three in Greek or Russian, because non-GSM-7 characters force UCS-2 at 70
// characters per segment instead of 160. Cost is modelled at the Greek/Russian
// count, and concatenated SMS has a measurably worse delivery profile.
{
  const english = 'Kinvara: we have not heard from you about tonight. Reply in the app.';
  const r = await req('POST', '/v1/messages', {
    to: '+35799123456',
    body: english,
    recipientLocale: 'en',
  });
  check(r.status === 201, 'POST /v1/messages (en) -> 201', `got ${String(r.status)}`);
  check(
    r.json?.encoding === 'GSM-7' && r.json?.segments === 1,
    `en body of ${String(english.length)} chars -> GSM-7, 1 segment`,
    JSON.stringify(r.json),
  );
}
{
  const greek =
    'Kinvara: δεν έχουμε νέα σας για τη σημερινή βραδιά. Πατήστε 1 αν όλα είναι εντάξει.';
  const r = await req('POST', '/v1/messages', {
    to: '+35799123456',
    body: greek,
    recipientLocale: 'el',
  });
  check(
    r.json?.encoding === 'UCS-2',
    'the same message in Greek -> UCS-2, not GSM-7',
    JSON.stringify(r.json),
  );
  check(
    typeof r.json?.segments === 'number' && r.json.segments >= 2,
    `Greek body of ${String(greek.length)} chars -> ${String(r.json?.segments)} segments (UCS-2 is 70/segment, not 160)`,
    JSON.stringify(r.json),
  );
}
{
  const r = await req('GET', '/v1/_fake/messages?to=%2B35799123456');
  check(
    Array.isArray(r.json) && r.json.length === 2,
    'GET /v1/_fake/messages records both sends for assertion',
    JSON.stringify(r.json),
  );
  check(
    r.json?.[0]?.recipientLocale === 'en' && r.json?.[1]?.recipientLocale === 'el',
    'recipientLocale is recorded as GIVEN and never defaulted (SE-8)',
    JSON.stringify(r.json?.map((m) => m.recipientLocale)),
  );
}

// --- voice + DTMF (DV-7) — the rung that REPLACED the SMS reply -------------
{
  const call = await req('POST', '/v1/calls', {
    to: '+35799123456',
    recipientLocale: 'el',
    promptId: 'checkin.no_response.v1',
  });
  check(call.status === 201, 'POST /v1/calls -> 201', `got ${String(call.status)}`);
  const sid = call.json?.sid;

  // Voicemail is NOT an acknowledgement (SD §INT-H.1). Provider libraries make
  // it easy to read `answered` as success; the fake says so explicitly.
  const answered = await req('POST', `/v1/_fake/calls/${sid}/answer`, { answeredBy: 'machine' });
  check(
    answered.json?.answeredBy === 'machine',
    'answeredBy: machine (voicemail) is recorded as such',
    JSON.stringify(answered.json),
  );
  const whs1 = await req('GET', '/v1/_fake/webhooks');
  const answeredWh = whs1.json?.find((w) => w.event === 'call.answered');
  check(
    answeredWh?.body?.isAcknowledgement === false,
    'call.answered on a machine is NOT an acknowledgement — the ladder continues',
    JSON.stringify(answeredWh?.body),
  );

  const dtmf = await req('POST', `/v1/_fake/calls/${sid}/dtmf`, { digits: '1' });
  check(dtmf.status === 200, 'POST .../dtmf {digits:"1"} -> 200', `got ${String(dtmf.status)}`);
  const whs2 = await req('GET', '/v1/_fake/webhooks');
  const dtmfWh = whs2.json?.find((w) => w.event === 'call.dtmf');
  check(
    dtmfWh?.body?.meaning === 'acknowledged' && dtmfWh?.body?.ackMethod === 'voice_dtmf',
    'DTMF 1 -> acknowledged, ack_method voice_dtmf (SD §INT-H.1)',
    JSON.stringify(dtmfWh?.body),
  );
}

// --- the inbound safety line (EV-1) ----------------------------------------
//
// We own this number and forward it to the answering-service vendor, so the
// 15-minute acknowledgement clock starts at OUR webhook rather than at the
// vendor's report — which is what makes the SLA measurable in the direction
// that matters. The failure a report-based metric cannot see is a call that
// produces NO report at all.
{
  const r = await req('POST', '/v1/_fake/safety-line/call', { from: '+35799777888' });
  check(r.status === 201, 'POST /v1/_fake/safety-line/call -> 201', `got ${String(r.status)}`);
  check(
    r.json?.webhook?.event === 'call.initiated' &&
      typeof r.json?.call?.providerCallRef === 'string',
    'emits call.initiated with a providerCallRef (EV-1)',
    JSON.stringify(r.json),
  );
  const calls = await req('GET', '/v1/_fake/safety-line/calls');
  check(
    Array.isArray(calls.json) && calls.json.length === 1,
    'the inbound call is recorded for the unreported-call sweep to correlate against',
    JSON.stringify(calls.json),
  );
}

// ===========================================================================
// THE REFUSAL — SA §INT-5r. This is the point of the whole container.
// ===========================================================================
//
// Cyprus supports neither two-way SMS through major providers nor domestic
// long codes. The SMS-reply acknowledgement rung was DELETED from the SOS
// design, not degraded. A fake that accepted an inbound SMS would let an
// engineer rebuild a rung that cannot ship in this market and hide it behind
// a green test.
console.log('\n  --- inbound SMS: 501 on every route that means it ---');
const INBOUND_PATHS = [
  '/v1/messages/inbound',
  '/v1/sms/inbound',
  '/v1/sms/incoming',
  '/v1/inbound/sms',
  '/webhooks/sms/reply',
  '/v1/sms/mo',
  // NOT one of the four somebody thought of. The refusal is a PREDICATE
  // applied before routing, so a path invented next year is refused too — and
  // refused with an explanation, rather than 404'd into a hunt for the right
  // URL.
  '/api/v9/text-messages/received-from-handset',
];
for (const path of INBOUND_PATHS) {
  const r = await req('POST', path, { From: '+35799123456', Body: 'OK' });
  const body = r.text;
  check(
    r.status === 501 && body.includes('INT-5r') && /Cyprus/i.test(body),
    `POST ${path} -> 501, body names SA §INT-5r`,
    `status ${String(r.status)}; body ${body.slice(0, 200)}`,
  );
}
// GET too — a webhook configured as GET must not slip past.
{
  const r = await req('GET', '/v1/sms/inbound');
  check(r.status === 501, 'GET /v1/sms/inbound -> 501 as well', `got ${String(r.status)}`);
}

// --- THE CONTROL ------------------------------------------------------------
// Without this, every assertion above is satisfied by a server that answers
// 501 to everything.
{
  const r = await req('POST', '/v1/definitely-not-a-route');
  check(
    r.status === 404,
    'CONTROL: an ordinary unknown route -> 404, so 501 is not the blanket answer',
    `got ${String(r.status)}`,
  );
}
{
  const r = await req('GET', '/v1/_fake/refusals');
  check(
    Array.isArray(r.json) && r.json.length === INBOUND_PATHS.length + 1,
    `every refusal is recorded (${String(INBOUND_PATHS.length + 1)} of them)`,
    JSON.stringify(r.json?.length),
  );
}

console.log('');
if (failures > 0) {
  console.error(`SMOKE FAIL — ${String(failures)} check(s) failed.`);
  process.exit(1);
}
console.log('SMOKE PASS — fake-telephony behaves, and refuses what Cyprus refuses.');
process.exit(0);
