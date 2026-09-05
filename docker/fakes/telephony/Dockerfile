# fake-telephony — ours (DOCKER.md §7, §8). Ticket: T-017.
#
# Twilio's stand-in: outbound SMS with real GSM-7/UCS-2 segmentation, outbound
# voice with DTMF playback (DV-7), the inbound safety line and its
# `call.initiated` webhook (EV-1), and a recording API to assert against.
#
# AND `501 Not Implemented` ON EVERY INBOUND-SMS ROUTE, naming SA §INT-5r.
# Cyprus supports neither two-way SMS through major providers nor domestic long
# codes; the SMS-reply acknowledgement rung was deleted from the SOS design,
# not degraded. See the header of server.mjs.
#
# No dependencies, no lockfile, no package manager, no registry access at run
# time — Node built-ins only. The container sits on `kinvara-int`
# (`internal: true`) and has no route off this host, so anything it needed to
# fetch at start-up would be a start-up failure.

FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /srv

COPY server.mjs /srv/server.mjs

# Non-root. `node` (uid 1000) is created by the base image.
USER node

EXPOSE 4000

# No curl and no wget-with-TLS in this image, and neither is wanted: the
# healthcheck uses the runtime that is already here.
HEALTHCHECK --interval=5s --timeout=3s --retries=12 --start-period=5s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "/srv/server.mjs"]

LABEL io.kinvara.image="fake-telephony" \
      io.kinvara.built-by="T-017" \
      io.kinvara.refuses="inbound SMS — SA §INT-5r"
