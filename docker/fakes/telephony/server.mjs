/**
 * fake-telephony — the local stand-in for Twilio (SMS, voice, DTMF), plus the
 * inbound safety line of EV-1.
 *
 * Ticket: T-017. Owner: platform-infrastructure. DOCKER.md §7, §8.
 * Node built-ins only, on purpose: this container must build and start with no
 * package manager, no lockfile and no registry.
 *
 * =========================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE — READ BEFORE CHANGING ANYTHING
 * =========================================================================
 *
 * A FAKE NEVER EXCEEDS THE REAL THING'S CAPABILITY (DOCKER.md §8,
 * PROTOCOL.md §9.11, platform-infrastructure.md non-negotiable 6).
 *
 * Cyprus supports NEITHER two-way SMS through major providers NOR domestic
 * long codes (SA §INT-5r, verified against the Sent.dm Cyprus SMS guide).
 * The "reply to this SMS to acknowledge" escalation rung — the one mechanism
 * in the original SOS design that depended on no browser capability at all —
 * DOES NOT EXIST IN THIS MARKET. It was DELETED, not degraded, and DV-7's
 * voice + DTMF rung is what replaced it.
 *
 * So every inbound-SMS route here returns 501 Not Implemented with SA §INT-5r
 * named in the body. That is not a stub gap and it is not a TODO. A fake that
 * cheerfully accepted an inbound SMS would let an engineer rebuild that rung,
 * pass every local test, and find out in Cyprus. The fake's job is to fail
 * where reality fails.
 *
 * AND IT IS A RULE, NOT A LIST (see isInboundSmsPath). Refusing only the four
 * paths somebody thought of would mean the fifth path an engineer invents
 * returns 404 — which reads as "wrong URL, keep looking" and sends them
 * hunting for the right one. Anything that looks like an inbound-SMS route
 * gets the 501 and the explanation.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? '4000');

/**
 * Where this fake posts its webhooks. Unset by default: a ticket that wants
 * delivery sets it to a service on the same internal network
 * (e.g. http://safety-gw:3010). When unset, every webhook is still RECORDED
 * with delivery `not_configured`, so a test can assert the fake tried.
 */
const WEBHOOK_BASE = process.env.TELEPHONY_WEBHOOK_BASE ?? '';

/** The number we own and forward to the answering-service vendor (EV-1). */
const SAFETY_LINE_E164 = process.env.TELEPHONY_SAFETY_LINE ?? '+35722000199';
/** Alphanumeric sender ID: fully supported in Cyprus, no registration (INT-5r). */
const DEFAULT_SENDER_ID = process.env.TELEPHONY_SENDER_ID ?? 'Kinvara';

// ---------------------------------------------------------------------------
// Recordings — everything this fake did, for assertions.
// In memory only. `svc down` destroys it, and DELETE /v1/_fake/recordings
// resets it between suites.
// ---------------------------------------------------------------------------
/** @type {{messages: any[], calls: any[], inboundCalls: any[], webhooks: any[], refusals: any[]}} */
const rec = { messages: [], calls: [], inboundCalls: [], webhooks: [], refusals: [] };

const nowIso = () => new Date().toISOString();
const sid = (prefix) => `${prefix}${randomUUID().replace(/-/g, '')}`;

// ---------------------------------------------------------------------------
// SMS segmentation — GSM-7 vs UCS-2 (SA §INT-5r, the UCS-2 constraint)
// ---------------------------------------------------------------------------
//
// This is here because it is a first-order COST and RELIABILITY fact in this
// market, not a detail: a Critical-tier SMS that fits one segment in English
// routinely needs two or three in Greek or Russian, and §Success Metrics caps
// Critical templates at 2 segments PER LOCALE. The i18n gate asserts that at
// build time over the compiled catalogue; this computes the same number at
// send time so a ladder test can assert what actually went out.
const GSM7_BASE =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '\f^{}\\[~]|€';

