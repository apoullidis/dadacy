# hibp-fake — the HIBP Pwned Passwords k-anonymity range-API stand-in.
# Ticket: T-139. DOCKER.md §3 (`hibp` profile), §7, §8; decisions.md OE-22.
#
# Answers ONLY `GET /range/<5 hex>` over the seeded corpus, and refuses
# anything wider than the real API accepts. See the header of server.mjs.
#
# No dependencies, no lockfile, no package manager, no registry access at run
# time — Node built-ins only. Same pinned base as fake-telephony (T-017).

FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

ENV NODE_ENV=production \
    PORT=4100 \
    HIBP_CORPUS=/srv/corpus.txt

WORKDIR /srv

COPY server.mjs corpus.txt /srv/

# Non-root. `node` (uid 1000) is created by the base image.
USER node

EXPOSE 4100

# There is no /healthz: the real API has none, so neither does this. The
# healthcheck asks for a range, which the real API answers 200 for every
# prefix.
HEALTHCHECK --interval=5s --timeout=3s --retries=12 --start-period=5s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/range/00000').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]

# A small heap: the budget is 64 MB (DOCKER.md §3) and the corpus is a few lines.
CMD ["node", "--max-old-space-size=24", "/srv/server.mjs"]

LABEL io.kinvara.image="hibp-fake" \
      io.kinvara.built-by="T-139" \
      io.kinvara.refuses="anything wider than GET /range/<5 hex> — PROTOCOL §9 item 11"