/** @returns {{encoding: 'GSM-7'|'UCS-2', units: number, segments: number}} */
export function segmentSms(body) {
  let units = 0;
  let gsm = true;
  for (const ch of body) {
    if (GSM7_BASE.includes(ch)) {
      units += 1;
    } else if (GSM7_EXT.includes(ch)) {
      units += 2; // escape + character
    } else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    // UCS-2 counts UTF-16 code units, so an astral character costs two.
    units = [...body].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
    const single = 70;
    const concat = 67;
    return {
      encoding: 'UCS-2',
      units,
      segments: units <= single ? 1 : Math.ceil(units / concat),
    };
  }
  const single = 160;
  const concat = 153;
  return { encoding: 'GSM-7', units, segments: units <= single ? 1 : Math.ceil(units / concat) };
}

// ---------------------------------------------------------------------------
// THE INBOUND-SMS PREDICATE — a rule, not a list
// ---------------------------------------------------------------------------
//
// True for anything that plausibly means "an SMS arriving at us". Deliberately
// OVER-general: a false positive costs an engineer one 501 that explains
// itself; a false negative costs them a rung that cannot ship in Cyprus.
const SMS_WORD = /(^|[^a-z])(sms|message|messages|mo|text)([^a-z]|$)/;
// `callback` is deliberately ABSENT. An outbound delivery-receipt callback
// (the DLR that INT-5.6r's acknowledged-reach metric reads) is a real,
// supported thing in Cyprus; refusing it would be the fake exceeding reality
// in the other direction, which is just as wrong.
const INBOUND_WORD = /(^|[^a-z])(inbound|incoming|receive|received|reply|replies|mo)([^a-z]|$)/;

export function isInboundSmsPath(pathname) {
  const p = pathname.toLowerCase();
  return SMS_WORD.test(p) && INBOUND_WORD.test(p);
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
async function postWebhook(event, body) {
  const entry = {
    id: sid('WH'),
    event,
    at: nowIso(),
    target: WEBHOOK_BASE === '' ? null : `${WEBHOOK_BASE}/webhooks/telephony/${event}`,
    body,
    delivery: 'not_configured',
    responseStatus: null,
    error: null,
  };
  if (WEBHOOK_BASE !== '') {
    try {
      const res = await fetch(entry.target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      entry.delivery = res.ok ? 'delivered' : 'rejected';
      entry.responseStatus = res.status;
    } catch (err) {
      // On kinvara-int a wrong host name is a DNS failure, and that is a
      // FINDING for whoever configured it, not something to swallow.
      entry.delivery = 'failed';
      entry.error = String(err && err.message ? err.message : err);
    }
  }
  rec.webhooks.push(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readJson = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __parseError: true, __raw: raw });
      }
    });
  });

/** The 501 body. Every inbound-SMS route returns exactly this. */
function inboundSmsRefusal(pathname, method) {
  return {
    error: 'inbound_sms_not_supported',
    status: 501,
    spec: 'SA §INT-5r',
    market: 'CY',
    message:
      'Inbound SMS does not exist in this market. Cyprus supports neither two-way SMS ' +
      'through major providers nor domestic long codes (SA §INT-5r), so an ' +
      '"SMS reply to acknowledge" escalation rung cannot ship here. It was deleted from ' +
      'the SOS design, not degraded. This fake refuses it so that a rung which cannot ' +
      'exist in production cannot be built and hidden behind a green test ' +
      '(DOCKER.md §8, PROTOCOL.md §9.11).',
    useInstead:
      'DV-7 voice + DTMF acknowledgement: POST /v1/calls, then POST /v1/_fake/calls/{sid}/dtmf. ' +
      'It is the only no-install acknowledgement channel that exists in Cyprus.',
    refusedRoute: `${method} ${pathname}`,
  };
}

const server = http.createServer((req, res) => {
  void handle(req, res).catch((err) => {
    json(res, 500, { error: 'fake_telephony_internal', message: String(err) });
  });
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://fake-telephony');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method ?? 'GET';

  // --- THE REFUSAL COMES FIRST -------------------------------------------
  // Before routing, before 404, before anything. A route added below that
  // happened to match the predicate would still be refused, which is the
  // direction this check must fail in.
  if (isInboundSmsPath(p)) {
    const body = inboundSmsRefusal(p, m);
    rec.refusals.push({ id: sid('RF'), at: nowIso(), method: m, path: p });
    return json(res, 501, body);
  }

  // --- health -------------------------------------------------------------
  if (m === 'GET' && (p === '/healthz' || p === '/')) {
    return json(res, 200, {
      service: 'fake-telephony',
      ticket: 'T-017',
      ok: true,
      safetyLine: SAFETY_LINE_E164,
      webhookBase: WEBHOOK_BASE === '' ? null : WEBHOOK_BASE,
      inboundSms: '501 — SA §INT-5r; Cyprus has no two-way SMS and no domestic long codes',
      counts: {
        messages: rec.messages.length,
        calls: rec.calls.length,
        inboundCalls: rec.inboundCalls.length,
        webhooks: rec.webhooks.length,
        inboundSmsRefusals: rec.refusals.length,
      },
    });
  }

  // --- outbound SMS -------------------------------------------------------
  if (m === 'POST' && p === '/v1/messages') {
    const b = await readJson(req);
    if (typeof b.to !== 'string' || typeof b.body !== 'string') {
      return json(res, 400, { error: 'to and body are required' });
    }
    const seg = segmentSms(b.body);
    const msg = {
      sid: sid('SM'),
      to: b.to,
      from: typeof b.from === 'string' ? b.from : DEFAULT_SENDER_ID,
      body: b.body,
      // recipientLocale is stamped at enqueue by the caller (SE-8). This fake
      // records what it was given and NEVER defaults it: a locale the sender
      // did not supply is the exact defect SE-8's lint rule exists to catch.
      recipientLocale: typeof b.recipientLocale === 'string' ? b.recipientLocale : null,
      encoding: seg.encoding,
      units: seg.units,
      segments: seg.segments,
      status: 'delivered',
      sentAt: nowIso(),
    };
    rec.messages.push(msg);
    return json(res, 201, msg);
  }

  // --- outbound voice (DV-7) ---------------------------------------------
  if (m === 'POST' && p === '/v1/calls') {
    const b = await readJson(req);
    if (typeof b.to !== 'string') return json(res, 400, { error: 'to is required' });
    const call = {
      sid: sid('CA'),
      to: b.to,
      from: typeof b.from === 'string' ? b.from : SAFETY_LINE_E164,
      // Pre-recorded audio per locale, never runtime TTS (SD §INT-H.1).
      promptId: typeof b.promptId === 'string' ? b.promptId : null,
      recipientLocale: typeof b.recipientLocale === 'string' ? b.recipientLocale : null,
      status: 'initiated',
      answeredBy: null,
      dtmf: [],
      startedAt: nowIso(),
      endedAt: null,
    };
    rec.calls.push(call);
    return json(res, 201, call);
  }

  // --- DTMF playback ------------------------------------------------------
  // POST /v1/_fake/calls/{sid}/answer   {answeredBy: 'human'|'machine'}
  // POST /v1/_fake/calls/{sid}/dtmf     {digits: '1'}
  const callMatch = /^\/v1\/_fake\/calls\/([^/]+)\/(answer|dtmf)$/.exec(p);
  if (m === 'POST' && callMatch) {
    const call = rec.calls.find((c) => c.sid === callMatch[1]);
    if (call === undefined) return json(res, 404, { error: 'no such call', sid: callMatch[1] });
    const b = await readJson(req);

    if (callMatch[2] === 'answer') {
      const by = b.answeredBy === 'machine' ? 'machine' : 'human';
      call.answeredBy = by;
      call.status = 'in-progress';
      // 'machine' (voicemail) IS NOT AN ACKNOWLEDGEMENT (SD §INT-H.1). The
      // ladder continues. Provider libraries make it easy to read `answered`
      // as success, so the fake reports the distinction explicitly.
      await postWebhook('call.answered', {
        callSid: call.sid,
        answeredBy: by,
        isAcknowledgement: false,
        at: nowIso(),
      });
      return json(res, 200, call);
    }

    const digits = typeof b.digits === 'string' ? b.digits : '';
    if (!/^[0-9*#]+$/.test(digits)) return json(res, 400, { error: 'digits must be 0-9 * #' });
    if (call.answeredBy === null) call.answeredBy = 'human';
    call.status = 'completed';
    call.endedAt = nowIso();
    call.dtmf.push({ digits, at: nowIso() });
    await postWebhook('call.dtmf', {
      callSid: call.sid,
      digits,
      // 1 -> ack, ladder cancelled. 2 -> immediate P0, operator page, no
      // further rungs (SD §INT-H.1). The fake reports the digit and its
      // documented meaning; the LADDER decides, not this container.
      meaning: digits === '1' ? 'acknowledged' : digits === '2' ? 'needs_help' : 'unmapped',
      ackMethod: digits === '1' ? 'voice_dtmf' : null,
      at: nowIso(),
    });
    return json(res, 200, call);
  }

  // --- the inbound SAFETY LINE (EV-1) -------------------------------------
  //
  // We own this number and forward it to the answering-service vendor, so the
  // 15-minute acknowledgement clock starts at OUR webhook rather than at the
  // vendor's report. The alarm that matters is the converse: a call with NO
  // matching report after 15 minutes (SD, `oncall.unreported_call_sweep`), a
  // failure a report-based metric structurally cannot see.
  if (m === 'POST' && p === '/v1/_fake/safety-line/call') {
    const b = await readJson(req);
    const call = {
      providerCallRef: sid('IC'),
      to: SAFETY_LINE_E164,
      // The number itself is never stored by us — `out_of_hours_call` holds a
      // SALTED HASH (from_e164_hash). The fake hands over the raw value once,
      // at the webhook, exactly as the real provider would; hashing is the
      // consumer's job and T-112's.
      from: typeof b.from === 'string' ? b.from : '+35799000000',
      receivedAt: nowIso(),
    };
    rec.inboundCalls.push(call);
    const wh = await postWebhook('call.initiated', {
      event: 'call.initiated',
      providerCallRef: call.providerCallRef,
      to: call.to,
      from: call.from,
      receivedAt: call.receivedAt,
    });
    return json(res, 201, { call, webhook: wh });
  }

  // --- assertion API ------------------------------------------------------
  if (m === 'GET' && p === '/v1/_fake/messages') {
    const to = url.searchParams.get('to');
    return json(res, 200, to === null ? rec.messages : rec.messages.filter((x) => x.to === to));
  }
  if (m === 'GET' && p === '/v1/_fake/calls') {
    const to = url.searchParams.get('to');
    return json(res, 200, to === null ? rec.calls : rec.calls.filter((x) => x.to === to));
  }
  if (m === 'GET' && p === '/v1/_fake/safety-line/calls') return json(res, 200, rec.inboundCalls);
  if (m === 'GET' && p === '/v1/_fake/webhooks') return json(res, 200, rec.webhooks);
  if (m === 'GET' && p === '/v1/_fake/refusals') return json(res, 200, rec.refusals);
  if (m === 'DELETE' && p === '/v1/_fake/recordings') {
    for (const k of Object.keys(rec)) rec[k].length = 0;
    res.writeHead(204);
    return res.end();
  }

  return json(res, 404, {
    error: 'no such route',
    path: `${m} ${p}`,
    routes: [
      'GET  /healthz',
      'POST /v1/messages                          outbound SMS (segments computed)',
      'POST /v1/calls                             outbound voice (DV-7)',
      'POST /v1/_fake/calls/{sid}/answer          answeredBy human|machine',
      'POST /v1/_fake/calls/{sid}/dtmf            play DTMF back',
      'POST /v1/_fake/safety-line/call            inbound safety line -> call.initiated (EV-1)',
      'GET  /v1/_fake/messages|calls|webhooks|refusals',
      'GET  /v1/_fake/safety-line/calls',
      'DELETE /v1/_fake/recordings',
    ],
    note: 'Any inbound-SMS route returns 501 — SA §INT-5r. There is no such thing here.',
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fake-telephony (T-017) listening on ${String(PORT)}; inbound SMS -> 501 (SA §INT-5r)`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
